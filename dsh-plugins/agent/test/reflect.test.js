import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { Bridge, REQUEST_TOOLS } from '../src/llm/bridge.js'
import { loadPrompts } from '../src/llm/prompts.js'
import { findLiterals, checkLiterals, collectEvidence } from '../src/capsules/literals.js'
import { diffSpecs } from '../src/bt/diff.js'
import { makeRuntime, runUntil } from './helpers.js'

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
    { compute: 'task/double', read: ['inventory'], params: { n: 21 }, writes: { 'calc.double': 'double' } },
    { cond: 'blackboard/compare', params: { key: 'calc.double', op: '==', value: 42 } }
  ]
}

/** 存成胶囊的版本：21 改成了参数，42 还是字面量（和初始黑板里 goal.value 的值相同；calc.double 是自己的代码算的，不算证据） */
const CAPSULE_BODY = {
  seq: '算两倍并确认',
  do: [
    { compute: 'task/double', read: ['inventory'], params: { n: '$n' }, writes: { 'calc.double': 'double' } },
    { cond: 'blackboard/compare', params: { key: 'calc.double', op: '==', value: 42 } }
  ]
}
const CAPSULE_SIGNATURE = { inputs: { n: { type: 'int', required: true } } }

function setup({ reflect = {} } = {}) {
  const rt = makeRuntime()
  const delivered = []
  const notified = []
  const bridge = new Bridge({
    executor: rt.executor, library: rt.library, sandbox: rt.sandbox, registry: rt.registry, prompts, reflect,
    deliver: (sessionId, message) => { delivered.push({ sessionId, ...message }); return true },
    notify: (sessionId, message) => notified.push({ sessionId, ...message })
  })
  const claim = (turn) => {
    const message = delivered.at(-1)
    return bridge.onPreStep({ sessionId: message.sessionId, turn, step: 1, messages: [{ source: message.source }] })
  }
  return { ...rt, bridge, delivered, notified, claim }
}

/** 规划 → 跑到 expand → 展开（带草稿）。返回时任务挂在 expand 之后、还没跑完 */
async function planAndExpand(ctx) {
  const { bridge, executor, claim } = ctx
  const plan = bridge.startPlanning({ sessionId: 's1', instruction: '算 42' })
  claim(1)
  assert.equal(bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree: OUTLINE, blackboard: { 'goal.value': 42 } }).ok, true)
  await runUntil(executor, () => executor.task.state === 'suspended')
  const expand = claim(2)
  assert.equal(bridge.submitExpansion({ sessionId: 's1', requestId: expand.requestId, subtree: EXPANSION, code: DOUBLE }).ok, true)
  return plan
}

async function finished(options) {
  const ctx = setup(options)
  const plan = await planAndExpand(ctx)
  await runUntil(ctx.executor, () => ctx.executor.task.state === 'done')
  return { ...ctx, plan, review: ctx.delivered.at(-1) }
}

test('任务 done → 复盘请求：目录（版本链、草稿用量）、准入的工具；bt_inspect tree 看版本链；复盘回合没有 live', async () => {
  const { bridge, review, claim, notified } = await finished()
  assert.equal(notified.length, 0)
  assert.equal(review.source.reason, 'reflect')
  assert.match(review.text, /复盘请求 c1（任务 \S+，已结束：done，根 SUCCESS/)
  assert.match(review.text, /v1 大纲 · v2 展开 n1\.2/)
  assert.match(review.text, /task\/double@[0-9a-f]+（被 n1\.2\.1\.1 引用，执行 1 次、成功 1 次）/)
  assert.match(review.text, /skill：任务复盘/)
  assert.deepEqual(claim(3), { requestId: 'c1', tools: REQUEST_TOOLS.reflect })
  assert.ok(REQUEST_TOOLS.reflect.includes('capsule_save') && !REQUEST_TOOLS.reflect.includes('bt_submit_patch'))

  const table = await bridge.inspect({ what: 'tree' }, { sessionId: 's1' })
  assert.deepEqual(table.value.versions.map((v) => [v.version, v.origin]), [[1, 'outline'], [2, 'expand n1.2']])
  const diff = await bridge.inspect({ what: 'tree', version: 2, against: '1' }, { sessionId: 's1' })
  assert.ok(diff.value.added.some((n) => n.id === 'n1.2.1.1'), JSON.stringify(diff.value))
  assert.ok(diff.value.removed.some((n) => n.id === 'n1.2') && diff.value.added.some((n) => n.id === 'n1.2.1'), '展开把 expand 换成了 seq')
  const v1 = await bridge.inspect({ what: 'tree', version: 1 }, { sessionId: 's1' })
  assert.match(v1.value.tree, /n1\.2 expand/)

  assert.match((await bridge.inspect({ what: 'live' }, { sessionId: 's1' })).error, /live is not available/)
  assert.equal(bridge.view({ sessionId: 's1' }).reviewing, 'c1')
  assert.match(bridge.reflectDraft('s1', 'task/double').body, /p\.n \* 2/, '复盘回合里草稿还取得到')
})

