import { renderTemplate } from '../llm/prompts.js'
import { parseSpareSpec } from './loom.js'
import { rng } from './sampler.js'

/**
 * 制图台题型（docs/制图台训练场设计方案.md）：正前方一台制图台，物品栏里有开局地图（mod 现做，一叠同编号的，K6）和这道题用的辅料，
 * 把它们做成指定的一组地图（每组缩放等级、是否锁定、张数都对）。
 *
 * - 题型（K3）：task=zoom|lock|clone|mix（缺省 mix，三种单项操作等概率）|chain（第一版的随机 1–4 步，不放进 mix）
 * - 单项题（K4）：开局 n 张缩放等级 s₀ 的同编号地图。zoom：其中 m 张放大到 t 级（t ∈ [s₀+1, 4]），纸 m×(t−s₀)；
 *   lock：其中 m 张锁定，玻璃板 m；clone：开局 1 张，做到总共 c 张，空地图 c−1。只发这一种辅料，加 spare（0–3）个余量
 * - chain 题（K5）：从 1 张 s₀ 级地图随机走 ops 步合法操作（放大 / 锁定 / 复制），走完后的全部地图状态就是目标；
 *   按最省用量发料（纸 = 最大缩放等级 − s₀，玻璃板 = 有锁定地图的缩放等级个数，空地图 = 总张数 − 1），用到的各加余量
 * - 判定（K8）：aborted → lost（制图台被挖、地上有东西、地图不守恒）→ overshoot（目标超数，或由开局地图做出的总张数超过目标总数）
 *   → mismap（foreign 地图、开局没有的物品、走不到任何目标的地图）→ timeout → success / false_success / failed；
 *   另算 copied（2×2 合成复制出的张数，取 crafted 统计的增量，K10）
 * - 到达（K9）：mod 在 tick 里按 expect { cartography } 检测，记 reachedAtMs
 *
 * 计数都按签名（K9）：由开局地图做出来的地图是 minecraft:filled_map#scale=N（锁定的加 ,locked），其他地图是 minecraft:filled_map#foreign，
 * 别的物品是 id。
 */

export const FILLED_MAP = 'minecraft:filled_map'
export const EMPTY_MAP = 'minecraft:map'
export const PAPER = 'minecraft:paper'
export const GLASS_PANE = 'minecraft:glass_pane'
export const FOREIGN = `${FILLED_MAP}#foreign`
export const INVENTORY_SLOTS = 36
export const MAX_SCALE = 4
export const MAX_OPS = 4
export const MAX_START_SCALE = 3
export const MAX_MAPS = 3
export const MIN_COPIES = 2
export const MAX_COPIES = 5
/** 操作种类，固定顺序（chain 抽样、kinds 都按它） */
export const OPS = Object.freeze(['zoom', 'lock', 'clone'])
/** 单项题（K3）：mix 在这三种里等概率抽 */
export const SINGLE_TASKS = OPS
export const CARTOGRAPHY_CHOICES = Object.freeze({ task: ['zoom', 'lock', 'clone', 'mix', 'chain'] })
/** 每种单项题用的辅料（K4） */
const MATERIAL_OF = { zoom: 'paper', lock: 'glass', clone: 'empty' }

function parseSpan(name, min, max, text) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(text))
  const lo = match ? Number(match[1]) : NaN
  const hi = match ? Number(match[2] ?? match[1]) : NaN
  if (!(lo >= min && hi <= max && lo <= hi)) throw new Error(`${name} 要写 k 或 a-b（${min}–${max}，a ≤ b），收到 "${text}"`)
  return { lo, hi }
}

/** ops=k|a-b（1–4）：chain 题走几步操作（K5） */
export const parseOpsSpec = (text) => parseSpan('ops', 1, MAX_OPS, text)
/** scale=k|a-b（0–3）：开局地图的缩放等级（K4） */
export const parseMapScaleSpec = (text) => parseSpan('scale', 0, MAX_START_SCALE, text)
/** maps=k|a-b（1–3）：放大、锁定题开局几张（K4） */
export const parseMapsSpec = (text) => parseSpan('maps', 1, MAX_MAPS, text)
/** copies=k|a-b（2–5）：复制题做到总共几张（K4） */
export const parseCopiesSpec = (text) => parseSpan('copies', MIN_COPIES, MAX_COPIES, text)

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
const draw = (random, { lo, hi }) => (lo === hi ? lo : between(random, lo, hi))

