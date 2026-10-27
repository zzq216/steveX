import { GameState, createModClient } from './game/index.js'
import { Executor, EventLog, createLocalResponder } from './bt/index.js'
import { CapsuleLibrary, Sandbox, createBuiltins } from './capsules/index.js'
import { createDefaultRegistry } from './commands.js'
import { FastMonitor, FastVersions, FastReflector, EMPTY_FAST_TREE } from './fast/index.js'
import { FactStore, SourceTree } from './facts/index.js'

/**
 * 组装一套运行时：mod 连接 → 游戏状态 → 命令注册表 → 胶囊库与沙箱 → 执行器（+ P0 本地应答器）。
 * DSH 适配层（index.js）和独立脚本（scripts/）共用这一处，保证两边跑的是同一套东西。
 *
 * @param {object} config  normalizeConfig() 的结果
 * @param {object} [deps]  { mod }：注入假 mod（测试）；缺省按 config.modUrl 建 ModWSClient
 * @param {string[]} [deps.responderTypes]  本地应答器只回答这些请求（DSH 里去掉交给大模型的 expand）
 * @param {(request) => boolean} [deps.responderSkip]  本地应答器跳过的请求（DSH 里：属于某个会话的任务，交给大模型）
 */
export function createRuntime(config, deps = {}) {
  const mod = deps.mod ?? createModClient({ url: config.modUrl })
  const game = new GameState({ mod, timing: config.timing, statePollMs: config.statePollMs })
  const registry = createDefaultRegistry()
  const capsules = createCapsules(config)
  const eventLog = new EventLog({ runtimeDir: config.runtimeDir })
  const executor = new Executor({
    game, registry, eventLog,
    capsules: { library: capsules.library, sandbox: capsules.sandbox, maxDepth: config.maxCapsuleDepth },
    config: {
      tickMs: config.tickMs,
      maxExpansionNodes: config.maxExpansionNodes,
      maxInvalidAttempts: config.maxInvalidAttempts,
      maxValueBytes: config.maxValueBytes,
      snapshotKeep: config.snapshotKeep,
      reactiveEveryMs: config.reactiveEveryMs,
      respawnTimeoutMs: config.respawnTimeoutMs,
      fastMaxEpisodeMs: config.fast.maxEpisodeMs,
      observe: config.observe
    }
  })
  const logger = config.logger ?? null
  const detachResponder = config.localResponder
    ? createLocalResponder(executor, { log: (line) => logger?.info?.(line), types: deps.responderTypes ?? null, skip: deps.responderSkip ?? null })
    : () => {}

  // 任务结束：通知查询 API（缓存已改为按版本，不再按任务钉住；保留这个钩子以兼容）
  executor.on('task', (summary) => {
    if (summary.state === 'done' || summary.state === 'failed') capsules.releaseTask(summary.taskId)
  })

  // 快树版本链（P3 §8）：装最新一版；版本 0 = 空快树。最新一版装不上（比如引用的胶囊没了）→ 先用空快树顶着、版本号不变，
  // 用 /bt fast rollback 回到一版能用的
  const versions = new FastVersions({
    dir: config.fastTreeDir, executor, library: capsules.library, sandbox: capsules.sandbox,
    config: { maxArms: config.fast.maxArms, maxNodesPerArm: config.maxExpansionNodes, maxEpisodeMs: config.fast.maxEpisodeMs }
  })
  try {
    versions.loadLatest()
    logger?.info?.(`[bt] fast tree v${versions.latest()} loaded`)
  } catch (error) {
    logger?.warn?.(`[bt] fast tree v${versions.latest()} could not be loaded, running an empty fast tree: ${error.message}`)
    executor.loadFastTree(EMPTY_FAST_TREE, { version: versions.latest(), meta: { by: 'fallback' } })
  }
  // 快树事件流与反思批次（P3 §3 / §4）：批次由大模型侧（index.js 的 FastBridge）接；没人接时只攒事件
  const monitor = new FastMonitor({
    executor, runtimeDir: config.runtimeDir,
    config: { incidentQuietMs: config.fast.incidentQuietMs, episodeMergeMs: config.fast.episodeMergeMs, snapshotKeep: config.fast.snapshotKeep }
  })
  const reflector = new FastReflector({
    executor, monitor, currentVersion: () => versions.latest(),
    config: { batchSize: config.fast.batchSize, batchMaxEvents: config.fast.batchMaxEvents, reflectMaxParallel: config.fast.reflectMaxParallel, reflect: config.fast.reflect }
  })
  reflector.start(monitor.start())

  // 事实库与 MC 源码基准（P5）
  const source = new SourceTree({ root: config.facts.sourceRoot, readMaxLines: config.facts.readMaxLines, searchLimit: config.facts.searchLimit })
  const facts = { source, store: new FactStore({ dir: config.facts.dir, source, maxRefLines: config.facts.maxRefLines, maxRefs: config.facts.maxRefs }) }

  return {
    mod, game, registry, executor,
    fast: { monitor, versions, reflector },
    facts,
    library: capsules.library,
    sandbox: capsules.sandbox,
    json: capsules.json,
    nbt: capsules.nbt,
    releaseTask: (taskId) => capsules.releaseTask(taskId),
    dispose() {
      reflector.stop()
      monitor.stop()
      executor.stop()
      detachResponder()
      if (!deps.mod) mod.close?.()
    }
  }
}

/** 胶囊库 + 沙箱 + 内置查询条目。scripts/capsule-save.js 不需要 mod，也用它。 */
export function createCapsules(config) {
  const { builtins, json, nbt } = createBuiltins({ jsonSources: config.jsonSources, visionRoot: config.visionRoot })
  return {
    library: new CapsuleLibrary({ dir: config.capsulesDir, builtins }),
    sandbox: new Sandbox(config.sandbox),
    json,
    nbt,
    releaseTask(taskId) {
      json.releaseTask(taskId)
      nbt?.releaseTask(taskId)
    }
  }
}
