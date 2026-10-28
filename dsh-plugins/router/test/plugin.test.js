import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { mkdtempSync, writeFileSync, cpSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as applyPlugin, name } from '../src/index.js'
import { loadPromptBlocks, DEFAULT_PROMPTS_DIR } from '../src/prompts.js'
import { instructionOf, statementOf } from '../src/handlers.js'
import { createFakeContext, emitEvent, emitWaterfall, makeSlots } from './helpers.js'

const promptsDir = fileURLToPath(new URL('../prompts', import.meta.url))

/** 测试默认不写路由日志、不用真模型（没给 provider 的用 stub）。 */
function apply(ctx, config = {}) {
  return applyPlugin(ctx, { logDir: null, ...config, provider: config.provider ?? { mode: 'stub' } })
}

function payload(turn, step) {
  return {
    agent: { id: 'agent-1' },
    messages: [],
    turn,
    step,
    signal: { aborted: false }
  }
}

const enter = async () => ({ kind: 'enter', messages: [] })

async function preStep(ctx, turn, step) {
  return emitWaterfall(ctx, 'agent/pre-step', payload(turn, step), enter)
}

async function turnStopping(ctx, turn) {
  return emitEvent(ctx, 'agent/turn-stopping', { turn })
}

test('插件加载：服务与五个 handler 就位', () => {
  const ctx = createFakeContext()
  apply(ctx, { logger: null })

  assert.equal(name, 'stevex-router')
  assert.ok(ctx.router)
  assert.deepEqual(
    ctx.router.handlerIds().sort(),
    ['clarify', 'default', 'fact', 'task', 'unsupported']
  )
})

test('pre-step：step=1 路由并创建 turn scope；step=2 不重复填槽', async () => {
  const calls = []
  const ctx = createFakeContext()
  apply(ctx, {
    logger: null,
    provider: {
      mode: 'llm',
      fillSlots: async () => {
        calls.push(1)
        return makeSlots({ knowledge: 'fact' })
      }
    }
  })

  await preStep(ctx, 1, 1)
  assert.equal(calls.length, 1)
  assert.deepEqual(ctx.router.lastResult(1).decision.order, ['fact'])
  assert.ok(ctx.router.turnScope(1))

  await preStep(ctx, 1, 2) // 工具结果驱动的后续 step
  assert.equal(calls.length, 1)
  await turnStopping(ctx, 1)
  assert.equal(ctx.router.turnScope(1), null)

  await preStep(ctx, 2, 1)
  assert.equal(calls.length, 2)
})

test('turn-stopping：无条件清空 handler 注册的回合级 disposer', async () => {
  const ctx = createFakeContext()
  apply(ctx, { logger: null })

  let disposed = 0
  ctx.router.registerHandler({
    id: 'probe',
    match: () => true,
    priority: 1,
    run: (slots, context) => {
      context.turn.onDispose(() => { disposed += 1 })
      return { text: 'probe' }
    }
  })

  await preStep(ctx, 1, 1)
  assert.ok(ctx.router.lastResult(1).decision.order.includes('probe'))
  assert.equal(disposed, 0)

  await turnStopping(ctx, 1)
  assert.equal(disposed, 1)
  assert.equal(ctx.router.turnScope(1), null)
})

test('追问：unknown → clarify 独占', async () => {
  const ctx = createFakeContext()
  apply(ctx, {
    logger: null,
    provider: { mode: 'stub', stubSlots: makeSlots({ knowledge: 'unknown' }) }
  })

  await preStep(ctx, 1, 1)
  const result = ctx.router.lastResult(1)
  assert.equal(result.decision.exclusive, true)
  assert.deepEqual(result.decision.order, ['clarify'])
  assert.match(result.parts[0].result.text, /clarify/)
})

