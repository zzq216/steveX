import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeMod } from './fake_mod.js'
import { makeRuntime, runUntil } from './helpers.js'
import { createLocalResponder } from '../src/bt/index.js'

const pressedFalse = (mod, method) => mod.calls.some(([m, p]) => m === method && p.pressed === false)
const hasItem = (item, count = 1) => ({ cond: 'code/test.has-item', read: ['inventory'], params: { item, count } })

test('Sequence(memory) 跑完 Steps、Action 与条件代码，根 SUCCESS → done', async () => {
  const mod = new FakeMod({ inventory: { 12: ['stick', 3] } })
  const { executor, events } = makeRuntime({ mod })
  executor.startTask({ tree: { seq: 'go', do: [
    { steps: '走两步', do: [['key/up', { pressed: true }], ['wait', 5], ['key/up', { pressed: false }]] },
    { act: 'key/hotbar', params: { slot: 4 } },
    hasItem('stick', 3)
  ] } })

  await runUntil(executor, () => executor.task.state === 'done')
  assert.equal(mod.selected, 4)
  assert.ok(events.some((e) => e.event === 'node' && e.id === 'n1.1' && e.phase === 'exit' && e.status === 'SUCCESS'))
  assert.equal(events.at(-1).event, 'task/done')
  assert.match(executor.task.spec.children[2].ref, /^code\/test\.has-item@[0-9a-f]{8}$/, '存进树的引用被钉到了 hash')
})

test('条件代码不成立 → FAILURE；返回非布尔值是错误', async () => {
  const bad = { folder: 'code', name: 'test.not-bool', signature: { returns: 'bool' }, body: 'function main() { return 1 }' }
  const { executor } = makeRuntime({ capsules: [bad] })
  executor.startTask({ tree: { sel: 'x', do: [hasItem('diamond'), { cond: 'code/test.not-bool' }] } })
  await runUntil(executor, () => executor.task.state === 'suspended')
  const notBool = executor.task.byId.get('n1.2')
  assert.match(notBool.lastError, /must return true \/ false, got 1/)
})

test('Repeat until：每轮先查条件；writes "+1" 递增', async () => {
  const { executor } = makeRuntime()
  executor.startTask({ tree: { repeat: '数到 3', maxIterations: 10,
    until: { cond: 'blackboard/compare', params: { key: 'n', op: '>=', value: 3 } },
    do: { act: 'key/hotbar', params: { slot: 1 }, writes: { n: '+1' } } } })
  await runUntil(executor, () => executor.task.state === 'done')
  assert.equal(executor.task.blackboard.get('n'), 3)
})

test('PendingExpansion → expand 请求；展开后从原位置继续；id 以被替换节点为前缀', async () => {
  const { executor, requests } = makeRuntime({ mod: new FakeMod({ inventory: { 3: ['stick', 1] } }) })
  executor.startTask({ tree: { seq: 's', do: [{ expand: '选中第三格' }, hasItem('stick')] } })

  await runUntil(executor, () => executor.task.state === 'suspended')
  const req = requests.at(-1)
  assert.equal(req.type, 'expand')
  assert.equal(req.evidence.nodeId, 'n1.1')

  const res = executor.submitExpansion(req.requestId, { act: 'key/hotbar', params: { slot: 3 } })
  assert.equal(res.ok, true)
  assert.deepEqual(res.ids, ['n1.1.1'])
  assert.equal(executor.task.version, 2)
  await runUntil(executor, () => executor.task.state === 'done')
})

test('展开不合法：错误原文返回；同一请求第 3 次不合法 → 任务失败；不存在的胶囊也算不合法', async () => {
  const { executor, requests } = makeRuntime()
  executor.startTask({ tree: { seq: 's', do: [{ expand: '随便' }] } })
  await runUntil(executor, () => executor.task.state === 'suspended')
  const { requestId } = requests.at(-1)

  const first = executor.submitExpansion(requestId, { act: 'teleport' })
  assert.equal(first.ok, false)
  assert.match(first.errors[0], /unknown command "teleport"/)
  assert.equal(first.attemptsLeft, 2)
  const second = executor.submitExpansion(requestId, { compute: 'code/no.such-thing' })
  assert.match(second.errors[0], /no capsule named code\/no\.such-thing/)
  const third = executor.submitExpansion(requestId, { act: 'teleport' })
  assert.equal(third.taskFailed, true)
  assert.equal(executor.task.state, 'failed')
})

