import { renderTemplate } from '../llm/prompts.js'
import { rng } from './sampler.js'
import { STORAGE_CHOICES, parseRangeSpec } from './storage.js'

/**
 * 织布机题型（docs/织布机训练场设计方案.md）：正前方一台织布机，物品栏里有 1–3 种底色的素旗、按目标发的染料（和图案物），
 * 把每种底色的旗做成指定图案、指定颜色的几种样式，每种恰好指定的数量。
 *
 * - 题目来源（L11）：arena/loom-catalog 从注册表读出的素旗、染料、基础图案、图案物，去掉 exclude
 * - 底色（L3）：等概率抽，同一轮互不相同；banner= 固定第一种
 * - 数量（L4）：每种底色占 slots 格（1–3），每格 [1, 16] 随机或取满（fill），合计 N；styles 种样式（不超过 N），每份 ⌊N / 样式数⌋，
 *   每个样式的目标 t 在 [1, 份数] 里随机
 * - 样式（L5）：图案 + 染料颜色，颜色不等于底色，同一底色下两两不同；itemPatterns=on 时每个样式 1/3 改用图案物的图案，发对应的图案物
 * - 发料（L6）：素旗 = 目标之和 + 余量，染料按颜色同理，余量在 spare（0–3）里抽；开局格数 + 目标叠数超过 36 就重抽
 * - 判定（L8）：aborted → lost（织布机被挖、地上有东西、图案物不见了、旗帜总数变少）→ overshoot → misweave（目标以外的带图案旗帜、
 *   开局没有的物品）→ timeout → success / false_success / failed；另算 copied（2×2 复制出来的面数，L10）
 * - 到达（L9）：mod 在 tick 里按 expect { loom } 检测，记 reachedAtMs
 *
 * 计数都按签名（L9）：素的物品是 id，带图案的旗帜是 id#图案/颜色，多层用 + 连接。
 */

export const INVENTORY_SLOTS = 36
export const BANNER_STACK = 16
export const DYE_STACK = 64
export const MAX_BANNERS = 3
export const MAX_SLOTS = 3
export const MAX_STYLES = 3
export const MAX_SPARE = 3
/** itemPatterns=on 时一个样式改用图案物图案的概率（L5） */
export const ITEM_PATTERN_CHANCE = 1 / 3
/** 开局格数 + 目标叠数超过 36 时最多重抽几次（L6） */
export const MAX_RETRIES = 50
/** 同一底色下抽到重复样式时，这一个最多重抽几次；还是重复就少出这一个 */
const MAX_DUPLICATE_DRAWS = 50

export const LOOM_CHOICES = Object.freeze({
  fill: STORAGE_CHOICES.fill,
  itemPatterns: ['off', 'on']
})

export const parseBannersSpec = (text) => parseRangeSpec('banners', MAX_BANNERS, text)
export const parseLoomSlotsSpec = (text) => parseRangeSpec('slots', MAX_SLOTS, text)
export const parseLoomStylesSpec = (text) => parseRangeSpec('styles', MAX_STYLES, text)

/** spare=k|a-b（0–3）：素旗、染料比目标多发几个（L6） */
export function parseSpareSpec(text) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(text))
  const lo = match ? Number(match[1]) : NaN
  const hi = match ? Number(match[2] ?? match[1]) : NaN
  if (!(lo >= 0 && hi <= MAX_SPARE && lo <= hi)) throw new Error(`spare 要写 k 或 a-b（0–${MAX_SPARE}，a ≤ b），收到 "${text}"`)
  return { lo, hi }
}

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

/** 目标的签名（L9）：底色旗帜 + 一层图案 / 颜色 */
export const goalKey = (banner, pattern, color) => `${banner}#${pattern}/${color}`
/** 签名里的物品 id（# 前面那段） */
export const keyId = (key) => key.split('#')[0]
const patterned = (key) => key.includes('#')

/**
 * 题目表（L11）：catalog 去掉 exclude。exclude 里可以写素旗、染料、图案、图案物的 id。
 * 染料去掉了的颜色不当图案颜色；图案物去掉了、或它的图案去掉了，就不出那个图案。
 * @param {{ banners, dyes, patterns, patternItems }} catalog  arena/loom-catalog 的结果
 * @returns {{ banners: {id, color}[], dyeOf: Map<string,string>, colors: string[], patterns: string[], itemPatterns: {item, pattern}[] }}
 */
