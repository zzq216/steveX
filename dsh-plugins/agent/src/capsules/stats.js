import fs from 'node:fs'
import path from 'node:path'

/**
 * 胶囊使用统计（胶囊库整理设计方案 §3）：每个胶囊用得怎么样，只是证据，不参与排序、不触发任何动作。
 *
 *   <capsulesDir>/stats.json   和库放在一起（同样不进 git）；条目文件里不放统计——条目的哈希会因此每次都变
 *
 * 由执行器的事件流驱动（observe）：带 ref 的节点退出事件累计到本任务，task/done | task/failed 时一次并进总账；
 * 复盘里草稿转正（capsule/saved 带 from: "task/…"）把该草稿在本任务里的数字拷到新条目的 draft 下（D5）。
 * 离线重建（scripts/capsule-stats.js --rebuild）把 runtime/tasks/*\/events.jsonl 按同样的顺序喂给 observe，结果一致。
 *
 * - 按完整引用（带哈希）记，展示时按名字汇总（D3）；task/ 草稿不进总账，只留在内存里等转正
 * - 同一个任务只并一次（tasks 列表），手动重复复盘、进程重启、重建都不会翻倍
 * - 快树没有节点事件，快树里的使用不计入（D6）
 * - 统计不做归因：tasksFailed 只是"用过它的任务里有几个失败了"
 */
const VERSION = 1
const MAX_ERROR_SAMPLES = 3
const MAX_ERROR_CHARS = 200
/** 等转正的草稿数字只留最近几个任务（复盘只针对刚结束的任务） */
const KEEP_DRAFT_TASKS = 5
const COUNTS = ['calls', 'ok', 'fail', 'error']
const TASK_COUNTS = ['tasks', 'tasksDone', 'tasksFailed']

export class CapsuleStats {
  /** @param {{ dir: string|null }} options  dir = 库目录；null = 只在内存里（测试） */
  constructor({ dir = null } = {}) {
    this.file = dir ? path.join(dir, 'stats.json') : null
    this.data = this.load()
    this.running = new Map() // taskId → Map<ref, tally>：还没结束的任务
    this.drafts = new Map()  // taskId → Map<draftName, tally>：结束了、草稿还可能被转正
  }

  load() {
    if (this.file && fs.existsSync(this.file)) {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (data.version === VERSION) return { ...emptyData(), ...data, curate: { ...emptyData().curate, ...(data.curate ?? {}) } }
    }
    return emptyData()
  }

  save() {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n')
    fs.renameSync(tmp, this.file)
  }

  /** 执行器的一条事件（executor.on('event')，或重建时从 events.jsonl 读出的一行）。@returns 是否改了总账 */
  observe(record) {
    const taskId = record?.taskId
    if (!taskId) return false
    if (record.event === 'node' && record.phase === 'exit' && typeof record.ref === 'string') {
      if (this.data.tasks.includes(taskId)) return false
      let tallies = this.running.get(taskId)
      if (!tallies) this.running.set(taskId, tallies = new Map())
      let tally = tallies.get(record.ref)
      if (!tally) tallies.set(record.ref, tally = newTally())
      addExit(tally, record)
      return false
    }
    if (record.event === 'task/done' || record.event === 'task/failed') return this.finishTask(taskId, record.event === 'task/done', record.at)
    if (record.event === 'capsule/saved' && typeof record.from === 'string' && record.from.startsWith('task/')) {
      return this.promote(taskId, record.from, record.ref)
    }
    return false
  }

  finishTask(taskId, done, at) {
    const tallies = this.running.get(taskId) ?? new Map()
    this.running.delete(taskId)
    if (this.data.tasks.includes(taskId)) return false
    const drafts = new Map()
    for (const [ref, tally] of tallies) {
      if (ref.startsWith('task/')) {
        const name = draftName(ref)
        drafts.set(name, mergeTally(drafts.get(name) ?? newRow(), tally))
        continue
      }
      const row = this.data.refs[ref] ?? newRow()
      mergeTally(row, tally)
      bumpTask(row, done)
      this.data.refs[ref] = row
    }
    for (const tally of drafts.values()) bumpTask(tally, done)
    this.drafts.set(taskId, drafts)
    while (this.drafts.size > KEEP_DRAFT_TASKS) this.drafts.delete(this.drafts.keys().next().value)
    this.data.tasks.push(taskId)
    this.data.curate.sinceLast++
    this.data.curate.lastTaskAt = at ?? null
    this.save()
    return true
  }

  /** 草稿转正（D5）：把这个任务里 task/<名字>@* 的数字拷到新条目的 draft 下。同一次转正只记一次。 */
  promote(taskId, from, to) {
    const name = draftName(from)
    const tally = this.drafts.get(taskId)?.get(name)
    const key = `${taskId} ${name} ${to}`
    if (!tally || typeof to !== 'string' || this.data.promotions.includes(key)) return false
    const row = this.data.refs[to] ?? newRow()
    row.draft = mergeTally(row.draft ?? newRow(), tally)
    for (const k of TASK_COUNTS) row.draft[k] += tally[k] ?? 0
    this.data.refs[to] = row
    this.data.promotions.push(key)
    this.save()
    return true
  }

  /** 一个完整引用的数字；没有 = null */
  get(ref) {
    return this.data.refs[ref] ?? null
  }