function shuffle(random, list) {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** 地图签名（K9） */
export const mapKey = (scale, locked) => `${FILLED_MAP}#scale=${scale}${locked ? ',locked' : ''}`
/** 签名 → { scale, locked }；不是由开局地图做出的地图签名 → null */
export function parseMapKey(key) {
  const match = /^minecraft:filled_map#scale=(\d)(,locked)?$/.exec(key)
  return match ? { scale: Number(match[1]), locked: Boolean(match[2]) } : null
}
const isMapKey = (key) => key.startsWith(`${FILLED_MAP}#`) || key === FILLED_MAP

/**
 * 选项（§5）：命令行的优先，没写的用场地配置。ops 只对 chain 题；maps / copies 不能写在 chain 题上（K5）——这两条只查命令行。
 * @returns {{ task, scale: {lo,hi}, maps: {lo,hi}, copies: {lo,hi}, ops: {lo,hi}, spare: {lo,hi} }}
 */
export function cartographyOptions(args = {}, config = {}) {
  const pick = (key, fallback) => args[key] ?? config[key] ?? fallback
  const task = pick('task', 'mix')
  if (!CARTOGRAPHY_CHOICES.task.includes(task)) throw new Error(`task 只能是 ${CARTOGRAPHY_CHOICES.task.join(' / ')}，收到 "${task}"`)
  if (task !== 'chain' && args.ops) throw new Error('ops 只用于 task=chain')
  if (task === 'chain' && (args.maps || args.copies)) throw new Error('maps / copies 不用于 task=chain')
  return {
    task,
    scale: parseMapScaleSpec(pick('scale', '0-3')),
    maps: parseMapsSpec(pick('maps', '1-3')),
    copies: parseCopiesSpec(pick('copies', '2-5')),
    ops: parseOpsSpec(pick('ops', '1-4')),
    spare: parseSpareSpec(pick('spare', '0-3'))
  }
}

/** 当前这一步能做哪些操作（F1、F4）：放大要有未锁定且 < 4 级的地图；锁定要有未锁定的地图；复制总能做 */
function legalOps(maps) {
  return OPS.filter((op) => maps.some((m) => canApply(op, m)))
}

const canApply = (op, m) => (op === 'zoom' ? !m.locked && m.scale < MAX_SCALE : op === 'lock' ? !m.locked : true)

/** 把地图列表整理成目标：[{ scale, locked, want }]，按缩放等级从低到高、未锁定在前 */
export function goalsFrom(maps) {
  const counts = new Map()
  for (const m of maps) counts.set(mapKey(m.scale, m.locked), (counts.get(mapKey(m.scale, m.locked)) ?? 0) + 1)
  return [...counts.entries()]
    .map(([key, want]) => ({ ...parseMapKey(key), want }))
    .sort((a, b) => a.scale - b.scale || Number(a.locked) - Number(b.locked))
}

/** chain 题（K5）的最省用量 { paper, glass, empty } */
export function minimalPlan(start, goals) {
  const maxScale = Math.max(...goals.map((g) => g.scale))
  const lockedScales = new Set(goals.filter((g) => g.locked).map((g) => g.scale))
  const total = goals.reduce((sum, g) => sum + g.want, 0)
  return { paper: maxScale - start, glass: lockedScales.size, empty: total - 1 }
}

/**
 * 一道题的最省用量：单项题没有别的辅料可借（放大题不发空地图，不能先放大再复制），
 * 放大题每张每级 1 张纸，锁定题每张 1 块玻璃板，复制题 c−1 张空地图（K4）；chain 题见 {@link minimalPlan}
 */
export function planFor(task, start, goals) {
  if (task === 'chain') return minimalPlan(start, goals)
  const plan = { paper: 0, glass: 0, empty: 0 }
  for (const g of goals) {
    if (task === 'zoom') plan.paper += g.want * (g.scale - start)
    if (task === 'lock' && g.locked) plan.glass += g.want
  }
  if (task === 'clone') plan.empty = goals.reduce((sum, g) => sum + g.want, 0) - 1
  return plan
}

/** chain 题（K5）要用到的操作种类，如 zoom+clone */
export function kindsOf(start, goals) {
  const total = goals.reduce((sum, g) => sum + g.want, 0)
  const used = { zoom: goals.some((g) => g.scale > start), lock: goals.some((g) => g.locked), clone: total > 1 }
  return OPS.filter((op) => used[op]).join('+')
}

/** 摆放：开局那叠地图和发的辅料各占 1 格，随机格位（K4） */
function layoutOf(random, start, count, given) {
  const stacks = [
    { id: FILLED_MAP, count, map: { scale: start } },
    ...(given.paper ? [{ id: PAPER, count: given.paper }] : []),
    ...(given.glass ? [{ id: GLASS_PANE, count: given.glass }] : []),
    ...(given.empty ? [{ id: EMPTY_MAP, count: given.empty }] : [])
  ]
  const positions = shuffle(random, Array.from({ length: INVENTORY_SLOTS }, (_, i) => i)).slice(0, stacks.length)
  return stacks.map((s, i) => ({ slot: positions[i], ...s })).sort((a, b) => a.slot - b.slot)
}

/** chain 题（K5）。随机数的抽取顺序：s₀ → 步数 n → 逐步（操作种类 → 地图状态）→ 纸、玻璃板、空地图的余量 → 打乱格位 */
function sampleChain(seed, options) {
  const random = rng(seed >>> 0)
  const start = draw(random, options.scale)
  const n = draw(random, options.ops)
  const maps = [{ scale: start, locked: false }]
  const ops = []
  for (let step = 0; step < n; step++) {
    const op = pickOne(random, legalOps(maps))
    const states = [...new Set(maps.filter((m) => canApply(op, m)).map((m) => mapKey(m.scale, m.locked)))].sort()
    const from = parseMapKey(pickOne(random, states))
    const index = maps.findIndex((m) => m.scale === from.scale && m.locked === from.locked)
    if (op === 'zoom') maps[index] = { scale: from.scale + 1, locked: false }
    else if (op === 'lock') maps[index] = { scale: from.scale, locked: true }
    else maps.push({ ...from })
    ops.push({ op, from })
  }
  const goals = goalsFrom(maps)
  const plan = minimalPlan(start, goals)
  const given = {}
  for (const k of ['paper', 'glass', 'empty']) given[k] = plan[k] > 0 ? plan[k] + draw(random, options.spare) : 0
  return { task: 'chain', start, count: 1, opCount: n, ops, goals, kinds: kindsOf(start, goals), plan, given, layout: layoutOf(random, start, 1, given) }
}

/** 单项题（K4）。随机数的抽取顺序：题型（mix 时）→ s₀ → zoom：t → n → m；lock：n → m；clone：c → 余量 → 打乱格位 */
function sampleSingle(seed, options) {
  const random = rng(seed >>> 0)
  const task = options.task === 'mix' ? pickOne(random, SINGLE_TASKS) : options.task
  const start = draw(random, options.scale)
  let count = 1
  let maps
  if (task === 'zoom') {
    const t = between(random, start + 1, MAX_SCALE)
    count = draw(random, options.maps)
    const m = between(random, 1, count)
    maps = [...Array(count - m).fill({ scale: start, locked: false }), ...Array(m).fill({ scale: t, locked: false })]
  } else if (task === 'lock') {
    count = draw(random, options.maps)
    const m = between(random, 1, count)
    maps = [...Array(count - m).fill({ scale: start, locked: false }), ...Array(m).fill({ scale: start, locked: true })]
  } else {
    maps = Array(draw(random, options.copies)).fill({ scale: start, locked: false })
  }
  const goals = goalsFrom(maps)
  const plan = planFor(task, start, goals)
  const material = MATERIAL_OF[task]
  const given = { paper: 0, glass: 0, empty: 0 }
  given[material] = plan[material] + draw(random, options.spare)
  return { task, start, count, goals, plan, given, layout: layoutOf(random, start, count, given) }
}

/**
 * 出一道题（K3–K5）。同一种子同一道题。
 * @returns {{ task, start, count, goals: [{ scale, locked, want }], plan, given, layout: [{ slot, id, count, map? }], target, want,
 *   opCount?, ops?, kinds? }}（后三项只有 chain 题有）
 */
export function sampleCartography(seed, options) {
  const picked = options.task === 'chain' ? sampleChain(seed, options) : sampleSingle(seed, options)
  // 主目标（记录的 target / want）：放大题是放大后的那组，锁定题是锁定的那组（不动的那几张不算），其余取第一组
  const first = picked.task === 'zoom' ? picked.goals.find((g) => g.scale > picked.start)
    : picked.task === 'lock' ? picked.goals.find((g) => g.locked)
      : picked.goals[0]
  return { ...picked, target: mapKey(first.scale, first.locked), want: first.want }
}

/** 开局发的全部物品 id */
export function givenIds(picked) {
  return [FILLED_MAP, ...(picked.given.paper ? [PAPER] : []), ...(picked.given.glass ? [GLASS_PANE] : []), ...(picked.given.empty ? [EMPTY_MAP] : [])].sort()
}

/** mod 的到达检测（K9）：{ cartography: { goals: [{ scale, locked, count }], allowed } } */
export function cartographyExpect(picked) {
  return { cartography: { goals: picked.goals.map((g) => ({ scale: g.scale, locked: g.locked, count: g.want })), allowed: givenIds(picked) } }
}

/** K8：状态 m 还走不走得到目标 g（已锁定只能原样；未锁定可以放大到 ≥ 自己的等级，再决定锁不锁） */
const canReach = (m, g) => (m.locked ? g.locked && g.scale === m.scale : m.scale <= g.scale)

const total = (counts) => Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0)

