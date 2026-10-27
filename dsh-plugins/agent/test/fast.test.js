import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { FakeMod } from './fake_mod.js'
import { makeRuntime, runUntil } from './helpers.js'
import { EventLog } from '../src/bt/index.js'
import { FastMonitor, FastVersions, FastReflector } from '../src/fast/index.js'
import { FastBridge } from '../src/llm/fast_bridge.js'
import { loadPrompts } from '../src/llm/prompts.js'
import { fastTools } from '../src/tools/fast.js'
import { DEFAULTS } from '../src/config.js'

const AIR_LOW = {
  'fast.air-low': {
    signature: { inputs: { value: { type: 'int', required: true } }, returns: 'bool' },
    body: 'function main(p, s) { return s.player.vitals.air < p.value }'
  }
}
const swimUp = (name = '上浮', ms = 30) => ({ steps: name, do: [['key/jump', { pressed: true }], ['wait', ms], ['key/jump', { pressed: false }]] })
const airArm = (name = '上浮', value = 100, ms = 30) => ({ when: { cond: 'code/test.air-below', read: ['player'], params: { value } }, then: swimUp(name, ms) })

/** 带快树事件流 / 版本链 / 批次的运行时。monitor 与 reflector 用可拨的时钟；runtimeDir 下落盘。 */
function fastRuntime({ mod = new FakeMod(), config = {}, fast = {}, runtimeDir = null } = {}) {
  const rt = makeRuntime({ mod, config: { respawnPollMs: 5, ...config } })
  const dir = runtimeDir ?? path.join(rt.dir, 'runtime')
  rt.executor.eventLog = new EventLog({ runtimeDir: dir })
  let clock = 1_000_000
  const now = () => clock
  const versions = new FastVersions({ dir: path.join(dir, 'fast-trees'), executor: rt.executor, library: rt.library, sandbox: rt.sandbox, config: fast.versions })
  versions.loadLatest()
  const monitor = new FastMonitor({ executor: rt.executor, runtimeDir: dir, config: { incidentQuietMs: 5000, episodeMergeMs: 10000, ...fast.monitor }, now })
  const reflector = new FastReflector({ executor: rt.executor, monitor, currentVersion: () => versions.latest(), config: { batchSize: 3, ...fast.reflector }, now })
  reflector.start(monitor.start())
  const poll = () => rt.game.pollOnce()
  const step = async () => {
    await poll()
    rt.executor.tick()
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return { ...rt, runtimeDir: dir, versions, monitor, reflector, poll, step, advance: (ms) => { clock += ms } }
}

/** otherwise 下掉一次血，等静默窗口过去，落成一条事件。 */
async function incident(rt, { amount = 1, type = 'minecraft:fall' } = {}) {
  rt.mod.health -= amount
  rt.mod.lastDamage = { type, ticksAgo: 0 }
  await rt.step()
  rt.advance(6000)
  await rt.step()
  return [...rt.monitor.events.values()].at(-1)
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

// ── P3a 感知 ────────────────────────────────────────────────────────────────

test('player 一直在轮询集合里；没有任务时死亡 → 松键、自动重生；快树事件流记一条 death（高）', async () => {
  const rt = fastRuntime()
  const { mod, executor, events, monitor } = rt
  assert.ok(executor.game.pollSources.has('player'), '没有任务也轮询 player（P3-D1）')
  await rt.step()
  mod.pressed.add('key/up')
  mod.lastDamage = { type: 'minecraft:lava', ticksAgo: 0 }
  mod.health = 0
  mod.deathMessage = 'Steve tried to swim in lava'
  await runUntil(executor, () => events.some((e) => e.event === 'player/respawned'), { beforeTick: rt.poll, maxTicks: 20000 })

  assert.equal(mod.health, 20, '已重生')
  assert.equal(mod.pressed.has('key/up'), false, '松了键')
  const record = [...monitor.events.values()].at(-1)
  assert.equal(record.kind, 'death')
  assert.equal(record.level, 'high')
  assert.deepEqual(record.harm.types, { 'minecraft:lava': 1 })
  assert.equal(record.harm.died, true)
  assert.equal(record.harm.deathMessage, 'Steve tried to swim in lava')
  assert.equal(monitor.snapshot(`after@${record.id}`).state.player.dead, true, '死亡事件的 after 是死前缓存')
})

test('重生失败（极限模式）：记 respawn-failed，之后还死着就不再重试', async () => {
  const rt = fastRuntime()
  rt.mod.hardcore = true
  await rt.step()
  rt.mod.health = 0
  await runUntil(rt.executor, () => rt.events.some((e) => e.event === 'player/respawn-failed'), { beforeTick: rt.poll, maxTicks: 20000 })
  const calls = rt.mod.calls.filter(([m]) => m === 'player/respawn').length
  for (let i = 0; i < 5; i++) await rt.step()
  assert.equal(rt.mod.calls.filter(([m]) => m === 'player/respawn').length, calls)
})

// ── P3b 事件流 ──────────────────────────────────────────────────────────────

test('otherwise 下掉血按事故合并：静默 5 s 才结束；记总量、次数、伤害类型、最低生命；前后快照', async () => {
  const rt = fastRuntime()
  const { mod, monitor } = rt
  mod.air = 120
  await rt.step()
  mod.health = 18
  mod.lastDamage = { type: 'minecraft:drown', ticksAgo: 0 }
  await rt.step()
  rt.advance(2000)
  mod.health = 16
  await rt.step()
  rt.advance(4000)
  await rt.step()
  assert.equal(monitor.events.size, 0, '两次掉血间隔 < 5 s，事故还没结束')
  rt.advance(1500)
  await rt.step()
  await settle()

  const [record] = monitor.events.values()
  assert.equal(record.kind, 'unhandled-harm')
  assert.equal(record.level, 'high')
  assert.equal(record.arm, null)
  assert.deepEqual(record.harm, { total: 4, hits: 2, types: { 'minecraft:drown': 2 }, minHealth: 16, minAir: 120, died: false })
  assert.equal(monitor.snapshot(`before@${record.id}`).state.player.vitals.health, '20.0', 'before = 第一次掉血前那次轮询')
  assert.deepEqual(Object.keys(monitor.snapshot(`after@${record.id}`).state).sort(), ['container', 'f3', 'inventory', 'player'], 'after 现场读全')
  assert.ok(fs.existsSync(path.join(rt.runtimeDir, 'fast', 'snapshots', `${record.id}.json`)))
  assert.ok(fs.readFileSync(path.join(rt.runtimeDir, 'fast', 'events.jsonl'), 'utf8').includes('"event":"fast/event"'))
})

test('同一 arm 的相邻情节并成一条；情节中掉血 → arm-harmed（中）；arm 统计', async () => {
  const rt = fastRuntime()
  const { mod, executor, events, monitor, versions } = rt
  assert.equal(versions.loadManual({ match: '反射', arms: [airArm()] }, '测试').ok, true)
  await rt.step()
  mod.air = 50
  await runUntil(executor, () => events.filter((e) => e.event === 'fast/episode-end').length >= 2, { beforeTick: rt.poll })
  mod.health = 17
  await runUntil(executor, () => monitor.current?.hits.length === 1, { beforeTick: rt.poll })
  mod.air = 300
  await runUntil(executor, () => !executor.episode, { beforeTick: rt.poll })
  rt.advance(10000)
  await rt.step()

  const [record] = monitor.events.values()
  assert.equal(record.kind, 'arm-harmed')
  assert.equal(record.level, 'medium')
  assert.equal(record.arm, '上浮')
  assert.ok(record.episodes >= 2, `并成了一条（${record.episodes} 次情节）`)
  const [stats] = monitor.armStats(1)
  assert.equal(stats.arm, '上浮')
  assert.equal(stats.hits, record.episodes)
  assert.equal(stats.harmed, 1)
})

test('两步动作的 arm（先转视角、再按跳）：每步只做一次，情节 SUCCESS 结束（P3 验收发现：快树 seq 原先缺省 reactive，第一步会被反复重做）', async () => {
  const rt = fastRuntime()
  const { mod, executor, events, versions } = rt
  const arm = { when: { cond: 'code/test.air-below', read: ['player'], params: { value: 100 } }, then: { seq: '抬头上浮', do: [
    { steps: '抬头', do: [['camera/turn', { dy: -90 }], ['wait', 10]] },
    swimUp('上浮', 30)
  ] } }
  assert.equal(versions.loadManual({ match: '反射', arms: [arm] }, '测试').ok, true)
  await rt.step()
  mod.air = 50
  await runUntil(executor, () => events.some((e) => e.event === 'fast/episode-end'), { beforeTick: async () => { await rt.poll(); if (mod.calls.some(([m, p]) => m === 'key/jump' && p.pressed)) mod.air = 300 } })
  const end = events.find((e) => e.event === 'fast/episode-end')
  assert.equal(end.status, 'SUCCESS')
  const count = (method, pressed) => mod.calls.filter(([m, p]) => m === method && (pressed === undefined || p.pressed === pressed)).length
  assert.equal(count('camera/turn'), 1, '第一步只做了一次')
  assert.equal(count('key/jump', true), 1, '第二步做到了')
})

test('arm 失败 → arm-failed（高），带错误原文；情节超时按 FAILURE 收场', async () => {
  for (const [then, pattern, config] of [
    [{ act: 'container/slot', params: { slot: 0 }, name: '点格子' }, /no menu/, {}],
    [swimUp('憋气', 5000), /longer than 60 ms/, { fastMaxEpisodeMs: 60 }]
  ]) {
    const rt = fastRuntime({ config })
    assert.equal(rt.versions.loadManual({ match: '反射', arms: [{ when: airArm().when, then }] }, '测试').ok, true)
    await rt.step()
    rt.mod.air = 50
    await runUntil(rt.executor, () => rt.events.some((e) => e.event === 'fast/episode-end'), { beforeTick: rt.poll })
    rt.mod.air = 300
    await rt.step()
    rt.advance(10000)
    await rt.step()
    const [record] = rt.monitor.events.values()
    assert.equal(record.kind, 'arm-failed')
    assert.match(record.armError, pattern)
    assert.equal(rt.mod.pressed.has('key/jump'), false, '超时后松了键')
  }
})

// ── P3c 版本链 ──────────────────────────────────────────────────────────────

test('补丁：加 arm + 条件代码 → v1 落盘、生效；代码以 fast. 存进库并钉住 hash', async () => {
  const rt = fastRuntime()
  await rt.step()
  const result = rt.versions.submit({
    base: 0, reason: '溺水时没有反射', batchId: 'b1', events: ['e1'], code: AIR_LOW,
    ops: [{ op: 'add', arm: { when: { cond: 'code/fast.air-low', read: ['player'], params: { value: 100 } }, then: swimUp() } }]
  })
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.equal(result.version, 1)
  assert.deepEqual(result.diff, ['+ 新增 arm "上浮"'])
  assert.equal(rt.executor.fast.version, 1)
  assert.match(rt.executor.fast.spec.arms[0].when.ref, /^code\/fast\.air-low@[0-9a-f]{8}$/)
  assert.ok(rt.library.readManifest()['code/fast.air-low'])
  const meta = JSON.parse(fs.readFileSync(path.join(rt.runtimeDir, 'fast-trees', 'v1.meta.json'), 'utf8'))
  assert.equal(meta.by, 'reflection')
  assert.equal(meta.batchId, 'b1')
  assert.deepEqual(meta.codeRefs, [rt.executor.fast.spec.arms[0].when.ref])

  rt.mod.air = 50
  await runUntil(rt.executor, () => rt.executor.episode?.name === '上浮', { beforeTick: rt.poll })
})

test('补丁被拒：代码不入库；base 不是最新 → 附最新版与差异；各种结构错误', async () => {
  const rt = fastRuntime()
  await rt.step()
  const v = rt.versions
  const bad = v.submit({ base: 0, reason: 'x', code: { 'fast.bad': AIR_LOW['fast.air-low'] }, ops: [{ op: 'add', arm: { when: { cond: 'code/fast.bad', read: ['player'], params: { value: 1 } }, then: { seq: '', do: [] } } }] })
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join(), /needs a name/)
  assert.equal(rt.library.readManifest()['code/fast.bad'], undefined, '被拒的补丁不写库')

  assert.equal(v.submit({ base: 0, reason: 'r', ops: [{ op: 'add', arm: airArm('A') }] }).ok, true)
  const conflict = v.submit({ base: 0, reason: 'r', ops: [{ op: 'add', arm: airArm('B') }] })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.conflict.latest, 1)
  assert.deepEqual(conflict.conflict.diff, ['+ 新增 arm "A"'])

  const errors = (ops, extra = {}) => v.submit({ base: 1, reason: 'r', ops, ...extra }).errors?.join('\n') ?? ''
  assert.match(errors([{ op: 'add', arm: airArm('A') }]), /already exists/)
  assert.match(errors([{ op: 'remove', name: 'Z' }]), /no arm named "Z"/)
  assert.match(errors([{ op: 'move', name: 'A' }]), /move needs "before" or "after"/)
  assert.match(errors([{ op: 'fly' }]), /op must be one of/)
  assert.match(errors([]), /non-empty/)
  assert.match(errors([{ op: 'add', arm: airArm('C') }], { code: { 'air-low': AIR_LOW['fast.air-low'] } }), /must be named fast\./)
  assert.match(errors([{ op: 'add', arm: { when: { cond: 'code/fast.boom', read: ['player'] }, then: swimUp('C') } }], {
    code: { 'fast.boom': { signature: { returns: 'bool' }, body: 'function main(p, s) { return s.player.nope.x }' } }
  }), /throws on the current state/)
  assert.match(errors([{ op: 'add', arm: { when: airArm().when, then: { seq: 'D', do: [{ act: 'key/hotbar', params: { slot: '$slot' } }] } } }]), /黑板/)
  assert.match(errors([{ op: 'add', arm: airArm('E', 100, 40000) }]), /episode is cut off after 30000 ms/)
})

