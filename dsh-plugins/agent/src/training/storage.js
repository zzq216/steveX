import { renderTemplate } from '../llm/prompts.js'
import { rng } from './sampler.js'

/**
 * 存取题型（docs/箱子训练场设计方案.md）：正前方一个容器（小箱子、大箱子；§8 起还有漏斗、发射器），在容器和物品栏之间搬指定数量的指定物品。
 *
 * - 取（take）：东西在箱子里，搬进物品栏；放（put）：东西在物品栏里，搬进箱子（C1–C6）
 * - 来源方占 [types, ⌊容量/2⌋] 格；目标物品 T 和 types−1 种干扰物品，每格数量在 [1, 堆叠上限] 里均匀随机（C4、C5）；
 *   fill=full 时每格都取满堆叠上限（练整组搬运）
 * - 要求 k 个由 rel 生成：lt → [1, n−1]，eq → n，gt → [n+1, ⌊容量/2⌋ × T 的堆叠上限]；应搬 want = min(k, n)
 * - 目标方开局为空（C6 方案 A；dest=partial 暂不开放）
 * - 容量规则（§8 C17）：种类数 ≤ 一半 − 目标最少格数 + 1；放进题目标物品最多占容器的格数，保证要求全部放入时装得下。
 *   这两条在小箱子、大箱子上都不会起作用，同种子出题不变
 * - 判定按任务结束时两边的计数（C8）：lost → overshoot → disturbed → timeout → success / false_success / failed
 * - reachedMs 由 mod 在 tick 里检测"恰好达到目标计数"的第一刻（C9），不打断 agent
 * - 多目标（§9）：targets=k|a-b 每轮搬几种目标物品；各自按 stack 挑档、按 rel 定 k；types 含全部目标；
 *   放进题全部目标合计不超过容器格数；无解时降低目标数。targets=1 时出题、文案与加选项前一样
 */

export const INVENTORY_SLOTS = 36
export const CHEST_SLOTS = { small: 27, large: 54, hopper: 5, dispenser: 9 }
/** 本轮容器 → mod 的工作站名 */
export const STATION_OF = { small: 'chest', large: 'large_chest', hopper: 'hopper', dispenser: 'dispenser' }
/** types 的上限：来源方最少 13 格（小箱子的一半），留出余量 */
export const MAX_TYPES = 9
export const STACK_CLASSES = [64, 16, 1]

export const STORAGE_CHOICES = Object.freeze({
  kind: ['take', 'put', 'mix'],
  rel: ['lt', 'eq', 'gt', 'mix'],
  chest: ['small', 'large', 'hopper', 'dispenser', 'mix', 'all'],
  stack: ['64', '16', '1', 'mix'],
  fill: ['random', 'full', 'mix']
})

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))

/** targets 的上限（§9 C21）：再多就主要在考记忆列表了 */
export const MAX_TARGETS = 4

export function parseRangeSpec(name, max, text) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(text))
  const lo = match ? Number(match[1]) : NaN
  const hi = match ? Number(match[2] ?? match[1]) : NaN
  if (!(lo >= 1 && hi <= max && lo <= hi)) throw new Error(`${name} 要写 k 或 a-b（1–${max}，a ≤ b），收到 "${text}"`)
  return { lo, hi }
}

/** "3" / "1-4" → { lo, hi }，在 [1, MAX_TYPES] 里；不合法抛错 */
export function parseTypesSpec(text) {
  return parseRangeSpec('types', MAX_TYPES, text)
}

/** 每轮要搬几种目标物品（§9 C21）："2" / "1-3" → { lo, hi }，在 [1, MAX_TARGETS] 里；不合法抛错 */
export function parseTargetsSpec(text) {
  return parseRangeSpec('targets', MAX_TARGETS, text)
}

const fullId = (id) => (id.includes(':') ? id : `minecraft:${id}`)

/** 物品池：item-props.json 里的全部物品，去掉 exclude（缺省排除收纳袋，箱子方案 S9），按 id 排序（种子可复现） */
export function storagePool(props, exclude = []) {
  const skip = new Set(exclude.map(fullId))
  return Object.keys(props).filter((id) => !skip.has(id)).sort()
}

/** 按 id 合计数量（只列有的） */
export function countsOf(stacks) {
  const out = {}
  for (const { id, count } of stacks) out[id] = (out[id] ?? 0) + count
  return out
}

