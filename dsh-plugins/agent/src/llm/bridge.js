import path from 'node:path'
import { TreeError } from '../bt/executor.js'
import { renderTree, ancestorsOf } from '../bt/overview.js'
import { renderDirectory, buildReflectDirectory, renderReflectDirectory } from '../bt/evidence.js'
import { saveCapsule, saveDraft } from '../capsules/save.js'
import { collectEvidence, checkLiterals } from '../capsules/literals.js'
import { walkSpec } from '../bt/build.js'
import { libraryRows, renderLibrary, checkReason, appendCurateLog } from '../capsules/curate.js'
import { renderTemplate } from './prompts.js'

/**
 * 执行器 ↔ 大模型会话的桥（集成方案 §4）。零 DSH 依赖：会话只通过注入的 deliver / notify 触达。
 *
 * 请求：
 *   plan    新任务：人下指令（/bt task 或路由 task handler）→ 大模型写大纲 → bt_submit_tree
 *   expand  任务树到达 PendingExpansion → 执行器挂起 → followup 叫醒大模型 → bt_submit_expansion
 *   recover / escalate / failed / died（P2）  被快树打断 / 根失败 / 死亡并已重生 → 执行器挂起 → 消息只推目录（P2 §4.2），
 *           证据由大模型用 bt_inspect 自己取 → bt_submit_patch（空补丁 = 原树继续）或 bt_abort_task
 *   reflect（P4）  任务结束 → 复盘：capsule_save（可多次）→ bt_reflect_done。不是执行器的请求、不挡新任务：
 *           请求自己持有结束的任务对象和草稿的拷贝，新任务换掉 executor.task 也不影响（P4 §2.3 / §2.4）
 *   curate（整理方案 §5）  胶囊库整理：/bt curate，或每结束 curate.everyTasks 个任务自动发（默认 0 = 只能手动）。
 *           只在空闲时发；给全库清单 → capsule_retire / capsule_describe（可多次）→ bt_curate_done。不属于任何任务
 * 不属于任何会话的任务（/bt run 的手写树）的修复请求不经过这里，由本地应答器回答（ownsTask）。
 *
 * - 一个请求对应一个会话：plan 属于下指令的会话，任务属于 plan 所在的会话（§7.2）
 * - 回合绑定：followup 消息的来源 `{ kind: 'stevex-bt', requestId }` 在该回合第一个 step 被认出；
 *   路由 task handler 在人发起的回合里直接绑定。绑定的回合只准入该请求需要的工具（§5.1.2）
 * - 必须以提交结束回合（I5）：回合要结束时请求仍未回答 → 返回提醒文本（由适配层 steer），算一次不合法尝试
 * - 同一请求第 maxInvalidAttempts 次不合法（含提醒）→ plan 作废 / 任务失败（§4.2）
 * - 代码草稿（I11）：提交工具的 `code` 字段先写进任务草稿区，再编译校验树
 * - 产出树的回合不给数据（I13）：不准入 mod_query / nbt_query / json_query，黑板只给形状不给值——
 *   大模型看不到具体值，就只能用 `$键` 引用、把判断写进树，树才能提取成可复用的胶囊
 *
 * @typedef {{ text: string, summary: string, source: object }} OutgoingMessage
 */
export const SOURCE_KIND = 'stevex-bt'

/**
 * 产出树的请求共用的工具：只有接口知识（I13，§5.1.2；fact_search / mc_source_* 在 P5）。
 * 读状态 / 查记忆 / 查数据（mod_query / nbt_query / json_query）只在普通问答回合可用——树要用到的数据由树自己读。
 */
/**
 * 事实库与 MC 源码（P5-D11）：接口知识，不是此刻的世界状态，进所有回合（含 fact_write：查了源码就要补事实库，§4.4）。
 */
export const FACT_TOOLS = Object.freeze(['fact_search', 'mc_source_search', 'mc_source_read', 'fact_write'])
export const KNOWLEDGE_TOOLS = Object.freeze(['command_docs', 'data_shapes', 'capsule_search', 'capsule_get', ...FACT_TOOLS])
/**
 * 修复请求（P2）：多一个 bt_inspect——能看自己的状态与树自己的执行过程（快照、事件、黑板值、现场读取），
 * 记忆世界的值仍然不给（P2 §4.5）。
 */
const PATCH_TOOLS = Object.freeze([...KNOWLEDGE_TOOLS, 'bt_view', 'bt_inspect', 'bt_submit_patch', 'bt_abort_task'])
export const PATCH_TYPES = Object.freeze(['recover', 'escalate', 'failed', 'died'])
/** 复盘（P4 §3.2）：任务已结束，没有树可改；bt_inspect 不给 live（由执行器拒绝）。 */
const REFLECT_TOOLS = Object.freeze([...KNOWLEDGE_TOOLS, 'bt_view', 'bt_inspect', 'capsule_save', 'bt_reflect_done'])
/** 只在复盘回合可用的工具（guard 据此拒绝其他回合的调用） */
export const REFLECT_ONLY_TOOLS = Object.freeze(['capsule_save', 'bt_reflect_done'])
/** 整理（整理方案 §5.4）：接口知识 + 下架 / 改说明 / 结束。不给 capsule_save：不经任务验证的新代码不进库 */
const CURATE_TOOLS = Object.freeze([...KNOWLEDGE_TOOLS, 'capsule_retire', 'capsule_describe', 'bt_curate_done'])
/** 只在整理回合可用的工具（guard 据此拒绝其他回合的调用） */
export const CURATE_ONLY_TOOLS = Object.freeze(['capsule_retire', 'capsule_describe', 'bt_curate_done'])
export const REQUEST_TOOLS = Object.freeze({
  reflect: REFLECT_TOOLS,
  curate: CURATE_TOOLS,
  plan: Object.freeze([...KNOWLEDGE_TOOLS, 'bt_submit_tree', 'bt_abort_task']),
  expand: Object.freeze([...KNOWLEDGE_TOOLS, 'bt_view', 'bt_submit_expansion', 'bt_abort_task']),
  recover: PATCH_TOOLS,
  escalate: PATCH_TOOLS,
  failed: PATCH_TOOLS,
  died: PATCH_TOOLS
})
const SUBMIT_TOOL = { reflect: 'bt_reflect_done', curate: 'bt_curate_done', plan: 'bt_submit_tree', expand: 'bt_submit_expansion', recover: 'bt_submit_patch', escalate: 'bt_submit_patch', failed: 'bt_submit_patch', died: 'bt_submit_patch' }
/** 修复请求用哪个 skill（集成方案 §4.6）：被打断 → 慢树恢复；根失败 → 慢树反思。 */
const PATCH_SKILL = { recover: 'recover', escalate: 'recover', died: 'recover', failed: 'reflect' }
const ACTIVE = ['running', 'suspended', 'paused']
/** 谁结束的任务不复盘（P4-D1）：人放弃的（可以手动 /bt reflect）、会话没了的 */
const NO_REFLECT_BY = ['user', 'session']

