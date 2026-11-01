import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { candidates, craftableResults, fitsGrid, sample } from '../src/training/sampler.js'
import { Trainer, judge, parseTrainArgs, sliceTurns, sumTurnUsage } from '../src/training/trainer.js'
import { CommandRegistry } from '../src/game/registry.js'
import { registerRawCommands, isAgentMethod } from '../src/game/raw_commands.js'
import { METHODS } from '../src/game/index.js'
import { GameState } from '../src/game/state.js'
import { normalizeConfig } from '../src/config.js'
import { loadPrompts } from '../src/llm/prompts.js'
import { tempDir } from './helpers.js'

const PLANKS = ['minecraft:oak_planks', 'minecraft:birch_planks']
const RECIPES = [
  { name: 'stick', result: 'minecraft:stick', count: 4, type: 'shaped', pattern: ['#', '#'], key: { '#': PLANKS } },
  { name: 'oak_button', result: 'minecraft:oak_button', count: 1, type: 'shapeless', ingredients: [['minecraft:oak_planks']] },
  { name: 'crafting_table', result: 'minecraft:crafting_table', count: 1, type: 'shaped', pattern: ['##', '##'], key: { '#': PLANKS } },
  { name: 'shears', result: 'minecraft:shears', count: 1, type: 'shaped', pattern: [' #', '# '], key: { '#': ['minecraft:iron_ingot'] } },
  { name: 'oak_boat', result: 'minecraft:oak_boat', count: 1, type: 'shaped', pattern: ['# #', '###'], key: { '#': ['minecraft:oak_planks'] } }
]
const prompts = loadPrompts(fileURLToPath(new URL('../prompts', import.meta.url)))

test('sampler: 2×2 candidates, reproducible seeds, fixed target, craftable results', () => {
  assert.equal(fitsGrid(RECIPES[4]), false, 'a 3-wide pattern does not fit')
  const pool = candidates(RECIPES, ['crafting_table'])
  assert.deepEqual(pool.map((r) => r.name), ['stick', 'oak_button', 'shears'])

  const a = sample(pool, 123)
  assert.deepEqual(sample(pool, 123), a, 'same seed, same run')
  const total = a.slots.reduce((n, s) => n + s.count, 0)
  assert.equal(total, a.materials.reduce((n, m) => n + m.count, 0), 'slots hand out exactly the materials')
  assert.equal(new Set(a.slots.map((s) => s.slot)).size, a.slots.length, 'distinct slots')
  assert.ok(a.slots.every((s) => s.slot >= 0 && s.slot <= 35))

  for (let seed = 0; seed < 20; seed++) {
    const run = sample(pool, seed, 'stick')
    assert.equal(run.target, 'minecraft:stick')
    assert.equal(run.materials.length, 1, 'one symbol → one kind of plank')
    assert.equal(run.materials[0].count, 2)
  }
  assert.throws(() => sample(pool, 1, 'minecraft:crafting_table'), /没有能用 2×2 合成/)

  const watch = craftableResults(pool, [{ id: 'minecraft:oak_planks', count: 2 }], 'minecraft:stick')
  assert.deepEqual(watch, ['minecraft:stick', 'minecraft:oak_button'])
  assert.deepEqual(craftableResults(pool, [{ id: 'minecraft:birch_planks', count: 2 }], 'minecraft:stick'), ['minecraft:stick'])
})

test('parseTrainArgs', () => {
  assert.deepEqual(parseTrainArgs(['craft2x2', 'item=stick', 'runs=5', 'seed=7']), { ok: true, arena: 'craft2x2', item: 'stick', runs: 5, seed: 7 })
  assert.deepEqual(parseTrainArgs(['craft2x2']), { ok: true, arena: 'craft2x2', item: null, runs: 1, seed: null })
  assert.equal(parseTrainArgs([]).ok, false)
  assert.equal(parseTrainArgs(['craft2x2', 'runs=0']).ok, false)
  assert.equal(parseTrainArgs(['craft2x2', 'speed=3']).ok, false)
  assert.equal(parseTrainArgs(['craft2x2', 'item=A B']).ok, false)
})

