import { renderTemplate } from '../llm/prompts.js'
import { rng } from './sampler.js'

/**
 * 附魔台题型（docs/附魔台训练场设计方案.md）：正前方一台附魔台，同层外圈摆书架；物品栏里有一件可附魔的物品和 64 个青金石，
 * 经验设成 xpLevel 级。要求把这件物品附魔成带有附魔 p、等级 m 的物品，然后关掉界面。
 *
 * - 物品池（N3）：item-props.json 里有 enchantable 的物品（77 种），去掉附魔台出不了附魔的（enchantingTable: false）和 exclude；
 *   按 16 类分组，先抽类再抽材质
 * - 出题（N5）：先用 arena/enchant-preview 按物品、附魔种子、书架数算出三档，再选目标：可用档的提示 (p, m) 里，
 *   三档实际结果中只有这一档含有 (p, m) 的才是候选；没有候选就换一件物品（seed + 1、+ 2……，最多 MAX_RETRIES 次）
 * - 判定（N7）：aborted → lost → misenchanted → timeout → success / false_success / failed
 * - 到达（N8）：mod 在 tick 里按 expect { enchant } 检测，记 reachedAtMs
 */

export const INVENTORY_SLOTS = 36
export const LAPIS = 'minecraft:lapis_lazuli'
export const LAPIS_COUNT = 64
export const MAX_SHELVES = 15
export const MAX_RETRIES = 10
export const MAX_XP_LEVEL = 1000

