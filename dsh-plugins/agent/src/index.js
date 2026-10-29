import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { normalizeConfig, steveXRoot } from './config.js'
import { createRuntime } from './runtime.js'
import { Bridge, REFLECT_ONLY_TOOLS, CURATE_ONLY_TOOLS, KNOWLEDGE_TOOLS } from './llm/bridge.js'
import { FactTurns } from './llm/fact_turns.js'
import { FastBridge, FAST_ONLY_TOOLS, FAST_TOOLS } from './llm/fast_bridge.js'
import { loadPrompts } from './llm/prompts.js'
import { createTools } from './tools/index.js'
import { METHODS, READ_METHODS } from './game/index.js'
import { NBT_SOURCES } from './capsules/index.js'

/**
 * steveX agent 插件（DSH / Cordis 适配层，集成方案 §2.3）。
 *
 * 这是本包**唯一**接触 DSH 的文件：
 *   - 组装运行时（mod 连接、注册表、执行器），挂到 `ctx.stevexBt`
 *   - 注册用户命令 `/bt`（集成方案 §7.3），不经过模型回合
 *   - P1：注册大模型工具（src/tools/）与常驻系统提示词（prompts/system/）；
 *     执行器的 expand 请求经 Bridge 用 followup 叫醒任务所属的会话（§4.1）；
 *     绑定了请求的回合只准入该请求的工具，没提交就结束回合 → steer 提醒（§4.4）
 *   - P2：修复类请求（recover / escalate / failed / died）也经 Bridge 交给大模型——只推目录，证据由它用 bt_inspect 自己取；
 *     不属于任何会话的任务（/bt run 的手写树）仍由本地应答器回答
 *   - P3：快树反思批次经 FastBridge 交给专用会话（ctx.agents.create，每批一个）；该会话只准入 fast_* 与接口知识工具
 *   - 插件卸载 / 热重载时停掉执行器、断开 mod
 */
export const name = 'stevex-agent'
export const inject = ['commands', 'tools', 'agents', 'systemPrompt']

/** 请求回合里被拒的查询工具 → 树里的等价写法（守卫的拒绝理由里给出，模型照着改，不用猜）。 */
const IN_TREE = {
  json_query: ' Put the same params into the tree: { "compute": "code/core.json.query", "params": { …same as json_query… }, "writes": { "<key>": "result" } }. To learn the record format first, call data_shapes with sources ["json.<source>"].',
  nbt_query: ' Put the same params into the tree: { "compute": "code/core.nbt.query", "params": { …same as nbt_query… }, "writes": { "<key>": "result" } }. To learn the record format first, call data_shapes with sources ["nbt.<source>"].',
  bt_inspect: ' bt_inspect is only for repair requests (recover / escalate / failed / died). To act on the current state, read it inside the tree: { "cond": "code/…", "read": ["player"] } or { "compute": "code/…", "read": [...] }; to check that earlier steps worked, give them an "expect".',
  mod_query: ' Read state inside the tree: condition code { "cond": "code/…", "read": ["inventory"] } or { "compute": "code/…", "read": [...] } (state arrives as main(params, state)). To learn field names and enum values first, call data_shapes with sources ["state.<source>"].'
}

/** 系统提示词分段的位置：DSH 内置工具说明（≤ 3100）之后、工具 SDK（5000）之前。 */
const SECTION_ORDER = 3200

const USAGE = [
  '/bt status                 当前任务、在飞请求、快树情节',
  '/bt task <指令>             开始一个新任务：叫醒大模型写大纲（规划在一个新回合里进行）',
  '/bt run <tree.json> [目标]  跑一棵手写树（编写格式或执行格式），路径相对 steveX/',
  '/bt pause | resume         暂停 / 继续任务树（快树照跑）',
  '/bt abort [理由]            放弃当前任务（默认中止流程：松键、关容器；不复盘）',
  '/bt reflect                对最近结束的任务手动发复盘请求（任务对象只留到下一个任务开始）',
  '/bt curate                 整理胶囊库：发一个整理请求（看全库清单、下架 / 改说明）；有任务或请求没结束时不发、不排队',
  '/bt fact <陈述>             让大模型查 MC 源码确认一条事实，确认了就带引用写进事实库',
  '/bt facts [词] | check      列出事实库（按词筛）；check 重算所有引用，列出失效的',
  '/bt nodes                  任务树每个节点的状态',
  '/bt fast status            快树当前版本、arm 统计、待反思事件与批次',
  '/bt fast log [n]           快树版本链（补丁理由、来源批次）与最近批次的结局',
  '/bt fast rollback <版本>    回滚：把那一版另存为新的一版',
  '/bt fast reflect           马上把待反思事件打成一批（不等凑够）',
  '/bt fast load <file> [理由] 手动放一版快树（走同样的校验，写进版本链）',
  '/bt capsules              胶囊库条目（内置查询 + 已保存的条件 / Compute / 子树 + 本任务的草稿）'
].join('\n')

