import fs from 'node:fs'

import { renderTemplate } from '../llm/prompts.js'
import { rng } from './sampler.js'
import { parseRangeSpec } from './storage.js'

/**
 * 熔炉题型（docs/熔炉训练场设计方案.md，第二版）：正前方一台熔炉、高炉或烟熏炉（每轮随机或指定），物品栏里有 rawSlots 格原料、fuelSlots 格燃料，
 * 把 n 个原料放进原料格、m 个燃料放进燃料格，然后关掉炉子界面。炉子按原版速度工作；不要求等它烧完，也不要求拿产物（K5、K6）。
 *
 * - 物品池（K2）：这台炉子能烧的原料，去掉堆叠上限不是 64 的、本身是燃料的、exclude 里的；燃料去掉堆叠上限不是 64 的、有剩余物的（熔岩桶）、exclude 里的。
 *   燃料不能和产物相同（煤矿石 → 煤 配 煤）：agent 拿了产物，物品栏里的燃料数就算不准
 * - 抽样（K3）：原料按产物分组（16 种带釉陶瓦并成一组），先抽组再抽原料；燃料先在燃烧时长档里等概率抽档，再在档内抽
 * - 放料（K4）：看物品栏少了多少，不看炉子里的数量（放下第一个能点火的东西时燃料就少了 1 个）
 * - 判定（K7）：aborted → lost → overshoot → misplaced → timeout → success / false_success / failed
 * - 到达（K8）：mod 在 tick 里按 expect { cook } 检测，记 reachedAtMs
 */

export const INVENTORY_SLOTS = 36
export const STACK = 64
/** 原料、燃料最多各占几格 */
export const MAX_COOK_SLOTS = 4
export const STATIONS = ['furnace', 'blast_furnace', 'smoker']
/** 炉子 → 配方类型（cooking.json 的 type） */
export const STATION_TYPES = { furnace: 'smelting', blast_furnace: 'blasting', smoker: 'smoking' }
export const STATION_NAMES = { furnace: '熔炉', blast_furnace: '高炉', smoker: '烟熏炉' }

export const COOK_CHOICES = Object.freeze({ station: [...STATIONS, 'random'] })

export const parseTotalSpec = (name, text) => parseRangeSpec(name, MAX_COOK_SLOTS * STACK, text)
export const parseCookSlotsSpec = (name, text) => parseRangeSpec(name, MAX_COOK_SLOTS, text)

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
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

/** data/cooking.json 的配方列表 [{ name, type, input: [ids], result, count, time }] */
export function loadCooking(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(data?.recipes)) throw new Error(`cooking file has no recipes list: ${file}`)
  return data.recipes
}

/** 这台炉子里的燃烧时长：熔炉是基准值，高炉、烟熏炉减半（整数除法，F3） */
export function burnIn(station, base) {
  return station === 'furnace' ? base : Math.floor(base / 2)
}

/** 原料分组键（K3）：16 种带釉陶瓦并成一组，其余按产物 */
export const groupOf = (result) => (result.endsWith('_glazed_terracotta') ? 'glazed_terracotta' : shortId(result))

/**
 * 物品池（K2、K3）。
 * @param {object[]} cooking  cooking.json 的配方
 * @param {object} props      item-props.json 的 items（id → { maxStack, remainder?, burn? }）
 * @returns {{ stations: { [station]: { groups: Array<{ key, inputs: string[] }>, recipe: Map<input, { result, time }>, size } },
 *             bands: Array<{ burn, items: string[] }>, fuels: Map<id, burn> }}
 */
