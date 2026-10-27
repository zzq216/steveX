import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bridge, SOURCE_KIND, REQUEST_TOOLS } from '../src/llm/bridge.js'
import { loadPrompts, renderTemplate } from '../src/llm/prompts.js'
import { saveCapsule } from '../src/capsules/index.js'
import { makeRuntime, runUntil, tempDir } from './helpers.js'

const prompts = loadPrompts(fileURLToPath(new URL('../prompts', import.meta.url)))

const OUTLINE = {
  seq: '演示任务',
  do: [
    { steps: '切到 1 号栏', do: [['key/hotbar', { slot: 1 }]] },
    { expand: '算出 42 并确认' }
  ]
}

const DOUBLE = {
  double: {
    description: '乘 2',
    signature: { inputs: { n: { type: 'int', required: true } }, outputs: { double: { type: 'int' } } },
    body: 'function main(p: { n: number }) { return { double: p.n * 2 } }'
  }
}

const EXPANSION = {
  seq: '算 42',
  do: [
    { compute: 'task/double', params: { n: 21 }, writes: { 'calc.double': 'double' } },
    { cond: 'blackboard/compare', params: { key: 'calc.double', op: '==', value: 42 } }
  ]
}

function setup({ deliverOk = true, runtimeDir = null } = {}) {
  const rt = makeRuntime()
  const delivered = []
  const notified = []
  const bound = []
  const bridge = new Bridge({
    executor: rt.executor, library: rt.library, sandbox: rt.sandbox, prompts, runtimeDir,
    deliver: (sessionId, message) => { delivered.push({ sessionId, ...message }); return deliverOk },
    notify: (sessionId, message) => notified.push({ sessionId, ...message }),
    onBind: (sessionId, turn, tools) => bound.push({ sessionId, turn, tools })
  })
  return { ...rt, bridge, delivered, notified, bound }
}

/** 模拟 DSH：followup 的消息在下一回合第一个 step 进来 */
function claim(bridge, delivered, turn) {
  const message = delivered.at(-1)
  return bridge.onPreStep({ sessionId: message.sessionId, turn, step: 1, messages: [{ source: message.source }] })
}

