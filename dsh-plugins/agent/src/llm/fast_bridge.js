import { renderTree } from '../bt/overview.js'
import { inspectFast } from '../fast/inspect.js'
import { KNOWLEDGE_TOOLS } from './bridge.js'
import { renderTemplate } from './prompts.js'

/**
 * 快树反思批次 ↔ 专用会话的桥（P3 实施细则 §5）。零 DSH 依赖：会话由注入的 openSession 开，消息由 deliver 送。
 *
 * - 每批开一个新会话（P3-D7），消息只推目录（当前快树 + 每条事件一行），证据由大模型用 fast_inspect 自己取
 * - 快树会话里**每个回合**都只准入 FAST_TOOLS（会话本身就是为这一批开的）
 * - 必须以 fast_submit_patch 或 fast_skip 结束：回合要结束时批次还开着 → 提醒，算一次不合法尝试；
 *   用完 maxInvalidAttempts 次 → 批次记为 abandoned
 * - 批次结束后会话留着（不 dispose），会话日志里能看到大模型是怎么想的
 *
 * @typedef {{ text: string, summary: string, source: object }} OutgoingMessage
 */
export const FAST_SOURCE_KIND = 'stevex-fast'
export const FAST_TOOLS = Object.freeze([...KNOWLEDGE_TOOLS, 'fast_inspect', 'fast_submit_patch', 'fast_skip'])
/** 只在快树会话里能用的工具：别的会话的名单里没有它们。 */
export const FAST_ONLY_TOOLS = Object.freeze(['fast_inspect', 'fast_submit_patch', 'fast_skip'])

const LEVEL = { high: '高', medium: '中', low: '低' }

export class FastBridge {
  /**
   * @param {object} options
   * @param {import('../fast/reflector.js').FastReflector} options.reflector
   * @param {import('../fast/versions.js').FastVersions} options.versions
   * @param {import('../fast/monitor.js').FastMonitor} options.monitor
   * @param {import('../bt/executor.js').Executor} options.executor
   * @param {object} options.prompts
   * @param {(batch) => Promise<string>} options.openSession  开一个新会话，返回 sessionId
   * @param {(sessionId: string, message: OutgoingMessage) => boolean} options.deliver  叫醒会话（followup）
   */
  constructor({ reflector, versions, monitor, executor, prompts, openSession, deliver, maxInvalidAttempts = 3, log = () => {}, now = () => Date.now() }) {
    this.reflector = reflector
    this.versions = versions
    this.monitor = monitor
    this.executor = executor
    this.prompts = prompts
    this.openSession = openSession
    this.deliver = deliver
    this.maxInvalidAttempts = maxInvalidAttempts
    this.log = log
    this.now = now
    this.batches = new Map()   // batchId → { batchId, sessionId, invalidAttempts, closed }
    this.sessions = new Map()  // sessionId → batchId
    this.onBatch = this.onBatch.bind(this)
    this.onBatchEnd = this.onBatchEnd.bind(this)
    reflector.on('batch', this.onBatch)
    reflector.on('batch-end', this.onBatchEnd)
  }

  dispose() {
    this.reflector.off('batch', this.onBatch)
    this.reflector.off('batch-end', this.onBatchEnd)
  }

  isFastSession(sessionId) {
    return this.sessions.has(sessionId)
  }

  // ── 批次 → 会话 ──────────────────────────────────────────────────────────

  async onBatch(batch) {
    const record = { batchId: batch.batchId, sessionId: null, invalidAttempts: 0, closed: false }
    this.batches.set(batch.batchId, record)
    let text
    try {
      text = this.renderBatch(batch)
    } catch (error) {
      return this.abandon(record, `could not render the batch: ${error.message}`)
    }
    let sessionId
    try {
      sessionId = await this.openSession(batch)
    } catch (error) {
      return this.abandon(record, `could not open a session: ${error.message}`)
    }
    record.sessionId = sessionId
    this.sessions.set(sessionId, batch.batchId)
    this.log(`[fast] batch ${batch.batchId} (${batch.events.length} events) → session ${sessionId}`)
    const summary = `快树反思 ${batch.batchId}：${batch.events.length} 条事件，基于 v${batch.base}`
    if (!this.deliver(sessionId, this.message(record, text, summary, 'batch'))) this.abandon(record, `session ${sessionId} is gone`)
  }

