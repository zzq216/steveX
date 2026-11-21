import { renderTemplate } from '../llm/prompts.js'
import { rng } from './sampler.js'

/**
 * 信标题型（docs/信标训练场设计方案.md）：正前方一个信标，底座（铁块金字塔）埋在地板下、已经搭好；物品栏里有一组付款物品。
 * 要求让信标提供指定的效果，设好后关掉界面。
 *
 * - 目标（G3）：6 个效果；前 5 个可要求 II 级；再生只能当副效果，再生题另抽一个主效果，两个都要求
 * - 底座等级（G2）：在"所需等级到 4"之间随机；prepare 后等信标真的数出这个等级再发任务（ready 钩子）
 * - 付款（G4）：5 种付款物品之一，一格 32–64 个
 * - 判定（G6）：只看最终状态；设置要是原版界面能设出来的，实际给的效果（按 applyEffects 算）里有要求的每一项
 *   aborted → lost → timeout → success / false_success / failed
 * - 到达（G7）：mod 在 tick 里按 expect { beacon } 检测，记 reachedAtMs
 */

export const INVENTORY_SLOTS = 36
export const MAX_LEVEL = 4
export const MAX_COUNT = 64
/** 信标效果按组（BeaconBlockEntity.BEACON_EFFECTS 53–58 行）：第 k 组（0 起）所需等级 k + 1，再生只能当副效果 */
export const BEACON_TIERS = [['minecraft:speed', 'minecraft:haste'], ['minecraft:resistance', 'minecraft:jump_boost'], ['minecraft:strength'], ['minecraft:regeneration']]
export const EFFECTS = BEACON_TIERS.flat()
export const REGENERATION = 'minecraft:regeneration'
/** 能当主效果的 5 个（界面主效果一栏只有前 3 组，BeaconScreen.init 74–86 行） */
export const PRIMARY_EFFECTS = BEACON_TIERS.slice(0, 3).flat()
/** 付款物品（beacon_payment_items，VanillaItemTagsProvider 116 行） */
export const PAYMENTS = ['minecraft:iron_ingot', 'minecraft:gold_ingot', 'minecraft:diamond', 'minecraft:emerald', 'minecraft:netherite_ingot']
export const AMPLIFIER_CHOICES = ['1', '2', 'mix']
export const EFFECT_NAMES = {
  'minecraft:speed': '速度', 'minecraft:haste': '急迫', 'minecraft:resistance': '抗性提升', 'minecraft:jump_boost': '跳跃提升',
  'minecraft:strength': '力量', 'minecraft:regeneration': '再生'
}
/** prepare 后等信标数出底座等级的上限（G2） */
export const READY_TIMEOUT_MS = 10000
export const READY_POLL_MS = 500
/** finish 前等地上的物品被捡回的上限（G6，F7：扔出的物品 2 秒内捡不起来） */
export const SETTLE_TIMEOUT_MS = 3000
export const SETTLE_POLL_MS = 250

const fullId = (id) => (id.includes(':') ? id : `minecraft:${id}`)
const shortId = (id) => id.replace(/^minecraft:/, '')
const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
const roman = (n) => (n === 2 ? 'II' : 'I')

/** 效果的组号 0–3；不是信标效果 → -1 */
export const tierOf = (id) => BEACON_TIERS.findIndex((group) => group.includes(id))

/** 一个要求的所需等级（G3）：II 级和再生要 4 级，其余是组号 + 1 */
export const requiredLevel = (effect, amplifier) => (amplifier === 2 || effect === REGENERATION ? MAX_LEVEL : tierOf(effect) + 1)

function parseRange(text, name, max) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(text))
  const lo = match ? Number(match[1]) : NaN
  const hi = match ? Number(match[2] ?? match[1]) : NaN
  if (!(lo >= 1 && hi <= max && lo <= hi)) throw new Error(`${name} 要写 k 或 a-b（1–${max}，a ≤ b），收到 "${text}"`)
  return { lo, hi }
}

