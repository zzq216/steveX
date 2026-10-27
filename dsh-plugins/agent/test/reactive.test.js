import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { FakeMod } from './fake_mod.js'
import { makeRuntime, runUntil } from './helpers.js'
import { compileTree } from '../src/bt/compiler.js'
import { validateTree } from '../src/bt/validator.js'
import { createDefaultRegistry } from '../src/commands.js'
import { pinRefs } from '../src/bt/build.js'

const hasStick = { cond: 'code/test.has-item', read: ['inventory'], params: { item: 'stick' } }
const walk = (ms) => ({ steps: '前进', do: [['key/up', { pressed: true }], ['wait', ms], ['key/up', { pressed: false }]] })
const inventoryReads = (mod) => mod.calls.filter(([m]) => m === 'inventory').length
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('reactive seq + every：守卫现场读取返回 RUNNING 不中止正在跑的动作；间隔内不重跑守卫', async () => {
  const mod = new FakeMod({ inventory: { 12: ['stick', 1] } })
  const { executor } = makeRuntime({ mod })
  executor.startTask({ tree: { seq: '边走边看', mode: 'reactive', every: 200, do: [hasStick, walk(700)] } })
  await runUntil(executor, () => executor.task.state !== 'running', { maxTicks: 20000 })

  assert.equal(executor.task.state, 'done')
  assert.equal(mod.calls.filter(([m, p]) => m === 'key/up' && p.pressed === true).length, 1, '前进只开始了一次：复查没有中止它')
  const reads = inventoryReads(mod)
  assert.ok(reads >= 3 && reads <= 6, `700 ms / 200 ms 间隔 → 首次 + 约 3 次复查，实际 ${reads} 次`)
})

test('reactive seq + every：复查时守卫不成立 → 中止动作（松键），序列 FAILURE', async () => {
  const mod = new FakeMod({ inventory: { 12: ['stick', 1] } })
  const { executor, requests } = makeRuntime({ mod })
  executor.startTask({ tree: { seq: '边走边看', mode: 'reactive', every: 200, do: [hasStick, walk(5000)] } })
  await runUntil(executor, () => mod.pressed.has('key/up'))
  const start = Date.now()
  mod.inv[12] = null

  await runUntil(executor, () => requests.some((r) => r.type === 'failed'), { maxTicks: 20000 })
  assert.ok(Date.now() - start < 1500, '下一次复查就发现了')
  await runUntil(executor, () => !mod.pressed.has('key/up'))
  assert.equal(mod.screen, 'none')
  assert.equal(requests.at(-1).evidence.nodeId, 'n1.1', '失败的是守卫')
})

test('reactive 的校验（P2-D16）：守卫不能有动作、任务树不能用 reactive sel、every 下限 200；快树里 reactive seq / sel 前面也只能是纯节点', () => {
  const registry = createDefaultRegistry()
  const { library } = makeRuntime()
  const check = (tree, kind = 'task') => validateTree(pinRefs(compileTree(tree, { kind }), library).spec, { registry, library, kind }).errors.join('\n')

  assert.equal(check({ seq: 'ok', mode: 'reactive', every: 500, do: [{ cond: 'blackboard/has', params: { key: 'x' } }, walk(10)] }).includes('reactive'), false)
  assert.match(check({ seq: 's', mode: 'reactive', do: [walk(10), { cond: 'blackboard/has', params: { key: 'x' } }] }), /n1\.1 \(Steps\) comes before the last child of a reactive seq/)
  assert.match(check({ seq: 's', mode: 'reactive', do: [{ seq: 'g', do: [{ act: 'key/hotbar', params: { slot: 1 } }] }, walk(10)] }), /n1\.1 \(Sequence\) comes before the last child/)
  assert.match(check({ sel: 's', mode: 'reactive', do: [walk(10), walk(20)] }), /reactive sel is not allowed in a task tree/)
  assert.match(check({ seq: 's', mode: 'reactive', every: 50, do: [walk(10)] }), /every must be an integer >= 200/)
  assert.match(check({ seq: 's', every: 500, do: [walk(10)] }), /every only applies to a reactive seq/)

  const arm = (then) => ({ match: 'f', arms: [{ when: { cond: 'code/test.air-below', read: ['player'], params: { value: 100 } }, then }] })
  assert.equal(check(arm({ seq: '两步', do: [walk(10), walk(20)] }), 'fast'), '', '快树 seq 缺省 memory，多个动作照写')
  assert.match(check(arm({ seq: '两步', mode: 'reactive', do: [walk(10), walk(20)] }), 'fast'), /comes before the last child of a reactive seq/)
  assert.match(check(arm({ sel: 'r', mode: 'reactive', do: [walk(10), walk(20)] }), 'fast'), /comes before the last child of a reactive sel/)
  assert.equal(check(arm({ seq: 'g', mode: 'reactive', every: 100, do: [{ cond: 'code/test.air-below', read: ['player'], params: { value: 200 } }, walk(10)] }), 'fast'), '', '快树守卫 + 动作照用，every 不受 200 下限')
})

test('同一任务里第二次查询读到新数据（P2-D15）；失败请求的目录列出换代的记忆来源（P2-D17）', async () => {
  const { executor, requests, dir } = makeRuntime({ config: { observe: { enabled: true } } })
  const file = path.join(dir, 'recipes.json')
  const query = (key) => ({ compute: 'code/core.json.query', params: { path: 'recipes', records: 'recipes', fields: ['type'], limit: 1 }, writes: { [key]: 'matchedCount' } })
  executor.startTask({ tree: { seq: '查两次', do: [
    query('first'),
    walk(60),
    query('second'),
    { cond: 'blackboard/compare', params: { key: 'second', op: '==', value: '$first' } }
  ] } })

  await runUntil(executor, () => executor.task.blackboard.has('first'))
  const original = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ recipes: original.recipes.slice(0, 2) }))

  await runUntil(executor, () => requests.some((r) => r.type === 'failed'), { maxTicks: 20000 })
  assert.equal(executor.task.blackboard.get('second'), 2, '第二次查询看到了改过的文件')
  assert.ok(executor.task.blackboard.get('first') > 2)

  // 第二次查询之后文件没再变：只有 n1.1（读的是旧版本）算换代
  const { directory } = requests.at(-1)
  assert.deepEqual(directory.versions.map((v) => [v.nodeId, v.source]), [['n1.1', 'recipes']])

  const versions = await executor.inspect({ what: 'versions' })
  assert.deepEqual(versions.value.queries.map((q) => [q.nodeId, q.changed]), [['n1.1', true], ['n1.3', false]])
  await sleep(1)
})
