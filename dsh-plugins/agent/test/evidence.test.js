import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeMod } from './fake_mod.js'
import { makeRuntime, runUntil } from './helpers.js'
import { SnapshotBuffer, renderDirectory } from '../src/bt/evidence.js'

const observe = { observe: { enabled: true } }
const hotbar = (slot) => ({ act: 'key/hotbar', params: { slot } })
const hasItem = (item, count = 1) => ({ cond: 'code/test.has-item', read: ['inventory'], params: { item, count } })

/** 跑到 failed 请求：n1.1 切栏位，n1.2 条件"有钻石"不成立（原地重试一次后仍不成立）。 */
async function failedTask() {
  const mod = new FakeMod({ inventory: { 12: ['stick', 3] } })
  const rt = makeRuntime({ mod, config: observe })
  rt.executor.startTask({ tree: { seq: '拿钻石', do: [hotbar(1), { ...hasItem('diamond'), name: '有钻石' }] }, blackboard: { want: 'diamond' } })
  await runUntil(rt.executor, () => rt.requests.length > 0)
  return rt
}

test('failed 请求只推目录：标题、路径、快照名、事件条数、黑板键名——不含快照内容与黑板值', async () => {
  const { requests } = await failedTask()
  const { type, directory } = requests[0]
  assert.equal(type, 'failed')
  assert.match(directory.title, /节点 n1\.2「有钻石」失败（已原地重试过一次）/)
  assert.deepEqual(directory.path, [{ id: 'n1', name: '拿钻石' }, { id: 'n1.2', name: '有钻石' }])
  assert.deepEqual(directory.snapshots, ['after@n1.1', 'before@n1.1'], 'Condition 不改世界，不存快照；Action 存前后两份')
  assert.ok(directory.events > 0)
  assert.deepEqual(directory.blackboard, ['want'])

  const text = renderDirectory(directory)
  assert.match(text, /路径：n1「拿钻石」 → n1\.2「有钻石」/)
  assert.match(text, /黑板  1 个键：want/)
  assert.doesNotMatch(text, /diamond|stick/, '目录里没有任何值')
})