test('provider 失败 → 按普通对话走 default，并注入降级说明（D7）', async () => {
  const ctx = createFakeContext()
  apply(ctx, {
    logger: null,
    provider: {
      mode: 'llm',
      fillSlots: async () => { throw new Error('provider boom') }
    }
  })

  const human = { id: 'u1', role: 'user', content: [{ type: 'text', text: '做一把木镐' }], source: { kind: 'user' } }
  const decision = await emitWaterfall(ctx, 'agent/pre-step', { agent: { id: 'agent-1' }, messages: [human], turn: 1, step: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [human] }))
  const result = ctx.router.lastResult(1)
  assert.equal(result.decision.exclusive, false)
  assert.deepEqual(result.decision.order, ['default'])
  assert.equal(result.notice.kind, 'degraded')
  assert.equal(decision.messages.length, 2)
  assert.deepEqual(decision.messages[1].source, { kind: 'stevex-router', handlers: [], notice: 'degraded' })
  assert.match(decision.messages[1].content[0].text, /路由调用失败：provider boom[\s\S]*\/bt task/)
})

test('配置校验：非法值在插件加载时失败', () => {
  assert.throws(() => apply(createFakeContext(), { confidenceThreshold: 2 }), /confidenceThreshold/)
  assert.throws(() => apply(createFakeContext(), { enabledHandlers: [] }), /enabledHandlers/)
  assert.throws(() => apply(createFakeContext(), { enabledHandlers: ['nope'] }), /enabledHandlers/)
  assert.throws(() => apply(createFakeContext(), { provider: { mode: 'llm', route: { provider: 'x' } } }), /route/)
  assert.throws(() => apply(createFakeContext(), { provider: { mode: 'llm', timeoutMs: 0 } }), /timeoutMs/)
  assert.throws(() => apply(createFakeContext(), { logDir: '' }), /logDir/)
})

test('默认配置 = llm 模式 + 本包自带的提示词（D9）；stub 仍可显式选用', () => {
  const ctx = createFakeContext()
  applyPlugin(ctx, { logger: null, logDir: null })
  assert.ok(ctx.router)
  const stub = createFakeContext()
  apply(stub, { logger: null, provider: { mode: 'stub' } })
  assert.ok(stub.router)
})

test('提示词缺失 / 为空 / 仍带占位 / 缺小节 → 拒绝上线', () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-prompts-'))
  try {
    cpSync(DEFAULT_PROMPTS_DIR, dir, { recursive: true })
    assert.ok(loadPromptBlocks(dir).slotDefs)

    writeFileSync(join(dir, 'router/rules.md'), '<!-- TODO(内容层): 待填 -->')
    assert.throws(() => apply(createFakeContext(), { logger: null, provider: { mode: 'llm', fillSlots: async () => makeSlots(), promptsDir: dir } }), (e) => e.code === 'PROMPT_PLACEHOLDER')

    writeFileSync(join(dir, 'router/rules.md'), '   ')
    assert.throws(() => loadPromptBlocks(dir), (e) => e.code === 'PROMPT_EMPTY')

    cpSync(join(DEFAULT_PROMPTS_DIR, 'router/rules.md'), join(dir, 'router/rules.md'))
    writeFileSync(join(dir, 'handlers/default.md'), ['## degraded', '只有一节'].join('\n'))
    assert.throws(() => loadPromptBlocks(dir), (e) => e.code === 'PROMPT_SECTION_MISSING' && /clarify-limit/.test(e.message))

    rmSync(join(dir, 'handlers/default.md'))
    assert.throws(() => loadPromptBlocks(dir), (e) => e.code === 'PROMPT_MISSING')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.throws(() => loadPromptBlocks(''), (e) => e.code === 'MISSING_PROMPTS_DIR')
})

test('插件卸载：兜底清空未结束的 turn scope', async () => {
  const ctx = createFakeContext()
  apply(ctx, { logger: null })

  let disposed = 0
  ctx.router.registerHandler({
    id: 'probe',
    match: () => true,
    priority: 1,
    run: (slots, context) => {
      context.turn.onDispose(() => { disposed += 1 })
      return { text: 'probe' }
    }
  })

  await preStep(ctx, 1, 1)
  await ctx.dispose()
  assert.equal(disposed, 1)
  assert.equal(ctx.router.lastResult(1), null)
})

