/**
 * 槽位词表与 SlotJSON 校验（设计文档 §3 / §7）。
 *
 * 本模块是纯逻辑：不 import 任何 `@deepseek-ai/*`，可脱离 DSH 单测。
 */

export const SLOT_NAMES = Object.freeze(['domain', 'knowledge', 'action', 'artifact'])

export const SLOT_VALUES = Object.freeze({
  domain: Object.freeze(['minecraft', 'general', 'unknown']),
  knowledge: Object.freeze(['none', 'fact', 'unknown']),
  action: Object.freeze(['none', 'execute', 'unknown']),
  artifact: Object.freeze(['none', 'fast_tree', 'unknown'])
})

/** 「决定性槽位」：不同取值会导致不同处理器集合（§8）。domain 是 unknown 不触发追问。 */
export const DECISIVE_SLOTS = Object.freeze(['knowledge', 'action', 'artifact'])

const MAX_PAYLOAD_DEPTH = 8

export class SlotValidationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SlotValidationError'
    this.code = code
  }
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** payload 必须是可 JSON 序列化的值（深度有上限，防递归/异常结构）。 */
function isJsonValue(value, depth = 0) {
  if (value === null) return true
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (depth >= MAX_PAYLOAD_DEPTH) return false
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1))
  if (isPlainObject(value)) return Object.values(value).every((item) => isJsonValue(item, depth + 1))
  return false
}

// 模型自报的 confidence 不是真实概率，不参与判定（2026-10-28 删除）；多给了也只是忽略
function normalizeSlot(slot) {
  return { value: slot.value, payload: slot.payload }
}

/** 默认槽位：无任何意图（provider=stub 时的兜底）。 */
export function defaultSlots() {
  return {
    slots: {
      domain: { value: 'general', payload: null },
      knowledge: { value: 'none', payload: null },
      action: { value: 'none', payload: null },
      artifact: { value: 'none', payload: null }
    },
    reason: 'stub default (no intents)',
    clarification: null
  }
}

/**
 * 校验并规范化一份 SlotJSON。
 * @returns {{ slots: Record<string, {value: string, payload: any}>, reason: string, clarification: string | null }}
 */
export function validateSlotJson(input) {
  if (!isPlainObject(input)) throw new SlotValidationError('BAD_SHAPE', 'slots JSON must be an object')
  if (!isPlainObject(input.slots)) throw new SlotValidationError('BAD_SLOTS', 'slots must be an object')

  const slots = input.slots
  const keys = Object.keys(slots)
  if (keys.length !== SLOT_NAMES.length || SLOT_NAMES.some((name) => !hasOwn(slots, name))) {
    throw new SlotValidationError('BAD_SLOTS', `slots must contain exactly: ${SLOT_NAMES.join(', ')}`)
  }

  for (const name of SLOT_NAMES) {
    const slot = slots[name]
    if (!isPlainObject(slot)) {
      throw new SlotValidationError('BAD_SLOT', `slots.${name} must be an object`)
    }
    if (!SLOT_VALUES[name].includes(slot.value)) {
      throw new SlotValidationError(
        'BAD_SLOT_VALUE',
        `slots.${name}.value must be one of: ${SLOT_VALUES[name].join(' / ')} (got ${JSON.stringify(slot.value)})`
      )
    }
    if (!hasOwn(slot, 'payload')) {
      throw new SlotValidationError('MISSING_PAYLOAD', `slots.${name}.payload key is required (may be null)`)
    }
    if (!isJsonValue(slot.payload)) {
      throw new SlotValidationError('BAD_PAYLOAD', `slots.${name}.payload must be JSON-serializable (or null)`)
    }
  }

  if (input.reason !== undefined && typeof input.reason !== 'string') {
    throw new SlotValidationError('BAD_REASON', 'reason must be a string')
  }
  if (input.clarification !== undefined && input.clarification !== null
    && (typeof input.clarification !== 'string' || input.clarification.trim() === '')) {
    throw new SlotValidationError('BAD_CLARIFICATION', 'clarification must be a non-empty string or null')
  }

  return {
    slots: {
      domain: normalizeSlot(slots.domain),
      knowledge: normalizeSlot(slots.knowledge),
      action: normalizeSlot(slots.action),
      artifact: normalizeSlot(slots.artifact)
    },
    reason: input.reason ?? '',
    clarification: input.clarification ?? null
  }
}

/**
 * 是否需要追问：任一决定性槽位是 unknown（§8；2026-10-28 起只看这一处）。
 * clarification 只是追问时用的那句话，不单独触发追问。
 */
export function needsClarification(slotJson) {
  return DECISIVE_SLOTS.some((name) => slotJson.slots[name].value === 'unknown')
}

/** 是否存在"非 none 的意图"；用于禁用处理器后的 unsupported 降级。 */
export function hasNonNoneIntent(slots) {
  return DECISIVE_SLOTS.some((name) => {
    const value = slots[name].value
    return value !== 'none' && value !== 'unknown'
  })
}

/**
 * 追问达到上限后（阶段 B 细则 D6）：仍拿不准的决定性槽位按 none 处理——不开任务、不写事实，
 * clarification 清空，走正常编排。
 */
export function resolveUnsure(slotJson) {
  const slots = { ...slotJson.slots }
  for (const name of DECISIVE_SLOTS) {
    if (slots[name].value === 'unknown') slots[name] = { value: 'none', payload: null }
  }
  return { ...slotJson, slots, clarification: null }
}
