import { EventEmitter } from 'node:events'
import { SUCCESS, FAILURE, RUNNING, NEEDS_EXPANSION, isTerminal } from './status.js'
import { Blackboard } from './blackboard.js'
import { buildTree, walkSpec, replaceSpec, pinRefs } from './build.js'
import { compileTree } from './compiler.js'
import { validateTree } from './validator.js'
import { EventLog } from './event_log.js'
import { planPatch } from './patch.js'
import { DEFAULT_OBSERVE_SOURCES } from './observe.js'
import { SnapshotBuffer, ALL_STATE_SOURCES, buildDirectory, inspect } from './evidence.js'

/**
 * 行为树执行器（集成方案 §3.2 / 行为树设计 §7）。
 *
 * 每个 tick：
 *   1. tick 快树（Match）——永远在跑，任务挂起、暂停、没有任务时也跑
 *   2. 快树的四种情况（行为树设计 §7.2）：
 *        命中 otherwise           → 什么都不做，tick 任务树
 *        命中真实 arm（新情节）   → 抢占：中止任务树 + 默认中止流程，完成后才开始 tick 该 arm
 *        情节结束 SUCCESS          → 请求 recover
 *        情节结束 FAILURE          → 请求 escalate
 *   0. 先看死亡（P2 实施细则 §8.3 / P3 §2.4）：死了 → 自动重生；有任务时先中止、重生后请求 died。处理期间快树与任务树都不 tick
 *   0'. 有排队的新版快树（P3 §8.3）且不在情节里 → 换上
 *   3. 任务树 running 且没有快树情节 → tick 任务树
 *        NEEDS_EXPANSION → 挂起，请求 expand
 *        根 FAILURE      → 先原地重试失败叶子一次（§7.5 ①），再失败才请求 failed
 *
 * 需要大模型的地方一律发 'request' 事件，由外部用 submitExpansion / submitPatch / answerRequest（放弃）回答。
 * 没有大模型的场合（scripts/bt-run.js）用一个本地应答器顶上（恢复 = 空补丁）。
 * 一个任务同时至多一个在飞请求（I4）：在飞期间的新事件把它标成 stale，回答时被拒并附上新证据。
 */