test('capsule_save：草稿转正；子树里的 task/ 引用自动改写；写死的值被拒、可带理由保留；同名要 replaces；bt_reflect_done', async () => {
  const { bridge, library, events } = await finished()
  const save = (args) => bridge.saveCapsule({ sessionId: 's1', requestId: 'c1', ...args })

  assert.match(save({ folder: 'code', name: 'x', from: 'task/double' }).errors.join('\n'), /description is required/)
  assert.match(bridge.saveCapsule({ sessionId: 's2', requestId: 'c1', folder: 'code', name: 'x', description: 'x', from: 'task/double' }).error, /另一个会话/)

  const early = save({ folder: 'trees', name: 'calc.answer', description: '算两倍并确认', from: 'n1.2.1', signature: CAPSULE_SIGNATURE, body: CAPSULE_BODY })
  assert.match(early.errors.join('\n'), /save the draft as code\/ first \(capsule_save folder "code"/)

  const code = save({ folder: 'code', name: 'math.double', description: '乘 2', from: 'task/double' })
  assert.equal(code.ok, true, JSON.stringify(code))
  assert.match(code.ref, /^code\/math\.double@/)
  assert.match(code.from.draft, /^task\/double@/)

  const noRead = { ...CAPSULE_BODY, do: [{ ...CAPSULE_BODY.do[0], read: undefined }, CAPSULE_BODY.do[1]] }
  const dropped = save({ folder: 'trees', name: 'calc.answer', description: '算两倍并确认', from: 'n1.2.1', signature: CAPSULE_SIGNATURE, body: noRead, keepLiterals: { 'c.2.params.value': '目标值' } })
  assert.equal(dropped.ok, false)
  assert.match(dropped.errors.join('\n'), /\[c\.1\] code\/math\.double: in this task n1\.2\.1\.1 called it with read: \["inventory"\], here read is \[\] — without it state\.inventory is undefined/)

  const literal = save({ folder: 'trees', name: 'calc.answer', description: '算两倍并确认', from: 'n1.2.1', signature: CAPSULE_SIGNATURE, body: CAPSULE_BODY })
  assert.equal(literal.ok, false)
  assert.match(literal.errors.join('\n'), /c\.2\.params\.value = 42: same as 黑板 goal\.value/)
  assert.match(literal.errors.join('\n'), /keepLiterals with every hit .*\{"c\.2\.params\.value":"<why this is a constant>"\}/)

  const kept = save({ folder: 'trees', name: 'calc.answer', description: '算两倍并确认', from: 'n1.2.1', signature: CAPSULE_SIGNATURE, body: CAPSULE_BODY, keepLiterals: { 'c.2.params.value': '演示：目标值本来就是 42' } })
  assert.equal(kept.ok, true, JSON.stringify(kept))
  assert.deepEqual(kept.rewritten.map((r) => [r.id, r.to]), [['c.1', code.ref]])
  assert.deepEqual(kept.from, { node: 'n1.2.1', runs: 1, successes: 1 })
  assert.deepEqual(Object.keys(kept.keptLiterals), ['c.2.params.value'])
  assert.equal(library.get(kept.ref).body.children[0].ref, code.ref, '胶囊里引用的是转正后的条目')

  const again = save({ folder: 'trees', name: 'calc.answer', description: '另一个', signature: CAPSULE_SIGNATURE, body: CAPSULE_BODY, keepLiterals: { 'c.2.params.value': 'x' } })
  assert.match(again.errors.join('\n'), /already exists .*replaces: "[0-9a-f]+"/)
  const stale = save({ folder: 'trees', name: 'calc.answer', description: '另一个', replaces: 'deadbeef', signature: CAPSULE_SIGNATURE, body: CAPSULE_BODY })
  assert.match(stale.errors.join('\n'), /not the latest version/)
  const hash = kept.ref.split('@')[1]
  const replaced = save({ folder: 'trees', name: 'calc.answer', description: '算两倍并确认（改进）', replaces: hash, signature: CAPSULE_SIGNATURE, body: { ...CAPSULE_BODY, seq: '算两倍' }, keepLiterals: { 'c.2.params.value': '目标值' } })
  assert.equal(replaced.ok, true, JSON.stringify(replaced))
  assert.notEqual(replaced.ref, kept.ref)
  assert.equal(library.tryGet(kept.ref)?.name, 'calc.answer', '老版本原样留着')

  assert.ok(events.some((e) => e.event === 'capsule/saved' && e.ref === kept.ref && e.keptLiterals))
  assert.match(bridge.reflectDone({ sessionId: 's1', requestId: 'c1' }).error, /summary is required/)
  const done = bridge.reflectDone({ sessionId: 's1', requestId: 'c1', summary: '存了乘 2 和算两倍' })
  assert.deepEqual(done.saved, [code.ref, kept.ref, replaced.ref])
  assert.ok(events.some((e) => e.event === 'reflect/done' && e.saved.length === 3))
  assert.match(save({ folder: 'code', name: 'y', description: 'y', from: 'task/double' }).error, /已经回答过或已关闭/)
  assert.equal(bridge.reflectDraft('s1', 'task/double'), null, '复盘结束，证据释放')
})

test('哪些结局复盘：人 /bt abort 只通知（可以手动 /bt reflect）；bt_abort_task 复盘；reflect.enabled = false 只通知', async () => {
  const user = setup()
  await planAndExpand(user)
  user.executor.abortTask('人不想做了')
  assert.equal(user.notified.length, 1)
  assert.notEqual(user.delivered.at(-1).source.reason, 'reflect')
  const manual = user.bridge.reflectLast({ sessionId: 's1' })
  assert.equal(manual.ok, true)
  assert.match(user.delivered.at(-1).text, /人手动发起的复盘/)
  assert.match(user.delivered.at(-1).text, /人放弃/)
  assert.match(user.bridge.reflectLast({ sessionId: 's1' }).error, /还没结束/)

  const agent = setup()
  const plan = agent.bridge.startPlanning({ sessionId: 's1', instruction: '算 42' })
  agent.claim(1)
  agent.bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree: OUTLINE })
  await runUntil(agent.executor, () => agent.executor.task.state === 'suspended')
  assert.equal(agent.bridge.abort({ sessionId: 's1', reason: '做不到' }).ok, true)
  assert.equal(agent.executor.task.finishedBy, 'agent')
  assert.equal(agent.delivered.at(-1).source.reason, 'reflect')
  assert.match(agent.delivered.at(-1).text, /已结束：failed，你用 bt_abort_task 放弃/)

  const off = await finished({ reflect: { enabled: false } })
  assert.equal(off.notified.length, 1)
  assert.match(off.notified[0].text, /已结束：\*\*done\*\*/)
})