function shuffle(random, list) {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * 出一道题（C3–C6）。同一种子同一道题。
 * @param {string[]} pool   storagePool()
 * @param {object} props    item-props.json 的 items（id → { maxStack }）
 * @param {number} seed
 * @param {{ kind, rel, chest, stack, fill, types: {lo,hi}, targets: {lo,hi}, item }} options  kind/rel/chest/stack/fill 可为 'mix'；fill 缺省 random；
 *   chest=mix 只在小箱子、大箱子之间抽（旧种子不变），chest=all 在四种容器之间抽；targets 缺省 1
 * @returns {{ kind, chest, chestSlots, rel, fill, target, stackClass, n, k, want, types, distractors, targetCount, targets, askOrder, layout: { chest, inventory } }}
 *   target / stackClass / n / k / want / rel 是第一个目标的（旧记录、旧报告照常能读）；targets 是全部目标
 *   [{ id, stackClass, n, k, want, rel }]（第一个就是 target）；askOrder 是文案里列出目标的顺序（id 列表）
 *
 * 多目标（§9 C21–C23）：targets=1 时不多用随机数，和加这个选项之前同种子同题。
 */
export function sampleStorage(pool, props, seed, { kind = 'mix', rel = 'mix', chest = 'mix', stack = 'mix', fill = 'random', types = { lo: 1, hi: 4 }, targets = { lo: 1, hi: 1 }, item = null } = {}) {
  const random = rng(seed)
  const maxStack = (id) => {
    const p = props[id]
    if (!p) throw new Error(`data/item-props.json 里没有 ${id}`)
    return p.maxStack
  }
  const task = kind === 'mix' ? pickOne(random, ['take', 'put']) : kind
  const size = chest === 'mix' ? pickOne(random, ['small', 'large']) : chest === 'all' ? pickOne(random, ['small', 'large', 'hopper', 'dispenser']) : chest
  const relation = rel === 'mix' ? pickOne(random, ['lt', 'eq', 'gt']) : rel
  // fill 只在 mix 时消耗随机数：fill=random 的题和加这个选项之前同种子同题
  const filling = fill === 'mix' ? pickOne(random, ['random', 'full']) : fill
  // 目标数只在写成范围时才抽（§9 C21）
  let targetCount = targets.lo === targets.hi ? targets.lo : between(random, targets.lo, targets.hi)
  const chestSlots = CHEST_SLOTS[size]
  const capacity = task === 'take' ? chestSlots : INVENTORY_SLOTS
  const half = Math.floor(capacity / 2)

  const pickTarget = (taken) => {
    const cls = stack === 'mix' ? pickOne(random, STACK_CLASSES) : Number(stack)
    let choices = pool.filter((id) => maxStack(id) === cls && !taken.includes(id))
    // stack=mix 时这一档被前面的目标用光了（物品池很小时才会发生）→ 在还有物品的档里挑
    if (!choices.length && stack === 'mix' && taken.length) {
      const left = STACK_CLASSES.filter((c) => pool.some((id) => maxStack(id) === c && !taken.includes(id)))
      if (left.length) {
        const c = pickOne(random, left)
        choices = pool.filter((id) => maxStack(id) === c && !taken.includes(id))
      }
    }
    if (!choices.length) throw new Error(`物品池里没有堆叠上限为 ${cls} 的物品${taken.length ? '（除去已选的目标）' : ''}`)
    return pickOne(random, choices)
  }
  let target
  if (item) {
    target = fullId(item)
    maxStack(target)
  } else {
    target = pickTarget([])
  }
  // 其余目标（§9 C22）：各自按 stack 挑堆叠档、各自按 rel 定关系
  const goals = [{ id: target, rel: relation }]
  while (goals.length < targetCount) {
    const id = pickTarget(goals.map((g) => g.id))
    goals.push({ id, rel: rel === 'mix' ? pickOne(random, ['lt', 'eq', 'gt']) : rel })
  }

  // lt 而目标不可堆叠时这个目标至少 2 格（n ≥ 2 才有 k < n）
  const minOf = (g) => (g.rel === 'lt' && maxStack(g.id) === 1 ? 2 : 1)
  // 放进题：全部目标合计最多占容器的格数，要求全部放入时装得下（§8 C17、§9 C23）
  const targetCap = task === 'put' ? chestSlots : capacity
  const minSum = () => goals.reduce((sum, g) => sum + minOf(g), 0)
  // 约束无解（如漏斗取物要 3 种目标）→ 目标数降到能出题的最大值，记录里写实际目标数（C23）
  while (goals.length > 1 && (minSum() > half || minSum() > targetCap)) goals.pop()
  targetCount = goals.length
  const minTargets = goals.map(minOf)

  // 种类数（含全部目标）：每种至少 1 格，合起来不超过一半（§8 C17）；比目标数少时抬到目标数（§9 C22）
  const typeCap = half - (minSum() - targetCount)
  const typeCount = between(random, Math.min(Math.max(types.lo, targetCount), typeCap), Math.min(Math.max(types.hi, targetCount), typeCap))
  const goalIds = goals.map((g) => g.id)
  const others = pool.filter((id) => !goalIds.includes(id))
  if (others.length < typeCount - targetCount) throw new Error(`物品池里不够 ${typeCount - targetCount} 种干扰物品`)
  const distractors = []
  while (distractors.length < typeCount - targetCount) {
    const id = pickOne(random, others)
    if (!distractors.includes(id)) distractors.push(id)
  }

  // 占用格数 s
  const spare = typeCount - targetCount
  const floor = spare + minSum()
  const slotsUsed = between(random, floor, Math.min(half, spare + targetCap))
  const ids = [...goalIds, ...distractors]
  const slotsOf = ids.map((_, i) => (i < targetCount ? minTargets[i] : 1))
  const targetSlots = () => slotsOf.slice(0, targetCount).reduce((sum, s) => sum + s, 0)
  for (let extra = slotsUsed - floor; extra > 0; extra--) {
    let i = Math.floor(random() * ids.length)
    // 目标合计已满上限就改分给干扰物品（只有上限真起作用时才多用一次随机数）
    if (i < targetCount && targetSlots() >= targetCap) i = targetCount + Math.floor(random() * (ids.length - targetCount))
    slotsOf[i]++
  }

  const stacks = []
  ids.forEach((id, i) => {
    for (let j = 0; j < slotsOf[i]; j++) stacks.push({ id, count: filling === 'full' ? maxStack(id) : between(random, 1, maxStack(id)) })
  })
  // lt 要 n ≥ 2：目标只有 1 格且只有 1 个时，把这一格重抽到 [2, 上限]
  const countOf = (id) => stacks.filter((s) => s.id === id).reduce((sum, s) => sum + s.count, 0)
  for (const g of goals) {
    g.n = countOf(g.id)
    if (g.rel === 'lt' && g.n < 2) {
      const first = stacks.find((s) => s.id === g.id)
      first.count = between(random, 2, maxStack(g.id))
      g.n = first.count
    }
  }

  const positions = shuffle(random, Array.from({ length: capacity }, (_, i) => i)).slice(0, stacks.length)
  const source = stacks.map((s, i) => ({ slot: positions[i], id: s.id, count: s.count })).sort((a, b) => a.slot - b.slot)

  for (const g of goals) {
    if (g.rel === 'lt') g.k = between(random, 1, g.n - 1)
    else if (g.rel === 'eq') g.k = g.n
    else g.k = between(random, g.n + 1, Math.max(half * maxStack(g.id), g.n + 1))
  }
  // 文案里列目标的顺序随机，不按格位排（C24）；只有一个目标时不多用随机数
  const askOrder = targetCount > 1 ? shuffle(random, goalIds) : goalIds

  const list = goals.map((g) => ({ id: g.id, stackClass: maxStack(g.id), n: g.n, k: g.k, want: Math.min(g.k, g.n), rel: g.rel }))
  const [first] = list
  return {
    kind: task, chest: size, chestSlots, rel: first.rel, fill: filling, target: first.id, stackClass: first.stackClass, n: first.n, k: first.k, want: first.want,
    types: typeCount, distractors, targetCount, targets: list, askOrder,
    layout: { chest: task === 'take' ? source : [], inventory: task === 'put' ? source : [] }
  }
}

/** 本轮的目标列表；旧记录（没有 targets）当成只有一个目标 */
export function targetsOf(picked) {
  return picked.targets ?? [{ id: picked.target, stackClass: picked.stackClass, n: picked.n, k: picked.k, want: picked.want, rel: picked.rel }]
}

const dropZeros = (counts) => Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0))

