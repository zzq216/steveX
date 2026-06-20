const fs = require('fs/promises')
const path = require('path')
const skillRegistry = require('../../runtime/skill_registry.ts')

const ENV_CONFIG_RELATIVE_PATH = path.join('configs', 'environments', 'app.json')
const ENV_CONFIG_PATH = path.resolve(process.cwd(), ENV_CONFIG_RELATIVE_PATH)

/**
 * Register all API routes on the Express app.
 */
function registerRoutes(app, manager) {

  // ---- Status ----
  app.get('/api/status', (req, res) => {
    res.json({
      agents: manager.getStatus(),
      uptimeSec: Math.floor(process.uptime())
    })
  })

  // ---- Read environment config ----
  app.get('/api/config/environment', async (req, res) => {
    try {
      const raw = await fs.readFile(ENV_CONFIG_PATH, 'utf8')
      const config = JSON.parse(raw)

      res.json({
        ok: true,
        path: ENV_CONFIG_RELATIVE_PATH,
        config
      })
    } catch (err) {
      console.error('[web] Failed to read environment config:', err)

      res.status(500).json({
        ok: false,
        error: err.message || 'Failed to read environment config'
      })
    }
  })

  // ---- Save environment config ----
  app.post('/api/config/environment', async (req, res) => {
    try {
      const config = req.body && req.body.config

      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return res.status(400).json({
          ok: false,
          error: 'Request body must contain a config object'
        })
      }

      const nextRaw = `${JSON.stringify(config, null, 2)}\n`

      // Guard against oversized config blobs
      const MAX_SIZE = 512 * 1024 // 512 KB
      if (Buffer.byteLength(nextRaw, 'utf8') > MAX_SIZE) {
        return res.status(413).json({
          ok: false,
          error: `Config too large (max ${MAX_SIZE / 1024} KB)`
        })
      }

      await fs.writeFile(ENV_CONFIG_PATH, nextRaw, 'utf8')

      res.json({
        ok: true,
        path: ENV_CONFIG_RELATIVE_PATH
      })
    } catch (err) {
      console.error('[web] Failed to save environment config:', err)

      res.status(500).json({
        ok: false,
        error: err.message || 'Failed to save environment config'
      })
    }
  })

  // ---- Reload config ----
  app.post('/api/reload', (req, res) => {
    manager.reload()
    res.json({ ok: true })
  })

  // ---- Connect agent ----
  app.post('/api/agents/:name/connect', (req, res) => {
    const name = decodeURIComponent(req.params.name)
    const ok = manager.connectAgent(name)
    res.status(ok ? 200 : 404).json({ ok })
  })

  // ---- Disconnect agent ----
  app.post('/api/agents/:name/disconnect', (req, res) => {
    const name = decodeURIComponent(req.params.name)
    const ok = manager.disconnectAgent(name)
    res.status(ok ? 200 : 404).json({ ok })
  })

  // ---- Execute command ----
  app.post('/api/agents/:name/command', async (req, res) => {
    const name = decodeURIComponent(req.params.name)
    const command = (req.body.command || '').trim()

    if (!command) {
      return res.status(400).json({
        ok: false,
        error: 'Missing command'
      })
    }

    const result = await manager.sendCommand(name, command)
    res.status(result.ok ? 200 : 400).json(result)
  })

  app.get('/api/skills', (req, res) => {
    const skills = skillRegistry.list()
    res.json({ ok: true, skills })
  });

  // ---- 404 catch-all ----
  app.use((req, res) => {
    res.status(404).json({
      ok: false,
      error: 'Not found'
    })
  })
}

module.exports = { registerRoutes }