test('bt_inspect：events 过滤、snapshot 与差异、live 存成快照、node 的执行次数', async () => {
  const { executor, mod } = await failedTask()

  const events = await executor.inspect({ what: 'events', node: 'n1.2', type: 'node', last: 10 })
  assert.equal(events.ok, true)
  assert.ok(events.value.events.every((e) => e.event === 'node' && e.id.startsWith('n1.2')))
  assert.ok(events.value.events.some((e) => e.phase === 'exit' && e.status === 'FAILURE'))

  const before = await executor.inspect({ what: 'snapshot', name: 'before@n1.1', sources: ['inventory'] })
  assert.deepEqual(Object.keys(before.value.state), ['inventory'])
  assert.deepEqual(before.value.state.inventory.slots.map((s) => s.id), ['minecraft:stick'])

  mod.inv[5] = { id: 'minecraft:oak_planks', count: 3 }
  const live = await executor.inspect({ what: 'live', sources: ['inventory'] })
  assert.equal(live.value.name, 'live#1')
  const diff = await executor.inspect({ what: 'snapshot', name: 'live#1', against: 'before@n1.1' })
  assert.deepEqual(diff.value.diff.inventory, [{ slot: 5, before: '空', after: 'oak_planks×3' }])
  assert.match(diff.value.summary, /\[5\] 空 → oak_planks×3/)

  const node = await executor.inspect({ what: 'node', id: 'n1.2' })
  assert.equal(node.value.executions, 2, '原地重试过一次')
  assert.equal(node.value.spec.cmd ?? node.value.spec.ref.split('@')[0], 'code/test.has-item')
  assert.equal(node.value.origin, null)

  const missing = await executor.inspect({ what: 'snapshot', name: 'nope' })
  assert.match(missing.error, /no snapshot "nope"; available: live#1, after@n1\.1, before@n1\.1/)
  assert.match((await executor.inspect({ what: 'fly' })).error, /what must be one of/)
})

test('bt_inspect：eval 用现在 / 某份快照的状态对条件求值；blackboard 给值', async () => {
  const { executor, mod } = await failedTask()
  assert.equal((await executor.inspect({ what: 'eval', id: 'n1.2' })).value.result, false)
  mod.inv[0] = { id: 'minecraft:diamond', count: 1 }
  assert.equal((await executor.inspect({ what: 'eval', id: 'n1.2' })).value.result, true, '现场读')
  assert.equal((await executor.inspect({ what: 'eval', id: 'n1.2', at: 'before@n1.1' })).value.result, false, '用旧快照')
  assert.match((await executor.inspect({ what: 'eval', id: 'n1.1' })).error, /is a Action; eval only evaluates Condition/)

  const bb = await executor.inspect({ what: 'blackboard', keys: ['want', 'nope'] })
  assert.deepEqual(bb.value, { values: { want: 'diamond' }, missing: ['nope'] })
})

test('补丁之后：node 显示补丁来源；新叶子再执行的快照带 #n', async () => {
  const { executor, requests, mod } = await failedTask()
  mod.inv[0] = { id: 'minecraft:diamond', count: 1 }
  const patch = executor.submitPatch(requests[0].requestId, [{ op: 'insert-before', id: 'n1.2', node: { seq: '再切一次', do: [hotbar(2)] } }])
  assert.equal(patch.ok, true, JSON.stringify(patch.errors))
  await runUntil(executor, () => executor.task.state === 'done')
  const inner = await executor.inspect({ what: 'node', id: 'n1.2.p2.1' })
  assert.deepEqual(inner.value.origin, { request: requests[0].requestId, type: 'failed' }, '从补丁子树根上继承')
  assert.ok(executor.task.snapshots.names().includes('before@n1.2.p2.1'))
})

test('快照缓冲：同一叶子再执行带 #n；只保留最近 keep 次叶子执行；特殊时刻不淘汰', () => {
  const buf = new SnapshotBuffer({ keep: 2 })
  let t = 0
  buf.moment('interrupt', { player: 1 }, ++t)
  buf.leafBefore('n1', {}, ++t); buf.leafAfter('n1', {}, ++t)
  buf.leafBefore('n1', {}, ++t); buf.leafAfter('n1', {}, ++t)
  buf.leafBefore('n2', {}, ++t)
  assert.deepEqual(buf.names(), ['before@n2', 'after@n1#2', 'before@n1#2', 'interrupt'])
  buf.leafAfter('n1', {}, ++t)
  assert.equal(buf.get('after@n1'), null, '被淘汰的执行不会再补"后"快照')
  assert.equal(buf.moment('interrupt', {}, ++t), 'interrupt#2')
  assert.equal(buf.moment('live', {}, ++t, { numbered: true }), 'live#1')
})

test('recover：中断时存 interrupt（缓存）、情节结束现场读全存 episode-end；escalate 带 arm 的错误原文', async () => {
  for (const [armThen, type] of [
    [{ steps: '跳', do: [['key/jump', { pressed: true }], ['key/jump', { pressed: false }]] }, 'recover'],
    [{ act: 'container/slot', params: { slot: 0 } }, 'escalate']
  ]) {
    const mod = new FakeMod()
    const { executor, game, requests } = makeRuntime({ mod, config: observe })
    executor.loadFastTree({ match: '局势', arms: [
      { when: { cond: 'code/test.air-below', read: ['player'], params: { value: 100 } }, then: armThen }
    ] })
    executor.startTask({ tree: { seq: 'job', do: [{ steps: '长时间前进', do: [['key/up', { pressed: true }], ['wait', 40], ['key/up', { pressed: false }]] }] } })
    const poll = () => game.pollOnce()
    await runUntil(executor, () => mod.pressed.has('key/up'), { beforeTick: poll })
    mod.air = 50
    await runUntil(executor, () => executor.episode?.phase === 'running', { beforeTick: poll })
    mod.air = 300
    await runUntil(executor, () => requests.length > 0, { beforeTick: poll })

    const { directory } = requests[0]
    assert.equal(requests[0].type, type)
    assert.match(directory.title, /快树情节「.+」以 (SUCCESS|FAILURE) 结束；被它中断的 n1\.1「长时间前进」已归零/)
    assert.ok(directory.snapshots.includes('interrupt') && directory.snapshots.includes('episode-end'), directory.snapshots.join())
    const end = executor.task.snapshots.get('episode-end').state
    assert.deepEqual(Object.keys(end).sort(), ['container', 'f3', 'inventory', 'player'], '情节结束现场读全')
    assert.ok('player' in executor.task.snapshots.get('interrupt').state, '中断时用缓存（快树轮询的 player + 之前读过的来源）')
    if (type === 'escalate') assert.match(directory.error, /no menu for screen none/)
    else assert.equal(directory.error, null)
  }
})

test('在飞请求过期（死亡）被拒时附上新的目录', async () => {
  const mod = new FakeMod({ inventory: { 12: ['stick', 3] } })
  const { executor, game, requests } = makeRuntime({ mod, config: { ...observe, respawnPollMs: 5 } })
  executor.startTask({ tree: { seq: 's', do: [hotbar(1), hasItem('diamond')] } })
  const poll = () => game.pollOnce()
  await runUntil(executor, () => requests.length > 0, { beforeTick: poll })
  mod.health = 0
  mod.deathMessage = 'Steve drowned'
  await runUntil(executor, () => executor.task.pending.stale && executor.task.snapshots.get('respawn'), { beforeTick: poll, maxTicks: 20000 })

  const rejected = executor.submitPatch(requests[0].requestId, [])
  assert.equal(rejected.stale, true)
  assert.equal(rejected.events[0].event, 'died')
  assert.equal(rejected.directory.type, 'failed')
  assert.ok(rejected.directory.snapshots.includes('death') && rejected.directory.snapshots.includes('respawn'))
})