test('展开超过节点数上限被拒，提示改用 expand', async () => {
  const { executor, requests } = makeRuntime({ config: { maxExpansionNodes: 2 } })
  executor.startTask({ tree: { seq: 's', do: [{ expand: 'x' }] } })
  await runUntil(executor, () => executor.task.state === 'suspended')
  const res = executor.submitExpansion(requests.at(-1).requestId, { seq: 'big', do: [{ expand: 'a' }, { expand: 'b' }] })
  assert.match(res.errors.join('\n'), /over the limit of 2/)
})

test('根 FAILURE：失败叶子原地重试一次（§7.5 ①），再失败 → failed 请求；本地应答器放弃任务并松键', async () => {
  const mod = new FakeMod()
  const { executor, events, requests } = makeRuntime({ mod })
  createLocalResponder(executor)
  executor.startTask({ tree: { seq: 's', do: [
    { act: 'key/hotbar', params: { slot: 2 } },
    { act: 'container/slot', params: { slot: 0 } } // 没开界面：假 mod 报错
  ] } })

  await runUntil(executor, () => executor.task.state === 'failed')
  const retry = events.find((e) => e.event === 'task/retry')
  assert.equal(retry.nodeId, 'n1.2')
  assert.equal(requests.at(-1).type, 'failed')
  assert.match(requests.at(-1).evidence.error, /no menu for screen none/)
  assert.equal(mod.calls.filter(([m]) => m === 'key/hotbar').length, 1, '游标保留在失败的叶子上，前一步没重跑')
  await runUntil(executor, () => events.some((e) => e.event === 'controls/released'))
})

test('快树抢占（when 是条件代码）：先中止任务树并松键，再跑 arm；情节结束 → recover，被中断的 Steps 整段重跑', async () => {
  const mod = new FakeMod()
  const { executor, game, events, requests } = makeRuntime({ mod })
  createLocalResponder(executor)
  executor.loadFastTree({ match: '局势', arms: [
    { when: { cond: 'code/test.air-below', read: ['player'], params: { value: 100 } },
      then: { seq: '上浮', do: [{ steps: '跳', do: [['key/jump', { pressed: true }], ['wait', 5], ['key/jump', { pressed: false }]] }] } }
  ] })
  assert.deepEqual([...game.pollSources], ['player'], '轮询集合由快树 when 的 read 推出')

  executor.startTask({ tree: { seq: 'job', do: [
    { act: 'key/hotbar', params: { slot: 1 } },
    { steps: '长时间前进', do: [['key/up', { pressed: true }], ['wait', 40], ['key/up', { pressed: false }]] }
  ] } })

  const poll = () => game.pollOnce()
  await runUntil(executor, () => mod.pressed.has('key/up'), { beforeTick: poll })

  mod.air = 50
  await runUntil(executor, () => executor.episode?.phase === 'running', { beforeTick: poll })
  assert.equal(executor.episode.interrupted.id, 'n1.2')
  assert.ok(pressedFalse(mod, 'key/up'), '抢占时默认中止流程松开了前进键')
  assert.equal(executor.task.root.cursor, 1, '外层 Sequence 的游标仍指向被中断的 Steps')

  mod.air = 300
  await runUntil(executor, () => requests.some((r) => r.type === 'recover'), { beforeTick: poll })
  assert.equal(requests.find((r) => r.type === 'recover').evidence.fastArm, '上浮')

  await runUntil(executor, () => executor.task.state === 'done', { beforeTick: poll })
  assert.equal(mod.calls.filter(([m]) => m === 'key/hotbar').length, 1, '前一步没有重跑')
  assert.equal(mod.calls.filter(([m, p]) => m === 'key/up' && p.pressed === true).length, 2, 'Steps 整段重跑了一次')
  assert.ok(events.some((e) => e.event === 'fast/episode-end' && e.status === 'SUCCESS'))
})

