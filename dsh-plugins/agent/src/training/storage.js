import { renderTemplate } from '../llm/prompts.js'
import { rng } from './sampler.js'

/**
 * 存取题型（docs/箱子训练场设计方案.md）：正前方一个小箱子或大箱子，在箱子和物品栏之间搬指定数量的指定物品。
 *
 * - 取（take）：东西在箱子里，搬进物品栏；放（put）：东西在物品栏里，搬进箱子（C1–C6）
 * - 来源方占 [types, ⌊容量/2⌋] 格；目标物品 T 和 types−1 种干扰物品，每格数量在 [1, 堆叠上限] 里均匀随机（C4、C5）
 * - 要求 k 个由 rel 生成：lt → [1, n−1]，eq → n，gt → [n+1, ⌊容量/2⌋ × T 的堆叠上限]；应搬 want = min(k, n)
 * - 目标方开局为空（C6 方案 A；dest=partial 暂不开放）
 * - 判定按任务结束时两边的计数（C8）：lost → overshoot → disturbed → timeout → success / false_success / failed
 * - reachedMs 由 mod 在 tick 里检测"恰好达到目标计数"的第一刻（C9），不打断 agent
 */

export const INVENTORY_SLOTS = 36
export const CHEST_SLOTS = { small: 27, large: 54 }
/** types 的上限：来源方最少 13 格（小箱子的一半），留出余量 */
export const MAX_TYPES = 9
export const STACK_CLASSES = [64, 16, 1]

export const STORAGE_CHOICES = Object.freeze({
  kind: ['take', 'put', 'mix'],
  rel: ['lt', 'eq', 'gt', 'mix'],
  chest: ['small', 'large', 'mix'],
  stack: ['64', '16', '1', 'mix']
})

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))

/** "3" / "1-4" → { lo, hi }，在 [1, MAX_TYPES] 里；不合法抛错 */
export function parseTypesSpec(text) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(text))
  const lo = match ? Number(match[1]) : NaN
  const hi = match ? Number(match[2] ?? match[1]) : NaN
  if (!(lo >= 1 && hi <= MAX_TYPES && lo <= hi)) throw new Error(`types 要写 k 或 a-b（1–${MAX_TYPES}，a ≤ b），收到 "${text}"`)
  return { lo, hi }
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
 * @param {{ kind, rel, chest, stack, types: {lo,hi}, item }} options  kind/rel/chest/stack 可为 'mix'
 * @returns {{ kind, chest, chestSlots, rel, target, stackClass, n, k, want, types, distractors, layout: { chest, inventory } }}
 */