/** level=k|a-b（1–4）：底座等级的范围 */
export const parseLevelSpec = (text) => parseRange(text, 'level', MAX_LEVEL)
/** count=k|a-b（1–64）：付款物品的数量 */
export const parseBeaconCountSpec = (text) => parseRange(text, 'count', MAX_COUNT)

export function parseAmplifier(value) {
  const text = String(value)
  if (!AMPLIFIER_CHOICES.includes(text)) throw new Error(`amplifier 只能是 ${AMPLIFIER_CHOICES.join(' / ')}，收到 "${value}"`)
  return text
}

/**
 * 题目的可选范围（§5.2）：去掉 exclude，按 amplifier、level 过滤；参数冲突直接报错。
 * @returns {{ effects: string[], primaries: string[], amplifier, level: { lo, hi }, count: { lo, hi }, effect, primary, payment }}
 */
export function beaconPool({ exclude = [], amplifier = 'mix', level = '1-4', count = '32-64', effect = null, primary = null, payment = null } = {}) {
  const excluded = new Set(exclude.map(fullId))
  for (const id of excluded) if (tierOf(id) < 0) throw new Error(`exclude 里的 ${id} 不是信标效果`)
  const amp = parseAmplifier(amplifier)
  const lv = typeof level === 'object' ? level : parseLevelSpec(level)
  const cnt = typeof count === 'object' ? count : parseBeaconCountSpec(count)
  const fixedEffect = effect ? fullId(effect) : null
  const fixedPrimary = primary ? fullId(primary) : null
  const fixedPayment = payment ? fullId(payment) : null
  if (fixedEffect && tierOf(fixedEffect) < 0) throw new Error(`effect 要是信标效果之一：${EFFECTS.join('、')}，收到 ${fixedEffect}`)
  if (fixedPayment && !PAYMENTS.includes(fixedPayment)) throw new Error(`payment 要是付款物品之一：${PAYMENTS.join('、')}，收到 ${fixedPayment}`)
  if (fixedPrimary) {
    if (fixedEffect !== REGENERATION) throw new Error('primary 只能和 effect=minecraft:regeneration 一起用')
    if (!PRIMARY_EFFECTS.includes(fixedPrimary)) throw new Error(`primary 要是能当主效果的效果之一：${PRIMARY_EFFECTS.join('、')}，收到 ${fixedPrimary}`)
    if (excluded.has(fixedPrimary)) throw new Error(`primary ${fixedPrimary} 在 exclude 里`)
  }
  if (fixedEffect && excluded.has(fixedEffect)) throw new Error(`effect ${fixedEffect} 在 exclude 里`)
  if (fixedEffect === REGENERATION && amp === '2') throw new Error('再生只有 I 级，不能和 amplifier=2 一起用')
  // 每个效果在这个范围里能不能出：最低要求（I 级；再生 4 级）不超过 level 上限；amplifier=2 时要能出 II 级（4 级）
  const feasible = (id) => {
    if (id === REGENERATION) return amp !== '2' && lv.hi >= MAX_LEVEL
    if (amp === '2') return lv.hi >= MAX_LEVEL
    return requiredLevel(id, 1) <= lv.hi
  }
  if (fixedEffect && !feasible(fixedEffect)) {
    throw new Error(`${fixedEffect}${amp === '2' ? ' II 级' : ''} 要 ${fixedEffect === REGENERATION || amp === '2' ? MAX_LEVEL : requiredLevel(fixedEffect, 1)} 级底座，level=${lv.lo}-${lv.hi} 不够`)
  }
  const effects = (fixedEffect ? [fixedEffect] : EFFECTS.filter((id) => !excluded.has(id))).filter(feasible)
  if (!effects.length) throw new Error(`去掉 exclude、按 level=${lv.lo}-${lv.hi}、amplifier=${amp} 过滤后没有能出的效果`)
  const primaries = fixedPrimary ? [fixedPrimary] : PRIMARY_EFFECTS.filter((id) => !excluded.has(id))
  if (effects.includes(REGENERATION) && !primaries.length) throw new Error('再生题要另抽一个主效果，但前 5 个效果都在 exclude 里')
  return { effects, primaries, amplifier: amp, level: lv, count: cnt, effect: fixedEffect, primary: fixedPrimary, payment: fixedPayment }
}

