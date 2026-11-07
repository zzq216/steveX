/**
 * 成本画像（任务历史与复盘评估设计方案 H1）：从一个任务的事件流算出这次的树花了多少、花在哪。
 *
 * 只陈述事实，不下结论：哪里该改由复盘里的 agent 判断（H2、H3）。
 *
 * - 纯执行时间 execMs：任务处于 running 的累计时长（task/state 事件），扣掉等展开 / 修补回合（suspended）与暂停
 * - mod 调用：叶子节点退出事件里的 calls { actions, reads }（一次读 N 个来源记 N 次）
 * - 节点 / 胶囊的耗时按"运行时钟"算：只计 running 期间，所以等 LLM 回合的时间不会算到外层节点头上
 * - 节点 / 胶囊的调用次数含子树：叶子退出时，计入当时所有已进入、尚未退出的节点
 */

const TERMINAL = ['done', 'failed']
/** 执行器请求类型 → 中文 */
const WAIT_TEXT = { expand: '展开', recover: '修补', escalate: '修补', failed: '修补', died: '修补' }

const at = (record) => Date.parse(record.at)

/**
 * @param {object[]} events  一个任务的事件（executor 'event' 的记录，按发生顺序）
 * @param {{ top?: number, repeatMin?: number }} [options]
 * @returns {object|null}  没有 task/start → null
 */
export function buildProfile(events, { top = 10, repeatMin = 3 } = {}) {
  const start = events.find((e) => e.event === 'task/start')
  if (!start) return null
  const startedAt = at(start)
  const end = events.find((e) => e.event === 'task/done' || e.event === 'task/failed')
  const lastAt = end ? at(end) : Math.max(...events.map(at).filter(Number.isFinite))

  // 状态区间 → 运行时钟
  const intervals = [] // { from, to, state }
  let state = 'running'
  let since = startedAt
  for (const e of events) {
    if (e.event !== 'task/state' || e.state === state) continue
    const t = at(e)
    intervals.push({ from: since, to: t, state })
    state = e.state
    since = t
    if (TERMINAL.includes(state)) break
  }
  if (!TERMINAL.includes(state)) intervals.push({ from: since, to: lastAt, state })
  const runningUntil = (t) => {
    let sum = 0
    for (const iv of intervals) {
      if (iv.state !== 'running' || iv.from >= t) continue
      sum += Math.min(iv.to, t) - iv.from
    }
    return sum
  }
  const sumState = (s) => intervals.filter((iv) => iv.state === s).reduce((n, iv) => n + (iv.to - iv.from), 0)
  const hasStates = events.some((e) => e.event === 'task/state')
  let execMs = sumState('running')
  let waitMs = sumState('suspended')
  const pausedMs = sumState('paused')

  // 每个执行器请求等了多久：从 request 到下一次回到 running（或结束）
  const waits = {}
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.event !== 'request') continue
    const kind = WAIT_TEXT[e.type] ?? e.type
    const back = events.slice(i + 1).find((x) => (x.event === 'task/state' && (x.state === 'running' || TERMINAL.includes(x.state))) || x.event === 'task/done' || x.event === 'task/failed')
    const ms = (back ? at(back) : lastAt) - at(e)
    waits[kind] ??= { count: 0, ms: 0 }
    waits[kind].count++
    waits[kind].ms += ms
  }

  // 早期的事件流没有 task/state：等待时间按请求算，执行时间 = 总时长 − 等待（运行时钟退化成墙钟）
  if (!hasStates) {
    waitMs = Object.values(waits).reduce((n, w) => n + w.ms, 0)
    execMs = Math.max(0, lastAt - startedAt - waitMs)
  }

  // 节点：进入 / 退出配对；叶子的调用计入所有在场的节点
  const open = [] // { id, enterRun }
  const nodes = new Map() // id → { id, name, type, ref, runs, modCalls, ms }
  const capsules = new Map() // ref → { ref, runs, modCalls, ms }
  let actions = 0
  let reads = 0
  let nodeRuns = 0
  for (const e of events) {
    if (e.event !== 'node') continue
    if (e.phase === 'enter') {
      open.push({ id: e.id, enterRun: runningUntil(at(e)), calls: 0 })
      continue
    }
    if (e.phase !== 'exit') continue
    nodeRuns++
    const own = (e.calls?.actions ?? 0) + (e.calls?.reads ?? 0)
    actions += e.calls?.actions ?? 0
    reads += e.calls?.reads ?? 0
    if (own) for (const o of open) o.calls += own
    const index = open.findLastIndex((o) => o.id === e.id)
    const frame = index >= 0 ? open.splice(index, 1)[0] : { enterRun: runningUntil(at(e)), calls: own }
    const ms = Math.max(0, runningUntil(at(e)) - frame.enterRun)
    const node = nodes.get(e.id) ?? { id: e.id, name: e.name ?? null, type: e.type, ref: e.ref ?? null, runs: 0, modCalls: 0, ms: 0 }
    node.runs++
    node.modCalls += frame.calls
    node.ms += ms
    nodes.set(e.id, node)
    if (e.ref) {
      const cap = capsules.get(e.ref) ?? { ref: e.ref, runs: 0, modCalls: 0, ms: 0 }
      cap.runs++
      cap.modCalls += frame.calls
      cap.ms += ms
      capsules.set(e.ref, cap)
    }
  }
  const modCalls = actions + reads
  const share = (row) => ({ ...row, callShare: modCalls ? row.modCalls / modCalls : 0, timeShare: execMs ? Math.min(1, row.ms / execMs) : 0 })
  const byCost = (a, b) => b.modCalls - a.modCalls || b.ms - a.ms
  const capsuleRows = [...capsules.values()].sort(byCost).map(share)
  const nodeRows = [...nodes.values()].sort(byCost).map(share)
  // 重复：同一个胶囊被调用 ≥ repeatMin 次；没有胶囊的循环体（同一个节点 id 跑了多次）也算
  const repeats = [
    ...capsuleRows.filter((c) => c.runs >= repeatMin).map((c) => ({ kind: 'capsule', key: c.ref, ...c })),
    // 胶囊内部的节点（id 带 "/"）算在胶囊头上，不重复列
    ...nodeRows.filter((n) => !n.ref && !n.id.includes('/') && n.runs >= repeatMin && n.type !== 'Condition').map((n) => ({ kind: 'node', key: n.id, ...n }))
  ].sort(byCost).slice(0, 5)

  return {
    taskId: start.taskId ?? null,
    outcome: end ? end.event.slice('task/'.length) : null,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: lastAt - startedAt,
    execMs, waitMs, pausedMs, waits,
    modCalls, actions, reads, nodeRuns,
    capsules: capsuleRows.slice(0, top),
    nodes: nodeRows.slice(0, top),
    repeats
  }
}

