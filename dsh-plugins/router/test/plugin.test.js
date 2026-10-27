import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { apply, name } from '../src/index.js'
import { loadPromptBlocks } from '../src/prompts.js'
import { instructionOf } from '../src/handlers.js'
import { createFakeContext, emitEvent, emitWaterfall, makeSlots } from './helpers.js'

const promptsDir = fileURLToPath(new URL('../prompts', import.meta.url))

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

test('provider 失败 → 追问兜底，不抛出', async () => {
  const ctx = createFakeContext()
  apply(ctx, {
    logger: null,
    provider: {
      mode: 'llm',
      fillSlots: async () => { throw new Error('provider boom') }
    }
  })

  await preStep(ctx, 1, 1)
  const result = ctx.router.lastResult(1)
  assert.equal(result.decision.exclusive, true)
  assert.deepEqual(result.decision.order, ['clarify'])
})

test('配置校验：非法值在插件加载时失败', () => {
  assert.throws(() => apply(createFakeContext(), { confidenceThreshold: 2 }), /confidenceThreshold/)
  assert.throws(() => apply(createFakeContext(), { enabledHandlers: [] }), /enabledHandlers/)
  assert.throws(() => apply(createFakeContext(), { enabledHandlers: ['nope'] }), /enabledHandlers/)
  assert.throws(
    () => apply(createFakeContext(), { provider: { mode: 'llm' } }),
    /fillSlots/
  )
})

test('llm 模式的提示词占位必须拒绝上线', () => {
  assert.throws(
    () => apply(createFakeContext(), {
      logger: null,
      provider: {
        mode: 'llm',
        fillSlots: async () => makeSlots(),
        promptsDir
      }
    }),
    (e) => e.code === 'PROMPT_PLACEHOLDER'
  )
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
