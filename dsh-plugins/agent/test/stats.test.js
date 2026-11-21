import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { CapsuleStats, usageSummary, rebuildStats } from '../src/capsules/stats.js'
import { Bridge } from '../src/llm/bridge.js'
import { loadPrompts } from '../src/llm/prompts.js'
import { createTools } from '../src/tools/index.js'
import { METHODS, READ_METHODS } from '../src/game/index.js'
import { NBT_SOURCES } from '../src/capsules/index.js'
import { makeRuntime, runUntil, tempDir } from './helpers.js'

const prompts = loadPrompts(fileURLToPath(new URL('../prompts', import.meta.url)))

const exit = (taskId, id, type, ref, status, error) => ({ taskId, event: 'node', phase: 'exit', id, type, ref, status, error, at: `2026-10-29T00:00:0${id.length % 10}.000Z` })

test('统计：条件的判真 / 判假 / 报错分开计；Compute 失败记 error；同一节点多次退出都计；task/ 草稿不进总账', () => {
  const stats = new CapsuleStats()
  const cond = 'code/x.ready@11111111'
  const calc = 'code/x.calc@22222222'
  for (const record of [
    exit('t1', 'n1', 'Condition', cond, 'SUCCESS'),
    exit('t1', 'n1', 'Condition', cond, 'FAILURE'),
    exit('t1', 'n1', 'Condition', cond, 'FAILURE', 'state.inventory is undefined'),
    exit('t1', 'n2', 'Compute', calc, 'FAILURE', 'boom'),
    exit('t1', 'n2', 'Compute', calc, 'SUCCESS'),
    exit('t1', 'n3', 'Compute', 'task/draft@33333333', 'SUCCESS'),
    { taskId: 't1', event: 'node', phase: 'exit', id: 'n4', type: 'Steps', status: 'SUCCESS' }
  ]) stats.observe(record)
  assert.equal(stats.get(cond), null, '任务结束前不进总账')
  assert.equal(stats.observe({ taskId: 't1', event: 'task/failed', at: 'x' }), true)

  const c = stats.get(cond)
  assert.deepEqual([c.calls, c.ok, c.fail, c.error, c.tasks, c.tasksDone, c.tasksFailed], [3, 1, 1, 1, 1, 0, 1])
  assert.deepEqual(c.errors, [{ taskId: 't1', nodeId: 'n1', message: 'state.inventory is undefined' }])
  const k = stats.get(calc)
  assert.deepEqual([k.calls, k.ok, k.fail, k.error], [2, 1, 0, 1])
  assert.equal(stats.get('task/draft@33333333'), null)
  assert.deepEqual(Object.keys(stats.data.refs).sort(), [calc, cond])

  assert.equal(usageSummary(c, 'condition'), '用过 3 次 / 1 个任务（0 成 1 败），判真 1 / 判假 1 / 报错 1')
  assert.equal(usageSummary(k, 'compute'), '用过 2 次 / 1 个任务（0 成 1 败），成功 1 / 失败 1')
  assert.equal(usageSummary(null, 'compute'), '尚无记录')
  assert.equal(usageSummary(null, 'condition', 'code/fast.low-health'), '尚无记录（快树里的使用不计入）')
})

test('统计：同一任务只并一次；草稿转正把数字拷到新条目的 draft；按名字汇总各版本', () => {
  const stats = new CapsuleStats()
  const feed = (taskId, ref, status, end = 'task/done') => {
    stats.observe(exit(taskId, 'n1', 'Compute', ref, status))
    stats.observe({ taskId, event: end, at: 'x' })
  }
  feed('t1', 'code/a@aaaaaaaa', 'SUCCESS')
  assert.equal(stats.observe({ taskId: 't1', event: 'task/done' }), false, '重复的结束事件不翻倍')
  assert.equal(stats.get('code/a@aaaaaaaa').tasks, 1)
  feed('t2', 'code/a@bbbbbbbb', 'FAILURE', 'task/failed')
  const named = stats.byName('code/a')
  assert.deepEqual([named.total.calls, named.total.tasks, named.total.tasksDone, named.total.tasksFailed], [2, 2, 1, 1])
  assert.deepEqual(named.versions.map((v) => v.hash).sort(), ['aaaaaaaa', 'bbbbbbbb'])
  assert.equal(stats.byName('code/none'), null)

  feed('t3', 'task/plan@cccccccc', 'SUCCESS')
  const saved = { taskId: 't3', event: 'capsule/saved', from: 'task/plan', ref: 'code/craft.plan@dddddddd' }
  assert.equal(stats.observe(saved), true)
  assert.equal(stats.observe(saved), false, '同一次转正只记一次')
  const promoted = stats.get('code/craft.plan@dddddddd')
  assert.deepEqual([promoted.calls, promoted.draft.calls, promoted.draft.ok, promoted.draft.tasks, promoted.draft.tasksDone], [0, 1, 1, 1, 1])
  assert.equal(usageSummary(promoted, 'compute'), '转正前（草稿）：用过 1 次 / 1 个任务，成功 1 / 失败 0')

  assert.equal(stats.curateState().sinceLast, 3)
  stats.curateStarted('k1', 'now')
  assert.deepEqual(stats.curateState(), { sinceLast: 0, lastAt: 'now', lastRequestId: 'k1', lastTaskAt: 'x' })
})

