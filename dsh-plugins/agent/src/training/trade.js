import { renderTemplate } from '../llm/prompts.js'
import { rng, spreadStacks } from './sampler.js'
import { parseTasksSpec } from './smithing.js'

/**
 * 村民交易题型（docs/村民交易训练场设计方案.md）：正前方一只村民（随机职业、随机等级，NoAI、无敌），物品栏里有交易要用的付款物。
 * 在指定的几笔交易上各交易指定次数，不做别的交易，然后关掉交易界面。
 *
 * - 出题（V3）：先抽职业、等级、村民类型；再用 arena/trade-preview 预览交易项（交易项种子 offerSeed 从同一个随机数流里抽），
 *   在预览出的交易里选 k 笔、定次数和付款物。选不出来就再抽一个 offerSeed 重新预览，最多 MAX_RETRIES 次。
 * - 选交易（V4）：目标按交易次数写，不需要产物方面的约束；文案按内容描述每笔交易，写出来和别的交易一样时带上附魔，还分不开就不选。
 * - 数量（V5）：每笔交易的付款物最多 4 格、产物最多 9 格；同一种付款物合并发，多发余量 e；开局占用 + 全部产物格数 ≤ 36。
 * - 判定（V6、V8）：以村民每笔交易的 uses 为准；aborted → lost → overshoot（换多）→ mistrade（换错）→ timeout → success / false_success / failed。
 * - 多换、换错拿不回来（V7）：doomed 钩子在轮询时发现就立即结束本轮。
 * - 到达（V9）：mod 在 tick 里按 expect { trade: { uses, held } } 检测，记 reachedAtMs。
 *
 * 物品按 id 计数：交易次数已经确定换到的是哪件东西，带组件的产物不需要比较组件（V6）。
 */

export const INVENTORY_SLOTS = 36
export const MAX_COUNT = 64
export const MAX_LEVEL = 5
/** V5：每笔交易的付款物、产物最多占几格 */
export const PAY_SLOTS = 4
export const PRODUCT_SLOTS = 9
/** 换 offerSeed 重新预览的次数上限（V3） */
const MAX_RETRIES = 10
/** 选定交易后抽数量、拆堆放不下时的重抽次数，用完就少选一笔（V5） */
const MAX_REDRAWS = 20
/** V2：有交易表的 13 种职业（none、nitwit 除外），和 arena/trade-catalog 一致 */
export const PROFESSIONS = [
  'minecraft:armorer', 'minecraft:butcher', 'minecraft:cartographer', 'minecraft:cleric', 'minecraft:farmer', 'minecraft:fisherman',
  'minecraft:fletcher', 'minecraft:leatherworker', 'minecraft:librarian', 'minecraft:mason', 'minecraft:shepherd', 'minecraft:toolsmith',
  'minecraft:weaponsmith'
]
/** V2：7 种村民类型 */
export const VILLAGER_TYPES = ['minecraft:desert', 'minecraft:jungle', 'minecraft:plains', 'minecraft:savanna', 'minecraft:snow', 'minecraft:swamp', 'minecraft:taiga']
/** 失败原因（V8），报告按这个顺序列 */
export const FAULTS = ['short', 'over', 'wrong', 'open']
export const FAULT_NAMES = { short: '次数不够', over: '换多', wrong: '换错', open: '没关界面' }

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

/** "k" / "a-b" → { lo, hi }，在 [min, max] 里；不合法抛错 */
function parseSpec(name, min, max, text) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(text))
  const lo = match ? Number(match[1]) : NaN
  const hi = match ? Number(match[2] ?? match[1]) : NaN
  if (!(lo >= min && hi <= max && lo <= hi)) throw new Error(`${name} 要写 k 或 a-b（${min}–${max}，a ≤ b），收到 "${text}"`)
  return { lo, hi }
}

/** level=k|a-b（1–5）：村民等级的范围。/bt train 的全局解析也用它（信标场地的 setup 自己再查不超过 4） */
export const parseTradeLevelSpec = (text) => parseSpec('level', 1, MAX_LEVEL, text)

/** profession=：职业注册名，可以省掉 minecraft: */
export function parseProfession(text) {
  const id = fullId(String(text))
  if (!PROFESSIONS.includes(id)) throw new Error(`profession 要写有交易的职业（${PROFESSIONS.map(shortId).join(' / ')}），收到 "${text}"`)
  return id
}

/**
 * 选项：命令行的优先，没写的用场地配置。n= 进来叫 portions。
 * @returns {{ level, tasks, portions, extra, profession: string|null, item: string|null, professions: string[], excludeItems: Set<string> }}
 */