export function apply(ctx, rawConfig = {}) {
  // `mod` 只供测试注入假 mod；正常运行按 modUrl 连接
  const { mod, ...rest } = rawConfig
  const config = normalizeConfig(rest)
  const logger = config.logger
  const plannerOn = config.planner.enabled
  // 本地应答器只回答不属于会话的任务（bridge 在 runtime 之后才建，用闭包晚绑定）
  let bridge = null
  const runtime = createRuntime(config, {
    mod,
    responderTypes: plannerOn ? ['recover', 'escalate', 'failed', 'died'] : null,
    responderSkip: plannerOn ? (request) => bridge?.ownsTask(request.taskId) ?? false : null
  })
  const { executor } = runtime

  executor.on('task', (summary) => logger?.info?.(`[bt] task ${summary.taskId}: ${summary.state}${summary.result ? ` (${summary.result})` : ''}`))
  executor.on('error', (error) => logger?.warn?.(`[bt] executor error: ${error.message}`))
  executor.start()

  const planner = plannerOn ? setupPlanner(ctx, config, runtime) : null
  bridge = planner?.bridge ?? null
  const fastBridge = planner?.fastBridge ?? null
  const factTurns = planner?.factTurns ?? null

  ctx.provide('stevexBt', {
    executor,
    bridge,
    fastBridge,
    fast: runtime.fast,
    registry: runtime.registry,
    game: runtime.game,
    library: runtime.library,
    sandbox: runtime.sandbox,
    snapshot: () => executor.snapshot(),
    /**
     * 路由 task handler 用（§6.1）：在人发起的这个回合里开始规划。
     * @returns {{ ok: true, requestId, taskId, text } | { ok: false, error }}  text = 要放进本 step 的请求正文
     */
    planInTurn: ({ agent, turn, instruction }) => {
      if (!bridge) return { ok: false, error: 'stevex-agent: planner is disabled' }
      return bridge.startPlanning({ sessionId: agent.id, instruction, turn })
    },
    /**
     * 路由 fact handler 用（P5 §2.2）：在人发起的这个回合里确认一条 MC 事实。
     * @returns {{ ok: true, text } | { ok: false, error }}  text = 要放进本 step 的正文
     */
    factInTurn: ({ agent, turn, statement }) => {
      if (!factTurns) return { ok: false, error: 'stevex-agent: planner is disabled' }
      return factTurns.start({ sessionId: agent.id, statement, turn })
    }
  })

  ctx.effect(() => ctx.commands.register({
    name: 'bt',
    description: 'steveX 行为树执行器：开始任务、跑手写树、查看 / 暂停 / 放弃任务、查看胶囊库',
    // 声明 input 才能带参数：没有 input 的命令，Web 输入框只在单独输入 "/bt" 时执行，带参数就当普通消息发给模型
    input: { hint: 'status | task <指令> | fact <陈述> | facts [词|check] | run <tree.json> | pause | resume | abort [理由] | reflect | curate | nodes | fast status|log|rollback|reflect|load | capsules' },
    handler: (invocation) => runCommand(executor, invocation.rawInput, {
      library: runtime.library, bridge, sessionId: invocation.agent?.id ?? null, fast: runtime.fast, facts: runtime.facts, factTurns
    })
  }))

  ctx.effect(() => () => {
    bridge?.dispose()
    fastBridge?.dispose()
    runtime.dispose()
  })
}

