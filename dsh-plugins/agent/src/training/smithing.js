import { renderTemplate } from '../llm/prompts.js'
import { rng } from './sampler.js'

/**
 * 锻造台题型（docs/锻造台训练场设计方案.md）：正前方一个锻造台，物品栏里有做出 n 件物品（1–4）所需的材料，每件正好一份。
 * 要求把它们都做出来，放在物品栏里。不要求关界面。
 *
 * - 题目来源（M2）：arena/smithing-catalog 从游戏里读出的升级配方、纹饰配方、可加纹饰的盔甲、纹饰材料，去掉 exclude
 * - 出题（M3）：题数在 tasks 里等概率；每道题先在 升级 / 纹饰 里等概率选一类；纹饰题的样式、盔甲、材料各自等概率；同一轮不出完全相同的目标
 * - 预览（M4）：arena/smithing-preview 用服务器的锻造配方算每道题的产物，和预期的目标对不上就整组重抽，最多重抽 MAX_RETRIES 次
 * - 文案（M5）：只写目标（物品、纹饰样式、纹饰材料的注册名），不列发了什么材料
 * - 判定（M6）：玩家身上（不含光标）能给每道题配上各不相同的一件，物品 id 和纹饰都对上；aborted → lost → timeout → success / false_success / failed
 * - 到达（M7）：mod 在 tick 里按 expect { smithing } 检测，记 reachedAtMs
 */

export const INVENTORY_SLOTS = 36
export const KINDS = ['upgrade', 'trim']
export const KIND_NAMES = { upgrade: '升级', trim: '纹饰', mix: '混合' }
export const MAX_TASKS = 4
export const MAX_RETRIES = 20
/** 同一轮里抽到和前面相同的目标时，这一道最多重抽几次；还是重复就少出这一道（§5.2） */
const MAX_DUPLICATE_DRAWS = 50
export const SMITHING_CHOICES = { kind: KINDS }

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
const fullId = (id) => (id.includes(':') ? id : `minecraft:${id}`)
const shortId = (id) => id.replace(/^minecraft:/, '')

/** tasks=k|a-b（1–4）：一轮几道题 */
export function parseTasksSpec(text) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(text))
  const lo = match ? Number(match[1]) : NaN
  const hi = match ? Number(match[2] ?? match[1]) : NaN
  if (!(lo >= 1 && hi <= MAX_TASKS && lo <= hi)) throw new Error(`tasks 要写 k 或 a-b（1–${MAX_TASKS}，a ≤ b），收到 "${text}"`)
  return { lo, hi }
}

/**
 * 选项（§5.2）：命令行的优先，没写的用场地配置。kind=upgrade 和 pattern / material 一起写就报错；
 * base 属不属于这一类要等读到 catalog 才知道（{@link smithingTables} 之后的 {@link checkFixed}）。
 */
export function smithingOptions(args = {}, config = {}) {
  const kind = args.kind ?? null
  if (kind !== null && !KINDS.includes(kind)) throw new Error(`锻造台场地的 kind 只能是 ${KINDS.join(' / ')}，收到 "${kind}"`)
  const pattern = args.pattern ? fullId(args.pattern) : null
  const material = args.material ? fullId(args.material) : null
  if (kind === 'upgrade' && (pattern || material)) {
    throw new Error(`升级题（kind=upgrade）没有纹饰，不能和 ${[pattern && 'pattern', material && 'material'].filter(Boolean).join('、')} 一起用`)
  }
  return { tasks: parseTasksSpec(args.tasks ?? config.tasks ?? '1-4'), kind, base: args.base ? fullId(args.base) : null, pattern, material }
}

/**
 * 题目表（M2）：catalog 去掉 exclude。exclude 里可以写底材、升级结果、模板、纹饰样式、纹饰材料或材料物品的 id。
 * 全部按 id 排序（同一种子出同一组题）。
 * @param {{ upgrades, trims, armors, materials }} catalog  arena/smithing-catalog 的结果
 */
export function smithingTables(catalog, exclude = []) {
  const excluded = new Set(exclude.map(fullId))
  const byId = (key) => (a, b) => a[key].localeCompare(b[key])
  const upgrades = (catalog?.upgrades ?? []).filter((u) => u.template && u.addition?.length && !excluded.has(u.base) && !excluded.has(u.result)).sort(byId('base'))
  const trims = (catalog?.trims ?? []).filter((t) => !excluded.has(t.template) && !excluded.has(t.pattern)).sort(byId('pattern'))
  const armors = (catalog?.armors ?? []).filter((id) => !excluded.has(id)).sort()
  const materials = (catalog?.materials ?? []).filter((m) => !excluded.has(m.item) && !excluded.has(m.material)).sort(byId('material'))
  return { upgrades, trims, armors, materials }
}

