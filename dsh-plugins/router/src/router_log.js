import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { SLOT_NAMES } from './domain/slots.js'

/**
 * 路由日志（设计方案 §10；阶段 B 细则 D8）：每次路由一行 JSON，写到 `<dir>/<sessionId>.jsonl`。
 * payload 只记长度，人说的原话不落这份日志（它已经在会话日志里）。写失败交给调用方打 warn。
 */
export function createRouterLog(dir) {
  if (!dir) return { write() {} }
  let ready = false
  return {
    write(sessionId, record) {
      if (!ready) {
        mkdirSync(dir, { recursive: true })
        ready = true
      }
      const file = join(dir, `${String(sessionId ?? 'default').replace(/[^\w.-]/g, '_')}.jsonl`)
      appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    }
  }
}

/** 一次路由 → 日志行。 */
export function routeRecord({ sessionId, turn, mode, trace = {}, slotJson, result, notice = null, degraded = null }) {
  const slots = {}
  const payload = {}
  for (const name of SLOT_NAMES) {
    const slot = slotJson?.slots?.[name]
    if (!slot) continue
    slots[name] = [slot.value, slot.confidence]
    if (slot.payload !== null && slot.payload !== undefined) payload[name] = JSON.stringify(slot.payload).length
  }
  const outcomes = {}
  for (const part of result?.parts ?? []) outcomes[part.id] = 'ok'
  for (const { id, error } of result?.errors ?? []) outcomes[id] = `error: ${error?.message ?? String(error)}`
  return {
    at: new Date().toISOString(),
    session: sessionId,
    turn,
    provider: mode,
    model: trace.model ?? null,
    latencyMs: trace.latencyMs ?? null,
    attempts: trace.attempts ?? null,
    slots,
    payload,
    reason: slotJson?.reason ?? '',
    clarification: slotJson?.clarification ?? null,
    handlers: result?.decision?.order ?? [],
    outcomes,
    notice,
    degraded
  }
}
