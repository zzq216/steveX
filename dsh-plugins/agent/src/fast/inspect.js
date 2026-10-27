import { compileTree } from '../bt/compiler.js'
import { pinRefs } from '../bt/build.js'
import { renderTree } from '../bt/overview.js'
import { diffState, summarizeDiff } from '../bt/observe.js'
import { ALL_STATE_SOURCES } from '../bt/evidence.js'
import { normalizeCode } from './versions.js'

export const FAST_INSPECT_KINDS = Object.freeze(['event', 'snapshot', 'trace', 'arms', 'versions', 'live', 'eval'])

/**
 * fast_inspect（P3 实施细则 §6.2）：只读执行器内存与快树事件流，没有路径参数。
 * @param {object} args  { what, ... }
 * @param {object} deps  { monitor, versions, executor }
 * @returns {Promise<{ ok: true, what, value } | { ok: false, error }>}
 */
export async function inspectFast(args, { monitor, versions, executor }) {
  const what = args?.what
  if (!FAST_INSPECT_KINDS.includes(what)) return { ok: false, error: `what must be one of ${FAST_INSPECT_KINDS.join(' / ')}` }
  switch (what) {
    case 'event': {
      const record = monitor.events.get(args.id)
      if (!record) return { ok: false, error: missingEvent(monitor, args.id) }
      const { trace, seq, ...rest } = record
      return { ok: true, what, value: rest }
    }
    case 'trace': {
      const record = monitor.events.get(args.id)
      if (!record) return { ok: false, error: missingEvent(monitor, args.id) }
      const last = clampInt(args.last, 50, 1, 200)
      const hits = record.trace?.hits ?? []
      const episodes = record.trace?.episodes ?? []
      return { ok: true, what, value: { id: record.id, hits: hits.slice(-last), episodes: episodes.slice(-last), totalHits: hits.length, totalEpisodes: episodes.length } }
    }
    case 'snapshot': {
      const entry = monitor.snapshot(args.name)
      if (!entry) return { ok: false, error: `no snapshot "${args.name}" (names look like before@e12, after@e12, live#1; old events' snapshots are pruned)` }
      if (args.against !== undefined) {
        const other = monitor.snapshot(args.against)
        if (!other) return { ok: false, error: `no snapshot "${args.against}"` }
        const from = pick(other.state, args.sources)
        const to = pick(entry.state, args.sources)
        const diff = { ...(diffState(from, to) ?? {}), ...playerDiff(from.player, to.player) }
        return { ok: true, what, value: { from: other.name, to: entry.name, diff, summary: summarize(diff) } }
      }
      return { ok: true, what, value: { name: entry.name, state: pick(entry.state, args.sources) } }
    }
    case 'arms': {
      const version = Number.isInteger(args.version) ? args.version : executor.fast?.version ?? 0
      const spec = versions.read(version)?.spec
      if (!spec) return { ok: false, error: `no version v${version} (latest is v${versions.latest()})` }
      return { ok: true, what, value: { version, arms: monitor.armStats(version, spec.arms.map((a) => a.then.name ?? a.then.id)) } }
    }
    case 'versions': {
      if (args.id === undefined) return { ok: true, what, value: { current: executor.fast?.version ?? 0, latest: versions.latest(), versions: versions.list(30) } }
      const entry = versions.read(args.id)
      if (!entry) return { ok: false, error: `no version v${args.id} (latest is v${versions.latest()})` }
      if (args.against !== undefined) {
        const diff = versions.diff(args.against, args.id)
        if (!diff) return { ok: false, error: `no version v${args.against}` }
        return { ok: true, what, value: { from: args.against, to: args.id, diff } }
      }
      return { ok: true, what, value: { meta: entry.meta, tree: renderTree(entry.spec), spec: entry.spec } }
    }
    case 'live': {
      const sources = Array.isArray(args.sources) && args.sources.length ? args.sources : ALL_STATE_SOURCES
      const unknown = sources.filter((s) => !ALL_STATE_SOURCES.includes(s))
      if (unknown.length) return { ok: false, error: `unknown sources ${unknown.join(', ')}; use ${ALL_STATE_SOURCES.join(' / ')}` }
      const state = await executor.game.read(sources)
      return { ok: true, what, value: { name: monitor.saveLive(state), state } }
    }
    case 'eval':
      return evalWhen(args, { monitor, versions, executor })
  }
  return { ok: false, error: `unhandled ${what}` }
}

