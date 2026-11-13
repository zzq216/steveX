import fs from 'node:fs'

/**
 * 合成训练的配方抽样（训练场设计方案 T7；工作台训练场设计方案 W3、W4）。
 *
 * - 候选：放得进 N×N、放不进 (N−1)×(N−1) 的配方（N = 场地的 grid；N=2 时就是全部能放进 2×2 的）。
 *   放得进 N×N = 有序配方图案不超过 N 行 N 列；无序配方材料不超过 N² 个
 * - 一个材料位能用多种物品时随机选一种；有序配方里同一符号、无序配方里选项完全相同的材料位用同一种物品
 * - 发 1 份配方的材料，按物品合并；再按种子决定怎么拆堆、放哪些槽位（主物品栏 0–35）
 * - byShape：先在形状里等概率抽一种，再在这种形状里抽配方（W4）；固定目标时不分组
 */

const MAIN_SLOTS = 36

export function loadRecipes(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(data?.recipes)) throw new Error(`recipes file has no recipes list: ${file}`)
  return data.recipes
}

export function fitsGrid(recipe, grid = 2) {
  if (recipe.type === 'shaped') {
    const { rows, cols } = patternSize(recipe.pattern)
    return rows <= grid && cols <= grid
  }
  if (recipe.type === 'shapeless') return recipe.ingredients.length <= grid * grid
  return false
}

/**
 * 有序配方图案实际占的行列数（2026-11-13）：配方数据里的 pattern 按生成器原样保留，可能带空格组成的空行空列
 * （雕纹铜 [" M ", " M "]、重锤 [" # ", " I "]）；游戏匹配时会去掉它们（ShapedRecipePattern 收缩），
 * 只按原样量宽度会把放得进 2x2 的配方算成 3x3、混进 craft3x3 的候选。
 */
export function patternSize(pattern) {
  const rows = pattern.filter((row) => row.trim() !== '')
  if (!rows.length) return { rows: 0, cols: 0 }
  const left = Math.min(...rows.map((row) => row.search(/\S/)))
  const right = Math.max(...rows.map((row) => row.trimEnd().length))
  return { rows: rows.length, cols: right - left }
}

/**
 * 配方的形状（W4）：有序配方的图案把符号按出现顺序换成 A、B、C…（楼梯 "#  /## /###" → "A  /AA /AAA"）；
 * 无序配方记为 "shapeless:<材料个数>"。
 */
export function shapeOf(recipe) {
  if (recipe.type !== 'shaped') return `shapeless:${recipe.ingredients.length}`
  const names = new Map()
  return recipe.pattern
    .map((row) => [...row].map((symbol) => {
      if (symbol === ' ') return ' '
      if (!names.has(symbol)) names.set(symbol, String.fromCharCode(65 + names.size))
      return names.get(symbol)
    }).join(''))
    .join('/')
}

/** 配方的材料位：[{ group, options }]；同一 group 的材料位发同一种物品。 */
export function requirement(recipe) {
  if (recipe.type === 'shaped') {
    const slots = []
    for (const row of recipe.pattern) {
      for (const symbol of row) if (symbol !== ' ') slots.push({ group: `#${symbol}`, options: recipe.key[symbol] })
    }
    return slots
  }
  return recipe.ingredients.map((options) => ({ group: options.join('|'), options }))
}

export function candidates(recipes, exclude = [], grid = 2) {
  const skip = new Set(exclude)
  return recipes.filter((r) => fitsGrid(r, grid) && (grid <= 2 || !fitsGrid(r, grid - 1)) && !skip.has(r.name))
}

/** 种子 → [0, 1) 的伪随机数（mulberry32）：同一种子同一序列，记录里的 seed 能复现一轮。 */
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))

/** n、m 的取值上限（T14）：命令行输入范围，放不放得下另算 */
export const MAX_PORTIONS = 64
/** 放不下时最多换几次配方（T14） */
const MAX_REDRAWS = 20

/**
 * 读 data/item-props.json（scripts/extract-item-props.js 生成）：id → { maxStack, remainder? }。
 * 文件不在 → null（只有多份模式需要它）。
 */
export function loadItemProps(file) {
  if (!file || !fs.existsSync(file)) return null
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!data?.items || typeof data.items !== 'object') throw new Error(`item props file has no items map: ${file}`)
  return data.items
}

/**
 * 发 n 份时最少要占几格（T14）：材料 + 按 n 份全部做光预留的产物 + 做光后的合成剩余物，各按堆叠上限向上取整。
 * @returns {{ materials: number, product: number, remainders: number, total: number }}
 */