/** 固定参数和题目表对得上（§5.2）：base 在这一类里、pattern / material 存在；返回每道题能出的类别 */
export function checkFixed(tables, options) {
  const { base, pattern, material } = options
  if (pattern && !tables.trims.some((t) => t.pattern === pattern)) throw new Error(`没有纹饰样式 ${pattern}（不存在，或者被 exclude 排除；写注册名，如 minecraft:sentry）`)
  if (material && !tables.materials.some((m) => m.material === material)) throw new Error(`没有纹饰材料 ${material}（不存在，或者被 exclude 排除；写材料的注册名，如 minecraft:gold）`)
  let kinds = options.kind ? [options.kind] : pattern || material ? ['trim'] : [...KINDS]
  if (base) {
    const upgradable = tables.upgrades.some((u) => u.base === base)
    const trimmable = tables.armors.includes(base)
    kinds = kinds.filter((k) => (k === 'upgrade' ? upgradable : trimmable))
    if (!kinds.length) {
      if (!upgradable && !trimmable) throw new Error(`${base} 不能锻造（不是升级配方的底材，也不是可加纹饰的盔甲，或者被 exclude 排除）`)
      throw new Error(`${base} ${upgradable ? '只能出升级题' : '只能出纹饰题'}，和 ${options.kind ? `kind=${options.kind}` : 'pattern / material'} 冲突`)
    }
  }
  for (const k of kinds) {
    if (k === 'upgrade' && !tables.upgrades.length) throw new Error('没有升级配方可出（arena/smithing-catalog 没有返回，或者全被 exclude 排除）')
    if (k === 'trim' && !(tables.trims.length && tables.armors.length && tables.materials.length)) throw new Error('没有纹饰题可出（纹饰样式、盔甲或纹饰材料是空的）')
  }
  return kinds
}

const goalKey = (goal) => `${goal.item}|${goal.trim?.pattern ?? ''}|${goal.trim?.material ?? ''}`

/** 一道题（M3）：类别 → 配方或样式 → 盔甲 → 材料（固定了的项不抽）。@returns { kind, template, base, addition, goal } */
function sampleTask(random, tables, options, kinds) {
  const kind = kinds.length === 1 ? kinds[0] : pickOne(random, kinds)
  if (kind === 'upgrade') {
    const pool = options.base ? tables.upgrades.filter((u) => u.base === options.base) : tables.upgrades
    const u = pickOne(random, pool)
    return { kind, template: u.template, base: u.base, addition: u.addition[0], goal: { item: u.result, trim: null } }
  }
  const t = options.pattern ? tables.trims.find((x) => x.pattern === options.pattern) : pickOne(random, tables.trims)
  const armor = options.base ?? pickOne(random, tables.armors)
  const m = options.material ? tables.materials.find((x) => x.material === options.material) : pickOne(random, tables.materials)
  return { kind, template: t.template, base: armor, addition: m.item, goal: { item: armor, trim: { pattern: t.pattern, material: m.material } } }
}

/**
 * 抽一组题（M3）。随机数抽取顺序：题数 → 逐道（类别 → 配方或样式 → 盔甲 → 材料）→ 格位。
 * 同一轮不出完全相同的目标：重复的这一道重抽，抽 MAX_DUPLICATE_DRAWS 次还重复就少出这一道。
 * 格位：模板、材料同种的合成一堆（都能叠 64）；底材是工具、盔甲，各占一格。每堆放在主物品栏 36 格里随机的格子。
 * @returns {{ tasks: Array<{ kind, template, base, addition, goal }>, kind: 'upgrade'|'trim'|'mix', layout: Array<{ slot, id, count }> }}
 */
export function sampleSmithing(tables, seed, options) {
  const kinds = checkFixed(tables, options)
  const random = rng(seed)
  const n = between(random, options.tasks.lo, options.tasks.hi)
  const tasks = []
  const seen = new Set()
  for (let i = 0; i < n; i++) {
    for (let draw = 0; draw < MAX_DUPLICATE_DRAWS; draw++) {
      const task = sampleTask(random, tables, options, kinds)
      if (seen.has(goalKey(task.goal))) continue
      seen.add(goalKey(task.goal))
      tasks.push(task)
      break
    }
  }
  const stacks = []
  const merged = new Map()
  for (const t of tasks) {
    for (const id of [t.template, t.addition]) {
      if (merged.has(id)) merged.get(id).count++
      else {
        const entry = { id, count: 1 }
        merged.set(id, entry)
        stacks.push(entry)
      }
    }
    stacks.push({ id: t.base, count: 1 })
  }
  const free = Array.from({ length: INVENTORY_SLOTS }, (_, i) => i)
  const layout = stacks.map((s) => ({ slot: free.splice(Math.floor(random() * free.length), 1)[0], id: s.id, count: s.count }))
  const kindSet = new Set(tasks.map((t) => t.kind))
  return { tasks, kind: kindSet.size === 1 ? [...kindSet][0] : 'mix', layout }
}

