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
import { loadPrompts, renderTemplate } from '../src/llm/prompts.js'
import { tempDir } from './helpers.js'
import * as land from '../src/training/land.js'
import { rng as rngOf } from '../src/training/sampler.js'

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
    effect: null, amplifier: null, primary: null, level: null, payment: null, count: null, task: null, second: null, enchants: null, curses: null, tasks: null, base: null, pattern: null, group: null, animal: null, total: null, move: null, banners: null, spare: null, itemPatterns: null, banner: null, ops: null, scale: null, maps: null, copies: null, bottles: null, extra: null, profession: null, books: null, pages: null, edits: null, dist: null, weapon: null, ground: null, memory: null, size: null, points: null, edge: null, offset: null }
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
  assert.deepEqual(arena, ['arena/build', 'arena/land-build', 'arena/prepare', 'arena/enchant-preview', 'arena/trade-preview', 'arena/trade-catalog', 'arena/mount-catalog', 'arena/loom-catalog', 'arena/smithing-catalog', 'arena/smithing-preview', 'arena/anvil-catalog', 'arena/anvil-preview', 'arena/status', 'arena/finish'])
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

function harness({ script, timeoutSec = 600, wallTimeoutSec = 2400, cancelTurn = () => {}, openFails = false, consoleAlive = () => true, arenas = ARENAS_2X2, prepareData = () => ({}), statusData = () => ({}), itemProps = ITEM_PROPS, recipes = RECIPES, stonecutting = null, cooking = null, brewing = null, onCall = null } = {}) {
  const dir = tempDir('stevex-train-')
  const recipesFile = path.join(dir, 'recipes.json')
  const itemPropsFile = path.join(dir, 'item-props.json')
  const stonecuttingFile = path.join(dir, 'stonecutting.json')
  const cookingFile = path.join(dir, 'cooking.json')
  const brewingFile = path.join(dir, 'brewing.json')
  if (brewing) fs.writeFileSync(brewingFile, JSON.stringify(brewing))
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
    config: { timeoutSec, wallTimeoutSec, pollMs: 1000, recipes: recipesFile, itemProps: itemPropsFile, stonecutting: stonecuttingFile, cooking: cookingFile, brewing: brewingFile, arenas },
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
  assert.throws(() => normalizeConfig({ training: { arenas: { stonecutter: { type: 'cut' } } } }), /"craft", "storage", "stonecut", "cook", "enchant", "beacon", "anvil", "smithing", "mount", "loom", "cartography", "brew", "crafter", "trade", "grindstone", "book", "sign", "bow", "route" or "goal"/)
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
  assert.match(parseTrainArgs(['beacon', 'level=0']).error, /level 要写 k 或 a-b（1–5/)
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
    effect: null, amplifier: null, primary: null, level: null, payment: null, count: null, task: null, second: null, enchants: null, curses: null, tasks: null, base: null, pattern: null, group: null, animal: null, total: null, move: null, banners: null, spare: null, itemPatterns: null, banner: null, ops: null, scale: null, maps: null, copies: null, bottles: null, extra: null, profession: null, books: null, pages: null, edits: null, dist: null, weapon: null, ground: null, memory: null, size: null, points: null, edge: null, offset: null }
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

// ── 锻造台训练场（docs/锻造台训练场设计方案.md）──────────────────────────────

const smithingModule = await import('../src/training/smithing.js')

const mc = (id) => `minecraft:${id}`
const UPGRADE = mc('netherite_upgrade_smithing_template')
/** 假的 arena/smithing-catalog：两条升级、三种纹饰、三件盔甲、三种纹饰材料 */
const SMITHING_CATALOG = {
  upgrades: [
    { template: UPGRADE, base: mc('diamond_chestplate'), addition: [mc('netherite_ingot')], result: mc('netherite_chestplate') },
    { template: UPGRADE, base: mc('diamond_sword'), addition: [mc('netherite_ingot')], result: mc('netherite_sword') }
  ],
  trims: [
    { template: mc('coast_armor_trim_smithing_template'), pattern: mc('coast') },
    { template: mc('sentry_armor_trim_smithing_template'), pattern: mc('sentry') },
    { template: mc('wild_armor_trim_smithing_template'), pattern: mc('wild') }
  ],
  armors: [mc('diamond_chestplate'), mc('iron_chestplate'), mc('leather_boots')],
  materials: [{ item: mc('gold_ingot'), material: mc('gold') }, { item: mc('lapis_lazuli'), material: mc('lapis') }, { item: mc('redstone'), material: mc('redstone') }]
}

/** 假的 arena/smithing-preview：按 catalog 找配方，升级给产物，纹饰给带纹饰的底材；找不到 → 没有产物 */
function fakeSmithingPreview({ template, base, addition }) {
  const u = SMITHING_CATALOG.upgrades.find((x) => x.template === template && x.base === base && x.addition.includes(addition))
  if (u) return { ok: true, data: { result: { id: u.result, count: 1, trim: null } } }
  const t = SMITHING_CATALOG.trims.find((x) => x.template === template)
  const m = SMITHING_CATALOG.materials.find((x) => x.item === addition)
  if (t && m && SMITHING_CATALOG.armors.includes(base)) return { ok: true, data: { result: { id: base, count: 1, trim: { pattern: t.pattern, material: m.material } } } }
  return { ok: true, data: { result: null } }
}

const ARENAS_SMITHING = { smithing: { type: 'smithing', origin: [0, 100, 210], timeoutSec: 600, tasks: '1-4', exclude: [] } }
const smithingTables = () => smithingModule.smithingTables(SMITHING_CATALOG)

test('smithing options: tasks, kind, base, pattern and material; upgrades have no trim; kind is shared with the chest arena (§5.2)', () => {
  const { smithingOptions } = smithingModule
  assert.deepEqual(smithingOptions({}, { tasks: '1-4' }), { tasks: { lo: 1, hi: 4 }, kind: null, base: null, pattern: null, material: null })
  assert.deepEqual(smithingOptions({ tasks: '2', kind: 'trim', base: 'iron_chestplate', pattern: 'sentry', material: 'gold' }, {}),
    { tasks: { lo: 2, hi: 2 }, kind: 'trim', base: mc('iron_chestplate'), pattern: mc('sentry'), material: mc('gold') })
  assert.throws(() => smithingOptions({ tasks: '5' }), /tasks 要写 k 或 a-b（1–4/)
  assert.throws(() => smithingOptions({ kind: 'upgrade', pattern: 'sentry' }), /升级题（kind=upgrade）没有纹饰，不能和 pattern 一起用/)
  assert.throws(() => smithingOptions({ kind: 'take' }), /锻造台场地的 kind 只能是 upgrade \/ trim/)
  const parsed = parseTrainArgs(['smithing', 'tasks=1-3', 'kind=trim', 'base=minecraft:iron_chestplate', 'pattern=minecraft:wild', 'material=minecraft:gold'])
  assert.deepEqual([parsed.ok, parsed.tasks, parsed.kind, parsed.base, parsed.pattern, parsed.material], [true, '1-3', 'trim', 'minecraft:iron_chestplate', 'minecraft:wild', 'minecraft:gold'])
  assert.match(parseTrainArgs(['smithing', 'kind=foo']).error, /kind 只能是 take \/ put \/ mix（箱子题）、upgrade \/ trim（锻造台题）、item \/ book \/ mix（砂轮题）或 text \/ color \/ wax（告示牌题）/)
  assert.match(parseTrainArgs(['smithing', 'tasks=0']).error, /tasks 要写 k 或 a-b/)
  const config = normalizeConfig({ logger: null })
  assert.deepEqual(config.training.arenas.smithing, { type: 'smithing', origin: [10000, 120, 10210], timeoutSec: 600, tasks: '1-4', exclude: [] })
  assert.ok(config.jsonSources.smithing.endsWith(path.join('data', 'smithing.json')))
  assert.throws(() => normalizeConfig({ logger: null, training: { arenas: { s2: { type: 'smithing', origin: [0, 0, 0], tasks: '9', exclude: [] } } } }), /training\.arenas\.s2\.tasks 要写/)
})

test('smithing sampler: upgrade / trim about even, 1–4 distinct goals, templates and materials stacked, bases one per slot, reproducible', () => {
  const tables = smithingTables()
  const options = smithingModule.smithingOptions({}, { tasks: '1-4' })
  const kinds = { upgrade: 0, trim: 0 }
  const counts = new Set()
  for (let seed = 0; seed < 300; seed++) {
    const picked = smithingModule.sampleSmithing(tables, seed, options)
    counts.add(picked.tasks.length)
    const keys = picked.tasks.map((t) => JSON.stringify(t.goal))
    assert.equal(new Set(keys).size, keys.length, 'no repeated goal in a round')
    for (const t of picked.tasks) {
      kinds[t.kind]++
      if (t.kind === 'upgrade') assert.deepEqual([t.template, t.goal.trim], [UPGRADE, null])
      else assert.deepEqual(t.goal, { item: t.base, trim: { pattern: SMITHING_CATALOG.trims.find((x) => x.template === t.template).pattern, material: SMITHING_CATALOG.materials.find((x) => x.item === t.addition).material } })
    }
    const slots = picked.layout.map((s) => s.slot)
    assert.equal(new Set(slots).size, slots.length)
    assert.ok(slots.every((s) => s >= 0 && s < 36))
    assert.equal(picked.layout.reduce((n, s) => n + s.count, 0), picked.tasks.length * 3, 'three items per task')
    const isBase = (s) => picked.tasks.some((t) => t.base === s.id)
    assert.ok(picked.layout.filter(isBase).every((s) => s.count === 1), 'tools and armor take a slot each')
    const stackable = picked.layout.filter((s) => !isBase(s)).map((s) => s.id)
    assert.equal(new Set(stackable).size, stackable.length, 'same template / material share one stack')
    assert.equal(picked.kind, new Set(picked.tasks.map((t) => t.kind)).size === 1 ? picked.tasks[0].kind : 'mix')
  }
  assert.deepEqual([...counts].sort(), [1, 2, 3, 4])
  const ratio = kinds.upgrade / (kinds.upgrade + kinds.trim)
  assert.ok(ratio > 0.3 && ratio < 0.6, `upgrade share ${ratio}`)
  assert.deepEqual(smithingModule.sampleSmithing(tables, 42, options), smithingModule.sampleSmithing(tables, 42, options))

  const fixed = (args) => smithingModule.sampleSmithing(tables, 7, smithingModule.smithingOptions({ tasks: '4', ...args }))
  assert.ok(fixed({ base: 'iron_chestplate' }).tasks.every((t) => t.kind === 'trim' && t.base === mc('iron_chestplate')), 'an iron chestplate can only be trimmed')
  assert.equal(fixed({ base: 'diamond_sword' }).tasks.length, 1, 'only one distinct upgrade goal for a fixed sword')
  assert.ok(fixed({ material: 'gold' }).tasks.every((t) => t.goal.trim?.material === mc('gold')))
  assert.throws(() => fixed({ kind: 'trim', base: 'diamond_sword' }), /minecraft:diamond_sword 只能出升级题，和 kind=trim 冲突/)
  assert.throws(() => fixed({ base: 'stick' }), /minecraft:stick 不能锻造/)
  assert.throws(() => fixed({ pattern: 'bolt' }), /没有纹饰样式 minecraft:bolt/)
  assert.equal(smithingModule.smithingTables(SMITHING_CATALOG, ['minecraft:sentry', 'minecraft:gold_ingot']).trims.length, 2, 'exclude takes patterns')
  assert.equal(smithingModule.smithingTables(SMITHING_CATALOG, ['minecraft:gold_ingot']).materials.length, 2, 'exclude takes material items')
})

test('smithing judge: every goal needs its own item with the right trim; swapped materials and partial work are false_success; the cursor does not count; missing items are lost', () => {
  const { judgeSmithing, maxAssigned } = smithingModule
  const trim = (pattern, material) => ({ pattern: mc(pattern), material: mc(material) })
  const picked = {
    tasks: [
      { kind: 'trim', base: mc('iron_chestplate'), goal: { item: mc('iron_chestplate'), trim: trim('sentry', 'gold') } },
      { kind: 'trim', base: mc('iron_chestplate'), goal: { item: mc('iron_chestplate'), trim: trim('wild', 'redstone') } },
      { kind: 'upgrade', base: mc('diamond_sword'), goal: { item: mc('netherite_sword'), trim: null } }
    ]
  }
  const item = (id, t = null, slot = 0) => ({ slot, id: mc(id), count: 1, trim: t })
  const done = [item('iron_chestplate', trim('wild', 'redstone')), item('iron_chestplate', trim('sentry', 'gold')), item('netherite_sword')]
  const judge = (final, extra = {}) => judgeSmithing({ stopped: false, timedOut: false, taskState: 'done', picked, final: { stationIntact: true, carriedItem: null, slots: null, droppedItems: [], takes: [], ...final }, ...extra })
  assert.deepEqual(judge({ items: done }), { outcome: 'success', reached: true, goalsMet: 3, takes: 0, wrongTakes: 0 })
  const swapped = [item('iron_chestplate', trim('wild', 'gold')), item('iron_chestplate', trim('sentry', 'redstone')), item('netherite_sword')]
  const takes = swapped.map((s) => ({ result: s, atMs: 1 }))
  assert.deepEqual(judge({ items: swapped, takes }), { outcome: 'false_success', reached: false, goalsMet: 1, takes: 3, wrongTakes: 2 })
  assert.equal(judge({ items: [done[0], item('iron_chestplate'), item('diamond_sword')] }).goalsMet, 1, 'one of three done')
  assert.equal(judge({ items: [done[0], done[0], item('diamond_sword')] }).goalsMet, 1, 'one goal per item')
  assert.equal(judge({ items: done.slice(0, 2), carriedItem: done[2] }).outcome, 'false_success', 'the product on the cursor is not in the inventory')
  assert.equal(judge({ items: done.slice(0, 2), droppedItems: [done[2]] }).outcome, 'false_success', 'dropped in the arena is not lost')
  assert.equal(judge({ items: done.slice(0, 2), slots: { template: null, base: item('diamond_sword'), addition: null } }).outcome, 'false_success', 'still in the smithing table is not lost')
  assert.equal(judge({ items: done.slice(0, 2) }).outcome, 'lost', 'the third item is gone')
  assert.equal(judge({ items: done, stationIntact: false }).outcome, 'lost')
  assert.equal(judge({ items: done }, { timedOut: true }).outcome, 'timeout')
  assert.equal(judge({ items: done }, { taskState: 'failed' }).outcome, 'failed')
  assert.equal(judge({ items: done }, { stopped: true }).outcome, 'aborted')
  assert.equal(maxAssigned([item('iron_chestplate', trim('sentry', 'gold'))], [{ item: mc('iron_chestplate'), trim: null }]), 0, 'a trimmed item does not answer an untrimmed goal')
})

/**
 * 锻造台题的假世界：arena/smithing-catalog 回 SMITHING_CATALOG；arena/smithing-preview 按 previewOf（缺省 fakeSmithingPreview）；
 * prepare 按参数发物品；任务结束时按 finalOf(params, world) 改状态（缺省：每道题都做出目标）。
 */
function smithingHarness({ finalOf = null, previewOf = fakeSmithingPreview, aimOk = true } = {}) {
  const world = { params: null, state: {}, previews: 0 }
  const defaultFinal = (params) => ({
    items: params.expect.smithing.map((g, i) => ({ slot: i, id: g.item, count: 1, trim: g.trim })),
    takes: params.expect.smithing.map((g) => ({ result: { id: g.item, count: 1, trim: g.trim }, atMs: 1 }))
  })
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
    script, arenas: ARENAS_SMITHING,
    onCall: (method, params) => {
      if (method === 'arena/smithing-catalog') return { ok: true, data: SMITHING_CATALOG }
      if (method === 'arena/smithing-preview') {
        world.previews++
        return previewOf(params, world)
      }
      return null
    },
    prepareData: (params) => {
      world.params = params
      const items = params.items.map((g) => ({ slot: g.slot, id: g.id, count: g.count, enchantments: {}, name: null }))
      world.state = { held: {}, items, carried: {}, carriedItem: null, slots: null, dropped: {}, droppedItems: [], containerOpen: false, takes: [], stationIntact: true, openedAtMs: null, reachedAtMs: null }
      return { aimOk, station: 'smithing_table', smithing: { items } }
    },
    statusData: () => world.state
  })
  return { ...h, world }
}

test('smithing run: the catalog is read once, every task is previewed, the text names the goals only; making them succeeds', async () => {
  const h = smithingHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'smithing', runs: 5, seed: 11 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /每轮 1-4 道题，升级、纹饰等概率/)
  await h.done()
  const records = h.records('smithing')
  assert.equal(records.length, 5)
  assert.equal(h.calls.filter(([m]) => m === 'arena/smithing-catalog').length, 1)
  assert.equal(h.world.previews, records.reduce((n, r) => n + r.tasks.length, 0))
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  for (const [i, record] of records.entries()) {
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.deepEqual([record.goalsMet, record.wrongTakes, record.takes.length], [record.tasks.length, 0, record.tasks.length])
    const prepare = prepares[i]
    assert.deepEqual([prepare.station, prepare.items], ['smithing_table', record.layout])
    assert.deepEqual(prepare.expect, { smithing: record.tasks.map((t) => ({ item: t.goal.item, trim: t.goal.trim })) })
    const text = h.instructions[i]
    assert.ok(text.startsWith(`你正前方有一个锻造台，视角已经对准它。\n你的物品栏里有做出下面 ${record.tasks.length} 件物品所需的材料，每件正好一份：\n1. `), text)
    for (const t of record.tasks) assert.ok(text.includes(smithingModule.goalText(t.goal)), text)
    assert.doesNotMatch(text, /template|ingot|格子|右键|lapis_lazuli/, 'name the goals, not the materials or the moves')
  }
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/5 轮：会话 run-1，锻造 \d 件：/)
  assert.doesNotMatch(prompts.training.smithing, /格子|右键|Shift|模板/, 'describe the goal, do not teach the move')
})

test('smithing run: a mismatched preview resamples the whole set; wrong trim materials are false_success; conflicts are refused', async () => {
  const flaky = smithingHarness({ previewOf: (params, world) => (world.previews === 1 ? { ok: true, data: { result: null } } : fakeSmithingPreview(params)) })
  assert.equal(flaky.trainer.start({ sessionId: 'console', arena: 'smithing', seed: 4 }).ok, true)
  await flaky.done()
  const record = flaky.records('smithing')[0]
  assert.deepEqual([record.outcome, record.retries], ['success', 1], JSON.stringify(record))

  const never = smithingHarness({ previewOf: () => ({ ok: true, data: { result: null } }) })
  assert.equal(never.trainer.start({ sessionId: 'console', arena: 'smithing', runs: 2 }).ok, true)
  await never.done()
  assert.match(never.records('smithing')[0].error, /preview: 抽不出能做的题：连续 21 次预览/)

  // 材料用错（emerald 不是这几道题的材料）：两件盔甲都对不上
  const swapped = smithingHarness({
    finalOf: (params) => {
      const items = params.expect.smithing.map((g, i) => ({ slot: i, id: g.item, count: 1, trim: { ...g.trim, material: 'minecraft:emerald' } }))
      return { items, takes: items.map((s) => ({ result: s, atMs: 1 })) }
    }
  })
  assert.equal(swapped.trainer.start({ sessionId: 'console', arena: 'smithing', tasks: '2', kind: 'trim', base: 'iron_chestplate', pattern: 'sentry' }).ok, true)
  await swapped.done()
  const r = swapped.records('smithing')[0]
  assert.deepEqual([r.outcome, r.goalsMet, r.wrongTakes, r.kind], ['false_success', 0, 2, 'trim'], JSON.stringify(r))

  const h = smithingHarness()
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'smithing', kind: 'upgrade', material: 'gold' }).error, /升级题（kind=upgrade）没有纹饰/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'smithing', xpLevel: 50 }).error, /不认这些选项：xpLevel/)
  const prepared = smithingHarness({ aimOk: false })
  assert.equal(prepared.trainer.start({ sessionId: 'console', arena: 'smithing' }).ok, true)
  await prepared.done()
  assert.match(prepared.records('smithing')[0].error, /crosshair is not on the smithing table/)
})

test('report: smithing records group by kind / tasks / pattern / material and count over-take, wrong-take and partial runs', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const trimTask = (pattern, material) => ({ kind: 'trim', goal: { item: mc('iron_chestplate'), trim: { pattern: mc(pattern), material: mc(material) } } })
  const upTask = { kind: 'upgrade', goal: { item: mc('netherite_sword'), trim: null } }
  const rec = (kind, tasks, outcome, extra = {}) => ({
    batch: 'b1', target: 'x', kind, tasks, outcome, openedMs: 1000, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false, stationIntact: true,
    goalsMet: outcome === 'success' ? tasks.length : 0, wrongTakes: 0, takes: tasks.map(() => ({})), ...extra
  })
  const records = [
    rec('upgrade', [upTask], 'success'),
    rec('trim', [trimTask('sentry', 'gold'), trimTask('wild', 'redstone')], 'false_success', { goalsMet: 1, wrongTakes: 1, takes: [{}, {}, {}] }),
    rec('mix', [upTask, trimTask('sentry', 'lapis')], 'success')
  ]
  const byKind = summarize(records, { by: 'kind' })
  assert.equal(byKind.smither, true)
  assert.deepEqual(byKind.rows.map((r) => [r.key, r.runs]).sort(), [['升级', 1], ['混合', 1], ['纹饰', 1]].sort())
  assert.deepEqual([byKind.total.overTake, byKind.total.wrongTake, byKind.total.partial], [1, 1, 1])
  assert.match(formatSummary(byKind).split('\n')[0], /^类别\t轮数\t成功率\t虚报\t失败\t超时\t中止\t丢失\t多做\t配错\t部分完成\t打开锻造台中位/)
  assert.deepEqual(summarize(records, { by: 'tasks' }).rows.map((r) => [r.key, r.runs]), [['2 道', 2], ['1 道', 1]])
  assert.deepEqual(summarize(records, { by: 'pattern' }).rows.map((r) => [r.key, r.runs]).sort(), [['sentry', 1], ['sentry+wild', 1], ['无（升级）', 1]].sort())
  assert.deepEqual(summarize(records, { by: 'material' }).rows.map((r) => [r.key, r.runs]).sort(), [['gold+redstone', 1], ['lapis', 1], ['无（升级）', 1]].sort())
  assert.equal(summarize([{ target: 'x', outcome: 'success', craftedMs: 1, taskMs: 1, items: [] }]).smither, false, 'craft records are not smithing records')
})

// ── 坐骑训练场（docs/坐骑训练场设计方案.md）──────────────────────────────

const mountModule = await import('../src/training/mount.js')

const HORSE_ARMORS = ['minecraft:diamond_horse_armor', 'minecraft:iron_horse_armor', 'minecraft:leather_horse_armor']
/** 假的 arena/mount-catalog：10 种动物，装备按设计方案 F2 */
const MOUNT_CATALOG = {
  animals: [
    { id: 'minecraft:horse', group: 'horse', saddle: ['minecraft:saddle'], body: HORSE_ARMORS, chest: 0 },
    { id: 'minecraft:zombie_horse', group: 'horse', saddle: ['minecraft:saddle'], body: HORSE_ARMORS, chest: 0 },
    { id: 'minecraft:donkey', group: 'donkey', saddle: ['minecraft:saddle'], body: [], chest: 15 },
    { id: 'minecraft:mule', group: 'donkey', saddle: ['minecraft:saddle'], body: [], chest: 15 },
    { id: 'minecraft:camel', group: 'camel', saddle: ['minecraft:saddle'], body: [], chest: 0 },
    { id: 'minecraft:camel_husk', group: 'camel', saddle: ['minecraft:saddle'], body: [], chest: 0 },
    { id: 'minecraft:llama', group: 'llama', saddle: [], body: ['minecraft:red_carpet', 'minecraft:white_carpet'], chest: 'strength' },
    { id: 'minecraft:trader_llama', group: 'llama', saddle: [], body: ['minecraft:red_carpet', 'minecraft:white_carpet'], chest: 'strength' },
    { id: 'minecraft:nautilus', group: 'nautilus', saddle: ['minecraft:saddle'], body: ['minecraft:iron_nautilus_armor'], chest: 0 },
    { id: 'minecraft:zombie_nautilus', group: 'nautilus', saddle: ['minecraft:saddle'], body: ['minecraft:iron_nautilus_armor'], chest: 0 }
  ]
}
const MOUNT_PROPS = { ...ITEM_PROPS, 'minecraft:red_carpet': { maxStack: 64 }, 'minecraft:bundle': { maxStack: 1 } }
const ARENAS_MOUNT = { mount: { type: 'mount', origin: [0, 100, 240], timeoutSec: 600, groups: ['horse', 'donkey', 'camel', 'llama', 'nautilus'], total: '64-128', move: '1-64', exclude: ['minecraft:bundle'] } }
const mountTables = () => mountModule.mountTables(MOUNT_CATALOG, MOUNT_PROPS, ['minecraft:bundle'])

test('mount options: group, animal, task, item, total and move; chest-only options need a chested group; task is shared with the anvil arena (§5.2)', () => {
  const { mountOptions } = mountModule
  const all = ['horse', 'donkey', 'camel', 'llama', 'nautilus']
  assert.deepEqual(mountOptions({}, {}), { groups: all, group: null, animal: null, task: null, item: null, total: { lo: 64, hi: 128 }, move: { lo: 1, hi: 64 } })
  assert.deepEqual(mountOptions({ animal: 'mule' }, {}).groups, ['donkey'])
  assert.deepEqual(mountOptions({ item: 'stick' }, { groups: ['horse', 'llama'] }).groups, ['llama'], 'item narrows to chested groups')
  assert.throws(() => mountOptions({ group: 'horse', animal: 'mule' }), /minecraft:mule 属于 donkey 组，和 group=horse 冲突/)
  assert.throws(() => mountOptions({ group: 'camel', move: '5' }), /camel 组的动物没有箱子，不能和 move 一起用/)
  assert.throws(() => mountOptions({ task: 'merge' }), /坐骑场地的 task 只能是 equip \/ unequip/)
  assert.throws(() => mountOptions({ animal: 'pig' }), /animal 只能是/)
  assert.throws(() => mountOptions({ total: '10', move: '20' }), /move 的下限 20 大于 total 的下限 10/)
  assert.throws(() => mountOptions({ total: '200' }), /total 要写 k 或 a-b（2–128/)
  const parsed = parseTrainArgs(['mount', 'group=llama', 'animal=minecraft:trader_llama', 'task=unequip', 'total=64', 'move=1-10'])
  assert.deepEqual([parsed.ok, parsed.group, parsed.animal, parsed.task, parsed.total, parsed.move], [true, 'llama', 'minecraft:trader_llama', 'unequip', '64', '1-10'])
  assert.equal(parseTrainArgs(['anvil', 'task=merge']).task, 'merge', 'anvil task values still parse')
  assert.match(parseTrainArgs(['mount', 'task=ride']).error, /task 只能是 merge \/ rename \/ both（铁砧题）、equip \/ unequip（坐骑题）或 zoom \/ lock \/ clone \/ mix \/ chain（制图台题）/)
  assert.match(parseTrainArgs(['mount', 'group=pig']).error, /group 只能是 horse \/ donkey/)
  const config = normalizeConfig({ logger: null })
  assert.deepEqual(config.training.arenas.mount, { type: 'mount', origin: [10000, 120, 10240], timeoutSec: 600, groups: all, total: '64-128', move: '1-64', exclude: ['minecraft:bundle'] })
  assert.throws(() => normalizeConfig({ logger: null, training: { arenas: { m2: { type: 'mount', origin: [0, 0, 0], groups: ['pig'], exclude: [] } } } }), /training\.arenas\.m2\.groups 要是/)
})

test('mount sampler: groups about even, equipment from the catalog, two stacks of 1–64 summing to the total, k within the total, llama strength 1–5, reproducible', () => {
  const tables = mountTables()
  assert.ok(!tables.pool.includes('minecraft:red_carpet') && !tables.pool.includes('minecraft:bundle') && !tables.pool.includes('minecraft:shears'), 'equipment, excluded and non-64 items are not in the pool')
  const options = mountModule.mountOptions({}, {})
  const groups = {}
  const tasks = { equip: 0, unequip: 0 }
  for (let seed = 0; seed < 500; seed++) {
    const p = mountModule.sampleMount(tables, seed, options)
    groups[p.group] = (groups[p.group] ?? 0) + 1
    tasks[p.task]++
    assert.equal(mountModule.GROUP_OF[p.animal], p.group)
    const entry = MOUNT_CATALOG.animals.find((a) => a.id === p.animal)
    assert.equal(p.equipment.saddle, entry.saddle[0] ?? null)
    assert.ok(entry.body.length ? entry.body.includes(p.equipment.body) : p.equipment.body === null)
    if (entry.chest) {
      assert.ok(p.split.every((n) => n >= 1 && n <= 64) && p.split[0] + p.split[1] === p.total && p.total >= 64 && p.total <= 128, JSON.stringify(p))
      assert.ok(p.move >= 1 && p.move <= Math.min(64, p.total))
      assert.equal(p.chestSize, entry.chest === 15 ? 15 : 3 * p.strength)
      if (entry.chest === 'strength') assert.ok(p.strength >= 1 && p.strength <= 5)
      const target = p.task === 'equip' ? p.layout : p.chestLayout
      assert.equal(target.filter((s) => s.id === p.item).reduce((n, s) => n + s.count, 0), p.total)
      if (p.task === 'unequip') assert.ok(p.chestLayout.every((s) => s.slot < p.chestSize))
    } else {
      assert.deepEqual([p.item, p.total, p.move, p.strength, p.chestSize], [null, null, null, null, 0])
    }
    if (p.task === 'unequip') assert.deepEqual(p.layout, [], 'nothing handed out for unequip')
    const slots = p.layout.map((s) => s.slot)
    assert.equal(new Set(slots).size, slots.length)
  }
  for (const g of Object.keys(groups)) assert.ok(groups[g] > 70 && groups[g] < 130, `group ${g}: ${groups[g]}`)
  assert.ok(tasks.equip > 200 && tasks.unequip > 200)
  assert.deepEqual(mountModule.sampleMount(tables, 42, options), mountModule.sampleMount(tables, 42, options))
  assert.throws(() => mountModule.sampleMount(tables, 1, mountModule.mountOptions({ animal: 'donkey', item: 'minecraft:shears' })), /物品池里没有 minecraft:shears/)
})

test('mount goal, text and judge: equip / unequip targets; overshoot, misplaced, cursor, dropped and a missing mount (H4, H5)', () => {
  const { mountGoal, mountSetup, mountText, judgeMount } = mountModule
  const donkey = { group: 'donkey', animal: 'minecraft:donkey', task: 'equip', equipment: { saddle: 'minecraft:saddle', body: null }, item: 'minecraft:stick', total: 100, split: [64, 36], move: 37, strength: null, chestSize: 15, layout: [], chestLayout: [] }
  assert.deepEqual(mountGoal(donkey), { saddle: 'minecraft:saddle', chest: { 'minecraft:stick': 37 }, inventory: { 'minecraft:stick': 63 } })
  const llamaOff = { group: 'llama', animal: 'minecraft:llama', task: 'unequip', equipment: { saddle: null, body: 'minecraft:red_carpet' }, item: 'minecraft:stick', total: 64, split: [10, 54], move: 64, strength: 2, chestSize: 6, layout: [], chestLayout: [{ slot: 0, id: 'minecraft:stick', count: 10 }, { slot: 3, id: 'minecraft:stick', count: 54 }] }
  assert.deepEqual(mountGoal(llamaOff), { body: null, chest: {}, inventory: { 'minecraft:red_carpet': 1, 'minecraft:stick': 64 } })
  assert.deepEqual(mountSetup(llamaOff), { animal: 'minecraft:llama', saddle: null, body: 'minecraft:red_carpet', chest: llamaOff.chestLayout, strength: 2 })
  const horse = { group: 'horse', animal: 'minecraft:horse', task: 'equip', equipment: { saddle: 'minecraft:saddle', body: 'minecraft:iron_horse_armor' }, item: null, total: null, split: null, move: null, strength: null, chestSize: 0, layout: [], chestLayout: [] }
  assert.deepEqual(mountText(horse), { animal: 'minecraft:horse', chestNote: '', given: '1 个 minecraft:saddle、1 个 minecraft:iron_horse_armor', goals: '把 minecraft:saddle 和 minecraft:iron_horse_armor 都装到它身上' })
  assert.equal(mountText(donkey).goals, '把 minecraft:saddle 装到它身上，并把 37 个 minecraft:stick 放进它身上的箱子里，其余的留在你的物品栏里')
  assert.equal(mountText(llamaOff).goals, '把 minecraft:red_carpet 取下来，并从它的箱子里取出 64 个 minecraft:stick，都放进你的物品栏', '全部取出时不写"其余的"')
  assert.equal(mountText({ ...llamaOff, move: 10 }).goals, '把 minecraft:red_carpet 取下来，并从它的箱子里取出 10 个 minecraft:stick，都放进你的物品栏，其余的留在它的箱子里')
  assert.equal(mountText({ ...horse, animal: 'minecraft:camel', task: 'unequip', equipment: { saddle: 'minecraft:saddle', body: null } }).goals, '把 minecraft:saddle 取下来，放进你的物品栏')
  const text = renderTemplate(prompts.training.mount_unequip, mountText(llamaOff))
  assert.equal(text, '你正前方有一只已驯服的 minecraft:llama，它身上装着 minecraft:red_carpet，挂着的箱子里有 minecraft:stick。\n请把 minecraft:red_carpet 取下来，并从它的箱子里取出 64 个 minecraft:stick，都放进你的物品栏。')
  assert.doesNotMatch(prompts.training.mount_equip + prompts.training.mount_unequip, /潜行|右键|格子|Shift|按 E/, 'describe the goal, not the moves')

  const judge = (picked, final, extra = {}) => judgeMount({ stopped: false, timedOut: false, taskState: 'done', picked, final: { stationIntact: true, carried: {}, dropped: {}, ...final }, ...extra })
  const ok = { mount: { saddle: 'minecraft:saddle', body: null, chest: { 'minecraft:stick': 37 } }, held: { 'minecraft:stick': 63 } }
  assert.deepEqual(judge(donkey, ok), { outcome: 'success', reached: true, misplaced: false })
  assert.equal(judge(donkey, { ...ok, mount: { ...ok.mount, chest: { 'minecraft:stick': 38 } }, held: { 'minecraft:stick': 62 } }).outcome, 'overshoot')
  assert.equal(judge(donkey, { ...ok, mount: { ...ok.mount, chest: { 'minecraft:stick': 36 } }, held: { 'minecraft:stick': 64 } }).outcome, 'false_success', 'moved too few')
  assert.equal(judge(donkey, { mount: { saddle: null, body: null, chest: { 'minecraft:stick': 37, 'minecraft:saddle': 1 } }, held: { 'minecraft:stick': 63 } }).outcome, 'misplaced')
  assert.equal(judge(donkey, { ...ok, held: { 'minecraft:stick': 62 }, carried: { 'minecraft:stick': 1 } }).outcome, 'false_success', 'cursor is not the inventory')
  assert.equal(judge(donkey, { ...ok, held: { 'minecraft:stick': 62 }, dropped: { 'minecraft:stick': 1 } }).outcome, 'lost')
  assert.equal(judge(donkey, { ...ok, mount: null, stationIntact: false }).outcome, 'lost')
  assert.equal(judge(donkey, { ...ok, held: { 'minecraft:stick': 50 } }).outcome, 'lost', 'items went missing')
  assert.equal(judge(donkey, ok, { timedOut: true }).outcome, 'timeout')
  assert.equal(judge(donkey, ok, { stopped: true }).outcome, 'aborted')
  assert.equal(judge(llamaOff, { mount: { saddle: null, body: null, chest: {} }, held: { 'minecraft:red_carpet': 1, 'minecraft:stick': 64 } }).outcome, 'success')
  assert.equal(judge(llamaOff, { mount: { saddle: null, body: 'minecraft:red_carpet', chest: {} }, held: { 'minecraft:stick': 64 } }).outcome, 'false_success', 'carpet still on')
})

