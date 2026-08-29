const { ModWSClient } = require('./client')

/**
 * Phase A：单例 mod 连接（对应"单机单客户端 → 单 agent"约束，见 steveX_改进方案.md §八）。
 *
 * 透传路由用同一个客户端实例；Phase B 起每个 agent 各持有自己的 ModWSClient，
 * 届时本模块可退役或改为按 (host, port) 复用。
 */

let instance = null

/**
 * 获取（并在首次调用时建立）共享的 ModWSClient。
 * @param {object} [config]  steveX 配置，取 config.mod = { host, port }
 */
function getModClient(config) {
  if (instance) return instance

  const mod = (config && config.mod) || {}
  const host = mod.host || '127.0.0.1'
  const port = mod.port || 25550

  instance = new ModWSClient({ url: `ws://${host}:${port}` })
  instance.connect()
  return instance
}

module.exports = { getModClient, ModWSClient }
