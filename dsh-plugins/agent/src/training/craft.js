import { renderTemplate } from '../llm/prompts.js'
import { candidates, craftableResults, fitsGrid, parseCountSpec, sample } from './sampler.js'

/**
 * 合成题型（训练场设计方案；工作台训练场设计方案）：craft2x2 / craft3x3。
 *
 * 从 trainer.js 原样搬来（箱子训练场设计方案 C11）：出题、发放参数、指令、判定、记录字段都和搬家前一样，
 * 随机数序列不变，旧种子仍能复现。
 *
 * 判定只看事实（T4）：crafted 统计有没有增加 + 任务怎么结束的。合成成功不打断 agent，只记时刻。
 *
 * 多份材料、指定产物个数（T14）：每轮发 n 份材料，要求合成 want = m × 单次产量 个；做出的个数 made 由
 * crafted 统计的差值给出（取出几个计几个）。made > want 判 overshoot（失败）。n、m 不写时在默认范围里随机；
 * 显式 n=1 m=1 是单次模式，与 T14 之前完全一样（原模板、原随机数序列、原判定）。
 *
 * 工作台场地：grid=3 的候选按形状分组抽（W4）；prepare 补回工作台并把准星对准它（W2）。
 */

/** 不写 n 时的默认范围（T14） */
const DEFAULT_PORTIONS = '1-64'

/**
 * 判定（T4；给了 wanted 时按 T14 的个数判定：做多了 overshoot，恰好做够才算做成）。
 * @returns {'success'|'crafted_but_failed'|'false_success'|'failed'|'timeout'|'aborted'|'overshoot'}
 */
export function judge({ stopped, timedOut, setupError, taskState, crafted, made = null, wanted = null }) {
  if (stopped || setupError) return 'aborted'
  if (timedOut) return 'timeout'
  if (wanted !== null) {
    if (made > wanted) return 'overshoot'
    crafted = made === wanted
  }
  if (taskState === 'done') return crafted ? 'success' : 'false_success'
  return crafted ? 'crafted_but_failed' : 'failed'
}

/**
 * 本组的 n、m（T14）：命令行 > 场地配置 > 缺省。显式 n=1 m=1 = 单次模式；hidden 场地缺省就是单次模式。
 * @returns {{ single: true } | { single: false, portions: {lo,hi}, crafts: {lo,hi}|null }}  不合法抛错
 */
export function resolveCounts({ portions, crafts }, arenaConfig) {
  const nText = portions ?? arenaConfig.portions ?? null
  const mText = crafts ?? arenaConfig.crafts ?? null
  const n = nText !== null ? parseCountSpec(nText, 'n') : null
  const m = mText !== null ? parseCountSpec(mText, 'm') : null
  const one = (spec) => spec && spec.lo === 1 && spec.hi === 1
  if (one(n) && one(m)) return { single: true }
  if (arenaConfig.mode === 'hidden') {
    if (n === null && m === null) return { single: true }
    throw new Error('hidden 模式不说出目标，没法要求个数：只能用单次模式（n=1 m=1 或不写）')
  }
  const range = n ?? parseCountSpec(DEFAULT_PORTIONS, 'n')
  if (m && m.lo > range.hi) throw new Error(`m 不能大于 n（m=${mText}，n=${nText ?? DEFAULT_PORTIONS}）`)
  return { single: false, portions: range, crafts: m }
}

/** {lo,hi} → "4" / "2-5" */
export function specText({ lo, hi }) {
  return lo === hi ? String(lo) : `${lo}-${hi}`
}

