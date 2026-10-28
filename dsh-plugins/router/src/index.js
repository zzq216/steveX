import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRouter } from './domain/router.js'
import { createTurnScope } from './domain/turn_scope.js'
import { defaultSlots, resolveUnsure } from './domain/slots.js'
import { createRouterProvider } from './provider.js'
import { createHandlers, userText } from './handlers.js'
import { normalizeConfig } from './config.js'
import { loadPromptBlocks, renderTemplate } from './prompts.js'
import { createLlmFillSlots, historyLines } from './llm_slots.js'
import { createRouterLog, routeRecord } from './router_log.js'

/**
 * steveX 路由插件（DSH / Cordis 适配层，设计文档 §17）。
 *
 * 这是本包**唯一**接触 DSH 的文件：
 *   - 把纯逻辑挂到 `ctx.router` 服务；
 *   - 监听 `agent/pre-step`（每个 step 触发，只在 step=1、且本 step 有人说的话时填槽）；
 *     handler 返回的 `prompt`（以及降级 / 追问上限的说明）合成一条 `stevex-router` 来源的消息追加进本 step；
 *   - llm 模式下用 `ctx.llm` 发一次独立的短调用填槽（不进会话历史，只进路由日志；阶段 B 细则 §3 / §5）；
 *   - 监听 `agent/turn-stopping`，统一清空 turn scope（§17.5.2）。
 *
 * 执行器发来的请求（来源 `stevex-bt`）已经知道自己是什么，不经路由（集成方案 I3 / §4.1）。
 *
 * 注册的提示词/工具/监听都由 Cordis 的作用域管理，插件卸载即回滚；
 * 回合级资源走 handler 上报的 turn scope，turn 结束无条件清空。
 */