/**
 * 坐骑题的假世界：arena/mount-catalog 回 MOUNT_CATALOG；prepare 按 mount 参数"生成"动物；任务结束时按 finalOf(params, world) 改状态
 * （缺省：做到目标状态）。
 */
function mountHarness({ finalOf = null, aimOk = true } = {}) {
  const world = { params: null, state: {} }
  const defaultFinal = (params) => {
    const g = params.expect.mount
    return { mount: { ...world.state.mount, saddle: g.saddle ?? null, body: g.body ?? null, chest: g.chest }, held: g.inventory }
  }
  const script = ({ req, executor, clock, setBusy }) => setImmediate(async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    await tick()
    req.closed = true
    req.answered = true
    executor.task = { taskId: req.taskId, state: 'running' }
    executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
    for (let i = 0; i < 3; i++) await tick()
    Object.assign(world.state, { openedAtMs: clock() - 2, rodeAtMs: clock() - 1, reachedAtMs: clock() }, (finalOf ?? defaultFinal)(world.params, world))
    for (let i = 0; i < 3; i++) await tick()
    executor.task.state = 'done'
    setBusy(2)
    executor.emit('task', { taskId: req.taskId, state: 'done', version: 2 })
  })
  const h = harness({
    script, arenas: ARENAS_MOUNT, itemProps: MOUNT_PROPS,
    onCall: (method) => (method === 'arena/mount-catalog' ? { ok: true, data: MOUNT_CATALOG } : null),
    prepareData: (params) => {
      world.params = params
      const m = params.mount
      const chest = {}
      for (const g of m.chest) chest[g.id] = (chest[g.id] ?? 0) + g.count
      const entry = MOUNT_CATALOG.animals.find((a) => a.id === m.animal)
      const chestSize = entry.chest === 15 ? 15 : entry.chest === 'strength' ? 3 * m.strength : 0
      const mount = { id: m.animal, uuid: 'u1', saddle: m.saddle, body: m.body, chest, chestSize, ...(m.strength ? { strength: m.strength } : {}) }
      const items = params.items.map((g) => ({ slot: g.slot, id: g.id, count: g.count, enchantments: {}, name: null }))
      world.state = { mount, held: {}, carried: {}, dropped: {}, containerOpen: false, riding: false, rodeAtMs: null, equippedWithoutMenu: false, stationIntact: true, openedAtMs: null, reachedAtMs: null }
      return { aimOk, station: 'mount', mount: { ...mount, items } }
    },
    statusData: () => world.state
  })
  return { ...h, world }
}

test('mount run: the catalog is read once, prepare spawns the mount, the task names the goal only; reaching the goal succeeds', async () => {
  const h = mountHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'mount', runs: 8, seed: 5 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /组 马、驴、骆驼、羊驼、鹦鹉螺 等概率，装上、卸下等概率，total=64-128，move=1-64/)
  await h.done()
  const records = h.records('mount')
  assert.equal(records.length, 8)
  assert.equal(h.calls.filter(([m]) => m === 'arena/mount-catalog').length, 1)
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  for (const [i, record] of records.entries()) {
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    const prepare = prepares[i]
    assert.deepEqual([prepare.station, prepare.items, prepare.mount.animal], ['mount', record.layout, record.animal])
    assert.deepEqual(prepare.expect, { mount: mountModule.mountGoal(record) })
    assert.ok(record.rodeMs !== null && record.reachedMs !== null && record.equippedWithoutMenu === false)
    const text = h.instructions[i]
    assert.ok(text.startsWith(`你正前方有一只已驯服的 ${record.animal}`), text)
    assert.doesNotMatch(text, /潜行|右键|格子|按 E/)
  }
  assert.ok(new Set(records.map((r) => r.group)).size >= 3)
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/8 轮：会话 run-1，坐骑 \S+ (装上|卸下) /)
})

test('mount run: overshoot, a wrong spawn and option conflicts', async () => {
  const over = mountHarness({
    finalOf: (params, world) => {
      const [id, k] = Object.entries(params.expect.mount.chest)[0]
      const n = params.items.filter((g) => g.id === id).reduce((sum, g) => sum + g.count, 0)
      return { mount: { ...world.state.mount, saddle: 'minecraft:saddle', chest: { [id]: k + 1 } }, held: { [id]: n - k - 1 } }
    }
  })
  assert.equal(over.trainer.start({ sessionId: 'console', arena: 'mount', animal: 'donkey', task: 'equip', move: '10' }).ok, true)
  await over.done()
  assert.equal(over.records('mount')[0].outcome, 'overshoot')

  const h = mountHarness({ aimOk: false })
  assert.equal(h.trainer.start({ sessionId: 'console', arena: 'mount' }).ok, true)
  await h.done()
  assert.match(h.records('mount')[0].error, /crosshair is not on the minecraft:/)

  const c = mountHarness()
  assert.match(c.trainer.start({ sessionId: 'console', arena: 'mount', group: 'horse', item: 'stick' }).error, /horse 组的动物没有箱子/)
  assert.match(c.trainer.start({ sessionId: 'console', arena: 'mount', xpLevel: 50 }).error, /不认这些选项：xpLevel/)
  assert.match(c.trainer.start({ sessionId: 'console', arena: 'mount', task: 'merge' }).error, /坐骑场地的 task 只能是 equip \/ unequip/)
})

test('report: mount records group by group / animal / task and count overshoot, misplaced, rode and equipped-without-menu runs', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (group, animal, task, outcome, extra = {}) => ({
    batch: 'b1', target: 'x', group, animal: `minecraft:${animal}`, task, outcome, openedMs: 1000, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false, stationIntact: true,
    rodeMs: null, equippedWithoutMenu: false, ...extra
  })
  const records = [
    rec('horse', 'horse', 'equip', 'success', { equippedWithoutMenu: true }),
    rec('donkey', 'mule', 'equip', 'overshoot', { rodeMs: 300 }),
    rec('donkey', 'donkey', 'unequip', 'misplaced'),
    rec('llama', 'llama', 'unequip', 'success')
  ]
  const byGroup = summarize(records, { by: 'group' })
  assert.equal(byGroup.mounter, true)
  assert.deepEqual(byGroup.rows.map((r) => [r.key, r.runs]).sort(), [['羊驼', 1], ['马', 1], ['驴', 2]].sort())
  assert.deepEqual([byGroup.total.overshoot, byGroup.total.misplaced, byGroup.total.rode, byGroup.total.withoutMenu], [1, 1, 1, 1])
  assert.match(formatSummary(byGroup).split('\n')[0], /^组\t轮数\t成功率\t虚报\t失败\t超时\t中止\t丢失\t放多\t放错\t骑上过\t不开界面装备\t打开物品栏中位/)
  assert.deepEqual(summarize(records, { by: 'task' }).rows.map((r) => [r.key, r.runs]).sort(), [['卸下', 2], ['装上', 2]])
  assert.deepEqual(summarize(records, { by: 'animal' }).rows.map((r) => r.key).sort(), ['donkey', 'horse', 'llama', 'mule'])
  assert.equal(summarize([{ target: 'x', outcome: 'success', craftedMs: 1, taskMs: 1, items: [] }]).mounter, false, 'craft records are not mount records')
})

// ── 织布机训练场（docs/织布机训练场设计方案.md）──────────────────────────────

const loomModule = await import('../src/training/loom.js')
const LOOM_CATALOG = {
  banners: [{ id: mc('white_banner'), color: 'white' }, { id: mc('black_banner'), color: 'black' }, { id: mc('red_banner'), color: 'red' }],
  dyes: [{ id: mc('white_dye'), color: 'white' }, { id: mc('black_dye'), color: 'black' }, { id: mc('red_dye'), color: 'red' }, { id: mc('blue_dye'), color: 'blue' }],
  patterns: [mc('stripe_bottom'), mc('cross'), mc('border')],
  patternItems: [{ item: mc('creeper_banner_pattern'), patterns: [mc('creeper')] }]
}
const loomTables = (exclude = []) => loomModule.loomTables(LOOM_CATALOG, exclude)

test('loom options: banners, slots, styles, spare (0–3) and itemPatterns; banner= fixes the first base; tables drop excluded ids (§5, L11)', () => {
  const { loomOptions, parseSpareSpec } = loomModule
  assert.deepEqual(loomOptions({}, {}), { banners: { lo: 1, hi: 3 }, slots: { lo: 1, hi: 3 }, fill: 'random', styles: { lo: 1, hi: 3 }, spare: { lo: 0, hi: 3 }, itemPatterns: 'off', banner: null })
  assert.deepEqual(parseSpareSpec('0'), { lo: 0, hi: 0 })
  assert.throws(() => parseSpareSpec('4'), /spare 要写 k 或 a-b（0–3/)
  assert.throws(() => loomOptions({ slots: '4' }), /slots 要写 k 或 a-b（1–3/)
  assert.throws(() => loomOptions({ itemPatterns: 'yes' }), /itemPatterns 只能是 off \/ on/)
  assert.equal(loomOptions({ banner: 'white_banner' }).banner, mc('white_banner'))
  const tables = loomTables([mc('red_dye'), mc('border')])
  assert.deepEqual([tables.colors, tables.patterns, tables.itemPatterns], [['black', 'blue', 'white'], [mc('stripe_bottom'), mc('cross')], [{ item: mc('creeper_banner_pattern'), pattern: mc('creeper') }]])
  assert.equal(loomTables([mc('creeper_banner_pattern')]).itemPatterns.length, 0)
  assert.throws(() => loomModule.sampleLoom(loomTables(), 1, loomOptions({ banner: 'cyan_banner' })), /没有素旗 minecraft:cyan_banner/)
})

test('loom sampler: colors differ from the base, styles distinct per base, spare 0–3 on banners and dyes, stacks within limits, items only when on, reproducible (L3–L6)', () => {
  const { sampleLoom, loomOptions, goalsOf, givenIds, loomExpect, BANNER_STACK, DYE_STACK } = loomModule
  const tables = loomTables()
  let itemStyles = 0
  let styles = 0
  for (const itemPatterns of ['off', 'on']) {
    const options = loomOptions({ itemPatterns })
    for (let seed = 0; seed < 400; seed++) {
      const p = sampleLoom(tables, seed, options)
      assert.equal(new Set(p.banners.map((b) => b.id)).size, p.banners.length)
      const dyeWant = {}
      for (const b of p.banners) {
        const keys = b.styles.map((st) => `${st.pattern}/${st.color}`)
        assert.equal(new Set(keys).size, keys.length, 'styles distinct per base')
        assert.ok(b.styles.length >= 1 && b.styles.length <= 3 && b.slots >= 1 && b.slots <= 3)
        const want = b.styles.reduce((n, st) => n + st.want, 0)
        assert.ok(b.given - want >= 0 && b.given - want <= 3, 'banner spare 0–3')
        for (const st of b.styles) {
          assert.notEqual(st.color, b.color)
          assert.ok(st.want >= 1 && st.want <= Math.floor(b.scale / b.styles.length))
          if (itemPatterns === 'off') assert.equal(st.item, null)
          if (st.item) {
            itemStyles++
            assert.equal(st.pattern, mc('creeper'))
          }
          if (itemPatterns === 'on') styles++
          dyeWant[st.color] = (dyeWant[st.color] ?? 0) + st.want
        }
      }
      for (const d of p.dyes) assert.ok(d.given - dyeWant[d.color] >= 0 && d.given - dyeWant[d.color] <= 3, 'dye spare 0–3')
      assert.deepEqual(p.patternItems, [...new Set(goalsOf(p).map((g) => g.item).filter(Boolean))].sort())
      const sum = (id) => p.layout.filter((s) => s.id === id).reduce((n, s) => n + s.count, 0)
      for (const b of p.banners) assert.equal(sum(b.id), b.given)
      for (const d of p.dyes) assert.equal(sum(d.id), d.given)
      for (const s of p.layout) assert.ok(s.count <= (s.id.endsWith('_banner') ? BANNER_STACK : s.id.endsWith('_dye') ? DYE_STACK : 1))
      assert.equal(new Set(p.layout.map((s) => s.slot)).size, p.layout.length)
      const end = goalsOf(p).reduce((n, g) => n + Math.ceil(g.want / BANNER_STACK), 0)
      assert.ok(p.layout.length + end <= 36, 'start slots + target stacks fit')
      assert.deepEqual(loomExpect(p).loom.allowed, givenIds(p))
    }
  }
  assert.ok(itemStyles / styles > 0.25 && itemStyles / styles < 0.42, `about a third use the pattern item (${itemStyles}/${styles})`)
  const full = sampleLoom(tables, 9, loomOptions({ fill: 'full', banners: '1', slots: '2' }))
  assert.equal(full.banners[0].scale, 32)
  assert.deepEqual(sampleLoom(tables, 42, loomOptions({})), sampleLoom(tables, 42, loomOptions({})))
  assert.equal(sampleLoom(tables, 3, loomOptions({ banner: 'red_banner' })).banners[0].id, mc('red_banner'))
})

/** 织布机题的固定一道：白旗做 3 面 stripe_bottom/red、2 面 creeper/blue（图案物）；发 6 面白旗、4 份红染料、2 份蓝染料、1 个苦力怕图案物 */
function fixedLoom() {
  return {
    bannerCount: 1, styleCount: 2, fill: 'random', retries: 0,
    banners: [{ id: mc('white_banner'), color: 'white', slots: 1, scale: 10, given: 6, styles: [
      { pattern: mc('stripe_bottom'), color: 'red', item: null, want: 3 },
      { pattern: mc('creeper'), color: 'blue', item: mc('creeper_banner_pattern'), want: 2 }] }],
    dyes: [{ id: mc('blue_dye'), color: 'blue', given: 2 }, { id: mc('red_dye'), color: 'red', given: 4 }],
    patternItems: [mc('creeper_banner_pattern')], layout: [], target: `${mc('white_banner')}#${mc('stripe_bottom')}/red`, want: 3
  }
}

test('loom judge: exact goals succeed with leftovers; overshoot, misweave (wrong style, two layers, mixed dye), lost (thrown out, dropped, missing pattern item), copied (L8, L10)', () => {
  const { judgeLoom } = loomModule
  const p = fixedLoom()
  const W = mc('white_banner')
  const red = `${W}#${mc('stripe_bottom')}/red`
  const blue = `${W}#${mc('creeper')}/blue`
  const base = { [red]: 3, [blue]: 2, [W]: 1, [mc('red_dye')]: 1, [mc('creeper_banner_pattern')]: 1 }
  const judge = (held, extra = {}) => judgeLoom({ taskState: 'done', picked: p, final: { held, carried: {}, loomInput: {}, dropped: {}, stationIntact: true, ...extra } })
  const ok = judge(base)
  assert.deepEqual([ok.outcome, ok.reached, ok.copied, ok.madeOf], ['success', true, 0, { [red]: 3, [blue]: 2 }])
  assert.equal(judge({ [red]: 3, [blue]: 2, [mc('red_dye')]: 1, [mc('creeper_banner_pattern')]: 1 }, { loomInput: { [W]: 1 } }).outcome, 'success', 'a plain banner left in the loom input is fine')
  assert.equal(judge({ [red]: 3, [W]: 1, [mc('red_dye')]: 1, [mc('creeper_banner_pattern')]: 1 }, { loomInput: { [blue]: 2 } }).outcome, 'false_success', 'goals must be in the inventory, not the loom')
  assert.equal(judge({ ...base, [red]: 4, [W]: 0, [mc('red_dye')]: 0 }).outcome, 'overshoot')
  const wrong = judge({ ...base, [W]: 0, [`${W}#${mc('cross')}/red`]: 1, [mc('red_dye')]: 0 })
  assert.deepEqual([wrong.outcome, wrong.extra], ['misweave', { [`${W}#${mc('cross')}/red`]: 1 }])
  assert.equal(judge({ ...base, [red]: 2, [`${red}+${mc('border')}/red`]: 1, [mc('red_dye')]: 0 }).outcome, 'misweave', 'a second layer is the wrong style')
  assert.equal(judge({ ...base, [mc('red_dye')]: 0, [mc('purple_dye')]: 2, [mc('blue_dye')]: 0 }).outcome, 'misweave', 'mixed dye is a new item')
  assert.equal(judge({ ...base, [W]: 0 }).outcome, 'lost', 'a banner thrown out of the arena')
  assert.equal(judge(base, { dropped: { [mc('red_dye')]: 1 } }).outcome, 'lost')
  assert.equal(judge({ ...base, [mc('creeper_banner_pattern')]: 0 }).outcome, 'lost', 'the pattern item is gone')
  assert.equal(judge(base, { stationIntact: false }).outcome, 'lost')
  // 2×2 复制：用掉的染料比做出的旗少
  const copied = judge({ ...base, [mc('red_dye')]: 2 })
  assert.deepEqual([copied.outcome, copied.copied], ['success', 1])
  assert.equal(judge(base, { carried: { [red]: 1 } }).outcome, 'overshoot')
  assert.equal(judge({ ...base, [red]: 2 }, { carried: { [red]: 1 } }).outcome, 'false_success', 'a goal on the cursor is not reached')
  assert.equal(judgeLoom({ taskState: 'done', picked: p, final: { held: base, carried: {}, loomInput: {}, dropped: {} }, timedOut: true }).outcome, 'timeout')
  assert.equal(judgeLoom({ stopped: true, picked: p, final: null }).outcome, 'aborted')
})

/**
 * 织布机题的假世界：arena/loom-catalog 回 LOOM_CATALOG；prepare 按参数发物品；任务结束时按 finalOf(params, world) 改状态
 * （缺省：每个目标恰好做出，染料每面用 1 份，剩下的素旗、染料留在物品栏）。
 */
function loomHarness({ finalOf = null, aimOk = true } = {}) {
  const world = { params: null, state: {} }
  const defaultFinal = (params) => {
    const held = {}
    for (const g of params.items) held[g.id] = (held[g.id] ?? 0) + g.count
    for (const goal of params.expect.loom.goals) {
      held[`${goal.banner}#${goal.pattern}/${goal.color}`] = goal.count
      held[goal.banner] -= goal.count
      held[mc(`${goal.color}_dye`)] -= goal.count
    }
    return { held: Object.fromEntries(Object.entries(held).filter(([, n]) => n > 0)) }
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
    script, arenas: { loom: { type: 'loom', origin: [0, 100, 270], timeoutSec: 900, banners: '1-3', slots: '1-3', fill: 'random', styles: '1-3', spare: '0-3', itemPatterns: 'off', exclude: [] } },
    onCall: (method) => (method === 'arena/loom-catalog' ? { ok: true, data: LOOM_CATALOG } : null),
    prepareData: (params) => {
      world.params = params
      world.state = { held: {}, carried: {}, loomInput: {}, dropped: {}, containerOpen: false, stationIntact: true, openedAtMs: null, reachedAtMs: null }
      return { aimOk, station: 'loom' }
    },
    statusData: () => world.state
  })
  return { ...h, world }
}

test('loom run: the catalog is read once, prepare carries the goals, the text names bases, patterns and colors only; making them succeeds', async () => {
  const h = loomHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'loom', runs: 4, seed: 5, itemPatterns: 'on' })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /banners=1-3，slots=1-3，fill=random，styles=1-3，spare=0-3，itemPatterns=on/)
  await h.done()
  const records = h.records('loom')
  assert.equal(records.length, 4)
  assert.equal(h.calls.filter(([m]) => m === 'arena/loom-catalog').length, 1)
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  for (const [i, record] of records.entries()) {
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.equal(record.copied, 0)
    const prepare = prepares[i]
    assert.deepEqual([prepare.station, prepare.items], ['loom', record.layout])
    assert.deepEqual(prepare.expect.loom.goals, record.banners.flatMap((b) => b.styles.map((st) => ({ banner: b.id, pattern: st.pattern, color: st.color, count: st.want }))))
    for (const b of record.banners) for (const st of b.styles) assert.equal(st.made, st.want)
    for (const d of record.dyes) assert.equal(d.used, record.banners.flatMap((b) => b.styles).filter((st) => st.color === d.color).reduce((n, st) => n + st.want, 0))
    const text = h.instructions[i]
    assert.ok(text.startsWith(`你正前方有一台织布机，视角已经对准它。你的物品栏里有这些旗帜：${record.banners.map((b) => b.id).join('、')}。\n请做出：用 `), text)
    for (const b of record.banners) for (const st of b.styles) assert.ok(text.includes(`${st.want} 面加了 ${st.color} 色 ${st.pattern} 图案的`), text)
    assert.doesNotMatch(text, /dye|染料|图案物|按钮|右键|Shift|复制/, 'name the goal, not the materials or the moves')
  }
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/4 轮：会话 run-1，\w+_banner 做 \d+ 面 /)
})

test('loom run: overshoot and option conflicts; a crosshair off the loom stops the run', async () => {
  const over = loomHarness({
    finalOf: (params) => {
      const [goal] = params.expect.loom.goals
      // 多做一面：素旗少一面，旗帜总数不变（不算丢失）
      const held = {}
      for (const g of params.items) held[g.id] = (held[g.id] ?? 0) + g.count
      held[goal.banner] -= goal.count + 1
      held[mc(`${goal.color}_dye`)] -= goal.count + 1
      held[`${goal.banner}#${goal.pattern}/${goal.color}`] = goal.count + 1
      return { held }
    }
  })
  assert.equal(over.trainer.start({ sessionId: 'console', arena: 'loom', banners: '1', styles: '1', spare: '3', seed: 2 }).ok, true)
  await over.done()
  assert.equal(over.records('loom')[0].outcome, 'overshoot')

  const h = loomHarness()
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'loom', item: 'white_banner' }).error, /织布机场地用 banner= 固定第一种底色/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'loom', bypass: 'keep' }).error, /不认这些选项：bypass/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'loom', slots: '5' }).error, /slots 要写 k 或 a-b（1–3/)
  const off = loomHarness({ aimOk: false })
  assert.equal(off.trainer.start({ sessionId: 'console', arena: 'loom' }).ok, true)
  await off.done()
  assert.match(off.records('loom')[0].error, /crosshair is not on the loom/)
})

test('report: loom records group by styles / banners / pattern / color / item and count overshoot, misweave and copied runs', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const st = (pattern, color, item = null) => ({ pattern: mc(pattern), color, item, want: 1, made: 1 })
  const rec = (banners, outcome, extra = {}) => ({
    batch: 'b1', target: 'x', banners, bannerCount: banners.length, styleCount: banners.reduce((n, b) => n + b.styles.length, 0), patternItems: [],
    outcome, copied: 0, openedMs: 1000, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false, stationIntact: true, ...extra
  })
  const records = [
    rec([{ id: mc('white_banner'), styles: [st('cross', 'red')] }], 'success'),
    rec([{ id: mc('white_banner'), styles: [st('cross', 'red'), st('border', 'blue')] }], 'misweave', { copied: 2 }),
    rec([{ id: mc('black_banner'), styles: [st('creeper', 'red', mc('creeper_banner_pattern'))] }], 'overshoot', { patternItems: [mc('creeper_banner_pattern')] })
  ]
  const byStyles = summarize(records, { by: 'styles' })
  assert.equal(byStyles.loomer, true)
  assert.deepEqual(byStyles.rows.map((r) => [r.key, r.runs]), [['1 种样式', 2], ['2 种样式', 1]])
  assert.deepEqual([byStyles.total.overshoot, byStyles.total.misweave, byStyles.total.copiedRuns], [1, 1, 1])
  assert.match(formatSummary(byStyles).split('\n')[0], /^样式数\t轮数\t成功率\t虚报\t失败\t超时\t中止\t多做\t做错\t丢失\t复制\t打开织布机中位/)
  assert.deepEqual(summarize(records, { by: 'banners' }).rows.map((r) => [r.key, r.runs]), [['1 种底色', 3]])
  assert.deepEqual(summarize(records, { by: 'pattern' }).rows.map((r) => r.key).sort(), ['border+cross', 'creeper', 'cross'])
  assert.deepEqual(summarize(records, { by: 'color' }).rows.map((r) => [r.key, r.runs]).sort(), [['blue+red', 1], ['red', 2]])
  assert.deepEqual(summarize(records, { by: 'item' }).rows.map((r) => [r.key, r.runs]).sort(), [['不用图案物', 2], ['用图案物', 1]])
  assert.equal(summarize([{ target: 'x', outcome: 'success', materials: [], materialCount: 1, targetCount: 1 }]).loomer, false, 'stonecutter records are not loom records')
})

// ── 制图台训练场（docs/制图台训练场设计方案.md）──────────────────────────────

const cartoModule = await import('../src/training/cartography.js')

/** K5 的逐级做法：从 s₀ 开始，每一级先复制出要留下的、要锁的、要继续放大的，再锁一张、复制出其余锁定的，最后放大一张。返回用量和做出的地图 */
function simulatePlan(start, goals) {
  const want = (scale, locked) => goals.find((g) => g.scale === scale && g.locked === locked)?.want ?? 0
  const maxScale = Math.max(...goals.map((g) => g.scale))
  const used = { paper: 0, glass: 0, empty: 0 }
  const made = []
  for (let s = start; s <= maxScale; s++) {
    const u = want(s, false)
    const l = want(s, true)
    const carry = s < maxScale ? 1 : 0
    const copies = u + (l > 0 ? 1 : 0) + carry
    assert.ok(copies >= 1, `level ${s} has a map to work on`)
    used.empty += copies - 1
    for (let i = 0; i < u; i++) made.push({ scale: s, locked: false })
    if (l > 0) {
      used.glass++
      used.empty += l - 1
      for (let i = 0; i < l; i++) made.push({ scale: s, locked: true })
    }
    if (carry) {
      assert.ok(s < 4, 'zoom stays within scale 4')
      used.paper++
    }
  }
  return { used, goals: cartoModule.goalsFrom(made) }
}

test('cartography options: task (mix by default), scale 0–3, maps 1–3, copies 2–5, ops 1–4 only for chain, spare 0–3 (§5, K3–K5)', () => {
  const { cartographyOptions, parseOpsSpec, parseMapScaleSpec, parseMapsSpec, parseCopiesSpec } = cartoModule
  assert.deepEqual(cartographyOptions({}, {}), { task: 'mix', scale: { lo: 0, hi: 3 }, maps: { lo: 1, hi: 3 }, copies: { lo: 2, hi: 5 }, ops: { lo: 1, hi: 4 }, spare: { lo: 0, hi: 3 } })
  assert.equal(cartographyOptions({ task: 'zoom' }, { task: 'mix' }).task, 'zoom')
  assert.throws(() => cartographyOptions({ task: 'repair' }), /task 只能是 zoom \/ lock \/ clone \/ mix \/ chain/)
  assert.throws(() => cartographyOptions({ ops: '2' }), /ops 只用于 task=chain/)
  assert.throws(() => cartographyOptions({ task: 'chain', maps: '2' }), /maps \/ copies 不用于 task=chain/)
  assert.deepEqual(cartographyOptions({ task: 'chain', ops: '2' }).ops, { lo: 2, hi: 2 })
  assert.throws(() => parseOpsSpec('5'), /ops 要写 k 或 a-b（1–4/)
  assert.throws(() => parseMapScaleSpec('4'), /scale 要写 k 或 a-b（0–3/)
  assert.throws(() => parseMapsSpec('4'), /maps 要写 k 或 a-b（1–3/)
  assert.throws(() => parseCopiesSpec('1'), /copies 要写 k 或 a-b（2–5/)
  assert.deepEqual(parseCopiesSpec('3-5'), { lo: 3, hi: 5 })
})

test('cartography single tasks: mix draws the three evenly, never chain; zoom / lock work on part of a stack, clone makes 2–5; only the one material, plan + spare (K3, K4)', () => {
  const { sampleCartography, cartographyOptions, cartographyExpect, givenIds, mapKey, FILLED_MAP, PAPER, GLASS_PANE, EMPTY_MAP } = cartoModule
  const tally = { zoom: 0, lock: 0, clone: 0 }
  const options = cartographyOptions({})
  for (let seed = 0; seed < 3000; seed++) {
    const p = sampleCartography(seed, options)
    assert.ok(p.task in tally, p.task)
    tally[p.task]++
    assert.ok(p.start >= 0 && p.start <= 3)
    assert.equal(p.ops, undefined, 'only chain records the steps')
    const total = p.goals.reduce((n, g) => n + g.want, 0)
    const at = (scale, locked) => p.goals.find((g) => g.scale === scale && g.locked === locked)?.want ?? 0
    if (p.task === 'zoom') {
      assert.ok(p.count >= 1 && p.count <= 3)
      assert.equal(total, p.count)
      const [up] = p.goals.filter((g) => g.scale > p.start)
      assert.ok(up && !up.locked && up.scale <= 4 && up.want >= 1 && up.want <= p.count)
      assert.equal(at(p.start, false), p.count - up.want)
      assert.deepEqual(p.plan, { paper: up.want * (up.scale - p.start), glass: 0, empty: 0 })
      assert.equal(p.target, mapKey(up.scale, false))
    } else if (p.task === 'lock') {
      assert.ok(p.count >= 1 && p.count <= 3)
      assert.equal(total, p.count)
      const m = at(p.start, true)
      assert.ok(m >= 1 && m <= p.count)
      assert.equal(at(p.start, false), p.count - m)
      assert.deepEqual(p.plan, { paper: 0, glass: m, empty: 0 })
      assert.equal(p.target, mapKey(p.start, true))
    } else {
      assert.equal(p.count, 1)
      assert.deepEqual(p.goals.map((g) => [g.scale, g.locked]), [[p.start, false]])
      assert.ok(total >= 2 && total <= 5)
      assert.deepEqual(p.plan, { paper: 0, glass: 0, empty: total - 1 })
    }
    for (const k of ['paper', 'glass', 'empty']) {
      if (p.plan[k] === 0) assert.equal(p.given[k], 0, `${k} is not given when unused`)
      else assert.ok(p.given[k] - p.plan[k] >= 0 && p.given[k] - p.plan[k] <= 3, `${k} spare 0–3`)
    }
    const source = p.layout.filter((s) => s.id === FILLED_MAP)
    assert.deepEqual(source.map((s) => [s.count, s.map]), [[p.count, { scale: p.start }]], 'one stack of same maps')
    const sum = (id) => p.layout.filter((s) => s.id === id).reduce((n, s) => n + s.count, 0)
    assert.deepEqual([sum(PAPER), sum(GLASS_PANE), sum(EMPTY_MAP)], [p.given.paper, p.given.glass, p.given.empty])
    assert.equal(p.layout.length, 2, 'the stack and one material')
    assert.equal(new Set(p.layout.map((s) => s.slot)).size, 2)
    assert.deepEqual(cartographyExpect(p).cartography.allowed, givenIds(p))
  }
  for (const n of Object.values(tally)) assert.ok(n > 900 && n < 1100, JSON.stringify(tally))
  assert.equal(sampleCartography(1, cartographyOptions({ task: 'lock', maps: '3' })).count, 3)
  assert.deepEqual(sampleCartography(42, options), sampleCartography(42, options))
})

test('cartography chain: legal steps, at most 5 maps, minimal plan works, given = plan + spare only for used materials, reproducible (K5)', () => {
  const { sampleCartography, cartographyOptions, minimalPlan, kindsOf } = cartoModule
  const options = cartographyOptions({ task: 'chain' })
  const seenKinds = new Set()
  for (let seed = 0; seed < 3000; seed++) {
    const p = sampleCartography(seed, options)
    assert.equal(p.task, 'chain')
    assert.equal(p.count, 1)
    assert.ok(p.opCount >= 1 && p.opCount <= 4)
    const maps = [{ scale: p.start, locked: false }]
    for (const { op, from } of p.ops) {
      const i = maps.findIndex((m) => m.scale === from.scale && m.locked === from.locked)
      assert.ok(i >= 0, 'the step starts from an existing map')
      if (op === 'zoom') {
        assert.ok(!from.locked && from.scale < 4)
        maps[i] = { scale: from.scale + 1, locked: false }
      } else if (op === 'lock') {
        assert.ok(!from.locked)
        maps[i] = { scale: from.scale, locked: true }
      } else maps.push({ ...from })
    }
    assert.deepEqual(p.goals, cartoModule.goalsFrom(maps))
    assert.ok(p.goals.reduce((n, g) => n + g.want, 0) <= 5)
    assert.deepEqual(p.plan, minimalPlan(p.start, p.goals))
    const sim = simulatePlan(p.start, p.goals)
    assert.deepEqual(sim.used, p.plan)
    assert.deepEqual(sim.goals, p.goals)
    for (const k of ['paper', 'glass', 'empty']) {
      if (p.plan[k] === 0) assert.equal(p.given[k], 0)
      else assert.ok(p.given[k] - p.plan[k] >= 0 && p.given[k] - p.plan[k] <= 3)
    }
    assert.equal(p.kinds, kindsOf(p.start, p.goals))
    seenKinds.add(p.kinds)
  }
  assert.deepEqual([...seenKinds].sort(), ['clone', 'lock', 'lock+clone', 'zoom', 'zoom+clone', 'zoom+lock', 'zoom+lock+clone'])
  assert.deepEqual(sampleCartography(42, options), sampleCartography(42, options))
  assert.deepEqual(minimalPlan(0, [{ scale: 1, locked: false, want: 2 }]), { paper: 1, glass: 0, empty: 1 })
  assert.deepEqual(cartoModule.planFor('zoom', 0, [{ scale: 1, locked: false, want: 2 }]), { paper: 2, glass: 0, empty: 0 }, 'a zoom task has no empty maps to share the zoom')
})

