import { renderTemplate } from '../llm/prompts.js'
import { rng } from './sampler.js'
import { BOOK, anvilTables, parseEnchantsSpec, sameEnchantments, sortEnchantments } from './anvil.js'
import { kindOf } from './enchant.js'
import { parseTasksSpec } from './smithing.js'

/**
 * 砂轮题型（docs/砂轮训练场设计方案.md）：正前方一个砂轮，物品栏里有 1–4 件带附魔的物品（有耐久的物品或附魔书），
 * 要求用砂轮给它们祛魔，产物放回物品栏。不要求关界面。
 *
 * - 物品池（K2）：arena/anvil-catalog 的物品（enchantable/durability 标签，按铁砧题的分组抽）和附魔书（catalog.book）；
 *   kind=mix 时每件以 1/4 的概率是附魔书
 * - 一轮几件（K3）：同一轮里有耐久的物品互不同种（两件同种会被合并）；附魔书可以有多本
 * - 附魔（K4）：非诅咒附魔 enchants 个（至少 1 个），诅咒 curses 个（0–2，候选不够就少抽）
 * - 目标（F4）：只留诅咒；附魔书一个不剩就变成 minecraft:book；损坏值不变（发满耐久，K5）。mod 在 prepare 时用原版砂轮逐件核对（K8）
 * - 文案（K6，做法 B）：只列出物品和附魔，请 agent 用砂轮祛魔；不写磨完的样子
 * - 判定（K7）：玩家身上（不含光标）按签名恰好是全部目标、光标为空；aborted → lost → timeout → success / false_success / failed
 */

export const INVENTORY_SLOTS = 36
export const PLAIN_BOOK = 'minecraft:book'
export const KINDS = ['item', 'book', 'mix']
export const GRINDSTONE_CHOICES = { kind: KINDS }
/** kind=mix 时一件是附魔书的概率（K2） */
export const BOOK_CHANCE = 0.25
export const MAX_CURSES = 2
/** 没做好的原因（K7） */
export const FAULTS = ['left', 'input', 'cursor', 'dropped']
export const FAULT_NAMES = { left: '有没磨的', input: '留在砂轮', cursor: '光标上有东西', dropped: '扔在地上' }

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
const fullId = (id) => (id.includes(':') ? id : `minecraft:${id}`)
const shortId = (id) => id.replace(/^minecraft:/, '')
const rangeText = ({ lo, hi }) => (lo === hi ? String(lo) : `${lo}-${hi}`)

/** curses=k|a-b（0–2）：每件带几个诅咒（K4）。铁砧题的 curses 是开关，各自解析 */
export function parseCursesSpec(text) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(text))
  const lo = match ? Number(match[1]) : NaN
  const hi = match ? Number(match[2] ?? match[1]) : NaN
  if (!(lo >= 0 && hi <= MAX_CURSES && lo <= hi)) throw new Error(`砂轮题的 curses 要写 k 或 a-b（0–${MAX_CURSES}，a ≤ b），收到 "${text}"`)
  return { lo, hi }
}

/**
 * 选项（§5.2）：命令行的优先，没写的用场地配置。
 * @param {object} args    命令行（没写的是 null）
 * @param {object} config  场地配置
 */
export function grindstoneOptions(args = {}, config = {}) {
  const kind = args.kind ?? config.kind ?? 'mix'
  if (!KINDS.includes(kind)) throw new Error(`砂轮题的 kind 只能是 ${KINDS.join(' / ')}，收到 "${kind}"`)
  const item = args.item ? fullId(args.item) : null
  if (kind === 'book' && item && item !== BOOK) throw new Error(`kind=book 只出附魔书，不能和 item=${item} 一起用`)
  if (kind === 'item' && item === BOOK) throw new Error(`kind=item 不出附魔书，不能和 item=${BOOK} 一起用`)
  return {
    tasks: parseTasksSpec(args.tasks ?? config.tasks ?? '1-3'),
    kind,
    item,
    enchants: parseEnchantsSpec(args.enchants ?? config.enchants ?? '1-3'),
    curses: parseCursesSpec(args.curses ?? config.curses ?? '0-1')
  }
}