export class Bridge {
  /**
   * @param {object} options
   * @param {import('../bt/executor.js').Executor} options.executor
   * @param {import('../capsules/library.js').CapsuleLibrary} options.library
   * @param {import('../capsules/sandbox.js').Sandbox} options.sandbox
   * @param {object} options.prompts  loadPrompts() 的结果
   * @param {(sessionId: string, message: OutgoingMessage) => boolean} options.deliver  叫醒会话（followup）；找不到会话返回 false
   * @param {(sessionId: string, message: OutgoingMessage) => void} [options.notify]    不叫醒地告知（任务结束）
   * @param {string|null} [options.runtimeDir]  代码草稿落在 <runtimeDir>/tasks/<taskId>/code/
   * @param {number} [options.maxInvalidAttempts=3]
   * @param {(taskId: string) => void} [options.releaseTask]  规划作废时释放查询 API 按任务钉住的快照
   * @param {(sessionId: string, turn: number, tools: string[]) => void} [options.onBind]  回合绑定了请求：适配层据此限制工具
   * @param {object} [options.registry]  命令注册表（capsule_save 的字面量检查查枚举参数）
   * @param {object} [options.reflect]   { enabled, onFailed, literalCheck }（P4 §9）
   * @param {import('../capsules/stats.js').CapsuleStats} [options.stats]  胶囊使用统计（整理清单、自动整理的计数）
   * @param {object} [options.curate]    { everyTasks, listLimit }（整理方案 §5.2 / §5.3）
   * @param {(sessionId, message) => boolean} [options.deliverIdle]  等会话空闲再 followup（自动整理可能在别的回合中途触发）；缺省 = deliver
   */
  constructor({ executor, library, sandbox, prompts, deliver, notify = () => {}, runtimeDir = null, maxInvalidAttempts = 3, releaseTask = () => {}, onBind = () => {}, log = () => {}, now = () => Date.now(), registry = null, reflect = {}, stats = null, curate = {}, deliverIdle = null }) {
    this.executor = executor
    this.library = library
    this.sandbox = sandbox
    this.registry = registry
    this.reflectConfig = { enabled: true, onFailed: true, literalCheck: true, ...reflect }
    this.lastDrafts = null        // 最近结束的任务的草稿拷贝（/bt reflect 手动复盘用）
    this.reflectSeq = 0
    this.stats = stats
    this.curateConfig = { everyTasks: 0, listLimit: 150, ...curate }
    this.curateSeq = 0
    this.curateSession = null    // 最近一个结束的任务所属的会话：自动整理发到这里
    this.prompts = prompts
    this.deliver = deliver
    this.deliverIdle = deliverIdle ?? deliver
    this.notify = notify
    this.runtimeDir = runtimeDir
    this.maxInvalidAttempts = maxInvalidAttempts
    this.releaseTask = releaseTask
    this.onBind = onBind
    this.log = log
    this.now = now
    this.requests = new Map()     // requestId → 请求记录
    this.turns = new Map()        // "sessionId#turn" → requestId
    this.taskSessions = new Map() // taskId → sessionId
    this.planning = null          // 在等大纲的 plan requestId（任务串行：至多一个）
    this.seq = 0
    this.onRequest = this.onRequest.bind(this)
    this.onTask = this.onTask.bind(this)
    executor.on('request', this.onRequest)
    executor.on('task', this.onTask)
  }

  dispose() {
    this.executor.off('request', this.onRequest)
    this.executor.off('task', this.onTask)
  }

  /** 这个任务属于某个会话（它的修复请求交给大模型，本地应答器跳过）。 */
  ownsTask(taskId) {
    return this.taskSessions.has(taskId)
  }

  activeTask() {
    const task = this.executor.task
    return task && ACTIVE.includes(task.state) ? task : null
  }

  /** 查询工具用的任务 id（任务级数据快照）：在跑的任务，或正在规划的那个。 */
  currentTaskId() {
    return this.activeTask()?.taskId ?? (this.planning ? this.requests.get(this.planning).taskId : null)
  }

  // ── 新任务 ───────────────────────────────────────────────────────────────

  /**
   * 开一个规划请求（§6.1）。
   * - `turn` 给了：在人发起的这个回合里规划（路由 task handler），返回要放进本 step 的请求正文
   * - 没给：followup 叫醒会话，规划在一个新回合里进行（/bt task）
   * @returns {{ ok: true, requestId, taskId, text?, tools? } | { ok: false, error: string }}
   */
  startPlanning({ sessionId, instruction, turn = null }) {
    const goal = typeof instruction === 'string' ? instruction.trim() : ''
    if (!goal) return { ok: false, error: '指令是空的' }
    const task = this.activeTask()
    if (task) {
      return { ok: false, error: `当前任务 ${task.taskId}${task.goal ? `（${task.goal}）` : ''}还在 ${task.state}；要开始新任务，先放弃它（/bt abort 或 bt_abort_task）` }
    }
    if (this.planning) {
      const old = this.requests.get(this.planning)
      return { ok: false, error: `规划请求 ${old.requestId}（${old.instruction}）还在等 bt_submit_tree；先提交，或用 bt_abort_task 放弃` }
    }

    const taskId = this.executor.newTaskId()
    const requestId = `p${++this.seq}`
    this.library.beginDrafts(taskId, this.runtimeDir ? path.join(this.runtimeDir, 'tasks', taskId, 'code') : null)
    const req = { requestId, type: 'plan', taskId, sessionId, instruction: goal, invalidAttempts: 0, answered: false, closed: false, createdAt: this.now() }
    this.requests.set(requestId, req)
    this.planning = requestId
    const text = renderTemplate(this.prompts.requests.plan, {
      taskId, requestId, instruction: goal, maxAttempts: this.maxInvalidAttempts, skill: this.prompts.skills.outline
    })
    this.log(`[bt] plan ${requestId} (${taskId}): ${goal}`)

    if (turn !== null) {
      this.bindTurn(sessionId, turn, requestId)
      return { ok: true, requestId, taskId, text, tools: REQUEST_TOOLS.plan }
    }
    if (!this.deliver(sessionId, this.message(req, text, `规划任务：${goal}`))) {
      this.closePlan(req, 'session not found')
      return { ok: false, error: `找不到会话 ${sessionId}` }
    }
    return { ok: true, requestId, taskId }
  }

  // ── 执行器发来的请求 ─────────────────────────────────────────────────────

