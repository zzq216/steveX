import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { candidates, craftableResults, fitsGrid, maxPortions, parseCountSpec, sample, shapeOf, slotsNeeded } from '../src/training/sampler.js'
import { Trainer, judge, parseTrainArgs, resolveCounts, sliceTurns, sumTurnUsage } from '../src/training/trainer.js'
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

  const full = candidates([RECIPES[2]], [])
  const splits = new Set()
  for (let seed = 0; seed < 200; seed++) {
    const run = sample(full, seed)
    assert.equal(run.slots.reduce((n, s) => n + s.count, 0), 4)
    splits.add(run.slots.map((s) => s.count).join('+'))
  }
  assert.ok(splits.has('4') && splits.has('1+1+1+1') && [...splits].some((s) => /2|3/.test(s)), 'stacks split at random points, including partial splits')
  assert.throws(() => sample(pool, 1, 'minecraft:crafting_table'), /没有合成 .* 的 2×2 配方/)

  const watch = craftableResults(pool, [{ id: 'minecraft:oak_planks', count: 2 }], 'minecraft:stick')
  assert.deepEqual(watch, ['minecraft:stick', 'minecraft:oak_button'])
  assert.deepEqual(craftableResults(pool, [{ id: 'minecraft:birch_planks', count: 2 }], 'minecraft:stick'), ['minecraft:stick'])
})

test('parseTrainArgs', () => {
  assert.deepEqual(parseTrainArgs(['craft2x2', 'item=stick', 'runs=5', 'seed=7']), { ok: true, arena: 'craft2x2', item: 'stick', runs: 5, seed: 7, portions: null, crafts: null })
  assert.deepEqual(parseTrainArgs(['craft2x2']), { ok: true, arena: 'craft2x2', item: null, runs: 1, seed: null, portions: null, crafts: null })
  assert.deepEqual(parseTrainArgs(['craft2x2', 'n=2-5', 'm=1']), { ok: true, arena: 'craft2x2', item: null, runs: 1, seed: null, portions: '2-5', crafts: '1' })
  assert.match(parseTrainArgs(['craft2x2', 'n=65']).error, /1–64/)
  assert.match(parseTrainArgs(['craft2x2', 'n=5-2']).error, /a ≤ b/)
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

  assert.equal(config.training.arenas.craft2x2.grid, 2, 'craft2x2 keeps the 2×2 grid')
  assert.equal(config.training.arenas.craft2x2.station, null)
  assert.deepEqual(config.training.arenas.craft3x3, { grid: 3, station: 'crafting_table', origin: [10000, 120, 10030], mode: 'named', exclude: [], timeoutSec: 900 })
  assert.throws(() => normalizeConfig({ training: { arenas: { craft3x3: { grid: 4 } } } }), /grid/)
  assert.throws(() => normalizeConfig({ training: { arenas: { craft3x3: { station: 'furnace' } } } }), /station/)
  assert.throws(() => normalizeConfig({ training: { arenas: { craft3x3: { timeoutSec: 0 } } } }), /craft3x3.timeoutSec/)
})

