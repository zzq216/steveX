import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { Bridge, REQUEST_TOOLS } from '../src/llm/bridge.js'
import { loadPrompts } from '../src/llm/prompts.js'
import { createLocalResponder } from '../src/bt/index.js'
import { treeTools } from '../src/tools/index.js'
import { makeRuntime, runUntil } from './helpers.js'

const prompts = loadPrompts(fileURLToPath(new URL('../prompts', import.meta.url)))
const okCond = { cond: 'blackboard/compare', params: { key: 'ok', op: '>=', value: 1 }, name: '确认' }
const TREE = { seq: '演示', do: [{ act: 'key/hotbar', params: { slot: 1 } }, okCond] }
const BUMP = {
  bump: {
    description: '加 1',
    signature: { inputs: { n: { type: 'int', required: true } }, outputs: { n: { type: 'int' } } },
    body: 'function main(p: { n: number }) { return { n: p.n + 1 } }'
  }
}

function setup() {
  const rt = makeRuntime({ config: { observe: { enabled: true } } })
  const delivered = []
  const bridge = new Bridge({
    executor: rt.executor, library: rt.library, sandbox: rt.sandbox, prompts,
    deliver: (sessionId, message) => { delivered.push({ sessionId, ...message }); return true },
    notify: () => {}
  })
  const answered = []
  createLocalResponder(rt.executor, { skip: (request) => bridge.ownsTask(request.taskId), log: (line) => answered.push(line) })
  return { ...rt, bridge, delivered, answered }
}

/** 规划 → 大纲通过 → 跑到 failed 请求 */
async function toFailed({ bridge, executor, delivered }) {
  const plan = bridge.startPlanning({ sessionId: 's1', instruction: '演示修复' })
  assert.equal(bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree: TREE, blackboard: { ok: 0 } }).ok, true)
  await runUntil(executor, () => delivered.length === 2)
  return delivered[1]
}