export function tradeOptions(args = {}, config = {}) {
  const exclude = config.exclude ?? {}
  const professions = PROFESSIONS.filter((p) => !(exclude.professions ?? []).map(fullId).includes(p))
  const profession = args.profession ? parseProfession(args.profession) : null
  if (!profession && !professions.length) throw new Error('职业池是空的（exclude.professions 排除了全部职业）')
  return {
    level: parseTradeLevelSpec(args.level ?? config.level ?? '1-5'),
    tasks: parseTasksSpec(args.tasks ?? config.tasks ?? '1-4'),
    portions: parseSpec('n', 1, MAX_COUNT, args.portions ?? config.portions ?? '1-64'),
    extra: parseSpec('extra', 0, MAX_COUNT, args.extra ?? config.extra ?? '0-16'),
    profession,
    item: args.item ? fullId(args.item) : null,
    professions,
    excludeItems: new Set((exclude.items ?? []).map(fullId))
  }
}

/** 出题第一步（V3）：职业 → 等级 → 类型。返回的 random 留给预览以后接着抽（offerSeed、选交易……） */
export function sampleVillager(seed, options) {
  const random = rng(seed >>> 0)
  const profession = options.profession ?? pickOne(random, options.professions)
  const level = between(random, options.level.lo, options.level.hi)
  const type = pickOne(random, VILLAGER_TYPES)
  return { profession, level, type, random }
}

/** 一笔交易的付款物：[{ id, count（实际价）, maxStack }]（A 在前） */
const costsOf = (offer) => [offer.costA, ...(offer.costB ? [offer.costB] : [])]

/** V5：这笔交易最多能出几次 */
export function maxTimes(offer) {
  const caps = [offer.maxUses - (offer.uses ?? 0), Math.floor((PRODUCT_SLOTS * offer.result.maxStack) / offer.result.count)]
  for (const c of costsOf(offer)) caps.push(Math.floor((PAY_SLOTS * c.maxStack) / c.count))
  return Math.max(0, Math.min(...caps))
}

const enchantText = (enchantments) => Object.entries(enchantments ?? {}).map(([id, lv]) => `${id} ${lv}`).join('、')
const plainText = (o) => `用 ${costsOf(o).map((c) => `${c.id} × ${c.count}`).join(' 和 ')} 换 ${o.result.id} × ${o.result.count}`

/**
 * V4、V9：每笔交易在文案里怎么写。和别的交易写出来一样时带上附魔（"（附魔：minecraft:sharpness 3）"）；
 * 还分不开 → null（这笔不选）。
 * @returns {Array<string|null>}  按交易下标
 */
export function describeOffers(offers) {
  const plain = offers.map(plainText)
  const rich = offers.map((o, i) => {
    const ench = enchantText(o.result.enchantments)
    return ench ? `${plain[i]}（附魔：${ench}）` : plain[i]
  })
  return offers.map((o, i) => {
    if (plain.filter((p) => p === plain[i]).length === 1) return plain[i]
    const same = offers.map((_, j) => j).filter((j) => plain[j] === plain[i])
    return same.filter((j) => rich[j] === rich[i]).length === 1 ? rich[i] : null
  })
}

/**
 * 出题第二步（V4、V5）：在预览出的交易里选 k 笔，抽次数、付款物余量、拆堆、打乱格位。选不出来 → null。
 * 随机数接着第一步的流抽：笔数 k → 交易排列 → 每笔的 n1 → 每种付款物的 e → 拆堆 → 打乱格位。
 * @returns {null | { kWanted, k, trades, extra, items, slots, uses, held, canOvershoot, hasComponents, hasUnstackable, hasCostB, hasChain, hasSameResult }}
 */
export function pickTrades(offers, random, options) {
  const texts = describeOffers(offers)
  const usable = offers.filter((o, i) => texts[i] !== null && o.maxUses > (o.uses ?? 0) && !options.excludeItems.has(o.result.id)
    && maxTimes(o) >= options.portions.lo)
  const kWanted = between(random, options.tasks.lo, options.tasks.hi)
  let order = shuffle(random, usable)
  if (options.item) {
    const first = order.find((o) => o.result.id === options.item)
    if (!first) return null
    order = [first, ...order.filter((o) => o !== first)]
  }
  let chosen = order.slice(0, kWanted)
  if (!chosen.length) return null
  for (;;) {
    for (let attempt = 0; attempt < MAX_REDRAWS; attempt++) {
      const plan = drawAmounts(chosen, random, options)
      if (plan) {
        return {
          kWanted, k: chosen.length,
          ...plan,
          trades: chosen.map((o, i) => ({
            index: o.index, level: o.level ?? null, costA: o.costA, costB: o.costB ?? null, result: o.result,
            n1: plan.times[i], n0: maxTimes(o), maxUses: o.maxUses, text: texts[o.index]
          }))
        }
      }
    }
    if (chosen.length === 1) return null
    chosen = chosen.slice(0, -1)
  }
}

