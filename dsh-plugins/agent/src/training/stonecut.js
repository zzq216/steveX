import fs from 'node:fs'

import { renderTemplate } from '../llm/prompts.js'
import { fitsGrid, rng } from './sampler.js'
import { STORAGE_CHOICES, parseRangeSpec } from './storage.js'

/**
 * 切石题型（docs/切石机训练场设计方案.md）：正前方一台切石机，物品栏里有 1–3 种材料，把每种材料切成指定数量的几种样式，不多不少。
 *
 * - 材料池（Q3）：data/stonecutting.json 的全部材料，去掉 exclude、去掉一种样式都切不出来的；先在家族里等概率抽，再在家族里抽材料。
 *   家族 = 能互相切出、或能切出同一种产物的材料；铜的氧化阶段与打蜡版本并成一个家族
 * - 2×2 捷径（Q4）：bypass=exclude（缺省）时，物品栏 2×2 合成用同一种材料就能直接做出的产物不出题
 * - 每轮（Q5）：materials 种材料、同一家族最多一种；每种占 slots 格，每格 [1, 64] 随机或取满（fill）
 * - 每种材料（Q6）：styles 种样式（不超过能切出的样式数和材料数 N），每份 ⌊N / 样式数⌋；每份消耗 c 个材料，
 *   目标 t = c × 每次产出；c 的上限还要让剩下的材料加全部产物装得下物品栏（每个样式最多 b = ⌊(36 − 材料格数) / 样式总数⌋ 格）
 * - 判定（Q8）：aborted → lost（切石机被挖、地上有东西）→ overshoot → miscut（出现题目没要的产物）→ timeout → success / false_success / failed
 * - 到达（Q9）：mod 在 tick 里按 expect { targets, allowed } 检测，记 reachedAtMs
 */

export const INVENTORY_SLOTS = 36
export const MAX_MATERIALS = 3
export const MAX_SLOTS = 9
export const MAX_STYLES = 3

export const STONECUT_CHOICES = Object.freeze({
  fill: STORAGE_CHOICES.fill,
  bypass: ['exclude', 'keep']
})

export const parseMaterialsSpec = (text) => parseRangeSpec('materials', MAX_MATERIALS, text)
export const parseSlotsSpec = (text) => parseRangeSpec('slots', MAX_SLOTS, text)
export const parseStylesSpec = (text) => parseRangeSpec('styles', MAX_STYLES, text)

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

/** data/stonecutting.json 的配方列表 [{ name, input, result, count }] */
export function loadStonecutting(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(data?.recipes)) throw new Error(`stonecutting file has no recipes list: ${file}`)
  return data.recipes
}

/**
 * 2×2 捷径（Q4）：recipes.json 里放得进 2×2、每个材料位都能放材料 m 的配方，记为 "m>产物"。
 * 只算"同一种材料直接做出"——先 2×2 做中间产物再上切石机，仍然用到了切石机，不拦。
 */
export function bypassPairs(recipes) {
  const out = new Set()
  for (const r of recipes) {
    if (!fitsGrid(r, 2)) continue
    const slots = r.type === 'shaped' ? Object.values(r.key) : r.ingredients
    if (!slots.length) continue
    for (const id of slots[0]) if (slots.every((list) => list.includes(id))) out.add(`${id}>${r.result}`)
  }
  return out
}

/**
 * 家族（Q3）：材料 A 能切出材料 B，或 A、B 能切出同一种产物，就是一家；铜的氧化阶段（exposed_ / weathered_ / oxidized_）
 * 与打蜡版本（waxed_）去掉前缀后同名的也并成一家。家族名取不是同家族别的材料切出来的那种材料（去掉这些前缀；有几种时取字典序最小的）。
 * @returns {Map<string, string>}  材料 id → 家族名
 */
export function cutterFamilies(recipes) {
  const inputs = [...new Set(recipes.map((r) => r.input))].sort()
  const parent = new Map(inputs.map((id) => [id, id]))
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)))
  const union = (a, b) => parent.set(find(a), find(b))
  const byOutput = new Map()
  for (const r of recipes) {
    if (parent.has(r.result)) union(r.input, r.result)
    if (!byOutput.has(r.result)) byOutput.set(r.result, [])
    byOutput.get(r.result).push(r.input)
  }
  for (const list of byOutput.values()) for (const id of list) union(id, list[0])
  const base = (id) => shortId(id).replace(/^waxed_/, '').replace(/^(exposed|weathered|oxidized)_/, '')
  // 材料本身去掉前缀后同名，或切出的产物去掉前缀后同名（斑驳铜 → 斑驳切制铜、铜块 → 切制铜），都并成一家
  const byBase = new Map()
  const join = (key, id) => (byBase.has(key) ? union(id, byBase.get(key)) : byBase.set(key, id))
  for (const id of inputs) join(`in:${base(id)}`, id)
  for (const r of recipes) join(`out:${base(r.result)}`, r.input)
  // 家族名：优先取不是同家族别的材料切出来的那种（石头而不是石砖），再按去掉前缀后的字典序
  const madeInFamily = new Set(recipes.filter((r) => parent.has(r.result) && find(r.input) === find(r.result)).map((r) => r.result))
  const rank = (id) => `${madeInFamily.has(id) ? 1 : 0}${base(id)}`
  const best = new Map()
  for (const id of inputs) {
    const root = find(id)
    if (!best.has(root) || rank(id) < rank(best.get(root))) best.set(root, id)
  }
  return new Map(inputs.map((id) => [id, base(best.get(find(id)))]))
}

