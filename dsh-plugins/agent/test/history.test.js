import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bridge, REQUEST_TOOLS, REFLECT_ONLY_TOOLS } from '../src/llm/bridge.js'
import { loadPrompts } from '../src/llm/prompts.js'
import { buildProfile, formatProfile, splitCalls } from '../src/history/profile.js'
import { TaskHistory } from '../src/history/store.js'
import { CapsuleStats } from '../src/capsules/stats.js'
import { historyTools } from '../src/tools/history.js'
import { makeRuntime, runUntil, tempDir } from './helpers.js'

const prompts = loadPrompts(fileURLToPath(new URL('../prompts', import.meta.url)))

// ── 成本画像（H1）──

const t = (ms) => new Date(Date.UTC(2026, 10, 3, 0, 0, 0) + ms).toISOString()
const ev = (ms, event, extra = {}) => ({ at: t(ms), taskId: 'task-1', event, ...extra })

test('profile: running time excludes waits for LLM turns; calls roll up to every open node and capsule; repeats are listed', () => {
  const events = [
    ev(0, 'task/start', { goal: 'g' }),
    ev(0, 'node', { phase: 'enter', id: 'n1', type: 'Sequence' }),
    ev(0, 'node', { phase: 'enter', id: 'n1.1', type: 'Expand' }),
    ev(100, 'request', { requestId: 'r1', type: 'expand' }),
    ev(100, 'task/state', { state: 'suspended' }),
    ev(5100, 'task/state', { state: 'running' }),
    ev(5100, 'node', { phase: 'exit', id: 'n1.1', type: 'Expand', status: 'SUCCESS' }),
    ...[0, 1, 2].flatMap((i) => [
      ev(5100 + i * 1000, 'node', { phase: 'enter', id: 'n1.2', type: 'SubTree' }),
      ev(5100 + i * 1000, 'node', { phase: 'enter', id: 'n1.2/c.1', type: 'Action' }),
      ev(5900 + i * 1000, 'node', { phase: 'exit', id: 'n1.2/c.1', type: 'Action', status: 'SUCCESS', calls: { actions: 3, reads: 2, observe: 4, settle: 1 } }),
      ev(6000 + i * 1000, 'node', { phase: 'exit', id: 'n1.2', type: 'SubTree', status: 'SUCCESS', ref: 'trees/craft.once@abc' })
    ]),
    ev(8100, 'node', { phase: 'exit', id: 'n1', type: 'Sequence', status: 'SUCCESS' }),
    ev(8100, 'task/state', { state: 'done' }),
    ev(8100, 'task/done', {})
  ]
  const p = buildProfile(events)
  assert.equal(p.outcome, 'done')
  assert.equal(p.durationMs, 8100)
  assert.equal(p.waitMs, 5000)
  assert.equal(p.execMs, 3100)
  assert.deepEqual(p.waits, { 展开: { count: 1, ms: 5000 } })
  assert.deepEqual([p.modCalls, p.actions, p.reads, p.observeReads, p.settleReads], [15, 9, 6, 12, 3], '执行器的观察 / 等稳定读取单列，不进 modCalls')
  assert.deepEqual(p.capsules[0], { ref: 'trees/craft.once@abc', runs: 3, modCalls: 15, ms: 2700, callShare: 1, timeShare: 2700 / 3100 })
  const root = p.nodes.find((n) => n.id === 'n1')
  assert.equal(root.ms, 3100, 'the outer node does not get the 5 s spent waiting for the expansion')
  assert.equal(root.modCalls, 15)
  assert.deepEqual(p.repeats.map((r) => r.key), ['trees/craft.once@abc'], 'nodes inside the capsule are not listed again')
  const text = formatProfile(p)
  assert.match(text, /执行 3\.1 s（不含等 LLM 回合 5\.0 s：展开 1 次 5\.0 s）/)
  assert.match(text, /trees\/craft\.once@abc 执行 3 次，占 mod 调用 100%/)
  assert.match(text, /mod 调用 15 次（树发出的：动作 9 \/ 读取 6）.*；另有执行器的观察读取 12 次、等稳定读取 3 次/)
  assert.equal(buildProfile([ev(0, 'node', { phase: 'enter', id: 'x' })]), null)
})

// ── 任务记录、检索、淘汰（H4、H5、H9）──

