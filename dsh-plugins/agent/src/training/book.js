import { renderTemplate } from '../llm/prompts.js'
import { rng } from './sampler.js'
import { HANZI } from './anvil.js'

/**
 * 书与笔题型（docs/书与笔训练场设计方案.md）：没有工作站，物品栏里有 1–3 本写了字的书与笔，
 * 要求把指定的页改成指定的文字或清空，其余页保持原样。
 *
 * - 书放在主物品栏 36 格里随机的格子，当前选中的快捷栏格也随机（J4）
 * - 开局（J5）：每本 n 页，每页一半概率有字，最后一页一定有字
 * - 修改（J6）：从第 1 页到第 n + 2 页里抽 m 个页号；有字的页 1/4 概率清空，其余写新文字；目标页列表删掉末尾的空页（保存时原版就这样做）
 * - 一轮几本（J7）：文案按"现在第 q 页写着「…」的那本"指明
 * - 判定（J10）：光标为空，玩家身上只有书与笔、恰好 k 本，页列表和目标作为多重集合相等；aborted → lost → timeout → success / false_success / failed
 */

export const INVENTORY_SLOTS = 36
export const WRITABLE = 'minecraft:writable_book'
export const WRITTEN = 'minecraft:written_book'
export const MAX_BOOKS = 3
export const MAX_PAGES = 8
export const MAX_EDITS = 4
/** 开局每页有字的概率（J5）、有字的页被要求清空的概率（J6） */
export const FILL_CHANCE = 0.5
export const CLEAR_CHANCE = 0.25
/** 随机文字的长度（J8） */
export const TEXT_MIN = 6
export const TEXT_MAX = 16
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
/** 没做好的原因（J10） */
export const FAULTS = ['unsaved', 'wrong', 'signed', 'cursor', 'dropped']
export const FAULT_NAMES = { unsaved: '没改或没保存', wrong: '改错', signed: '署名了', cursor: '光标上有东西', dropped: '扔在地上' }

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
const rangeText = ({ lo, hi }) => (lo === hi ? String(lo) : `${lo}-${hi}`)

function rangeSpec(name, min, max) {
  return (text) => {
    const match = /^(\d+)(?:-(\d+))?$/.exec(String(text))
    const lo = match ? Number(match[1]) : NaN
    const hi = match ? Number(match[2] ?? match[1]) : NaN
    if (!(lo >= min && hi <= max && lo <= hi)) throw new Error(`${name} 要写 k 或 a-b（${min}–${max}，a ≤ b），收到 "${text}"`)
    return { lo, hi }
  }
}

/** books=k|a-b（1–3）：一轮几本书（J7） */
export const parseBooksSpec = rangeSpec('books', 1, MAX_BOOKS)
/** pages=k|a-b（1–8）：每本书开局几页（J5） */
export const parseBookPagesSpec = rangeSpec('pages', 1, MAX_PAGES)
/** edits=k|a-b（1–4）：每本书改几页（J6） */
export const parseEditsSpec = rangeSpec('edits', 1, MAX_EDITS)

/**
 * 选项（§5.2）：命令行的优先，没写的用场地配置。
 * @param {object} args    命令行（没写的是 null）
 * @param {object} config  场地配置
 */
export function bookOptions(args = {}, config = {}) {
  return {
    books: parseBooksSpec(args.books ?? config.books ?? '1-3'),
    pages: parseBookPagesSpec(args.pages ?? config.pages ?? '1-6'),
    edits: parseEditsSpec(args.edits ?? config.edits ?? '1-3')
  }
}

/** 一串随机文字（J8）：6–16 个字符，汉字和字母数字都有，打乱顺序；和 used 里的都不同 */
export function sampleText(random, used) {
  for (;;) {
    const length = between(random, TEXT_MIN, TEXT_MAX)
    const hanzi = between(random, 1, length - 1)
    const chars = []
    for (let i = 0; i < hanzi; i++) chars.push(pickOne(random, HANZI))
    for (let i = hanzi; i < length; i++) chars.push(pickOne(random, ALNUM))
    for (let i = chars.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[chars[i], chars[j]] = [chars[j], chars[i]]
    }
    const text = chars.join('')
    if (!used.has(text)) {
      used.add(text)
      return text
    }
  }
}