/**
 * 出题用的表（setup 里算一次）。
 * @param {object[]} cutting   loadStonecutting()
 * @param {object[]|null} crafting  recipes.json（bypass=exclude 时用来找 2×2 捷径；keep 时可以为 null）
 * @param {{ exclude?: string[], bypass?: 'exclude'|'keep', props?: object|null }} options  exclude 同时作用于材料和产物
 * @returns {{ pool: string[], outputs: Map<string, {id, yield}[]>, familyOf: Map<string,string>, members: Map<string,string[]>, families: string[], stackOf: (id) => number }}
 */
export function cutterTables(cutting, crafting, { exclude = [], bypass = 'exclude', props = null } = {}) {
  const skip = new Set(exclude.map(fullId))
  const shortcut = bypass === 'exclude' ? bypassPairs(crafting ?? []) : new Set()
  const outputs = new Map()
  for (const r of [...cutting].sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip.has(r.input) || skip.has(r.result) || shortcut.has(`${r.input}>${r.result}`)) continue
    if (!outputs.has(r.input)) outputs.set(r.input, [])
    const list = outputs.get(r.input)
    if (!list.some((o) => o.id === r.result)) list.push({ id: r.result, yield: r.count })
  }
  const familyOf = cutterFamilies(cutting)
  const pool = [...outputs.keys()].sort()
  const members = new Map()
  for (const id of pool) {
    const fam = familyOf.get(id)
    if (!members.has(fam)) members.set(fam, [])
    members.get(fam).push(id)
  }
  const families = [...members.keys()].sort()
  const stackOf = (id) => props?.[id]?.maxStack ?? 64
  return { pool, outputs, familyOf, members, families, stackOf }
}

/**
 * 出一道题（Q5、Q6）。同一种子同一道题。
 * 随机数的抽取顺序：材料种数（写成范围时）→ fill（mix 时）→ 逐种材料（家族 → 材料 → 格数（范围时）→ 每格数量 → 样式数（范围时）→ 选样式）
 * → 逐个样式抽 c → 打乱格位。
 * @param {ReturnType<typeof cutterTables>} tables
 * @param {number} seed
 * @param {{ materials: {lo,hi}, slots: {lo,hi}, fill: 'random'|'full'|'mix', styles: {lo,hi}, material?: string|null }} options
 * @returns {{ materialCount, targetCount, fill, materials: [{ id, family, slots, count, styles: [{ id, yield, uses, want }] }], layout: [{ slot, id, count }], target, want }}
 */