/** 恰好搬完之后两边应有的计数（mod 的 expect 用它判断"到达"，C9） */
export function expectedCounts(picked) {
  const inventory = countsOf(picked.layout.inventory)
  const container = countsOf(picked.layout.chest)
  const [from, to] = picked.kind === 'take' ? [container, inventory] : [inventory, container]
  for (const t of targetsOf(picked)) {
    from[t.id] = (from[t.id] ?? 0) - t.want
    to[t.id] = (to[t.id] ?? 0) + t.want
  }
  return { inventory: dropZeros(inventory), container: dropZeros(container) }
}

const total = (counts) => Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0)

function sameCounts(a, b) {
  const x = dropZeros(a ?? {})
  const y = dropZeros(b ?? {})
  const keys = new Set([...Object.keys(x), ...Object.keys(y)])
  for (const key of keys) if (x[key] !== y[key]) return false
  return true
}

/**
 * 判定（C8）。final 是 arena/finish（或最后一次 arena/status）的数据：held（物品栏，不含光标）、chest、carried、dropped、stationIntact。
 * 顺序：aborted → lost → overshoot → disturbed → timeout → success / false_success / failed。
 * 多目标（§9 C25）：任一目标搬多了 → overshoot；目标以外的物品变了 → disturbed；只做完一部分就交差 → false_success。
 * @returns {{ outcome, moved, movedOf: {id: n} | null, disturbed: string[], reached: boolean }}  moved 是第一个目标的
 */