  onBatchEnd(batch) {
    const record = this.batches.get(batch.batchId)
    if (record) record.closed = true
  }

  renderBatch(batch) {
    const version = batch.base
    const spec = this.versions.read(version)?.spec
    const stats = new Map(this.monitor.armStats(version, spec.arms.map((a) => a.then.name ?? a.then.id)).map((row) => [row.arm, row]))
    const arms = spec.arms.length
      ? spec.arms.map((arm, i) => {
        const name = arm.then.name ?? arm.then.id
        const s = stats.get(name)
        const counts = s && s.hits ? `命中 ${s.hits} / 掉血事件 ${s.harmed} / 失败 ${s.failed}` : '命中 0'
        return `  ${i + 1}. ${name.padEnd(10)} when ${describeWhen(arm.when)}   ${counts}`
      }).join('\n') + '\n  otherwise（什么都不做）'
      : '  （没有 arm，只有 otherwise：什么都不做）'
    const events = batch.events.map((id) => eventLine(this.monitor.events.get(id) ?? { id })).join('\n')
    return renderTemplate(this.prompts.requests.fast_batch, {
      batchId: batch.batchId,
      count: batch.events.length,
      version,
      armCount: spec.arms.length,
      arms,
      tree: renderTree(spec),
      events,
      maxAttempts: this.maxInvalidAttempts,
      skill: `${this.prompts.skills.fast_reflect}\n\n${this.prompts.skills.fast_author}`
    })
  }

  // ── 回合 ─────────────────────────────────────────────────────────────────

  /** 快树会话的回合准入的工具；不是快树会话 → null。 */
  toolsFor(sessionId) {
    return this.isFastSession(sessionId) ? FAST_TOOLS : null
  }

  /**
   * agent/turn-stopping。
   * @returns {undefined | null | { steer: OutgoingMessage }}  undefined = 不是快树会话；null = 可以结束
   */
  onTurnStopping({ sessionId }) {
    const record = this.recordOf(sessionId)
    if (record === undefined) return undefined
    if (!record || !this.isOpen(record)) return null
    const left = this.charge(record, 'the turn ended without fast_submit_patch or fast_skip')
    if (left <= 0) return null
    const text = renderTemplate(this.prompts.requests.fast_reminder, { batchId: record.batchId, attemptsLeft: left })
    return { steer: this.message(record, text, `提醒：快树批次 ${record.batchId} 还没有提交`, 'reminder') }
  }

  /**
   * agent/error：快树会话的回合出错结束。
   * @returns {undefined | null | { retry: OutgoingMessage }}
   */
  onTurnError({ sessionId, error }) {
    const record = this.recordOf(sessionId)
    if (record === undefined) return undefined
    if (!record || !this.isOpen(record)) return null
    const message = String(error?.message ?? error ?? 'unknown error').slice(0, 500)
    const left = this.charge(record, `the turn errored: ${message}`)
    if (left <= 0) return null
    const text = renderTemplate(this.prompts.requests.fast_retry, { batchId: record.batchId, attemptsLeft: left, error: message })
    return { retry: this.message(record, text, `重试：快树批次 ${record.batchId}（上一回合出错）`, 'retry') }
  }

  /** 会话被关掉：它的批次作废。 */
  onSessionClosed(sessionId) {
    const record = this.recordOf(sessionId)
    if (record && this.isOpen(record)) this.abandon(record, `session ${sessionId} was closed`)
  }

  // ── 工具 ─────────────────────────────────────────────────────────────────

  /** fast_submit_patch。不合法 → 逐条错误 + 剩余次数（版本冲突不计次：那不是写错了）。 */
  submit({ sessionId, batchId, base, ops, code, reason }) {
    const check = this.check(sessionId, batchId)
    if (check.error) return { ok: false, error: check.error }
    const { record } = check
    const batch = this.reflector.batches.get(batchId)
    const result = this.versions.submit({ base, ops, code, reason, batchId, events: batch?.events ?? [] })
    if (!result.ok) {
      if (result.conflict) return { ...result, attemptsLeft: this.maxInvalidAttempts - record.invalidAttempts }
      return { ...result, attemptsLeft: this.charge(record, result.errors.join('; ')) }
    }
    this.reflector.end(batchId, 'patched', { reason, version: result.version })
    return { ok: true, batchId, version: result.version, arms: result.arms, diff: result.diff }
  }

