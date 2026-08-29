const { WebSocketServer } = require('ws')

/**
 * Set up WebSocket server on top of the existing HTTP server.
 * Bridges AgentManager eventBus → real-time browser push.
 *
 * @param {import('http').Server} server
 * @param {import('../../agent/agent_manager').AgentManager} manager
 */
function setupWebSocket(server, manager) {
  const wss = new WebSocketServer({ server })

  function broadcastSnapshot() {
    broadcast(wss, {
      type: 'snapshot',
      agents: manager.getStatus(),
      uptimeSec: Math.floor(process.uptime())
    })
  }

  // Throttle snapshot broadcasts: mark dirty on events, flush on 1s tick.
  // This prevents a single command from triggering 3+ redundant snapshots
  // (agent:command:start → snapshot, agent:command:done → snapshot, agent:update → snapshot).
  let snapshotDirty = true

  wss.on('connection', (ws) => {
    console.log('[info][ws] Web client connected')

    ws.on('close', () => {
      console.log('[info][ws] Web client disconnected')
    })

    // Send current status snapshot immediately after connect
    ws.send(JSON.stringify({
      type: 'snapshot',
      agents: manager.getStatus(),
      uptimeSec: Math.floor(process.uptime())
    }))
  })

  const statusInterval = setInterval(() => {
    if (snapshotDirty) {
      broadcastSnapshot()
      snapshotDirty = false
    }
  }, 1000)

  // Clean up interval when server closes
  wss.on('close', () => clearInterval(statusInterval))

  // ── AgentManager eventBus → WebSocket broadcast ──

  const eventBus = manager.eventBus
  if (!eventBus) return

  eventBus.on('agent:connect', (data) => {
    broadcast(wss, { type: 'agent:connect', name: data.name })
    snapshotDirty = true
  })

  eventBus.on('agent:disconnect', (data) => {
    broadcast(wss, { type: 'agent:disconnect', name: data.name })
    snapshotDirty = true
  })

  eventBus.on('agent:update', (data) => {
    // 状态数据以 snapshot 全量推送（1s 节流），此处只需置脏标记；
    // 不再单独广播 agent:update 消息 —— 前端无人消费，纯冗余渲染开销。
    snapshotDirty = true
  })

  eventBus.on('agent:llm:input', (data) => {
    broadcast(wss, {
      type: 'agent:llm:input',
      name: data.name,
      model: data.model,
      prompt: data.prompt,
      timestamp: data.timestamp
    })
  })

  eventBus.on('agent:llm:output', (data) => {
    broadcast(wss, {
      type: 'agent:llm:output',
      name: data.name,
      model: data.model,
      response: data.response,
      timestamp: data.timestamp
    })
  })
}

function broadcast(wss, data) {
  const message = JSON.stringify(data)

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(message)
    }
  }
}

module.exports = { setupWebSocket }