/** V5：给已选的交易抽次数和余量、拆堆；全局格数放不下 → null（调用方重抽） */
function drawAmounts(chosen, random, options) {
  const times = chosen.map((o) => between(random, Math.max(1, options.portions.lo), Math.min(maxTimes(o), options.portions.hi)))
  const productSlots = chosen.reduce((sum, o, i) => sum + Math.ceil((times[i] * o.result.count) / o.result.maxStack), 0)
  // 同一种付款物合并：need、最高单价、用到它的交易笔数、堆叠上限
  const pay = new Map()
  chosen.forEach((o, i) => {
    for (const c of costsOf(o)) {
      const g = pay.get(c.id) ?? { id: c.id, need: 0, price: 0, uses: 0, cap: c.maxStack }
      g.need += times[i] * c.count
      g.price = Math.max(g.price, c.count)
      g.uses++
      pay.set(c.id, g)
    }
  })
  const extra = {}
  const items = [...pay.values()].map((g) => {
    const hi = Math.max(options.extra.hi, 2 * g.price)
    let e = between(random, Math.min(options.extra.lo, hi), hi)
    e = Math.min(e, PAY_SLOTS * g.uses * g.cap - g.need)
    extra[g.id] = e
    const total = g.need + e
    return { id: g.id, total, cap: g.cap, k: Math.ceil(total / g.cap) }
  })
  const room = INVENTORY_SLOTS - productSlots
  if (items.reduce((sum, it) => sum + it.k, 0) > room) return null
  const given = Object.fromEntries(items.map((it) => [it.id, it.total]))
  const stacks = spreadStacks(random, items, room)
  const free = shuffle(random, Array.from({ length: INVENTORY_SLOTS }, (_, i) => i))
  const slots = stacks.map((s, i) => ({ slot: free[i], ...s }))
  // V6 的守恒：结束时物品栏 = 发放 − 消耗 + 产物
  const held = { ...given }
  chosen.forEach((o, i) => {
    for (const c of costsOf(o)) held[c.id] -= times[i] * c.count
    held[o.result.id] = (held[o.result.id] ?? 0) + times[i] * o.result.count
  })
  for (const id of Object.keys(held)) if (held[id] <= 0) delete held[id]
  const payIds = new Set(pay.keys())
  const resultIds = chosen.map((o) => o.result.id)
  return {
    times, extra, given,
    items: items.map(({ id, total }) => ({ id, total, extra: extra[id] })),
    slots, held,
    productSlots,
    // V10：至少有一笔能多换：没交易满，并且每种付款物多发的都够再付一次
    canOvershoot: chosen.some((o, i) => times[i] < o.maxUses - (o.uses ?? 0) && costsOf(o).every((c) => extra[c.id] >= c.count)),
    hasComponents: chosen.some((o) => o.result.components === true),
    hasUnstackable: chosen.some((o) => o.result.maxStack === 1),
    hasCostB: chosen.some((o) => Boolean(o.costB)),
    hasChain: resultIds.some((id) => payIds.has(id)),
    hasSameResult: new Set(resultIds).size < resultIds.length
  }
}

/** expect.trade（V9）：uses 按交易下标（没选的为 0）、held */
export function tradeExpect(picked) {
  return { trade: { uses: picked.uses, held: picked.held } }
}

/** 每笔交易的目标次数（按交易下标，没选的为 0） */
export function targetUses(offers, trades) {
  const uses = offers.map(() => 0)
  for (const t of trades) uses[t.index] = t.n1
  return uses
}

const total = (counts) => Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0)

/**
 * 守恒（V6）和失败原因（V8）。final：villager{ uses }、held、carried、payment、dropped（按 id）、containerOpen。
 * @returns {{ conserved, faults: string[], over: number[], wrong: number[], expected: {id: n} }}
 */