test('统计：落盘到 stats.json；重建从 events.jsonl 重算，结果与在线累计一致，整理计数保留', () => {
  const dir = tempDir()
  const runtimeDir = path.join(dir, 'runtime')
  const records = [
    exit('task-1', 'n1', 'Condition', 'code/x@11111111', 'SUCCESS'),
    { taskId: 'task-1', event: 'task/done', at: 'a' },
    exit('task-2', 'n1', 'Compute', 'task/d@22222222', 'SUCCESS'),
    { taskId: 'task-2', event: 'task/done', at: 'b' },
    { taskId: 'task-2', event: 'capsule/saved', from: 'task/d', ref: 'code/d@33333333' }
  ]
  for (const r of records) {
    const file = path.join(runtimeDir, 'tasks', r.taskId, 'events.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(r) + '\n')
  }
  const live = new CapsuleStats({ dir: path.join(dir, 'capsules') })
  for (const r of records) live.observe(r)
  live.curateStarted('k1', 'then')
  const reloaded = new CapsuleStats({ dir: path.join(dir, 'capsules') })
  assert.deepEqual(reloaded.data, live.data)

  const result = rebuildStats(reloaded, runtimeDir)
  assert.deepEqual(result, { tasks: 2, excluded: 0, recorded: 2, refs: 2 })
  assert.deepEqual(reloaded.data.refs, live.data.refs)
  assert.equal(reloaded.curateState().lastRequestId, 'k1', '重建不动整理计数')
  assert.equal(reloaded.curateState().sinceLast, live.curateState().sinceLast, '重算时的任务结束不累加到整理计数上')

  // exclude：该任务的使用和它的转正记录都不算；不存在的 id 不计入 excluded
  const without = rebuildStats(reloaded, runtimeDir, { exclude: ['task-2', 'task-404'] })
  assert.deepEqual(without, { tasks: 1, excluded: 1, recorded: 1, refs: 1 })
  assert.deepEqual(Object.keys(reloaded.data.refs), ['code/x@11111111'])
  assert.deepEqual(reloaded.data.tasks, ['task-1'])
  assert.deepEqual(reloaded.data.promotions, [])
})

function setup() {
  const rt = makeRuntime()
  const stats = new CapsuleStats({ dir: path.join(rt.dir, 'capsules') })
  rt.executor.on('event', (record) => stats.observe(record))
  const delivered = []
  const bridge = new Bridge({
    executor: rt.executor, library: rt.library, sandbox: rt.sandbox, registry: rt.registry, prompts, stats,
    deliver: (sessionId, message) => { delivered.push({ sessionId, ...message }); return true }
  })
  const claim = (turn) => {
    const message = delivered.at(-1)
    return bridge.onPreStep({ sessionId: message.sessionId, turn, step: 1, messages: [{ source: message.source }] })
  }
  const defs = createTools({
    game: rt.game, registry: rt.registry, library: rt.library, stats, bridge,
    methods: METHODS, readMethods: READ_METHODS, nbt: null, nbtSources: NBT_SOURCES,
    json: rt.json, jsonSources: ['recipes'], taskId: () => bridge.currentTaskId(), maxOutputChars: 8000
  })
  const tools = Object.fromEntries(defs.map((def) => [def.name, defineTool(def)]))
  const call = (name, args) => tools[name].execute(args, { agent: { id: 's1' } })
  return { ...rt, stats, bridge, delivered, claim, call }
}

const DOUBLE = {
  double: {
    description: '乘 2',
    signature: { inputs: { n: { type: 'int', required: true } }, outputs: { double: { type: 'int' } } },
    body: 'function main(p: { n: number }) { return { double: p.n * 2 } }'
  }
}

test('端到端：节点退出事件带钉过哈希的 ref；任务结束并进总账；复盘转正带上草稿数字；capsule_search / capsule_get 展示统计、排序不变', async () => {
  const ctx = setup()
  const { bridge, executor, events, claim, call, stats, refs } = ctx
  const plan = bridge.startPlanning({ sessionId: 's1', instruction: '演示' })
  claim(1)
  const tree = {
    seq: '演示',
    do: [
      { sel: '有钻石或继续', do: [{ cond: 'code/test.has-item', read: ['inventory'], params: { item: 'diamond', count: 999 } }, { steps: '切栏', do: [['key/hotbar', { slot: 1 }]] }] },
      { expand: '算 42' }
    ]
  }
  assert.equal(bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree }).ok, true)
  await runUntil(executor, () => executor.task.state === 'suspended')
  const expand = claim(2)
  const subtree = { compute: 'task/double', params: { n: 21 }, writes: { 'calc.double': 'double' } }
  assert.equal(bridge.submitExpansion({ sessionId: 's1', requestId: expand.requestId, subtree, code: DOUBLE }).ok, true)
  await runUntil(executor, () => executor.task.state === 'done')

  const condExit = events.find((e) => e.event === 'node' && e.phase === 'exit' && e.type === 'Condition')
  assert.equal(condExit.ref, refs['test.has-item'])
  assert.equal(condExit.status, 'FAILURE')
  assert.ok(!events.some((e) => e.event === 'node' && e.phase === 'enter' && e.ref), '进入事件不带 ref')
  assert.ok(!events.some((e) => e.event === 'node' && e.type === 'Steps' && e.ref))
  const has = stats.get(refs['test.has-item'])
  assert.deepEqual([has.calls, has.ok, has.fail, has.error, has.tasksDone], [1, 0, 1, 0, 1])
  assert.equal(stats.curateState().sinceLast, 1)

  claim(3)
  const saved = bridge.saveCapsule({ sessionId: 's1', requestId: 'c1', folder: 'code', name: 'math.double', description: '乘 2', from: 'task/double' })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.equal(stats.get(saved.ref).draft.calls, 1)

  const listed = (await call('capsule_search', {})).items
  assert.deepEqual(listed.map((r) => r.ref), ctx.library.list().map((r) => r.ref.slice(0, r.ref.lastIndexOf('@'))).sort(), '排序不看统计（不给 query 时按名字）')
  assert.ok(listed.every((r) => r.usage === undefined), '搜索结果不带统计（2026-11-21：只给名字）')
  assert.equal((await call('capsule_get', { ref: 'code/test.has-item' })).usage.allVersions,
    '用过 1 次 / 1 个任务（1 成 0 败），判真 0 / 判假 1 / 报错 0；跨实例：在 1 种参数组合上成功过（共 1 种），未跨实例验证')
  assert.deepEqual(condExit.args, { count: 999, item: 'diamond' }, '退出事件带实参指纹（2026-11-13）')
  assert.deepEqual(Object.keys(has.instances), ['{"count":999,"item":"diamond"}'])
  assert.equal((await call('capsule_get', { ref: 'code/test.air-below' })).usage.allVersions, '尚无记录')
  assert.match((await call('capsule_get', { ref: saved.ref })).usage.allVersions, /^转正前（草稿）：用过 1 次/)
  const got = await call('capsule_get', { ref: 'code/test.has-item' })
  assert.equal(got.usage.thisVersion, got.usage.allVersions)
  assert.ok(got.usage.lastUsed)
})

