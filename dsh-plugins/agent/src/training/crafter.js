import { renderTemplate } from '../llm/prompts.js'
import { candidates, requirement, rng, shapeOf, spreadStacks } from './sampler.js'

/**
 * 合成器题型（docs/合成器训练场设计方案.md）：正前方一台合成器，物品栏里有某条配方 n 份的材料，每种材料另外多发 e 个。
 * 把材料放进合成器，让它预览出目标、材料正好够合成 n 次（每个放了材料的格子正好 n 个），没放材料的格子全部禁用，然后关掉界面。
 * 合成器不通电，不会真的合成（C2）。
 *
 * - 配方池（R3）：recipes.json 的全部配方（减 exclude）；先在形状里等概率抽一种，再在形状里抽配方；item= 固定目标时不分组
 * - 数量（R4）：n 在 portions 里抽，不超过材料堆叠上限中最小的；每种材料的余量 e 在 extra 里抽，不超过它自己的堆叠上限
 * - 判定（R2、R6）：按原版配方匹配（mod 算的 result），平移、镜像都认；aborted → lost → timeout → success / false_success / failed
 * - 到达（R7）：mod 在 tick 里按 expect { crafter } 检测，记 reachedAtMs
 *
 * 材料都是不带组件的普通物品，按 id 计数（R5）。
 */

export const INVENTORY_SLOTS = 36
export const GRID = 9
export const MAX_COUNT = 64
/** 放不下 n 的下限时最多换几次配方（同工作台方案 MAX_REDRAWS） */
const MAX_REDRAWS = 20
/** 失败原因（R6），报告按这个顺序列 */
export const FAULTS = ['recipe', 'count', 'unlocked', 'leftover', 'open', 'foreign']
export const FAULT_NAMES = { recipe: '产物不对', count: '份数不对', unlocked: '空格没禁用', leftover: '物品栏剩余不对', open: '没关界面', foreign: '出现别的物品' }

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
const fullId = (id) => (id.includes(':') ? id : `minecraft:${id}`)
const shortId = (id) => id.replace(/^minecraft:/, '')

/** "k" / "a-b" → { lo, hi }，在 [min, max] 里；不合法抛错 */
function parseSpec(name, min, max, text) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(text))
  const lo = match ? Number(match[1]) : NaN
  const hi = match ? Number(match[2] ?? match[1]) : NaN
  if (!(lo >= min && hi <= max && lo <= hi)) throw new Error(`${name} 要写 k 或 a-b（${min}–${max}，a ≤ b），收到 "${text}"`)
  return { lo, hi }
}

/** extra=（每种材料多发几个，R4）：0–64 */
export const parseExtraSpec = (text) => parseSpec('extra', 0, MAX_COUNT, text)

/**
 * 选项：命令行的优先，没写的用场地配置。命令行的 n= 进来叫 portions（和合成、酿造场地一致）。
 * @returns {{ portions: {lo,hi}, extra: {lo,hi}, item: string|null }}
 */
export function crafterOptions(args = {}, config = {}) {
  return {
    portions: parseSpec('n', 1, MAX_COUNT, args.portions ?? config.portions ?? '1-16'),
    extra: parseExtraSpec(args.extra ?? config.extra ?? '0-16'),
    item: args.item ? fullId(args.item) : null
  }
}

/** 配方占几格（1–9）：有序配方的非空格数，无序配方的材料数 */
export const cellsOf = (recipe) => requirement(recipe).length

/**
 * 一份材料：每个材料组落到具体物品（同一组同一种），按出现顺序合并计数。
 * @returns {{ chosen: Map<group, id>, materials: Array<{id, count}> }}
 */