export function slotsNeeded(materials, target, yieldCount, n, props) {
  const stack = (id) => {
    const p = props[id]
    if (!p) throw new Error(`data/item-props.json 里没有 ${id}（重新运行 npm run extract-item-props）`)
    return p.maxStack
  }
  let materialSlots = 0
  const remainders = new Map()
  for (const { id, count } of materials) {
    materialSlots += Math.ceil((count * n) / stack(id))
    const remainder = props[id]?.remainder
    if (remainder) remainders.set(remainder, (remainders.get(remainder) ?? 0) + count * n)
  }
  const product = Math.ceil((yieldCount * n) / stack(target))
  let remainderSlots = 0
  for (const [id, count] of remainders) remainderSlots += Math.ceil(count / stack(id))
  return { materials: materialSlots, product, remainders: remainderSlots, total: materialSlots + product + remainderSlots }
}

/** 这份材料最多能发几份（slotsNeeded ≤ 36 的最大 n，上限 MAX_PORTIONS）；连 1 份都放不下 → 0。 */
export function maxPortions(materials, target, yieldCount, props) {
  let n = 0
  while (n < MAX_PORTIONS && slotsNeeded(materials, target, yieldCount, n + 1, props).total <= MAIN_SLOTS) n++
  return n
}

/**
 * 解析 n= / m= 的值："k" 或 "a-b"，1–64。@returns {{ lo, hi }}；不合法抛错
 */
export function parseCountSpec(text, name) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(text))
  const lo = match ? Number(match[1]) : NaN
  const hi = match ? Number(match[2] ?? match[1]) : NaN
  if (!(lo >= 1 && hi <= MAX_PORTIONS && lo <= hi)) throw new Error(`${name} 要是 1–${MAX_PORTIONS} 的整数或范围 a-b（a ≤ b），收到 "${text}"`)
  return { lo, hi }
}

/** 一份材料：配方 + 每个材料位落到具体物品（同一 group 同一种）。 */
function drawMaterials(random, recipe) {
  const chosen = new Map()
  const counts = new Map()
  for (const { group, options } of requirement(recipe)) {
    if (!chosen.has(group)) chosen.set(group, pickOne(random, options))
    const id = chosen.get(group)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return [...counts].map(([id, count]) => ({ id, count }))
}

/**
 * 抽 n、m（T14）：先在用户范围里抽 n，放不下就在 [下限, min(上限, n_max)] 里重抽；m 省略时 n=1 → 1，否则 1…n−1。
 * @returns {{ n, m } | null}  可用范围是空的 → null
 */
function drawCounts(random, portions, crafts, nMax) {
  const lo = Math.max(portions.lo, crafts ? crafts.lo : 1)
  if (lo > portions.hi) return null
  let n = between(random, lo, portions.hi)
  if (n > nMax) {
    if (Math.min(portions.hi, nMax) < lo) return null
    n = between(random, lo, Math.min(portions.hi, nMax))
  }
  const m = crafts ? between(random, crafts.lo, Math.min(crafts.hi, n)) : n === 1 ? 1 : between(random, 1, n - 1)
  return { n, m }
}

/**
 * 抽一轮：配方、材料、份数与次数、发放槽位。
 * @param {object[]} pool         candidates() 的结果
 * @param {number} seed
 * @param {string|null} [item]    固定目标：物品 id（minecraft:stick）或省略命名空间（stick）
 * @param {object} [options]
 * @param {number} [options.grid]          只用于报错文字
 * @param {boolean} [options.byShape]
 * @param {{lo,hi}|null} [options.portions]  n 的范围；null = 单次模式（1 份、1 次，随机数序列与 T14 之前相同）
 * @param {{lo,hi}|null} [options.crafts]    m 的范围；null = 随 n 抽
 * @param {object|null} [options.props]      loadItemProps() 的结果（多份模式必需）
 * @returns {{ recipe, target, shape, materials, portions, crafts, yield, wanted, nMax, slots: Array<{slot,id,count}> }}
 *   materials = 一份的材料；slots = 实际要发的堆（多份时是 materials × n 拆出来的）
 */
export function sample(pool, seed, item = null, { grid = 2, byShape = false, portions = null, crafts = null, props = null } = {}) {
  const random = rng(seed)
  let choices = pool
  if (item) {
    const id = item.includes(':') ? item : `minecraft:${item}`
    choices = pool.filter((r) => r.result === id)
    if (choices.length === 0) throw new Error(`候选里没有合成 ${id} 的 ${grid}×${grid} 配方（不在本场地的候选里，或被 exclude 排除了）`)
  }
  if (choices.length === 0) throw new Error('候选配方是空的')
  const multi = portions !== null
  if (multi && !props) throw new Error('多份模式需要 data/item-props.json（在 dsh-plugins/agent 里运行 npm run extract-item-props）')

  let recipe, materials, counts, nMax
  for (let attempt = 0; ; attempt++) {
    let drawFrom = choices
    if (byShape && !item) {
      const shapes = [...new Set(choices.map(shapeOf))].sort()
      const shape = pickOne(random, shapes)
      drawFrom = choices.filter((r) => shapeOf(r) === shape)
    }
    recipe = pickOne(random, drawFrom)
    materials = drawMaterials(random, recipe)
    if (!multi) {
      counts = { n: 1, m: 1 }
      nMax = null
      break
    }
    nMax = maxPortions(materials, recipe.result, recipe.count, props)
    counts = drawCounts(random, portions, crafts, nMax)
    if (counts) break
    if (attempt + 1 >= MAX_REDRAWS) {
      const want = crafts ? `n ≥ ${Math.max(portions.lo, crafts.lo)}` : `n ≥ ${portions.lo}`
      throw new Error(`放不进主物品栏：${recipe.result}（配方 ${recipe.name}）这份材料最多发 ${nMax} 份（材料 + 全部做光的产物 + 剩余物 ≤ 36 格），要求 ${want}；换了 ${MAX_REDRAWS} 次配方都不行`)
    }
  }
  const { n, m } = counts

  const stacks = multi ? splitStacks(random, materials, recipe, n, props) : splitEachGap(random, materials)
  const free = Array.from({ length: MAIN_SLOTS }, (_, i) => i)
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[free[i], free[j]] = [free[j], free[i]]
  }
  const slots = stacks.map((stack, i) => ({ slot: free[i], ...stack }))
  return {
    recipe: recipe.name, target: recipe.result, shape: shapeOf(recipe), materials,
    portions: n, crafts: m, yield: recipe.count, wanted: m * recipe.count, nMax, slots
  }
}