export function loomTables(catalog, exclude = []) {
  const skip = new Set(exclude.map(fullId))
  const byId = (a, b) => a.id.localeCompare(b.id)
  const banners = (catalog?.banners ?? []).filter((b) => !skip.has(b.id)).sort(byId)
  const dyes = (catalog?.dyes ?? []).filter((d) => !skip.has(d.id)).sort(byId)
  const dyeOf = new Map(dyes.map((d) => [d.color, d.id]))
  const colors = [...dyeOf.keys()].sort()
  const patterns = (catalog?.patterns ?? []).filter((p) => !skip.has(p))
  const itemPatterns = []
  for (const row of [...(catalog?.patternItems ?? [])].sort((a, b) => a.item.localeCompare(b.item))) {
    if (skip.has(row.item)) continue
    for (const pattern of row.patterns ?? []) if (!skip.has(pattern)) itemPatterns.push({ item: row.item, pattern })
  }
  return { banners, dyeOf, colors, patterns, itemPatterns }
}

/**
 * 选项（§5）：命令行的优先，没写的用场地配置。
 * @returns {{ banners: {lo,hi}, slots: {lo,hi}, fill, styles: {lo,hi}, spare: {lo,hi}, itemPatterns: 'off'|'on', banner: string|null }}
 */
export function loomOptions(args = {}, config = {}) {
  const pick = (key, fallback) => args[key] ?? config[key] ?? fallback
  const options = {
    banners: parseBannersSpec(pick('banners', '1-3')),
    slots: parseLoomSlotsSpec(pick('slots', '1-3')),
    fill: pick('fill', 'random'),
    styles: parseLoomStylesSpec(pick('styles', '1-3')),
    spare: parseSpareSpec(pick('spare', '0-3')),
    itemPatterns: pick('itemPatterns', 'off'),
    banner: args.banner ? fullId(args.banner) : null
  }
  for (const [key, choices] of Object.entries(LOOM_CHOICES)) {
    if (!choices.includes(options[key])) throw new Error(`${key} 只能是 ${choices.join(' / ')}，收到 "${options[key]}"`)
  }
  return options
}

/** 题目表和选项对得上：有素旗、有至少两种颜色、有图案；banner= 在素旗里 */
export function checkTables(tables, options) {
  if (!tables.banners.length) throw new Error('没有素旗可出（arena/loom-catalog 没有返回，或者全被 exclude 排除）')
  if (!tables.patterns.length) throw new Error('没有基础图案可出（全被 exclude 排除？）')
  if (tables.colors.length < 2) throw new Error('染料颜色不够（至少要两种：图案颜色不能和底色相同）')
  if (options.banner && !tables.banners.some((b) => b.id === options.banner)) throw new Error(`没有素旗 ${options.banner}（不是旗帜，或者被 exclude 排除）`)
}

/** 把 x 个物品拆成若干叠（L6）：full 时尽量满叠；random 时叠数在 ⌈x/上限⌉ 和它加 1 之间随机（不超过 x），再随机分配 */
function splitStacks(random, x, cap, filling) {
  const min = Math.ceil(x / cap)
  if (filling === 'full') return Array.from({ length: min }, (_, i) => (i < min - 1 ? cap : x - cap * (min - 1)))
  const n = Math.min(x, min + Math.floor(random() * 2))
  const stacks = new Array(n).fill(1)
  for (let left = x - n; left > 0; left--) {
    const room = stacks.map((c, i) => (c < cap ? i : -1)).filter((i) => i >= 0)
    stacks[pickOne(random, room)]++
  }
  return stacks
}

