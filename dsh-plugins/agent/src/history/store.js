import fs from 'node:fs'
import path from 'node:path'

import { buildProfile } from './profile.js'

/**
 * 任务历史（任务历史与复盘评估设计方案 H4–H9）。
 *
 *   <dir>/<taskId>.json        一个任务一条记录：指令、指标、成本画像、最终树、用到的胶囊、复盘评估、前驱
 *   <dir>/index.json           检索用的摘要（task_search 只读它）
 *   <dir>/archive/<taskId>.json 归档的记录（H9）
 *   <capsulesDir>/notes.json   胶囊的已知问题（H8）：和 stats.json 一样在条目之外，不改哈希
 *
 * 系统给证据、agent 写结论：成本画像由 profile.js 算；问题与改进设想只来自复盘里的 task_assess。
 * 问题状态 open（待验证）→ resolved / wrong / blocked，由下一次参考了这条记录（task_get）的任务在复盘时核对（H7）。
 * blocked = 受现有能力限制：不再进核对队列，仍作为胶囊的已知问题可见；记问题时也可以直接标 blocked（2026-11-07）。
 */
const VERSION = 1
const KINDS = ['cost', 'time', 'turns', 'fragile', 'other']
const REVIEW_STATUS = ['resolved', 'open', 'wrong', 'blocked']
const ISSUE_STATUS = ['open', 'blocked']
/** 事件只为还没写记录的任务缓存；最多留这么多个任务 */
const KEEP_EVENT_TASKS = 3

export const HISTORY_DEFAULTS = Object.freeze({
  profileTop: 10, repeatMin: 3, reviewMax: 10, issuesMax: 5,
  treeChars: 8000, archiveUnseenDays: 30, maxActive: 500
})

/**
 * review 里的一项指向哪条以往问题。issue 照说明写序号（数字或数字字符串）；
 * 也认 record 写成 "task-x#0" / "task-x [0]…"，以及 issue 抄了那条问题的原文（只匹配到一条时）。
 */
