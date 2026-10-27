import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { GameState } from '../src/game/index.js'
import { Executor, EventLog } from '../src/bt/index.js'
import { CapsuleLibrary, Sandbox, createBuiltins, saveCapsule } from '../src/capsules/index.js'
import { createDefaultRegistry } from '../src/commands.js'
import { FakeMod, allRecipes } from './fake_mod.js'

/** 测试夹具。不被 node:test 用作测试文件（没有 test() 调用）。 */

export function tempDir(prefix = 'stevex-agent-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 测试用的条件代码（agent 训练时会自己写这类东西；这里只是让执行器测试有条件可用）。 */
export const TEST_CAPSULES = [
  {
    folder: 'code',
    name: 'test.has-item',
    description: '背包里 item 至少 count 个',
    signature: { inputs: { item: { type: 'string', required: true }, count: { type: 'int' } }, returns: 'bool' },
    body: `function main(p: { item: string, count?: number }, state: any): boolean {
  const id = p.item.includes(':') ? p.item : 'minecraft:' + p.item
  const n = state.inventory.slots.filter((s: any) => s.id === id).reduce((sum: number, s: any) => sum + s.count, 0)
  return n >= (p.count ?? 1)
}`
  },
  {
    folder: 'code',
    name: 'test.air-below',
    description: '氧气低于 value',
    signature: { inputs: { value: { type: 'int', required: true } }, returns: 'bool' },
    body: 'function main(p, state) { return state.player.vitals.air < p.value }'
  }
]

/**
 * @param {object} [options]
 * @param {FakeMod} [options.mod]
 * @param {object} [options.config]      执行器配置（observe 默认关掉，测试里要看差异时再开）
 * @param {object[]} [options.capsules]  额外要存进库的条目（{ folder, ...entry }）
 */
export function makeRuntime({ mod = new FakeMod(), config = {}, capsules = [] } = {}) {
  const dir = tempDir()
  const recipesFile = path.join(dir, 'recipes.json')
  fs.writeFileSync(recipesFile, JSON.stringify({ recipes: allRecipes() }))
  const { builtins, json } = createBuiltins({ jsonSources: { recipes: recipesFile } })
  const library = new CapsuleLibrary({ dir: path.join(dir, 'capsules'), builtins })
  const sandbox = new Sandbox()
  const registry = createDefaultRegistry()
  const refs = {}
  for (const { folder, ...entry } of [...TEST_CAPSULES, ...capsules]) {
    const result = saveCapsule({ library, sandbox, registry }, folder, entry)
    if (!result.ok) throw new Error(`test capsule ${entry.name}: ${result.errors.join('; ')}`)
    refs[entry.name] = result.ref
  }

  const game = new GameState({ mod, timing: { clickWaitMs: 0, lookWaitMs: 0, pollMs: 0 } })
  const executor = new Executor({
    game, registry, eventLog: new EventLog(),
    capsules: { library, sandbox },
    config: { observe: { enabled: false }, ...config }
  })
  executor.loadFastTree({ match: 'empty', arms: [] })
  const events = []
  executor.on('event', (record) => events.push(record))
  const requests = []
  executor.on('request', (request) => requests.push(request))
  return { mod, game, registry, executor, events, requests, library, sandbox, refs, json, dir }
}

/** 反复 tick（中间让出事件循环，让在飞的 mod 调用落地），直到 predicate 为真。 */
export async function runUntil(executor, predicate, { maxTicks = 5000, beforeTick } = {}) {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return i
    await beforeTick?.()
    executor.tick()
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`condition not reached after ${maxTicks} ticks; task=${JSON.stringify(executor.taskSummary())}`)
}

export const taskState = (executor) => () => executor.task?.state