export const craft = {
  type: 'craft',
  /** 这个题型认的 /bt train 选项（runs、seed 各题型都认） */
  options: ['item', 'portions', 'crafts'],

  /** 一组开始前：解析 n、m，备好候选配方与判定范围；不合法抛错 */
  setup(trainer, arena, arenaConfig, args) {
    const counts = resolveCounts(args, arenaConfig)
    const props = counts.single ? null : trainer.itemProps()
    if (!counts.single && !props) throw new Error(`多份模式需要 ${trainer.config.itemProps}（在 dsh-plugins/agent 里运行 npm run extract-item-props）；只练单次合成用 n=1 m=1`)
    const pool = candidates(trainer.recipes(), arenaConfig.exclude, arenaConfig.grid)
    const reach = trainer.recipes().filter((r) => fitsGrid(r, arenaConfig.grid))
    const sampleOptions = { grid: arenaConfig.grid, byShape: arenaConfig.grid >= 3, ...(counts.single ? {} : { portions: counts.portions, crafts: counts.crafts, props }) }
    const ctx = { arena, arenaConfig, counts, pool, reach, sampleOptions, item: args.item ?? null }
    // 目标没有配方、或这个目标的材料怎么都放不下，就当场报错，不等到第一轮
    if (ctx.item) sample(pool, 0, ctx.item, sampleOptions)
    return ctx
  },

  startText(ctx) {
    const what = ctx.item ? `目标 ${ctx.item}` : '每轮随机目标'
    const how = ctx.counts.single ? '单次模式' : `n=${specText(ctx.counts.portions)}，m=${ctx.counts.crafts ? specText(ctx.counts.crafts) : '随 n'}`
    return `${what}，${how}`
  },

  /** 抽样失败时记录里也有的字段 */
  batchFields(ctx) {
    return { grid: ctx.arenaConfig.grid, mode: ctx.arenaConfig.mode, single: ctx.counts.single }
  },

  sample(ctx, seed) {
    const picked = sample(ctx.pool, seed, ctx.item, ctx.sampleOptions)
    return { ...picked, watch: craftableResults(ctx.reach, picked.materials, picked.target) }
  },

  /** 控制台通知、/bt train status 里的"本轮" */
  label(ctx, picked, seed) {
    const amount = ctx.counts.single ? '' : ` ×${picked.wanted}（${picked.portions} 份材料）`
    return `目标 ${picked.target}${amount}（配方 ${picked.recipe}，seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      grid: ctx.arenaConfig.grid, recipe: picked.recipe, shape: picked.shape, target: picked.target, mode: ctx.arenaConfig.mode,
      single: ctx.counts.single, portions: picked.portions, crafts: picked.crafts, yield: picked.yield, wanted: picked.wanted, nMax: picked.nMax,
      items: picked.materials, slots: picked.slots, watch: picked.watch,
      craftedMs: null, reachedMs: null, craftedDelta: 0, made: 0, overshoot: 0, craftedItem: null, inventoryHasTarget: false
    }
  },

  prepareParams(ctx, picked, seed) {
    return { station: ctx.arenaConfig.station, items: picked.slots, seed, watch: picked.watch, dayTime: 1000 }
  },

  /** prepare 的返回 → 记录要补的字段；不能开始就返回 { error } */
  afterPrepare(ctx, picked, data) {
    const fields = {}
    // 超过堆叠上限的堆由 mod 拆开（W5）：记实际发放的槽位
    if (Array.isArray(data?.given)) fields.slots = data.given
    const station = ctx.arenaConfig.station
    if (station && data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the ${station} (aimOk=${data?.aimOk}); check the arena origin`, fields }
    return { fields }
  },

  instruction(ctx, picked, prompts) {
    const template = ctx.counts.single ? `${ctx.arena}_${ctx.arenaConfig.mode}` : `${ctx.arena}_multi`
    return renderTemplate(prompts.training[template], { target: picked.target, portions: picked.portions, want: picked.wanted })
  },

  /** 轮询时：做够了没有（多份模式的 reachedMs，精度同 pollMs） */
  reached(ctx, picked, status) {
    return (status?.craftedDelta?.[picked.target] ?? 0) >= picked.wanted
  },

  /** 本轮结束：最终状态 → 判定与记录字段 */
  finish(ctx, picked, { final, stopped, timedOut, taskState, t0, reachedAt, now }) {
    const single = ctx.counts.single
    const delta = final?.craftedDelta ?? {}
    const crafted = ctx.arenaConfig.mode === 'hidden' ? picked.watch.some((id) => (delta[id] ?? 0) > 0) : (delta[picked.target] ?? 0) > 0
    const made = delta[picked.target] ?? 0
    const craftedAtMs = final?.craftedAtMs ?? null
    // 最后一次轮询之后才做够的：记结束时刻（精度同 pollMs）
    if (reachedAt === null && made >= picked.wanted) reachedAt = now
    const craftedMs = craftedAtMs !== null ? craftedAtMs - t0 : null
    return {
      outcome: judge({ stopped, timedOut, setupError: false, taskState, crafted, ...(single ? {} : { made, wanted: picked.wanted }) }),
      craftedMs,
      reachedMs: single ? (made > 0 ? craftedMs : null) : reachedAt !== null ? reachedAt - t0 : null,
      made,
      overshoot: Math.max(0, made - picked.wanted),
      craftedDelta: delta[picked.target] ?? 0,
      craftedItem: final?.craftedItem ?? null,
      inventoryHasTarget: (final?.inventory?.[picked.target] ?? 0) > 0
    }
  },

  /** 本轮结果通知里的用时 */
  timings(record) {
    return [['合成用时', record.craftedMs]]
  },

  /** 抄进任务历史的训练标记 */
  annotate(record) {
    return { portions: record.portions, crafts: record.crafts }
  }
}
