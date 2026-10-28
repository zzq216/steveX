import test from 'node:test'
import assert from 'node:assert/strict'

import { createRouter } from '../src/domain/router.js'
import { createHandlers } from '../src/handlers.js'
import { makeSlots } from './helpers.js'

function createTestRouter({ enabled = null } = {}) {
  const router = createRouter()
  for (const handler of createHandlers({ enabled })) router.registerHandler(handler)
  return router
}

test('默认路由：无意图 → default', () => {
  const decision = createTestRouter().decide(makeSlots())
  assert.deepEqual(decision.order, ['default'])
  assert.equal(decision.exclusive, false)
})

test('事实 / 任务 / 两者：软依赖让事实先跑', () => {
  const router = createTestRouter()
  assert.deepEqual(router.decide(makeSlots({ knowledge: 'fact' })).order, ['fact'])
  assert.deepEqual(router.decide(makeSlots({ action: 'execute' })).order, ['task'])
  assert.deepEqual(router.decide(makeSlots({ knowledge: 'fact', action: 'execute' })).order, ['fact', 'task'])
})

test('unsupported 与任务并存：按 priority 排序', () => {
  const router = createTestRouter()
  assert.deepEqual(router.decide(makeSlots({ artifact: 'fast_tree' })).order, ['unsupported'])
  assert.deepEqual(
    router.decide(makeSlots({ artifact: 'fast_tree', action: 'execute' })).order,
    ['unsupported', 'task']
  )
})

test('禁用某个 handler：对应意图降级为 unsupported', () => {
  const router = createTestRouter({ enabled: ['task', 'default', 'unsupported', 'clarify'] })
  const decision = router.decide(makeSlots({ knowledge: 'fact' }))
  assert.deepEqual(decision.order, ['unsupported'])
})

test('追问：unknown → clarify 独占；只有 clarification 没有 unknown 不追问', () => {
  const router = createTestRouter()
  const unknown = router.decide(makeSlots({ knowledge: 'unknown' }))
  assert.equal(unknown.exclusive, true)
  assert.deepEqual(unknown.order, ['clarify'])

  const sentenceOnly = router.decide(makeSlots({ action: 'execute', clarification: '现在就去吗？' }))
  assert.equal(sentenceOnly.exclusive, false)
  assert.deepEqual(sentenceOnly.order, ['task'])
})

test('缺少 clarify handler 时，需要追问 → MISSING_CLARIFY', () => {
  const router = createTestRouter({ enabled: ['fact', 'task', 'default', 'unsupported'] })
  assert.throws(
    () => router.decide(makeSlots({ knowledge: 'unknown' })),
    (e) => e.code === 'MISSING_CLARIFY'
  )
})

test('依赖环 → DEPENDENCY_CYCLE', () => {
  const router = createRouter()
  router.registerHandler({
    id: 'a', match: () => true, provides: ['y'], requires: ['x'], run: async () => ({ text: 'a' })
  })
  router.registerHandler({
    id: 'b', match: () => true, provides: ['x'], requires: ['y'], run: async () => ({ text: 'b' })
  })
  assert.throws(() => router.decide(makeSlots()), (e) => e.code === 'DEPENDENCY_CYCLE')
})

test('handler 注册校验：重复 / 缺字段', () => {
  const router = createRouter()
  router.registerHandler({ id: 'x', match: () => true, run: async () => null })
  assert.throws(
    () => router.registerHandler({ id: 'x', match: () => true, run: async () => null }),
    (e) => e.code === 'DUPLICATE_HANDLER'
  )
  assert.throws(
    () => router.registerHandler({ id: 'y', match: () => true }),
    (e) => e.code === 'BAD_HANDLER_RUN'
  )
  assert.throws(
    () => router.registerHandler({ id: 'z', match: () => true, run: async () => null, onFailure: 'later' }),
    (e) => e.code === 'BAD_HANDLER_FAILURE'
  )
})

test('run：按顺序执行并收集失败；continue 不阻塞，stop 中止', () => {
  const continued = createRouter()
  continued.registerHandler({
    id: 'bad', match: () => true, priority: 1, onFailure: 'continue',
    run: async () => { throw new Error('bad') }
  })
  continued.registerHandler({
    id: 'good', match: () => true, priority: 2, onFailure: 'continue',
    run: async () => ({ text: 'good' })
  })

  return continued.run(makeSlots()).then((result) => {
    assert.deepEqual(result.parts, [{ id: 'good', result: { text: 'good' } }])
    assert.equal(result.errors.length, 1)

    const stopped = createRouter()
    stopped.registerHandler({
      id: 'bad', match: () => true, priority: 1, onFailure: 'stop',
      run: async () => { throw new Error('bad') }
    })
    stopped.registerHandler({
      id: 'good', match: () => true, priority: 2, onFailure: 'continue',
      run: async () => ({ text: 'good' })
    })
    return stopped.run(makeSlots()).then((stoppedResult) => {
      assert.deepEqual(stoppedResult.parts, [])
      assert.equal(stoppedResult.errors.length, 1)
    })
  })
})

test('payload 不参与选择：同 value 不同 payload 结果一致', () => {
  const router = createTestRouter()
  const plain = makeSlots({ knowledge: 'fact' })
  const withPayload = makeSlots({
    knowledge: 'fact',
    payloads: { knowledge: { query: '任何内容' }, domain: 'ignored by match' }
  })
  assert.deepEqual(router.decide(plain).order, router.decide(withPayload).order)
})

test('注销函数移除 handler', () => {
  const router = createTestRouter()
  const remove = router.registerHandler({ id: 'probe', match: () => false, run: async () => null })
  assert.ok(router.handlerIds().includes('probe'))
  remove()
  assert.equal(router.handlerIds().includes('probe'), false)
})