function drawMaterials(random, recipe) {
  const chosen = new Map()
  const counts = new Map()
  for (const { group, options } of requirement(recipe)) {
    if (!chosen.has(group)) chosen.set(group, pickOne(random, options))
    const id = chosen.get(group)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return { chosen, materials: [...counts].map(([id, count]) => ({ id, count })) }
}

/**
 * 规范摆法（R8，只给 mod 核对产物用）：有序配方的图案放在左上角，无序配方按顺序放进 0 号格往后。
 * @returns {Array<string|null>}  9 个，行优先
 */
export function canonicalLayout(recipe, chosen) {
  const layout = new Array(GRID).fill(null)
  if (recipe.type === 'shaped') {
    recipe.pattern.forEach((row, r) => [...row].forEach((symbol, c) => {
      if (symbol !== ' ') layout[r * 3 + c] = chosen.get(`#${symbol}`)
    }))
  } else {
    recipe.ingredients.forEach((options, i) => { layout[i] = chosen.get(options.join('|')) })
  }
  return layout
}

/**
 * 出一道题（R3、R4）。同一种子同一道题。
 * 随机数的抽取顺序：形状 → 配方 → 材料 → n → 每种材料的 e（按材料顺序）→ 拆堆 → 打乱格位。
 * @param {object[]} pool  candidates(…, { all: true }) 的结果
 * @param {object} props   item-props.json 的 items
 * @returns {{ recipe, shape, target, cells, portions, materials: Array<{id, count, extra, total}>, extra: {id: e}, held: {id: e}, layout, slots }}
 */
export function sampleCrafter(pool, props, seed, options) {
  let choices = pool
  if (options.item) {
    choices = pool.filter((r) => r.result === options.item)
    if (!choices.length) throw new Error(`配方池里没有合成 ${options.item} 的配方（没有这个产物，或被 exclude 排除了）`)
  }
  if (!choices.length) throw new Error('配方池是空的')
  const stack = (id) => {
    if (!props?.[id]) throw new Error(`item-props.json 里没有 ${id}（重新运行 npm run extract-item-props）`)
    return props[id].maxStack
  }
  const random = rng(seed >>> 0)
  let recipe, chosen, materials, n
  for (let attempt = 0; ; attempt++) {
    let drawFrom = choices
    if (!options.item) {
      const shapes = [...new Set(choices.map(shapeOf))].sort()
      const shape = pickOne(random, shapes)
      drawFrom = choices.filter((r) => shapeOf(r) === shape)
    }
    recipe = pickOne(random, drawFrom)
    ;({ chosen, materials } = drawMaterials(random, recipe))
    const cap = Math.min(...materials.map((m) => stack(m.id)))
    if (options.portions.lo <= cap) {
      n = between(random, options.portions.lo, Math.min(options.portions.hi, cap))
      break
    }
    if (attempt + 1 >= MAX_REDRAWS) {
      throw new Error(`n=${options.portions.lo} 放不下：${recipe.result}（配方 ${recipe.name}）的材料最多堆 ${cap} 个，换了 ${MAX_REDRAWS} 次配方都不行`)
    }
  }
  const extra = {}
  const held = {}
  const items = materials.map(({ id, count }) => {
    const cap = stack(id)
    const top = Math.min(options.extra.hi, cap)
    const e = between(random, Math.min(options.extra.lo, top), top)
    extra[id] = e
    if (e > 0) held[id] = e
    const total = count * n + e
    return { id, total, cap, k: Math.ceil(total / cap) }
  })
  const totals = items.map((it) => it.total)
  const stacks = spreadStacks(random, items, INVENTORY_SLOTS)
  const free = Array.from({ length: INVENTORY_SLOTS }, (_, i) => i)
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[free[i], free[j]] = [free[j], free[i]]
  }
  return {
    recipe: recipe.name, shape: shapeOf(recipe), target: recipe.result, cells: cellsOf(recipe), portions: n,
    materials: materials.map((m, i) => ({ ...m, extra: extra[m.id], total: totals[i] })),
    extra, held,
    layout: canonicalLayout(recipe, chosen),
    slots: stacks.map((s, i) => ({ slot: free[i], ...s }))
  }
}

/** mod 的到达检测（R7）：{ crafter: { target, portions, held, layout } } */
export function crafterExpect(picked) {
  return { crafter: { target: picked.target, portions: picked.portions, held: picked.held, layout: picked.layout } }
}

const total = (counts) => Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0)
const positive = (counts) => Object.fromEntries(Object.entries(counts ?? {}).filter(([, n]) => n > 0))

function sameCounts(a, b) {
  const x = positive(a)
  const y = positive(b)
  return Object.keys(x).length === Object.keys(y).length && Object.entries(y).every(([key, n]) => x[key] === n)
}

/**
 * 守恒（R5）和失败原因（R6）。final：held、carried、dropped（按 id）、crafter { grid, disabled, result }、containerOpen。
 * foreign：出现了材料以外的物品（例如在物品栏的 2×2 里合成了别的东西）。这时材料少了不算丢失，记成这条原因。
 * @returns {{ conserved: boolean, faults: string[], placed: {id: n}, foreign: {id: n} }}
 */
export function crafterAccount(final, picked) {
  const grid = final.crafter?.grid ?? []
  const disabled = new Set(final.crafter?.disabled ?? [])
  const placed = {}
  for (const cell of grid) if (cell) placed[cell.id] = (placed[cell.id] ?? 0) + cell.count
  const everywhere = {}
  for (const counts of [final.held, final.carried, final.dropped, placed]) {
    for (const [id, n] of Object.entries(counts ?? {})) everywhere[id] = (everywhere[id] ?? 0) + n
  }
  const given = Object.fromEntries(picked.materials.map((m) => [m.id, m.total]))
  const foreign = Object.fromEntries(Object.entries(everywhere).filter(([id, n]) => n > 0 && !(id in given)).sort(([a], [b]) => a.localeCompare(b)))
  const conserved = Object.entries(given).every(([id, n]) => (everywhere[id] ?? 0) === n)
  const faults = []
  if (final.crafter?.result !== picked.target) faults.push('recipe')
  if (grid.some((cell) => cell && cell.count !== picked.portions)) faults.push('count')
  if (Array.from({ length: GRID }, (_, i) => i).some((i) => !grid[i] && !disabled.has(i))) faults.push('unlocked')
  if (!sameCounts(final.held, picked.held)) faults.push('leftover')
  if (final.containerOpen !== false || total(final.carried) > 0) faults.push('open')
  if (Object.keys(foreign).length) faults.push('foreign')
  return { conserved, faults, placed, foreign }
}