test('turn slicing and token sums: one unknown turn → null, optional buckets only when every turn has them', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } }, { type: 'x', data: {} }, { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } }, { type: 'turn/end', data: { turn: 2 } },
    { type: 'turn/start', data: { turn: 3 } }
  ]
  const slices = sliceTurns(events)
  assert.deepEqual([...slices.keys()], [1, 2], 'an unfinished turn is not sliced')
  assert.equal(slices.get(1).length, 3)
  const usage = { 1: { uncachedInputTokens: 10, outputTokens: 2, totalTokens: 40, cacheReadTokens: 28 }, 2: { uncachedInputTokens: 5, outputTokens: 1, totalTokens: 6 } }
  const derive = (slice) => usage[slice[0].data.turn]
  assert.deepEqual(sumTurnUsage(events, [1, 2], derive), { input: 15, output: 3, total: 46 })
  assert.deepEqual(sumTurnUsage(events, [1], derive), { input: 10, output: 2, total: 40, cacheRead: 28 })
  assert.equal(sumTurnUsage(events, [1, 3], derive), null, 'unfinished turn → null')
  assert.equal(sumTurnUsage(events, [1], () => undefined), null)
  assert.deepEqual(sumTurnUsage(events, [], derive), { input: 0, output: 0, total: 0 })
})

test('judge', () => {
  assert.equal(judge({ taskState: 'done', crafted: true }), 'success')
  assert.equal(judge({ taskState: 'done', crafted: false }), 'false_success')
  assert.equal(judge({ taskState: 'failed', crafted: true }), 'crafted_but_failed')
  assert.equal(judge({ taskState: 'failed', crafted: false }), 'failed')
  assert.equal(judge({ timedOut: true, taskState: 'failed', crafted: true }), 'timeout')
  assert.equal(judge({ stopped: true, timedOut: true, taskState: 'failed' }), 'aborted')
})

test('arena/* is listed for the trainer but hidden from the agent', () => {
  const arena = METHODS.filter((m) => m.method.startsWith('arena/')).map((m) => m.method)
  assert.deepEqual(arena, ['arena/build', 'arena/prepare', 'arena/status', 'arena/finish'])
  const registry = new CommandRegistry()
  registerRawCommands(registry)
  for (const method of arena) {
    assert.equal(isAgentMethod(method), false)
    assert.equal(registry.get(method), undefined, `${method} must not be an agent command`)
  }
  assert.ok(registry.get('chat/send'), 'ordinary methods are still registered')
})

test('GameState.onCall sees every env call; a throwing listener does not break the call', async () => {
  const calls = []
  const game = new GameState({ mod: { call: async (method) => ({ ok: true, data: { method } }) } })
  const off = game.onCall((method, params) => calls.push([method, params]))
  game.onCall(() => { throw new Error('observer bug') })
  const env = game.env(null)
  assert.deepEqual(await env.must('chat/send', { text: '/give @s stick' }), { method: 'chat/send' })
  await env.call('inventory')
  off()
  await env.call('f3')
  assert.deepEqual(calls, [['chat/send', { text: '/give @s stick' }], ['inventory', {}]])
})

test('config: training defaults merge per arena and are validated', () => {
  const config = normalizeConfig({ training: { arenas: { craft2x2: { mode: 'hidden' } } } })
  assert.deepEqual(config.training.arenas.craft2x2.origin, [10000, 120, 10000])
  assert.equal(config.training.arenas.craft2x2.mode, 'hidden')
  assert.ok(path.isAbsolute(config.training.recipes))
  assert.throws(() => normalizeConfig({ training: { timeoutSec: 0 } }), /training.timeoutSec/)
  assert.throws(() => normalizeConfig({ training: { arenas: { craft2x2: { mode: 'secret' } } } }), /mode/)
  assert.throws(() => normalizeConfig({ training: { arenas: { craft2x2: { origin: [1, 2] } } } }), /origin/)
})

// ── 训练器：假 mod / 假 bridge / 假执行器，假时钟 ──

