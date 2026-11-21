import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { candidates, craftableResults, fitsGrid, maxPortions, parseCountSpec, patternSize, sample, shapeOf, slotsNeeded } from '../src/training/sampler.js'
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
  // 空行空列不算（2026-11-13）：游戏匹配时会去掉；只按原样量宽度会把它们算成 3x3
  const padded = { name: 'chiseled', result: 'minecraft:chiseled_copper', count: 1, type: 'shaped', pattern: [' M ', ' M '], key: { M: ['minecraft:cut_copper_slab'] } }
  assert.equal(fitsGrid(padded), true, 'padded columns are trimmed')
  assert.deepEqual(patternSize(['   ', ' # ', ' I ']), { rows: 2, cols: 1 })
  assert.deepEqual(patternSize(['#  ', '## ', '###']), { rows: 3, cols: 3 }, 'stairs stay 3x3')
  assert.deepEqual(candidates([padded], [], 3), [], 'not a 3x3 candidate')
  assert.deepEqual(candidates([padded], [], 2).map((r) => r.name), ['chiseled'])
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
  const none = { kind: null, rel: null, chest: null, stack: null, fill: null, types: null, targets: null, materials: null, slots: null, styles: null, bypass: null, material: null,
    station: null, raw: null, fuel: null, rawSlots: null, fuelSlots: null, input: null, fuelItem: null, bookshelves: null, xpLevel: null,
    effect: null, amplifier: null, primary: null, level: null, payment: null, count: null, task: null, second: null, enchants: null, curses: null }
  assert.deepEqual(parseTrainArgs(['craft2x2', 'item=stick', 'runs=5', 'seed=7']), { ok: true, arena: 'craft2x2', item: 'stick', runs: 5, seed: 7, portions: null, crafts: null, ...none })
  assert.deepEqual(parseTrainArgs(['craft2x2']), { ok: true, arena: 'craft2x2', item: null, runs: 1, seed: null, portions: null, crafts: null, ...none })
  assert.deepEqual(parseTrainArgs(['craft2x2', 'n=2-5', 'm=1']), { ok: true, arena: 'craft2x2', item: null, runs: 1, seed: null, portions: '2-5', crafts: '1', ...none })
  assert.deepEqual(parseTrainArgs(['chest', 'kind=take', 'rel=lt', 'chest=large', 'stack=16', 'fill=full', 'types=2-3', 'targets=1-3']),
    { ok: true, arena: 'chest', item: null, runs: 1, seed: null, portions: null, crafts: null, ...none, kind: 'take', rel: 'lt', chest: 'large', stack: '16', fill: 'full', types: '2-3', targets: '1-3' })
  assert.deepEqual(parseTrainArgs(['stonecutter', 'materials=2', 'slots=1-3', 'styles=2', 'bypass=keep', 'material=stone', 'fill=full']),
    { ok: true, arena: 'stonecutter', item: null, runs: 1, seed: null, portions: null, crafts: null, ...none, materials: '2', slots: '1-3', styles: '2', bypass: 'keep', material: 'stone', fill: 'full' })
  assert.match(parseTrainArgs(['stonecutter', 'materials=4']).error, /materials 要写 k 或 a-b（1–3/)
  assert.match(parseTrainArgs(['stonecutter', 'slots=10']).error, /slots 要写 k 或 a-b（1–9/)
  assert.match(parseTrainArgs(['stonecutter', 'styles=0']).error, /styles/)
  assert.match(parseTrainArgs(['stonecutter', 'bypass=no']).error, /exclude \/ keep/)
  assert.match(parseTrainArgs(['stonecutter', 'material=A B']).error, /material 不像物品 id/)
  assert.match(parseTrainArgs(['chest', 'targets=5']).error, /targets 要写 k 或 a-b（1–4/)
  assert.match(parseTrainArgs(['chest', 'fill=half']).error, /random \/ full \/ mix/)
  assert.equal(parseTrainArgs(['chest', 'chest=hopper']).chest, 'hopper')
  assert.match(parseTrainArgs(['chest', 'chest=barrel']).error, /small \/ large \/ hopper \/ dispenser \/ mix \/ all/)
  assert.match(parseTrainArgs(['chest', 'kind=swap']).error, /take \/ put \/ mix/)
  assert.match(parseTrainArgs(['chest', 'stack=32']).error, /64 \/ 16 \/ 1/)
  assert.match(parseTrainArgs(['chest', 'types=10']).error, /1–9/)
  assert.match(parseTrainArgs(['craft2x2', 'n=65']).error, /1–64/)
  assert.match(parseTrainArgs(['craft2x2', 'n=5-2']).error, /a ≤ b/)
  assert.equal(parseTrainArgs([]).ok, false)
  assert.equal(parseTrainArgs(['craft2x2', 'runs=0']).ok, false)
  assert.equal(parseTrainArgs(['craft2x2', 'color=3']).ok, false)
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
  assert.deepEqual(arena, ['arena/build', 'arena/prepare', 'arena/enchant-preview', 'arena/anvil-catalog', 'arena/anvil-preview', 'arena/status', 'arena/finish'])
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

function harness({ script, timeoutSec = 600, wallTimeoutSec = 2400, cancelTurn = () => {}, openFails = false, consoleAlive = () => true, arenas = ARENAS_2X2, prepareData = () => ({}), statusData = () => ({}), itemProps = ITEM_PROPS, recipes = RECIPES, stonecutting = null, cooking = null, onCall = null } = {}) {
  const dir = tempDir('stevex-train-')
  const recipesFile = path.join(dir, 'recipes.json')
  const itemPropsFile = path.join(dir, 'item-props.json')
  const stonecuttingFile = path.join(dir, 'stonecutting.json')
  const cookingFile = path.join(dir, 'cooking.json')
  if (itemProps) fs.writeFileSync(itemPropsFile, JSON.stringify({ items: itemProps }))
  if (stonecutting) fs.writeFileSync(stonecuttingFile, JSON.stringify({ recipes: stonecutting }))
  if (cooking) fs.writeFileSync(cookingFile, JSON.stringify({ recipes: cooking }))
  fs.writeFileSync(recipesFile, JSON.stringify({ recipes }))
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
      const extra = onCall?.(method, params)
      if (extra) return extra
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
    config: { timeoutSec, wallTimeoutSec, pollMs: 1000, recipes: recipesFile, itemProps: itemPropsFile, stonecutting: stonecuttingFile, cooking: cookingFile, arenas },
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
  assert.match(recipeSourceNote({ file: 'net/minecraft/data/recipes/packs/VanillaRecipeProvider.java' }), /切石机配方在 json\.stonecutting 里.*json\.cooking.*锻造/)
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

// ── 箱子训练场（箱子训练场设计方案）──

const storageModule = await import('../src/training/storage.js')

const SPROPS = Object.fromEntries([
  ['stone', 64], ['dirt', 64], ['oak_log', 64], ['sand', 64], ['gravel', 64],
  ['egg', 16], ['snowball', 16], ['ender_pearl', 16],
  ['iron_sword', 1], ['shears', 1], ['bundle', 1]
].map(([id, maxStack]) => [`minecraft:${id}`, { maxStack }]))

test('storage sampler: layout within half the source, rel gives k, reproducible, bundle excluded', () => {
  const { sampleStorage, storagePool, countsOf } = storageModule
  const pool = storagePool(SPROPS, ['minecraft:bundle'])
  assert.equal(pool.includes('minecraft:bundle'), false)
  assert.deepEqual(sampleStorage(pool, SPROPS, 42), sampleStorage(pool, SPROPS, 42), 'same seed, same task')
  const seen = { kind: new Set(), rel: new Set(), chest: new Set(), stackClass: new Set() }
  for (let seed = 0; seed < 300; seed++) {
    const t = sampleStorage(pool, SPROPS, seed, { types: { lo: 1, hi: 9 } })
    for (const key of Object.keys(seen)) seen[key].add(t[key])
    const capacity = t.kind === 'take' ? t.chestSlots : 36
    const source = t.kind === 'take' ? t.layout.chest : t.layout.inventory
    const dest = t.kind === 'take' ? t.layout.inventory : t.layout.chest
    assert.deepEqual(dest, [], 'dest starts empty (C6)')
    assert.equal(t.chestSlots, t.chest === 'large' ? 54 : 27)
    assert.ok(source.length >= t.types && source.length <= Math.floor(capacity / 2), `slots ${source.length} of ${capacity}`)
    assert.equal(new Set(source.map((s) => s.slot)).size, source.length, 'distinct slots')
    assert.ok(source.every((s) => s.slot >= 0 && s.slot < capacity && s.count >= 1 && s.count <= SPROPS[s.id].maxStack), JSON.stringify(source))
    assert.equal(new Set(source.map((s) => s.id)).size, t.types, 'every kind of item has at least one slot')
    assert.ok(!t.distractors.includes(t.target) && new Set(t.distractors).size === t.types - 1)
    assert.equal(countsOf(source)[t.target], t.n)
    if (t.rel === 'lt') assert.ok(t.k >= 1 && t.k < t.n, `lt: k ${t.k} n ${t.n}`)
    if (t.rel === 'eq') assert.equal(t.k, t.n)
    if (t.rel === 'gt') assert.ok(t.k > t.n && t.k <= Math.max(Math.floor(capacity / 2) * t.stackClass, t.n + 1), `gt: k ${t.k} n ${t.n}`)
    assert.equal(t.want, Math.min(t.k, t.n))
  }
  assert.deepEqual([...seen.kind].sort(), ['put', 'take'])
  assert.deepEqual([...seen.rel].sort(), ['eq', 'gt', 'lt'])
  assert.deepEqual([...seen.chest].sort(), ['large', 'small'])
  assert.deepEqual([...seen.stackClass].sort((a, b) => a - b), [1, 16, 64], 'mix draws every stack class')

  // 不可堆叠的目标、lt：至少 2 格，k < n 才有解
  for (let seed = 0; seed < 50; seed++) {
    const t = sampleStorage(pool, SPROPS, seed, { rel: 'lt', stack: '1', types: { lo: 1, hi: 1 } })
    assert.equal(t.stackClass, 1)
    assert.ok(t.n >= 2 && t.k < t.n)
  }
  // fill=full：每格都满一组（干扰物品也满），n = 目标格数 × 堆叠上限；fill=mix 两种都出
  const fills = new Set()
  for (let seed = 0; seed < 100; seed++) {
    const t = sampleStorage(pool, SPROPS, seed, { fill: 'full', types: { lo: 1, hi: 4 } })
    const source = t.kind === 'take' ? t.layout.chest : t.layout.inventory
    assert.equal(t.fill, 'full')
    assert.ok(source.every((s) => s.count === SPROPS[s.id].maxStack), JSON.stringify(source))
    assert.equal(t.n, source.filter((s) => s.id === t.target).length * t.stackClass)
    if (t.rel === 'lt') assert.ok(t.k >= 1 && t.k < t.n)
    fills.add(sampleStorage(pool, SPROPS, seed, { fill: 'mix' }).fill)
  }
  assert.deepEqual([...fills].sort(), ['full', 'random'])
  assert.equal(sampleStorage(pool, SPROPS, 5).fill, 'random', 'fill defaults to random')
  // §8：漏斗、发射器。容量 5 / 9；种类数 ≤ 一半 − 目标最少格数 + 1；放进题目标最多占容器的格数
  const sizes = { mix: new Set(), all: new Set() }
  for (let seed = 0; seed < 400; seed++) {
    sizes.mix.add(sampleStorage(pool, SPROPS, seed, { chest: 'mix' }).chest)
    sizes.all.add(sampleStorage(pool, SPROPS, seed, { chest: 'all' }).chest)
    for (const chest of ['hopper', 'dispenser']) {
      const t = sampleStorage(pool, SPROPS, seed, { chest, types: { lo: 1, hi: 9 } })
      const slots = { hopper: 5, dispenser: 9 }[chest]
      assert.equal(t.chestSlots, slots)
      const capacity = t.kind === 'take' ? slots : 36
      const source = t.kind === 'take' ? t.layout.chest : t.layout.inventory
      const half = Math.floor(capacity / 2)
      assert.ok(source.length >= t.types && source.length <= half, `${chest} ${t.kind}: ${source.length} slots, half ${half}`)
      assert.ok(source.every((x) => x.slot >= 0 && x.slot < capacity), JSON.stringify(source))
      assert.equal(new Set(source.map((x) => x.id)).size, t.types)
      if (t.kind === 'put') {
        assert.ok(source.filter((x) => x.id === t.target).length <= slots, 'put: the target fits into the container')
        assert.ok(t.want <= slots * t.stackClass)
      }
      if (t.rel === 'lt') assert.ok(t.k >= 1 && t.k < t.n)
    }
    // 漏斗取物、lt、不可堆叠：一半只有 2 格，目标要占 2 格 → 只有 1 种物品
    const tight = sampleStorage(pool, SPROPS, seed, { kind: 'take', chest: 'hopper', rel: 'lt', stack: '1', types: { lo: 1, hi: 9 } })
    assert.equal(tight.types, 1)
    assert.equal(tight.layout.chest.length, 2)
    assert.ok(tight.n === 2 && tight.k === 1)
    // 放进漏斗、要求全部、每格满：n 一定装得下
    const full = sampleStorage(pool, SPROPS, seed, { kind: 'put', chest: 'hopper', rel: 'gt', fill: 'full', types: { lo: 1, hi: 1 } })
    assert.ok(full.n <= 5 * full.stackClass && full.layout.inventory.length <= 5)
  }
  assert.deepEqual([...sizes.mix].sort(), ['large', 'small'], 'mix stays with the two chests (old seeds unchanged)')
  assert.deepEqual([...sizes.all].sort(), ['dispenser', 'hopper', 'large', 'small'])
  // §9：多目标。targets=1 与不写一样；各目标不同、都在来源方里；types 含全部目标；放进题全部目标合计 ≤ 容器格数
  assert.deepEqual(sampleStorage(pool, SPROPS, 8, { targets: { lo: 1, hi: 1 } }), sampleStorage(pool, SPROPS, 8))
  const counts = new Set()
  for (let seed = 0; seed < 300; seed++) {
    for (const chest of ['small', 'large', 'hopper', 'dispenser']) {
      const t = sampleStorage(pool, SPROPS, seed, { chest, targets: { lo: 1, hi: 3 }, types: { lo: 1, hi: 4 } })
      counts.add(t.targetCount)
      assert.equal(t.targets.length, t.targetCount)
      assert.equal(t.targets[0].id, t.target, 'the first target keeps the old top-level fields')
      assert.equal(new Set(t.targets.map((g) => g.id)).size, t.targetCount, 'distinct targets')
      assert.ok(t.types >= t.targetCount, 'types includes every target')
      assert.ok(t.targets.every((g) => !t.distractors.includes(g.id)))
      assert.deepEqual([...t.askOrder].sort(), t.targets.map((g) => g.id).sort())
      const source = t.kind === 'take' ? t.layout.chest : t.layout.inventory
      const capacity = t.kind === 'take' ? t.chestSlots : 36
      assert.ok(source.length <= Math.floor(capacity / 2), `${chest} ${t.kind}: ${source.length} slots`)
      for (const g of t.targets) {
        assert.equal(countsOf(source)[g.id], g.n)
        assert.equal(g.want, Math.min(g.k, g.n))
        if (g.rel === 'lt') assert.ok(g.k >= 1 && g.k < g.n)
        if (g.rel === 'eq') assert.equal(g.k, g.n)
        if (g.rel === 'gt') assert.ok(g.k > g.n)
      }
      if (t.kind === 'put') assert.ok(source.filter((x) => t.targets.some((g) => g.id === x.id)).length <= t.chestSlots, 'all targets together fit into the container')
    }
  }
  assert.deepEqual([...counts].sort(), [1, 2, 3])
  // 漏斗取物：一半只有 2 格，要 3 种目标出不了 → 降到 2 种（C23）
  for (let seed = 0; seed < 50; seed++) {
    const t = sampleStorage(pool, SPROPS, seed, { kind: 'take', chest: 'hopper', targets: { lo: 3, hi: 3 }, types: { lo: 3, hi: 3 } })
    assert.ok(t.targetCount <= 2 && t.layout.chest.length <= 2, JSON.stringify(t.layout.chest))
  }
  // 放进漏斗、3 种目标、要求全部、每格满：全部目标合计最多 5 格
  for (let seed = 0; seed < 50; seed++) {
    const t = sampleStorage(pool, SPROPS, seed, { kind: 'put', chest: 'hopper', rel: 'gt', fill: 'full', targets: { lo: 3, hi: 3 }, types: { lo: 3, hi: 4 } })
    assert.equal(t.targetCount, 3)
    assert.ok(t.layout.inventory.filter((x) => t.targets.some((g) => g.id === x.id)).length <= 5)
  }
  const fixed = sampleStorage(pool, SPROPS, 3, { item: 'egg', kind: 'put', chest: 'large' })
  assert.equal(fixed.target, 'minecraft:egg')
  assert.ok(fixed.layout.inventory.length > 0 && fixed.layout.chest.length === 0)
})

test('storage expect and judge: exact counts succeed; overshoot, disturbed, lost and cursor leftovers do not', () => {
  const { expectedCounts, judgeStorage } = storageModule
  const picked = {
    kind: 'take', target: 'minecraft:stone', want: 30,
    layout: { chest: [{ slot: 0, id: 'minecraft:stone', count: 20 }, { slot: 5, id: 'minecraft:stone', count: 20 }, { slot: 7, id: 'minecraft:egg', count: 3 }], inventory: [] }
  }
  const expect = expectedCounts(picked)
  assert.deepEqual(expect, { inventory: { 'minecraft:stone': 30 }, container: { 'minecraft:stone': 10, 'minecraft:egg': 3 } })
  const final = (fields) => ({ held: expect.inventory, chest: expect.container, carried: {}, dropped: {}, stationIntact: true, ...fields })
  const j = (fields, extra = {}) => judgeStorage({ taskState: 'done', final: final(fields), picked, ...extra })
  assert.deepEqual(j({}), { outcome: 'success', moved: 30, movedOf: { 'minecraft:stone': 30 }, disturbed: [], reached: true })
  assert.equal(j({}, { taskState: 'failed' }).outcome, 'failed', 'reached but reported failure')
  assert.equal(j({ held: { 'minecraft:stone': 31 }, chest: { 'minecraft:stone': 9, 'minecraft:egg': 3 } }).outcome, 'overshoot')
  const disturbed = j({ held: { 'minecraft:stone': 30, 'minecraft:egg': 1 }, chest: { 'minecraft:stone': 10, 'minecraft:egg': 2 } })
  assert.equal(disturbed.outcome, 'disturbed')
  assert.deepEqual(disturbed.disturbed, ['minecraft:egg'])
  assert.equal(j({ held: { 'minecraft:stone': 25 }, carried: { 'minecraft:stone': 5 } }).outcome, 'false_success', 'still on the cursor')
  assert.equal(j({ held: { 'minecraft:stone': 20 }, chest: { 'minecraft:stone': 20, 'minecraft:egg': 3 } }).outcome, 'false_success', 'too few')
  assert.equal(j({ held: { 'minecraft:stone': 29 }, dropped: { 'minecraft:stone': 1 } }).outcome, 'lost', 'thrown on the ground')
  assert.equal(j({ stationIntact: false }).outcome, 'lost', 'chest broken')
  assert.equal(j({ chest: null }).outcome, 'lost')
  assert.equal(j({ held: { 'minecraft:stone': 31 }, chest: { 'minecraft:stone': 9, 'minecraft:egg': 3 } }, { timedOut: true }).outcome, 'overshoot', 'overshoot outranks timeout')
  assert.equal(j({ held: {}, chest: { 'minecraft:stone': 40, 'minecraft:egg': 3 } }, { timedOut: true, taskState: 'failed' }).outcome, 'timeout')
  assert.equal(j({}, { stopped: true }).outcome, 'aborted')
  assert.equal(judgeStorage({ taskState: 'done', final: null, picked }).outcome, 'failed', 'no final state')

  const put = { kind: 'put', target: 'minecraft:egg', want: 4, layout: { chest: [], inventory: [{ slot: 9, id: 'minecraft:egg', count: 16 }, { slot: 0, id: 'minecraft:dirt', count: 1 }] } }
  assert.deepEqual(expectedCounts(put), { inventory: { 'minecraft:egg': 12, 'minecraft:dirt': 1 }, container: { 'minecraft:egg': 4 } })

  // 多目标（§9 C25）：取 30 个 stone、全部 3 个 egg，dirt 是干扰物品
  const multi = {
    kind: 'take', target: 'minecraft:stone', want: 30,
    targets: [{ id: 'minecraft:stone', want: 30 }, { id: 'minecraft:egg', want: 3 }],
    layout: { chest: [{ slot: 0, id: 'minecraft:stone', count: 40 }, { slot: 1, id: 'minecraft:egg', count: 3 }, { slot: 2, id: 'minecraft:dirt', count: 5 }], inventory: [] }
  }
  const mExpect = expectedCounts(multi)
  assert.deepEqual(mExpect, { inventory: { 'minecraft:stone': 30, 'minecraft:egg': 3 }, container: { 'minecraft:stone': 10, 'minecraft:dirt': 5 } })
  const mj = (fields) => judgeStorage({ taskState: 'done', final: { held: mExpect.inventory, chest: mExpect.container, carried: {}, dropped: {}, stationIntact: true, ...fields }, picked: multi })
  assert.deepEqual(mj({}), { outcome: 'success', moved: 30, movedOf: { 'minecraft:stone': 30, 'minecraft:egg': 3 }, disturbed: [], reached: true })
  const half = mj({ held: { 'minecraft:stone': 30 }, chest: { 'minecraft:stone': 10, 'minecraft:egg': 3, 'minecraft:dirt': 5 } })
  assert.equal(half.outcome, 'false_success', 'only one of the targets done')
  assert.deepEqual(half.movedOf, { 'minecraft:stone': 30, 'minecraft:egg': 0 })
  assert.equal(mj({ held: { 'minecraft:stone': 31, 'minecraft:egg': 3 }, chest: { 'minecraft:stone': 9, 'minecraft:dirt': 5 } }).outcome, 'overshoot', 'any target overshoots')
  const touched = mj({ held: { 'minecraft:stone': 30, 'minecraft:egg': 3, 'minecraft:dirt': 1 }, chest: { 'minecraft:stone': 10, 'minecraft:dirt': 4 } })
  assert.equal(touched.outcome, 'disturbed')
  assert.deepEqual(touched.disturbed, ['minecraft:dirt'], 'targets are not "others"')
})

test('config: the chest arena is a storage arena with its own defaults and checks; craft arenas are unchanged', () => {
  const config = normalizeConfig({})
  assert.deepEqual(config.training.arenas.chest, { type: 'storage', origin: [10000, 120, 10060], timeoutSec: 600, kind: 'mix', rel: 'mix', chest: 'mix', stack: 'mix', fill: 'random', types: '1-4', targets: '1', dest: 'empty', exclude: ['minecraft:bundle'] })
  assert.equal(config.training.arenas.craft2x2.type, undefined)
  const mine = normalizeConfig({ training: { arenas: { box: { type: 'storage', origin: [0, 100, 0], kind: 'put' } } } }).training.arenas.box
  assert.equal(mine.kind, 'put')
  assert.equal(mine.rel, 'mix', 'storage defaults fill the rest')
  assert.equal(mine.grid, undefined, 'no craft fields')
  assert.throws(() => normalizeConfig({ training: { arenas: { chest: { rel: 'ne' } } } }), /chest\.rel/)
  assert.throws(() => normalizeConfig({ training: { arenas: { chest: { types: '0-3' } } } }), /types/)
  assert.throws(() => normalizeConfig({ training: { arenas: { chest: { dest: 'partial' } } } }), /dest/)
  assert.throws(() => normalizeConfig({ training: { arenas: { chest: { type: 'smelt' } } } }), /type/)
})

const ARENAS_CHEST = { chest: { type: 'storage', origin: [0, 100, 60], timeoutSec: 600, kind: 'take', rel: 'mix', chest: 'small', stack: 'mix', types: '1-3', dest: 'empty', exclude: ['minecraft:bundle'] } }

/** 箱子题的假世界：prepare 按参数布置，script 结束前把计数改成 finalOf(params) 的样子 */
function chestHarness({ finalOf = (params) => ({ held: params.expect.inventory, chest: params.expect.container }), chestSlots = (station) => ({ large_chest: 54, hopper: 5, dispenser: 9 })[station] ?? 27, arenas = ARENAS_CHEST } = {}) {
  const { countsOf } = storageModule
  const world = { params: null, state: {} }
  const script = ({ req, executor, clock, setBusy }) => setImmediate(async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    await tick()
    req.closed = true
    req.answered = true
    executor.task = { taskId: req.taskId, state: 'running' }
    executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
    for (let i = 0; i < 3; i++) await tick()
    Object.assign(world.state, { openedAtMs: clock() - 1 }, finalOf(world.params), { reachedAtMs: clock() })
    for (let i = 0; i < 3; i++) await tick()
    executor.task.state = 'done'
    setBusy(2)
    executor.emit('task', { taskId: req.taskId, state: 'done', version: 2 })
  })
  const h = harness({
    script, arenas, itemProps: SPROPS,
    prepareData: (params) => {
      world.params = params
      world.state = { held: countsOf(params.items), chest: countsOf(params.chestItems), carried: {}, dropped: {}, stationIntact: true, openedAtMs: null, reachedAtMs: null }
      return { aimOk: true, chestSlots: chestSlots(params.station) }
    },
    statusData: () => world.state
  })
  return { ...h, world }
}

