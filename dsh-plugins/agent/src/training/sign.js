import { renderTemplate } from '../llm/prompts.js'
import { rng } from './sampler.js'
import { HANZI } from './anvil.js'

/**
 * 告示牌题型（docs/告示牌训练场设计方案.md）：正前方一块立着的告示牌，三种题型各考一件事（Q2）：
 *
 * - text：逐行改写或清空正面的文字（Q5）；不发物品
 * - color：用染料把正面文字改成指定颜色；发 32–64 个目标颜色的染料（Q6）
 * - wax：用蜜脾给告示牌涂蜡；发 32–64 个蜜脾
 *
 * - 开局（Q4）：4 行每行 1/2 概率有字（color 题至少一行有字）；颜色在 16 种里随机；不发光、不涂蜡、背面空着
 * - 物品放在 36 格里随机的 1 格；开局手上是空的（选中格在快捷栏里没放物品的格子里抽，Q6）
 * - 判定（Q8）：正面 4 行、颜色、是否涂蜡等于目标，背面空着，编辑已提交，光标为空；
 *   wax 题涂了蜡但文字已经被改过就提前结束（doomed，改不回来，F7）；aborted → lost → timeout → success / false_success / failed
 */

export const INVENTORY_SLOTS = 36
export const LINES = 4
export const KINDS = ['text', 'color', 'wax']
export const SIGN_CHOICES = { kind: KINDS }
export const MAX_EDITS = 4
/** 开局每行有字的概率（Q4）、text 题有字的行被要求清空的概率（Q5） */
export const FILL_CHANCE = 0.5
export const CLEAR_CHANCE = 0.25
/** 每行随机文字的长度（Q7）：6 个汉字远窄于 90 像素，mod 另按编辑框的宽度再查一遍 */
export const TEXT_MIN = 2
export const TEXT_MAX = 6
/** color、wax 题发几个染料、蜜脾（Q6） */
export const ITEM_MIN = 32
export const ITEM_MAX = 64
export const HONEYCOMB = 'minecraft:honeycomb'
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
/** 16 种染料颜色（DyeColor 的序列化名）和游戏里染料的中文名（Q10） */
export const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
export const COLOR_NAMES = {
  white: '白色', orange: '橙色', magenta: '品红色', light_blue: '淡蓝色', yellow: '黄色', lime: '黄绿色', pink: '粉红色', gray: '灰色',
  light_gray: '淡灰色', cyan: '青色', purple: '紫色', blue: '蓝色', brown: '棕色', green: '绿色', red: '红色', black: '黑色'
}
export const dyeOf = (color) => `minecraft:${color}_dye`
/** 没做好的原因（Q8） */
export const FAULTS = ['editing', 'text', 'color', 'wax', 'back', 'cursor', 'dropped']
export const FAULT_NAMES = { editing: '编辑框没关', text: '文字不对', color: '颜色不对', wax: '蜡不对', back: '改了背面', cursor: '光标上有东西', dropped: '扔在地上' }
/** wax 题提前结束的原因代号（Q8） */
export const DOOMED_WAXED = 'waxed-changed'

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
const rangeText = ({ lo, hi }) => (lo === hi ? String(lo) : `${lo}-${hi}`)
const sameLines = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])

/** edits=k|a-b（1–4）：text 题改几行（Q5） */
export function parseSignEditsSpec(text) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(text))
  const lo = match ? Number(match[1]) : NaN
  const hi = match ? Number(match[2] ?? match[1]) : NaN
  if (!(lo >= 1 && hi <= MAX_EDITS && lo <= hi)) throw new Error(`edits 要写 k 或 a-b（1–${MAX_EDITS}，a ≤ b），收到 "${text}"`)
  return { lo, hi }
}

/**
 * 选项（§5.2）：命令行的优先，没写的用场地配置。kind 不写 = 每轮在三种里等概率抽（null）。
 * edits 只给 text 题：和 kind=color / wax 一起写时报错。
 */
export function signOptions(args = {}, config = {}) {
  const kind = args.kind ?? config.kind ?? null
  if (kind !== null && !KINDS.includes(kind)) throw new Error(`告示牌题的 kind 只能是 ${KINDS.join(' / ')}，收到 "${kind}"`)
  if (args.edits && (kind === 'color' || kind === 'wax')) throw new Error(`edits= 只用于 text 题，不能和 kind=${kind} 一起用`)
  return { kind, edits: parseSignEditsSpec(args.edits ?? config.edits ?? '1-3') }
}