export function sampleStorage(pool, props, seed, { kind = 'mix', rel = 'mix', chest = 'mix', stack = 'mix', types = { lo: 1, hi: 4 }, item = null } = {}) {
  const random = rng(seed)
  const maxStack = (id) => {
    const p = props[id]
    if (!p) throw new Error(`data/item-props.json 里没有 ${id}`)
    return p.maxStack
  }
  const task = kind === 'mix' ? pickOne(random, ['take', 'put']) : kind
  const size = chest === 'mix' ? pickOne(random, ['small', 'large']) : chest
  const relation = rel === 'mix' ? pickOne(random, ['lt', 'eq', 'gt']) : rel
  const chestSlots = CHEST_SLOTS[size]
  const capacity = task === 'take' ? chestSlots : INVENTORY_SLOTS
  const half = Math.floor(capacity / 2)

  let target
  if (item) {
    target = fullId(item)
    maxStack(target)
  } else {
    const cls = stack === 'mix' ? pickOne(random, STACK_CLASSES) : Number(stack)
    const choices = pool.filter((id) => maxStack(id) === cls)
    if (!choices.length) throw new Error(`物品池里没有堆叠上限为 ${cls} 的物品`)
    target = pickOne(random, choices)
  }

  // 种类数（含目标物品）：每种至少 1 格
  const typeCount = between(random, Math.min(types.lo, half), Math.min(types.hi, half))
  const others = pool.filter((id) => id !== target)
  if (others.length < typeCount - 1) throw new Error(`物品池里不够 ${typeCount - 1} 种干扰物品`)
  const distractors = []
  while (distractors.length < typeCount - 1) {
    const id = pickOne(random, others)
    if (!distractors.includes(id)) distractors.push(id)
  }

  // 占用格数 s：lt 而目标不可堆叠时目标至少 2 格（n ≥ 2 才有 k < n）
  const minTarget = relation === 'lt' && maxStack(target) === 1 ? 2 : 1
  const floor = typeCount - 1 + minTarget
  const slotsUsed = between(random, floor, half)
  const ids = [target, ...distractors]
  const slotsOf = ids.map((_, i) => (i === 0 ? minTarget : 1))
  for (let extra = slotsUsed - floor; extra > 0; extra--) slotsOf[Math.floor(random() * ids.length)]++

  const stacks = []
  ids.forEach((id, i) => {
    for (let j = 0; j < slotsOf[i]; j++) stacks.push({ id, count: between(random, 1, maxStack(id)) })
  })
  // lt 要 n ≥ 2：目标只有 1 格且只有 1 个时，把这一格重抽到 [2, 上限]
  let n = stacks.filter((s) => s.id === target).reduce((sum, s) => sum + s.count, 0)
  if (relation === 'lt' && n < 2) {
    const first = stacks.find((s) => s.id === target)
    first.count = between(random, 2, maxStack(target))
    n = first.count
  }

  const positions = shuffle(random, Array.from({ length: capacity }, (_, i) => i)).slice(0, stacks.length)
  const source = stacks.map((s, i) => ({ slot: positions[i], id: s.id, count: s.count })).sort((a, b) => a.slot - b.slot)

  let k
  if (relation === 'lt') k = between(random, 1, n - 1)
  else if (relation === 'eq') k = n
  else k = between(random, n + 1, Math.max(half * maxStack(target), n + 1))

  return {
    kind: task, chest: size, chestSlots, rel: relation, target, stackClass: maxStack(target), n, k, want: Math.min(k, n),
    types: typeCount, distractors,
    layout: { chest: task === 'take' ? source : [], inventory: task === 'put' ? source : [] }
  }
}

const dropZeros = (counts) => Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0))

/** 恰好搬完之后两边应有的计数（mod 的 expect 用它判断"到达"，C9） */
export function expectedCounts(picked) {
  const inventory = countsOf(picked.layout.inventory)
  const container = countsOf(picked.layout.chest)
  const [from, to] = picked.kind === 'take' ? [container, inventory] : [inventory, container]
  from[picked.target] = (from[picked.target] ?? 0) - picked.want
  to[picked.target] = (to[picked.target] ?? 0) + picked.want
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
 * @returns {{ outcome, moved, disturbed: string[], reached: boolean }}
 */
export function judgeStorage({ stopped, timedOut, taskState, final, picked }) {
  const none = { moved: null, disturbed: [], reached: false }
  if (stopped) return { outcome: 'aborted', ...none }
  if (!final?.held) return { outcome: timedOut ? 'timeout' : 'failed', ...none }
  const inv0 = countsOf(picked.layout.inventory)
  const chest0 = countsOf(picked.layout.chest)
  const held = final.held
  const chest = final.chest ?? {}
  const carried = final.carried ?? {}
  const dst = picked.kind === 'take' ? held : chest
  const dst0 = picked.kind === 'take' ? inv0 : chest0
  const moved = (dst[picked.target] ?? 0) - (dst0[picked.target] ?? 0)
  const ids = new Set([...Object.keys(inv0), ...Object.keys(chest0), ...Object.keys(held), ...Object.keys(chest), ...Object.keys(carried)])
  const disturbed = [...ids].filter((id) => id !== picked.target && ((held[id] ?? 0) !== (inv0[id] ?? 0) || (chest[id] ?? 0) !== (chest0[id] ?? 0))).sort()
  const expect = expectedCounts(picked)
  const reached = sameCounts(held, expect.inventory) && sameCounts(chest, expect.container) && total(carried) === 0
  const lost = final.stationIntact === false || final.chest === null || final.chest === undefined || total(final.dropped) > 0 ||
    total(held) + total(chest) + total(carried) < total(inv0) + total(chest0)
  let outcome
  if (lost) outcome = 'lost'
  else if (moved > picked.want) outcome = 'overshoot'
  else if (disturbed.length) outcome = 'disturbed'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, moved, disturbed, reached }
}

