import { diffState, summarizeDiff } from './observe.js'
import { diffSpecs } from './diff.js'
import { renderTree } from './overview.js'
import { walkSpec } from './build.js'

/**
 * 修复请求的证据（P2 实施细则 §4）：消息里只推一份目录，内容由大模型用 bt_inspect 自己取。
 *
 * 这里有三样东西：
 *   SnapshotBuffer  每个任务的快照缓冲（§4.3）：叶子前后、抢占、情节结束、现场读取
 *   buildDirectory  目录（§4.2）：标题、错误、路径、快照名、事件条数、黑板键名——不含快照内容和黑板值
 *   inspect         bt_inspect 的八种查看方式（§4.4；tree 是 P4 §3.3 加的）
 *   buildReflectDirectory  复盘请求的目录（P4 §3.1）
 *
 * 记忆世界的值不在这里（§4.5）：这里能看到的都来自自己的状态和树自己的执行过程。
 */

/** 现场读全时读哪些来源（情节结束、bt_inspect live 的缺省）。 */
export const ALL_STATE_SOURCES = Object.freeze(['player', 'inventory', 'container', 'f3'])

/**
 * 快照缓冲。名字：
 *   before@<id> / after@<id>    叶子第一次执行；同一叶子再次执行（循环、重试、恢复后重跑）→ before@<id>#2 …
 *   interrupt / episode-end / … 特殊时刻；同名再来一次 → interrupt#2 …
 *   live#1 / live#2 …           bt_inspect 的 live（总是带编号）
 * 叶子快照只保留最近 keep 次执行的（环形淘汰）；特殊时刻的保留到任务结束。
 */
export class SnapshotBuffer {
  constructor({ keep = 20 } = {}) {
    this.keep = keep
    this.entries = new Map() // name → { name, at, state, kind: 'leaf' | 'moment' }
    this.runs = new Map()    // 叶子 id → 已开始的执行次数
    this.leafOrder = []      // 叶子执行的先后：[{ before, after }]
    this.counts = new Map()  // 特殊时刻的基名 → 次数
    this.seq = 0             // 写入顺序（同一毫秒里的前后快照也分得清先后）
  }

  /** 叶子开始执行（读到了"前"快照）。 */
  leafBefore(id, state, at) {
    const n = (this.runs.get(id) ?? 0) + 1
    this.runs.set(id, n)
    const suffix = n === 1 ? '' : `#${n}`
    const run = { before: `before@${id}${suffix}`, after: `after@${id}${suffix}` }
    this.entries.set(run.before, { name: run.before, at, seq: ++this.seq, state, kind: 'leaf' })
    this.leafOrder.push(run)
    while (this.leafOrder.length > this.keep) {
      const old = this.leafOrder.shift()
      this.entries.delete(old.before)
      this.entries.delete(old.after)
    }
  }

  /** 叶子结束（成功或失败都读一次"后"）。只配给最近一次 before。 */
  leafAfter(id, state, at) {
    const n = this.runs.get(id)
    if (!n) return
    const name = `after@${id}${n === 1 ? '' : `#${n}`}`
    if (!this.leafOrder.some((run) => run.after === name)) return
    this.entries.set(name, { name, at, seq: ++this.seq, state, kind: 'leaf' })
  }

  /** 特殊时刻。@returns 实际用的名字 */
  moment(base, state, at, { numbered = false } = {}) {
    const n = (this.counts.get(base) ?? 0) + 1
    this.counts.set(base, n)
    const name = numbered ? `${base}#${n}` : n === 1 ? base : `${base}#${n}`
    this.entries.set(name, { name, at, seq: ++this.seq, state, kind: 'moment' })
    return name
  }

  get(name) {
    return this.entries.get(name) ?? null
  }

  /** 新的在前。 */
  names() {
    return [...this.entries.values()].sort((a, b) => b.seq - a.seq).map((entry) => entry.name)
  }
}

/**
 * 目录（§4.2）。
 * @param {object} task     执行器的任务记录
 * @param {object} pending  在飞请求 { requestId, type, evidence }
 * @param {{ path: (id: string) => Array<{ id, name }> }} helpers
 */