test('cartography judge (chain): exact goals succeed with leftovers; unfinished, overshoot, mismap (foreign, dead end, new item), lost (conservation, dropped, station), copied (K8, K10)', () => {
  const { judgeCartography } = cartoModule
  // 0 级开局 1 张，要 1 张 0 级锁定、2 张 1 级未锁定；发 2 纸（余 1）、1 玻璃板、2 空地图
  const p = {
    task: 'chain', start: 0, count: 1, goals: [{ scale: 0, locked: true, want: 1 }, { scale: 1, locked: false, want: 2 }],
    plan: { paper: 1, glass: 1, empty: 2 }, given: { paper: 2, glass: 1, empty: 2 }, layout: []
  }
  const M = mc('filled_map')
  const L0 = `${M}#scale=0,locked`
  const S0 = `${M}#scale=0`
  const S1 = `${M}#scale=1`
  const base = { [L0]: 1, [S1]: 2, [mc('paper')]: 1 }
  const judge = (held, extra = {}) => judgeCartography({ taskState: 'done', picked: p, final: { held, carried: {}, tableInput: {}, dropped: {}, stationIntact: true, craftedDelta: { [M]: 0 }, ...extra } })
  const ok = judge(base)
  assert.deepEqual([ok.outcome, ok.reached, ok.copied, ok.madeOf, ok.extra, ok.unfinished], ['success', true, 0, { [L0]: 1, [S1]: 2 }, {}, {}])
  assert.equal(judge({ [L0]: 1, [S1]: 2 }, { tableInput: { [mc('paper')]: 1 } }).outcome, 'success', 'leftover paper in the table input is fine')
  assert.equal(judge({ [L0]: 1, [S1]: 1 }, { tableInput: { [S1]: 1, [mc('paper')]: 1 } }).outcome, 'false_success', 'goals must be in the inventory, not the table')
  const half = judge({ [L0]: 1, [S1]: 1, [S0]: 1, [mc('paper')]: 2 })
  assert.deepEqual([half.outcome, half.unfinished, half.extra], ['false_success', { [S0]: 1 }, {}])
  assert.equal(judge({ [S1]: 3, [mc('glass_pane')]: 1 }).outcome, 'overshoot')
  assert.equal(judge({ [L0]: 1, [S1]: 2, [S0]: 1, [mc('paper')]: 1 }).outcome, 'overshoot', 'one clone too many')
  const dead = judge({ [L0]: 1, [S1]: 1, [`${M}#scale=1,locked`]: 1 })
  assert.deepEqual([dead.outcome, dead.extra], ['mismap', { [`${M}#scale=1,locked`]: 1 }])
  assert.equal(judge({ [L0]: 1, [S1]: 1, [`${M}#scale=2`]: 1 }).outcome, 'mismap', 'zoomed past every goal')
  const foreign = judge({ [L0]: 1, [S1]: 1, [`${M}#foreign`]: 1, [mc('paper')]: 2 })
  assert.deepEqual([foreign.outcome, foreign.extra], ['mismap', { [`${M}#foreign`]: 1 }])
  assert.equal(judge({ ...base, [mc('stick')]: 1 }).outcome, 'mismap')
  assert.equal(judge({ [L0]: 1, [S1]: 1, [mc('paper')]: 1 }).outcome, 'lost')
  assert.equal(judge({ [L0]: 1, [S1]: 1, [mc('map')]: 1, [mc('paper')]: 1 }).outcome, 'false_success', 'an unused empty map keeps the count')
  assert.equal(judge(base, { dropped: { [mc('paper')]: 1 } }).outcome, 'lost')
  assert.equal(judge(base, { stationIntact: false }).outcome, 'lost')
  assert.deepEqual([judge(base, { craftedDelta: { [M]: 2 } }).outcome, judge(base, { craftedDelta: { [M]: 2 } }).copied], ['success', 2])
  assert.equal(judge({ [L0]: 1, [S1]: 1, [mc('paper')]: 1 }, { carried: { [S1]: 1 } }).outcome, 'false_success', 'a goal on the cursor is not reached')
  assert.equal(judgeCartography({ taskState: 'done', picked: p, final: { held: base, carried: {}, tableInput: {}, dropped: {} }, timedOut: true }).outcome, 'timeout')
  assert.equal(judgeCartography({ stopped: true, picked: p, final: null }).outcome, 'aborted')
})

test('cartography judge (single tasks): a whole stack done with Shift overshoots, zooming past the goal is mismap, a right-clicked map is mismap, conservation counts the start stack (K8)', () => {
  const { judgeCartography } = cartoModule
  const M = mc('filled_map')
  const judge = (picked, held, extra = {}) => judgeCartography({ taskState: 'done', picked, final: { held, carried: {}, tableInput: {}, dropped: {}, stationIntact: true, craftedDelta: { [M]: 0 }, ...extra } })
  // 锁定：3 张 1 级，锁 2 张；发 3 块玻璃板（余 1）
  const lock = { task: 'lock', start: 1, count: 3, goals: [{ scale: 1, locked: false, want: 1 }, { scale: 1, locked: true, want: 2 }], plan: { paper: 0, glass: 2, empty: 0 }, given: { paper: 0, glass: 3, empty: 0 } }
  assert.equal(judge(lock, { [`${M}#scale=1`]: 1, [`${M}#scale=1,locked`]: 2, [mc('glass_pane')]: 1 }).outcome, 'success')
  assert.equal(judge(lock, { [`${M}#scale=1,locked`]: 3 }).outcome, 'overshoot', 'Shift locked the whole stack')
  assert.equal(judge(lock, { [`${M}#scale=1`]: 2 }).outcome, 'lost', 'three maps were given')
  // 放大：2 张 0 级，1 张放大到 2 级；发 3 张纸（余 1）
  const zoom = { task: 'zoom', start: 0, count: 2, goals: [{ scale: 0, locked: false, want: 1 }, { scale: 2, locked: false, want: 1 }], plan: { paper: 2, glass: 0, empty: 0 }, given: { paper: 3, glass: 0, empty: 0 } }
  assert.equal(judge(zoom, { [`${M}#scale=0`]: 1, [`${M}#scale=2`]: 1, [mc('paper')]: 1 }).outcome, 'success')
  const half = judge(zoom, { [`${M}#scale=0`]: 1, [`${M}#scale=1`]: 1, [mc('paper')]: 2 })
  assert.deepEqual([half.outcome, half.unfinished], ['false_success', { [`${M}#scale=1`]: 1 }], 'one level short is unfinished')
  assert.equal(judge(zoom, { [`${M}#scale=0`]: 1, [`${M}#scale=3`]: 1 }).outcome, 'mismap', 'zoomed past the goal')
  assert.equal(judge(zoom, { [`${M}#scale=1`]: 2, [mc('paper')]: 1 }).outcome, 'false_success', 'both zoomed once: still reachable')
  assert.equal(judge(zoom, { [`${M}#scale=2`]: 2 }).outcome, 'overshoot', 'Shift zoomed both')
  // 复制：1 张 0 级做到 3 张；发 3 张空地图（余 1）
  const clone = { task: 'clone', start: 0, count: 1, goals: [{ scale: 0, locked: false, want: 3 }], plan: { paper: 0, glass: 0, empty: 2 }, given: { paper: 0, glass: 0, empty: 3 } }
  assert.equal(judge(clone, { [`${M}#scale=0`]: 3, [mc('map')]: 1 }).outcome, 'success')
  assert.equal(judge(clone, { [`${M}#scale=0`]: 4 }).outcome, 'overshoot')
  const right = judge(clone, { [`${M}#scale=0`]: 3, [`${M}#foreign`]: 1 })
  assert.deepEqual([right.outcome, right.extra], ['mismap', { [`${M}#foreign`]: 1 }])
})

/**
 * 制图台题的假世界：prepare 按参数发物品、回开局地图；任务结束时按 finalOf(params, world) 改状态
 * （缺省：每个目标恰好做出，辅料按最省用量用掉，余量留在物品栏）。题型从目标推：有锁定 → lock；总张数多于开局 → clone；否则 zoom。
 */
function cartographyHarness({ finalOf = null, aimOk = true, noMap = false } = {}) {
  const world = { params: null, state: {} }
  const defaultFinal = (params) => {
    const held = {}
    for (const g of params.items) if (g.id !== mc('filled_map')) held[g.id] = (held[g.id] ?? 0) + g.count
    const goals = params.expect.cartography.goals.map((g) => ({ scale: g.scale, locked: g.locked, want: g.count }))
    const source = params.items.find((g) => g.map)
    const total = goals.reduce((n, g) => n + g.want, 0)
    const task = goals.some((g) => g.locked) ? 'lock' : total > source.count ? 'clone' : 'zoom'
    const plan = cartoModule.planFor(task, source.map.scale, goals)
    held[mc('paper')] = (held[mc('paper')] ?? 0) - plan.paper
    held[mc('glass_pane')] = (held[mc('glass_pane')] ?? 0) - plan.glass
    held[mc('map')] = (held[mc('map')] ?? 0) - plan.empty
    for (const g of goals) held[cartoModule.mapKey(g.scale, g.locked)] = g.want
    return { held: Object.fromEntries(Object.entries(held).filter(([, n]) => n > 0)) }
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
    script, arenas: { cartography: { type: 'cartography', origin: [0, 100, 300], timeoutSec: 600, task: 'mix', scale: '0-3', maps: '1-3', copies: '2-5', ops: '1-4', spare: '0-3', exclude: [] } },
    prepareData: (params) => {
      world.params = params
      world.state = { held: {}, carried: {}, tableInput: {}, dropped: {}, containerOpen: false, stationIntact: true, openedAtMs: null, reachedAtMs: null, craftedDelta: { [mc('filled_map')]: 0 } }
      const start = params.items.find((g) => g.map)?.map.scale
      return { aimOk, station: 'cartography', ...(noMap ? {} : { map: { id: 7, scale: start, center: [8256, 300] } }) }
    },
    statusData: () => world.state
  })
  return { ...h, world }
}

test('cartography run: prepare carries the source stack, goals and watch; the text names states only; making them succeeds', async () => {
  const h = cartographyHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'cartography', runs: 6, seed: 5 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /task=mix，scale=0-3，maps=1-3，copies=2-5，spare=0-3/)
  await h.done()
  const records = h.records('cartography')
  assert.equal(records.length, 6)
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  for (const [i, record] of records.entries()) {
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.ok(['zoom', 'lock', 'clone'].includes(record.task))
    assert.equal(record.copied, 0)
    assert.equal(record.ops, undefined)
    assert.deepEqual(record.source, { scale: record.source.scale, count: record.source.count, mapId: 7, center: [8256, 300] })
    const prepare = prepares[i]
    assert.deepEqual([prepare.station, prepare.items, prepare.watch], ['cartography', record.layout, [mc('filled_map')]])
    assert.equal(prepare.items.find((g) => g.map).count, record.source.count)
    assert.deepEqual(prepare.expect.cartography.goals, record.goals.map((g) => ({ scale: g.scale, locked: g.locked, count: g.want })))
    for (const g of record.goals) assert.equal(g.made, g.want)
    assert.deepEqual(record.used, record.plan)
    const text = h.instructions[i]
    const maps = record.source.count === 1 ? '一张地图' : `${record.source.count} 张相同的地图`
    const it = record.source.count === 1 ? '它' : '它们'
    assert.ok(text.startsWith(`你正前方有一台制图台，视角已经对准它。你的物品栏里有${maps}（缩放等级 ${record.source.scale}，未锁定）。\n请把${it}做成：`), text)
    for (const g of record.goals) assert.ok(text.includes(`${g.want} 张缩放等级 ${g.scale}、${g.locked ? '已锁定' : '未锁定'}的地图`), text)
    assert.doesNotMatch(text, /纸|玻璃|空地图|paper|glass|右键|Shift|复制|放大|锁定后/, 'name the goal, not the materials or the moves')
  }
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/6 轮：会话 run-1，(放大|锁定|复制) \d×s\d → /)
  // chain 题照旧
  const c = cartographyHarness()
  assert.equal(c.trainer.start({ sessionId: 'console', arena: 'cartography', task: 'chain', ops: '2', seed: 3 }).ok, true)
  await c.done()
  const [chain] = c.records('cartography')
  assert.deepEqual([chain.task, chain.opCount, chain.outcome], ['chain', 2, 'success'])
})

test('cartography run: overshoot and option conflicts; a crosshair off the table or a missing source map stops the run', async () => {
  const over = cartographyHarness({
    finalOf: (params) => {
      const goals = params.expect.cartography.goals
      const top = goals[goals.length - 1]
      return { held: { [cartoModule.mapKey(top.scale, top.locked)]: goals.reduce((n, g) => n + g.count, 0) + 1 } }
    }
  })
  assert.equal(over.trainer.start({ sessionId: 'console', arena: 'cartography', task: 'clone', seed: 2 }).ok, true)
  await over.done()
  assert.equal(over.records('cartography')[0].outcome, 'overshoot')

  const h = cartographyHarness()
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'cartography', banners: '1' }).error, /不认这些选项：banners/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'cartography', ops: '2' }).error, /ops 只用于 task=chain/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'cartography', task: 'chain', copies: '3' }).error, /maps \/ copies 不用于 task=chain/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'cartography', task: 'equip' }).error, /task 只能是 zoom \/ lock \/ clone \/ mix \/ chain/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'cartography', scale: '4' }).error, /scale 要写 k 或 a-b（0–3/)
  const off = cartographyHarness({ aimOk: false })
  assert.equal(off.trainer.start({ sessionId: 'console', arena: 'cartography' }).ok, true)
  await off.done()
  assert.match(off.records('cartography')[0].error, /crosshair is not on the cartography table/)
  const noMap = cartographyHarness({ noMap: true })
  assert.equal(noMap.trainer.start({ sessionId: 'console', arena: 'cartography' }).ok, true)
  await noMap.done()
  assert.match(noMap.records('cartography')[0].error, /no source map/)
})

test('report: cartography records group by task / scale / spare / ops and count overshoot, mismap and copied runs', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (task, scale, outcome, extra = {}) => ({
    batch: 'b1', target: 'x', task, source: { scale, count: 1, mapId: 1, center: [0, 0] }, goals: [],
    plan: { paper: 1, glass: 0, empty: 0 }, given: { paper: 2, glass: 0, empty: 0 },
    outcome, copied: 0, openedMs: 1000, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false, stationIntact: true, ...extra
  })
  const records = [
    rec('zoom', 0, 'success'),
    rec('zoom', 1, 'mismap'),
    rec('clone', 0, 'overshoot', { copied: 2, plan: { paper: 0, glass: 0, empty: 2 }, given: { paper: 0, glass: 0, empty: 2 } }),
    rec('chain', 0, 'success', { opCount: 3, plan: { paper: 1, glass: 1, empty: 1 }, given: { paper: 1, glass: 2, empty: 1 } })
  ]
  const byTask = summarize(records, { by: 'task' })
  assert.equal(byTask.charter, true)
  assert.deepEqual(byTask.rows.map((r) => [r.key, r.runs]), [['放大', 2], ['复制', 1], ['连续操作', 1]])
  assert.deepEqual([byTask.total.overshoot, byTask.total.mismap, byTask.total.copiedRuns], [1, 1, 1])
  assert.match(formatSummary(byTask).split('\n')[0], /^题型\t轮数\t成功率\t虚报\t失败\t超时\t中止\t多做\t做错\t丢失\t复制\t打开制图台中位/)
  assert.deepEqual(summarize(records, { by: 'ops' }).rows.map((r) => [r.key, r.runs]).sort(), [['3 步', 1], ['（未记录）', 3]])
  assert.deepEqual(summarize(records, { by: 'scale' }).rows.map((r) => [r.key, r.runs]), [['开局 0 级', 3], ['开局 1 级', 1]])
  assert.deepEqual(summarize(records, { by: 'spare' }).rows.map((r) => [r.key, r.runs]).sort(), [['余量 空图0', 1], ['余量 纸0/玻璃1/空图0', 1], ['余量 纸1', 2]])
  assert.equal(summarize([{ target: 'x', outcome: 'success', banners: [], copied: 0 }]).charter, false, 'loom records are not cartography records')
})

// ── 酿造台训练场（docs/酿造台训练场设计方案.md）──────────────────────────────

const brewModule = await import('../src/training/brew.js')
const T400 = { time: 400 }
const BREWING = {
  fuel: [{ id: mc('blaze_powder'), charges: 20 }],
  containers: [{ id: mc('potion') }, { id: mc('splash_potion') }, { id: mc('lingering_potion') }],
  potionMixes: [
    { from: mc('water'), ingredient: mc('nether_wart'), to: mc('awkward'), ...T400 },
    { from: mc('water'), ingredient: mc('redstone'), to: mc('mundane'), ...T400 },
    { from: mc('awkward'), ingredient: mc('golden_carrot'), to: mc('night_vision'), ...T400 },
    { from: mc('night_vision'), ingredient: mc('redstone'), to: mc('long_night_vision'), ...T400 },
    { from: mc('awkward'), ingredient: mc('blaze_powder'), to: mc('strength'), ...T400 },
    { from: mc('awkward'), ingredient: mc('turtle_helmet'), to: mc('turtle_master'), ...T400 }
  ],
  containerMixes: [
    { from: mc('potion'), ingredient: mc('gunpowder'), to: mc('splash_potion'), ...T400 },
    { from: mc('splash_potion'), ingredient: mc('dragon_breath'), to: mc('lingering_potion'), ...T400 }
  ]
}
const BREW_PROPS = Object.fromEntries(['blaze_powder', 'nether_wart', 'redstone', 'golden_carrot', 'turtle_helmet', 'gunpowder', 'dragon_breath', 'glass_bottle']
  .map((id) => [mc(id), { maxStack: id === 'turtle_helmet' ? 1 : 64, ...(id === 'dragon_breath' ? { remainder: mc('glass_bottle') } : {}) }]))

test('brew options and tables: fuel / raw 1–64, bottles 1–3, n / m default 1-32; blaze powder as an ingredient is excluded; potion mixes × 3 bottles, container mixes × potions (P3, P4)', () => {
  const { brewOptions, brewTables, parseBottlesSpec } = brewModule
  assert.deepEqual(brewOptions({}, {}), { fuel: { lo: 32, hi: 64 }, raw: { lo: 32, hi: 64 }, bottles: { lo: 1, hi: 3 }, m: { lo: 1, hi: 32 }, n: { lo: 1, hi: 32 }, input: null })
  assert.deepEqual(brewOptions({ portions: '5', crafts: '2', input: 'redstone' }, { fuel: '10' }), { fuel: { lo: 10, hi: 10 }, raw: { lo: 32, hi: 64 }, bottles: { lo: 1, hi: 3 }, m: { lo: 2, hi: 2 }, n: { lo: 5, hi: 5 }, input: mc('redstone') })
  assert.throws(() => parseBottlesSpec('4'), /bottles 要写 k 或 a-b（1–3/)
  assert.throws(() => brewOptions({ fuel: '65' }), /fuel 要写 k 或 a-b（1–64/)
  const tables = brewTables(BREWING, BREW_PROPS)
  assert.deepEqual(tables.ingredients, [mc('dragon_breath'), mc('golden_carrot'), mc('gunpowder'), mc('nether_wart'), mc('redstone'), mc('turtle_helmet')])
  assert.equal(tables.fuel, mc('blaze_powder'))
  assert.equal(tables.byIngredient.get(mc('redstone')).length, 6, 'two mixes × three bottles')
  // 换瓶子配方 × 配方表里出现过的药水（water、mundane、awkward、night_vision、long_night_vision、strength、turtle_master）
  assert.equal(tables.byIngredient.get(mc('gunpowder')).length, 7)
  assert.deepEqual(tables.byIngredient.get(mc('gunpowder')).find((r) => r.from === mc('awkward')), { kind: 'container', bottle: mc('potion'), from: mc('awkward'), ingredient: mc('gunpowder'), to: mc('awkward'), input: `${mc('potion')}#${mc('awkward')}`, product: `${mc('splash_potion')}#${mc('awkward')}` })
  assert.equal(tables.stacks.get(mc('turtle_helmet')), 1)
  assert.equal(tables.remainders.get(mc('dragon_breath')), mc('glass_bottle'))
  const fewer = brewTables(BREWING, BREW_PROPS, { exclude: [mc('lingering_potion'), 'redstone'] })
  assert.ok(!fewer.ingredients.includes(mc('redstone')))
  assert.equal(fewer.byIngredient.get(mc('nether_wart')).length, 2, 'lingering bottles excluded')
  assert.throws(() => brewTables(BREWING, {}), /item-props\.json 里没有/)
})

test('brew sampler: ingredients drawn evenly (never blaze powder), turtle helmet only 1, m ≤ F, n ≤ R, p ≤ b, one stack each and one slot per bottle, reproducible (P3, P4)', () => {
  const { brewTables, brewOptions, sampleBrew, brewExpect } = brewModule
  const tables = brewTables(BREWING, BREW_PROPS)
  const options = brewOptions({})
  const tally = {}
  for (let seed = 0; seed < 3000; seed++) {
    const p = sampleBrew(tables, seed, options)
    tally[p.ingredient.id] = (tally[p.ingredient.id] ?? 0) + 1
    assert.notEqual(p.ingredient.id, mc('blaze_powder'))
    assert.ok(p.fuel.total >= 32 && p.fuel.total <= 64 && p.fuel.placed >= 1 && p.fuel.placed <= Math.min(32, p.fuel.total))
    if (p.ingredient.id === mc('turtle_helmet')) assert.deepEqual([p.ingredient.total, p.ingredient.placed], [1, 1])
    else assert.ok(p.ingredient.total >= 32 && p.ingredient.total <= 64)
    assert.ok(p.ingredient.placed >= 1 && p.ingredient.placed <= Math.min(32, p.ingredient.total))
    assert.ok(p.potion.total >= 1 && p.potion.total <= 3 && p.potion.placed >= 1 && p.potion.placed <= p.potion.total)
    assert.equal(p.potion.signature, `${p.potion.bottle}#${p.potion.potion}`)
    const sum = (id) => p.layout.filter((s) => s.id === id && !s.potion).reduce((n, s) => n + s.count, 0)
    assert.deepEqual([sum(p.fuel.id), sum(p.ingredient.id)], [p.fuel.total, p.ingredient.total])
    const bottles = p.layout.filter((s) => s.potion)
    assert.equal(bottles.length, p.potion.total)
    assert.ok(bottles.every((s) => s.count === 1 && s.id === p.potion.bottle && s.potion === p.potion.potion))
    assert.equal(p.layout.length, 2 + p.potion.total)
    assert.equal(new Set(p.layout.map((s) => s.slot)).size, p.layout.length)
    const expect = brewExpect(p).brew
    assert.deepEqual([expect.fuelLeft, expect.ingredientLeft, expect.potionLeft, expect.placed, expect.products], [p.fuel.total - p.fuel.placed, p.ingredient.total - p.ingredient.placed, p.potion.total - p.potion.placed, p.potion.placed, [p.product]])
  }
  for (const n of Object.values(tally)) assert.ok(n > 400 && n < 600, JSON.stringify(tally))
  assert.equal(Object.keys(tally).length, 6)
  assert.deepEqual(sampleBrew(tables, 42, options), sampleBrew(tables, 42, options))
  assert.equal(sampleBrew(tables, 7, brewOptions({ input: 'gunpowder' })).ingredient.id, mc('gunpowder'))
  assert.throws(() => sampleBrew(tables, 1, brewOptions({ input: 'blaze_powder' })), /没有材料 minecraft:blaze_powder/)
})

/** 酿造台题的固定一道：喷溅的粗制药水 + 龙息 → 滞留的粗制药水；发 40 烈焰粉放 5、20 龙息放 3、3 瓶放 2 */
function fixedBrew() {
  const pot = `${mc('splash_potion')}#${mc('awkward')}`
  const product = `${mc('lingering_potion')}#${mc('awkward')}`
  return {
    recipe: { kind: 'container', from: pot, ingredient: mc('dragon_breath'), to: product },
    fuel: { id: mc('blaze_powder'), total: 40, placed: 5 },
    ingredient: { id: mc('dragon_breath'), total: 20, placed: 3, remainder: mc('glass_bottle') },
    potion: { signature: pot, bottle: mc('splash_potion'), potion: mc('awkward'), total: 3, placed: 2 },
    product, layout: [], target: product
  }
}

test('brew judge: inventory-based success before and after brewing; open GUI, overflowed blaze powder, extra items, lost potions / ingredients, dragon-breath bottles, overshoot (P5, P6)', () => {
  const { judgeBrew } = brewModule
  const p = fixedBrew()
  const BP = mc('blaze_powder')
  const DB = mc('dragon_breath')
  const GB = mc('glass_bottle')
  const pot = p.potion.signature
  const prod = p.product
  const held = { [BP]: 35, [DB]: 17, [pot]: 1 }
  const placed = { potions: [pot, pot, null], ingredient: { [DB]: 3 }, fuel: { [BP]: 4 }, fuelCharges: 20, brewTicks: 300 }
  const judge = (extra = {}) => judgeBrew({ taskState: 'done', picked: p, final: { held, carried: {}, dropped: {}, stand: placed, containerOpen: false, brews: 0, stationIntact: true, ...extra } })
  const ok = judge()
  assert.deepEqual([ok.outcome, ok.reached, ok.account.put, ok.account.consumed], ['success', true, { fuel: 5, ingredient: 3, potions: 2 }, { fuel: 1, ingredient: 0 }])
  // 酿完一次：药水变成产物，龙息少 1、玻璃瓶掉在地上
  const brewed = judge({ stand: { ...placed, potions: [prod, prod, null], ingredient: { [DB]: 2 } }, dropped: { [GB]: 1 }, brews: 1 })
  assert.deepEqual([brewed.outcome, brewed.account.consumed.ingredient], ['success', 1])
  assert.equal(judge({ containerOpen: true }).outcome, 'false_success', 'the GUI must be closed')
  assert.equal(judge({ carried: { [BP]: 1 }, held: { ...held, [BP]: 34 } }).outcome, 'false_success', 'something on the cursor')
  const overflow = judge({ stand: { ...placed, ingredient: { [DB]: 3, [BP]: 2 } }, held: { ...held, [BP]: 33 } })
  assert.equal(overflow.outcome, 'misplaced')
  assert.match(overflow.account.wrongSlots.join(), /材料格：minecraft:blaze_powder/)
  assert.equal(judge({ held: { ...held, [mc('glowstone')]: 1 } }).outcome, 'misplaced', 'an item the round did not give')
  assert.equal(judge({ held: { [BP]: 35, [DB]: 17 } }).outcome, 'lost', 'a potion thrown out of the arena')
  assert.equal(judge({ held: { [BP]: 35, [DB]: 16, [pot]: 1 } }).outcome, 'lost', 'a dragon breath gone without a brew')
  assert.equal(judge({ dropped: { [BP]: 1 }, held: { ...held, [BP]: 34 } }).outcome, 'lost', 'something on the ground')
  assert.equal(judge({ stationIntact: false }).outcome, 'lost')
  assert.equal(judge({ stand: { ...placed, ingredient: { [DB]: 1 }, potions: [prod, prod, null] }, dropped: { [GB]: 2 }, brews: 2, held: { ...held } }).outcome, 'success', 'two brews used two (3 placed)')
  const p1 = { ...p, ingredient: { ...p.ingredient, placed: 1 } }
  const over = judgeBrew({ taskState: 'done', picked: p1, final: { held: { [BP]: 35, [DB]: 19, [pot]: 1 }, carried: {}, dropped: { [GB]: 1 }, stand: { ...placed, ingredient: { [DB]: 0 } , potions: [prod, prod, null] }, containerOpen: false, brews: 1, stationIntact: true } })
  assert.equal(over.outcome, 'success', 'one placed, one used')
  const over2 = judgeBrew({ taskState: 'done', picked: p1, final: { held: { [BP]: 35, [DB]: 17, [pot]: 1 }, carried: {}, dropped: { [GB]: 1 }, stand: { ...placed, ingredient: { [DB]: 1 }, potions: [prod, prod, null] }, containerOpen: false, brews: 2, stationIntact: true } })
  assert.equal(over2.outcome, 'overshoot', 'two used, one asked')
  assert.equal(judgeBrew({ taskState: 'done', picked: p, final: { held, carried: {}, dropped: {}, stand: placed, containerOpen: false, brews: 0 }, timedOut: true }).outcome, 'timeout')
  assert.equal(judgeBrew({ stopped: true, picked: p, final: null }).outcome, 'aborted')
  // 手动停止：照样判 aborted，但有最终状态就照常算放入量和放错（2026-11-23）
  const withExtra = { ...held, [mc('glowstone')]: 1 }
  assert.equal(judge({ held: withExtra }).outcome, 'misplaced')
  const stoppedBrew = judgeBrew({ stopped: true, taskState: 'failed', picked: p, final: { held: withExtra, carried: {}, dropped: {}, stand: placed, containerOpen: true, brews: 0, stationIntact: true } })
  assert.deepEqual([stoppedBrew.outcome, stoppedBrew.reached, stoppedBrew.account.put, stoppedBrew.account.extra], ['aborted', false, { fuel: 5, ingredient: 3, potions: 2 }, { [mc('glowstone')]: 1 }])
})

/**
 * 酿造台题的假世界：prepare 回服务器算出的产物；任务结束时按 finalOf(params) 改状态
 * （缺省：恰好放对、关掉界面，燃料格被吃掉 1 个，还没酿完）。
 */
function brewHarness({ finalOf = null, aimOk = true, product = null } = {}) {
  const world = { params: null, state: {} }
  const defaultFinal = (params) => {
    const e = params.expect.brew
    const given = (id) => params.items.filter((g) => g.id === id && !g.potion).reduce((n, g) => n + g.count, 0)
    const held = Object.fromEntries([[e.fuel, e.fuelLeft], [e.ingredient, e.ingredientLeft], [e.potion, e.potionLeft]].filter(([, n]) => n > 0))
    const fuelIn = given(e.fuel) - e.fuelLeft - 1
    return {
      held, containerOpen: false, brews: 0,
      stand: { potions: [...Array(e.placed).fill(e.potion), ...Array(3 - e.placed).fill(null)], ingredient: { [e.ingredient]: given(e.ingredient) - e.ingredientLeft }, fuel: fuelIn > 0 ? { [e.fuel]: fuelIn } : {}, fuelCharges: 20, brewTicks: 400 }
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
    script, brewing: BREWING, itemProps: BREW_PROPS,
    arenas: { brewing: { type: 'brew', origin: [0, 100, 330], timeoutSec: 600, fuel: '32-64', raw: '32-64', bottles: '1-3', m: '1-32', n: '1-32', exclude: [] } },
    prepareData: (params) => {
      world.params = params
      world.state = { held: {}, carried: {}, dropped: {}, stand: { potions: [null, null, null], ingredient: {}, fuel: {} }, containerOpen: false, brews: 0, stationIntact: true, openedAtMs: null, reachedAtMs: null }
      return { aimOk, station: 'brewing_stand', brew: { product: product ?? params.expect.brew.products[0] } }
    },
    statusData: () => world.state
  })
  return { ...h, world }
}

test('brew run: prepare carries potions and the expect; the text names fuel, ingredient and potion kind only; placing right and closing succeeds', async () => {
  const h = brewHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'brewing', runs: 4, seed: 5 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /fuel=32-64，raw=32-64，bottles=1-3，m=1-32，n=1-32；配方池 6 种材料/)
  await h.done()
  const records = h.records('brewing')
  assert.equal(records.length, 4)
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  for (const [i, record] of records.entries()) {
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.deepEqual(record.put, { fuel: record.fuel.placed, ingredient: record.ingredient.placed, potions: record.potion.placed })
    assert.deepEqual([record.consumed.fuel, record.brews], [1, 0])
    const prepare = prepares[i]
    assert.deepEqual([prepare.station, prepare.items], ['brewing_stand', record.layout])
    assert.equal(prepare.expect.brew.potion, record.potion.signature)
    const text = h.instructions[i]
    const potion = `${record.potion.bottle}（${record.potion.potion}）`
    assert.equal(text, `你正前方有一台酿造台（minecraft:brewing_stand），视角已经对准它。\n你的物品栏里有 ${record.fuel.id}、${record.ingredient.id} 和 ${record.potion.total} 瓶 ${potion}。请把 ${record.fuel.placed} 个 ${record.fuel.id} 放进它的燃料格，${record.ingredient.placed} 个 ${record.ingredient.id} 放进它的材料格，${record.potion.placed} 瓶 ${potion} 放进它的药水格，放好以后关掉它的界面。不要多放，也不要动其他物品。`)
    assert.doesNotMatch(text, /产物|右键|Shift|等/, 'no product, no moves')
  }
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/4 轮：会话 run-1，酿造台：放 \d+ 个 blaze_powder、/)
})

test('brew run: a product the server disagrees with or a crosshair off the stand stops the run; option conflicts', async () => {
  const stale = brewHarness({ product: `${mc('potion')}#${mc('thick')}` })
  assert.equal(stale.trainer.start({ sessionId: 'console', arena: 'brewing' }).ok, true)
  await stale.done()
  assert.match(stale.records('brewing')[0].error, /数据和服务器不一致.*npm run extract-item-props/)
  const off = brewHarness({ aimOk: false })
  assert.equal(off.trainer.start({ sessionId: 'console', arena: 'brewing' }).ok, true)
  await off.done()
  assert.match(off.records('brewing')[0].error, /crosshair is not on the brewing stand/)
  const h = brewHarness()
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'brewing', item: 'redstone' }).error, /酿造台场地用 input= 指定材料/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'brewing', fuelItem: 'coal' }).error, /不认这些选项：fuelItem/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'brewing', input: 'blaze_powder' }).error, /没有材料 minecraft:blaze_powder/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'brewing', bottles: '5' }).error, /bottles 要写 k 或 a-b（1–3/)
})

test('report: brew records group by ingredient / bottle / kind and count overshoot, misplaced and brewed runs', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (ingredient, bottle, kind, outcome, brews = 0) => ({
    batch: 'b1', target: 'x', recipe: { kind, from: 'a', ingredient: mc(ingredient), to: 'b' }, potion: { signature: `${mc(bottle)}#x`, bottle: mc(bottle), potion: 'x', total: 1, placed: 1 },
    brews, outcome, openedMs: 1000, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false, stationIntact: true
  })
  const records = [rec('redstone', 'potion', 'potion', 'success', 1), rec('redstone', 'splash_potion', 'potion', 'misplaced'), rec('gunpowder', 'potion', 'container', 'overshoot', 2)]
  const byIng = summarize(records, { by: 'ingredient' })
  assert.equal(byIng.brewer, true)
  assert.deepEqual(byIng.rows.map((r) => [r.key, r.runs]), [['redstone', 2], ['gunpowder', 1]])
  assert.deepEqual([byIng.total.overshoot, byIng.total.misplaced, byIng.total.brewedRuns], [1, 1, 2])
  assert.match(formatSummary(byIng).split('\n')[0], /^材料\t轮数\t成功率\t虚报\t失败\t超时\t中止\t放多\t放错\t丢失\t酿起来了\t打开酿造台中位/)
  assert.deepEqual(summarize(records, { by: 'bottle' }).rows.map((r) => [r.key, r.runs]), [['普通', 2], ['喷溅', 1]])
  assert.deepEqual(summarize(records, { by: 'kind' }).rows.map((r) => [r.key, r.runs]), [['药水配方', 2], ['换瓶子配方', 1]])
  assert.match(formatSummary(summarize(records, { by: 'kind' })).split('\n')[0], /^配方种类\t/)
  assert.equal(summarize([{ target: 'x', outcome: 'success', cookTicks: 200, station: 'furnace', fuel: { band: 300 } }]).brewer, false, 'furnace records are not brew records')
})

// ── 合成器训练场（docs/合成器训练场设计方案.md） ────────────────────────────────

const crafterModule = await import('../src/training/crafter.js')
const { crafterOptions, parseExtraSpec, sampleCrafter, canonicalLayout, crafterExpect, judgeCrafter, cellsOf } = crafterModule
const CRAFTER_RECIPES = [
  ...RECIPES,
  { name: 'cake', result: 'minecraft:cake', count: 1, type: 'shaped', pattern: ['AAA', 'BEB', 'CCC'], key: { A: ['minecraft:milk_bucket'], B: ['minecraft:sugar'], E: ['minecraft:egg'], C: ['minecraft:wheat'] } },
  { name: 'pumpkin_pie', result: 'minecraft:pumpkin_pie', count: 1, type: 'shapeless', ingredients: [['minecraft:pumpkin'], ['minecraft:sugar'], ['minecraft:egg']] }
]
const CRAFTER_PROPS = {
  ...ITEM_PROPS,
  ...Object.fromEntries(['milk_bucket', 'sugar', 'egg', 'wheat', 'pumpkin'].map((id) => [mc(id), { maxStack: id === 'milk_bucket' ? 1 : id === 'egg' ? 16 : 64 }]))
}
const CRAFTER_ARENA = { crafter: { type: 'crafter', origin: [0, 100, 360], timeoutSec: 900, portions: '1-16', extra: '0-16', exclude: [] } }