// ── P1：task handler 真实化（集成方案 §6.1）──────────────────────────────────

const userMessage = (text) => ({ id: 'u1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

function taskRouter({ planInTurn } = {}) {
  const ctx = createFakeContext()
  const calls = []
  if (planInTurn !== null) {
    ctx.provide('stevexBt', {
      planInTurn: (args) => {
        calls.push(args)
        return planInTurn ? planInTurn(args) : { ok: true, taskId: 't1', requestId: 'p1', text: '# 规划请求 p1\n指令：做一把木镐' }
      }
    })
  }
  apply(ctx, { logger: null, provider: { mode: 'llm', fillSlots: async () => makeSlots({ action: 'execute' }) } })
  return { ctx, calls }
}

async function routeTurn(ctx, messages) {
  const p = { agent: { id: 'agent-1' }, messages, turn: 1, step: 1, signal: { aborted: false } }
  return emitWaterfall(ctx, 'agent/pre-step', p, async () => ({ kind: 'enter', messages }))
}

test('task handler：把人说的话交给 planInTurn，返回的请求正文追加进本 step', async () => {
  const { ctx, calls } = taskRouter()
  const human = userMessage('做一把木镐')
  const decision = await routeTurn(ctx, [human])

  assert.deepEqual(calls, [{ agent: { id: 'agent-1' }, turn: 1, instruction: '做一把木镐' }])
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0], human)
  const injected = decision.messages[1]
  assert.equal(injected.role, 'user')
  assert.deepEqual(injected.source, { kind: 'stevex-router', handlers: ['task'] })
  assert.match(injected.content[0].text, /规划请求 p1/)
})

test('task handler：已有任务在跑 → 注入"先问人要不要放弃"的说明，不开新任务', async () => {
  const { ctx } = taskRouter({ planInTurn: () => ({ ok: false, error: '当前任务 t0 还在 running' }) })
  const decision = await routeTurn(ctx, [userMessage('去挖铁')])
  assert.match(decision.messages[1].content[0].text, /没有开始新任务：当前任务 t0 还在 running/)
  assert.match(decision.messages[1].content[0].text, /bt_abort_task/)
})

test('task handler：没装 agent 插件 → handler 失败（continue），不注入任何东西', async () => {
  const { ctx } = taskRouter({ planInTurn: null })
  const decision = await routeTurn(ctx, [userMessage('做一把木镐')])
  assert.equal(decision.messages.length, 1)
  assert.match(ctx.router.lastResult(1).errors[0].error.message, /stevex-agent plugin/)
})

// ── P5：fact handler 真实化 ───────────────────────────────────────────────────

function factRouter(slots) {
  const ctx = createFakeContext()
  const calls = []
  ctx.provide('stevexBt', {
    planInTurn: (args) => { calls.push(['plan', args]); return { ok: true, taskId: 't1', requestId: 'p1', text: '# 规划请求 p1' } },
    factInTurn: (args) => { calls.push(['fact', args]); return { ok: true, text: '# 事实确认\n> 岩浆会点燃玩家' } }
  })
  apply(ctx, { logger: null, provider: { mode: 'llm', fillSlots: async () => slots } })
  return { ctx, calls }
}

test('fact handler：把人说的话交给 factInTurn，正文追加进本 step', async () => {
  const { ctx, calls } = factRouter(makeSlots({ knowledge: 'fact' }))
  const decision = await routeTurn(ctx, [userMessage('岩浆会点燃玩家')])
  assert.deepEqual(calls, [['fact', { agent: { id: 'agent-1' }, turn: 1, statement: '岩浆会点燃玩家' }]])
  assert.deepEqual(decision.messages[1].source, { kind: 'stevex-router', handlers: ['fact'] })
  assert.match(decision.messages[1].content[0].text, /事实确认/)
})