test('chest run: prepare lays out the chest and the goal, the take template is used, exact counts succeed with reachedMs', async () => {
  const h = chestHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'chest', runs: 2, seed: 11 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /kind=take，rel=mix，chest=small/)
  await h.done()
  const records = h.records('chest')
  assert.equal(records.length, 2)
  for (const [i, record] of records.entries()) {
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.equal(record.kind, 'take')
    assert.equal(record.chest, 'small')
    assert.equal(record.chestSlots, 27)
    assert.ok(record.reachedMs !== null && record.reachedMs <= record.taskMs, JSON.stringify(record))
    assert.ok(record.openedMs !== null && record.openedMs <= record.reachedMs)
    assert.equal(record.moved, record.want)
    assert.equal(record.stationIntact, true)
    assert.deepEqual(record.final.carried, {})
    assert.ok(h.instructions[i].startsWith(`你正前方有一个箱子，视角已经对准它。请从箱子里取出 ${record.k} 个 ${record.target} 放进你的物品栏；`), h.instructions[i])
  }
  const prepare = h.calls.find(([m]) => m === 'arena/prepare')[1]
  assert.equal(prepare.station, 'chest')
  assert.deepEqual(prepare.items, [], 'take: the inventory starts empty')
  assert.ok(prepare.chestItems.length > 0)
  assert.deepEqual(prepare.watch, [])
  assert.deepEqual(prepare.expect, storageModule.expectedCounts(records[0]))
  assert.ok(h.sleeps.includes(100), 'waits for the client to pick up the crosshair target')
  const texts = h.notices.map(([, text]) => text)
  assert.match(texts[0], /^第 1\/2 轮：会话 run-1，取 \d+ 个 minecraft:\w+（箱子里有 \d+ 个，(lt|eq|gt)，小箱子，\d 种物品，seed=\d+）$/)
  assert.match(texts[1], /^第 1\/2 轮结果 success，达成用时 \d+\.\d 秒，任务用时/)
  assert.doesNotMatch(prompts.training.chest_take + prompts.training.chest_put, /右键/, 'describe the situation, do not teach the move')
})

test('chest run with two targets: the multi template lists both, expect covers both, record keeps each target', async () => {
  const h = chestHarness({ arenas: { chest: { ...ARENAS_CHEST.chest, targets: '2', types: '2-3' } } })
  const started = h.trainer.start({ sessionId: 'console', arena: 'chest', runs: 1, seed: 21 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /targets=2/)
  await h.done()
  const [record] = h.records('chest')
  assert.equal(record.outcome, 'success', JSON.stringify(record))
  assert.equal(record.targetCount, 2)
  assert.equal(record.targets.length, 2)
  assert.ok(record.targets.every((t) => t.moved === t.want), JSON.stringify(record.targets))
  const prepare = h.calls.find(([m]) => m === 'arena/prepare')[1]
  for (const t of record.targets) assert.equal(prepare.expect.inventory[t.id], t.want)
  assert.ok(h.instructions[0].startsWith('你正前方有一个箱子，视角已经对准它。请从箱子里取出：'), h.instructions[0])
  for (const t of record.targets) assert.ok(h.instructions[0].includes(`${t.k} 个 ${t.id}`), h.instructions[0])
  assert.match(h.notices[0][1], /2 种目标/)
  // types 上限比 targets 下限还小 → 开训时报错
  const bad = chestHarness({ arenas: { chest: { ...ARENAS_CHEST.chest, targets: '3', types: '1-2' } } })
  assert.match(bad.trainer.start({ sessionId: 'console', arena: 'chest', runs: 1 }).error, /上限不能小于 targets 的下限 3/)
})

test('chest run with a hopper / dispenser: station name, slot self-check and the container named in the task text', async () => {
  for (const [chest, name, slots] of [['hopper', '漏斗', 5], ['dispenser', '发射器', 9]]) {
    const h = chestHarness({ arenas: { chest: { ...ARENAS_CHEST.chest, chest } } })
    assert.equal(h.trainer.start({ sessionId: 'console', arena: 'chest', runs: 1, seed: 5 }).ok, true)
    await h.done()
    const [record] = h.records('chest')
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.equal(record.chest, chest)
    assert.equal(record.chestSlots, slots)
    assert.equal(h.calls.find(([m]) => m === 'arena/prepare')[1].station, chest)
    assert.ok(h.instructions[0].startsWith(`你正前方有一个${name}，视角已经对准它。请从${name}里取出 `), h.instructions[0])
    assert.ok(h.notices[0][1].includes(`${name}里有 `) && h.notices[0][1].includes(`，${name}，`), h.notices[0][1])
  }
  // 容器格数不对（比如漏斗没放上）→ 本轮 aborted
  const wrong = chestHarness({ arenas: { chest: { ...ARENAS_CHEST.chest, chest: 'hopper' } }, chestSlots: () => 27 })
  wrong.trainer.start({ sessionId: 'console', arena: 'chest', runs: 1, seed: 5 })
  await wrong.done()
  assert.equal(wrong.records('chest')[0].outcome, 'aborted')
})

test('chest run: a large chest that did not connect aborts the batch before planning; options of the other task type are refused', async () => {
  const h = chestHarness({ chestSlots: () => 27 })
  h.trainer.start({ sessionId: 's1', arena: 'chest', chest: 'large', runs: 3 })
  await h.done()
  const records = h.records('chest')
  assert.equal(records.length, 1)
  assert.equal(records[0].outcome, 'aborted')
  assert.match(records[0].error, /large_chest has 27 slots, expected 54/)
  assert.deepEqual(h.calls.map(([m]) => m), ['arena/status', 'arena/prepare', 'arena/finish'])
  assert.deepEqual(h.planned, [])

  const both = chestHarness({ arenas: { ...ARENAS_CHEST, ...ARENAS_2X2 } })
  assert.match(both.trainer.start({ sessionId: 's1', arena: 'chest', portions: '4' }).error, /不认这些选项：n/)
  assert.match(both.trainer.start({ sessionId: 's1', arena: 'craft2x2', kind: 'take', rel: 'lt' }).error, /不认这些选项：kind、rel/)
  assert.match(both.trainer.start({ sessionId: 's1', arena: 'chest', item: 'bundle' }).error, /物品池里没有 minecraft:bundle/)
  const noProps = harness({ script: () => {}, arenas: ARENAS_CHEST, itemProps: null })
  assert.match(noProps.trainer.start({ sessionId: 's1', arena: 'chest' }).error, /item-props\.json/)
})

test('chest run: moving one too many is overshoot; the put template goes the other way', async () => {
  const over = chestHarness({
    arenas: { chest: { ...ARENAS_CHEST.chest, rel: 'lt' } },
    finalOf: (params) => {
      // 多取 1 个：目标物品是 expect 里物品栏的那一项（取之前物品栏是空的）
      const [[id, n]] = Object.entries(params.expect.inventory)
      return { held: { [id]: n + 1 }, chest: { ...params.expect.container, [id]: params.expect.container[id] - 1 } }
    }
  })
  over.trainer.start({ sessionId: 's1', arena: 'chest', seed: 5 })
  await over.done()
  const [record] = over.records('chest')
  assert.equal(record.outcome, 'overshoot', JSON.stringify(record.final))
  assert.equal(record.moved, record.want + 1)

  const put = chestHarness({ arenas: { chest: { ...ARENAS_CHEST.chest, kind: 'put', chest: 'large' } } })
  put.trainer.start({ sessionId: 's1', arena: 'chest', seed: 9 })
  await put.done()
  const [p] = put.records('chest')
  assert.equal(p.outcome, 'success')
  assert.equal(p.chestSlots, 54)
  assert.ok(/^你正前方有一个箱子，视角已经对准它。请把你物品栏里的 \d+ 个 minecraft:\w+ 放进箱子；/.test(put.instructions[0]), put.instructions[0])
  const prepare = put.calls.find(([m]) => m === 'arena/prepare')[1]
  assert.equal(prepare.station, 'large_chest')
  assert.deepEqual(prepare.chestItems, [], 'put: the chest starts empty')
})

test('report: chest records group by task / chest / stack and get their own columns', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (kind, rel, chest, stackClass, outcome, extra = {}) => ({ batch: 'b1', target: 'minecraft:stone', kind, rel, chest, stackClass, outcome, openedMs: 1000, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false, stationIntact: true, ...extra })
  const records = [
    rec('take', 'lt', 'small', 64, 'success'),
    rec('take', 'lt', 'large', 16, 'overshoot', { reachedMs: null }),
    rec('put', 'gt', 'small', 64, 'disturbed'),
    rec('put', 'eq', 'large', 1, 'lost', { stationIntact: false })
  ]
  const byTask = summarize(records, { by: 'task' })
  assert.equal(byTask.storage, true)
  assert.deepEqual(byTask.rows.map((r) => [r.key, r.runs]), [['take/lt', 2], ['put/eq', 1], ['put/gt', 1]])
  assert.deepEqual([byTask.total.overshoot, byTask.total.disturbed, byTask.total.lost, byTask.total.stationBroken], [1, 1, 1, 1])
  assert.equal(byTask.total.medianReachedMs, 5000, 'reached median over successful runs')
  const text = formatSummary(byTask)
  assert.match(text.split('\n')[0], /^取放\/关系\t轮数\t成功率\t.*超量\t动了别的\t丢失\t打开箱子中位\t达成中位\t任务中位/)
  assert.doesNotMatch(text, /合成|工作台/)
  assert.deepEqual(summarize(records, { by: 'chest' }).rows.map((r) => r.key).sort(), ['大箱子', '小箱子'])
  assert.deepEqual(summarize(records, { by: 'stack' }).rows.map((r) => r.key), ['64', '1', '16'])
  assert.deepEqual(summarize(records, { by: 'fill' }).rows.map((r) => r.key), ['随机数量'], 'records without fill count as random')
  assert.deepEqual(summarize([...records, rec('take', 'eq', 'small', 64, 'success', { targetCount: 2 })], { by: 'targets' }).rows.map((r) => [r.key, r.runs]), [['1 种', 4], ['2 种', 1]], 'records without targetCount count as one target')
  assert.doesNotMatch(formatSummary(summarize([{ target: 'x', outcome: 'success', craftedMs: 1, taskMs: 1 }])), /动了别的/, 'craft output is unchanged')
})


// ── 切石机训练场（docs/切石机训练场设计方案.md） ─────────────────────────────

const cutModule = await import('../src/training/stonecut.js')
const cut = (input, result, count) => ({ name: `${result.slice(10)}_from_${input.slice(10)}`, input, result, count })
const CUTS = [
  cut('minecraft:stone', 'minecraft:stone_slab', 2),
  cut('minecraft:stone', 'minecraft:stone_stairs', 1),
  cut('minecraft:stone', 'minecraft:stone_bricks', 1),
  cut('minecraft:stone', 'minecraft:stone_brick_slab', 2),
  cut('minecraft:stone_bricks', 'minecraft:stone_brick_slab', 2),
  cut('minecraft:granite', 'minecraft:granite_slab', 2),
  cut('minecraft:granite', 'minecraft:granite_wall', 1),
  cut('minecraft:copper_block', 'minecraft:cut_copper', 4),
  cut('minecraft:copper_block', 'minecraft:cut_copper_slab', 8),
  cut('minecraft:cut_copper', 'minecraft:cut_copper_slab', 2),
  cut('minecraft:exposed_copper', 'minecraft:exposed_cut_copper', 4),
  cut('minecraft:waxed_copper_block', 'minecraft:waxed_cut_copper', 4),
  cut('minecraft:basalt', 'minecraft:polished_basalt', 1)
]
/** 2×2 能用同一种材料直接做出的：石砖、磨制玄武岩；台阶要 3×3，不算 */
const CUT_CRAFTING = [
  { name: 'stone_bricks', result: 'minecraft:stone_bricks', count: 4, type: 'shaped', pattern: ['##', '##'], key: { '#': ['minecraft:stone'] } },
  { name: 'polished_basalt', result: 'minecraft:polished_basalt', count: 4, type: 'shaped', pattern: ['SS', 'SS'], key: { S: ['minecraft:basalt'] } },
  { name: 'stone_slab', result: 'minecraft:stone_slab', count: 6, type: 'shaped', pattern: ['###'], key: { '#': ['minecraft:stone'] } }
]

test('stonecut tables: families merge copper stages, 2×2 shortcuts are left out by default, exclude covers materials and products', () => {
  const { cutterTables, cutterFamilies, bypassPairs } = cutModule
  const fam = cutterFamilies(CUTS)
  assert.equal(fam.get('minecraft:stone_bricks'), 'stone', 'stone_bricks is cut from stone: same family, named after the material that is not cut from another')
  assert.equal(fam.get('minecraft:cut_copper'), 'copper')
  assert.equal(fam.get('minecraft:exposed_copper'), 'copper', 'oxidation stages join the copper family')
  assert.equal(fam.get('minecraft:waxed_copper_block'), 'copper', 'waxed versions too')
  assert.equal(fam.get('minecraft:granite'), 'granite')
  assert.deepEqual([...bypassPairs(CUT_CRAFTING)].sort(), ['minecraft:basalt>minecraft:polished_basalt', 'minecraft:stone>minecraft:stone_bricks'])

  const t = cutterTables(CUTS, CUT_CRAFTING)
  assert.ok(!t.pool.includes('minecraft:basalt'), 'basalt has nothing left to cut once its 2×2 shortcut is out')
  assert.deepEqual(t.outputs.get('minecraft:stone').map((o) => o.id), ['minecraft:stone_brick_slab', 'minecraft:stone_slab', 'minecraft:stone_stairs'])
  assert.deepEqual(t.families, ['copper', 'granite', 'stone'])
  const keep = cutterTables(CUTS, null, { bypass: 'keep' })
  assert.ok(keep.pool.includes('minecraft:basalt'))
  assert.equal(keep.outputs.get('minecraft:stone').length, 4)
  const ex = cutterTables(CUTS, CUT_CRAFTING, { exclude: ['granite_wall', 'minecraft:copper_block'] })
  assert.deepEqual(ex.outputs.get('minecraft:granite').map((o) => o.id), ['minecraft:granite_slab'])
  assert.ok(!ex.pool.includes('minecraft:copper_block'))
})