export function judgeStorage({ stopped, timedOut, taskState, final, picked }) {
  const none = { moved: null, movedOf: null, disturbed: [], reached: false }
  if (stopped) return { outcome: 'aborted', ...none }
  if (!final?.held) return { outcome: timedOut ? 'timeout' : 'failed', ...none }
  const inv0 = countsOf(picked.layout.inventory)
  const chest0 = countsOf(picked.layout.chest)
  const held = final.held
  const chest = final.chest ?? {}
  const carried = final.carried ?? {}
  const dst = picked.kind === 'take' ? held : chest
  const dst0 = picked.kind === 'take' ? inv0 : chest0
  const goals = targetsOf(picked)
  const movedOf = Object.fromEntries(goals.map((t) => [t.id, (dst[t.id] ?? 0) - (dst0[t.id] ?? 0)]))
  const moved = movedOf[picked.target]
  const goalIds = new Set(goals.map((t) => t.id))
  const ids = new Set([...Object.keys(inv0), ...Object.keys(chest0), ...Object.keys(held), ...Object.keys(chest), ...Object.keys(carried)])
  const disturbed = [...ids].filter((id) => !goalIds.has(id) && ((held[id] ?? 0) !== (inv0[id] ?? 0) || (chest[id] ?? 0) !== (chest0[id] ?? 0))).sort()
  const expect = expectedCounts(picked)
  const reached = sameCounts(held, expect.inventory) && sameCounts(chest, expect.container) && total(carried) === 0
  const lost = final.stationIntact === false || final.chest === null || final.chest === undefined || total(final.dropped) > 0 ||
    total(held) + total(chest) + total(carried) < total(inv0) + total(chest0)
  let outcome
  if (lost) outcome = 'lost'
  else if (goals.some((t) => movedOf[t.id] > t.want)) outcome = 'overshoot'
  else if (disturbed.length) outcome = 'disturbed'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, moved, movedOf, disturbed, reached }
}

const KIND_TEXT = { take: '取', put: '放' }
const CHEST_TEXT = { small: '小箱子', large: '大箱子', hopper: '漏斗', dispenser: '发射器' }
/** 文案里的容器名（C18）：大小箱子都叫箱子 */
const CONTAINER_TEXT = { small: '箱子', large: '箱子', hopper: '漏斗', dispenser: '发射器' }

