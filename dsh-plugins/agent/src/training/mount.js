import { renderTemplate } from '../llm/prompts.js'
import { rng } from './sampler.js'
import { storagePool } from './storage.js'

/**
 * 坐骑题型（docs/坐骑训练场设计方案.md）：正前方一只已驯服、不会动的成年动物。装上的题要求把鞍 / 马铠 / 地毯 / 鹦鹉螺铠装到它身上，
 * 驴、骡、羊驼另要把 k 个物品放进它身上的箱子；卸下的题反过来。不要求关界面、不要求下坐骑。
 *
 * - 装备池（H10）：arena/mount-catalog 从游戏里试出每种动物的鞍槽、身体槽能装什么、箱子几格
 * - 出题（H3）：组 → 组里的动物 → 任务 → 装备 → 物品 → 总数和两格的分法 → k → 羊驼的力量 → 格位
 * - 文案（H4）：只写目标，不写怎么打开、不写格子编号
 * - 判定（H5）：只看最终状态；aborted → lost → overshoot → misplaced → success / false_success / failed / timeout
 * - 到达（H6）：mod 在 tick 里按 expect { mount } 检测，记 reachedAtMs；另记第一次骑上、不开界面装备
 */

export const INVENTORY_SLOTS = 36
export const GROUPS = ['horse', 'donkey', 'camel', 'llama', 'nautilus']
export const GROUP_NAMES = { horse: '马', donkey: '驴', camel: '骆驼', llama: '羊驼', nautilus: '鹦鹉螺' }
/** 动物 → 组（H3）；顺序就是组内的抽样顺序 */
export const GROUP_OF = Object.freeze({
  'minecraft:horse': 'horse', 'minecraft:zombie_horse': 'horse',
  'minecraft:donkey': 'donkey', 'minecraft:mule': 'donkey',
  'minecraft:camel': 'camel', 'minecraft:camel_husk': 'camel',
  'minecraft:llama': 'llama', 'minecraft:trader_llama': 'llama',
  'minecraft:nautilus': 'nautilus', 'minecraft:zombie_nautilus': 'nautilus'
})
export const ANIMAL_NAMES = {
  'minecraft:horse': '马', 'minecraft:zombie_horse': '僵尸马', 'minecraft:donkey': '驴', 'minecraft:mule': '骡',
  'minecraft:camel': '骆驼', 'minecraft:camel_husk': '骆驼尸壳', 'minecraft:llama': '羊驼', 'minecraft:trader_llama': '行商羊驼',
  'minecraft:nautilus': '鹦鹉螺', 'minecraft:zombie_nautilus': '僵尸鹦鹉螺'
}
/** 有箱子的组（H3） */
export const CHEST_GROUPS = ['donkey', 'llama']
export const TASKS = ['equip', 'unequip']
export const TASK_NAMES = { equip: '装上', unequip: '卸下' }
export const MOUNT_CHOICES = { group: GROUPS, task: TASKS }
export const STACK = 64
export const MAX_TOTAL = 2 * STACK
export const MAX_STRENGTH = 5
export const DONKEY_CHEST = 15

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
const fullId = (id) => (id.includes(':') ? id : `minecraft:${id}`)
const shortId = (id) => id.replace(/^minecraft:/, '')

function parseRange(name, text, lo, hi) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(text))
  const a = match ? Number(match[1]) : NaN
  const b = match ? Number(match[2] ?? match[1]) : NaN
  if (!(a >= lo && b <= hi && a <= b)) throw new Error(`${name} 要写 k 或 a-b（${lo}–${hi}，a ≤ b），收到 "${text}"`)
  return { lo: a, hi: b }
}

/** total=k|a-b（2–128）：两格物品的总数 */
export const parseMountTotal = (text) => parseRange('total', text, 2, MAX_TOTAL)
/** move=k|a-b（1–64）：要搬的数量 k */
export const parseMountMove = (text) => parseRange('move', text, 1, STACK)

/** 场地配置的 groups：GROUPS 的非空子集 */
export function parseMountGroups(value) {
  if (!Array.isArray(value) || !value.length || value.some((g) => !GROUPS.includes(g))) throw new Error(`groups 要是 ${GROUPS.join(' / ')} 里的一个或几个，收到 ${JSON.stringify(value)}`)
  return [...new Set(value)]
}