test('replace / move / remove 与差异；回滚 = 旧版另存为新版；情节中提交 → 等情节结束再换上', async () => {
  const rt = fastRuntime()
  const v = rt.versions
  await rt.step()
  assert.equal(v.submit({ base: 0, reason: 'r', ops: [{ op: 'add', arm: airArm('A') }, { op: 'add', arm: airArm('B', 50) }] }).ok, true)
  const moved = v.submit({ base: 1, reason: 'r', ops: [{ op: 'move', name: 'B', before: 'A' }, { op: 'replace', name: 'A', arm: airArm('A2', 80) }] })
  assert.equal(moved.ok, true, JSON.stringify(moved.errors))
  assert.deepEqual(moved.arms, ['B', 'A2'])
  assert.deepEqual(moved.diff, ['+ 新增 arm "A2"', '- 删除 arm "A"'])
  assert.deepEqual(v.submit({ base: 2, reason: 'r', ops: [{ op: 'remove', name: 'B' }] }).arms, ['A2'])

  const back = v.rollback(1, '撤销')
  assert.equal(back.ok, true)
  assert.equal(back.version, 4)
  assert.deepEqual(back.arms, ['A', 'B'])
  assert.equal(v.read(4).meta.by, 'rollback')
  assert.equal(v.read(4).meta.target, 1)
  assert.equal(v.rollback(4).ok, false, '已经是当前版本')

  rt.mod.air = 10
  await runUntil(rt.executor, () => rt.executor.episode?.phase === 'running', { beforeTick: rt.poll })
  assert.equal(v.submit({ base: 4, reason: 'r', ops: [{ op: 'remove', name: 'B' }] }).ok, true)
  assert.equal(rt.executor.fast.version, 4, '情节中不换')
  assert.equal(rt.executor.nextFast.version, 5)
  rt.mod.air = 300
  await runUntil(rt.executor, () => rt.executor.fast.version === 5, { beforeTick: rt.poll })
  assert.ok(rt.events.some((e) => e.event === 'fast/load-deferred'))
})