/** 一次抽题（不检查容量）。随机数顺序见 {@link sampleLoom} */
function drawLoom(tables, random, options) {
  const wanted = draw(random, options.banners)
  const filling = options.fill === 'mix' ? pickOne(random, ['random', 'full']) : options.fill
  const used = new Set()
  const banners = []
  for (let i = 0; i < wanted; i++) {
    let base
    if (i === 0 && options.banner) base = tables.banners.find((b) => b.id === options.banner)
    else {
      const left = tables.banners.filter((b) => !used.has(b.id))
      if (!left.length) break
      base = pickOne(random, left)
    }
    used.add(base.id)
    const s = draw(random, options.slots)
    const counts = Array.from({ length: s }, () => (filling === 'full' ? BANNER_STACK : between(random, 1, BANNER_STACK)))
    const scale = counts.reduce((sum, c) => sum + c, 0)
    const hi = Math.min(options.styles.hi, scale)
    const m = draw(random, { lo: Math.min(options.styles.lo, hi), hi })
    const share = Math.floor(scale / m)
    const colors = tables.colors.filter((c) => c !== base.color)
    const styles = []
    const seen = new Set()
    for (let j = 0; j < m; j++) {
      for (let tries = 0; tries < MAX_DUPLICATE_DRAWS; tries++) {
        const useItem = options.itemPatterns === 'on' && tables.itemPatterns.length > 0 && random() < ITEM_PATTERN_CHANCE
        const from = useItem ? pickOne(random, tables.itemPatterns) : { item: null, pattern: pickOne(random, tables.patterns) }
        const color = pickOne(random, colors)
        const want = between(random, 1, share)
        const key = goalKey(base.id, from.pattern, color)
        if (seen.has(key)) continue
        seen.add(key)
        styles.push({ pattern: from.pattern, color, item: from.item, want })
        break
      }
    }
    banners.push({ id: base.id, color: base.color, slots: s, scale, styles })
  }
  // 余量（L6）：逐种底色抽素旗余量，再逐种颜色（按颜色名排序）抽染料余量
  for (const b of banners) b.given = b.styles.reduce((sum, st) => sum + st.want, 0) + draw(random, options.spare)
  const dyeNeed = new Map()
  for (const b of banners) for (const st of b.styles) dyeNeed.set(st.color, (dyeNeed.get(st.color) ?? 0) + st.want)
  const dyes = [...dyeNeed.keys()].sort().map((color) => ({ id: tables.dyeOf.get(color), color, given: dyeNeed.get(color) + draw(random, options.spare) }))
  const patternItems = [...new Set(banners.flatMap((b) => b.styles.map((st) => st.item)).filter(Boolean))].sort()
  const stacks = [
    ...banners.flatMap((b) => splitStacks(random, b.given, BANNER_STACK, filling).map((count) => ({ id: b.id, count }))),
    ...dyes.flatMap((d) => splitStacks(random, d.given, DYE_STACK, filling).map((count) => ({ id: d.id, count }))),
    ...patternItems.map((id) => ({ id, count: 1 }))
  ]
  return { filling, banners, dyes, patternItems, stacks }
}

/**
 * 出一道题（L3–L6）。同一种子同一道题。
 * 随机数的抽取顺序：底色种数 → fill（mix 时）→ 逐种底色（底色 → 格数 → 每格数量 → 样式数 → 逐个样式：是否用图案物 → 图案 → 颜色 → t）
 * → 逐种底色抽素旗余量 → 逐种颜色抽染料余量 → 拆叠 → 打乱格位。开局格数 + 目标叠数超过 36 就用下一个派生种子重抽（retries 记次数）。
 * @returns {{ bannerCount, styleCount, fill, banners: [{ id, color, slots, scale, given, styles: [{ pattern, color, item, want }] }],
 *   dyes: [{ id, color, given }], patternItems: string[], layout: [{ slot, id, count }], target, want, retries }}
 */
export function sampleLoom(tables, seed, options) {
  checkTables(tables, options)
  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    const random = rng((seed + retry * 0x9E3779B9) >>> 0)
    const picked = drawLoom(tables, random, options)
    const endStacks = picked.banners.reduce((sum, b) => sum + b.styles.reduce((n, st) => n + Math.ceil(st.want / BANNER_STACK), 0), 0)
    if (picked.stacks.length + endStacks > INVENTORY_SLOTS) continue
    const positions = shuffle(random, Array.from({ length: INVENTORY_SLOTS }, (_, i) => i)).slice(0, picked.stacks.length)
    const layout = picked.stacks.map((s, i) => ({ slot: positions[i], id: s.id, count: s.count })).sort((a, b) => a.slot - b.slot)
    const first = picked.banners[0]
    const [style] = first.styles
    return {
      bannerCount: picked.banners.length,
      styleCount: picked.banners.reduce((sum, b) => sum + b.styles.length, 0),
      fill: picked.filling, banners: picked.banners, dyes: picked.dyes, patternItems: picked.patternItems, layout,
      target: goalKey(first.id, style.pattern, style.color), want: style.want, retries: retry
    }
  }
  throw new Error(`物品栏放不下：连续 ${MAX_RETRIES + 1} 次抽到的题开局格数加目标叠数都超过 ${INVENTORY_SLOTS}`)
}