test('跨实例（2026-11-13）：按实参指纹分开计数；同名各版本汇总；没有参数按任务；旧事件没有 args 只进总数', () => {
  const stats = new CapsuleStats()
  const exit = (taskId, ref, status, args) => stats.observe({ taskId, event: 'node', phase: 'exit', type: 'SubTree', id: 'n1', ref, status, args, at: '2026-11-13T00:00:00Z' })
  const end = (taskId) => stats.observe({ taskId, event: 'task/done', at: '2026-11-13T00:00:01Z' })
  exit('t1', 'trees/craft.x@aaaaaaaa', 'SUCCESS', { goal: 3, target: 'minecraft:white_bed' }); end('t1')
  exit('t2', 'trees/craft.x@aaaaaaaa', 'SUCCESS', { goal: 5, target: 'minecraft:red_bed' }); end('t2')
  exit('t3', 'trees/craft.x@bbbbbbbb', 'FAILURE', { goal: 2, target: 'minecraft:rabbit_stew' }); end('t3')
  exit('t4', 'trees/craft.x@bbbbbbbb', 'SUCCESS', undefined); end('t4')
  const total = stats.byName('trees/craft.x').total
  assert.equal(total.calls, 4, '旧事件照样进总数')
  assert.equal(Object.keys(total.instances).length, 3)
  assert.equal(usageSummary(total, 'tree').match(/跨实例：.*$/)[0],
    '跨实例：在 2 种参数组合上成功过（共 3 种；变过的参数：goal 3 种、target 3 种）；没成功过的组合：goal=2, target="minecraft:rabbit_stew"')
  assert.doesNotMatch(usageSummary(stats.get('trees/craft.x@bbbbbbbb'), 'tree'), /在 2 种/, '单个版本只算自己的')

  exit('t5', 'code/inv.count@cccccccc', 'SUCCESS', {}); end('t5')
  exit('t6', 'code/inv.count@cccccccc', 'SUCCESS', {}); end('t6')
  assert.match(usageSummary(stats.get('code/inv.count@cccccccc'), 'compute'), /跨实例：没有输入参数，按任务算——在 2 个任务里成功过（共 2 个）$/)
  assert.doesNotMatch(usageSummary(stats.get('trees/craft.x@aaaaaaaa'), 'tree'), /未跨实例验证/)
})

