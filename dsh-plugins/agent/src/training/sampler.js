import fs from 'node:fs'

/**
 * 2×2 合成训练的配方抽样（训练场设计方案 T7）。
 *
 * - 候选：有序配方图案不超过 2 行 2 列；无序配方材料不超过 4 个
 * - 一个材料位能用多种物品时随机选一种；有序配方里同一符号、无序配方里选项完全相同的材料位用同一种物品
 * - 发 1 份配方的材料，按物品合并；再按种子决定拆不拆堆、放哪些槽位（主物品栏 0–35）
 */

const GRID = 2
const MAIN_SLOTS = 36

export function loadRecipes(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(data?.recipes)) throw new Error(`recipes file has no recipes list: ${file}`)
  return data.recipes
}

export function fitsGrid(recipe) {
  if (recipe.type === 'shaped') return recipe.pattern.length <= GRID && recipe.pattern.every((row) => row.length <= GRID)
  if (recipe.type === 'shapeless') return recipe.ingredients.length <= GRID * GRID
  return false
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

export function candidates(recipes, exclude = []) {
  const skip = new Set(exclude)
  return recipes.filter((r) => fitsGrid(r) && !skip.has(r.name))
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

/**
 * 抽一轮：配方、材料、发放槽位。
 * @param {object[]} pool         candidates() 的结果
 * @param {number} seed
 * @param {string|null} [item]    固定目标：物品 id（minecraft:stick）或省略命名空间（stick）
 * @returns {{ recipe, target, materials: Array<{id,count}>, slots: Array<{slot,id,count}> }}
 */
export function sample(pool, seed, item = null) {
  const random = rng(seed)
  let choices = pool
  if (item) {
    const id = item.includes(':') ? item : `minecraft:${item}`
    choices = pool.filter((r) => r.result === id)
    if (choices.length === 0) throw new Error(`没有能用 2×2 合成 ${id} 的配方（或被 exclude 排除了）`)
  }
  if (choices.length === 0) throw new Error('候选配方是空的')
  const recipe = pickOne(random, choices)

  const chosen = new Map()
  const counts = new Map()
  for (const { group, options } of requirement(recipe)) {
    if (!chosen.has(group)) chosen.set(group, pickOne(random, options))
    const id = chosen.get(group)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const materials = [...counts].map(([id, count]) => ({ id, count }))

  const stacks = []
  for (const { id, count } of materials) {
    if (count > 1 && random() < 0.5) for (let i = 0; i < count; i++) stacks.push({ id, count: 1 })
    else stacks.push({ id, count })
  }
  const free = Array.from({ length: MAIN_SLOTS }, (_, i) => i)
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[free[i], free[j]] = [free[j], free[i]]
  }
  const slots = stacks.map((stack, i) => ({ slot: free[i], ...stack }))
  return { recipe: recipe.name, target: recipe.result, materials, slots }
}

/**
 * 这份材料在 2×2 里能合成出的全部产物（hidden 模式判定 + 记录 agent 实际做出了什么，T5）。
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