function storeWith(events, options = {}) {
  const dir = tempDir('stevex-history-')
  const history = new TaskHistory({ dir: path.join(dir, 'history'), capsulesDir: path.join(dir, 'capsules'), ...options })
  for (const e of events) history.observe(e)
  return { history, dir }
}

const TASK_EVENTS = (taskId, ref = 'trees/craft.once@abc') => [
  { at: t(0), taskId, event: 'task/start' },
  { at: t(0), taskId, event: 'node', phase: 'enter', id: 'n1', type: 'SubTree' },
  { at: t(10), taskId, event: 'node', phase: 'enter', id: 'n1/c', type: 'Action' },
  { at: t(20), taskId, event: 'node', phase: 'exit', id: 'n1/c', type: 'Action', status: 'SUCCESS', calls: { actions: 4, reads: 1, observe: 2 } },
  { at: t(30), taskId, event: 'node', phase: 'exit', id: 'n1', type: 'SubTree', status: 'SUCCESS', ref },
  { at: t(30), taskId, event: 'task/done' }
]

test('history: assessment checks, record, search (empty is fine), get, capsule notes, review closes the predecessor', () => {
  const { history, dir } = storeWith([...TASK_EVENTS('task-a'), ...TASK_EVENTS('task-b')])
  const spec = { id: 'n1', use: 'trees/craft.once@abc' }

  assert.deepEqual(history.search({ query: 'stick' }), [], 'nothing recorded yet → empty list')

  const bad = history.checkAssessment({ issues: [{ where: 'n9', kind: 'speed', problem: '', evidence: 'x' }], none: 'also none' }, { taskId: 'task-a', spec })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((e) => /issues 和 none 只能写一个/.test(e)))
  assert.ok(bad.errors.some((e) => /"n9" 不在这次的树里/.test(e)))
  assert.ok(bad.errors.some((e) => /kind/.test(e)) && bad.errors.some((e) => /problem 必填/.test(e)))
  assert.match(history.checkAssessment({}, { taskId: 'task-a', spec }).errors[0], /没有问题时写 none/)

  const ok = history.checkAssessment({ issues: [{ where: 'trees/craft.once', kind: 'cost', problem: '每次都重开界面', evidence: '调用 5 次，占 100%', idea: '一次放满' }] }, { taskId: 'task-a', spec })
  assert.equal(ok.ok, true, JSON.stringify(ok.errors))
  const a = history.record({ task: { taskId: 'task-a', goal: '合成 8 个 minecraft:stick', state: 'done', spec }, tree: 'n1 use trees/craft.once', assessment: ok.assessment, usage: { turns: 2, tokens: { total: 900 } } })
  assert.deepEqual([a.metrics.modCalls, a.metrics.actions, a.metrics.turns], [5, 4, 2])
  assert.deepEqual(a.capsules, ['trees/craft.once@abc'])
  assert.ok(a.keywords.includes('stick') && a.keywords.includes('minecraft:stick'))
  assert.ok(fs.existsSync(path.join(dir, 'history', 'task-a.json')))

  const notes = history.notesFor('trees/craft.once@abc')
  assert.equal(notes.length, 1)
  assert.deepEqual([notes[0].id, notes[0].hash, notes[0].status], ['task-a#0', 'abc', 'open'])
  assert.ok(fs.existsSync(path.join(dir, 'capsules', 'notes.json')))

  const found = history.search({ query: 'stick' })
  assert.deepEqual(found.map((r) => [r.taskId, r.openIssues]), [['task-a', 1]])
  const got = history.get('task-a')
  assert.equal(got.retrieved.count, 1)
  assert.equal(got.spec, undefined, 'the authoring spec stays on disk; the agent reads the tree text')
  assert.match(history.get('task-a', { node: 'n9' }).tree, /没有以 n9 开头/)

  // 下一个同类任务参考了 task-a：核对它的问题
  const wrong = history.checkAssessment({ none: '没有重复', review: [{ record: 'task-a', issue: 3, status: 'resolved', evidence: 'x' }] }, { taskId: 'task-b', spec, predecessors: ['task-a'] })
  assert.equal(wrong.ok, false)
  assert.match(wrong.errors[0], /issue 写复盘请求里该问题前面方括号中的序号[\s\S]*\{ record: "task-a", issue: 0 \}/)
  // 常见的写法偏差也认：record 带 #序号、issue 是数字字符串、issue 抄了问题原文
  for (const item of [{ record: 'task-a#0' }, { record: 'task-a [0]（cost）：每次都重开界面' }, { record: 'task-a', issue: '0' }, { record: 'task-a', issue: '每次都重开界面' }]) {
    const loose = history.checkAssessment({ none: 'x', review: [{ ...item, status: 'resolved', evidence: 'y' }] }, { taskId: 'task-b', spec, predecessors: ['task-a'] })
    assert.equal(loose.ok, true, `${JSON.stringify(item)}: ${JSON.stringify(loose.errors)}`)
    assert.deepEqual([loose.assessment.review[0].record, loose.assessment.review[0].issue], ['task-a', 0])
  }
  assert.match(history.checkAssessment({ none: 'x', review: [{ record: 'task-a', issue: 0, status: 'resolved', evidence: 'y' }] }, { taskId: 'task-b', spec, predecessors: [] }).errors[0], /没有可核对的以往问题/)
  const reviewed = history.checkAssessment({ none: '一次放满后只取一次', review: [{ record: 'task-a', issue: 0, status: 'resolved', evidence: 'modCalls 5 → 2' }] }, { taskId: 'task-b', spec, predecessors: ['task-a'] })
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed.errors))
  history.record({ task: { taskId: 'task-b', goal: '合成 8 个 minecraft:stick', state: 'done', spec }, assessment: reviewed.assessment, predecessors: ['task-a'] })
  const prev = history.read('task-a')
  assert.equal(prev.assessment.issues[0].status, 'resolved')
  assert.equal(prev.assessment.issues[0].reviews[0].by, 'task-b')
  assert.ok(prev.archived, 'rule 1: all issues reviewed and a later task built on it → archived')
  assert.ok(fs.existsSync(path.join(dir, 'history', 'archive', 'task-a.json')))
  assert.deepEqual(history.notesFor('trees/craft.once'), [], 'the capsule note follows the review')
  assert.deepEqual(history.search({ query: 'stick' }).map((r) => r.taskId), ['task-b'])
  assert.equal(history.search({ query: 'stick', archived: true }).length, 2)

  // 重新打开：索引和笔记从磁盘读回
  const again = new TaskHistory({ dir: path.join(dir, 'history'), capsulesDir: path.join(dir, 'capsules') })
  assert.deepEqual(again.search({ query: 'stick' }).map((r) => r.taskId), ['task-b'])
})