function harness({ script, timeoutSec = 600, openFails = false, consoleAlive = () => true } = {}) {
  const dir = tempDir('stevex-train-')
  const recipesFile = path.join(dir, 'recipes.json')
  fs.writeFileSync(recipesFile, JSON.stringify({ recipes: RECIPES }))
  let clock = 1_000_000
  const now = () => clock
  const sleep = (ms) => { clock += ms; return new Promise((resolve) => setImmediate(resolve)) }

  const executor = new EventEmitter()
  executor.task = null
  executor.abortTask = (reason, { by }) => {
    const { taskId } = executor.task
    executor.task.state = 'failed'
    executor.emit('task', { taskId, state: 'failed', by, result: reason, version: 1 })
  }

  const arena = { active: false, craftedAtMs: null, craftedItem: null, delta: {}, inventory: {} }
  const calls = []
  const mod = {
    async call(method, params) {
      calls.push([method, params])
      if (method === 'arena/prepare') {
        Object.assign(arena, { active: true, craftedAtMs: null, craftedItem: null, delta: Object.fromEntries(params.watch.map((id) => [id, 0])), inventory: {} })
        return { ok: true, data: { arena: params.arena } }
      }
      const data = { active: arena.active, craftedAtMs: arena.craftedAtMs, craftedItem: arena.craftedItem, craftedDelta: { ...arena.delta }, inventory: { ...arena.inventory }, insideArena: arena.active }
      if (method === 'arena/status') return { ok: true, data }
      if (method === 'arena/finish') { arena.active = false; return { ok: true, data } }
      return { ok: false, error: `unexpected ${method}` }
    }
  }
  const listeners = new Set()
  const game = { mod, onCall: (fn) => { listeners.add(fn); return () => listeners.delete(fn) } }

  let busy = 0
  const requests = new Map()
  let seq = 0
  const bridge = {
    requests,
    busyReason: () => (busy > 0 ? (busy--, 'reflect open') : null),
    startPlanning({ sessionId, instruction }) {
      const n = ++seq
      const req = { requestId: `p${n}`, type: 'plan', taskId: `t${n}`, sessionId, instruction, invalidAttempts: 0, answered: false, closed: false, boundTurns: [{ sessionId, turn: n * 10 }] }
      requests.set(req.requestId, req)
      script({ req, executor, arena, emitCall: (m, p) => listeners.forEach((fn) => fn(m, p)), clock: () => clock, setBusy: (b) => { busy = b } })
      return { ok: true, requestId: req.requestId, taskId: req.taskId }
    },
    abort({ requestId }) {
      const req = requests.get(requestId)
      req.closed = true
      return { ok: true }
    }
  }
  const events = [{ type: 'turn/start', data: { turn: 10 } }, { type: 'turn/end', data: { turn: 10 } }]
  const opened = []
  const notices = []
  const planned = []
  const startPlanning = bridge.startPlanning
  bridge.startPlanning = (args) => { planned.push(args.sessionId); return startPlanning(args) }
  const trainer = new Trainer({
    bridge, executor, game, prompts,
    config: { timeoutSec, pollMs: 1000, recipes: recipesFile, arenas: { craft2x2: { origin: [0, 100, 0], mode: 'named', exclude: [] } } },
    runtimeDir: dir,
    whenIdle: async () => true,
    async openSession(consoleSessionId) {
      if (openFails) throw new Error('model route unavailable')
      const id = `run-${opened.length + 1}`
      opened.push({ id, consoleSessionId })
      return id
    },
    notify: (sessionId, text) => notices.push([sessionId, text]),
    sessionExists: (id) => consoleAlive(id),
    sessionEvents: () => events,
    deriveUsage: () => ({ uncachedInputTokens: 100, outputTokens: 20, totalTokens: 120 }),
    now, sleep, randomSeed: () => 99
  })
  const records = () => fs.readFileSync(path.join(dir, 'training', 'craft2x2.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const done = async () => { while (trainer.running()) await new Promise((resolve) => setImmediate(resolve)) }
  return { trainer, calls, records, done, opened, notices, planned }
}

/** 规划交树 → 跑几秒 → 合成 → 任务结束。 */
function playTask({ crafted = true, finalState = 'done', chat = false } = {}) {
  return ({ req, executor, arena, emitCall, clock, setBusy }) => {
    setImmediate(async () => {
      const tick = () => new Promise((resolve) => setImmediate(resolve))
      await tick()
      req.closed = true
      req.answered = true
      executor.task = { taskId: req.taskId, state: 'running' }
      executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
      executor.emit('event', { taskId: req.taskId, event: 'node', phase: 'exit', ref: 'code/craft.inventory@abc' })
      executor.emit('event', { taskId: req.taskId, event: 'node', phase: 'exit' })
      if (chat) emitCall('chat/send', { text: '/give @s stick' })
      for (let i = 0; i < 3; i++) await tick()
      if (crafted) {
        arena.craftedAtMs = clock()
        arena.craftedItem = 'minecraft:stick'
        arena.delta['minecraft:stick'] = 1
        arena.inventory['minecraft:stick'] = 4
      }
      for (let i = 0; i < 3; i++) await tick()
      executor.task.state = finalState
      setBusy(2)
      executor.emit('task', { taskId: req.taskId, state: finalState, version: 2, result: finalState === 'failed' ? 'gave up' : undefined })
    })
  }
}

test('trainer: a successful run records timing, nodes, capsules, turns and tokens, then teleports out', async () => {
  const h = harness({ script: playTask() })
  const started = h.trainer.start({ sessionId: 's1', arena: 'craft2x2', item: 'stick', runs: 1 })
  assert.equal(started.ok, true, started.error)
  await h.done()
  const [record] = h.records()
  assert.equal(record.outcome, 'success')
  assert.equal(record.target, 'minecraft:stick')
  assert.equal(record.taskId, 't1')
  assert.equal(record.sessionId, 'run-1')
  assert.ok(record.craftedMs > 0 && record.taskMs >= record.craftedMs, JSON.stringify(record))
  assert.equal(record.craftedDelta, 1)
  assert.equal(record.inventoryHasTarget, true)
  assert.equal(record.nodeCalls, 2)
  assert.deepEqual(record.capsules, ['code/craft.inventory@abc'])
  assert.equal(record.treeVersions, 2)
  assert.equal(record.planAttempts, 1)
  assert.equal(record.turns, 1)
  assert.deepEqual(record.tokens, { input: 100, output: 20, total: 120 })
  assert.equal(record.usedChatSend, false)
  assert.equal(record.seed, 99)
  assert.equal(record.mode, 'named')

  const methods = h.calls.map(([m]) => m)
  assert.equal(methods[0], 'arena/prepare')
  assert.equal(methods.at(-1), 'arena/finish')
  const prepare = h.calls[0][1]
  assert.deepEqual(prepare.origin, [0, 100, 0])
  assert.equal(prepare.watch[0], 'minecraft:stick')
  assert.match(h.trainer.status(), /已结束[\s\S]*success 1/)
})

test('trainer: done without crafting is false_success; a chat/send during the run is flagged', async () => {
  const h = harness({ script: playTask({ crafted: false, chat: true }) })
  h.trainer.start({ sessionId: 's1', arena: 'craft2x2', item: 'stick' })
  await h.done()
  const [record] = h.records()
  assert.equal(record.outcome, 'false_success')
  assert.equal(record.craftedMs, null)
  assert.equal(record.usedChatSend, true)
  assert.deepEqual(record.chatSends, ['/give @s stick'])
})

test('trainer: crafted but the agent reported failure', async () => {
  const h = harness({ script: playTask({ finalState: 'failed' }) })
  h.trainer.start({ sessionId: 's1', arena: 'craft2x2', item: 'stick' })
  await h.done()
  const [record] = h.records()
  assert.equal(record.outcome, 'crafted_but_failed')
  assert.equal(record.taskResult, 'gave up')
})

test('trainer: timeout aborts the task with by=timeout; several runs each get a record', async () => {
  const aborted = []
  const script = ({ req, executor }) => {
    setImmediate(() => {
      req.closed = true
      executor.task = { taskId: req.taskId, state: 'running' }
      executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
    })
  }
  const h = harness({ script, timeoutSec: 5 })
  const original = h.trainer.executor.abortTask
  h.trainer.executor.abortTask = (reason, options) => { aborted.push(options.by); original(reason, options) }
  h.trainer.start({ sessionId: 's1', arena: 'craft2x2', runs: 2, seed: 1 })
  await h.done()
  const records = h.records()
  assert.deepEqual(records.map((r) => r.outcome), ['timeout', 'timeout'])
  assert.deepEqual(aborted, ['timeout', 'timeout'])
  assert.equal(records[0].seed, 1)
  assert.notEqual(records[1].seed, records[0].seed)
})

test('trainer: planning closed without a tree is failed; stop aborts the current run and ends the batch', async () => {
  const planFails = harness({ script: ({ req }) => setImmediate(() => { req.closed = true; req.invalidAttempts = 3 }) })
  planFails.trainer.start({ sessionId: 's1', arena: 'craft2x2', item: 'stick' })
  await planFails.done()
  const [failed] = planFails.records()
  assert.equal(failed.outcome, 'failed')
  assert.equal(failed.planAttempts, 3)
  assert.match(failed.error, /planning closed without a tree/)

  const stopper = harness({ script: ({ req, executor }) => setImmediate(() => {
    req.closed = true
    executor.task = { taskId: req.taskId, state: 'running' }
    executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
  }) })
  stopper.trainer.start({ sessionId: 's1', arena: 'craft2x2', runs: 5 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stopper.trainer.start({ sessionId: 's1', arena: 'craft2x2' }).ok, false, 'one batch at a time')
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stopper.trainer.stop().ok, true)
  await stopper.done()
  const records = stopper.records()
  assert.equal(records.length, 1)
  assert.equal(records[0].outcome, 'aborted')
})

test('trainer: start rejects unknown arenas and targets without a 2×2 recipe', () => {
  const h = harness({ script: () => {} })
  assert.match(h.trainer.start({ sessionId: 's1', arena: 'smelt' }).error, /未知场地/)
  assert.match(h.trainer.start({ sessionId: 's1', arena: 'craft2x2', item: 'crafting_table_x' }).error, /没有能用 2×2 合成/)
  assert.match(h.trainer.start({ sessionId: null, arena: 'craft2x2' }).error, /会话/)
})

test('report: per-target success rate, medians over successful runs, batch and last-N filters', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (target, outcome, extra = {}) => ({ target, outcome, batch: 'b1', craftedMs: null, taskMs: null, tokens: null, usedChatSend: false, ...extra })
  const records = [
    rec('minecraft:stick', 'success', { craftedMs: 1000, taskMs: 3000, tokens: { total: 100 } }),
    rec('minecraft:stick', 'success', { craftedMs: 3000, taskMs: 5000, tokens: { total: 300 } }),
    rec('minecraft:stick', 'false_success', { usedChatSend: true }),
    rec('minecraft:oak_button', 'timeout', { batch: 'b2' })
  ]
  const { rows, total } = summarize(records)
  assert.equal(rows[0].target, 'minecraft:stick')
  assert.equal(rows[0].runs, 3)
  assert.equal(rows[0].success, 2)
  assert.equal(rows[0].falseSuccess, 1)
  assert.equal(rows[0].medianCraftedMs, 2000)
  assert.equal(rows[0].medianTokens, 200)
  assert.equal(rows[0].chatSend, 1)
  assert.equal(total.runs, 4)
  assert.equal(summarize(records, { batch: 'b2' }).total.timeout, 1)
  assert.equal(summarize(records, { last: 1 }).total.runs, 1)
  assert.match(formatSummary({ rows, total }), /minecraft:stick\t3\t67%/)
  assert.equal(formatSummary(summarize([])), '没有训练记录')
})

test('each run gets its own new session; the console session only gets notices', async () => {
  const h = harness({ script: playTask() })
  h.trainer.start({ sessionId: 'console', arena: 'craft2x2', item: 'stick', runs: 3 })
  await h.done()
  const records = h.records()
  assert.deepEqual(records.map((r) => r.sessionId), ['run-1', 'run-2', 'run-3'])
  assert.deepEqual(h.planned, ['run-1', 'run-2', 'run-3'], 'planning goes to the run session, never the console')
  assert.ok(h.opened.every((o) => o.consoleSessionId === 'console'), 'the model follows the console session')
  assert.ok(h.notices.every(([sid]) => sid === 'console'))
  const texts = h.notices.map(([, text]) => text)
  assert.equal(texts.length, 7, 'start + end per run, plus the batch summary')
  assert.match(texts[0], /^第 1\/3 轮：会话 run-1，目标 minecraft:stick/)
  assert.match(texts[1], /^第 1\/3 轮结果 success，合成用时 \d+\.\d 秒，任务用时/)
  assert.match(texts[6], /^训练 b\d+ 结束：success 3/)
})

test('opening the run session fails → aborted, the batch stops, the arena is never prepared', async () => {
  const h = harness({ script: playTask(), openFails: true })
  h.trainer.start({ sessionId: 'console', arena: 'craft2x2', runs: 3 })
  await h.done()
  const records = h.records()
  assert.equal(records.length, 1)
  assert.equal(records[0].outcome, 'aborted')
  assert.match(records[0].error, /openSession: model route unavailable/)
  assert.equal(records[0].sessionId, null)
  assert.equal(h.calls.some(([m]) => m === 'arena/prepare'), false)
})

test('the console session closes mid-batch → the current run finishes, no new run starts', async () => {
  let alive = true
  const h = harness({ script: (ctx) => { playTask()(ctx); alive = false }, consoleAlive: () => alive })
  h.trainer.start({ sessionId: 'console', arena: 'craft2x2', item: 'stick', runs: 3 })
  await h.done()
  const records = h.records()
  assert.equal(records.length, 1)
  assert.equal(records[0].outcome, 'success')
  assert.equal(h.notices.length, 1, 'only the start notice went out before the console closed')
})