test('fact 与 task 同时选中：fact 先跑，两段正文都进本 step', async () => {
  const { ctx, calls } = factRouter(makeSlots({ knowledge: 'fact', action: 'execute' }))
  const decision = await routeTurn(ctx, [userMessage('岩浆会点燃玩家，绕开岩浆去挖铁')])
  assert.deepEqual(calls.map(([kind]) => kind), ['fact', 'plan'])
  assert.deepEqual(decision.messages[1].source.handlers, ['fact', 'task'])
  assert.match(decision.messages[1].content[0].text, /事实确认[\s\S]*规划请求 p1/)
})

test('执行器发来的请求（stevex-bt 来源）不经路由（I3）', async () => {
  const { ctx, calls } = taskRouter()
  const followup = { id: 'f1', role: 'user', content: [{ type: 'text', text: '# 展开请求 r3' }], source: { kind: 'stevex-bt', requestId: 'r3' } }
  const decision = await routeTurn(ctx, [followup])
  assert.deepEqual(decision.messages, [followup])
  assert.equal(calls.length, 0)
  assert.equal(ctx.router.lastResult(1), null)
})

test('instructionOf：槽位 payload 的 instruction 优先，否则取人说的话', () => {
  const slots = makeSlots({ action: 'execute', payloads: { action: { instruction: '  合成木镐 ' } } })
  assert.equal(instructionOf(slots, [userMessage('随便')]), '合成木镐')
  assert.equal(instructionOf(makeSlots({ action: 'execute' }), [userMessage('砍树'), { source: { kind: 'stevex-bt' }, content: [{ type: 'text', text: 'x' }] }]), '砍树')
})

// ── 阶段 B：llm 模式（细则 §3–§9）────────────────────────────────────────────

