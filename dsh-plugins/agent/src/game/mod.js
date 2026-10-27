import { createRequire } from 'node:module'

/**
 * mod 连接：直接复用 steveX 的 ModWSClient（CJS），不另写协议（集成方案 §2.1）。
 * 任何带 `call(method, params) → Promise<{ ok, data } | { ok: false, error }>` 的对象都能顶替它（测试用假 mod）。
 */
const require = createRequire(import.meta.url)
const { ModWSClient } = require('../../../../src/mod/client.js')
const { METHODS } = require('../../../../src/mod/methods.js')
const { PRESSABLE_METHODS } = require('../../../../src/mod/pressable_methods.js')

export { METHODS, PRESSABLE_METHODS }

export function createModClient({ url = 'ws://127.0.0.1:25550', requestTimeoutMs = 20000 } = {}) {
  const client = new ModWSClient({ url, requestTimeoutMs })
  client.connect()
  return client
}

/** 等到 mod 连上（或超时）。 */
export function waitForConnection(client, timeoutMs = 10000) {
  if (client.isConnected?.()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => { client.off?.('connected', onConnected); resolve(false) }, timeoutMs)
    function onConnected() { clearTimeout(timer); resolve(true) }
    client.once('connected', onConnected)
  })
}