/**
 * 选项（§5.2）：命令行的优先，没写的用场地配置。冲突直接报错：animal 不属于 group；item / total / move 和没有箱子的组一起用；
 * move 的下限大于 total 的下限。
 */
export function mountOptions(args = {}, config = {}) {
  const group = args.group ?? null
  if (group !== null && !GROUPS.includes(group)) throw new Error(`group 只能是 ${GROUPS.join(' / ')}，收到 "${group}"`)
  const animal = args.animal ? fullId(args.animal) : null
  if (animal && !GROUP_OF[animal]) throw new Error(`animal 只能是 ${Object.keys(GROUP_OF).join('、')}，收到 "${args.animal}"`)
  if (animal && group && GROUP_OF[animal] !== group) throw new Error(`${animal} 属于 ${GROUP_OF[animal]} 组，和 group=${group} 冲突`)
  const task = args.task ?? null
  if (task !== null && !TASKS.includes(task)) throw new Error(`坐骑场地的 task 只能是 ${TASKS.join(' / ')}，收到 "${task}"`)
  const chestOnly = ['item', 'total', 'move'].filter((k) => args[k] !== null && args[k] !== undefined)
  const fixedGroup = animal ? GROUP_OF[animal] : group
  if (chestOnly.length && fixedGroup && !CHEST_GROUPS.includes(fixedGroup)) throw new Error(`${fixedGroup} 组的动物没有箱子，不能和 ${chestOnly.join('、')} 一起用`)
  const total = parseMountTotal(args.total ?? config.total ?? '64-128')
  const move = parseMountMove(args.move ?? config.move ?? '1-64')
  if (move.lo > total.lo) throw new Error(`move 的下限 ${move.lo} 大于 total 的下限 ${total.lo}，会抽出搬不了那么多的题`)
  let groups = parseMountGroups(config.groups ?? GROUPS)
  if (fixedGroup) groups = [fixedGroup]
  else if (chestOnly.length) {
    groups = groups.filter((g) => CHEST_GROUPS.includes(g))
    if (!groups.length) throw new Error(`场地配置的 groups 里没有带箱子的组（${CHEST_GROUPS.join(' / ')}），不能用 ${chestOnly.join('、')}`)
  }
  return { groups, group, animal, task, item: args.item ? fullId(args.item) : null, total, move }
}

/**
 * 装备池（H10）：catalog 的每种动物 → { id, group, saddle: [item], body: [item], chest: 0 | 15 | 'strength' }。
 * 物品池（H3）：箱子方案 C3 的物品池里堆叠上限 64 的，去掉 exclude，也去掉能当装备的物品（地毯等，免得和装备混在一起计数）。
 */
export function mountTables(catalog, props, exclude = []) {
  const animals = new Map()
  const equipment = new Set()
  for (const a of catalog?.animals ?? []) {
    if (!GROUP_OF[a.id]) continue
    animals.set(a.id, { id: a.id, group: a.group ?? GROUP_OF[a.id], saddle: [...(a.saddle ?? [])].sort(), body: [...(a.body ?? [])].sort(), chest: a.chest ?? 0 })
    for (const id of [...(a.saddle ?? []), ...(a.body ?? [])]) equipment.add(id)
  }
  const pool = storagePool(props, exclude).filter((id) => props[id]?.maxStack === STACK && !equipment.has(id))
  return { animals, pool }
}

/**
 * 抽一道题（H3）。随机数抽取顺序：组 → 组里的动物 → 任务 → 装备 → 物品 → 总数和两格的分法 → k → 羊驼的力量 → 格位。固定了的项不抽。
 * @returns {{ group, animal, task, equipment: { saddle, body }, item, total, split, move, strength, chestSize, layout, chestLayout }}
 */