/** 一行随机文字（Q7）：2–6 个字符，汉字和字母数字都有，打乱顺序；和 used 里的都不同 */
export function sampleLine(random, used) {
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

/**
 * 抽一道题（Q2–Q6）。随机数抽取顺序：题型（没指定时）→ 开局 4 行（color 题全空时整组重抽）→ 开局颜色 →
 * text：改几行 → 行号 → 逐行（清不清空 → 新文字）；color：目标颜色 → 物品格、数量；wax：物品格、数量 → 选中的快捷栏格。
 * @returns {{ kind, lines, color, goal, goalColor, wax, edits: Array<{ line, op, text? }>, item: { slot, id, count } | null, selectedSlot }}
 */
export function sampleSignRound(seed, options) {
  const random = rng(seed)
  const kind = options.kind ?? pickOne(random, KINDS)
  const used = new Set()
  let lines
  for (;;) {
    lines = Array.from({ length: LINES }, () => (random() < FILL_CHANCE ? sampleLine(random, used) : ''))
    if (kind !== 'color' || lines.some((l) => l !== '')) break
  }
  const color = pickOne(random, COLORS)
  let goal = [...lines]
  let goalColor = color
  let edits = []
  let item = null
  if (kind === 'text') {
    const m = between(random, options.edits.lo, options.edits.hi)
    const candidates = [0, 1, 2, 3]
    const chosen = []
    for (let i = 0; i < m; i++) chosen.push(candidates.splice(Math.floor(random() * candidates.length), 1)[0])
    chosen.sort((a, b) => a - b)
    edits = chosen.map((i) => (lines[i] !== '' && random() < CLEAR_CHANCE
      ? { line: i + 1, op: 'clear' }
      : { line: i + 1, op: 'write', text: sampleLine(random, used) }))
    for (const e of edits) goal[e.line - 1] = e.op === 'clear' ? '' : e.text
  } else if (kind === 'color') {
    goalColor = pickOne(random, COLORS.filter((c) => c !== color))
    item = { slot: between(random, 0, INVENTORY_SLOTS - 1), id: dyeOf(goalColor), count: between(random, ITEM_MIN, ITEM_MAX) }
  } else {
    item = { slot: between(random, 0, INVENTORY_SLOTS - 1), id: HONEYCOMB, count: between(random, ITEM_MIN, ITEM_MAX) }
  }
  const hotbar = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((s) => s !== item?.slot)
  const selectedSlot = pickOne(random, hotbar)
  return { kind, lines, color, goal, goalColor, wax: kind === 'wax', edits, item, selectedSlot }
}

/** mod 的到达检测（Q11）：{ sign: { lines, color, waxed } } */
export const signExpect = (picked) => ({ sign: { lines: picked.goal, color: picked.goalColor, waxed: picked.wax } })

const editLine = (e) => (e.op === 'clear' ? `- 正面第 ${e.line} 行清空` : `- 正面第 ${e.line} 行改成「${e.text}」`)

/** Q10：每项一行，最后一行以句号结尾，其余以分号结尾 */
export function editsText(picked) {
  const items = picked.kind === 'text' ? picked.edits.map(editLine)
    : picked.kind === 'color' ? [`- 物品栏里有 ${dyeOf(picked.goalColor)}，用它把正面文字的颜色改成${COLOR_NAMES[picked.goalColor]}`]
      : [`- 物品栏里有 ${HONEYCOMB}，用它给告示牌涂蜡`]
  return items.map((s, i) => `${s}${i === items.length - 1 ? '。' : '；'}`).join('\n')
}

const backIsBlank = (back) => Array.isArray(back?.lines) && back.lines.every((l) => l === '') && back.color === 'black' && back.glow === false
const total = (counts) => Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0)

/**
 * Q8 的到达条件（按 arena/status 的 sign、carried 算）：正面 4 行、颜色、是否涂蜡等于目标，背面空着，编辑已提交，光标为空。
 */
export function signReached(picked, final) {
  const sign = final?.sign
  if (!sign) return false
  return sameLines(sign.front?.lines, picked.goal) && sign.front?.color === picked.goalColor && sign.waxed === picked.wax
    && backIsBlank(sign.back) && sign.editing === false && total(final.carried) === 0
}

/** Q8：涂了蜡、但文字或颜色已经不是目标，再也改不回来 → 原因文字（训练器据此中止本轮）；否则 null */
export function doomedReason(picked, status) {
  const sign = status?.sign
  if (!sign?.waxed) return null
  if (sameLines(sign.front?.lines, picked.goal) && sign.front?.color === picked.goalColor) return null
  return `告示牌已经涂了蜡，但正面${sameLines(sign.front?.lines, picked.goal) ? '颜色' : '文字'}不是目标，涂蜡后再也改不了`
}

/**
 * 判定（Q8）。final：sign（告示牌不在了为 null）、carried、dropped、stationIntact。
 * @returns {{ outcome, reached, faults }}
 */
export function judgeSign({ stopped, timedOut, taskState, final, picked, doomed = null }) {
  if (stopped && !doomed) return { outcome: 'aborted', reached: false, faults: [] }
  if (final?.stationIntact === false || (final && final.sign === null)) return { outcome: 'lost', reached: false, faults: [] }
  if (!final?.sign) return { outcome: timedOut ? 'timeout' : 'failed', reached: false, faults: [] }
  const sign = final.sign
  const reached = signReached(picked, final)
  const faults = []
  if (sign.editing) faults.push('editing')
  if (!sameLines(sign.front?.lines, picked.goal)) faults.push('text')
  if (sign.front?.color !== picked.goalColor) faults.push('color')
  if (sign.waxed !== picked.wax) faults.push('wax')
  if (doomed && !faults.includes('wax')) faults.push('wax')
  if (!backIsBlank(sign.back)) faults.push('back')
  if (total(final.carried) > 0) faults.push('cursor')
  if (total(final.dropped) > 0) faults.push('dropped')
  let outcome
  if (doomed) outcome = 'failed'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, reached, faults: outcome === 'success' ? [] : faults }
}