test('crafter options and sampler: all recipes incl. 2×2 and 1-cell, n capped by the smallest stack, extra per material capped by its own stack, totals conserved, reproducible (R3, R4)', () => {
  assert.deepEqual(crafterOptions({}, {}), { portions: { lo: 1, hi: 16 }, extra: { lo: 0, hi: 16 }, item: null })
  assert.deepEqual(crafterOptions({ portions: '3', extra: '0' }, { portions: '1-16' }).portions, { lo: 3, hi: 3 })
  assert.deepEqual(parseExtraSpec('0-64'), { lo: 0, hi: 64 })
  assert.throws(() => parseExtraSpec('65'), /extra 要写 k 或 a-b（0–64/)
  assert.throws(() => crafterOptions({ portions: '0' }), /n 要写 k 或 a-b（1–64/)
  const pool = candidates(CRAFTER_RECIPES, [], 3, { all: true })
  assert.equal(pool.length, CRAFTER_RECIPES.length, 'small recipes stay in the pool')
  assert.deepEqual(candidates(CRAFTER_RECIPES, [], 3).map((r) => r.name), ['oak_boat', 'cake'], 'craft3x3 pool unchanged')
  assert.deepEqual([cellsOf(RECIPES[1]), cellsOf(RECIPES[4]), cellsOf(CRAFTER_RECIPES[5])], [1, 5, 9])

  const options = crafterOptions({}, {})
  const a = sampleCrafter(pool, CRAFTER_PROPS, 11, options)
  assert.deepEqual(sampleCrafter(pool, CRAFTER_PROPS, 11, options), a, 'same seed, same run')
  const shapes = new Set()
  for (let seed = 0; seed < 300; seed++) {
    const p = sampleCrafter(pool, CRAFTER_PROPS, seed, options)
    shapes.add(p.shape)
    const cap = Math.min(...p.materials.map((m) => CRAFTER_PROPS[m.id].maxStack))
    assert.ok(p.portions >= 1 && p.portions <= Math.min(16, cap), `n ≤ stack cap (${p.recipe})`)
    assert.equal(p.layout.filter(Boolean).length, p.cells)
    for (const m of p.materials) {
      assert.ok(m.extra >= 0 && m.extra <= Math.min(16, CRAFTER_PROPS[m.id].maxStack))
      assert.equal(m.total, m.count * p.portions + m.extra)
      assert.equal(p.slots.filter((s) => s.id === m.id).reduce((n, s) => n + s.count, 0), m.total)
      assert.equal(p.held[m.id] ?? 0, m.extra)
    }
    assert.ok(p.slots.every((s) => s.count <= CRAFTER_PROPS[s.id].maxStack && s.slot >= 0 && s.slot <= 35))
    assert.equal(new Set(p.slots.map((s) => s.slot)).size, p.slots.length)
  }
  assert.equal(shapes.size, new Set(pool.map(shapeOf)).size, 'every shape comes up')

  const cake = sampleCrafter(pool, CRAFTER_PROPS, 3, { ...options, item: 'minecraft:cake' })
  assert.equal(cake.portions, 1, 'milk buckets do not stack')
  assert.deepEqual(cake.layout, [mc('milk_bucket'), mc('milk_bucket'), mc('milk_bucket'), mc('sugar'), mc('egg'), mc('sugar'), mc('wheat'), mc('wheat'), mc('wheat')])
  assert.ok(cake.extra[mc('milk_bucket')] <= 1)
  assert.throws(() => sampleCrafter(pool, CRAFTER_PROPS, 3, { ...options, portions: { lo: 2, hi: 4 }, item: 'minecraft:cake' }), /n=2 放不下.*最多堆 1 个/)
  assert.throws(() => sampleCrafter(pool, CRAFTER_PROPS, 3, { ...options, item: 'minecraft:diamond' }), /没有合成 minecraft:diamond/)
  // 规范摆法：有序配方放左上角（空格照留），无序配方从 0 号格往后
  const shears = sampleCrafter(pool, CRAFTER_PROPS, 1, { ...options, item: 'minecraft:shears' })
  assert.deepEqual(shears.layout, [null, mc('iron_ingot'), null, mc('iron_ingot'), null, null, null, null, null])
  const pie = sampleCrafter(pool, CRAFTER_PROPS, 1, { ...options, item: 'minecraft:pumpkin_pie' })
  assert.deepEqual(pie.layout, [mc('pumpkin'), mc('sugar'), mc('egg'), null, null, null, null, null, null])
  assert.ok(pie.portions <= 16, 'eggs stack to 16')
  assert.deepEqual(crafterExpect(pie), { crafter: { target: mc('pumpkin_pie'), portions: pie.portions, held: pie.held, layout: pie.layout } })
  assert.equal(canonicalLayout(RECIPES[0], new Map([['#A', 'x']])).length, 9)
})

/** 合成器题的最终状态：layout 摆进合成器（每格 n 个，可整体平移 shift 格），空格禁用，物品栏剩余量 */
function crafterFinal(p, { shift = 0, disabled = null, counts = null, held = p.held, open = false, carried = {}, dropped = {}, result = p.target, intact = true } = {}) {
  const grid = new Array(9).fill(null)
  p.layout.forEach((id, i) => { if (id) grid[i + shift] = { id, count: counts?.[i] ?? p.portions } })
  return {
    held, carried, dropped, containerOpen: open, stationIntact: intact,
    crafter: { grid, disabled: disabled ?? grid.map((c, i) => (c ? null : i)).filter((i) => i !== null), result, powered: false }
  }
}

test('crafter judge: any position the server matches succeeds; faults for wrong product, uneven counts, unlocked cells, leftovers, open GUI, foreign items; lost on drops, broken crafter, missing materials (R5–R7)', () => {
  const pool = candidates(CRAFTER_RECIPES, [], 3, { all: true })
  const p = sampleCrafter(pool, CRAFTER_PROPS, 1, { ...crafterOptions({ portions: '4', extra: '2' }), item: 'minecraft:shears' })
  const judgeOf = (final, extra = {}) => judgeCrafter({ stopped: false, timedOut: false, taskState: 'done', final, picked: p, ...extra })
  assert.deepEqual(p.held, { [mc('iron_ingot')]: 2 })
  assert.equal(judgeOf(crafterFinal(p)).outcome, 'success')
  assert.equal(judgeOf(crafterFinal(p, { shift: 4 })).outcome, 'success', 'shifted layout: judged by the server result')

  const faultsOf = (final) => judgeOf(final).account.faults
  assert.deepEqual([judgeOf(crafterFinal(p, { result: null })).outcome, faultsOf(crafterFinal(p, { result: null }))], ['false_success', ['recipe']])
  // 一格多放 1 个：物品栏少 1 个
  assert.deepEqual(faultsOf(crafterFinal(p, { counts: { 1: 5 }, held: { [mc('iron_ingot')]: 1 } })), ['count', 'leftover'])
  assert.deepEqual(faultsOf(crafterFinal(p, { disabled: [0, 2, 4, 5, 6, 7] })), ['unlocked'])
  assert.deepEqual(faultsOf(crafterFinal(p, { open: true })), ['open'])
  assert.deepEqual(faultsOf(crafterFinal(p, { held: {}, carried: { [mc('iron_ingot')]: 2 } })), ['leftover', 'open'])
  assert.equal(judgeOf(crafterFinal(p), { taskState: 'failed' }).outcome, 'failed')
  assert.equal(judgeOf(crafterFinal(p), { timedOut: true }).outcome, 'timeout')
  assert.equal(judgeOf(crafterFinal(p), { stopped: true }).outcome, 'aborted')
  // 手动停止：照样判 aborted，但有最终状态就照常算失败原因（2026-11-23）
  const stopped = judgeOf(crafterFinal(p, { result: null, open: true }), { stopped: true, taskState: 'failed' })
  assert.deepEqual([stopped.outcome, stopped.account.faults], ['aborted', ['recipe', 'open']])
  assert.equal(judgeOf(crafterFinal(p, { intact: false }), { stopped: true }).outcome, 'aborted', 'stopping beats lost')

  assert.equal(judgeOf(crafterFinal(p, { held: { [mc('iron_ingot')]: 1 }, dropped: { [mc('iron_ingot')]: 1 } })).outcome, 'lost', 'something on the floor')
  assert.equal(judgeOf(crafterFinal(p, { held: { [mc('iron_ingot')]: 1 } })).outcome, 'lost', 'one thrown out of the arena')
  assert.equal(judgeOf(crafterFinal(p, { intact: false })).outcome, 'lost')
  assert.equal(judgeOf({ ...crafterFinal(p), crafter: null }).outcome, 'lost', 'no crafter any more')
  // 物品栏 2×2 里做了别的东西：材料少了不算丢失，记 foreign
  const shearsMade = judgeOf(crafterFinal(p, { held: { [mc('shears')]: 1 } }))
  assert.equal(shearsMade.outcome, 'false_success')
  assert.deepEqual([shearsMade.account.faults, shearsMade.account.foreign], [['leftover', 'foreign'], { [mc('shears')]: 1 }])
  assert.equal(judgeCrafter({ stopped: false, timedOut: true, taskState: 'failed', final: null, picked: p }).outcome, 'timeout')
})

function crafterHarness({ aimOk = true, product = null, finalOf = null } = {}) {
  const world = { params: null, state: null }
  const script = ({ req, executor, clock, setBusy }) => setImmediate(async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    await tick()
    req.closed = true
    req.answered = true
    executor.task = { taskId: req.taskId, state: 'running' }
    executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
    for (let i = 0; i < 3; i++) await tick()
    const e = world.params.expect.crafter
    const picked = { layout: e.layout, portions: e.portions, held: e.held, target: e.target }
    Object.assign(world.state, { openedAtMs: clock() - 1, reachedAtMs: clock() }, (finalOf ?? crafterFinal)(picked))
    for (let i = 0; i < 3; i++) await tick()
    executor.task.state = 'done'
    setBusy(2)
    executor.emit('task', { taskId: req.taskId, state: 'done', version: 2 })
  })
  const h = harness({
    script, recipes: CRAFTER_RECIPES, itemProps: CRAFTER_PROPS, arenas: CRAFTER_ARENA,
    prepareData: (params) => {
      world.params = params
      world.state = { held: {}, carried: {}, dropped: {}, crafter: { grid: new Array(9).fill(null), disabled: [], result: null, powered: false }, containerOpen: false, stationIntact: true, openedAtMs: null, reachedAtMs: null }
      return { aimOk, station: 'crafter', given: params.items, crafter: { product: product ?? params.expect.crafter.target } }
    },
    statusData: () => world.state
  })
  return { ...h, world }
}

test('crafter run: prepare carries the layout expect; the text names target and n only; placing right and closing succeeds', async () => {
  const h = crafterHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'crafter', runs: 4, seed: 5 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /n=1-16，extra=0-16；配方池 7 条配方、\d+ 种形状/)
  await h.done()
  const records = h.records('crafter')
  assert.equal(records.length, 4)
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  for (const [i, record] of records.entries()) {
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.deepEqual(record.faults, [])
    assert.equal(record.cells, prepares[i].expect.crafter.layout.filter(Boolean).length)
    assert.deepEqual([prepares[i].station, prepares[i].items], ['crafter', record.slots])
    assert.equal(prepares[i].expect.crafter.target, record.target)
    assert.equal(typeof record.reachedMs, 'number')
    const text = h.instructions[i]
    assert.equal(text, `你正前方有一台合成器（minecraft:crafter），视角已经对准它。你的物品栏里有合成 ${record.target} 的材料。\n请把材料放进合成器的合成格，让它合成出 ${record.target}，并且材料正好够它合成 ${record.portions} 次，没放材料的格子全部禁用。放好以后关掉它的界面。用不完的材料留在物品栏里，不要动其他物品。`)
    assert.doesNotMatch(text, /右键|点击|每个放了材料的格子|上锁/, 'no moves, no per-cell count')
  }
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/4 轮：会话 run-1，合成器：\w+ ×\d+ 次（配方 \w+，占 \d 格，seed=/)
})

test('crafter run: a product the server disagrees with or a crosshair off the crafter stops the run; option checks', async () => {
  const stale = crafterHarness({ product: mc('stick') })
  assert.equal(stale.trainer.start({ sessionId: 'console', arena: 'crafter', item: 'oak_boat' }).ok, true)
  await stale.done()
  assert.match(stale.records('crafter')[0].error, /数据和服务器不一致.*npm run extract-recipes.*oak_boat 加进 exclude/)
  const off = crafterHarness({ aimOk: false })
  assert.equal(off.trainer.start({ sessionId: 'console', arena: 'crafter' }).ok, true)
  await off.done()
  assert.match(off.records('crafter')[0].error, /crosshair is not on the crafter/)
  const h = crafterHarness()
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'crafter', crafts: '2' }).error, /不认这些选项：m/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'crafter', item: 'diamond' }).error, /没有合成 minecraft:diamond/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'crafter', item: 'cake', portions: '2' }).error, /n=2 放不下/)
  assert.equal(parseTrainArgs(['crafter', 'n=2-4', 'extra=0']).extra, '0')
  assert.match(parseTrainArgs(['crafter', 'extra=70']).error, /extra 要写 k 或 a-b（0–64/)
})

test('crafter config: defaults, validation and the report (cells grouping, fault columns)', async () => {
  const config = normalizeConfig({})
  assert.deepEqual(config.training.arenas.crafter, { type: 'crafter', origin: [10000, 120, 10360], timeoutSec: 900, portions: '1-16', extra: '0-16', exclude: [] })
  assert.deepEqual(normalizeConfig({ training: { arenas: { mine: { type: 'crafter', origin: [0, 0, 0], exclude: [] } } } }).training.arenas.mine.extra, '0-16')
  assert.throws(() => normalizeConfig({ training: { arenas: { crafter: { type: 'crafter', origin: [0, 0, 0], extra: '99', exclude: [] } } } }), /training\.arenas\.crafter\.extra 要写/)

  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (cells, outcome, faults = []) => ({ batch: 'b1', target: 'x', shape: 'AA', cells, portions: 2, faults, outcome, openedMs: 1000, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false, stationIntact: true })
  const records = [rec(4, 'success'), rec(4, 'false_success', ['unlocked']), rec(1, 'false_success', ['count', 'leftover'])]
  const byCells = summarize(records, { by: 'cells' })
  assert.equal(byCells.crafterer, true)
  assert.deepEqual(byCells.rows.map((r) => [r.key, r.runs]), [['4 格', 2], ['1 格', 1]])
  assert.deepEqual(byCells.total.faults, { recipe: 0, count: 1, unlocked: 1, leftover: 1, open: 0, foreign: 0 })
  assert.match(formatSummary(byCells).split('\n')[0], /^配方格数\t轮数\t成功率\t虚报\t失败\t超时\t中止\t丢失\t产物不对\t份数不对\t空格没禁用\t物品栏剩余不对\t没关界面\t出现别的物品\t打开合成器中位/)
  assert.deepEqual(summarize(records, { by: 'portions' }).rows.map((r) => r.key), ['n=2'])
  assert.equal(summarize([{ target: 'x', outcome: 'success', shape: 'AA', portions: 1, crafts: 1 }]).crafterer, false, 'craft records are not crafter records')
})

// ── 村民交易训练场（docs/村民交易训练场设计方案.md） ─────────────────────
const tradeModule = await import('../src/training/trade.js')
const { tradeOptions, sampleVillager, describeOffers, maxTimes, pickTrades, targetUses, tradeExpect, judgeTrade, doomedReason, PROFESSIONS } = tradeModule
const { rng: tradeRng } = await import('../src/training/sampler.js')

const cost = (id, count, maxStack = 64) => ({ id: mc(id), count, maxStack })
const result = (id, count, { maxStack = 64, components = false, enchantments = {} } = {}) => ({ id: mc(id), count, maxStack, components, enchantments, name: id })
/** 一只假村民的交易项（形状同 arena/trade-preview 的 offers） */
function fakeOffers(offerSeed = 0) {
  return [
    { costA: cost('wheat', 20), costB: null, result: result('emerald', 1), maxUses: 16 },
    { costA: cost('emerald', 1), costB: null, result: result('bread', 6), maxUses: 16 },
    { costA: cost('emerald', 1), costB: null, result: result('apple', 4), maxUses: 16 },
    { costA: cost('emerald', 24), costB: cost('book', 1), result: result('enchanted_book', 1, { maxStack: 1, components: true, enchantments: { [mc('sharpness')]: 3 } }), maxUses: 12 },
    { costA: cost('emerald', 24), costB: cost('book', 1), result: result('enchanted_book', 1, { maxStack: 1, components: true, enchantments: { [mc('efficiency')]: 2 } }), maxUses: 12 },
    { costA: cost('emerald', 3), costB: null, result: result('iron_sword', 1, { maxStack: 1, components: true }), maxUses: 3 }
  ].map((o, index) => ({ index, level: 1 + (index >> 1), uses: 0, xp: 1, ...o, encoded: `offer-${index}-${offerSeed}` }))
}
const ARENAS_TRADE = { villager: { type: 'trade', origin: [0, 100, 390], timeoutSec: 900, level: '1-5', tasks: '1-4', portions: '1-64', extra: '0-16', exclude: { professions: [], items: [] } } }

/** 按交易次数算出的最终状态：物品栏 = 发放 − 消耗 + 产物（V6 的守恒） */
function tradeFinal(offers, given, uses, { open = false, carried = {}, dropped = {}, payment = {}, move = {}, villager = true, intact = true } = {}) {
  const held = { ...given }
  offers.forEach((o, i) => {
    for (const c of [o.costA, ...(o.costB ? [o.costB] : [])]) held[c.id] = (held[c.id] ?? 0) - (uses[i] ?? 0) * c.count
    held[o.result.id] = (held[o.result.id] ?? 0) + (uses[i] ?? 0) * o.result.count
  })
  for (const [id, n] of Object.entries(move)) held[id] -= n
  for (const id of Object.keys(held)) if (held[id] <= 0) delete held[id]
  return { held, carried, dropped, payment, containerOpen: open, stationIntact: intact, villager: villager ? { uuid: 'u', profession: mc('farmer'), level: 3, uses, trading: open } : null }
}

test('trade options: level 1–5, tasks 1–4, n, extra, profession and exclude (§5)', () => {
  const o = tradeOptions({}, {})
  assert.deepEqual([o.level, o.tasks, o.portions, o.extra, o.profession, o.item], [{ lo: 1, hi: 5 }, { lo: 1, hi: 4 }, { lo: 1, hi: 64 }, { lo: 0, hi: 16 }, null, null])
  assert.equal(o.professions.length, 13)
  assert.ok(!PROFESSIONS.includes(mc('nitwit')) && !PROFESSIONS.includes(mc('none')))
  assert.equal(tradeOptions({ profession: 'librarian' }).profession, mc('librarian'))
  assert.throws(() => tradeOptions({ profession: 'nitwit' }), /profession 要写有交易的职业/)
  assert.throws(() => tradeOptions({ level: '6' }), /level 要写 k 或 a-b（1–5/)
  assert.throws(() => tradeOptions({ tasks: '5' }), /tasks 要写 k 或 a-b（1–4/)
  assert.deepEqual(tradeOptions({}, { exclude: { professions: ['farmer'] } }).professions.includes(mc('farmer')), false)
  assert.throws(() => tradeOptions({}, { exclude: { professions: PROFESSIONS } }), /职业池是空的/)
  assert.ok(tradeOptions({}, { exclude: { items: ['bread'] } }).excludeItems.has(mc('bread')))
  // 抽村民：同一种子同一只；level 限定在范围里
  const a = sampleVillager(7, tradeOptions({ level: '2-3' }))
  const b = sampleVillager(7, tradeOptions({ level: '2-3' }))
  assert.deepEqual([a.profession, a.level, a.type], [b.profession, b.level, b.type])
  assert.ok(a.level >= 2 && a.level <= 3)
  assert.equal(parseTrainArgs(['villager', 'profession=minecraft:cleric', 'level=5', 'tasks=2', 'n=1-3', 'extra=0']).profession, 'minecraft:cleric')
  assert.equal(parseTrainArgs(['villager', 'level=5']).level, '5')
  assert.match(parseTrainArgs(['villager', 'profession=Bad Name']).error, /profession 不像职业 id/)
})

test('trade descriptions: by content; identical trades get their enchantments, still identical → not choosable (V4, V9)', () => {
  const offers = fakeOffers()
  const texts = describeOffers(offers)
  assert.equal(texts[0], `用 ${mc('wheat')} × 20 换 ${mc('emerald')} × 1`)
  assert.equal(texts[3], `用 ${mc('emerald')} × 24 和 ${mc('book')} × 1 换 ${mc('enchanted_book')} × 1（附魔：${mc('sharpness')} 3）`)
  assert.equal(texts[5], `用 ${mc('emerald')} × 3 换 ${mc('iron_sword')} × 1`, 'unique without enchantments')
  const twins = [...offers.slice(0, 2), { ...offers[1], index: 2 }]
  assert.deepEqual(describeOffers(twins).slice(1), [null, null])
  // V5 的次数上限：交易次数、付款物 4 格、产物 9 格
  assert.deepEqual(offers.map(maxTimes), [12, 16, 16, 9, 9, 3])
})

test('trade picking: k trades, n1 within n0, payments merged with extra, ≤36 slots in all, held by conservation, reproducible (V4, V5)', () => {
  const offers = fakeOffers()
  const options = tradeOptions({}, {})
  for (let seed = 0; seed < 300; seed++) {
    const p = pickTrades(offers, tradeRng(seed), options)
    assert.ok(p, `seed ${seed}`)
    assert.ok(p.k >= 1 && p.k <= p.kWanted && p.kWanted <= 4)
    assert.equal(new Set(p.trades.map((t) => t.index)).size, p.k)
    for (const t of p.trades) assert.ok(t.n1 >= 1 && t.n1 <= t.n0 && t.n0 === maxTimes(offers[t.index]), JSON.stringify(t))
    // 每种付款物：发放 = need + e，e 不超过 max(16, 2 × 最高单价)，不超过 4 格 × 用到它的笔数
    for (const item of p.items) {
      const users = p.trades.filter((t) => t.costA.id === item.id || t.costB?.id === item.id)
      const need = users.reduce((n, t) => n + t.n1 * (t.costA.id === item.id ? t.costA.count : t.costB.count), 0)
      const top = Math.max(...users.map((t) => (t.costA.id === item.id ? t.costA.count : t.costB.count)))
      assert.equal(item.total, need + item.extra)
      assert.ok(item.extra >= 0 && item.extra <= Math.max(16, 2 * top) && Math.ceil(item.total / 64) <= 4 * users.length)
    }
    assert.ok(p.slots.length + p.productSlots <= 36, 'payments and products fit')
    assert.equal(new Set(p.slots.map((s) => s.slot)).size, p.slots.length)
    const given = Object.fromEntries(p.items.map((i) => [i.id, i.total]))
    assert.deepEqual(p.held, tradeFinal(offers, given, targetUses(offers, p.trades)).held)
    assert.equal(p.hasUnstackable, p.trades.some((t) => t.result.maxStack === 1))
  }
  assert.deepEqual(pickTrades(offers, tradeRng(9), options), pickTrades(offers, tradeRng(9), options))
  // 串联：产物是另一笔的付款物（卖小麦换绿宝石 + 用绿宝石买面包）也照常出
  assert.ok(Array.from({ length: 200 }, (_, s) => pickTrades(offers, tradeRng(s), options)).some((p) => p.hasChain))
  // item= 固定一笔的产物；没有这样的交易 → null；n 的下限超过 n0 的交易不选
  for (let s = 0; s < 50; s++) assert.equal(pickTrades(offers, tradeRng(s), tradeOptions({ item: 'bread' })).trades[0].result.id, mc('bread'))
  assert.equal(pickTrades(offers, tradeRng(1), tradeOptions({ item: 'diamond' })), null)
  for (let s = 0; s < 50; s++) assert.ok(pickTrades(offers, tradeRng(s), tradeOptions({ portions: '10-64' })).trades.every((t) => t.n0 >= 10 && t.n1 >= 10))
  assert.equal(pickTrades(offers, tradeRng(1), tradeOptions({ portions: '17' })), null)
  assert.deepEqual(tradeExpect({ uses: [0, 2], held: { a: 1 } }), { trade: { uses: [0, 2], held: { a: 1 } } })
})

test('trade judge: uses decide; short / over / wrong / open; drops and missing items are lost; stopped keeps faults (V6, V8)', () => {
  const offers = fakeOffers()
  const picked = { offers, trades: [{ index: 1, n1: 3 }, { index: 3, n1: 1 }], given: { [mc('emerald')]: 40, [mc('book')]: 2 } }
  picked.uses = targetUses(offers, picked.trades)
  const judgeOf = (final, o = {}) => judgeTrade({ stopped: false, timedOut: false, taskState: 'done', final, picked, ...o })
  const at = (uses, o) => tradeFinal(offers, picked.given, uses, o)
  assert.deepEqual([judgeOf(at(picked.uses)).outcome, judgeOf(at(picked.uses)).reached], ['success', true])
  const short = judgeOf(at([0, 2, 0, 1, 0, 0]))
  assert.deepEqual([short.outcome, short.account.faults], ['false_success', ['short']])
  const over = judgeOf(at([0, 4, 0, 1, 0, 0]))
  assert.deepEqual([over.outcome, over.account.faults], ['overshoot', ['over']])
  const wrong = judgeOf(at([0, 3, 1, 1, 0, 0]))
  assert.deepEqual([wrong.outcome, wrong.account.faults], ['mistrade', ['wrong']])
  assert.deepEqual(judgeOf(at(picked.uses, { open: true })).account.faults, ['open'])
  // 界面开着时支付格里的东西也算在内（守恒），carried 有东西记 open
  const inPayment = at(picked.uses, { open: true, move: { [mc('emerald')]: 5 }, payment: { [mc('emerald')]: 5 } })
  assert.deepEqual([judgeOf(inPayment).outcome, judgeOf(inPayment).account.faults], ['false_success', ['open']])
  assert.equal(judgeOf(at(picked.uses, { move: { [mc('book')]: 1 }, dropped: { [mc('book')]: 1 } })).outcome, 'lost', 'on the floor')
  assert.equal(judgeOf(at(picked.uses, { move: { [mc('book')]: 1 } })).outcome, 'lost', 'thrown out of the arena')
  assert.equal(judgeOf(at(picked.uses, { villager: false })).outcome, 'lost', 'no villager')
  assert.equal(judgeOf(at(picked.uses, { intact: false })).outcome, 'lost')
  assert.equal(judgeOf(at([0, 4, 0, 1, 0, 0]), { timedOut: true }).outcome, 'overshoot', 'over beats timeout')
  assert.equal(judgeOf(at([0, 2, 0, 1, 0, 0]), { timedOut: true, taskState: 'failed' }).outcome, 'timeout')
  assert.equal(judgeOf(at([0, 2, 0, 1, 0, 0]), { taskState: 'failed' }).outcome, 'failed')
  const stopped = judgeOf(at([0, 2, 0, 1, 0, 0], { open: true }), { stopped: true, taskState: 'failed' })
  assert.deepEqual([stopped.outcome, stopped.account.faults], ['aborted', ['short', 'open']])
  assert.equal(judgeTrade({ stopped: false, timedOut: true, taskState: 'failed', final: null, picked }).outcome, 'timeout')

  // 串联：用换来的绿宝石付款也守恒
  const chain = { offers, trades: [{ index: 0, n1: 2 }, { index: 1, n1: 3 }], given: { [mc('wheat')]: 40, [mc('emerald')]: 3 } }
  chain.uses = targetUses(offers, chain.trades)
  assert.equal(judgeTrade({ stopped: false, timedOut: false, taskState: 'done', final: tradeFinal(offers, chain.given, chain.uses), picked: chain }).outcome, 'success')

  // V7：多换、换错一发现就给原因
  const withText = { ...picked, trades: picked.trades.map((t) => ({ ...t, text: describeOffers(offers)[t.index] })) }
  assert.equal(doomedReason(withText, { villager: { uses: picked.uses } }), null)
  assert.equal(doomedReason(withText, { villager: null }), null)
  assert.match(doomedReason(withText, { villager: { uses: [0, 4, 0, 1, 0, 0] } }), /^交易次数超过目标：用 minecraft:emerald × 1 换 minecraft:bread × 6的那笔已经交易了 4 次，目标是 3 次，无法挽回$/)
  assert.match(doomedReason(withText, { villager: { uses: [0, 1, 0, 0, 0, 2] } }), /^做了不在目标里的交易：用 minecraft:emerald × 3 换 minecraft:iron_sword × 1的那笔交易了 2 次，无法挽回$/)
})

/** 训练场跑一轮：预览给 fakeOffers；脚本按 plan 改村民状态 */
function tradeHarness({ aimOk = true, mismatch = false, plan = 'exact' } = {}) {
  const world = { params: null, state: null, previews: [] }
  const offersOf = (seed) => fakeOffers(seed)
  const script = ({ req, executor, clock }) => setImmediate(async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    await tick()
    req.closed = true
    req.answered = true
    executor.task = { taskId: req.taskId, state: 'running' }
    executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
    for (let i = 0; i < 3; i++) await tick()
    const offers = offersOf(world.params.villager.offerSeed)
    const given = {}
    for (const s of world.params.items) given[s.id] = (given[s.id] ?? 0) + s.count
    const want = world.params.expect.trade.uses
    if (plan === 'over') {
      // 第一笔多换一次：训练器在下一次轮询时发现并中止
      const i = want.findIndex((n) => n > 0)
      const uses = want.map((n, j) => (j === i ? n + 1 : 0))
      Object.assign(world.state, { openedAtMs: clock() - 1 }, tradeFinal(offers, given, uses, { open: true }))
      while (executor.task.state === 'running') await tick()
      return
    }
    Object.assign(world.state, { openedAtMs: clock() - 1, reachedAtMs: clock() }, tradeFinal(offers, given, want))
    for (let i = 0; i < 3; i++) await tick()
    executor.task.state = 'done'
    executor.emit('task', { taskId: req.taskId, state: 'done', version: 2 })
  })
  const h = harness({
    script, arenas: ARENAS_TRADE,
    onCall: (method, params) => {
      if (method !== 'arena/trade-preview') return null
      world.previews.push(params)
      return { ok: true, data: { ...params, offers: offersOf(params.offerSeed) } }
    },
    prepareData: (params) => {
      world.params = params
      world.state = { held: {}, carried: {}, payment: {}, dropped: {}, villager: { uuid: 'u', uses: offersOf(0).map(() => 0) }, containerOpen: false, stationIntact: true, openedAtMs: null, reachedAtMs: null }
      const offers = offersOf(params.villager.offerSeed).map((o) => (mismatch ? { ...o, encoded: 'other' } : o))
      return { aimOk, station: 'villager', given: params.items, villager: { uuid: 'u', ...params.villager, offers } }
    },
    statusData: () => world.state
  })
  return { ...h, world }
}

test('trade run: preview first, prepare carries the villager and the uses expect; the text lists each trade by content; exact trading succeeds', async () => {
  const h = tradeHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'villager', runs: 3, seed: 11 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /level=1-5，tasks=1-4，n=1-64，extra=0-16；职业池 13 种/)
  await h.done()
  const records = h.records('villager')
  assert.equal(records.length, 3)
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  for (const [i, record] of records.entries()) {
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.deepEqual([record.faults, record.doomed, record.doomedMs], [[], null, null])
    const p = prepares[i]
    assert.equal(p.station, 'villager')
    assert.deepEqual(p.villager, { profession: record.profession, type: record.villagerType, level: record.level, offerSeed: record.offerSeed })
    assert.deepEqual(h.world.previews[i], p.villager, 'prepare uses the previewed villager')
    assert.deepEqual(p.expect.trade.uses, targetUses(record.offers, record.trades))
    assert.equal(record.trades.length, record.k)
    const text = h.instructions[i]
    const lines = record.trades.map((t, j) => `- ${describeOffers(fakeOffers())[t.index]}的那笔，交易 ${t.n1} 次${j === record.trades.length - 1 ? '。' : '；'}`)
    assert.equal(text, `你正前方有一个村民，视角已经对准它。你的物品栏里有和它交易要用的物品。\n请和它交易：\n${lines.join('\n')}\n每笔都正好交易这么多次，不要做别的交易。换完以后关掉交易界面。用不完的物品留在物品栏里，不要动其他物品。`)
    assert.doesNotMatch(text, /右键|选中|Shift|下标|第 \d 笔/, 'no moves, no indexes')
    assert.equal(typeof record.reachedMs, 'number')
  }
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/3 轮：会话 run-1，村民交易：\w+ \d 级，/)
})

test('trade run: trading over the target is caught while polling, the task is stopped and judged overshoot (V7)', async () => {
  const h = tradeHarness({ plan: 'over' })
  assert.equal(h.trainer.start({ sessionId: 'console', arena: 'villager', seed: 3 }).ok, true)
  await h.done()
  const [record] = h.records('villager')
  assert.equal(record.outcome, 'overshoot', JSON.stringify(record))
  assert.match(record.doomed, /^交易次数超过目标：.*无法挽回$/)
  assert.equal(typeof record.doomedMs, 'number')
  assert.equal(record.error, null)
  assert.ok(record.faults.includes('over') && record.faults.includes('open'), JSON.stringify(record.faults))
})

test('trade run: offers that differ from the preview or a crosshair off the villager stop the run; option checks', async () => {
  const diff = tradeHarness({ mismatch: true })
  assert.equal(diff.trainer.start({ sessionId: 'console', arena: 'villager' }).ok, true)
  await diff.done()
  assert.match(diff.records('villager')[0].error, /预览和村民交易项不一致/)
  const off = tradeHarness({ aimOk: false })
  assert.equal(off.trainer.start({ sessionId: 'console', arena: 'villager' }).ok, true)
  await off.done()
  assert.match(off.records('villager')[0].error, /crosshair is not on the villager/)
  const none = tradeHarness()
  assert.equal(none.trainer.start({ sessionId: 'console', arena: 'villager', item: 'diamond' }).ok, true)
  await none.done()
  assert.match(none.records('villager')[0].error, /preview: 连续 11 次选不出交易/)
  assert.equal(none.world.previews.length, 11)
  const h = tradeHarness()
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'villager', crafts: '2' }).error, /不认这些选项：m/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'villager', level: '6' }).error, /level 要写 k 或 a-b（1–5/)
})