/** 本轮的全部目标（展平）：[{ key, banner, pattern, color, item, want }] */
export function goalsOf(picked) {
  return picked.banners.flatMap((b) => b.styles.map((st) => ({ key: goalKey(b.id, st.pattern, st.color), banner: b.id, ...st })))
}

/** 开局发的全部物品 id（素旗、染料、图案物） */
export function givenIds(picked) {
  return [...new Set([...picked.banners.map((b) => b.id), ...picked.dyes.map((d) => d.id), ...picked.patternItems])].sort()
}

/** mod 的到达检测（L9）：{ loom: { goals: [{ banner, pattern, color, count }], allowed } } */
export function loomExpect(picked) {
  return { loom: { goals: goalsOf(picked).map((g) => ({ banner: g.banner, pattern: g.pattern, color: g.color, count: g.want })), allowed: givenIds(picked) } }
}

const total = (counts) => Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0)

function addCounts(...maps) {
  const out = {}
  for (const map of maps) for (const [key, n] of Object.entries(map ?? {})) out[key] = (out[key] ?? 0) + n
  return out
}

const sumWhere = (counts, test) => Object.entries(counts ?? {}).reduce((sum, [key, n]) => sum + (test(key) ? n : 0), 0)
const isBanner = (key) => keyId(key).endsWith('_banner')
const isDye = (key) => keyId(key).endsWith('_dye')

/**
 * 判定（L8）。final 是 arena/finish（或最后一次 arena/status）的数据：held（物品栏，不含光标）、carried、loomInput、dropped、stationIntact，
 * 都按签名计数。四处合计按"物品栏 + 光标 + 输入格"算（关界面时光标和输入格都会退回物品栏）；剩多少素旗、染料不判。
 * copied（L10）：做出的带图案旗帜总数 − 用掉的染料数（织布机每面耗 1 份染料，2×2 复制不耗），不小于 0。
 * @returns {{ outcome, madeOf: {key: n} | null, extra: {key: n}, copied: number|null, reached: boolean }}
 */
export function judgeLoom({ stopped, timedOut, taskState, final, picked }) {
  const none = { madeOf: null, extra: {}, copied: null, reached: false }
  if (stopped) return { outcome: 'aborted', ...none }
  if (!final?.held) return { outcome: timedOut ? 'timeout' : 'failed', ...none }
  const held = final.held
  const carried = final.carried ?? {}
  const input = final.loomInput ?? {}
  const dropped = final.dropped ?? {}
  const all = addCounts(held, carried, input)
  const goals = goalsOf(picked)
  const goalKeys = new Set(goals.map((g) => g.key))
  const allowed = new Set(givenIds(picked))
  const madeOf = Object.fromEntries(goals.map((g) => [g.key, all[g.key] ?? 0]))
  const extra = Object.fromEntries(Object.entries(all)
    .filter(([key, n]) => n > 0 && (patterned(key) ? !goalKeys.has(key) : !allowed.has(key)))
    .sort(([a], [b]) => a.localeCompare(b)))
  const everywhere = addCounts(all, dropped)
  const bannersGiven = picked.banners.reduce((sum, b) => sum + b.given, 0)
  const dyesGiven = picked.dyes.reduce((sum, d) => sum + d.given, 0)
  const dyeUsed = dyesGiven - sumWhere(everywhere, isDye)
  const copied = Math.max(0, sumWhere(everywhere, patterned) - dyeUsed)
  const reached = goals.every((g) => (held[g.key] ?? 0) === g.want && !input[g.key]) && total(carried) === 0 && Object.keys(extra).length === 0
  const lost = final.stationIntact === false || total(dropped) > 0
    || sumWhere(all, isBanner) < bannersGiven
    || picked.patternItems.some((id) => !(all[id] > 0))
  let outcome
  if (lost) outcome = 'lost'
  else if (goals.some((g) => madeOf[g.key] > g.want)) outcome = 'overshoot'
  else if (Object.keys(extra).length) outcome = 'misweave'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, madeOf, extra, copied, reached }
}