/**
 * 物品池（K2）：物品沿用铁砧题的分组；附魔书是 catalog.book（exclude 里写了 minecraft:enchanted_book 就不出）。
 * @param {{ items, book }} catalog  arena/anvil-catalog 的结果
 */
export function grindstoneTables(catalog, exclude = []) {
  const { groups, byId } = anvilTables(catalog, exclude)
  const excluded = new Set(exclude.map(fullId))
  const book = catalog?.book && !excluded.has(BOOK) ? { ...catalog.book, id: BOOK } : null
  return { groups, byId, book }
}

/**
 * 从候选里依次抽 k 个附魔（同铁砧方案 A3 第 3 步）：每次去掉已抽到的和与已抽到的冲突的；候选不够就少抽。
 * @param {object[]} chosen  已经抽到的（冲突也要避开）
 * @returns {object[]} 新抽到的目录项
 */
function drawEnchantments(random, pool, k, chosen = []) {
  const out = []
  for (let i = 0; i < k; i++) {
    const taken = [...chosen, ...out]
    const avail = pool.filter((e) => !taken.some((c) => c.id === e.id || c.exclusive.includes(e.id) || e.exclusive.includes(c.id)))
    if (!avail.length) break
    out.push(pickOne(random, avail))
  }
  return out
}

/** 签名（K7）：id | 附魔 | 损坏值 | 自定义名字 */
export const signature = (stack) => `${stack.id}|${JSON.stringify(sortEnchantments(stack.enchantments ?? {}))}|${stack.damage ?? 0}|${stack.name ?? ''}`

/** 一件物品磨完的样子（F4）：只留诅咒；附魔书一个不剩就变成 minecraft:book；损坏值不变 */
export function goalOf(item) {
  const kept = sortEnchantments(Object.fromEntries(Object.entries(item.enchantments).filter(([id]) => item.curses.includes(id))))
  const id = item.id === BOOK && Object.keys(kept).length === 0 ? PLAIN_BOOK : item.id
  return { id, enchantments: kept, damage: 0 }
}

/**
 * 抽一道题（K2–K5）。随机数抽取顺序：件数 → 逐件（种类 → 物品类别 → 物品 → 非诅咒附魔个数 → 逐个抽附魔 → 诅咒个数 → 逐个抽诅咒 → 各附魔的级数）→ 格位。
 * item= 固定第一件。
 * @returns {{ k, items: Array<{ slot, kind, category, id, enchantments, curses }>, goals, hasBook, hasCurse }}
 */
export function sampleGrindstone(tables, seed, options) {
  const random = rng(seed)
  const k = between(random, options.tasks.lo, options.tasks.hi)
  const used = new Set()
  const items = []
  for (let i = 0; i < k; i++) {
    const fixed = i === 0 ? options.item : null
    let kind
    if (fixed) kind = fixed === BOOK ? 'book' : 'item'
    else if (options.kind === 'mix') kind = tables.book && random() < BOOK_CHANCE ? 'book' : 'item'
    else kind = options.kind
    let entry
    if (kind === 'book') {
      if (!tables.book) throw new Error('物品池里没有附魔书（arena/anvil-catalog 没有返回 book，或者 exclude 排除了 minecraft:enchanted_book）')
      entry = tables.book
    } else if (fixed) {
      entry = tables.byId.get(fixed)
      if (!entry) throw new Error(`物品池里没有 ${fixed}（附不上耐久，或者被 exclude 排除）`)
    } else {
      // K3：有耐久的物品互不同种
      const groups = tables.groups.map((g) => ({ ...g, items: g.items.filter((e) => !used.has(e.id)) })).filter((g) => g.items.length)
      if (!groups.length) throw new Error(`物品池不够：一轮要 ${k} 件互不同种的物品`)
      entry = pickOne(random, pickOne(random, groups).items)
    }
    if (kind === 'item') used.add(entry.id)
    const plain = entry.enchantments.filter((e) => !e.curse)
    const cursed = entry.enchantments.filter((e) => e.curse)
    const chosen = drawEnchantments(random, plain, between(random, options.enchants.lo, options.enchants.hi))
    if (!chosen.length) throw new Error(`${entry.id} 没有能附的非诅咒附魔`)
    const curses = drawEnchantments(random, cursed, between(random, options.curses.lo, options.curses.hi), chosen)
    const enchantments = {}
    for (const e of [...chosen, ...curses]) enchantments[e.id] = between(random, 1, e.maxLevel)
    items.push({
      kind, category: kind === 'book' ? 'book' : kindOf(entry.id)?.kind ?? shortId(entry.id), id: entry.id,
      enchantments: sortEnchantments(enchantments), curses: curses.map((e) => e.id).sort()
    })
  }
  const free = Array.from({ length: INVENTORY_SLOTS }, (_, i) => i)
  for (const item of items) item.slot = free.splice(Math.floor(random() * free.length), 1)[0]
  const goals = items.map(goalOf)
  return { k, items, goals, hasBook: items.some((i) => i.kind === 'book'), hasCurse: items.some((i) => i.curses.length > 0) }
}