  onRequest(request) {
    if (PATCH_TYPES.includes(request.type)) return this.onPatchRequest(request)
    if (request.type !== 'expand') return
    const { taskId, requestId, evidence } = request
    const sessionId = this.taskSessions.get(taskId)
    if (!sessionId) {
      this.log(`[bt] expand ${requestId}: 任务 ${taskId} 不属于任何会话（/bt run 跑的手写树），保持挂起；/bt abort 结束`)
      return
    }
    const req = { requestId, type: 'expand', taskId, sessionId, nodeId: evidence.nodeId, goal: evidence.goal, answered: false, closed: false, createdAt: this.now() }
    this.requests.set(requestId, req)
    const task = this.executor.task
    const text = renderTemplate(this.prompts.requests.expand, {
      taskId, requestId,
      version: task.version,
      taskGoal: task.goal ?? '（无）',
      nodeId: evidence.nodeId,
      goal: evidence.goal,
      path: ancestorsOf(task.spec, evidence.nodeId).join(' › ') || '（根）',
      tree: renderTree(task.spec, { statuses: statusMap(task), mark: evidence.nodeId }),
      blackboard: blackboardShape(request.blackboard),
      drafts: this.draftRefs().join(', ') || '（无）',
      maxAttempts: this.maxInvalidAttempts,
      skill: this.prompts.skills.expand
    })
    if (!this.deliver(sessionId, this.message(req, text, `展开 ${evidence.nodeId}：${evidence.goal}`))) {
      // 会话被关掉而任务还在跑：任务立即失败，不 resume（§7.2 审阅点 6）。不在 tick 里重入执行器
      queueMicrotask(() => {
        if (this.activeTask()?.taskId === taskId) this.executor.abortTask(`session ${sessionId} is gone`, { by: 'session' })
      })
    }
  }

  /** recover / escalate / failed（P2 §4）：消息只推目录与树，证据由大模型用 bt_inspect 自己取。 */
  onPatchRequest(request) {
    const { taskId, requestId, type, evidence, directory } = request
    const sessionId = this.taskSessions.get(taskId)
    if (!sessionId) return // 本地应答器回答
    const nodeId = directory?.path.at(-1)?.id ?? null
    const req = { requestId, type, taskId, sessionId, nodeId, answered: false, closed: false, createdAt: this.now() }
    this.requests.set(requestId, req)
    const task = this.executor.task
    const text = renderTemplate(this.prompts.requests[type], {
      taskId, requestId,
      version: task.version,
      taskGoal: task.goal ?? '（无）',
      directory: renderDirectory(directory),
      tree: renderTree(task.spec, { statuses: statusMap(task), mark: nodeId, markLabel: type === 'failed' ? '← 失败' : type === 'died' ? '← 死亡时在跑' : '← 被中断' }),
      drafts: this.draftRefs().join(', ') || '（无）',
      maxAttempts: this.maxInvalidAttempts,
      skill: this.prompts.skills[PATCH_SKILL[type]]
    })
    const summary = type === 'failed'
      ? `修复：${evidence.nodeId ?? '?'} 失败`
      : type === 'died'
        ? `恢复：死亡并已重生（${evidence.deathMessage ?? '无死亡信息'}）`
        : `恢复：快树情节「${evidence.fastArm}」打断了 ${evidence.interrupted?.id ?? '?'}`
    if (!this.deliver(sessionId, this.message(req, text, summary))) {
      queueMicrotask(() => {
        if (this.activeTask()?.taskId === taskId) this.executor.abortTask(`session ${sessionId} is gone`, { by: 'session' })
      })
    }
  }

  onTask(summary) {
    if (!summary || (summary.state !== 'done' && summary.state !== 'failed')) return
    const { taskId } = summary
    // 草稿区照旧关掉（新任务的 beginDrafts 不受影响），复盘读的是这份拷贝（P4 §2.4）
    this.lastDrafts = copyDrafts(this.library, taskId)
    this.library.endDrafts(taskId)
    for (const req of this.requests.values()) if (req.taskId === taskId && req.type !== 'reflect') req.closed = true
    const sessionId = this.taskSessions.get(taskId)
    this.taskSessions.delete(taskId)
    if (!sessionId) return this.maybeCurate()
    this.curateSession = sessionId
    const task = this.executor.task?.taskId === taskId ? this.executor.task : null
    // 发了复盘就先不整理：复盘结束（closeReflect）时再查
    if (task && this.shouldReflect(summary) && this.startReflect({ sessionId, task, drafts: this.lastDrafts }).ok) return
    const text = renderTemplate(this.prompts.requests.task_end, {
      taskId, state: summary.state, goal: summary.goal ?? '（无）', result: summary.result ?? '（无）'
    })
    this.notify(sessionId, { text, summary: `任务 ${taskId} ${summary.state}`, source: { kind: SOURCE_KIND, taskId, reason: 'task-end' } })
    this.maybeCurate()
  }

  // ── 复盘（P4）─────────────────────────────────────────────────────────────

  shouldReflect(summary) {
    const { enabled, onFailed } = this.reflectConfig
    if (!enabled) return false
    if (summary.state === 'done') return true
    return onFailed && !NO_REFLECT_BY.includes(summary.by)
  }

  /**
   * 发一个复盘请求（任务结束时自动；/bt reflect 手动）。
   * @returns {{ ok: true, requestId } | { ok: false, error }}
   */
  startReflect({ sessionId, task, drafts = null, manual = false }) {
    const open = [...this.requests.values()].find((r) => r.type === 'reflect' && r.taskId === task.taskId && this.isOpen(r))
    if (open) return { ok: false, error: `任务 ${task.taskId} 的复盘请求 ${open.requestId} 还没结束` }
    const requestId = `c${++this.reflectSeq}`
    const req = {
      requestId, type: 'reflect', taskId: task.taskId, sessionId, task,
      drafts: drafts?.taskId === task.taskId ? drafts : { taskId: task.taskId, entries: new Map(), latest: new Map() },
      saved: [], promoted: new Map(), reminded: false, errors: 0, answered: false, closed: false, createdAt: this.now()
    }
    this.requests.set(requestId, req)
    const directory = buildReflectDirectory(task, { drafts: draftList(req.drafts) })
    const text = renderTemplate(this.prompts.requests.reflect, {
      requestId, taskId: task.taskId,
      state: task.state,
      by: BY_TEXT[task.finishedBy] ?? task.finishedBy ?? '?',
      seconds: Math.round(((task.finishedAt ?? this.now()) - task.startedAt) / 1000),
      goal: task.goal ?? '（无）',
      result: task.result ?? '（无）',
      manual: manual ? '（人手动发起的复盘）\n\n' : '',
      directory: renderReflectDirectory(directory),
      tree: renderTree(task.spec, { statuses: statusMap(task) }),
      skill: this.prompts.skills.review
    })
    this.executor.log(task.taskId, { event: 'reflect/start', requestId, manual: manual || undefined })
    if (!this.deliver(sessionId, this.message(req, text, `复盘：任务 ${task.taskId} ${task.state}${task.goal ? `（${task.goal}）` : ''}`))) {
      this.closeReflect(req, 'abandoned', `session ${sessionId} not found`)
      return { ok: false, error: `找不到会话 ${sessionId}` }
    }
    this.log(`[bt] reflect ${requestId} (${task.taskId} ${task.state})`)
    return { ok: true, requestId }
  }

  /** /bt reflect：对最近结束、任务对象还在内存里的任务手动复盘。 */
  reflectLast({ sessionId }) {
    const task = this.executor.task
    if (!task || (task.state !== 'done' && task.state !== 'failed')) return { ok: false, error: task ? `任务 ${task.taskId} 还在 ${task.state}` : '没有已结束的任务（任务对象只保留到下一个任务开始）' }
    return this.startReflect({ sessionId, task, drafts: this.lastDrafts, manual: true })
  }

