import fs from 'node:fs'

import { renderTemplate } from '../llm/prompts.js'
import { rng } from './sampler.js'
import { parseRangeSpec } from './storage.js'

/**
 * 酿造台题型（docs/酿造台训练场设计方案.md）：正前方一台酿造台，物品栏里有 1 格烈焰粉、1 格酿造材料、b 瓶同一种药水，
 * 把 m 个烈焰粉放进燃料格、n 个材料放进材料格、p 瓶药水放进药水格，然后关掉界面。酿造台按原版速度工作；不要求等它酿完、不要求拿产物（P2）。
 *
 * - 配方池（P3）：data/brewing.json 展开成"开局药水 + 材料 → 产物"：药水配方 × 三种瓶子；换瓶子配方（火药、龙息）× 配方表里出现过的药水。
 *   去掉材料是燃料（烈焰粉）的、exclude 里的材料 / 药水 / 瓶子；先抽材料，再在材料内抽配方
 * - 数量（P4）：烈焰粉 F（fuel，1 格）放 m 个；材料 R（raw，不超过堆叠上限，海龟壳只有 1 个）放 n 个；药水 b 瓶（bottles）放 p 瓶（[1, b]）
 * - 放料（P5）：看物品栏少了多少；药水格只数瓶数（酿造一瓶换一瓶）
 * - 判定（P6）：aborted → lost（被挖、地上有东西（龙息剩下的玻璃瓶除外）、不守恒）→ overshoot（吃掉的烈焰粉 > m、用掉的材料 > n）
 *   → misplaced → timeout → success / false_success / failed
 * - 到达（P8）：mod 在 tick 里按 expect { brew } 检测，记 reachedAtMs
 *
 * 计数都按签名（P7）：带药水内容的是 瓶子 id#药水注册名，其余是 id。
 */

export const INVENTORY_SLOTS = 36
export const STACK = 64
export const MAX_BOTTLES = 3
export const KIND_NAMES = { potion: '药水配方', container: '换瓶子配方' }
export const BOTTLE_NAMES = { 'minecraft:potion': '普通', 'minecraft:splash_potion': '喷溅', 'minecraft:lingering_potion': '滞留' }

export const parseBottlesSpec = (text) => parseRangeSpec('bottles', MAX_BOTTLES, text)

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
const draw = (random, { lo, hi }) => (lo === hi ? lo : between(random, lo, hi))
const fullId = (id) => (id.includes(':') ? id : `minecraft:${id}`)
const shortId = (id) => id.replace(/^minecraft:/, '')

function shuffle(random, list) {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** 药水签名（P7）：瓶子 id#药水注册名 */
export const potionKey = (bottle, potion) => `${bottle}#${potion}`

/** data/brewing.json：{ fuel: [{ id, charges }], containers: [{ id }], potionMixes, containerMixes } */
export function loadBrewing(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const key of ['fuel', 'containers', 'potionMixes', 'containerMixes']) {
    if (!Array.isArray(data?.[key])) throw new Error(`brewing file has no ${key} list: ${file}`)
  }
  return data
}

/**
 * 配方池（P3）：[{ kind, bottle, from, ingredient, to, input, product }]，input / product 是签名；按材料分组。
 * @returns {{ fuel: string, byIngredient: Map<string, object[]>, ingredients: string[], stacks: Map<string, number>, remainders: Map<string, string|null> }}
 */
export function brewTables(brewing, props, { exclude = [] } = {}) {
  const skip = new Set(exclude.map(fullId))
  const fuels = brewing.fuel.map((f) => f.id)
  if (fuels.length !== 1) throw new Error(`brewing.json 的燃料应该只有一种，实际 ${fuels.join('、') || '没有'}`)
  const containers = brewing.containers.map((c) => c.id).filter((id) => !skip.has(id))
  const potions = [...new Set(brewing.potionMixes.flatMap((m) => [m.from, m.to]))].filter((p) => !skip.has(p)).sort()
  const recipes = []
  for (const mix of brewing.potionMixes) {
    if (skip.has(mix.from) || skip.has(mix.to)) continue
    for (const bottle of containers) recipes.push({ kind: 'potion', bottle, from: mix.from, ingredient: mix.ingredient, to: mix.to, input: potionKey(bottle, mix.from), product: potionKey(bottle, mix.to) })
  }
  for (const mix of brewing.containerMixes) {
    if (skip.has(mix.from) || skip.has(mix.to)) continue
    for (const potion of potions) recipes.push({ kind: 'container', bottle: mix.from, from: potion, ingredient: mix.ingredient, to: potion, input: potionKey(mix.from, potion), product: potionKey(mix.to, potion) })
  }
  const byIngredient = new Map()
  for (const r of recipes) {
    // 材料是燃料的排除（P3、F6）：燃料和材料是同一种物品，只看物品栏分不清各放了多少
    if (fuels.includes(r.ingredient) || skip.has(r.ingredient)) continue
    if (!byIngredient.has(r.ingredient)) byIngredient.set(r.ingredient, [])
    byIngredient.get(r.ingredient).push(r)
  }
  const ingredients = [...byIngredient.keys()].sort()
  const stacks = new Map()
  const remainders = new Map()
  for (const id of [...ingredients, fuels[0]]) {
    if (!props?.[id]) throw new Error(`item-props.json 里没有 ${id}（重新运行 npm run extract-item-props）`)
    stacks.set(id, props[id].maxStack)
    remainders.set(id, props[id].remainder ?? null)
  }
  return { fuel: fuels[0], byIngredient, ingredients, stacks, remainders }
}