export function sampleStonecut(tables, seed, { materials = { lo: 1, hi: 3 }, slots = { lo: 1, hi: 9 }, fill = 'random', styles = { lo: 1, hi: 3 }, material = null } = {}) {
  const { pool, outputs, familyOf, members, families, stackOf } = tables
  const random = rng(seed)
  const wanted = materials.lo === materials.hi ? materials.lo : between(random, materials.lo, materials.hi)
  const filling = fill === 'mix' ? pickOne(random, ['random', 'full']) : fill
  const used = new Set()
  const chosen = []
  for (let i = 0; i < wanted; i++) {
    let id
    if (i === 0 && material) {
      id = fullId(material)
      if (!outputs.has(id)) throw new Error(`材料池里没有 ${id}`)
    } else {
      // 同一家族最多一种（Q5）：剩下的家族不够时减少材料种数
      const left = families.filter((f) => !used.has(f))
      if (!left.length) break
      id = pickOne(random, members.get(pickOne(random, left)))
    }
    used.add(familyOf.get(id))
    const s = slots.lo === slots.hi ? slots.lo : between(random, slots.lo, slots.hi)
    const counts = Array.from({ length: s }, () => (filling === 'full' ? stackOf(id) : between(random, 1, stackOf(id))))
    const n = counts.reduce((sum, c) => sum + c, 0)
    const options = outputs.get(id)
    const hi = Math.min(styles.hi, options.length, n)
    const lo = Math.min(styles.lo, hi)
    const m = lo === hi ? lo : between(random, lo, hi)
    const picks = shuffle(random, options).slice(0, m)
    chosen.push({ id, family: familyOf.get(id), slots: s, counts, count: n, share: Math.floor(n / m), picks })
  }

  // 物品栏容量（Q6）：每个样式最多 b 格产物，材料格 + 全部产物格 ≤ 36
  const materialSlots = chosen.reduce((sum, m) => sum + m.slots, 0)
  const styleCount = chosen.reduce((sum, m) => sum + m.picks.length, 0)
  const perStyle = Math.floor((INVENTORY_SLOTS - materialSlots) / styleCount)
  if (perStyle < 1) throw new Error(`物品栏放不下：材料占 ${materialSlots} 格，${styleCount} 种样式`)
  const list = chosen.map((m) => ({
    id: m.id, family: m.family, slots: m.slots, count: m.count,
    styles: m.picks.map((p) => {
      const cap = Math.min(m.share, Math.floor((stackOf(p.id) * perStyle) / p.yield))
      if (cap < 1) throw new Error(`${p.id} 每次产出 ${p.yield} 个，${perStyle} 格放不下`)
      const uses = between(random, 1, cap)
      return { id: p.id, yield: p.yield, uses, want: uses * p.yield }
    })
  }))

  const positions = shuffle(random, Array.from({ length: INVENTORY_SLOTS }, (_, i) => i)).slice(0, materialSlots)
  const stacks = chosen.flatMap((m) => m.counts.map((count) => ({ id: m.id, count })))
  const layout = stacks.map((s, i) => ({ slot: positions[i], id: s.id, count: s.count })).sort((a, b) => a.slot - b.slot)
  const [first] = list[0].styles
  return { materialCount: list.length, targetCount: styleCount, fill: filling, materials: list, layout, target: first.id, want: first.want }
}

/** 本轮的全部样式（展平） */
export function stylesOf(picked) {
  return picked.materials.flatMap((m) => m.styles)
}

/** mod 的到达检测（Q9）：{ targets: { 样式: t }, allowed: 全部材料和样式 } */
export function cutterExpect(picked) {
  const targets = Object.fromEntries(stylesOf(picked).map((s) => [s.id, s.want]))
  const allowed = [...new Set([...picked.materials.map((m) => m.id), ...Object.keys(targets)])].sort()
  return { targets, allowed }
}

const total = (counts) => Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0)

function addCounts(...maps) {
  const out = {}
  for (const map of maps) for (const [id, n] of Object.entries(map ?? {})) out[id] = (out[id] ?? 0) + n
  return out
}

/**
 * 判定（Q8）。final 是 arena/finish（或最后一次 arena/status）的数据：held（物品栏，不含光标）、carried、cutterInput、dropped、stationIntact。
 * 顺序：aborted → lost → overshoot → miscut → timeout → success / false_success / failed。
 * 四处合计按"物品栏 + 光标 + 输入格"算（关界面时光标和输入格都会退回物品栏）；剩多少材料不判。
 * @returns {{ outcome, madeOf: {id: n} | null, extra: {id: n}, reached: boolean }}
 */
export function judgeStonecut({ stopped, timedOut, taskState, final, picked }) {
  const none = { madeOf: null, extra: {}, reached: false }
  if (stopped) return { outcome: 'aborted', ...none }
  if (!final?.held) return { outcome: timedOut ? 'timeout' : 'failed', ...none }
  const held = final.held
  const carried = final.carried ?? {}
  const input = final.cutterInput ?? {}
  const all = addCounts(held, carried, input)
  const goals = stylesOf(picked)
  const madeOf = Object.fromEntries(goals.map((g) => [g.id, all[g.id] ?? 0]))
  const allowed = new Set(cutterExpect(picked).allowed)
  const extra = Object.fromEntries(Object.entries(all).filter(([id, n]) => n > 0 && !allowed.has(id)).sort(([a], [b]) => a.localeCompare(b)))
  const reached = goals.every((g) => (held[g.id] ?? 0) === g.want && !input[g.id]) && total(carried) === 0 && Object.keys(extra).length === 0
  const lost = final.stationIntact === false || total(final.dropped) > 0
  let outcome
  if (lost) outcome = 'lost'
  else if (goals.some((g) => madeOf[g.id] > g.want)) outcome = 'overshoot'
  else if (Object.keys(extra).length) outcome = 'miscut'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, madeOf, extra, reached }
}

const rangeText = ({ lo, hi }) => (lo === hi ? String(lo) : `${lo}-${hi}`)