export function tradeAccount(final, picked) {
  const uses = final.villager?.uses ?? []
  const want = picked.uses
  const expected = { ...picked.given }
  picked.offers.forEach((o, i) => {
    const n = uses[i] ?? 0
    if (!n) return
    for (const c of costsOf(o)) expected[c.id] = (expected[c.id] ?? 0) - n * c.count
    expected[o.result.id] = (expected[o.result.id] ?? 0) + n * o.result.count
  })
  const everywhere = {}
  for (const counts of [final.held, final.carried, final.payment, final.dropped]) {
    for (const [id, n] of Object.entries(counts ?? {})) everywhere[id] = (everywhere[id] ?? 0) + n
  }
  const ids = new Set([...Object.keys(expected), ...Object.keys(everywhere)])
  const conserved = [...ids].every((id) => (everywhere[id] ?? 0) === Math.max(0, expected[id] ?? 0))
  const chosen = new Set(picked.trades.map((t) => t.index))
  const over = want.map((w, i) => i).filter((i) => chosen.has(i) && (uses[i] ?? 0) > want[i])
  const wrong = want.map((w, i) => i).filter((i) => !chosen.has(i) && (uses[i] ?? 0) > 0)
  const faults = []
  if (picked.trades.some((t) => (uses[t.index] ?? 0) < t.n1)) faults.push('short')
  if (over.length) faults.push('over')
  if (wrong.length) faults.push('wrong')
  if (final.containerOpen !== false || total(final.carried) > 0) faults.push('open')
  return { conserved, faults, over, wrong, expected }
}

/**
 * 判定（V8）。手动停止的轮次照样判 aborted，拿到了最终状态就照常算失败原因。
 * doomed（V7：多换、换错被发现后训练器中止的）不算手动停止，按最终状态判 overshoot / mistrade。
 * @returns {{ outcome, account: object|null, reached: boolean }}
 */
export function judgeTrade({ stopped, timedOut, taskState, final, picked }) {
  if (!final?.held || final.villager === undefined) return { outcome: stopped ? 'aborted' : timedOut ? 'timeout' : 'failed', account: null, reached: false }
  const account = tradeAccount(final, picked)
  const reached = account.faults.length === 0
  const lost = final.stationIntact === false || final.villager === null || total(final.dropped) > 0 || !account.conserved
  let outcome
  if (stopped) outcome = 'aborted'
  else if (lost) outcome = 'lost'
  else if (account.over.length) outcome = 'overshoot'
  else if (account.wrong.length) outcome = 'mistrade'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, account, reached }
}

/** V7：多换、换错拿不回来，轮询时一发现就返回原因（写进任务历史）；否则 null */
export function doomedReason(picked, status) {
  const uses = status?.villager?.uses
  if (!Array.isArray(uses)) return null
  for (const t of picked.trades) {
    if ((uses[t.index] ?? 0) > t.n1) return `交易次数超过目标：${t.text}的那笔已经交易了 ${uses[t.index]} 次，目标是 ${t.n1} 次，无法挽回`
  }
  const chosen = new Set(picked.trades.map((t) => t.index))
  for (let i = 0; i < uses.length; i++) {
    if (!chosen.has(i) && uses[i] > 0) {
      const text = picked.offers[i] ? plainText(picked.offers[i]) : `第 ${i} 笔交易`
      return `做了不在目标里的交易：${text}的那笔交易了 ${uses[i]} 次，无法挽回`
    }
  }
  return null
}

const rangeText = ({ lo, hi }) => (lo === hi ? String(lo) : `${lo}-${hi}`)
const tradeLines = (trades) => trades.map((t, i) => `- ${t.text}的那笔，交易 ${t.n1} 次${i === trades.length - 1 ? '。' : '；'}`).join('\n')