test('trade config: defaults, validation and the report (k grouping, mistrade and fault columns)', async () => {
  const config = normalizeConfig({})
  assert.deepEqual(config.training.arenas.villager, { type: 'trade', origin: [10000, 120, 10390], timeoutSec: 900, level: '1-5', tasks: '1-4', portions: '1-64', extra: '0-16', exclude: { professions: [], items: [] } })
  assert.deepEqual(normalizeConfig({ training: { arenas: { mine: { type: 'trade', origin: [0, 0, 0] } } } }).training.arenas.mine.tasks, '1-4')
  assert.throws(() => normalizeConfig({ training: { arenas: { villager: { type: 'trade', origin: [0, 0, 0], exclude: ['x'] } } } }), /villager\.exclude must be \{ professions/)
  assert.throws(() => normalizeConfig({ training: { arenas: { villager: { type: 'trade', origin: [0, 0, 0], level: '0' } } } }), /training\.arenas\.villager\.level 要写/)

  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (k, outcome, faults = [], hasChain = false) => ({ batch: 'b1', target: 'x', profession: mc('farmer'), level: 2, trades: [], k, hasChain, doomed: null, faults, outcome, openedMs: 1000, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false, stationIntact: true })
  const records = [rec(2, 'success'), rec(2, 'mistrade', ['wrong']), rec(1, 'overshoot', ['over', 'open'], true), rec(1, 'false_success', ['short'])]
  const byK = summarize(records, { by: 'k' })
  assert.equal(byK.trader, true)
  assert.deepEqual(byK.rows.map((r) => [r.key, r.runs]), [['1 笔', 2], ['2 笔', 2]])
  assert.deepEqual([byK.total.mistrade, byK.total.overshoot, byK.total.tradeFaults], [1, 1, { short: 1, over: 1, wrong: 1, open: 1 }])
  assert.match(formatSummary(byK).split('\n')[0], /^交易笔数\t轮数\t成功率\t虚报\t失败\t超时\t中止\t换多\t换错\t丢失\t次数不够\t换多\t换错\t没关界面\t打开交易界面中位/)
  assert.deepEqual(summarize(records, { by: 'chain' }).rows.map((r) => r.key).sort(), ['无串联', '有串联'])
  assert.deepEqual(summarize(records, { by: 'level' }).rows.map((r) => r.key), ['2 级'])
  assert.deepEqual(summarize(records, { by: 'profession' }).rows.map((r) => r.key), ['farmer'])
})

// ── 砂轮（docs/砂轮训练场设计方案.md）──
const grindModule = await import('../src/training/grindstone.js')
/** 假的 arena/anvil-catalog，带附魔书（K2）：书能带全部附魔 */
const GRIND_CATALOG = {
  items: ANVIL_CATALOG.items,
  book: {
    id: 'minecraft:enchanted_book',
    enchantments: [anvilEnch('binding_curse', 1, { curse: true }), anvilEnch('feather_falling', 4), anvilEnch('mending', 1), anvilEnch('protection', 4),
      anvilEnch('sharpness', 5, { exclusive: ['smite'] }), anvilEnch('smite', 5, { exclusive: ['sharpness'] }), anvilEnch('unbreaking', 3), anvilEnch('vanishing_curse', 1, { curse: true })]
  }
}
const ARENAS_GRIND = { grindstone: { type: 'grindstone', origin: [0, 100, 420], timeoutSec: 600, tasks: '1-3', kind: 'mix', enchants: '1-3', curses: '0-1', exclude: [] } }

test('grindstone options: tasks 1–4, kind item / book / mix, enchants 1–5, curses 0–2 as a count; item and kind must agree (§5.2)', () => {
  const { grindstoneOptions, parseCursesSpec } = grindModule
  assert.deepEqual(grindstoneOptions({}, ARENAS_GRIND.grindstone), { tasks: { lo: 1, hi: 3 }, kind: 'mix', item: null, enchants: { lo: 1, hi: 3 }, curses: { lo: 0, hi: 1 } })
  assert.deepEqual(grindstoneOptions({ tasks: '4', kind: 'book', item: 'enchanted_book', enchants: '2-5', curses: '2' }),
    { tasks: { lo: 4, hi: 4 }, kind: 'book', item: mc('enchanted_book'), enchants: { lo: 2, hi: 5 }, curses: { lo: 2, hi: 2 } })
  assert.throws(() => grindstoneOptions({ kind: 'book', item: 'bow' }), /kind=book 只出附魔书，不能和 item=minecraft:bow 一起用/)
  assert.throws(() => grindstoneOptions({ kind: 'item', item: 'enchanted_book' }), /kind=item 不出附魔书/)
  assert.throws(() => grindstoneOptions({ kind: 'take' }), /砂轮题的 kind 只能是 item \/ book \/ mix/)
  assert.throws(() => grindstoneOptions({ tasks: '5' }), /tasks 要写 k 或 a-b（1–4/)
  assert.throws(() => parseCursesSpec('3'), /砂轮题的 curses 要写 k 或 a-b（0–2/)
  assert.deepEqual(parseCursesSpec('0'), { lo: 0, hi: 0 })

  const args = parseTrainArgs(['grindstone', 'tasks=2-4', 'kind=book', 'enchants=2', 'curses=0-2'])
  assert.equal(args.ok, true, args.error)
  assert.deepEqual([args.tasks, args.kind, args.enchants, args.curses], ['2-4', 'book', '2', '0-2'])
  assert.match(parseTrainArgs(['grindstone', 'curses=5']).error, /curses 只能是 0 \/ 1（铁砧题）或 k、a-b（砂轮题，0–2）/)
  assert.match(parseTrainArgs(['grindstone', 'kind=foo']).error, /、item \/ book \/ mix（砂轮题）或 text \/ color \/ wax（告示牌题）/)
  assert.equal(parseTrainArgs(['anvil', 'curses=1']).curses, '1', 'the anvil switch still parses')

  const config = normalizeConfig({})
  assert.deepEqual(config.training.arenas.grindstone, { type: 'grindstone', origin: [10000, 120, 10420], timeoutSec: 600, tasks: '1-3', kind: 'mix', enchants: '1-3', curses: '0-1', exclude: [] })
  assert.deepEqual(normalizeConfig({ training: { arenas: { g2: { type: 'grindstone', origin: [0, 0, 0] } } } }).training.arenas.g2, { tasks: '1-3', kind: 'mix', enchants: '1-3', curses: '0-1', exclude: [], type: 'grindstone', origin: [0, 0, 0] })
  assert.throws(() => normalizeConfig({ training: { arenas: { g2: { type: 'grindstone', origin: [0, 0, 0], curses: '0-3' } } } }), /training\.arenas\.g2\.砂轮题的 curses/)
  assert.throws(() => normalizeConfig({ training: { arenas: { g2: { type: 'grindstone', origin: [0, 0, 0], exclude: {} } } } }), /g2\.exclude must be a list of item ids/)
})

test('grindstone sampler: distinct durable items, books about 1/4, ≥1 compatible non-curse enchantment, curses only where they fit, goals keep curses and turn bare books into books, reproducible (K2–K5)', () => {
  const { grindstoneTables, grindstoneOptions, sampleGrindstone, goalOf, BOOK_CHANCE } = grindModule
  const tables = grindstoneTables(GRIND_CATALOG, [])
  const options = grindstoneOptions({}, ARENAS_GRIND.grindstone)
  const entryOf = (it) => (it.kind === 'book' ? GRIND_CATALOG.book : GRIND_CATALOG.items.find((e) => e.id === it.id))
  let items = 0
  let books = 0
  const ks = new Set()
  let cursed = 0
  for (let seed = 0; seed < 300; seed++) {
    const picked = sampleGrindstone(tables, seed, options)
    ks.add(picked.k)
    assert.ok(picked.k >= 1 && picked.k <= 3)
    assert.equal(picked.items.length, picked.k)
    const durable = picked.items.filter((it) => it.kind === 'item').map((it) => it.id)
    assert.equal(new Set(durable).size, durable.length, 'durable items never repeat in a round')
    const slots = picked.items.map((it) => it.slot)
    assert.equal(new Set(slots).size, slots.length)
    assert.ok(slots.every((s) => s >= 0 && s < 36))
    for (const it of picked.items) {
      items++
      if (it.kind === 'book') books++
      const entry = entryOf(it)
      const ids = Object.keys(it.enchantments)
      const meta = ids.map((id) => entry.enchantments.find((e) => e.id === id))
      assert.ok(meta.every(Boolean), `${it.id} only gets enchantments it can hold: ${ids}`)
      assert.ok(meta.some((e) => !e.curse), 'at least one non-curse enchantment (F5)')
      assert.ok(meta.filter((e) => !e.curse).length <= 3)
      assert.ok(meta.filter((e) => e.curse).length <= 1)
      assert.deepEqual(it.curses, meta.filter((e) => e.curse).map((e) => e.id).sort())
      if (it.curses.length) cursed++
      for (const e of meta) {
        assert.ok(it.enchantments[e.id] >= 1 && it.enchantments[e.id] <= e.maxLevel)
        assert.ok(!meta.some((o) => e.exclusive.includes(o.id)), `compatible: ${ids}`)
      }
    }
    assert.deepEqual(picked.goals, picked.items.map(goalOf))
    assert.equal(picked.hasBook, picked.items.some((it) => it.kind === 'book'))
    assert.equal(picked.hasCurse, picked.items.some((it) => it.curses.length > 0))
  }
  assert.deepEqual([...ks].sort(), [1, 2, 3])
  assert.ok(Math.abs(books / items - BOOK_CHANCE) < 0.08, `books ${books}/${items}`)
  assert.ok(cursed > 0)
  assert.deepEqual(sampleGrindstone(tables, 42, options), sampleGrindstone(tables, 42, options))

  // 目标（F4）
  assert.deepEqual(goalOf({ id: mc('enchanted_book'), enchantments: { [mc('mending')]: 1 }, curses: [] }), { id: mc('book'), enchantments: {}, damage: 0 })
  assert.deepEqual(goalOf({ id: mc('enchanted_book'), enchantments: { [mc('mending')]: 1, [mc('vanishing_curse')]: 1 }, curses: [mc('vanishing_curse')] }),
    { id: mc('enchanted_book'), enchantments: { [mc('vanishing_curse')]: 1 }, damage: 0 })
  assert.deepEqual(goalOf({ id: mc('iron_boots'), enchantments: { [mc('binding_curse')]: 1, [mc('protection')]: 4 }, curses: [mc('binding_curse')] }),
    { id: mc('iron_boots'), enchantments: { [mc('binding_curse')]: 1 }, damage: 0 })

  // kind=book：多本附魔书；curses=2 时书上两种诅咒都有，剑只有消失诅咒
  const allBooks = sampleGrindstone(tables, 7, grindstoneOptions({ tasks: '3', kind: 'book', curses: '2' }))
  assert.deepEqual(allBooks.items.map((it) => [it.id, it.curses.length]), [[mc('enchanted_book'), 2], [mc('enchanted_book'), 2], [mc('enchanted_book'), 2]])
  const sword = sampleGrindstone(tables, 7, grindstoneOptions({ tasks: '1', item: 'diamond_sword', curses: '2' }))
  assert.deepEqual([sword.items[0].id, sword.items[0].curses], [mc('diamond_sword'), [mc('vanishing_curse')]])
  // 物品池不够、附魔书被排除
  const small = grindstoneTables(GRIND_CATALOG, ['minecraft:iron_sword'])
  assert.throws(() => sampleGrindstone(small, 1, grindstoneOptions({ tasks: '4', kind: 'item' })), /物品池不够：一轮要 4 件互不同种的物品/)
  const noBook = grindstoneTables(GRIND_CATALOG, ['minecraft:enchanted_book'])
  assert.equal(noBook.book, null)
  assert.throws(() => sampleGrindstone(noBook, 1, grindstoneOptions({ kind: 'book' })), /物品池里没有附魔书/)
  for (let seed = 0; seed < 50; seed++) assert.ok(sampleGrindstone(noBook, seed, options).items.every((it) => it.kind === 'item'))
})

test('grindstone judge: exact goals succeed in any slot; unground, left in the grindstone, on the cursor, dropped; lost when an item is gone or the grindstone is (K7)', () => {
  const { judgeGrindstone, goalOf } = grindModule
  const sword = { slot: 3, kind: 'item', id: mc('diamond_sword'), enchantments: { [mc('sharpness')]: 3, [mc('vanishing_curse')]: 1 }, curses: [mc('vanishing_curse')] }
  const book = { slot: 9, kind: 'book', id: mc('enchanted_book'), enchantments: { [mc('mending')]: 1 }, curses: [] }
  const book2 = { slot: 10, kind: 'book', id: mc('enchanted_book'), enchantments: { [mc('unbreaking')]: 2 }, curses: [] }
  const picked = { k: 2, items: [sword, book], goals: [goalOf(sword), goalOf(book)] }
  const stack = (it, slot, extra = {}) => ({ slot, id: it.id, count: 1, enchantments: it.enchantments, name: null, ...(it.id.endsWith('sword') ? { damage: 0 } : {}), ...extra })
  const ground = [stack(picked.goals[0], 20), stack(picked.goals[1], 0)]
  const judgeWith = (final, extra = {}) => judgeGrindstone({ stopped: false, timedOut: false, taskState: 'done', picked, final: { carriedItem: null, slots: null, droppedItems: [], containerOpen: true, stationIntact: true, ...final }, ...extra })

  assert.deepEqual(judgeWith({ items: ground }), { outcome: 'success', reached: true, ground: 2, faults: [] })
  assert.deepEqual(judgeWith({ items: [ground[0], stack(book, 9)] }), { outcome: 'false_success', reached: false, ground: 1, faults: ['left'] })
  assert.deepEqual(judgeWith({ items: [ground[0]], slots: { input0: stack(book, undefined), input1: null } }).faults, ['left', 'input'])
  assert.deepEqual(judgeWith({ items: [ground[0]], carriedItem: stack(picked.goals[1]) }), { outcome: 'false_success', reached: false, ground: 1, faults: ['cursor'] })
  assert.deepEqual(judgeWith({ items: [ground[0]], droppedItems: [stack(picked.goals[1])] }).faults, ['dropped'])
  assert.equal(judgeWith({ items: [ground[0], stack(picked.goals[1], 0, { name: 'x' })] }).outcome, 'lost', 'a renamed book is no longer one of the forms')
  assert.equal(judgeWith({ items: [ground[0]] }).outcome, 'lost')
  assert.equal(judgeWith({ items: ground, stationIntact: false }).outcome, 'lost')
  assert.equal(judgeWith({ items: [stack(sword, 3), stack(book, 9)] }, { taskState: 'failed' }).outcome, 'failed')
  assert.equal(judgeWith({ items: [stack(sword, 3), stack(book, 9)] }, { timedOut: true, taskState: 'running' }).outcome, 'timeout')
  assert.equal(judgeWith({ items: ground }, { stopped: true }).outcome, 'aborted')
  // 两本没有诅咒的附魔书磨完是同一种书，叠成 2 本也算
  const twoBooks = { k: 2, items: [book, book2], goals: [goalOf(book), goalOf(book2)] }
  assert.equal(judgeGrindstone({ stopped: false, timedOut: false, taskState: 'done', picked: twoBooks, final: { items: [{ slot: 0, id: mc('book'), count: 2, enchantments: {}, name: null }], carriedItem: null, slots: null, droppedItems: [], stationIntact: true } }).outcome, 'success')
})

function grindHarness({ aimOk = true, finalOf = null } = {}) {
  const world = { params: null, state: {} }
  const describe = (g) => ({ slot: g.slot, id: g.id, count: g.count, enchantments: anvilModule.sortEnchantments(g.enchantments ?? {}), name: null })
  const defaultFinal = (params) => ({ items: params.expect.grindstone.goals.map((g, i) => ({ slot: i, id: g.id, count: 1, enchantments: g.enchantments, name: null, damage: g.damage })) })
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
    script, arenas: ARENAS_GRIND,
    onCall: (method) => (method === 'arena/anvil-catalog' ? { ok: true, data: GRIND_CATALOG } : null),
    prepareData: (params) => {
      world.params = params
      const items = params.items.map(describe)
      world.state = { held: {}, items, carried: {}, carriedItem: null, slots: null, dropped: {}, droppedItems: [], containerOpen: false, stationIntact: true, openedAtMs: null, reachedAtMs: null }
      return { aimOk, station: 'grindstone', grindstone: { items } }
    },
    statusData: () => world.state
  })
  return { ...h, world }
}

test('grindstone run: the catalog is read once, prepare carries count-1 items and the goals, the text lists items only (K6 B); grinding everything succeeds', async () => {
  const h = grindHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'grindstone', runs: 6, seed: 5 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /tasks=1-3，kind=mix，enchants=1-3，curses=0-1/)
  await h.done()
  const records = h.records('grindstone')
  assert.equal(records.length, 6)
  assert.equal(h.calls.filter(([m]) => m === 'arena/anvil-catalog').length, 1)
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  for (const [i, record] of records.entries()) {
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.deepEqual([record.ground, record.faults, record.reached], [record.k, [], true])
    const prepare = prepares[i]
    assert.equal(prepare.station, 'grindstone')
    assert.deepEqual(prepare.items, record.items.map((it) => ({ slot: it.slot, id: it.id, count: 1, enchantments: it.enchantments })))
    assert.deepEqual(prepare.expect, { grindstone: { goals: record.goals } })
    const text = h.instructions[i]
    const one = record.k === 1
    assert.ok(text.startsWith(`你正前方有一个砂轮，视角已经对准它。你的物品栏里有${one ? '一件' : `${record.k} 件`}带附魔的物品：\n`), text)
    assert.ok(text.trimEnd().endsWith(`请用砂轮给${one ? '它' : '它们'}祛魔，产物放回物品栏。`), text)
    for (const it of record.items) assert.ok(text.includes(`- 带 ${grindModule.enchantsText(it.enchantments)} 的 ${it.id}`), text)
    assert.doesNotMatch(text, /→|诅咒|minecraft:book[^_]|格子|右键|Shift/, 'K6 B: no goals, no moves')
    assert.ok(!text.includes('\r'))
  }
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/6 轮：会话 run-1，砂轮 \d 件 /)
})

test('grindstone run: a crosshair off the grindstone stops the batch; an unground item is false_success; option conflicts are refused', async () => {
  const off = grindHarness({ aimOk: false })
  assert.equal(off.trainer.start({ sessionId: 'console', arena: 'grindstone', runs: 3 }).ok, true)
  await off.done()
  const offRecords = off.records('grindstone')
  assert.equal(offRecords.length, 1)
  assert.match(offRecords[0].error, /crosshair is not on the grindstone/)

  const lazy = grindHarness({ finalOf: (params) => ({ items: params.items.map((g) => ({ slot: g.slot, id: g.id, count: 1, enchantments: g.enchantments, name: null, damage: 0 })) }) })
  assert.equal(lazy.trainer.start({ sessionId: 'console', arena: 'grindstone', seed: 2, kind: 'item' }).ok, true)
  await lazy.done()
  const rec = lazy.records('grindstone')[0]
  assert.deepEqual([rec.outcome, rec.faults, rec.ground], ['false_success', ['left'], 0])

  const h = grindHarness()
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'grindstone', kind: 'book', item: 'bow' }).error, /kind=book 只出附魔书/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'grindstone', task: 'merge' }).error, /不认这些选项：task/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'grindstone', curses: '1-3' }).error, /砂轮题的 curses/)
})

test('report: grindstone records group by k / kind / curses, with a column per fault', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (k, outcome, faults = [], hasBook = false, hasCurse = false) => ({ batch: 'b1', target: 'x', k, items: [], goals: [], hasBook, hasCurse, ground: null, faults, outcome, openedMs: 1000, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false, stationIntact: true })
  const records = [rec(1, 'success'), rec(2, 'false_success', ['left', 'input'], true), rec(2, 'false_success', ['cursor'], false, true), rec(3, 'lost', ['dropped'], true, true)]
  const byK = summarize(records, { by: 'k' })
  assert.equal(byK.grinder, true)
  assert.deepEqual(byK.rows.map((r) => [r.key, r.runs]), [['2 件', 2], ['1 件', 1], ['3 件', 1]])
  assert.deepEqual(byK.total.grindFaults, { left: 1, input: 1, cursor: 1, dropped: 1 })
  assert.match(formatSummary(byK).split('\n')[0], /^件数\t轮数\t成功率\t虚报\t失败\t超时\t中止\t丢失\t有没磨的\t留在砂轮\t光标上有东西\t扔在地上\t打开砂轮中位/)
  assert.deepEqual(summarize(records, { by: 'kind' }).rows.map((r) => r.key).sort(), ['有附魔书', '没有附魔书'].sort())
  assert.deepEqual(summarize(records, { by: 'curses' }).rows.map((r) => r.key).sort(), ['有诅咒', '没有诅咒'].sort())
  assert.match(formatSummary(summarize(records, { by: 'curses' })).split('\n')[0], /^诅咒\t/)
})

// ── 书与笔（docs/书与笔训练场设计方案.md）──
const bookModule = await import('../src/training/book.js')
const ARENAS_BOOK = { book: { type: 'book', origin: [0, 100, 450], timeoutSec: 600, books: '1-3', pages: '1-6', edits: '1-3', exclude: [] } }

test('book options: books 1–3, pages 1–8, edits 1–4 (§5.2); config defaults and checks', () => {
  const { bookOptions } = bookModule
  assert.deepEqual(bookOptions({}, ARENAS_BOOK.book), { books: { lo: 1, hi: 3 }, pages: { lo: 1, hi: 6 }, edits: { lo: 1, hi: 3 } })
  assert.deepEqual(bookOptions({ books: '2', pages: '4-8', edits: '4' }), { books: { lo: 2, hi: 2 }, pages: { lo: 4, hi: 8 }, edits: { lo: 4, hi: 4 } })
  assert.throws(() => bookOptions({ books: '4' }), /books 要写 k 或 a-b（1–3/)
  assert.throws(() => bookOptions({ pages: '0' }), /pages 要写 k 或 a-b（1–8/)
  assert.throws(() => bookOptions({ edits: '2-5' }), /edits 要写 k 或 a-b（1–4/)

  const args = parseTrainArgs(['book', 'books=2-3', 'pages=4', 'edits=1-4'])
  assert.equal(args.ok, true, args.error)
  assert.deepEqual([args.books, args.pages, args.edits], ['2-3', '4', '1-4'])
  assert.match(parseTrainArgs(['book', 'pages=9']).error, /pages 要写 k 或 a-b（1–8/)

  const config = normalizeConfig({})
  assert.deepEqual(config.training.arenas.book, { type: 'book', origin: [10000, 120, 10450], timeoutSec: 600, books: '1-3', pages: '1-6', edits: '1-3', exclude: [] })
  assert.deepEqual(normalizeConfig({ training: { arenas: { b2: { type: 'book', origin: [0, 0, 0] } } } }).training.arenas.b2, { books: '1-3', pages: '1-6', edits: '1-3', exclude: [], type: 'book', origin: [0, 0, 0] })
  assert.throws(() => normalizeConfig({ training: { arenas: { b2: { type: 'book', origin: [0, 0, 0], edits: '9' } } } }), /training\.arenas\.b2\.edits 要写/)
})

test('book sampler: last page has text, edits within page n + 2, clears only on written pages, goal drops trailing blanks, unique 6–16 character texts, distinct slots, reproducible (J4–J8)', () => {
  const { bookOptions, sampleBookRound, applyEdits, TEXT_MIN, TEXT_MAX } = bookModule
  const options = bookOptions({}, ARENAS_BOOK.book)
  const hanzi = new Set(anvilModule.HANZI)
  const alnum = /^[A-Za-z0-9]$/
  let clears = 0
  let appends = 0
  let inHand = 0
  const ks = new Set()
  for (let seed = 0; seed < 300; seed++) {
    const picked = sampleBookRound(seed, options)
    ks.add(picked.k)
    assert.equal(picked.books.length, picked.k)
    assert.ok(picked.selectedSlot >= 0 && picked.selectedSlot <= 8)
    assert.equal(picked.inHand, picked.books.some((b) => b.slot === picked.selectedSlot))
    if (picked.inHand) inHand++
    const slots = picked.books.map((b) => b.slot)
    assert.equal(new Set(slots).size, slots.length)
    assert.ok(slots.every((s) => s >= 0 && s < 36))
    const texts = []
    for (const b of picked.books) {
      const n = b.pages.length
      assert.ok(n >= 1 && n <= 6)
      assert.notEqual(b.pages[n - 1], '', 'the last page always has text (F5)')
      assert.ok(b.edits.length >= 1 && b.edits.length <= Math.min(3, n + 2))
      const pages = b.edits.map((e) => e.page)
      assert.deepEqual(pages, [...new Set(pages)].sort((x, y) => x - y))
      assert.ok(pages.every((p) => p >= 1 && p <= n + 2))
      for (const e of b.edits) {
        if (e.op === 'clear') {
          clears++
          assert.ok(e.page <= n && b.pages[e.page - 1] !== '', 'only written pages are cleared')
        } else {
          texts.push(e.text)
        }
        if (e.page > n) appends++
      }
      assert.deepEqual(b.goal, applyEdits(b.pages, b.edits))
      assert.notDeepEqual(b.goal, b.pages)
      if (b.goal.length) assert.notEqual(b.goal[b.goal.length - 1], '')
      texts.push(...b.pages.filter((p) => p !== ''))
      if (picked.k === 1) assert.equal(b.label, null)
      else assert.deepEqual(b.label, { page: b.pages.findIndex((p) => p !== '') + 1, text: b.pages.find((p) => p !== '') })
    }
    assert.equal(new Set(texts).size, texts.length, 'every text in a round is unique')
    for (const t of texts) {
      const chars = [...t]
      assert.ok(chars.length >= TEXT_MIN && chars.length <= TEXT_MAX, t)
      assert.ok(chars.every((c) => hanzi.has(c) || alnum.test(c)), t)
      assert.ok(chars.some((c) => hanzi.has(c)) && chars.some((c) => alnum.test(c)), t)
    }
    assert.equal(picked.hasClear, picked.books.some((b) => b.edits.some((e) => e.op === 'clear')))
    assert.equal(picked.hasAppend, picked.books.some((b) => b.edits.some((e) => e.page > b.pages.length)))
  }
  assert.deepEqual([...ks].sort(), [1, 2, 3])
  assert.ok(clears > 0 && appends > 0 && inHand > 0)
  assert.deepEqual(sampleBookRound(11, options), sampleBookRound(11, options))
  // 目标页列表（F5）：清空最后一页书变短，写到第 n + 2 页时第 n + 1 页是空页
  assert.deepEqual(applyEdits(['a', '', 'c'], [{ page: 3, op: 'clear' }]), ['a'])
  assert.deepEqual(applyEdits(['a'], [{ page: 3, op: 'write', text: 'z' }]), ['a', '', 'z'])
  assert.deepEqual(applyEdits(['a'], [{ page: 1, op: 'clear' }]), [])
})

test('book judge: goals as a multiset in any slot; unsaved, wrong, signed, cursor, dropped; lost when a book is gone (J10)', () => {
  const { judgeBook, WRITABLE, WRITTEN } = bookModule
  const picked = { k: 2, books: [{ pages: ['a1', 'a2'], goal: ['A1', 'a2'] }, { pages: ['b1'], goal: [] }] }
  const bk = (pages, slot = 0, extra = {}) => ({ slot, id: WRITABLE, count: 1, pages, ...extra })
  const judgeWith = (final, extra = {}) => judgeBook({ stopped: false, timedOut: false, taskState: 'done', picked, final: { carriedItem: null, droppedBooks: [], ...final }, ...extra })
  assert.deepEqual(judgeWith({ books: [bk([], 7), bk(['A1', 'a2'], 30)] }), { outcome: 'success', reached: true, done: 2, faults: [] })
  assert.deepEqual(judgeWith({ books: [bk(['A1', 'a2']), bk(['b1'], 3)] }), { outcome: 'false_success', reached: false, done: 1, faults: ['unsaved'] })
  assert.deepEqual(judgeWith({ books: [bk(['A1', 'a2', '']), bk([], 3)] }).faults, ['wrong'])
  assert.deepEqual(judgeWith({ books: [bk(['A1', 'a2'])], carriedItem: bk([]) }).faults, ['cursor'])
  assert.deepEqual(judgeWith({ books: [bk(['A1', 'a2'])], droppedBooks: [bk([])] }).faults, ['dropped'])
  assert.deepEqual(judgeWith({ books: [bk(['A1', 'a2']), { slot: 2, id: WRITTEN, count: 1, pages: [], title: 'x' }] }).faults, ['signed'])
  assert.equal(judgeWith({ books: [bk(['A1', 'a2']), bk([], 1), { slot: 4, id: mc('stick'), count: 1 }] }).outcome, 'false_success', 'nothing but the books')
  assert.equal(judgeWith({ books: [bk(['A1', 'a2'])] }).outcome, 'lost')
  assert.equal(judgeWith({ books: [bk(['a1', 'a2']), bk(['b1'])] }, { taskState: 'failed' }).outcome, 'failed')
  assert.equal(judgeWith({ books: [bk(['a1', 'a2']), bk(['b1'])] }, { timedOut: true, taskState: 'running' }).outcome, 'timeout')
  assert.equal(judgeWith({ books: [bk([]), bk(['A1', 'a2'])] }, { stopped: true }).outcome, 'aborted')
})

function bookHarness({ finalOf = null, selectedOffset = 0 } = {}) {
  const world = { params: null, state: {} }
  const defaultFinal = (params) => ({ books: params.expect.book.goals.map((pages, i) => ({ slot: i, id: bookModule.WRITABLE, count: 1, pages })) })
  const script = ({ req, executor, clock, setBusy }) => setImmediate(async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    await tick()
    req.closed = true
    req.answered = true
    executor.task = { taskId: req.taskId, state: 'running' }
    executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
    for (let i = 0; i < 3; i++) await tick()
    Object.assign(world.state, { reachedAtMs: clock() }, (finalOf ?? defaultFinal)(world.params, world))
    for (let i = 0; i < 3; i++) await tick()
    executor.task.state = 'done'
    setBusy(2)
    executor.emit('task', { taskId: req.taskId, state: 'done', version: 2 })
  })
  const h = harness({
    script, arenas: ARENAS_BOOK,
    prepareData: (params) => {
      world.params = params
      const items = params.items.map((g) => ({ slot: g.slot, id: g.id, count: g.count, pages: g.pages }))
      world.state = { held: {}, books: items, carriedItem: null, dropped: {}, droppedBooks: [], selectedSlot: params.selectedSlot, reachedAtMs: null }
      return { book: { items, selectedSlot: (params.selectedSlot + selectedOffset) % 9 } }
    },
    statusData: () => world.state
  })
  return { ...h, world }
}

test('book run: prepare carries books with pages, the selected slot and the goals; the text lists page edits only (J9); writing them succeeds', async () => {
  const h = bookHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'book', runs: 8, seed: 4 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /books=1-3，pages=1-6，edits=1-3/)
  await h.done()
  const records = h.records('book')
  assert.equal(records.length, 8)
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  let multi = 0
  for (const [i, record] of records.entries()) {
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.deepEqual([record.done, record.faults, record.reached], [record.k, [], true])
    const prepare = prepares[i]
    assert.equal(prepare.station, undefined)
    assert.equal(prepare.selectedSlot, record.selectedSlot)
    assert.deepEqual(prepare.items, record.books.map((b) => ({ slot: b.slot, id: mc('writable_book'), count: 1, pages: b.pages })))
    assert.deepEqual(prepare.expect, { book: { goals: record.books.map((b) => b.goal) } })
    const text = h.instructions[i]
    assert.ok(text.startsWith(`你的物品栏里有${record.k === 1 ? '一本' : `${record.k} 本`}书与笔。请修改：\n`), text)
    assert.ok(text.trimEnd().endsWith('没有提到的页保持原样。改好的书留在物品栏里。'), text)
    for (const b of record.books) {
      for (const e of b.edits) assert.ok(text.includes(e.op === 'clear' ? `- 第 ${e.page} 页清空` : `- 第 ${e.page} 页的内容改成「${e.text}」`), text)
      if (record.k > 1) {
        multi++
        assert.ok(text.includes(`现在第 ${b.label.page} 页写着「${b.label.text}」的那本：\n`), text)
      }
    }
    assert.doesNotMatch(text, /追加|保存|署名|book\/|右键|快捷栏/, 'J9: the goal only')
    assert.ok(!text.includes('\r'))
  }
  assert.ok(multi > 0, 'some rounds have several books')
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/8 轮：会话 run-1，书与笔 \d 本：\[/)
})

test('book run: a wrong selected slot stops the batch; an unsaved book is false_success; option checks', async () => {
  const off = bookHarness({ selectedOffset: 1 })
  assert.equal(off.trainer.start({ sessionId: 'console', arena: 'book', runs: 3 }).ok, true)
  await off.done()
  const offRecords = off.records('book')
  assert.equal(offRecords.length, 1)
  assert.match(offRecords[0].error, /选中的快捷栏格是 \d，应为 \d/)

  const lazy = bookHarness({ finalOf: (params) => ({ books: params.items.map((g) => ({ slot: g.slot, id: g.id, count: 1, pages: g.pages })) }) })
  assert.equal(lazy.trainer.start({ sessionId: 'console', arena: 'book', seed: 3 }).ok, true)
  await lazy.done()
  const rec = lazy.records('book')[0]
  assert.deepEqual([rec.outcome, rec.faults, rec.done], ['false_success', ['unsaved'], 0])

  const h = bookHarness()
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'book', item: 'stick' }).error, /书与笔题没有 item= 选项/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'book', crafts: '2' }).error, /不认这些选项：m/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'book', books: '5' }).error, /books 要写 k 或 a-b（1–3/)
})

test('report: book records group by k / hand / ops with a column per fault; cartography keeps its own ops grouping', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (k, outcome, faults = [], inHand = false, hasAppend = false, hasClear = false) => ({ batch: 'b1', target: 'x', k, books: [], inHand, hasAppend, hasClear, selectedSlot: 0, done: null, faults, outcome, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false })
  const records = [rec(1, 'success', [], true), rec(2, 'false_success', ['unsaved'], false, true), rec(2, 'false_success', ['wrong', 'cursor'], false, false, true), rec(3, 'lost', ['dropped'], false, true, true)]
  const byK = summarize(records, { by: 'k' })
  assert.equal(byK.booker, true)
  assert.deepEqual(byK.rows.map((r) => [r.key, r.runs]), [['2 本', 2], ['1 本', 1], ['3 本', 1]])
  assert.deepEqual(byK.total.bookFaults, { unsaved: 1, wrong: 1, signed: 0, cursor: 1, dropped: 1 })
  assert.match(formatSummary(byK).split('\n')[0], /^本数\t轮数\t成功率\t虚报\t失败\t超时\t中止\t丢失\t没改或没保存\t改错\t署名了\t光标上有东西\t扔在地上\t达成中位/)
  assert.deepEqual(summarize(records, { by: 'hand' }).rows.map((r) => r.key).sort(), ['开局在手上', '要先拿到手上'].sort())
  const byOps = summarize(records, { by: 'ops' })
  assert.deepEqual(byOps.rows.map((r) => r.key).sort(), ['只改写', '有追加', '有清空', '有追加、有清空'].sort())
  assert.match(formatSummary(byOps).split('\n')[0], /^修改种类\t/)
})

const signModule = await import('../src/training/sign.js')
const ARENAS_SIGN = { sign: { type: 'sign', origin: [0, 100, 480], timeoutSec: 300, kind: null, edits: '1-3', exclude: [] } }
const blankBack = () => ({ lines: ['', '', '', ''], color: 'black', glow: false })

test('sign options: kind text / color / wax or random, edits 1–4 only for text (§5.2); config defaults and checks', () => {
  const { signOptions } = signModule
  assert.deepEqual(signOptions({}, ARENAS_SIGN.sign), { kind: null, edits: { lo: 1, hi: 3 } })
  assert.deepEqual(signOptions({ kind: 'text', edits: '4' }), { kind: 'text', edits: { lo: 4, hi: 4 } })
  assert.deepEqual(signOptions({ kind: 'wax' }, ARENAS_SIGN.sign), { kind: 'wax', edits: { lo: 1, hi: 3 } })
  assert.throws(() => signOptions({ kind: 'take' }), /告示牌题的 kind 只能是 text \/ color \/ wax/)
  assert.throws(() => signOptions({ kind: 'color', edits: '2' }), /edits= 只用于 text 题，不能和 kind=color 一起用/)
  assert.throws(() => signOptions({ edits: '0-2' }), /edits 要写 k 或 a-b（1–4/)

  const args = parseTrainArgs(['sign', 'kind=color', 'runs=2'])
  assert.equal(args.ok, true, args.error)
  assert.deepEqual([args.kind, args.runs], ['color', 2])
  assert.match(parseTrainArgs(['sign', 'kind=foo']).error, /或 text \/ color \/ wax（告示牌题）/)

  const config = normalizeConfig({})
  assert.deepEqual(config.training.arenas.sign, { type: 'sign', origin: [10000, 120, 10480], timeoutSec: 300, kind: null, edits: '1-3', exclude: [] })
  assert.deepEqual(normalizeConfig({ training: { arenas: { s2: { type: 'sign', origin: [0, 0, 0] } } } }).training.arenas.s2, { kind: null, edits: '1-3', exclude: [], type: 'sign', origin: [0, 0, 0] })
  assert.throws(() => normalizeConfig({ training: { arenas: { s2: { type: 'sign', origin: [0, 0, 0], kind: 'gold' } } } }), /training\.arenas\.s2\.告示牌题的 kind/)
})