test('stonecut sampler: whole cuts only, one material per family, room for everything, reproducible', () => {
  const { cutterTables, sampleStonecut, cutterExpect } = cutModule
  const t = cutterTables(CUTS, CUT_CRAFTING)
  const range = (lo, hi = lo) => ({ lo, hi })
  for (const fill of ['random', 'full']) {
    for (let seed = 0; seed < 300; seed++) {
      const opts = { materials: range(1, 3), slots: range(1, 9), fill, styles: range(1, 3) }
      const p = sampleStonecut(t, seed, opts)
      assert.deepEqual(sampleStonecut(t, seed, opts), p, 'same seed, same task')
      const families = p.materials.map((m) => m.family)
      assert.equal(new Set(families).size, families.length, 'one material per family')
      assert.ok(p.materialCount >= 1 && p.materialCount <= 3)
      let slots = p.layout.length
      for (const m of p.materials) {
        const given = p.layout.filter((s) => s.id === m.id)
        assert.equal(given.length, m.slots)
        assert.equal(given.reduce((n, s) => n + s.count, 0), m.count)
        if (fill === 'full') assert.ok(given.every((s) => s.count === 64))
        const options = t.outputs.get(m.id)
        assert.ok(m.styles.length >= 1 && m.styles.length <= Math.min(3, options.length, m.count))
        assert.equal(new Set(m.styles.map((s) => s.id)).size, m.styles.length)
        const share = Math.floor(m.count / m.styles.length)
        for (const s of m.styles) {
          assert.equal(s.yield, options.find((o) => o.id === s.id).yield)
          assert.equal(s.want, s.uses * s.yield, 'the goal is a whole number of cuts')
          assert.ok(s.uses >= 1 && s.uses <= share)
          slots += Math.ceil(s.want / 64)
        }
      }
      assert.ok(slots <= 36, `materials and products fit the inventory (${slots})`)
      assert.equal(new Set(p.layout.map((s) => s.slot)).size, p.layout.length)
      assert.equal(p.target, p.materials[0].styles[0].id)
      const expect = cutterExpect(p)
      assert.deepEqual(Object.keys(expect.targets).sort(), p.materials.flatMap((m) => m.styles.map((s) => s.id)).sort())
      assert.ok(expect.allowed.includes(p.materials[0].id))
    }
  }
  // 三个家族都要：每轮正好三种材料，各来自一个家族
  for (let seed = 0; seed < 50; seed++) assert.equal(sampleStonecut(t, seed, { materials: range(3), slots: range(9), fill: 'full', styles: range(3) }).materialCount, 3)
  // 家族不够时减少材料种数
  const one = cutterTables(CUTS, CUT_CRAFTING, { exclude: ['minecraft:granite', 'minecraft:copper_block', 'minecraft:cut_copper', 'minecraft:exposed_copper', 'minecraft:waxed_copper_block'] })
  assert.equal(sampleStonecut(one, 1, { materials: range(3), slots: range(2), fill: 'random', styles: range(1) }).materialCount, 1)
  // 固定第一种材料；样式数不超过能切出的种数
  const fixed = sampleStonecut(t, 5, { materials: range(1), slots: range(3), fill: 'full', styles: range(3), material: 'granite' })
  assert.equal(fixed.materials[0].id, 'minecraft:granite')
  assert.equal(fixed.materials[0].styles.length, 2)
  // 9 格铜块全切台阶会远超物品栏：每个样式的产物最多占 b 格
  const copper = sampleStonecut(t, 3, { materials: range(3), slots: range(9), fill: 'full', styles: range(3), material: 'copper_block' })
  const slab = copper.materials[0].styles.find((s) => s.id === 'minecraft:cut_copper_slab')
  if (slab) assert.ok(slab.want <= 64 * Math.floor((36 - 27) / copper.targetCount))
  assert.throws(() => sampleStonecut(t, 1, { materials: range(1), slots: range(1), fill: 'full', styles: range(1), material: 'basalt' }), /材料池里没有 minecraft:basalt/)
})

test('stonecut judge: exact counts succeed wherever the material sits; cursor, overshoot, miscut, drops and broken cutters do not', () => {
  const { judgeStonecut } = cutModule
  const picked = {
    target: 'minecraft:stone_slab',
    materials: [{ id: 'minecraft:stone', family: 'stone', slots: 1, count: 20, styles: [
      { id: 'minecraft:stone_slab', yield: 2, uses: 3, want: 6 },
      { id: 'minecraft:stone_stairs', yield: 1, uses: 2, want: 2 }
    ] }]
  }
  const run = (final, extra = {}) => judgeStonecut({ stopped: false, timedOut: false, taskState: 'done', picked, final: { carried: {}, cutterInput: {}, dropped: {}, stationIntact: true, ...final }, ...extra })
  const goal = { 'minecraft:stone_slab': 6, 'minecraft:stone_stairs': 2 }
  assert.deepEqual(run({ held: { ...goal, 'minecraft:stone': 15 } }), { outcome: 'success', madeOf: goal, extra: {}, reached: true })
  assert.equal(run({ held: goal }).outcome, 'success', 'leftover material is not judged')
  assert.equal(run({ held: { ...goal, 'minecraft:stone': 2 }, cutterInput: { 'minecraft:stone': 10 } }).outcome, 'success', 'material still in the input slot is fine')
  const onCursor = run({ held: { 'minecraft:stone_stairs': 2 }, carried: { 'minecraft:stone_slab': 6 } })
  assert.equal(onCursor.outcome, 'false_success', 'targets on the cursor are not in the inventory yet')
  assert.equal(onCursor.madeOf['minecraft:stone_slab'], 6)
  assert.equal(run({ held: { ...goal, 'minecraft:stone_slab': 8 } }).outcome, 'overshoot')
  assert.equal(run({ held: goal, cutterInput: { 'minecraft:stone_slab': 1 } }).outcome, 'overshoot', 'the input slot counts too')
  const miscut = run({ held: { ...goal, 'minecraft:stone_bricks': 1 } })
  assert.deepEqual([miscut.outcome, miscut.extra], ['miscut', { 'minecraft:stone_bricks': 1 }], 'a leftover intermediate is a miscut')
  assert.equal(run({ held: goal, dropped: { 'minecraft:stone_slab': 2 } }).outcome, 'lost')
  assert.equal(run({ held: goal, stationIntact: false }).outcome, 'lost')
  assert.equal(run({ held: { 'minecraft:stone_slab': 4 } }).outcome, 'false_success')
  assert.equal(run({ held: { 'minecraft:stone_slab': 4 } }, { timedOut: true }).outcome, 'timeout')
  assert.equal(run({ held: { 'minecraft:stone_slab': 4 } }, { taskState: 'failed' }).outcome, 'failed')
  assert.equal(judgeStonecut({ stopped: true, picked, final: null }).outcome, 'aborted')
  assert.equal(judgeStonecut({ stopped: false, timedOut: true, picked, final: null }).outcome, 'timeout')
})

test('config: the stonecutter arena has its own defaults and checks; json.stonecutting is a data source', () => {
  const config = normalizeConfig({ training: { arenas: { cut2: { type: 'stonecut', origin: [0, 100, 0] } } } })
  assert.deepEqual(config.training.arenas.stonecutter, { type: 'stonecut', origin: [10000, 120, 10090], timeoutSec: 900, materials: '1-3', slots: '1-9', fill: 'random', styles: '1-3', bypass: 'exclude', exclude: [] })
  assert.deepEqual(config.training.arenas.cut2, { materials: '1-3', slots: '1-9', fill: 'random', styles: '1-3', bypass: 'exclude', exclude: [], type: 'stonecut', origin: [0, 100, 0] })
  assert.ok(path.isAbsolute(config.training.stonecutting) && config.training.stonecutting.endsWith('stonecutting.json'))
  assert.ok(config.jsonSources.stonecutting.endsWith(path.join('data', 'stonecutting.json')))
  assert.throws(() => normalizeConfig({ training: { arenas: { stonecutter: { bypass: 'maybe' } } } }), /stonecutter.bypass must be one of exclude \| keep/)
  assert.throws(() => normalizeConfig({ training: { arenas: { stonecutter: { materials: '4' } } } }), /stonecutter.materials 要写/)
  assert.throws(() => normalizeConfig({ training: { arenas: { stonecutter: { type: 'cut' } } } }), /"craft", "storage", "stonecut", "cook", "enchant", "beacon" or "anvil"/)
})

const ARENAS_CUT = { stonecutter: { type: 'stonecut', origin: [0, 100, 90], timeoutSec: 900, materials: '1-3', slots: '1-9', fill: 'random', styles: '1-3', bypass: 'exclude', exclude: [] } }

/** 切石题的假世界：prepare 按参数发材料，script 结束前把物品栏改成 finalOf(params) 的样子 */
function cutHarness({ finalOf = (params) => ({ held: { ...params.expect.targets, [params.items[0].id]: 1 } }), arenas = ARENAS_CUT, aimOk = true, stonecutting = CUTS } = {}) {
  const { countsOf } = storageModule
  const world = { params: null, state: {} }
  const script = ({ req, executor, clock, setBusy }) => setImmediate(async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    await tick()
    req.closed = true
    req.answered = true
    executor.task = { taskId: req.taskId, state: 'running' }
    executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
    for (let i = 0; i < 3; i++) await tick()
    Object.assign(world.state, { openedAtMs: clock() - 1, reachedAtMs: clock() }, finalOf(world.params))
    for (let i = 0; i < 3; i++) await tick()
    executor.task.state = 'done'
    setBusy(2)
    executor.emit('task', { taskId: req.taskId, state: 'done', version: 2 })
  })
  const h = harness({
    script, arenas, itemProps: null, recipes: CUT_CRAFTING, stonecutting,
    prepareData: (params) => {
      world.params = params
      world.state = { held: countsOf(params.items), carried: {}, cutterInput: {}, dropped: {}, stationIntact: true, openedAtMs: null, reachedAtMs: null }
      return { aimOk }
    },
    statusData: () => world.state
  })
  return { ...h, world }
}

test('stonecutter run: prepare hands out the materials with a targets-only expect, the task lists each material, exact counts succeed', async () => {
  const h = cutHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'stonecutter', runs: 2, seed: 21 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /materials=1-3，slots=1-9，fill=random，styles=1-3，bypass=exclude，材料池 7 种（3 个家族）/)
  await h.done()
  const records = h.records('stonecutter')
  assert.equal(records.length, 2)
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  for (const [i, record] of records.entries()) {
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.ok(record.reachedMs !== null && record.reachedMs <= record.taskMs)
    assert.ok(record.openedMs !== null)
    assert.equal(record.stationIntact, true)
    assert.deepEqual(record.extra, {})
    assert.equal(record.materials.length, record.materialCount)
    for (const m of record.materials) for (const s of m.styles) assert.equal(s.made, s.want)
    assert.equal(record.made, record.want)
    assert.deepEqual(record.final.cutterInput, {})
    const prepare = prepares[i]
    assert.equal(prepare.station, 'stonecutter')
    assert.deepEqual(prepare.items, record.layout)
    assert.deepEqual(prepare.watch, [])
    assert.deepEqual(prepare.expect, cutModule.cutterExpect(record))
    const text = h.instructions[i]
    assert.ok(text.startsWith(`你正前方有一个切石机，视角已经对准它。你的物品栏里有这些材料：${record.materials.map((m) => m.id).join('、')}。`), text)
    for (const m of record.materials) assert.ok(text.includes(`用 ${m.id} 切 ${m.styles.map((s) => `${s.want} 个 ${s.id}`).join('、')}`), text)
    assert.match(text, /不要切出其他物品。\n?$/)
  }
  assert.ok(h.sleeps.includes(100), 'waits for the client to pick up the crosshair target')
  const texts = h.notices.map(([, text]) => text)
  assert.match(texts[0], /^第 1\/2 轮：会话 run-1，用 minecraft:\w+（\d+ 个）切 \d+ 个 minecraft:\w+.*（\d 种材料，\d 种样式，seed=\d+）$/)
  assert.match(texts[1], /^第 1\/2 轮结果 success，达成用时 \d+\.\d 秒/)
  assert.doesNotMatch(prompts.training.stonecut, /右键|Shift|按钮|button/, 'describe the situation, do not teach the move')
})

test('stonecutter run: overshoot and miscut are judged from the final counts; material= fixes the first material', async () => {
  const over = cutHarness({ finalOf: (params) => {
    const [first] = Object.keys(params.expect.targets)
    return { held: { ...params.expect.targets, [first]: params.expect.targets[first] + 2 } }
  } })
  assert.equal(over.trainer.start({ sessionId: 'console', arena: 'stonecutter', seed: 3 }).ok, true)
  await over.done()
  assert.equal(over.records('stonecutter')[0].outcome, 'overshoot')

  const wrong = cutHarness({ finalOf: (params) => ({ held: { ...params.expect.targets, 'minecraft:polished_basalt': 1 } }) })
  assert.equal(wrong.trainer.start({ sessionId: 'console', arena: 'stonecutter', seed: 3, material: 'granite', materials: '1' }).ok, true)
  await wrong.done()
  const record = wrong.records('stonecutter')[0]
  assert.equal(record.outcome, 'miscut')
  assert.deepEqual(record.extra, { 'minecraft:polished_basalt': 1 })
  assert.equal(record.materials[0].id, 'minecraft:granite')
  assert.equal(record.materialCount, 1)
})

test('stonecutter run: crosshair off the cutter aborts the batch; item=, options of other task types and a missing data file are refused', async () => {
  const off = cutHarness({ aimOk: false })
  assert.equal(off.trainer.start({ sessionId: 'console', arena: 'stonecutter', runs: 3 }).ok, true)
  await off.done()
  const records = off.records('stonecutter')
  assert.equal(records.length, 1)
  assert.equal(records[0].outcome, 'aborted')
  assert.match(records[0].error, /crosshair is not on the stonecutter/)

  const h = cutHarness()
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'stonecutter', item: 'minecraft:stone' }).error, /material=/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'stonecutter', kind: 'take' }).error, /不认这些选项：kind/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'stonecutter', material: 'basalt' }).error, /材料池里没有 minecraft:basalt/)
  assert.equal(h.trainer.start({ sessionId: 'console', arena: 'stonecutter', material: 'basalt', bypass: 'keep' }).ok, true, 'bypass=keep puts basalt back')
  await h.done()

  const chest = chestHarness({ arenas: { ...ARENAS_CHEST } })
  assert.match(chest.trainer.start({ sessionId: 'console', arena: 'chest', styles: '2' }).error, /不认这些选项：styles/)

  const missing = cutHarness({ stonecutting: null })
  assert.match(missing.trainer.start({ sessionId: 'console', arena: 'stonecutter' }).error, /extract-recipes/)
})

test('report: stonecutter records group by family / materials / styles / yield and count miscuts', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (families, yields, outcome, extra = {}) => ({
    batch: 'b1', target: 'minecraft:stone_slab', outcome, openedMs: 1000, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false, stationIntact: true,
    materialCount: families.length, targetCount: yields.length,
    materials: families.map((family, i) => ({ id: `minecraft:${family}`, family, styles: i === 0 ? yields.map((y) => ({ id: 'x', yield: y })) : [] })),
    ...extra
  })
  const records = [rec(['stone'], [2], 'success'), rec(['stone', 'granite'], [1, 2], 'miscut', { reachedMs: null }), rec(['copper'], [8], 'overshoot'), rec(['granite'], [1], 'lost', { stationIntact: false })]
  const byFamily = summarize(records, { by: 'family' })
  assert.equal(byFamily.cutter, true)
  assert.deepEqual(byFamily.rows.map((r) => [r.key, r.runs]), [['copper', 1], ['granite', 1], ['granite+stone', 1], ['stone', 1]])
  assert.deepEqual([byFamily.total.miscut, byFamily.total.overshoot, byFamily.total.lost, byFamily.total.stationBroken], [1, 1, 1, 1])
  const text = formatSummary(byFamily)
  assert.match(text.split('\n')[0], /^材料家族\t轮数\t成功率\t.*超量\t切错\t丢失\t打开切石机中位\t达成中位\t任务中位/)
  assert.doesNotMatch(text, /动了别的|合成中位/)
  assert.deepEqual(summarize(records, { by: 'materials' }).rows.map((r) => [r.key, r.runs]), [['1 种材料', 3], ['2 种材料', 1]])
  assert.deepEqual(summarize(records, { by: 'styles' }).rows.map((r) => r.key).sort(), ['1 种样式', '2 种样式'])
  assert.deepEqual(summarize(records, { by: 'yield' }).rows.map((r) => r.key).sort(), ['×1', '×1+×2', '×2', '×8'])
  assert.equal(summarize([{ target: 'x', outcome: 'success', craftedMs: 1, taskMs: 1, items: [] }]).cutter, false, 'craft records are not cutter records')
})

// ── 熔炉训练场（docs/熔炉训练场设计方案.md，第二版）────────────────────────────────

const cookModule = await import('../src/training/cook.js')
const cookRecipe = (type, inputs, result, time) => ({ name: `${result.slice(10)}_from_${type}_${inputs[0].slice(10)}`, type, input: inputs, result, count: 1, time })
const COOKING = [
  cookRecipe('smelting', ['minecraft:raw_iron', 'minecraft:iron_ore'], 'minecraft:iron_ingot', 200),
  cookRecipe('blasting', ['minecraft:raw_iron', 'minecraft:iron_ore'], 'minecraft:iron_ingot', 100),
  cookRecipe('smelting', ['minecraft:iron_sword'], 'minecraft:iron_nugget', 200),
  cookRecipe('smelting', ['minecraft:oak_log'], 'minecraft:charcoal', 200),
  cookRecipe('smelting', ['minecraft:coal_ore'], 'minecraft:coal', 200),
  cookRecipe('blasting', ['minecraft:coal_ore'], 'minecraft:coal', 100),
  cookRecipe('smelting', ['minecraft:beef'], 'minecraft:cooked_beef', 200),
  cookRecipe('smoking', ['minecraft:beef'], 'minecraft:cooked_beef', 100),
  cookRecipe('campfire_cooking', ['minecraft:beef'], 'minecraft:cooked_beef', 600),
  cookRecipe('smelting', ['minecraft:red_terracotta'], 'minecraft:red_glazed_terracotta', 200),
  cookRecipe('smelting', ['minecraft:blue_terracotta'], 'minecraft:blue_glazed_terracotta', 200)
]
const CPROPS = {
  'minecraft:raw_iron': { maxStack: 64 }, 'minecraft:iron_ore': { maxStack: 64 }, 'minecraft:iron_ingot': { maxStack: 64 },
  'minecraft:iron_sword': { maxStack: 1 }, 'minecraft:iron_nugget': { maxStack: 64 },
  'minecraft:oak_log': { maxStack: 64, burn: 300 }, 'minecraft:charcoal': { maxStack: 64, burn: 1600 },
  'minecraft:coal': { maxStack: 64, burn: 1600 }, 'minecraft:coal_ore': { maxStack: 64 },
  'minecraft:bamboo': { maxStack: 64, burn: 50 }, 'minecraft:white_carpet': { maxStack: 64, burn: 67 },
  'minecraft:lava_bucket': { maxStack: 1, remainder: 'minecraft:bucket', burn: 20000 }, 'minecraft:bucket': { maxStack: 16 },
  'minecraft:oak_boat': { maxStack: 1, burn: 1200 },
  'minecraft:beef': { maxStack: 64 }, 'minecraft:cooked_beef': { maxStack: 64 },
  'minecraft:red_terracotta': { maxStack: 64 }, 'minecraft:red_glazed_terracotta': { maxStack: 64 },
  'minecraft:blue_terracotta': { maxStack: 64 }, 'minecraft:blue_glazed_terracotta': { maxStack: 64 }
}
const COOK_OPTIONS = { station: 'random', raw: { lo: 64, hi: 128 }, fuel: { lo: 64, hi: 128 }, rawSlots: { lo: 2, hi: 2 }, fuelSlots: { lo: 2, hi: 2 }, n: { lo: 1, hi: 64 }, m: { lo: 1, hi: 64 } }