export function buildDirectory(task, pending, { path, versions = [] }) {
  const { type, evidence } = pending
  const nodeId = evidence.nodeId ?? evidence.interrupted?.id ?? null
  const node = nodeId ? task.byId.get(nodeId) : null
  const label = (id, name) => `${id}${name ? `「${name}」` : ''}`
  let title
  let error = null
  switch (type) {
    case 'recover':
    case 'escalate':
      title = `快树情节「${evidence.fastArm}」以 ${type === 'recover' ? 'SUCCESS' : 'FAILURE'} 结束；被它中断的 ${evidence.interrupted ? label(evidence.interrupted.id, evidence.interrupted.name) : '（无）'}已归零，原树继续时从它重新开始`
      if (type === 'escalate') error = evidence.armError ?? null
      break
    case 'died':
      title = `死亡并已自动重生；死亡时在跑的 ${evidence.interrupted ? label(evidence.interrupted.id, evidence.interrupted.name) : '（无，任务当时没有叶子在跑）'}${evidence.interrupted ? '已归零，原树继续时从它重新开始' : ''}`
      error = evidence.deathMessage ?? null
      break
    case 'failed':
      title = `节点 ${node ? label(node.id, node.name) : nodeId ?? '（未知）'}失败（已原地重试过一次）`
      error = evidence.error ?? null
      break
    default:
      title = `${type} 请求`
  }
  return {
    requestId: pending.requestId,
    type,
    title,
    error,
    path: nodeId ? path(nodeId) : [],
    snapshots: task.snapshots.names(),
    events: task.events.length,
    blackboard: Object.keys(task.blackboard.snapshot()),
    // 记忆来源的版本换代（P2-D17）：只列换代了的
    versions: versions.filter((row) => row.changed)
  }
}

/** 目录 → 消息正文里的一段文字。 */
export function renderDirectory(dir) {
  const lines = [`${dir.type}：${dir.title}`]
  if (dir.error) lines.push(`错误：${dir.error}`)
  if (dir.path.length) lines.push(`路径：${dir.path.map((p) => `${p.id}${p.name ? `「${p.name}」` : ''}`).join(' → ')}`)
  lines.push('可查看（bt_inspect）：')
  lines.push(`  快照  ${dir.snapshots.length ? `${dir.snapshots.slice(0, 12).join(', ')}${dir.snapshots.length > 12 ? `, …（共 ${dir.snapshots.length} 份）` : `（共 ${dir.snapshots.length} 份）`}` : '（无）'}`)
  lines.push(`  事件  ${dir.events} 条`)
  lines.push(`  黑板  ${dir.blackboard.length ? `${dir.blackboard.length} 个键：${dir.blackboard.join(', ')}` : '（空）'}`)
  if (dir.versions.length) lines.push(`  记忆来源已换代  ${dir.versions.map((v) => `${v.source}（${v.nodeId} 读到之后又变过）`).join('；')}`)
  return lines.join('\n')
}

export const INSPECT_KINDS = Object.freeze(['events', 'snapshot', 'node', 'eval', 'blackboard', 'live', 'versions', 'tree'])

/**
 * bt_inspect（§4.4）：只看当前任务。
 * @param {object} task
 * @param {object} args  { what, ... }
 * @param {object} deps  { game, now, context: () => ctx（求值条件用）, nodeEnters: (id) => number }
 * @returns {Promise<{ ok: true, what, value } | { ok: false, error }>}
 */