/** 大模型侧：Bridge、FastBridge、工具、系统提示词、回合监听。 */
function setupPlanner(ctx, config, runtime) {
  const { executor, library, sandbox, registry, game } = runtime
  const logger = config.logger
  const prompts = loadPrompts(config.promptsDir)

  const toMessage = ({ text, summary, source }) => createUserMessage({
    content: [{ type: 'text', text }],
    source: { ...source, form: 'notice', summary }
  })

  const bridge = new Bridge({
    executor, library, sandbox, prompts, registry,
    reflect: config.reflect,
    stats: runtime.stats,
    curate: config.curate,
    runtimeDir: config.runtimeDir,
    maxInvalidAttempts: config.maxInvalidAttempts,
    releaseTask: runtime.releaseTask,
    // 回合绑定了请求 → 本回合只放行该请求的工具（§5.1.2，由守卫执行）；回合结束 / 出错时 releaseTurn 解除
    onBind: (sessionId, turn, names) => bindTurnTools(sessionId, turn, names),
    log: (line) => logger?.info?.(line),
    deliver(sessionId, message) {
      const agent = ctx.agents.get(sessionId)
      if (!agent) return false
      // 执行器的 tick 不属于任何 agent 的驱动链：不要把触发它的那个 agent 带进新回合
      ctx.agents.withoutInitiator(() => agent.followup(toMessage(message)))
      return true
    },
    notify(sessionId, message) {
      ctx.agents.get(sessionId)?.inject(toMessage(message))
    },
    // 自动整理可能在复盘回合中途（bt_reflect_done 里）触发：回合还在 running 时 followup 叫不醒驱动器，等 idle 再发
    deliverIdle(sessionId, message) {
      const agent = ctx.agents.get(sessionId)
      if (!agent) return false
      Promise.resolve(agent.whenIdle?.())
        .then(() => ctx.agents.withoutInitiator(() => agent.followup(toMessage(message))))
        .catch((e) => logger?.warn?.(`[bt] curate delivery failed: ${e?.message ?? e}`))
      return true
    }
  })

  // ── 快树反思（P3 §5）：每批开一个新会话；批次结束后会话留着，日志里能看到大模型怎么想的 ──
  const creatingFast = new Set()
  // 快树反思会话用和 web 端新建会话相同的默认模型。不放进 inject：这一版 Cordis 的对象写法是"服务名 → 配置"，
  // 没有"可选依赖"；没声明就直接读 ctx.agentDefaultModel 会抛错，所以经 reflect 不严格地取，取不到就用 DSH 的缺省
  const defaultModel = () => {
    try {
      return ctx.reflect?.get?.('agentDefaultModel')?.currentSelection?.() ?? null
    } catch {
      return null
    }
  }
  const followup = (sessionId, message) => {
    const agent = ctx.agents.get(sessionId)
    if (!agent) return false
    ctx.agents.withoutInitiator(() => agent.followup(toMessage(message)))
    return true
  }
  const fastBridge = new FastBridge({
    reflector: runtime.fast.reflector,
    versions: runtime.fast.versions,
    monitor: runtime.fast.monitor,
    executor, prompts,
    maxInvalidAttempts: config.maxInvalidAttempts,
    log: (line) => logger?.info?.(line),
    deliver: followup,
    async openSession() {
      const selection = defaultModel()
      const sessionId = `session-${randomUUID()}`
      // agent/created 在 create 返回之前就发出：先登记，监听器据此给它快树会话的可见名单
      creatingFast.add(sessionId)
      try {
        const handle = await ctx.agents.create({
          sessionId,
          ...(selection ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
          meta: { cwd: steveXRoot, agentPreset: config.fast.sessionPreset }
        })
        return handle.agent.id
      } finally {
        creatingFast.delete(sessionId)
      }
    }
  })

  // ── 事实确认回合与"查了源码就要补事实库"（P5 §2 / §7）──
  const factTurns = new FactTurns({
    prompts,
    tools: KNOWLEDGE_TOOLS,
    deliver: followup,
    onBind: (sessionId, turn, names) => bindTurnTools(sessionId, turn, names),
    remind: config.facts.remind,
    log: (line) => logger?.info?.(line),
    describe(sessionId, turn) {
      if (fastBridge.toolsFor(sessionId)) return { kind: 'fast-reflect' }
      const req = bridge.requests.get(bridge.turns.get(`${sessionId}#${turn}`))
      return req ? { kind: req.type, taskId: req.taskId, requestId: req.requestId } : { kind: 'chat' }
    }
  })

  // ── 工具 ──
  const tools = createTools({
    facts: runtime.facts,
    factTurns,
    game, registry, library, bridge,
    stats: runtime.stats,
    methods: METHODS,
    readMethods: READ_METHODS,
    nbt: runtime.nbt,
    nbtSources: NBT_SOURCES,
    json: runtime.json,
    jsonSources: Object.keys(config.jsonSources),
    taskId: () => bridge.currentTaskId(),
    fastBridge,
    maxOutputChars: config.planner.maxOutputChars,
    inspectMaxBytes: config.planner.inspectMaxBytes
  })
  const toolNames = tools.map((tool) => tool.name)
  for (const tool of tools) ctx.effect(() => ctx.tools.register(defineTool(tool)))

  // ── 常驻系统提示词（§6.3）：只放很少变化的东西，不写 {{变量}} ──
  // 命令 / 胶囊清单已删除（2026-10-28）：模型规划时本来就用 command_docs / capsule_search 查，清单是重复的，
  // 且每存一条胶囊都会改写系统提示词
  const sections = [
    ['stevex:identity', prompts.system.identity],
    ['stevex:authoring', prompts.system.authoring]
  ]
  sections.forEach(([sectionName, text], i) => {
    ctx.effect(() => ctx.systemPrompt.section({ name: sectionName, order: SECTION_ORDER + i * 10, text, interpolate: false }))
  })

  // ── 工具准入（§5.1.2 / §5.4）──
  // 两层，分工不同：
  // - restrict（会话级，只在 exclusiveTools 时）：模型看得见什么。整个会话不变——工具清单一变，KV 缓存前缀就断（§6.3）
  // - guard：模型调得动什么。不在名单里的调用一律拒绝；绑定了请求的回合按该请求的名单（I13）
  // 回合级只用 guard、不再 restrict：DSH 在 agent/pre-step 之前就组装好了本步的工具清单，pre-step 里 restrict
  // 要到下一步才生效（首测日志：每个请求回合第 1 步仍是全集），还让清单每个请求回合变两次。
  // restrict 也挡不住 agent 自己那一层注册的工具（预设 delegation 组里延迟注册的 subagent），所以执法靠 guard。
  // restrict 的名字必须是已注册的全局工具；没装的内置工具（如 todo_write）跳过
  const allowList = (names) => [...new Set([...names, ...config.planner.extraTools])].filter((n) => ctx.tools.get(n))
  const agentRestrictions = new Map() // sessionId → disposer
  const turnTools = new Map() // sessionId → { turn, allowed: Set }：绑定了请求的那个回合放行的工具
  // 普通会话的名单里没有 fast_*：它们只在快树会话里能用
  const sessionAllowed = new Set([...toolNames.filter((n) => !FAST_ONLY_TOOLS.includes(n)), ...config.planner.extraTools])
  // 同一回合绑定两次（路由同时选中 fact 与 task handler）→ 取并集（P5 §2.2）
  function bindTurnTools(sessionId, turn, names) {
    const same = turnTools.get(sessionId)?.turn === turn ? turnTools.get(sessionId).allowed : []
    turnTools.set(sessionId, { turn, allowed: new Set([...same, ...names, ...config.planner.extraTools]) })
  }
  const releaseTurn = (sessionId, turn) => {
    if (turnTools.get(sessionId)?.turn === turn) turnTools.delete(sessionId)
  }
  ctx.effect(() => ctx.tools.guard((exec) => {
    const sessionId = exec.agent?.id
    if (!sessionId) return undefined
    const fastTools = fastBridge.toolsFor(sessionId)
    if (fastTools) {
      if (fastTools.includes(exec.name) || config.planner.extraTools.includes(exec.name)) return undefined
      return `steveX: ${exec.name} is not available in a fast-tree reflection session (allowed: ${fastTools.join(', ')})`
    }
    if (FAST_ONLY_TOOLS.includes(exec.name)) return `steveX: ${exec.name} is only for fast-tree reflection sessions`
    const turn = turnTools.get(sessionId)
    if (REFLECT_ONLY_TOOLS.includes(exec.name) && !turn?.allowed.has(exec.name)) return `steveX: ${exec.name} is only for answering a task review (reflect) request`
    if (CURATE_ONLY_TOOLS.includes(exec.name) && !turn?.allowed.has(exec.name)) return `steveX: ${exec.name} is only for answering a capsule library curation request (/bt curate)`
    const allowed = turn?.allowed ?? (config.planner.exclusiveTools ? sessionAllowed : null)
    if (!allowed || allowed.has(exec.name)) return undefined
    if (turn && factTurns.isCheck(sessionId, turn.turn) && !bridge.turns.has(`${sessionId}#${turn.turn}`)) {
      return `steveX: ${exec.name} is not available while confirming an MC fact (allowed now: ${[...turn.allowed].join(', ')})`
    }
    return turn
      ? `steveX: ${exec.name} is not available while answering an executor request (allowed now: ${[...turn.allowed].join(', ')}); the tree must read the data itself (I13).${IN_TREE[exec.name] ?? ''}`
      : `steveX: ${exec.name} is not available in a steveX session`
  }))

  if (config.planner.exclusiveTools) {
    ctx.on('agent/created', ({ agent }) => {
      safely(agentRestrictions.get(agent.id))
      const allow = creatingFast.has(agent.id) ? allowList(FAST_TOOLS) : allowList(toolNames.filter((n) => !FAST_ONLY_TOOLS.includes(n)))
      agentRestrictions.set(agent.id, allow.length ? agent.ctx.tools.restrict({ allow }) : null)
    })
  }
  ctx.on('agent/disposed', ({ agent }) => {
    agentRestrictions.delete(agent.id)
    turnTools.delete(agent.id)
    factTurns.onSessionClosed(agent.id)
    fastBridge.onSessionClosed(agent.id)
    bridge.onSessionClosed(agent.id)
  })

  // ── 回合：认出执行器的请求（绑定即按请求放行工具）；没提交就提醒（§4.4）；出错就重试 ──
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    bridge.onPreStep({ sessionId: payload.agent.id, turn: payload.turn, step: payload.step, messages: decision.messages })
    factTurns.onPreStep({ sessionId: payload.agent.id, turn: payload.turn, step: payload.step, messages: decision.messages })
    return decision
  })

  // 先问请求（快树批次 / 任务请求）：还没交 → 只提醒请求；请求没事了再看"查了源码没写事实"（P5-D10）
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const fast = fastBridge.onTurnStopping({ sessionId: agent.id, turn })
    const result = fast === undefined ? bridge.onTurnStopping({ sessionId: agent.id, turn }) : null
    const steer = fast?.steer ?? result?.steer ?? factTurns.onTurnStopping({ sessionId: agent.id, turn })
    if (steer) {
      agent.steer(toMessage(steer))
      return
    }
    factTurns.endTurn(agent.id, turn)
    if (fast === undefined) releaseTurn(agent.id, turn)
  })

  // 出错结束的回合不经过 turn-stopping（首测：模型返回坏的工具参数 JSON → MALFORMED_RESPONSE），
  // 不接住的话请求会一直等、挡住后面的任务。重试用 followup 开新回合，新回合按消息来源重新绑定。
  // agent/error 发出时出错的回合还在 running：此时 followup 只进收件箱、叫不醒驱动器（loop 的 wakeDriver
  // 在非 idle 阶段直接丢掉这次唤醒），回合结束后也没人再开新回合——task-20261027122523-1 就停在这里。
  // 所以等 agent 回到 idle 再 followup；不能在监听器里 await（回合要等监听器返回才能结束）。
  const retryWhenIdle = (agent, message) => {
    Promise.resolve(agent.whenIdle?.())
      .then(() => ctx.agents.withoutInitiator(() => agent.followup(toMessage(message))))
      .catch((e) => logger?.warn?.(`[bt] retry after turn error failed: ${e?.message ?? e}`))
  }
  ctx.on('agent/error', ({ agent, turn, error }) => {
    factTurns.endTurn(agent.id, turn)
    const fast = fastBridge.onTurnError({ sessionId: agent.id, turn, error })
    if (fast !== undefined) {
      if (fast?.retry) retryWhenIdle(agent, fast.retry)
      return
    }
    releaseTurn(agent.id, turn)
    const result = bridge.onTurnError({ sessionId: agent.id, turn, error })
    if (result?.retry) retryWhenIdle(agent, result.retry)
  })

  ctx.effect(() => () => {
    for (const dispose of agentRestrictions.values()) safely(dispose)
    agentRestrictions.clear()
    turnTools.clear()
  })

  return { bridge, fastBridge, factTurns }
}