test('cook tables: stack-1 and fuel inputs are left out, glazed terracotta is one group, fuels are banded by burn time', () => {
  const { cookTables, burnIn, groupOf } = cookModule
  const t = cookTables(COOKING, CPROPS)
  assert.deepEqual(t.stations.furnace.groups.map((g) => [g.key, g.inputs.length]), [['coal', 1], ['cooked_beef', 1], ['glazed_terracotta', 2], ['iron_ingot', 2]])
  assert.equal(t.stations.furnace.recipe.has('minecraft:iron_sword'), false, 'stack size 1')
  assert.equal(t.stations.furnace.recipe.has('minecraft:oak_log'), false, 'logs are fuel')
  assert.deepEqual(t.stations.blast_furnace.groups.map((g) => g.key), ['coal', 'iron_ingot'])
  assert.deepEqual(t.stations.smoker.groups.map((g) => g.key), ['cooked_beef'])
  assert.equal(t.stations.blast_furnace.recipe.get('minecraft:raw_iron').time, 100)
  assert.deepEqual(t.bands.map((b) => [b.burn, b.items]), [[50, ['minecraft:bamboo']], [67, ['minecraft:white_carpet']], [300, ['minecraft:oak_log']], [1600, ['minecraft:charcoal', 'minecraft:coal']]])
  assert.equal(t.fuels.has('minecraft:lava_bucket'), false, 'leaves a bucket behind')
  assert.equal(t.fuels.has('minecraft:oak_boat'), false, 'stack size 1')
  assert.deepEqual([burnIn('furnace', 67), burnIn('blast_furnace', 67), burnIn('smoker', 1600)], [67, 33, 800])
  assert.equal(groupOf('minecraft:lime_glazed_terracotta'), 'glazed_terracotta')
  const ex = cookTables(COOKING, CPROPS, { exclude: ['minecraft:beef', 'coal', 'minecraft:bamboo'] })
  assert.equal(ex.stations.smoker.groups.length, 0)
  assert.deepEqual(ex.stations.furnace.groups.map((g) => g.key), ['glazed_terracotta', 'iron_ingot'], 'coal excluded as a product, beef as a raw item')
  assert.equal(ex.fuels.has('minecraft:bamboo'), false)
  assert.throws(() => cookTables(COOKING, { ...CPROPS, 'minecraft:beef': undefined }), /item-props\.json 里没有 minecraft:beef/)
})

test('cook sampler: fuel never equals the product, n and m within what is handed out, counts fit the slots, reproducible', () => {
  const { cookTables, sampleCook } = cookModule
  const t = cookTables(COOKING, CPROPS)
  const stations = new Set()
  const bands = new Set()
  for (let seed = 0; seed < 600; seed++) {
    const p = sampleCook(t, seed, COOK_OPTIONS)
    stations.add(p.station)
    bands.add(p.fuel.band)
    assert.notEqual(p.fuel.id, p.product, `seed ${seed}`)
    for (const side of [p.raw, p.fuel]) {
      assert.equal(side.slots.length, 2)
      assert.ok(side.slots.every((c) => c >= 1 && c <= 64))
      assert.equal(side.slots.reduce((a, b) => a + b, 0), side.total)
      assert.ok(side.total >= 64 && side.total <= 128)
    }
    assert.ok(p.n >= 1 && p.n <= 64 && p.n <= p.raw.total)
    assert.ok(p.m >= 1 && p.m <= 64 && p.m <= p.fuel.total)
    assert.equal(new Set(p.layout.map((l) => l.slot)).size, 4)
    assert.equal(p.layout.filter((l) => l.id === p.raw.id).reduce((a, l) => a + l.count, 0), p.raw.total)
    assert.equal(p.target, p.raw.id)
    if (p.station !== 'furnace') assert.equal(p.cookTicks, 100)
  }
  assert.deepEqual([...stations].sort(), ['blast_furnace', 'furnace', 'smoker'])
  assert.deepEqual([...bands].sort((a, b) => a - b), [50, 67, 300, 1600])
  assert.deepEqual(sampleCook(t, 5, COOK_OPTIONS), sampleCook(t, 5, COOK_OPTIONS))

  // 固定原料、燃料；煤矿石烧出煤，燃料就不能是煤
  const coal = sampleCook(t, 1, { ...COOK_OPTIONS, station: 'furnace', input: 'minecraft:coal_ore' })
  assert.equal(coal.product, 'minecraft:coal')
  for (let seed = 0; seed < 100; seed++) assert.notEqual(sampleCook(t, seed, { ...COOK_OPTIONS, station: 'furnace', input: 'minecraft:coal_ore' }).fuel.id, 'minecraft:coal')
  assert.throws(() => sampleCook(t, 1, { ...COOK_OPTIONS, station: 'furnace', input: 'minecraft:coal_ore', fuelItem: 'minecraft:coal' }), /和产物相同/)
  const bamboo = sampleCook(t, 2, { ...COOK_OPTIONS, station: 'blast_furnace', input: 'minecraft:raw_iron', fuelItem: 'minecraft:bamboo', m: { lo: 1, hi: 1 } })
  assert.deepEqual([bamboo.fuel.burnTicks, bamboo.fuel.band, bamboo.cookTicks, bamboo.m], [25, 50, 100, 1], 'm is not tied to how much the fuel can cook')
  assert.equal(sampleCook(t, 3, { ...COOK_OPTIONS, input: 'minecraft:beef' }).raw.id, 'minecraft:beef', 'random station picks one that can cook it')
  assert.throws(() => sampleCook(t, 3, { ...COOK_OPTIONS, station: 'smoker', input: 'minecraft:raw_iron' }), /烟熏炉的原料池里没有 minecraft:raw_iron/)
  assert.throws(() => sampleCook(t, 3, { ...COOK_OPTIONS, fuelItem: 'minecraft:lava_bucket' }), /燃料池里没有 minecraft:lava_bucket/)
  const narrow = sampleCook(t, 4, { ...COOK_OPTIONS, raw: { lo: 10, hi: 10 }, rawSlots: { lo: 3, hi: 3 }, fuel: { lo: 5, hi: 5 }, fuelSlots: { lo: 1, hi: 1 } })
  assert.equal(narrow.raw.total, 10)
  assert.ok(narrow.n <= 10 && narrow.m <= 5, 'n and m never exceed what is handed out')
  assert.throws(() => sampleCook(t, 4, { ...COOK_OPTIONS, fuel: { lo: 5, hi: 5 }, fuelSlots: { lo: 1, hi: 1 }, m: { lo: 8, hi: 9 } }), /m 至少 8，但只有 5 个燃料/)
})

/** 一道固定的熔炉题：熔炉，raw_iron 100 个（60+40），oak_log 80 个（50+30），n=20，m=10 */
function fixedCook(overrides = {}) {
  return {
    station: 'furnace', product: 'minecraft:iron_ingot', cookTicks: 200, n: 20, m: 10,
    raw: { id: 'minecraft:raw_iron', group: 'iron_ingot', total: 100, slots: [60, 40] },
    fuel: { id: 'minecraft:oak_log', burnTicks: 300, band: 300, total: 80, slots: [50, 30] },
    layout: [], target: 'minecraft:raw_iron', ...overrides
  }
}
/**
 * 放好料以后的最终状态：炉子按原版速度烧了 smelted 个原料、burned 个燃料；产物 taken 个在物品栏里，其余在产物格。
 * held / furnace 里给的字段覆盖缺省值。
 */
function cookFinal(p, { smelted = 2, burned = 1, taken = 0, held = {}, carried = {}, dropped = {}, furnace = {}, stationIntact = true, containerOpen = false } = {}) {
  const output = smelted - taken
  return {
    held: { [p.raw.id]: p.raw.total - p.n, [p.fuel.id]: p.fuel.total - p.m, ...(taken ? { [p.product]: taken } : {}), ...held },
    carried, dropped, stationIntact, containerOpen,
    furnace: {
      input: p.n - smelted ? { [p.raw.id]: p.n - smelted } : {},
      fuel: p.m - burned ? { [p.fuel.id]: p.m - burned } : {},
      output: output ? { [p.product]: output } : {},
      lit: true,
      ...furnace
    }
  }
}

test('cook judge: exact loading succeeds while the furnace is still burning, whether or not products were taken; overshoot, misplaced and lost do not', () => {
  const { judgeCook, cookAccount, cookExpect } = cookModule
  const p = fixedCook()
  const judge = (final, extra = {}) => judgeCook({ stopped: false, timedOut: false, taskState: 'done', final, picked: p, ...extra })
  assert.deepEqual(cookExpect(p), { cook: { raw: 'minecraft:raw_iron', rawLeft: 80, fuel: 'minecraft:oak_log', fuelLeft: 70, product: 'minecraft:iron_ingot' } })

  // 放好了，炉子还在烧，产物在产物格里 → 成功
  const burning = judge(cookFinal(p))
  assert.equal(burning.outcome, 'success')
  assert.equal(burning.reached, true)
  assert.deepEqual(burning.account, { placedRaw: 20, placedFuel: 10, smelted: 2, burned: 1, produced: 2, extra: {}, foreignInput: false, foreignFuel: false })
  // 还没开始烧（刚放好那一刻）、拿了产物，都算成功
  assert.equal(judge(cookFinal(p, { smelted: 0, burned: 0, furnace: { lit: false } })).outcome, 'success')
  assert.equal(judge(cookFinal(p, { smelted: 3, taken: 3 })).outcome, 'success')
  // 放对了但炉子界面没关、mod 太旧没报界面状态 → 没达成
  assert.equal(judge(cookFinal(p, { containerOpen: true })).outcome, 'false_success')
  assert.equal(judge({ ...cookFinal(p), containerOpen: undefined }).outcome, 'false_success')
  // 光标上还拿着东西
  assert.equal(judge(cookFinal(p, { smelted: 3, taken: 2, carried: { 'minecraft:iron_ingot': 1 }, furnace: { output: {} } })).outcome, 'false_success')
  assert.equal(judge(cookFinal(p), { taskState: 'failed' }).outcome, 'failed')
  // 少放了：物品栏多剩 3 个原料
  assert.equal(judge(cookFinal(p, { held: { 'minecraft:raw_iron': 83 }, furnace: { input: { 'minecraft:raw_iron': 15 } } })).outcome, 'false_success')
  // 多放了但还没烧就拿回来了（物品栏恰好剩 R − n）→ 不影响
  assert.equal(judge(cookFinal(p, { smelted: 1 })).outcome, 'success')
  // 多放了还留在炉子里：物品栏少了 3 个
  assert.equal(judge(cookFinal(p, { held: { 'minecraft:raw_iron': 77 }, furnace: { input: { 'minecraft:raw_iron': 21 } } })).outcome, 'false_success')
  // 烧掉的原料超过 n（放了 25 个，烧掉 22 个）
  assert.equal(judge(cookFinal(p, { smelted: 22, held: { 'minecraft:raw_iron': 75 }, furnace: { input: { 'minecraft:raw_iron': 3 } } })).outcome, 'overshoot')
  // 烧掉的燃料超过 m
  assert.equal(judge(cookFinal(p, { held: { 'minecraft:oak_log': 68 }, furnace: { fuel: { 'minecraft:oak_log': 1 } } })).outcome, 'overshoot')
  // 燃料放进了原料格
  const fuelInInput = judge(cookFinal(p, { smelted: 0, burned: 0, held: { 'minecraft:raw_iron': 100 }, furnace: { input: { 'minecraft:oak_log': 10 }, fuel: {}, lit: false } }))
  assert.equal(fuelInInput.outcome, 'misplaced')
  assert.equal(fuelInInput.account.foreignInput, true)
  // 能当燃料的产物放进了燃料格（换一道产物是木炭的题：燃料用煤）
  const logs = fixedCook({ product: 'minecraft:charcoal', raw: { id: 'minecraft:beef', group: 'charcoal', total: 100, slots: [60, 40] }, fuel: { id: 'minecraft:coal', burnTicks: 1600, band: 1600, total: 80, slots: [50, 30] } })
  const fuelSlot = judgeCook({ stopped: false, timedOut: false, taskState: 'done', picked: logs, final: cookFinal(logs, { smelted: 2, taken: 0, furnace: { fuel: { 'minecraft:charcoal': 2 }, output: {} } }) })
  assert.equal(fuelSlot.outcome, 'misplaced')
  assert.equal(fuelSlot.account.foreignFuel, true)
  // 产物用 2×2 做成了别的东西（铁锭 → 铁粒）
  const converted = judge(cookFinal(p, { smelted: 2, taken: 1, held: { 'minecraft:iron_nugget': 9 } }))
  assert.equal(converted.outcome, 'misplaced')
  assert.deepEqual(converted.account.extra, { 'minecraft:iron_nugget': 9 })
  // 地上有东西、产物不见了、炉子被挖
  assert.equal(judge(cookFinal(p, { smelted: 2, taken: 1, dropped: { 'minecraft:iron_ingot': 1 } })).outcome, 'lost')
  assert.equal(judge(cookFinal(p, { smelted: 2, furnace: { output: {} } })).outcome, 'lost', 'two ingots vanished (thrown out of the arena)')
  assert.equal(judge({ ...cookFinal(p), furnace: null, stationIntact: false }).outcome, 'lost')
  assert.equal(judge(cookFinal(p), { stopped: true }).outcome, 'aborted')
  assert.equal(judge(cookFinal(p, { held: { 'minecraft:raw_iron': 90 }, furnace: { input: { 'minecraft:raw_iron': 8 } } }), { timedOut: true, taskState: 'failed' }).outcome, 'timeout')
  assert.equal(cookAccount(null, p), null)
})

test('config: the furnace arena has its own defaults and checks; json.cooking and json.items are data sources', () => {
  const config = normalizeConfig({ training: { arenas: { oven: { type: 'cook', origin: [0, 100, 0] } } } })
  assert.deepEqual(config.training.arenas.furnace, { type: 'cook', origin: [10000, 120, 10120], timeoutSec: 600, station: 'random', raw: '64-128', fuel: '64-128', rawSlots: 2, fuelSlots: 2, n: '1-64', m: '1-64', exclude: [] })
  assert.deepEqual(config.training.arenas.oven, { station: 'random', raw: '64-128', fuel: '64-128', rawSlots: 2, fuelSlots: 2, n: '1-64', m: '1-64', exclude: [], type: 'cook', origin: [0, 100, 0] })
  assert.ok(path.isAbsolute(config.training.cooking) && config.training.cooking.endsWith('cooking.json'))
  assert.ok(config.jsonSources.cooking.endsWith(path.join('data', 'cooking.json')))
  assert.ok(config.jsonSources.items.endsWith(path.join('data', 'items.json')))
  assert.throws(() => normalizeConfig({ training: { arenas: { furnace: { station: 'campfire' } } } }), /furnace.station must be one of furnace \| blast_furnace \| smoker \| random/)
  assert.throws(() => normalizeConfig({ training: { arenas: { furnace: { rawSlots: 5 } } } }), /furnace.rawSlots 要写/)
  assert.throws(() => normalizeConfig({ training: { arenas: { furnace: { n: '0-3' } } } }), /furnace.n 要是 1–64/)
})

test('parseTrainArgs: furnace options', () => {
  const args = parseTrainArgs(['furnace', 'station=smoker', 'raw=70-90', 'fuel=64', 'rawSlots=1-2', 'fuelSlots=3', 'n=5', 'm=2-4', 'input=beef', 'fuelItem=minecraft:coal'])
  assert.equal(args.ok, true, args.error)
  assert.deepEqual([args.station, args.raw, args.fuel, args.rawSlots, args.fuelSlots, args.portions, args.crafts, args.input, args.fuelItem],
    ['smoker', '70-90', '64', '1-2', '3', '5', '2-4', 'beef', 'minecraft:coal'])
  assert.match(parseTrainArgs(['furnace', 'station=campfire']).error, /station 只能是 furnace \/ blast_furnace \/ smoker \/ random/)
  assert.equal(parseTrainArgs(['furnace', 'speed=20']).ok, false, 'the furnace is not sped up any more')
  assert.match(parseTrainArgs(['furnace', 'raw=300']).error, /raw 要写/)
  assert.match(parseTrainArgs(['furnace', 'fuelSlots=5']).error, /fuelSlots 要写/)
})

const ARENAS_COOK = { furnace: { type: 'cook', origin: [0, 100, 120], timeoutSec: 600, station: 'random', raw: '64-128', fuel: '64-128', rawSlots: 2, fuelSlots: 2, n: '1-64', m: '1-64', exclude: [] } }

/**
 * 熔炉题的假世界：prepare 按参数发材料、按 cooking 数据回报服务器端数值；
 * script 结束前把物品栏和炉子改成 finalOf(params) 的样子（缺省：恰好放好，炉子烧了 1 个，产物还在产物格）。
 */
function cookHarness({ finalOf = null, arenas = ARENAS_COOK, aimOk = true, cooking = COOKING, serverOf = null } = {}) {
  const { countsOf } = storageModule
  const world = { params: null, state: {} }
  const tables = cookModule.cookTables(COOKING, CPROPS)
  const server = (params) => {
    const { raw, fuel } = params.expect.cook
    const recipe = tables.stations[params.station].recipe.get(raw)
    return { burnTicks: cookModule.burnIn(params.station, CPROPS[fuel].burn), cookTicks: recipe.time, product: recipe.result, productCount: 1, rawMaxStack: 64, fuelMaxStack: 64 }
  }
  const defaultFinal = (params) => {
    const { raw, rawLeft, fuel, fuelLeft, product } = params.expect.cook
    const handed = countsOf(params.items)
    const n = handed[raw] - rawLeft
    const m = handed[fuel] - fuelLeft
    return {
      held: { [raw]: rawLeft, [fuel]: fuelLeft },
      containerOpen: false,
      furnace: { input: n > 1 ? { [raw]: n - 1 } : {}, fuel: m > 1 ? { [fuel]: m - 1 } : {}, output: { [product]: 1 }, lit: true }
    }
  }
  const script = ({ req, executor, clock, setBusy }) => setImmediate(async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    await tick()
    req.closed = true
    req.answered = true
    executor.task = { taskId: req.taskId, state: 'running' }
    executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
    for (let i = 0; i < 3; i++) await tick()
    Object.assign(world.state, { openedAtMs: clock() - 1, reachedAtMs: clock() }, (finalOf ?? defaultFinal)(world.params))
    for (let i = 0; i < 3; i++) await tick()
    executor.task.state = 'done'
    setBusy(2)
    executor.emit('task', { taskId: req.taskId, state: 'done', version: 2 })
  })
  const h = harness({
    script, arenas, itemProps: CPROPS, cooking,
    prepareData: (params) => {
      world.params = params
      world.state = { held: countsOf(params.items), carried: {}, dropped: {}, furnace: { input: {}, fuel: {}, output: {}, lit: false }, stationIntact: true, openedAtMs: null, reachedAtMs: null }
      return { aimOk, station: params.station, cook: (serverOf ?? server)(params) }
    },
    statusData: () => world.state
  })
  return { ...h, world }
}

test('furnace run: prepare hands out raw items and fuel with a cook expect, the task only asks for the loading, exact loading succeeds', async () => {
  const h = cookHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'furnace', runs: 3, seed: 8 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /station=random，raw=64-128（2 格），fuel=64-128（2 格），n=1-64，m=1-64；原料池 熔炉 6、高炉 3、烟熏炉 1 种，燃料 5 种（4 档）/)
  await h.done()
  const records = h.records('furnace')
  assert.equal(records.length, 3)
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  for (const [i, record] of records.entries()) {
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.ok(record.reachedMs !== null && record.openedMs !== null)
    assert.deepEqual([record.placedRaw, record.placedFuel, record.smelted, record.produced], [record.n, record.m, 1, 1])
    assert.deepEqual(record.extra, {})
    assert.equal(record.final.containerOpen, false)
    for (const gone of ['speed', 'capacity', 'fuelLimited', 'firstTakeMs']) assert.equal(gone in record, false, gone)
    const prepare = prepares[i]
    assert.equal(prepare.station, record.station)
    assert.deepEqual(prepare.items, record.layout)
    assert.deepEqual(prepare.watch, [])
    assert.deepEqual(prepare.expect, cookModule.cookExpect(record))
    assert.equal('speed' in prepare, false)
    const text = h.instructions[i]
    const name = cookModule.STATION_NAMES[record.station]
    assert.equal(text.trim(), `你正前方有一个${name}（minecraft:${record.station}），视角已经对准它。\n你的物品栏里有 ${record.raw.id} 和 ${record.fuel.id}。请把 ${record.n} 个 ${record.raw.id} 放进它的原料格，${record.m} 个 ${record.fuel.id} 放进它的燃料格，放好以后关掉它的界面。不要多放，也不要动其他物品。`)
  }
  assert.ok(h.sleeps.includes(100), 'waits for the client to pick up the crosshair target')
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/3 轮：会话 run-1，(熔炉|高炉|烟熏炉)：放 \d+ 个 \w+、\d+ 个 \w+（seed=\d+）$/)
  assert.doesNotMatch(prompts.training.cook, /右键|Shift|拆分|点击|产物|烧完|快/, 'describe the situation, do not teach the move')
})

