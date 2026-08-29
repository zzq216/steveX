const express = require('express')
const path = require('path')
const { registerRoutes } = require('./routes')
const { registerModRoutes } = require('./mod_routes')
const { getModClient } = require('../../mod')

/**
 * Create and configure the Express application.
 * @param {import('../../agent/agent_manager').AgentManager} manager
 * @returns {import('express').Express}
 */
function createApp(manager) {
  const app = express()

  // JSON body parser
  app.use(express.json())

  // Static files — serve index.html, style.css, app.js from public/
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: 0,
    etag: false,
    lastModified: false
  }))

  // Mod WS API passthrough routes (steveX_改进方案.md §五). mineflayer 已移除，
  // mod 48 方法为底层感知/动作的唯一入口。
  // Registered BEFORE registerRoutes because that one ends with a 404 catch-all
  // middleware, which would otherwise swallow /api/mod/*.
  const modClient = getModClient(manager.config)
  registerModRoutes(app, modClient)

  // API routes
  registerRoutes(app, manager)

  return app
}

module.exports = { createApp }
