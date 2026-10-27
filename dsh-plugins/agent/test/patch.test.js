import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeMod } from './fake_mod.js'
import { makeRuntime, runUntil } from './helpers.js'

const hotbar = (slot) => ({ act: 'key/hotbar', params: { slot } })
const broken = { act: 'container/slot', params: { slot: 0 } } // 没开界面：假 mod 报错
const okCond = { cond: 'blackboard/compare', params: { key: 'ok', op: '>=', value: 1 } }
const slots = (mod) => mod.calls.filter(([m]) => m === 'key/hotbar').map(([, p]) => p.slot)

/** 跑到 failed 请求：n1.1 已完成，n1.2 失败（游标停在它上面），n1.3 还没执行。 */
async function failedAt(tree = { seq: 's', do: [hotbar(1), broken, hotbar(3)] }, config, blackboard = { ok: 0 }) {
  const mod = new FakeMod()
  const runtime = makeRuntime({ mod, config })
  runtime.executor.startTask({ tree, blackboard })
  await runUntil(runtime.executor, () => runtime.executor.task.state === 'suspended')
  const request = runtime.requests.at(-1)
  assert.equal(request.type, 'failed')
  return { ...runtime, requestId: request.requestId }
}

test('replace 失败的当前步骤：新节点从原位置执行，已完成的不重跑；id 带版本、打 origin、写版本链', async () => {
  const { executor, mod, events, requestId } = await failedAt()
  const result = executor.submitPatch(requestId, [{ op: 'replace', id: 'n1.2', node: hotbar(2) }])
  assert.equal(result.ok, true)
  assert.equal(result.version, 2)
  assert.deepEqual(result.ids, ['n1.2.p2'])
  assert.deepEqual(executor.task.spec.children[1].origin, { request: requestId, type: 'failed' })
  assert.ok(executor.task.byId.has('n1.2.p2') && !executor.task.byId.has('n1.2'))

  await runUntil(executor, () => executor.task.state === 'done')
  assert.deepEqual(slots(mod), [1, 2, 3])
  assert.ok(events.some((e) => e.event === 'patch/applied' && e.version === 2))
})

test('insert-before 当前步骤 / insert-after 最后一个已完成的步骤：新节点下一个执行', async () => {
  for (const op of [{ op: 'insert-before', id: 'n1.2' }, { op: 'insert-after', id: 'n1.1' }]) {
    const { executor, mod, requestId } = await failedAt({ seq: 's', do: [hotbar(1), okCond, hotbar(3)] })
    const result = executor.submitPatch(requestId, [{ ...op, node: { act: 'key/hotbar', params: { slot: 2 }, writes: { ok: '+1' } } }])
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    await runUntil(executor, () => executor.task.state === 'done')
    assert.deepEqual(slots(mod), [1, 2, 3], `${op.op}：新节点先跑，失败的条件随后重新求值通过`)
  }
})

test('remove 当前步骤：游标不动，下一个步骤成为当前步骤；remove / insert 还没执行到的部分也接受', async () => {
  const { executor, mod, requestId } = await failedAt({ seq: 's', do: [hotbar(1), broken, hotbar(3), hotbar(4)] })
  const result = executor.submitPatch(requestId, [
    { op: 'remove', id: 'n1.2' },
    { op: 'remove', id: 'n1.4' },
    { op: 'insert-after', id: 'n1.3', node: hotbar(5) }
  ])
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  await runUntil(executor, () => executor.task.state === 'done')
  assert.deepEqual(slots(mod), [1, 3, 5])
})