test('furnace run: stale data or a misaimed crosshair aborts the batch; overshoot is judged from the final counts', async () => {
  const stale = cookHarness({ serverOf: () => ({ burnTicks: 1, cookTicks: 200, product: 'minecraft:stone', productCount: 1, rawMaxStack: 64, fuelMaxStack: 64 }) })
  assert.equal(stale.trainer.start({ sessionId: 'console', arena: 'furnace', runs: 3, station: 'furnace', input: 'raw_iron', fuelItem: 'oak_log' }).ok, true)
  await stale.done()
  const records = stale.records('furnace')
  assert.equal(records.length, 1)
  assert.equal(records[0].outcome, 'aborted')
  assert.match(records[0].error, /数据和服务器不一致（burnTicks: 数据 300 \/ 服务器 1，product: 数据 minecraft:iron_ingot \/ 服务器 minecraft:stone）/)
  assert.ok(stale.calls.some(([m]) => m === 'arena/finish'))

  const off = cookHarness({ aimOk: false })
  assert.equal(off.trainer.start({ sessionId: 'console', arena: 'furnace', station: 'smoker' }).ok, true)
  await off.done()
  assert.match(off.records('furnace')[0].error, /crosshair is not on the smoker/)

  const over = cookHarness({ finalOf: (params) => {
    const { raw, rawLeft, fuel, fuelLeft, product } = params.expect.cook
    // 多放 3 个原料，13 个全烧掉了
    return { held: { [raw]: rawLeft - 3, [fuel]: fuelLeft, [product]: 13 }, furnace: { input: {}, fuel: {}, output: {}, lit: false } }
  } })
  assert.equal(over.trainer.start({ sessionId: 'console', arena: 'furnace', seed: 4, station: 'furnace', fuelItem: 'coal', input: 'beef', portions: '10', crafts: '3' }).ok, true)
  await over.done()
  const record = over.records('furnace')[0]
  assert.equal(record.fuel.id, 'minecraft:coal')
  assert.equal(record.raw.id, 'minecraft:beef')
  assert.deepEqual([record.n, record.m, record.smelted], [10, 3, 13])
  assert.equal(record.outcome, 'overshoot')
})

test('furnace run: item=, options of other task types and missing data files are refused', () => {
  const h = cookHarness()
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'furnace', item: 'minecraft:beef' }).error, /input= 指定原料/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'furnace', styles: '2' }).error, /不认这些选项：styles/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'furnace', input: 'minecraft:iron_sword' }).error, /没有炉子能烧 minecraft:iron_sword/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'furnace', station: 'furnace', input: 'coal_ore', fuelItem: 'coal' }).error, /和产物相同/)
  const missing = cookHarness({ cooking: null })
  assert.match(missing.trainer.start({ sessionId: 'console', arena: 'furnace' }).error, /extract-recipes/)
  const cut = cutHarness()
  assert.match(cut.trainer.start({ sessionId: 'console', arena: 'stonecutter', station: 'furnace' }).error, /不认这些选项：station/)
})

test('report: furnace records group by station / band and count misplaced runs', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (station, band, outcome, extra = {}) => ({
    batch: 'b1', target: 'minecraft:raw_iron', outcome, openedMs: 1000, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false, stationIntact: true,
    station, cookTicks: station === 'furnace' ? 200 : 100, fuel: { id: 'x', band }, ...extra
  })
  const records = [rec('furnace', 300, 'success'), rec('furnace', 1600, 'misplaced', { reachedMs: null }), rec('smoker', 1600, 'overshoot'), rec('blast_furnace', 50, 'lost', { stationIntact: false })]
  const byStation = summarize(records, { by: 'station' })
  assert.equal(byStation.cooker, true)
  assert.deepEqual(byStation.rows.map((r) => [r.key, r.runs]), [['熔炉', 2], ['高炉', 1], ['烟熏炉', 1]])
  assert.deepEqual([byStation.total.misplaced, byStation.total.overshoot, byStation.total.lost, byStation.total.stationBroken], [1, 1, 1, 1])
  const text = formatSummary(byStation)
  assert.match(text.split('\n')[0], /^炉子\t轮数\t成功率\t.*放多\t放错\t丢失\t打开炉子中位\t达成中位\t任务中位/)
  assert.doesNotMatch(text, /切错|合成中位/)
  assert.deepEqual(summarize(records, { by: 'band' }).rows.map((r) => [r.key, r.runs]), [['燃烧 1600', 2], ['燃烧 300', 1], ['燃烧 50', 1]])
  assert.equal(summarize([{ target: 'x', outcome: 'success', craftedMs: 1, taskMs: 1, items: [] }]).cooker, false, 'craft records are not furnace records')
})

// ── 附魔台训练场（docs/附魔台训练场设计方案.md）────────────────────────────────

const enchantModule = await import('../src/training/enchant.js')
const EPROPS = {
  'minecraft:iron_sword': { maxStack: 1, enchantable: 14 }, 'minecraft:golden_sword': { maxStack: 1, enchantable: 22 },
  'minecraft:diamond_pickaxe': { maxStack: 1, enchantable: 10 }, 'minecraft:turtle_helmet': { maxStack: 1, enchantable: 9 },
  'minecraft:leather_boots': { maxStack: 1, enchantable: 15 }, 'minecraft:bow': { maxStack: 1, enchantable: 1 },
  'minecraft:book': { maxStack: 64, enchantable: 1 }, 'minecraft:shield': { maxStack: 1 },
  'minecraft:mystery_wand': { maxStack: 1, enchantable: 5, enchantingTable: false },
  'minecraft:stick': { maxStack: 64, burn: 100 }, 'minecraft:lapis_lazuli': { maxStack: 64 }
}
const ench = (enchantment, level) => ({ enchantment: `minecraft:${enchantment}`, level })
/** 三档：每档 { cost, clue, result } */
const offersOf = (...rows) => rows.map(([cost, clue, result], i) => ({ slot: i + 1, cost, clue, result }))

test('enchant tables: enchantable items grouped by kind, items the table cannot enchant are left out', () => {
  const { enchantTables, kindOf, resultOf } = enchantModule
  const t = enchantTables(EPROPS)
  assert.deepEqual(t.groups.map((g) => [g.kind, g.items.map((i) => i.id.slice(10))]),
    [['sword', ['golden_sword', 'iron_sword']], ['pickaxe', ['diamond_pickaxe']], ['helmet', ['turtle_helmet']], ['boots', ['leather_boots']], ['bow', ['bow']], ['book', ['book']]])
  assert.deepEqual(kindOf('minecraft:golden_pickaxe'), { kind: 'pickaxe', material: 'golden' })
  assert.deepEqual(kindOf('minecraft:fishing_rod'), { kind: 'fishing_rod', material: null })
  assert.equal(kindOf('minecraft:mystery_wand'), null)
  assert.deepEqual([resultOf('minecraft:book'), resultOf('minecraft:bow')], ['minecraft:enchanted_book', 'minecraft:bow'])
  assert.deepEqual(enchantTables(EPROPS, { exclude: ['bow', 'minecraft:book'] }).groups.map((g) => g.kind), ['sword', 'pickaxe', 'helmet', 'boots'])
  assert.throws(() => enchantTables({ ...EPROPS, 'minecraft:magic_rod': { maxStack: 1, enchantable: 3 } }), /认不出 minecraft:magic_rod 的物品类别/)
})

test('enchant sampler: one item and 64 lapis in two random slots, kinds drawn evenly, a 32-bit enchant seed, reproducible', () => {
  const { enchantTables, sampleEnchant } = enchantModule
  const t = enchantTables(EPROPS)
  const kinds = {}
  for (let seed = 0; seed < 1200; seed++) {
    const p = sampleEnchant(t, seed)
    kinds[p.item.kind] = (kinds[p.item.kind] ?? 0) + 1
    assert.equal(p.layout.length, 2)
    assert.notEqual(p.layout[0].slot, p.layout[1].slot)
    assert.deepEqual(p.layout.map((l) => [l.id, l.count]).sort(), [['minecraft:lapis_lazuli', 64], [p.item.id, 1]].sort())
    assert.ok(Number.isInteger(p.enchantSeed) && p.enchantSeed >= -0x80000000 && p.enchantSeed <= 0x7FFFFFFF)
    assert.ok(p.choice >= 0 && p.choice < 1)
  }
  for (const n of Object.values(kinds)) assert.ok(n > 150 && n < 250, JSON.stringify(kinds))
  assert.deepEqual(sampleEnchant(t, 7), sampleEnchant(t, 7))
  assert.equal(sampleEnchant(t, 7, { item: 'minecraft:book' }).item.id, 'minecraft:book')
  assert.throws(() => sampleEnchant(t, 7, { item: 'minecraft:shield' }), /物品池里没有 minecraft:shield/)
})

test('enchant target: the clue must appear in exactly one offer result; none → null', () => {
  const { chooseTarget } = enchantModule
  const offers = offersOf(
    [3, ench('unbreaking', 1), [ench('unbreaking', 1)]],
    [12, ench('sharpness', 2), [ench('sharpness', 2), ench('unbreaking', 1)]],
    [30, ench('sharpness', 4), [ench('sharpness', 4), ench('looting', 2)]]
  )
  // 第 1 档的 unbreaking 1 也出现在第 2 档的结果里，不能选
  for (const choice of [0, 0.4, 0.99]) assert.notEqual(chooseTarget(offers, choice).slot, 1)
  assert.deepEqual(chooseTarget(offers, 0), { slot: 2, enchantment: 'minecraft:sharpness', level: 2 })
  assert.deepEqual(chooseTarget(offers, 0.99), { slot: 3, enchantment: 'minecraft:sharpness', level: 4 })
  const same = offersOf([3, ench('efficiency', 1), [ench('efficiency', 1)]], [8, ench('efficiency', 1), [ench('efficiency', 1)]], [0, null, []])
  assert.equal(chooseTarget(same, 0.5), null)
})

/** 一道固定的附魔题：铁剑，目标第 2 档 sharpness 2（结果还带 unbreaking 1） */
function fixedEnchant(overrides = {}) {
  return {
    item: { id: 'minecraft:iron_sword', kind: 'sword', material: 'iron' }, enchantSeed: 42, layout: [], choice: 0,
    offers: offersOf([3, ench('unbreaking', 1), [ench('unbreaking', 1)]], [12, ench('sharpness', 2), [ench('unbreaking', 1), ench('sharpness', 2)]], [30, ench('sharpness', 4), [ench('sharpness', 4)]]),
    target: { slot: 2, enchantment: 'minecraft:sharpness', level: 2 }, retries: 0, ...overrides
  }
}
/** 附魔好、关掉界面后的最终状态（slot 档：青金石、经验各少 slot） */
function enchantFinal(p, { slot = 2, enchantments = null, held = {}, carried = {}, dropped = {}, table = { item: {}, lapis: {} }, containerOpen = false, stationIntact = true } = {}) {
  const result = enchantModule.resultOf(p.item.id)
  return {
    held: { [result]: 1, 'minecraft:lapis_lazuli': 64 - slot, ...held }, carried, dropped, table, containerOpen, stationIntact,
    xpLevel: 30 - slot,
    enchantments: enchantments ?? p.offers.find((o) => o.slot === slot)?.result ?? []
  }
}

test('enchant judge: the target enchantment with the screen closed succeeds; open screen, wrong offer, drops and missing items do not', () => {
  const { judgeEnchant, enchantExpect } = enchantModule
  const p = fixedEnchant()
  const judge = (final, extra = {}) => judgeEnchant({ stopped: false, timedOut: false, taskState: 'done', final, picked: p, xpLevel: 30, ...extra })
  assert.deepEqual(enchantExpect(p), { enchant: { item: 'minecraft:iron_sword', result: 'minecraft:iron_sword', enchantment: 'minecraft:sharpness', level: 2 } })

  const ok = judge(enchantFinal(p))
  assert.deepEqual(ok, { outcome: 'success', reached: true, enchanted: true, hasTarget: true, lapisUsed: 2, levelsUsed: 2, matchedPreview: true })
  // 界面没关、物品还在附魔台里
  assert.equal(judge(enchantFinal(p, { containerOpen: true })).outcome, 'false_success')
  assert.equal(judge(enchantFinal(p, { containerOpen: true, held: { 'minecraft:iron_sword': 0 }, table: { item: { 'minecraft:iron_sword': 1 }, lapis: {} } })).outcome, 'false_success')
  // 还没附魔
  const plain = judge({ ...enchantFinal(p, { slot: 0 }), enchantments: [] })
  assert.deepEqual([plain.outcome, plain.enchanted, plain.lapisUsed, plain.matchedPreview], ['false_success', false, 0, null])
  assert.equal(judge({ ...enchantFinal(p, { slot: 0 }), enchantments: [] }, { taskState: 'failed' }).outcome, 'failed')
  // 选错档：第 3 档没有 sharpness 2
  const wrong = judge(enchantFinal(p, { slot: 3 }))
  assert.deepEqual([wrong.outcome, wrong.lapisUsed, wrong.levelsUsed], ['misenchanted', 3, 3])
  // 带有目标附魔，但和预览的那一档不完全一样（预览算错了，不怪 agent）
  const odd = judge(enchantFinal(p, { enchantments: [ench('sharpness', 2)] }))
  assert.deepEqual([odd.outcome, odd.matchedPreview], ['success', false])
  // 丢失：地上有东西、附魔台或书架被挖、物品不见了
  assert.equal(judge(enchantFinal(p, { dropped: { 'minecraft:lapis_lazuli': 1 }, held: { 'minecraft:lapis_lazuli': 61 } })).outcome, 'lost')
  assert.equal(judge(enchantFinal(p, { stationIntact: false })).outcome, 'lost')
  assert.equal(judge(enchantFinal(p, { held: { 'minecraft:iron_sword': 0 } })).outcome, 'lost')
  assert.equal(judge(enchantFinal(p), { stopped: true }).outcome, 'aborted')
  assert.equal(judge({ ...enchantFinal(p, { slot: 0 }), enchantments: [] }, { timedOut: true, taskState: 'failed' }).outcome, 'timeout')

  // 书：结果是附魔书
  const book = fixedEnchant({ item: { id: 'minecraft:book', kind: 'book', material: null } })
  const bookFinal = enchantFinal(book)
  assert.deepEqual(Object.keys(bookFinal.held).sort(), ['minecraft:enchanted_book', 'minecraft:lapis_lazuli'])
  assert.equal(judgeEnchant({ stopped: false, timedOut: false, taskState: 'done', final: bookFinal, picked: book, xpLevel: 30 }).outcome, 'success')
  assert.equal(enchantExpect(book).enchant.result, 'minecraft:enchanted_book')
})

test('config and arguments: the enchanting arena has its own defaults and checks', () => {
  const config = normalizeConfig({ training: { arenas: { ench2: { type: 'enchant', origin: [0, 100, 0] } } } })
  assert.deepEqual(config.training.arenas.enchanting, { type: 'enchant', origin: [10000, 120, 10150], timeoutSec: 600, bookshelves: 15, xpLevel: 30, exclude: [] })
  assert.deepEqual(config.training.arenas.ench2, { bookshelves: 15, xpLevel: 30, exclude: [], type: 'enchant', origin: [0, 100, 0] })
  assert.throws(() => normalizeConfig({ training: { arenas: { enchanting: { bookshelves: 16 } } } }), /enchanting.bookshelves 要是 0–15/)
  assert.throws(() => normalizeConfig({ training: { arenas: { enchanting: { xpLevel: -1 } } } }), /enchanting.xpLevel 要是 0–1000/)
  const args = parseTrainArgs(['enchanting', 'item=book', 'bookshelves=8', 'xpLevel=40'])
  assert.deepEqual([args.ok, args.item, args.bookshelves, args.xpLevel], [true, 'book', 8, 40])
  assert.match(parseTrainArgs(['enchanting', 'bookshelves=20']).error, /bookshelves 要是 0–15/)
  assert.match(parseTrainArgs(['enchanting', 'xpLevel=lots']).error, /xpLevel 要是/)
})

const ARENAS_ENCHANT = { enchanting: { type: 'enchant', origin: [0, 100, 150], timeoutSec: 600, bookshelves: 15, xpLevel: 30, exclude: [] } }

/**
 * 附魔台题的假世界：arena/enchant-preview 按 previewOf(params) 回三档；prepare 按参数发物品、回报附魔台的真实三档（缺省和预览一致）；
 * script 结束前把状态改成 finalOf(params) 的样子（缺省：选目标档附魔、关掉界面）。
 */
function enchantHarness({ previewOf, finalOf = null, menuOf = null, aimOk = true, shelves = 15 } = {}) {
  const { countsOf } = storageModule
  const world = { params: null, state: {}, previews: [] }
  const defaultFinal = (params) => {
    const { item, result, enchantment, level } = params.expect.enchant
    const offers = previewOf({ item, enchantSeed: params.enchantSeed }).offers
    const target = offers.find((o) => o.clue?.enchantment === enchantment && o.clue?.level === level)
    return { held: { [result]: 1, 'minecraft:lapis_lazuli': 64 - target.slot }, table: { item: {}, lapis: {} }, containerOpen: false, xpLevel: params.xpLevel - target.slot, enchantments: target.result }
  }
  const script = ({ req, executor, clock, setBusy }) => setImmediate(async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    await tick()
    req.closed = true
    req.answered = true
    executor.task = { taskId: req.taskId, state: 'running' }
    executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
    for (let i = 0; i < 3; i++) await tick()
    Object.assign(world.state, { openedAtMs: clock() - 1, reachedAtMs: clock() }, (finalOf ?? defaultFinal)(world.params))
    for (let i = 0; i < 3; i++) await tick()
    executor.task.state = 'done'
    setBusy(2)
    executor.emit('task', { taskId: req.taskId, state: 'done', version: 2 })
  })
  const h = harness({
    script, arenas: ARENAS_ENCHANT, itemProps: EPROPS,
    onCall: (method, params) => {
      if (method !== 'arena/enchant-preview') return null
      world.previews.push(params)
      return { ok: true, data: { item: params.item, enchantSeed: params.enchantSeed, bookshelves: params.bookshelves, enchantable: true, ...previewOf(params) } }
    },
    prepareData: (params) => {
      world.params = params
      world.state = { held: countsOf(params.items), carried: {}, table: { item: {}, lapis: {} }, dropped: {}, containerOpen: true, xpLevel: params.xpLevel, enchantments: [], stationIntact: true, openedAtMs: null, reachedAtMs: null }
      const offers = (menuOf ?? ((p) => previewOf({ item: p.expect.enchant.item, enchantSeed: p.enchantSeed }).offers.map(({ slot, cost, clue }) => ({ slot, cost, clue }))))(params)
      return { aimOk, enchant: { bookshelves: shelves, xpLevel: params.xpLevel, enchantSeed: params.enchantSeed, offers } }
    },
    statusData: () => world.state
  })
  return { ...h, world }
}

/** 假预览：附魔种子为偶数时三档提示都一样（选不出目标），奇数时第 3 档的 sharpness 4 唯一 */
const fakePreview = ({ enchantSeed }) => (enchantSeed % 2 === 0
  ? { offers: offersOf([3, ench('unbreaking', 1), [ench('unbreaking', 1)]], [10, ench('unbreaking', 1), [ench('unbreaking', 1)]], [30, ench('unbreaking', 1), [ench('unbreaking', 1)]]) }
  : { offers: offersOf([3, ench('unbreaking', 1), [ench('unbreaking', 1)]], [10, ench('unbreaking', 1), [ench('unbreaking', 1), ench('smite', 1)]], [30, ench('sharpness', 4), [ench('sharpness', 4)]]) })