test('展开请求在飞时被快树情节打断：不过期（P2-D13），展开照常被接受', async () => {
  const mod = new FakeMod()
  const { executor, game, requests } = makeRuntime({ mod })
  executor.loadFastTree({ match: '局势', arms: [
    { when: { cond: 'code/test.air-below', read: ['player'], params: { value: 100 } }, then: { steps: '跳', do: [['key/jump', { pressed: true }], ['key/jump', { pressed: false }]] } }
  ] })
  executor.startTask({ tree: { seq: 's', do: [{ expand: '规划' }] } })
  const poll = () => game.pollOnce()
  await runUntil(executor, () => executor.task.state === 'suspended', { beforeTick: poll })

  mod.air = 10
  await runUntil(executor, () => executor.episode !== null, { beforeTick: poll })
  mod.air = 300
  await runUntil(executor, () => executor.episode === null, { beforeTick: poll })
  assert.equal(executor.task.pending.stale, false)

  const { requestId } = requests.at(-1)
  assert.equal(executor.submitExpansion(requestId, { act: 'key/hotbar', params: { slot: 1 } }).ok, true)
})

test('修复请求在飞时被快树情节打断：不过期（P2 §5 方案 A），补丁照常被接受', async () => {
  const mod = new FakeMod()
  const { executor, game, requests, events } = makeRuntime({ mod })
  executor.loadFastTree({ match: '局势', arms: [
    { when: { cond: 'code/test.air-below', read: ['player'], params: { value: 100 } }, then: { steps: '跳', do: [['key/jump', { pressed: true }], ['key/jump', { pressed: false }]] } }
  ] })
  executor.startTask({ tree: { seq: 's', do: [{ act: 'container/slot', params: { slot: 0 } }] } })
  const poll = () => game.pollOnce()
  await runUntil(executor, () => requests.some((r) => r.type === 'failed'), { beforeTick: poll })

  mod.air = 10
  await runUntil(executor, () => executor.episode !== null, { beforeTick: poll })
  mod.air = 300
  await runUntil(executor, () => executor.episode === null && events.some((e) => e.event === 'fast/episode-end'), { beforeTick: poll })
  assert.equal(executor.task.pending.stale, false)
  assert.ok(events.some((e) => e.event === 'request/not-stale'))
  assert.equal(requests.filter((r) => r.type === 'recover').length, 0, '挂起时没有叶子被打断，不发 recover')

  const { requestId } = requests.at(-1)
  assert.equal(executor.submitPatch(requestId, [{ op: 'replace', id: 'n1.1', node: { act: 'key/hotbar', params: { slot: 1 } } }]).ok, true)
})

test('暂停 / 继续 / 放弃', async () => {
  const mod = new FakeMod()
  const { executor, events } = makeRuntime({ mod })
  executor.startTask({ tree: { steps: '走', do: [['key/up', { pressed: true }], ['wait', 30], ['key/up', { pressed: false }]] } })
  await runUntil(executor, () => mod.pressed.has('key/up'))
  executor.pauseTask()
  assert.equal(executor.task.state, 'paused')
  await runUntil(executor, () => !mod.pressed.has('key/up'))
  executor.resumeTask()
  await runUntil(executor, () => mod.pressed.has('key/up'))
  executor.abortTask('test')
  assert.equal(executor.task.state, 'failed')
  await runUntil(executor, () => events.some((e) => e.event === 'controls/released') && !mod.pressed.has('key/up'))
  assert.throws(() => executor.resumeTask(), /is failed/)
})

test('任务串行：有任务在跑时不能开新任务', () => {
  const { executor } = makeRuntime()
  executor.startTask({ tree: { expand: 'x' } })
  assert.throws(() => executor.startTask({ tree: { expand: 'y' } }), /still running/)
})
