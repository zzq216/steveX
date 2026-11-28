import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_OBSERVE_BY_COMMAND } from './bt/observe.js'
import { STORAGE_CHOICES, parseTargetsSpec, parseTypesSpec } from './training/storage.js'
import { STONECUT_CHOICES, parseMaterialsSpec, parseSlotsSpec, parseStylesSpec } from './training/stonecut.js'
import { COOK_CHOICES, parseCookSlotsSpec, parseTotalSpec } from './training/cook.js'
import { parseBookshelves, parseXpLevel } from './training/enchant.js'
import { beaconPool, parseAmplifier, parseBeaconCountSpec } from './training/beacon.js'
import { parseAnvilXpLevel, parseCurses, parseEnchantsSpec } from './training/anvil.js'
import { parseTasksSpec } from './training/smithing.js'
import { parseMountGroups, parseMountMove, parseMountTotal } from './training/mount.js'
import { loomOptions } from './training/loom.js'
import { cartographyOptions } from './training/cartography.js'
import { brewOptions } from './training/brew.js'
import { crafterOptions } from './training/crafter.js'
import { tradeOptions } from './training/trade.js'
import { grindstoneOptions } from './training/grindstone.js'
import { bookOptions } from './training/book.js'
import { signOptions } from './training/sign.js'
import { bowOptions } from './training/bow.js'
import { DEFAULT_TERRAIN_SOURCES, LAND_ORIGIN, landOptions } from './training/land.js'
import { parseCountSpec } from './training/sampler.js'

/** 用户自己加的箱子场地（type: 'storage'）没写的字段（箱子训练场设计方案 §5） */
const STORAGE_ARENA_DEFAULTS = Object.freeze({ kind: 'mix', rel: 'mix', chest: 'mix', stack: 'mix', fill: 'random', types: '1-4', targets: '1', dest: 'empty', exclude: ['minecraft:bundle'] })
/** 用户自己加的切石机场地（type: 'stonecut'）没写的字段（切石机训练场设计方案 §5） */
const STONECUT_ARENA_DEFAULTS = Object.freeze({ materials: '1-3', slots: '1-9', fill: 'random', styles: '1-3', bypass: 'exclude', exclude: [] })
/** 用户自己加的熔炉场地（type: 'cook'）没写的字段（熔炉训练场设计方案 §5） */
/** 用户自己加的附魔台场地（type: 'enchant'）没写的字段（附魔台训练场设计方案 §5） */
const ENCHANT_ARENA_DEFAULTS = Object.freeze({ bookshelves: 15, xpLevel: 30, exclude: [] })
/** 用户自己加的信标场地（type: 'beacon'）没写的字段（信标训练场设计方案 §6） */
const BEACON_ARENA_DEFAULTS = Object.freeze({ amplifier: 'mix', count: '32-64', exclude: [] })
/** 用户自己加的铁砧场地（type: 'anvil'）没写的字段（铁砧训练场设计方案 §6） */
const ANVIL_ARENA_DEFAULTS = Object.freeze({ xpLevel: 216, enchants: '1-3', curses: false, exclude: [] })
/** 用户自己加的锻造台场地（type: 'smithing'）没写的字段（锻造台训练场设计方案 §6） */
const SMITHING_ARENA_DEFAULTS = Object.freeze({ tasks: '1-4', exclude: [] })
/** 用户自己加的坐骑场地（type: 'mount'）没写的字段（坐骑训练场设计方案 §6） */
const MOUNT_ARENA_DEFAULTS = Object.freeze({ groups: ['horse', 'donkey', 'camel', 'llama', 'nautilus'], total: '64-128', move: '1-64', exclude: ['minecraft:bundle'] })
/** 用户自己加的织布机场地（type: 'loom'）没写的字段（织布机训练场设计方案 §5） */
const LOOM_ARENA_DEFAULTS = Object.freeze({ banners: '1-3', slots: '1-3', fill: 'random', styles: '1-3', spare: '0-3', itemPatterns: 'off', exclude: [] })
/** 用户自己加的制图台场地（type: 'cartography'）没写的字段（制图台训练场设计方案 §5）；exclude 不用，留空 */
/** 用户自己加的酿造台场地（type: 'brew'）没写的字段（酿造台训练场设计方案 §5） */
const BREW_ARENA_DEFAULTS = Object.freeze({ fuel: '32-64', raw: '32-64', bottles: '1-3', m: '1-32', n: '1-32', exclude: [] })
/** 用户自己加的合成器场地（type: 'crafter'）没写的字段（合成器训练场设计方案 R4） */
const CRAFTER_ARENA_DEFAULTS = Object.freeze({ portions: '1-16', extra: '0-16', exclude: [] })
/** 用户自己加的村民交易场地（type: 'trade'）没写的字段（村民交易训练场设计方案 §5） */
const TRADE_ARENA_DEFAULTS = Object.freeze({ level: '1-5', tasks: '1-4', portions: '1-64', extra: '0-16', exclude: { professions: [], items: [] } })
/** 用户自己加的砂轮场地（type: 'grindstone'）没写的字段（砂轮训练场设计方案 §6） */
const GRINDSTONE_ARENA_DEFAULTS = Object.freeze({ tasks: '1-3', kind: 'mix', enchants: '1-3', curses: '0-1', exclude: [] })
/** 用户自己加的书与笔场地（type: 'book'）没写的字段（书与笔训练场设计方案 §6；exclude 不用，留着和其他场地一致） */
const BOOK_ARENA_DEFAULTS = Object.freeze({ books: '1-3', pages: '1-6', edits: '1-3', exclude: [] })
/** 用户自己加的告示牌场地（type: 'sign'）没写的字段（告示牌训练场设计方案 §6；kind: null = 每轮三种题型随机；exclude 不用，留着和其他场地一致） */
const SIGN_ARENA_DEFAULTS = Object.freeze({ kind: null, edits: '1-3', exclude: [] })
/** 用户自己加的弓箭场地（type: 'bow'）没写的字段（弓箭训练场设计方案 §6；exclude 不用，留着和其他场地一致） */
const BOW_ARENA_DEFAULTS = Object.freeze({ targets: '1-4', dist: '8-40', rodDist: '3-10', weapon: 'bow', exclude: [] })
/** 陆地寻路的两个题型共用的字段（陆地寻路训练场设计方案 §6；两个题型共用 mod 里的一块场地 land，exclude 不用） */
const LAND_COMMON_DEFAULTS = { origin: LAND_ORIGIN, timeoutSec: 600, memory: 'prefill', relief: { synthetic: '4-12', terrain: '4-24' }, cliffs: '1-3', maxWater: 0.25, markers: true, terrainSources: DEFAULT_TERRAIN_SOURCES, exclude: [] }
/** 用户自己加的路线题、寻路题场地（type: 'route' / 'goal'）没写的字段 */
const ROUTE_ARENA_DEFAULTS = Object.freeze({ ...LAND_COMMON_DEFAULTS, ground: 'flat', size: 2, points: '2-4', edge: '0-2', dist: '12-28', offset: '0-16' })
const GOAL_ARENA_DEFAULTS = Object.freeze({ ...LAND_COMMON_DEFAULTS, ground: 'synthetic', size: 4, dist: '24-56', offset: '0-16' })
const CARTOGRAPHY_ARENA_DEFAULTS = Object.freeze({ task: 'mix', scale: '0-3', maps: '1-3', copies: '2-5', ops: '1-4', spare: '0-3', exclude: [] })
const COOK_ARENA_DEFAULTS = Object.freeze({ station: 'random', raw: '64-128', fuel: '64-128', rawSlots: 2, fuelSlots: 2, n: '1-64', m: '1-64', exclude: [] })

const steveXRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** 插件配置（cordis.yml 的 config；脚本里同一份）。没有可变硬编码，全部可覆盖。 */
export const DEFAULTS = Object.freeze({
  modUrl: 'ws://127.0.0.1:25550',
  tickMs: 50,
  statePollMs: 200,
  runtimeDir: path.join(steveXRoot, 'runtime'),
  fastTreeDir: path.join(steveXRoot, 'src', 'bt', 'trees', 'fast'),
  /** 胶囊库目录（code/ + trees/ + manifest.json）；null = 只有内置条目 */
  capsulesDir: path.join(steveXRoot, 'src', 'capsules'),
  /** 任务历史目录（任务历史与复盘评估设计方案 H4）：一个任务一条记录 + index.json + archive/；null = 不记。只留本地 */
  historyDir: path.join(steveXRoot, 'src', 'history'),
  /** 任务历史的上限与淘汰阈值（H1、H9、H11） */
  history: { profileTop: 10, repeatMin: 3, reviewMax: 10, issuesMax: 5, treeChars: 8000, archiveUnseenDays: 30, maxActive: 500 },
  /** core.json.query 能读的数据源：标识 → 文件或目录（相对 steveX/）。不在这里的文件读不到 */
  jsonSources: {
    recipes: 'dsh-plugins/agent/data/recipes.json',
    stonecutting: 'dsh-plugins/agent/data/stonecutting.json',
    /** 熔炉 / 高炉 / 烟熏炉 / 营火配方（熔炉训练场设计方案 K10） */
    cooking: 'dsh-plugins/agent/data/cooking.json',
    /** 锻造台配方：升级和纹饰（锻造台训练场设计方案 M9） */
    smithing: 'dsh-plugins/agent/data/smithing.json',
    /** 酿造台配方：药水配方、换瓶子配方、燃料（酿造台训练场设计方案 P10） */
    brewing: 'dsh-plugins/agent/data/brewing.json',
    /** 物品的堆叠上限、合成剩余物、燃料时长、可附魔程度、纹饰材料（熔炉训练场设计方案 K10；锻造台训练场设计方案 M9） */
    items: 'dsh-plugins/agent/data/items.json'
  },
  /** core.nbt.query 读的采集端落盘目录（相对 steveX/） */
  visionRoot: 'vendor/stevex-template-1.21.11/run/stevex/vision',
  /** 单次提交（大纲 / 展开 / 补丁）编译后的节点上限；2026-11-07 从 15 调到 25（第一次写批量合成时 15 太紧） */
  maxExpansionNodes: 100,
  maxInvalidAttempts: 3,
  /**
   * 黑板单个值序列化后的字节上限。2026-11-28 从 16 KB 调到 256 KB：和查询结果的 256 KB 字节预算对齐，
   * 查得出来就写得进黑板（16 KB 只装得下约 160 条地形记录）。给大模型看的请求里，超过 200 字节的值只给形状，上下文不受影响
   */
  maxValueBytes: 262144,
  /** 修复请求的快照缓冲保留最近多少个叶子的前后快照（P2 §4.3） */
  snapshotKeep: 20,
  /** 任务树 reactive 序列缺省的复查间隔（毫秒，P2 §6.2）；树里写了 every 就用树里的 */
  reactiveEveryMs: 1000,
  /** 死亡后自动重生：等到没死且生命值回满的上限（P2 §8.3），超时任务失败 */
  respawnTimeoutMs: 10000,
  /** 快树进化（P3 实施细则 §10） */
  fast: {
    /** 待反思事件攒到几条打一批（§4.1）；任务结束 / 死亡 / 手动也会打批 */
    batchSize: 3,
    /** 一批最多几条事件，按信息量从高到低取（§4.2） */
    batchMaxEvents: 10,
    /** 同时在飞的快树反思会话数（§4.2） */
    reflectMaxParallel: 1,
    /** otherwise 下的掉血静默多久算事故结束（§3.2） */
    incidentQuietMs: 5000,
    /** 同一 arm 相邻情节间隔多久之内并成一条事件（§3.2） */
    episodeMergeMs: 10000,
    /** 保留最近多少个事件的前后快照（§3.5） */
    snapshotKeep: 200,
    /** 快树最多几个真实 arm（§7.3） */
    maxArms: 30,
    /** 快树每个 arm 的 then 节点上限：快树要短小，不跟 maxExpansionNodes 一起调 */
    maxNodesPerArm: 15,
    /** 一个情节最长多久，超时按 FAILURE 收场（§7.3） */
    maxEpisodeMs: 30000,
    /** false = 只记事件、不开反思会话 */
    reflect: true,
    /** 反思会话用的 DSH 预设（§5.1） */
    sessionPreset: 'stevex'
  },
  /** 沙箱硬超时：Compute 单次、条件代码单次（快树每 tick 都要算）；输出上限 2026-11-28 从 64 KB 调到 256 KB，和黑板上限一致 */
  sandbox: { timeoutMs: 1000, conditionTimeoutMs: 50, maxOutputBytes: 262144 },
  maxCapsuleDepth: 8,
  /** 每个 Steps / Action 前后读哪些状态来源报告差异（可观测性） */
  /** settle：动作后隔 intervalMs 再读 inventory / container，连续两次一样才拍"执行后"快照，最多 maxReads 次；maxReads 0 = 不等（2026-11-09） */
  /** byCommand：叶子里的命令都在表里时只观察表里的来源（2026-11-13）。container/slot 只在界面开着时点，界面的 slots 已含玩家背包格，inventory / f3 是重复读 */
  /** 观察读取记在节点的 calls.observe，等稳定的读取记在 calls.settle，都不算进成本画像的 mod 调用（执行器的证据设施，不是 agent 的成本） */
  observe: { enabled: true, sources: ['inventory', 'container', 'f3'], byCommand: DEFAULT_OBSERVE_BY_COMMAND, settle: { intervalMs: 50, maxReads: 4 } },
  timing: { clickWaitMs: 80, lookWaitMs: 150, pollMs: 100 },
  /** 视角转法（docs/视角平滑转动设计方案.md）：instant = 一步到位，否则按 speed（平均角速度，度/秒，30–3600）平滑转动；agent 改不了，切换不影响胶囊 */
  camera: { instant: false, speed: 360 },
  /** 本地应答器（没有大模型时回答请求）。DSH 里属于会话的任务的请求都交给大模型，它只回答 /bt run 的手写树 */
  localResponder: true,
  /** 大模型侧（集成方案 §4 / §5，P1）：只在 DSH 适配层里生效，scripts/ 不用 */
  /** 事实库与 MC 源码（P5 §10） */
  facts: {
    /** 事实库目录（训练产物，只留本地，不进 git） */
    dir: path.join(steveXRoot, 'facts'),
    /** MC 源码基准：mc_source_* 只能读这个目录（P5-D9） */
    sourceRoot: path.join(steveXRoot, '1.21.11_src'),
    /** fact_write：单条引用最多几行、最多几条引用（P5-D6） */
    maxRefLines: 80,
    maxRefs: 5,
    /** mc_source_read 一次最多几行；mc_source_search 最多几处命中 */
    readMaxLines: 300,
    searchLimit: 200,
    /** 查了源码却没写事实 → 提醒一次（§7）；false 只用于调试 */
    remind: true
  },
  /** 任务复盘（P4 §9） */
  reflect: {
    /** false = 任务结束只发通知（P3 及以前的行为） */
    enabled: true,
    /** failed 的任务也复盘（人 /bt abort、会话没了的除外，P4-D1） */
    onFailed: true,
    /**
     * done 的任务什么时候复盘（2026-11-21）：'changed' = 有新情况才复盘——没有参考过同类任务、树展开或修补过、
     * 有节点报错、执行了新草稿、第一次执行某个胶囊版本、mod 调用次数和参考任务里最少的那次不一样；都没有就只写任务历史。'always' = 每次都复盘
     */
    onDone: 'changed',
    /** 保存胶囊时查写死的值（P4 §5）；false 只用于调试 */
    literalCheck: true,
    /** 自动复盘在哪个会话里做：'new' = 另开新会话（不带规划回合的上下文，2026-11-07）；'same' = 任务会话。/bt reflect 手动复盘总在当前会话 */
    session: 'new'
  },
  /** 胶囊库整理（胶囊库整理设计方案 §5） */
  curate: {
    /** 每结束几个任务自动发一次整理请求；0 = 只能手动 /bt curate（C1） */
    everyTasks: 0,
    /** 条目超过这么多时，整理请求只给目录、不给全量清单（C5） */
    listLimit: 150
  },
  /** 训练场（训练场设计方案 §5）：/bt train 每轮"给材料 → 发任务 → 判定 → 记录"，记录写 runtime/training/<场地>.jsonl */
  training: {
    /**
     * 时间上限（秒，T6）；到时中止任务、取消在跑的回合、记 timeout。
     * timeoutSec 从发任务起算、但不算等本任务 LLM 回合（规划 / 展开 / 修补）的时间；
     * wallTimeoutSec 是含 LLM 回合的总上限（2026-11-07 拆开：第一次想新做法的规划回合可能要十几分钟）
     */
    timeoutSec: 600,
    wallTimeoutSec: 2400,
    /** 一轮进行中查 arena/status 的间隔（毫秒） */
    pollMs: 1000,
    /** 配方表（抽样用，T7），相对 steveX/ */
    recipes: 'dsh-plugins/agent/data/recipes.json',
    /** 物品的堆叠上限与合成剩余物（多份模式算格子用，T14；npm run extract-item-props 生成），相对 steveX/ */
    itemProps: 'dsh-plugins/agent/data/item-props.json',
    /** 切石配方（切石题出题用，切石机训练场设计方案 Q11；npm run extract-recipes 一并生成），相对 steveX/ */
    stonecutting: 'dsh-plugins/agent/data/stonecutting.json',
    /** 烹饪配方（熔炉题出题用，熔炉训练场设计方案 K10；npm run extract-recipes 一并生成），相对 steveX/ */
    cooking: 'dsh-plugins/agent/data/cooking.json',
    /** 酿造配方（酿造台题出题用，酿造台训练场设计方案 P10；npm run extract-item-props 一并生成），相对 steveX/ */
    brewing: 'dsh-plugins/agent/data/brewing.json',
    /**
     * 场地：名字 → { origin: 场内地板中心 [x,y,z], mode: named | hidden（T5）, exclude: 不抽的配方名,
     *   grid: 合成格边长 2 | 3（缺省 2）, station: 场内工作站 'crafting_table' | null（缺省 null）,
     *   timeoutSec? / wallTimeoutSec?: 覆盖全局的时间上限, portions? / crafts?: n、m 的默认值 "k" | "a-b"（T14，命令行优先；不写 = n 在 1–64 随机） }。
     * 工作台训练场见 docs/工作台训练场设计方案.md
     *
     * type 选题型（箱子训练场设计方案 C11）：不写 = 'craft'（上面这些字段）；'storage' = 箱子存取，字段是
     *   { origin, kind: take | put | mix, rel: lt | eq | gt | mix, chest: small | large | hopper | dispenser | mix（大小箱子）| all（四种）, stack: 64 | 16 | 1 | mix,
     *     fill: random（每格数量在 [1, 堆叠上限] 随机）| full（每格取满）| mix,
     *     types: 物品种类数（含全部目标）"k" | "a-b"（1–9）, targets: 每轮要搬几种目标物品 "k" | "a-b"（1–4，缺省 1，§9）, dest: 'empty'（C6，partial 暂不开放）, exclude: 不抽的物品 id,
     *     timeoutSec? / wallTimeoutSec? }（命令行同名选项优先），见 docs/箱子训练场设计方案.md
     * 'stonecut' = 切石机，字段是 { origin, materials: 材料种数 "k" | "a-b"（1–3）, slots: 每种材料占的格数（1–9）, fill: random | full | mix,
     *     styles: 每种材料切几种样式（1–3）, bypass: exclude（物品栏 2×2 就能直接做出的产物不出题）| keep, exclude: 不用的材料 / 产物 id,
     *     timeoutSec? / wallTimeoutSec? }（命令行同名选项优先），见 docs/切石机训练场设计方案.md
     * 'cook' = 熔炉 / 高炉 / 烟熏炉，字段是 { origin, station: furnace | blast_furnace | smoker | random, raw / fuel: 原料、燃料总数 "k" | "a-b"（1–256）,
     *     rawSlots / fuelSlots: 各占几格（1–4）, n / m: 要放进原料格、燃料格的个数（1–64）, exclude: 不用的原料 / 燃料 / 产物 id,
     *     timeoutSec? / wallTimeoutSec? }（命令行同名选项优先），见 docs/熔炉训练场设计方案.md
     * 'enchant' = 附魔台，字段是 { origin, bookshelves: 附魔台周围的书架数（0–15）, xpLevel: 每轮的经验等级, exclude: 不用的物品 id,
     *     timeoutSec? / wallTimeoutSec? }（命令行同名选项优先），见 docs/附魔台训练场设计方案.md
     * 'beacon' = 信标，字段是 { origin, amplifier: 1 | 2 | mix（目标级数；mix = 前 5 个效果 I、II 级各一半）, count: 付款物品数量 "k" | "a-b"（1–64）,
     *     exclude: 不出的效果 id（也不当再生题的主效果）, timeoutSec? / wallTimeoutSec? }（命令行同名选项优先），见 docs/信标训练场设计方案.md
     * 'anvil' = 铁砧，字段是 { origin, xpLevel: 每轮的经验等级（39–1000）, enchants: 第二件物品带几个附魔 "k" | "a-b"（1–5）, curses: 第二件的附魔里能不能有诅咒,
     *     exclude: 不用的物品 id, timeoutSec? / wallTimeoutSec? }（命令行同名选项优先），见 docs/铁砧训练场设计方案.md
     * 'smithing' = 锻造台，字段是 { origin, tasks: 一轮几道题 "k" | "a-b"（1–4）, exclude: 不出的底材、升级结果、模板、纹饰样式、纹饰材料或材料物品的 id,
     *     timeoutSec? / wallTimeoutSec? }（命令行同名选项优先），见 docs/锻造台训练场设计方案.md
     * 'mount' = 坐骑（动物身上的物品栏），字段是 { origin, groups: 出哪几组动物（horse / donkey / camel / llama / nautilus）, total: 两格物品的总数 "k" | "a-b"（2–128）,
     *     move: 要搬的数量 "k" | "a-b"（1–64）, exclude: 物品池里不抽的物品 id, timeoutSec? / wallTimeoutSec? }（命令行同名选项优先），见 docs/坐骑训练场设计方案.md
     * 'loom' = 织布机，字段是 { origin, banners: 底色种数 "k" | "a-b"（1–3）, slots: 每种底色的格数（1–3）, fill: random | full | mix, styles: 每种底色的样式数（1–3）,
     *     spare: 素旗、染料比目标多发几个（0–3）, itemPatterns: off | on（要不要出图案物的图案）, exclude: 不出的素旗、染料、图案、图案物 id, timeoutSec? / wallTimeoutSec? }
     *     （命令行同名选项优先），见 docs/织布机训练场设计方案.md
     * 'cartography' = 制图台，字段是 { origin, task: zoom | lock | clone | mix | chain（mix = 前三种单项操作等概率）, scale: 开局地图的缩放等级（0–3）,
     *     maps: 放大、锁定题开局几张（1–3）, copies: 复制题做到几张（2–5）, ops: chain 题的步数（1–4）, spare: 用到的辅料多发几个（0–3）,
     *     timeoutSec? / wallTimeoutSec? }（命令行同名选项优先），见 docs/制图台训练场设计方案.md
     * 'brew' = 酿造台，字段是 { origin, fuel: 发几个烈焰粉 "k" | "a-b"（1–64）, raw: 发几个材料（1–64，不超过堆叠上限）, bottles: 发几瓶药水（1–3）,
     *     m: 放进燃料格的个数, n: 放进材料格的个数（1–64）, exclude: 不出的材料、药水、瓶子 id, timeoutSec? / wallTimeoutSec? }（命令行同名选项优先），见 docs/酿造台训练场设计方案.md
     * 'crafter' = 合成器，字段是 { origin, portions: 放几份（每个放了材料的格子几个）"k" | "a-b"（1–64，不超过材料的堆叠上限）,
     *     extra: 每种材料多发几个（0–64，不超过堆叠上限）, exclude: 不出的配方名, timeoutSec? / wallTimeoutSec? }（命令行 n= / extra= 优先），见 docs/合成器训练场设计方案.md
     * 'trade' = 村民交易，字段是 { origin, level: 村民等级 "k" | "a-b"（1–5）, tasks: 选几笔交易（1–4）, portions: 每笔交易几次（1–64，再截到这笔交易最多能出的次数）,
     *     extra: 每种付款物多发几个（0–64，上限另放宽到单价的 2 倍）, exclude: { professions: 不出的职业, items: 不当产物的物品 id }, timeoutSec? / wallTimeoutSec? }
     *     （命令行 level= / tasks= / n= / extra= / profession= / item= 优先），见 docs/村民交易训练场设计方案.md
     * 'grindstone' = 砂轮，字段是 { origin, tasks: 一轮几件 "k" | "a-b"（1–4）, kind: item | book | mix（mix = 每件 1/4 的概率是附魔书）,
     *     enchants: 每件带几个非诅咒附魔（1–5）, curses: 每件带几个诅咒（0–2）, exclude: 不出的物品 id（写 minecraft:enchanted_book 就不出附魔书）,
     *     timeoutSec? / wallTimeoutSec? }（命令行同名选项优先），见 docs/砂轮训练场设计方案.md
     * 'book' = 书与笔（没有工作站），字段是 { origin, books: 一轮几本 "k" | "a-b"（1–3）, pages: 每本开局几页（1–8）, edits: 每本改几页（1–4）,
     *     exclude: 不用, timeoutSec? / wallTimeoutSec? }（命令行同名选项优先），见 docs/书与笔训练场设计方案.md
     * 'sign' = 告示牌，字段是 { origin, kind: text | color | wax | null（null = 每轮三种随机）, edits: text 题改几行 "k" | "a-b"（1–4）,
     *     exclude: 不用, timeoutSec? / wallTimeoutSec? }（命令行同名选项优先），见 docs/告示牌训练场设计方案.md
     * 'bow' = 弓箭（射击平台加 48 格的空场地，原点是平台中心），字段是 { origin, targets: 一轮几个标靶 "k" | "a-b"（1–4）,
     *     dist: 眼睛到标靶的距离 "a-b"（2–60）, rodDist: 钓竿的轮次没写 dist= 时用的距离 "a-b"（2–16，缺省 3-10，第五稿 Q28）, weapon: 武器 "bow" | "crossbow" | "trident" | "fishing_rod" | "any"（缺省 bow，any 每轮在弓、弩、三叉戟里等概率抽一种，不抽钓竿；第三稿加的弩、第四稿加的三叉戟、第五稿加的钓竿）, exclude: 不用, timeoutSec? / wallTimeoutSec? }（命令行同名选项优先），见 docs/弓箭训练场设计方案.md
     * 'route' / 'goal' = 陆地寻路的路线题 / 寻路题（两个题型共用 mod 里的一块场地 land，原点是场地西北角、平地地板的顶面），字段是 { origin,
     *     ground: 地形 "flat" | "synthetic" | "terrain" | "any"（寻路题不收 flat；缺省路线 flat、寻路 synthetic）, memory: 记忆 "prefill" | "none" | "any"（缺省 prefill）,
     *     size: 场地边长（区块）"k" | "a-b"（2–4，可按地形写成 { flat, synthetic, terrain }；缺省路线 2、寻路 4）, points: 路线题的中间点数 "k" | "a-b"（1–8，缺省 2-4）,
     *     edge: 路线题放在场地最外一圈的中间点数 "k" | "a-b"（0–8，超过本轮点数时取点数；缺省 0-2）, offset: 本轮场地在 x、z 方向各自随机偏移的格数 "k" | "a-b"（0–16，缺省 0-16）,
     *     dist: 起终点的水平直线距离 "a-b"（4–88，可按地形分开写；缺省路线 12-28、寻路 24-56）, relief: { synthetic, terrain } 高差 "a-b"（缺省 4-12 / 4-24）,
     *     cliffs: 模拟起伏的悬崖和坑 "k" | "a-b"（0–8，缺省 1-3）, maxWater: 真实世界窗口的水面占比上限（缺省 0.25）, markers: 画观察标记（缺省 true）,
     *     terrainSources: 真实世界的源区域 [[cx, cz, 区块数], …], exclude: 不用, timeoutSec? / wallTimeoutSec? }（命令行同名选项优先），见 docs/陆地寻路训练场设计方案.md
     */
    arenas: {
      craft2x2: { origin: [10000, 120, 10000], mode: 'named', exclude: [] },
      craft3x3: { origin: [10000, 120, 10030], mode: 'named', grid: 3, station: 'crafting_table', exclude: [], timeoutSec: 900 },
      chest: { type: 'storage', origin: [10000, 120, 10060], timeoutSec: 600, kind: 'mix', rel: 'mix', chest: 'mix', stack: 'mix', fill: 'random', types: '1-4', targets: '1', dest: 'empty', exclude: ['minecraft:bundle'] },
      stonecutter: { type: 'stonecut', origin: [10000, 120, 10090], timeoutSec: 900, materials: '1-3', slots: '1-9', fill: 'random', styles: '1-3', bypass: 'exclude', exclude: [] },
      furnace: { type: 'cook', origin: [10000, 120, 10120], timeoutSec: 600, station: 'random', raw: '64-128', fuel: '64-128', rawSlots: 2, fuelSlots: 2, n: '1-64', m: '1-64', exclude: [] },
      enchanting: { type: 'enchant', origin: [10000, 120, 10150], timeoutSec: 600, bookshelves: 15, xpLevel: 30, exclude: [] },
      // 信标场地换到 x = 10100（信标训练场设计方案 G1）：4 级信标的水平范围是 50 格，和其他场地要隔开 50 格以上
      beacon: { type: 'beacon', origin: [10100, 120, 10000], timeoutSec: 600, amplifier: 'mix', count: '32-64', exclude: [] },
      anvil: { type: 'anvil', origin: [10000, 120, 10180], timeoutSec: 600, xpLevel: 216, enchants: '1-3', curses: false, exclude: [] },
      smithing: { type: 'smithing', origin: [10000, 120, 10210], timeoutSec: 600, tasks: '1-4', exclude: [] },
      mount: { type: 'mount', origin: [10000, 120, 10240], timeoutSec: 600, groups: ['horse', 'donkey', 'camel', 'llama', 'nautilus'], total: '64-128', move: '1-64', exclude: ['minecraft:bundle'] },
      loom: { type: 'loom', origin: [10000, 120, 10270], timeoutSec: 900, banners: '1-3', slots: '1-3', fill: 'random', styles: '1-3', spare: '0-3', itemPatterns: 'off', exclude: [] },
      cartography: { type: 'cartography', origin: [10000, 120, 10300], timeoutSec: 600, task: 'mix', scale: '0-3', maps: '1-3', copies: '2-5', ops: '1-4', spare: '0-3', exclude: [] },
      brewing: { type: 'brew', origin: [10000, 120, 10330], timeoutSec: 600, fuel: '32-64', raw: '32-64', bottles: '1-3', m: '1-32', n: '1-32', exclude: [] },
      crafter: { type: 'crafter', origin: [10000, 120, 10360], timeoutSec: 900, portions: '1-16', extra: '0-16', exclude: [] },
      villager: { type: 'trade', origin: [10000, 120, 10390], timeoutSec: 900, level: '1-5', tasks: '1-4', portions: '1-64', extra: '0-16', exclude: { professions: [], items: [] } },
      grindstone: { type: 'grindstone', origin: [10000, 120, 10420], timeoutSec: 600, tasks: '1-3', kind: 'mix', enchants: '1-3', curses: '0-1', exclude: [] },
      book: { type: 'book', origin: [10000, 120, 10450], timeoutSec: 600, books: '1-3', pages: '1-6', edits: '1-3', exclude: [] },
      sign: { type: 'sign', origin: [10000, 120, 10480], timeoutSec: 300, kind: null, edits: '1-3', exclude: [] },
      bow: { type: 'bow', origin: [10300, 120, 10000], timeoutSec: 600, targets: '1-4', dist: '8-40', rodDist: '3-10', weapon: 'bow', exclude: [] },
      route: { type: 'route', ...ROUTE_ARENA_DEFAULTS },
      goal: { type: 'goal', ...GOAL_ARENA_DEFAULTS }
    }
  },
  planner: {
    enabled: true,
    /** 工具结果的字符上限，超出截断并提示缩小查询（§5.2） */
    maxOutputChars: 20000,
    /** bt_inspect 每次结果的字节上限（P2 §4.4） */
    inspectMaxBytes: 8000,
    /** 只给 agent 看 steveX 的工具与 extraTools，其余 DSH 内置工具（shell、文件读写……）全部关掉（§5.4） */
    exclusiveTools: true,
    extraTools: ['ask_user_question', 'todo_write']
  },
  promptsDir: path.join(steveXRoot, 'dsh-plugins', 'agent', 'prompts'),
  logger: console
})