test('enchanting run: preview, then prepare with the target expect, xp and seed; the task names the enchantment only; exact enchanting succeeds', async () => {
  const h = enchantHarness({ previewOf: fakePreview })
  const started = h.trainer.start({ sessionId: 'console', arena: 'enchanting', runs: 3, seed: 5 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /bookshelves=15，xpLevel=30；物品池 7 种（6 类）/)
  await h.done()
  const records = h.records('enchanting')
  assert.equal(records.length, 3)
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  for (const [i, record] of records.entries()) {
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.deepEqual(record.goal, { slot: 3, enchantment: 'minecraft:sharpness', level: 4 })
    assert.equal(record.target, record.item.id)
    assert.ok(record.enchantSeed % 2 !== 0, 'only seeds with a unique clue reach prepare')
    assert.deepEqual([record.matchedPreview, record.lapisUsed, record.levelsUsed], [true, 3, 3])
    assert.ok(record.reachedMs !== null && record.openedMs !== null)
    const prepare = prepares[i]
    assert.equal(prepare.station, 'enchanting_table')
    assert.deepEqual([prepare.bookshelves, prepare.xpLevel, prepare.enchantSeed], [15, 30, record.enchantSeed])
    assert.deepEqual(prepare.items, record.layout)
    assert.deepEqual(prepare.expect, { enchant: { item: record.item.id, result: enchantModule.resultOf(record.item.id), enchantment: 'minecraft:sharpness', level: 4 } })
    assert.equal(h.instructions[i].trim(), `你正前方有一个附魔台，视角已经对准它。你的物品栏里有一个 ${record.item.id} 和一些青金石。\n把这个 ${record.item.id} 放进附魔台后，界面上的三档里会有一档显示 minecraft:sharpness 4 级。\n请用附魔台把它附魔成带有这个附魔的物品，附魔好后关掉它的界面。不要动其他物品。`)
  }
  assert.ok(h.world.previews.length >= 3)
  assert.ok(h.world.previews.every((p) => p.bookshelves === 15))
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/3 轮：会话 run-1，附魔 \w+ 得到 sharpness 4（第 3 档，seed=\d+）$/)
  assert.doesNotMatch(prompts.training.enchant, /第.档|按钮|右键|Shift|青金石放/, 'describe the situation, do not teach the move')
})

test('enchanting run: no unique clue after every retry, a menu that disagrees with the preview, or the wrong offer', async () => {
  const never = enchantHarness({ previewOf: (p) => fakePreview({ enchantSeed: 0 }) })
  assert.equal(never.trainer.start({ sessionId: 'console', arena: 'enchanting', runs: 2 }).ok, true)
  await never.done()
  const stuck = never.records('enchanting')
  assert.equal(stuck.length, 1)
  assert.equal(stuck[0].outcome, 'aborted')
  assert.match(stuck[0].error, /preview: 连续 11 次选不出目标附魔/)
  assert.equal(never.calls.filter(([m]) => m === 'arena/prepare').length, 0)

  const disagree = enchantHarness({ previewOf: fakePreview, menuOf: () => offersOf([3, ench('unbreaking', 1)], [10, ench('unbreaking', 1)], [30, ench('smite', 4)]) })
  assert.equal(disagree.trainer.start({ sessionId: 'console', arena: 'enchanting', runs: 2 }).ok, true)
  await disagree.done()
  const bad = disagree.records('enchanting')
  assert.equal(bad.length, 1)
  assert.equal(bad[0].outcome, 'aborted')
  assert.match(bad[0].error, /预览和附魔台不一致（第 3 档）/)

  const fewShelves = enchantHarness({ previewOf: fakePreview, shelves: 12 })
  assert.equal(fewShelves.trainer.start({ sessionId: 'console', arena: 'enchanting' }).ok, true)
  await fewShelves.done()
  assert.match(fewShelves.records('enchanting')[0].error, /有效书架 12 个，应为 15 个/)

  const wrong = enchantHarness({ previewOf: fakePreview, finalOf: (params) => ({ held: { [params.expect.enchant.result]: 1, 'minecraft:lapis_lazuli': 62 }, table: { item: {}, lapis: {} }, containerOpen: false, xpLevel: 28, enchantments: [ench('unbreaking', 1), ench('smite', 1)] }) })
  assert.equal(wrong.trainer.start({ sessionId: 'console', arena: 'enchanting', item: 'minecraft:book' }).ok, true)
  await wrong.done()
  const record = wrong.records('enchanting')[0]
  assert.equal(record.item.id, 'minecraft:book')
  assert.deepEqual([record.outcome, record.lapisUsed, record.levelsUsed], ['misenchanted', 2, 2])

  const h = enchantHarness({ previewOf: fakePreview })
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'enchanting', item: 'minecraft:shield' }).error, /物品池里没有 minecraft:shield/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'enchanting', station: 'furnace' }).error, /不认这些选项：station/)
  const cut = cutHarness()
  assert.match(cut.trainer.start({ sessionId: 'console', arena: 'stonecutter', bookshelves: 3 }).error, /不认这些选项：bookshelves/)
})

test('report: enchanting records group by kind / slot / enchantment and count misenchanted runs and preview mismatches', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (kind, slot, enchantment, outcome, extra = {}) => ({
    batch: 'b1', target: 'minecraft:x', outcome, openedMs: 1000, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false, stationIntact: true,
    item: { id: 'minecraft:x', kind }, offers: [], goal: { slot, enchantment: `minecraft:${enchantment}`, level: 1 }, matchedPreview: true, ...extra
  })
  const records = [rec('sword', 3, 'sharpness', 'success'), rec('sword', 2, 'smite', 'misenchanted', { reachedMs: null }), rec('book', 1, 'unbreaking', 'success', { matchedPreview: false }), rec('bow', 3, 'power', 'lost', { stationIntact: false })]
  const byKind = summarize(records, { by: 'kind' })
  assert.equal(byKind.enchanter, true)
  assert.deepEqual(byKind.rows.map((r) => [r.key, r.runs]), [['剑', 2], ['弓', 1], ['书', 1]])
  assert.deepEqual([byKind.total.misenchanted, byKind.total.previewMismatch, byKind.total.lost, byKind.total.stationBroken], [1, 1, 1, 1])
  const text = formatSummary(byKind)
  assert.match(text.split('\n')[0], /^物品类别\t轮数\t成功率\t虚报\t失败\t超时\t中止\t附错\t丢失\t预览不一致\t打开附魔台中位\t达成中位/)
  assert.deepEqual(summarize(records, { by: 'slot' }).rows.map((r) => [r.key, r.runs]), [['第 3 档', 2], ['第 1 档', 1], ['第 2 档', 1]])
  assert.deepEqual(summarize(records, { by: 'enchantment' }).rows.map((r) => r.key).sort(), ['power', 'sharpness', 'smite', 'unbreaking'])
  assert.equal(summarize([{ target: 'x', outcome: 'success', craftedMs: 1, taskMs: 1, items: [] }]).enchanter, false, 'craft records are not enchanting records')
})

// ── 信标训练场（docs/信标训练场设计方案.md） ─────────────────────────────

const beaconModule = await import('../src/training/beacon.js')
const fx = (name, amplifier = 1) => ({ effect: `minecraft:${name}`, amplifier })

test('beacon pool: exclude, amplifier and level filter the effects; conflicting options are refused (§5.2)', () => {
  const { beaconPool, EFFECTS, PRIMARY_EFFECTS } = beaconModule
  const all = beaconPool()
  assert.deepEqual(all.effects, EFFECTS)
  assert.deepEqual(all.primaries, PRIMARY_EFFECTS)
  assert.deepEqual([all.level, all.count], [{ lo: 1, hi: 4 }, { lo: 32, hi: 64 }])
  assert.deepEqual(beaconPool({ amplifier: '2' }).effects, PRIMARY_EFFECTS, 'regeneration has no level II')
  assert.deepEqual(beaconPool({ level: '2' }).effects, ['minecraft:speed', 'minecraft:haste', 'minecraft:resistance', 'minecraft:jump_boost'])
  assert.deepEqual(beaconPool({ exclude: ['haste', 'minecraft:strength'] }).primaries, ['minecraft:speed', 'minecraft:resistance', 'minecraft:jump_boost'])
  assert.deepEqual(beaconPool({ effect: 'regeneration', primary: 'haste' }).primaries, ['minecraft:haste'])
  assert.throws(() => beaconPool({ effect: 'regeneration', amplifier: '2' }), /再生只有 I 级/)
  assert.throws(() => beaconPool({ primary: 'haste' }), /primary 只能和 effect=minecraft:regeneration 一起用/)
  assert.throws(() => beaconPool({ effect: 'regeneration', primary: 'regeneration' }), /primary 要是能当主效果的效果之一/)
  assert.throws(() => beaconPool({ effect: 'strength', level: '1-2' }), /minecraft:strength 要 3 级底座，level=1-2 不够/)
  assert.throws(() => beaconPool({ effect: 'speed', amplifier: '2', level: '1-3' }), /II 级 要 4 级底座/)
  assert.throws(() => beaconPool({ effect: 'speed', exclude: ['speed'] }), /effect minecraft:speed 在 exclude 里/)
  assert.throws(() => beaconPool({ effect: 'regeneration', primary: 'speed', exclude: ['speed'] }), /primary minecraft:speed 在 exclude 里/)
  assert.throws(() => beaconPool({ amplifier: '2', level: '1-3' }), /没有能出的效果/)
  assert.throws(() => beaconPool({ effect: 'regeneration', exclude: PRIMARY_EFFECTS }), /前 5 个效果都在 exclude 里/)
  assert.throws(() => beaconPool({ effect: 'fire_resistance' }), /effect 要是信标效果之一/)
  assert.throws(() => beaconPool({ payment: 'copper_ingot' }), /payment 要是付款物品之一/)
  assert.throws(() => beaconPool({ exclude: ['night_vision'] }), /exclude 里的 minecraft:night_vision 不是信标效果/)
  assert.throws(() => beaconPool({ count: '0-10' }), /count 要写 k 或 a-b（1–64/)
  assert.throws(() => beaconPool({ level: '5' }), /level 要写 k 或 a-b（1–4/)
  assert.throws(() => beaconPool({ amplifier: '3' }), /amplifier 只能是 1 \/ 2 \/ mix/)
})

test('beacon sampler: effects about 1/6 each, I and II about half, regeneration brings a primary, the base is at least the required level, reproducible', () => {
  const { beaconPool, sampleBeacon, requiredLevel, PAYMENTS, PRIMARY_EFFECTS, REGENERATION } = beaconModule
  const pool = beaconPool()
  const byEffect = new Map()
  const amps = { 1: 0, 2: 0 }
  const payments = new Set()
  const levelsForSpeedI = new Set()
  const N = 6000
  for (let seed = 1; seed <= N; seed++) {
    const p = sampleBeacon(pool, seed)
    byEffect.set(p.target, (byEffect.get(p.target) ?? 0) + 1)
    const wants = p.goal.effects
    if (p.target === REGENERATION) {
      assert.equal(wants.length, 2)
      assert.ok(PRIMARY_EFFECTS.includes(wants[0].effect) && wants[1].effect === REGENERATION)
      assert.ok(wants.every((w) => w.amplifier === 1))
    } else {
      assert.equal(wants.length, 1)
      amps[wants[0].amplifier]++
      if (p.target === 'minecraft:speed' && wants[0].amplifier === 1) levelsForSpeedI.add(p.beaconLevel)
    }
    assert.equal(p.goal.tier, Math.max(...wants.map((w) => requiredLevel(w.effect, w.amplifier))))
    assert.ok(p.beaconLevel >= p.goal.tier && p.beaconLevel <= 4)
    if (p.target === REGENERATION || wants[0].amplifier === 2) assert.equal(p.beaconLevel, 4)
    assert.equal(p.layout.length, 1)
    assert.deepEqual(p.layout[0], { slot: p.layout[0].slot, id: p.payment.item, count: p.payment.count })
    assert.ok(p.payment.count >= 32 && p.payment.count <= 64 && p.layout[0].slot >= 0 && p.layout[0].slot < 36)
    payments.add(p.payment.item)
  }
  for (const [effect, n] of byEffect) assert.ok(Math.abs(n / N - 1 / 6) < 0.03, `${effect}: ${n}`)
  assert.equal(byEffect.size, 6)
  assert.ok(Math.abs(amps[1] / (amps[1] + amps[2]) - 0.5) < 0.04, JSON.stringify(amps))
  assert.deepEqual([...levelsForSpeedI].sort(), [1, 2, 3, 4])
  assert.deepEqual([...payments].sort(), [...PAYMENTS].sort())
  assert.deepEqual(sampleBeacon(pool, 42), sampleBeacon(pool, 42))
  // 固定选项
  const fixed = sampleBeacon(beaconPool({ effect: 'regeneration', primary: 'haste', payment: 'diamond', count: '1' }), 7)
  assert.deepEqual([fixed.goal.effects, fixed.payment, fixed.beaconLevel], [[fx('haste'), fx('regeneration')], { item: 'minecraft:diamond', count: 1 }, 4])
  assert.ok(Array.from({ length: 200 }, (_, i) => sampleBeacon(beaconPool({ amplifier: '1', level: '1' }), i)).every((p) => p.beaconLevel === 1 && ['minecraft:speed', 'minecraft:haste'].includes(p.target)))
})

test('beacon rules: what the screen can set, and what the beacon actually gives (applyEffects)', () => {
  const { legalSetting, effectiveEffects, satisfies } = beaconModule
  const S = 'minecraft:speed', H = 'minecraft:haste', ST = 'minecraft:strength', R = 'minecraft:regeneration'
  assert.equal(legalSetting(1, S, null), true)
  assert.equal(legalSetting(1, ST, null), false, 'strength needs level 3')
  assert.equal(legalSetting(4, R, null), false, 'regeneration is never a primary')
  assert.equal(legalSetting(4, null, R), false, 'the confirm button needs a primary')
  assert.equal(legalSetting(3, S, R), false, 'no secondary below level 4')
  assert.equal(legalSetting(4, S, R), true)
  assert.equal(legalSetting(4, S, S), true)
  assert.equal(legalSetting(4, S, H), true, 'pick haste, its II button, then speed: the secondary stays haste')
  assert.deepEqual(effectiveEffects(4, S, H), [{ effect: S, amplifier: 1 }, { effect: H, amplifier: 1 }])
  assert.deepEqual(effectiveEffects(4, S, S), [{ effect: S, amplifier: 2 }])
  assert.deepEqual(effectiveEffects(4, S, R), [{ effect: S, amplifier: 1 }, { effect: R, amplifier: 1 }])
  assert.deepEqual(effectiveEffects(3, S, R), [{ effect: S, amplifier: 1 }], 'the secondary only works at level 4')
  assert.deepEqual(effectiveEffects(4, null, R), [], 'no primary → nothing')
  assert.deepEqual(effectiveEffects(4, R, R), [{ effect: R, amplifier: 2 }], 'vanilla would give regeneration II…')
  assert.equal(satisfies(4, R, R, [fx('regeneration')]), false, '…but the screen cannot set it')
  assert.equal(satisfies(4, S, R, [fx('speed')]), true, 'extra effects are fine')
  assert.equal(satisfies(4, S, S, [fx('speed')]), false, 'speed II is not speed I')
  assert.equal(satisfies(4, H, R, [fx('haste'), fx('regeneration')]), true)
  assert.equal(satisfies(4, S, R, [fx('haste'), fx('regeneration')]), false)
})

const fixedBeacon = (overrides = {}) => ({
  goal: { effects: [fx('speed', 2)], tier: 4 }, target: 'minecraft:speed', beaconLevel: 4,
  payment: { item: 'minecraft:diamond', count: 40 }, layout: [{ slot: 3, id: 'minecraft:diamond', count: 40 }], ...overrides
})

function beaconFinal(p, { primary = p.goal.effects[0].effect, secondary = p.goal.effects[1]?.effect ?? (p.goal.effects[0].amplifier === 2 ? primary : null), paid = 1, held = null, carried = {}, slot = {}, dropped = {}, containerOpen = false, stationIntact = true, levels = p.beaconLevel, sets = null } = {}) {
  return {
    held: held ?? { [p.payment.item]: p.payment.count - paid }, carried, slot, dropped, containerOpen, stationIntact, paid,
    beacon: levels === null ? null : { levels, primary, secondary }, sets: sets ?? Array.from({ length: paid }, () => ({ primary, secondary, atMs: 0 }))
  }
}

test('beacon judge: final state only; the setting must be one the screen can make; drops, broken bases and missing payments are lost', () => {
  const { judgeBeacon, beaconExpect } = beaconModule
  const judge = (final, extra = {}, p = fixedBeacon()) => judgeBeacon({ stopped: false, timedOut: false, taskState: 'done', final, picked: p, ...extra })
  const p = fixedBeacon()
  assert.deepEqual(beaconExpect(p), { beacon: { payment: 'minecraft:diamond', effects: [fx('speed', 2)] } })
  assert.deepEqual(judge(beaconFinal(p)), { outcome: 'success', reached: true, effective: [fx('speed', 2)], extra: [], illegal: false, paid: 1, wrongSets: 0 })
  assert.equal(judge(beaconFinal(p, { containerOpen: true })).outcome, 'false_success', 'the screen must be closed')
  assert.equal(judge(beaconFinal(p, { secondary: null })).outcome, 'false_success', 'speed I is not speed II')
  assert.equal(judge(beaconFinal(p, { paid: 0, primary: null, secondary: null, sets: [] })).outcome, 'false_success')
  assert.equal(judge(beaconFinal(p, { paid: 0, primary: null, secondary: null, sets: [] }), { taskState: 'failed' }).outcome, 'failed')
  assert.equal(judge(beaconFinal(p, { secondary: null }), { timedOut: true, taskState: 'failed' }).outcome, 'timeout')
  assert.equal(judge(beaconFinal(p), { stopped: true }).outcome, 'aborted')
  // 只看最终状态：先设错再改对，成功；多付、设错过都记下来
  const retried = judge(beaconFinal(p, { paid: 2, sets: [{ primary: 'minecraft:speed', secondary: null }, { primary: 'minecraft:speed', secondary: 'minecraft:speed' }] }))
  assert.deepEqual([retried.outcome, retried.paid, retried.wrongSets], ['success', 2, 1])
  // 丢失
  assert.equal(judge(beaconFinal(p, { dropped: { 'minecraft:diamond': 1 }, held: { 'minecraft:diamond': 38 } })).outcome, 'lost')
  assert.equal(judge(beaconFinal(p, { held: { 'minecraft:diamond': 30 } })).outcome, 'lost', 'thrown out of the arena')
  assert.equal(judge(beaconFinal(p, { stationIntact: false })).outcome, 'lost')
  assert.equal(judge(beaconFinal(p, { levels: null })).outcome, 'lost')
  // 付款物品还在付款格里 / 光标上：数得上，不算丢失，但没到达
  assert.equal(judge(beaconFinal(p, { containerOpen: true, held: { 'minecraft:diamond': 38 }, slot: { 'minecraft:diamond': 1 } })).outcome, 'false_success')
  assert.equal(judge(beaconFinal(p, { held: { 'minecraft:diamond': 20 }, carried: { 'minecraft:diamond': 19 } })).outcome, 'false_success')

  // 再生题：主效果 + 再生；只设再生、或者把再生设成主效果，都不算
  const regen = fixedBeacon({ goal: { effects: [fx('haste'), fx('regeneration')], tier: 4 }, target: 'minecraft:regeneration' })
  assert.equal(judge(beaconFinal(regen), {}, regen).outcome, 'success')
  const onlySecondary = judge(beaconFinal(regen, { primary: null }), {}, regen)
  assert.deepEqual([onlySecondary.outcome, onlySecondary.illegal, onlySecondary.effective], ['false_success', true, []])
  const asPrimary = judge(beaconFinal(regen, { primary: 'minecraft:regeneration', secondary: 'minecraft:haste' }), {}, regen)
  assert.deepEqual([asPrimary.outcome, asPrimary.illegal], ['false_success', true])
  assert.equal(judge(beaconFinal(regen, { primary: 'minecraft:speed' }), {}, regen).outcome, 'false_success', 'the wrong primary')

  // 一般的 I 级题：顺手加个再生不影响成功，记在 extra
  const speedI = fixedBeacon({ goal: { effects: [fx('speed')], tier: 1 } })
  const withRegen = judge(beaconFinal(speedI, { secondary: 'minecraft:regeneration' }), {}, speedI)
  assert.deepEqual([withRegen.outcome, withRegen.extra], ['success', [fx('regeneration')]])
  // 底座 4 级时 (急迫, 速度)：界面点得出来（先速度、点 II、再换急迫），速度 I 在，急迫记 extra
  const twoPrimaries = judge(beaconFinal(fixedBeacon({ goal: { effects: [fx('speed')], tier: 1 } }), { primary: 'minecraft:haste', secondary: 'minecraft:speed' }), {}, fixedBeacon({ goal: { effects: [fx('speed')], tier: 1 } }))
  assert.deepEqual([twoPrimaries.outcome, twoPrimaries.illegal, twoPrimaries.extra], ['success', false, [fx('haste')]])
  // 底座 1 级时设力量：原版照样给，但界面设不出来
  const low = fixedBeacon({ goal: { effects: [fx('speed')], tier: 1 }, beaconLevel: 1 })
  const cheat = judge(beaconFinal(low, { primary: 'minecraft:strength' }), {}, low)
  assert.deepEqual([cheat.outcome, cheat.illegal], ['false_success', true])
})