/** mod 的核对和到达检测（K8）：{ grindstone: { goals } }，顺序和 items 一致 */
export const grindstoneExpect = (picked) => ({ grindstone: { goals: picked.goals.map((g) => ({ id: g.id, enchantments: g.enchantments, damage: g.damage })) } })

/** 文案里的附魔列表：minecraft:sharpness 5 级、minecraft:unbreaking 3 级 */
export const enchantsText = (map) => Object.entries(sortEnchantments(map)).map(([id, level]) => `${id} ${level} 级`).join('、')
const enchantsLabel = (map) => Object.entries(sortEnchantments(map)).map(([id, level]) => `${shortId(id)} ${level}`).join('、')
/** K6（做法 B）：每件一行，只写物品和附魔 */
export const itemLines = (items) => items.map((it, i) => `- 带 ${enchantsText(it.enchantments)} 的 ${it.id}${i === items.length - 1 ? '。' : '；'}`).join('\n')

const countOf = (list) => {
  const out = new Map()
  for (const s of list) if (s) out.set(signature(s), (out.get(signature(s)) ?? 0) + (s.count ?? 1))
  return out
}
const sameCounts = (a, b) => a.size === b.size && [...a].every(([key, n]) => b.get(key) === n)

/**
 * 判定（K7）。final：items（玩家身上，不含光标）、carriedItem、slots{ input0, input1 }、droppedItems、containerOpen、stationIntact。
 * @returns {{ outcome, reached, ground, faults }}
 */
export function judgeGrindstone({ stopped, timedOut, taskState, final, picked }) {
  if (stopped) return { outcome: 'aborted', reached: false, ground: null, faults: [] }
  if (!Array.isArray(final?.items)) return { outcome: final?.stationIntact === false ? 'lost' : timedOut ? 'timeout' : 'failed', reached: false, ground: null, faults: [] }
  const items = final.items
  const carried = final.carriedItem ?? null
  const inputs = [final.slots?.input0 ?? null, final.slots?.input1 ?? null].filter(Boolean)
  const dropped = Array.isArray(final.droppedItems) ? final.droppedItems : []
  const want = countOf(picked.goals)
  const reached = !carried && sameCounts(countOf(items), want)
  // 每件物品还在不在：原样（没磨）或目标样子（磨过）出现在玩家身上、光标、砂轮输入格、场内地上
  const everywhere = countOf([...items, carried, ...inputs, ...dropped])
  const original = countOf(picked.items.map((it) => ({ id: it.id, enchantments: it.enchantments, damage: 0 })))
  const forms = new Set([...want.keys(), ...original.keys()])
  const found = [...forms].reduce((n, key) => n + (everywhere.get(key) ?? 0), 0)
  const ground = [...want].reduce((n, [key, need]) => n + Math.min(need, countOf(items).get(key) ?? 0), 0)
  const faults = []
  if ([...original.keys()].some((key) => (everywhere.get(key) ?? 0) > 0)) faults.push('left')
  if (inputs.length) faults.push('input')
  if (carried) faults.push('cursor')
  if (dropped.length) faults.push('dropped')
  let outcome
  if (final.stationIntact === false || found < picked.k) outcome = 'lost'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, reached, ground, faults: outcome === 'success' ? [] : faults }
}