function addCounts(...maps) {
  const out = {}
  for (const map of maps) for (const [key, n] of Object.entries(map ?? {})) out[key] = (out[key] ?? 0) + n
  return out
}

const sumWhere = (counts, test) => Object.entries(counts ?? {}).reduce((sum, [key, n]) => sum + (test(key) ? n : 0), 0)

/**
 * 判定（K8）。final 是 arena/finish（或最后一次 arena/status）的数据：held（物品栏，不含光标）、carried、tableInput、dropped、stationIntact、
 * craftedDelta，前四项按签名计数。四处合计按"物品栏 + 光标 + 输入格"算（关界面时光标和输入格都会退回物品栏）；剩多少辅料不判。
 * extra 是做错的东西（foreign 地图、开局没有的物品、走不到任何目标的地图）；unfinished 是还走得到目标、只是没做完的地图。
 * @returns {{ outcome, madeOf: {key: n} | null, extra: {key: n}, unfinished: {key: n}, copied: number|null, reached: boolean }}
 */
export function judgeCartography({ stopped, timedOut, taskState, final, picked }) {
  const none = { madeOf: null, extra: {}, unfinished: {}, copied: null, reached: false }
  if (stopped) return { outcome: 'aborted', ...none }
  if (!final?.held) return { outcome: timedOut ? 'timeout' : 'failed', ...none }
  const held = final.held
  const carried = final.carried ?? {}
  const input = final.tableInput ?? {}
  const dropped = final.dropped ?? {}
  const all = addCounts(held, carried, input)
  const goalKeys = new Set(picked.goals.map((g) => mapKey(g.scale, g.locked)))
  const allowed = new Set(givenIds(picked))
  const madeOf = Object.fromEntries(picked.goals.map((g) => [mapKey(g.scale, g.locked), all[mapKey(g.scale, g.locked)] ?? 0]))
  const extra = {}
  const unfinished = {}
  for (const [key, n] of Object.entries(all).sort(([a], [b]) => a.localeCompare(b))) {
    if (!(n > 0) || goalKeys.has(key)) continue
    const state = parseMapKey(key)
    if (state && picked.goals.some((g) => canReach(state, g))) unfinished[key] = n
    else if (state || isMapKey(key) || !allowed.has(key)) extra[key] = n
  }
  const lineage = sumWhere(all, (key) => parseMapKey(key) !== null)
  const wantTotal = picked.goals.reduce((sum, g) => sum + g.want, 0)
  // 地图守恒：已绘制地图（含 foreign）+ 空地图 = 开局张数 + 发的空地图（复制、右键新做都是 1 张空地图换 1 张已绘制地图）
  const maps = sumWhere(all, isMapKey) + (all[EMPTY_MAP] ?? 0)
  const copied = final.craftedDelta ? (final.craftedDelta[FILLED_MAP] ?? 0) : null
  const reached = picked.goals.every((g) => (held[mapKey(g.scale, g.locked)] ?? 0) === g.want && !input[mapKey(g.scale, g.locked)])
    && total(carried) === 0 && Object.keys(extra).length === 0 && Object.keys(unfinished).length === 0
  const lost = final.stationIntact === false || total(dropped) > 0 || maps < (picked.count ?? 1) + picked.given.empty
  let outcome
  if (lost) outcome = 'lost'
  else if (picked.goals.some((g) => madeOf[mapKey(g.scale, g.locked)] > g.want) || lineage > wantTotal) outcome = 'overshoot'
  else if (Object.keys(extra).length) outcome = 'mismap'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, madeOf, extra, unfinished, copied, reached }
}