/**
 * 选项（§5）：命令行的优先，没写的用场地配置。命令行的 n= / m= 进来叫 portions / crafts（和合成题、熔炉题共用名字）。
 * @returns {{ fuel, raw, bottles, n, m: {lo,hi}, input: string|null }}
 */
export function brewOptions(args = {}, config = {}) {
  const pick = (key, fallback) => args[key] ?? config[key] ?? fallback
  return {
    fuel: parseRangeSpec('fuel', STACK, pick('fuel', '32-64')),
    raw: parseRangeSpec('raw', STACK, pick('raw', '32-64')),
    bottles: parseBottlesSpec(pick('bottles', '1-3')),
    m: parseRangeSpec('m', STACK, args.crafts ?? config.m ?? '1-32'),
    n: parseRangeSpec('n', STACK, args.portions ?? config.n ?? '1-32'),
    input: args.input ? fullId(args.input) : null
  }
}

/** 在 range 里抽，但不超过 cap（下限也压到 cap 以内） */
function drawCapped(random, { lo, hi }, cap) {
  const top = Math.min(hi, cap)
  return between(random, Math.min(lo, top), top)
}

/**
 * 出一道题（P3、P4）。同一种子同一道题。
 * 随机数的抽取顺序：材料 → 配方 → F → R → b → m → n → p → 打乱格位。
 * @returns {{ recipe, fuel: { id, total, placed }, ingredient: { id, total, placed, remainder }, potion: { signature, bottle, potion, total, placed },
 *   product: string, layout: [{ slot, id, count, potion? }], target: string }}
 */
export function sampleBrew(tables, seed, options) {
  if (options.input && !tables.byIngredient.has(options.input)) throw new Error(`没有材料 ${options.input}（不是酿造材料，是燃料，或者被 exclude 排除）`)
  if (!tables.ingredients.length) throw new Error('配方池是空的（brewing.json 没有配方，或者全被 exclude 排除）')
  const random = rng(seed >>> 0)
  const ingredient = options.input ?? pickOne(random, tables.ingredients)
  const recipe = pickOne(random, tables.byIngredient.get(ingredient))
  const F = draw(random, options.fuel)
  const R = Math.min(draw(random, options.raw), tables.stacks.get(ingredient))
  const b = draw(random, options.bottles)
  const m = drawCapped(random, options.m, F)
  const n = drawCapped(random, options.n, R)
  const p = between(random, 1, b)
  const stacks = [
    { id: tables.fuel, count: F },
    { id: ingredient, count: R },
    ...Array.from({ length: b }, () => ({ id: recipe.bottle, count: 1, potion: recipe.from }))
  ]
  const positions = shuffle(random, Array.from({ length: INVENTORY_SLOTS }, (_, i) => i)).slice(0, stacks.length)
  const layout = stacks.map((s, i) => ({ slot: positions[i], ...s })).sort((a, b2) => a.slot - b2.slot)
  return {
    recipe: { kind: recipe.kind, from: recipe.input, ingredient, to: recipe.product },
    fuel: { id: tables.fuel, total: F, placed: m },
    ingredient: { id: ingredient, total: R, placed: n, remainder: tables.remainders.get(ingredient) },
    potion: { signature: recipe.input, bottle: recipe.bottle, potion: recipe.from, total: b, placed: p },
    product: recipe.product,
    layout,
    target: recipe.product
  }
}

/** mod 的到达检测（P8）：{ brew: { fuel, fuelLeft, ingredient, ingredientLeft, potion, potionLeft, placed, products } } */
export function brewExpect(picked) {
  return {
    brew: {
      fuel: picked.fuel.id, fuelLeft: picked.fuel.total - picked.fuel.placed,
      ingredient: picked.ingredient.id, ingredientLeft: picked.ingredient.total - picked.ingredient.placed,
      potion: picked.potion.signature, potionLeft: picked.potion.total - picked.potion.placed,
      placed: picked.potion.placed, products: [picked.product]
    }
  }
}