test('完整流程：/bt task → 大纲（先错后对）→ 执行到 expand → followup → 展开（带代码草稿）→ 跑完 → 复盘请求', async () => {
  const runtimeDir = tempDir()
  const { bridge, executor, library, delivered, notified, bound } = setup({ runtimeDir })

  const plan = bridge.startPlanning({ sessionId: 's1', instruction: '演示：切栏位再算个数' })
  assert.equal(plan.ok, true)
  assert.equal(delivered.length, 1)
  assert.deepEqual(delivered[0].source, { kind: SOURCE_KIND, taskId: plan.taskId, requestId: plan.requestId, reason: 'plan' })
  assert.match(delivered[0].text, /演示：切栏位再算个数/)
  assert.match(delivered[0].text, /skill：慢树大纲/)
  assert.equal(bridge.currentTaskId(), plan.taskId, '规划期间的查询就用这个任务的数据快照')

  assert.deepEqual(claim(bridge, delivered, 1), { requestId: plan.requestId, tools: REQUEST_TOOLS.plan })
  assert.deepEqual(bound, [{ sessionId: 's1', turn: 1, tools: REQUEST_TOOLS.plan }])

  const bad = bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree: { act: 'fly' } })
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join('\n'), /unknown command "fly"/)
  assert.equal(bad.attemptsLeft, 2)

  const good = bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree: OUTLINE })
  assert.equal(good.ok, true, JSON.stringify(good))
  assert.equal(good.taskId, plan.taskId)
  assert.equal(good.version, 1)
  assert.match(good.tree, /n1\.2 expand "算出 42 并确认"/)
  assert.equal(bridge.onTurnStopping({ sessionId: 's1', turn: 1 }), null, '交过了，回合可以结束')

  await runUntil(executor, () => executor.task.state === 'suspended')
  assert.equal(delivered.length, 2)
  const expand = delivered[1]
  assert.equal(expand.source.reason, 'expand')
  assert.match(expand.text, /需要展开：\*\*n1\.2\*\* — 算出 42 并确认/)
  assert.match(expand.text, /n1\.1 steps "切到 1 号栏".*\[SUCCESS\]/)
  assert.match(expand.text, /n1\.2 expand "算出 42 并确认" ← 待展开/)

  assert.equal(claim(bridge, delivered, 2).requestId, expand.source.requestId)
  const view = bridge.view()
  assert.equal(view.task.pending.nodeId, 'n1.2')

  const wrongType = bridge.submitTree({ sessionId: 's1', requestId: expand.source.requestId, tree: OUTLINE })
  assert.match(wrongType.error, /bt_submit_expansion/)
  const otherSession = bridge.submitExpansion({ sessionId: 's2', requestId: expand.source.requestId, subtree: EXPANSION })
  assert.match(otherSession.error, /另一个会话/)

  const noDraft = bridge.submitExpansion({ sessionId: 's1', requestId: expand.source.requestId, subtree: EXPANSION })
  assert.equal(noDraft.ok, false)
  assert.match(noDraft.errors.join('\n'), /no task draft named task\/double/)

  const done = bridge.submitExpansion({ sessionId: 's1', requestId: expand.source.requestId, subtree: EXPANSION, code: DOUBLE })
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(done.version, 2)
  assert.ok(library.list().some((row) => row.draft && row.ref.startsWith('task/double@')))
  const draftDir = path.join(runtimeDir, 'tasks', plan.taskId, 'code')
  assert.equal(fs.readdirSync(draftDir).filter((f) => f.startsWith('double@')).length, 1, '草稿落盘')

  await runUntil(executor, () => executor.task.state === 'done')
  assert.equal(executor.task.blackboard.get('calc.double'), 42)
  assert.equal(notified.length, 0, '复盘请求代替了结束通知（P4）')
  assert.equal(delivered.at(-1).source.reason, 'reflect')
  assert.match(delivered.at(-1).text, /复盘请求 c1（任务 \S+，已结束：done/)
  assert.equal(library.list().some((row) => row.draft), false, '任务结束，草稿不可再引用')
  assert.throws(() => library.pin('task/double'), /no task draft/)
})

test('I5：没提交就结束回合 → 提醒并计一次；用完 3 次 → 规划作废 / 任务失败', async () => {
  const { bridge, executor, delivered } = setup()
  const plan = bridge.startPlanning({ sessionId: 's1', instruction: '做点什么' })
  claim(bridge, delivered, 1)

  const first = bridge.onTurnStopping({ sessionId: 's1', turn: 1 })
  assert.match(first.steer.text, /bt_submit_tree/)
  assert.match(first.steer.text, /还剩 2 次/)
  assert.equal(first.steer.source.requestId, plan.requestId)
  const invalid = bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree: { act: 'fly' } })
  assert.equal(invalid.attemptsLeft, 1, '提醒与不合法提交共用 3 次')
  assert.deepEqual(bridge.onTurnStopping({ sessionId: 's1', turn: 1 }), { failed: true })
  assert.equal(bridge.planning, null)
  assert.match(bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree: OUTLINE }).error, /已经回答过或已关闭/)

  // expand 请求同理，用完 → 任务失败
  const plan2 = bridge.startPlanning({ sessionId: 's1', instruction: '再来' })
  assert.equal(bridge.submitTree({ sessionId: 's1', requestId: plan2.requestId, tree: OUTLINE }).ok, true)
  await runUntil(executor, () => executor.task.state === 'suspended')
  claim(bridge, delivered, 2)
  assert.ok(bridge.onTurnStopping({ sessionId: 's1', turn: 2 }).steer)
  assert.ok(bridge.onTurnStopping({ sessionId: 's1', turn: 2 }).steer)
  assert.deepEqual(bridge.onTurnStopping({ sessionId: 's1', turn: 2 }), { failed: true })
  assert.equal(executor.task.state, 'failed')
  assert.match(executor.task.result, /invalid 3 times/)
})

