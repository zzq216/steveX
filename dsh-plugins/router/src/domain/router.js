import {
  hasNonNoneIntent,
  needsClarification,
  validateSlotJson
} from './slots.js'

/**
 * 通用编排器（设计文档 §4 / §5）：
 *   选择 → 追问独占 → 软依赖排序 → 执行与失败策略。
 *
 * 纯逻辑，不依赖 DSH。handler 契约：
 *   { id, match(slots), provides?, requires?, onFailure?, priority?, run(slots, context) }
 */

export class RouterError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RouterError'
    this.code = code
  }
}

const FAILURE_MODES = new Set(['continue', 'stop'])

function normalizeHandler(raw) {
  if (raw === null || typeof raw !== 'object') {
    throw new RouterError('BAD_HANDLER', 'handler must be an object')
  }
  const handler = {
    id: raw.id,
    match: raw.match,
    run: raw.run,
    provides: raw.provides ?? [],
    requires: raw.requires ?? [],
    onFailure: raw.onFailure ?? 'continue',
    priority: raw.priority ?? 50
  }
  if (typeof handler.id !== 'string' || handler.id === '') {
    throw new RouterError('BAD_HANDLER_ID', 'handler.id must be a non-empty string')
  }
  if (typeof handler.match !== 'function') {
    throw new RouterError('BAD_HANDLER_MATCH', `handler ${handler.id}: match must be a function`)
  }
  if (typeof handler.run !== 'function') {
    throw new RouterError('BAD_HANDLER_RUN', `handler ${handler.id}: run must be a function`)
  }
  if (!FAILURE_MODES.has(handler.onFailure)) {
    throw new RouterError('BAD_HANDLER_FAILURE', `handler ${handler.id}: onFailure must be continue or stop`)
  }
  if (typeof handler.priority !== 'number' || !Number.isFinite(handler.priority)) {
    throw new RouterError('BAD_HANDLER_PRIORITY', `handler ${handler.id}: priority must be a finite number`)
  }
  for (const key of ['provides', 'requires']) {
    if (!Array.isArray(handler[key]) || handler[key].some((item) => typeof item !== 'string' || item === '')) {
      throw new RouterError('BAD_HANDLER_DEPS', `handler ${handler.id}: ${key} must be a string[]`)
    }
  }
  return handler
}

const compareHandlers = (a, b) => (a.priority - b.priority) || (a.seq - b.seq)

/**
 * 软依赖拓扑排序：provider 必须排在消费者之前。
 * 未选中的 provider 视为"软依赖缺失"，不阻塞消费者；环 = RouterError。
 */
function orderHandlers(selected) {
  const byId = new Map(selected.map((handler) => [handler.id, handler]))
  const indegree = new Map(selected.map((handler) => [handler.id, 0]))
  const edges = new Map(selected.map((handler) => [handler.id, new Set()]))

  for (const handler of selected) {
    for (const requirement of handler.requires) {
      for (const provider of selected) {
        if (provider.id === handler.id || !provider.provides.includes(requirement)) continue
        if (edges.get(provider.id).has(handler.id)) continue
        edges.get(provider.id).add(handler.id)
        indegree.set(handler.id, indegree.get(handler.id) + 1)
      }
    }
  }

  const ready = selected.filter((handler) => indegree.get(handler.id) === 0).sort(compareHandlers)
  const ordered = []
  while (ready.length > 0) {
    const handler = ready.shift()
    ordered.push(handler)
    for (const nextId of edges.get(handler.id)) {
      indegree.set(nextId, indegree.get(nextId) - 1)
      if (indegree.get(nextId) === 0) {
        ready.push(byId.get(nextId))
        ready.sort(compareHandlers)
      }
    }
  }

  if (ordered.length !== selected.length) {
    throw new RouterError('DEPENDENCY_CYCLE', 'handler requires/provides form a cycle')
  }
  return ordered
}

export function createRouter() {
  /** @type {Map<string, object>} */
  const registry = new Map()
  let nextSeq = 0

  /**
   * 注册处理器；返回注销函数。
   * 框架阶段由 router-handlers 统一注册；将来可独立拆插件。
   */
  function registerHandler(raw) {
    const handler = normalizeHandler(raw)
    if (registry.has(handler.id)) {
      throw new RouterError('DUPLICATE_HANDLER', `handler ${handler.id} is already registered`)
    }
    Object.defineProperty(handler, 'seq', { value: nextSeq++, enumerable: false })
    registry.set(handler.id, handler)

    let active = true
    return () => {
      if (!active) return
      active = false
      if (registry.get(handler.id) === handler) registry.delete(handler.id)
    }
  }

  function handlerIds() {
    return [...registry.keys()]
  }

  /**
   * 选择并排序处理器。
   * @param {object} slotJson SlotJSON（§7）
   * @returns {{ slots: object, handlers: object[], order: string[], exclusive: boolean }}
   */
  function decide(slotJson) {
    const validated = validateSlotJson(slotJson)

    if (needsClarification(validated)) {
      const clarify = registry.get('clarify')
      if (!clarify) {
        throw new RouterError('MISSING_CLARIFY', 'slots need clarification but no clarify handler is registered')
      }
      return { slots: validated, handlers: [clarify], order: [clarify.id], exclusive: true }
    }

    // default / clarify 不参与普通匹配（由兜底与独占路径选用）。
    const normal = [...registry.values()].filter((handler) => handler.id !== 'clarify' && handler.id !== 'default')
    let selected = normal.filter((handler) => handler.match(validated))

    // 禁用处理器导致的降级：有意图但没人接 → unsupported。
    if (selected.length === 0 && hasNonNoneIntent(validated.slots)) {
      const unsupported = registry.get('unsupported')
      if (unsupported) selected = [unsupported]
    }

    // 无任何意图 → default。
    if (selected.length === 0) {
      const fallback = registry.get('default')
      if (fallback) selected = [fallback]
    }

    if (selected.length === 0) {
      throw new RouterError('NO_HANDLER', 'no handler matched and no default handler is registered')
    }

    const ordered = orderHandlers(selected)
    return { slots: validated, handlers: ordered, order: ordered.map((handler) => handler.id), exclusive: false }
  }

  /**
   * 执行一次路由：选择 → 依次运行 → 按 onFailure 处理失败。
   * @returns {Promise<{ decision: object, parts: Array<{id: string, result: any}>, errors: Array<{id: string, error: Error}> }>}
   */
  async function run(slotJson, context = {}) {
    const decision = decide(slotJson)
    const parts = []
    const errors = []

    for (const handler of decision.handlers) {
      try {
        const result = await handler.run(decision.slots, context)
        if (result !== undefined && result !== null) parts.push({ id: handler.id, result })
      } catch (error) {
        errors.push({ id: handler.id, error })
        if (handler.onFailure === 'stop') break
      }
    }

    return { decision, parts, errors }
  }

  function clear() {
    registry.clear()
  }

  return { registerHandler, decide, run, handlerIds, clear }
}