export function cookTables(cooking, props, { exclude = [] } = {}) {
  const excluded = new Set(exclude.map(fullId))
  const prop = (id) => {
    const p = props[id]
    if (!p) throw new Error(`data/item-props.json 里没有 ${id}（重新运行 npm run extract-item-props）`)
    return p
  }
  const stations = {}
  for (const station of STATIONS) {
    const recipe = new Map()
    const groups = new Map()
    for (const r of cooking.filter((x) => x.type === STATION_TYPES[station])) {
      if (r.count !== 1) continue // 1.21.11 的烹饪配方都只产出 1 个（F1）；以后有别的就先不出题
      if (excluded.has(r.result)) continue
      for (const input of r.input) {
        const p = prop(input)
        if (p.maxStack !== STACK || p.burn || excluded.has(input)) continue
        if (recipe.has(input) && recipe.get(input).result !== r.result) throw new Error(`${input} 在${STATION_NAMES[station]}里有两种产物：${recipe.get(input).result}、${r.result}`)
        recipe.set(input, { result: r.result, time: r.time })
        const key = groupOf(r.result)
        if (!groups.has(key)) groups.set(key, new Set())
        groups.get(key).add(input)
      }
    }
    const list = [...groups].map(([key, inputs]) => ({ key, inputs: [...inputs].sort() })).sort((a, b) => a.key.localeCompare(b.key))
    stations[station] = { groups: list, recipe, size: recipe.size }
  }
  const fuels = new Map()
  for (const [id, p] of Object.entries(props)) {
    if (!p.burn || p.maxStack !== STACK || p.remainder || excluded.has(id)) continue
    fuels.set(id, p.burn)
  }
  const byBurn = new Map()
  for (const [id, burn] of [...fuels].sort(([a], [b]) => a.localeCompare(b))) {
    if (!byBurn.has(burn)) byBurn.set(burn, [])
    byBurn.get(burn).push(id)
  }
  const bands = [...byBurn].map(([burn, items]) => ({ burn, items })).sort((a, b) => a.burn - b.burn)
  return { stations, bands, fuels }
}

/** total 个分进 slots 格，每格 [1, 64]，在这个限制下随机 */
function splitSlots(random, total, slots) {
  const out = []
  let left = total
  for (let k = slots; k > 0; k--) {
    const lo = Math.max(1, left - STACK * (k - 1))
    const hi = Math.min(STACK, left - (k - 1))
    const c = k === 1 ? left : between(random, lo, hi)
    out.push(c)
    left -= c
  }
  return out
}

/** 总数的可取范围：给定格数下每格 [1, 64] */
function totalRange(spec, slots) {
  const lo = Math.max(spec.lo, slots)
  const hi = Math.min(spec.hi, slots * STACK)
  return lo <= hi ? { lo, hi } : null
}

/**
 * 出一道题（K3）。随机数抽取顺序：工作站（random 时）→ 原料组 → 原料 → 燃料档 → 燃料（冲突时按 K2 重抽）→ 原料格数 → R → 原料分格
 * → 燃料格数 → F → 燃料分格 → n → m → 格位打乱。
 * @param {object} tables  cookTables 的结果
 * @param {object} options { station, raw: {lo,hi}, fuel: {lo,hi}, rawSlots: {lo,hi}, fuelSlots: {lo,hi}, n: {lo,hi}, m: {lo,hi}, input, fuelItem }
 */