export function normalizeConfig(raw = {}) {
  const config = {
    ...DEFAULTS,
    ...raw,
    timing: { ...DEFAULTS.timing, ...(raw.timing ?? {}) },
    camera: { ...DEFAULTS.camera, ...(raw.camera ?? {}) },
    sandbox: { ...DEFAULTS.sandbox, ...(raw.sandbox ?? {}) },
    observe: {
      ...DEFAULTS.observe, ...(raw.observe ?? {}),
      byCommand: { ...DEFAULTS.observe.byCommand, ...(raw.observe?.byCommand ?? {}) },
      settle: { ...DEFAULTS.observe.settle, ...(raw.observe?.settle ?? {}) }
    },
    planner: { ...DEFAULTS.planner, ...(raw.planner ?? {}) },
    fast: { ...DEFAULTS.fast, ...(raw.fast ?? {}) },
    reflect: { ...DEFAULTS.reflect, ...(raw.reflect ?? {}) },
    curate: { ...DEFAULTS.curate, ...(raw.curate ?? {}) },
    history: { ...DEFAULTS.history, ...(raw.history ?? {}) },
    facts: { ...DEFAULTS.facts, ...(raw.facts ?? {}) },
    training: normalizeTraining(raw.training)
  }
  for (const key of ['tickMs', 'statePollMs', 'maxExpansionNodes', 'maxInvalidAttempts', 'maxValueBytes', 'maxCapsuleDepth', 'snapshotKeep', 'reactiveEveryMs', 'respawnTimeoutMs']) {
    if (!(Number.isInteger(config[key]) && config[key] > 0)) throw new Error(`stevex-agent config: ${key} must be a positive integer`)
  }
  for (const key of ['batchSize', 'batchMaxEvents', 'reflectMaxParallel', 'incidentQuietMs', 'episodeMergeMs', 'snapshotKeep', 'maxArms', 'maxNodesPerArm', 'maxEpisodeMs']) {
    if (!(Number.isInteger(config.fast[key]) && config.fast[key] > 0)) throw new Error(`stevex-agent config: fast.${key} must be a positive integer`)
  }
  if (typeof config.camera.instant !== 'boolean') throw new Error('stevex-agent config: camera.instant must be true or false')
  if (!(typeof config.camera.speed === 'number' && config.camera.speed >= 30 && config.camera.speed <= 3600)) throw new Error('stevex-agent config: camera.speed must be a number within 30-3600 (degrees per second)')
  if (!['changed', 'always'].includes(config.reflect.onDone)) throw new Error('stevex-agent config: reflect.onDone must be "changed" or "always"')
  if (!(Number.isInteger(config.curate.everyTasks) && config.curate.everyTasks >= 0)) throw new Error('stevex-agent config: curate.everyTasks must be a non-negative integer (0 = manual only)')
  if (!(Number.isInteger(config.curate.listLimit) && config.curate.listLimit > 0)) throw new Error('stevex-agent config: curate.listLimit must be a positive integer')
  for (const key of ['timeoutSec', 'wallTimeoutSec', 'pollMs']) {
    if (!(Number.isInteger(config.training[key]) && config.training[key] > 0)) throw new Error(`stevex-agent config: training.${key} must be a positive integer`)
  }
  for (const [name, arena] of Object.entries(config.training.arenas)) {
    if (!/^[a-z0-9_]{1,32}$/.test(name)) throw new Error(`stevex-agent config: training.arenas key "${name}" must match [a-z0-9_]{1,32}`)
    if (!(Array.isArray(arena.origin) && arena.origin.length === 3 && arena.origin.every(Number.isInteger))) {
      throw new Error(`stevex-agent config: training.arenas.${name}.origin must be [x, y, z] integers`)
    }
    for (const key of ['timeoutSec', 'wallTimeoutSec']) if (arena[key] !== undefined && !(Number.isInteger(arena[key]) && arena[key] > 0)) {
      throw new Error(`stevex-agent config: training.arenas.${name}.${key} must be a positive integer`)
    }
    if (arena.type === 'trade') {
      // 村民交易场地（村民交易训练场设计方案 §5）：exclude 是 { professions, items }
      const ex = arena.exclude ?? {}
      const strings = (v) => v === undefined || (Array.isArray(v) && v.every((s) => typeof s === 'string'))
      if (typeof ex !== 'object' || Array.isArray(ex) || !strings(ex.professions) || !strings(ex.items)) {
        throw new Error(`stevex-agent config: training.arenas.${name}.exclude must be { professions: [profession ids], items: [item ids] }`)
      }
      try {
        tradeOptions({}, arena)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (arena.type === 'route' || arena.type === 'goal') {
      // 陆地寻路训练场设计方案 §5.2、§6
      try {
        landOptions(arena.type, {}, arena)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (!(Array.isArray(arena.exclude) && arena.exclude.every((r) => typeof r === 'string'))) {
      throw new Error(`stevex-agent config: training.arenas.${name}.exclude must be a list of ${arena.type === 'beacon' ? 'effect ids' : ['storage', 'stonecut', 'cook', 'enchant', 'anvil', 'grindstone'].includes(arena.type) ? 'item ids' : arena.type === 'smithing' ? 'item, trim pattern or trim material ids' : arena.type === 'mount' ? 'item ids' : arena.type === 'loom' ? 'banner, dye, banner pattern or pattern item ids' : ['cartography', 'book', 'sign', 'bow'].includes(arena.type) ? 'strings (unused)' : arena.type === 'brew' ? 'ingredient, potion or bottle ids' : 'recipe names'}`)
    }
    const type = arena.type ?? 'craft'
    if (!['craft', 'storage', 'stonecut', 'cook', 'enchant', 'beacon', 'anvil', 'smithing', 'mount', 'loom', 'cartography', 'brew', 'crafter', 'trade', 'grindstone', 'book', 'sign', 'bow', 'route', 'goal'].includes(type)) throw new Error(`stevex-agent config: training.arenas.${name}.type must be "craft", "storage", "stonecut", "cook", "enchant", "beacon", "anvil", "smithing", "mount", "loom", "cartography", "brew", "crafter", "trade", "grindstone", "book", "sign", "bow", "route" or "goal"`)
    if (type === 'crafter') {
      try {
        crafterOptions({}, arena)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (type === 'brew') {
      try {
        brewOptions({}, arena)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (type === 'cartography') {
      try {
        cartographyOptions({}, arena)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (type === 'loom') {
      try {
        loomOptions({}, arena)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (type === 'mount') {
      try {
        parseMountGroups(arena.groups)
        const total = parseMountTotal(arena.total)
        const move = parseMountMove(arena.move)
        if (move.lo > total.lo) throw new Error(`move 的下限 ${move.lo} 大于 total 的下限 ${total.lo}`)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (type === 'smithing') {
      try {
        parseTasksSpec(arena.tasks)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (type === 'bow') {
      try {
        bowOptions({}, arena)
        // 第五稿 Q28：rodDist 只在钓竿的轮次用，配置里写了就一并查
        bowOptions({ weapon: 'fishing_rod' }, arena)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (type === 'sign') {
      try {
        signOptions({}, arena)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (type === 'book') {
      try {
        bookOptions({}, arena)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (type === 'grindstone') {
      try {
        grindstoneOptions({}, arena)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (type === 'anvil') {
      try {
        parseAnvilXpLevel(arena.xpLevel)
        parseEnchantsSpec(arena.enchants)
        parseCurses(arena.curses)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (type === 'beacon') {
      try {
        parseAmplifier(arena.amplifier)
        parseBeaconCountSpec(arena.count)
        beaconPool({ exclude: arena.exclude, amplifier: arena.amplifier, count: arena.count })
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (type === 'enchant') {
      try {
        parseBookshelves(arena.bookshelves)
        parseXpLevel(arena.xpLevel)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (type === 'cook') {
      for (const [key, choices] of Object.entries(COOK_CHOICES)) {
        if (!choices.includes(String(arena[key]))) throw new Error(`stevex-agent config: training.arenas.${name}.${key} must be one of ${choices.join(' | ')}`)
      }
      try {
        parseTotalSpec('raw', arena.raw)
        parseTotalSpec('fuel', arena.fuel)
        parseCookSlotsSpec('rawSlots', arena.rawSlots)
        parseCookSlotsSpec('fuelSlots', arena.fuelSlots)
        parseCountSpec(arena.n, 'n')
        parseCountSpec(arena.m, 'm')
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (type === 'stonecut') {
      for (const [key, choices] of Object.entries(STONECUT_CHOICES)) {
        if (!choices.includes(String(arena[key]))) throw new Error(`stevex-agent config: training.arenas.${name}.${key} must be one of ${choices.join(' | ')}`)
      }
      try {
        parseMaterialsSpec(arena.materials)
        parseSlotsSpec(arena.slots)
        parseStylesSpec(arena.styles)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      continue
    }
    if (type === 'storage') {
      for (const [key, choices] of Object.entries(STORAGE_CHOICES)) {
        if (!choices.includes(String(arena[key]))) throw new Error(`stevex-agent config: training.arenas.${name}.${key} must be one of ${choices.join(' | ')}`)
      }
      try {
        parseTypesSpec(arena.types)
        parseTargetsSpec(arena.targets)
      } catch (error) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${error.message}`)
      }
      if (arena.dest !== 'empty') throw new Error(`stevex-agent config: training.arenas.${name}.dest must be "empty" (partial is not open yet)`)
      continue
    }
    if (!['named', 'hidden'].includes(arena.mode)) throw new Error(`stevex-agent config: training.arenas.${name}.mode must be "named" or "hidden"`)
    if (![2, 3].includes(arena.grid)) throw new Error(`stevex-agent config: training.arenas.${name}.grid must be 2 or 3`)
    if (![null, 'crafting_table'].includes(arena.station)) throw new Error(`stevex-agent config: training.arenas.${name}.station must be "crafting_table" or null`)
    for (const key of ['portions', 'crafts']) {
      const value = arena[key]
      if (value === undefined || value === null) continue
      const match = /^(\d+)(?:-(\d+))?$/.exec(String(value))
      if (!match || !(Number(match[1]) >= 1 && Number(match[2] ?? match[1]) <= 64 && Number(match[1]) <= Number(match[2] ?? match[1]))) {
        throw new Error(`stevex-agent config: training.arenas.${name}.${key} must be "k" or "a-b" within 1-64`)
      }
    }
  }
  config.training.recipes = path.resolve(steveXRoot, config.training.recipes)
  config.training.itemProps = path.resolve(steveXRoot, config.training.itemProps)
  config.training.stonecutting = path.resolve(steveXRoot, config.training.stonecutting)
  config.training.cooking = path.resolve(steveXRoot, config.training.cooking)
  config.training.brewing = path.resolve(steveXRoot, config.training.brewing)
  for (const key of ['maxOutputChars', 'inspectMaxBytes']) {
    if (!(Number.isInteger(config.planner[key]) && config.planner[key] > 0)) throw new Error(`stevex-agent config: planner.${key} must be a positive integer`)
  }
  for (const key of ['runtimeDir', 'fastTreeDir', 'capsulesDir', 'historyDir', 'visionRoot', 'promptsDir']) {
    if (config[key] !== null) config[key] = path.resolve(steveXRoot, config[key])
  }
  config.jsonSources = Object.fromEntries(
    Object.entries(config.jsonSources ?? {}).map(([id, target]) => [id, path.resolve(steveXRoot, target)])
  )
  return config
}

/** 场地逐个合并缺省值：只覆盖 craft2x2 的 mode 时 origin 照旧。 */
function normalizeTraining(raw = {}) {
  const arenas = {}
  for (const [name, arena] of Object.entries({ ...DEFAULTS.training.arenas, ...(raw.arenas ?? {}) })) {
    const type = arena.type ?? DEFAULTS.training.arenas[name]?.type ?? 'craft'
    arenas[name] = type === 'storage'
      ? { ...STORAGE_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
      : type === 'stonecut'
        ? { ...STONECUT_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
        : type === 'cook'
          ? { ...COOK_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'enchant'
            ? { ...ENCHANT_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'beacon'
            ? { ...BEACON_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'anvil'
            ? { ...ANVIL_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'smithing'
            ? { ...SMITHING_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'mount'
            ? { ...MOUNT_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'loom'
            ? { ...LOOM_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'cartography'
            ? { ...CARTOGRAPHY_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'brew'
            ? { ...BREW_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'crafter'
            ? { ...CRAFTER_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'trade'
            ? { ...TRADE_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'grindstone'
            ? { ...GRINDSTONE_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'book'
            ? { ...BOOK_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'sign'
            ? { ...SIGN_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'bow'
            ? { ...BOW_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'route'
            ? { ...ROUTE_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
          : type === 'goal'
            ? { ...GOAL_ARENA_DEFAULTS, ...(DEFAULTS.training.arenas[name] ?? {}), ...arena }
        : { grid: 2, station: null, ...(DEFAULTS.training.arenas[name] ?? { mode: 'named', exclude: [] }), ...arena }
  }
  return { ...DEFAULTS.training, ...raw, arenas }
}

export { steveXRoot }
