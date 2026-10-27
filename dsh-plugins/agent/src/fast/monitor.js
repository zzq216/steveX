import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { FAILURE } from '../bt/status.js'
import { ALL_STATE_SOURCES } from '../bt/evidence.js'

/**
 * 快树事件流（P3 实施细则 §3）：把执行器的过程记录（fast/episode-*、player/died）和轮询到的 player
 * 合成"有信息量的事件"，写进 runtime/fast/events.jsonl（event: 'fast/event'），交给反思批次。
 *
 * | kind             | 判据                                              | level  |
 * |------------------|---------------------------------------------------|--------|
 * | unhandled-harm   | 命中 otherwise 期间掉血（死了也并进来，died: true） | high   |
 * | death            | 死亡，之前没有掉血记录                             | high   |
 * | arm-failed       | 真实 arm 情节以 FAILURE 结束                       | high   |
 * | arm-harmed       | 真实 arm 情节 SUCCESS，但期间掉血（死了 → high）    | medium |
 * | arm-ok           | 真实 arm、SUCCESS、没掉血                          | low（只计统计，不进批次） |
 *
 * 合并（P3-D5）：otherwise 下的掉血按"事故"记，静默 incidentQuietMs 才结束；同一个 arm 在 episodeMergeMs 内的
 * 相邻情节并成一条（两次情节之间的掉血也算进这组——反射没把危险解决掉）。底下的过程记录照常全量落盘。
 *
 * 事件只写快照名；快照内容在 runtime/fast/snapshots/<id>.json（{ before, after }），保留最近 snapshotKeep 个事件的。
 */
