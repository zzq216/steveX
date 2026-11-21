import { renderTemplate } from '../llm/prompts.js'
import { rng } from './sampler.js'
import { kindOf } from './enchant.js'

/**
 * 铁砧题型（docs/铁砧训练场设计方案.md）：正前方一个铁砧，物品栏里有一件只带耐久 III 的物品 A，合并题另有第二件 B（同种物品或附魔书）。
 * 要求做出指定的物品（合并后的 A / 改名后的 A / 两样都做），放在物品栏里。不要求关界面。
 *
 * - 物品池（A2）：arena/anvil-catalog 读出的 enchantable/durability 标签里的物品，去掉 exclude；先等概率抽类别，再在类里抽一件
 * - 出题（A3）：任务、B 的种类等概率；B 的附魔从能附到 A 上的附魔里抽 k 个（互相兼容，默认不含诅咒）；名字 8 个字符，汉字和字母都有
 * - 预览（A4）：arena/anvil-preview 用原版铁砧算产物和花费；没有产物、花费 > 39、合并后附魔没变的换一道题，最多重抽 MAX_RETRIES 次
 * - 判定（A6）：只看最终状态，物品类型、附魔、名字三项都对上；aborted → lost → timeout → success / false_success / failed
 * - 到达（A7）：mod 在 tick 里按 expect { anvil } 检测，记 reachedAtMs
 */

export const INVENTORY_SLOTS = 36
export const TASKS = ['merge', 'rename', 'both']
export const SECOND_KINDS = ['same', 'book']
export const TASK_NAMES = { merge: '合并', rename: '改名', both: '合并加改名' }
export const SECOND_NAMES = { same: '同种物品', book: '附魔书' }
export const BOOK = 'minecraft:enchanted_book'
/** A 只带耐久 III（用户原始流程） */
export const BASE_ENCHANTMENTS = { 'minecraft:unbreaking': 3 }
export const NAME_LENGTH = 8
/** 生存模式下铁砧最多花 39 级（AnvilMenu.createResult 250–252 行，F3） */
export const MAX_COST = 39
export const MIN_XP_LEVEL = MAX_COST
export const MAX_XP_LEVEL = 1000
export const MAX_ENCHANTS = 5
export const MAX_RETRIES = 20
export const ANVIL_CHOICES = { task: TASKS, second: SECOND_KINDS, curses: ['0', '1'] }
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/** 常用汉字表（A3）：GB2312 一级字（3755 个常用字）每隔 7 个取 1 个，共 537 个 */
export const HANZI = '啊皑隘岸敖澳八耙百班扮邦磅包饱爆背焙绷比毕敝陛变彪彬冰并博舶卜簿才蔡灿糙册茶诧馋昌肠抄炒郴陈成承匙侈冲踌丑锄矗椽幢锤纯雌赐丛篡粹撮答戴逮掸诞档导得凳笛地颠垫淀掉蝶钉东恫豆独肚段墩盾躲蛾恶而贰法矾范方纺匪芬焚粪风奉孵伏弗脯赋负噶溉赶钢篙镐鸽蛤根耿供拱狗咕古固褂冠贯硅癸滚过害涵捍夯郝荷盒鹤恨哄红后胡唬华槐桓豢黄煌辉慧烩婚火击箕姬籍嫉技济际佳钾歼兼柬剪见饯将讲焦嚼角轿秸杰姐疥今进尽鲸警径窘灸舅疽举距剧绢觉军骏楷砍亢苛咳肯恐枯夸侩框岿愧扩腊婪谰琅捞烙磊泪黎里丽例力镰链粱谅辽列磷赁铃领馏龙拢陋卤赂驴缕峦略论骡麻吗瞒漫莽卯玫眉妹檬醚秘眠面庙敏名膜墨牟墓睦那奈恼能你年鸟镍拧浓暖哦沤拍潘乓刨培喷蓬捧劈匹片瞥坪屏迫葡浦戚其齐乞迄洽签前欠蔷桥翘怯勤轻氰秋泅驱圈拳却然嚷壬刃茸绒儒褥润鳃桑瑟杀筛煽善赏稍邵赦砷绅慎绳失十实始拭适恃守蔬舒薯属墅摔双瞬斯死饲宋苏塑算岁笋锁獭台摊潭探棠趟桃藤锑嚏填条厅庭同统秃土腿拖椭洼弯碗万往微惟伟畏尉闻翁斡乌吾舞物析锡夕檄洗匣下仙闲献限襄响象销校歇斜懈锌衅型性雄锈虚叙绪玄学旬训鸭衙咽蜒沿堰焰秧阳邀窑耀也夜依仪椅艺臆毅谊荫银印莹盈佣咏幽铀右淤余隅宇吁狱豫袁猿院粤匀韵灾暂凿噪则赠闸诈瞻辗站张仗沼遮蔗砧诊睁正枝汁执只致稚中肿洲皱朱煮助祝转妆赘卓灼淄自综租组尊作'

