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
  assert.deepEqual(result, { tasks: 2, recorded: 2, refs: 2 })
  assert.deepEqual(reloaded.data.refs, live.data.refs)
  assert.equal(reloaded.curateState().lastRequestId, 'k1', '重建不动整理计数')
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

  const listed = await call('capsule_search', {})
  assert.deepEqual(listed.map((r) => r.ref), ctx.library.list().map((r) => r.ref), '排序不看统计')
  assert.equal(listed.find((r) => r.ref === refs['test.has-item']).usage, '用过 1 次 / 1 个任务（1 成 0 败），判真 0 / 判假 1 / 报错 0')
  assert.equal(listed.find((r) => r.ref === refs['test.air-below']).usage, '尚无记录')
  assert.match(listed.find((r) => r.ref === saved.ref).usage, /^转正前（草稿）：用过 1 次/)
  const got = await call('capsule_get', { ref: 'code/test.has-item' })
  assert.equal(got.usage.thisVersion, got.usage.allVersions)
  assert.ok(got.usage.lastUsed)
})
