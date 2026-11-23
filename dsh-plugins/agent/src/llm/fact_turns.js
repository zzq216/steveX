import { renderTemplate } from './prompts.js'

/**
 * 事实确认回合与"查了源码就要补事实库"的提醒（P5 实施细则 §2、§7）。零 DSH 依赖：会话只通过注入的 deliver 触达。
 *
 * - 事实确认回合不是请求（P5-D2）：没有必交的提交工具，结论可以是"源码不支持，不写入"。
 *   /bt fact 用 followup 开新回合（消息来源 { kind: 'stevex-fact' }，第一个 step 认出来绑定工具）；
 *   路由 fact handler 在人发起的回合里直接绑定（factInTurn）
 * - 提醒（P5-D10）：本回合用过 mc_source_* 却没有成功写过事实 → 回合要结束时 steer 一次「完善事实库」；
 *   每回合至多一次、不计次数，大模型说明理由后可以结束。请求的提醒优先（由适配层排先后）
 * - 让路（2026-11-21）：回合要结束时已经有请求在排队等这个会话（如任务失败的修复请求），提醒推迟到下一个回合末尾——
 *   先把请求处理掉，事实下个回合再写（task-20261121063943-1：修复请求在提醒那一步后面排了 41 秒，任务一直挂着）
 * - guard 拿不到回合号（P5 §12 #2）：pre-step 里记下每个会话的当前回合，工具按会话记账
 * - 挪到复盘（docs/事实库写入挪到复盘设计方案.md，reviewTasks = true）：
 *   规划 / 展开 / 修复回合查源码只记到任务名下（onTaskSource，E1），回合末尾不提醒；
 *   复盘回合末尾：任务回合或复盘自己查过源码、复盘没写过事实 → 提醒一次（E4）。
 *   普通问答、/bt fact、快树复盘回合照旧
 */
export const FACT_SOURCE_KIND = 'stevex-fact'
/** 产出树的请求类型：这些回合查源码只记账（E1） */
export const TASK_TURN_KINDS = Object.freeze(['plan', 'expand', 'recover', 'escalate', 'failed', 'died'])
const TASK_TURNS_TEXT = '本任务的规划 / 展开 / 修复回合（复盘目录里的「源码」）'

export class FactTurns {
  /**
   * @param {object} options
   * @param {object} options.prompts  loadPrompts() 的结果
   * @param {string[]} options.tools  事实确认回合准入的工具
   * @param {(sessionId: string, message) => boolean} options.deliver  followup；找不到会话返回 false
   * @param {(sessionId: string, turn: number, tools: string[]) => void} options.onBind  绑定回合工具
   * @param {(sessionId: string, turn: number) => object} [options.describe]  写事实时的来源（请求类型、任务 id……）
   * @param {boolean} [options.remind=true]
   * @param {boolean} [options.reviewTasks=false]  事实挪到复盘写（E1、E4）；false = 每个回合末尾照旧提醒（复盘关掉时，E5c）
   * @param {(taskId, requestId, detail) => void} [options.onTaskSource]  任务回合查了一次源码
   * @param {(taskId) => number} [options.taskSources]  任务回合查过几次源码
   * @param {(source: object) => void} [options.onWrite]  成功写了一条事实（source = 写事实时的来源）
   */
  constructor({ prompts, tools, deliver, onBind, describe = () => ({ kind: 'chat' }), remind = true, log = () => {}, reviewTasks = false, onTaskSource = () => {}, taskSources = () => 0, onWrite = () => {} }) {
    this.prompts = prompts
    this.reviewTasks = reviewTasks
    this.onTaskSource = onTaskSource
    this.taskSources = taskSources
    this.onWrite = onWrite
    this.tools = tools
    this.deliver = deliver
    this.onBind = onBind
    this.describe = describe
    this.remind = remind
    this.log = log
    this.current = new Map() // sessionId → 当前回合
    this.usage = new Map()   // "sessionId#turn" → { source, write, reminded }
    this.checks = new Set()  // 事实确认回合 "sessionId#turn"
    this.deferred = new Set() // 提醒推迟到下一回合的会话
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
    // 上一回合推迟的提醒：记到这个回合上（这个回合写了事实就不用再提醒）
    if (this.deferred.has(sessionId)) {
      this.deferred.delete(sessionId)
      const k = key(sessionId, turn)
      this.usage.set(k, { ...(this.usage.get(k) ?? { write: false, reminded: false }), source: true, deferred: true })
    }
    if (step === 1 && messages.some((m) => m?.source?.kind === FACT_SOURCE_KIND && m.source.reason === 'fact-check')) this.bind(sessionId, turn)
  }