export function sampleCook(tables, seed, options) {
  const random = rng(seed)
  const { input = null, fuelItem = null } = options
  // 工作站：指定原料时只在能烧它的炉子里选
  let station = options.station
  if (station === 'random') {
    const candidates = input ? STATIONS.filter((s) => tables.stations[s].recipe.has(input)) : STATIONS.filter((s) => tables.stations[s].size > 0)
    if (!candidates.length) throw new Error(input ? `没有炉子能烧 ${input}（或者它被物品池排除了）` : '三种炉子的原料池都是空的')
    station = pickOne(random, candidates)
  }
  const pool = tables.stations[station]
  let raw
  if (input) {
    if (!pool.recipe.has(input)) throw new Error(`${STATION_NAMES[station]}的原料池里没有 ${input}（烧不了、堆叠上限不是 64、本身是燃料，或者被 exclude 排除）`)
    raw = input
  } else {
    if (!pool.groups.length) throw new Error(`${STATION_NAMES[station]}的原料池是空的`)
    raw = pickOne(random, pickOne(random, pool.groups).inputs)
  }
  const { result: product, time: cookTicks } = pool.recipe.get(raw)
  const group = groupOf(product)

  // 燃料：燃烧时长档 → 档内一种；不能和产物相同（K2）
  let fuel
  if (fuelItem) {
    if (!tables.fuels.has(fuelItem)) throw new Error(`燃料池里没有 ${fuelItem}（不是燃料、堆叠上限不是 64、有剩余物，或者被 exclude 排除）`)
    if (fuelItem === product) throw new Error(`燃料 ${fuelItem} 和产物相同，物品栏里分不清`)
    fuel = fuelItem
  } else {
    const bands = tables.bands.map((b) => ({ burn: b.burn, items: b.items.filter((id) => id !== product) })).filter((b) => b.items.length)
    if (!bands.length) throw new Error(`没有合适的燃料（产物 ${product}）`)
    fuel = pickOne(random, pickOne(random, bands).items)
  }
  const fuelBase = tables.fuels.get(fuel)

  // 数量：n、m 不超过发下去的总数
  const rawSlots = between(random, options.rawSlots.lo, options.rawSlots.hi)
  const rawRange = totalRange(options.raw, rawSlots)
  if (!rawRange) throw new Error(`raw=${options.raw.lo}-${options.raw.hi} 分不进 ${rawSlots} 格（每格 1–64）`)
  const rawTotal = between(random, rawRange.lo, rawRange.hi)
  const rawCounts = splitSlots(random, rawTotal, rawSlots)
  const fuelSlots = between(random, options.fuelSlots.lo, options.fuelSlots.hi)
  const fuelRange = totalRange(options.fuel, fuelSlots)
  if (!fuelRange) throw new Error(`fuel=${options.fuel.lo}-${options.fuel.hi} 分不进 ${fuelSlots} 格（每格 1–64）`)
  const fuelTotal = between(random, fuelRange.lo, fuelRange.hi)
  const fuelCounts = splitSlots(random, fuelTotal, fuelSlots)
  const nHi = Math.min(options.n.hi, rawTotal)
  if (options.n.lo > nHi) throw new Error(`n 至少 ${options.n.lo}，但只有 ${rawTotal} 个原料`)
  const n = between(random, options.n.lo, nHi)
  const mHi = Math.min(options.m.hi, fuelTotal)
  if (options.m.lo > mHi) throw new Error(`m 至少 ${options.m.lo}，但只有 ${fuelTotal} 个燃料`)
  const m = between(random, options.m.lo, mHi)

  const positions = shuffle(random, Array.from({ length: INVENTORY_SLOTS }, (_, i) => i)).slice(0, rawSlots + fuelSlots)
  const stacks = [...rawCounts.map((count) => ({ id: raw, count })), ...fuelCounts.map((count) => ({ id: fuel, count }))]
  const layout = stacks.map((s, i) => ({ slot: positions[i], id: s.id, count: s.count })).sort((a, b) => a.slot - b.slot)
  return {
    station, product, cookTicks, n, m,
    raw: { id: raw, group, total: rawTotal, slots: rawCounts },
    // band：燃烧时长档（熔炉的基准时长）；burnTicks：这台炉子里的时长
    fuel: { id: fuel, burnTicks: burnIn(station, fuelBase), band: fuelBase, total: fuelTotal, slots: fuelCounts },
    layout, target: raw
  }
}

/** mod 的到达检测（K8）：{ cook: { raw, rawLeft, fuel, fuelLeft, product } } */
export function cookExpect(picked) {
  return { cook: { raw: picked.raw.id, rawLeft: picked.raw.total - picked.n, fuel: picked.fuel.id, fuelLeft: picked.fuel.total - picked.m, product: picked.product } }
}

const total = (counts) => Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0)
const at = (counts, id) => counts?.[id] ?? 0

/**
 * 按 K4、K7 的几处计数核算。final：held（物品栏，不含光标）、carried、dropped、furnace { input, fuel, output, lit }（炉子不在了为 null）、stationIntact。
 * @returns {{ placedRaw, placedFuel, smelted, burned, produced, extra: {id: n}, foreignInput: boolean, foreignFuel: boolean } | null}  炉子不在了 → null
 */
export function cookAccount(final, picked) {
  const furnace = final?.furnace
  if (!final?.held || !furnace) return null
  const { held, carried = {}, dropped = {} } = final
  const raw = picked.raw.id
  const fuel = picked.fuel.id
  const product = picked.product
  const outside = (id) => at(held, id) + at(carried, id) + at(dropped, id)
  const placedRaw = picked.raw.total - outside(raw)
  const placedFuel = picked.fuel.total - outside(fuel)
  const smelted = placedRaw - at(furnace.input, raw)
  const burned = placedFuel - at(furnace.fuel, fuel) - at(furnace.input, fuel)
  const produced = outside(product) + at(furnace.output, product) + at(furnace.input, product) + at(furnace.fuel, product)
  const known = new Set([raw, fuel, product])
  const extra = {}
  for (const counts of [held, carried, dropped, furnace.input, furnace.fuel, furnace.output]) {
    for (const [id, n] of Object.entries(counts ?? {})) if (n > 0 && !known.has(id)) extra[id] = (extra[id] ?? 0) + n
  }
  const foreignInput = Object.keys(furnace.input ?? {}).some((id) => id !== raw)
  const foreignFuel = Object.keys(furnace.fuel ?? {}).some((id) => id !== fuel)
  return { placedRaw, placedFuel, smelted, burned, produced, extra: Object.fromEntries(Object.entries(extra).sort(([a], [b]) => a.localeCompare(b))), foreignInput, foreignFuel }
}