/** 物品类别（N3），按这个顺序分组 */
export const KINDS = ['sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'spear', 'helmet', 'chestplate', 'leggings', 'boots', 'bow', 'crossbow', 'trident', 'mace', 'fishing_rod', 'book']
export const KIND_NAMES = {
  sword: '剑', pickaxe: '镐', axe: '斧', shovel: '锹', hoe: '锄', spear: '矛', helmet: '头盔', chestplate: '胸甲', leggings: '护腿', boots: '靴子',
  bow: '弓', crossbow: '弩', trident: '三叉戟', mace: '重锤', fishing_rod: '钓鱼竿', book: '书'
}
const MATERIALS = ['wooden', 'stone', 'copper', 'iron', 'golden', 'diamond', 'netherite', 'leather', 'chainmail', 'turtle']

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const fullId = (id) => (id.includes(':') ? id : `minecraft:${id}`)
const shortId = (id) => id.replace(/^minecraft:/, '')

export function parseBookshelves(text) {
  const n = Number(text)
  if (!(Number.isInteger(n) && n >= 0 && n <= MAX_SHELVES)) throw new Error(`bookshelves 要是 0–${MAX_SHELVES} 的整数，收到 "${text}"`)
  return n
}

export function parseXpLevel(text) {
  const n = Number(text)
  if (!(Number.isInteger(n) && n >= 0 && n <= MAX_XP_LEVEL)) throw new Error(`xpLevel 要是 0–${MAX_XP_LEVEL} 的整数，收到 "${text}"`)
  return n
}

/** 物品 id → { kind, material }：minecraft:golden_pickaxe → 镐、金；minecraft:bow → 弓、没有材质。认不出 → null */
export function kindOf(id) {
  const name = shortId(id)
  if (KINDS.includes(name)) return { kind: name, material: null }
  const at = name.indexOf('_')
  if (at < 0) return null
  const material = name.slice(0, at)
  const kind = name.slice(at + 1)
  return MATERIALS.includes(material) && KINDS.includes(kind) ? { kind, material } : null
}

/** 附魔后的物品 id：书变附魔书（EnchantmentMenu.clickMenuButton 153–156 行），其余不变 */
export const resultOf = (item) => (item === 'minecraft:book' ? 'minecraft:enchanted_book' : item)

/**
 * 物品池（N3）。
 * @param {object} props  item-props.json 的 items
 * @returns {{ groups: Array<{ kind, items: Array<{ id, material }> }>, ids: string[] }}
 */
export function enchantTables(props, { exclude = [] } = {}) {
  const excluded = new Set(exclude.map(fullId))
  const byKind = new Map()
  for (const [id, p] of Object.entries(props).sort(([a], [b]) => a.localeCompare(b))) {
    if (p.enchantable === undefined || p.enchantingTable === false || excluded.has(id)) continue
    const info = kindOf(id)
    if (!info) throw new Error(`认不出 ${id} 的物品类别（附魔台训练场设计方案 N3）`)
    if (!byKind.has(info.kind)) byKind.set(info.kind, [])
    byKind.get(info.kind).push({ id, material: info.material })
  }
  const groups = KINDS.filter((k) => byKind.has(k)).map((kind) => ({ kind, items: byKind.get(kind) }))
  return { groups, ids: groups.flatMap((g) => g.items.map((i) => i.id)) }
}

/**
 * 抽一件物品和这一轮的附魔种子（N3、N5）。随机数抽取顺序：类别 → 材质 → 附魔种子 → 物品格位、青金石格位 → 选目标用的随机数。
 * @param {{ item?: string|null }} options
 */
export function sampleEnchant(tables, seed, { item = null } = {}) {
  const random = rng(seed)
  let chosen
  if (item) {
    const found = tables.groups.flatMap((g) => g.items.map((i) => ({ ...i, kind: g.kind }))).find((i) => i.id === item)
    if (!found) throw new Error(`物品池里没有 ${item}（不能上附魔台，或者被 exclude 排除）`)
    chosen = found
  } else {
    if (!tables.groups.length) throw new Error('物品池是空的（item-props.json 里没有 enchantable？重新运行 npm run extract-item-props）')
    const group = pickOne(random, tables.groups)
    chosen = { ...pickOne(random, group.items), kind: group.kind }
  }
  const enchantSeed = Math.floor(random() * 0x100000000) | 0
  const slots = []
  while (slots.length < 2) {
    const slot = Math.floor(random() * INVENTORY_SLOTS)
    if (!slots.includes(slot)) slots.push(slot)
  }
  const layout = [{ slot: slots[0], id: chosen.id, count: 1 }, { slot: slots[1], id: LAPIS, count: LAPIS_COUNT }].sort((a, b) => a.slot - b.slot)
  return { item: { id: chosen.id, kind: chosen.kind, material: chosen.material }, enchantSeed, layout, choice: random() }
}

const sameEnchantment = (a, b) => a.enchantment === b.enchantment && a.level === b.level

/**
 * 选目标（N5）：可用的档（cost > 0、有提示）里，提示 (p, m) 只出现在这一档实际结果中的，作为候选；按 choice 从候选里挑一个。
 * @param {Array<{ slot, cost, clue, result }>} offers  预览的三档
 * @returns {{ slot, enchantment, level } | null}
 */
export function chooseTarget(offers, choice) {
  const candidates = offers.filter((o) => o.cost > 0 && o.clue && offers.filter((x) => (x.result ?? []).some((e) => sameEnchantment(e, o.clue))).length === 1 && (o.result ?? []).some((e) => sameEnchantment(e, o.clue)))
  if (!candidates.length) return null
  const pick = candidates[Math.min(candidates.length - 1, Math.floor(choice * candidates.length))]
  return { slot: pick.slot, enchantment: pick.clue.enchantment, level: pick.clue.level }
}

/** mod 的到达检测（N8）：{ enchant: { item, result, enchantment, level } } */
export function enchantExpect(picked) {
  return { enchant: { item: picked.item.id, result: resultOf(picked.item.id), enchantment: picked.target.enchantment, level: picked.target.level } }
}

const total = (counts) => Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0)
const at = (counts, id) => counts?.[id] ?? 0
const sortEnchantments = (list) => [...(list ?? [])].sort((a, b) => a.enchantment.localeCompare(b.enchantment) || a.level - b.level)

/**
 * 判定（N7）。final：held、carried、table { item, lapis }、dropped、containerOpen、xpLevel、enchantments、stationIntact。
 * @returns {{ outcome, reached, enchanted, hasTarget, lapisUsed, levelsUsed, matchedPreview }}
 */