test('history gc: never-retrieved old records and the active cap are archived (dry run first); open + retrieved ones are kept', () => {
  let now = Date.UTC(2026, 10, 3)
  const { history } = storeWith([], { now: () => now, config: { archiveUnseenDays: 30, maxActive: 2 } })
  const put = (id, issues = []) => {
    for (const e of TASK_EVENTS(id)) history.observe(e)
    history.record({ task: { taskId: id, goal: id, state: 'done' }, assessment: issues.length ? { issues, none: null, review: [] } : { issues: [], none: 'ok', review: [] } })
  }
  put('old')
  put('kept', [{ where: 'n1', kind: 'cost', problem: 'p', evidence: 'e' }])
  history.get('kept')
  now += 40 * 86_400_000
  put('new1')
  put('new2')
  const plan = history.gc()
  assert.deepEqual(plan.map((p) => p.taskId).sort(), ['new1', 'old'])
  assert.ok(!history.read('old').archived, 'dry run does not move anything')
  history.gc({ apply: true })
  assert.ok(history.read('old').archived && history.read('new1').archived)
  assert.ok(!history.read('kept').archived && !history.read('new2').archived)
})

// ── 和执行器、Bridge 一起（H2、H7）──

const OUTLINE = { seq: '演示任务', do: [{ steps: '切到 1 号栏', do: [['key/hotbar', { slot: 1 }], ['key/hotbar', { slot: 2 }]] }] }

function setup({ reflect } = {}) {
  const rt = makeRuntime()
  const history = new TaskHistory({ dir: null })
  rt.executor.on('event', (record) => history.observe(record))
  const delivered = []
  const bridge = new Bridge({
    executor: rt.executor, library: rt.library, sandbox: rt.sandbox, registry: rt.registry, prompts, history,
    ...(reflect ? { reflect } : {}),
    taskUsage: () => ({ turns: 1, tokens: null }),
    deliver: (sessionId, message) => { delivered.push({ sessionId, ...message }); return true },
    notify: () => {}
  })
  const claim = (turn) => {
    const message = delivered.at(-1)
    return bridge.onPreStep({ sessionId: message.sessionId, turn, step: 1, messages: [{ source: message.source }] })
  }
  const tools = Object.fromEntries(historyTools({ history, bridge, maxOutputChars: 20000 }).map((tool) => [tool.name, tool]))
  return { ...rt, bridge, history, delivered, claim, tools }
}