/**
 * 判定（K7）。顺序：aborted → lost → overshoot → misplaced → timeout → success / false_success / failed。
 * - lost：炉子被挖、地上有东西，或者产物总数 ≠ 烧掉的原料数且没有额外物品（被扔出场外等）。产物、原料被做成了别的东西时有额外物品，判 misplaced
 * - overshoot：烧掉的原料 > n 或烧掉的燃料 > m（拿不回来）
 * - misplaced：原料格里有原料以外的东西、燃料格里有燃料以外的东西，或者出现了额外物品
 * - 到达（K8）：放对了并关掉炉子界面就算（final.containerOpen === false）——不看产物格、炉子烧没烧完；产物拿没拿都行
 * @returns {{ outcome, account, reached: boolean }}
 */
export function judgeCook({ stopped, timedOut, taskState, final, picked }) {
  if (stopped) return { outcome: 'aborted', account: null, reached: false }
  const account = cookAccount(final, picked)
  if (!account) {
    const lost = final?.stationIntact === false
    return { outcome: lost ? 'lost' : timedOut ? 'timeout' : 'failed', account: null, reached: false }
  }
  const { held, carried = {}, dropped = {} } = final
  const hasExtra = Object.keys(account.extra).length > 0
  const reached = final.containerOpen === false && total(carried) === 0 &&
    at(held, picked.raw.id) === picked.raw.total - picked.n &&
    at(held, picked.fuel.id) === picked.fuel.total - picked.m &&
    Object.keys(held).every((id) => id === picked.raw.id || id === picked.fuel.id || id === picked.product) &&
    !account.foreignInput && !account.foreignFuel
  let outcome
  if (final.stationIntact === false || total(dropped) > 0 || (account.produced !== account.smelted && !hasExtra)) outcome = 'lost'
  else if (account.smelted > picked.n || account.burned > picked.m) outcome = 'overshoot'
  else if (account.foreignInput || account.foreignFuel || hasExtra) outcome = 'misplaced'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, account, reached }
}

const rangeText = ({ lo, hi }) => (lo === hi ? String(lo) : `${lo}-${hi}`)