export class Executor extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('../game/state.js').GameState} options.game
   * @param {import('../game/registry.js').CommandRegistry} options.registry
   * @param {EventLog} [options.eventLog]
   * @param {object} [options.capsules]  { library, sandbox, maxDepth }：Compute / SubTree / 条件代码
   * @param {object} [options.config]    { tickMs, maxExpansionNodes, maxInvalidAttempts, maxValueBytes, observe }
   *   observe：{ enabled, sources }——每个 Steps / Action 前后读哪些状态来源、报告差异（算法层 §8.8.2）
   */
  constructor({ game, registry, capsules = null, eventLog = new EventLog(), config = {}, now = () => Date.now() }) {
    super()
    this.game = game
    this.registry = registry
    this.capsules = capsules
    this.eventLog = eventLog
    this.config = {
      tickMs: 50, maxExpansionNodes: 15, maxInvalidAttempts: 3, maxValueBytes: 16384, snapshotKeep: 20, reactiveEveryMs: 1000, respawnTimeoutMs: 10000, respawnPollMs: 200,
      fastMaxEpisodeMs: 30000,
      ...config,
      observe: { enabled: true, sources: DEFAULT_OBSERVE_SOURCES, ...(config.observe ?? {}) }
    }
    this.now = now
    this.fast = null       // { spec, root, version }
    this.nextFast = null   // 排队等情节结束再换上的快树（P3 §8.3）：{ spec, root, version, meta }
    this.task = null
    this.episode = null    // 快树情节 { arm, name, phase, startedAt, before, interrupted }
    this.timer = null
    this.ticking = false
    this.taskSeq = 0
    this.requestSeq = 0
    this.pendingAborts = []
    this.dying = false     // 正在处理死亡与重生（§8.3）
    this.stuckDead = false // 重生失败（极限模式等）：还死着就不再重试，等它自己活过来
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.config.tickMs)
    this.game.startPolling?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.game.stopPolling?.()
  }

  /**
   * 装载快树。`tree` 可以是编写格式或执行格式；校验失败抛错，旧快树保持不变。
   * 快树正在情节里时不换（P3 §8.3）：排队，等情节结束后的下一个 tick 换上。
   * @param {object} [options.meta]  记进 fast/loaded 的来源（by / batchId）
   * @returns {object} 执行格式的快树
   */
  loadFastTree(tree, { version = 1, meta = null } = {}) {
    const { spec, check } = this.prepare(tree, { kind: 'fast', rootId: 'f' })
    if (!check.ok) throw new TreeError('fast tree is invalid', check.errors)
    const root = this.build(spec).root
    if (this.episode) {
      this.nextFast = { spec, root, version, meta }
      this.log(null, { event: 'fast/load-deferred', version, episode: this.episode.name })
    } else {
      this.installFast({ spec, root, version, meta })
    }
    return spec
  }

  installFast({ spec, root, version, meta }) {
    this.nextFast = null
    this.fast = { spec, root, version }
    this.refreshPollSources()
    this.log(null, { event: 'fast/loaded', version, arms: spec.arms.map((arm) => arm.then.name ?? arm.then.id), ...(meta ?? {}) })
  }

  /** 开始一个任务（任务串行，D12）。返回 taskId。 */
  startTask({ tree, goal = null, taskId = null, blackboard = {} }) {
    if (this.task && ['running', 'suspended', 'paused'].includes(this.task.state)) {
      throw new Error(`task ${this.task.taskId} is still ${this.task.state}; abort it first`)
    }
    const { spec, check } = this.prepare(tree, { kind: 'task', rootId: 'n1', initialKeys: Object.keys(blackboard) })
    if (!check.ok) throw new TreeError('task tree is invalid', check.errors)

    const id = taskId ?? this.newTaskId()
    const built = this.build(spec)
    this.task = {
      taskId: id,
      goal,
      state: 'running',
      spec,
      root: built.root,
      byId: built.byId,
      version: 1,
      blackboard: new Blackboard({ maxValueBytes: this.config.maxValueBytes, initial: blackboard }),
      pending: null,
      retriedLeaf: null,
      expansionNode: null,
      lastObservation: null,
      snapshots: new SnapshotBuffer({ keep: this.config.snapshotKeep }),
      events: [],
      queries: new Map(),  // 查询节点 id → 最近一次读到的数据源版本（P2-D17）
      versionRows: [],     // 最近一次比较的结果（过期被拒时的目录用）
      versions: [],        // 树版本链（P4 §3.3）：[{ version, origin, at, spec }]
      startedAt: this.now(),
      result: null
    }
    this.recordVersion(this.task, 'outline')
    this.refreshPollSources()
    this.log(id, { event: 'task/start', goal, nodes: check.nodeCount })
    this.emit('task', this.taskSummary())
    return id
  }

  /** 新任务 id。规划请求在大纲交回之前就要用它（任务级查询快照、代码草稿目录）。 */
  newTaskId() {
    return `task-${new Date(this.now()).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${++this.taskSeq}`
  }

  pauseTask() {
    const task = this.requireTask(['running', 'suspended'])
    this.interruptTask('pause')
    this.releaseControls(task.taskId)
    task.stateBeforePause = task.state
    this.setState('paused')
  }

  resumeTask() {
    const task = this.requireTask(['paused'])
    this.setState(task.stateBeforePause ?? 'running')
  }

  /**
   * 放弃当前任务：默认中止流程，任务进 failed。
   * @param {object} [options]
   * @param {'user'|'agent'|'session'|'executor'} [options.by='user']  谁放弃的（P4 §2.1：人放弃的不复盘）
   */
  abortTask(reason = 'aborted', { by = 'user' } = {}) {
    this.requireTask(['running', 'suspended', 'paused'])
    this.interruptTask('abort')
    this.finishTask('failed', reason, { by })
  }

  // ── tick ─────────────────────────────────────────────────────────────────

  tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      if (this.dying || this.checkDeath()) return
      if (this.nextFast && !this.episode) this.installFast(this.nextFast)
      if (this.fast) this.tickFast()
      const task = this.task
      if (task && task.state === 'running' && !this.episode) this.tickTask(task)
    } catch (error) {
      this.log(this.task?.taskId ?? null, { event: 'executor/error', error: error.stack ?? String(error) })
      this.emit('error', error)
    } finally {
      this.ticking = false
      // 快树事件流在每个 tick 末尾看一眼轮询到的 player（P3 §3）
      this.emit('tick')
    }
  }

  tickFast() {
    const root = this.fast.root
    const ctx = this.context(null)
    if (!this.episode) {
      const arm = root.select(ctx)
      if (arm === -1) {
        root.tickArm(-1, ctx)
        return
      }
      this.beginEpisode(arm)
      return
    }
    if (this.episode.phase !== 'running') return
    // 情节必须能结束（P3 §7.3）：超时按 FAILURE 收场，否则慢树会一直被挂着
    if (this.now() - this.episode.startedAt > this.config.fastMaxEpisodeMs) {
      root.branch(this.episode.arm).abort(ctx)
      this.releaseKeys(this.task?.taskId ?? null)
      this.endEpisode(FAILURE, 'timeout', `episode ran longer than ${this.config.fastMaxEpisodeMs} ms`)
      return
    }
    const status = root.tickArm(this.episode.arm, ctx)
    if (!isTerminal(status)) return
    this.endEpisode(status)
  }

  beginEpisode(arm) {
    const name = this.fast.spec.arms[arm].then.name ?? this.fast.spec.arms[arm].then.id
    const episode = { arm, name, phase: 'preempting', startedAt: this.now(), before: this.game.cachedAll(), interrupted: null }
    this.episode = episode
    const task = this.task
    if (task && task.state === 'running') {
      episode.interrupted = this.interruptTask('preempt')
      // 抢占要快，来不及现场读：中断时的状态只有快树缓存里有的部分（P2 §4.3）
      if (episode.interrupted) task.snapshots.moment('interrupt', episode.before, this.now())
    }
    this.logFast({ event: 'fast/episode-start', arm, name, taskId: task?.taskId ?? null, interrupted: episode.interrupted?.id ?? null })
    // 先中止、后跑快树：松键与快树自己的按键不能交错
    this.releaseControls(task?.taskId ?? null).then(() => {
      if (this.episode === episode) episode.phase = 'running'
    })
  }

  endEpisode(status, reason = null, error = null) {
    const episode = this.episode
    this.episode = null
    const after = this.game.cachedAll()
    const armError = status === FAILURE ? error ?? findFailedLeaf(this.fast.root.arms[episode.arm].then).lastError ?? null : null
    this.logFast({
      event: 'fast/episode-end', arm: episode.arm, name: episode.name, status, reason, error: armError ?? undefined,
      durationMs: this.now() - episode.startedAt, before: episode.before, after,
      taskId: this.task?.taskId ?? null, fastVersion: this.fast?.version ?? null
    })
    const task = this.task
    if (!task || status === null || !ACTIVE_STATES.includes(task.state)) return
    const evidence = {
      fastArm: episode.name,
      interrupted: episode.interrupted,
      armError,
      before: episode.before,
      after
    }
    // 过期规则（P2 §5，2026-10-25 改为方案 A）：任务挂起期间的快树情节**不让任何请求过期**。
    // 挂起时没有叶子在跑，情节打断不了什么；证据由大模型用 bt_inspect 按需取，要最新状态随时 live。
    // 原规则在反射处理不了的持续危险里（溺水反射只会原地上浮）会让修复请求一直过期、永远交不上（首测：6 分钟 58 次情节）。
    // 补丁生效后局面若仍危险，快树会再打断、发新的 recover，自然纠正
    if (task.pending) {
      this.log(task.taskId, { event: 'request/not-stale', requestId: task.pending.requestId, cause: status === SUCCESS ? 'recover' : 'escalate' })
      return
    }
    if (!episode.interrupted) return
    // 情节结束后现场读全，存成 episode-end 快照（缓存里通常只有快树轮询的 player）
    const gather = this.game.read(ALL_STATE_SOURCES).then(
      (state) => { task.snapshots.moment('episode-end', state, this.now()) },
      (error) => this.log(task.taskId, { event: 'snapshot/failed', name: 'episode-end', error: error.message })
    )
    this.request(task, status === SUCCESS ? 'recover' : 'escalate', evidence, gather)
  }

  tickTask(task) {
    task.expansionNode = null
    const abortsBefore = this.pendingAborts.length
    const status = task.root.tick(this.context(task))
    // 树自己中止了叶子（reactive 复查不成立、Timeout……）：被作废的 Steps 后面的松键不会再执行
    if (this.pendingAborts.length > abortsBefore) this.releaseKeys(task.taskId)
    if (status === NEEDS_EXPANSION) {
      const node = task.expansionNode
      this.request(task, 'expand', { nodeId: node.id, goal: node.spec.goal })
      return
    }
    if (status === SUCCESS) {
      this.finishTask('done', 'root SUCCESS')
      return
    }
    if (status !== FAILURE) return

    const leaf = findFailedLeaf(task.root)
    if (leaf && task.retriedLeaf !== leaf.id && task.root.reopenFailure()) {
      // §7.5 ①：同一个失败叶子只原地重试一次，覆盖瞬态失败
      task.retriedLeaf = leaf.id
      this.log(task.taskId, { event: 'task/retry', nodeId: leaf.id, error: leaf.lastError })
      return
    }
    // 等大模型期间不能一直按着键（失败的 Steps 可能停在按下之后）；不关容器：原地再来时可能还要用
    this.releaseKeys(task.taskId)
    this.request(task, 'failed', {
      nodeId: leaf?.id ?? null, name: leaf?.name ?? null, error: leaf?.lastError ?? null, type: leaf?.type ?? null,
      observed: task.lastObservation
    })
  }

  // ── 死亡与重生（P2 实施细则 §8）──────────────────────────────────────────

  /** 轮询到的 player 显示已死亡 → 开始处理（有任务走 §8.3，没任务只重生，P3 §2.4）。@returns 这个 tick 是否到此为止 */
  checkDeath() {
    const player = this.game.cached(['player'])?.player
    if (!player || !isDead(player)) {
      this.stuckDead = false
      return false
    }
    if (this.stuckDead) return true
    const task = this.task
    if (task && ACTIVE_STATES.includes(task.state)) this.handleDeath(task, player)
    else this.handleIdleDeath(player)
    return true
  }

  /** 没有任务时死亡：记下来（快树事件流据此记 death 事件）、松键、自动重生。重生失败就等它自己活过来。 */
  async handleIdleDeath(player) {
    this.dying = true
    if (this.episode) this.endEpisode(null, 'death')
    this.log(null, { event: 'player/died', deathMessage: player.deathMessage ?? null, nodeId: null })
    try {
      await this.releaseControls(null)
      await this.respawn()
      this.log(null, { event: 'player/respawned' })
    } catch (error) {
      this.stuckDead = true
      this.log(null, { event: 'player/respawn-failed', error: error.message })
    } finally {
      this.dying = false
    }
  }

  /**
   * 死亡：记下死前状态（缓存——死后背包已掉落，读不到了）→ 中止任务树、默认中止流程 → 自动重生 →
   * 读重生后的状态 → 发 died 请求。在飞请求期间死亡 → 让它过期、附 died 证据（§5）。重生失败 → 任务失败。
   */
  async handleDeath(task, player) {
    this.dying = true
    const deathMessage = player.deathMessage ?? null
    const before = this.game.cachedAll()
    if (this.episode) this.endEpisode(null, 'death')
    const interrupted = task.state === 'running' ? this.interruptTask('death') : null
    task.snapshots.moment('death', before, this.now())
    this.log(task.taskId, { event: 'player/died', deathMessage, nodeId: interrupted?.id ?? null })
    const stale = task.state === 'suspended' && task.pending
    if (!stale) this.setState('suspended')

    try {
      await this.releaseControls(task.taskId)
      const after = await this.respawn()
      task.snapshots.moment('respawn', after, this.now())
      this.log(task.taskId, { event: 'player/respawned' })
    } catch (error) {
      this.dying = false
      if (this.task === task && ACTIVE_STATES.includes(task.state)) {
        task.pending = null
        this.finishTask('failed', `died and could not respawn: ${error.message}`)
      }
      return
    }
    this.dying = false
    // 处理期间任务被放弃了
    if (this.task !== task || !ACTIVE_STATES.includes(task.state)) return
    const evidence = { deathMessage, interrupted }
    if (stale && task.pending) {
      this.markStale(task, { event: 'died', ...evidence })
      return
    }
    this.request(task, 'died', evidence)
  }

  /** 调 player/respawn，轮询到没死且生命值回满。@returns 重生后现场读全的状态 */
  async respawn() {
    const res = await this.game.mod.call('player/respawn', {})
    if (!res.ok) throw new Error(`player/respawn: ${res.error}`)
    const deadline = this.now() + this.config.respawnTimeoutMs
    for (;;) {
      const state = await this.game.read(ALL_STATE_SOURCES)
      const vitals = state.player?.vitals
      if (!isDead(state.player) && Number(vitals?.health) >= Number(vitals?.maxHealth)) return state
      if (this.now() > deadline) throw new Error(`still dead or not at full health after ${this.config.respawnTimeoutMs} ms`)
      await new Promise((resolve) => setTimeout(resolve, this.config.respawnPollMs))
    }
  }

  /** 任务树正在跑的叶子 id（快树事件的背景，P3 §3.3）；没有任务或没在跑 → null。 */
  runningLeafId() {
    const task = this.task
    if (!task || task.state !== 'running') return null
    return findRunningLeaf(task.root)?.id ?? null
  }

  /** 中止任务树的活跃路径，返回被中断的最小任务（正在跑的叶子）。 */
  interruptTask(reason) {
    const task = this.task
    const leaf = findRunningLeaf(task.root)
    const interrupted = leaf ? { id: leaf.id, type: leaf.type, name: leaf.name, spec: leaf.spec } : null
    task.root.abort(this.context(task))
    this.log(task.taskId, { event: 'task/interrupted', reason, nodeId: interrupted?.id ?? null })
    return interrupted
  }

  /** 默认中止流程：先等被作废的在飞调用落地，再松键、关容器。 */
  releaseControls(taskId) {
    return this.drainAborts()
      .then(() => this.game.abortDefault())
      .then(
        (summary) => this.log(taskId, { event: 'controls/released', ...summary }),
        (error) => this.log(taskId, { event: 'controls/release-failed', error: error.message })
      )
  }

  /** 只松键（树内部的中止、发 failed 请求前）：先等被作废的在飞调用落地，免得迟到的按下盖掉松开。 */
  releaseKeys(taskId) {
    return this.drainAborts()
      .then(() => this.game.releaseKeys())
      .then(
        (released) => this.log(taskId, { event: 'controls/keys-released', released }),
        (error) => this.log(taskId, { event: 'controls/release-failed', error: error.message })
      )
  }

  async drainAborts() {
    const pending = this.pendingAborts.splice(0)
    if (pending.length === 0) return
    await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, 2000))])
  }

  context(task) {
    return {
      registry: this.registry,
      game: this.game,
      taskId: task?.taskId ?? null,
      blackboard: task ? task.blackboard : EMPTY_BLACKBOARD,
      observe: task && this.config.observe.enabled ? this.config.observe : null,
      onQuery: task ? (query) => {
        task.queries.set(query.nodeId, query)
        this.log(task.taskId, { event: 'query/version', id: query.nodeId, source: query.source, version: query.version })
      } : undefined,
      onSnapshot: task ? (node, phase, state) => {
        if (phase === 'before') task.snapshots.leafBefore(node.id, state, this.now())
        else task.snapshots.leafAfter(node.id, state, this.now())
      } : undefined,
      onObserve: task ? (node, diff) => {
        task.lastObservation = { nodeId: node.id, diff }
        this.log(task.taskId, { event: 'observe', id: node.id, diff })
      } : undefined,
      now: this.now,
      // 任务树 reactive 序列缺省的复查间隔；快树没有（每 tick 重跑，读缓存）
      reactiveEveryMs: task ? this.config.reactiveEveryMs : undefined,
      trackAbort: (promise) => this.pendingAborts.push(promise),
      requestExpansion: task ? (node) => { task.expansionNode = node } : undefined,
      onNode: task ? (node, phase, status) => this.log(task.taskId, {
        event: 'node', phase, id: node.id, type: node.type, name: node.name ?? undefined,
        status, error: phase === 'exit' && status === FAILURE ? node.lastError ?? undefined : undefined
      }) : undefined
    }
  }

  // ── 请求与回答 ───────────────────────────────────────────────────────────

  /**
   * 挂起任务、发请求。修复类请求附目录（P2 §4.2）。
   * `gather`：发请求前还要等的现场读取（情节结束的快照）；请求立即生效（在飞期间的新事件照常让它过期），
   * 读完才发 'request' 事件，目录里才有那份快照。
   */
  request(task, type, evidence, gather = null) {
    const requestId = `r${++this.requestSeq}`
    task.pending = { requestId, type, createdAt: this.now(), evidence, stale: false, staleEvents: [], invalidAttempts: 0 }
    this.setState('suspended')
    this.log(task.taskId, { event: 'request', requestId, type, evidence: summarizeEvidence(evidence) })
    const emit = () => {
      if (this.task !== task || task.pending?.requestId !== requestId) return
      this.emit('request', {
        taskId: task.taskId, requestId, type, evidence, tree: task.spec, blackboard: task.blackboard.snapshot(),
        directory: PATCH_REQUESTS.includes(type) ? this.directory(task) : null
      })
    }
    if (!PATCH_REQUESTS.includes(type)) {
      if (gather) gather.then(emit)
      else emit()
      return
    }
    // 修复请求：目录里要列出记忆来源的换代，先探一遍当前版本（只 stat）
    Promise.all([gather, this.probeVersions(task)]).then(emit, emit)
  }

  /**
   * 本任务执行过的查询节点：读到的版本 vs 当前版本（P2-D17）。只比版本戳，不比内容、不归因。
   * @returns {Promise<Array<{ nodeId, ref, source, read, now, changed }>>}
   */
  async probeVersions(task) {
    const rows = await Promise.all([...task.queries.values()].map(async (q) => {
      let now = null
      try {
        now = await q.probe()
      } catch {
        // 数据源暂时读不到：当前版本未知
      }
      return { nodeId: q.nodeId, ref: q.ref, source: q.source, read: q.version, now, changed: now !== null && now !== q.version }
    }))
    task.versionRows = rows
    return rows
  }

  /** 在飞修复请求的目录（P2 §4.2）。 */
  directory(task = this.task) {
    if (!task?.pending || !PATCH_REQUESTS.includes(task.pending.type)) return null
    return buildDirectory(task, task.pending, { path: (id) => this.nodePath(task, id), versions: task.versionRows })
  }

  /** 根 → 节点的 { id, name } 链。 */
  nodePath(task, id) {
    const target = task.byId.get(id)
    if (!target) return []
    const chain = [target]
    for (let parent = findParent(task.root, target); parent; parent = findParent(task.root, parent)) chain.unshift(parent)
    return chain.map((node) => ({ id: node.id, name: node.name }))
  }

  /**
   * bt_inspect（P2 §4.4）：任务的事件、快照、节点、条件求值、黑板、现场状态、树版本链。
   * @param {object} [options]  { task: 要看的任务对象（复盘看已结束的那个，缺省 = 当前任务）, reflect: 复盘回合（不给 live，P4 §3.2） }
   */
  async inspect(args, { task = this.task, reflect = false } = {}) {
    if (!task) return { ok: false, error: 'no task' }
    if (reflect && args?.what === 'live') return { ok: false, error: 'live is not available while reviewing a finished task: the world now has nothing to do with that task; use the snapshots taken during it' }
    if (reflect && args?.what === 'eval' && args.at === undefined) return { ok: false, error: 'while reviewing a finished task, eval needs at: a snapshot taken during the task (the state now has nothing to do with it)' }
    return inspect(task, args, {
      game: this.game,
      now: this.now,
      context: () => this.context(task),
      versions: () => this.probeVersions(task),
      nodeEnters: (id) => task.events.filter((e) => e.event === 'node' && e.phase === 'enter' && e.id === id).length
    })
  }

  markStale(task, event) {
    task.pending.stale = true
    task.pending.staleEvents.push(event)
    this.log(task.taskId, { event: 'request/stale', requestId: task.pending.requestId, cause: event.event })
  }

  /** 过期检查：过期 → 拒绝并交出新证据（不计入不合法次数）。 */
  checkPending(requestId, types) {
    const task = this.task
    const pending = task?.pending
    if (!pending || pending.requestId !== requestId) return { ok: false, error: `no pending request ${requestId}` }
    if (!types.includes(pending.type)) return { ok: false, error: `request ${requestId} is a ${pending.type} request` }
    if (pending.stale) {
      const events = pending.staleEvents.splice(0)
      pending.stale = false
      this.log(task.taskId, { event: 'request/rejected-stale', requestId })
      return { ok: false, stale: true, error: '世界已变化，请基于新证据重做', events: events.map(summarizeEvidence), directory: this.directory(task) }
    }
    return { ok: true, task, pending }
  }

  /**
   * 放弃：任何在飞请求都可以用 { action: 'abort', reason } 回答，任务进 failed。
   * 原树继续不再单独存在，是空补丁（submitPatch(requestId, [])，P2 §2）。
   */
  answerRequest(requestId, answer) {
    const check = this.checkPending(requestId, [...PATCH_REQUESTS, 'expand'])
    if (!check.ok) return check
    const { task, pending } = check
    if (answer.action === 'abort') {
      this.log(task.taskId, { event: 'request/answered', requestId, action: 'abort', reason: answer.reason })
      task.pending = null
      this.finishTask('failed', answer.reason ?? `abandoned at ${pending.type} request`)
      return { ok: true }
    }
    return { ok: false, error: `unknown answer action "${answer.action}"; to continue the tree as it is, submit an empty patch` }
  }

  /**
   * 回答 recover / escalate / failed / died 请求：补丁（P2 §3）。`ops: []` = 原树继续。
   * 不合法 → 错误原文，计一次不合法尝试（与展开相同）。
   * 合法 → 施加到运行中的树上，版本 +1；failed 请求另对失败路径 reopenFailure，否则根一直停在 FAILURE（§3.4）。
   */
  submitPatch(requestId, ops) {
    const check = this.checkPending(requestId, PATCH_REQUESTS)
    if (!check.ok) return check
    const { task, pending } = check

    const version = task.version + 1
    const initialKeys = [...writtenKeys(task.spec, this.capsules?.library), ...Object.keys(task.blackboard.snapshot())]
    let plan
    try {
      plan = planPatch({
        spec: task.spec, root: task.root, ops, version,
        compile: (node, rootId) => this.prepare(node, { kind: 'task', rootId, initialKeys }),
        maxNodes: this.config.maxExpansionNodes,
        origin: { request: requestId, type: pending.type }
      })
      if (plan.errors.length === 0) {
        plan.errors = validateTree(plan.spec, {
          registry: this.registry, library: this.capsules?.library ?? null, kind: 'task',
          initialKeys: Object.keys(task.blackboard.snapshot())
        }).errors
      }
    } catch (error) {
      plan = { errors: [error.message] }
    }
    if (plan.errors.length > 0) return { ok: false, errors: plan.errors, ...this.recordInvalidAttempt(requestId, plan.errors) }

    this.applyPatchSteps(task, plan.steps)
    task.spec = plan.spec
    task.version = version
    task.pending = null
    if (pending.type === 'failed') {
      task.root.reopenFailure()
      task.retriedLeaf = null
    }
    this.recordVersion(task, `patch ${pending.type} @ ${pending.evidence?.nodeId ?? pending.evidence?.interrupted?.id ?? '?'}`)
    this.refreshPollSources()
    this.log(task.taskId, {
      event: 'patch/applied', requestId, type: pending.type, version,
      ops: plan.steps.map((step) => ({ op: step.op, id: step.id, newId: step.spec?.id })), ids: plan.ids
    })
    this.setState('running')
    return { ok: true, version, ids: plan.ids }
  }

  /** 把 planPatch 规划好的操作施加到运行中的树上（规划时已在副本上验证过，这里不再检查）。 */
  applyPatchSteps(task, steps) {
    const drop = (node) => {
      task.byId.delete(node.id)
      for (const kid of node.children()) drop(kid)
      if (node.expect) drop(node.expect)
    }
    for (const step of steps) {
      const built = step.spec ? this.build(step.spec) : null
      if (step.op === 'replace' || step.op === 'remove') {
        const old = task.byId.get(step.id)
        const parent = findParent(task.root, old)
        old.reset()
        drop(old)
        if (step.op === 'remove') parent.removeChild(old)
        else if (parent) parent.replaceChild(old, built.root)
        else task.root = built.root
      } else {
        const parent = task.byId.get(step.parentId)
        const anchor = task.byId.get(step.op === 'insert-after' ? step.afterId : step.id)
        parent.insertChild(parent.kids.indexOf(anchor) + (step.op === 'insert-after' ? 1 : 0), built.root)
      }
      if (built) for (const [id, node] of built.byId) task.byId.set(id, node)
    }
  }

  /**
   * 回答 expand 请求：编译 + 校验 + 换下 PendingExpansion（§4.2）。
   * 不合法 → 返回错误原文；同一请求第 maxInvalidAttempts 次不合法 → 任务失败（§4.3）。
   */
  submitExpansion(requestId, subtree) {
    const check = this.checkPending(requestId, ['expand'])
    if (!check.ok) return check
    const { task, pending } = check
    const nodeId = pending.evidence.nodeId

    let spec
    let errors = []
    try {
      const prepared = this.prepare(subtree, {
        kind: 'task', rootId: `${nodeId}.1`, maxNodes: this.config.maxExpansionNodes,
        initialKeys: [...writtenKeys(task.spec, this.capsules?.library), ...Object.keys(task.blackboard.snapshot())]
      })
      spec = prepared.spec
      errors = prepared.check.errors
      if (errors.length === 0) {
        const merged = replaceSpec(task.spec, nodeId, spec)
        errors = validateTree(merged, {
          registry: this.registry, library: this.capsules?.library ?? null, kind: 'task',
          initialKeys: Object.keys(task.blackboard.snapshot())
        }).errors
      }
    } catch (error) {
      errors = [error.message]
    }

    if (errors.length > 0) return { ok: false, errors, ...this.recordInvalidAttempt(requestId, errors) }

    const oldNode = task.byId.get(nodeId)
    const parent = findParent(task.root, oldNode)
    const built = this.build(spec)
    if (parent) parent.replaceChild(oldNode, built.root)
    else task.root = built.root
    task.byId.delete(nodeId)
    for (const [id, node] of built.byId) task.byId.set(id, node)
    task.spec = replaceSpec(task.spec, nodeId, spec)
    task.version++
    task.pending = null
    this.recordVersion(task, `expand ${nodeId}`)
    this.refreshPollSources()
    this.log(task.taskId, { event: 'expansion/applied', requestId, nodeId, version: task.version, ids: [...built.byId.keys()] })
    this.setState('running')
    return { ok: true, version: task.version, ids: [...built.byId.keys()] }
  }

  /**
   * 给在飞的请求记一次不合法尝试：交回的子树 / 补丁不合法、代码草稿不合法，
   * 或回合结束了却没有提交（I5 的提醒）。第 maxInvalidAttempts 次 → 任务失败（§4.3）。
   * @param {string} requestId
   * @param {string[]} errors  记进事件日志的原因
   * @returns {{ attemptsLeft: number, taskFailed?: true }}
   */
  recordInvalidAttempt(requestId, errors) {
    const task = this.task
    const pending = task?.pending
    if (!pending || pending.requestId !== requestId) return { attemptsLeft: 0, error: `no pending request ${requestId}` }
    pending.invalidAttempts++
    const expand = pending.type === 'expand'
    this.log(task.taskId, { event: expand ? 'expansion/invalid' : 'patch/invalid', requestId, attempt: pending.invalidAttempts, errors })
    if (pending.invalidAttempts >= this.config.maxInvalidAttempts) {
      task.pending = null
      this.finishTask('failed', expand
        ? `expansion of ${pending.evidence.nodeId} was invalid ${pending.invalidAttempts} times`
        : `${pending.type} request ${requestId} got no valid answer in ${pending.invalidAttempts} attempts`)
      return { attemptsLeft: 0, taskFailed: true }
    }
    return { attemptsLeft: this.config.maxInvalidAttempts - pending.invalidAttempts }
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  /** 编译 → 钉住胶囊引用 → 校验。编译错误与钉不上的引用都进 check.errors（交给校验—修正循环）。 */
  prepare(tree, { kind, rootId, initialKeys = [], maxNodes }) {
    let compiled
    try {
      compiled = compileTree(tree, { kind, rootId })
    } catch (error) {
      return { spec: null, check: { ok: false, errors: [error.message], nodeCount: 0 } }
    }
    const library = this.capsules?.library ?? null
    const pinned = pinRefs(compiled, library)
    if (pinned.errors.length) return { spec: pinned.spec, check: { ok: false, errors: pinned.errors, nodeCount: 0 } }
    const check = validateTree(pinned.spec, { registry: this.registry, library, kind, initialKeys, maxNodes })
    return { spec: pinned.spec, check }
  }

  build(spec) {
    return buildTree(spec, { registry: this.registry, capsules: this.capsules })
  }

  /**
   * 任务结束。失败时走默认中止流程——失败的 Steps 可能还按着键。
   * by：done 是 'tree'（根 SUCCESS）；failed 是 'user' / 'agent' / 'session' / 'executor'（P4 §2.1）
   */
  finishTask(state, reason, { by = state === 'done' ? 'tree' : 'executor' } = {}) {
    const task = this.task
    if (state === 'failed') this.releaseControls(task.taskId)
    // 任务结束 = 没有在飞请求了（/bt abort 等路径不经过回答请求，不清的话 bt_view 会把死请求当成还在等）
    task.pending = null
    task.state = state
    task.result = reason
    task.finishedBy = by
    task.finishedAt = this.now()
    this.log(task.taskId, { event: `task/${state}`, reason, by, durationMs: task.finishedAt - task.startedAt })
    this.refreshPollSources()
    this.emit('task', this.taskSummary())
  }

  /** 树的新版本：落盘，同时留在任务对象里（runtimeDir 为 null 时复盘也看得到版本链）。 */
  recordVersion(task, origin) {
    task.versions.push({ version: task.version, origin, at: this.now(), spec: task.spec })
    this.eventLog.writeTreeVersion(task.taskId, task.version, task.spec)
  }

  setState(state) {
    this.task.state = state
    this.emit('task', this.taskSummary())
  }

  requireTask(states) {
    if (!this.task || !states.includes(this.task.state)) {
      throw new Error(this.task ? `task ${this.task.taskId} is ${this.task.state}` : 'no task')
    }
    return this.task
  }

  /** 轮询集合 = 快树与任务树里所有 Match.when 用到的来源（集成方案 §3.3）+ 一直轮询的 player（受伤与死亡，P3 §2.1）。 */
  refreshPollSources() {
    const sources = new Set(['player'])
    for (const spec of [this.fast?.spec, this.task?.spec]) {
      if (!spec) continue
      walkSpec(spec, (node) => {
        if (node.type !== 'Match') return
        for (const arm of node.arms) {
          const read = arm.when.ref ? arm.when.read ?? [] : this.registry.get(arm.when.cmd)?.sources ?? []
          for (const s of read) sources.add(s)
        }
      })
    }
    this.game.setPollSources?.(sources)
  }

  log(taskId, event) {
    // 值为 undefined 的字段去掉：落盘的 JSON 本来就没有它们，内存里那份（bt_inspect 的 events）也要一致——
    // DSH 要求工具输出是无损 JSON，带 undefined 的对象会被判 INVALID_TOOL_OUTPUT
    const record = this.eventLog.append(taskId, withoutUndefined(event))
    // 本任务的事件留一份在内存里，bt_inspect 的 events 从这里过滤（任务结束随任务记录一起丢弃）
    if (taskId && this.task?.taskId === taskId && this.task.events) {
      this.task.events.push(record)
      if (this.task.events.length > MAX_TASK_EVENTS) this.task.events.shift()
    }
    this.emit('event', record)
    return record
  }

  logFast(event) {
    const record = this.eventLog.append(null, withoutUndefined(event))
    this.emit('event', record)
  }

  taskSummary() {
    const task = this.task
    if (!task) return null
    return {
      taskId: task.taskId, goal: task.goal, state: task.state, version: task.version,
      pending: task.pending ? { requestId: task.pending.requestId, type: task.pending.type, stale: task.pending.stale } : null,
      result: task.result,
      ...(task.finishedBy ? { by: task.finishedBy, durationMs: task.finishedAt - task.startedAt } : {})
    }
  }

  /** 内省快照（G1 / bt_view）：任务摘要、按 id 的扁平节点表、黑板、快树情节。 */
  snapshot() {
    const task = this.task
    return {
      task: task ? {
        ...this.taskSummary(),
        blackboard: task.blackboard.snapshot(),
        nodes: [...task.byId.values()].map((node) => node.describe())
      } : null,
      fast: this.fast ? {
        version: this.fast.version,
        next: this.nextFast?.version ?? null,
        arms: this.fast.spec.arms.map((arm) => arm.then.name ?? arm.then.id),
        episode: this.episode ? { arm: this.episode.arm, name: this.episode.name, phase: this.episode.phase } : null
      } : null
    }
  }
}