test('config and arguments: the beacon arena has its own defaults and checks', () => {
  const config = normalizeConfig({ training: { arenas: { beacon2: { type: 'beacon', origin: [0, 100, 0] } } } })
  assert.deepEqual(config.training.arenas.beacon, { type: 'beacon', origin: [10100, 120, 10000], timeoutSec: 600, amplifier: 'mix', count: '32-64', exclude: [] })
  assert.deepEqual(config.training.arenas.beacon2, { amplifier: 'mix', count: '32-64', exclude: [], type: 'beacon', origin: [0, 100, 0] })
  assert.throws(() => normalizeConfig({ training: { arenas: { beacon: { amplifier: '3' } } } }), /beacon.amplifier 只能是 1 \/ 2 \/ mix/)
  assert.throws(() => normalizeConfig({ training: { arenas: { beacon: { count: '65' } } } }), /beacon.count 要写 k 或 a-b（1–64/)
  assert.throws(() => normalizeConfig({ training: { arenas: { beacon: { exclude: ['minecraft:night_vision'] } } } }), /不是信标效果/)
  const args = parseTrainArgs(['beacon', 'effect=regeneration', 'primary=minecraft:haste', 'amplifier=1', 'level=4', 'payment=diamond', 'count=1-8'])
  assert.deepEqual([args.ok, args.effect, args.primary, args.amplifier, args.level, args.payment, args.count], [true, 'regeneration', 'minecraft:haste', '1', '4', 'diamond', '1-8'])
  assert.match(parseTrainArgs(['beacon', 'amplifier=3']).error, /amplifier 只能是 1 \/ 2 \/ mix/)
  assert.match(parseTrainArgs(['beacon', 'level=0']).error, /level 要写 k 或 a-b（1–4/)
  assert.match(parseTrainArgs(['beacon', 'count=100']).error, /count 要写 k 或 a-b（1–64/)
  assert.match(parseTrainArgs(['beacon', 'effect=A B']).error, /effect 不像效果 id/)
})

const ARENAS_BEACON = { beacon: { type: 'beacon', origin: [100, 100, 0], timeoutSec: 600, amplifier: 'mix', count: '32-64', exclude: [] } }

/**
 * 信标题的假世界：prepare 后信标等级先是 0，第一次读 status 之后 readyAfterMs 毫秒变成 levelsOf(params)（缺省就是本轮底座等级）；
 * script 结束前把状态改成 finalOf(params, world) 的样子（缺省：付一次、设对效果、关掉界面）。finalOf 设了 world.pickupDelay 时，任务结束后第一次读 status 起再过这么久，地上的东西回到物品栏。
 */
function beaconHarness({ finalOf = null, levelsOf = (params) => params.beaconLevel, readyAfterMs = 1500, aimOk = true } = {}) {
  const { countsOf } = storageModule
  const world = { params: null, state: {}, readyAt: null, pickupAt: null, pickupDelay: null, ended: false, clock: 0 }
  const defaultFinal = (params) => {
    const [first, second] = params.expect.beacon.effects
    const primary = first.effect
    const secondary = second ? second.effect : first.amplifier === 2 ? first.effect : null
    const { payment } = params.expect.beacon
    return { held: { [payment]: params.items[0].count - 1 }, slot: {}, dropped: {}, containerOpen: false, beacon: { levels: params.beaconLevel, primary, secondary }, paid: 1, sets: [{ primary, secondary, atMs: world.clock }] }
  }
  const script = ({ req, executor, clock, setBusy }) => setImmediate(async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    await tick()
    req.closed = true
    req.answered = true
    executor.task = { taskId: req.taskId, state: 'running' }
    executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
    for (let i = 0; i < 3; i++) await tick()
    world.clock = clock()
    Object.assign(world.state, { openedAtMs: clock() - 1, reachedAtMs: clock() }, (finalOf ?? defaultFinal)(world.params, world))
    for (let i = 0; i < 3; i++) await tick()
    executor.task.state = 'done'
    world.ended = true
    setBusy(2)
    executor.emit('task', { taskId: req.taskId, state: 'done', version: 2 })
  })
  const h = harness({
    script, arenas: ARENAS_BEACON,
    prepareData: (params) => {
      world.params = params
      world.readyAt = null
      world.state = { held: countsOf(params.items), carried: {}, slot: {}, dropped: {}, containerOpen: false, beacon: { levels: 0, primary: null, secondary: null }, paid: 0, sets: [], stationIntact: true, openedAtMs: null, reachedAtMs: null }
      return { aimOk, station: 'beacon', beacon: { baseLevel: params.beaconLevel, state: { levels: 0, primary: null, secondary: null } } }
    },
    statusData: (clock) => {
      world.readyAt ??= clock + readyAfterMs
      if (world.ended && world.pickupDelay !== null && world.pickupAt === null) world.pickupAt = clock + world.pickupDelay
      if (clock >= world.readyAt && world.state.beacon && world.state.paid === 0) world.state.beacon.levels = levelsOf(world.params)
      if (world.pickupAt !== null && clock >= world.pickupAt) {
        for (const [id, n] of Object.entries(world.state.dropped)) world.state.held[id] = (world.state.held[id] ?? 0) + n
        world.state.dropped = {}
        world.pickupAt = null
      }
      return world.state
    }
  })
  return { ...h, world }
}

test('beacon run: prepare lays the base, waits for the beacon level, the task lists the effects; setting them and closing the screen succeeds', async () => {
  const h = beaconHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'beacon', runs: 4, seed: 11 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /效果 6 种，amplifier=mix，level=1-4，count=32-64/)
  await h.done()
  const records = h.records('beacon')
  assert.equal(records.length, 4)
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  for (const [i, record] of records.entries()) {
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    const prepare = prepares[i]
    assert.deepEqual([prepare.station, prepare.beaconLevel, prepare.items], ['beacon', record.beaconLevel, record.layout])
    assert.deepEqual(prepare.expect, { beacon: { payment: record.payment.item, effects: record.goal.effects } })
    assert.ok(record.readyMs >= 1500 && record.readyMs <= 2500, `readyMs ${record.readyMs}`)
    assert.deepEqual([record.paid, record.wrongSets, record.illegal, record.extra], [1, 0, false, []])
    assert.equal(record.sets.length, 1)
    assert.ok(Number.isFinite(record.sets[0].ms) && record.reachedMs !== null && record.openedMs !== null)
    const wants = beaconModule.effectsText(record.goal.effects)
    assert.equal(h.instructions[i].trim(), `你正前方有一个信标，视角已经对准它。它下面的底座已经搭好，等级足够提供下面要求的效果。\n你的物品栏里有一些 ${record.payment.item}。\n请用信标让它提供 ${wants} 效果，设好以后关掉它的界面。`)
  }
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/4 轮：会话 run-1，信标 minecraft:\w+ (II?)( \+ minecraft:regeneration I)?（底座 [1-4] 级，付 \w+×\d+，seed=\d+）$/)
  assert.equal(beaconModule.effectsText([fx('haste'), fx('regeneration')]), 'minecraft:haste 1 级和minecraft:regeneration 1 级')
  assert.doesNotMatch(prompts.training.beacon, /付款格|主效果|副效果|右键|Shift|container/, 'describe the situation, do not teach the move')
})

test('beacon run: a beacon that never reaches its level aborts the batch before planning; a dropped payment is waited for before finishing', async () => {
  const blocked = beaconHarness({ levelsOf: () => 0 })
  assert.equal(blocked.trainer.start({ sessionId: 'console', arena: 'beacon', runs: 3 }).ok, true)
  await blocked.done()
  const stuck = blocked.records('beacon')
  assert.equal(stuck.length, 1)
  assert.equal(stuck[0].outcome, 'aborted')
  assert.match(stuck[0].error, /信标等级不对：等了 10 秒，读到 0，应为 [1-4]/)
  assert.equal(blocked.planned.length, 0)
  assert.deepEqual(blocked.calls.map(([m]) => m).slice(-1), ['arena/finish'])

  // 关界面时付款格里的一个被扔到地上，任务结束后才捡回：finish 前等它，判成功
  const dropped = beaconHarness({
    finalOf: (params, world) => {
      world.pickupDelay = 600
      const [first] = params.expect.beacon.effects
      return {
        held: { [params.expect.beacon.payment]: params.items[0].count - 2 }, dropped: { [params.expect.beacon.payment]: 1 }, containerOpen: false, slot: {},
        beacon: { levels: 4, primary: first.effect, secondary: first.effect }, paid: 1, sets: [{ primary: first.effect, secondary: first.effect, atMs: world.clock }]
      }
    }
  })
  assert.equal(dropped.trainer.start({ sessionId: 'console', arena: 'beacon', effect: 'speed', amplifier: '2' }).ok, true)
  await dropped.done()
  const record = dropped.records('beacon')[0]
  assert.equal(record.outcome, 'success', JSON.stringify(record))
  assert.deepEqual(record.final.dropped, {})
  assert.ok(dropped.sleeps.filter((ms) => ms === beaconModule.SETTLE_POLL_MS).length >= 2, `settle polled the status: ${JSON.stringify(dropped.sleeps)}`)

  // 拿不回来（扔出场外）就是丢失
  const gone = beaconHarness({
    finalOf: (params) => {
      const [first] = params.expect.beacon.effects
      return { held: { [params.expect.beacon.payment]: params.items[0].count - 5 }, beacon: { levels: 4, primary: first.effect, secondary: first.effect }, paid: 1, sets: [] }
    }
  })
  assert.equal(gone.trainer.start({ sessionId: 'console', arena: 'beacon', effect: 'speed', amplifier: '2' }).ok, true)
  await gone.done()
  assert.equal(gone.records('beacon')[0].outcome, 'lost')

  const h = beaconHarness()
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'beacon', item: 'minecraft:diamond' }).error, /payment= 指定付款物品/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'beacon', primary: 'haste' }).error, /primary 只能和 effect=minecraft:regeneration 一起用/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'beacon', effect: 'strength', level: '1-2' }).error, /要 3 级底座/)
  const cut = cutHarness()
  assert.match(cut.trainer.start({ sessionId: 'console', arena: 'stonecutter', effect: 'speed' }).error, /不认这些选项：effect/)
})

test('report: beacon records group by effect / level / payment and count overpaid, wrong-set and illegal runs', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (effects, beaconLevel, item, outcome, extra = {}) => ({
    batch: 'b1', target: effects.at(-1).effect, outcome, openedMs: 1000, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false, stationIntact: true,
    goal: { effects, tier: 4 }, beaconLevel, payment: { item: `minecraft:${item}`, count: 40 }, paid: 1, wrongSets: 0, illegal: false, ...extra
  })
  const records = [
    rec([fx('speed', 2)], 4, 'diamond', 'success'),
    rec([fx('speed')], 2, 'iron_ingot', 'success', { paid: 2, wrongSets: 1 }),
    rec([fx('haste'), fx('regeneration')], 4, 'diamond', 'false_success', { illegal: true, reachedMs: null }),
    rec([fx('strength'), fx('regeneration')], 4, 'emerald', 'lost', { stationIntact: false })
  ]
  const byEffect = summarize(records, { by: 'effect' })
  assert.equal(byEffect.beaconer, true)
  assert.deepEqual(byEffect.rows.map((r) => [r.key, r.runs]), [['regeneration', 2], ['speed I', 1], ['speed II', 1]])
  assert.deepEqual([byEffect.total.overpaid, byEffect.total.wrongSet, byEffect.total.illegal, byEffect.total.lost], [1, 1, 1, 1])
  const text = formatSummary(byEffect)
  assert.match(text.split('\n')[0], /^目标效果\t轮数\t成功率\t虚报\t失败\t超时\t中止\t丢失\t多付\t设错过\t越界\t打开信标中位\t达成中位/)
  assert.deepEqual(summarize(records, { by: 'level' }).rows.map((r) => [r.key, r.runs]), [['底座 4 级', 3], ['底座 2 级', 1]])
  assert.deepEqual(summarize(records, { by: 'payment' }).rows.map((r) => r.key), ['diamond', 'emerald', 'iron_ingot'])
  assert.equal(summarize([{ target: 'x', outcome: 'success', craftedMs: 1, taskMs: 1, items: [] }]).beaconer, false, 'craft records are not beacon records')
})

// ── 铁砧训练场（docs/铁砧训练场设计方案.md）──────────────────────────────

const anvilModule = await import('../src/training/anvil.js')

const anvilEnch = (id, maxLevel, { curse = false, exclusive = [] } = {}) => ({ id: `minecraft:${id}`, maxLevel, curse, exclusive: exclusive.map((e) => `minecraft:${e}`) })
/** 假的 arena/anvil-catalog：剑（锋利、亡灵杀手互斥）、靴子、打火石（只有耐久、经验修补和诅咒） */
const ANVIL_CATALOG = {
  items: [
    { id: 'minecraft:diamond_sword', enchantments: [anvilEnch('mending', 1), anvilEnch('sharpness', 5, { exclusive: ['smite'] }), anvilEnch('smite', 5, { exclusive: ['sharpness'] }), anvilEnch('unbreaking', 3), anvilEnch('vanishing_curse', 1, { curse: true })] },
    { id: 'minecraft:flint_and_steel', enchantments: [anvilEnch('mending', 1), anvilEnch('unbreaking', 3), anvilEnch('vanishing_curse', 1, { curse: true })] },
    { id: 'minecraft:iron_boots', enchantments: [anvilEnch('binding_curse', 1, { curse: true }), anvilEnch('feather_falling', 4), anvilEnch('mending', 1), anvilEnch('protection', 4), anvilEnch('unbreaking', 3), anvilEnch('vanishing_curse', 1, { curse: true })] },
    { id: 'minecraft:iron_sword', enchantments: [anvilEnch('mending', 1), anvilEnch('sharpness', 5, { exclusive: ['smite'] }), anvilEnch('smite', 5, { exclusive: ['sharpness'] }), anvilEnch('unbreaking', 3)] }
  ]
}

/**
 * 假的 arena/anvil-preview（只为测试，近似原版）：右格的附魔能附上的才合（同级 +1、否则取高，截到最高级），
 * 每合一个花"级数"，改名再加 1；全都附不上 → 没有产物；花费 > 39 → 没有产物。
 */
function fakeAnvilPreview({ left, right, name }) {
  const entry = ANVIL_CATALOG.items.find((i) => i.id === left.id)
  const out = { ...left.enchantments }
  let cost = 0
  if (right) {
    let applied = 0
    for (const [id, r] of Object.entries(right.enchantments ?? {})) {
      const e = entry.enchantments.find((x) => x.id === id)
      if (!e) continue
      const q = out[id] ?? 0
      out[id] = Math.min(q === r ? r + 1 : Math.max(q, r), e.maxLevel)
      cost += out[id]
      applied++
    }
    if (!applied) return { ok: true, data: { result: null, cost: 0 } }
  }
  if (name) cost += 1
  if (cost === 0) return { ok: true, data: { result: null, cost: 0 } }
  if (cost > 39) return { ok: true, data: { result: null, cost } }
  return { ok: true, data: { result: { id: left.id, count: 1, enchantments: anvilModule.sortEnchantments(out), name: name ?? null }, cost } }
}

const ARENAS_ANVIL = { anvil: { type: 'anvil', origin: [0, 100, 180], timeoutSec: 600, xpLevel: 216, enchants: '1-3', curses: false, exclude: [] } }

test('anvil options: task, second, enchants, curses and xpLevel; rename has no second item (§5.2)', () => {
  const { anvilOptions, parseEnchantsSpec, parseAnvilXpLevel, parseCurses } = anvilModule
  assert.deepEqual(anvilOptions({}, ARENAS_ANVIL.anvil), { task: null, second: null, item: null, enchants: { lo: 1, hi: 3 }, curses: false, xpLevel: 216 })
  assert.deepEqual(anvilOptions({ task: 'both', second: 'book', item: 'bow', enchants: '2', curses: '1', xpLevel: 39 }, ARENAS_ANVIL.anvil),
    { task: 'both', second: 'book', item: 'minecraft:bow', enchants: { lo: 2, hi: 2 }, curses: true, xpLevel: 39 })
  assert.throws(() => anvilOptions({ task: 'rename', second: 'book' }), /改名题（task=rename）没有第二件物品，不能和 second 一起用/)
  assert.throws(() => anvilOptions({ task: 'rename', enchants: '2', curses: '1' }), /不能和 enchants、curses 一起用/)
  assert.doesNotThrow(() => anvilOptions({ task: 'rename' }, ARENAS_ANVIL.anvil), 'config defaults are fine for rename')
  assert.throws(() => parseEnchantsSpec('0'), /enchants 要写 k 或 a-b（1–5/)
  assert.throws(() => parseEnchantsSpec('2-6'), /1–5/)
  assert.throws(() => parseAnvilXpLevel(38), /39–1000/)
  assert.equal(parseCurses('0'), false)
  assert.throws(() => parseCurses('yes'), /curses 只能是 0 \/ 1/)

  const none = { kind: null, rel: null, chest: null, stack: null, fill: null, types: null, targets: null, materials: null, slots: null, styles: null, bypass: null, material: null,
    station: null, raw: null, fuel: null, rawSlots: null, fuelSlots: null, input: null, fuelItem: null, bookshelves: null, xpLevel: null,
    effect: null, amplifier: null, primary: null, level: null, payment: null, count: null, task: null, second: null, enchants: null, curses: null }
  assert.deepEqual(parseTrainArgs(['anvil', 'task=merge', 'second=same', 'item=bow', 'enchants=1-2', 'curses=1', 'xpLevel=50']),
    { ok: true, arena: 'anvil', item: 'bow', runs: 1, seed: null, portions: null, crafts: null, ...none, task: 'merge', second: 'same', enchants: '1-2', curses: '1', xpLevel: 50 })
  assert.match(parseTrainArgs(['anvil', 'task=repair']).error, /task 只能是 merge \/ rename \/ both/)
  assert.match(parseTrainArgs(['anvil', 'second=stick']).error, /second 只能是 same \/ book/)
  assert.match(parseTrainArgs(['anvil', 'enchants=9']).error, /enchants 要写 k 或 a-b/)

  const config = normalizeConfig({})
  assert.deepEqual(config.training.arenas.anvil, { type: 'anvil', origin: [10000, 120, 10180], timeoutSec: 600, xpLevel: 216, enchants: '1-3', curses: false, exclude: [] })
  assert.deepEqual(normalizeConfig({ training: { arenas: { a2: { type: 'anvil', origin: [0, 0, 0] } } } }).training.arenas.a2, { xpLevel: 216, enchants: '1-3', curses: false, exclude: [], type: 'anvil', origin: [0, 0, 0] })
  assert.throws(() => normalizeConfig({ training: { arenas: { anvil: { xpLevel: 20 } } } }), /training\.arenas\.anvil\.铁砧场地的 xpLevel 要是 39–1000/)
})