/** 单次模式的拆堆（T7）：count 个之间的 count-1 个缝隙各有一半概率断开（3 个可能拆成 3 / 2+1 / 1+2 / 1+1+1） */
function splitEachGap(random, materials) {
  const stacks = []
  for (const { id, count } of materials) {
    let run = 1
    for (let i = 1; i < count; i++) {
      if (random() < 0.5) {
        stacks.push({ id, count: run })
        run = 1
      } else run++
    }
    stacks.push({ id, count: run })
  }
  return stacks
}

/**
 * 多份模式的拆堆（T14"拆堆"，2026-11-02 修订）：先在 [K_min, K_max] 里均匀抽总堆数 K，
 * 再把 K 分给各材料（每种先给最少堆数，多的逐个随机分给还能再拆的），最后每种材料先每堆 1 个、
 * 余下的逐个随机放进没满的堆。每堆都不超过堆叠上限；n ≤ n_max 保证 K_min ≤ K_max。
 * @returns {Array<{id, count}>}  按材料顺序排列
 */
export function splitStacks(random, materials, recipe, n, props) {
  const need = slotsNeeded(materials, recipe.result, recipe.count, n, props)
  const items = materials.map(({ id, count }) => {
    const total = count * n
    const cap = props[id].maxStack
    return { id, total, cap, k: Math.ceil(total / cap) }
  })
  const kMin = items.reduce((sum, it) => sum + it.k, 0)
  const kMax = Math.min(MAIN_SLOTS - need.product - need.remainders, items.reduce((sum, it) => sum + it.total, 0))
  let extra = between(random, kMin, Math.max(kMin, kMax)) - kMin
  while (extra > 0) {
    const open = items.filter((it) => it.k < it.total)
    if (open.length === 0) break
    pickOne(random, open).k++
    extra--
  }
  const stacks = []
  for (const it of items) {
    const counts = new Array(it.k).fill(1)
    for (let left = it.total - it.k; left > 0; left--) {
      const open = []
      for (let i = 0; i < counts.length; i++) if (counts[i] < it.cap) open.push(i)
      counts[pickOne(random, open)]++
    }
    for (const count of counts) stacks.push({ id: it.id, count })
  }
  return stacks
}

/**
 * 这份材料能合成出的全部产物（hidden 模式判定 + 记录 agent 实际做出了什么，T5）。
 * pool = 场地合成格里能放下的全部配方（工作台场地含 2×2 配方，W7）。
 * 每个材料位各占一个材料（MC 的合成格逐格匹配，同一符号不要求同一种物品）。
 * @returns {string[]}  target 排第一
 */
export function craftableResults(pool, materials, target) {
  const units = materials.flatMap(({ id, count }) => Array(count).fill(id))
  const out = new Set([target])
  for (const recipe of pool) {
    if (out.has(recipe.result)) continue
    if (satisfiable(requirement(recipe).map((s) => s.options), units)) out.add(recipe.result)
  }
  return [...out]
}

function satisfiable(slots, units) {
  if (slots.length > units.length) return false
  const used = new Array(units.length).fill(false)
  const assign = (i) => {
    if (i === slots.length) return true
    for (let u = 0; u < units.length; u++) {
      if (used[u] || !slots[i].includes(units[u])) continue
      used[u] = true
      if (assign(i + 1)) return true
      used[u] = false
    }
    return false
  }
  return assign(0)
}