const sameTrim = (a, b) => (a ?? null) === null ? (b ?? null) === null : Boolean(b) && a.pattern === b.pattern && a.material === b.material

/** 一件物品是不是这个目标（M6）：物品 id 相同，纹饰相同（目标没有纹饰时物品也不能有） */
export const matchesGoal = (stack, goal) => Boolean(stack) && stack.id === goal.item && sameTrim(goal.trim, stack.trim)

/** 预览对得上（M4）：每道题的产物 id 和纹饰都和预期的目标相同 */
export const acceptPreview = (task, data) => Boolean(data?.result) && matchesGoal(data.result, task.goal)

/** 最多能给几个目标配上各不相同的一件（M6，回溯；最多 4 个目标） */
export function maxAssigned(stacks, goals) {
  const used = new Array(stacks.length).fill(false)
  let best = 0
  const walk = (g, matched) => {
    if (matched + (goals.length - g) <= best) return
    if (g === goals.length) {
      best = matched
      return
    }
    for (let i = 0; i < stacks.length; i++) {
      if (used[i] || !matchesGoal(stacks[i], goals[g])) continue
      used[i] = true
      walk(g + 1, matched + 1)
      used[i] = false
    }
    walk(g + 1, matched)
  }
  walk(0, 0)
  return best
}

/** mod 的到达检测（M7）：{ smithing: [{ item, trim }] } */
export const smithingExpect = (picked) => ({ smithing: picked.tasks.map((t) => ({ item: t.goal.item, trim: t.goal.trim })) })

/** 文案里的一行（M5）：升级题只写物品；纹饰题写样式和材料的注册名 */
export const goalText = (goal) => (goal.trim ? `带纹饰（样式 ${goal.trim.pattern}，材料 ${goal.trim.material}）的 ${goal.item}` : goal.item)
const goalLabel = (goal) => (goal.trim ? `${shortId(goal.item)}[${shortId(goal.trim.pattern)}/${shortId(goal.trim.material)}]` : shortId(goal.item))

const count = (s) => (Number.isInteger(s?.count) ? s.count : 1)

/**
 * 判定（M6）。final：items、carriedItem、slots{ template, base, addition }、droppedItems、containerOpen、takes、stationIntact。
 * @returns {{ outcome, reached, goalsMet, takes, wrongTakes }}
 */
export function judgeSmithing({ stopped, timedOut, taskState, final, picked }) {
  const none = { reached: false, goalsMet: null, takes: null, wrongTakes: null }
  if (stopped) return { outcome: 'aborted', ...none }
  if (!Array.isArray(final?.items)) return { outcome: final?.stationIntact === false ? 'lost' : timedOut ? 'timeout' : 'failed', ...none }
  const goals = picked.tasks.map((t) => t.goal)
  const goalsMet = maxAssigned(final.items, goals)
  const reached = goalsMet === goals.length
  const takes = Array.isArray(final.takes) ? final.takes.length : null
  // 配错：有一次取出的产物和任何一道题的目标都对不上（M10）
  const wrongTakes = Array.isArray(final.takes) ? final.takes.filter((t) => !goals.some((g) => matchesGoal(t.result, g))).length : null
  // 相关物品（底材或目标的物品 id）在玩家身上、光标、锻造台三格、场内地上加起来不到 n 件 → 丢了（做成产物件数不变）
  const related = new Set(picked.tasks.flatMap((t) => [t.base, t.goal.item]))
  const slots = final.slots ? [final.slots.template, final.slots.base, final.slots.addition] : []
  const where = [...final.items, final.carriedItem ?? null, ...slots, ...(final.droppedItems ?? [])]
  const found = where.filter((s) => s && related.has(s.id)).reduce((n, s) => n + count(s), 0)
  let outcome
  if (final.stationIntact === false || found < picked.tasks.length) outcome = 'lost'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, reached, goalsMet, takes, wrongTakes }
}