async function runTask(ctx, turn) {
  const plan = ctx.bridge.startPlanning({ sessionId: 's1', instruction: '切栏' })
  ctx.claim(turn)
  return plan
}

test('bridge: the review shows the cost profile; done tasks must be assessed; task_get during planning makes a predecessor that the next review checks', async () => {
  const ctx = setup({ reflect: { onDone: 'always' } })
  const { bridge, executor, tools, history } = ctx
  assert.ok(REQUEST_TOOLS.plan.includes('task_search') && REQUEST_TOOLS.reflect.includes('task_assess') && !REQUEST_TOOLS.curate.includes('task_search'))
  assert.ok(REFLECT_ONLY_TOOLS.includes('task_assess'))

  const first = await runTask(ctx, 1)
  assert.equal(bridge.submitTree({ sessionId: 's1', requestId: first.requestId, tree: OUTLINE }).ok, true)
  await runUntil(executor, () => executor.task.state === 'done')
  const review = ctx.delivered.at(-1)
  assert.match(review.text, /## 成本画像[\s\S]*mod 调用 2 次（树发出的：动作 2 \/ 读取 0）/)
  assert.match(review.text, /LLM 回合：规划（发请求到交树）[\d.]+ s，执行中等 LLM（展开 \/ 修补）[\d.]+ s/)
  assert.match(review.text, /以往任务里待验证的问题[\s\S]*（没有：/)
  assert.match(review.text, /和参考过的同类任务比\n\n（没有：/)
  ctx.claim(2)
  assert.match(bridge.reflectDone({ sessionId: 's1', requestId: 'c1', summary: '没存' }).error, /先用 task_assess/)
  const rejected = bridge.assess({ sessionId: 's1', requestId: 'c1', issues: [{ where: 'n7', kind: 'cost', problem: 'p', evidence: 'e' }] })
  assert.ok(rejected.errors.some((e) => /不在这次的树里/.test(e)))
  assert.ok(bridge.assess({ sessionId: 's1', requestId: 'c1', issues: [{ where: 'n1.1', kind: 'cost', problem: 'p', evidence: 'e', status: 'later' }] }).errors.some((e) => /status 要是 open \/ blocked/.test(e)))
  assert.equal(bridge.assess({ sessionId: 's1', requestId: 'c1', issues: [
    { where: 'n1.1', kind: 'cost', problem: '切了两次栏', evidence: '动作 2 次' },
    { where: 'n1', kind: 'cost', problem: '没有一次切两栏的命令', evidence: '动作 2 次', status: 'blocked' }
  ] }).ok, true)
  assert.equal(bridge.reflectDone({ sessionId: 's1', requestId: 'c1', summary: '记了一条' }).ok, true)
  const firstId = executor.task.taskId
  const rec = history.read(firstId)
  assert.deepEqual([rec.metrics.modCalls, rec.metrics.turns, rec.assessment.issues[0].status, rec.assessment.issues[1].status], [2, 1, 'open', 'blocked'])
  assert.ok(Number.isFinite(rec.metrics.planMs) && Number.isFinite(rec.metrics.reflectMs), JSON.stringify(rec.metrics))
  assert.deepEqual(history.openIssues([firstId])[0].issues.map((i) => i.index), [0], 'blocked 不进核对队列')

  // 第二个任务：规划时查历史并 task_get → 前驱
  const second = await runTask(ctx, 3)
  const search = await tools.task_search.execute({ query: '切栏' })
  assert.deepEqual(search.tasks.map((r) => r.taskId), [firstId])
  const viewed = await tools.task_get.execute({ taskId: firstId }, { agent: { id: 's1' } })
  assert.equal(viewed.viewedBy, second.taskId)
  assert.equal((await tools.task_get.execute({ taskId: 'nope' }, { agent: { id: 's1' } })).ok, false)
  assert.equal(bridge.submitTree({ sessionId: 's1', requestId: second.requestId, tree: OUTLINE }).ok, true)
  await runUntil(executor, () => executor.task.state === 'done' && executor.task.taskId === second.taskId)
  const review2 = ctx.delivered.at(-1)
  assert.match(review2.text, new RegExp(`${firstId}（切栏）\\n  \\[0\\] n1\\.1（cost）：切了两次栏`))
  assert.match(review2.text, new RegExp(`这次：mod 调用 2 次[^\\n]*复盘 （进行中）[^\\n]*\\n${firstId}：mod 调用 2 次，执行 [\\d.]+ s，回合 1；规划 [\\d.]+ s，执行中等 LLM [\\d.]+ s，复盘 [\\d.]+ s[^\\n]*（done；切栏）`))
  ctx.claim(4)
  assert.equal(bridge.assess({ sessionId: 's1', requestId: 'c2', none: '只切了需要的栏', review: [{ record: firstId, issue: 0, status: 'wrong', evidence: '两次切栏是题目要求的' }] }).ok, true)
  assert.equal(bridge.reflectDone({ sessionId: 's1', requestId: 'c2', summary: '核对了上一条' }).ok, true)
  assert.equal(history.read(firstId).assessment.issues[0].status, 'wrong')
  assert.deepEqual(history.read(second.taskId).predecessors, [firstId])
})

test('reflect.onDone = changed（2026-11-21）：参考过同类任务、同样的调用次数、没有新情况的 done 任务不复盘，只写历史；调用次数不同照常复盘', async () => {
  const ctx = setup()
  const { bridge, executor, tools, history } = ctx
  const first = await runTask(ctx, 1)
  assert.equal(bridge.submitTree({ sessionId: 's1', requestId: first.requestId, tree: OUTLINE }).ok, true)
  await runUntil(executor, () => executor.task.state === 'done')
  assert.match(ctx.delivered.at(-1).text, /# 复盘请求 c1/, '没参考过同类任务：复盘')
  ctx.claim(2)
  assert.equal(bridge.assess({ sessionId: 's1', requestId: 'c1', none: '没问题' }).ok, true)
  assert.equal(bridge.reflectDone({ sessionId: 's1', requestId: 'c1', summary: '没存' }).ok, true)
  const firstId = executor.task.taskId

  const second = await runTask(ctx, 3)
  await tools.task_get.execute({ taskId: firstId }, { agent: { id: 's1' } })
  assert.equal(bridge.submitTree({ sessionId: 's1', requestId: second.requestId, tree: OUTLINE }).ok, true)
  await runUntil(executor, () => executor.task.state === 'done' && executor.task.taskId === second.taskId)
  assert.doesNotMatch(ctx.delivered.at(-1).text, /# 复盘请求/, '同类、同样 2 次调用、没有新情况：不复盘')
  assert.ok(executor.task.events.some((e) => e.event === 'reflect/skipped'))
  const rec = history.read(second.taskId)
  assert.deepEqual([rec.outcome, rec.assessment, rec.predecessors], ['done', null, [firstId]], '照样写任务历史')
  assert.deepEqual(bridge.doneChanges(executor.task), [])

  const third = await runTask(ctx, 4)
  await tools.task_get.execute({ taskId: firstId }, { agent: { id: 's1' } })
  const three = { seq: '演示任务', do: [{ steps: '切三次栏', do: [['key/hotbar', { slot: 1 }], ['key/hotbar', { slot: 2 }], ['key/hotbar', { slot: 3 }]] }] }
  assert.equal(bridge.submitTree({ sessionId: 's1', requestId: third.requestId, tree: three }).ok, true)
  await runUntil(executor, () => executor.task.state === 'done' && executor.task.taskId === third.taskId)
  assert.match(ctx.delivered.at(-1).text, /# 复盘请求 c2/, '调用次数和参考任务不同：复盘')
  assert.deepEqual(bridge.doneChanges(executor.task), ['mod 调用次数和参考任务不同'])
})

test('reflect.onDone = changed（2026-11-22）：第一次执行的胶囊版本也算新情况；这次的数字已并进统计时扣掉再看', () => {
  const stats = new CapsuleStats()
  const bridge = Object.assign(Object.create(Bridge.prototype), { stats, history: null, historyViews: new Map() })
  const exit = (taskId, ref) => ({ taskId, event: 'node', phase: 'exit', id: 'n1', type: 'SubTree', ref, status: 'SUCCESS' })
  const task = { taskId: 't2', versions: [{}], events: [exit('t2', 'trees/x@aaaaaaaa'), exit('t2', 'trees/y@bbbbbbbb'), exit('t2', 'task/d@cccccccc')] }
  stats.observe(exit('t1', 'trees/x@aaaaaaaa'))
  stats.observe({ taskId: 't1', event: 'task/done', at: 'a' })
  for (const e of task.events) stats.observe(e)
  assert.deepEqual(bridge.firstRuns(task), ['trees/y@bbbbbbbb'], '任务还没并进统计')
  stats.observe({ taskId: 't2', event: 'task/done', at: 'b' })
  assert.deepEqual(bridge.firstRuns(task), ['trees/y@bbbbbbbb'], '已并进统计：扣掉这次的再看')
  assert.ok(bridge.doneChanges(task).includes('第一次执行这些胶囊版本：trees/y@bbbbbbbb'))
  stats.data.refs['trees/z@dddddddd'] = { calls: 0, origin: { calls: 1 } }
  assert.deepEqual(bridge.firstRuns({ taskId: 't3', events: [exit('t3', 'trees/z@dddddddd')] }), [], '保存前作为原节点跑过的不算第一次')
  assert.deepEqual(Object.assign(Object.create(Bridge.prototype), { stats: null }).firstRuns(task), [])
})

test('只列这次能核对的以往问题（2026-11-21）：挂在没执行到的胶囊上的、已被两次复盘核为 open 的不列，并写明没列几条', () => {
  const history = new TaskHistory({ dir: null })
  const issue = (index, where, reviews = []) => ({ index, where, kind: 'cost', problem: `p${index}`, evidence: 'e', status: 'open', reviews })
  const opened = (n) => Array.from({ length: n }, (_, i) => ({ by: `t${i}`, status: 'open', evidence: '没走到' }))
  history.writeRecord({ taskId: 'task-a', goal: 'g', assessment: { issues: [
    issue(0, 'n1.2'), issue(1, 'trees/x.ran@aaaaaaaa'), issue(2, 'trees/x.idle'), issue(3, 'n1.3', opened(1)), issue(4, 'n1.4', opened(2))
  ] } })
  history.observe({ taskId: 'task-b', event: 'node', phase: 'exit', id: 'n1', type: 'SubTree', ref: 'trees/x.ran@bbbbbbbb', status: 'SUCCESS' })
  history.observe({ taskId: 'task-b', event: 'node', phase: 'exit', id: 'n2', type: 'Compute', ref: 'task/draft@cccccccc', status: 'SUCCESS' })
  assert.deepEqual([...history.ranCapsules('task-b')], ['trees/x.ran'])
  const [rec] = history.openIssues(['task-a'], { taskId: 'task-b' })
  assert.deepEqual([rec.issues.map((i) => i.index), rec.omitted], [[0, 1, 3], 2])
  assert.equal(history.openIssues(['task-a'])[0].issues.length, 5, '不给 taskId：全列（task_get 等）')
  const checked = history.checkAssessment({ none: 'n', review: [{ record: 'task-a', issue: 4, status: 'open', evidence: 'e' }] }, { taskId: 'task-b', spec: null, predecessors: ['task-a'] })
  assert.ok(checked.errors.some((e) => /对不上待验证的问题/.test(e)), '没列的不能核对')
})

test('profile：旧事件没有 calls.observe 时，Steps / Action 的读取按执行器观察读取算；条件 / Compute 的读取照旧算树的（2026-11-13）', () => {
  const p = buildProfile([
    ev(0, 'task/start', { goal: 'g' }),
    ev(0, 'node', { phase: 'enter', id: 'n1', type: 'Action' }),
    ev(10, 'node', { phase: 'exit', id: 'n1', type: 'Action', status: 'SUCCESS', calls: { actions: 1, reads: 6, settle: 2 } }),
    ev(10, 'node', { phase: 'enter', id: 'n2', type: 'Compute' }),
    ev(20, 'node', { phase: 'exit', id: 'n2', type: 'Compute', status: 'SUCCESS', calls: { actions: 0, reads: 2 } }),
    ev(20, 'task/done', {})
  ])
  assert.deepEqual([p.modCalls, p.actions, p.reads, p.observeReads, p.settleReads], [3, 1, 2, 6, 2])
  assert.deepEqual(splitCalls({ type: 'Action', calls: { actions: 1, reads: 1, observe: 2 } }), { actions: 1, reads: 1, observe: 2, settle: 0 }, '新事件原样拆')
})