export const name = 'stevex-router'
export const inject = []

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const router = createRouter()
  // Cordis 的 ctx.get 读可选服务（不进 inject）；测试夹具没有 get，直接读属性
  const optional = (service) => (typeof ctx.get === 'function' ? ctx.get(service) : ctx[service]) ?? null
  // agent 插件是可选依赖：没装时 task / fact handler 报错（onFailure: continue），其余照常
  const handlers = createHandlers({ enabled: config.enabledHandlers, planner: () => optional('stevexBt') })

  for (const handler of handlers) router.registerHandler(handler)

  // 提示词缺失 / 为空 / 仍带占位标记 = 拒绝上线（设计方案 §6）
  const prompts = loadPromptBlocks(config.provider.promptsDir)
  const llmMode = config.provider.mode === 'llm'
  const provider = createRouterProvider({
    ...config.provider,
    fillSlots: llmMode ? (config.provider.fillSlots ?? createLlmFillSlots({ prompts, complete })) : null
  })
  const routerLog = createRouterLog(config.logDir)

  /** turn id → TurnScope */
  const scopes = new Map()
  /** turn id → 最近一次路由结果（调试/测试） */
  const pending = new Map()
  /** 会话 → 连续追问次数 */
  const clarifyCounts = new Map()
  /** 会话 → 上一次追问 { question, userText }：下一条消息填槽时放进 [CONTEXT]（细则 D5） */
  const clarifyState = new Map()

  const service = {
    registerHandler: router.registerHandler,
    decide: router.decide,
    run: router.run,
    handlerIds: router.handlerIds,
    turnScope: (turnId) => scopes.get(turnId) ?? null,
    lastResult: (turnId) => pending.get(turnId) ?? null
  }
  ctx.provide('router', service)

  function scopeFor(turnId) {
    let scope = scopes.get(turnId)
    if (!scope) {
      scope = createTurnScope({ label: `turn:${turnId}` })
      scopes.set(turnId, scope)
    }
    return scope
  }

  function agentKey(agent) {
    return agent?.session?.id ?? agent?.id ?? 'default'
  }

  function buildContext(payload, clarifyCount) {
    return {
      turn: scopeFor(payload.turn),
      turnId: payload.turn,
      agent: payload.agent,
      messages: payload.messages,
      clarifyCount,
      config,
      logger: config.logger,
      prompts
    }
  }

  /**
   * 一次独立的模型调用（细则 §5）：默认跟会话同一个 provider/model、该模型支持的最低推理档。
   * 不写进会话历史；人取消回合或超时都经 signal 中止。
   */
  async function complete({ system, user, signal, agent }) {
    const llm = optional('llm')
    if (typeof llm?.prepareCall !== 'function') throw new Error('the llm service is not available')
    const route = config.provider.route
      ?? (agent?.options?.provider && agent?.options?.model ? { provider: agent.options.provider, model: agent.options.model } : null)
    if (!route) throw new Error('no model route: the session has no provider/model (set provider.route)')
    const effort = config.provider.reasoningEffort
    const call = await llm.prepareCall({ ...route, maxTokens: config.provider.maxTokens }, signal, (controls, model) => {
      const chosen = effort ?? model?.reasoning?.efforts?.[0]?.id
      return chosen === undefined ? controls : { ...controls, reasoningEffort: chosen }
    })
    const sessionId = agent?.session?.id
    const assembler = new BlockAssembler()
    const stream = call.stream({
      ...call.config,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      ...(sessionId === undefined ? {} : { sessionId }),
      signal
    })
    for await (const chunk of stream) assembler.push(chunk)
    signal?.throwIfAborted?.()
    const finish = assembler.finish
    if (finish?.kind === 'error' || finish?.kind === 'aborted') throw new Error(finish.failure?.message ?? `model call ${finish.kind}`)
    const text = assembler.blocks().filter((block) => block.type === 'text').map((block) => block.text).join('')
    return { text, model: `${route.provider}/${route.model}` }
  }

  function historyOf(agent, messages) {
    if (config.provider.contextMessages === 0) return []
    let history = []
    try {
      history = agent?.session?.deriveMessages?.() ?? []
    } catch (error) {
      config.logger?.warn?.(`[stevex-router] could not read session history: ${error?.message ?? String(error)}`)
    }
    return historyLines(history, {
      limit: config.provider.contextMessages,
      chars: config.provider.contextChars,
      exclude: new Set((messages ?? []).map((message) => message?.id).filter(Boolean))
    })
  }

  /** 人取消回合 → 路由调用一起停；另加硬超时。 */
  function routeSignal(turnSignal) {
    const timeout = AbortSignal.timeout(config.provider.timeoutMs)
    return turnSignal instanceof AbortSignal ? AbortSignal.any([turnSignal, timeout]) : timeout
  }

  async function route(payload) {
    const key = agentKey(payload.agent)
    const text = userText(payload.messages)
    const previous = clarifyState.get(key) ?? null
    const trace = {}
    const started = Date.now()
    let slotJson = await provider.fillSlots({
      turn: payload.turn,
      step: payload.step,
      messages: payload.messages,
      agent: payload.agent,
      prompts,
      userText: text,
      history: llmMode ? historyOf(payload.agent, payload.messages) : [],
      pending: previous,
      signal: llmMode ? routeSignal(payload.signal) : undefined,
      trace
    })
    trace.latencyMs = Date.now() - started

    // 追问上限（细则 D6）：已经连续追问 clarifyMaxTurns 次仍判不出 → 不再追问，拿不准的按 none 走
    let notice = null
    let selected = router.decide(slotJson)
    let clarifyCount = clarifyCounts.get(key) ?? 0
    if (selected.exclusive && clarifyCount >= config.clarifyMaxTurns) {
      slotJson = resolveUnsure(selected.slots)
      notice = { kind: 'clarify-limit' }
      selected = router.decide(slotJson)
    }
    if (selected.exclusive) {
      clarifyCount += 1
      clarifyCounts.set(key, clarifyCount)
    } else {
      clarifyCount = 0
      clarifyCounts.delete(key)
      clarifyState.delete(key)
    }

    const result = await router.run(slotJson, buildContext(payload, clarifyCount))
    if (selected.exclusive) {
      const question = result.parts.find((part) => part.id === 'clarify')?.result?.question ?? ''
      clarifyState.set(key, { question, userText: previous ? `${previous.userText}\n${text}` : text })
    }
    return finish(payload, { slotJson, result, notice, trace })
  }

  /** 路由调用失败（超时 / 模型不可用 / 两次输出都不合法）→ 按全 none 走 default，注入说明（细则 D7）。 */
  async function degrade(payload, error) {
    const reason = describeFailure(error)
    config.logger?.warn?.(`[stevex-router] routing failed: ${error?.message ?? String(error)}; treating as ordinary conversation`)
    const key = agentKey(payload.agent)
    clarifyCounts.delete(key)
    clarifyState.delete(key)
    const slotJson = defaultSlots()
    slotJson.reason = `router failure: ${error?.message ?? String(error)}`
    const result = await router.run(slotJson, buildContext(payload, 0))
    return finish(payload, { slotJson, result, notice: { kind: 'degraded', reason }, degraded: reason })
  }

  function describeFailure(error) {
    if (error?.name === 'TimeoutError') return `路由超时（${Math.round(config.provider.timeoutMs / 1000)} 秒）`
    if (error?.code === 'ROUTER_OUTPUT_INVALID') return '路由模型两次输出都不合法'
    const message = String(error?.message ?? error)
    return `路由调用失败：${message.length > 120 ? `${message.slice(0, 119)}…` : message}`
  }

  function finish(payload, { slotJson, result, notice, trace = {}, degraded = null }) {
    pending.set(payload.turn, { slotJson, ...result, notice })
    const handlerIds = result.decision.order.join(',') || 'none'
    config.logger?.info?.(
      `[stevex-router] turn=${payload.turn} step=${payload.step} handlers=${handlerIds} `
      + `parts=${result.parts.length} errors=${result.errors.length} clarify=${clarifyCounts.get(agentKey(payload.agent)) ?? 0}`
      + `${notice ? ` notice=${notice.kind}` : ''}${trace.latencyMs !== undefined ? ` ${trace.latencyMs}ms` : ''}`
    )
    try {
      routerLog.write(agentKey(payload.agent), routeRecord({
        sessionId: agentKey(payload.agent), turn: payload.turn, mode: config.provider.mode, trace, slotJson, result, notice: notice?.kind ?? null, degraded
      }))
    } catch (error) {
      config.logger?.warn?.(`[stevex-router] could not write the routing log: ${error?.message ?? String(error)}`)
    }
    return { result, notice }
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (payload.signal?.aborted) return decision
    // agent/pre-step 每个 step 都会触发；只在本 turn 的第一个 step 填槽。
    if (payload.step !== 1) return decision
    // 只对人说的话填槽：本 step 只有执行器 followup / 其他插件的消息时不路由
    const messages = decision.messages ?? []
    if (messages.length > 0 && !messages.some((message) => message?.source?.kind === 'user')) return decision

    let outcome = null
    try {
      outcome = await route(payload)
    } catch (error) {
      // 人取消了回合：不降级、不注入
      if (payload.signal?.aborted) return decision
      try {
        outcome = await degrade(payload, error)
      } catch (fallbackError) {
        config.logger?.warn?.(`[stevex-router] degraded routing failed: ${fallbackError?.message ?? String(fallbackError)}`)
      }
    }
    return withHandlerPrompts(decision, outcome)
  }, { prepend: true })

  /** handler 给出的模型可见正文（与降级 / 追问上限的说明）→ 本 step 末尾的一条消息（随会话日志落盘，可回放）。 */
  function withHandlerPrompts(decision, outcome) {
    const parts = (outcome?.result?.parts ?? []).filter((part) => typeof part.result?.prompt === 'string' && part.result.prompt)
    const notice = outcome?.notice
      ? renderTemplate(prompts.defaultSections[outcome.notice.kind], { reason: outcome.notice.reason ?? '' })
      : null
    const texts = [...(notice ? [notice] : []), ...parts.map((part) => part.result.prompt)]
    if (texts.length === 0) return decision
    const message = createUserMessage({
      content: [{ type: 'text', text: texts.join('\n\n') }],
      source: {
        kind: 'stevex-router',
        handlers: parts.map((part) => part.id),
        ...(outcome.notice ? { notice: outcome.notice.kind } : {})
      }
    })
    return { ...decision, messages: [...(decision.messages ?? []), message] }
  }

  ctx.on('agent/turn-stopping', async ({ turn }) => {
    const scope = scopes.get(turn)
    pending.delete(turn)
    if (!scope) return
    scopes.delete(turn)

    const { count, errors } = await scope.disposeAll()
    if (errors.length > 0) {
      config.logger?.warn?.(
        `[stevex-router] turn=${turn} turn scope disposed: ${count} disposer(s), ${errors.length} failure(s)`
      )
    } else {
      config.logger?.info?.(`[stevex-router] turn=${turn} turn scope disposed: ${count} disposer(s)`)
    }
  })

  // 插件卸载/热重载：兜底清空仍在内存里的 turn scope（正常路径由 turn-stopping 清）。
  ctx.effect(() => () => {
    const tasks = [...scopes.values()].map((scope) => scope.disposeAll())
    scopes.clear()
    pending.clear()
    clarifyCounts.clear()
    clarifyState.clear()
    return Promise.all(tasks).then(() => undefined)
  })
}