function safely(dispose) {
  try {
    dispose?.()
  } catch {
    // 所属 agent 已经销毁时它的限制已随之解除
  }
}

export function runCommand(executor, rawInput, { library = null, bridge = null, sessionId = null, fast = null, facts = null, factTurns = null } = {}) {
  const [sub = 'status', ...rest] = rawInput.trim().split(/\s+/).filter(Boolean)
  try {
    switch (sub) {
      case 'status':
        return { kind: 'success', text: formatStatus(executor.snapshot(), bridge) }
      case 'task': {
        if (!bridge) return { kind: 'error', text: '大模型侧没有启用（planner.enabled = false）' }
        if (!sessionId) return { kind: 'error', text: '/bt task 只能在会话里用' }
        const instruction = rawInput.trim().replace(/^task\s*/, '')
        if (!instruction) return { kind: 'error', text: `用法：\n${USAGE}` }
        const result = bridge.startPlanning({ sessionId, instruction })
        if (!result.ok) return { kind: 'error', text: result.error }
        return { kind: 'success', text: `规划请求 ${result.requestId}（任务 ${result.taskId}）已发给大模型` }
      }
      case 'run': {
        const [file, ...goalWords] = rest
        if (!file) return { kind: 'error', text: `用法：\n${USAGE}` }
        const full = path.isAbsolute(file) ? file : path.resolve(steveXRoot, file)
        const tree = JSON.parse(fs.readFileSync(full, 'utf8'))
        const taskId = executor.startTask({
          tree: tree.root ?? tree,
          goal: goalWords.join(' ') || tree.goal || path.basename(file),
          blackboard: tree.blackboard ?? {}
        })
        return { kind: 'success', text: `任务 ${taskId} 已开始（${full}）` }
      }
      case 'pause':
        executor.pauseTask()
        return { kind: 'success', text: '任务树已暂停，快树照跑' }
      case 'resume':
        executor.resumeTask()
        return { kind: 'success', text: '任务树已继续' }
      case 'abort': {
        const reason = rest.join(' ') || 'aborted by /bt abort'
        if (bridge?.planning && !bridge.activeTask()) {
          const result = bridge.abort({ sessionId: null, reason })
          return { kind: result.ok ? 'success' : 'error', text: result.ok ? `规划请求 ${result.requestId} 已放弃` : result.error }
        }
        executor.abortTask(reason)
        return { kind: 'success', text: '任务已放弃' }
      }
      case 'reflect': {
        if (!bridge) return { kind: 'error', text: '大模型侧没有启用（planner.enabled = false）' }
        if (!sessionId) return { kind: 'error', text: '/bt reflect 只能在会话里用' }
        const result = bridge.reflectLast({ sessionId })
        return result.ok ? { kind: 'success', text: `复盘请求 ${result.requestId} 已发给大模型` } : { kind: 'error', text: result.error }
      }
      case 'curate': {
        if (!bridge) return { kind: 'error', text: '大模型侧没有启用（planner.enabled = false）' }
        if (!sessionId) return { kind: 'error', text: '/bt curate 只能在会话里用' }
        const result = bridge.startCurate({ sessionId, trigger: 'manual' })
        return result.ok ? { kind: 'success', text: `整理请求 ${result.requestId} 已发给大模型` } : { kind: 'error', text: result.error }
      }
      case 'fact': {
        if (!factTurns) return { kind: 'error', text: '大模型侧没有启用（planner.enabled = false）' }
        if (!sessionId) return { kind: 'error', text: '/bt fact 只能在会话里用' }
        const statement = rawInput.trim().replace(/^fact\s*/, '')
        if (!statement) return { kind: 'error', text: `用法：\n${USAGE}` }
        const result = factTurns.start({ sessionId, statement })
        return result.ok ? { kind: 'success', text: '事实确认已发给大模型' } : { kind: 'error', text: result.error }
      }
      case 'facts':
        return runFactsCommand(rest, facts)
      case 'fast':
        return runFastCommand(executor, rest, fast)
      case 'capsules': {
        if (!library) return { kind: 'error', text: '没有配置胶囊库' }
        const rows = library.list()
        if (rows.length === 0) return { kind: 'success', text: '胶囊库是空的' }
        return { kind: 'success', text: rows.map((r) => `${r.ref.padEnd(40)} ${r.kind.padEnd(9)} ${r.locked ? 'locked ' : ''}${r.draft ? 'draft ' : ''}${r.description}`).join('\n') }
      }
      case 'nodes': {
        const snap = executor.snapshot()
        if (!snap.task) return { kind: 'success', text: '没有任务' }
        return { kind: 'success', text: snap.task.nodes.map(formatNode).join('\n') }
      }
      default:
        return { kind: 'error', text: `未知子命令 "${sub}"。\n${USAGE}` }
    }
  } catch (error) {
    return { kind: 'error', text: error.message }
  }
}