test('任务串行：有任务在跑时不能开新规划；bt_abort_task 放弃规划 / 任务', () => {
  const { bridge, executor } = setup()
  const plan = bridge.startPlanning({ sessionId: 's1', instruction: 'A' })
  assert.match(bridge.startPlanning({ sessionId: 's1', instruction: 'B' }).error, /还在等 bt_submit_tree/)
  assert.deepEqual(bridge.abort({ sessionId: 's1', reason: '不做了' }), { ok: true, cancelled: 'plan', requestId: plan.requestId, taskId: plan.taskId })

  const plan2 = bridge.startPlanning({ sessionId: 's1', instruction: 'C' })
  bridge.submitTree({ sessionId: 's1', requestId: plan2.requestId, tree: OUTLINE })
  assert.match(bridge.startPlanning({ sessionId: 's1', instruction: 'D' }).error, /还在 running/)
  assert.match(bridge.abort({ sessionId: 's2', reason: 'x' }).error, /另一个会话/)
  assert.equal(bridge.abort({ sessionId: 's1', reason: '换个任务' }).cancelled, 'task')
  assert.equal(executor.task.state, 'failed')
  assert.equal(bridge.startPlanning({ sessionId: 's1', instruction: 'D' }).ok, true)
})

test('路由 task handler 的回合内规划：不 followup，直接绑定本回合', () => {
  const { bridge, delivered, bound } = setup()
  const res = bridge.startPlanning({ sessionId: 's1', instruction: '做一把木镐', turn: 7 })
  assert.equal(res.ok, true)
  assert.equal(delivered.length, 0)
  assert.match(res.text, /规划请求 p1/)
  assert.deepEqual(bound, [{ sessionId: 's1', turn: 7, tools: REQUEST_TOOLS.plan }])
  assert.equal(bridge.onPreStep({ sessionId: 's1', turn: 7, step: 2, messages: [] }).requestId, 'p1')
  assert.equal(bridge.onPreStep({ sessionId: 's1', turn: 8, step: 1, messages: [{ source: { kind: 'user' } }] }), null)
})

test('会话找不到 / 被关掉：任务立即失败（§7.2 审阅点 6）', async () => {
  const lost = setup({ deliverOk: false })
  assert.match(lost.bridge.startPlanning({ sessionId: 'gone', instruction: 'x' }).error, /找不到会话/)
  assert.equal(lost.bridge.planning, null)

  const { bridge, executor, delivered } = setup()
  const plan = bridge.startPlanning({ sessionId: 's1', instruction: 'x' })
  bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree: OUTLINE })
  await runUntil(executor, () => executor.task.state === 'suspended')
  assert.equal(delivered.length, 2)
  bridge.onSessionClosed('s1')
  assert.equal(executor.task.state, 'failed')
  assert.match(executor.task.result, /closed/)
})

test('代码草稿：不合法的草稿计入不合法次数；库里的子树胶囊不能引用草稿', () => {
  const { bridge, library, sandbox, registry } = setup()
  const plan = bridge.startPlanning({ sessionId: 's1', instruction: 'x' })
  const res = bridge.submitTree({
    sessionId: 's1', requestId: plan.requestId, tree: OUTLINE,
    code: { broken: { signature: { inputs: {}, outputs: { a: { type: 'int' } } }, body: 'function main( {' } }
  })
  assert.equal(res.ok, false)
  assert.match(res.errors[0], /^code\.broken: /)
  assert.equal(res.attemptsLeft, 2)

  assert.equal(bridge.writeDrafts(DOUBLE).length, 0)
  const saved = saveCapsule({ library, sandbox, registry }, 'trees', {
    name: 'uses-draft', signature: { inputs: {} },
    body: { compute: 'task/double', params: { n: 1 } }
  })
  assert.equal(saved.ok, false)
  assert.match(saved.errors[0], /cannot reference a task draft/)
})

test('提示词：所有模板的变量都填得上', () => {
  assert.throws(() => renderTemplate('{{x}}', {}), /missing variable "x"/)
  for (const name of ['identity', 'authoring']) assert.ok(prompts.system[name].length > 200)
  assert.doesNotThrow(() => renderTemplate(prompts.requests.reminder, { requestId: 'r1', submitTool: 't', attemptsLeft: 1 }))
  assert.doesNotThrow(() => renderTemplate(prompts.requests.task_end, { taskId: 't', state: 'done', goal: 'g', result: 'r' }))
})