export const grindstone = {
  type: 'grindstone',
  options: ['item', 'tasks', 'kind', 'enchants', 'curses'],

  setup(trainer, arena, arenaConfig, args) {
    const options = grindstoneOptions(args, arenaConfig)
    return { arena, arenaConfig, options, tables: null }
  },

  startText(ctx) {
    const o = ctx.options
    return [`tasks=${rangeText(o.tasks)}`, `kind=${o.kind}`, `enchants=${rangeText(o.enchants)}`, `curses=${rangeText(o.curses)}`, o.item ? `第一件 ${o.item}` : null].filter(Boolean).join('，')
  },

  batchFields() {
    return {}
  },

  /** 物品池要问 mod，抽题放在 preview 里做 */
  sample(ctx, seed) {
    return { seed }
  },

  /** 第一次先读物品池（每组训练只读一次），再抽题；不需要预览（§3） */
  async preview(ctx, picked, seed, call) {
    if (!ctx.tables) {
      const res = await call('arena/anvil-catalog', {})
      if (!res?.ok) throw new Error(`arena/anvil-catalog: ${res?.error ?? 'no response'}`)
      ctx.tables = grindstoneTables(res.data, ctx.arenaConfig.exclude ?? [])
    }
    return sampleGrindstone(ctx.tables, seed, ctx.options)
  },

  label(ctx, picked, seed) {
    const what = picked.items.map((it) => `${it.kind === 'book' ? '附魔书' : shortId(it.id)}[${enchantsLabel(it.enchantments)}]`).join(' + ')
    return `砂轮 ${picked.k} 件 ${what}（seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      // target 和其他题型一样是字符串（日志、通知、--by target 用）：各件目标用 + 连起来（同锻造台题）
      target: picked.goals.map((g) => shortId(g.id) + (Object.keys(g.enchantments).length ? `[${enchantsLabel(g.enchantments)}]` : '')).join('+'),
      k: picked.k, items: picked.items, goals: picked.goals, hasBook: picked.hasBook, hasCurse: picked.hasCurse,
      ground: null, faults: [], final: null, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return {
      station: 'grindstone', seed, watch: [], expect: grindstoneExpect(picked), dayTime: 1000,
      items: picked.items.map((it) => ({ slot: it.slot, id: it.id, count: 1, enchantments: it.enchantments }))
    }
  },

  afterPrepare(ctx, picked, data) {
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the grindstone (aimOk=${data?.aimOk}); check the arena origin`, fields: {} }
    const given = data?.grindstone?.items
    if (!Array.isArray(given)) return { error: 'arena/prepare: no grindstone info (mod 版本太旧？)', fields: {} }
    const wrong = picked.items.filter((it) => !given.some((s) => s.slot === it.slot && s.id === it.id && sameEnchantments(s.enchantments, it.enchantments)))
    if (wrong.length || given.length !== picked.items.length) return { error: `arena/prepare: 发放的物品和题目不一致（${wrong.map((it) => `${it.slot} 号格 ${it.id}`).join('、') || `发了 ${given.length} 件`}）`, fields: {} }
    return { fields: {} }
  },

  instruction(ctx, picked, prompts) {
    // K6（做法 B）：列出物品和附魔，只说"用砂轮祛魔"；不写磨完的样子、不说怎么放
    const one = picked.k === 1
    return renderTemplate(prompts.training.grindstone, { what: one ? '一件带附魔的物品' : `${picked.k} 件带附魔的物品`, items: itemLines(picked.items), them: one ? '它' : '它们' })
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0 }) {
    const judged = judgeGrindstone({ stopped, timedOut, taskState, final, picked })
    const reachedAtMs = final?.reachedAtMs ?? null
    return {
      outcome: judged.outcome, reached: judged.reached, ground: judged.ground, faults: judged.faults,
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final
        ? { items: final.items ?? null, carriedItem: final.carriedItem ?? null, slots: final.slots ?? null, droppedItems: final.droppedItems ?? null, containerOpen: final.containerOpen ?? null }
        : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { k: record.k ?? null, hasBook: record.hasBook ?? null, hasCurse: record.hasCurse ?? null }
  }
}
