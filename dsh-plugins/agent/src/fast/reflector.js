import { EventEmitter } from 'node:events'

/**
 * 快树反思的批次（P3 实施细则 §4）：攒事件 → 打批 → 排队 → 交给反思会话（'batch' 事件）→ 结束（end）。
 *
 * 触发（P3-D6）：待反思事件 ≥ batchSize；任务结束且有待反思事件；死亡立即；手动（flush）。
 * 快树正在情节里不打批，等情节结束。同时在飞的批次 ≤ reflectMaxParallel，多的排队。
 * 在飞期间新来的事件不进当前批次。每批最多 batchMaxEvents 条，按信息量从高到低取。
 *
 * 结局（§4.3）：patched / skipped / abandoned。三种都把批次里的事件标成"已反思"，不再进下一批。
 * 没有人接 'batch'（没开大模型侧、或 config.reflect = false）时只攒事件、不打批。
 *
 * 落盘的过程记录（runtime/fast/events.jsonl）：fast/batch-start { batchId, events, base }、
 * fast/batch-end { batchId, outcome, reason, version?, events }。重启后据此重放；开始了没结束的批次（进程中途退出）
 * 记一条 abandoned，事件回到待反思。
 */
export class FastReflector extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('../bt/executor.js').Executor} options.executor
   * @param {import('./monitor.js').FastMonitor} options.monitor
   * @param {() => number} options.currentVersion  批次基于的快树版本（版本链最新版）
   * @param {object} [options.config]  { batchSize, batchMaxEvents, reflectMaxParallel, reflect }
   */
  constructor({ executor, monitor, currentVersion, config = {}, now = () => Date.now() }) {
    super()
    this.executor = executor
    this.monitor = monitor
    this.currentVersion = currentVersion
    this.config = { batchSize: 3, batchMaxEvents: 10, reflectMaxParallel: 1, reflect: true, ...config }
    this.now = now
    this.pending = []           // 待反思的事件 id
    this.batches = new Map()    // batchId → { batchId, events, state, base, createdAt, outcome?, reason?, version? }
    this.queue = []
    this.running = new Set()
    this.seq = 0
    this.want = false
    this.onFastEvent = this.onFastEvent.bind(this)
    this.onTask = this.onTask.bind(this)
    this.onTick = this.onTick.bind(this)
  }

  /** @param {object[]} records  readFastLog 读到的全部记录（monitor.start() 的返回值） */
  start(records = []) {
    this.replay(records)
    this.monitor.on('fast-event', this.onFastEvent)
    this.executor.on('task', this.onTask)
    this.executor.on('tick', this.onTick)
  }

  stop() {
    this.monitor.off('fast-event', this.onFastEvent)
    this.executor.off('task', this.onTask)
    this.executor.off('tick', this.onTick)
  }

  replay(records) {
    const reflected = new Set()
    const started = new Map()
    const pending = []
    for (const record of records) {
      if (record.event === 'fast/event' && record.level !== 'low') pending.push(record.id)
      if (record.event === 'fast/batch-start') {
        started.set(record.batchId, record)
        this.seq = Math.max(this.seq, Number(String(record.batchId).slice(1)) || 0)
      }
      if (record.event === 'fast/batch-end') {
        started.delete(record.batchId)
        for (const id of record.events ?? []) reflected.add(id)
      }
    }
    for (const record of started.values()) {
      this.log({ event: 'fast/batch-end', batchId: record.batchId, outcome: 'abandoned', reason: 'process restarted while the batch was in flight', events: [] })
    }
    this.pending = pending.filter((id) => !reflected.has(id))
    if (this.pending.length >= this.config.batchSize) this.want = true
  }

  enabled() {
    return this.config.reflect && this.listenerCount('batch') > 0
  }

  // ── 触发 ─────────────────────────────────────────────────────────────────

  onFastEvent(record) {
    if (record.level === 'low') return
    this.pending.push(record.id)
    if (record.harm?.died || this.pending.length >= this.config.batchSize) this.want = true
  }

  onTask(summary) {
    if ((summary?.state === 'done' || summary?.state === 'failed') && this.pending.length > 0) this.want = true
  }

  onTick() {
    if (this.want && !this.executor.episode && this.enabled()) this.flush()
  }

  /**
   * 把待反思事件打成一批，立即开始。
   * 并行已满时**不打批**，触发保留到有空位的那个 tick：在飞期间攒下的事件一起进下一批。
   * （游戏内验收：骷髅连杀 12 次，每次死亡都立即打批 → 排出 b3、b4… 每批只有一条同样的事件，每批一个会话）
   * @returns {object|null} 新批次；没有待反思事件 / 没人接 / 并行已满 → null
   */
  flush() {
    if (this.pending.length === 0 || !this.enabled()) {
      this.want = false
      return null
    }
    if (this.running.size >= this.config.reflectMaxParallel) {
      this.want = true
      return null
    }
    this.want = false
    const rank = { high: 0, medium: 1 }
    const ordered = [...this.pending].sort((a, b) => {
      const ea = this.monitor.events.get(a)
      const eb = this.monitor.events.get(b)
      return (rank[ea?.level] ?? 2) - (rank[eb?.level] ?? 2) || Number(a.slice(1)) - Number(b.slice(1))
    })
    const events = ordered.slice(0, this.config.batchMaxEvents)
    this.pending = this.pending.filter((id) => !events.includes(id))
    const batch = { batchId: `b${++this.seq}`, events, state: 'queued', base: null, createdAt: this.now() }
    this.batches.set(batch.batchId, batch)
    this.queue.push(batch)
    this.pump()
    if (this.pending.length >= this.config.batchSize) this.want = true
    return batch
  }

  pump() {
    while (this.running.size < this.config.reflectMaxParallel && this.queue.length > 0) {
      const batch = this.queue.shift()
      batch.state = 'running'
      batch.base = this.currentVersion()
      this.running.add(batch.batchId)
      this.log({ event: 'fast/batch-start', batchId: batch.batchId, events: batch.events, base: batch.base })
      this.emit('batch', batch)
    }
  }

  // ── 结束 ─────────────────────────────────────────────────────────────────

  /**
   * @param {'patched'|'skipped'|'abandoned'} outcome
   * @returns {boolean} 批次在飞并已结束
   */
  end(batchId, outcome, { reason = null, version = null } = {}) {
    const batch = this.batches.get(batchId)
    if (!batch || batch.state !== 'running') return false
    Object.assign(batch, { state: outcome, outcome, reason, version, endedAt: this.now() })
    this.running.delete(batchId)
    this.log({ event: 'fast/batch-end', batchId, outcome, reason, version: version ?? undefined, events: batch.events })
    this.emit('batch-end', batch)
    this.pump()
    if (this.pending.length >= this.config.batchSize) this.want = true
    return true
  }

  isRunning(batchId) {
    return this.running.has(batchId)
  }

  status() {
    return {
      pending: [...this.pending],
      queued: this.queue.map((b) => b.batchId),
      running: [...this.running],
      recent: [...this.batches.values()].filter((b) => b.outcome).slice(-10)
        .map((b) => ({ batchId: b.batchId, outcome: b.outcome, reason: b.reason, version: b.version, events: b.events }))
    }
  }

  log(event) {
    const record = this.executor.eventLog.append(null, Object.fromEntries(Object.entries(event).filter(([, v]) => v !== undefined)))
    this.executor.emit('event', record)
    return record
  }
}