test('I13：产出树的回合不准入读状态 / 查数据的工具；展开请求与 bt_view 里的黑板只有形状、没有值', async () => {
  for (const tools of Object.values(REQUEST_TOOLS)) {
    for (const name of ['mod_query', 'nbt_query', 'json_query']) assert.equal(tools.includes(name), false, name)
  }
  const { bridge, executor, delivered } = setup()
  const plan = bridge.startPlanning({ sessionId: 's1', instruction: '搬原木' })
  const blackboard = { 'log.slot': { slot: 36, item: 'minecraft:oak_log' }, 'log.cells': [[1, 2], [3, 4]], 'log.found': true }
  assert.equal(bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree: { seq: '搬', do: [{ expand: '把 $log.slot 的原木放进箱子' }] }, blackboard }).ok, true)
  await runUntil(executor, () => executor.task.state === 'suspended')

  const text = delivered.at(-1).text
  assert.match(text, /log\.slot: \{slot: int, item: string\}/)
  assert.match(text, /log\.cells: list\(2\) of list\(2\) of int/)
  assert.match(text, /log\.found: bool/)
  assert.doesNotMatch(text, /36|oak_log|true/, '具体值不出现在请求里')
  assert.doesNotMatch(bridge.view().task.blackboard, /36|oak_log/)
})

test('回合出错（如模型返回坏 JSON）：计一次不合法，发重试消息开新回合；用完 → 作废 / 任务失败', async () => {
  const { bridge, executor, delivered } = setup()
  assert.equal(bridge.onTurnError({ sessionId: 's1', turn: 9, error: new Error('x') }), null, '没绑定请求的回合不管')

  const plan = bridge.startPlanning({ sessionId: 's1', instruction: '做点什么' })
  claim(bridge, delivered, 1)
  const first = bridge.onTurnError({ sessionId: 's1', turn: 1, error: { message: 'DeepSeek Messages stream: tool input is invalid JSON', code: 'MALFORMED_RESPONSE' } })
  assert.equal(first.retry.source.requestId, plan.requestId)
  assert.equal(first.retry.source.reason, 'retry')
  assert.match(first.retry.text, /tool input is invalid JSON/)
  assert.match(first.retry.text, /还剩 2 次/)
  assert.equal(bridge.onTurnStopping({ sessionId: 's1', turn: 1 }), null, '出错的回合已解绑，之后的 turn-stopping 不重复计数')

  // 重试消息开的新回合按来源重新绑定
  assert.equal(bridge.onPreStep({ sessionId: 's1', turn: 2, step: 1, messages: [{ source: first.retry.source }] }).requestId, plan.requestId)
  assert.ok(bridge.onTurnError({ sessionId: 's1', turn: 2, error: 'boom' }).retry)
  bridge.onPreStep({ sessionId: 's1', turn: 3, step: 1, messages: [{ source: first.retry.source }] })
  assert.deepEqual(bridge.onTurnError({ sessionId: 's1', turn: 3, error: 'boom' }), { failed: true })
  assert.equal(bridge.planning, null, '规划作废，不再挡住新任务')
  assert.equal(bridge.startPlanning({ sessionId: 's1', instruction: '新任务' }).ok, true)

  // expand 请求出错 → 记在执行器的在飞请求上
  const plan2 = bridge.planning
  bridge.submitTree({ sessionId: 's1', requestId: plan2, tree: OUTLINE })
  await runUntil(executor, () => executor.task.state === 'suspended')
  const turn = 10
  bridge.onPreStep({ sessionId: 's1', turn, step: 1, messages: [{ source: delivered.at(-1).source }] })
  assert.match(bridge.onTurnError({ sessionId: 's1', turn, error: 'boom' }).retry.text, /bt_submit_expansion/)
  assert.equal(executor.task.pending.invalidAttempts, 1)
})