/** 套用修改，再删掉末尾的空页（BookEditScreen.eraseEmptyTrailingPages，F5） */
export function applyEdits(pages, edits) {
  const out = [...pages]
  for (const e of edits) {
    while (out.length < e.page) out.push('')
    out[e.page - 1] = e.op === 'clear' ? '' : e.text
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

/**
 * 一本书（J5、J6）。随机数抽取顺序：页数 → 逐页（有没有字 → 文字）→ 最后一页补字 → 改几页 → 页号 → 逐个页号（清不清空 → 新文字）。
 * @returns {{ pages, edits: Array<{ page, op, text? }>, goal, label: { page, text } }}
 */
export function sampleBook(random, options, used) {
  const n = between(random, options.pages.lo, options.pages.hi)
  const pages = []
  for (let i = 0; i < n; i++) pages.push(random() < FILL_CHANCE ? sampleText(random, used) : '')
  if (pages[n - 1] === '') pages[n - 1] = sampleText(random, used)
  const m = Math.min(between(random, options.edits.lo, options.edits.hi), n + 2)
  const candidates = Array.from({ length: n + 2 }, (_, i) => i + 1)
  const chosen = []
  for (let i = 0; i < m; i++) chosen.push(candidates.splice(Math.floor(random() * candidates.length), 1)[0])
  chosen.sort((a, b) => a - b)
  const edits = chosen.map((page) => (page <= n && pages[page - 1] !== '' && random() < CLEAR_CHANCE
    ? { page, op: 'clear' }
    : { page, op: 'write', text: sampleText(random, used) }))
  const q = pages.findIndex((p) => p !== '')
  return { pages, edits, goal: applyEdits(pages, edits), label: { page: q + 1, text: pages[q] } }
}

/**
 * 抽一道题（J4–J7）。随机数抽取顺序：本数 → 逐本（sampleBook）→ 逐本格位 → 选中的快捷栏格。
 * @returns {{ k, books: Array<{ slot, pages, edits, goal, label }>, selectedSlot, inHand, hasAppend, hasClear }}
 */
export function sampleBookRound(seed, options) {
  const random = rng(seed)
  const k = between(random, options.books.lo, options.books.hi)
  const used = new Set()
  const books = []
  for (let i = 0; i < k; i++) books.push(sampleBook(random, options, used))
  const free = Array.from({ length: INVENTORY_SLOTS }, (_, i) => i)
  for (const b of books) b.slot = free.splice(Math.floor(random() * free.length), 1)[0]
  const selectedSlot = between(random, 0, 8)
  if (k === 1) books[0].label = null
  return {
    k, books, selectedSlot,
    inHand: books.some((b) => b.slot === selectedSlot),
    hasAppend: books.some((b) => b.edits.some((e) => e.page > b.pages.length)),
    hasClear: books.some((b) => b.edits.some((e) => e.op === 'clear'))
  }
}

/** mod 的到达检测（J11）：{ book: { goals } } */
export const bookExpect = (picked) => ({ book: { goals: picked.books.map((b) => b.goal) } })

const editLine = (e) => (e.op === 'clear' ? `- 第 ${e.page} 页清空` : `- 第 ${e.page} 页的内容改成「${e.text}」`)
const editLines = (edits) => edits.map((e, i) => `${editLine(e)}${i === edits.length - 1 ? '。' : '；'}`).join('\n')

/** J9：一本时只列修改；几本时每本先写"现在第 q 页写着「…」的那本：" */
export function editsText(picked) {
  if (picked.k === 1) return editLines(picked.books[0].edits)
  return picked.books.map((b) => `现在第 ${b.label.page} 页写着「${b.label.text}」的那本：\n${editLines(b.edits)}`).join('\n')
}

const key = (pages) => JSON.stringify(pages ?? [])
const countOf = (lists) => {
  const out = new Map()
  for (const l of lists) out.set(key(l), (out.get(key(l)) ?? 0) + 1)
  return out
}

/**
 * 判定（J10）。final：books（玩家身上，不含光标）、carriedItem、droppedBooks。
 * @returns {{ outcome, reached, done, faults }}
 */
export function judgeBook({ stopped, timedOut, taskState, final, picked }) {
  if (stopped) return { outcome: 'aborted', reached: false, done: null, faults: [] }
  if (!Array.isArray(final?.books)) return { outcome: timedOut ? 'timeout' : 'failed', reached: false, done: null, faults: [] }
  const held = final.books
  const carried = final.carriedItem ?? null
  const dropped = Array.isArray(final.droppedBooks) ? final.droppedBooks : []
  const goals = countOf(picked.books.map((b) => b.goal))
  const writable = held.filter((it) => it.id === WRITABLE && it.count === 1)
  const have = countOf(writable.map((it) => it.pages))
  const reached = !carried && writable.length === held.length && have.size === goals.size && [...goals].every(([k, n]) => have.get(k) === n)
  const done = [...goals].reduce((sum, [k, n]) => sum + Math.min(n, have.get(k) ?? 0), 0)
  const everywhere = [...held, carried, ...dropped].filter(Boolean)
  const found = everywhere.filter((it) => it.id === WRITABLE || it.id === WRITTEN).reduce((sum, it) => sum + (it.count ?? 1), 0)
  const initial = new Set(picked.books.map((b) => key(b.pages)))
  const faults = []
  const books = everywhere.filter((it) => it.id === WRITABLE)
  if (books.some((it) => initial.has(key(it.pages)) && !goals.has(key(it.pages)))) faults.push('unsaved')
  if (books.some((it) => !initial.has(key(it.pages)) && !goals.has(key(it.pages)))) faults.push('wrong')
  if (everywhere.some((it) => it.id === WRITTEN)) faults.push('signed')
  if (carried) faults.push('cursor')
  if (dropped.length) faults.push('dropped')
  let outcome
  if (found < picked.k) outcome = 'lost'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, reached, done, faults: outcome === 'success' ? [] : faults }
}

const editsLabel = (b) => b.edits.map((e) => `${e.op === 'clear' ? '清' : '改'} ${e.page}`).join('、')

export const book = {
  type: 'book',
  options: ['books', 'pages', 'edits'],

  setup(trainer, arena, arenaConfig, args) {
    // item= 是训练器的通用选项，书与笔题用不上，写了就报错，免得以为它起了作用
    if (args.item) throw new Error('书与笔题没有 item= 选项（可用 books= / pages= / edits=）')
    return { arena, arenaConfig, options: bookOptions(args, arenaConfig) }
  },

  startText(ctx) {
    const o = ctx.options
    return `books=${rangeText(o.books)}，pages=${rangeText(o.pages)}，edits=${rangeText(o.edits)}`
  },

  batchFields() {
    return {}
  },

  sample(ctx, seed) {
    return sampleBookRound(seed, ctx.options)
  },

  label(ctx, picked, seed) {
    return `书与笔 ${picked.k} 本：${picked.books.map((b) => `[${b.pages.length} 页，${editsLabel(b)}]`).join(' + ')}（seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      // target 和其他题型一样是字符串（日志、通知、--by target 用）：各本的修改简述用 + 连起来
      target: picked.books.map((b) => b.edits.map((e) => `${e.op === 'clear' ? '清' : '改'}${e.page}`).join(',')).join('+'),
      k: picked.k, books: picked.books.map(({ slot, pages, label, edits, goal }) => ({ slot, pages, label, edits, goal })),
      selectedSlot: picked.selectedSlot, inHand: picked.inHand, hasAppend: picked.hasAppend, hasClear: picked.hasClear,
      done: null, faults: [], final: null, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return {
      items: picked.books.map((b) => ({ slot: b.slot, id: WRITABLE, count: 1, pages: b.pages })),
      seed, watch: [], expect: bookExpect(picked), dayTime: 1000, selectedSlot: picked.selectedSlot
    }
  },

  afterPrepare(ctx, picked, data) {
    const info = data?.book
    if (!info || !Array.isArray(info.items)) return { error: 'arena/prepare: no book info (mod 版本太旧？)', fields: {} }
    if (info.selectedSlot !== picked.selectedSlot) return { error: `arena/prepare: 选中的快捷栏格是 ${info.selectedSlot}，应为 ${picked.selectedSlot}`, fields: {} }
    const wrong = picked.books.filter((b) => !info.items.some((s) => s.slot === b.slot && s.id === WRITABLE && key(s.pages) === key(b.pages)))
    if (wrong.length || info.items.length !== picked.k) return { error: `arena/prepare: 发放的书和题目不一致（${wrong.map((b) => `${b.slot} 号格`).join('、') || `发了 ${info.items.length} 件`}）`, fields: {} }
    return { fields: {} }
  },

  instruction(ctx, picked, prompts) {
    // J9：只写目标；不说怎么拿书、怎么翻页、怎么保存
    return renderTemplate(prompts.training.book, { what: picked.k === 1 ? '一本书与笔' : `${picked.k} 本书与笔`, edits: editsText(picked) })
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0 }) {
    const judged = judgeBook({ stopped, timedOut, taskState, final, picked })
    const reachedAtMs = final?.reachedAtMs ?? null
    return {
      outcome: judged.outcome, reached: judged.reached, done: judged.done, faults: judged.faults,
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final ? { books: final.books ?? null, carriedItem: final.carriedItem ?? null, droppedBooks: final.droppedBooks ?? null, selectedSlot: final.selectedSlot ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { k: record.k ?? null, inHand: record.inHand ?? null, hasAppend: record.hasAppend ?? null, hasClear: record.hasClear ?? null }
  }
}
