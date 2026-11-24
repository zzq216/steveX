import fs from 'node:fs'
import path from 'node:path'

/**
 * 坏工具参数定位（docs/坏工具参数定位设计方案.md）。
 *
 * DSH 的 DeepSeek 适配层解析工具参数失败时只抛一句"tool input is invalid JSON"，位置和原文都丢了（F1）。
 * 参数原文是一段段经 `agent/assistant-stream` 发给插件的（F2、F3）：这里按会话记下最近一次请求里各工具调用的原文，
 * 出错时自己再解析一遍，找出第一个解析失败的调用，生成"错在哪"的说明（Q2）；完整原文另存给人看（Q4）。
 * 只列事实，不给修改建议。
 */

/** 每个会话最多记多少字符的参数原文（Q1） */
export const MAX_TEXT = 2 * 1024 * 1024
/** 最多同时记多少个会话，超出丢掉最久没动的（Q1） */
export const MAX_AGENTS = 32
/** 出错位置前后各给多少字符（Q2） */
export const CONTEXT_CHARS = 80
/** runtime/malformed/ 只留最近多少个文件（Q4） */
export const KEEP_FILES = 50
export const MARK = '⟦✗⟧'
export const NO_SOURCE = '（拿不到这次工具参数的原文，指不出出错位置）'

export class ToolInputTrace {
  /**
   * @param {object} [options]
   * @param {string|null} [options.dir]  原文存到这里（runtime/malformed）；null = 不存
   * @param {() => number} [options.now]
   */
  constructor({ dir = null, now = () => Date.now() } = {}) {
    this.dir = dir
    this.now = now
    this.attempts = new Map() // agent id → { attemptId, turn, step, calls: Map<index, { index, id, name, text }>, size, clipped }
  }

  /** `agent/assistant-stream` 的一帧：start 清空重来，tool-call-delta 拼进对应的调用 */
  onFrame(agentId, frame) {
    if (!agentId || !frame) return
    if (frame.type === 'start') {
      this.attempts.delete(agentId)
      this.attempts.set(agentId, { attemptId: frame.attemptId ?? null, turn: frame.turn ?? null, step: frame.step ?? null, calls: new Map(), size: 0, clipped: false })
      while (this.attempts.size > MAX_AGENTS) this.attempts.delete(this.attempts.keys().next().value)
      return
    }
    if (frame.type !== 'chunk' || frame.chunk?.type !== 'tool-call-delta') return
    const attempt = this.attempts.get(agentId)
    if (!attempt) return
    // 最近有动静的放到最后（丢最久没动的）
    this.attempts.delete(agentId)
    this.attempts.set(agentId, attempt)
    const chunk = frame.chunk
    let call = attempt.calls.get(chunk.index)
    if (!call) attempt.calls.set(chunk.index, call = { index: chunk.index, id: chunk.id ?? null, name: chunk.name ?? null, text: '' })
    if (!call.name && chunk.name) call.name = chunk.name
    const delta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
    if (!delta || attempt.clipped) return
    const room = MAX_TEXT - attempt.size
    if (delta.length > room) {
      call.text += delta.slice(0, room)
      attempt.size = MAX_TEXT
      attempt.clipped = true
      return
    }
    call.text += delta
    attempt.size += delta.length
  }

  /** 取走这个会话最近一次请求的记录（取走后删掉）；没有 → null */
  take(agentId) {
    const attempt = this.attempts.get(agentId) ?? null
    this.attempts.delete(agentId)
    return attempt
  }

  /**
   * 坏工具参数时调用（`agent/error`）：诊断、存原文。
   * @returns {{ detail: string, summary: string | null, file: string | null }}
   *   detail = 放进重试消息的那一段（以空行结尾）；summary = 日志用的一句话（指不出位置时为 null）
   */
  report({ sessionId, turn, error, attempt }) {
    const diagnosis = diagnose(attempt)
    const file = this.save({ sessionId, turn, error, attempt, diagnosis })
    return { detail: renderDetail(diagnosis), summary: diagnosis ? summaryOf(diagnosis) : null, file }
  }