export function sampleMount(tables, seed, options) {
  const random = rng(seed)
  const group = options.animal ? GROUP_OF[options.animal] : options.groups.length === 1 ? options.groups[0] : pickOne(random, options.groups)
  const candidates = Object.keys(GROUP_OF).filter((id) => GROUP_OF[id] === group && tables.animals.has(id))
  if (!candidates.length) throw new Error(`装备池里没有 ${group} 组的动物（arena/mount-catalog 没有返回）`)
  const animal = options.animal ?? pickOne(random, candidates)
  const entry = tables.animals.get(animal)
  if (!entry) throw new Error(`装备池里没有 ${animal}`)
  const task = options.task ?? pickOne(random, TASKS)
  const saddle = entry.saddle.length ? pickOne(random, entry.saddle) : null
  const body = entry.body.length ? pickOne(random, entry.body) : null
  if (!saddle && !body) throw new Error(`${animal} 的鞍槽、身体槽都不能用（arena/mount-catalog）`)
  let item = null
  let total = null
  let split = null
  let move = null
  let strength = null
  let chestSize = 0
  if (entry.chest) {
    if (options.item) {
      if (!tables.pool.includes(options.item)) throw new Error(`物品池里没有 ${options.item}（不是堆叠上限 64 的物品、能当装备，或者被 exclude 排除）`)
      item = options.item
    } else {
      if (!tables.pool.length) throw new Error('物品池是空的')
      item = pickOne(random, tables.pool)
    }
    total = between(random, options.total.lo, options.total.hi)
    const a = between(random, Math.max(1, total - STACK), Math.min(STACK, total - 1))
    split = [a, total - a]
    move = between(random, options.move.lo, Math.min(options.move.hi, total))
    if (entry.chest === 'strength') strength = between(random, 1, MAX_STRENGTH)
    chestSize = entry.chest === 'strength' ? 3 * strength : entry.chest
  }
  const layout = []
  const chestLayout = []
  if (task === 'equip') {
    const stacks = [saddle && { id: saddle, count: 1 }, body && { id: body, count: 1 }, ...(item ? split.map((count) => ({ id: item, count })) : [])].filter(Boolean)
    const free = Array.from({ length: INVENTORY_SLOTS }, (_, i) => i)
    for (const s of stacks) layout.push({ slot: free.splice(Math.floor(random() * free.length), 1)[0], ...s })
  } else if (item) {
    const free = Array.from({ length: chestSize }, (_, i) => i)
    for (const count of split) chestLayout.push({ slot: free.splice(Math.floor(random() * free.length), 1)[0], id: item, count })
  }
  return { group, animal, task, equipment: { saddle, body }, item, total, split, move, strength, chestSize, layout, chestLayout }
}

const omitZero = (map) => Object.fromEntries(Object.entries(map).filter(([, n]) => n > 0))

/**
 * 目标（H5、H6）：checkSaddle / checkBody 只在这只动物有这一格时写。
 * @returns {{ saddle?, body?, chest: {id:n}, inventory: {id:n} }}  就是 expect.mount
 */
export function mountGoal(picked) {
  const { saddle, body } = picked.equipment
  const k = picked.move ?? 0
  const n = picked.total ?? 0
  const equip = picked.task === 'equip'
  const goal = {}
  if (saddle) goal.saddle = equip ? saddle : null
  if (body) goal.body = equip ? body : null
  goal.chest = picked.item ? omitZero({ [picked.item]: equip ? k : n - k }) : {}
  const inventory = {}
  if (!equip) {
    if (saddle) inventory[saddle] = 1
    if (body) inventory[body] = 1
  }
  if (picked.item) inventory[picked.item] = (inventory[picked.item] ?? 0) + (equip ? n - k : k)
  goal.inventory = omitZero(inventory)
  return goal
}

/** arena/prepare 的 mount：本轮生成什么动物（H2）。卸下的题一开始就装着装备、箱子里有东西 */
export function mountSetup(picked) {
  const unequip = picked.task === 'unequip'
  return {
    animal: picked.animal,
    saddle: unequip ? picked.equipment.saddle : null,
    body: unequip ? picked.equipment.body : null,
    chest: unequip ? picked.chestLayout : [],
    ...(picked.strength !== null ? { strength: picked.strength } : {})
  }
}

const sameCounts = (a, b) => {
  const x = omitZero(a ?? {})
  const y = omitZero(b ?? {})
  return Object.keys(x).length === Object.keys(y).length && Object.entries(x).every(([id, n]) => y[id] === n)
}
const total = (counts) => Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0)

/**
 * 判定（H5）。final：mount{ saddle, body, chest }（不在了为 null）、held、carried、dropped、stationIntact。
 * @returns {{ outcome, reached, misplaced }}
 */