/** 假的 ctx.llm：按顺序吐出 replies（字符串 = 文本回复；Error = 调用失败；'hang' = 一直不回，等 signal）。 */
function fakeLlm(replies) {
  const calls = []
  return {
    calls,
    async prepareCall(config, signal, configure) {
      const controls = configure({ maxTokens: config.maxTokens }, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })
      const call = { config, signal, controls }
      calls.push(call)
      return {
        config: { ...config, ...controls },
        async * stream(options) {
          call.options = options
          const reply = replies.shift()
          if (reply instanceof Error) throw reply
          if (reply === 'hang') {
            await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
          }
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: reply }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
  }
}

function llmRouter(replies, { config = {}, service = null, history = [] } = {}) {
  const ctx = createFakeContext()
  const llm = fakeLlm(replies)
  ctx.provide('llm', llm)
  const calls = []
  ctx.provide('stevexBt', service ?? {
    planInTurn: (args) => { calls.push(['plan', args]); return { ok: true, taskId: 't1', requestId: 'p1', text: '# 规划请求 p1' } },
    factInTurn: (args) => { calls.push(['fact', args]); return { ok: true, text: '# 事实确认' } }
  })
  applyPlugin(ctx, { logger: null, logDir: null, ...config, provider: { mode: 'llm', ...(config.provider ?? {}) } })
  const agent = { id: 'agent-1', options: { provider: 'deepseek', model: 'chat' }, session: { id: 's1', deriveMessages: () => history } }
  let turn = 0
  async function say(text, { signal = new AbortController().signal } = {}) {
    turn++
    const messages = [userMessage(text)]
    const decision = await emitWaterfall(ctx, 'agent/pre-step', { agent, messages, turn, step: 1, signal }, async () => ({ kind: 'enter', messages }))
    return { decision, result: ctx.router.lastResult(turn), injected: decision.messages[1] ?? null }
  }
  return { ctx, llm, calls, say }
}

const reply = (options) => JSON.stringify(makeSlots(options))

test('llm 模式：用会话的 provider/model、最低推理档发一次独立调用；人说的话直接开任务', async () => {
  const { llm, calls, say } = llmRouter([reply({ action: 'execute', payloads: { action: { instruction: '做一把木镐' } } })], {
    history: [{ ...userMessage('你好'), id: 'h1' }, { role: 'assistant', content: [{ type: 'text', text: '你好，我是 steveX' }] }]
  })
  const { injected } = await say('那就帮我做一把木镐吧')
  assert.equal(llm.calls.length, 1)
  const [call] = llm.calls
  assert.equal(call.config.provider, 'deepseek')
  assert.equal(call.config.model, 'chat')
  assert.equal(call.controls.reasoningEffort, 'low')
  assert.equal(call.options.sessionId, 's1')
  assert.match(call.options.system, /\[SLOT_DEFS\]/)
  assert.match(call.options.messages[0].content[0].text, /\[CONTEXT\]\n用户：你好\nsteveX：你好，我是 steveX[\s\S]*\[USER\]\n那就帮我做一把木镐吧/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'plan')
  assert.equal(calls[0][1].instruction, '做一把木镐')
  assert.deepEqual(injected.source, { kind: 'stevex-router', handlers: ['task'] })
})

test('llm 模式：配置的 route / reasoningEffort 覆盖会话模型', async () => {
  const { llm, say } = llmRouter([reply()], { config: { provider: { route: { provider: 'fast', model: 'mini' }, reasoningEffort: 'high' } } })
  await say('你好')
  assert.equal(llm.calls[0].config.provider, 'fast')
  assert.equal(llm.calls[0].config.model, 'mini')
  assert.equal(llm.calls[0].controls.reasoningEffort, 'high')
})

test('普通对话：只命中 default，不注入任何东西', async () => {
  const { say } = llmRouter([reply()])
  const { decision, result } = await say('钻石一般在第几层？')
  assert.deepEqual(result.decision.order, ['default'])
  assert.equal(decision.messages.length, 1)
})

test('fact handler 用 payload.statement（D3）', async () => {
  const { calls, say } = llmRouter([reply({ knowledge: 'fact', payloads: { knowledge: { statement: '岩浆会点燃玩家' } } })])
  await say('哈喽，岩浆会点燃玩家哦')
  assert.equal(calls[0][0], 'fact')
  assert.equal(calls[0][1].statement, '岩浆会点燃玩家')
})

test('unsupported：注入"暂不支持"；同时下了指令时任务照跑', async () => {
  const { calls, say } = llmRouter([reply({ artifact: 'fast_tree', action: 'execute' })])
  const { injected } = await say('以后看到苦力怕就跑，现在先去砍树')
  assert.deepEqual(injected.source.handlers, ['unsupported', 'task'])
  assert.match(injected.content[0].text, /目前不支持[\s\S]*规划请求 p1/)
  assert.equal(calls[0][0], 'plan')
})

test('追问：注入"只问一句、不调工具"；下一条消息带着追问上下文填槽；判定后清掉', async () => {
  const { llm, calls, say } = llmRouter([
    reply({ action: 'unknown', confidences: { action: 0.4 }, clarification: '现在就去挖铁吗？' }),
    reply({ action: 'execute', payloads: { action: { instruction: '去挖 10 个铁' } } }),
    reply()
  ])
  const first = await say('要不要去挖点铁呢')
  assert.deepEqual(first.result.decision.order, ['clarify'])
  assert.deepEqual(first.injected.source.handlers, ['clarify'])
  assert.match(first.injected.content[0].text, /「现在就去挖铁吗？」[\s\S]*不要调用任何工具/)
  assert.equal(calls.length, 0)

  await say('现在就去，挖 10 个')
  assert.match(llm.calls[1].options.messages[0].content[0].text, /\[PENDING_CLARIFICATION\][\s\S]*现在就去挖铁吗？[\s\S]*要不要去挖点铁呢/)
  assert.deepEqual(calls.map(([kind]) => kind), ['plan'])

  await say('谢谢')
  assert.doesNotMatch(llm.calls[2].options.messages[0].content[0].text, /PENDING_CLARIFICATION/)
})

test('追问：没给 clarification 时按拿不准的槽位套 clarify.md 的问句', async () => {
  const { say } = llmRouter([reply({ knowledge: 'unknown' })])
  const { injected } = await say('熔炉好像挺慢的')
  assert.match(injected.content[0].text, /要我记住的游戏规则，还是你在问我/)
})

test('追问上限（D6）：连续 2 次后仍拿不准 → 不再追问，按 none 走并提示 /bt task', async () => {
  const unsure = () => reply({ action: 'unknown', knowledge: 'fact', confidences: { action: 0.3 } })
  const { calls, say } = llmRouter([unsure(), unsure(), unsure()])
  assert.deepEqual((await say('a')).result.decision.order, ['clarify'])
  assert.deepEqual((await say('b')).result.decision.order, ['clarify'])
  const third = await say('c')
  assert.deepEqual(third.result.decision.order, ['fact'])
  assert.equal(third.result.notice.kind, 'clarify-limit')
  assert.equal(third.result.slotJson.slots.action.value, 'none')
  assert.deepEqual(third.injected.source, { kind: 'stevex-router', handlers: ['fact'], notice: 'clarify-limit' })
  assert.match(third.injected.content[0].text, /追问之后仍不能确定[\s\S]*\/bt task[\s\S]*事实确认/)
  assert.deepEqual(calls.map(([kind]) => kind), ['fact'])
})

test('降级（D7）：两次输出都不合法 / 模型报错 → default + 说明，不开任务', async () => {
  const invalid = llmRouter(['胡言乱语', '{"slots": 1}'])
  const a = await invalid.say('做一把木镐')
  assert.deepEqual(a.result.decision.order, ['default'])
  assert.match(a.injected.content[0].text, /两次输出都不合法[\s\S]*\/bt task/)
  assert.equal(invalid.calls.length, 0)

  const broken = llmRouter([new Error('rate limited')])
  const b = await broken.say('做一把木镐')
  assert.match(b.injected.content[0].text, /路由调用失败：rate limited/)
})

test('降级：超时 → "路由超时"', async () => {
  const { say } = llmRouter(['hang'], { config: { provider: { timeoutMs: 20 } } })
  const { injected } = await say('做一把木镐')
  assert.match(injected.content[0].text, /路由超时/)
})

test('人取消回合：路由调用一起停，不降级、不注入', async () => {
  const { say } = llmRouter(['hang'])
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 10)
  const { decision, result } = await say('做一把木镐', { signal: controller.signal })
  assert.equal(decision.messages.length, 1)
  assert.equal(result, null)
})