/** /bt facts [词] | check（P5 §10）。 */
function runFactsCommand(args, facts) {
  if (!facts) return { kind: 'error', text: '没有配置事实库' }
  if (args[0] === 'check') {
    const total = facts.store.list().length
    const bad = facts.store.check()
    if (bad.length === 0) return { kind: 'success', text: `${total} 条事实，引用全部有效` }
    return { kind: 'success', text: [`${total} 条事实，${bad.length} 处引用失效：`, ...bad.map((b) => `  ${b.name}  ${b.file}:${b.lines[0]}-${b.lines[1]}  ${b.status}`)].join('\n') }
  }
  const { total, facts: rows } = facts.store.search({ query: args.join(' '), limit: 50 })
  if (total === 0) return { kind: 'success', text: args.length ? '没有匹配的事实' : '事实库是空的' }
  const lines = rows.map((f) => `${f.name}（rev ${f.rev}）：${f.statement}\n    ${f.refs.map((r) => `${r.file}:${r.lines[0]}-${r.lines[1]}${r.stale ? `（${r.stale}）` : ''}`).join(', ')}`)
  if (total > rows.length) lines.push(`…共 ${total} 条`)
  return { kind: 'success', text: lines.join('\n') }
}

/** /bt fast …（P3 §9）。 */
function runFastCommand(executor, args, fast) {
  if (!fast) return { kind: 'error', text: '快树版本链没有启用' }
  const { versions, monitor, reflector } = fast
  let [sub = 'status', ...rest] = args
  // 旧写法 /bt fast <file.json> = load
  if (sub.endsWith('.json')) [sub, rest] = ['load', [sub, ...rest]]
  switch (sub) {
    case 'status': {
      const snap = executor.snapshot().fast
      const state = reflector.status()
      const lines = [`快树 v${snap?.version ?? 0}${snap?.next ? `（v${snap.next} 等情节结束后换上）` : ''}，版本链最新 v${versions.latest()}`]
      const stats = monitor.armStats(snap?.version ?? 0)
      if (stats.length === 0) lines.push('  （没有 arm）')
      for (const row of stats) lines.push(`  ${row.arm}：命中 ${row.hits}，掉血事件 ${row.harmed}，失败 ${row.failed}${row.lastHitAt ? `，最近 ${row.lastHitAt}` : ''}`)
      lines.push(`待反思事件：${state.pending.length ? state.pending.join(', ') : '无'}`)
      lines.push(`批次：在飞 ${state.running.join(', ') || '无'}；排队 ${state.queued.join(', ') || '无'}${reflector.enabled() ? '' : '（没有开反思：只记事件）'}`)
      if (snap?.episode) lines.push(`情节："${snap.episode.name}"（${snap.episode.phase}）`)
      return { kind: 'success', text: lines.join('\n') }
    }
    case 'log': {
      const n = Number(rest[0]) || 10
      const lines = versions.list(n).map((m) => `v${m.version}  ${m.by}${m.batchId ? ` ${m.batchId}` : ''}${m.target !== undefined ? ` ← v${m.target}` : ''}  ${m.createdAt ?? ''}\n    ${m.reason ?? ''}`)
      if (lines.length === 0) lines.push('版本链是空的（v0 = 空快树）')
      const recent = reflector.status().recent
      if (recent.length) {
        lines.push('最近的批次：')
        for (const b of recent) lines.push(`  ${b.batchId} ${b.outcome}${b.version ? ` → v${b.version}` : ''}（${b.events.join(', ')}）：${b.reason ?? ''}`)
      }
      return { kind: 'success', text: lines.join('\n') }
    }
    case 'rollback': {
      const target = Number(rest[0])
      if (!Number.isInteger(target)) return { kind: 'error', text: '用法：/bt fast rollback <版本号>' }
      const result = versions.rollback(target, rest.slice(1).join(' ') || null)
      if (!result.ok) return { kind: 'error', text: result.errors.join('\n') }
      return { kind: 'success', text: [`已回滚：v${target} 另存为 v${result.version}`, ...result.diff].join('\n') }
    }
    case 'reflect': {
      if (!reflector.enabled()) return { kind: 'error', text: '没有开反思（大模型侧没启用或 fast.reflect = false）：事件只记录' }
      monitor.flush()
      const batch = reflector.flush()
      if (!batch && reflector.status().pending.length) return { kind: 'success', text: `批次 ${reflector.status().running.join(', ')} 还在反思；它结束后，待反思事件（${reflector.status().pending.join(', ')}）自动打成下一批` }
      if (!batch) return { kind: 'success', text: '没有待反思的事件' }
      return { kind: 'success', text: `批次 ${batch.batchId}（${batch.events.join(', ')}）${batch.state === 'running' ? '已开始反思' : '已排队'}` }
    }
    case 'load': {
      const [file, ...reason] = rest
      if (!file) return { kind: 'error', text: '用法：/bt fast load <file.json> [理由]' }
      const full = path.isAbsolute(file) ? file : path.resolve(steveXRoot, file)
      const tree = JSON.parse(fs.readFileSync(full, 'utf8'))
      const result = versions.loadManual(tree, reason.join(' ') || `手动装载 ${path.basename(file)}`)
      if (!result.ok) return { kind: 'error', text: `快树不合法：\n${result.errors.join('\n')}` }
      return { kind: 'success', text: [`快树 v${result.version}：${result.arms.join(' → ') || '（没有 arm）'}（${full}）`, ...result.diff].join('\n') }
    }
    default:
      return { kind: 'error', text: `未知子命令 "fast ${sub}"。\n${USAGE}` }
  }
}