test('sampler: 3×3 candidates exclude 2×2 recipes, sampling is by shape, judging reach includes 2×2 recipes', () => {
  const slab = (name, wood) => ({ name, result: `minecraft:${name}`, count: 6, type: 'shaped', pattern: ['###'], key: { '#': [`minecraft:${wood}_planks`] } })
  const R3 = [
    ...RECIPES,
    slab('oak_slab', 'oak'), slab('birch_slab', 'birch'), slab('spruce_slab', 'spruce'),
    { name: 'chest', result: 'minecraft:chest', count: 1, type: 'shaped', pattern: ['###', '# #', '###'], key: { '#': PLANKS } },
    { name: 'stairs', result: 'minecraft:oak_stairs', count: 4, type: 'shaped', pattern: ['#  ', '## ', '###'], key: { '#': ['minecraft:oak_planks'] } }
  ]
  const pool = candidates(R3, [], 3)
  assert.deepEqual(pool.map((r) => r.name), ['oak_boat', 'oak_slab', 'birch_slab', 'spruce_slab', 'chest', 'stairs'])
  assert.deepEqual(candidates(R3, [], 2).map((r) => r.name), ['stick', 'oak_button', 'crafting_table', 'shears'], 'grid 2 is unchanged')

  assert.equal(shapeOf(R3.at(-1)), 'A  /AA /AAA')
  assert.equal(shapeOf({ type: 'shaped', pattern: ['XYX', 'X X'] }), 'ABA/A A')
  assert.equal(shapeOf(RECIPES[1]), 'shapeless:1')

  const a = sample(pool, 7, null, { grid: 3, byShape: true })
  assert.deepEqual(sample(pool, 7, null, { grid: 3, byShape: true }), a, 'same seed, same run')
  assert.equal(a.shape, shapeOf(pool.find((r) => r.name === a.recipe)))
  // 4 种形状、6 条配方：按形状抽时 3 条台阶合起来约 1/4，按配方抽约 1/2
  const slabs = (byShape) => Array.from({ length: 400 }, (_, seed) => sample(pool, seed, null, { grid: 3, byShape })).filter((r) => r.shape === 'AAA').length
  assert.ok(slabs(true) < 140 && slabs(false) > 160, `byShape ${slabs(true)} vs byRecipe ${slabs(false)}`)
  assert.equal(sample(pool, 3, 'chest', { grid: 3, byShape: true }).recipe, 'chest', 'a fixed target skips the shape draw')
  assert.throws(() => sample(pool, 1, 'stick', { grid: 3 }), /没有合成 minecraft:stick 的 3×3 配方/)

  const reach = R3.filter((r) => fitsGrid(r, 3))
  const watch = craftableResults(reach, [{ id: 'minecraft:oak_planks', count: 8 }], 'minecraft:chest')
  assert.ok(['minecraft:stick', 'minecraft:crafting_table', 'minecraft:oak_slab'].every((id) => watch.includes(id)), watch.join(' '))
})

// ── 训练器：假 mod / 假 bridge / 假执行器，假时钟 ──

const ITEM_PROPS = Object.fromEntries(
  ['minecraft:oak_planks', 'minecraft:birch_planks', 'minecraft:stick', 'minecraft:oak_button', 'minecraft:crafting_table', 'minecraft:iron_ingot', 'minecraft:shears', 'minecraft:oak_boat']
    .map((id) => [id, { maxStack: id.endsWith('shears') || id.endsWith('boat') ? 1 : 64 }])
)
const ARENAS_2X2 = { craft2x2: { origin: [0, 100, 0], mode: 'named', exclude: [], portions: '1', crafts: '1' } }

