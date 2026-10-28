import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DECISIVE_SLOTS,
  SLOT_NAMES,
  SLOT_VALUES,
  defaultSlots,
  hasNonNoneIntent,
  needsClarification,
  resolveUnsure,
  validateSlotJson
} from '../src/domain/slots.js'
import { makeSlots } from './helpers.js'

test('词表是封闭的', () => {
  assert.deepEqual([...SLOT_NAMES], ['domain', 'knowledge', 'action', 'artifact'])
  assert.deepEqual([...DECISIVE_SLOTS], ['knowledge', 'action', 'artifact'])
  for (const name of SLOT_NAMES) assert.ok(SLOT_VALUES[name].includes('unknown'))
})

test('defaultSlots 与合法 SlotJSON 通过校验', () => {
  assert.doesNotThrow(() => validateSlotJson(defaultSlots()))
  const validated = validateSlotJson(makeSlots({ knowledge: 'fact', action: 'execute' }))
  assert.equal(validated.slots.knowledge.value, 'fact')
  assert.equal(validated.slots.action.value, 'execute')
  assert.equal(validated.slots.domain.payload, null)
  assert.equal(validated.clarification, null)
})

test('缺少 / 多余槽位被拒绝', () => {
  const missing = makeSlots()
  delete missing.slots.action
  assert.throws(() => validateSlotJson(missing), (e) => e.code === 'BAD_SLOTS')

  const extra = makeSlots()
  extra.slots.extra = { value: 'none', confidence: 1, payload: null }
  assert.throws(() => validateSlotJson(extra), (e) => e.code === 'BAD_SLOTS')
})

test('取值不在词表 / confidence 非法被拒绝', () => {
  assert.throws(
    () => validateSlotJson(makeSlots({ knowledge: 'maybe' })),
    (e) => e.code === 'BAD_SLOT_VALUE'
  )
  assert.throws(
    () => validateSlotJson(makeSlots({ confidences: { action: 1.5 } })),
    (e) => e.code === 'BAD_CONFIDENCE'
  )
  assert.throws(
    () => validateSlotJson(makeSlots({ confidences: { action: Number.NaN } })),
    (e) => e.code === 'BAD_CONFIDENCE'
  )
})

test('payload 键必须存在且必须是 JSON 值', () => {
  const missing = makeSlots()
  delete missing.slots.knowledge.payload
  assert.throws(() => validateSlotJson(missing), (e) => e.code === 'MISSING_PAYLOAD')

  const fn = makeSlots()
  fn.slots.action.payload = () => {}
  assert.throws(() => validateSlotJson(fn), (e) => e.code === 'BAD_PAYLOAD')

  const circular = {}
  circular.self = circular
  const circularSlots = makeSlots()
  circularSlots.slots.action.payload = circular
  assert.throws(() => validateSlotJson(circularSlots), (e) => e.code === 'BAD_PAYLOAD')

  assert.doesNotThrow(() => validateSlotJson(makeSlots({
    payloads: {
      knowledge: { query: '钻石生成高度', options: ['a', 1, true, null] }
    }
  })))
})

test('reason / clarification 形态被校验', () => {
  assert.throws(
    () => validateSlotJson({ ...makeSlots(), reason: 42 }),
    (e) => e.code === 'BAD_REASON'
  )
  assert.throws(
    () => validateSlotJson(makeSlots({ clarification: '   ' })),
    (e) => e.code === 'BAD_CLARIFICATION'
  )
  assert.equal(validateSlotJson(makeSlots({ clarification: '问事实还是做任务？' })).clarification, '问事实还是做任务？')
})

test('needsClarification：unknown / 低置信度 / 显式 clarification', () => {
  assert.equal(needsClarification(makeSlots()), false)
  assert.equal(needsClarification(makeSlots({ knowledge: 'unknown' })), true)
  assert.equal(needsClarification(makeSlots({ knowledge: 'fact', confidence: 0.4 })), true)
  assert.equal(needsClarification(makeSlots({ clarification: '你是在问什么？' })), true)
  // domain 不是决定性槽位：低置信度不触发追问
  assert.equal(needsClarification(makeSlots({ confidences: { domain: 0.1 } })), false)
})

test('hasNonNoneIntent 只看非 none 的意图', () => {
  assert.equal(hasNonNoneIntent(makeSlots().slots), false)
  assert.equal(hasNonNoneIntent(makeSlots({ knowledge: 'fact' }).slots), true)
  assert.equal(hasNonNoneIntent(makeSlots({ action: 'execute' }).slots), true)
  assert.equal(hasNonNoneIntent(makeSlots({ artifact: 'fast_tree' }).slots), true)
  assert.equal(hasNonNoneIntent(makeSlots({ knowledge: 'unknown' }).slots), false)
})

test('resolveUnsure：拿不准的决定性槽位按 none，确定的保留，clarification 清空', () => {
  const input = validateSlotJson(makeSlots({ knowledge: 'fact', action: 'unknown', artifact: 'fast_tree', confidences: { artifact: 0.2 }, clarification: '?' }))
  const out = resolveUnsure(input, 0.7)
  assert.equal(out.slots.knowledge.value, 'fact')
  assert.deepEqual(out.slots.action, { value: 'none', confidence: 1, payload: null })
  assert.equal(out.slots.artifact.value, 'none')
  assert.equal(out.clarification, null)
  assert.equal(input.slots.action.value, 'unknown')
})