const sec = (ms) => `${(ms / 1000).toFixed(1)} s`
const pct = (x) => `${Math.round(x * 100)}%`

/** 给复盘请求 / task_get 看的文本。 */
export function formatProfile(profile) {
  if (!profile) return '（没有这个任务的执行事件，算不出成本画像）'
  const waits = Object.entries(profile.waits).map(([kind, w]) => `${kind} ${w.count} 次 ${sec(w.ms)}`).join('、')
  const lines = [
    `总计：执行 ${sec(profile.execMs)}（不含等 LLM 回合 ${sec(profile.waitMs)}${waits ? `：${waits}` : ''}${profile.pausedMs ? `；暂停 ${sec(profile.pausedMs)}` : ''}），` +
      `mod 调用 ${profile.modCalls} 次（动作 ${profile.actions} / 读取 ${profile.reads}），节点执行 ${profile.nodeRuns} 次`
  ]
  if (profile.capsules.length) {
    lines.push(`按胶囊（前 ${profile.capsules.length}，按 mod 调用排；调用与耗时含子树）：`)
    for (const c of profile.capsules) lines.push(`  ${c.ref}  ${c.runs} 次  调用 ${c.modCalls}（${pct(c.callShare)}）  ${sec(c.ms)}（${pct(c.timeShare)}）`)
  }
  if (profile.nodes.length) {
    lines.push(`按节点（前 ${profile.nodes.length}）：`)
    for (const n of profile.nodes) lines.push(`  ${n.id}  ${n.type}${n.name ? ` "${n.name}"` : ''}${n.ref ? ` ${n.ref}` : ''}  ${n.runs} 次  调用 ${n.modCalls}（${pct(n.callShare)}）  ${sec(n.ms)}（${pct(n.timeShare)}）`)
  }
  if (profile.repeats.length) {
    lines.push('重复执行：')
    for (const r of profile.repeats) lines.push(`  ${r.key} 执行 ${r.runs} 次，占 mod 调用 ${pct(r.callShare)}、执行时间 ${pct(r.timeShare)}`)
  }
  return lines.join('\n')
}