test('改已经执行完的部分被拒，错误说明改法；不合法计次，第 3 次任务失败', async () => {
  const { executor, events, requestId } = await failedAt()
  const replaceDone = executor.submitPatch(requestId, [{ op: 'replace', id: 'n1.1', node: hotbar(9) }])
  assert.equal(replaceDone.ok, false)
  assert.match(replaceDone.errors[0], /n1\.1 has already finished.*insert-before the current step insert-before n1\.2/)
  assert.equal(replaceDone.attemptsLeft, 2)

  const insertBetween = executor.submitPatch(requestId, [{ op: 'insert-before', id: 'n1.1', node: hotbar(9) }])
  assert.match(insertBetween.errors[0], /already finished, so the new node would never run.*insert-before n1\.2/)

  const removeDone = executor.submitPatch(requestId, [{ op: 'remove', id: 'n1.1' }])
  assert.equal(removeDone.taskFailed, true)
  assert.equal(executor.task.state, 'failed')
  assert.match(executor.task.result, /failed request r\d+ got no valid answer in 3 attempts/)
  assert.equal(events.filter((e) => e.event === 'patch/invalid').length, 3)
})

test('上面有 Repeat 时，已完成的部分下一轮会重跑，可以改', async () => {
  const { executor, mod, requestId } = await failedAt({ repeat: '两轮', n: 2, do: { seq: '一轮', do: [hotbar(1), broken] } })
  const result = executor.submitPatch(requestId, [
    { op: 'replace', id: 'n1.1.1', node: hotbar(7) },
    { op: 'replace', id: 'n1.1.2', node: hotbar(2) }
  ])
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  await runUntil(executor, () => executor.task.state === 'done')
  assert.deepEqual(slots(mod), [1, 2, 7, 2], '本轮从失败处继续，下一轮用新的第一步')
})

test('同一锚点多次 insert-after：按顺序排在后面，id 依次 p2、p2b', async () => {
  const { executor, mod, requestId } = await failedAt()
  const result = executor.submitPatch(requestId, [
    { op: 'replace', id: 'n1.2', node: hotbar(2) },
    { op: 'insert-after', id: 'n1.3', node: hotbar(4) },
    { op: 'insert-after', id: 'n1.3', node: hotbar(5) }
  ])
  assert.deepEqual(result.ids, ['n1.2.p2', 'n1.3.p2', 'n1.3.p2b'])
  await runUntil(executor, () => executor.task.state === 'done')
  assert.deepEqual(slots(mod), [1, 2, 3, 4, 5])
})

test('补丁的结构错误：点名本补丁里已换掉的节点、往非 seq / sel 里插、删根、未知操作、新节点超过上限', async () => {
  const { executor, requestId } = await failedAt(
    { seq: 's', do: [hotbar(1), broken, { retry: 1, do: hotbar(3) }] },
    { maxExpansionNodes: 2 }
  )
  const errors = executor.submitPatch(requestId, [
    { op: 'replace', id: 'n1.2', node: hotbar(2) },
    { op: 'remove', id: 'n1.2' },
    { op: 'insert-before', id: 'n1.3.1', node: hotbar(4) },
    { op: 'remove', id: 'n1' },
    { op: 'move', id: 'n1.3' },
    { op: 'insert-after', id: 'n1.3', node: { seq: 'x', do: [hotbar(5), hotbar(6)] } }
  ]).errors
  assert.match(errors[0], /^ops\[1\]: n1\.2 was already replaced or removed by ops\[0\]/)
  assert.match(errors[1], /^ops\[2\]: n1\.3\.1 is the child of a Retry.*use replace/)
  assert.match(errors[2], /^ops\[3\]: n1 is the root/)
  assert.match(errors[3], /^ops\[4\]: unknown op "move"/)
  assert.match(errors[4], /adds 4 nodes, over the limit of 2/)
})

test('空补丁 = 原树继续；continue 不再存在', async () => {
  const { executor, mod, requestId } = await failedAt({ seq: 's', do: [hotbar(1), okCond] })
  assert.match(executor.answerRequest(requestId, { action: 'continue' }).error, /submit an empty patch/)
  executor.task.blackboard.set('ok', 1)
  assert.equal(executor.submitPatch(requestId, []).ok, true)
  await runUntil(executor, () => executor.task.state === 'done')
  assert.deepEqual(slots(mod), [1], '失败的条件原地重新求值，前一步不重跑')
})