export function judgeEnchant({ stopped, timedOut, taskState, final, picked, xpLevel }) {
  const none = { reached: false, enchanted: false, hasTarget: false, lapisUsed: null, levelsUsed: null, matchedPreview: null }
  if (stopped) return { outcome: 'aborted', ...none }
  if (!final?.held) return { outcome: final?.stationIntact === false ? 'lost' : timedOut ? 'timeout' : 'failed', ...none }
  const { held, carried = {}, dropped = {}, table = {} } = final
  const item = picked.item.id
  const result = resultOf(item)
  const ids = item === result ? [item] : [item, result]
  const where = (counts) => ids.reduce((sum, id) => sum + at(counts, id), 0)
  const itemCount = where(held) + where(carried) + where(table.item)
  const lapisUsed = LAPIS_COUNT - (at(held, LAPIS) + at(carried, LAPIS) + at(table.lapis, LAPIS) + at(dropped, LAPIS))
  const levelsUsed = Number.isInteger(final.xpLevel) ? xpLevel - final.xpLevel : null
  const enchantments = final.enchantments ?? []
  const enchanted = enchantments.length > 0
  const hasTarget = enchantments.some((e) => e.enchantment === picked.target.enchantment && e.level === picked.target.level)
  const targetOffer = picked.offers.find((o) => o.slot === picked.target.slot)
  const matchedPreview = enchanted ? JSON.stringify(sortEnchantments(enchantments)) === JSON.stringify(sortEnchantments(targetOffer?.result)) : null
  const reached = final.containerOpen === false && total(carried) === 0 && at(held, result) === 1 &&
    Object.keys(held).every((id) => id === result || id === LAPIS) && hasTarget
  let outcome
  if (final.stationIntact === false || total(dropped) > 0 || itemCount === 0) outcome = 'lost'
  else if (enchanted && !hasTarget) outcome = 'misenchanted'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, reached, enchanted, hasTarget, lapisUsed, levelsUsed, matchedPreview }
}

const enchantText = (e) => `${shortId(e.enchantment)} ${e.level}`

