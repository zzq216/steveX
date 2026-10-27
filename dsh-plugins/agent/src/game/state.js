import { PRESSABLE_METHODS } from './mod.js'

/**
 * 游戏状态：状态缓存、按需读取、命令运行环境、默认中止流程（集成方案 §3.3 / 行为树设计 §6.3）。
 *
 * 两棵树读状态的方式不同：
 * - 快树 `when`：读缓存。只轮询快树（以及任务树里 Match 的 `when`）实际用到的来源
 * - 任务树 Condition：执行到读取点时现场读一次（read），读到的一定是新的
 */
export const SOURCE_METHODS = Object.freeze({
  player: 'player',
  inventory: 'inventory',
  f3: 'f3',
  container: 'container/get'
})

export class GameState {
  /**
   * @param {object} options
   * @param {{ call(method: string, params?: object): Promise<any> }} options.mod
   * @param {object} [options.timing]   { clickWaitMs, lookWaitMs, pollMs }
   * @param {number} [options.statePollMs=200]
   */
  constructor({ mod, timing = {}, statePollMs = 200 }) {
    this.mod = mod
    this.timing = { clickWaitMs: 80, lookWaitMs: 150, pollMs: 100, ...timing }
    this.statePollMs = statePollMs
    this.cache = new Map() // source → { data, at }
    this.pollSources = new Set()
    this.pollTimer = null
    this.polling = false
  }

  setPollSources(sources) {
    this.pollSources = new Set(sources)
  }

  startPolling() {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => { this.pollOnce().catch(() => {}) }, this.statePollMs)
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  async pollOnce() {
    if (this.polling || this.pollSources.size === 0) return
    this.polling = true
    try {
      await this.fetch([...this.pollSources])
    } finally {
      this.polling = false
    }
  }

  /** 缓存里这些来源都在 → 快照；缺任何一个 → null（快树把它当"条件不成立"）。 */
  cached(sources) {
    const snapshot = {}
    for (const source of sources) {
      const entry = this.cache.get(source)
      if (!entry) return null
      snapshot[source] = entry.data
    }
    return snapshot
  }

  /** 一个来源的缓存条目 { data, at }；每次读到都是新对象（快树事件流据此判断是不是新的一次轮询）。没有 → null。 */
  cachedEntry(source) {
    return this.cache.get(source) ?? null
  }

  /** 全部缓存（中断前后的世界差异用）。 */
  cachedAll() {
    return Object.fromEntries([...this.cache].map(([source, entry]) => [source, entry.data]))
  }

  async fetch(sources) {
    const snapshot = {}
    await Promise.all(sources.map(async (source) => {
      const method = SOURCE_METHODS[source]
      if (!method) throw new Error(`unknown state source: ${source}`)
      const res = await this.mod.call(method, {})
      if (!res.ok) throw new Error(`${method}: ${res.error}`)
      this.cache.set(source, { data: res.data, at: Date.now() })
      snapshot[source] = res.data
    }))
    return snapshot
  }

  /** 按需读取（任务树 Condition）。 */
  read(sources, signal) {
    if (signal?.aborted) return Promise.reject(new Error('aborted'))
    return this.fetch(sources)
  }

  /** 命令运行环境：所有 mod 调用都经过它，中止信号在每次调用前检查。 */
  env(signal) {
    const mod = this.mod
    const timing = this.timing
    const check = () => { if (signal?.aborted) throw new Error('aborted') }
    return {
      signal,
      timing,
      async call(method, params = {}) {
        check()
        return mod.call(method, params)
      },
      async must(method, params = {}) {
        check()
        const res = await mod.call(method, params)
        if (!res.ok) throw new Error(`${method}: ${res.error}`)
        return res.data
      },
      sleep(ms) {
        return sleep(ms, signal)
      },
      read: (sources) => this.read(sources, signal)
    }
  }

  /**
   * 默认中止流程（行为树设计 §6.3 / B6）：松开所有按键；开着容器就关掉。
   * 不记 carried 的去向——那由恢复时的世界差异读出来。
   */
  /** 只松开所有可按住的键（不关容器）。@returns 松开成功的个数 */
  async releaseKeys() {
    const released = []
    await Promise.all(PRESSABLE_METHODS.map(async (method) => {
      const res = await this.mod.call(method, { pressed: false })
      if (res.ok) released.push(method)
    }))
    return released.length
  }

  async abortDefault() {
    const released = await this.releaseKeys()
    let closedContainer = false
    const container = await this.mod.call('container/get', {})
    if (container.ok && container.data?.type && container.data.type !== 'none') {
      const res = await this.mod.call('container/close', {})
      closedContainer = res.ok
    }
    return { released, closedContainer }
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    if (!(ms > 0)) return setImmediate(() => (signal?.aborted ? reject(new Error('aborted')) : resolve()))
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve() }, ms)
    function onAbort() { clearTimeout(timer); reject(new Error('aborted')) }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}