/**
 * 判定（R6）。到达在插件这边按 R7 的同一套条件再算一遍：没有任何失败原因。
 * 手动停止的轮次照样判 aborted，但拿到了最终状态就照常算失败原因与守恒（2026-11-23：复盘要看停下时卡在哪）。
 * @returns {{ outcome, account: object|null, reached: boolean }}
 */
export function judgeCrafter({ stopped, timedOut, taskState, final, picked }) {
  if (!final?.held || final.crafter === undefined) return { outcome: stopped ? 'aborted' : timedOut ? 'timeout' : 'failed', account: null, reached: false }
  const account = crafterAccount(final, picked)
  const reached = account.faults.length === 0
  const lost = final.stationIntact === false || final.crafter === null || total(final.dropped) > 0
    || (!account.conserved && Object.keys(account.foreign).length === 0)
  let outcome
  if (stopped) outcome = 'aborted'
  else if (lost) outcome = 'lost'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, account, reached }
}

const rangeText = ({ lo, hi }) => (lo === hi ? String(lo) : `${lo}-${hi}`)

export const crafter = {
  type: 'crafter',
  options: ['item', 'portions', 'extra'],

  setup(trainer, arena, arenaConfig, args) {
    const options = crafterOptions(args, arenaConfig)
    const props = trainer.itemProps()
    if (!props) throw new Error(`合成器题需要 ${trainer.config.itemProps}（在 dsh-plugins/agent 里运行 npm run extract-item-props）`)
    const pool = candidates(trainer.recipes(), arenaConfig.exclude ?? [], 3, { all: true })
    const ctx = { arena, arenaConfig, options, pool, props }
    sampleCrafter(pool, props, 0, options) // 选项组合出不了题就当场报错
    return ctx
  },

  startText(ctx) {
    const o = ctx.options
    const shapes = new Set(ctx.pool.map(shapeOf)).size
    return `n=${rangeText(o.portions)}，extra=${rangeText(o.extra)}${o.item ? `，目标 ${o.item}` : ''}；配方池 ${ctx.pool.length} 条配方、${shapes} 种形状`
  },

  batchFields() {
    return {}
  },

  sample(ctx, seed) {
    return sampleCrafter(ctx.pool, ctx.props, seed, ctx.options)
  },

  label(ctx, picked, seed) {
    return `合成器：${shortId(picked.target)} ×${picked.portions} 次（配方 ${picked.recipe}，占 ${picked.cells} 格，seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      recipe: picked.recipe, shape: picked.shape, target: picked.target, cells: picked.cells, portions: picked.portions,
      extra: picked.extra, items: picked.materials, slots: picked.slots,
      grid: null, disabled: null, result: null, powered: null, faults: [], foreign: {},
      final: null, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return { station: 'crafter', items: picked.slots, seed, watch: [], expect: crafterExpect(picked), dayTime: 1000 }
  },

  afterPrepare(ctx, picked, data) {
    const fields = {}
    if (Array.isArray(data?.given)) fields.slots = data.given
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the crafter (aimOk=${data?.aimOk}); check the arena origin`, fields }
    // R8：mod 已用服务器配方核对过规范摆法；这里再确认返回了产物
    if (data?.crafter?.product !== picked.target) {
      return { error: `数据和服务器不一致（产物：数据 ${picked.target} / 服务器 ${data?.crafter?.product}）；请重新运行 npm run extract-recipes，或把配方 ${picked.recipe} 加进 exclude`, fields }
    }
    return { fields }
  },

  instruction(ctx, picked, prompts) {
    // R11：只写目标状态；不说怎么打开、怎么禁用，也不说每格放几个
    return renderTemplate(prompts.training.crafter, { target: picked.target, n: picked.portions })
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0 }) {
    const { outcome, account, reached } = judgeCrafter({ stopped, timedOut, taskState, final, picked })
    const reachedAtMs = final?.reachedAtMs ?? null
    const state = final?.crafter ?? null
    return {
      outcome, reached,
      grid: state?.grid ?? null, disabled: state?.disabled ?? null, result: state?.result ?? null, powered: state?.powered ?? null,
      faults: outcome === 'success' ? [] : account?.faults ?? [],
      foreign: account?.foreign ?? {},
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final ? { held: final.held ?? null, carried: final.carried ?? null, dropped: final.dropped ?? null, containerOpen: final.containerOpen ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { cells: record.cells ?? null, portions: record.portions ?? null }
  }
}
