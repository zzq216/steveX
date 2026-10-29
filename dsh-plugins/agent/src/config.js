import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  /** core.json.query 能读的数据源：标识 → 文件或目录（相对 steveX/）。不在这里的文件读不到 */
  jsonSources: { recipes: 'dsh-plugins/agent/data/recipes.json' },
  /** core.nbt.query 读的采集端落盘目录（相对 steveX/） */
  visionRoot: 'vendor/stevex-template-1.21.11/run/stevex/vision',
  maxExpansionNodes: 15,
  maxInvalidAttempts: 3,
  maxValueBytes: 16384,
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
    /** 一个情节最长多久，超时按 FAILURE 收场（§7.3） */
    maxEpisodeMs: 30000,
    /** false = 只记事件、不开反思会话 */
    reflect: true,
    /** 反思会话用的 DSH 预设（§5.1） */
    sessionPreset: 'stevex'
  },
  /** 沙箱硬超时：Compute 单次、条件代码单次（快树每 tick 都要算） */
  sandbox: { timeoutMs: 1000, conditionTimeoutMs: 50, maxOutputBytes: 65536 },
  maxCapsuleDepth: 8,
  /** 每个 Steps / Action 前后读哪些状态来源报告差异（可观测性） */
  observe: { enabled: true, sources: ['inventory', 'container', 'f3'] },
  timing: { clickWaitMs: 80, lookWaitMs: 150, pollMs: 100 },
  /** 本地应答器（没有大模型时回答请求）。DSH 里属于会话的任务的请求都交给大模型，它只回答 /bt run 的手写树 */
  localResponder: true,
  /** 大模型侧（集成方案 §4 / §5，P1）：只在 DSH 适配层里生效，scripts/ 不用 */
  /** 事实库与 MC 源码（P5 §10） */
  facts: {
    /** 事实库目录（进 git） */
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
    /** 保存胶囊时查写死的值（P4 §5）；false 只用于调试 */
    literalCheck: true
  },
  /** 胶囊库整理（胶囊库整理设计方案 §5） */
  curate: {
    /** 每结束几个任务自动发一次整理请求；0 = 只能手动 /bt curate（C1） */
    everyTasks: 0,
    /** 条目超过这么多时，整理请求只给目录、不给全量清单（C5） */
    listLimit: 150
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
    sandbox: { ...DEFAULTS.sandbox, ...(raw.sandbox ?? {}) },
    observe: { ...DEFAULTS.observe, ...(raw.observe ?? {}) },
    planner: { ...DEFAULTS.planner, ...(raw.planner ?? {}) },
    fast: { ...DEFAULTS.fast, ...(raw.fast ?? {}) },
    reflect: { ...DEFAULTS.reflect, ...(raw.reflect ?? {}) },
    curate: { ...DEFAULTS.curate, ...(raw.curate ?? {}) },
    facts: { ...DEFAULTS.facts, ...(raw.facts ?? {}) }
  }
  for (const key of ['tickMs', 'statePollMs', 'maxExpansionNodes', 'maxInvalidAttempts', 'maxValueBytes', 'maxCapsuleDepth', 'snapshotKeep', 'reactiveEveryMs', 'respawnTimeoutMs']) {
    if (!(Number.isInteger(config[key]) && config[key] > 0)) throw new Error(`stevex-agent config: ${key} must be a positive integer`)
  }
  for (const key of ['batchSize', 'batchMaxEvents', 'reflectMaxParallel', 'incidentQuietMs', 'episodeMergeMs', 'snapshotKeep', 'maxArms', 'maxEpisodeMs']) {
    if (!(Number.isInteger(config.fast[key]) && config.fast[key] > 0)) throw new Error(`stevex-agent config: fast.${key} must be a positive integer`)
  }
  if (!(Number.isInteger(config.curate.everyTasks) && config.curate.everyTasks >= 0)) throw new Error('stevex-agent config: curate.everyTasks must be a non-negative integer (0 = manual only)')
  if (!(Number.isInteger(config.curate.listLimit) && config.curate.listLimit > 0)) throw new Error('stevex-agent config: curate.listLimit must be a positive integer')
  for (const key of ['maxOutputChars', 'inspectMaxBytes']) {
    if (!(Number.isInteger(config.planner[key]) && config.planner[key] > 0)) throw new Error(`stevex-agent config: planner.${key} must be a positive integer`)
  }
  for (const key of ['runtimeDir', 'fastTreeDir', 'capsulesDir', 'visionRoot', 'promptsDir']) {
    if (config[key] !== null) config[key] = path.resolve(steveXRoot, config[key])
  }
  config.jsonSources = Object.fromEntries(
    Object.entries(config.jsonSources ?? {}).map(([id, target]) => [id, path.resolve(steveXRoot, target)])
  )
  return config
}

export { steveXRoot }