export class FastMonitor extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('../bt/executor.js').Executor} options.executor
   * @param {string|null} [options.runtimeDir]  null = 只在内存里（测试）
   * @param {object} [options.config]  { incidentQuietMs, episodeMergeMs, snapshotKeep }
   */
  constructor({ executor, runtimeDir = null, config = {}, now = () => Date.now() }) {
    super()
    this.executor = executor
    this.game = executor.game
    this.config = { incidentQuietMs: 5000, episodeMergeMs: 10000, snapshotKeep: 200, ...config }
    this.now = now
    this.dir = runtimeDir ? path.join(runtimeDir, 'fast') : null
    this.events = new Map()     // id → fast/event 记录
    this.stats = new Map()      // "version\u0000arm" → { hits, failed, harmed, lastHitAt }
    this.snapshots = new Map()  // id → { before, after }（没有 runtimeDir 时；有的话只缓存最近读过的）
    this.snapshotOrder = []
    this.live = []              // fast_inspect live 存下的快照
    this.seq = 0
    this.current = null         // 正在累积的事故 / 情节组
    this.lastEntry = null       // 上一次处理的 player 缓存条目（每次轮询都是新对象）
    this.lastHealth = null
    this.prevAll = null         // 上一次轮询时的全部缓存（事故的 before）
    this.onTick = this.onTick.bind(this)
    this.onRecord = this.onRecord.bind(this)
  }

  /** 从 events.jsonl 重放事件与统计，然后开始监听执行器。@returns {object[]} 读到的全部快树记录（给反思批次重放） */
  start() {
    const records = readFastLog(this.dir)
    for (const record of records) {
      if (record.event !== 'fast/event') continue
      this.events.set(record.id, record)
      this.count(record)
      const n = Number(record.id.slice(1))
      if (n > this.seq) this.seq = n
    }
    if (this.dir) {
      const dir = path.join(this.dir, 'snapshots')
      if (fs.existsSync(dir)) {
        this.snapshotOrder = fs.readdirSync(dir).filter((f) => /^e\d+\.json$/.test(f)).map((f) => f.slice(0, -5))
          .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
      }
    }
    this.executor.on('tick', this.onTick)
    this.executor.on('event', this.onRecord)
    return records
  }

  stop() {
    this.executor.off('tick', this.onTick)
    this.executor.off('event', this.onRecord)
  }

  // ── 输入 ─────────────────────────────────────────────────────────────────

  onTick() {
    if (this.executor.dying) {
      this.lastHealth = null
      return
    }
    const entry = this.game.cachedEntry('player')
    if (entry && entry !== this.lastEntry) {
      this.lastEntry = entry
      this.sample(entry.data)
    }
    this.checkTimers()
  }

  sample(player) {
    const prevAll = this.prevAll
    this.prevAll = this.game.cachedAll()
    if (player?.dead === true) return
    const health = Number(player?.vitals?.health)
    if (!Number.isFinite(health)) return
    if (this.lastHealth !== null && health < this.lastHealth - 1e-6) this.harm(this.lastHealth - health, health, player, prevAll)
    this.lastHealth = health
    if (this.current) track(this.current, player)
  }

  onRecord(record) {
    switch (record.event) {
      case 'fast/episode-start': return this.episodeStart(record)
      case 'fast/episode-end': return this.episodeEnd(record)
      case 'player/died': return this.died(record)
    }
  }

  // ── 合并 ─────────────────────────────────────────────────────────────────

  open(kind, { arm = null, before = null, taskNode = null } = {}) {
    const now = this.now()
    const group = {
      kind, arm, startedAt: now, lastActivityAt: now,
      before: before ?? this.game.cachedAll(),
      hits: [], episodes: [], inEpisode: false, armError: null, died: false, deathMessage: null,
      minHealth: null, minAir: null,
      fastVersion: this.executor.fast?.version ?? null,
      taskId: activeTaskId(this.executor),
      taskNode: taskNode ?? this.executor.runningLeafId?.() ?? null
    }
    this.current = group
    return group
  }

  /** 当前组还能不能吸收新的掉血：事故一直能（静默才结束）；情节组在情节中或合并窗口内能。 */
  absorbing() {
    const group = this.current
    if (!group) return null
    if (group.kind === 'incident') return group
    return group.inEpisode || this.now() - group.lastActivityAt < this.config.episodeMergeMs ? group : null
  }

  harm(amount, health, player, prevAll) {
    let group = this.absorbing()
    if (!group) {
      if (this.current) this.finalize(this.current)
      group = this.open('incident', { before: prevAll })
    }
    const damage = player?.lastDamage ?? null
    group.hits.push(strip({ at: this.now(), amount: round1(amount), health, type: damage?.type ?? null, attacker: damage?.attacker }))
    group.lastActivityAt = this.now()
  }

  episodeStart(record) {
    const now = this.now()
    const version = this.executor.fast?.version ?? null
    let group = this.current
    const merge = group?.kind === 'arm' && group.arm === record.name && !group.inEpisode &&
      group.fastVersion === version && now - group.lastActivityAt < this.config.episodeMergeMs
    if (!merge) {
      if (group) this.finalize(group)
      group = this.open('arm', { arm: record.name, taskNode: record.interrupted ?? null })
    }
    group.inEpisode = true
    group.episodes.push({ at: now, status: null })
    group.lastActivityAt = now
  }

  episodeEnd(record) {
    const group = this.current
    if (!group || group.kind !== 'arm') return
    const episode = group.episodes.at(-1)
    if (episode) Object.assign(episode, strip({ status: record.status, reason: record.reason ?? undefined, ms: record.durationMs }))
    group.inEpisode = false
    group.lastActivityAt = this.now()
    if (record.status === FAILURE) group.armError = record.error ?? group.armError
  }

  /** 死亡：并进正在累积的组（或新开一个），立即结束这一组。死前状态取缓存（死后背包已掉落）。 */
  died(record) {
    let group = this.absorbing()
    if (!group) {
      if (this.current) this.finalize(this.current)
      group = this.open('incident', { before: this.prevAll })
    }
    const player = this.game.cached(['player'])?.player
    if (this.lastHealth !== null && this.lastHealth > 0) {
      const damage = player?.lastDamage ?? null
      group.hits.push(strip({ at: this.now(), amount: round1(this.lastHealth), health: 0, type: damage?.type ?? null, attacker: damage?.attacker }))
    }
    group.died = true
    group.deathMessage = record.deathMessage ?? null
    if (group.episodes.at(-1)?.status === null) group.episodes.at(-1).status = 'death'
    group.inEpisode = false
    this.lastHealth = null
    this.finalize(group, { after: this.game.cachedAll() })
  }

  checkTimers() {
    const group = this.current
    if (!group) return
    const idle = this.now() - group.lastActivityAt
    if (group.kind === 'incident' && idle >= this.config.incidentQuietMs) this.finalize(group)
    else if (group.kind === 'arm' && !group.inEpisode && idle >= this.config.episodeMergeMs) this.finalize(group)
  }

  /** 立即结束正在累积的组（手动反思、测试）。 */
  flush() {
    if (this.current && !this.current.inEpisode) this.finalize(this.current)
  }

  // ── 落成事件 ─────────────────────────────────────────────────────────────

  finalize(group, { after = null } = {}) {
    if (this.current === group) this.current = null
    const id = `e${++this.seq}`
    const total = round1(group.hits.reduce((sum, hit) => sum + hit.amount, 0))
    const failed = group.episodes.some((e) => e.status === FAILURE)
    let kind
    let level
    if (group.kind === 'incident') {
      kind = group.died && group.hits.length <= 1 ? 'death' : 'unhandled-harm'
      level = 'high'
    } else if (failed) {
      kind = 'arm-failed'
      level = 'high'
    } else if (total > 0 || group.died) {
      kind = 'arm-harmed'
      level = group.died ? 'high' : 'medium'
    } else {
      kind = 'arm-ok'
      level = 'low'
    }
    const record = this.executor.eventLog.append(null, strip({
      event: 'fast/event', id, kind, level,
      startedAt: new Date(group.startedAt).toISOString(),
      endedAt: new Date(this.now()).toISOString(),
      fastVersion: group.fastVersion,
      arm: group.arm,
      status: group.kind === 'arm' ? group.episodes.at(-1)?.status ?? null : undefined,
      episodes: group.kind === 'arm' ? group.episodes.length : undefined,
      harm: strip({
        total, hits: group.hits.length,
        types: countBy(group.hits, 'type'),
        attackers: emptyToUndefined(countBy(group.hits, 'attacker')),
        minHealth: group.minHealth, minAir: group.minAir,
        died: group.died, deathMessage: group.deathMessage ?? undefined
      }),
      armError: group.armError ?? undefined,
      taskId: group.taskId ?? undefined,
      taskNode: group.taskNode ?? undefined,
      snapshots: { before: `before@${id}`, after: `after@${id}` },
      trace: { hits: group.hits, episodes: group.kind === 'arm' ? group.episodes : undefined }
    }))
    this.events.set(id, record)
    this.count(record)
    this.saveSnapshots(id, group.before, after)
    this.emit('fast-event', record)
    return record
  }

  count(record) {
    if (!record.arm) return
    const key = `${record.fastVersion}\u0000${record.arm}`
    const row = this.stats.get(key) ?? { hits: 0, failed: 0, harmed: 0, lastHitAt: null }
    const episodes = record.trace?.episodes ?? []
    row.hits += record.episodes ?? episodes.length
    row.failed += episodes.filter((e) => e.status === FAILURE).length
    if (record.kind === 'arm-harmed') row.harmed += 1
    row.lastHitAt = record.endedAt
    this.stats.set(key, row)
  }

  /** 一个版本的 arm 统计；version 缺省 = 当前装载的版本（包括从没命中过的 arm）。 */
  armStats(version = this.executor.fast?.version ?? null, arms = null) {
    const names = arms ?? (version === (this.executor.fast?.version ?? null) ? this.executor.fast?.spec.arms.map((a) => a.then.name ?? a.then.id) ?? [] : [])
    const rows = new Map(names.map((arm) => [arm, { arm, hits: 0, failed: 0, harmed: 0, lastHitAt: null }]))
    for (const [key, row] of this.stats) {
      const [v, arm] = key.split('\u0000')
      if (String(v) !== String(version)) continue
      rows.set(arm, { arm, ...row })
    }
    return [...rows.values()]
  }

  // ── 快照 ─────────────────────────────────────────────────────────────────

  saveSnapshots(id, before, after) {
    const write = (afterState, error = null) => {
      const entry = { before, after: afterState, ...(error ? { afterError: error } : {}) }
      this.snapshots.set(id, entry)
      if (this.dir) {
        const dir = path.join(this.dir, 'snapshots')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(entry) + '\n')
      }
      this.snapshotOrder.push(id)
      this.prune()
    }
    if (after) return write(after)
    // 事件结束时现场读全（f3 里有脚下方块与坐标），读不到就退回缓存
    this.game.read(ALL_STATE_SOURCES).then(
      (state) => write(state),
      (error) => write(this.game.cachedAll(), error.message)
    )
  }

  prune() {
    while (this.snapshotOrder.length > this.config.snapshotKeep) {
      const old = this.snapshotOrder.shift()
      this.snapshots.delete(old)
      if (this.dir) fs.rmSync(path.join(this.dir, 'snapshots', `${old}.json`), { force: true })
    }
  }

  /** 快照名 before@eN / after@eN / live#n → { name, state } 或 null。 */
  snapshot(name) {
    const live = this.live.find((s) => s.name === name)
    if (live) return live
    const match = /^(before|after)@(e\d+)$/.exec(name ?? '')
    if (!match) return null
    const [, which, id] = match
    let entry = this.snapshots.get(id)
    if (!entry && this.dir) {
      const file = path.join(this.dir, 'snapshots', `${id}.json`)
      if (fs.existsSync(file)) {
        entry = JSON.parse(fs.readFileSync(file, 'utf8'))
        this.snapshots.set(id, entry)
      }
    }
    if (!entry || !entry[which]) return null
    return { name, state: entry[which] }
  }

  saveLive(state) {
    const name = `live#${this.live.length + 1}`
    this.live.push({ name, state })
    if (this.live.length > 20) this.live.shift()
    return name
  }
}

/** 读 runtime/fast/events.jsonl（坏行跳过）。 */
export function readFastLog(dir) {
  if (!dir) return []
  const file = path.join(dir, 'events.jsonl')
  if (!fs.existsSync(file)) return []
  const out = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // 写到一半被打断的行
    }
  }
  return out
}

function track(group, player) {
  const health = Number(player?.vitals?.health)
  const air = Number(player?.vitals?.air)
  if (Number.isFinite(health)) group.minHealth = group.minHealth === null ? health : Math.min(group.minHealth, health)
  if (Number.isFinite(air)) group.minAir = group.minAir === null ? air : Math.min(group.minAir, air)
}

function activeTaskId(executor) {
  const task = executor.task
  return task && ['running', 'suspended', 'paused'].includes(task.state) ? task.taskId : null
}

function countBy(rows, key) {
  const out = {}
  for (const row of rows) if (row[key]) out[row[key]] = (out[row[key]] ?? 0) + 1
  return out
}

function emptyToUndefined(object) {
  return Object.keys(object).length ? object : undefined
}

function round1(n) {
  return Math.round(n * 10) / 10
}

function strip(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))
}