test('复盘回合没交：提醒一次，再没交按 abandoned 关闭，已存的胶囊保留；复盘不挡新任务', async () => {
  const { bridge, claim, events, library, executor } = await finished()
  claim(3)
  assert.equal(bridge.saveCapsule({ sessionId: 's1', requestId: 'c1', folder: 'code', name: 'math.double', description: '乘 2', from: 'task/double' }).ok, true)

  const plan = bridge.startPlanning({ sessionId: 's1', instruction: '再算一次' })
  assert.equal(plan.ok, true, '复盘期间可以开始新任务')
  claim(4)
  assert.equal(bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree: OUTLINE }).ok, true)
  assert.notEqual(executor.task.taskId, events.find((e) => e.event === 'reflect/start').taskId)
  const old = await bridge.inspect({ what: 'tree' }, { sessionId: 's1' })
  assert.equal(old.value.versions.length, 2, '复盘看的还是结束的那个任务')

  const steer = bridge.onTurnStopping({ sessionId: 's1', turn: 3 })
  assert.match(steer.steer.text, /复盘请求 c1 还没有结束。本次复盘已经存下：code\/math\.double@/)
  assert.equal(bridge.onTurnStopping({ sessionId: 's1', turn: 3 }), null)
  assert.ok(events.some((e) => e.event === 'reflect/abandoned'))
  assert.ok(library.list().some((row) => row.ref.startsWith('code/math.double@')), '已存的胶囊保留')
  assert.equal(bridge.reflecting().length, 0)
})