export function judgeMount({ stopped, timedOut, taskState, final, picked }) {
  if (stopped) return { outcome: 'aborted', reached: false, misplaced: false }
  const goal = mountGoal(picked)
  const m = final?.mount ?? null
  const held = final?.held ?? null
  if (!final || !held) return { outcome: final?.stationIntact === false ? 'lost' : timedOut ? 'timeout' : 'failed', reached: false, misplaced: false }
  const carried = final.carried ?? {}
  const chest = m?.chest ?? {}
  const reached = Boolean(m) && total(carried) === 0
    && (!('saddle' in goal) || (m.saddle ?? null) === goal.saddle)
    && (!('body' in goal) || (m.body ?? null) === goal.body)
    && sameCounts(chest, goal.chest) && sameCounts(held, goal.inventory)
  // 物品和装备都还在：要搬的物品（动物箱子 + 身上 + 光标）一共 n 个；每件装备在槽里、身上、箱子或光标上
  const where = (id) => (m?.saddle === id ? 1 : 0) + (m?.body === id ? 1 : 0) + (chest[id] ?? 0) + (held[id] ?? 0) + (carried[id] ?? 0)
  const kept = (!picked.item || where(picked.item) >= picked.total) && [picked.equipment.saddle, picked.equipment.body].every((id) => !id || where(id) >= 1)
  const lost = !m || final.stationIntact === false || total(final.dropped) > 0 || !kept
  const k = picked.move ?? 0
  const moved = picked.item ? (picked.task === 'equip' ? chest[picked.item] ?? 0 : held[picked.item] ?? 0) : 0
  const overshoot = Boolean(picked.item) && moved > k
  // 放错：要搬的物品数量对，但装备进了动物的箱子（而不是鞍槽 / 身体槽或玩家身上）
  const itemOk = !picked.item || (sameCounts({ [picked.item]: chest[picked.item] ?? 0 }, { [picked.item]: goal.chest[picked.item] ?? 0 }))
  const misplaced = itemOk && [picked.equipment.saddle, picked.equipment.body].some((id) => id && (chest[id] ?? 0) > 0)
  let outcome
  if (lost) outcome = 'lost'
  else if (overshoot) outcome = 'overshoot'
  else if (misplaced) outcome = 'misplaced'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, reached, misplaced }
}

const list = (ids) => (ids.length === 1 ? ids[0] : `${ids.slice(0, -1).join('、')} 和 ${ids.at(-1)}`)
const wornOf = (picked) => [picked.equipment.saddle, picked.equipment.body].filter(Boolean)

/** 文案的占位（H4）：只写目标；不说怎么打开、不说格子编号 */
export function mountText(picked) {
  const worn = wornOf(picked)
  const k = picked.move
  if (picked.task === 'equip') {
    const given = [...worn.map((id) => `1 个 ${id}`), ...(picked.item ? [`${picked.total} 个 ${picked.item}`] : [])].join('、')
    const goals = `把 ${list(worn)}${worn.length > 1 ? ' 都' : ' '}装到它身上` + (picked.item ? `，并把 ${k} 个 ${picked.item} 放进它身上的箱子里${k < picked.total ? '，其余的留在你的物品栏里' : ''}` : '')
    return { animal: picked.animal, chestNote: picked.item ? '，它身上挂着箱子' : '', given, goals }
  }
  const goals = `把 ${list(worn)}${worn.length > 1 ? ' 都' : ' '}取下来` + (picked.item ? `，并从它的箱子里取出 ${k} 个 ${picked.item}，都放进你的物品栏${k < picked.total ? '，其余的留在它的箱子里' : ''}` : '，放进你的物品栏')
  return { animal: picked.animal, worn: worn.join('、'), chestNote: picked.item ? `，挂着的箱子里有 ${picked.item}` : '', goals }
}