export const enchant = {
  type: 'enchant',
  options: ['item', 'bookshelves', 'xpLevel'],

  setup(trainer, arena, arenaConfig, args) {
    const props = trainer.itemProps()
    if (!props) throw new Error(`附魔台题需要 ${trainer.config.itemProps}（在 dsh-plugins/agent 里运行 npm run extract-item-props）`)
    const options = {
      item: args.item ? fullId(args.item) : null,
      bookshelves: parseBookshelves(args.bookshelves ?? arenaConfig.bookshelves ?? MAX_SHELVES),
      xpLevel: parseXpLevel(args.xpLevel ?? arenaConfig.xpLevel ?? 30)
    }
    const tables = enchantTables(props, { exclude: arenaConfig.exclude ?? [] })
    if (!tables.ids.length) throw new Error('物品池是空的（item-props.json 里没有 enchantable？重新运行 npm run extract-item-props）')
    if (options.item && !tables.ids.includes(options.item)) throw new Error(`物品池里没有 ${options.item}（不能上附魔台，或者被 exclude 排除）`)
    return { arena, arenaConfig, tables, options }
  },

  startText(ctx) {
    const o = ctx.options
    return `${o.item ? `物品 ${o.item}，` : ''}bookshelves=${o.bookshelves}，xpLevel=${o.xpLevel}；物品池 ${ctx.tables.ids.length} 种（${ctx.tables.groups.length} 类）`
  },

  batchFields() {
    return {}
  },

  sample(ctx, seed) {
    return sampleEnchant(ctx.tables, seed, ctx.options)
  },

  /**
   * 出题的第二步（N5）：预览三档、选目标；选不出来就用 seed + 1、+ 2……换一件物品，最多 MAX_RETRIES 次。
   * @param {(method: string, params: object) => Promise<{ ok, data?, error? }>} call  mod 调用
   */
  async preview(ctx, picked, seed, call) {
    let current = picked
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      if (retry > 0) current = sampleEnchant(ctx.tables, (seed + retry) >>> 0, ctx.options)
      const res = await call('arena/enchant-preview', { item: current.item.id, enchantSeed: current.enchantSeed, bookshelves: ctx.options.bookshelves })
      if (!res?.ok) throw new Error(`arena/enchant-preview: ${res?.error ?? 'no response'}`)
      if (res.data?.enchantable !== true) throw new Error(`${current.item.id} 不能上附魔台（数据过期？重新运行 npm run extract-item-props）`)
      const offers = res.data.offers ?? []
      const target = chooseTarget(offers, current.choice)
      if (target) return { ...current, offers, target, retries: retry }
      // 选不出来：换一件物品（固定物品时只换附魔种子）
    }
    throw new Error(`连续 ${MAX_RETRIES + 1} 次选不出目标附魔（三档的提示都不唯一）`)
  },

  label(ctx, picked, seed) {
    return `附魔 ${shortId(picked.item.id)} 得到 ${enchantText(picked.target)}（第 ${picked.target.slot} 档，seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      item: picked.item, enchantSeed: picked.enchantSeed, bookshelves: ctx.options.bookshelves, xpLevel: ctx.options.xpLevel,
      // target 和其他题型一样是字符串（日志、通知、--by target 用），这里是原材料 id；目标附魔记在 goal（方案 N9 的 target）
      offers: picked.offers, goal: picked.target, target: picked.item.id, retries: picked.retries ?? 0, layout: picked.layout,
      enchantments: null, matchedPreview: null, lapisUsed: null, levelsUsed: null,
      final: null, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return {
      station: 'enchanting_table', items: picked.layout, seed, watch: [], expect: enchantExpect(picked), dayTime: 1000,
      bookshelves: ctx.options.bookshelves, xpLevel: ctx.options.xpLevel, enchantSeed: picked.enchantSeed
    }
  },

  afterPrepare(ctx, picked, data) {
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the enchanting table (aimOk=${data?.aimOk}); check the arena origin`, fields: {} }
    const info = data?.enchant
    if (!info) return { error: 'arena/prepare: no enchant info (mod 版本太旧？)', fields: {} }
    if (Math.min(info.bookshelves, MAX_SHELVES) !== ctx.options.bookshelves) return { error: `arena/prepare: 附魔台周围有效书架 ${info.bookshelves} 个，应为 ${ctx.options.bookshelves} 个（场地被改动过？）`, fields: {} }
    if (info.xpLevel !== ctx.options.xpLevel || info.enchantSeed !== picked.enchantSeed) return { error: `arena/prepare: 经验 ${info.xpLevel} / 附魔种子 ${info.enchantSeed} 没设上（应为 ${ctx.options.xpLevel} / ${picked.enchantSeed}）`, fields: {} }
    // N5 的核对：真实附魔台菜单的三档要和预览一致
    const diff = picked.offers.filter((o) => {
      const real = (info.offers ?? []).find((x) => x.slot === o.slot)
      return !real || real.cost !== o.cost || JSON.stringify(real.clue ?? null) !== JSON.stringify(o.clue ?? null)
    })
    if (diff.length) return { error: `预览和附魔台不一致（第 ${diff.map((o) => o.slot).join('、')} 档）：预览 ${JSON.stringify(picked.offers.map(({ slot, cost, clue }) => ({ slot, cost, clue })))}，附魔台 ${JSON.stringify(info.offers)}`, fields: {} }
    return { fields: {} }
  },

  instruction(ctx, picked, prompts) {
    // N6：只说现状和要求；不提第几档、按钮、青金石怎么用
    return renderTemplate(prompts.training.enchant, { item: picked.item.id, enchantment: picked.target.enchantment, level: picked.target.level })
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0 }) {
    const judged = judgeEnchant({ stopped, timedOut, taskState, final, picked, xpLevel: ctx.options.xpLevel })
    const reachedAtMs = final?.reachedAtMs ?? null
    return {
      outcome: judged.outcome, reached: judged.reached,
      enchantments: final?.enchantments ?? null, matchedPreview: judged.matchedPreview,
      lapisUsed: judged.lapisUsed, levelsUsed: judged.levelsUsed,
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final ? { held: final.held ?? null, carried: final.carried ?? null, table: final.table ?? null, dropped: final.dropped ?? null, containerOpen: final.containerOpen ?? null, xpLevel: final.xpLevel ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { kind: record.item?.kind ?? null }
  }
}