test('sign sampler: three kinds; text edits 1–3 lines with clears only on written lines; color has text and a new dye colour; wax gives honeycomb; 32–64 items, empty hand, unique 2–6 character lines, reproducible (Q4–Q7)', () => {
  const { signOptions, sampleSignRound, COLORS, dyeOf, HONEYCOMB, TEXT_MIN, TEXT_MAX } = signModule
  const options = signOptions({}, ARENAS_SIGN.sign)
  const hanzi = new Set(anvilModule.HANZI)
  const alnum = /^[A-Za-z0-9]$/
  const kinds = new Map()
  let clears = 0
  let emptyStarts = 0
  for (let seed = 0; seed < 400; seed++) {
    const p = sampleSignRound(seed, options)
    kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1)
    assert.equal(p.lines.length, 4)
    assert.ok(COLORS.includes(p.color))
    assert.ok(p.selectedSlot >= 0 && p.selectedSlot <= 8)
    assert.notEqual(p.selectedSlot, p.item?.slot, 'the hand starts empty (Q6)')
    if (p.lines.every((l) => l === '')) emptyStarts++
    const texts = [...p.lines.filter(Boolean), ...p.edits.filter((e) => e.op === 'write').map((e) => e.text)]
    assert.equal(new Set(texts).size, texts.length, 'every line in a round is unique')
    for (const t of texts) {
      const chars = [...t]
      assert.ok(chars.length >= TEXT_MIN && chars.length <= TEXT_MAX, t)
      assert.ok(chars.every((c) => hanzi.has(c) || alnum.test(c)), t)
      assert.ok(chars.some((c) => hanzi.has(c)) && chars.some((c) => alnum.test(c)), t)
    }
    if (p.kind === 'text') {
      assert.equal(p.item, null)
      assert.equal(p.goalColor, p.color)
      assert.equal(p.wax, false)
      assert.ok(p.edits.length >= 1 && p.edits.length <= 3)
      const lines = p.edits.map((e) => e.line)
      assert.deepEqual(lines, [...new Set(lines)].sort((a, b) => a - b))
      const goal = [...p.lines]
      for (const e of p.edits) {
        if (e.op === 'clear') {
          clears++
          assert.notEqual(p.lines[e.line - 1], '', 'only written lines are cleared')
        }
        goal[e.line - 1] = e.op === 'clear' ? '' : e.text
      }
      assert.deepEqual(p.goal, goal)
      assert.notDeepEqual(p.goal, p.lines)
    } else {
      assert.deepEqual(p.goal, p.lines)
      assert.deepEqual(p.edits, [])
      assert.ok(p.item.slot >= 0 && p.item.slot < 36)
      assert.ok(p.item.count >= 32 && p.item.count <= 64)
      if (p.kind === 'color') {
        assert.ok(p.lines.some((l) => l !== ''), 'a dye needs text on the sign (F6)')
        assert.notEqual(p.goalColor, p.color)
        assert.equal(p.item.id, dyeOf(p.goalColor))
        assert.equal(p.wax, false)
      } else {
        assert.equal(p.item.id, HONEYCOMB)
        assert.equal(p.goalColor, p.color)
        assert.equal(p.wax, true)
      }
    }
  }
  assert.deepEqual([...kinds.keys()].sort(), ['color', 'text', 'wax'])
  assert.ok([...kinds.values()].every((n) => n > 80), JSON.stringify([...kinds]))
  assert.ok(clears > 0 && emptyStarts > 0)
  assert.deepEqual(sampleSignRound(7, options), sampleSignRound(7, options))
  assert.ok([...Array(50).keys()].every((s) => sampleSignRound(s, signOptions({ kind: 'wax' })).kind === 'wax'))
})

test('sign judge: lines, colour, wax, blank back and a closed editor; editing, text, color, wax, back, cursor, dropped; lost; doomed when waxed after a change (Q8)', () => {
  const { judgeSign, doomedReason, editsText } = signModule
  const picked = { kind: 'text', lines: ['a', '', 'c', ''], goal: ['A', '', '', ''], color: 'red', goalColor: 'red', wax: false, edits: [{ line: 1, op: 'write', text: 'A' }, { line: 3, op: 'clear' }] }
  const sign = (over = {}) => ({ front: { lines: ['A', '', '', ''], color: 'red', glow: false }, back: blankBack(), waxed: false, editing: false, ...over })
  const judgeWith = (final, extra = {}) => judgeSign({ stopped: false, timedOut: false, taskState: 'done', picked, final: { sign: sign(), carried: {}, dropped: {}, stationIntact: true, ...final }, ...extra })
  assert.deepEqual(judgeWith({}), { outcome: 'success', reached: true, faults: [] })
  assert.deepEqual(judgeWith({ sign: sign({ editing: true }) }), { outcome: 'false_success', reached: false, faults: ['editing'] })
  assert.deepEqual(judgeWith({ sign: sign({ front: { lines: ['a', '', 'c', ''], color: 'red', glow: false } }) }).faults, ['text'])
  assert.deepEqual(judgeWith({ sign: sign({ front: { lines: ['A', '', '', ''], color: 'blue', glow: false } }) }).faults, ['color'])
  assert.deepEqual(judgeWith({ sign: sign({ waxed: true }) }).faults, ['wax'])
  assert.deepEqual(judgeWith({ sign: sign({ back: { lines: ['x', '', '', ''], color: 'black', glow: false } }) }).faults, ['back'])
  assert.deepEqual(judgeWith({ carried: { 'minecraft:red_dye': 1 } }).faults, ['cursor'])
  assert.equal(judgeWith({ dropped: { 'minecraft:red_dye': 3 } }).outcome, 'success', 'leftover items do not matter (Q8)')
  assert.deepEqual(judgeWith({ dropped: { 'minecraft:red_dye': 3 } }, { taskState: 'failed' }).faults, ['dropped'])
  assert.equal(judgeWith({ sign: sign({ front: { lines: ['A', '', '', ''], color: 'red', glow: true } }) }).outcome, 'success', 'glow is not judged')
  assert.equal(judgeWith({ sign: null, stationIntact: false }).outcome, 'lost')
  assert.equal(judgeWith({}, { taskState: 'failed' }).outcome, 'failed')
  assert.equal(judgeWith({ sign: sign({ editing: true }) }, { timedOut: true, taskState: 'running' }).outcome, 'timeout')
  assert.equal(judgeWith({}, { stopped: true }).outcome, 'aborted')

  const wax = { kind: 'wax', lines: ['a', '', '', ''], goal: ['a', '', '', ''], color: 'red', goalColor: 'red', wax: true, edits: [] }
  assert.equal(doomedReason(wax, { sign: sign({ front: { lines: ['a', '', '', ''], color: 'red', glow: false }, waxed: true }) }), null, 'waxing the untouched sign is the goal')
  assert.equal(doomedReason(wax, { sign: sign({ front: { lines: ['b', '', '', ''], color: 'red', glow: false }, waxed: false }) }), null, 'not waxed yet: still fixable')
  assert.match(doomedReason(wax, { sign: sign({ front: { lines: ['b', '', '', ''], color: 'red', glow: false }, waxed: true }) }), /涂了蜡，但正面文字不是目标/)
  assert.equal(doomedReason(wax, { sign: null }), null)
  const doomed = judgeSign({ stopped: false, timedOut: false, taskState: 'failed', picked: wax, final: { sign: sign({ front: { lines: ['b', '', '', ''], color: 'red', glow: false }, waxed: true }), carried: {}, dropped: {} }, doomed: { reason: 'x', at: 1 } })
  assert.deepEqual(doomed, { outcome: 'failed', reached: false, faults: ['text', 'wax'] })

  assert.equal(editsText(picked), '- 正面第 1 行改成「A」；\n- 正面第 3 行清空。')
  assert.equal(editsText({ kind: 'color', goalColor: 'light_blue' }), '- 物品栏里有 minecraft:light_blue_dye，用它把正面文字的颜色改成淡蓝色。')
  assert.equal(editsText(wax), '- 物品栏里有 minecraft:honeycomb，用它给告示牌涂蜡。')
})

function signHarness({ plan = 'do', aimOk = true, badState = false } = {}) {
  const world = { params: null, state: {} }
  const script = ({ req, executor, clock, setBusy }) => setImmediate(async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    await tick()
    req.closed = true
    req.answered = true
    executor.task = { taskId: req.taskId, state: 'running' }
    executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
    for (let i = 0; i < 3; i++) await tick()
    const goal = world.params.expect.sign
    if (plan === 'scribble-then-wax') {
      // 先改了字再涂蜡：训练器在下一次轮询时发现并中止
      world.state.sign = { ...world.state.sign, front: { ...world.state.sign.front, lines: ['zz', '', '', ''] }, waxed: true }
      while (executor.task.state === 'running') await tick()
      return
    }
    if (plan === 'do') {
      world.state.sign = { front: { lines: goal.lines, color: goal.color, glow: false }, back: blankBack(), waxed: goal.waxed, editing: false }
      world.state.reachedAtMs = clock()
    }
    for (let i = 0; i < 3; i++) await tick()
    executor.task.state = 'done'
    setBusy(2)
    executor.emit('task', { taskId: req.taskId, state: 'done', version: 2 })
  })
  const h = harness({
    script, arenas: ARENAS_SIGN,
    prepareData: (params) => {
      world.params = params
      const state = { front: { lines: badState ? ['?', '', '', ''] : params.sign.lines, color: params.sign.color, glow: false }, back: blankBack(), waxed: false, editing: false }
      world.state = { sign: state, held: {}, carried: {}, dropped: {}, selectedSlot: params.selectedSlot, stationIntact: true, reachedAtMs: null }
      return { aimOk, station: 'sign', sign: { state, items: params.items.map(({ slot, id, count }) => ({ slot, id, count })), selectedSlot: params.selectedSlot } }
    },
    statusData: () => world.state
  })
  return { ...h, world }
}

test('sign run: prepare carries the opening sign, items, the empty hand and the goal; the text only states the goal (Q10); doing it succeeds', async () => {
  const { COLOR_NAMES } = signModule
  const h = signHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'sign', runs: 9, seed: 5 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /kind=随机，edits=1-3（只用于 text 题）/)
  await h.done()
  const records = h.records('sign')
  assert.equal(records.length, 9)
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  const kinds = new Set()
  for (const [i, record] of records.entries()) {
    kinds.add(record.kind)
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.deepEqual([record.faults, record.doomed, record.reached], [[], null, true])
    const p = prepares[i]
    assert.equal(p.station, 'sign')
    assert.deepEqual(p.sign, { lines: record.lines, color: record.color.from })
    assert.deepEqual(p.expect, { sign: { lines: record.goal, color: record.color.to, waxed: record.wax } })
    assert.deepEqual(p.items, record.items)
    assert.equal(p.selectedSlot, record.selectedSlot)
    const text = h.instructions[i]
    assert.ok(text.startsWith('你正前方有一个告示牌。请按下面的要求修改它：\n'), text)
    assert.ok(text.trimEnd().endsWith('没有提到的保持原样。'), text)
    if (record.kind === 'text') for (const e of record.edits) assert.ok(text.includes(e.op === 'clear' ? `- 正面第 ${e.line} 行清空` : `- 正面第 ${e.line} 行改成「${e.text}」`), text)
    if (record.kind === 'color') assert.ok(text.includes(`- 物品栏里有 minecraft:${record.color.to}_dye，用它把正面文字的颜色改成${COLOR_NAMES[record.color.to]}。`), text)
    if (record.kind === 'wax') assert.ok(text.includes('- 物品栏里有 minecraft:honeycomb，用它给告示牌涂蜡。'), text)
    if (record.kind === 'text') assert.doesNotMatch(text, /minecraft:|物品栏/, 'Q10: text rounds name no items')
    assert.doesNotMatch(text, /右键|sign\/|方向键/, 'Q10: no how-to')
    assert.ok(!text.includes('\r'))
  }
  assert.deepEqual([...kinds].sort(), ['color', 'text', 'wax'])
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/9 轮：会话 run-1，告示牌 (text|color|wax)/)
})

test('sign run: waxing after changing the text is caught while polling and judged failed (doomed); setup mismatches stop the batch; option checks', async () => {
  const doomedRun = signHarness({ plan: 'scribble-then-wax' })
  assert.equal(doomedRun.trainer.start({ sessionId: 'console', arena: 'sign', kind: 'wax', seed: 2 }).ok, true)
  await doomedRun.done()
  const [rec] = doomedRun.records('sign')
  assert.equal(rec.outcome, 'failed', JSON.stringify(rec))
  assert.equal(rec.doomed, 'waxed-changed')
  assert.equal(typeof rec.doomedMs, 'number')
  assert.ok(rec.faults.includes('text') && rec.faults.includes('wax'), JSON.stringify(rec.faults))

  const lazy = signHarness({ plan: 'nothing' })
  assert.equal(lazy.trainer.start({ sessionId: 'console', arena: 'sign', kind: 'color', seed: 4 }).ok, true)
  await lazy.done()
  const lazyRec = lazy.records('sign')[0]
  assert.deepEqual([lazyRec.outcome, lazyRec.faults], ['false_success', ['color']])

  const off = signHarness({ aimOk: false })
  assert.equal(off.trainer.start({ sessionId: 'console', arena: 'sign', runs: 3 }).ok, true)
  await off.done()
  assert.equal(off.records('sign').length, 1)
  assert.match(off.records('sign')[0].error, /crosshair is not on the sign/)

  const bad = signHarness({ badState: true })
  assert.equal(bad.trainer.start({ sessionId: 'console', arena: 'sign', kind: 'wax', seed: 1 }).ok, true)
  await bad.done()
  assert.match(bad.records('sign')[0].error, /告示牌的开局内容和题目不一致/)

  const h = signHarness()
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'sign', item: 'stick' }).error, /告示牌题没有 item= 选项/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'sign', books: '2' }).error, /不认这些选项：books/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'sign', kind: 'wax', edits: '2' }).error, /edits= 只用于 text 题/)
})

test('report: sign records group by kind / edits with doomed and a column per fault', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (kind, outcome, faults = [], edits = [], doomed = null) => ({ batch: 'b1', target: 'x', kind, lines: ['', '', '', ''], goal: ['', '', '', ''], edits, color: { from: 'red', to: 'red' }, wax: kind === 'wax', items: [], selectedSlot: 0, doomed, faults, outcome, reachedMs: 4000, taskMs: 6000, tokens: null, usedChatSend: false, stationIntact: true })
  const records = [rec('text', 'success', [], [{ line: 1 }]), rec('text', 'false_success', ['editing'], [{ line: 1 }, { line: 2 }]), rec('color', 'false_success', ['color']), rec('wax', 'failed', ['text', 'wax'], [], 'waxed-changed')]
  const byKind = summarize(records, { by: 'kind' })
  assert.equal(byKind.signer, true)
  assert.deepEqual(byKind.rows.map((r) => [r.key, r.runs]).sort(), [['color', 1], ['text', 2], ['wax', 1]])
  assert.deepEqual(byKind.total.signFaults, { editing: 1, text: 1, color: 1, wax: 1, back: 0, cursor: 0, dropped: 0 })
  assert.equal(byKind.total.doomedRuns, 1)
  assert.match(formatSummary(byKind).split('\n')[0], /^题型\t轮数\t成功率\t虚报\t失败\t超时\t中止\t丢失\t涂蜡后改不了\t编辑框没关\t文字不对\t颜色不对\t蜡不对\t改了背面\t光标上有东西\t扔在地上\t达成中位/)
  assert.deepEqual(summarize(records, { by: 'edits' }).rows.map((r) => r.key).sort(), ['1 行', '2 行', '—'].sort())
  assert.match(formatSummary(summarize(records, { by: 'edits' })).split('\n')[0], /^改几行\t/)
})

// ── 弓箭训练场（docs/弓箭训练场设计方案.md）──────────────────────────────

const bowModule = await import('../src/training/bow.js')
const BOW_ORIGIN = [0, 100, 0]
const ARENAS_BOW = { bow: { type: 'bow', origin: BOW_ORIGIN, timeoutSec: 600, targets: '1-4', dist: '8-40', exclude: [] } }
const deg = (rad) => (rad * 180) / Math.PI

test('bow options: targets 1–4, dist a-b within 2–60 (§5.2); config defaults and checks; parseTrainArgs takes dist', () => {
  const { bowOptions } = bowModule
  assert.deepEqual(bowOptions({}, {}), { targets: { lo: 1, hi: 4 }, dist: { lo: 8, hi: 40 }, weapon: 'bow' })
  assert.deepEqual(bowOptions({ targets: '2', dist: '10-20' }, { targets: '1-4', dist: '8-40' }), { targets: { lo: 2, hi: 2 }, dist: { lo: 10, hi: 20 }, weapon: 'bow' })
  assert.throws(() => bowOptions({ targets: '5' }), /targets 要写 k 或 a-b（1–4/)
  for (const bad of ['1-10', '10-10', '20-10', '10', '8-61']) assert.throws(() => bowOptions({ dist: bad }), /dist 要写 a-b（2–60，a < b）/, bad)
  const config = normalizeConfig({})
  assert.deepEqual(config.training.arenas.bow, { type: 'bow', origin: [10300, 120, 10000], timeoutSec: 600, targets: '1-4', dist: '8-40', rodDist: '3-10', weapon: 'bow', exclude: [] })
  assert.deepEqual(normalizeConfig({ training: { arenas: { range: { type: 'bow', origin: [0, 100, 0] } } } }).training.arenas.range, { type: 'bow', origin: [0, 100, 0], targets: '1-4', dist: '8-40', rodDist: '3-10', weapon: 'bow', exclude: [] })
  assert.throws(() => normalizeConfig({ training: { arenas: { range: { type: 'bow', origin: [0, 100, 0], dist: '1-5' } } } }), /training\.arenas\.range\.dist 要写 a-b/)
  assert.equal(parseTrainArgs(['bow', 'targets=2', 'dist=10-30']).dist, '10-30')
  assert.match(parseTrainArgs(['bow', 'dist=5']).error, /dist 要写 a-b/)
})

test('bow ballistics: same per-tick order as vanilla (move, ×0.99, −0.05); pitch for flat shots; face checks — visible, reachable, entered through that face, not too oblique, clear of other targets and the platform (Q3, F2–F5)', () => {
  const { solvePitch, heightAt, faceOk, segmentBox, spawnPoint, eyePoint, faceCenter, planeError } = bowModule
  // 与设计文档 F5 的模拟一致：水平 8 / 16 / 32 / 48 格平射要抬高 0.85° / 2.17° / 5.02° / 8.18°
  assert.deepEqual([8, 16, 32, 48].map((d) => deg(solvePitch(d, 0)).toFixed(2)), ['0.85', '2.17', '5.02', '8.18'])
  assert.ok(Math.abs(heightAt(solvePitch(32, 0), 32)) < 1e-6)
  assert.equal(solvePitch(130, 0), null, '同一高度最远约 116 格')
  // 第一 tick 走满 3 格，之后乘 0.99、竖直减 0.05
  assert.ok(Math.abs(heightAt(0, 3)) < 1e-12 && Math.abs(heightAt(0, 3 + 2.97) - -0.05) < 1e-12)
  assert.deepEqual(spawnPoint(BOW_ORIGIN), [0.5, 100 + 1 + 1.62 - 0.1, 0.5])
  assert.deepEqual(eyePoint(BOW_ORIGIN), [0.5, 102.62, 0.5])
  assert.deepEqual(faceCenter([20, 102, 0], 'west'), [20, 102.5, 0.5])
  assert.equal(planeError([0, 0.2, -0.3], 'west'), 0.3)
  assert.deepEqual(segmentBox([0, 0.5, 0.5], [2, 0.5, 0.5], [1, 0, 0], [2, 1, 1]), { t: 0.5, face: 'west' })
  assert.equal(segmentBox([0, 2, 0.5], [2, 2, 0.5], [1, 0, 0], [2, 1, 1]), null)
  // 正前方 20 格、眼睛高度附近：朝玩家的 west 面可以；背面 east、看不到的 north 不行
  assert.equal(faceOk(BOW_ORIGIN, [20, 102, 0], 'west'), true)
  assert.equal(faceOk(BOW_ORIGIN, [20, 102, 0], 'east'), false)
  assert.equal(faceOk(BOW_ORIGIN, [20, 102, 0], 'north'), false)
  // 正前方挡着另一个标靶就不行
  assert.equal(faceOk(BOW_ORIGIN, [20, 102, 0], 'west', [[10, 102, 0]]), false)
  // 头顶上方较远处的底面：看得到，但箭飞到那里已经在往下落，碰不到
  assert.equal(faceOk(BOW_ORIGIN, [45, 104, 0], 'down'), false)
  // 几乎侧着看的面（夹角超过 70°）不行
  assert.equal(faceOk(BOW_ORIGIN, [30, 102, 3], 'north'), false)
  // 太靠平台侧面：弹道要擦过护栏
  assert.equal(faceOk(BOW_ORIGIN, [2, 102, -20], 'west'), false)
})

test('bow sampler: 1–4 targets inside the field, distance in range, at least 3 apart, every face passes the checks against the others; a bow and n arrows in two random slots, empty hand; reproducible (Q2–Q4)', () => {
  const { sampleBowRound, bowOptions, faceOk, FIELD, BOW, ARROW } = bowModule
  const options = bowOptions({}, {})
  const counts = new Set()
  for (let seed = 0; seed < 40; seed++) {
    const r = sampleBowRound(seed, options, BOW_ORIGIN)
    counts.add(r.targets.length)
    for (const [i, t] of r.targets.entries()) {
      const rel = t.pos.map((c, k) => c - BOW_ORIGIN[k])
      assert.ok(rel[0] >= FIELD.x[0] && rel[0] <= FIELD.x[1] && rel[1] >= FIELD.y[0] && rel[1] <= FIELD.y[1] && rel[2] >= FIELD.z[0] && rel[2] <= FIELD.z[1], JSON.stringify(t))
      assert.ok(t.dist >= 8 - 0.05 && t.dist <= 40 + 0.05, String(t.dist))
      const others = r.targets.filter((_, j) => j !== i).map((o) => o.pos)
      assert.ok(others.every((o) => Math.max(...o.map((c, k) => Math.abs(c - t.pos[k]))) >= 3))
      assert.equal(faceOk(BOW_ORIGIN, t.pos, t.face, others), true, JSON.stringify(t))
    }
    const [bowItem, arrows] = r.items
    assert.deepEqual([bowItem.id, bowItem.count, arrows.id, arrows.count], [BOW, 1, ARROW, r.targets.length])
    assert.notEqual(bowItem.slot, arrows.slot)
    assert.ok(r.selectedSlot >= 0 && r.selectedSlot <= 8 && r.selectedSlot !== bowItem.slot && r.selectedSlot !== arrows.slot)
    assert.deepEqual(sampleBowRound(seed, options, BOW_ORIGIN), r)
  }
  assert.deepEqual([...counts].sort(), [1, 2, 3, 4])
  const near = sampleBowRound(3, bowOptions({ targets: '4', dist: '8-12' }), BOW_ORIGIN)
  assert.ok(near.targets.length === 4 && near.targets.every((t) => t.dist <= 12.05))
})

/** mod 登记的一支箭：hit 落在目标点附近；out 从目标面前方穿过平面（偏 0.4 格）飞出去 */
function bowArrow(n, t, i, result, { at = 0, crit = true } = {}) {
  const normal = bowModule.NORMALS[t.face]
  const side = normal[1] === 0 ? [0, 0.4, 0] : [0.4, 0, 0]
  const before = t.point.map((c, k) => c + normal[k] * 5 + side[k])
  const after = t.point.map((c, k) => c - normal[k] * 5 + side[k])
  const base = { n, ms: at, crit, from: [0.5, 102.52, 0.5], velocity: [2.9, 0.2, 0.1], playerPos: [0.5, 101, 0.5], rotation: { yaw: -88, pitch: -4 }, result, resultMs: at + 300 }
  if (result === 'hit') {
    const point = t.point.map((c, k) => c + (normal[k] === 0 ? 0.1 : 0))
    return { ...base, block: t.pos, face: t.face, point, target: i, err: 0.1, offset: point.map((c, k) => c - t.point[k]), path: [before, point] }
  }
  return { ...base, path: [before, after] }
}

function bowHarness({ plan = 'do' } = {}) {
  const world = { params: null, state: {} }
  const reflects = []
  const script = ({ req, executor, clock, setBusy }) => setImmediate(async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    await tick()
    req.closed = true
    req.answered = true
    executor.task = { taskId: req.taskId, state: 'running' }
    executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
    for (let i = 0; i < 3; i++) await tick()
    const bow = world.state.bow
    const shoot = (i, result, extra) => {
      bow.arrows.push(bowArrow(bow.arrows.length + 1, world.targets[i], i, result, { at: clock(), ...extra }))
      if (world.ammo) world.state.held[world.ammo] -= 1
      if (result === 'hit') bow.targets[i].hit = true
    }
    if (plan === 'do') {
      world.targets.forEach((_, i) => shoot(i, 'hit'))
      world.state.reachedAtMs = clock()
    } else if (plan === 'miss-all') {
      // 每一支都飞出去：箭用完了还没全中，训练器在下一次轮询时发现并中止
      world.targets.forEach((_, i) => shoot(i, 'out'))
      while (executor.task.state === 'running') await tick()
      return
    } else if (plan === 'walk-off') {
      bow.leftPlatformAtMs = clock()
      while (executor.task.state === 'running') await tick()
      return
    } else if (plan === 'weak-then-claim') {
      shoot(0, 'weak', { crit: false })
    } else if (plan === 'load-then-claim') {
      // 弩（第三稿 Q17）：装上一支箭，没射就报完成
      world.state.held['minecraft:arrow'] -= 1
      world.state.loaded = { 'minecraft:arrow': 1 }
    }
    for (let i = 0; i < 3; i++) await tick()
    executor.task.state = 'done'
    setBusy(2)
    executor.emit('task', { taskId: req.taskId, state: 'done', version: 2 })
  })
  const h = harness({
    script, arenas: ARENAS_BOW,
    prepareData: (params) => {
      world.params = params
      world.targets = params.bow.targets.map((t) => ({ ...t, point: bowModule.faceCenter(t.pos, t.face) }))
      const held = {}
      for (const it of params.items) held[it.id] = (held[it.id] ?? 0) + it.count
      // 钓竿（第五稿 Q29）没有弹药，次数由 mod 登记的抛竿数算
      world.ammo = held['minecraft:trident'] ? 'minecraft:trident' : held['minecraft:fishing_rod'] ? null : 'minecraft:arrow'
      world.state = {
        bow: { targets: world.targets.map((t) => ({ pos: t.pos, face: t.face, point: t.point, hit: false })), arrows: [], flying: 0, leftPlatformAtMs: null },
        held, carried: {}, dropped: {}, selectedSlot: params.selectedSlot, stationIntact: true, reachedAtMs: null
      }
      return { bow: { targets: params.bow.targets, items: params.items.map(({ slot, id, count }) => ({ slot, id, count })), selectedSlot: params.selectedSlot } }
    },
    statusData: () => world.state
  })
  h.trainer.bridge.holdReflect = (taskId) => reflects.push(['hold', taskId])
  h.trainer.bridge.releaseReflect = (taskId, text) => reflects.push(['release', taskId, text])
  return { ...h, world, reflects }
}

test('bow run: prepare carries the targets, the bow and n arrows, the empty hand and the goal; the text names the points and the rules only (Q5); hitting every target succeeds and the debrief goes to the held reflect (Q13)', async () => {
  const h = bowHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'bow', runs: 4, seed: 7 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /targets=1-4，dist=8-40/)
  await h.done()
  const records = h.records('bow')
  assert.equal(records.length, 4)
  const prepares = h.calls.filter(([m]) => m === 'arena/prepare').map(([, p]) => p)
  for (const [i, record] of records.entries()) {
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.deepEqual([record.faults, record.doomed, record.reached, record.hits], [[], null, true, record.targets.length])
    assert.deepEqual(record.hitTargets, record.targets.map((_, k) => k))
    assert.ok(record.arrows.every((a) => a.result === 'hit' && a.err === 0.1 && !('path' in a)))
    const p = prepares[i]
    const targets = record.targets.map(({ pos, face }) => ({ pos, face }))
    assert.equal(p.station, 'bow')
    assert.deepEqual(p.bow, { targets })
    assert.deepEqual(p.expect, { bow: { targets } })
    assert.deepEqual(p.items, record.items)
    assert.equal(p.selectedSlot, record.selectedSlot)
    const text = h.instructions[i]
    const n = record.targets.length
    assert.ok(text.startsWith(`你站在一个平台上，前方的空中有 ${n} 个标靶（minecraft:target）。你的物品栏里有一把弓（minecraft:bow）和 ${n} 支箭（minecraft:arrow）。\n`), text)
    for (const t of record.targets) assert.ok(text.includes(`- (${t.point.map((c) => c.toFixed(1)).join(', ')})`), text)
    assert.match(text, /每个点只有一支箭，顺序不限。没拉满射出的箭不算数；离开平台本轮直接结束。/)
    assert.doesNotMatch(text, /west|east|north|south|仰角|抬高|格远|key\/|camera/, 'Q5: no face, distance or how-to')
    assert.ok(!text.includes('\r'))
  }
  // Q13：每轮发任务后登记、判定后交来判定说明
  const holds = h.reflects.filter(([k]) => k === 'hold').map(([, id]) => id)
  const releases = h.reflects.filter(([k]) => k === 'release')
  assert.deepEqual(holds, records.map((r) => r.taskId))
  assert.deepEqual(releases.map(([, id]) => id), holds)
  assert.match(releases[0][2], /^本轮武器：弓（minecraft:bow）。\n本轮结果：success（成功），射中 \d\/\d 个标靶。\n\n标靶：\n- 1 号：目标点 \(/)
  assert.match(releases[0][2], /- 第 1 支：拉满；射出时玩家在 \(0\.50, 101\.00, 0\.50\)，服务端用来射箭的朝向 yaw=-88\.00、pitch=-4\.00；箭从 \(0\.50, 102\.52, 0\.50\) 出发，初速度 \(2\.900, 0\.200, 0\.100\) 格\/tick；结果 hit（射中指定面）：命中方块 /)
  assert.doesNotMatch(releases[0][2], /应该|建议|抬高/, 'Q13: facts only')
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/4 轮：会话 run-1，弓箭：\d 个靶，/)
})

test('bow run: arrows used up without hitting everything and walking off the platform end the round early (doomed); a weak arrow and unshot arrows are faults; misses get the nearest target plane; option checks (Q6, Q7)', async () => {
  const missed = bowHarness({ plan: 'miss-all' })
  assert.equal(missed.trainer.start({ sessionId: 'console', arena: 'bow', targets: '2', seed: 3 }).ok, true)
  await missed.done()
  const [rec] = missed.records('bow')
  assert.equal(rec.outcome, 'failed', JSON.stringify(rec))
  assert.equal(rec.doomed, 'out-of-arrows')
  assert.equal(typeof rec.doomedMs, 'number')
  assert.deepEqual(rec.faults, ['miss'])
  for (const [i, a] of rec.arrows.entries()) {
    assert.equal(a.result, 'out')
    assert.equal(a.nearest.target, i)
    assert.ok(Math.abs(a.nearest.err - 0.4) < 1e-9, JSON.stringify(a.nearest))
  }
  const debrief = missed.reflects.find(([k]) => k === 'release')[2]
  assert.match(debrief, /提前结束：箭用完了还有标靶没射中，本轮提前结束。/)
  assert.match(debrief, /结果 out（飞出场地）；轨迹穿过 1 号标靶指定面所在平面的点 .*，相对目标点偏移 /)

  const walked = bowHarness({ plan: 'walk-off' })
  assert.equal(walked.trainer.start({ sessionId: 'console', arena: 'bow', seed: 4 }).ok, true)
  await walked.done()
  const walkedRec = walked.records('bow')[0]
  assert.deepEqual([walkedRec.outcome, walkedRec.doomed], ['failed', 'left-platform'])
  assert.ok(walkedRec.faults.includes('left-platform') && walkedRec.faults.includes('unshot'))

  const weak = bowHarness({ plan: 'weak-then-claim' })
  assert.equal(weak.trainer.start({ sessionId: 'console', arena: 'bow', targets: '2', seed: 5 }).ok, true)
  await weak.done()
  const weakRec = weak.records('bow')[0]
  assert.deepEqual([weakRec.outcome, weakRec.faults, weakRec.hits], ['false_success', ['miss', 'weak', 'unshot'], 0])
  assert.match(weak.reflects.find(([k]) => k === 'release')[2], /第 1 支：没拉满；.*结果 weak（没拉满，不算数）/)

  const h = bowHarness()
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'bow', item: 'stick' }).error, /弓箭题没有 item= 选项/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'bow', edits: '2' }).error, /不认这些选项：edits/)
  assert.match(h.trainer.start({ sessionId: 'console', arena: 'bow', dist: '30-10' }).error, /dist 要写 a-b/)
})

test('bow judge and doomed: all targets hit → reached; doomed only when the platform was left or no arrows are left anywhere (Q7)', () => {
  const { judgeBow, doomedReason } = bowModule
  const picked = { targets: [{ pos: [20, 102, 0], face: 'west', point: [20, 102.5, 0.5] }, { pos: [25, 102, 5], face: 'west', point: [25, 102.5, 5.5] }] }
  const status = (hits, { held = 0, carried = 0, dropped = 0, flying = 0, left = null, pending = false } = {}) => ({
    bow: { targets: picked.targets.map((t, i) => ({ ...t, hit: i < hits })), arrows: pending ? [{ result: null }] : [], flying, leftPlatformAtMs: left },
    held: { 'minecraft:arrow': held }, carried: { 'minecraft:arrow': carried }, dropped: { 'minecraft:arrow': dropped }, stationIntact: true
  })
  assert.equal(doomedReason(picked, status(1, { held: 1 })), null)
  assert.equal(doomedReason(picked, status(1, { dropped: 1 })), null, '扔在平台上的箭还能捡回来')
  assert.equal(doomedReason(picked, status(1, { flying: 1, pending: true })), null, '还有箭在飞')
  assert.equal(doomedReason(picked, status(2)), null)
  assert.match(doomedReason(picked, status(1)), /箭已经用完/)
  assert.match(doomedReason(picked, status(2, { left: 5 })), /离开了射击平台/)
  assert.deepEqual(judgeBow({ final: status(2), picked, taskState: 'done' }), { outcome: 'success', reached: true, faults: [], hits: 2 })
  assert.deepEqual(judgeBow({ final: status(1, { held: 1 }), picked, taskState: 'done' }), { outcome: 'false_success', reached: false, faults: ['miss', 'unshot'], hits: 1 })
  assert.equal(judgeBow({ final: status(1), picked, taskState: 'failed', timedOut: true }).outcome, 'timeout')
  assert.equal(judgeBow({ final: { ...status(1), stationIntact: false }, picked, taskState: 'done' }).outcome, 'lost')
  assert.equal(judgeBow({ final: status(2), picked, stopped: true }).outcome, 'aborted')
})