function formatStatus(snap, bridge) {
  const lines = []
  const plan = bridge?.planning ? bridge.requests.get(bridge.planning) : null
  if (plan) lines.push(`规划中：请求 ${plan.requestId}（任务 ${plan.taskId}）— ${plan.instruction}`)
  for (const r of bridge?.reflecting?.() ?? []) lines.push(`复盘中：请求 ${r.requestId}（任务 ${r.taskId}）；已存 ${r.saved.join(', ') || '无'}`)
  for (const r of bridge?.curating?.() ?? []) lines.push(`整理中：请求 ${r.requestId}（${r.trigger === 'auto' ? '自动' : '手动'}）；已改 ${r.changes} 处`)
  if (!snap.task) lines.push('任务：无')
  else {
    const t = snap.task
    lines.push(`任务 ${t.taskId}：${t.state}（树 v${t.version}）${t.goal ? ` — ${t.goal}` : ''}`)
    if (t.pending) lines.push(`  在飞请求：${t.pending.requestId} ${t.pending.type}${t.pending.stale ? '（已过期）' : ''}`)
    if (t.result) lines.push(`  结果：${t.result}`)
    const running = t.nodes.filter((n) => n.status === 'RUNNING' && !['Sequence', 'Selector', 'Match', 'Repeat'].includes(n.type))
    if (running.length) lines.push(`  正在执行：${running.map((n) => n.name ?? n.id).join(', ')}`)
  }
  if (snap.fast) {
    lines.push(`快树 v${snap.fast.version}（${snap.fast.arms.length} 个 arm）：${snap.fast.episode ? `情节"${snap.fast.episode.name}"（${snap.fast.episode.phase}）` : '空闲'}`)
  }
  return lines.join('\n')
}

function formatNode(node) {
  const extra = node.cursor !== undefined && node.cursor !== null ? ` cursor=${node.cursor}` : ''
  const err = node.error ? ` — ${node.error}` : ''
  return `${node.id.padEnd(14)} ${node.type.padEnd(16)} ${String(node.status ?? '-').padEnd(15)}${node.name ?? ''}${extra}${err}`
}