  /** Q4：完整原文写成 runtime/malformed/<时间>-<会话>.json，只留最近 KEEP_FILES 个 */
  save({ sessionId, turn, error, attempt, diagnosis }) {
    if (!this.dir) return null
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const at = new Date(this.now()).toISOString()
      const name = `${at.replace(/[-:.]/g, '').replace('T', '-').slice(0, 18)}-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`
      const file = path.join(this.dir, name)
      const calls = attempt ? [...attempt.calls.values()].sort((a, b) => a.index - b.index).map(({ index, id, name: tool, text }) => ({ index, id, name: tool, length: text.length, text })) : []
      const body = {
        at, sessionId, turn: turn ?? null, error: String(error?.message ?? error ?? ''),
        attempt: attempt ? { attemptId: attempt.attemptId, turn: attempt.turn, step: attempt.step, clipped: attempt.clipped } : null,
        diagnosis: diagnosis ? { ...diagnosis, snippet: undefined } : null,
        calls
      }
      fs.writeFileSync(file, JSON.stringify(body, null, 1) + '\n')
      const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort()
      for (const old of files.slice(0, Math.max(0, files.length - KEEP_FILES))) fs.rmSync(path.join(this.dir, old), { force: true })
      return file
    } catch {
      // 存不下只是少一份排查材料，不能让重试失败
      return null
    }
  }
}

/**
 * 按调用的先后逐个解析，找出第一个解析失败的（DSH 也是按这个顺序查、遇到第一个就报错）。
 * 原文为空的调用跳过：DSH 那时用的是块开头的参数，是合法的（F2）。
 * @returns {{ ordinal, total, name, length, message, position, clipped } | null}  都解析得了或没有记录 → null
 */
export function diagnose(attempt) {
  if (!attempt || attempt.calls.size === 0) return null
  const calls = [...attempt.calls.values()].sort((a, b) => a.index - b.index)
  for (const [i, call] of calls.entries()) {
    if (call.text === '') continue
    try {
      JSON.parse(call.text)
    } catch (error) {
      const message = String(error?.message ?? error)
      const m = /at position (\d+)/.exec(message)
      const position = m ? Number(m[1]) : /end of JSON input/i.test(message) ? call.text.length : null
      return { ordinal: i + 1, total: calls.length, name: call.name, length: call.text.length, message, position, clipped: attempt.clipped, snippet: position === null ? null : snippetAt(call.text, position) }
    }
  }
  return null
}

/** 控制字符显示成可见符号：换行 ␊、回车 ␍、制表符 ␉，其他码值 < 32 的是 U+2400 + 码值，DEL 是 ␡ */
export function visible(text) {
  return text.replace(/[\u0000-\u001f\u007f]/g, (c) => {
    const code = c.charCodeAt(0)
    return code === 0x7f ? '␡' : String.fromCharCode(0x2400 + code)
  })
}

/** 出错位置前后各 CONTEXT_CHARS 个字符，出错点标 MARK，截断处用 … */
export function snippetAt(text, position) {
  const from = Math.max(0, position - CONTEXT_CHARS)
  const to = Math.min(text.length, position + CONTEXT_CHARS)
  return `${from > 0 ? '…' : ''}${visible(text.slice(from, position))}${MARK}${visible(text.slice(position, to))}${to < text.length ? '…' : ''}`
}

/** 代码块围栏：比原文里最长的一串反引号多一个，至少三个 */
export function fenceFor(text) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) ?? []).map((s) => s.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

const block = (text) => {
  const fence = fenceFor(text)
  return `${fence}text\n${text}\n${fence}`
}

/** Q2：放进重试消息的那一段，以空行结尾 */
export function renderDetail(diagnosis) {
  if (!diagnosis) return `${NO_SOURCE}\n\n`
  const tool = diagnosis.name ? `\`${diagnosis.name}\`` : '（没有名字的工具）'
  const parts = [`出错的是这条消息里的第 ${diagnosis.ordinal} 个工具调用 ${tool}（共 ${diagnosis.total} 个），参数原文 ${diagnosis.length} 个字符${diagnosis.clipped ? `（原文太长，只记了前 ${MAX_TEXT} 个字符）` : ''}。解析器报错：`, '', block(diagnosis.message)]
  if (diagnosis.snippet !== null) parts.push('', `出错位置前后的原文（${MARK} 是解析器停下的位置）：`, '', block(diagnosis.snippet))
  return `${parts.join('\n')}\n\n`
}

/** 日志用的一句话（Q4） */
function summaryOf(d) {
  const where = /\(line \d+ column \d+\)/.exec(d.message)?.[0]?.slice(1, -1) ?? (d.position !== null ? `position ${d.position}` : 'unknown position')
  return `in ${d.name ?? '?'} at ${where} (${d.length} chars${d.clipped ? ', clipped' : ''})`
}