const total = (counts) => Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0)
const at = (counts, key) => counts?.[key] ?? 0

function addCounts(...maps) {
  const out = {}
  for (const map of maps) for (const [key, n] of Object.entries(map ?? {})) out[key] = (out[key] ?? 0) + n
  return out
}

/**
 * 守恒与放入量（P6）。final：held、carried、dropped（按签名）、stand { potions, ingredient, fuel }、brews。
 * @returns {{ put: { fuel, ingredient, potions }, consumed: { fuel, ingredient }, potionsTotal, extra: {key: n}, wrongSlots: string[] }}
 */
export function brewAccount(final, picked) {
  const FUEL = picked.fuel.id
  const ING = picked.ingredient.id
  const REM = picked.ingredient.remainder
  const POT = picked.potion.signature
  const isPotion = (key) => key === POT || key === picked.product
  const outside = addCounts(final.held, final.carried, final.dropped)
  const stand = final.stand ?? { potions: [], ingredient: {}, fuel: {} }
  const standPotions = (stand.potions ?? []).filter(Boolean)
  const consumedFuel = picked.fuel.total - at(outside, FUEL) - at(stand.fuel, FUEL) - at(stand.ingredient, FUEL)
  const consumedIng = picked.ingredient.total - at(outside, ING) - at(stand.ingredient, ING)
  const potionsTotal = Object.entries(outside).reduce((sum, [key, n]) => sum + (isPotion(key) ? n : 0), 0) + standPotions.filter(isPotion).length
  const allowed = new Set([FUEL, ING, POT, picked.product, ...(REM ? [REM] : [])])
  const extra = Object.fromEntries(Object.entries(outside).filter(([key, n]) => n > 0 && !allowed.has(key)).sort(([a], [b]) => a.localeCompare(b)))
  const wrongSlots = [
    ...Object.keys(stand.fuel ?? {}).filter((key) => key !== FUEL).map((key) => `燃料格：${key}`),
    ...Object.keys(stand.ingredient ?? {}).filter((key) => key !== ING && key !== REM).map((key) => `材料格：${key}`),
    ...standPotions.filter((key) => !isPotion(key)).map((key) => `药水格：${key}`)
  ]
  return {
    put: {
      fuel: picked.fuel.total - at(outside, FUEL),
      ingredient: picked.ingredient.total - at(outside, ING),
      potions: standPotions.length
    },
    consumed: { fuel: consumedFuel, ingredient: consumedIng },
    potionsTotal, extra, wrongSlots
  }
}

/**
 * 判定（P6）。到达（P8）在插件这边按同样的规则再算一遍：界面已关、光标为空、物品栏恰好剩 F − m / R − n / b − p 且没有别的东西、
 * 燃料格只有烈焰粉、材料格只有材料（或龙息剩下的玻璃瓶）、药水格恰好 p 瓶开局药水或产物。
 * @returns {{ outcome, account: object|null, reached: boolean }}
 */
export function judgeBrew({ stopped, timedOut, taskState, final, picked }) {
  if (stopped) return { outcome: 'aborted', account: null, reached: false }
  if (!final?.held) return { outcome: timedOut ? 'timeout' : 'failed', account: null, reached: false }
  const account = brewAccount(final, picked)
  const REM = picked.ingredient.remainder
  const want = {}
  const left = [[picked.fuel.id, picked.fuel.total - picked.fuel.placed], [picked.ingredient.id, picked.ingredient.total - picked.ingredient.placed], [picked.potion.signature, picked.potion.total - picked.potion.placed]]
  for (const [key, n] of left) if (n > 0) want[key] = n
  const held = Object.fromEntries(Object.entries(final.held).filter(([, n]) => n > 0))
  const heldExact = Object.keys(held).length === Object.keys(want).length && Object.entries(want).every(([key, n]) => held[key] === n)
  const reached = final.containerOpen === false && total(final.carried) === 0 && heldExact && account.wrongSlots.length === 0 && account.put.potions === picked.potion.placed
  const droppedOther = Object.entries(final.dropped ?? {}).some(([key, n]) => n > 0 && key !== REM)
  const brews = Number.isInteger(final.brews) ? final.brews : null
  const lost = final.stationIntact === false || droppedOther
    || account.potionsTotal !== picked.potion.total
    || account.consumed.fuel < 0 || account.consumed.fuel > 1
    || (brews !== null ? account.consumed.ingredient !== brews : account.consumed.ingredient < 0)
  let outcome
  if (lost) outcome = 'lost'
  else if (account.consumed.fuel > picked.fuel.placed || account.consumed.ingredient > picked.ingredient.placed) outcome = 'overshoot'
  else if (account.wrongSlots.length || Object.keys(account.extra).length) outcome = 'misplaced'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, account, reached }
}