  /** 本会话在飞的复盘请求（bt_inspect / bt_view / capsule_get 在复盘回合里看它持有的任务）。 */
  reflectRequestFor(sessionId) {
    if (!sessionId) return null
    return [...this.requests.values()].find((r) => r.type === 'reflect' && r.sessionId === sessionId && this.isOpen(r)) ?? null
  }

  /** 在飞的复盘请求（/bt status）。 */
  reflecting() {
    return [...this.requests.values()].filter((r) => r.type === 'reflect' && this.isOpen(r))
      .map((r) => ({ requestId: r.requestId, taskId: r.taskId, saved: [...r.saved] }))
  }

  /** capsule_get task/… 在复盘回合里：从请求持有的草稿拷贝取。@returns {object|null} */
  reflectDraft(sessionId, ref) {
    const req = this.reflectRequestFor(sessionId)
    return req ? findDraft(req.drafts, ref) : null
  }

  /**
   * capsule_save（P4 §4）。
   * @returns {{ ok: true, ref, created, rewritten?, from?, keptLiterals? } | { ok: false, errors: string[] } | { ok: false, error }}
   */
  saveCapsule({ sessionId, requestId, folder, name, description, from, signature, body, preconditions, replaces, keepLiterals }) {
    const check = this.checkRequest(sessionId, requestId, 'reflect')
    if (check.error) return { ok: false, error: check.error }
    const { req } = check
    const errors = []
    if (folder !== 'code' && folder !== 'trees') errors.push('folder must be "code" or "trees"')
    if (typeof description !== 'string' || !description.trim()) errors.push('description is required: one line saying what it does and when it applies — it is the line the planner sees in the capsule list')
    if (errors.length) return { ok: false, errors }

    const key = `${folder}/${name}`
    const existing = this.library.readManifest()[key]
    if (existing) {
      if (existing.locked) return { ok: false, errors: [`${key} is locked (a hand-made base entry) and cannot be replaced; pick another name`] }
      const current = this.library.tryGet(`${key}@${existing.hash}`)
      const info = `${key}@${existing.hash}: ${existing.description || '(no description)'}; signature ${JSON.stringify(current?.signature ?? null)}`
      if (replaces === undefined) return { ok: false, errors: [`${key} already exists (${info}). To improve it, resubmit with replaces: "${existing.hash}"; if this is something else, pick another name`] }
      if (replaces !== existing.hash) return { ok: false, errors: [`replaces "${replaces}" is not the latest version of ${key} (latest: ${info}); look at it with capsule_get and resubmit on top of it`] }
    } else if (replaces !== undefined) {
      return { ok: false, errors: [`replaces given, but there is no ${key} in the library yet`] }
    }

    const entry = { name, description: description.trim(), signature, body, ...(preconditions ? { preconditions } : {}) }
    let fromInfo = null
    let draft = null
    if (folder === 'code' && from !== undefined) {
      draft = findDraft(req.drafts, from)
      if (!draft) return { ok: false, errors: [`from: no draft ${from} in task ${req.taskId} (drafts: ${draftList(req.drafts).map((d) => d.ref).join(', ') || 'none'})`] }
      entry.signature ??= draft.signature
      entry.body ??= draft.body
      fromInfo = { draft: `task/${draft.name}@${draft.hash}` }
    }
    if (folder === 'trees' && from !== undefined) {
      const node = req.task.byId.get(from)
      if (!node) return { ok: false, errors: [`from: no node ${from} in task ${req.taskId}'s tree`] }
      const exits = req.task.events.filter((e) => e.event === 'node' && e.phase === 'exit' && e.id === from)
      fromInfo = { node: from, runs: exits.length, successes: exits.filter((e) => e.status === 'SUCCESS').length }
    }
    if (entry.signature === undefined || entry.body === undefined) {
      return { ok: false, errors: [folder === 'trees' ? 'a tree capsule needs signature and body (the subtree in authoring format)' : 'a code capsule needs signature and body, or from: a task/ draft to promote'] }
    }

    let hits = []
    const result = saveCapsule({ library: this.library, sandbox: this.sandbox, registry: this.registry }, folder, entry, {
      rewriteDraft: (ref) => {
        const target = parseDraftRef(ref)
        const promoted = target && req.promoted.get(target.name)
        if (!promoted || (target.hash && target.hash !== promoted.hash)) return null
        return promoted.ref
      },
      check: (kind, compiled) => {
        const errors = kind === 'trees' && from !== undefined ? missingReads(req, from, compiled) : []
        if (!this.reflectConfig.literalCheck) return errors
        const outcome = checkLiterals({
          folder: kind, body: compiled, keep: keepLiterals ?? {}, registry: this.registry,
          evidence: collectEvidence(req.task, { from: kind === 'trees' ? from ?? null : null })
        })
        hits = outcome.hits
        return [...errors, ...outcome.errors]
      }
    })
    if (!result.ok) return result
    if (draft) req.promoted.set(draft.name, { hash: draft.hash, ref: result.ref })
    if (!req.saved.includes(result.ref)) req.saved.push(result.ref)
    const keptLiterals = hits.length ? Object.fromEntries(hits.map((h) => [h.path, keepLiterals[h.path]])) : undefined
    this.executor.log(req.taskId, {
      event: 'capsule/saved', requestId, ref: result.ref, folder, from: from ?? undefined,
      replaces: replaces ?? undefined, created: result.created, keptLiterals
    })
    this.log(`[bt] reflect ${requestId}: saved ${result.ref}`)
    return { ok: true, ref: result.ref, created: result.created, ...(result.rewritten ? { rewritten: result.rewritten } : {}), ...(fromInfo ? { from: fromInfo } : {}), ...(keptLiterals ? { keptLiterals } : {}) }
  }

  /** bt_reflect_done（P4 §6.1）：结束复盘。summary 必填，什么都没存也要写为什么。 */
  reflectDone({ sessionId, requestId, summary }) {
    const check = this.checkRequest(sessionId, requestId, 'reflect')
    if (check.error) return { ok: false, error: check.error }
    const { req } = check
    if (typeof summary !== 'string' || !summary.trim()) return { ok: false, error: 'summary is required: what you saved and why, or why nothing was worth saving' }
    req.answered = true
    const saved = [...req.saved]
    this.closeReflect(req, 'done', summary.trim())
    return { ok: true, requestId, taskId: req.taskId, saved }
  }

  closeReflect(req, outcome, reason) {
    req.closed = true
    this.executor.log(req.taskId, { event: `reflect/${outcome}`, requestId: req.requestId, saved: [...req.saved], reason })
    this.log(`[bt] reflect ${req.requestId} ${outcome}: ${reason}`)
    // 证据随请求释放（P4 §2.4）
    req.task = null
    req.drafts = null
    this.maybeCurate()
  }

  // ── 整理（整理方案 §5）───────────────────────────────────────────────────