const editsLabel = (picked) => picked.edits.map((e) => `${e.op === 'clear' ? '清' : '改'} ${e.line}`).join('、')

export const sign = {
  type: 'sign',
  options: ['kind', 'edits'],

  setup(trainer, arena, arenaConfig, args) {
    // item= 是训练器的通用选项，告示牌题用不上，写了就报错，免得以为它起了作用
    if (args.item) throw new Error('告示牌题没有 item= 选项（可用 kind= / edits=）')
    return { arena, arenaConfig, options: signOptions(args, arenaConfig) }
  },

  startText(ctx) {
    const o = ctx.options
    return `kind=${o.kind ?? '随机'}，edits=${rangeText(o.edits)}（只用于 text 题）`
  },

  batchFields() {
    return {}
  },

  sample(ctx, seed) {
    return sampleSignRound(seed, ctx.options)
  },

  label(ctx, picked, seed) {
    const detail = picked.kind === 'text' ? `：${editsLabel(picked)}`
      : picked.kind === 'color' ? `：${COLOR_NAMES[picked.color]}→${COLOR_NAMES[picked.goalColor]}` : ''
    return `告示牌 ${picked.kind}${detail}（seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      // target 和其他题型一样是字符串（日志、通知、--by target 用）
      target: picked.kind === 'text' ? `text:${picked.edits.map((e) => `${e.op === 'clear' ? '清' : '改'}${e.line}`).join(',')}`
        : picked.kind === 'color' ? `color:${picked.goalColor}` : 'wax',
      kind: picked.kind, lines: picked.lines, goal: picked.goal, edits: picked.edits,
      color: { from: picked.color, to: picked.goalColor }, wax: picked.wax,
      items: picked.item ? [picked.item] : [], selectedSlot: picked.selectedSlot,
      doomed: null, doomedMs: null, faults: [], final: null, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return {
      station: 'sign', seed, watch: [], expect: signExpect(picked), dayTime: 1000,
      items: picked.item ? [{ ...picked.item }] : [],
      selectedSlot: picked.selectedSlot,
      sign: { lines: picked.lines, color: picked.color }
    }
  },

  afterPrepare(ctx, picked, data) {
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the sign (aimOk=${data?.aimOk}); check the arena origin`, fields: {} }
    const info = data?.sign
    const state = info?.state
    if (!state?.front) return { error: 'arena/prepare: no sign info (mod 版本太旧？)', fields: {} }
    if (!sameLines(state.front.lines, picked.lines) || state.front.color !== picked.color || state.front.glow !== false || state.waxed !== false || !backIsBlank(state.back)) {
      return { error: `arena/prepare: 告示牌的开局内容和题目不一致（${JSON.stringify(state)}）`, fields: {} }
    }
    if (info.selectedSlot !== picked.selectedSlot) return { error: `arena/prepare: 选中的快捷栏格是 ${info.selectedSlot}，应为 ${picked.selectedSlot}`, fields: {} }
    const items = Array.isArray(info.items) ? info.items : []
    const want = picked.item ? [picked.item] : []
    const ok = items.length === want.length && want.every((w) => items.some((it) => it.slot === w.slot && it.id === w.id && it.count === w.count))
    if (!ok) return { error: `arena/prepare: 发放的物品和题目不一致（发了 ${JSON.stringify(items.map(({ slot, id, count }) => ({ slot, id, count })))}）`, fields: {} }
    return { fields: {} }
  },

  instruction(ctx, picked, prompts) {
    // Q10：写目标；color / wax 题点明物品栏里有染料 / 蜜脾、要用它（2026-11-24）；不说怎么打开、怎么切行、怎么右键
    return renderTemplate(prompts.training.sign, { edits: editsText(picked) })
  },

  /** Q8：涂了蜡但文字或颜色不是目标 → 原因文字（训练器据此中止本轮）；否则 null */
  doomed(ctx, picked, status) {
    return doomedReason(picked, status)
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0, doomed }) {
    const judged = judgeSign({ stopped, timedOut, taskState, final, picked, doomed })
    const reachedAtMs = final?.reachedAtMs ?? null
    return {
      outcome: judged.outcome, reached: judged.reached, faults: judged.faults,
      doomed: doomed ? DOOMED_WAXED : null,
      doomedMs: doomed ? doomed.at - t0 : null,
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final ? { sign: final.sign ?? null, held: final.held ?? null, carried: final.carried ?? null, dropped: final.dropped ?? null, selectedSlot: final.selectedSlot ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { kind: record.kind ?? null, edits: Array.isArray(record.edits) ? record.edits.length : null }
  }
}