export const stonecut = {
  type: 'stonecut',
  options: ['materials', 'slots', 'fill', 'styles', 'bypass', 'material'],

  setup(trainer, arena, arenaConfig, args) {
    if (args.item) throw new Error('切石机场地用 material= 指定第一种材料（item= 是合成题、箱子题的选项）')
    const pick = (key, fallback) => args[key] ?? arenaConfig[key] ?? fallback
    const options = {
      materials: parseMaterialsSpec(pick('materials', '1-3')),
      slots: parseSlotsSpec(pick('slots', '1-9')),
      fill: pick('fill', 'random'),
      styles: parseStylesSpec(pick('styles', '1-3')),
      bypass: pick('bypass', 'exclude'),
      material: args.material ? fullId(args.material) : null
    }
    for (const [key, choices] of Object.entries(STONECUT_CHOICES)) {
      if (!choices.includes(options[key])) throw new Error(`${key} 只能是 ${choices.join(' / ')}，收到 "${options[key]}"`)
    }
    const cutting = trainer.stonecutting()
    if (!cutting) throw new Error(`切石题需要 ${trainer.config.stonecutting}（在 dsh-plugins/agent 里运行 npm run extract-recipes）`)
    const crafting = options.bypass === 'exclude' ? trainer.recipes() : null
    const tables = cutterTables(cutting, crafting, { exclude: arenaConfig.exclude ?? [], bypass: options.bypass, props: trainer.itemProps() })
    if (!tables.pool.length) throw new Error('材料池是空的（exclude 把材料都排除了？）')
    if (options.material && !tables.pool.includes(options.material)) throw new Error(`材料池里没有 ${options.material}（不是切石材料、被 exclude 排除，或者能切出的样式都被 bypass=exclude 排除了）`)
    const ctx = { arena, arenaConfig, tables, options }
    sampleStonecut(tables, 0, options) // 选项组合出不了题就当场报错
    return ctx
  },

  startText(ctx) {
    const o = ctx.options
    return `${o.material ? `第一种材料 ${o.material}，` : ''}materials=${rangeText(o.materials)}，slots=${rangeText(o.slots)}，fill=${o.fill}，styles=${rangeText(o.styles)}，bypass=${o.bypass}，材料池 ${ctx.tables.pool.length} 种（${ctx.tables.families.length} 个家族）`
  },

  batchFields() {
    return {}
  },

  sample(ctx, seed) {
    return sampleStonecut(ctx.tables, seed, ctx.options)
  },

  label(ctx, picked, seed) {
    const groups = picked.materials.map((m) => `用 ${m.id}（${m.count} 个）切 ${m.styles.map((s) => `${s.want} 个 ${s.id}${s.yield > 1 ? `（×${s.yield}，${s.uses} 份）` : ''}`).join('、')}`)
    return `${groups.join('；')}（${picked.materialCount} 种材料，${picked.targetCount} 种样式${picked.fill === 'full' ? '，每格满' : ''}，seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      materialCount: picked.materialCount, targetCount: picked.targetCount, fill: picked.fill, target: picked.target, want: picked.want,
      materials: picked.materials.map((m) => ({ ...m, styles: m.styles.map((s) => ({ ...s, made: null })) })),
      layout: picked.layout, final: null, made: null, extra: {}, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return { station: 'stonecutter', items: picked.layout, seed, watch: [], expect: cutterExpect(picked), dayTime: 1000 }
  },

  afterPrepare(ctx, picked, data) {
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the stonecutter (aimOk=${data?.aimOk}); check the arena origin`, fields: {} }
    return { fields: {} }
  },

  instruction(ctx, picked, prompts) {
    // Q7：只说现状和要求；按材料分组列出（同一轮的材料来自不同家族，产物不重叠）
    const materials = picked.materials.map((m) => m.id).join('、')
    const list = picked.materials.map((m) => `用 ${m.id} 切 ${m.styles.map((s) => `${s.want} 个 ${s.id}`).join('、')}`).join('；')
    return renderTemplate(prompts.training.stonecut, { materials, list })
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0 }) {
    const { outcome, madeOf, extra, reached } = judgeStonecut({ stopped, timedOut, taskState, final, picked })
    const reachedAtMs = final?.reachedAtMs ?? null
    return {
      outcome, made: madeOf ? madeOf[picked.target] : null, extra, reached,
      materials: picked.materials.map((m) => ({ ...m, styles: m.styles.map((s) => ({ ...s, made: madeOf ? madeOf[s.id] : null })) })),
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final ? { inventory: final.held ?? null, carried: final.carried ?? null, cutterInput: final.cutterInput ?? null, dropped: final.dropped ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { materialCount: record.materialCount, targetCount: record.targetCount }
  }
}