export const mount = {
  type: 'mount',
  options: ['item', 'group', 'animal', 'task', 'total', 'move'],

  setup(trainer, arena, arenaConfig, args) {
    const options = mountOptions(args, arenaConfig)
    const props = trainer.itemProps()
    if (!props) throw new Error(`坐骑题需要 ${trainer.config.itemProps}（在 dsh-plugins/agent 里运行 npm run extract-item-props）`)
    return { arena, arenaConfig, options, props, tables: null }
  },

  startText(ctx) {
    const o = ctx.options
    const parts = [
      o.animal ? `动物 ${o.animal}` : `组 ${o.groups.map((g) => GROUP_NAMES[g]).join('、')}${o.groups.length > 1 ? ' 等概率' : ''}`,
      o.task ? `只出${TASK_NAMES[o.task]}题` : '装上、卸下等概率',
      o.item ? `物品 ${o.item}` : null,
      o.groups.some((g) => CHEST_GROUPS.includes(g)) ? `total=${o.total.lo}-${o.total.hi}，move=${o.move.lo}-${o.move.hi}` : null
    ]
    return parts.filter(Boolean).join('，')
  },

  batchFields() {
    return {}
  },

  /** 装备池要问 mod，抽题放在 preview 里做（H3、H10） */
  sample(ctx, seed) {
    return { seed }
  },

  async preview(ctx, picked, seed, call) {
    if (!ctx.tables) {
      const res = await call('arena/mount-catalog', {})
      if (!res?.ok) throw new Error(`arena/mount-catalog: ${res?.error ?? 'no response'}`)
      ctx.tables = mountTables(res.data, ctx.props, ctx.arenaConfig.exclude ?? [])
    }
    return sampleMount(ctx.tables, seed >>> 0, ctx.options)
  },

  label(ctx, picked, seed) {
    const worn = wornOf(picked).map(shortId).join(' + ')
    const items = picked.item ? ` + ${picked.move}/${picked.total} ${shortId(picked.item)}` : ''
    return `坐骑 ${ANIMAL_NAMES[picked.animal] ?? picked.animal} ${TASK_NAMES[picked.task]} ${worn}${items}（seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      // target 和其他题型一样是字符串（日志、通知、--by target 用）（H11）
      target: `${shortId(picked.animal)} ${picked.task}`,
      group: picked.group, animal: picked.animal, task: picked.task, equipment: picked.equipment,
      item: picked.item, total: picked.total, split: picked.split, move: picked.move, strength: picked.strength,
      layout: picked.layout, chestLayout: picked.chestLayout,
      misplaced: null, rodeMs: null, equippedWithoutMenu: null, ridingAtEnd: null,
      final: null, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return { station: 'mount', items: picked.layout, seed, watch: [], expect: { mount: mountGoal(picked) }, dayTime: 1000, mount: mountSetup(picked) }
  },

  afterPrepare(ctx, picked, data) {
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the ${picked.animal} (aimOk=${data?.aimOk}); check the arena origin`, fields: {} }
    const info = data?.mount
    if (!info) return { error: 'arena/prepare: no mount info (mod 版本太旧？)', fields: {} }
    const setup = mountSetup(picked)
    const problems = []
    if (info.id !== picked.animal) problems.push(`动物是 ${info.id}，应为 ${picked.animal}`)
    if ((info.saddle ?? null) !== setup.saddle) problems.push(`鞍槽是 ${info.saddle}，应为 ${setup.saddle}`)
    if ((info.body ?? null) !== setup.body) problems.push(`身体槽是 ${info.body}，应为 ${setup.body}`)
    const chest = {}
    for (const g of setup.chest) chest[g.id] = (chest[g.id] ?? 0) + g.count
    if (!sameCounts(info.chest, chest)) problems.push(`箱子里是 ${JSON.stringify(info.chest)}，应为 ${JSON.stringify(chest)}`)
    if ((info.chestSize ?? 0) !== picked.chestSize) problems.push(`箱子 ${info.chestSize} 格，应为 ${picked.chestSize} 格`)
    const wrong = picked.layout.filter((g) => !(info.items ?? []).some((s) => s.slot === g.slot && s.id === g.id && s.count === g.count))
    if (wrong.length) problems.push(`发放的物品和题目不一致（${wrong.map((g) => `${g.slot} 号格 ${g.id} ×${g.count}`).join('、')}）`)
    return problems.length ? { error: `arena/prepare: ${problems.join('；')}`, fields: {} } : { fields: {} }
  },

  instruction(ctx, picked, prompts) {
    return renderTemplate(prompts.training[`mount_${picked.task}`], mountText(picked))
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0 }) {
    const judged = judgeMount({ stopped, timedOut, taskState, final, picked })
    const at = (ms) => (Number.isFinite(ms) ? ms - t0 : null)
    return {
      outcome: judged.outcome, reached: judged.reached, misplaced: judged.misplaced,
      reachedMs: at(final?.reachedAtMs ?? null), rodeMs: at(final?.rodeAtMs ?? null),
      equippedWithoutMenu: final?.equippedWithoutMenu ?? null, ridingAtEnd: final?.riding ?? null,
      final: final ? { mount: final.mount ?? null, held: final.held ?? null, carried: final.carried ?? null, dropped: final.dropped ?? null, containerOpen: final.containerOpen ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { group: record.group ?? null, animal: record.animal ?? null, task: record.task ?? null }
  }
}