test('调用处出错（2026-11-13）：缺 read / 实参不合签名 / $键解析不了 → callError，不算条目失败、不进跨实例；代码自己的错和 SubTree 照旧算失败', () => {
  const stats = new CapsuleStats()
  const ref = 'code/craft.plan@aaaaaaaa'
  const exit = (taskId, error, extra = {}) => stats.observe({ taskId, event: 'node', phase: 'exit', type: 'Compute', id: 'n1', ref, status: error ? 'FAILURE' : 'SUCCESS', error, args: { goal: 31, target: `minecraft:${taskId}` }, ...extra })
  exit('t1', 'state.inventory is not read by this node: add "inventory" to the node\'s read (e.g. read: ["inventory"])')
  exit('t2', 'code/craft.plan@aaaaaaaa: missing required param "recipe"')
  exit('t3', 'code/craft.plan@aaaaaaaa: param "goal" must be number')
  exit('t4', 'blackboard has no key "craft.recipes"')
  exit('t5', 'code/craft.plan@aaaaaaaa: returned undeclared output "dirty"')
  exit('t6', null)
  stats.observe({ taskId: 't7', event: 'node', phase: 'exit', type: 'SubTree', id: 'n1', ref: 'trees/x@bbbbbbbb', status: 'FAILURE', error: 'state.inventory is not read by this node', args: { goal: 1 } })
  for (const t of ['t1', 't2', 't3', 't4', 't5', 't6', 't7']) stats.observe({ taskId: t, event: 'task/done' })
  const row = stats.get(ref)
  assert.deepEqual([row.calls, row.ok, row.error, row.callError], [6, 1, 1, 4])
  assert.deepEqual(Object.keys(row.instances).map((k) => JSON.parse(k).target), ['minecraft:t5', 'minecraft:t6'], '调用处出错的组合不进 instances')
  const usage = usageSummary(row, 'compute')
  assert.match(usage, /成功 1 \/ 失败 1 \/ 调用处出错 4（缺 read、实参不合签名等，不算条目失败）/)
  assert.match(usage, /跨实例：在 1 种参数组合上成功过（共 2 种.*没成功过的组合：goal=31, target="minecraft:t5"/)
  assert.equal(stats.get('trees/x@bbbbbbbb').error, 1, 'SubTree 的错误是子节点传上来的，照旧算失败')
  assert.equal(row.errors.length, 3, '错误样本里调用处出错也留着（规划时看得到"要加 read"）')
})
