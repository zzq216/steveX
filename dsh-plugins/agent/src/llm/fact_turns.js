import { renderTemplate } from './prompts.js'

/**
 * 事实确认回合与"查了源码就要补事实库"的提醒（P5 实施细则 §2、§7）。零 DSH 依赖：会话只通过注入的 deliver 触达。
 *
 * - 事实确认回合不是请求（P5-D2）：没有必交的提交工具，结论可以是"源码不支持，不写入"。
 *   /bt fact 用 followup 开新回合（消息来源 { kind: 'stevex-fact' }，第一个 step 认出来绑定工具）；
 *   路由 fact handler 在人发起的回合里直接绑定（factInTurn）
 * - 提醒（P5-D10）：本回合用过 mc_source_* 却没有成功写过事实 → 回合要结束时 steer 一次「完善事实库」；
 *   每回合至多一次、不计次数，大模型说明理由后可以结束。请求的提醒优先（由适配层排先后）
 * - guard 拿不到回合号（P5 §12 #2）：pre-step 里记下每个会话的当前回合，工具按会话记账
 */
export const FACT_SOURCE_KIND = 'stevex-fact'

export class FactTurns {
  /**
   * @param {object} options
   * @param {object} options.prompts  loadPrompts() 的结果
   * @param {string[]} options.tools  事实确认回合准入的工具
   * @param {(sessionId: string, message) => boolean} options.deliver  followup；找不到会话返回 false
   * @param {(sessionId: string, turn: number, tools: string[]) => void} options.onBind  绑定回合工具
   * @param {(sessionId: string, turn: number) => object} [options.describe]  写事实时的来源（请求类型、任务 id……）
   * @param {boolean} [options.remind=true]
   */
  constructor({ prompts, tools, deliver, onBind, describe = () => ({ kind: 'chat' }), remind = true, log = () => {} }) {
    this.prompts = prompts
    this.tools = tools
    this.deliver = deliver
    this.onBind = onBind
    this.describe = describe
    this.remind = remind
    this.log = log
    this.current = new Map() // sessionId → 当前回合
    this.usage = new Map()   // "sessionId#turn" → { source, write, reminded }
    this.checks = new Set()  // 事实确认回合 "sessionId#turn"
    this.seq = 0
  }

  /**
   * 开一个事实确认回合。
   * - turn 给了（路由 fact handler）：在人发起的这个回合里确认，返回要放进本 step 的正文
   * - 没给（/bt fact）：followup 叫醒会话
   * @returns {{ ok: true, text? } | { ok: false, error }}
   */
  start({ sessionId, statement, turn = null }) {
    const text = typeof statement === 'string' ? statement.trim() : ''
    if (!text) return { ok: false, error: '陈述是空的' }
    const body = renderTemplate(this.prompts.requests.fact_check, { statement: text, skill: this.prompts.skills.fact_check })
    if (turn !== null) {
      this.bind(sessionId, turn)
      return { ok: true, text: body }
    }
    const id = `f${++this.seq}`
    const summary = `事实确认：${text.length > 100 ? `${text.slice(0, 99)}…` : text}`
    if (!this.deliver(sessionId, { text: body, summary, source: { kind: FACT_SOURCE_KIND, factCheckId: id, reason: 'fact-check' } })) {
      return { ok: false, error: `找不到会话 ${sessionId}` }
    }
    this.log(`[facts] fact check ${id}: ${text}`)
    return { ok: true }
  }

  bind(sessionId, turn) {
    this.checks.add(key(sessionId, turn))
    this.onBind(sessionId, turn, this.tools)
  }

  /** agent/pre-step：记当前回合；第一个 step 认出 /bt fact 的消息。 */
  onPreStep({ sessionId, turn, step, messages = [] }) {
    this.current.set(sessionId, turn)
    if (step === 1 && messages.some((m) => m?.source?.kind === FACT_SOURCE_KIND && m.source.reason === 'fact-check')) this.bind(sessionId, turn)
  }

  /** 工具记账：'source' = 用了 mc_source_*，'write' = 成功写了事实。 */
  note(sessionId, kind) {
    if (!sessionId || !this.current.has(sessionId)) return
    const k = key(sessionId, this.current.get(sessionId))
    const row = this.usage.get(k) ?? { source: false, write: false, reminded: false }
    row[kind] = true
    this.usage.set(k, row)
  }

  /** fact_write 的 source 字段。 */
  source(sessionId) {
    const turn = this.current.get(sessionId) ?? null
    if (turn !== null && this.checks.has(key(sessionId, turn))) return { kind: 'fact-check' }
    return turn === null ? { kind: 'chat' } : this.describe(sessionId, turn)
  }

  isCheck(sessionId, turn) {
    return this.checks.has(key(sessionId, turn))
  }

  /**
   * 回合要结束、且没有请求要提醒时：查了源码却没写事实 → 返回一条 steer 消息（每回合一次）。
   * @returns {null | { text, summary, source }}
   */
  onTurnStopping({ sessionId, turn }) {
    if (!this.remind) return null
    const row = this.usage.get(key(sessionId, turn))
    if (!row || !row.source || row.write || row.reminded) return null
    row.reminded = true
    const text = renderTemplate(this.prompts.requests.fact_reminder, { skill: this.prompts.skills.fact_record })
    return { text, summary: '提醒：本回合查了 MC 源码，还没有写事实', source: { kind: FACT_SOURCE_KIND, reason: 'fact-reminder' } }
  }

  /** 回合结束（真的结束了）：清掉这个回合的记账。 */
  endTurn(sessionId, turn) {
    this.usage.delete(key(sessionId, turn))
    this.checks.delete(key(sessionId, turn))
  }

  onSessionClosed(sessionId) {
    this.current.delete(sessionId)
    for (const k of [...this.usage.keys()]) if (k.startsWith(`${sessionId}#`)) this.usage.delete(k)
    for (const k of [...this.checks]) if (k.startsWith(`${sessionId}#`)) this.checks.delete(k)
  }
}

function key(sessionId, turn) {
  return `${sessionId}#${turn}`
}