/** 药水的文案写法（P12）：minecraft:splash_potion（minecraft:awkward） */
const potionText = (picked) => `${picked.potion.bottle}（${picked.potion.potion}）`
const rangeText = ({ lo, hi }) => (lo === hi ? String(lo) : `${lo}-${hi}`)

export const brew = {
  type: 'brew',
  options: ['raw', 'fuel', 'bottles', 'portions', 'crafts', 'input'],

  setup(trainer, arena, arenaConfig, args) {
    if (args.item) throw new Error('酿造台场地用 input= 指定材料（item= 是合成题、箱子题的选项）')
    const options = brewOptions(args, arenaConfig)
    const brewing = trainer.brewing()
    if (!brewing) throw new Error(`酿造台题需要 ${trainer.config.brewing}（在 dsh-plugins/agent 里运行 npm run extract-item-props）`)
    const props = trainer.itemProps()
    if (!props) throw new Error(`酿造台题需要 ${trainer.config.itemProps}（在 dsh-plugins/agent 里运行 npm run extract-item-props）`)
    const tables = brewTables(brewing, props, { exclude: arenaConfig.exclude ?? [] })
    const ctx = { arena, arenaConfig, tables, options }
    sampleBrew(tables, 0, options) // 选项组合出不了题就当场报错
    return ctx
  },

  startText(ctx) {
    const o = ctx.options
    const recipes = [...ctx.tables.byIngredient.values()].reduce((sum, list) => sum + list.length, 0)
    return `fuel=${rangeText(o.fuel)}，raw=${rangeText(o.raw)}，bottles=${rangeText(o.bottles)}，m=${rangeText(o.m)}，n=${rangeText(o.n)}${o.input ? `，材料 ${o.input}` : ''}；配方池 ${ctx.tables.ingredients.length} 种材料、${recipes} 条配方`
  },

  batchFields() {
    return {}
  },

  sample(ctx, seed) {
    return sampleBrew(ctx.tables, seed, ctx.options)
  },

  label(ctx, picked, seed) {
    const potion = `${shortId(picked.potion.bottle)}(${shortId(picked.potion.potion)})`
    return `酿造台：放 ${picked.fuel.placed} 个 ${shortId(picked.fuel.id)}、${picked.ingredient.placed} 个 ${shortId(picked.ingredient.id)}、${picked.potion.placed}/${picked.potion.total} 瓶 ${potion}（seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      recipe: picked.recipe, fuel: picked.fuel, ingredient: picked.ingredient, potion: picked.potion, product: picked.product,
      target: picked.target, layout: picked.layout,
      put: null, consumed: null, brews: null, extra: {}, wrongSlots: [],
      final: null, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return { station: 'brewing_stand', items: picked.layout, seed, watch: [], expect: brewExpect(picked), dayTime: 1000 }
  },

  afterPrepare(ctx, picked, data) {
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the brewing stand (aimOk=${data?.aimOk}); check the arena origin`, fields: {} }
    // P8：mod 已用服务器的酿造配方核对过；这里再确认返回了产物、和数据一致
    if (data?.brew?.product !== picked.product) {
      return { error: `数据和服务器不一致（产物：数据 ${picked.product} / 服务器 ${data?.brew?.product}）；请重新运行 npm run extract-item-props`, fields: {} }
    }
    return { fields: {} }
  },

  instruction(ctx, picked, prompts) {
    // P12：只说现状和要求（放料、关界面）；药水写清种类；不说物品栏里各有多少，不提产物
    return renderTemplate(prompts.training.brew, {
      fuel: picked.fuel.id, ingredient: picked.ingredient.id, potion: potionText(picked),
      bottles: picked.potion.total, m: picked.fuel.placed, n: picked.ingredient.placed, p: picked.potion.placed
    })
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0 }) {
    const { outcome, account, reached } = judgeBrew({ stopped, timedOut, taskState, final, picked })
    const reachedAtMs = final?.reachedAtMs ?? null
    return {
      outcome, reached,
      put: account?.put ?? null, consumed: account?.consumed ?? null, brews: Number.isInteger(final?.brews) ? final.brews : null,
      extra: account?.extra ?? {}, wrongSlots: account?.wrongSlots ?? [],
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final ? { held: final.held ?? null, carried: final.carried ?? null, dropped: final.dropped ?? null, stand: final.stand ?? null, containerOpen: final.containerOpen ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { ingredient: record.ingredient?.id ?? null, kind: record.recipe?.kind ?? null }
  }
}