test('字面量：树里的参数（跳过 $ 引用、wait、小整数、短串）；代码里的整数与字符串（跳过注释）；keepLiterals 写错的项报错', () => {
  const spec = {
    id: 'c', type: 'Sequence', children: [
      { id: 'c.1', type: 'Steps', do: [['camera/turn', { dy: -90 }], ['wait', 40], ['key/hotbar', { slot: 1 }]] },
      { id: 'c.2', type: 'Action', cmd: 'container/slot', params: { slot: 36, item: '$want', to: [12, 64, -30] } }
    ]
  }
  assert.deepEqual(findLiterals('trees', spec).map((l) => [l.path, l.value]), [
    ['c.1.do[0].params.dy', -90],
    ['c.2.params.slot', 36],
    ['c.2.params.to[0]', 12], ['c.2.params.to[1]', 64], ['c.2.params.to[2]', -30]
  ])
  const source = [
    'function main(p, state) {',
    '  // 36 号格是注释里的，不算',
    "  const want = 'minecraft:oak_log'",
    '  return { slot: state.inventory.slots.find((s) => s.id === want)?.slot ?? 36, n: 1, label: `${p.x}` }',
    '}'
  ].join('\n')
  assert.deepEqual(findLiterals('code', source).map((l) => l.path), ['body:L3:"minecraft:oak_log"'], '代码只比字符串')

  const evidence = new Map([['n:36', '快照 before@n1.3 的 inventory.slots[3].slot']])
  const bad = checkLiterals({ folder: 'trees', body: spec, evidence, keep: { 'c.9.params.x': '?' } })
  assert.match(bad.errors.join('\n'), /keepLiterals\["c\.9\.params\.x"\]: no such hit/)
  assert.match(bad.errors.join('\n'), /c\.2\.params\.slot = 36: same as 快照 before@n1\.3/)
  assert.deepEqual(checkLiterals({ folder: 'trees', body: spec, evidence, keep: { 'c.2.params.slot': '' } }).errors.slice(0, 1), ['keepLiterals["c.2.params.slot"]: give a reason why this value is a constant'])
  assert.deepEqual(checkLiterals({ folder: 'trees', body: spec, evidence, keep: { 'c.2.params.slot': '这个胶囊就是点 36 号格' } }).errors, [])
})

test('证据只取观察来的：自己的 Compute 算出的黑板键、ForEach 循环变量不算；初始黑板、core.* 查询、快照照算', () => {
  const spec = {
    id: 'n1', type: 'Sequence', children: [
      { id: 'n1.1', type: 'Compute', ref: 'code/core.json.query@1234abcd', params: {}, writes: { 'recipe.rows': 'records' } },
      { id: 'n1.2', type: 'Compute', ref: 'task/plan@1234abcd', params: {}, writes: { 'plan.slot': 'slot' } },
      { id: 'n1.3', type: 'ForEach', list: '$plan.clicks', as: 'click', indexAs: 'clickIdx', child: { id: 'n1.3.1', type: 'Action', cmd: 'wait', params: {} } }
    ]
  }
  const blackboard = { 'recipe.rows': [{ item: 'minecraft:stick' }], 'plan.slot': 9, click: { slot: 7 }, clickIdx: 9, 'goal.item': 'minecraft:wooden_axe' }
  const snapshots = new Map([['before@n1.2', { state: { container: { slots: [{ slot: 36, id: 'minecraft:oak_log' }] } } }]])
  const task = {
    spec, versions: [{ spec }],
    blackboard: { snapshot: () => blackboard },
    snapshots: { names: () => [...snapshots.keys()], get: (name) => snapshots.get(name) }
  }
  const evidence = collectEvidence(task)
  assert.equal(evidence.get('s:minecraft:stick'), '黑板 recipe.rows[0].item')
  assert.equal(evidence.get('s:minecraft:wooden_axe'), '黑板 goal.item')
  assert.equal(evidence.get('n:36'), '快照 before@n1.2 的 container.slots[0].slot')
  assert.equal(evidence.has('n:9'), false, 'plan.slot / clickIdx 是自己算的')
  assert.equal(evidence.has('n:7'), false, '循环变量 click 不算')
})

test('diffSpecs：按 id 对齐，字段级差异；孩子顺序变了也算改动', () => {
  const a = { id: 'n1', type: 'Sequence', children: [{ id: 'n1.1', type: 'Action', cmd: 'x', params: { a: 1 } }, { id: 'n1.2', type: 'Action', cmd: 'y' }] }
  const b = { id: 'n1', type: 'Sequence', children: [{ id: 'n1.2', type: 'Action', cmd: 'y' }, { id: 'n1.3', type: 'Action', cmd: 'z' }] }
  const diff = diffSpecs(a, b)
  assert.deepEqual(diff.added.map((n) => n.id), ['n1.3'])
  assert.deepEqual(diff.removed.map((n) => n.id), ['n1.1'])
  assert.deepEqual(diff.changed.map((n) => [n.id, Object.keys(n.fields)]), [['n1', ['children']]])
})