  /** fast_skip：这批不改，写明理由。 */
  skip({ sessionId, batchId, reason }) {
    const check = this.check(sessionId, batchId)
    if (check.error) return { ok: false, error: check.error }
    if (typeof reason !== 'string' || !reason.trim()) return { ok: false, error: 'reason is required: say why this batch needs no change (or what is missing to handle it)' }
    this.reflector.end(batchId, 'skipped', { reason: reason.trim() })
    return { ok: true, batchId, outcome: 'skipped' }
  }

  inspect(args) {
    return inspectFast(args, { monitor: this.monitor, versions: this.versions, executor: this.executor })
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  /** @returns {undefined | null | object}  undefined = 不是快树会话 */
  recordOf(sessionId) {
    if (!this.sessions.has(sessionId)) return undefined
    return this.batches.get(this.sessions.get(sessionId)) ?? null
  }

  isOpen(record) {
    return !record.closed && this.reflector.isRunning(record.batchId)
  }

  check(sessionId, batchId) {
    const record = this.batches.get(batchId)
    if (!record) return { error: `没有快树批次 ${batchId}` }
    if (sessionId && record.sessionId !== sessionId) return { error: `快树批次 ${batchId} 属于另一个会话` }
    if (!this.isOpen(record)) return { error: `快树批次 ${batchId} 已经结束` }
    return { record }
  }

  /** 计一次不合法尝试；用完 → 批次 abandoned。@returns 剩余次数 */
  charge(record, reason) {
    record.invalidAttempts++
    const left = this.maxInvalidAttempts - record.invalidAttempts
    if (left <= 0) this.abandon(record, `no valid patch after ${record.invalidAttempts} attempts (last: ${reason})`)
    return Math.max(0, left)
  }

  abandon(record, reason) {
    record.closed = true
    this.reflector.end(record.batchId, 'abandoned', { reason })
    this.log(`[fast] batch ${record.batchId} abandoned: ${reason}`)
  }

  message(record, text, summary, reason) {
    return { text, summary, source: { kind: FAST_SOURCE_KIND, batchId: record.batchId, reason } }
  }
}

/** 事件的一行摘要（批次目录）。 */
export function eventLine(record) {
  if (!record.kind) return `${record.id}  （事件记录不见了）`
  const harm = record.harm ?? {}
  const types = Object.entries(harm.types ?? {}).map(([t, n]) => `${t} ×${n}`).join('，')
  const attackers = Object.entries(harm.attackers ?? {}).map(([t, n]) => `${t} ×${n}`).join('，')
  const hurt = harm.total ? `掉血 ${harm.total}（${harm.hits} 次${types ? `：${types}` : ''}${attackers ? `；来自 ${attackers}` : ''}）` : '没掉血'
  const died = harm.died ? `，死亡${harm.deathMessage ? `：${harm.deathMessage}` : ''}` : ''
  const arm = record.arm ? `「${record.arm}」${record.episodes > 1 ? ` ×${record.episodes} 次情节` : ''}` : 'otherwise'
  const error = record.armError ? `，错误：${String(record.armError).slice(0, 120)}` : ''
  const task = record.taskId ? `，当时任务 ${record.taskId}${record.taskNode ? ` 在跑 ${record.taskNode}` : ''}` : ''
  return `${record.id}  ${LEVEL[record.level] ?? record.level}  ${record.kind}  v${record.fastVersion}  ${arm}  ${hurt}${died}${error}${task}  快照 ${record.snapshots.before} / ${record.snapshots.after}`
}

function describeWhen(when) {
  const params = when.params && Object.keys(when.params).length ? ` ${JSON.stringify(when.params)}` : ''
  if (when.type === 'Condition') return `${when.ref ?? when.cmd}${params}`
  return `${when.type}${when.name ? ` "${when.name}"` : ''}`
}