export async function inspect(task, args, deps) {
  const what = args?.what
  if (!INSPECT_KINDS.includes(what)) return { ok: false, error: `what must be one of ${INSPECT_KINDS.join(' / ')}` }
  switch (what) {
    case 'events': {
      const last = clampInt(args.last, 30, 1, 200)
      const rows = task.events.filter((e) =>
        (!args.node || String(e.id ?? e.nodeId ?? '').startsWith(args.node)) &&
        (!args.type || String(e.event).startsWith(args.type)))
      return { ok: true, what, value: { total: rows.length, events: rows.slice(-last).map(compactEvent) } }
    }
    case 'snapshot': {
      const entry = task.snapshots.get(args.name)
      if (!entry) return { ok: false, error: missingSnapshot(task, args.name) }
      if (args.against !== undefined) {
        const other = task.snapshots.get(args.against)
        if (!other) return { ok: false, error: missingSnapshot(task, args.against) }
        const diff = diffState(pick(other.state, args.sources), pick(entry.state, args.sources))
        return { ok: true, what, value: { from: other.name, to: entry.name, diff, summary: summarizeDiff(diff) } }
      }
      return { ok: true, what, value: { name: entry.name, at: new Date(entry.at).toISOString(), state: pick(entry.state, args.sources) } }
    }
    case 'node': {
      const node = task.byId.get(args.id)
      if (!node) return { ok: false, error: `no node ${args.id} in the task tree` }
      return { ok: true, what, value: {
        ...node.describe(),
        spec: specWithoutChildren(node.spec),
        children: node.children().map((kid) => kid.id),
        executions: deps.nodeEnters(node.id),
        origin: originOf(task, node)
      } }
    }
    case 'eval': {
      const node = task.byId.get(args.id)
      if (!node) return { ok: false, error: `no node ${args.id} in the task tree` }
      if (node.type !== 'Condition') return { ok: false, error: `${args.id} is a ${node.type}; eval only evaluates Condition nodes` }
      const sources = node.command.sources ?? []
      let snapshot = {}
      let at = 'live'
      if (args.at !== undefined) {
        const entry = task.snapshots.get(args.at)
        if (!entry) return { ok: false, error: missingSnapshot(task, args.at) }
        const missing = sources.filter((s) => !(s in entry.state))
        if (missing.length) return { ok: false, error: `snapshot ${args.at} has no ${missing.join(', ')} (it has ${Object.keys(entry.state).join(', ') || 'nothing'})` }
        snapshot = entry.state
        at = entry.name
      } else if (sources.length) {
        snapshot = await deps.game.read(sources)
      }
      try {
        return { ok: true, what, value: { id: node.id, at, result: node.test(snapshot, deps.context()) } }
      } catch (error) {
        return { ok: true, what, value: { id: node.id, at, result: null, error: error.message } }
      }
    }
    case 'blackboard': {
      const all = task.blackboard.snapshot()
      const keys = Array.isArray(args.keys) && args.keys.length ? args.keys : null
      if (!keys) return { ok: false, error: `keys must be a non-empty list; the blackboard has: ${Object.keys(all).join(', ') || '(empty)'}` }
      const values = {}
      const missing = []
      for (const key of keys) (key in all ? (values[key] = all[key]) : missing.push(key))
      return { ok: true, what, value: missing.length ? { values, missing } : { values } }
    }
    case 'live': {
      const sources = Array.isArray(args.sources) && args.sources.length ? args.sources : ALL_STATE_SOURCES
      const unknown = sources.filter((s) => !ALL_STATE_SOURCES.includes(s))
      if (unknown.length) return { ok: false, error: `unknown sources ${unknown.join(', ')}; use ${ALL_STATE_SOURCES.join(' / ')}` }
      const state = await deps.game.read(sources)
      const name = task.snapshots.moment('live', state, deps.now(), { numbered: true })
      return { ok: true, what, value: { name, state } }
    }
    case 'versions':
      return { ok: true, what, value: { queries: await deps.versions() } }
    case 'tree':
      return inspectTree(task, args)
  }
  return { ok: false, error: `unhandled ${what}` }
}

/** 树版本链（P4 §3.3）：版本表 / 某一版 / 两版之差。旧版不带节点状态（状态只对最新版有意义）。 */
function inspectTree(task, args) {
  const versions = task.versions ?? []
  const table = () => versions.map((v) => ({ version: v.version, origin: v.origin, at: new Date(v.at).toISOString(), nodes: countNodes(v.spec) }))
  if (args.version === undefined) return { ok: true, what: 'tree', value: { versions: table() } }
  const find = (n) => versions.find((v) => v.version === Number(n))
  const entry = find(args.version)
  if (!entry) return { ok: false, error: `no tree version ${args.version}; versions: ${versions.map((v) => v.version).join(', ') || '(none)'}` }
  if (args.against !== undefined) {
    const base = find(args.against)
    if (!base) return { ok: false, error: `no tree version ${args.against}; versions: ${versions.map((v) => v.version).join(', ')}` }
    return { ok: true, what: 'tree', value: { from: base.version, to: entry.version, origin: entry.origin, ...diffSpecs(base.spec, entry.spec) } }
  }
  const latest = entry === versions.at(-1)
  const statuses = latest ? new Map([...task.byId.values()].map((node) => [node.id, node.lastStatus])) : new Map()
  return { ok: true, what: 'tree', value: { version: entry.version, origin: entry.origin, latest, tree: renderTree(entry.spec, { statuses }) } }
}

function countNodes(spec) {
  let n = 0
  walkSpec(spec, () => { n++ })
  return n
}

/**
 * 复盘请求的目录（P4 §3.1）：全是从任务对象里数出来的，不含快照内容和黑板值。
 * @param {object} task
 * @param {object} options
 * @param {Array<{ ref, name }>} options.drafts  本任务的代码草稿（最新版）
 */