/**
 * 抽一道题（G2、G3、G4）。随机数抽取顺序：效果 → 级数（或再生题的主效果）→ 底座等级 → 付款物品 → 数量 → 格位。
 * @returns {{ goal: { effects: Array<{ effect, amplifier }>, tier }, target, beaconLevel, payment: { item, count }, layout }}
 */
export function sampleBeacon(pool, seed) {
  const random = rng(seed)
  const effect = pickOne(random, pool.effects)
  let wants
  if (effect === REGENERATION) {
    wants = [{ effect: pickOne(random, pool.primaries), amplifier: 1 }, { effect: REGENERATION, amplifier: 1 }]
  } else {
    const roll = random()
    const amplifier = pool.amplifier === '2' ? 2 : pool.amplifier === '1' || pool.level.hi < MAX_LEVEL ? 1 : roll < 0.5 ? 2 : 1
    wants = [{ effect, amplifier }]
  }
  const tier = Math.max(...wants.map((w) => requiredLevel(w.effect, w.amplifier)))
  const beaconLevel = between(random, Math.max(pool.level.lo, tier), pool.level.hi)
  const item = pool.payment ?? pickOne(random, PAYMENTS)
  const count = between(random, pool.count.lo, pool.count.hi)
  const slot = Math.floor(random() * INVENTORY_SLOTS)
  return { goal: { effects: wants, tier }, target: effect, beaconLevel, payment: { item, count }, layout: [{ slot, id: item, count }] }
}

/** mod 的到达检测（G7）：{ beacon: { payment, effects } } */
export const beaconExpect = (picked) => ({ beacon: { payment: picked.payment.item, effects: picked.goal.effects } })

/**
 * G6 "界面能设出来"（BeaconScreen.init 74–101、183、231 行）：主效果不为空，是前 3 组之一，所需等级不超过 levels；
 * 副效果为空，或者 levels = 4 且副效果是任意一个信标效果。和 mod 的 BeaconArena.legal 一致。
 *
 * 副效果不限于"再生或和主效果相同"（2026-11-20 修正）：界面上先点主效果 X、再点"X II"按钮（副效果设成 X）、再把主效果改成 Y，
 * 副效果仍是 X（BeaconPowerButton.onPress 只改主效果），确认后得到 (Y, X)，信标给 Y I 和 X I。
 */
export function legalSetting(levels, primary, secondary) {
  const tier = tierOf(primary)
  if (tier < 0 || tier > 2 || tier >= levels) return false
  if (!secondary) return true
  return levels >= MAX_LEVEL && tierOf(secondary) >= 0
}

/**
 * 信标实际给的效果（F4，照搬 BeaconBlockEntity.applyEffects）：主效果为空 → 无；levels ≥ 4 且主副相同 → 主效果 II；
 * levels ≥ 4、副效果不为空且不同于主效果 → 另加副效果 I。和 mod 的 BeaconArena.effective 一致。
 */
export function effectiveEffects(levels, primary, secondary) {
  if (!(levels > 0) || !primary) return []
  const out = [{ effect: primary, amplifier: levels >= MAX_LEVEL && primary === secondary ? 2 : 1 }]
  if (levels >= MAX_LEVEL && secondary && secondary !== primary) out.push({ effect: secondary, amplifier: 1 })
  return out
}

const has = (list, w) => list.some((e) => e.effect === w.effect && e.amplifier === w.amplifier)
const total = (counts) => Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0)
const at = (counts, id) => counts?.[id] ?? 0

/** 一次设置满不满足要求：界面能设出来，实际给的效果里有每一项 */
export function satisfies(levels, primary, secondary, wants) {
  if (!legalSetting(levels, primary, secondary)) return false
  const given = effectiveEffects(levels, primary, secondary)
  return wants.every((w) => has(given, w))
}

