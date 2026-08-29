const { METHODS, METHOD_NAMES } = require('../../mod/methods')

/**
 * 采集端 mod WS API 透传路由（steveX_改进方案.md §五）。
 *
 * 透传主路径：POST /api/mod/:method，body 即 params，直接中转到 mod，
 * 响应原样回传 { ok, data } / { ok:false, error }。vision 大数据
 * （vision/snapshot 等）只走 HTTP 请求-响应，不进入 WS 广播。
 */

function registerModRoutes(app, modClient) {
  // ── 透传主路径：POST /api/mod/:method ──
  // 方法名含斜杠（vision/snapshot、key/up…），故用 /*splat 捕获整段余下路径
  // （Express 5 / path-to-regexp v8 命名通配符，req.params.splat 为数组）。
  app.post('/api/mod/*splat', async (req, res) => {
    const method = Array.isArray(req.params.splat) ? req.params.splat.join('/') : req.params.splat
    if (!method) {
      return res.status(400).json({ ok: false, error: 'Missing method in path' })
    }
    const params = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body
      : {}

    const result = await modClient.call(method, params)
    // 上游失败（mod 错误 / 未连接 / 超时）统一 502 Bad Gateway
    res.status(result.ok ? 200 : 502).json(result)
  })

  // ── 状态查询：GET /api/mod/status ──
  app.get('/api/mod/status', async (req, res) => {
    // 实时拉取一次 status，避免返回过期缓存
    const status = await modClient.refreshStatus()
    res.json({
      connected: modClient.isConnected(),
      ...status,
      methods: METHOD_NAMES,
      methodCount: METHODS.length
    })
  })

  // ── 通用入口：POST /api/mod，body = { method, params } ──
  // 供不需要 RESTful 路径的调用方（如 LLM 工具调用）
  app.post('/api/mod', async (req, res) => {
    const { method, params } = req.body || {}
    if (typeof method !== 'string' || !method) {
      return res.status(400).json({ ok: false, error: 'Missing method (string) in body' })
    }

    const result = await modClient.call(method, params && typeof params === 'object' ? params : {})
    res.status(result.ok ? 200 : 502).json(result)
  })

  // ── 方法清单：GET /api/mod/methods（与 /api/skills 语义一致）──
  app.get('/api/mod/methods', (req, res) => {
    res.json({ ok: true, methods: METHODS })
  })
}

module.exports = { registerModRoutes }