export const TASK_NAMES = Object.freeze({ zoom: '放大', lock: '锁定', clone: '复制', chain: '连续操作' })
const MATERIAL_NAMES = { paper: '纸', glass: '玻璃', empty: '空图' }

/** 一个目标的文案（K7）：2 张缩放等级 1、未锁定的地图 */
const goalText = (g) => `${g.want} 张缩放等级 ${g.scale}、${g.locked ? '已锁定' : '未锁定'}的地图`
/** 一个目标的简写（label）：2×s1、1×s0锁定 */
const goalLabel = (g) => `${g.want}×s${g.scale}${g.locked ? '锁定' : ''}`
const rangeText = ({ lo, hi }) => (lo === hi ? String(lo) : `${lo}-${hi}`)
const spareText = (picked) => ['paper', 'glass', 'empty']
  .filter((k) => picked.task === 'chain' || picked.given[k] > 0)
  .map((k) => `${MATERIAL_NAMES[k]}${picked.given[k] ? picked.given[k] - picked.plan[k] : 0}`).join('/')

export const cartography = {
  type: 'cartography',
  options: ['task', 'scale', 'maps', 'copies', 'ops', 'spare'],

  setup(trainer, arena, arenaConfig, args) {
    return { arena, arenaConfig, options: cartographyOptions(args, arenaConfig) }
  },

  startText(ctx) {
    const o = ctx.options
    return o.task === 'chain'
      ? `task=chain，scale=${rangeText(o.scale)}，ops=${rangeText(o.ops)}，spare=${rangeText(o.spare)}`
      : `task=${o.task}，scale=${rangeText(o.scale)}，maps=${rangeText(o.maps)}，copies=${rangeText(o.copies)}，spare=${rangeText(o.spare)}`
  },

  batchFields() {
    return {}
  },

  sample(ctx, seed) {
    return sampleCartography(seed, ctx.options)
  },

  label(ctx, picked, seed) {
    const goals = picked.goals.map(goalLabel).join('、')
    if (picked.task === 'chain') return `chain s${picked.start} → ${goals}（${picked.kinds}，余量 ${spareText(picked)}，seed=${seed}）`
    return `${TASK_NAMES[picked.task]} ${picked.count}×s${picked.start} → ${goals}（余量 ${spareText(picked)}，seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      task: picked.task,
      source: { scale: picked.start, count: picked.count, mapId: null, center: null },
      target: picked.target, want: picked.want,
      goals: picked.goals.map((g) => ({ ...g, made: null })),
      plan: picked.plan, given: picked.given, used: null, layout: picked.layout,
      ...(picked.task === 'chain' ? { opCount: picked.opCount, ops: picked.ops, kinds: picked.kinds } : {}),
      final: null, made: null, extra: {}, unfinished: {}, copied: null, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return { station: 'cartography', items: picked.layout, seed, watch: [FILLED_MAP], expect: cartographyExpect(picked), dayTime: 1000 }
  },

  afterPrepare(ctx, picked, data) {
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the cartography table (aimOk=${data?.aimOk}); check the arena origin`, fields: {} }
    if (!data?.map) return { error: 'arena/prepare: no source map in the result (is the mod up to date?)', fields: {} }
    return { fields: { source: { scale: data.map.scale, count: picked.count, mapId: data.map.id, center: data.map.center } } }
  },

  instruction(ctx, picked, prompts) {
    // K7：只说现状和要求；不提辅料各有什么用、操作顺序，也不说考的是哪种操作
    return renderTemplate(prompts.training.cartography, {
      maps: picked.count === 1 ? '一张地图' : `${picked.count} 张相同的地图`,
      it: picked.count === 1 ? '它' : '它们',
      scale: String(picked.start),
      list: picked.goals.map(goalText).join('，')
    })
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0 }) {
    const { outcome, madeOf, extra, unfinished, copied, reached } = judgeCartography({ stopped, timedOut, taskState, final, picked })
    const reachedAtMs = final?.reachedAtMs ?? null
    const left = final ? addCounts(final.held, final.carried, final.tableInput, final.dropped) : null
    const used = left ? {
      paper: picked.given.paper - (left[PAPER] ?? 0),
      glass: picked.given.glass - (left[GLASS_PANE] ?? 0),
      empty: picked.given.empty - (left[EMPTY_MAP] ?? 0)
    } : null
    return {
      outcome, made: madeOf ? madeOf[picked.target] : null, extra, unfinished, copied, reached, used,
      goals: picked.goals.map((g) => ({ ...g, made: madeOf ? madeOf[mapKey(g.scale, g.locked)] : null })),
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final ? { inventory: final.held ?? null, carried: final.carried ?? null, tableInput: final.tableInput ?? null, dropped: final.dropped ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { task: record.task, ...(record.task === 'chain' ? { opCount: record.opCount } : {}), copied: record.copied ?? null }
  }
}