test('重启：版本链装最新版；事件、arm 统计、批次从 events.jsonl 重放，没结束的批次记 abandoned、事件回到待反思', async () => {
  const first = fastRuntime()
  first.reflector.on('batch', () => {})
  await first.step()
  for (let i = 0; i < 3; i++) await incident(first)
  await first.step()
  assert.deepEqual(first.reflector.status().running, ['b1'])
  first.monitor.stop()
  first.reflector.stop()

  const second = fastRuntime({ runtimeDir: first.runtimeDir })
  assert.equal(second.monitor.events.size, 3)
  assert.equal(second.monitor.seq, 3)
  assert.deepEqual(second.reflector.status().pending, ['e1', 'e2', 'e3'])
  const lines = fs.readFileSync(path.join(first.runtimeDir, 'fast', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.some((r) => r.event === 'fast/batch-end' && r.batchId === 'b1' && r.outcome === 'abandoned'))
  second.reflector.on('batch', () => {})
  await second.step()
  assert.deepEqual(second.reflector.status().running, ['b2'], '批次号接着往下编')
})

// ── P3d 批次与反思 ─────────────────────────────────────────────────────────

test('批次：凑够 3 条打批；在飞期间新事件不进当前批，攒到它结束后一起打成下一批；死亡立即打批；情节中不打批', async () => {
  const rt = fastRuntime()
  const batches = []
  rt.reflector.on('batch', (b) => batches.push(b))
  await rt.step()
  await incident(rt)
  await incident(rt)
  assert.equal(batches.length, 0)
  await incident(rt)
  await rt.step()
  assert.equal(batches.length, 1)
  assert.deepEqual(batches[0].events, ['e1', 'e2', 'e3'])
  assert.equal(batches[0].base, 0)

  for (let i = 0; i < 4; i++) await incident(rt)
  await rt.step()
  assert.equal(batches.length, 1, '并行已满：不打批')
  assert.equal(rt.reflector.end('b1', 'skipped', { reason: '偶发' }), true)
  await rt.step()
  assert.deepEqual(rt.reflector.status().running, ['b2'])
  assert.deepEqual(batches[1].events, ['e4', 'e5', 'e6', 'e7'], '在飞期间攒下的事件一起进下一批')
  assert.equal(rt.reflector.end('b1', 'skipped'), false, '结束过的批次不能再结束')
  rt.reflector.end('b2', 'skipped', { reason: 'x' })

  // 情节中不打批：死在情节里，情节结束后（死亡已经结束了它）才打
  assert.equal(rt.versions.loadManual({ match: '反射', arms: [airArm('憋气', 100, 5000)] }, '测试').ok, true)
  rt.mod.air = 50
  await runUntil(rt.executor, () => rt.executor.episode?.phase === 'running', { beforeTick: rt.poll })
  rt.mod.health -= 2
  await rt.step()
  assert.equal(batches.length, 2, '情节中不打批')
  rt.mod.health = 0
  rt.mod.air = 300
  await runUntil(rt.executor, () => batches.length === 3, { beforeTick: rt.poll, maxTicks: 20000 })
  const died = rt.monitor.events.get(batches[2].events[0])
  assert.equal(died.kind, 'arm-harmed')
  assert.equal(died.level, 'high', '死在情节里：高')
  assert.equal(died.harm.died, true)
})

test('FastBridge：批次 → 开会话、推目录；fast_inspect 七种查看；fast_submit_patch 通过 → 新版本、批次 patched', async () => {
  const rt = fastRuntime()
  const delivered = []
  const prompts = loadPrompts(DEFAULTS.promptsDir)
  const bridge = new FastBridge({
    reflector: rt.reflector, versions: rt.versions, monitor: rt.monitor, executor: rt.executor, prompts,
    openSession: async () => 'fs1', deliver: (sessionId, message) => { delivered.push({ sessionId, message }); return true }
  })
  await rt.step()
  rt.mod.air = 40
  await rt.step()
  const record = await incident(rt, { amount: 2, type: 'minecraft:drown' })
  await settle()
  rt.monitor.flush()
  const batch = rt.reflector.flush()
  await settle()

  assert.equal(delivered[0].sessionId, 'fs1')
  const { text, source } = delivered[0].message
  assert.deepEqual(source, { kind: 'stevex-fast', batchId: batch.batchId, reason: 'batch' })
  assert.match(text, /快树反思批次 b1（1 条事件，当前快树 v0）/)
  assert.match(text, new RegExp(`${record.id}  高  unhandled-harm  v0  otherwise  掉血 2（1 次：minecraft:drown ×1）`))
  assert.match(text, /# skill：快树反思/)
  assert.match(text, /# skill：快树生成/)
  assert.equal(bridge.isFastSession('fs1'), true)
  assert.ok(bridge.toolsFor('fs1').includes('fast_submit_patch'))
  assert.equal(bridge.toolsFor('other'), null)

  const look = (args) => bridge.inspect(args)
  assert.equal((await look({ what: 'event', id: record.id })).value.kind, 'unhandled-harm')
  assert.equal((await look({ what: 'trace', id: record.id })).value.hits[0].type, 'minecraft:drown')
  const diff = await look({ what: 'snapshot', name: `after@${record.id}`, against: `before@${record.id}`, sources: ['player'] })
  assert.equal(diff.value.diff.player.health, '20.0 → 18.0')
  assert.match(diff.value.summary, /health 20\.0 → 18\.0/)
  const when = { cond: 'code/fast.air-low', read: ['player'], params: { value: 100 } }
  const evalBefore = await look({ what: 'eval', when, code: AIR_LOW, at: `before@${record.id}` })
  assert.equal(evalBefore.value.result, true, '还没提交的代码也能求值')
  assert.equal(rt.library.readManifest()['code/fast.air-low'], undefined, 'eval 不写库')
  assert.match((await look({ what: 'eval', when, at: `before@${record.id}` })).error, /no capsule named code\/fast\.air-low/)
  assert.equal((await look({ what: 'live', sources: ['player'] })).value.name, 'live#1')
  assert.deepEqual((await look({ what: 'versions' })).value.versions, [])
  assert.match((await look({ what: 'nope' })).error, /what must be one of/)

  const [inspectTool, submitTool, skipTool] = fastTools({ fastBridge: bridge })
  const exec = { agent: { id: 'fs1' } }
  const out = await inspectTool.execute({ what: 'snapshot', name: `before@${record.id}` }, exec)
  assert.doesNotThrow(() => JSON.stringify(out))

  const wrong = await submitTool.execute({ batchId: 'b1', base: 0, reason: 'r', ops: [{ op: 'remove', name: 'X' }] }, exec)
  assert.equal(wrong.ok, false)
  assert.equal(wrong.attemptsLeft, 2)
  assert.match(submitTool.output.render({}, wrong)[0].text, /剩余次数：2/)
  assert.match((await submitTool.execute({ batchId: 'b1', base: 0, reason: 'r', ops: [] }, { agent: { id: 'other' } })).error, /属于另一个会话/)

  const ok = await submitTool.execute({ batchId: 'b1', base: 0, reason: '溺水没有反射', code: AIR_LOW, ops: [{ op: 'add', arm: { when, then: swimUp() } }] }, exec)
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(ok.version, 1)
  assert.equal(rt.reflector.batches.get('b1').outcome, 'patched')
  assert.equal(rt.versions.read(1).meta.batchId, 'b1')
  assert.deepEqual(rt.versions.read(1).meta.events, [record.id])
  assert.equal(bridge.onTurnStopping({ sessionId: 'fs1' }), null, '批次结束，回合可以结束')
  assert.equal(bridge.onTurnStopping({ sessionId: 'other' }), undefined, '不是快树会话')
  assert.match((await skipTool.execute({ batchId: 'b1', reason: 'x' }, exec)).error, /已经结束/)
  assert.equal((await look({ what: 'arms' })).value.arms[0].arm, '上浮')
  assert.match((await look({ what: 'versions', id: 1 })).value.tree, /steps "上浮"/)
})

test('FastBridge：没提交就结束回合 → 提醒、计次；用完 → abandoned；fast_skip 写理由；开会话失败 → abandoned', async () => {
  const rt = fastRuntime()
  const prompts = loadPrompts(DEFAULTS.promptsDir)
  let sessions = 0
  let failOpen = false
  const bridge = new FastBridge({
    reflector: rt.reflector, versions: rt.versions, monitor: rt.monitor, executor: rt.executor, prompts,
    openSession: async () => { if (failOpen) throw new Error('no model'); return `fs${++sessions}` },
    deliver: () => true
  })
  await rt.step()
  await incident(rt)
  rt.reflector.flush()
  await settle()
  const first = bridge.onTurnStopping({ sessionId: 'fs1' })
  assert.match(first.steer.text, /快树批次 b1 还没有结束/)
  assert.match(first.steer.text, /还剩 2 次/)
  const retry = bridge.onTurnError({ sessionId: 'fs1', error: new Error('bad JSON') })
  assert.match(retry.retry.text, /bad JSON/)
  assert.equal(bridge.onTurnStopping({ sessionId: 'fs1' }), null, '第 3 次：用完')
  assert.equal(rt.reflector.batches.get('b1').outcome, 'abandoned')

  await incident(rt)
  rt.reflector.flush()
  await settle()
  assert.equal(bridge.skip({ sessionId: 'fs2', batchId: 'b2', reason: ' ' }).ok, false, '理由必填')
  assert.equal(bridge.skip({ sessionId: 'fs2', batchId: 'b2', reason: '偶发的摔伤' }).ok, true)
  assert.equal(rt.reflector.batches.get('b2').reason, '偶发的摔伤')

  failOpen = true
  await incident(rt)
  rt.reflector.flush()
  await settle()
  assert.equal(rt.reflector.batches.get('b3').outcome, 'abandoned')
  assert.match(rt.reflector.batches.get('b3').reason, /no model/)
  assert.deepEqual(rt.reflector.status().pending, [], '三批的事件都已反思过，不再进批')
})

test('两个进程共用版本目录：后写的看到对方的版本、不覆盖（游戏内验收：旧进程把人手放的 v2 盖掉了）', () => {
  const rt = fastRuntime()
  const dir = rt.versions.dir
  const other = new FastVersions({ dir, executor: rt.executor, library: rt.library, sandbox: rt.sandbox })
  assert.equal(other.loadManual({ match: '反射', arms: [airArm('甲')] }, '另一个进程').version, 1)
  assert.equal(rt.versions.latest(), 0, '这个进程还不知道')
  const stale = rt.versions.submit({ base: 0, ops: [{ op: 'add', arm: airArm('乙') }], reason: '基于旧版' })
  assert.equal(stale.ok, false)
  assert.equal(stale.conflict.latest, 1, '写之前重新看了目录')
  const mine = rt.versions.loadManual({ match: '反射', arms: [airArm('乙')] }, '这个进程')
  assert.equal(mine.version, 2)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'v1.meta.json'), 'utf8')).reason, '另一个进程', 'v1 没被覆盖')
})