test('report: bow records group by targets (rounds) and by dist (one row per target) with doomed, faults, arrow and first-arrow hit rates and the median error (Q11)', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const t = (dist) => ({ pos: [0, 0, 0], face: 'west', point: [0, 0.5, 0.5], dist })
  const rec = (targets, arrows, outcome, { faults = [], doomed = null, hitTargets = [] } = {}) => ({ batch: 'b1', target: `bow:${targets.length}`, targets, arrows, hitTargets, items: [], selectedSlot: 0, hits: hitTargets.length, doomed, faults, outcome, reachedMs: 5000, taskMs: 8000, tokens: null, usedChatSend: false, stationIntact: true })
  const records = [
    rec([t(10)], [{ n: 1, result: 'hit', target: 0, err: 0.1 }], 'success', { hitTargets: [0] }),
    rec([t(20), t(35)], [{ n: 1, result: 'out', nearest: { target: 0, err: 0.6 } }, { n: 2, result: 'hit', target: 1, err: 0.3 }], 'failed', { faults: ['miss'], doomed: 'out-of-arrows', hitTargets: [1] }),
    rec([t(30), t(45)], [{ n: 1, result: 'weak', crit: false }], 'false_success', { faults: ['miss', 'weak', 'unshot'] })
  ]
  const byTargets = summarize(records, { by: 'targets' })
  assert.equal(byTargets.bower, true)
  assert.deepEqual(byTargets.rows.map((r) => [r.key, r.runs]), [['2 个靶', 2], ['1 个靶', 1]])
  assert.deepEqual(byTargets.total.bow, { arrows: 4, arrowHits: 2, weakArrows: 1, firstShots: 3, firstHits: 2, medianErr: 0.3, doomedLeft: 0, doomedOut: 1, faults: { miss: 2, weak: 1, unshot: 1 } })
  const table = formatSummary(byTargets).split('\n')
  assert.match(table[0], /^标靶数\t轮数\t全中率\t虚报\t失败\t超时\t中止\t丢失\t离开平台\t箭用完\t有靶没中\t没拉满\t箭没射完\t箭命中率\t首箭命中率\t偏差中位\t没拉满的箭\t达成中位/)
  assert.match(table.at(-1), /^（合计）\t3\t33%\t1\t1\t0\t0\t0\t0\t1\t2\t1\t1\t50%\t67%\t0\.30\t25%\t/)
  const byDist = summarize(records, { by: 'dist' })
  assert.deepEqual(byDist.rows.map((r) => [r.key, r.targets, r.hit]), [['8–16 格', 1, 1], ['16–24 格', 1, 0], ['24–32 格', 1, 0], ['32–40 格', 1, 1], ['40 格以上', 1, 0]])
  const distTable = formatSummary(byDist).split('\n')
  assert.equal(distTable[0], '距离\t标靶数\t射中率\t首箭命中率\t射向它的箭\t偏差中位')
  assert.equal(distTable.at(-1), '（合计）\t5\t40%\t67%\t3\t0.30')
})

// ── 弩（弓箭训练场设计方案第三稿，Q14–Q20）──────────────────────────────

test('crossbow options: weapon=bow|crossbow|any, default bow from the arena config; parseTrainArgs takes weapon; bad values rejected (Q14, §5.2)', () => {
  const { bowOptions, parseWeaponSpec } = bowModule
  assert.equal(bowOptions({ weapon: 'crossbow' }, {}).weapon, 'crossbow')
  assert.equal(bowOptions({}, { weapon: 'any' }).weapon, 'any')
  assert.equal(bowOptions({ weapon: 'bow' }, { weapon: 'crossbow' }).weapon, 'bow', '命令行优先')
  assert.throws(() => parseWeaponSpec('sword'), /weapon 只能是 bow \/ crossbow \/ trident \/ fishing_rod \/ any/)
  assert.equal(parseTrainArgs(['bow', 'weapon=crossbow']).weapon, 'crossbow')
  assert.match(parseTrainArgs(['bow', 'weapon=sword']).error, /weapon 只能是/)
  assert.throws(() => normalizeConfig({ training: { arenas: { range: { type: 'bow', origin: [0, 100, 0], weapon: 'sword' } } } }), /training\.arenas\.range\.weapon 只能是/)
})

test('crossbow ballistics: speed 3.15 (float) with the same per-tick order; flat-shot pitches match F15; faces are checked at the crossbow speed (Q19)', () => {
  const { solvePitch, heightAt, faceOk, CROSSBOW_SPEED, SPEED, WEAPONS } = bowModule
  assert.equal(CROSSBOW_SPEED, Math.fround(3.15))
  assert.deepEqual([WEAPONS.bow.speed, WEAPONS.crossbow.speed], [SPEED, CROSSBOW_SPEED])
  // 与设计文档 F15 一致：水平 8 / 16 / 32 / 40 / 48 格平射要抬高 0.76° / 1.94° / 4.51° / 5.88° / 7.33°
  assert.deepEqual([8, 16, 32, 40, 48].map((d) => deg(solvePitch(d, 0, CROSSBOW_SPEED)).toFixed(2)), ['0.76', '1.94', '4.51', '5.88', '7.33'])
  assert.ok(Math.abs(heightAt(0, CROSSBOW_SPEED, CROSSBOW_SPEED)) < 1e-12)
  // 弩更平：同一个仰角、同样的距离，弩的箭更高
  assert.ok(heightAt(solvePitch(40, 0), 40, CROSSBOW_SPEED) > 0.3)
  assert.equal(faceOk(BOW_ORIGIN, [20, 102, 0], 'west', [], CROSSBOW_SPEED), true)
})

test('crossbow sampler: weapon=crossbow hands out a crossbow; weapon=bow draws exactly the same rounds as before the crossbow; weapon=any picks either, reproducibly (Q14, Q15, Q19)', () => {
  const { sampleBowRound, bowOptions, faceOk, CROSSBOW, BOW, ARROW, CROSSBOW_SPEED } = bowModule
  const legacy = { targets: { lo: 1, hi: 4 }, dist: { lo: 8, hi: 40 } }
  for (let seed = 0; seed < 10; seed++) {
    const { weapon, ...bowRound } = sampleBowRound(seed, bowOptions({}, {}), BOW_ORIGIN)
    assert.equal(weapon, 'bow')
    const { weapon: _, ...old } = sampleBowRound(seed, legacy, BOW_ORIGIN)
    assert.deepEqual(bowRound, old, '指定弓时不抽武器，同一种子出同一道题')
    const x = sampleBowRound(seed, bowOptions({ weapon: 'crossbow' }, {}), BOW_ORIGIN)
    assert.equal(x.weapon, 'crossbow')
    assert.deepEqual([x.items[0].id, x.items[0].count, x.items[1].id, x.items[1].count], [CROSSBOW, 1, ARROW, x.targets.length])
    for (const [i, t] of x.targets.entries()) assert.equal(faceOk(BOW_ORIGIN, t.pos, t.face, x.targets.filter((_, j) => j !== i).map((o) => o.pos), CROSSBOW_SPEED), true)
  }
  const any = bowOptions({ weapon: 'any' }, {})
  const picks = new Set()
  for (let seed = 0; seed < 20; seed++) {
    const r = sampleBowRound(seed, any, BOW_ORIGIN)
    picks.add(r.weapon)
    assert.equal(r.items[0].id, { bow: BOW, crossbow: CROSSBOW, trident: 'minecraft:trident' }[r.weapon])
    assert.deepEqual(sampleBowRound(seed, any, BOW_ORIGIN), r)
  }
  assert.deepEqual([...picks].sort(), ['bow', 'crossbow', 'trident'])
})

test('crossbow run: a crossbow and n arrows, its own text without the full-draw rule or how to load (Q15, Q16); record, label and debrief name the weapon and skip "fully drawn" (Q20)', async () => {
  const h = bowHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'bow', runs: 2, seed: 11, weapon: 'crossbow' })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /weapon=crossbow，targets=1-4，dist=8-40/)
  await h.done()
  const records = h.records('bow')
  for (const [i, record] of records.entries()) {
    const n = record.targets.length
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.deepEqual([record.weapon, record.target], ['crossbow', `crossbow:${n}`])
    assert.equal(record.items.find((it) => it.id === 'minecraft:crossbow')?.count, 1)
    const text = h.instructions[i]
    assert.ok(text.startsWith(`你站在一个平台上，前方的空中有 ${n} 个标靶（minecraft:target）。你的物品栏里有一把弩（minecraft:crossbow）和 ${n} 支箭（minecraft:arrow）。\n请站在平台上用弩射箭，`), text)
    assert.match(text, /每个点只有一支箭，顺序不限。离开平台本轮直接结束。\n?$/)
    assert.doesNotMatch(text, /拉满|装填|key\/|按住/, 'Q16: no full-draw rule, no how-to')
    assert.ok(!text.includes('\r'))
  }
  const debrief = h.reflects.find(([k]) => k === 'release')[2]
  assert.match(debrief, /^本轮武器：弩（minecraft:crossbow）。\n本轮结果：success/)
  assert.match(debrief, /- 第 1 支；射出时玩家在 /)
  assert.doesNotMatch(debrief, /拉满/)
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/2 轮：会话 run-1，弩：\d 个靶，/)
})

test('crossbow arrows: an arrow loaded in a crossbow still counts as left (no out-of-arrows) and as unshot; the debrief says how many are still loaded (Q17, F18)', async () => {
  const { doomedReason, judgeBow, arrowsLeft } = bowModule
  const picked = { weapon: 'crossbow', targets: [{ pos: [20, 102, 0], face: 'west', point: [20, 102.5, 0.5] }] }
  const status = { bow: { targets: [{ ...picked.targets[0], hit: false }], arrows: [], flying: 0, leftPlatformAtMs: null }, held: { 'minecraft:crossbow': 1 }, carried: {}, dropped: {}, loaded: { 'minecraft:arrow': 1 }, stationIntact: true }
  assert.equal(arrowsLeft(status), 1)
  assert.equal(doomedReason(picked, status), null, '装上最后一支箭不算用完')
  assert.match(doomedReason(picked, { ...status, loaded: {} }), /箭已经用完/)
  assert.deepEqual(judgeBow({ final: status, picked, taskState: 'done' }).faults, ['miss', 'unshot'])

  const h = bowHarness({ plan: 'load-then-claim' })
  assert.equal(h.trainer.start({ sessionId: 'console', arena: 'bow', targets: '1', seed: 5, weapon: 'crossbow' }).ok, true)
  await h.done()
  const rec = h.records('bow')[0]
  assert.deepEqual([rec.outcome, rec.faults, rec.doomed, rec.final.loaded], ['false_success', ['miss', 'unshot'], null, { 'minecraft:arrow': 1 }])
  const debrief = h.reflects.find(([k]) => k === 'release')[2]
  assert.match(debrief, /还有 1 支箭装在弩里没射出。/)
  assert.doesNotMatch(debrief, /物品栏里还有箭没射/)
})

test('report: bow and crossbow records split into one table per weapon; --by weapon gives one row each; the crossbow table has no full-draw columns (Q20)', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const t = (dist) => ({ pos: [0, 0, 0], face: 'west', point: [0, 0.5, 0.5], dist })
  const rec = (weapon, outcome, arrows, hitTargets) => ({ batch: 'b1', target: `${weapon ?? 'bow'}:1`, ...(weapon ? { weapon } : {}), targets: [t(20)], arrows, hitTargets, items: [], selectedSlot: 0, hits: hitTargets.length, doomed: null, faults: outcome === 'success' ? [] : ['miss'], outcome, reachedMs: 4000, taskMs: 6000, tokens: null, usedChatSend: false, stationIntact: true })
  const records = [
    rec(undefined, 'success', [{ n: 1, result: 'hit', target: 0, err: 0.2 }], [0]),
    rec('bow', 'false_success', [{ n: 1, result: 'weak', crit: false }], []),
    rec('crossbow', 'success', [{ n: 1, result: 'hit', target: 0, err: 0.1, weapon: 'minecraft:crossbow' }], [0])
  ]
  const split = summarize(records, { by: 'targets' })
  assert.deepEqual(split.split.map(({ title, summary }) => [title, summary.total.runs]), [['【弓】', 2], ['【弩】', 1]])
  const text = formatSummary(split)
  const [bowPart, crossbowPart] = text.split('\n\n')
  assert.match(bowPart, /^【弓】\n标靶数\t.*\t没拉满\t.*\t没拉满的箭\t/)
  assert.match(crossbowPart, /^【弩】\n标靶数\t轮数\t全中率\t虚报\t失败\t超时\t中止\t丢失\t离开平台\t箭用完\t有靶没中\t箭没射完\t箭命中率\t首箭命中率\t偏差中位\t达成中位/)
  assert.doesNotMatch(crossbowPart, /没拉满/)
  const byDist = formatSummary(summarize(records, { by: 'dist' }))
  assert.match(byDist, /^【弓】\n距离\t.*\n\n【弩】\n距离\t/s)
  const byWeapon = summarize(records, { by: 'weapon' })
  assert.deepEqual(byWeapon.rows.map((r) => [r.key, r.runs]), [['弓', 2], ['弩', 1]])
  assert.match(formatSummary(byWeapon).split('\n')[0], /^武器\t轮数\t全中率/)
  // 只有弓的记录：和加弩之前一样，不分表
  assert.equal(summarize(records.slice(0, 2), { by: 'targets' }).split, undefined)
})

// ── 三叉戟（弓箭训练场设计方案第四稿，Q21–Q26）──────────────────────────

test('trident ballistics and sampler: speed 2.5, flat-shot pitches match F22; n tridents in n distinct random slots, no arrows, empty hand; faces checked at 2.5; bow and crossbow rounds unchanged (Q21, Q22, Q25)', () => {
  const { solvePitch, faceOk, sampleBowRound, bowOptions, TRIDENT, TRIDENT_SPEED, WEAPONS, parseWeaponSpec } = bowModule
  assert.equal(parseWeaponSpec('trident'), 'trident')
  assert.equal(WEAPONS.trident.speed, TRIDENT_SPEED)
  assert.equal(TRIDENT_SPEED, Math.fround(2.5))
  // 与设计文档 F22 一致：水平 8 / 16 / 32 / 40 / 48 格平射要抬高 1.32° / 3.27° / 7.52° / 9.89° / 12.47°
  assert.deepEqual([8, 16, 32, 40, 48].map((d) => deg(solvePitch(d, 0, TRIDENT_SPEED)).toFixed(2)), ['1.32', '3.27', '7.52', '9.89', '12.47'])
  assert.equal(solvePitch(90, 0, TRIDENT_SPEED), null, '同一高度最远约 86 格')
  const options = bowOptions({ weapon: 'trident' }, {})
  for (let seed = 0; seed < 15; seed++) {
    const r = sampleBowRound(seed, options, BOW_ORIGIN)
    const n = r.targets.length
    assert.equal(r.weapon, 'trident')
    assert.equal(r.items.length, n)
    assert.ok(r.items.every((it) => it.id === TRIDENT && it.count === 1 && it.slot >= 0 && it.slot < 36))
    assert.equal(new Set(r.items.map((it) => it.slot)).size, n, '各占一格')
    assert.ok(r.selectedSlot >= 0 && r.selectedSlot <= 8 && !r.items.some((it) => it.slot === r.selectedSlot), '开局手上是空的')
    for (const [i, t] of r.targets.entries()) assert.equal(faceOk(BOW_ORIGIN, t.pos, t.face, r.targets.filter((_, j) => j !== i).map((o) => o.pos), TRIDENT_SPEED), true)
    assert.deepEqual(sampleBowRound(seed, options, BOW_ORIGIN), r)
  }
  // 弓、弩的题不受影响：同一种子和第三稿一样（第三稿的抽题测试也还在跑）
  const legacy = { targets: { lo: 1, hi: 4 }, dist: { lo: 8, hi: 40 } }
  for (let seed = 0; seed < 5; seed++) assert.deepEqual(sampleBowRound(seed, bowOptions({}, {}), BOW_ORIGIN), sampleBowRound(seed, legacy, BOW_ORIGIN))
})

test('trident run: n tridents, its own text without the full-draw rule or how to throw (Q22, Q23); no weak; record, label and debrief speak of tridents (Q26)', async () => {
  const h = bowHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'bow', runs: 2, seed: 21, weapon: 'trident' })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /weapon=trident，/)
  await h.done()
  const records = h.records('bow')
  for (const [i, record] of records.entries()) {
    const n = record.targets.length
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.deepEqual([record.weapon, record.target, record.faults], ['trident', `trident:${n}`, []])
    assert.equal(record.items.filter((it) => it.id === 'minecraft:trident').length, n)
    assert.ok(!record.items.some((it) => it.id === 'minecraft:arrow'))
    const text = h.instructions[i]
    assert.ok(text.startsWith(`你站在一个平台上，前方的空中有 ${n} 个标靶（minecraft:target）。你的物品栏里有 ${n} 把三叉戟（minecraft:trident）。\n请站在平台上投掷三叉戟，让三叉戟分别命中下面 ${n} 个点：\n`), text)
    assert.match(text, /每个点只有一把三叉戟，顺序不限。离开平台本轮直接结束。\n?$/)
    assert.doesNotMatch(text, /拉满|按住|tick|key\/|抬高/, 'Q23: no full-draw rule, no how-to')
    assert.ok(!text.includes('\r'))
  }
  const debrief = h.reflects.find(([k]) => k === 'release')[2]
  assert.match(debrief, /^本轮武器：三叉戟（minecraft:trident）。\n本轮结果：success/)
  assert.match(debrief, /每一把三叉戟（按掷出的顺序）：\n- 第 1 把；掷出时玩家在 .*，服务端用来投掷的朝向 .*；三叉戟从 /)
  assert.doesNotMatch(debrief, /拉满|箭/)
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/2 轮：会话 run-1，三叉戟：\d 个靶，/)
})

test('trident judge: tridents are the ammo — doomed when none are left anywhere, unshot when some are still held; arrows and loaded do not count; a non-crit trident is no weak fault (Q24, Q26)', async () => {
  const { doomedReason, judgeBow, arrowsLeft, debriefText } = bowModule
  const picked = { weapon: 'trident', targets: [{ pos: [20, 102, 0], face: 'west', point: [20, 102.5, 0.5] }, { pos: [25, 102, 5], face: 'west', point: [25, 102.5, 5.5] }] }
  const status = (hits, { held = {}, dropped = {}, flying = 0, loaded = {} } = {}) => ({
    bow: { targets: picked.targets.map((t, i) => ({ ...t, hit: i < hits })), arrows: [{ n: 1, crit: false, weapon: 'minecraft:trident', result: hits ? 'hit' : 'out' }], flying, leftPlatformAtMs: null },
    held, carried: {}, dropped, loaded, stationIntact: true
  })
  assert.equal(arrowsLeft(status(1, { held: { 'minecraft:trident': 1, 'minecraft:arrow': 5 } }), 'trident'), 1)
  assert.equal(doomedReason(picked, status(1, { held: { 'minecraft:trident': 1 } })), null)
  assert.equal(doomedReason(picked, status(1, { dropped: { 'minecraft:trident': 1 } })), null, '扔在平台上的三叉戟还能捡回来')
  assert.match(doomedReason(picked, status(1, { held: { 'minecraft:arrow': 3 }, loaded: { 'minecraft:arrow': 1 } })), /三叉戟已经用完，还有标靶没命中/)
  assert.deepEqual(judgeBow({ final: status(1, { held: { 'minecraft:trident': 1 } }), picked, taskState: 'done' }).faults, ['miss', 'unshot'])
  assert.deepEqual(judgeBow({ final: status(1), picked, taskState: 'done', doomed: { at: 1 } }).faults, ['miss'], '不是暴击也不判 weak')
  const text = debriefText({ weapon: 'trident', outcome: 'false_success', hits: 1, targets: picked.targets, hitTargets: [0], arrows: [], faults: ['miss', 'unshot'], doomed: null, final: { held: { 'minecraft:trident': 1 }, carried: {}, loaded: { 'minecraft:arrow': 1 } } })
  assert.match(text, /报完成时物品栏里还有 1 把三叉戟没掷出。/)
  assert.doesNotMatch(text, /装在弩里/, '三叉戟不算装填')
  assert.match(text, /没有掷出任何三叉戟。/)
  assert.match(debriefText({ weapon: 'trident', outcome: 'failed', hits: 0, targets: picked.targets, arrows: [], doomed: 'out-of-arrows', faults: ['miss'], final: {} }), /提前结束：三叉戟用完了还有标靶没命中，本轮提前结束。/)

  // 整轮：每一投都飞出去，三叉戟用完立刻结束
  const missed = bowHarness({ plan: 'miss-all' })
  assert.equal(missed.trainer.start({ sessionId: 'console', arena: 'bow', targets: '2', seed: 3, weapon: 'trident' }).ok, true)
  await missed.done()
  const [rec] = missed.records('bow')
  assert.deepEqual([rec.outcome, rec.doomed, rec.faults], ['failed', 'out-of-arrows', ['miss']])
})

test('report: three weapons split into three tables; --by weapon gives three rows; the trident table has no full-draw columns and names its columns after tridents (Q26)', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const t = (dist) => ({ pos: [0, 0, 0], face: 'west', point: [0, 0.5, 0.5], dist })
  const rec = (weapon, outcome, hitTargets) => ({ batch: 'b1', target: `${weapon}:1`, weapon, targets: [t(20)], arrows: hitTargets.length ? [{ n: 1, result: 'hit', target: 0, err: 0.2 }] : [], hitTargets, items: [], selectedSlot: 0, hits: hitTargets.length, doomed: null, faults: outcome === 'success' ? [] : ['miss'], outcome, reachedMs: 4000, taskMs: 6000, tokens: null, usedChatSend: false, stationIntact: true })
  const records = [rec('bow', 'success', [0]), rec('crossbow', 'success', [0]), rec('trident', 'success', [0]), rec('trident', 'false_success', [])]
  const split = summarize(records, { by: 'targets' })
  assert.deepEqual(split.split.map(({ title, summary }) => [title, summary.total.runs]), [['【弓】', 1], ['【弩】', 1], ['【三叉戟】', 2]])
  const parts = formatSummary(split).split('\n\n')
  assert.equal(parts.length, 3)
  assert.match(parts[0], /^【弓】\n标靶数\t.*\t箭用完\t有靶没中\t没拉满\t箭没射完\t箭命中率\t/)
  assert.match(parts[1], /^【弩】\n标靶数\t.*\t箭用完\t有靶没中\t箭没射完\t箭命中率\t/)
  assert.match(parts[2], /^【三叉戟】\n标靶数\t轮数\t全中率\t虚报\t失败\t超时\t中止\t丢失\t离开平台\t三叉戟用完\t有靶没中\t三叉戟没掷完\t命中率\t首箭命中率\t偏差中位\t达成中位/)
  assert.doesNotMatch(parts[2], /没拉满|箭用完|箭没射完/)
  assert.deepEqual(summarize(records, { by: 'weapon' }).rows.map((r) => [r.key, r.runs]), [['三叉戟', 2], ['弓', 1], ['弩', 1]])
})

// ── 钓竿（弓箭训练场设计方案第五稿，Q27–Q34）──────────────────────────────

test('fishing rod options: weapon=fishing_rod, dist from rodDist (default 3-10) unless dist= is given, capped at 16; any never draws the rod; config checks rodDist (Q27, Q28)', () => {
  const { bowOptions, parseWeaponSpec, sampleBowRound } = bowModule
  assert.equal(parseWeaponSpec('fishing_rod'), 'fishing_rod')
  assert.deepEqual(bowOptions({ weapon: 'fishing_rod' }, {}), { targets: { lo: 1, hi: 4 }, dist: { lo: 3, hi: 10 }, weapon: 'fishing_rod' })
  assert.deepEqual(bowOptions({}, { weapon: 'fishing_rod', dist: '8-40', rodDist: '4-8' }).dist, { lo: 4, hi: 8 }, '钓竿不用 dist 的场地配置')
  assert.deepEqual(bowOptions({ weapon: 'fishing_rod', dist: '6-12' }, { rodDist: '4-8' }).dist, { lo: 6, hi: 12 }, '命令行的 dist= 优先')
  assert.deepEqual(bowOptions({}, { rodDist: '4-8' }).dist, { lo: 8, hi: 40 }, '弓不看 rodDist')
  assert.throws(() => bowOptions({ weapon: 'fishing_rod', dist: '8-20' }), /钓竿的 dist 要写 a-b（2–16，a < b）/)
  assert.throws(() => bowOptions({ weapon: 'fishing_rod' }, { rodDist: '3-30' }), /rodDist 要写 a-b（2–16/)
  assert.equal(parseTrainArgs(['bow', 'weapon=fishing_rod', 'dist=4-9']).weapon, 'fishing_rod')
  assert.throws(() => normalizeConfig({ training: { arenas: { range: { type: 'bow', origin: [0, 100, 0], rodDist: '3-30' } } } }), /training\.arenas\.range\.rodDist 要写/)
  const any = bowOptions({ weapon: 'any' }, {})
  for (let seed = 0; seed < 30; seed++) assert.notEqual(sampleBowRound(seed, any, BOW_ORIGIN).weapon, 'fishing_rod')
})

test('fishing rod ballistics: vanilla launch (eye height, 0.3 ahead, 0.6/len + 0.5, float sine table) and per-tick order (ray, −0.03, move by the 0.25 box, ×0.92); flat-cast pitches match F30; a cast that only the box touches is a contact on that face (F27, F28, F31, Q33)', () => {
  const { solveHookPitch, hookLaunch, hookFlight, hookEye, aimAt, faceOkHook, faceCenter, mthSin, mthCos, HOOK_GRAVITY, HOOK_DRAG } = bowModule
  assert.deepEqual([HOOK_GRAVITY, HOOK_DRAG], [0.03, 0.92])
  assert.ok(Math.abs(mthSin(Math.PI / 6) - 0.5) < 1e-4 && Math.abs(mthCos(Math.PI / 3) - 0.5) < 1e-4)
  // 正对 +x、视线水平：从眼睛前方 0.3 格出发，水平 1.1 格/tick
  const flat = hookLaunch([0.5, 101.62, 0.5], -90, 0)
  assert.ok(Math.abs(flat.from[0] - 0.8) < 1e-6 && Math.abs(flat.from[2] - 0.5) < 1e-6 && flat.from[1] === 101.62)
  assert.ok(Math.abs(flat.velocity[0] - 1.1) < 1e-6 && Math.abs(flat.velocity[1]) < 1e-9 && Math.abs(flat.velocity[2]) < 1e-6)
  // 抬头 45°：竖直 = 水平 = 0.6 / √2 + 0.5
  const up = hookLaunch([0, 0, 0], -90, -45)
  assert.ok(Math.abs(up.velocity[0] - (0.6 / Math.SQRT2 + 0.5)) < 1e-3 && Math.abs(up.velocity[1] - up.velocity[0]) < 1e-3)
  // 与设计文档 F30 一致：水平 3 / 4 / 6 / 8 / 10 格平抛要抬高 2.57° / 3.55° / 6.15° / 9.39° / 15.02°，12 格同一高度够不着
  assert.deepEqual([3, 4, 6, 8, 10].map((d) => deg(solveHookPitch(d, 0)).toFixed(2)), ['2.57', '3.55', '6.15', '9.39', '15.02'])
  assert.equal(solveHookPitch(12, 0), null)
  const eye = hookEye(BOW_ORIGIN)
  const cast = (pos, face) => {
    const c = faceCenter(pos, face)
    const theta = solveHookPitch(Math.hypot(c[0] - eye[0], c[2] - eye[2]), c[1] - eye[1])
    const { yaw, pitch } = aimAt(eye, c, theta)
    const { from, velocity } = hookLaunch(eye, yaw, pitch)
    return { c, flight: hookFlight(from, velocity, [[pos, pos.map((x) => x + 1)]]) }
  }
  // 射线命中：瞄准 (6, 102, 0) 西面的中点
  const ray = cast([6, 102, 0], 'west')
  assert.deepEqual([ray.flight.kind, ray.flight.face], ['ray', 'west'])
  assert.ok(Math.hypot(...ray.flight.point.map((x, k) => x - ray.c[k])) < 0.01)
  // F31：瞄准 (9, 102, 0) 西面的中点，射线差一点没够到，碰撞箱先贴上 → contact，命中点是底面中心投到面上
  const box = cast([9, 102, 0], 'west')
  assert.deepEqual([box.flight.kind, box.flight.face, box.flight.point[0]], ['contact', 'west', 9])
  assert.ok(Math.abs(box.flight.point[1] - 102.5) < 0.05 && Math.abs(box.flight.point[2] - 0.5) < 1e-6)
  assert.equal(faceOkHook(BOW_ORIGIN, [9, 102, 0], 'west'), true, '碰撞箱先碰到也算从这一面进去')
  assert.equal(faceOkHook(BOW_ORIGIN, [9, 102, 0], 'east'), false, '看不到')
  assert.equal(faceOkHook(BOW_ORIGIN, [14, 102, 0], 'west'), false, '够不着')
  assert.equal(faceOkHook(BOW_ORIGIN, [9, 102, 0], 'west', [[6, 102, 0]]), false, '路上有别的标靶')
})

test('fishing rod sampler: targets within the rod distance, faces checked with the hook; one rod in a random slot, nothing else, empty hand; reproducible; other weapons unchanged (Q28, Q29, Q33)', () => {
  const { sampleBowRound, bowOptions, faceOkHook, FISHING_ROD } = bowModule
  const options = bowOptions({ weapon: 'fishing_rod' }, {})
  for (let seed = 0; seed < 15; seed++) {
    const r = sampleBowRound(seed, options, BOW_ORIGIN)
    assert.equal(r.weapon, 'fishing_rod')
    assert.ok(r.targets.length >= 1 && r.targets.length <= 4)
    assert.ok(r.targets.every((t) => t.dist >= 3 && t.dist <= 10), JSON.stringify(r.targets))
    assert.equal(r.items.length, 1)
    assert.deepEqual([r.items[0].id, r.items[0].count], [FISHING_ROD, 1])
    assert.ok(r.items[0].slot >= 0 && r.items[0].slot < 36)
    assert.ok(r.selectedSlot >= 0 && r.selectedSlot <= 8 && r.selectedSlot !== r.items[0].slot, '开局手上是空的')
    for (const [i, t] of r.targets.entries()) assert.equal(faceOkHook(BOW_ORIGIN, t.pos, t.face, r.targets.filter((_, j) => j !== i).map((o) => o.pos)), true)
    assert.deepEqual(sampleBowRound(seed, options, BOW_ORIGIN), r)
  }
  const far = sampleBowRound(1, bowOptions({ weapon: 'fishing_rod', targets: '4', dist: '8-12' }), BOW_ORIGIN)
  assert.ok(far.targets.length === 4 && far.targets.every((t) => t.dist >= 8 && t.dist <= 12))
  const legacy = { targets: { lo: 1, hi: 4 }, dist: { lo: 8, hi: 40 } }
  for (let seed = 0; seed < 5; seed++) assert.deepEqual(sampleBowRound(seed, bowOptions({}, {}), BOW_ORIGIN), sampleBowRound(seed, legacy, BOW_ORIGIN))
})

test('fishing rod run: one rod, its own text with the cast limit and no how-to (Q29, Q30); record, label and debrief speak of casts (Q34)', async () => {
  const h = bowHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'bow', runs: 2, seed: 31, weapon: 'fishing_rod' })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /weapon=fishing_rod，targets=1-4，dist=3-10/)
  await h.done()
  const records = h.records('bow')
  assert.equal(records.length, 2)
  for (const [i, record] of records.entries()) {
    const n = record.targets.length
    assert.equal(record.outcome, 'success', JSON.stringify(record))
    assert.deepEqual([record.weapon, record.target, record.faults], ['fishing_rod', `fishing_rod:${n}`, []])
    assert.deepEqual(record.items.map((it) => it.id), ['minecraft:fishing_rod'])
    const text = h.instructions[i]
    assert.ok(text.startsWith(`你站在一个平台上，前方的空中有 ${n} 个标靶（minecraft:target）。你的物品栏里有一根钓竿（minecraft:fishing_rod）。\n请站在平台上用钓竿抛出浮标，让浮标分别碰到下面 ${n} 个点：\n`), text)
    assert.ok(text.trimEnd().endsWith(`每个点都是一个标靶某一面的中心，一共只能抛 ${n} 次，多抛的不算数，顺序不限。离开平台本轮直接结束。`), text)
    assert.doesNotMatch(text, /拉满|收竿|key\/|抬高|按住/, 'Q30: no how-to')
    assert.ok(!text.includes('\r'))
  }
  const debrief = h.reflects.find(([k]) => k === 'release')[2]
  assert.match(debrief, /^本轮武器：钓竿（minecraft:fishing_rod）。\n本轮结果：success（成功），命中 \d\/\d 个标靶。/)
  assert.match(debrief, /每一次抛竿（按抛出的顺序）：\n- 第 1 次抛竿；抛出时玩家在 .*，服务端用来抛竿的朝向 .*；浮标从 .* 出发，初速度 .*；结果 hit（碰到指定面）：碰到方块 .* 面，碰到的点 /)
  assert.doesNotMatch(debrief, /拉满|箭|射/)
  assert.match(h.notices.map(([, t]) => t)[0], /^第 1\/2 轮：会话 run-1，钓竿：\d 个靶，/)
})