const pickOne = (random, list) => list[Math.floor(random() * list.length)]
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
const fullId = (id) => (id.includes(':') ? id : `minecraft:${id}`)
const shortId = (id) => id.replace(/^minecraft:/, '')

/** enchants=k|a-b（1–5）：第二件物品带几个附魔 */
export function parseEnchantsSpec(text) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(text))
  const lo = match ? Number(match[1]) : NaN
  const hi = match ? Number(match[2] ?? match[1]) : NaN
  if (!(lo >= 1 && hi <= MAX_ENCHANTS && lo <= hi)) throw new Error(`enchants 要写 k 或 a-b（1–${MAX_ENCHANTS}，a ≤ b），收到 "${text}"`)
  return { lo, hi }
}

/** 每轮开始时的经验等级（A7）：不低于 39，否则会出现取不出产物的题 */
export function parseAnvilXpLevel(value) {
  const n = Number(value)
  if (!(Number.isInteger(n) && n >= MIN_XP_LEVEL && n <= MAX_XP_LEVEL)) throw new Error(`铁砧场地的 xpLevel 要是 ${MIN_XP_LEVEL}–${MAX_XP_LEVEL} 的整数（铁砧最多花 ${MAX_COST} 级），收到 "${value}"`)
  return n
}

/** curses：0 / 1 / true / false → 布尔 */
export function parseCurses(value) {
  if (value === true || value === false) return value
  const text = String(value)
  if (text === '1' || text === 'true') return true
  if (text === '0' || text === 'false') return false
  throw new Error(`curses 只能是 0 / 1，收到 "${value}"`)
}

/**
 * 选项（§5.2）：命令行的优先，没写的用场地配置。改名题没有第二件物品，task=rename 和 second / enchants / curses 一起写就报错。
 * @param {object} args    命令行（没写的是 null）
 * @param {object} config  场地配置
 */
export function anvilOptions(args = {}, config = {}) {
  const task = args.task ?? null
  if (task !== null && !TASKS.includes(task)) throw new Error(`task 只能是 ${TASKS.join(' / ')}，收到 "${task}"`)
  const second = args.second ?? null
  if (second !== null && !SECOND_KINDS.includes(second)) throw new Error(`second 只能是 ${SECOND_KINDS.join(' / ')}，收到 "${second}"`)
  if (task === 'rename') {
    const extra = ['second', 'enchants', 'curses'].filter((k) => args[k] !== null && args[k] !== undefined)
    if (extra.length) throw new Error(`改名题（task=rename）没有第二件物品，不能和 ${extra.join('、')} 一起用`)
  }
  return {
    task,
    second,
    item: args.item ? fullId(args.item) : null,
    enchants: parseEnchantsSpec(args.enchants ?? config.enchants ?? '1-3'),
    curses: parseCurses(args.curses ?? config.curses ?? false),
    xpLevel: parseAnvilXpLevel(args.xpLevel ?? config.xpLevel ?? 216)
  }
}