  /** 为什么现在不能整理；null = 空闲（没有在跑的任务、没有规划 / 复盘 / 整理请求没结束） */
  busyReason() {
    const task = this.activeTask()
    if (task) return `任务 ${task.taskId} 还在 ${task.state}`
    if (this.planning) return `规划请求 ${this.planning} 还没结束`
    const open = [...this.requests.values()].find((r) => (r.type === 'reflect' || r.type === 'curate') && this.isOpen(r))
    if (open) return `${open.type === 'reflect' ? '复盘' : '整理'}请求 ${open.requestId} 还没结束`
    return null
  }

  /** 自动整理（C1 / C2）：everyTasks > 0、攒够了、空闲时才发；忙就等下一次检查（任务结束 / 复盘结束） */
  maybeCurate() {
    const every = this.curateConfig.everyTasks
    if (!(every > 0) || !this.stats || !this.curateSession) return
    if (this.stats.curateState().sinceLast < every) return
    if (this.busyReason()) return
    const result = this.startCurate({ sessionId: this.curateSession, trigger: 'auto' })
    if (!result.ok) this.log(`[bt] auto curate not sent: ${result.error}`)
  }

  /**
   * 发一个整理请求（/bt curate 手动；自动见 maybeCurate）。忙时直接返回说明，不排队（§5.2）。
   * @returns {{ ok: true, requestId } | { ok: false, error }}
   */
  startCurate({ sessionId, trigger = 'manual' }) {
    const busy = this.busyReason()
    if (busy) return { ok: false, error: `${busy}；等它结束再整理（不排队）` }
    const requestId = `k${++this.curateSeq}`
    const state = this.stats?.curateState() ?? { sinceLast: 0, lastAt: null, lastRequestId: null }
    const req = { requestId, type: 'curate', sessionId, trigger, sinceLast: state.sinceLast, changes: [], reminded: false, answered: false, closed: false, createdAt: this.now() }
    this.requests.set(requestId, req)
    const text = renderTemplate(this.prompts.requests.curate, {
      requestId,
      trigger: trigger === 'auto'
        ? `（自动发起：自上次整理以来已经结束了 ${state.sinceLast} 个任务，达到 curate.everyTasks = ${this.curateConfig.everyTasks}。人可以随时取消这一回合。）`
        : '（人用 /bt curate 发起）',
      last: state.lastAt
        ? `上次整理：${state.lastAt}（${state.lastRequestId}），之后结束了 ${state.sinceLast} 个任务`
        : `还没有整理过；统计里已经记了 ${this.stats?.data.tasks.length ?? 0} 个任务`,
      library: renderLibrary(libraryRows(this.library, this.stats), { listLimit: this.curateConfig.listLimit }),
      skill: this.prompts.skills.curate
    })
    const summary = trigger === 'auto' ? `整理胶囊库：已累计 ${state.sinceLast} 个任务` : '整理胶囊库'
    const send = trigger === 'auto' ? this.deliverIdle : this.deliver
    if (!send(sessionId, this.message(req, text, summary))) {
      this.closeCurate(req, 'abandoned', `session ${sessionId} not found`)
      return { ok: false, error: `找不到会话 ${sessionId}` }
    }
    this.stats?.curateStarted(requestId, new Date(this.now()).toISOString())
    this.log(`[bt] curate ${requestId} (${trigger})`)
    return { ok: true, requestId }
  }

  /** 在飞的整理请求（/bt status）。 */
  curating() {
    return [...this.requests.values()].filter((r) => r.type === 'curate' && this.isOpen(r))
      .map((r) => ({ requestId: r.requestId, trigger: r.trigger, changes: r.changes.length }))
  }

  /** capsule_retire（§5.4）：按名字下架 / 撤销。reason 必填。 */
  retireCapsule({ sessionId, requestId, ref, reason, supersededBy, undo = false }) {
    const check = this.checkRequest(sessionId, requestId, 'curate')
    if (check.error) return { ok: false, error: check.error }
    const why = checkReason(reason)
    if (why.error) return { ok: false, error: why.error }
    let change
    try {
      if (undo) {
        const r = this.library.unretire(ref)
        change = { op: 'undo', key: r.key, before: r.before, reason: why.reason }
      } else {
        const r = this.library.retire(ref, { reason: why.reason, supersededBy: supersededBy ?? null, at: new Date(this.now()).toISOString(), by: requestId })
        change = { op: 'retire', key: r.key, before: r.before, after: r.after }
      }
    } catch (error) {
      return { ok: false, error: error.message }
    }
    check.req.changes.push(change)
    this.log(`[bt] curate ${requestId}: ${change.op} ${change.key}`)
    return { ok: true, ...change }
  }

  /** capsule_describe（§5.4）：改说明，不产生新版本。 */
  describeCapsule({ sessionId, requestId, ref, description }) {
    const check = this.checkRequest(sessionId, requestId, 'curate')
    if (check.error) return { ok: false, error: check.error }
    if (typeof description !== 'string' || !description.trim()) return { ok: false, error: 'description is required: one line saying what it does and when it applies' }
    let r
    try {
      r = this.library.describe(ref, description.trim())
    } catch (error) {
      return { ok: false, error: error.message }
    }
    const change = { op: 'describe', key: r.key, before: r.before, after: r.after }
    check.req.changes.push(change)
    this.log(`[bt] curate ${requestId}: describe ${r.key}`)
    return { ok: true, ...change }
  }

  /** bt_curate_done：结束整理。reason 必填，什么都没改也要写为什么。 */
  curateDone({ sessionId, requestId, reason }) {
    const check = this.checkRequest(sessionId, requestId, 'curate')
    if (check.error) return { ok: false, error: check.error }
    if (typeof reason !== 'string' || !reason.trim()) return { ok: false, error: 'reason is required: what you changed and why, or why nothing needed changing' }
    const { req } = check
    req.answered = true
    this.closeCurate(req, 'done', reason.trim())
    return { ok: true, requestId, changes: req.changes }
  }

  closeCurate(req, outcome, reason) {
    req.closed = true
    const pick = (op) => req.changes.filter((c) => c.op === op)
    appendCurateLog(this.library.dir, {
      requestId: req.requestId, at: new Date(this.now()).toISOString(), trigger: req.trigger, sinceLast: req.sinceLast, outcome,
      retired: pick('retire'), undone: pick('undo'), described: pick('describe'), reason
    })
    this.log(`[bt] curate ${req.requestId} ${outcome}: ${reason}`)
  }

  // ── 回合 ─────────────────────────────────────────────────────────────────

  bindTurn(sessionId, turn, requestId) {
    const key = turnKey(sessionId, turn)
    if (this.turns.get(key) === requestId) return
    this.turns.set(key, requestId)
    this.onBind(sessionId, turn, REQUEST_TOOLS[this.requests.get(requestId).type])
  }

  /**
   * agent/pre-step：第一个 step 认出 followup 消息带来的请求，绑定回合。
   * @returns {{ requestId, tools: string[] } | null}  绑定了请求的回合 → 该请求准入的工具
   */
  onPreStep({ sessionId, turn, step, messages = [] }) {
    const key = turnKey(sessionId, turn)
    if (step === 1) {
      for (const message of messages) {
        const source = message?.source
        if (source?.kind === SOURCE_KIND && this.requests.has(source.requestId)) this.bindTurn(sessionId, turn, source.requestId)
      }
    }
    const requestId = this.turns.get(key)
    if (!requestId) return null
    return { requestId, tools: REQUEST_TOOLS[this.requests.get(requestId).type] }
  }