  /**
   * 工具记账：'source' = 用了 mc_source_*（detail = 读了哪里），'write' = 成功写了事实。
   * 挪到复盘时，任务回合的查源码另记到任务名下（E1）。
   */
  note(sessionId, kind, detail = null) {
    if (!sessionId || !this.current.has(sessionId)) return
    const k = key(sessionId, this.current.get(sessionId))
    const row = this.usage.get(k) ?? { source: false, write: false, reminded: false }
    row[kind] = true
    this.usage.set(k, row)
    if (kind === 'write') this.onWrite(this.source(sessionId))
    if (kind === 'source' && this.reviewTasks) {
      const from = this.source(sessionId)
      if (TASK_TURN_KINDS.includes(from.kind) && from.taskId) {
        row.taskTurn = true
        this.onTaskSource(from.taskId, from.requestId ?? null, detail ?? {})
      }
    }
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
   * defer = 已经有请求在排队等这个会话：不提醒，推迟到下一个回合末尾。
   * @returns {null | { text, summary, source }}
   */
  onTurnStopping({ sessionId, turn, defer = false }) {
    if (!this.remind) return null
    if (this.reviewTasks) {
      const from = this.checks.has(key(sessionId, turn)) ? { kind: 'fact-check' } : this.describe(sessionId, turn)
      // E1：任务回合不提醒，查过的源码记在任务名下，复盘时写。交了树以后回合解绑（describe 变成 chat），按记账时的标记认
      if (TASK_TURN_KINDS.includes(from.kind) || this.usage.get(key(sessionId, turn))?.taskTurn) return null
      // E4：复盘回合——任务回合或复盘自己查过源码，复盘没写过事实
      if (from.kind === 'reflect' && from.taskId) return this.reviewReminder(sessionId, turn, from.taskId, defer)
    }
    const row = this.usage.get(key(sessionId, turn))
    if (!row || !row.source || row.write || row.reminded) return null
    if (defer) {
      this.deferred.add(sessionId)
      return null
    }
    row.reminded = true
    const when = row.deferred ? '上一回合（以及本回合）' : '本回合'
    const text = renderTemplate(this.prompts.requests.fact_reminder, { when, skill: this.prompts.skills.fact_record })
    return { text, summary: '提醒：本回合查了 MC 源码，还没有写事实', source: { kind: FACT_SOURCE_KIND, reason: 'fact-reminder' } }
  }

  /** E4：复盘回合末尾的提醒；任务回合的记账不跟着"让路"推迟（复盘请求不排队等修复） */
  reviewReminder(sessionId, turn, taskId, defer) {
    const k = key(sessionId, turn)
    const row = this.usage.get(k) ?? { source: false, write: false, reminded: false }
    const taskRead = this.taskSources(taskId) > 0
    if ((!taskRead && !row.source) || row.write || row.reminded) return null
    if (defer) {
      if (row.source) this.deferred.add(sessionId)
      return null
    }
    row.reminded = true
    this.usage.set(k, row)
    const self = row.deferred ? '上一回合（以及本回合）' : '本回合'
    const when = taskRead && row.source ? `${TASK_TURNS_TEXT}和${self}` : taskRead ? TASK_TURNS_TEXT : self
    const text = renderTemplate(this.prompts.requests.fact_reminder, { when, skill: this.prompts.skills.fact_record })
    return { text, summary: '提醒：查了 MC 源码，还没有写事实', source: { kind: FACT_SOURCE_KIND, reason: 'fact-reminder' } }
  }

  /** 回合结束（真的结束了）：清掉这个回合的记账。 */
  endTurn(sessionId, turn) {
    this.usage.delete(key(sessionId, turn))
    this.checks.delete(key(sessionId, turn))
  }

  onSessionClosed(sessionId) {
    this.current.delete(sessionId)
    this.deferred.delete(sessionId)
    for (const k of [...this.usage.keys()]) if (k.startsWith(`${sessionId}#`)) this.usage.delete(k)
    for (const k of [...this.checks]) if (k.startsWith(`${sessionId}#`)) this.checks.delete(k)
  }
}

function key(sessionId, turn) {
  return `${sessionId}#${turn}`
}
