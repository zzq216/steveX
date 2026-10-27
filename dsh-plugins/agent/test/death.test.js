import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeMod } from './fake_mod.js'
import { makeRuntime, runUntil } from './helpers.js'
import { createLocalResponder } from '../src/bt/index.js'

const walk = (ms) => ({ steps: '前进', do: [['key/up', { pressed: true }], ['wait', ms], ['key/up', { pressed: false }]] })
const kill = (mod, message) => { mod.health = 0; mod.deathMessage = message }

function runtime(config = {}) {
  const mod = new FakeMod({ inventory: { 3: ['oak_log', 5] }, position: [10, 64, -4] })
  const rt = makeRuntime({ mod, config: { respawnPollMs: 5, ...config } })
  const poll = () => rt.game.pollOnce()
  return { ...rt, poll }
}

test('任务中死亡：中止并松键 → 自动重生 → died 请求；目录有 death / respawn 快照与死亡信息；空补丁后从被中断的叶子继续', async () => {
  const { mod, executor, requests, events, poll } = runtime()
  executor.startTask({ tree: { seq: '干活', do: [{ act: 'key/hotbar', params: { slot: 2 } }, walk(3000)] } })
  assert.ok(executor.game.pollSources.has('player'), '任务存在期间 player 在轮询集合里')
  await runUntil(executor, () => mod.pressed.has('key/up'), { beforeTick: poll })

  kill(mod, 'Steve was slain by Zombie')
  await runUntil(executor, () => requests.some((r) => r.type === 'died'), { beforeTick: poll, maxTicks: 20000 })

  assert.equal(mod.pressed.has('key/up'), false, '默认中止流程松了键')
  assert.equal(mod.health, 20, '已重生')
  assert.ok(mod.calls.some(([m]) => m === 'player/respawn'))
  const { directory, evidence } = requests.at(-1)
  assert.equal(evidence.interrupted.id, 'n1.2')
  assert.equal(directory.error, 'Steve was slain by Zombie')
  assert.match(directory.title, /死亡并已自动重生；死亡时在跑的 n1\.2「前进」已归零/)
  assert.ok(directory.snapshots.includes('death') && directory.snapshots.includes('respawn'))
  assert.equal(executor.task.snapshots.get('death').state.player.dead, true, '死前状态取自缓存')
  assert.deepEqual(executor.task.snapshots.get('respawn').state.inventory.slots, [], '重生后背包是空的')
  assert.ok(events.some((e) => e.event === 'player/died') && events.some((e) => e.event === 'player/respawned'))

  assert.equal(executor.submitPatch(requests.at(-1).requestId, []).ok, true)
  await runUntil(executor, () => executor.task.state === 'done', { beforeTick: poll, maxTicks: 20000 })
  assert.equal(mod.calls.filter(([m]) => m === 'key/hotbar').length, 1, '死前完成的步骤没有重跑')
})

test('在飞请求期间死亡：请求过期并附 died 证据（§5），不另发 died 请求', async () => {
  const { mod, executor, requests, poll } = runtime()
  executor.startTask({ tree: { seq: 's', do: [{ expand: '以后再说' }] } })
  await runUntil(executor, () => executor.task.state === 'suspended', { beforeTick: poll })

  kill(mod, 'Steve fell from a high place')
  await runUntil(executor, () => executor.task.pending?.stale, { beforeTick: poll, maxTicks: 20000 })
  assert.equal(requests.filter((r) => r.type === 'died').length, 0)

  const rejected = executor.submitExpansion(requests.at(-1).requestId, { act: 'key/hotbar', params: { slot: 1 } })
  assert.equal(rejected.stale, true)
  assert.equal(rejected.events[0].event, 'died')
  assert.equal(rejected.events[0].deathMessage, 'Steve fell from a high place')
})

test('重生失败（极限模式）→ 任务失败；mod 未升级时按生命值 ≤ 0 判死', async () => {
  const { mod, executor, poll } = runtime()
  mod.hardcore = true
  executor.startTask({ tree: walk(3000) })
  await runUntil(executor, () => mod.pressed.has('key/up'), { beforeTick: poll })
  kill(mod, 'x')
  await runUntil(executor, () => executor.task.state === 'failed', { beforeTick: poll, maxTicks: 20000 })
  assert.match(executor.task.result, /could not respawn: player\/respawn: hardcore world/)

  const old = runtime()
  const handle = old.mod.handle.bind(old.mod)
  old.mod.handle = (method, p) => {
    const data = handle(method, p)
    if (method === 'player' && data) delete data.dead
    return data
  }
  old.executor.startTask({ tree: walk(3000) })
  await runUntil(old.executor, () => old.mod.pressed.has('key/up'), { beforeTick: old.poll })
  kill(old.mod, null)
  await runUntil(old.executor, () => old.requests.some((r) => r.type === 'died'), { beforeTick: old.poll, maxTicks: 20000 })
})

test('不属于会话的任务死亡：本地应答器放弃任务', async () => {
  const { mod, executor, poll } = runtime()
  createLocalResponder(executor)
  executor.startTask({ tree: walk(3000) })
  await runUntil(executor, () => mod.pressed.has('key/up'), { beforeTick: poll })
  kill(mod, 'Steve drowned')
  await runUntil(executor, () => executor.task.state === 'failed', { beforeTick: poll, maxTicks: 20000 })
  assert.match(executor.task.result, /died: Steve drowned/)
})