  /**
   * agent/turn-stopping（I5）。
   * @returns {null | { steer: OutgoingMessage } | { failed: true }}
   *   null = 回合可以结束（释放工具限制）；steer = 发提醒让回合再跑一步；failed = 尝试用完，请求作废
   */
  onTurnStopping({ sessionId, turn }) {
    const key = turnKey(sessionId, turn)
    const requestId = this.turns.get(key)
    if (!requestId) return null
    const req = this.requests.get(requestId)
    if (!this.isOpen(req)) {
      this.turns.delete(key)
      return null
    }
    if (req.type === 'curate') {
      // 整理没结束：提醒一次；再没结束就按 abandoned 关闭，已经做的改动保留（照复盘）
      if (!req.reminded) {
        req.reminded = true
        const text = renderTemplate(this.prompts.requests.curate_reminder, { requestId, changes: String(req.changes.length) })
        return { steer: { text, summary: `提醒：整理 ${requestId} 还没有结束`, source: { kind: SOURCE_KIND, requestId, reason: 'reminder' } } }
      }
      this.turns.delete(key)
      this.closeCurate(req, 'abandoned', 'the turn ended again without bt_curate_done')
      return null
    }
    if (req.type === 'reflect') {
      // 复盘没交（P4-D10）：提醒一次；再没交就按 abandoned 关闭，已经存进库的胶囊保留
      if (!req.reminded) {
        req.reminded = true
        const text = renderTemplate(this.prompts.requests.reflect_reminder, { requestId, saved: req.saved.join(', ') || '（还没有）' })
        return { steer: { text, summary: `提醒：复盘 ${requestId} 还没有结束`, source: { kind: SOURCE_KIND, taskId: req.taskId, requestId, reason: 'reminder' } } }
      }
      this.turns.delete(key)
      this.closeReflect(req, 'abandoned', 'the turn ended again without bt_reflect_done')
      return null
    }
    const attemptsLeft = this.chargeAttempt(req, 'the turn ended without a submission')
    if (attemptsLeft <= 0) {
      this.turns.delete(key)
      return { failed: true }
    }
    const text = renderTemplate(this.prompts.requests.reminder, { requestId, submitTool: SUBMIT_TOOL[req.type], attemptsLeft })
    return { steer: { text, summary: `提醒：请求 ${requestId} 还没有提交`, source: { kind: SOURCE_KIND, taskId: req.taskId, requestId, reason: 'reminder' } } }
  }

  /**
   * agent/error：绑定了请求的回合因错误结束（如模型返回了坏的工具参数 JSON）。
   * 这种回合不经过 turn-stopping，不处理的话请求会一直等下去、挡住后面的任务。
   * 算一次不合法尝试，解除回合绑定；还有次数 → 返回一条重试消息（由适配层 followup 开新回合，新回合按来源重新绑定）。
   * @returns {null | { retry: OutgoingMessage } | { failed: true }}
   */
  onTurnError({ sessionId, turn, error }) {
    const key = turnKey(sessionId, turn)
    const requestId = this.turns.get(key)
    if (!requestId) return null
    this.turns.delete(key)
    const req = this.requests.get(requestId)
    if (!this.isOpen(req)) return null
    const message = errorText(error)
    // 整理回合出错（含人取消）：不自动重发（§5.2），要整理就再敲 /bt curate
    if (req.type === 'curate') {
      this.closeCurate(req, 'abandoned', `the turn errored: ${message}`)
      return null
    }
    const attemptsLeft = this.chargeAttempt(req, `the turn errored: ${message}`)
    if (attemptsLeft <= 0) return { failed: true }
    const template = req.type === 'reflect' ? this.prompts.requests.reflect_retry : this.prompts.requests.retry
    const text = renderTemplate(template, { requestId, submitTool: SUBMIT_TOOL[req.type], attemptsLeft, error: message })
    return { retry: { text, summary: `重试：请求 ${requestId}（上一回合出错）`, source: { kind: SOURCE_KIND, taskId: req.taskId, requestId, reason: 'retry' } } }
  }

  /** 计一次不合法尝试（plan 自己计；expand 记在执行器的在飞请求上）。用完 → 规划作废 / 任务失败。@returns 剩余次数 */
  chargeAttempt(req, reason) {
    if (req.type === 'reflect') {
      req.errors++
      const left = this.maxInvalidAttempts - req.errors
      if (left <= 0) this.closeReflect(req, 'abandoned', `${req.errors} turns errored (last: ${reason})`)
      return left
    }
    if (req.type === 'plan') {
      req.invalidAttempts++
      const left = this.maxInvalidAttempts - req.invalidAttempts
      if (left <= 0) this.closePlan(req, `no valid outline after ${req.invalidAttempts} attempts (last: ${reason})`)
      return left
    }
    const result = this.executor.recordInvalidAttempt(req.requestId, [reason])
    return result.taskFailed || result.error ? 0 : result.attemptsLeft
  }

  /** 会话被关掉（agent/disposed）：它的规划作废，它的任务立即失败（§7.2 审阅点 6）。 */
  onSessionClosed(sessionId) {
    for (const key of [...this.turns.keys()]) if (key.startsWith(`${sessionId}#`)) this.turns.delete(key)
    const plan = this.planning && this.requests.get(this.planning)
    if (plan && plan.sessionId === sessionId) this.closePlan(plan, 'session closed')
    for (const req of this.requests.values()) if (req.type === 'reflect' && req.sessionId === sessionId && this.isOpen(req)) this.closeReflect(req, 'abandoned', 'session closed')
    for (const req of this.requests.values()) if (req.type === 'curate' && req.sessionId === sessionId && this.isOpen(req)) this.closeCurate(req, 'abandoned', 'session closed')
    if (this.curateSession === sessionId) this.curateSession = null
    const task = this.activeTask()
    if (task && this.taskSessions.get(task.taskId) === sessionId) this.executor.abortTask(`session ${sessionId} was closed`, { by: 'session' })
  }

  // ── 提交（工具调用） ─────────────────────────────────────────────────────

  /** bt_submit_tree：新任务的大纲。不合法 → 错误原文 + 剩余次数（§4.2 的校验—修正循环，同一回合内修正）。 */
  submitTree({ sessionId, requestId, tree, code, blackboard }) {
    const check = this.checkRequest(sessionId, requestId, 'plan')
    if (check.error) return { ok: false, error: check.error }
    const { req } = check
    let errors = this.writeDrafts(code)
    if (errors.length === 0) {
      try {
        this.executor.startTask({ tree, goal: req.instruction, taskId: req.taskId, blackboard: blackboard ?? {} })
      } catch (error) {
        errors = error instanceof TreeError ? error.errors : [error.message]
      }
    }
    if (errors.length > 0) {
      req.invalidAttempts++
      const attemptsLeft = this.maxInvalidAttempts - req.invalidAttempts
      this.log(`[bt] plan ${requestId}: outline invalid (attempt ${req.invalidAttempts}): ${errors.join(' | ')}`)
      if (attemptsLeft <= 0) {
        this.closePlan(req, `outline invalid ${req.invalidAttempts} times`)
        return { ok: false, errors, attemptsLeft: 0, planningFailed: true }
      }
      return { ok: false, errors, attemptsLeft }
    }
    req.answered = true
    this.planning = null
    this.taskSessions.set(req.taskId, req.sessionId)
    const task = this.executor.task
    return { ok: true, taskId: task.taskId, requestId, version: task.version, tree: renderTree(task.spec), ...this.retiredWarnings(task.spec) }
  }

