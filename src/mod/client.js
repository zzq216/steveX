const { EventEmitter } = require('events')
const WebSocket = require('ws')

/**
 * ModWSClient —— 采集端 mod WebSocket JSON-RPC 客户端。
 *
 * 协议（AgentWebSocketServer.java 已核实）：
 *   请求  {"id":1, "method":"player", "params":{}}
 *   成功  {"id":1, "ok":true,  "data":{...}}
 *   失败  {"id":1, "ok":false, "error":"message"}
 *
 * 事件：'connected' | 'disconnected' (reason) | 'status' ({busy, error})
 */
class ModWSClient extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url]                     ws://host:port，默认 ws://127.0.0.1:25550
   * @param {number} [opts.reconnectDelayMs=2000]   断线重连初始延迟（指数退避）
   * @param {number} [opts.reconnectMaxMs=30000]    重连最大延迟
   * @param {number} [opts.requestTimeoutMs=20000]  单次请求超时（mod 部分方法在客户端线程执行可能阻塞）
   */
  constructor(opts = {}) {
    super()
    this.url = opts.url || 'ws://127.0.0.1:25550'
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 2000
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30000
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20000

    this.ws = null
    this.connected = false
    this.closing = false

    this._nextId = 1
    this._pending = new Map() // id -> { resolve, timer }
    this._statusCache = null  // { busy, error }
    this._reconnectTimer = null
    this._reconnectDelay = this.reconnectDelayMs
  }

  /** 建立连接并启动心跳/重连。重复调用会先关闭旧连接再重连。 */
  connect() {
    this.closing = false
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close() } catch (_) {}
      this.ws = null
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    this._reconnectDelay = this.reconnectDelayMs
    this._open()
  }

  /** 关闭连接，停止重连，并 settle 所有在途请求。 */
  close() {
    this.closing = true
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    const ws = this.ws
    this.ws = null
    this.connected = false
    if (ws) {
      try { ws.removeAllListeners(); ws.close() } catch (_) {}
    }
    this._rejectAllPending('connection closed')
    this.emit('disconnected', 'closed')
  }

  isConnected() {
    return this.connected
  }

  /**
   * 调用 mod 方法。总是 resolve，不抛异常。
   * @returns {Promise<{ok:true, data:any} | {ok:false, error:string}>}
   */
  async call(method, params = {}) {
    if (!this.connected || !this.ws) {
      return { ok: false, error: 'not connected to mod' }
    }

    const id = this._nextId++
    const body = JSON.stringify({ id, method, params: params || {} })

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        resolve({ ok: false, error: `timeout: ${method}` })
      }, this.requestTimeoutMs)

      this._pending.set(id, { resolve, timer })

      try {
        this.ws.send(body)
      } catch (err) {
        this._pending.delete(id)
        clearTimeout(timer)
        resolve({ ok: false, error: `send failed: ${err.message}` })
      }
    })
  }

  /** 刷新 status 缓存（mod 实时 busy/error），更新后 emit 'status'。 */
  async refreshStatus() {
    const res = await this.call('status', {})
    if (res.ok) {
      this._statusCache = {
        busy: !!res.data?.busy,
        error: typeof res.data?.error === 'string' ? res.data.error : ''
      }
      this.emit('status', this._statusCache)
    }
    return this.getStatus()
  }

  /** 最近一次 status 缓存；未获取过返回 { busy:false, error:'' }。 */
  getStatus() {
    return this._statusCache || { busy: false, error: '' }
  }

  // ── internal ──

  _open() {
    let ws
    try {
      ws = new WebSocket(this.url)
    } catch (err) {
      this._scheduleReconnect()
      return
    }
    this.ws = ws

    ws.on('open', () => {
      this.connected = true
      this._reconnectDelay = this.reconnectDelayMs
      this.emit('connected')
      // 连接建立后立即拉一次 status 供上层判断是否可下发
      this.refreshStatus().catch(() => {})
    })

    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data.toString()) } catch (_) { return }
      const id = msg && msg.id
      if (typeof id !== 'number') return
      const p = this._pending.get(id)
      if (!p) return
      this._pending.delete(id)
      clearTimeout(p.timer)
      if (msg.ok === true) {
        p.resolve({ ok: true, data: msg.data !== undefined ? msg.data : null })
      } else {
        p.resolve({ ok: false, error: msg.error || 'unknown mod error' })
      }
    })

    // ws 库中 error 之后必跟 close，错误只在这里吞掉，重连统一走 close
    ws.on('error', () => {})

    ws.on('close', () => {
      if (this.ws !== ws) return // 已被 close()/connect() 替换
      this.connected = false
      this._rejectAllPending('connection lost')
      this.emit('disconnected', 'closed')
      this._scheduleReconnect()
    })
  }

  _scheduleReconnect() {
    if (this.closing || this._reconnectTimer) return
    const delay = this._reconnectDelay
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this.reconnectMaxMs)
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      if (!this.closing) this._open()
    }, delay)
  }

  _rejectAllPending(reason) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: reason })
    }
    this._pending.clear()
  }
}

module.exports = { ModWSClient }