/**
 * 判定（G6）。final：held、carried、slot、dropped、containerOpen、beacon { levels, primary, secondary }、paid、sets、stationIntact。
 * @returns {{ outcome, reached, effective, extra, illegal, paid, wrongSets }}
 */
export function judgeBeacon({ stopped, timedOut, taskState, final, picked }) {
  const none = { reached: false, effective: null, extra: null, illegal: null, paid: null, wrongSets: null }
  if (stopped) return { outcome: 'aborted', ...none }
  if (!final?.held) return { outcome: final?.stationIntact === false ? 'lost' : timedOut ? 'timeout' : 'failed', ...none }
  const { held, carried = {}, slot = {}, dropped = {}, beacon = null } = final
  const wants = picked.goal.effects
  const payment = picked.payment.item
  const paid = Number.isInteger(final.paid) ? final.paid : 0
  const levels = beacon?.levels ?? 0
  const primary = beacon?.primary ?? null
  const secondary = beacon?.secondary ?? null
  const effective = effectiveEffects(levels, primary, secondary)
  const legal = legalSetting(levels, primary, secondary)
  const illegal = Boolean(primary || secondary) && !legal
  const extra = effective.filter((e) => !has(wants, e))
  // 设错过：某一次付款设出的效果不满足要求（按本轮底座等级算；最后改对了也算）
  const wrongSets = (final.sets ?? []).filter((s) => !satisfies(picked.beaconLevel, s.primary ?? null, s.secondary ?? null, wants)).length
  const reached = final.containerOpen === false && total(carried) === 0 && total(dropped) === 0 &&
    Object.keys(held).every((id) => id === payment) && legal && wants.every((w) => has(effective, w))
  const accounted = at(held, payment) + at(carried, payment) + at(slot, payment) + at(dropped, payment) + paid
  let outcome
  if (final.stationIntact === false || !beacon || total(dropped) > 0 || accounted < picked.payment.count) outcome = 'lost'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, reached, effective, extra, illegal, paid, wrongSets }
}

/** 任务里的效果列表：minecraft:speed 2 级；再生题 minecraft:haste 1 级和 minecraft:regeneration 1 级（主效果在前，G5） */
export const effectsText = (wants) => wants.map((w) => `${w.effect} ${w.amplifier} 级`).join('和')
const goalLabel = (wants) => wants.map((w) => `${w.effect} ${roman(w.amplifier)}`).join(' + ')