test('fishing rod judge: casts are the ammo — doomed when n casts all have results, extra casts do not count or block; unshot when casts are left; via is kept; the debrief names extra, stuck and unused casts (Q29, Q31, Q34)', async () => {
  const { doomedReason, judgeBow, arrowsLeft, arrowRecords, debriefText } = bowModule
  const picked = { weapon: 'fishing_rod', targets: [{ pos: [6, 102, 0], face: 'west', point: [6, 102.5, 0.5] }, { pos: [8, 102, 4], face: 'west', point: [8, 102.5, 4.5] }] }
  const cast = (n, result, extra = {}) => ({ n, ms: n, crit: false, weapon: 'minecraft:fishing_rod', from: [0.8, 101.62, 0.5], velocity: [1, 0.1, 0], playerPos: [0.5, 101, 0.5], rotation: { yaw: -90, pitch: -5 }, result, resultMs: n + 1, path: [], ...extra })
  const status = (hits, arrows) => ({ bow: { targets: picked.targets.map((t, i) => ({ ...t, hit: i < hits })), arrows, flying: arrows.filter((a) => a.result === null).length, leftPlatformAtMs: null }, held: { 'minecraft:fishing_rod': 1 }, carried: {}, dropped: {}, loaded: {}, stationIntact: true })
  assert.equal(arrowsLeft(status(0, []), 'fishing_rod'), 2)
  assert.equal(arrowsLeft(status(1, [cast(1, 'hit')]), 'fishing_rod'), 1)
  assert.equal(doomedReason(picked, status(1, [cast(1, 'hit')])), null, '还能抛一次')
  assert.equal(doomedReason(picked, status(1, [cast(1, 'hit'), cast(2, null)])), null, '第 2 次还没结果')
  assert.match(doomedReason(picked, status(1, [cast(1, 'hit'), cast(2, 'out')])), /抛竿次数已经用完，还有标靶没命中/)
  assert.match(doomedReason(picked, status(1, [cast(1, 'hit'), cast(2, 'out'), cast(3, null)])), /抛竿次数已经用完/, '多抛的还在飞也不等')
  assert.equal(doomedReason(picked, status(2, [cast(1, 'hit'), cast(2, 'hit')])), null)
  assert.deepEqual(judgeBow({ final: status(1, [cast(1, 'hit')]), picked, taskState: 'done' }).faults, ['miss', 'unshot'])
  assert.deepEqual(judgeBow({ final: status(1, [cast(1, 'hit'), cast(2, 'out'), cast(3, 'extra')]), picked, taskState: 'done' }).faults, ['miss'], '不判 weak；次数用完了不算 unshot')
  const records = arrowRecords(picked, { arrows: [cast(1, 'hit', { via: 'contact', block: [6, 102, 0], face: 'west', point: [6, 102.48, 0.5], target: 0, err: 0.02, offset: [0, -0.02, 0] })] }, 0)
  assert.equal(records[0].via, 'contact')
  const text = debriefText({ weapon: 'fishing_rod', outcome: 'false_success', hits: 1, targets: picked.targets, hitTargets: [0], faults: ['miss', 'unshot'], doomed: null, final: {}, arrows: [cast(1, 'hit', { block: [6, 102, 0], face: 'west', point: [6, 102.48, 0.5], target: 0, offset: [0, -0.02, 0], via: 'contact' })] })
  assert.match(text, /报完成时还有 1 次抛竿没用。/)
  assert.match(text, /- 1 号：目标点 .*，命中\n- 2 号：目标点 .*，没命中/)
  assert.doesNotMatch(text, /contact|碰撞箱/, 'Q31：怎么判出来的不写进判定说明')
  const more = debriefText({ weapon: 'fishing_rod', outcome: 'failed', hits: 0, targets: picked.targets, hitTargets: [], faults: ['miss'], doomed: 'out-of-arrows', final: {}, arrows: [cast(1, 'stuck'), cast(2, 'out', { nearest: null }), cast(3, 'extra')] })
  assert.match(more, /提前结束：抛竿次数用完了还有标靶没命中，本轮提前结束。/)
  assert.match(more, /- 第 1 次抛竿；.*结果 stuck（浮标还没碰到任何方块就没了，或者抛出后 10 秒还没有结果）/)
  assert.match(more, /结果 out（飞出场地）；轨迹没有经过任何还没命中的目标面所在的平面/)
  assert.match(more, /- 第 3 次抛竿；.*结果 extra（超出了 2 次，不算数）/)
  assert.match(debriefText({ weapon: 'fishing_rod', outcome: 'failed', hits: 0, targets: picked.targets, arrows: [], faults: ['miss'], final: {} }), /没有抛出过浮标。/)

  // 整轮：每一次都飞出去，次数用完立刻结束
  const missed = bowHarness({ plan: 'miss-all' })
  assert.equal(missed.trainer.start({ sessionId: 'console', arena: 'bow', targets: '2', seed: 3, weapon: 'fishing_rod' }).ok, true)
  await missed.done()
  const [rec] = missed.records('bow')
  assert.deepEqual([rec.outcome, rec.doomed, rec.faults], ['failed', 'out-of-arrows', ['miss']])
})

test('report: the rod gets its own table among the weapons; --by weapon gives four rows; the rod table names its columns after casts and bands distances by 2 (Q34)', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const t = (dist) => ({ pos: [0, 0, 0], face: 'west', point: [0, 0.5, 0.5], dist })
  const rec = (weapon, outcome, hitTargets, dist = 20) => ({ batch: 'b1', target: `${weapon}:1`, weapon, targets: [t(dist)], arrows: hitTargets.length ? [{ n: 1, result: 'hit', target: 0, err: 0.02 }] : [], hitTargets, items: [], selectedSlot: 0, hits: hitTargets.length, doomed: null, faults: outcome === 'success' ? [] : ['miss', 'unshot'], outcome, reachedMs: 4000, taskMs: 6000, tokens: null, usedChatSend: false, stationIntact: true })
  const records = [rec('bow', 'success', [0]), rec('crossbow', 'success', [0]), rec('trident', 'success', [0]), rec('fishing_rod', 'success', [0], 5), rec('fishing_rod', 'false_success', [], 9)]
  const split = summarize(records, { by: 'targets' })
  assert.deepEqual(split.split.map(({ title, summary }) => [title, summary.total.runs]), [['【弓】', 1], ['【弩】', 1], ['【三叉戟】', 1], ['【钓竿】', 2]])
  const parts = formatSummary(split).split('\n\n')
  assert.equal(parts.length, 4)
  assert.match(parts[3], /^【钓竿】\n标靶数\t轮数\t全中率\t虚报\t失败\t超时\t中止\t丢失\t离开平台\t次数用完\t有靶没中\t没抛完\t命中率\t首箭命中率\t偏差中位\t达成中位/)
  assert.doesNotMatch(parts[3], /没拉满|箭用完|箭没射完|三叉戟/)
  assert.deepEqual(summarize(records, { by: 'weapon' }).rows.map((r) => [r.key, r.runs]), [['钓竿', 2], ['弓', 1], ['弩', 1], ['三叉戟', 1]])
  const rodDist = summarize(records.slice(3), { by: 'dist' })
  assert.deepEqual(rodDist.rows.map((r) => [r.key, r.targets, r.hit]), [['4–6 格', 1, 1], ['8–10 格', 1, 0]])
  // 别的武器的距离分段不变
  assert.deepEqual(summarize([rec('bow', 'success', [0])], { by: 'dist' }).rows.map((r) => r.key), ['16–24 格'])
})

// ── 陆地寻路训练场（docs/陆地寻路训练场设计方案.md）──────────────────────

const LAND_ORIGIN_T = [10496, 100, 9984]
const ARENAS_LAND = (over = {}) => {
  const cfg = normalizeConfig({}).training.arenas
  return { route: { ...cfg.route, ...(over.route ?? {}) }, goal: { ...cfg.goal, ...(over.goal ?? {}) } }
}

/** 按高度图造 mod 的格子信息（草方块顶面在 oy + h，脚高 oy + h + 1，净空 6，不危险，地表那一面能出题） */
function gridFromHeights(heights, w, oy = 100, { hazard = () => false, clear = () => 6 } = {}) {
  const columns = []
  for (let i = 0; i < w * w; i++) columns.push([0, 1, oy + heights[i] + 1, clear(i), hazard(i) ? 1 : 0])
  return { width: w, columns }
}
const fieldOf = (w, bottom = 100, [ox, oz] = [0, 0]) => ({ x0: LAND_ORIGIN_T[0] + ox, z0: LAND_ORIGIN_T[2] + oz, x1: LAND_ORIGIN_T[0] + ox + w - 1, z1: LAND_ORIGIN_T[2] + oz + w - 1, width: w, bottom, fellY: bottom - 2 })

test('land options (§5.2): defaults per type, ground checks per type, size 2–4, points 1–8, dist up to 88; config validation; parseTrainArgs takes the new flags', () => {
  const cfg = normalizeConfig({}).training.arenas
  assert.equal(cfg.route.type, 'route')
  assert.deepEqual(cfg.route.origin, LAND_ORIGIN_T)
  const r = land.landOptions('route', {}, cfg.route)
  assert.deepEqual([r.ground, r.grounds, r.memory, r.size.flat, r.points, r.dist.flat], ['flat', ['flat'], 'prefill', { lo: 2, hi: 2 }, { lo: 2, hi: 4 }, { lo: 12, hi: 28 }])
  const g = land.landOptions('goal', {}, cfg.goal)
  assert.deepEqual([g.ground, g.size.synthetic, g.dist.synthetic, g.relief.synthetic], ['synthetic', { lo: 4, hi: 4 }, { lo: 24, hi: 56 }, { lo: 4, hi: 12 }])
  assert.equal(g.points, undefined)
  const any = land.landOptions('goal', { ground: 'any', memory: 'any' }, cfg.goal)
  assert.deepEqual(any.grounds, ['synthetic', 'terrain'])
  assert.deepEqual(any.relief.terrain, { lo: 4, hi: 24 })
  assert.throws(() => land.landOptions('goal', { ground: 'flat' }, cfg.goal), /寻路题的 ground 只能是 synthetic \/ terrain/)
  assert.throws(() => land.landOptions('route', { size: '5' }, cfg.route), /size 要写 k 或 a-b（2–4/)
  assert.throws(() => land.landOptions('route', { points: '9' }, cfg.route), /points 要写 k 或 a-b（1–8/)
  assert.throws(() => land.landOptions('route', { dist: '10-90' }, cfg.route), /dist 要写 a-b（2–88/)
  // 场地配置可以按地形分开写 size / dist
  const split = land.landOptions('goal', { ground: 'any' }, { ...cfg.goal, size: { synthetic: 3, terrain: '2-4' }, dist: { synthetic: '20-30', terrain: '30-60' } })
  assert.deepEqual([split.size.synthetic, split.size.terrain, split.dist.terrain], [{ lo: 3, hi: 3 }, { lo: 2, hi: 4 }, { lo: 30, hi: 60 }])
  assert.throws(() => normalizeConfig({ training: { arenas: { goal: { type: 'goal', ground: 'flat' } } } }), /training\.arenas\.goal\..*ground/)
  assert.throws(() => normalizeConfig({ training: { arenas: { route: { type: 'route', maxWater: 2 } } } }), /maxWater/)
  const args = parseTrainArgs(['route', 'ground=synthetic', 'memory=none', 'size=2-3', 'points=3', 'dist=20-80'])
  assert.equal(args.ok, true, args.error)
  assert.deepEqual([args.ground, args.memory, args.size, args.points, args.dist], ['synthetic', 'none', '2-3', '3', '20-80'])
  assert.equal(parseTrainArgs(['route', 'ground=water']).ok, false)
  assert.equal(parseTrainArgs(['route', 'memory=all']).ok, false)
  // dist 放宽到 88 之后，弓箭题照样按自己的上限 60 查
  assert.throws(() => bowModule.bowOptions({ dist: '8-70' }, {}), /dist 要写 a-b（2–60/)
})

test('land synthetic terrain (Q2b): reproducible; 0 at the lowest; neighbours differ by ≤ 1 except at cliffs; cliffs make ≥ 4 drops; every pit can be walked out of', () => {
  const a = land.syntheticHeights(11, 64, { lo: 8, hi: 8 }, { lo: 3, hi: 3 })
  const b = land.syntheticHeights(11, 64, { lo: 8, hi: 8 }, { lo: 3, hi: 3 })
  assert.deepEqual(a, b)
  assert.equal(Math.min(...a.heights), 0)
  assert.equal(a.cliffs.length, 3)
  const flat = land.syntheticHeights(5, 32, { lo: 6, hi: 6 }, { lo: 0, hi: 0 })
  const w = 32
  for (let z = 0; z < w; z++) {
    for (let x = 0; x + 1 < w; x++) assert.ok(Math.abs(flat.heights[z * w + x] - flat.heights[z * w + x + 1]) <= 1)
  }
  // 有悬崖时一定有 ≥ 4 的高差
  let steep = 0
  for (let z = 0; z < 64; z++) for (let x = 0; x + 1 < 64; x++) if (Math.abs(a.heights[z * 64 + x] - a.heights[z * 64 + x + 1]) >= 4) steep++
  assert.ok(steep > 0)
  // 坑都留坡道：坑中心那一格能走到场地中间附近的任意一格（有向图上）
  for (let seed = 1; seed <= 12; seed++) {
    const s = land.syntheticHeights(seed, 64, { lo: 4, hi: 12 }, { lo: 1, hi: 3 })
    const graph = land.buildGraph(gridFromHeights(s.heights, 64), fieldOf(64))
    for (const c of s.cliffs.filter((k) => k.kind === 'pit')) {
      const from = graph.top[c.center[1] * 64 + c.center[0]]
      const outside = graph.top[2 * 64 + 2]
      assert.ok(land.shortestPath(graph, from, outside), `seed ${seed}: pit at ${c.center} has no way out`)
    }
  }
})

test('land walkability (Q5, F1, F2): step up 0.5, jump up 1 with headroom, not 1.5; drop 3 with room, not 4; hazards closed; diagonals only on near-level ground; directed', () => {
  const n = (feet, clear = 6, hazard = false) => ({ feet, clear, hazard })
  assert.equal(land.moveOk(n(101), n(101.5)), true)
  assert.equal(land.moveOk(n(101), n(102)), true)
  assert.equal(land.moveOk(n(101, 2.5), n(102)), false, 'a jump needs dy + 1.8 above the start')
  assert.equal(land.moveOk(n(101), n(102.5)), false)
  assert.equal(land.moveOk(n(104), n(101)), true)
  assert.equal(land.moveOk(n(104), n(101, 4.5)), false, 'the landing column needs drop + 1.8')
  assert.equal(land.moveOk(n(105), n(101)), false, 'a 4-block drop hurts')
  assert.equal(land.moveOk(n(101), n(101, 6, true)), false)
  assert.equal(land.moveOk(n(101), n(101, 1.5)), false)
  // 4 × 4 平地，中间一格高 4：走得下来，上不去
  const w = 16
  const h = new Array(w * w).fill(0)
  h[5 * w + 5] = 4
  const graph = land.buildGraph(gridFromHeights(h, w), fieldOf(w))
  const top = (x, z) => graph.top[z * w + x]
  assert.ok(land.shortestPath(graph, top(5, 5), top(5, 7)) === null, 'a 4 drop is not safe')
  h[5 * w + 5] = 3
  const g2 = land.buildGraph(gridFromHeights(h, w), fieldOf(w))
  assert.ok(land.shortestPath(g2, g2.top[5 * w + 5], g2.top[7 * w + 5]), 'a 3 drop is fine')
  assert.equal(land.shortestPath(g2, g2.top[7 * w + 5], g2.top[5 * w + 5]), null, 'and you cannot climb 3 back up')
  // 平地上斜着走：(2,2) → (6,6) 长 4√2
  const flat = land.buildGraph(gridFromHeights(new Array(w * w).fill(0), w), fieldOf(w))
  const p = land.shortestPath(flat, flat.top[2 * w + 2], flat.top[6 * w + 6])
  assert.ok(Math.abs(p.length - 4 * Math.SQRT2) < 1e-9)
  assert.deepEqual(land.nodePos(flat, flat.top[2 * w + 2]), [10498.5, 101, 9986.5])
  // 危险的一格绕开
  const haz = land.buildGraph(gridFromHeights(new Array(w * w).fill(0), w, 100, { hazard: (i) => i === 4 * w + 4 }), fieldOf(w))
  const around = land.shortestPath(haz, haz.top[4 * w + 2], haz.top[4 * w + 6])
  assert.ok(!around.path.includes(haz.top[4 * w + 4]))
  assert.equal(land.referenceTicks(28.06), 100)
})

test('land sampling (Q4, Q5, Q6): route points ≥ 4 apart and ≥ 2 from the edge, legs all walkable, dist in range, reference = joined legs; start yaw not facing the first stop; reproducible', () => {
  const w = 32
  const graph = land.buildGraph(gridFromHeights(new Array(w * w).fill(0), w), fieldOf(w))
  for (let seed = 1; seed <= 20; seed++) {
    const t = land.sampleOnGraph(graph, rngOf(seed), { type: 'route', dist: { lo: 12, hi: 28 }, points: { lo: 2, hi: 4 } })
    assert.ok(t, `seed ${seed}`)
    assert.ok(t.points.length >= 2 && t.points.length <= 4)
    const all = [t.start, ...t.points, t.goal]
    for (const p of all) {
      assert.ok(p[0] - 10496 >= 2 && p[0] - 10496 < w - 2 && p[2] - 9984 >= 2 && p[2] - 9984 < w - 2, JSON.stringify(p))
      assert.equal(p[1], 101)
      assert.equal(p[0] % 1, 0.5)
    }
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (!(i === 0 && j === all.length - 1)) assert.ok(Math.hypot(all[i][0] - all[j][0], all[i][2] - all[j][2]) >= 4)
    assert.ok(t.dist >= 12 && t.dist <= 28)
    const legs = all.slice(1).reduce((s, p, i) => s + Math.max(Math.abs(p[0] - all[i][0]), Math.abs(p[2] - all[i][2])) + (Math.SQRT2 - 1) * Math.min(Math.abs(p[0] - all[i][0]), Math.abs(p[2] - all[i][2])), 0)
    assert.ok(Math.abs(t.reference.length - legs) < 0.02, `${t.reference.length} vs ${legs}`)
    assert.equal(t.reference.ticks, land.referenceTicks(t.reference.length))
    const toward = land.yawToward(t.start, t.points[0])
    assert.ok(Math.abs((((t.yaw - toward) % 360) + 540) % 360 - 180) >= 45)
  }
  const g = land.sampleOnGraph(graph, rngOf(3), { type: 'goal', dist: { lo: 20, hi: 30 } })
  assert.deepEqual(g.points, [])
  assert.deepEqual(land.sampleOnGraph(graph, rngOf(3), { type: 'goal', dist: { lo: 20, hi: 30 } }), g)
  // 出不了题：距离要求比场地还大
  assert.equal(land.sampleOnGraph(graph, rngOf(3), { type: 'goal', dist: { lo: 60, hi: 80 } }), null)
})

test('land offset and edge points (第四稿 Q19, Q20): offset 0–16 per axis, reproducible, drawn last; edge = min(drawn, n) points on the outermost ring, the rest ≥ 2 from the edge; edge 0 samples exactly as before', () => {
  const cfg = normalizeConfig({}).training.arenas
  const r = land.landOptions('route', {}, cfg.route)
  assert.deepEqual([r.edge, r.offset], [{ lo: 0, hi: 2 }, { lo: 0, hi: 16 }])
  const g = land.landOptions('goal', {}, cfg.goal)
  assert.deepEqual([g.edge, g.offset], [undefined, { lo: 0, hi: 16 }])
  assert.throws(() => land.landOptions('route', { edge: '9' }, cfg.route), /edge 要写 k 或 a-b（0–8/)
  assert.throws(() => land.landOptions('route', { offset: '0-17' }, cfg.route), /offset 要写 k 或 a-b（0–16/)
  const args = parseTrainArgs(['route', 'edge=1-3', 'offset=0'])
  assert.deepEqual([args.ok, args.edge, args.offset], [true, '1-3', '0'])

  // 偏移：每轴 0–16，同一种子同一个偏移；放在最后抽，前面的随机数和第三稿一样
  const seen = new Set()
  for (let seed = 1; seed <= 40; seed++) {
    const p = land.sampleLandRound(seed, r)
    assert.ok(p.offset.every((v) => Number.isInteger(v) && v >= 0 && v <= 16), JSON.stringify(p.offset))
    assert.deepEqual(land.sampleLandRound(seed, r).offset, p.offset)
    const { offset, ...rest } = p
    const { offset: _, ...before } = land.sampleLandRound(seed, { ...r, offset: undefined })
    assert.deepEqual(rest, before)
    seen.add(p.offset.join(','))
  }
  assert.ok(seen.size > 20, 'offsets vary from round to round')
  assert.deepEqual(land.sampleLandRound(3, { ...r, offset: { lo: 0, hi: 0 } }).offset, [0, 0])

  // 边缘点：偏移后的场地上，k 个在最外一圈，其余（和起终点）离边缘 ≥ 2 格
  const w = 32
  const off = [5, 11]
  const graph = land.buildGraph(gridFromHeights(new Array(w * w).fill(0), w), fieldOf(w, 100, off))
  const x0 = LAND_ORIGIN_T[0] + off[0], z0 = LAND_ORIGIN_T[2] + off[1]
  const ring = (p) => Math.min(p[0] - 0.5 - x0, p[2] - 0.5 - z0, x0 + w - 1 - (p[0] - 0.5), z0 + w - 1 - (p[2] - 0.5))
  for (let seed = 1; seed <= 20; seed++) {
    const t = land.sampleOnGraph(graph, rngOf(seed), { type: 'route', dist: { lo: 12, hi: 28 }, points: { lo: 3, hi: 3 }, edge: { lo: 2, hi: 2 } })
    assert.ok(t, `seed ${seed}`)
    assert.equal(t.edgePoints.length, 2)
    t.points.forEach((p, i) => assert.equal(ring(p) === 0, t.edgePoints.includes(i), `seed ${seed} point ${i}: ${JSON.stringify(p)}`))
    t.points.forEach((p, i) => { if (!t.edgePoints.includes(i)) assert.ok(ring(p) >= 2) })
    assert.ok(ring(t.start) >= 2 && ring(t.goal) >= 2)
    const all = [t.start, ...t.points, t.goal]
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (!(i === 0 && j === all.length - 1)) assert.ok(Math.hypot(all[i][0] - all[j][0], all[i][2] - all[j][2]) >= 4)
  }
  // 抽到的比点数多：全部靠边
  const many = land.sampleOnGraph(graph, rngOf(7), { type: 'route', dist: { lo: 12, hi: 28 }, points: { lo: 2, hi: 2 }, edge: { lo: 5, hi: 5 } })
  assert.deepEqual(many.edgePoints, [0, 1])
  // edge 上限是 0：和不给 edge 抽出的题一模一样
  for (let seed = 1; seed <= 10; seed++) {
    const a = land.sampleOnGraph(graph, rngOf(seed), { type: 'route', dist: { lo: 12, hi: 28 }, points: { lo: 2, hi: 4 }, edge: { lo: 0, hi: 0 } })
    const b = land.sampleOnGraph(graph, rngOf(seed), { type: 'route', dist: { lo: 12, hi: 28 }, points: { lo: 2, hi: 4 } })
    assert.deepEqual(a, b)
    assert.deepEqual(a.edgePoints, [])
  }
  // 寻路题没有边缘点
  assert.equal(land.sampleOnGraph(graph, rngOf(3), { type: 'goal', dist: { lo: 20, hi: 30 } }).edgePoints, undefined)
})

/** 陆地寻路的假 mod：land-build 按地形给格子信息（真实世界的窗口按 rejectWindows 拒掉），prepare 回题目和记忆，status 回 world.land */
function landHarness({ plan = 'do', rejectWindows = 0, memoryError = null, arenas = ARENAS_LAND() } = {}) {
  const world = { builds: [], land: null, params: null }
  const reflects = []
  const onCall = (method, params) => {
    if (method === 'arena/land-build') {
      world.builds.push(params)
      const w = 16 * params.size
      if (params.ground === 'terrain' && world.builds.filter((b) => b.ground === 'terrain').length <= rejectWindows) {
        return { ok: true, data: { accepted: false, reason: 'water', scan: { waterRatio: 0.6 } } }
      }
      const heights = params.heights ?? new Array(w * w).fill(0)
      const bottom = params.ground === 'flat' ? 100 : 96
      return { ok: true, data: { accepted: true, ground: params.ground, size: params.size, offset: params.offset, field: fieldOf(w, bottom, params.offset ?? [0, 0]), grid: gridFromHeights(heights, w), scan: params.ground === 'terrain' ? { relief: 9, waterRatio: 0.1 } : undefined } }
    }
    return null
  }
  const script = ({ req, executor, clock, setBusy }) => setImmediate(async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    await tick()
    req.closed = true
    req.answered = true
    executor.task = { taskId: req.taskId, state: 'running' }
    executor.emit('task', { taskId: req.taskId, state: 'running', version: 1 })
    for (let i = 0; i < 3; i++) await tick()
    const L = world.land
    L.started = 40
    L.startedAtMs = clock()
    if (plan === 'do' || plan === 'hurt') {
      L.route.passed = L.route.passed.map((_, i) => 100 + i * 50)
      L.route.next = L.route.passed.length
      L.reachedTick = 400
      L.reachedAtMs = clock()
      world.reachedAtMs = clock()
      if (plan === 'hurt') {
        L.hurt = { count: 1, total: 1 }
        L.damage = [{ tick: 200, atMs: clock(), source: 'minecraft:fall', amount: 1, health: 19, pos: [10500.3, 101, 9990.2], fallDistance: 4.2 }]
      }
      L.trace = [[39, ...world.params.land.start, 1], [60, 10500, 101, 9990, 3], [400, ...world.params.land.goal, 1]]
    } else if (plan === 'skip') {
      L.reachedTick = null
    } else if (plan === 'fall') {
      L.fell = { tick: 90, pos: [10480.5, 97.5, 9990.5], edge: [10496.1, 101, 9990.5], edgeTick: 85 }
      L.fellAtMs = clock()
      while (executor.task.state === 'running') await tick()
      return
    }
    for (let i = 0; i < 3; i++) await tick()
    executor.task.state = 'done'
    setBusy(2)
    executor.emit('task', { taskId: req.taskId, state: 'done', version: 2 })
  })
  const h = harness({
    script, arenas, onCall,
    prepareData: (params) => {
      world.params = params
      world.reachedAtMs = null
      world.land = {
        kind: params.land.kind, started: null, startedAtMs: null, reachedTick: null, reachedAtMs: null,
        route: { passed: params.land.points.map(() => null), next: 0, early: [] }, hurt: { count: 0, total: 0 }, damage: [], dead: null, fell: null, fellAtMs: null, trace: [], events: []
      }
      return {
        land: { kind: params.land.kind, start: params.land.start, points: params.land.points, goal: params.land.goal, memory: params.land.memory },
        memory: memoryError ? { error: memoryError } : { mode: params.land.memory, cleared: { terrain: 5 }, prefilled: params.land.memory === 'prefill' ? { terrain: 1024 } : null }
      }
    },
    statusData: () => ({ land: world.land, reachedAtMs: world.reachedAtMs })
  })
  h.trainer.bridge.holdReflect = (taskId) => reflects.push(['hold', taskId])
  h.trainer.bridge.releaseReflect = (taskId, text) => reflects.push(['release', taskId, text])
  return { ...h, world, reflects }
}

test('land route run (§3, Q4, Q6, Q7, Q14, Q15): land-build before prepare; prepare carries the stops, the yaw, the markers and the memory mode, nothing handed out; the text lists the points only; reaching in order succeeds; the debrief has the times, the reference time and the trace', async () => {
  const h = landHarness()
  const started = h.trainer.start({ sessionId: 'console', arena: 'route', runs: 2, seed: 5 })
  assert.equal(started.ok, true, started.error)
  assert.match(started.text, /ground=flat，memory=prefill，size=2，points=2-4，edge=0-2，dist=12-28，offset=0-16/)
  await h.done()
  const records = h.records('route')
  assert.equal(records.length, 2)
  const methods = h.calls.map(([m]) => m)
  assert.ok(methods.indexOf('arena/land-build') < methods.indexOf('arena/prepare'))
  const { offset: off0, ...build0 } = h.world.builds[0]
  assert.deepEqual(build0, { arena: 'land', origin: LAND_ORIGIN_T, ground: 'flat', size: 2 })
  assert.ok(off0.length === 2 && off0.every((v) => Number.isInteger(v) && v >= 0 && v <= 16), JSON.stringify(off0))
  const prep = h.calls.find(([m]) => m === 'arena/prepare')[1]
  assert.equal(prep.station, 'land')
  assert.deepEqual(prep.items, [])
  assert.deepEqual(Object.keys(prep.land), ['kind', 'start', 'yaw', 'points', 'goal', 'markers', 'memory'])
  assert.deepEqual([prep.land.kind, prep.land.markers, prep.land.memory], ['route', true, 'prefill'])
  const r = records[0]
  assert.equal(r.outcome, 'success', JSON.stringify(r))
  assert.deepEqual([r.faults, r.doomed, r.reached, r.ground, r.memory, r.size], [[], null, true, 'flat', 'prefill', 2])
  // 第四稿：记录带偏移和边缘点；题目在偏移后的场地里
  assert.deepEqual(r.offset, off0)
  assert.ok(Array.isArray(r.edgePoints) && r.edgePoints.length <= 2)
  for (const p of [r.start, ...r.points, r.goal]) {
    assert.ok(p[0] >= LAND_ORIGIN_T[0] + off0[0] && p[0] < LAND_ORIGIN_T[0] + off0[0] + 32 && p[2] >= LAND_ORIGIN_T[2] + off0[1] && p[2] < LAND_ORIGIN_T[2] + off0[1] + 32, JSON.stringify(p))
  }
  assert.equal(r.moveTicks, 360)
  assert.equal(r.ratio, Math.round((360 / r.reference.ticks) * 1000) / 1000)
  assert.equal(r.thinkMs !== null, true)
  assert.equal(r.hurt, false)
  assert.deepEqual(r.memoryInfo.prefilled, { terrain: 1024 })
  const text = h.instructions[0]
  assert.match(text, /^你站在 \(\d+\.5, 101, \d+\.5\)。请以最快速度按顺序经过下面 \d 个点，最后走到终点/)
  assert.match(text, /\n1\. \(\d+\.5, 101, \d+\.5\)\n2\. /)
  assert.doesNotMatch(text, /记忆|场地|掉下去|平地/)
  const debrief = h.reflects.find(([k]) => k === 'release')[2]
  assert.match(debrief, /本轮结果：success（到达）/)
  assert.match(debrief, /从开始移动到到达：360 tick（18\.0 秒）/)
  assert.match(debrief, new RegExp(`参照用时：${r.reference.ticks} tick`))
  assert.match(debrief, /1\. \(.*\)：第 100 tick 按顺序经过/)
  assert.match(debrief, /受伤：全程没有受伤/)
  assert.match(debrief, /你走过的路/)
  assert.doesNotMatch(debrief, /参照路线/)
})

test('land goal run on real terrain (Q3, Q9, Q10): rejected windows are tried in turn and recorded; damage is recorded but still success; falling off ends the round as fell; a memory error stops the batch', async () => {
  const h = landHarness({ plan: 'hurt', rejectWindows: 2 })
  const started = h.trainer.start({ sessionId: 'console', arena: 'goal', runs: 1, seed: 9, ground: 'terrain', size: '2', dist: '12-30' })
  assert.equal(started.ok, true, started.error)
  await h.done()
  const [r] = h.records('goal')
  assert.equal(h.world.builds.length, 3)
  assert.ok(h.world.builds.every((b) => b.window && b.maxWater === 0.25 && JSON.stringify(b.relief) === '[4,24]'))
  assert.equal(r.rejected.length, 2)
  assert.equal(r.outcome, 'success')
  assert.deepEqual([r.hurt, r.damage, r.damageEvents.length], [true, 1, 1])
  assert.deepEqual(r.window, [h.world.builds[2].window.cx, h.world.builds[2].window.cz])
  const debrief = h.reflects.find(([k]) => k === 'release')[2]
  assert.match(debrief, /受伤：1 次，一共掉了 1\.0 点生命值/)
  assert.match(debrief, /第 200 tick，摔落（minecraft:fall），掉 1\.0 点，剩 19\.0 点，位置 \(10500\.3, 101\.0, 9990\.2\)，摔落距离 4\.20 格/)

  const f = landHarness({ plan: 'fall' })
  f.trainer.start({ sessionId: 'console', arena: 'goal', runs: 1, seed: 9 })
  await f.done()
  const [fr] = f.records('goal')
  assert.deepEqual([fr.outcome, fr.doomed, fr.reached], ['failed', 'fell', false])
  assert.ok(fr.faults.includes('fell') && fr.faults.includes('unreached'))
  assert.match(f.reflects.find(([k]) => k === 'release')[2], /掉出场地：第 85 tick 在 \(10496\.1, 101\.0, 9990\.5\) 离开场地边缘/)

  const m = landHarness({ memoryError: 'client did not load the field chunks within 10s' })
  m.trainer.start({ sessionId: 'console', arena: 'route', runs: 3, seed: 9 })
  await m.done()
  const mr = m.records('route')
  assert.equal(mr.length, 1, 'setup failures stop the batch')
  assert.equal(mr[0].outcome, 'aborted')
  assert.match(mr[0].error, /记忆没有清除 \/ 预填好（client did not load/)
  assert.ok(m.calls.some(([method]) => method === 'arena/finish'))
})

test('land route judge (Q10): claiming done before passing every point is false_success with skipped; synthetic ground sends a heightmap', async () => {
  const h = landHarness({ plan: 'skip' })
  h.trainer.start({ sessionId: 'console', arena: 'route', runs: 1, seed: 4, ground: 'synthetic' })
  await h.done()
  const [r] = h.records('route')
  assert.equal(r.outcome, 'false_success')
  assert.deepEqual(r.faults, ['unreached', 'skipped'])
  const b = h.world.builds[0]
  assert.equal(b.ground, 'synthetic')
  assert.equal(b.heights.length, 32 * 32)
  assert.equal(Math.min(...b.heights), 0)
  assert.ok(Array.isArray(r.cliffs))
  assert.match(land.debriefText(r), /没有按顺序经过/)
})

test('land report (Q15): grouped by ground by default (in the order flat → synthetic → real), split by memory mode when both are present; arrival rate, fell, hurt, move ticks and the ratio to the reference', async () => {
  const { summarize, formatSummary } = await import('../src/training/report.js')
  const rec = (o) => ({ type: 'route', ground: 'flat', memory: 'prefill', points: [[0, 0, 0], [1, 1, 1]], dist: 20, reference: { ticks: 100 }, moveTicks: 120, ratio: 1.2, thinkMs: 3000, taskMs: 9000, damage: 0, hurt: false, doomed: null, faults: [], outcome: 'success', ...o })
  const records = [
    rec({ ground: 'terrain', moveTicks: 300, ratio: 2 }),
    rec({}),
    rec({ ground: 'synthetic', moveTicks: 200, ratio: 1.5, hurt: true, damage: 2 }),
    rec({ outcome: 'failed', doomed: 'fell', faults: ['unreached', 'fell'], moveTicks: null, ratio: null }),
    rec({ outcome: 'false_success', faults: ['unreached', 'skipped'], moveTicks: null, ratio: null })
  ]
  const s = summarize(records, { by: 'target' })
  assert.equal(s.lander, true)
  assert.deepEqual(s.rows.map((r) => [r.key, r.runs, r.success, r.fell, r.skipped, r.hurtRuns]), [['平地', 3, 1, 1, 1, 0], ['模拟起伏', 1, 1, 0, 0, 1], ['真实世界', 1, 1, 0, 0, 0]])
  assert.deepEqual([s.total.medianMoveTicks, s.total.medianRatio, s.total.hurtSuccess], [200, 1.5, 1])
  const text = formatSummary(s)
  assert.match(text.split('\n')[0], /^地形\t轮数\t到达率\t虚报\t失败\t超时\t中止\t掉出场地\t死亡\t跳过点\t受伤轮次/)
  assert.match(text, /\n平地\t3\t33%\t1\t1\t0\t0\t1\t0\t1\t0%/)
  const split = summarize([...records, rec({ memory: 'none' })], { by: 'ground' })
  assert.deepEqual(split.split.map((p) => p.title), ['【记忆预填】', '【记忆不预填】'])
  const goals = summarize([rec({ type: 'goal', points: [] })], { by: 'dist' })
  assert.equal(goals.router, false)
  // 第四稿 Q20：按边缘点数分组；第四稿之前的路线题记录没有 edgePoints，算 0 个
  const byEdge = summarize([rec({}), rec({ edgePoints: [1] }), rec({ edgePoints: [0, 2], outcome: 'failed', doomed: 'fell' })], { by: 'edge' })
  assert.deepEqual(byEdge.rows.map((x) => [x.key, x.runs, x.fell]), [['0 个靠边', 1, 0], ['1 个靠边', 1, 0], ['2 个靠边', 1, 1]])
  assert.match(formatSummary(byEdge).split('\n')[0], /^边缘点\t/)
  assert.doesNotMatch(formatSummary(goals), /跳过点/)
  assert.deepEqual(goals.rows.map((r) => r.key), ['16–24 格'])
})