export function buildReflectDirectory(task, { drafts = [] } = {}) {
  const nodes = [...task.byId.values()]
  const counts = {}
  for (const node of nodes) {
    const key = node.lastStatus ?? 'NOT_RUN'
    counts[key] = (counts[key] ?? 0) + 1
  }
  const exits = (id) => task.events.filter((e) => e.event === 'node' && e.phase === 'exit' && e.id === id)
  const failures = nodes.filter((node) => exits(node.id).some((e) => e.status === 'FAILURE'))
    .map((node) => ({ id: node.id, times: exits(node.id).filter((e) => e.status === 'FAILURE').length, final: node.lastStatus }))
  const eventKinds = {}
  for (const e of task.events) {
    const kind = String(e.event).split('/')[0]
    eventKinds[kind] = (eventKinds[kind] ?? 0) + 1
  }
  const draftRows = drafts.map(({ ref, name }) => {
    const users = nodes.filter((node) => typeof node.spec?.ref === 'string' && node.spec.ref.startsWith(`task/${name}@`)).map((node) => node.id)
    const runs = users.flatMap((id) => exits(id))
    return { ref, usedBy: users, runs: runs.length, successes: runs.filter((e) => e.status === 'SUCCESS').length }
  })
  return {
    versions: (task.versions ?? []).map((v) => ({ version: v.version, origin: v.origin })),
    nodes: { total: nodes.length, counts },
    failures,
    snapshots: task.snapshots.names(),
    events: { total: task.events.length, kinds: eventKinds },
    blackboard: Object.keys(task.blackboard.snapshot()),
    drafts: draftRows
  }
}

const ORIGIN_TEXT = { outline: '大纲' }

/** 复盘目录 → 消息正文里的一段文字。 */
export function renderReflectDirectory(dir) {
  const origin = (o) => ORIGIN_TEXT[o] ?? o.replace(/^expand /, '展开 ').replace(/^patch (\S+) @ /, '修复（$1）@ ')
  const lines = [`树版本（bt_inspect what=tree）：${dir.versions.map((v) => `v${v.version} ${origin(v.origin)}`).join(' · ') || '（无）'}`]
  lines.push(`节点：共 ${dir.nodes.total} 个；${Object.entries(dir.nodes.counts).map(([k, n]) => `${k === 'NOT_RUN' ? '未执行' : k} ${n}`).join(' · ')}`)
  if (dir.failures.length) lines.push(`失败过的节点：${dir.failures.map((f) => `${f.id} ×${f.times}（最终 ${f.final ?? '未执行'}）`).join('、')}`)
  const snaps = dir.snapshots
  lines.push(`快照（bt_inspect what=snapshot）：${snaps.length ? `${snaps.slice(0, 12).join(', ')}${snaps.length > 12 ? `, …（共 ${snaps.length} 份）` : `（共 ${snaps.length} 份）`}` : '（无）'}`)
  lines.push(`事件（bt_inspect what=events）：${dir.events.total} 条（${Object.entries(dir.events.kinds).map(([k, n]) => `${k} ${n}`).join(' · ')}）`)
  lines.push(`黑板键（bt_inspect what=blackboard）：${dir.blackboard.length ? dir.blackboard.join(' · ') : '（空）'}`)
  lines.push(`代码草稿：${dir.drafts.length ? dir.drafts.map((d) => `${d.ref}（${d.usedBy.length ? `被 ${d.usedBy.join('、')} 引用，执行 ${d.runs} 次、成功 ${d.successes} 次` : '没有节点引用'}）`).join('；') : '（无）'}`)
  return lines.join('\n')
}

function missingSnapshot(task, name) {
  const names = task.snapshots.names()
  return `no snapshot "${name}"; available: ${names.length ? names.join(', ') : '(none)'}`
}

function pick(state, sources) {
  if (!Array.isArray(sources) || sources.length === 0) return state
  return Object.fromEntries(Object.entries(state).filter(([source]) => sources.includes(source)))
}

function compactEvent(e) {
  const { at, taskId, ...rest } = e
  return rest
}

function specWithoutChildren(spec) {
  const { children, child, arms, otherwise, until, expect, ...rest } = spec
  return rest
}

/** 节点自己或最近的祖先上的补丁来源标记（§4.6）。 */
function originOf(task, node) {
  if (node.spec.origin) return node.spec.origin
  const id = node.id
  let best = null
  for (const other of task.byId.values()) {
    if (other.spec.origin && id.startsWith(`${other.id}.`) && (!best || other.id.length > best.id.length)) best = other
  }
  return best?.spec.origin ?? null
}

function clampInt(value, fallback, min, max) {
  const n = Number.isInteger(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}