export const beacon = {
  type: 'beacon',
  options: ['effect', 'amplifier', 'primary', 'level', 'payment', 'count'],

  setup(trainer, arena, arenaConfig, args) {
    if (args.item) throw new Error('信标场地用 payment= 指定付款物品（item= 是合成题、箱子题、附魔台题的选项）')
    const pool = beaconPool({
      exclude: arenaConfig.exclude ?? [],
      amplifier: args.amplifier ?? arenaConfig.amplifier ?? 'mix',
      level: args.level ?? '1-4',
      count: args.count ?? arenaConfig.count ?? '32-64',
      effect: args.effect ?? null,
      primary: args.primary ?? null,
      payment: args.payment ?? null
    })
    return { arena, arenaConfig, pool }
  },

  startText(ctx) {
    const p = ctx.pool
    const parts = [
      p.effect ? `效果 ${p.effect}` : `效果 ${p.effects.length} 种`,
      p.primary ? `主效果 ${p.primary}` : null,
      `amplifier=${p.amplifier}`, `level=${p.level.lo}-${p.level.hi}`,
      p.payment ? `付款 ${p.payment}` : null,
      `count=${p.count.lo}-${p.count.hi}`
    ]
    return parts.filter(Boolean).join('，')
  },

  batchFields() {
    return {}
  },

  sample(ctx, seed) {
    return sampleBeacon(ctx.pool, seed)
  },

  label(ctx, picked, seed) {
    return `信标 ${goalLabel(picked.goal.effects)}（底座 ${picked.beaconLevel} 级，付 ${shortId(picked.payment.item)}×${picked.payment.count}，seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      // target 和其他题型一样是字符串（日志、通知、--by target 用）：目标效果，再生题是 minecraft:regeneration；完整要求在 goal（方案 G8）
      target: picked.target, goal: picked.goal, beaconLevel: picked.beaconLevel, payment: picked.payment, layout: picked.layout,
      paid: null, sets: null, effective: null, extra: null, illegal: null, wrongSets: null, readyMs: null,
      final: null, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return { station: 'beacon', items: picked.layout, seed, watch: [], expect: beaconExpect(picked), dayTime: 1000, beaconLevel: picked.beaconLevel }
  },

  afterPrepare(ctx, picked, data) {
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the beacon (aimOk=${data?.aimOk}); check the arena origin`, fields: {} }
    if (!data?.beacon) return { error: 'arena/prepare: no beacon info (mod 版本太旧？)', fields: {} }
    if (data.beacon.baseLevel !== picked.beaconLevel) return { error: `arena/prepare: 底座 ${data.beacon.baseLevel} 层，应为 ${picked.beaconLevel} 层`, fields: {} }
    return { fields: {} }
  },

  /**
   * G2：新放的信标等级是 0，要等它查完光柱、到 80 tick 的整数倍才数底座。每 0.5 秒读一次 status，等 beacon.levels 等于本轮等级；
   * 10 秒还没对上 → 报错（本轮 aborted 并停止整组），最常见的原因是信标上方有不透光的方块挡住光柱。
   */
  async ready(ctx, picked, { call, sleep, now }) {
    const start = now()
    let levels = null
    for (;;) {
      const res = await call('arena/status', {})
      levels = res?.ok ? res.data?.beacon?.levels ?? null : null
      if (levels === picked.beaconLevel) return { fields: { readyMs: now() - start } }
      if (now() - start >= READY_TIMEOUT_MS) break
      await sleep(READY_POLL_MS)
    }
    return { error: `信标等级不对：等了 ${READY_TIMEOUT_MS / 1000} 秒，读到 ${levels}，应为 ${picked.beaconLevel}（信标上方的光柱被挡住了？）`, fields: {} }
  },

  /** G6：地上有物品时（关界面时付款格里的物品是扔出去的，F7），finish 前最多等 3 秒让 agent 捡回来 */
  async settle(ctx, picked, { call, sleep, now }) {
    const start = now()
    for (;;) {
      const res = await call('arena/status', {})
      if (!res?.ok || total(res.data?.dropped) === 0) return
      if (now() - start >= SETTLE_TIMEOUT_MS) return
      await sleep(SETTLE_POLL_MS)
    }
  },

  instruction(ctx, picked, prompts) {
    // G5：只说现状和要求；不提付款格、主副效果、container/beacon
    return renderTemplate(prompts.training.beacon, { payment: picked.payment.item, effects: effectsText(picked.goal.effects) })
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0 }) {
    const judged = judgeBeacon({ stopped, timedOut, taskState, final, picked })
    const reachedAtMs = final?.reachedAtMs ?? null
    const sets = Array.isArray(final?.sets) ? final.sets.map((s) => ({ primary: s.primary ?? null, secondary: s.secondary ?? null, ms: Number.isFinite(s.atMs) ? s.atMs - t0 : null })) : null
    return {
      outcome: judged.outcome, reached: judged.reached,
      paid: judged.paid, sets, effective: judged.effective, extra: judged.extra, illegal: judged.illegal, wrongSets: judged.wrongSets,
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final ? { held: final.held ?? null, carried: final.carried ?? null, slot: final.slot ?? null, dropped: final.dropped ?? null, containerOpen: final.containerOpen ?? null, beacon: final.beacon ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { effect: record.target ?? null, beaconLevel: record.beaconLevel ?? null }
  }
}