  /** 同名所有版本加总（D3：展示时按名字汇总）。@returns {{ total, versions: [{ hash, row }] } | null} */
  byName(key) {
    const versions = Object.entries(this.data.refs)
      .filter(([ref]) => ref.slice(0, ref.lastIndexOf('@')) === key)
      .map(([ref, row]) => ({ hash: ref.slice(ref.lastIndexOf('@') + 1), row }))
    if (versions.length === 0) return null
    const total = newRow()
    for (const { row } of versions) {
      mergeTally(total, row)
      for (const k of TASK_COUNTS) total[k] += row[k]
      if (row.draft) {
        total.draft = mergeTally(total.draft ?? newRow(), row.draft)
        for (const k of TASK_COUNTS) total.draft[k] += row.draft[k]
      }
    }
    return { total, versions }
  }

  // ── 整理回合的计数（§5.2）──────────────────────────────────────────────

  curateState() {
    return { ...this.data.curate }
  }

  /** 整理请求发出：计数清零。 */
  curateStarted(requestId, at) {
    this.data.curate = { ...this.data.curate, sinceLast: 0, lastAt: at, lastRequestId: requestId }
    this.save()
  }
}

/** 一行摘要（capsule_search / 整理清单用）。kind = 'condition' 时写判真 / 判假；没有数据写"尚无记录"（没用过 ≠ 没用）。 */
export function usageSummary(stat, kind, key = '') {
  const fastNote = /\/fast\./.test(key) ? '（快树里的使用不计入）' : ''
  if (!stat) return `尚无记录${fastNote}`
  const parts = []
  if (stat.calls > 0) {
    const outcome = kind === 'condition'
      ? `判真 ${stat.ok} / 判假 ${stat.fail} / 报错 ${stat.error}`
      : `成功 ${stat.ok} / 失败 ${stat.error}`
    parts.push(`用过 ${stat.calls} 次 / ${stat.tasks} 个任务（${stat.tasksDone} 成 ${stat.tasksFailed} 败），${outcome}`)
  }
  if (stat.draft) {
    const d = stat.draft
    const outcome = kind === 'condition' ? `判真 ${d.ok} / 判假 ${d.fail} / 报错 ${d.error}` : `成功 ${d.ok} / 失败 ${d.error}`
    parts.push(`转正前（草稿）：用过 ${d.calls} 次 / ${d.tasks} 个任务，${outcome}`)
  }
  return parts.length ? parts.join('；') + fastNote : `尚无记录${fastNote}`
}

/** 重建（scripts/capsule-stats.js --rebuild）：按任务目录读 events.jsonl，顺序喂给 observe。 */
export function rebuildStats(stats, runtimeDir) {
  const tasksDir = path.join(runtimeDir, 'tasks')
  const curate = stats.data.curate
  stats.data = { ...emptyData(), curate }
  stats.running.clear()
  stats.drafts.clear()
  const file = stats.file
  stats.file = null // 重建期间不逐条写盘
  let tasks = 0
  try {
    const dirs = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).sort() : []
    for (const dir of dirs) {
      const log = path.join(tasksDir, dir, 'events.jsonl')
      if (!fs.existsSync(log)) continue
      for (const line of fs.readFileSync(log, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        let record
        try { record = JSON.parse(line) } catch { continue }
        stats.observe(record)
      }
      tasks++
    }
  } finally {
    stats.file = file
  }
  stats.data.curate = curate
  stats.save()
  return { tasks, recorded: stats.data.tasks.length, refs: Object.keys(stats.data.refs).length }
}

function emptyData() {
  return { version: VERSION, tasks: [], promotions: [], refs: {}, curate: { sinceLast: 0, lastAt: null, lastRequestId: null, lastTaskAt: null } }
}

function newTally() {
  return { calls: 0, ok: 0, fail: 0, error: 0, firstUsed: null, lastUsed: null, errors: [] }
}

function newRow() {
  return { ...newTally(), tasks: 0, tasksDone: 0, tasksFailed: 0 }
}

/**
 * 一次退出：条件 SUCCESS = 判真、FAILURE 无错误 = 判假、FAILURE 带错误 = 报错；
 * Compute / SubTree 的 FAILURE 一律记 error（展示为"失败"）
 */
function addExit(tally, record) {
  tally.calls++
  if (record.status === 'SUCCESS') tally.ok++
  else if (record.type === 'Condition' && !record.error) tally.fail++
  else {
    tally.error++
    if (record.error) pushError(tally, { taskId: record.taskId, nodeId: record.id, message: String(record.error).slice(0, MAX_ERROR_CHARS) })
  }
  tally.firstUsed ??= record.at ?? null
  tally.lastUsed = record.at ?? tally.lastUsed
}

function mergeTally(into, from) {
  for (const k of COUNTS) into[k] += from[k] ?? 0
  if (from.firstUsed && (!into.firstUsed || from.firstUsed < into.firstUsed)) into.firstUsed = from.firstUsed
  if (from.lastUsed && (!into.lastUsed || from.lastUsed > into.lastUsed)) into.lastUsed = from.lastUsed
  for (const sample of from.errors ?? []) pushError(into, sample)
  return into
}

function pushError(tally, sample) {
  tally.errors.push(sample)
  if (tally.errors.length > MAX_ERROR_SAMPLES) tally.errors.splice(0, tally.errors.length - MAX_ERROR_SAMPLES)
}

function bumpTask(row, done) {
  row.tasks++
  if (done) row.tasksDone++
  else row.tasksFailed++
}

/** "task/name@hash" | "task/name" → name */
function draftName(ref) {
  return ref.slice('task/'.length).split('@')[0]
}
