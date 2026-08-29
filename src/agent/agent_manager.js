const { EventEmitter } = require('events')
const { SteveXAgent } = require('./agent')

/**
 * AgentManager —— 管理多个 agent（改造后：每个 agent 是一条到采集端 mod 的
 * WebSocket 连接，见 steveX_改进方案.md §六）。连接对象从 mineflayer bot
 * 变为 ModWSClient，生命周期/事件总线保持不变。
 */
class AgentManager {
  constructor(loadConfig) {
    this.loadConfig = loadConfig
    this.config = this.loadConfig()
    this.agents = new Map()
    this.eventBus = new EventEmitter()
    this.eventBus.setMaxListeners(50)

    // Pre-index agent configs by name for O(1) lookup
    this.agentConfigs = new Map(
      (this.config.agents || []).map(cfg => [cfg.name, cfg])
    )
  }

  // ── Lifecycle ──

  disconnectAll() {
    for (const name of this.agents.keys()) {
      this.disconnectAgent(name)
    }
  }

  reload() {
    this.disconnectAll()
    this.config = this.loadConfig()
    this.agentConfigs = new Map(
      (this.config.agents || []).map(cfg => [cfg.name, cfg])
    )
  }

  connectAgent(name) {
    const cfg = this.agentConfigs.get(name)
    if (!cfg) return false

    const existing = this.agents.get(name)
    if (existing?.isOnline() || existing?.isConnecting()) return true

    // Phase A 单连接：per-agent mod 配置缺失时回退全局 config.mod
    // （当前 env 配置的 agent 只有 mineflayer 遗留字段，无 mod 段）
    const agent = new SteveXAgent({ ...cfg, mod: cfg.mod ?? this.config.mod }, name, this.eventBus)
    if (!agent.start()) return false
    this.agents.set(name, agent)

    this.eventBus.emit('agent:connect', { name })
    this.eventBus.emit('agent:update', {
      name,
      timestamp: Date.now()
    })

    return true
  }

  disconnectAgent(name) {
    const agent = this.agents.get(name)
    if (!agent) return false

    agent.shutdown()
    this.agents.delete(name)

    this.eventBus.emit('agent:disconnect', { name })
    this.eventBus.emit('agent:update', {
      name,
      timestamp: Date.now()
    })

    return true
  }

  // ── Runtime data helpers（状态全部来自 mod 缓存）──

  getAgentHealth(agent) {
    const v = agent?.vitals

    // mod 端 health/maxHealth 经 f1() 返回字符串（"17.0"），故与 position
    // 一样用 Number() 强转；非法/缺省值回退 20。
    const n = (val) => {
      const num = Number(val)
      return Number.isFinite(num) ? num : 20
    }

    return {
      health: n(v?.health),
      maxHealth: n(v?.maxHealth)
    }
  }

  /** mod 未暴露游戏模式字段，透传模式下统一标记为 'N/A'。 */
  getAgentGameMode() {
    return 'N/A'
  }

  getAgentPosition(agent) {
    const xyz = agent?.position?.xyz

    if (!Array.isArray(xyz) || xyz.length < 3) {
      return { x: '~', y: '~', z: '~' }
    }

    const fmt = (v) => {
      const num = Number(v)
      return Number.isFinite(num) ? num.toFixed(1) : '~'
    }

    return { x: fmt(xyz[0]), y: fmt(xyz[1]), z: fmt(xyz[2]) }
  }

  getAgentAction(agent) {
    return agent?.currentAction ?? 'Idle'
  }

  getAgentModel(cfg) {
    return cfg?.llm?.model ?? 'Unknown'
  }

  // ── Queries ──

  /**
   * Phase A：返回当前已创建连接的 agent 的 ModWSClient。
   * 透传路由 /api/mod/* 请求时从这里解析 —— 与 agent 卡片的
   * Connect/Disconnect 指向同一连接；无 agent 时返回 null（调用方 502）。
   * Phase B 多 agent 时改为按 name 选择。
   */
  getModClient() {
    for (const agent of this.agents.values()) {
      if (agent.client) return agent.client
    }
    return null
  }

  getStatus() {
    return [...this.agentConfigs.values()].map(cfg => {
      const agent = this.agents.get(cfg.name)
      const online = agent?.isOnline() ?? false
      const { health, maxHealth } = this.getAgentHealth(agent)

      return {
        name: cfg.name,
        username: agent?.getUsername() ?? cfg.name,
        online,

        // Runtime status for frontend live display (from mod player/f3 cache)
        health,
        maxHealth,
        gameMode: this.getAgentGameMode(),
        position: this.getAgentPosition(agent),
        currentAction: this.getAgentAction(agent),

        // Mod connection info + live busy/error
        mod: {
          host: cfg.mod?.host ?? this.config.mod?.host ?? null,
          port: cfg.mod?.port ?? this.config.mod?.port ?? null,
          connected: online,
          busy: agent?.busy ?? false,
          error: agent?.modError ?? ''
        },

        // Config-derived display data
        model: this.getAgentModel(cfg)
      }
    })
  }
}

module.exports = { AgentManager }