export const trade = {
  type: 'trade',
  options: ['item', 'profession', 'level', 'tasks', 'portions', 'extra'],

  setup(trainer, arena, arenaConfig, args) {
    const options = tradeOptions(args, arenaConfig)
    if (options.item && options.excludeItems.has(options.item)) throw new Error(`${options.item} 在 exclude.items 里，不能当产物`)
    return { arena, arenaConfig, options }
  },

  startText(ctx) {
    const o = ctx.options
    return `level=${rangeText(o.level)}，tasks=${rangeText(o.tasks)}，n=${rangeText(o.portions)}，extra=${rangeText(o.extra)}`
      + `${o.profession ? `，职业 ${o.profession}` : `；职业池 ${o.professions.length} 种`}${o.item ? `，产物 ${o.item}` : ''}`
  },

  batchFields() {
    return {}
  },

  sample(ctx, seed) {
    return sampleVillager(seed, ctx.options)
  },

  /**
   * 出题的第二步（V3）：预览交易项、选交易；选不出来就从同一个随机数流里再抽一个 offerSeed，最多 MAX_RETRIES 次。
   * @param {(method: string, params: object) => Promise<{ ok, data?, error? }>} call  mod 调用
   */
  async preview(ctx, picked, seed, call) {
    const { random, ...villager } = picked
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      const offerSeed = Math.floor(random() * 0x7fffffff)
      const params = { profession: villager.profession, type: villager.type, level: villager.level, offerSeed }
      const res = await call('arena/trade-preview', params)
      if (!res?.ok) throw new Error(`arena/trade-preview: ${res?.error ?? 'no response'}`)
      const offers = res.data?.offers ?? []
      const chosen = pickTrades(offers, random, ctx.options)
      if (chosen) return { ...villager, offerSeed, retries: retry, offers, ...chosen, uses: targetUses(offers, chosen.trades) }
    }
    throw new Error(`连续 ${MAX_RETRIES + 1} 次选不出交易（${villager.profession} ${villager.level} 级${ctx.options.item ? `，产物 ${ctx.options.item}` : ''}；n 的下限 ${ctx.options.portions.lo}）`)
  },

  label(ctx, picked, seed) {
    const what = picked.trades.map((t) => `${shortId(t.result.id)}×${t.n1}次`).join('、')
    return `村民交易：${shortId(picked.profession)} ${picked.level} 级，${what}（seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      profession: picked.profession, villagerType: picked.type, level: picked.level, offerSeed: picked.offerSeed, retries: picked.retries ?? 0,
      offers: picked.offers.map(({ index, level, costA, costB, result, maxUses }) => ({ index, level, costA, costB, result, maxUses })),
      trades: picked.trades.map(({ index, costA, costB, result, n1, n0, maxUses }) => ({ index, costA, costB, result, n1, n0, maxUses })),
      // target 和其他题型一样是字符串（日志、通知、--by target 用）：第一笔交易的产物
      target: picked.trades[0]?.result.id ?? null,
      kWanted: picked.kWanted, k: picked.k, extra: picked.extra, items: picked.items, slots: picked.slots,
      canOvershoot: picked.canOvershoot, hasComponents: picked.hasComponents, hasUnstackable: picked.hasUnstackable,
      hasCostB: picked.hasCostB, hasChain: picked.hasChain, hasSameResult: picked.hasSameResult,
      uses: null, faults: [], doomed: null, doomedMs: null,
      final: null, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return {
      station: 'villager', items: picked.slots, seed, watch: [], expect: tradeExpect(picked), dayTime: 1000,
      villager: { profession: picked.profession, type: picked.type, level: picked.level, offerSeed: picked.offerSeed }
    }
  },

  afterPrepare(ctx, picked, data) {
    const fields = {}
    if (Array.isArray(data?.given)) fields.slots = data.given
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the villager (aimOk=${data?.aimOk}); check the arena origin`, fields }
    // V3 的核对：prepare 生成的交易项要和预览逐笔一致
    const offers = data?.villager?.offers
    if (!Array.isArray(offers)) return { error: 'arena/prepare: no villager info (mod 版本太旧？)', fields }
    const same = offers.length === picked.offers.length && offers.every((o, i) => o.encoded === picked.offers[i].encoded)
    if (!same) return { error: `预览和村民交易项不一致（${picked.profession} ${picked.level} 级，offerSeed=${picked.offerSeed}）`, fields }
    return { fields }
  },

  instruction(ctx, picked, prompts) {
    // V9：只写目标状态；按内容描述每笔交易，不写下标，不说怎么打开、怎么选交易
    return renderTemplate(prompts.training.trade, { trades: tradeLines(picked.trades) })
  },

  /** V7：多换、换错 → 原因文字（训练器据此中止本轮）；否则 null */
  doomed(ctx, picked, status) {
    return doomedReason(picked, status)
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0, doomed }) {
    const { outcome, account, reached } = judgeTrade({ stopped, timedOut, taskState, final, picked })
    const reachedAtMs = final?.reachedAtMs ?? null
    return {
      outcome, reached,
      uses: final?.villager?.uses ?? null,
      faults: outcome === 'success' ? [] : account?.faults ?? [],
      doomed: doomed?.reason ?? null,
      doomedMs: doomed ? doomed.at - t0 : null,
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final
        ? { held: final.held ?? null, carried: final.carried ?? null, payment: final.payment ?? null, dropped: final.dropped ?? null, containerOpen: final.containerOpen ?? null }
        : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { profession: record.profession ?? null, level: record.level ?? null, k: record.k ?? null }
  }
}