export const cook = {
  type: 'cook',
  options: ['station', 'raw', 'fuel', 'rawSlots', 'fuelSlots', 'portions', 'crafts', 'input', 'fuelItem'],

  setup(trainer, arena, arenaConfig, args) {
    if (args.item) throw new Error('熔炉场地用 input= 指定原料、fuelItem= 指定燃料（item= 是合成题、箱子题的选项）')
    const pick = (key, fallback) => args[key] ?? arenaConfig[key] ?? fallback
    const options = {
      station: pick('station', 'random'),
      raw: parseTotalSpec('raw', pick('raw', '64-128')),
      fuel: parseTotalSpec('fuel', pick('fuel', '64-128')),
      rawSlots: parseCookSlotsSpec('rawSlots', pick('rawSlots', 2)),
      fuelSlots: parseCookSlotsSpec('fuelSlots', pick('fuelSlots', 2)),
      // 命令行的 n= / m= 进来叫 portions / crafts（和合成题共用名字），场地配置里写 n / m
      n: parseRangeSpec('n', STACK, args.portions ?? arenaConfig.n ?? '1-64'),
      m: parseRangeSpec('m', STACK, args.crafts ?? arenaConfig.m ?? '1-64'),
      input: args.input ? fullId(args.input) : null,
      fuelItem: args.fuelItem ? fullId(args.fuelItem) : null
    }
    if (!COOK_CHOICES.station.includes(options.station)) throw new Error(`station 只能是 ${COOK_CHOICES.station.join(' / ')}，收到 "${options.station}"`)
    const cooking = trainer.cooking()
    if (!cooking) throw new Error(`熔炉题需要 ${trainer.config.cooking}（在 dsh-plugins/agent 里运行 npm run extract-recipes）`)
    const props = trainer.itemProps()
    if (!props) throw new Error(`熔炉题需要 ${trainer.config.itemProps}（在 dsh-plugins/agent 里运行 npm run extract-item-props）`)
    const tables = cookTables(cooking, props, { exclude: arenaConfig.exclude ?? [] })
    if (!tables.bands.length) throw new Error('燃料池是空的（item-props.json 里没有燃料？重新运行 npm run extract-item-props）')
    const ctx = { arena, arenaConfig, tables, options }
    sampleCook(tables, 0, options) // 选项组合出不了题就当场报错
    return ctx
  },

  startText(ctx) {
    const o = ctx.options
    const sizes = STATIONS.map((s) => `${STATION_NAMES[s]} ${ctx.tables.stations[s].size}`).join('、')
    return `station=${o.station}，raw=${rangeText(o.raw)}（${rangeText(o.rawSlots)} 格），fuel=${rangeText(o.fuel)}（${rangeText(o.fuelSlots)} 格），n=${rangeText(o.n)}，m=${rangeText(o.m)}${o.input ? `，原料 ${o.input}` : ''}${o.fuelItem ? `，燃料 ${o.fuelItem}` : ''}；原料池 ${sizes} 种，燃料 ${ctx.tables.fuels.size} 种（${ctx.tables.bands.length} 档）`
  },

  batchFields() {
    return {}
  },

  sample(ctx, seed) {
    return sampleCook(ctx.tables, seed, ctx.options)
  },

  label(ctx, picked, seed) {
    return `${STATION_NAMES[picked.station]}：放 ${picked.n} 个 ${shortId(picked.raw.id)}、${picked.m} 个 ${shortId(picked.fuel.id)}（seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      station: picked.station, raw: picked.raw, fuel: picked.fuel, product: picked.product, cookTicks: picked.cookTicks,
      n: picked.n, m: picked.m, target: picked.target, layout: picked.layout,
      placedRaw: null, placedFuel: null, smelted: null, burned: null, produced: null, extra: {},
      final: null, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return { station: picked.station, items: picked.layout, seed, watch: [], expect: cookExpect(picked), dayTime: 1000 }
  },

  afterPrepare(ctx, picked, data) {
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the ${picked.station} (aimOk=${data?.aimOk}); check the arena origin`, fields: {} }
    // 服务器端的真实数值和数据文件核对（K8）：不一致说明数据过期
    const server = data?.cook
    const expected = { burnTicks: picked.fuel.burnTicks, cookTicks: picked.cookTicks, product: picked.product, productCount: 1, rawMaxStack: STACK, fuelMaxStack: STACK }
    const diff = server ? Object.entries(expected).filter(([key, value]) => server[key] !== value) : [['cook', 'missing']]
    if (diff.length) {
      const text = diff.map(([key, value]) => `${key}: 数据 ${value} / 服务器 ${server?.[key]}`).join('，')
      return { error: `数据和服务器不一致（${text}）；请重新运行 npm run extract-recipes 和 npm run extract-item-props`, fields: {} }
    }
    return { fields: {} }
  },

  instruction(ctx, picked, prompts) {
    // K11：只说现状和要求（放料、关界面）；不说物品栏里各有多少，不提产物
    return renderTemplate(prompts.training.cook, {
      stationName: STATION_NAMES[picked.station], station: `minecraft:${picked.station}`,
      raw: picked.raw.id, fuel: picked.fuel.id, n: picked.n, m: picked.m
    })
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0 }) {
    const { outcome, account, reached } = judgeCook({ stopped, timedOut, taskState, final, picked })
    const reachedAtMs = final?.reachedAtMs ?? null
    return {
      outcome, reached,
      placedRaw: account?.placedRaw ?? null, placedFuel: account?.placedFuel ?? null, smelted: account?.smelted ?? null,
      burned: account?.burned ?? null, produced: account?.produced ?? null, extra: account?.extra ?? {},
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final ? { held: final.held ?? null, carried: final.carried ?? null, dropped: final.dropped ?? null, furnace: final.furnace ?? null, containerOpen: final.containerOpen ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { station: record.station }
  }
}