  /** bt_submit_expansion：替换一个 PendingExpansion。 */
  submitExpansion({ sessionId, requestId, subtree, code }) {
    const check = this.checkRequest(sessionId, requestId, 'expand')
    if (check.error) return { ok: false, error: check.error }
    const { req } = check
    const draftErrors = this.writeDrafts(code)
    if (draftErrors.length) return { ok: false, errors: draftErrors, ...this.executor.recordInvalidAttempt(requestId, draftErrors) }
    const result = this.executor.submitExpansion(requestId, subtree)
    if (!result.ok) return result
    req.answered = true
    return { ok: true, taskId: req.taskId, requestId, version: result.version, ids: result.ids, ...this.retiredWarnings(this.executor.task?.spec, result.ids) }
  }

  /** bt_submit_patch：回答修复请求（P2 §3）。`ops: []` = 原树继续。 */
  submitPatch({ sessionId, requestId, ops, code }) {
    const check = this.checkRequest(sessionId, requestId, PATCH_TYPES)
    if (check.error) return { ok: false, error: check.error }
    const { req } = check
    const draftErrors = this.writeDrafts(code)
    if (draftErrors.length) return { ok: false, errors: draftErrors, ...this.executor.recordInvalidAttempt(requestId, draftErrors) }
    const result = this.executor.submitPatch(requestId, ops ?? [])
    if (!result.ok) return result
    req.answered = true
    return { ok: true, taskId: req.taskId, requestId, version: result.version, ids: result.ids, ...this.retiredWarnings(this.executor.task?.spec, result.ids) }
  }

  /** bt_inspect（P2 §4.4）：当前任务；复盘回合里看复盘请求持有的那个已结束的任务（P4 §2.4）。 */
  inspect(args, { sessionId = null } = {}) {
    const req = this.reflectRequestFor(sessionId)
    return req ? this.executor.inspect(args, { task: req.task, reflect: true }) : this.executor.inspect(args)
  }

  /** bt_abort_task：放弃规划中的新任务，或放弃在跑的任务（默认中止流程，进 failed）。 */
  abort({ sessionId, requestId = null, reason }) {
    const text = reason || 'abandoned by the model'
    const plan = this.planning && this.requests.get(this.planning)
    if (plan && (!requestId || requestId === plan.requestId)) {
      if (sessionId && plan.sessionId !== sessionId) return { ok: false, error: `规划请求 ${plan.requestId} 属于另一个会话` }
      this.closePlan(plan, `abandoned: ${text}`)
      return { ok: true, cancelled: 'plan', requestId: plan.requestId, taskId: plan.taskId }
    }
    const task = this.activeTask()
    if (!task) return { ok: false, error: '没有正在规划或进行的任务' }
    const owner = this.taskSessions.get(task.taskId)
    if (sessionId && owner && owner !== sessionId) return { ok: false, error: `任务 ${task.taskId} 属于另一个会话` }
    this.executor.abortTask(text, { by: 'agent' })
    return { ok: true, cancelled: 'task', taskId: task.taskId }
  }