function harness({ script, timeoutSec = 600, wallTimeoutSec = 2400, cancelTurn = () => {}, openFails = false, consoleAlive = () => true, arenas = ARENAS_2X2, prepareData = () => ({}), statusData = () => ({}), itemProps = ITEM_PROPS } = {}) {
  const dir = tempDir('stevex-train-')
  const recipesFile = path.join(dir, 'recipes.json')
  const itemPropsFile = path.join(dir, 'item-props.json')
  if (itemProps) fs.writeFileSync(itemPropsFile, JSON.stringify({ items: itemProps }))
  fs.writeFileSync(recipesFile, JSON.stringify({ recipes: RECIPES }))
  let clock = 1_000_000
  const now = () => clock
  const sleeps = []
  const sleep = (ms) => { sleeps.push(ms); clock += ms; return new Promise((resolve) => setImmediate(resolve)) }

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
        return { ok: true, data: { arena: params.arena, ...prepareData(params) } }
      }
      const data = { active: arena.active, craftedAtMs: arena.craftedAtMs, craftedItem: arena.craftedItem, craftedDelta: { ...arena.delta }, inventory: { ...arena.inventory }, insideArena: arena.active, ...statusData(clock) }
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
  const instructions = []
  bridge.startPlanning = (args) => { planned.push(args.sessionId); instructions.push(args.instruction); return startPlanning(args) }
  const trainer = new Trainer({
    bridge, executor, game, prompts,
    config: { timeoutSec, wallTimeoutSec, pollMs: 1000, recipes: recipesFile, itemProps: itemPropsFile, arenas },
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
    now, sleep, randomSeed: () => 99, cancelTurn
  })
  const records = (name = 'craft2x2') => fs.readFileSync(path.join(dir, 'training', `${name}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const done = async () => { while (trainer.running()) await new Promise((resolve) => setImmediate(resolve)) }
  return { trainer, calls, records, done, opened, notices, planned, sleeps, instructions, arena }
}

/** 规划交树 → 跑几秒 → 合成 → 任务结束。 */
function playTask({ crafted = true, finalState = 'done', chat = false, target = 'minecraft:stick', made = 1 } = {}) {
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
        arena.craftedItem = target
        arena.delta[target] = made
        arena.inventory[target] = made
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
  assert.deepEqual(methods.slice(0, 2), ['arena/status', 'arena/prepare'], '开局先查有没有上次没结束的一轮')
  assert.equal(methods.at(-1), 'arena/finish')
  const prepare = h.calls[1][1]
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

test('trainer: a run left active by an earlier DSH process is finished before the batch starts', async () => {
  const h = harness({ script: playTask() })
  h.arena.active = true
  h.trainer.start({ sessionId: 's1', arena: 'craft2x2', item: 'stick' })
  await h.done()
  assert.deepEqual(h.calls.slice(0, 3).map(([m]) => m), ['arena/status', 'arena/finish', 'arena/prepare'])
  assert.deepEqual(h.calls[1][1], { arena: 'craft2x2', origin: [0, 100, 0] })
  assert.ok(h.notices.some(([, text]) => /清理了上次没结束的一轮（场地 craft2x2/.test(text)))
  assert.equal(h.records()[0].outcome, 'success')
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

test('trainer: time spent waiting for the planning turn does not count toward timeoutSec; wallTimeoutSec does, and cancels the turn', async () => {
  const cancelled = []
  // 规划回合一直不交：请求一直开着
  const h = harness({ script: () => {}, timeoutSec: 5, wallTimeoutSec: 30, cancelTurn: (sessionId, reason) => cancelled.push([sessionId, reason]) })
  h.trainer.start({ sessionId: 's1', arena: 'craft2x2', item: 'stick' })
  await h.done()
  const [record] = h.records()
  assert.equal(record.outcome, 'timeout')
  assert.match(record.error, /总用时超过 30 秒/)
  assert.ok(record.llmWaitMs >= 30000, `llmWaitMs=${record.llmWaitMs}`)
  assert.deepEqual(cancelled.map(([id]) => id), ['run-1'])
  assert.match(cancelled[0][1], /训练超时/)
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
  assert.match(h.trainer.start({ sessionId: 's1', arena: 'craft2x2', item: 'crafting_table_x' }).error, /没有合成 .* 的 2×2 配方/)
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
  assert.equal(rows[0].key, 'minecraft:stick')
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


// ── 工作台训练场（工作台训练场设计方案）──

const ARENAS_3X3 = { craft3x3: { origin: [0, 100, 30], mode: 'named', exclude: [], grid: 3, station: 'crafting_table', timeoutSec: 900, portions: '1', crafts: '1' } }

test('craft3x3: prepare places the station, records shape, given slots, openedMs and stationIntact', async () => {
  let openedAt = null
  let prepared = false
  const h = harness({
    script: playTask({ target: 'minecraft:oak_boat' }),
    arenas: ARENAS_3X3,
    prepareData: (params) => { prepared = true; return { aimOk: true, given: [...params.items, { slot: 35, id: 'minecraft:oak_planks', count: 1 }] } },
    statusData: (clock) => (prepared ? { openedAtMs: (openedAt ??= clock), stationIntact: true } : {})
  })
  const started = h.trainer.start({ sessionId: 's1', arena: 'craft3x3' })
  assert.equal(started.ok, true, started.error)
  await h.done()
  const [record] = h.records('craft3x3')
  assert.equal(record.outcome, 'success')
  assert.equal(record.grid, 3)
  assert.equal(record.recipe, 'oak_boat', 'the only 3×3-only recipe in the fixture')
  assert.equal(record.shape, 'A A/AAA')
  assert.ok(record.openedMs >= 0 && record.openedMs <= record.craftedMs, JSON.stringify(record))
  assert.equal(record.stationIntact, true)
  assert.deepEqual(record.slots.at(-1), { slot: 35, id: 'minecraft:oak_planks', count: 1 }, 'records what the mod actually handed out')
  const prepare = h.calls.find(([m]) => m === 'arena/prepare')[1]
  assert.equal(prepare.station, 'crafting_table')
  assert.equal(prepare.seed, record.seed)
  assert.ok(prepare.watch.includes('minecraft:stick'), 'judging reach includes 2×2 recipes')
  assert.ok(h.sleeps.includes(100), 'waits for the client to pick up the crosshair target')
})

test('craft3x3: crosshair not on the station → aborted, arena finished, the batch stops before planning', async () => {
  const h = harness({ script: playTask(), arenas: ARENAS_3X3, prepareData: () => ({ aimOk: false }) })
  h.trainer.start({ sessionId: 's1', arena: 'craft3x3', runs: 3 })
  await h.done()
  const records = h.records('craft3x3')
  assert.equal(records.length, 1)
  assert.equal(records[0].outcome, 'aborted')
  assert.match(records[0].error, /aimOk=false/)
  assert.deepEqual(h.calls.map(([m]) => m), ['arena/status', 'arena/prepare', 'arena/finish'])
  assert.deepEqual(h.planned, [])
})

test('craft3x3: the arena timeoutSec overrides the global one; the craft3x3 templates describe the station', async () => {
  const script = ({ req, executor }) => setImmediate(() => {
    req.closed = true
    executor.task = { taskId: req.taskId, state: 'running' }
    executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
  })
  const h = harness({ script, timeoutSec: 600, arenas: { craft3x3: { ...ARENAS_3X3.craft3x3, timeoutSec: 5 } }, prepareData: () => ({ aimOk: true }) })
  h.trainer.start({ sessionId: 's1', arena: 'craft3x3' })
  await h.done()
  const [record] = h.records('craft3x3')
  assert.equal(record.outcome, 'timeout')
  assert.ok(record.taskMs < 60_000, 'stopped after ~5 s, not 600 s')

  for (const mode of ['named', 'hidden']) {
    const text = prompts.training[`craft3x3_${mode}`]
    assert.match(text, /正前方有一个工作台/)
    assert.doesNotMatch(text, /右键/, 'describe the situation, do not teach the move')
  }
})

test('report: group by shape, station columns only for station arenas, capsules older than the first run', async () => {
  const { summarize, formatSummary, priorCapsules, formatPriorCapsules } = await import('../src/training/report.js')
  const rec = (run, shape, outcome, extra = {}) => ({ batch: 'b1', run, target: `minecraft:t${run}`, shape, outcome, craftedMs: 9000, openedMs: 2000, taskMs: 10000, tokens: null, usedChatSend: false, stationIntact: true, capsules: [], ...extra })
  const records = [
    rec(1, 'AAA', 'success', { t0: '2026-11-01T10:00:00.000Z', capsules: ['trees/craft.once-2x2@aaa', 'code/new.thing@bbb', 'code/core.json.query@x'] }),
    rec(2, 'AAA', 'failed', { stationIntact: false, capsules: ['code/retired.old@ccc'] }),
    rec(3, 'A A/AAA', 'success', { openedMs: 4000, t0: '2026-11-01T11:00:00.000Z' })
  ]
  const byShape = summarize(records, { by: 'shape' })
  assert.deepEqual(byShape.rows.map((r) => [r.key, r.runs]), [['AAA', 2], ['A A/AAA', 1]])
  assert.equal(byShape.station, true)
  assert.equal(byShape.total.stationBroken, 1)
  assert.equal(byShape.total.medianOpenedMs, 3000)
  const text = formatSummary(byShape)
  assert.match(text.split('\n')[0], /^形状\t.*打开工作台中位.*工作台被挖$/)
  assert.doesNotMatch(formatSummary(summarize([{ target: 'x', outcome: 'success', craftedMs: 1, taskMs: 1, stationIntact: null }])), /工作台/, '2×2 output is unchanged')

  const dir = tempDir('stevex-report-')
  const write = (rel, when) => {
    const file = path.join(dir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{}')
    fs.utimesSync(file, when / 1000, when / 1000)
  }
  const first = Date.parse('2026-11-01T10:00:00.000Z')
  write('trees/craft.once-2x2@aaa.json', first - 86_400_000)
  write('code/new.thing@bbb.json', first + 60_000)
  write('archive/2026-10-31/code/retired.old@ccc.json', first - 3_600_000)
  const prior = priorCapsules(records, dir)
  assert.equal(prior.since, '2026-11-01T10:00:00.000Z')
  assert.deepEqual(prior.runs.map((r) => [r.run, r.refs]), [[1, ['trees/craft.once-2x2@aaa']], [2, ['code/retired.old@ccc']]], 'new, built-in and missing refs are not counted; archived ones are')
  assert.match(formatPriorCapsules(prior), /轮次：2[\s\S]*trees\/craft\.once-2x2@aaa\t1 轮/)
  assert.match(formatPriorCapsules(priorCapsules(records.slice(2), dir)), /没有一轮引用过/)
})

// ── 多份材料、指定产物个数（训练场设计方案 T14）──

test('slotsNeeded / maxPortions: materials + products for all n portions + craft remainders', () => {
  const props = { 'minecraft:milk_bucket': { maxStack: 1, remainder: 'minecraft:bucket' }, 'minecraft:bucket': { maxStack: 16 }, 'minecraft:sugar': { maxStack: 64 },
    'minecraft:egg': { maxStack: 16 }, 'minecraft:wheat': { maxStack: 64 }, 'minecraft:cake': { maxStack: 1 }, 'minecraft:oak_planks': { maxStack: 64 }, 'minecraft:stick': { maxStack: 64 } }
  const cake = [{ id: 'minecraft:milk_bucket', count: 3 }, { id: 'minecraft:sugar', count: 2 }, { id: 'minecraft:egg', count: 1 }, { id: 'minecraft:wheat', count: 3 }]
  assert.deepEqual(slotsNeeded(cake, 'minecraft:cake', 1, 7, props), { materials: 24, product: 7, remainders: 2, total: 33 })
  assert.equal(slotsNeeded(cake, 'minecraft:cake', 1, 8, props).total, 37)
  assert.equal(maxPortions(cake, 'minecraft:cake', 1, props), 7, 'the worked example in T14')
  assert.equal(maxPortions([{ id: 'minecraft:oak_planks', count: 2 }], 'minecraft:stick', 4, props), 64, 'capped at 64')
  assert.throws(() => slotsNeeded([{ id: 'minecraft:dirt', count: 1 }], 'minecraft:stick', 1, 1, props), /item-props\.json 里没有 minecraft:dirt/)
  assert.deepEqual(parseCountSpec('4', 'n'), { lo: 4, hi: 4 })
  assert.deepEqual(parseCountSpec('2-5', 'n'), { lo: 2, hi: 5 })
  assert.throws(() => parseCountSpec('0', 'n'), /1–64/)
})

test('sample in multi mode: n × materials, m < n by default, redraw n when it does not fit, merge stacks to leave room', () => {
  const pool = candidates(RECIPES, ['crafting_table'])
  const single = sample(pool, 123)
  assert.deepEqual({ ...sample(pool, 123, null, { portions: null }) }, single, 'single mode keeps the old random sequence')
  assert.equal(single.portions, 1)
  assert.equal(single.wanted, single.yield)

  for (let seed = 0; seed < 50; seed++) {
    const run = sample(pool, seed, 'stick', { portions: { lo: 2, hi: 5 }, crafts: null, props: ITEM_PROPS })
    assert.ok(run.portions >= 2 && run.portions <= 5)
    assert.ok(run.crafts >= 1 && run.crafts < run.portions, JSON.stringify(run))
    assert.equal(run.wanted, run.crafts * 4)
    assert.equal(run.slots.reduce((n, s) => n + s.count, 0), 2 * run.portions, 'hands out n portions')
    assert.equal(new Set(run.slots.map((s) => s.slot)).size, run.slots.length)
  }
  assert.deepEqual(sample(pool, 9, 'stick', { portions: { lo: 2, hi: 5 }, props: ITEM_PROPS }), sample(pool, 9, 'stick', { portions: { lo: 2, hi: 5 }, props: ITEM_PROPS }), 'reproducible')

  // 64 份木棍：128 块木板，随机拆堆会碎成几十堆；合并后材料格 + 产物预留（256 根 = 4 格）≤ 36
  const big = sample(pool, 3, 'stick', { portions: { lo: 64, hi: 64 }, props: ITEM_PROPS })
  const used = big.slots.reduce((n, s) => n + Math.ceil(s.count / 64), 0)
  assert.ok(used + 4 <= 36, `materials ${used} + products 4 must fit`)
  assert.equal(big.slots.reduce((n, s) => n + s.count, 0), 128)

  // 不可堆叠的材料：n_max 很小，范围内重抽
  const props = { ...ITEM_PROPS, 'minecraft:iron_ingot': { maxStack: 1 }, 'minecraft:shears': { maxStack: 1 } }
  for (let seed = 0; seed < 20; seed++) {
    const run = sample(pool, seed, 'shears', { portions: { lo: 1, hi: 64 }, props })
    assert.equal(run.nMax, 12, '2n ingots + n shears ≤ 36')
    assert.ok(run.portions <= 12)
  }
  assert.throws(() => sample(pool, 0, 'shears', { portions: { lo: 20, hi: 20 }, props }), /最多发 12 份/)
  assert.throws(() => sample(pool, 0, 'shears', { portions: { lo: 13, hi: 64 }, props }), /最多发 12 份/)
  assert.throws(() => sample(pool, 0, 'stick', { portions: { lo: 2, hi: 2 } }), /item-props\.json/)
})

test('resolveCounts and judge with counts: overshoot fails, exact is success', () => {
  assert.deepEqual(resolveCounts({ portions: '1', crafts: '1' }, { mode: 'named' }), { single: true })
  assert.deepEqual(resolveCounts({ portions: null, crafts: null }, { mode: 'named' }), { single: false, portions: { lo: 1, hi: 64 }, crafts: null }, 'default is random')
  assert.deepEqual(resolveCounts({ portions: null, crafts: null }, { mode: 'named', portions: '1', crafts: '1' }), { single: true }, 'arena default')
  assert.deepEqual(resolveCounts({ portions: '4', crafts: null }, { mode: 'named', portions: '1', crafts: '1' }).portions, { lo: 4, hi: 4 }, 'command line wins')
  assert.deepEqual(resolveCounts({ portions: null, crafts: null }, { mode: 'hidden' }), { single: true })
  assert.throws(() => resolveCounts({ portions: '2', crafts: null }, { mode: 'hidden' }), /hidden/)
  assert.throws(() => resolveCounts({ portions: '3', crafts: '4' }, { mode: 'named' }), /m 不能大于 n/)

  assert.equal(judge({ taskState: 'done', made: 8, wanted: 8 }), 'success')
  assert.equal(judge({ taskState: 'done', made: 16, wanted: 8 }), 'overshoot')
  assert.equal(judge({ taskState: 'failed', made: 9, wanted: 8 }), 'overshoot')
  assert.equal(judge({ taskState: 'done', made: 4, wanted: 8 }), 'false_success')
  assert.equal(judge({ taskState: 'failed', made: 8, wanted: 8 }), 'crafted_but_failed')
  assert.equal(judge({ taskState: 'failed', made: 0, wanted: 8 }), 'failed')
  assert.equal(judge({ timedOut: true, taskState: 'failed', made: 16, wanted: 8 }), 'timeout')
})

const ARENAS_MULTI = { craft2x2: { origin: [0, 100, 0], mode: 'named', exclude: [] } }

test('multi run: n portions, want in items, exact count succeeds; records the T14 fields and uses the multi template', async () => {
  const h = harness({ script: playTask({ made: 8 }), arenas: ARENAS_MULTI })
  const started = h.trainer.start({ sessionId: 's1', arena: 'craft2x2', item: 'stick', portions: '4', crafts: '2' })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /n=4，m=2/)
  await h.done()
  const [record] = h.records()
  assert.equal(record.outcome, 'success')
  assert.deepEqual([record.single, record.portions, record.crafts, record.yield, record.wanted, record.made, record.overshoot], [false, 4, 2, 4, 8, 8, 0])
  assert.ok(record.reachedMs !== null && record.reachedMs >= record.craftedMs, JSON.stringify(record))
  assert.equal(record.slots.reduce((n, s) => n + s.count, 0), 8, '4 portions of 2 planks')
  assert.equal(h.instructions[0], '你的物品栏里有合成 4 次 minecraft:stick 所需的材料。请用这些材料合成 8 个 minecraft:stick，不要多做。')
})

test('multi run: making more than asked is overshoot; no n/m means random n with m < n', async () => {
  const over = harness({ script: playTask({ made: 16 }), arenas: ARENAS_MULTI })
  over.trainer.start({ sessionId: 's1', arena: 'craft2x2', item: 'stick', portions: '4', crafts: '2' })
  await over.done()
  const [record] = over.records()
  assert.equal(record.outcome, 'overshoot')
  assert.equal(record.overshoot, 8)

  const random = harness({ script: playTask({ made: 0, crafted: false, finalState: 'failed' }), arenas: ARENAS_MULTI })
  random.trainer.start({ sessionId: 's1', arena: 'craft2x2', item: 'stick', runs: 3, seed: 5 })
  await random.done()
  for (const r of random.records()) {
    assert.equal(r.single, false)
    assert.ok(r.portions >= 1 && r.portions <= 64)
    assert.ok(r.portions === 1 ? r.crafts === 1 : r.crafts < r.portions)
  }
})

test('multi run: missing item-props.json or a target that never fits is refused up front; single mode does not need the file', () => {
  const noProps = harness({ script: () => {}, arenas: ARENAS_MULTI, itemProps: null })
  assert.match(noProps.trainer.start({ sessionId: 's1', arena: 'craft2x2' }).error, /item-props\.json/)
  assert.equal(noProps.trainer.start({ sessionId: 's1', arena: 'craft2x2', portions: '1', crafts: '1' }).ok, true)

  const tight = harness({ script: () => {}, arenas: ARENAS_MULTI, itemProps: { ...ITEM_PROPS, 'minecraft:iron_ingot': { maxStack: 1 }, 'minecraft:shears': { maxStack: 1 } } })
  assert.match(tight.trainer.start({ sessionId: 's1', arena: 'craft2x2', item: 'shears', portions: '20' }).error, /最多发 12 份/)
})

test('report: overshoot and reached columns only when there are multi runs; --by portions groups n/m', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (portions, crafts, outcome, extra = {}) => ({ target: 'minecraft:stick', outcome, single: false, portions, crafts, craftedMs: 1000, reachedMs: 3000, taskMs: 4000, tokens: null, usedChatSend: false, stationIntact: null, ...extra })
  const records = [rec(4, 2, 'success'), rec(4, 2, 'overshoot'), rec(3, 1, 'success', { reachedMs: 1000 }), { ...rec(1, 1, 'success'), single: true }]
  const byPortions = summarize(records, { by: 'portions' })
  assert.deepEqual(byPortions.rows.map((r) => [r.key, r.runs]), [['4/2', 2], ['3/1', 1], ['单次', 1]])
  assert.equal(byPortions.total.overshoot, 1)
  assert.equal(byPortions.rows[0].medianReachedMs, 3000)
  assert.match(formatSummary(byPortions).split('\n')[0], /^n\/m\t.*\t超量\t.*合成中位\t做够中位\t/)
  assert.doesNotMatch(formatSummary(summarize([{ target: 'x', outcome: 'success', craftedMs: 1, taskMs: 1 }])), /超量|做够/, 'old records keep the old columns')
  assert.equal(summarize([{ target: 'x', outcome: 'success' }], { by: 'portions' }).rows[0].key, '（未记录）')
})

test('splitStacks (T14 revision): total stack count drawn in [K_min, K_max], every stack within its stack size', async () => {
  const { splitStacks, rng } = await import('../src/training/sampler.js')
  const props = { 'minecraft:oak_planks': { maxStack: 64 }, 'minecraft:stick': { maxStack: 64 }, 'minecraft:egg': { maxStack: 16 }, 'minecraft:cake': { maxStack: 1 } }
  const recipe = { result: 'minecraft:stick', count: 4 }
  const materials = [{ id: 'minecraft:oak_planks', count: 2 }]
  // n = 64：128 块木板，K_min = 2，K_max = 36 − 4（256 根木棍）= 32
  const ks = new Set()
  for (let seed = 0; seed < 300; seed++) {
    const stacks = splitStacks(rng(seed), materials, recipe, 64, props)
    assert.equal(stacks.reduce((n, s) => n + s.count, 0), 128)
    assert.ok(stacks.every((s) => s.count >= 1 && s.count <= 64))
    assert.ok(stacks.length >= 2 && stacks.length <= 32, `K = ${stacks.length}`)
    ks.add(stacks.length)
  }
  assert.ok(ks.has(2) && ks.has(32) && ks.size > 20, 'K spreads over the whole range, not pinned near the top')

  // 两种材料、一种上限 16：每种至少拆到放得下
  const two = splitStacks(rng(1), [{ id: 'minecraft:oak_planks', count: 1 }, { id: 'minecraft:egg', count: 1 }], { result: 'minecraft:cake', count: 1 }, 20, props)
  assert.ok(two.filter((s) => s.id === 'minecraft:egg').every((s) => s.count <= 16))
  assert.ok(two.filter((s) => s.id === 'minecraft:egg').length >= 2)
  // 份数少时 K_max = 总个数：每堆至少 1 个
  const tiny = splitStacks(rng(2), materials, recipe, 1, props)
  assert.ok(tiny.length >= 1 && tiny.length <= 2)
})

test('mc_source_* results from the recipe generator carry a note pointing at json.recipes; other files do not', async () => {
  const { recipeSourceNote } = await import('../src/tools/facts.js')
  assert.match(recipeSourceNote({ text: 'net/minecraft/data/recipes/RecipeProvider.java:374: \tpublic void harness(' }), /json\.recipes/)
  assert.match(recipeSourceNote({ file: 'net/minecraft/data/recipes/packs/VanillaRecipeProvider.java' }), /熔炼、切石、锻造/)
  assert.equal(recipeSourceNote({ text: 'net/minecraft/world/item/HoneycombItem.java:40: WAXING' }), null)
  assert.equal(recipeSourceNote({ file: 'net/minecraft/world/inventory/ResultSlot.java' }), null)
})

test('stop while the finished run is still in review: the review is abandoned, its turn cancelled, the batch ends', async () => {
  const h = harness({ script: playTask(), arenas: ARENAS_2X2 })
  const bridge = h.trainer.bridge
  let reviewing = false
  const abandoned = []
  const cancelled = []
  const busy = bridge.busyReason
  bridge.busyReason = () => (reviewing ? '复盘请求 c1 还没结束' : busy())
  bridge.abandonReviews = (reason) => { abandoned.push(reason); reviewing = false; return ['run-1'] }
  h.trainer.cancelTurn = (sessionId, reason) => cancelled.push([sessionId, reason])
  // 任务一结束就进入"复盘中"，复盘自己永远不结束
  const onTask = (summary) => { if (summary.state === 'done') reviewing = true }
  h.trainer.executor.on('task', onTask)
  h.trainer.start({ sessionId: 'console', arena: 'craft2x2', item: 'stick', runs: 3 })
  while (!reviewing) await new Promise((resolve) => setImmediate(resolve))
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.trainer.running(), true, 'without stop it keeps waiting for the review')
  assert.match(h.trainer.stop().text, /第 1 轮已经做完，中断它的复盘/)
  await h.done()
  const records = h.records()
  assert.equal(records.length, 1, 'no new run starts')
  assert.equal(records[0].outcome, 'success', 'the finished run keeps its result')
  assert.deepEqual(abandoned, ['training stopped (/bt train stop)'])
  assert.deepEqual(cancelled, [['run-1', 'training stopped (/bt train stop)']])

  // 回合不响应取消：等满 30 秒就不再等
  const stuck = harness({ script: playTask(), arenas: ARENAS_2X2 })
  let stuckReviewing = false
  const busy2 = stuck.trainer.bridge.busyReason
  stuck.trainer.bridge.busyReason = () => (stuckReviewing ? '复盘请求 c1 还没结束' : busy2())
  stuck.trainer.bridge.abandonReviews = () => []
  stuck.trainer.executor.on('task', (summary) => { if (summary.state === 'done') stuckReviewing = true })
  stuck.trainer.start({ sessionId: 'console', arena: 'craft2x2', item: 'stick', runs: 3 })
  while (!stuckReviewing) await new Promise((resolve) => setImmediate(resolve))
  stuck.trainer.stop()
  await stuck.done()
  assert.equal(stuck.records().length, 1)
})