export class TreeError extends Error {
  constructor(message, errors) {
    super(`${message}:\n  ${errors.join('\n  ')}`)
    this.name = 'TreeError'
    this.errors = errors
  }
}

const EMPTY_BLACKBOARD = new Blackboard()
const ACTIVE_STATES = ['running', 'suspended', 'paused']

function withoutUndefined(event) {
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined))
}

/** 死亡判据：mod 的 dead 字段；mod 未升级（没有这个字段）时退化为生命值 ≤ 0。 */
function isDead(player) {
  if (!player) return false
  if (typeof player.dead === 'boolean') return player.dead
  return Number(player.vitals?.health) <= 0
}
const MAX_TASK_EVENTS = 5000

/** 用补丁回答的请求（P2 §2）。died 在 P2e 接上。 */
const PATCH_REQUESTS = ['recover', 'escalate', 'failed', 'died']

function findRunningLeaf(node) {
  const kids = node.children()
  if (kids.length === 0) return node.lastStatus === RUNNING ? node : null
  for (const kid of kids) {
    if (kid.lastStatus === RUNNING || kid.lastStatus === NEEDS_EXPANSION) {
      const leaf = findRunningLeaf(kid)
      if (leaf) return leaf
    }
  }
  return null
}

function findFailedLeaf(node) {
  const failed = node.children().filter((kid) => kid.lastStatus === FAILURE).pop()
  return failed ? findFailedLeaf(failed) : node
}

function findParent(root, target) {
  for (const kid of root.children()) {
    if (kid === target) return root
    const found = findParent(kid, target)
    if (found) return found
  }
  return null
}

/** 树里所有可能写黑板的键（展开时，新子树可以读树里别处写的键）。 */
function writtenKeys(spec, library) {
  const keys = []
  walkSpec(spec, (node) => {
    if (node.writes) keys.push(...Object.keys(node.writes))
    if (node.type === 'ForEach') keys.push(node.as, ...(node.indexAs ? [node.indexAs] : []))
    if ((node.type === 'Compute' && !node.writes) || node.type === 'SubTree') {
      const entry = library?.tryGet(node.ref)
      keys.push(...Object.keys(entry?.signature.outputs ?? {}))
    }
  })
  return keys
}

function summarizeEvidence(evidence) {
  const out = { ...evidence }
  delete out.before
  delete out.after
  if (out.interrupted) out.interrupted = { id: out.interrupted.id, type: out.interrupted.type }
  return out
}