test('属于会话的任务失败 → 消息只推目录与树、配「慢树反思」；回合准入 bt_inspect 与 bt_submit_patch；补丁带代码草稿修好后跑完', async () => {
  const rt = setup()
  const { bridge, executor, answered } = rt
  const message = await toFailed(rt)
  assert.equal(message.source.reason, 'failed')
  assert.match(message.text, /# 修复请求 r\d+/)
  assert.match(message.text, /failed：节点 n1\.2「确认」失败/)
  assert.match(message.text, /快照  after@n1\.1, before@n1\.1/)
  assert.match(message.text, /黑板  1 个键：ok/)
  assert.match(message.text, /n1\.2 cond blackboard\/compare .* ← 失败/)
  assert.match(message.text, /skill：慢树反思/)
  assert.doesNotMatch(message.text, /"ok": 0|ok: 0/, '黑板值不推')
  assert.equal(answered.length, 0, '本地应答器跳过属于会话的任务')

  const claimed = bridge.onPreStep({ sessionId: 's1', turn: 2, step: 1, messages: [{ source: message.source }] })
  assert.deepEqual(claimed.tools, REQUEST_TOOLS.failed)
  assert.ok(claimed.tools.includes('bt_inspect') && claimed.tools.includes('bt_submit_patch'))
  assert.ok(!claimed.tools.includes('nbt_query'), '修复回合仍然看不到记忆世界的值（P2 §4.5）')
  assert.ok(!REQUEST_TOOLS.plan.includes('bt_inspect') && !REQUEST_TOOLS.expand.includes('bt_inspect'), 'plan / expand 回合不准入（I13），由守卫拒绝')

  const bb = await bridge.inspect({ what: 'blackboard', keys: ['ok'] })
  assert.deepEqual(bb.value.values, { ok: 0 }, 'bt_inspect 给值')

  const requestId = message.source.requestId
  assert.match(bridge.submitExpansion({ sessionId: 's1', requestId, subtree: {} }).error, /bt_submit_patch/)
  const patched = bridge.submitPatch({
    sessionId: 's1', requestId, code: BUMP,
    ops: [{ op: 'insert-before', id: 'n1.2', node: { compute: 'task/bump', params: { n: '$ok' }, writes: { ok: 'n' } } }]
  })
  assert.equal(patched.ok, true, JSON.stringify(patched))
  assert.equal(patched.version, 2)
  assert.deepEqual(patched.ids, ['n1.2.p2'])
  assert.equal(bridge.onTurnStopping({ sessionId: 's1', turn: 2 }), null, '交过了')
  await runUntil(executor, () => executor.task.state === 'done')
  assert.match(bridge.view().task.tree, /n1\.2\.p2 compute task\/bump.*\(补丁 r\d+ failed\)/)
})

test('修复回合没提交就结束 → 提醒用 bt_submit_patch，计一次不合法尝试', async () => {
  const rt = setup()
  const message = await toFailed(rt)
  rt.bridge.onPreStep({ sessionId: 's1', turn: 2, step: 1, messages: [{ source: message.source }] })
  const stop = rt.bridge.onTurnStopping({ sessionId: 's1', turn: 2 })
  assert.match(stop.steer.text, /bt_submit_patch/)
  assert.equal(rt.executor.task.pending.invalidAttempts, 1)
})

test('不属于会话的任务（/bt run）：修复请求由本地应答器回答，不发给大模型', async () => {
  const rt = setup()
  rt.executor.startTask({ tree: TREE, blackboard: { ok: 0 } })
  await runUntil(rt.executor, () => rt.executor.task.state === 'failed')
  assert.equal(rt.delivered.length, 0)
  assert.match(rt.answered[0], /失败/)
})

test('bt_inspect 工具：结果超过字节上限时截断并提示缩小范围；出错不是工具错误', async () => {
  const rt = setup()
  await toFailed(rt)
  const tools = treeTools({ bridge: rt.bridge, maxOutputChars: 20000, inspectMaxBytes: 300 })
  const tool = tools.find((t) => t.name === 'bt_inspect')
  const snapshot = await tool.execute({ what: 'snapshot', name: 'before@n1.1' })
  const text = tool.output.render({}, snapshot)[0].text
  assert.ok(Buffer.byteLength(text) < 600)
  assert.match(text, /已截断到 300；请缩小范围/)
  const bad = await tool.execute({ what: 'snapshot', name: 'nope' })
  assert.match(tool.output.render({}, bad)[0].text, /没有结果：no snapshot "nope"/)
})

test('属于会话的任务死亡 → died 请求发给大模型：死亡恢复模板、「慢树恢复」、目录带死亡信息', async () => {
  const rt = setup()
  const { bridge, executor, delivered, mod, game } = rt
  executor.config.respawnPollMs = 5
  const plan = bridge.startPlanning({ sessionId: 's1', instruction: '演示死亡' })
  const tree = { seq: '走', do: [{ steps: '前进', do: [['key/up', { pressed: true }], ['wait', 3000], ['key/up', { pressed: false }]] }] }
  assert.equal(bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree }).ok, true)
  const poll = () => game.pollOnce()
  await runUntil(executor, () => mod.pressed.has('key/up'), { beforeTick: poll })
  mod.health = 0
  mod.deathMessage = 'Steve was blown up by Creeper'
  await runUntil(executor, () => delivered.length === 2, { beforeTick: poll, maxTicks: 20000 })

  const message = delivered[1]
  assert.equal(message.source.reason, 'died')
  assert.match(message.text, /# 死亡恢复请求 r\d+/)
  assert.match(message.text, /错误：Steve was blown up by Creeper/)
  assert.match(message.text, /n1\.1 steps "前进".* ← 死亡时在跑/)
  assert.match(message.text, /skill：慢树恢复/)
  assert.match(message.summary, /死亡并已重生/)
  assert.deepEqual(bridge.onPreStep({ sessionId: 's1', turn: 2, step: 1, messages: [{ source: message.source }] }).tools, REQUEST_TOOLS.died)
  assert.equal(bridge.submitPatch({ sessionId: 's1', requestId: message.source.requestId, ops: [] }).ok, true)
})

test('bt_inspect 工具的每种输出都是无损 JSON（DSH 拒收 undefined：INVALID_TOOL_OUTPUT）', async () => {
  const rt = setup()
  const message = await toFailed(rt)
  const tool = treeTools({ bridge: rt.bridge, maxOutputChars: 20000 }).find((t) => t.name === 'bt_inspect')
  const lossless = (value) => assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
  assert.ok(rt.executor.task.events.some((e) => e.event === 'node' && e.phase === 'enter'), '有 node 事件（enter 没有 status / error）')
  for (const args of [
    { what: 'events', last: 30 }, { what: 'node', id: 'n1.2' }, { what: 'snapshot', name: 'before@n1.1' },
    { what: 'eval', id: 'n1.2' }, { what: 'blackboard', keys: ['ok'] }, { what: 'live' }, { what: 'versions' }
  ]) {
    const out = await tool.execute(args)
    assert.equal(out.ok, true, `${args.what}: ${out.error}`)
    lossless(out)
  }
  assert.ok(message)
})