const KIND_TEXT = { take: '取', put: '放' }
const CHEST_TEXT = { small: '小箱子', large: '大箱子' }

export const storage = {
  type: 'storage',
  options: ['item', 'kind', 'rel', 'chest', 'stack', 'types'],

  setup(trainer, arena, arenaConfig, args) {
    const props = trainer.itemProps()
    if (!props) throw new Error(`箱子题需要 ${trainer.config.itemProps}（在 dsh-plugins/agent 里运行 npm run extract-item-props）`)
    const pick = (key) => args[key] ?? arenaConfig[key] ?? 'mix'
    const options = { kind: pick('kind'), rel: pick('rel'), chest: pick('chest'), stack: String(pick('stack')), types: parseTypesSpec(args.types ?? arenaConfig.types ?? '1-4'), item: args.item ?? null }
    for (const [key, choices] of Object.entries(STORAGE_CHOICES)) {
      if (!choices.includes(options[key])) throw new Error(`${key} 只能是 ${choices.join(' / ')}，收到 "${options[key]}"`)
    }
    if ((arenaConfig.dest ?? 'empty') !== 'empty') throw new Error('dest=partial 暂不开放（箱子训练场设计方案 C6）')
    const pool = storagePool(props, arenaConfig.exclude ?? [])
    if (options.item && !pool.includes(fullId(options.item))) throw new Error(`物品池里没有 ${fullId(options.item)}（不在 item-props.json 里，或被 exclude 排除）`)
    const ctx = { arena, arenaConfig, props, pool, options }
    sampleStorage(pool, props, 0, options) // 选项组合出不了题就当场报错
    return ctx
  },

  startText(ctx) {
    const o = ctx.options
    return `${o.item ? `目标 ${fullId(o.item)}，` : ''}kind=${o.kind}，rel=${o.rel}，chest=${o.chest}，stack=${o.item ? '随目标' : o.stack}，types=${o.types.lo === o.types.hi ? o.types.lo : `${o.types.lo}-${o.types.hi}`}`
  },

  batchFields() {
    return {}
  },

  sample(ctx, seed) {
    return sampleStorage(ctx.pool, ctx.props, seed, ctx.options)
  },

  label(ctx, picked, seed) {
    const where = picked.kind === 'take' ? '箱子里' : '物品栏里'
    return `${KIND_TEXT[picked.kind]} ${picked.k} 个 ${picked.target}（${where}有 ${picked.n} 个，${picked.rel}，${CHEST_TEXT[picked.chest]}，${picked.types} 种物品，seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      kind: picked.kind, rel: picked.rel, chest: picked.chest, chestSlots: null, stackClass: picked.stackClass,
      target: picked.target, n: picked.n, k: picked.k, want: picked.want, types: picked.types, distractors: picked.distractors,
      layout: picked.layout, final: null, moved: null, disturbed: [], reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return {
      station: picked.chest === 'large' ? 'large_chest' : 'chest',
      items: picked.layout.inventory, chestItems: picked.layout.chest,
      seed, watch: [], expect: expectedCounts(picked), dayTime: 1000
    }
  },

  afterPrepare(ctx, picked, data) {
    const fields = { chestSlots: data?.chestSlots ?? null }
    const station = picked.chest === 'large' ? 'large_chest' : 'chest'
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the ${station} (aimOk=${data?.aimOk}); check the arena origin`, fields }
    // 大箱子没连上时容量是 27（C2 自检）
    if (data?.chestSlots !== picked.chestSlots) return { error: `arena/prepare: the ${station} has ${data?.chestSlots} slots, expected ${picked.chestSlots}`, fields }
    return { fields }
  },

  instruction(ctx, picked, prompts) {
    return renderTemplate(prompts.training[`chest_${picked.kind}`], { target: picked.target, k: picked.k })
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0 }) {
    const { outcome, moved, disturbed, reached } = judgeStorage({ stopped, timedOut, taskState, final, picked })
    const reachedAtMs = final?.reachedAtMs ?? null
    return {
      outcome, moved, disturbed, reached,
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final ? { inventory: final.held ?? null, chest: final.chest ?? null, carried: final.carried ?? null, dropped: final.dropped ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { kind: record.kind, rel: record.rel, n: record.n, k: record.k }
  }
}