export const storage = {
  type: 'storage',
  options: ['item', 'kind', 'rel', 'chest', 'stack', 'fill', 'types', 'targets'],

  setup(trainer, arena, arenaConfig, args) {
    const props = trainer.itemProps()
    if (!props) throw new Error(`箱子题需要 ${trainer.config.itemProps}（在 dsh-plugins/agent 里运行 npm run extract-item-props）`)
    const pick = (key) => args[key] ?? arenaConfig[key] ?? 'mix'
    const options = { kind: pick('kind'), rel: pick('rel'), chest: pick('chest'), stack: String(pick('stack')), fill: args.fill ?? arenaConfig.fill ?? 'random', types: parseTypesSpec(args.types ?? arenaConfig.types ?? '1-4'), targets: parseTargetsSpec(args.targets ?? arenaConfig.targets ?? '1'), item: args.item ?? null }
    for (const [key, choices] of Object.entries(STORAGE_CHOICES)) {
      if (!choices.includes(options[key])) throw new Error(`${key} 只能是 ${choices.join(' / ')}，收到 "${options[key]}"`)
    }
    // types 含全部目标（§9 C22）：抽到的种类数少于目标数时会自动抬高，但上限比目标数下限还小就是配错了
    if (options.types.hi < options.targets.lo) throw new Error(`types（${options.types.lo}-${options.types.hi}）含全部目标，上限不能小于 targets 的下限 ${options.targets.lo}`)
    if ((arenaConfig.dest ?? 'empty') !== 'empty') throw new Error('dest=partial 暂不开放（箱子训练场设计方案 C6）')
    const pool = storagePool(props, arenaConfig.exclude ?? [])
    if (options.item && !pool.includes(fullId(options.item))) throw new Error(`物品池里没有 ${fullId(options.item)}（不在 item-props.json 里，或被 exclude 排除）`)
    const ctx = { arena, arenaConfig, props, pool, options }
    sampleStorage(pool, props, 0, options) // 选项组合出不了题就当场报错
    return ctx
  },

  startText(ctx) {
    const o = ctx.options
    return `${o.item ? `目标 ${fullId(o.item)}，` : ''}kind=${o.kind}，rel=${o.rel}，chest=${o.chest}，stack=${o.item ? '随目标' : o.stack}，fill=${o.fill}，types=${o.types.lo === o.types.hi ? o.types.lo : `${o.types.lo}-${o.types.hi}`}${o.targets.hi > 1 ? `，targets=${o.targets.lo === o.targets.hi ? o.targets.lo : `${o.targets.lo}-${o.targets.hi}`}` : ''}`
  },

  batchFields() {
    return {}
  },

  sample(ctx, seed) {
    return sampleStorage(ctx.pool, ctx.props, seed, ctx.options)
  },

  label(ctx, picked, seed) {
    const where = picked.kind === 'take' ? `${CONTAINER_TEXT[picked.chest]}里` : '物品栏里'
    const tail = `${CHEST_TEXT[picked.chest]}，${picked.types} 种物品${picked.fill === 'full' ? '，每格满' : ''}，seed=${seed}`
    if ((picked.targetCount ?? 1) === 1) return `${KIND_TEXT[picked.kind]} ${picked.k} 个 ${picked.target}（${where}有 ${picked.n} 个，${picked.rel}，${tail}）`
    // 多目标（C26）：列出全部目标，各自的实有数量与关系
    const goals = targetsOf(picked).map((t) => `${t.k} 个 ${t.id}（有 ${t.n}，${t.rel}）`).join('、')
    return `${KIND_TEXT[picked.kind]} ${goals}（${where}，${picked.targetCount} 种目标，${tail}）`
  },

  record(ctx, picked) {
    return {
      kind: picked.kind, rel: picked.rel, chest: picked.chest, fill: picked.fill, chestSlots: null, stackClass: picked.stackClass,
      target: picked.target, n: picked.n, k: picked.k, want: picked.want, types: picked.types, distractors: picked.distractors,
      targetCount: picked.targetCount ?? 1, targets: targetsOf(picked).map((t) => ({ ...t, moved: null })),
      layout: picked.layout, final: null, moved: null, disturbed: [], reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return {
      station: STATION_OF[picked.chest],
      items: picked.layout.inventory, chestItems: picked.layout.chest,
      seed, watch: [], expect: expectedCounts(picked), dayTime: 1000
    }
  },

  afterPrepare(ctx, picked, data) {
    const fields = { chestSlots: data?.chestSlots ?? null }
    const station = STATION_OF[picked.chest]
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the ${station} (aimOk=${data?.aimOk}); check the arena origin`, fields }
    // 大箱子没连上时容量是 27（C2 自检）；漏斗 5、发射器 9
    if (data?.chestSlots !== picked.chestSlots) return { error: `arena/prepare: the ${station} has ${data?.chestSlots} slots, expected ${picked.chestSlots}`, fields }
    return { fields }
  },

  instruction(ctx, picked, prompts) {
    const container = CONTAINER_TEXT[picked.chest]
    if ((picked.targetCount ?? 1) === 1) return renderTemplate(prompts.training[`chest_${picked.kind}`], { target: picked.target, k: picked.k, container })
    // 多目标（C24）：按 askOrder 逐项列出要求，不提示怎么做
    const byId = Object.fromEntries(targetsOf(picked).map((t) => [t.id, t]))
    const list = (picked.askOrder ?? Object.keys(byId)).map((id) => `${byId[id].k} 个 ${id}`).join('、')
    return renderTemplate(prompts.training[`chest_${picked.kind}_multi`], { list, container })
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0 }) {
    const { outcome, moved, movedOf, disturbed, reached } = judgeStorage({ stopped, timedOut, taskState, final, picked })
    const reachedAtMs = final?.reachedAtMs ?? null
    return {
      outcome, moved, disturbed, reached,
      targets: targetsOf(picked).map((t) => ({ ...t, moved: movedOf ? movedOf[t.id] : null })),
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final ? { inventory: final.held ?? null, chest: final.chest ?? null, carried: final.carried ?? null, dropped: final.dropped ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { kind: record.kind, rel: record.rel, n: record.n, k: record.k, ...((record.targetCount ?? 1) > 1 ? { targetCount: record.targetCount } : {}) }
  }
}