test('anvil sampler: tasks and second kinds about even, compatible non-curse enchantments, mixed 8-character names, reproducible', () => {
  const { anvilTables, anvilOptions, sampleAnvil, HANZI, BOOK, BASE_ENCHANTMENTS, NAME_LENGTH } = anvilModule
  const tables = anvilTables(ANVIL_CATALOG, ['minecraft:iron_sword'])
  assert.deepEqual(tables.groups.map((g) => [g.kind, g.items.map((i) => i.id)]), [['boots', ['minecraft:iron_boots']], ['flint_and_steel', ['minecraft:flint_and_steel']], ['sword', ['minecraft:diamond_sword']]])
  const options = anvilOptions({}, ARENAS_ANVIL.anvil)
  const tasks = {}
  const seconds = {}
  const kinds = {}
  const N = 3000
  for (let seed = 0; seed < N; seed++) {
    const p = sampleAnvil(tables, seed, options)
    tasks[p.task] = (tasks[p.task] ?? 0) + 1
    kinds[p.kind] = (kinds[p.kind] ?? 0) + 1
    assert.deepEqual(p.layout[0].enchantments, BASE_ENCHANTMENTS)
    assert.equal(p.layout[0].id, p.item)
    if (p.task === 'rename') {
      assert.equal(p.second, null)
      assert.equal(p.layout.length, 1)
    } else {
      seconds[p.second.kind] = (seconds[p.second.kind] ?? 0) + 1
      assert.equal(p.second.id, p.second.kind === 'book' ? BOOK : p.item)
      const ids = Object.keys(p.second.enchantments)
      assert.ok(ids.length >= 1 && ids.length <= 3, JSON.stringify(p.second))
      assert.ok(!(ids.includes('minecraft:sharpness') && ids.includes('minecraft:smite')), 'no conflicting pair')
      assert.ok(ids.every((id) => !id.includes('curse')), 'no curses by default')
      const entry = tables.byId.get(p.item)
      for (const [id, level] of Object.entries(p.second.enchantments)) {
        const e = entry.enchantments.find((x) => x.id === id)
        assert.ok(e && level >= 1 && level <= e.maxLevel, `${id} ${level} on ${p.item}`)
      }
      assert.equal(p.layout.length, 2)
      assert.notEqual(p.layout[0].slot, p.layout[1].slot)
    }
    if (p.task === 'merge') assert.equal(p.name, null)
    else {
      const chars = [...p.name]
      assert.equal(chars.length, NAME_LENGTH)
      const hanzi = chars.filter((c) => HANZI.includes(c)).length
      assert.ok(hanzi >= 1 && hanzi <= NAME_LENGTH - 1 && chars.every((c) => HANZI.includes(c) || /[A-Za-z]/.test(c)), p.name)
    }
  }
  for (const t of ['merge', 'rename', 'both']) assert.ok(Math.abs(tasks[t] / N - 1 / 3) < 0.04, JSON.stringify(tasks))
  const withSecond = seconds.same + seconds.book
  assert.ok(Math.abs(seconds.same / withSecond - 0.5) < 0.04, JSON.stringify(seconds))
  for (const k of ['boots', 'flint_and_steel', 'sword']) assert.ok(Math.abs(kinds[k] / N - 1 / 3) < 0.04, JSON.stringify(kinds))
  assert.deepEqual(sampleAnvil(tables, 42, options), sampleAnvil(tables, 42, options))

  const cursed = anvilOptions({ curses: '1', task: 'merge', item: 'flint_and_steel' }, ARENAS_ANVIL.anvil)
  let sawCurse = false
  for (let seed = 0; seed < 200; seed++) sawCurse ||= Object.keys(sampleAnvil(tables, seed, cursed).second.enchantments).includes('minecraft:vanishing_curse')
  assert.ok(sawCurse, 'curses=1 lets curses in')
  assert.throws(() => sampleAnvil(tables, 1, anvilOptions({ item: 'iron_sword' }, ARENAS_ANVIL.anvil)), /物品池里没有 minecraft:iron_sword/)
  const fixed = sampleAnvil(tables, 5, anvilOptions({ task: 'merge', second: 'book', item: 'iron_boots', enchants: '2' }, ARENAS_ANVIL.anvil))
  assert.deepEqual([fixed.task, fixed.second.kind, fixed.item, Object.keys(fixed.second.enchantments).length], ['merge', 'book', 'minecraft:iron_boots', 2])
})

test('anvil preview gate: a result, cost at most 39, the enchantments must change for merges, and the name must match (A4)', () => {
  const { acceptPreview, previewParams } = anvilModule
  const merge = { task: 'merge', item: 'minecraft:diamond_sword', second: { kind: 'book', id: 'minecraft:enchanted_book', enchantments: { 'minecraft:sharpness': 4 } }, name: null }
  assert.deepEqual(previewParams(merge), { left: { id: 'minecraft:diamond_sword', enchantments: { 'minecraft:unbreaking': 3 } }, right: { id: 'minecraft:enchanted_book', enchantments: { 'minecraft:sharpness': 4 } }, name: null })
  const result = (enchantments, name = null) => ({ id: 'minecraft:diamond_sword', count: 1, enchantments, name })
  assert.deepEqual(acceptPreview(merge, { result: result({ 'minecraft:unbreaking': 3, 'minecraft:sharpness': 4 }), cost: 4 }),
    { goal: { id: 'minecraft:diamond_sword', enchantments: { 'minecraft:sharpness': 4, 'minecraft:unbreaking': 3 }, name: null }, cost: 4 })
  assert.equal(acceptPreview(merge, { result: null, cost: 0 }), null, 'no result')
  assert.equal(acceptPreview(merge, { result: result({ 'minecraft:sharpness': 5, 'minecraft:unbreaking': 3 }), cost: 40 }), null, 'too expensive')
  assert.equal(acceptPreview(merge, { result: result({ 'minecraft:unbreaking': 3 }), cost: 6 }), null, 'unbreaking III + III stays III: nothing to tell apart')
  const rename = { task: 'rename', item: 'minecraft:diamond_sword', second: null, name: '风a雪Bc林dE' }
  assert.deepEqual(acceptPreview(rename, { result: result({ 'minecraft:unbreaking': 3 }, '风a雪Bc林dE'), cost: 1 }).goal.name, '风a雪Bc林dE')
  assert.equal(acceptPreview(rename, { result: result({ 'minecraft:unbreaking': 3 }, 'other'), cost: 1 }), null, 'the name must be the one asked for')
})

test('anvil judge: final state only; type, enchantments and name must all match; renaming a merge fails; a missing item or anvil is lost', () => {
  const { judgeAnvil } = anvilModule
  const picked = { task: 'merge', item: 'minecraft:diamond_sword', goal: { id: 'minecraft:diamond_sword', enchantments: { 'minecraft:sharpness': 4, 'minecraft:unbreaking': 3 }, name: null } }
  const sword = (enchantments, name = null, slot = 3) => ({ slot, id: 'minecraft:diamond_sword', count: 1, enchantments, name })
  const goodItems = [sword({ 'minecraft:sharpness': 4, 'minecraft:unbreaking': 3 })]
  const final = (extra = {}) => ({ items: goodItems, carried: {}, carriedItem: null, slots: null, dropped: {}, containerOpen: true, anvilState: 'anvil', xpLevel: 212, takes: [{ cost: 4 }], stationIntact: true, ...extra })
  const judge = (f, more = {}) => judgeAnvil({ stopped: false, timedOut: false, taskState: 'done', final: f, picked, xpLevel: 216, ...more })

  assert.deepEqual(judge(final()), { outcome: 'success', reached: true, nameWrong: false, levelsUsed: 4, takes: 1 }, 'the screen may stay open')
  const renamed = judge(final({ items: [sword({ 'minecraft:sharpness': 4, 'minecraft:unbreaking': 3 }, 'abc')] }))
  assert.deepEqual([renamed.outcome, renamed.nameWrong], ['false_success', true], 'renaming a merge-only task fails')
  assert.equal(judge(final({ items: [sword({ 'minecraft:sharpness': 3, 'minecraft:unbreaking': 3 })] })).outcome, 'false_success', 'enchantments must match exactly')
  assert.equal(judge(final({ items: [sword({ 'minecraft:sharpness': 4, 'minecraft:unbreaking': 3, 'minecraft:mending': 1 })] })).outcome, 'false_success', 'one more is not a match either')
  const held = judge(final({ items: [], carried: { 'minecraft:diamond_sword': 1 }, carriedItem: sword({ 'minecraft:sharpness': 4, 'minecraft:unbreaking': 3 }) }))
  assert.deepEqual([held.outcome, held.reached], ['false_success', false], 'still on the cursor')
  assert.equal(judge(final(), { taskState: 'failed' }).outcome, 'failed')
  assert.equal(judge(final({ items: [] }), { taskState: 'failed' }).outcome, 'lost', 'the sword is nowhere')
  assert.equal(judge(final({ items: [], slots: { left: sword({ 'minecraft:unbreaking': 3 }), right: null } }), { taskState: 'failed' }).outcome, 'failed', 'still in the anvil is not lost')
  assert.equal(judge(final({ items: [], dropped: { 'minecraft:diamond_sword': 1 } })).outcome, 'false_success', 'on the floor inside the arena is not lost')
  assert.equal(judge(final({ anvilState: 'missing', stationIntact: false })).outcome, 'lost')
  assert.equal(judge(final({ items: [sword({ 'minecraft:unbreaking': 3 })] }), { timedOut: true, taskState: 'failed' }).outcome, 'timeout')
  assert.equal(judge(final(), { stopped: true }).outcome, 'aborted')

  const both = { ...picked, task: 'both', goal: { ...picked.goal, name: '风a雪Bc林dE' } }
  const judgeBoth = (items) => judgeAnvil({ stopped: false, timedOut: false, taskState: 'done', final: final({ items }), picked: both, xpLevel: 216 })
  assert.equal(judgeBoth([sword({ 'minecraft:sharpness': 4, 'minecraft:unbreaking': 3 }, '风a雪Bc林dE')]).outcome, 'success')
  const spaced = judgeBoth([sword({ 'minecraft:sharpness': 4, 'minecraft:unbreaking': 3 }, '风a雪Bc林dE ')])
  assert.deepEqual([spaced.outcome, spaced.nameWrong], ['false_success', true], 'a trailing space is a wrong name')
  assert.equal(judgeBoth([sword({ 'minecraft:sharpness': 4, 'minecraft:unbreaking': 3 })]).nameWrong, false, 'not renamed at all is not a wrong name')
})

/**
 * 铁砧题的假世界：arena/anvil-catalog 回 ANVIL_CATALOG；arena/anvil-preview 按 previewOf（缺省 fakeAnvilPreview）；
 * prepare 按参数发物品、回报铁砧状态和经验；任务结束时按 finalOf(params, world) 改状态（缺省：做出目标、花掉预览的花费）。
 */
function anvilHarness({ finalOf = null, previewOf = fakeAnvilPreview, aimOk = true } = {}) {
  const world = { params: null, state: {}, previews: 0 }
  const describe = (g) => ({ slot: g.slot, id: g.id, count: g.count, enchantments: anvilModule.sortEnchantments(g.enchantments ?? {}), name: null })
  const defaultFinal = (params) => {
    const goal = params.expect.anvil
    return { items: [{ slot: 5, id: goal.item, count: 1, enchantments: goal.enchantments, name: goal.name }], xpLevel: params.xpLevel - 3, takes: [{ cost: 3, enchantments: goal.enchantments, name: goal.name, atMs: 1 }] }
  }
  const script = ({ req, executor, clock, setBusy }) => setImmediate(async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    await tick()
    req.closed = true
    req.answered = true
    executor.task = { taskId: req.taskId, state: 'running' }
    executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
    for (let i = 0; i < 3; i++) await tick()
    Object.assign(world.state, { openedAtMs: clock() - 1, reachedAtMs: clock() }, (finalOf ?? defaultFinal)(world.params, world))
    for (let i = 0; i < 3; i++) await tick()
    executor.task.state = 'done'
    setBusy(2)
    executor.emit('task', { taskId: req.taskId, state: 'done', version: 2 })
  })
  const h = harness({
    script, arenas: ARENAS_ANVIL,
    onCall: (method, params) => {
      if (method === 'arena/anvil-catalog') return { ok: true, data: ANVIL_CATALOG }
      if (method === 'arena/anvil-preview') {
        world.previews++
        return previewOf(params, world)
      }
      return null
    },
    prepareData: (params) => {
      world.params = params
      const items = params.items.map(describe)
      world.state = { held: {}, items, carried: {}, carriedItem: null, slots: null, dropped: {}, containerOpen: false, anvilState: 'anvil', xpLevel: params.xpLevel, takes: [], stationIntact: true, openedAtMs: null, reachedAtMs: null }
      return { aimOk, station: 'anvil', anvil: { state: 'anvil', xpLevel: params.xpLevel, items } }
    },
    statusData: () => world.state
  })
  return { ...h, world }
}

test('anvil run: the catalog is read once, every question is previewed, the task names the goal only; making it succeeds', async () => {
  const h = anvilHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'anvil', runs: 6, seed: 3 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /任务三种等概率，第二件两种等概率，enchants=1-3，curses=0，xpLevel=216/)
  await h.done()
  const records = h.records('anvil')
  assert.equal(records.length, 6)
  assert.equal(h.calls.filter(([m]) => m === 'arena/anvil-catalog').length, 1)
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  const tasks = new Set()
  for (const [i, record] of records.entries()) {
    tasks.add(record.task)
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    const prepare = prepares[i]
    assert.deepEqual([prepare.station, prepare.xpLevel, prepare.items], ['anvil', 216, record.layout])
    assert.deepEqual(prepare.expect, { anvil: { item: record.goal.id, enchantments: record.goal.enchantments, name: record.goal.name } })
    assert.deepEqual([record.levelsUsed, record.takes.length, record.nameWrong, record.anvilState], [3, 1, false, 'anvil'])
    assert.ok(record.cost >= 1 && record.cost <= 39 && record.reachedMs !== null)
    const text = h.instructions[i]
    assert.doesNotMatch(text, /格子|左边|右边|container|右键/, 'describe the goal, not the moves')
    assert.match(text, /^你正前方有一个铁砧，视角已经对准它。你的经验等级足够这次使用。\n你的物品栏里有一个带 minecraft:unbreaking 3 级 的 minecraft:\w+/)
    if (record.task === 'merge') assert.match(text, /请用铁砧做出一个带 .+ 的 minecraft:\w+，放在你的物品栏里。不要给它改名。/)
    if (record.task === 'rename') assert.ok(text.includes(`请用铁砧把它的名字改成「${record.name}」`), text)
    if (record.task === 'both') assert.ok(text.includes(`名字是「${record.name}」`) && text.includes(anvilModule.enchantsText(record.goal.enchantments)), text)
  }
  assert.ok(tasks.size >= 2, `several tasks in 6 runs: ${[...tasks]}`)
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/6 轮：会话 run-1，铁砧 (合并|改名|合并加改名) \w+/)
})

test('anvil run: failed previews are resampled; a question that never previews aborts the batch; option conflicts are refused', async () => {
  // 前两次预览都"过于昂贵"：重抽两次后发题
  const flaky = anvilHarness({ previewOf: (params, world) => (world.previews <= 2 ? { ok: true, data: { result: null, cost: 45 } } : fakeAnvilPreview(params)) })
  assert.equal(flaky.trainer.start({ sessionId: 'console', arena: 'anvil', seed: 9 }).ok, true)
  await flaky.done()
  const record = flaky.records('anvil')[0]
  assert.equal(record.outcome, 'success', JSON.stringify(record))
  assert.equal(record.retries, 2)

  const never = anvilHarness({ previewOf: () => ({ ok: true, data: { result: null, cost: 0 } }) })
  assert.equal(never.trainer.start({ sessionId: 'console', arena: 'anvil', runs: 3 }).ok, true)
  await never.done()
  const stuck = never.records('anvil')
  assert.equal(stuck.length, 1)
  assert.equal(stuck[0].outcome, 'aborted')
  assert.match(stuck[0].error, /preview: 抽不出能做的题：连续 21 次预览/)
  assert.equal(never.planned.length, 0)

  const unknown = anvilHarness()
  assert.equal(unknown.trainer.start({ sessionId: 'console', arena: 'anvil', item: 'stick' }).ok, true)
  await unknown.done()
  assert.match(unknown.records('anvil')[0].error, /物品池里没有 minecraft:stick/)

  // 合并题多改了名：判 false_success，记名字错
  const renamed = anvilHarness({
    finalOf: (params) => ({ items: [{ slot: 1, id: params.expect.anvil.item, count: 1, enchantments: params.expect.anvil.enchantments, name: 'Hello' }], xpLevel: params.xpLevel - 5, takes: [{ cost: 5 }] })
  })
  assert.equal(renamed.trainer.start({ sessionId: 'console', arena: 'anvil', task: 'merge' }).ok, true)
  await renamed.done()
  const r = renamed.records('anvil')[0]
  assert.deepEqual([r.outcome, r.nameWrong], ['false_success', true])

  const h = anvilHarness()
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'anvil', task: 'rename', second: 'book' }).error, /改名题（task=rename）没有第二件物品/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'anvil', xpLevel: 10 }).error, /铁砧场地的 xpLevel 要是 39–1000/)
  const beacon = beaconHarness()
  assert.match(beacon.trainer.start({ sessionId: 'console', arena: 'beacon', task: 'merge' }).error, /不认这些选项：task/)
  const prepared = anvilHarness({ aimOk: false })
  assert.equal(prepared.trainer.start({ sessionId: 'console', arena: 'anvil' }).ok, true)
  await prepared.done()
  assert.match(prepared.records('anvil')[0].error, /crosshair is not on the anvil/)
  assert.doesNotMatch(prompts.training.anvil_merge + prompts.training.anvil_rename + prompts.training.anvil_both, /格子|左边|右边|container|右键|Shift/, 'describe the goal, do not teach the move')
})

test('report: anvil records group by task / item / second and count multi-take, overspent and wrong-name runs', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (task, item, second, outcome, extra = {}) => ({
    batch: 'b1', target: `minecraft:${item}`, task, item: `minecraft:${item}`, second: second ? { kind: second, id: 'x', enchantments: {} } : null,
    outcome, openedMs: 1000, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false, stationIntact: true,
    goal: { id: `minecraft:${item}`, enchantments: {}, name: null }, cost: 4, levelsUsed: 4, takes: [{ cost: 4 }], nameWrong: false, ...extra
  })
  const records = [
    rec('merge', 'diamond_sword', 'book', 'success'),
    rec('merge', 'diamond_sword', 'same', 'false_success', { nameWrong: true, levelsUsed: 5 }),
    rec('both', 'iron_boots', 'book', 'success', { takes: [{ cost: 4 }, { cost: 2 }], levelsUsed: 6 }),
    rec('rename', 'bow', null, 'lost', { stationIntact: false, takes: [] })
  ]
  const byTask = summarize(records, { by: 'task' })
  assert.equal(byTask.anviler, true)
  assert.deepEqual(byTask.rows.map((r) => [r.key, r.runs]).sort(), [['合并', 2], ['合并加改名', 1], ['改名', 1]].sort())
  assert.deepEqual([byTask.total.multiTake, byTask.total.overspent, byTask.total.nameWrong, byTask.total.lost], [1, 2, 1, 1])
  const text = formatSummary(byTask)
  assert.match(text.split('\n')[0], /^任务\t轮数\t成功率\t虚报\t失败\t超时\t中止\t丢失\t多次取出\t多花经验\t名字错\t打开铁砧中位\t达成中位/)
  assert.deepEqual(summarize(records, { by: 'item' }).rows.map((r) => [r.key, r.runs]), [['diamond_sword', 2], ['bow', 1], ['iron_boots', 1]])
  assert.deepEqual(summarize(records, { by: 'second' }).rows.map((r) => [r.key, r.runs]).sort(), [['附魔书', 2], ['同种物品', 1], ['无（改名）', 1]].sort())
  assert.equal(summarize(records).beaconer, false)
  assert.equal(summarize([{ target: 'x', outcome: 'success', craftedMs: 1, taskMs: 1, items: [] }]).anviler, false, 'craft records are not anvil records')
})