function reviewTarget(item, openRecords) {
  const raw = String(item?.record ?? '').trim()
  const head = /^(task-[\w-]*\w)\s*(?:(?:#|\[)\s*(\d+))?/.exec(raw)
  const record = head ? head[1] : raw
  let issue = item?.issue
  if (typeof issue === 'string' && /^\s*\[?\s*\d+\s*\]?\s*$/.test(issue)) issue = Number(issue.replace(/[[\]\s]/g, ''))
  if ((issue === undefined || issue === null || issue === '') && head?.[2] !== undefined) issue = Number(head[2])
  if (typeof issue === 'string' && issue.trim()) {
    const text = issue.trim()
    const hits = (openRecords.find((r) => r.taskId === record)?.issues ?? [])
      .filter((it) => text.includes(it.problem.slice(0, 20)) || it.problem.includes(text) || text === it.where || text.startsWith(`${it.where}（`))
    if (hits.length === 1) issue = hits[0].index
  }
  return { record, issue }
}

export class TaskHistory {
  /**
   * @param {object} options
   * @param {string|null} options.dir          记录目录；null = 只在内存里（测试）
   * @param {string|null} [options.capsulesDir] 胶囊库目录（notes.json）
   * @param {object} [options.config]          HISTORY_DEFAULTS 的覆盖
   */
  constructor({ dir = null, capsulesDir = null, config = {}, now = () => Date.now() } = {}) {
    this.dir = dir
    this.notesFile = capsulesDir ? path.join(capsulesDir, 'notes.json') : null
    this.config = { ...HISTORY_DEFAULTS, ...config }
    this.now = now
    this.events = new Map() // taskId → 事件
    this.memory = new Map() // dir 为 null 时的记录
    this.index = this.loadIndex()
    this.notes = this.loadNotes()
  }

  // ── 事件与成本画像（H1）──────────────────────────────────────────────────

  /** 执行器的一条事件（executor.on('event')）。 */
  observe(record) {
    const taskId = record?.taskId
    if (!taskId) return
    let list = this.events.get(taskId)
    if (!list) {
      this.events.set(taskId, list = [])
      while (this.events.size > KEEP_EVENT_TASKS) this.events.delete(this.events.keys().next().value)
    }
    list.push(record)
  }

  profile(taskId) {
    const events = this.events.get(taskId)
    return events ? buildProfile(events, { top: this.config.profileTop, repeatMin: this.config.repeatMin }) : null
  }

  /** 这次任务里出现过的节点 id 与胶囊引用（task_assess 校验 where 用）：事件 + 最终树规格 */
  known(taskId, spec = null) {
    const ids = new Set()
    const refs = new Set()
    for (const e of this.events.get(taskId) ?? []) {
      if (e.event !== 'node') continue
      ids.add(e.id)
      if (e.ref) refs.add(e.ref)
    }
    walk(spec, (key, value) => {
      if (key === 'id') ids.add(value)
      else if (['ref', 'use', 'compute', 'cond'].includes(key) && /^(code|trees|task)\//.test(value)) refs.add(value)
    })
    return { ids, refs }
  }

  // ── 评估（H2、H3）────────────────────────────────────────────────────────

  /**
   * 校验 task_assess 的参数。@returns {{ ok: true, assessment } | { ok: false, errors: string[] }}
   * @param {object} args          { issues?, none?, review? }
   * @param {object} context       { taskId, spec, predecessors: string[] }
   */
  checkAssessment(args, { taskId, spec, predecessors = [] }) {
    const errors = []
    const issues = Array.isArray(args.issues) ? args.issues : args.issues == null ? [] : null
    if (issues === null) errors.push('issues 要是数组')
    const none = typeof args.none === 'string' && args.none.trim() ? args.none.trim() : null
    if (issues && issues.length === 0 && !none) errors.push('没有问题时写 none（为什么没有问题）；有问题时写 issues')
    if (issues && issues.length > 0 && none) errors.push('issues 和 none 只能写一个')
    if (issues && issues.length > this.config.issuesMax) errors.push(`issues 最多 ${this.config.issuesMax} 条（只记最重要的）`)
    const { ids, refs } = this.known(taskId, spec)
    const cleaned = []
    for (const [i, issue] of (issues ?? []).entries()) {
      const at = `issues[${i}]`
      if (!issue || typeof issue !== 'object') { errors.push(`${at} 要是对象`); continue }
      const where = typeof issue.where === 'string' ? issue.where.trim() : ''
      if (!where) errors.push(`${at}.where 必填：节点 id 或胶囊引用`)
      else if (!ids.has(where) && !matchesRef(where, refs)) errors.push(`${at}.where "${where}" 不在这次的树里（写节点 id，或树里用到的胶囊引用，可以不带 @hash）`)
      if (!KINDS.includes(issue.kind)) errors.push(`${at}.kind 要是 ${KINDS.join(' / ')} 之一`)
      for (const field of ['problem', 'evidence']) if (typeof issue[field] !== 'string' || !issue[field].trim()) errors.push(`${at}.${field} 必填`)
      if (issue.idea !== undefined && typeof issue.idea !== 'string') errors.push(`${at}.idea 要是字符串`)
      if (issue.status !== undefined && !ISSUE_STATUS.includes(issue.status)) errors.push(`${at}.status 要是 ${ISSUE_STATUS.join(' / ')} 之一（不写 = open）`)
      cleaned.push({
        where, kind: issue.kind, problem: String(issue.problem ?? '').trim(), evidence: String(issue.evidence ?? '').trim(),
        ...(typeof issue.idea === 'string' && issue.idea.trim() ? { idea: issue.idea.trim() } : {}),
        ...(issue.status === 'blocked' ? { status: 'blocked' } : {})
      })
    }
    const review = []
    const openRecords = this.openIssues(predecessors)
    const open = new Map(openRecords.flatMap((r) => r.issues.map((issue) => [`${r.taskId}#${issue.index}`, issue])))
    const listed = [...open.keys()].map((key) => { const [record, index] = key.split('#'); return `{ record: "${record}", issue: ${index} }` })
    for (const [i, item] of (Array.isArray(args.review) ? args.review : []).entries()) {
      const at = `review[${i}]`
      const { record, issue } = reviewTarget(item, openRecords)
      if (!open.has(`${record}#${issue}`)) {
        errors.push(listed.length
          ? `${at}：对不上待验证的问题（record=${JSON.stringify(item?.record)}，issue=${JSON.stringify(item?.issue)}）。record 写任务 id，issue 写复盘请求里该问题前面方括号中的序号（数字）；这次能核对的是：${listed.join('、')}`
          : `${at}：这次没有可核对的以往问题（复盘请求里没有列出），不用写 review`)
      }
      if (!REVIEW_STATUS.includes(item?.status)) errors.push(`${at}.status 要是 ${REVIEW_STATUS.join(' / ')} 之一`)
      if (typeof item?.evidence !== 'string' || !item.evidence.trim()) errors.push(`${at}.evidence 必填：凭什么这么判断（如这次的指标）`)
      review.push({ record, issue, status: item?.status, evidence: String(item?.evidence ?? '').trim() })
    }
    if (args.review !== undefined && !Array.isArray(args.review)) errors.push('review 要是数组')
    if (errors.length) return { ok: false, errors }
    return { ok: true, assessment: { issues: cleaned, none, review } }
  }

  // ── 记录（H4）────────────────────────────────────────────────────────────

  /**
   * 任务结束（复盘结束，或不复盘时）写一条记录。
   * @param {object} input
   * @param {{ taskId, goal, state, result?, finishedBy?, spec?, versions? }} input.task
   * @param {string} [input.tree]           最终树的文本（renderTree）
   * @param {object|null} [input.assessment] checkAssessment 的结果
   * @param {string[]} [input.predecessors]
   * @param {{ turns?: number, tokens?: object|null }} [input.usage]
   * @param {object} [input.training]
   * @returns {object} 写下的记录
   */
  record({ task, tree = '', assessment = null, predecessors = [], usage = {}, training = null }) {
    const taskId = task.taskId
    const profile = this.profile(taskId)
    // 同一个任务再写一次（手动 /bt reflect 补评估）：看过的次数、前驱沿用
    const prev = this.read(taskId)
    const capsules = [...new Set((profile?.capsules ?? []).map((c) => c.ref).concat([...this.known(taskId, task.spec).refs]))].filter((r) => !r.startsWith('task/')).sort()
    const issues = (assessment?.issues ?? []).map((issue, index) => ({ index, ...issue, status: issue.status === 'blocked' ? 'blocked' : 'open' }))
    const record = {
      version: VERSION,
      taskId,
      at: new Date(this.now()).toISOString(),
      goal: task.goal ?? '',
      outcome: task.state ?? profile?.outcome ?? null,
      ...(task.finishedBy ? { by: task.finishedBy } : {}),
      ...(task.result ? { result: String(task.result).slice(0, 500) } : {}),
      metrics: {
        execMs: profile?.execMs ?? null, waitMs: profile?.waitMs ?? null, durationMs: profile?.durationMs ?? null,
        modCalls: profile?.modCalls ?? null, actions: profile?.actions ?? null, reads: profile?.reads ?? null,
        nodeRuns: profile?.nodeRuns ?? null, turns: usage.turns ?? null, tokens: usage.tokens ?? null,
        planMs: usage.planMs ?? null, reflectMs: usage.reflectMs ?? null, reflectTokens: usage.reflectTokens ?? null
      },
      profile,
      tree,
      spec: task.spec ?? null,
      capsules,
      keywords: keywordsOf(task.goal, capsules),
      assessment: assessment ? { issues, none: assessment.none ?? null, review: assessment.review ?? [] } : null,
      predecessors: [...new Set([...(prev?.predecessors ?? []), ...predecessors])],
      retrieved: prev?.retrieved ?? { count: 0, last: null },
      ...(training ? { training } : {})
    }
    this.writeRecord(record)
    this.index[taskId] = summaryOf(record)
    for (const issue of issues) this.addNote(record, issue)
    if (assessment?.review?.length) this.applyReview(taskId, assessment.review)
    // 淘汰规则 1（H9）：前驱的问题都核对完了，又有了后继 → 归档
    for (const id of record.predecessors) {
      const prev = this.read(id)
      if (prev && !prev.archived && (prev.assessment?.issues ?? []).every((issue) => issue.status !== 'open')) this.archive(id, 'closed: all issues reviewed and a later task built on it')
    }
    this.saveIndex()
    return record
  }

  /** 给已有的记录补字段（训练器写 training 标记）。@returns {object|null} */
  annotate(taskId, fields) {
    const rec = this.read(taskId)
    if (!rec) return null
    Object.assign(rec, fields)
    this.writeRecord(rec)
    if (this.index[taskId]) {
      this.index[taskId] = summaryOf(rec)
      this.saveIndex()
    }
    return rec
  }

  applyReview(reviewerId, review) {
    for (const item of review) {
      const prev = this.read(item.record)
      const issue = prev?.assessment?.issues?.find((x) => x.index === item.issue)
      if (!issue) continue
      issue.status = item.status
      issue.reviews = [...(issue.reviews ?? []), { by: reviewerId, status: item.status, evidence: item.evidence, at: new Date(this.now()).toISOString() }]
      this.writeRecord(prev)
      if (this.index[item.record]) this.index[item.record] = summaryOf(prev)
      this.updateNote(`${item.record}#${item.issue}`, item.status)
    }
  }

  /** 这些记录里还待验证的问题（复盘请求列给 agent 核对，H7）。 */
  openIssues(taskIds) {
    const out = []
    for (const id of taskIds) {
      const rec = this.read(id)
      const issues = (rec?.assessment?.issues ?? []).filter((issue) => issue.status === 'open')
      if (issues.length) out.push({ taskId: id, goal: rec.goal, issues: issues.slice(0, this.config.reviewMax) })
    }
    return out
  }

  // ── 检索（H5）────────────────────────────────────────────────────────────

  /** @returns {Array<object>}  没有匹配 → [] */
  search({ query = '', outcome = null, limit = 20, archived = false } = {}) {
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    return Object.values(this.index)
      .filter((row) => (archived || !row.archived) && (!outcome || row.outcome === outcome))
      .map((row) => {
        const hay = [row.goal, ...row.keywords, ...row.capsules].join('\n').toLowerCase()
        return { row, n: words.length ? words.filter((w) => hay.includes(w)).length : 1 }
      })
      .filter(({ n }) => n > 0)
      .sort((a, b) => b.n - a.n || (a.row.at < b.row.at ? 1 : -1))
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map(({ row }) => ({
        taskId: row.taskId, at: row.at, goal: row.goal, outcome: row.outcome,
        execMs: row.execMs, modCalls: row.modCalls, turns: row.turns,
        openIssues: row.openIssues, capsules: row.capsules.slice(0, 5),
        ...(row.archived ? { archived: true } : {})
      }))
  }

  /**
   * 完整记录（task_get）：树太长时截断，node 给了就只给以它开头的那些行。看过一次记一次（淘汰用）。
   * @returns {object|null}
   */
  get(taskId, { node = null } = {}) {
    const rec = this.read(taskId)
    if (!rec) return null
    rec.retrieved = { count: (rec.retrieved?.count ?? 0) + 1, last: new Date(this.now()).toISOString() }
    this.writeRecord(rec)
    if (this.index[taskId]) {
      this.index[taskId] = summaryOf(rec)
      this.saveIndex()
    }
    let tree = rec.tree ?? ''
    let treeNote = null
    if (node) {
      const lines = tree.split('\n').filter((line) => {
        const head = line.trimStart()
        return head === node || head.startsWith(`${node} `) || head.startsWith(`${node}.`) || head.startsWith(`${node}/`)
      })
      tree = lines.join('\n') || `（树里没有以 ${node} 开头的节点）`
    } else if (tree.length > this.config.treeChars) {
      tree = tree.slice(0, this.config.treeChars)
      treeNote = `树太长，只给了前 ${this.config.treeChars} 字符；用 node 参数看某个节点的子树（如 node: "n1.6"）`
    }
    const { spec, ...rest } = rec
    return { ...rest, tree, ...(treeNote ? { treeNote } : {}) }
  }

  // ── 胶囊的已知问题（H8）──────────────────────────────────────────────────

  addNote(record, issue) {
    if (!/^(code|trees)\//.test(issue.where)) return
    const name = issue.where.split('@')[0]
    const hash = issue.where.includes('@') ? issue.where.split('@')[1] : refHash(record.capsules, name)
    const list = this.notes.issues[name] ?? []
    list.push({ id: `${record.taskId}#${issue.index}`, hash, kind: issue.kind, problem: issue.problem, evidence: issue.evidence, status: issue.status ?? 'open', at: record.at })
    this.notes.issues[name] = list
    this.saveNotes()
  }

  updateNote(id, status) {
    let changed = false
    for (const list of Object.values(this.notes.issues)) {
      for (const note of list) if (note.id === id && note.status !== status) { note.status = status; changed = true }
    }
    if (changed) this.saveNotes()
  }

  /** 一个胶囊（名字，可带 @hash）的已知问题：待验证的（open）与受现有能力限制的（blocked）。@returns {Array<object>} */
  notesFor(ref) {
    const name = String(ref).split('@')[0]
    return (this.notes.issues[name] ?? []).filter((note) => note.status === 'open' || note.status === 'blocked')
  }

  // ── 淘汰（H9）────────────────────────────────────────────────────────────

  /**
   * 规则 2、3（规则 1 在写记录时执行）。@returns {Array<{ taskId, reason }>}
   * @param {{ apply?: boolean }} [options]  false = 演练，只列出
   */
  gc({ apply = false } = {}) {
    const now = this.now()
    const active = Object.values(this.index).filter((row) => !row.archived)
    const keep = (row) => row.openIssues > 0 && row.retrieved > 0 // 规则 4：还有待验证问题、且被看过
    const out = []
    const cutoff = now - this.config.archiveUnseenDays * 86_400_000
    for (const row of active) {
      if (!keep(row) && row.retrieved === 0 && Date.parse(row.at) < cutoff) out.push({ taskId: row.taskId, reason: `never retrieved in ${this.config.archiveUnseenDays} days` })
    }
    const left = active.filter((row) => !out.some((o) => o.taskId === row.taskId))
    if (left.length > this.config.maxActive) {
      const order = left.filter((row) => !keep(row)).sort((a, b) => (a.retrieved - b.retrieved) || (a.at < b.at ? -1 : 1))
      for (const row of order.slice(0, left.length - this.config.maxActive)) out.push({ taskId: row.taskId, reason: `over ${this.config.maxActive} active records` })
    }
    if (apply) {
      for (const { taskId, reason } of out) this.archive(taskId, reason)
      this.saveIndex()
    }
    return out
  }

  archive(taskId, reason) {
    const rec = this.read(taskId)
    if (!rec || rec.archived) return
    rec.archived = { at: new Date(this.now()).toISOString(), reason }
    if (this.dir) {
      fs.mkdirSync(path.join(this.dir, 'archive'), { recursive: true })
      writeAtomic(path.join(this.dir, 'archive', `${taskId}.json`), JSON.stringify(rec, null, 1) + '\n')
      fs.rmSync(path.join(this.dir, `${taskId}.json`), { force: true })
    } else {
      this.memory.set(taskId, rec)
    }
    if (this.index[taskId]) this.index[taskId] = summaryOf(rec)
  }

  // ── 存储 ─────────────────────────────────────────────────────────────────

  read(taskId) {
    if (!/^[\w.-]+$/.test(String(taskId))) return null
    if (!this.dir) return this.memory.get(taskId) ?? null
    for (const file of [path.join(this.dir, `${taskId}.json`), path.join(this.dir, 'archive', `${taskId}.json`)]) {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
    }
    return null
  }

  writeRecord(rec) {
    if (!this.dir) return void this.memory.set(rec.taskId, rec)
    const file = rec.archived ? path.join(this.dir, 'archive', `${rec.taskId}.json`) : path.join(this.dir, `${rec.taskId}.json`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    writeAtomic(file, JSON.stringify(rec, null, 1) + '\n')
  }

  loadIndex() {
    const file = this.dir && path.join(this.dir, 'index.json')
    if (!file || !fs.existsSync(file)) return {}
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return data.version === VERSION ? data.tasks ?? {} : {}
  }

  saveIndex() {
    if (!this.dir) return
    fs.mkdirSync(this.dir, { recursive: true })
    writeAtomic(path.join(this.dir, 'index.json'), JSON.stringify({ version: VERSION, tasks: this.index }, null, 1) + '\n')
  }

  loadNotes() {
    if (this.notesFile && fs.existsSync(this.notesFile)) {
      const data = JSON.parse(fs.readFileSync(this.notesFile, 'utf8'))
      if (data.version === VERSION) return { version: VERSION, issues: data.issues ?? {} }
    }
    return { version: VERSION, issues: {} }
  }

  saveNotes() {
    if (!this.notesFile) return
    fs.mkdirSync(path.dirname(this.notesFile), { recursive: true })
    writeAtomic(this.notesFile, JSON.stringify(this.notes, null, 1) + '\n')
  }
}

function summaryOf(rec) {
  return {
    taskId: rec.taskId, at: rec.at, goal: rec.goal, outcome: rec.outcome,
    execMs: rec.metrics?.execMs ?? null, modCalls: rec.metrics?.modCalls ?? null, turns: rec.metrics?.turns ?? null,
    planMs: rec.metrics?.planMs ?? null, waitMs: rec.metrics?.waitMs ?? null, reflectMs: rec.metrics?.reflectMs ?? null,
    openIssues: (rec.assessment?.issues ?? []).filter((issue) => issue.status === 'open').length,
    assessed: Boolean(rec.assessment),
    predecessors: rec.predecessors ?? [],
    capsules: (rec.capsules ?? []).map((ref) => ref.split('@')[0]),
    keywords: rec.keywords ?? [],
    retrieved: rec.retrieved?.count ?? 0,
    ...(rec.training ? { training: rec.training } : {}),
    ...(rec.archived ? { archived: true } : {})
  }
}

/** 检索词：指令里的物品 id（含不带命名空间的写法）+ 胶囊名和名字里的各段 */
function keywordsOf(goal, capsules) {
  const words = new Set()
  for (const id of String(goal ?? '').match(/[a-z0-9_]+:[a-z0-9_/.]+/g) ?? []) {
    words.add(id)
    words.add(id.split(':')[1])
  }
  for (const ref of capsules) {
    const name = ref.split('@')[0]
    words.add(name)
    for (const part of name.split(/[/.\-]/)) if (part.length > 2) words.add(part)
  }
  return [...words]
}

function matchesRef(where, refs) {
  for (const ref of refs) if (ref === where || ref.startsWith(`${where}@`)) return true
  return false
}

function refHash(capsules, name) {
  const ref = capsules.find((r) => r.split('@')[0] === name)
  return ref ? ref.split('@')[1] : null
}

function walk(value, visit, key = null) {
  if (value === null || value === undefined) return
  if (typeof value === 'string') return key ? visit(key, value) : undefined
  if (Array.isArray(value)) return value.forEach((v) => walk(v, visit, key))
  if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, visit, k)
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}