  /** bt_view：当前任务树（带 id 与状态）、黑板、在飞请求、代码草稿。复盘回合里看复盘的那个任务。 */
  view({ sessionId = null } = {}) {
    const reflect = this.reflectRequestFor(sessionId)
    if (reflect) {
      const task = reflect.task
      return {
        planning: null,
        reviewing: reflect.requestId,
        task: {
          taskId: task.taskId, goal: task.goal, state: task.state, version: task.version, result: task.result, pending: null,
          tree: renderTree(task.spec, { statuses: statusMap(task) }),
          blackboard: blackboardShape(task.blackboard.snapshot()),
          drafts: draftList(reflect.drafts).map((d) => d.ref)
        }
      }
    }
    const plan = this.planning ? this.requests.get(this.planning) : null
    const planning = plan ? { requestId: plan.requestId, taskId: plan.taskId, instruction: plan.instruction } : null
    const task = this.executor.task
    if (!task) return { task: null, planning }
    const pending = task.pending
    return {
      planning,
      task: {
        taskId: task.taskId,
        goal: task.goal,
        state: task.state,
        version: task.version,
        result: task.result,
        pending: pending ? {
          requestId: pending.requestId, type: pending.type, stale: pending.stale,
          nodeId: pending.evidence?.nodeId ?? pending.evidence?.interrupted?.id ?? null,
          title: this.executor.directory(task)?.title ?? null
        } : null,
        tree: renderTree(task.spec, { statuses: statusMap(task), mark: pending?.type === 'expand' ? pending.evidence.nodeId : null }),
        blackboard: blackboardShape(task.blackboard.snapshot()),
        drafts: this.draftRefs()
      }
    }
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  /**
   * 树里引用了已下架的名字（D9）：只警告、不拦——下架可能是误判，带哈希的引用照常能跑。
   * ids 给了只看这些新节点（展开 / 补丁），没给看整棵树（大纲）。@returns {{ warnings?: string[] }}
   */
  retiredWarnings(spec, ids = null) {
    if (!spec) return {}
    const manifest = this.library.readManifest()
    const only = ids ? new Set(ids) : null
    const warnings = []
    walkSpec(spec, (node) => {
      if (typeof node.ref !== 'string' || (only && !only.has(node.id))) return
      const key = node.ref.split('@')[0]
      const retired = manifest[key]?.retired
      if (!retired) return
      warnings.push(`[${node.id}] ${key} is retired (${retired.reason})${retired.supersededBy ? `; superseded by ${retired.supersededBy}` : ''}. The tree still runs — this is only a warning`)
    })
    return warnings.length ? { warnings } : {}
  }

  isOpen(req) {
    if (!req || req.answered || req.closed) return false
    if (!['plan', 'reflect', 'curate'].includes(req.type)) return this.executor.task?.pending?.requestId === req.requestId
    return true
  }

  checkRequest(sessionId, requestId, type) {
    const req = this.requests.get(requestId)
    if (!req) return { error: `没有请求 ${requestId}` }
    if (Array.isArray(type) ? !type.includes(req.type) : req.type !== type) return { error: `${requestId} 是 ${req.type} 请求，请用 ${SUBMIT_TOOL[req.type]} 回答` }
    if (sessionId && req.sessionId !== sessionId) return { error: `请求 ${requestId} 属于另一个会话` }
    if (!this.isOpen(req)) return { error: `请求 ${requestId} 已经回答过或已关闭` }
    return { req }
  }

  closePlan(req, reason) {
    req.closed = true
    if (this.planning === req.requestId) this.planning = null
    this.library.endDrafts(req.taskId)
    this.releaseTask(req.taskId)
    this.log(`[bt] plan ${req.requestId} closed: ${reason}`)
  }

  /** 提交工具的 code 字段 → 任务草稿区。@returns {string[]} 错误 */
  writeDrafts(code) {
    if (code === undefined || code === null) return []
    if (typeof code !== 'object' || Array.isArray(code)) return ['code must be an object { <name>: { signature, body, description? } }']
    const errors = []
    for (const [name, entry] of Object.entries(code)) {
      const result = saveDraft({ library: this.library, sandbox: this.sandbox }, name, entry)
      if (!result.ok) errors.push(...result.errors.map((e) => `code.${name}: ${e}`))
    }
    return errors
  }

  draftRefs() {
    return this.library.list().filter((row) => row.draft).map((row) => row.ref)
  }

  message(req, text, summary) {
    return { text, summary: summary.length > 120 ? `${summary.slice(0, 119)}…` : summary, source: { kind: SOURCE_KIND, ...(req.taskId ? { taskId: req.taskId } : {}), requestId: req.requestId, reason: req.type } }
  }
}

function errorText(error) {
  const text = error?.message ?? (typeof error === 'string' ? error : JSON.stringify(error))
  return String(text ?? 'unknown error').slice(0, 500)
}

const BY_TEXT = { tree: '根 SUCCESS', agent: '你用 bt_abort_task 放弃', user: '人放弃', session: '会话没了', executor: '执行器判定失败' }

/** 草稿区的拷贝（任务结束前取）：{ taskId, entries: Map<"task/name@hash", entry>, latest: Map<name, hash> } */
function copyDrafts(library, taskId) {
  const drafts = library.drafts
  if (!drafts || drafts.taskId !== taskId) return { taskId, entries: new Map(), latest: new Map() }
  return { taskId, entries: new Map(drafts.entries), latest: new Map(drafts.latest) }
}

function draftList(drafts) {
  return [...(drafts?.latest ?? [])].map(([name, hash]) => ({ ref: `task/${name}@${hash}`, name }))
}

function parseDraftRef(ref) {
  const match = typeof ref === 'string' ? /^task\/([a-z0-9][a-z0-9._-]*)(?:@([0-9a-f]{4,64}))?$/.exec(ref) : null
  return match ? { name: match[1], hash: match[2] ?? null } : null
}

/**
 * 子树胶囊丢了 read（P4 §4.4，游戏内验收发现）：出处子树里调用某段代码的节点带着 read，胶囊里调用同一段代码的节点却少了其中的来源。
 * 代码读 state.<来源>，节点不 read 它，运行时 state 就是 undefined——保存时看不出来，要等下一次任务用到才失败。
 * "同一段代码"按名字认：出处里的 task/<草稿> 看它在本次复盘里转正成了哪个 code/<名字>；code/<名字> 不论版本。
 * @returns {string[]}
 */
export function missingReads(req, from, compiled) {
  let origin = null
  walkSpec(req.task.spec, (node) => { if (node.id === from) origin = node })
  if (!origin) return []
  const codeName = (ref) => {
    if (typeof ref !== 'string') return null
    const draft = parseDraftRef(ref)
    if (draft) {
      const promoted = req.promoted.get(draft.name)
      return promoted ? promoted.ref.replace(/@[0-9a-f]+$/, '') : null
    }
    return ref.startsWith('code/') ? ref.replace(/@[0-9a-f]+$/, '') : null
  }
  const reads = new Map() // code/<名字> → [{ id, read }]
  walkSpec(origin, (node) => {
    const name = codeName(node.ref)
    if (!name || !node.read?.length) return
    if (!reads.has(name)) reads.set(name, [])
    reads.get(name).push({ id: node.id, read: node.read })
  })
  const errors = []
  walkSpec(compiled, (node) => {
    const name = codeName(node.ref)
    for (const call of reads.get(name) ?? []) {
      const missing = call.read.filter((source) => !(node.read ?? []).includes(source))
      if (missing.length) {
        errors.push(`[${node.id}] ${name}: in this task ${call.id} called it with read: ${JSON.stringify(call.read)}, here read is ${JSON.stringify(node.read ?? [])} — without it state.${missing[0]} is undefined inside the code; add ${JSON.stringify(missing)} to read (or, if this call really does not need it, the code must not touch state.${missing[0]})`)
        break
      }
    }
  })
  return errors
}

/** task/name（最新版）或 task/name@hash → 草稿条目（带 name、hash）。 */
function findDraft(drafts, ref) {
  const target = parseDraftRef(ref)
  if (!target || !drafts) return null
  const hash = target.hash ?? drafts.latest.get(target.name)
  const entry = hash && drafts.entries.get(`task/${target.name}@${hash}`)
  return entry ? { ...entry, name: target.name, hash } : null
}

function turnKey(sessionId, turn) {
  return `${sessionId}#${turn}`
}

function statusMap(task) {
  return new Map([...task.byId.values()].map((node) => [node.id, node.lastStatus]))
}

/**
 * 黑板形状（I13）：一行一个键，只给类型与结构（列表长度、对象字段），**不给值**。
 * 大模型据此知道"有什么可以 `$键` 引用"，但看不到可以抄成字面量的具体值。
 */
export function blackboardShape(snapshot) {
  const entries = Object.entries(snapshot ?? {})
  if (entries.length === 0) return '（空）'
  return entries.map(([key, value]) => `${key}: ${shapeOf(value)}`).join('\n')
}

const MAX_SHAPE_DEPTH = 3
const MAX_SHAPE_FIELDS = 12

/**
 * 值的形状：`int` / `string` / `list(3) of {id: string, count: int}` / `{pattern: list(3) of string, …}`。
 * @param {object} [options]  { maxDepth, maxFields }：状态来源的形状（data_shapes）要看得更深、字段更全
 */
export function shapeOf(value, depth = 0, { maxDepth = MAX_SHAPE_DEPTH, maxFields = MAX_SHAPE_FIELDS } = {}) {
  const sub = (v) => shapeOf(v, depth + 1, { maxDepth, maxFields })
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'number'
  if (typeof value === 'string') return 'string'
  if (Array.isArray(value)) {
    if (value.length === 0) return 'list(0)'
    if (depth >= maxDepth) return `list(${value.length})`
    const kinds = [...new Set(value.map(sub))]
    const item = kinds.length <= 3 ? kinds.join(' | ') : `${kinds.slice(0, 3).join(' | ')} | …`
    return `list(${value.length}) of ${item}`
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) return '{}'
    if (depth >= maxDepth) return `{${keys.length} 个字段}`
    const fields = keys.slice(0, maxFields).map((k) => `${k}: ${sub(value[k])}`)
    if (keys.length > maxFields) fields.push(`…另 ${keys.length - maxFields} 个字段`)
    return `{${fields.join(', ')}}`
  }
  return typeof value
}
