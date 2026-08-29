const { ModWSClient } = require('../mod/client')

/**
 * SteveXAgent —— 改造后：一个 agent = 一个采集端 mod 的 WebSocket 连接。
 *
 * 底层感知/动作不再由 mineflayer bot 提供，而是连到跑在 Minecraft 客户端内的
 * 采集端 mod（stevex-template-1.21.11，WS 25550），直接透传 mod 原生方法
 * （见 steveX_改进方案.md §六）。
 *
 * 状态缓存（getStatus 同步读取，供 Web 面板实时展示）：
 *   - vitals   ← mod `player` 方法（health/maxHealth/…）
 *   - position ← mod `f3` 方法（position.xyz）
 *   - busy     ← mod `status` 方法（是否正在执行非 status 方法）
 * 连接建立后每 3s 轮询刷新一次。
 */
class SteveXAgent {
  constructor(config, name = 'steveX') {
    this.config = config
    this.name = name

    this.client = null
    this.connected = false
    this.connecting = false

    // mod 侧状态缓存
    this.vitals = null       // player 方法返回的 vitals（health/maxHealth 等）
    this.position = null     // f3 方法返回的 position（xyz/block/facing 等）
    this.busy = false
    this.modError = ''
    this.lastRefreshAt = 0

    // Current action shown on the web console.
    this.currentAction = 'Idle'

    this._refreshTimer = null
  }

  /** 当前 agent 的 mod 连接配置（{ host, port }）。 */
  get modConfig() {
    return (this.config && this.config.mod) || {}
  }

  /** 建立到采集端 mod 的 WS 连接。返回是否接受连接（缺 mod 配置时返回 false）。 */
  start() {
    const mod = this.modConfig
    if (!mod.host || !mod.port) {
      console.warn(`[warn](${this.name}) No mod config (host/port) — agent stays offline`)
      return false
    }

    this.connecting = true
    this.currentAction = 'Connecting'

    this.client = new ModWSClient({ url: `ws://${mod.host}:${mod.port}` })
    this.client.on('connected', () => this._onConnected())
    this.client.on('disconnected', () => this._onDisconnected())
    this.client.connect()

    return true
  }

  _onConnected() {
    this.connecting = false
    this.connected = true
    this.currentAction = 'Idle'

    console.log(`[info](${this.name}) Connected to mod at ${this.client.url}`)

    // 立即刷新一次状态，再周期轮询驱动 Web 面板实时数据
    this.refreshState()

    this._refreshTimer = setInterval(() => this.refreshState(), 3000)
  }

  _onDisconnected() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer)
      this._refreshTimer = null
    }
    this.connecting = false
    this.connected = false
    this.currentAction = 'Offline'
  }

  /**
   * 从 mod 拉取 player + f3 + status 刷新状态缓存。
   * 全部调用都走 ModWSClient.call()（失败不抛异常，只保持旧缓存）。
   */
  async refreshState() {
    const client = this.client
    if (!client || !client.isConnected()) return

    const [player, f3] = await Promise.all([
      client.call('player', {}),
      client.call('f3', {})
    ])

    // 等待期间连接可能已被 shutdown()/重建：连接变更则丢弃本次刷新
    if (this.client !== client) return

    if (player.ok && player.data) this.vitals = player.data.vitals || null
    if (f3.ok && f3.data && f3.data.position) this.position = f3.data.position

    const status = await client.refreshStatus()
    if (this.client !== client) return

    this.busy = status.busy
    this.modError = status.error || ''
    this.currentAction = this.busy ? 'Busy' : (this.connected ? 'Idle' : 'Offline')

    this.lastRefreshAt = Date.now()
  }

  /** 是否已连上 mod（在线）。 */
  isOnline() {
    return !!(this.client && this.connected)
  }

  /** 是否处于连接握手/重连中。 */
  isConnecting() {
    return !!(this.client && this.connecting)
  }

  /** 展示名：mod 连接没有独立用户名，回退到配置名。 */
  getUsername() {
    return (this.config && this.config.name) || this.name
  }

  /** 当前动作（Web 面板展示）。 */
  getCurrentAction() {
    return this.currentAction
  }

  /** 关闭 mod 连接，停止状态轮询。 */
  shutdown() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer)
      this._refreshTimer = null
    }

    if (this.client) {
      this.currentAction = 'Disconnecting'
      this.client.close()
      this.client.removeAllListeners()
      this.client = null
    }

    this.connected = false
    this.connecting = false
    this.currentAction = 'Offline'
  }
}

module.exports = {
  SteveXAgent
}
