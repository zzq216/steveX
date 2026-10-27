import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRouter } from './domain/router.js'
import { createTurnScope } from './domain/turn_scope.js'
import { defaultSlots } from './domain/slots.js'
import { createRouterProvider } from './provider.js'
import { createHandlers } from './handlers.js'
import { normalizeConfig } from './config.js'
import { loadPromptBlocks } from './prompts.js'

/**
 * steveX 路由插件（DSH / Cordis 适配层，设计文档 §17）。
 *
 * 这是本包**唯一**接触 DSH 的文件：
 *   - 把纯逻辑挂到 `ctx.router` 服务；
 *   - 监听 `agent/pre-step`（每个 step 触发，只在 step=1、且本 step 有人说的话时填槽）；
 *     handler 返回的 `prompt` 作为一条 `stevex-router` 来源的消息追加进本 step；
 *   - 监听 `agent/turn-stopping`，统一清空 turn scope（§17.5.2）。
 *
 * 执行器发来的请求（来源 `stevex-bt`）已经知道自己是什么，不经路由（集成方案 I3 / §4.1）。
 *
 * 注册的提示词/工具/监听都由 Cordis 的作用域管理，插件卸载即回滚；
 * 回合级资源走 handler 上报的 turn scope，turn 结束无条件清空。
 *
 * 阶段 A：provider 用 stub；P1 起 `task` handler 是真实实现（经 steveX agent 插件的 planInTurn），
 * 其余 handler 与 llm provider 的内容在阶段 B。
 */

export const name = 'stevex-router'
export const inject = []

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const router = createRouter({ clarifyThreshold: config.confidenceThreshold })
  const provider = createRouterProvider(config.provider)
  // agent 插件是可选依赖：没装时 task handler 报错（onFailure: continue），其余照常
  const handlers = createHandlers({
    enabled: config.enabledHandlers,
    // Cordis 的 ctx.get 读可选服务（不进 inject）；测试夹具没有 get，直接读属性
    planner: () => (typeof ctx.get === 'function' ? ctx.get('stevexBt') : ctx.stevexBt) ?? null
  })

  for (const handler of handlers) router.registerHandler(handler)

  // llm 模式下先校验提示词内容；缺失/为空/仍带占位标记 = 拒绝上线。
  let prompts = null
  if (config.provider.mode === 'llm' && config.provider.promptsDir) {
    prompts = loadPromptBlocks(config.provider.promptsDir)
  }

  /** turn id → TurnScope */
  const scopes = new Map()
  /** turn id → 最近一次路由结果（调试/测试） */
  const pending = new Map()
  /** agent → 连续追问次数（追问上限在阶段 B 的话术里使用） */
  const clarifyCounts = new Map()

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

  async function route(payload) {
    const providerContext = {
      turn: payload.turn,
      step: payload.step,
      messages: payload.messages,
      agent: payload.agent,
      prompts
    }
    const slotJson = await provider.fillSlots(providerContext)

    const key = agentKey(payload.agent)
    const selected = router.decide(slotJson)
    let clarifyCount = clarifyCounts.get(key) ?? 0
    if (selected.exclusive) {
      clarifyCount += 1
      clarifyCounts.set(key, clarifyCount)
    } else {
      clarifyCounts.delete(key)
    }

    const result = await router.run(slotJson, buildContext(payload, clarifyCount))
    pending.set(payload.turn, { slotJson, ...result })

    const handlerIds = result.decision.order.join(',') || 'none'
    config.logger?.info?.(
      `[stevex-router] turn=${payload.turn} step=${payload.step} handlers=${handlerIds} `
      + `parts=${result.parts.length} errors=${result.errors.length} clarify=${clarifyCount}`
    )

    return result
  }

  async function clarifyFallback(payload, error) {
    config.logger?.warn?.(
      `[stevex-router] routing failed: ${error?.message ?? String(error)}; falling back to clarify`
    )
    const fallback = defaultSlots()
    fallback.reason = `router failure: ${error?.message ?? String(error)}`
    fallback.clarification = '路由失败，请重试或换个说法。'
    clarifyCounts.set(agentKey(payload.agent), 1)
    const result = await router.run(fallback, buildContext(payload, 1))
    pending.set(payload.turn, { slotJson: fallback, ...result })
    return result
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

    let result = null
    try {
      result = await route(payload)
    } catch (error) {
      try {
        result = await clarifyFallback(payload, error)
      } catch (fallbackError) {
        config.logger?.warn?.(
          `[stevex-router] clarify fallback failed: ${fallbackError?.message ?? String(fallbackError)}`
        )
      }
    }
    return withHandlerPrompts(decision, result)
  }, { prepend: true })

  /** handler 给出的模型可见正文 → 本 step 末尾的一条消息（随会话日志落盘，可回放）。 */
  function withHandlerPrompts(decision, result) {
    const parts = (result?.parts ?? []).filter((part) => typeof part.result?.prompt === 'string' && part.result.prompt)
    if (parts.length === 0) return decision
    const message = createUserMessage({
      content: [{ type: 'text', text: parts.map((part) => part.result.prompt).join('\n\n') }],
      source: { kind: 'stevex-router', handlers: parts.map((part) => part.id) }
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
    return Promise.all(tasks).then(() => undefined)
  })
}
