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

    const agent = new SteveXAgent(cfg, name)
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

    return {
      health: (typeof v?.health === 'number') ? v.health : 20,
      maxHealth: (typeof v?.maxHealth === 'number') ? v.maxHealth : 20
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