export const smithing = {
  type: 'smithing',
  options: ['tasks', 'kind', 'base', 'pattern', 'material'],

  setup(trainer, arena, arenaConfig, args) {
    const options = smithingOptions(args, arenaConfig)
    return { arena, arenaConfig, options, tables: null }
  },

  startText(ctx) {
    const o = ctx.options
    const parts = [
      `每轮 ${o.tasks.lo === o.tasks.hi ? o.tasks.lo : `${o.tasks.lo}-${o.tasks.hi}`} 道题`,
      o.kind ? `只出${KIND_NAMES[o.kind]}题` : o.pattern || o.material ? '只出纹饰题' : '升级、纹饰等概率',
      o.base ? `底材 ${o.base}` : null,
      o.pattern ? `纹饰样式 ${o.pattern}` : null,
      o.material ? `纹饰材料 ${o.material}` : null
    ]
    return parts.filter(Boolean).join('，')
  },

  batchFields() {
    return {}
  },

  /** 题目来源要问 mod，抽题放在 preview 里做（M3、M4） */
  sample(ctx, seed) {
    return { seed }
  },

  /**
   * 出题（M3、M4）：第一次先读 catalog；每次抽一组题、逐道预览，有一道对不上就用 seed + 1、+ 2……整组重抽，最多 MAX_RETRIES 次。
   * @param {(method: string, params: object) => Promise<{ ok, data?, error? }>} call  mod 调用
   */
  async preview(ctx, picked, seed, call) {
    if (!ctx.tables) {
      const res = await call('arena/smithing-catalog', {})
      if (!res?.ok) throw new Error(`arena/smithing-catalog: ${res?.error ?? 'no response'}`)
      ctx.tables = smithingTables(res.data, ctx.arenaConfig.exclude ?? [])
    }
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      const current = sampleSmithing(ctx.tables, (seed + retry) >>> 0, ctx.options)
      let ok = current.tasks.length > 0
      for (const task of current.tasks) {
        if (!ok) break
        const res = await call('arena/smithing-preview', { template: task.template, base: task.base, addition: task.addition })
        if (!res?.ok) throw new Error(`arena/smithing-preview: ${res?.error ?? 'no response'}`)
        ok = acceptPreview(task, res.data)
      }
      if (ok) return { ...current, retries: retry }
    }
    throw new Error(`抽不出能做的题：连续 ${MAX_RETRIES + 1} 次预览的产物都和预期的目标对不上`)
  },

  label(ctx, picked, seed) {
    return `锻造 ${picked.tasks.length} 件：${picked.tasks.map((t) => goalLabel(t.goal)).join(' + ')}（seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      // target 和其他题型一样是字符串（日志、通知、--by target 用）：目标的简写，多道题用 + 连起来（M10）
      target: picked.tasks.map((t) => goalLabel(t.goal)).join('+'),
      kind: picked.kind, tasks: picked.tasks, retries: picked.retries ?? 0, layout: picked.layout,
      takes: null, goalsMet: null, wrongTakes: null,
      final: null, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return { station: 'smithing_table', items: picked.layout, seed, watch: [], expect: smithingExpect(picked), dayTime: 1000 }
  },

  afterPrepare(ctx, picked, data) {
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the smithing table (aimOk=${data?.aimOk}); check the arena origin`, fields: {} }
    const info = data?.smithing
    if (!info) return { error: 'arena/prepare: no smithing info (mod 版本太旧？)', fields: {} }
    const wrong = picked.layout.filter((g) => !(info.items ?? []).some((s) => s.slot === g.slot && s.id === g.id && s.count === g.count))
    if (wrong.length) return { error: `arena/prepare: 发放的物品和题目不一致（${wrong.map((g) => `${g.slot} 号格 ${g.id} ×${g.count}`).join('、')}）`, fields: {} }
    return { fields: {} }
  },

  instruction(ctx, picked, prompts) {
    // M5：只写目标；不说怎么打开、哪件放哪一格，也不列发了什么材料
    const goals = picked.tasks.map((t, i) => `${i + 1}. ${goalText(t.goal)}`).join('\n')
    return renderTemplate(prompts.training.smithing, { n: picked.tasks.length, goals })
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0 }) {
    const judged = judgeSmithing({ stopped, timedOut, taskState, final, picked })
    const reachedAtMs = final?.reachedAtMs ?? null
    const takes = Array.isArray(final?.takes)
      ? final.takes.map((t) => ({ result: t.result ?? null, ms: Number.isFinite(t.atMs) ? t.atMs - t0 : null }))
      : null
    return {
      outcome: judged.outcome, reached: judged.reached, goalsMet: judged.goalsMet, wrongTakes: judged.wrongTakes, takes,
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final ? { items: final.items ?? null, carriedItem: final.carriedItem ?? null, slots: final.slots ?? null, dropped: final.droppedItems ?? null, containerOpen: final.containerOpen ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { kind: record.kind ?? null, tasks: Array.isArray(record.tasks) ? record.tasks.length : null, goalsMet: record.goalsMet ?? null }
  }
}