test('路由日志（D8）：一行 JSON，payload 只记长度，不记原话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-log-'))
  try {
    const { say } = llmRouter([reply({ action: 'execute', payloads: { action: { instruction: '做一把木镐' } } })], { config: { logDir: dir } })
    await say('请帮我做一把木镐')
    const lines = readFileSync(join(dir, 's1.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.length, 1)
    const [row] = lines
    assert.equal(row.session, 's1')
    assert.equal(row.turn, 1)
    assert.equal(row.provider, 'llm')
    assert.equal(row.model, 'deepseek/chat')
    assert.equal(row.attempts, 1)
    assert.deepEqual(row.slots.action, ['execute', 0.95])
    assert.deepEqual(row.payload, { action: JSON.stringify({ instruction: '做一把木镐' }).length })
    assert.deepEqual(row.handlers, ['task'])
    assert.deepEqual(row.outcomes, { task: 'ok' })
    assert.equal(row.degraded, null)
    assert.ok(!JSON.stringify(row).includes('做一把木镐'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('statementOf：payload 的 statement 优先，否则取人说的话', () => {
  assert.equal(statementOf(makeSlots({ knowledge: 'fact', payloads: { knowledge: { statement: ' 岩浆会点燃玩家 ' } } }), [userMessage('x')]), '岩浆会点燃玩家')
  assert.equal(statementOf(makeSlots({ knowledge: 'fact' }), [userMessage('铁镐挖钻石')]), '铁镐挖钻石')
})