/** 一个样式的文案（L7）：5 面加了 red 色 minecraft:stripe_bottom 图案的 */
const styleText = (st) => `${st.want} 面加了 ${st.color} 色 ${st.pattern} 图案的`
/** 一个样式的简写（label、记录）：5 面 stripe_bottom/red */
const styleLabel = (st) => `${st.want} 面 ${shortId(st.pattern)}/${st.color}${st.item ? '（图案物）' : ''}`
const rangeText = ({ lo, hi }) => (lo === hi ? String(lo) : `${lo}-${hi}`)

export const loom = {
  type: 'loom',
  options: ['banners', 'slots', 'fill', 'styles', 'spare', 'itemPatterns', 'banner'],

  setup(trainer, arena, arenaConfig, args) {
    if (args.item || args.material) throw new Error('织布机场地用 banner= 固定第一种底色（item= / material= 是别的场地的选项）')
    return { arena, arenaConfig, tables: null, options: loomOptions(args, arenaConfig) }
  },

  startText(ctx) {
    const o = ctx.options
    return `${o.banner ? `第一种底色 ${o.banner}，` : ''}banners=${rangeText(o.banners)}，slots=${rangeText(o.slots)}，fill=${o.fill}，styles=${rangeText(o.styles)}，spare=${rangeText(o.spare)}，itemPatterns=${o.itemPatterns}`
  },

  batchFields() {
    return {}
  },

  /** 题目来源要问 mod，抽题放在 preview 里做（L11） */
  sample(ctx, seed) {
    return { seed }
  },

  /** 第一次先读 catalog（L11），再抽题 */
  async preview(ctx, picked, seed, call) {
    if (!ctx.tables) {
      const res = await call('arena/loom-catalog', {})
      if (!res?.ok) throw new Error(`arena/loom-catalog: ${res?.error ?? 'no response'}`)
      ctx.tables = loomTables(res.data, ctx.arenaConfig.exclude ?? [])
    }
    return sampleLoom(ctx.tables, seed, ctx.options)
  },

  label(ctx, picked, seed) {
    const groups = picked.banners.map((b) => `${shortId(b.id)} 做 ${b.styles.map(styleLabel).join('、')}`)
    return `${groups.join('；')}（${picked.bannerCount} 种底色，${picked.styleCount} 种样式${picked.fill === 'full' ? '，每格满' : ''}，seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      bannerCount: picked.bannerCount, styleCount: picked.styleCount, fill: picked.fill, target: picked.target, want: picked.want,
      banners: picked.banners.map((b) => ({ ...b, styles: b.styles.map((st) => ({ ...st, made: null })) })),
      dyes: picked.dyes.map((d) => ({ ...d, used: null })), patternItems: picked.patternItems, retries: picked.retries ?? 0,
      layout: picked.layout, final: null, made: null, extra: {}, copied: null, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return { station: 'loom', items: picked.layout, seed, watch: [], expect: loomExpect(picked), dayTime: 1000 }
  },

  afterPrepare(ctx, picked, data) {
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the loom (aimOk=${data?.aimOk}); check the arena origin`, fields: {} }
    return { fields: {} }
  },

  instruction(ctx, picked, prompts) {
    // L7：只说现状和要求；按底色分组列出目标，不提染料、图案物和怎么操作
    const banners = picked.banners.map((b) => b.id).join('、')
    const list = picked.banners.map((b) => `用 ${b.id} 做 ${b.styles.map(styleText).join('、')}`).join('；')
    return renderTemplate(prompts.training.loom, { banners, list })
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0 }) {
    const { outcome, madeOf, extra, copied, reached } = judgeLoom({ stopped, timedOut, taskState, final, picked })
    const reachedAtMs = final?.reachedAtMs ?? null
    const left = final ? addCounts(final.held, final.carried, final.loomInput, final.dropped) : null
    return {
      outcome, made: madeOf ? madeOf[picked.target] : null, extra, copied, reached,
      banners: picked.banners.map((b) => ({ ...b, styles: b.styles.map((st) => ({ ...st, made: madeOf ? madeOf[goalKey(b.id, st.pattern, st.color)] : null })) })),
      dyes: picked.dyes.map((d) => ({ ...d, used: left ? d.given - (left[d.id] ?? 0) : null })),
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final ? { inventory: final.held ?? null, carried: final.carried ?? null, loomInput: final.loomInput ?? null, dropped: final.dropped ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { bannerCount: record.bannerCount, styleCount: record.styleCount, copied: record.copied ?? null }
  }
}