/**
 * 物品池分组（A2）：catalog 的物品去掉 exclude，按附魔台题的 kindOf 分类（剑、镐……、头盔……、弓……），认不出的物品各自单独成一类。
 * 组按名字排序，组内按 id 排序（同一种子出同一道题）。
 * @param {{ items: Array<{ id, enchantments }> }} catalog  arena/anvil-catalog 的结果
 * @returns {{ groups: Array<{ kind, items }>, byId: Map<string, object> }}
 */
export function anvilTables(catalog, exclude = []) {
  const excluded = new Set(exclude.map(fullId))
  const byKind = new Map()
  const byId = new Map()
  for (const entry of [...(catalog?.items ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
    if (excluded.has(entry.id)) continue
    const kind = kindOf(entry.id)?.kind ?? shortId(entry.id)
    if (!byKind.has(kind)) byKind.set(kind, [])
    byKind.get(kind).push(entry)
    byId.set(entry.id, entry)
  }
  const groups = [...byKind.keys()].sort().map((kind) => ({ kind, items: byKind.get(kind) }))
  return { groups, byId }
}

/** 名字（A3）：汉字 c 个（1–7）、字母 8 − c 个，打乱顺序 */
export function sampleName(random) {
  const hanzi = between(random, 1, NAME_LENGTH - 1)
  const chars = []
  for (let i = 0; i < hanzi; i++) chars.push(pickOne(random, HANZI))
  for (let i = hanzi; i < NAME_LENGTH; i++) chars.push(pickOne(random, LETTERS))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

/**
 * 第二件物品的附魔（A3）：候选是能附到 A 上的附魔（默认去掉诅咒），依次抽 k 个——每次去掉已抽到的和与已抽到的冲突的，
 * 级数在 1 到最高级之间等概率；候选不够就少抽。@returns { 注册名: 级数 }
 */
export function sampleEnchantments(random, entry, k, curses) {
  const pool = entry.enchantments.filter((e) => curses || !e.curse)
  const chosen = []
  for (let i = 0; i < k; i++) {
    const avail = pool.filter((e) => !chosen.some((c) => c.id === e.id || c.exclusive.includes(e.id) || e.exclusive.includes(c.id)))
    if (!avail.length) break
    chosen.push(pickOne(random, avail))
  }
  const out = {}
  for (const e of chosen) out[e.id] = between(random, 1, e.maxLevel)
  return sortEnchantments(out)
}

export const sortEnchantments = (map) => Object.fromEntries(Object.entries(map ?? {}).sort(([a], [b]) => a.localeCompare(b)))

/**
 * 抽一道题（A3）。随机数抽取顺序：任务 → 第二件的种类 → 物品类别 → 物品 → 附魔个数 → 逐个抽附魔和级数 → 名字 → 格位。
 * 固定了的项不抽。
 * @returns {{ task, item, kind, second: { kind, id, enchantments } | null, name, layout }}
 */
export function sampleAnvil(tables, seed, options) {
  const random = rng(seed)
  const task = options.task ?? pickOne(random, TASKS)
  const secondKind = task === 'rename' ? null : options.second ?? pickOne(random, SECOND_KINDS)
  let entry
  if (options.item) {
    entry = tables.byId.get(options.item)
    if (!entry) throw new Error(`物品池里没有 ${options.item}（附不上耐久，或者被 exclude 排除）`)
  } else {
    if (!tables.groups.length) throw new Error('物品池是空的（arena/anvil-catalog 没有返回物品，或者全被 exclude 排除）')
    entry = pickOne(random, pickOne(random, tables.groups).items)
  }
  let second = null
  if (secondKind) {
    const k = between(random, options.enchants.lo, options.enchants.hi)
    second = { kind: secondKind, id: secondKind === 'same' ? entry.id : BOOK, enchantments: sampleEnchantments(random, entry, k, options.curses) }
  }
  const name = task === 'merge' ? null : sampleName(random)
  const slotA = Math.floor(random() * INVENTORY_SLOTS)
  let slotB = Math.floor(random() * (INVENTORY_SLOTS - 1))
  if (slotB >= slotA) slotB++
  const layout = [{ slot: slotA, id: entry.id, count: 1, enchantments: { ...BASE_ENCHANTMENTS } }]
  if (second) layout.push({ slot: slotB, id: second.id, count: 1, enchantments: second.enchantments })
  return { task, item: entry.id, kind: kindOf(entry.id)?.kind ?? shortId(entry.id), second, name, layout }
}

export const sameEnchantments = (a, b) => JSON.stringify(sortEnchantments(a)) === JSON.stringify(sortEnchantments(b))

/** arena/anvil-preview 的参数：A 放左、B 放右，有名字就改名 */
export const previewParams = (picked) => ({
  left: { id: picked.item, enchantments: { ...BASE_ENCHANTMENTS } },
  right: picked.second ? { id: picked.second.id, enchantments: picked.second.enchantments } : null,
  name: picked.name
})

/**
 * 预览能不能发题（A4）：有产物；花费 ≤ 39；合并题、合并加改名题的产物附魔和 A 原来的不同；名字和要求的一致。
 * @returns {{ goal: { id, enchantments, name }, cost } | null}
 */
export function acceptPreview(picked, data) {
  const result = data?.result
  if (!result || !Number.isInteger(data.cost) || data.cost < 1 || data.cost > MAX_COST) return null
  if (result.id !== picked.item || (result.name ?? null) !== picked.name) return null
  if (picked.task !== 'rename' && sameEnchantments(result.enchantments, BASE_ENCHANTMENTS)) return null
  return { goal: { id: result.id, enchantments: sortEnchantments(result.enchantments), name: result.name ?? null }, cost: data.cost }
}

/** mod 的到达检测（A7）：{ anvil: { item, enchantments, name } } */
export const anvilExpect = (picked) => ({ anvil: { item: picked.goal.id, enchantments: picked.goal.enchantments, name: picked.goal.name } })

/** 文案里的附魔列表：minecraft:sharpness 5 级、minecraft:unbreaking 3 级 */
export const enchantsText = (map) => Object.entries(sortEnchantments(map)).map(([id, level]) => `${id} ${level} 级`).join('、')
const enchantsLabel = (map) => Object.entries(sortEnchantments(map)).map(([id, level]) => `${shortId(id)} ${level}`).join('、')

/** 一件物品是不是目标（A6）：类型、附魔（完全相同）、自定义名字（逐字；null = 没有）都对上 */
export const matchesGoal = (stack, goal) => Boolean(stack) && stack.id === goal.id && sameEnchantments(stack.enchantments, goal.enchantments) && (stack.name ?? null) === goal.name

const total = (counts) => Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0)

/**
 * 判定（A6）。final：items、carried、carriedItem、slots、dropped、containerOpen、anvilState、xpLevel、takes、stationIntact。
 * @returns {{ outcome, reached, nameWrong, levelsUsed, takes }}
 */
export function judgeAnvil({ stopped, timedOut, taskState, final, picked, xpLevel }) {
  const none = { reached: false, nameWrong: null, levelsUsed: null, takes: null }
  if (stopped) return { outcome: 'aborted', ...none }
  if (!Array.isArray(final?.items)) return { outcome: final?.stationIntact === false ? 'lost' : timedOut ? 'timeout' : 'failed', ...none }
  const goal = picked.goal
  const items = final.items
  const carriedItem = final.carriedItem ?? null
  const reached = total(final.carried) === 0 && items.some((s) => matchesGoal(s, goal))
  // 名字错：附魔对，但带了不该有的名字（合并题多改了名）或者名字不对
  const nameWrong = !reached && [...items, carriedItem].some((s) => s && s.id === goal.id && sameEnchantments(s.enchantments, goal.enchantments) && s.name != null && s.name !== goal.name)
  const levelsUsed = Number.isInteger(final.xpLevel) ? xpLevel - final.xpLevel : null
  const takes = Array.isArray(final.takes) ? final.takes.length : null
  // A 这种物品在玩家身上、光标、铁砧两格、场内地上都找不到 → 丢了
  const where = [...items, carriedItem, final.slots?.left ?? null, final.slots?.right ?? null]
  const found = where.some((s) => s && s.id === picked.item) || (final.dropped?.[picked.item] ?? 0) > 0
  let outcome
  if (final.stationIntact === false || final.anvilState === 'missing' || !found) outcome = 'lost'
  else if (timedOut) outcome = 'timeout'
  else if (taskState === 'done') outcome = reached ? 'success' : 'false_success'
  else outcome = 'failed'
  return { outcome, reached, nameWrong, levelsUsed, takes }
}

export const anvil = {
  type: 'anvil',
  options: ['item', 'task', 'second', 'enchants', 'curses', 'xpLevel'],

  setup(trainer, arena, arenaConfig, args) {
    const options = anvilOptions(args, arenaConfig)
    return { arena, arenaConfig, options, tables: null }
  },

  startText(ctx) {
    const o = ctx.options
    const parts = [
      o.task ? `任务 ${TASK_NAMES[o.task]}` : '任务三种等概率',
      o.task === 'rename' ? null : o.second ? `第二件 ${SECOND_NAMES[o.second]}` : '第二件两种等概率',
      o.item ? `物品 ${o.item}` : null,
      o.task === 'rename' ? null : `enchants=${o.enchants.lo}-${o.enchants.hi}`,
      o.task === 'rename' ? null : `curses=${o.curses ? 1 : 0}`,
      `xpLevel=${o.xpLevel}`
    ]
    return parts.filter(Boolean).join('，')
  },

  batchFields() {
    return {}
  },

  /** 物品池要问 mod，抽题放在 preview 里做（A3、A4） */
  sample(ctx, seed) {
    return { seed }
  },

  /**
   * 出题（A3、A4）：第一次先读物品池；每次抽一道题、预览，预览不通过就用 seed + 1、+ 2……重抽，最多 MAX_RETRIES 次。
   * @param {(method: string, params: object) => Promise<{ ok, data?, error? }>} call  mod 调用
   */
  async preview(ctx, picked, seed, call) {
    if (!ctx.tables) {
      const res = await call('arena/anvil-catalog', {})
      if (!res?.ok) throw new Error(`arena/anvil-catalog: ${res?.error ?? 'no response'}`)
      ctx.tables = anvilTables(res.data, ctx.arenaConfig.exclude ?? [])
    }
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      const current = sampleAnvil(ctx.tables, (seed + retry) >>> 0, ctx.options)
      const res = await call('arena/anvil-preview', previewParams(current))
      if (!res?.ok) throw new Error(`arena/anvil-preview: ${res?.error ?? 'no response'}`)
      const accepted = acceptPreview(current, res.data)
      if (accepted) return { ...current, ...accepted, retries: retry }
    }
    throw new Error(`抽不出能做的题：连续 ${MAX_RETRIES + 1} 次预览都没有产物、花费超过 ${MAX_COST} 或者合并后附魔没变`)
  },

  label(ctx, picked, seed) {
    const head = `铁砧 ${TASK_NAMES[picked.task]} ${shortId(picked.item)}`
    const second = picked.second ? ` + ${picked.second.kind === 'book' ? '附魔书' : shortId(picked.second.id)}[${enchantsLabel(picked.second.enchantments)}]` : ''
    const result = picked.task === 'rename' ? '' : ` → ${enchantsLabel(picked.goal.enchantments)}`
    const name = picked.name ? ` →「${picked.name}」` : ''
    const cost = picked.task === 'rename' ? '' : `花费 ${picked.cost}，`
    return `${head}${second}${result}${name}（${cost}seed=${seed}）`
  },

  record(ctx, picked) {
    return {
      // target 和其他题型一样是字符串（日志、通知、--by target 用）：物品 A 的 id；完整目标在 goal（方案 A8）
      target: picked.item, task: picked.task, item: picked.item, kind: picked.kind, second: picked.second, name: picked.name,
      goal: picked.goal, cost: picked.cost, retries: picked.retries ?? 0, layout: picked.layout, xpLevel: ctx.options.xpLevel,
      takes: null, levelsUsed: null, anvilState: null, nameWrong: null,
      final: null, reached: false, reachedMs: null
    }
  },

  prepareParams(ctx, picked, seed) {
    return { station: 'anvil', items: picked.layout, seed, watch: [], expect: anvilExpect(picked), dayTime: 1000, xpLevel: ctx.options.xpLevel }
  },

  afterPrepare(ctx, picked, data) {
    if (data?.aimOk !== true) return { error: `arena/prepare: crosshair is not on the anvil (aimOk=${data?.aimOk}); check the arena origin`, fields: {} }
    const info = data?.anvil
    if (!info) return { error: 'arena/prepare: no anvil info (mod 版本太旧？)', fields: {} }
    if (info.state !== 'anvil') return { error: `arena/prepare: 铁砧状态是 ${info.state}，应为完好的 anvil`, fields: {} }
    if (info.xpLevel !== ctx.options.xpLevel) return { error: `arena/prepare: 经验 ${info.xpLevel} 没设上（应为 ${ctx.options.xpLevel}）`, fields: {} }
    const wrong = picked.layout.filter((g) => !(info.items ?? []).some((s) => s.slot === g.slot && s.id === g.id && sameEnchantments(s.enchantments, g.enchantments)))
    if (wrong.length) return { error: `arena/prepare: 发放的物品和题目不一致（${wrong.map((g) => `${g.slot} 号格 ${g.id}`).join('、')}）`, fields: {} }
    return { fields: {} }
  },

  instruction(ctx, picked, prompts) {
    // A5：只写目标；不说哪件放哪一格、怎么改名
    const vars = {
      item: picked.item, baseEnchants: enchantsText(BASE_ENCHANTMENTS),
      second: picked.second?.id ?? '', secondEnchants: picked.second ? enchantsText(picked.second.enchantments) : '',
      resultEnchants: enchantsText(picked.goal.enchantments), name: picked.name ?? ''
    }
    return renderTemplate(prompts.training[`anvil_${picked.task}`], vars)
  },

  finish(ctx, picked, { final, stopped, timedOut, taskState, t0 }) {
    const judged = judgeAnvil({ stopped, timedOut, taskState, final, picked, xpLevel: ctx.options.xpLevel })
    const reachedAtMs = final?.reachedAtMs ?? null
    const takes = Array.isArray(final?.takes)
      ? final.takes.map((t) => ({ cost: t.cost ?? null, enchantments: t.enchantments ?? null, name: t.name ?? null, ms: Number.isFinite(t.atMs) ? t.atMs - t0 : null }))
      : null
    return {
      outcome: judged.outcome, reached: judged.reached, nameWrong: judged.nameWrong, levelsUsed: judged.levelsUsed, takes,
      anvilState: final?.anvilState ?? null,
      reachedMs: reachedAtMs !== null ? reachedAtMs - t0 : null,
      final: final ? { items: final.items ?? null, carried: final.carried ?? null, carriedItem: final.carriedItem ?? null, slots: final.slots ?? null, dropped: final.dropped ?? null, containerOpen: final.containerOpen ?? null, xpLevel: final.xpLevel ?? null } : null
    }
  },

  timings(record) {
    return [['达成用时', record.reachedMs]]
  },

  annotate(record) {
    return { task: record.task ?? null, item: record.item ?? null, second: record.second?.kind ?? null }
  }
}