/** 用某份快照（或现在）的状态求一个 when 条件——写 arm 之前先验证它在那次事故里会不会成立。 */
async function evalWhen(args, { monitor, versions, executor }) {
  const what = 'eval'
  if (args.when === null || typeof args.when !== 'object') return { ok: false, error: 'when must be a condition node, e.g. { "cond": "code/fast.x", "read": ["player"], "params": {...} }' }
  const errors = []
  const code = normalizeCode(args.code, errors)
  if (errors.length) return { ok: false, error: errors.join('; ') }
  // 暂存只在回调同步执行的那一段有效：编译、钉引用、构造节点（取条目）都在第一个 await 之前完成
  return versions.withStaged(code, async (stageErrors) => {
    if (stageErrors.length) return { ok: false, error: stageErrors.join('; ') }
    let spec
    try {
      spec = compileTree(args.when, { kind: 'fast', rootId: 'w' })
    } catch (error) {
      return { ok: false, error: error.message }
    }
    if (spec.type !== 'Condition') return { ok: false, error: `when must be a single condition (got ${spec.type})` }
    const pinned = pinRefs(spec, executor.capsules?.library ?? null)
    if (pinned.errors.length) return { ok: false, error: pinned.errors.join('; ') }
    let condition
    try {
      condition = executor.build(pinned.spec).root
    } catch (error) {
      return { ok: false, error: error.message }
    }
    const sources = condition.command.sources ?? []
    let state
    let at = 'live'
    if (args.at !== undefined) {
      const entry = monitor.snapshot(args.at)
      if (!entry) return { ok: false, error: `no snapshot "${args.at}"` }
      const missing = sources.filter((s) => !(s in entry.state))
      if (missing.length) return { ok: false, error: `snapshot ${args.at} has no ${missing.join(', ')} (it has ${Object.keys(entry.state).join(', ') || 'nothing'})` }
      state = entry.state
      at = entry.name
    } else {
      state = sources.length ? await executor.game.read(sources) : {}
    }
    try {
      return { ok: true, what, value: { at, result: condition.test(state, executor.context(null)) } }
    } catch (error) {
      return { ok: true, what, value: { at, result: null, error: error.message } }
    }
  })
}

/** 玩家状态的差异：生命 / 氧气 / 饥饿 / 冻结与状态标志（快树关心的就是这些）。 */
function playerDiff(before, after) {
  if (!before || !after) return {}
  const out = {}
  for (const key of ['health', 'air', 'food', 'frozenTicks']) {
    const b = before.vitals?.[key]
    const a = after.vitals?.[key]
    if (b !== undefined && a !== undefined && String(b) !== String(a)) out[key] = `${b} → ${a}`
  }
  for (const [key, a] of Object.entries(after.flags ?? {})) {
    const b = before.flags?.[key]
    if (b !== undefined && b !== a) out[key] = `${b} → ${a}`
  }
  if (before.dead !== after.dead) out.dead = `${before.dead} → ${after.dead}`
  return Object.keys(out).length ? { player: out } : {}
}

function summarize(diff) {
  const parts = []
  if (diff.player) parts.push(`player：${Object.entries(diff.player).map(([k, v]) => `${k} ${v}`).join('，')}`)
  const { player, ...rest } = diff
  if (Object.keys(rest).length) parts.push(summarizeDiff(rest))
  return parts.join('；') || '没有变化'
}

function missingEvent(monitor, id) {
  const ids = [...monitor.events.keys()].slice(-10)
  return `no event "${id}"; recent: ${ids.join(', ') || '(none)'}`
}

function pick(state, sources) {
  if (!Array.isArray(sources) || sources.length === 0) return state
  return Object.fromEntries(Object.entries(state).filter(([source]) => sources.includes(source)))
}

function clampInt(value, fallback, min, max) {
  const n = Number.isInteger(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}
