/**
 * 测试夹具：构造合法 SlotJSON / 静默 logger。
 * 不被 node:test 用作测试文件（没有 test() 调用）。
 */
export function makeSlots({
  domain = 'minecraft',
  knowledge = 'none',
  action = 'none',
  artifact = 'none',
  payloads = {},
  reason = 'test',
  clarification = null
} = {}) {
  const slot = (name, value) => ({
    value,
    payload: payloads[name] ?? null
  })
  return {
    slots: {
      domain: slot('domain', domain),
      knowledge: slot('knowledge', knowledge),
      action: slot('action', action),
      artifact: slot('artifact', artifact)
    },
    reason,
    clarification
  }
}

export function silentLogger() {
  return { info() {}, warn() {} }
}

export function createFakeContext() {
  const listeners = new Map()
  const effects = []
  const services = new Map()

  const ctx = {
    provide(name, value) {
      services.set(name, value)
      ctx[name] = value
      return () => {
        services.delete(name)
        delete ctx[name]
      }
    },
    on(event, handler, options) {
      const entry = { handler, options }
      const list = listeners.get(event) ?? []
      list.push(entry)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(entry)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return () => {}
    },
    async dispose() {
      for (const cleanup of effects.splice(0).reverse()) await cleanup()
    },
    _listeners: listeners,
    _services: services
  }

  return ctx
}

export async function emitWaterfall(ctx, event, payload, next) {
  let result
  for (const entry of ctx._listeners.get(event) ?? []) {
    result = await entry.handler(payload, next)
  }
  return result
}

export async function emitEvent(ctx, event, payload) {
  for (const entry of ctx._listeners.get(event) ?? []) {
    await entry.handler(payload)
  }
}
