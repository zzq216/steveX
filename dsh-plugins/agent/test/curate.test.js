import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { Bridge, REQUEST_TOOLS, CURATE_ONLY_TOOLS } from '../src/llm/bridge.js'
import { loadPrompts } from '../src/llm/prompts.js'
import { createTools } from '../src/tools/index.js'
import { CapsuleStats } from '../src/capsules/stats.js'
import { libraryRows, renderLibrary, curateScope, renderScope, scopeCounts, domainOf, lastDoneCurate, lastCurateSeq } from '../src/capsules/curate.js'
import { CapsuleLibrary } from '../src/capsules/library.js'
import { planGc, applyGc } from '../src/capsules/gc.js'
import { saveCapsule } from '../src/capsules/save.js'
import { METHODS, READ_METHODS } from '../src/game/index.js'
import { NBT_SOURCES } from '../src/capsules/index.js'
import { makeRuntime, runUntil, tempDir } from './helpers.js'

const prompts = loadPrompts(fileURLToPath(new URL('../prompts', import.meta.url)))

function setup({ reflect = { enabled: false }, curate = {} } = {}) {
  const rt = makeRuntime()
  const stats = new CapsuleStats({ dir: rt.library.dir })
  rt.executor.on('event', (record) => stats.observe(record))
  const delivered = []
  const idle = []
  const notified = []
  const bridge = new Bridge({
    executor: rt.executor, library: rt.library, sandbox: rt.sandbox, registry: rt.registry, prompts, stats, reflect, curate,
    deliver: (sessionId, message) => { delivered.push({ sessionId, ...message }); return true },
    deliverIdle: (sessionId, message) => { idle.push({ sessionId, ...message }); delivered.push({ sessionId, ...message }); return true },
    notify: (sessionId, message) => notified.push({ sessionId, ...message })
  })
  const claim = (turn, sessionId = 's1') => {
    const message = delivered.at(-1)
    return bridge.onPreStep({ sessionId, turn, step: 1, messages: [{ source: message.source }] })
  }
  const defs = createTools({
    game: rt.game, registry: rt.registry, library: rt.library, stats, bridge,
    methods: METHODS, readMethods: READ_METHODS, nbt: null, nbtSources: NBT_SOURCES,
    json: rt.json, jsonSources: ['recipes'], taskId: () => bridge.currentTaskId(), maxOutputChars: 8000
  })
  const tools = Object.fromEntries(defs.map((def) => [def.name, defineTool(def)]))
  const call = (name, args) => tools[name].execute(args, { agent: { id: 's1' } })
  const text = (name, args, value) => tools[name].output.render(args, value).map((b) => b.text).join('')
  return { ...rt, stats, bridge, delivered, idle, notified, claim, call, text }
}

const SIMPLE = { seq: '演示', do: [{ steps: '切栏', do: [['key/hotbar', { slot: 1 }]] }] }

async function runTask(ctx, tree = SIMPLE) {
  const plan = ctx.bridge.startPlanning({ sessionId: 's1', instruction: '演示' })
  ctx.claim(1)
  const submitted = ctx.bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree })
  assert.equal(submitted.ok, true, JSON.stringify(submitted))
  await runUntil(ctx.executor, () => ctx.executor.task.state === 'done' || ctx.executor.task.state === 'failed')
  return submitted
}

test('/bt curate：全库清单（按名字排序、带统计与旧版本数）、只准入整理工具；忙时直接拒绝、不排队', async () => {
  const ctx = setup()
  const { bridge, delivered, claim, refs } = ctx
  const plan = bridge.startPlanning({ sessionId: 's1', instruction: '演示' })
  assert.match(bridge.startCurate({ sessionId: 's1' }).error, /规划请求 p1 还没结束；等它结束再整理（不排队）/)
  claim(1)
  bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree: SIMPLE })
  assert.match(bridge.startCurate({ sessionId: 's1' }).error, /^任务 \S+ 还在 running/)
  await runUntil(ctx.executor, () => ctx.executor.task.state === 'done')

  const started = bridge.startCurate({ sessionId: 's1' })
  assert.deepEqual(started, { ok: true, requestId: 'k1', mode: 'all' }, '从没完成过整理：按全库发（整理范围方案 R1）')
  const message = delivered.at(-1)
  assert.deepEqual(message.source, { kind: 'stevex-bt', requestId: 'k1', reason: 'curate' })
  assert.match(message.text, /# 整理请求 k1（胶囊库）\n\n（人用 \/bt curate 发起）/)
  assert.match(message.text, /还没有完成过整理，这次整理全库。\n还没有整理过，之后结束了 1 个任务/)
  assert.match(message.text, /## 胶囊库\n/)
  assert.match(message.text, /skill：胶囊库整理/)
  // 写明本回合放行的工具（取自守卫的同一份名单），其他工具会被拒绝
  assert.match(message.text, /本回合只能调用这些 steveX 工具：`command_docs`、.*`capsule_get`、.*`capsule_retire`、`capsule_describe`、`bt_curate_done`。其他工具（如任务历史 `task_search` \/ `task_get`/)
  const listed = message.text.split('\n').filter((l) => l.startsWith('- code/') || l.startsWith('- trees/'))
  assert.deepEqual(listed.map((l) => l.slice(2, l.indexOf('（'))), [...listed.map((l) => l.slice(2, l.indexOf('（')))].sort(), '按名字排序')
  assert.ok(listed.some((l) => l.startsWith(`- ${refs['test.has-item']}（条件）尚无记录｜同名旧版本 0｜背包里 item`)), listed.join('\n'))
  assert.ok(listed.some((l) => /core\.json\.query@\w+（内置查询，内置）/.test(l)))
  assert.match(bridge.startCurate({ sessionId: 's1' }).error, /整理请求 k1 还没结束/)
  assert.equal(ctx.stats.curateState().sinceLast, 0, '发出即清零')

  assert.deepEqual(claim(2), { requestId: 'k1', tools: REQUEST_TOOLS.curate })
  for (const name of CURATE_ONLY_TOOLS) {
    assert.ok(REQUEST_TOOLS.curate.includes(name))
    assert.ok(!REQUEST_TOOLS.reflect.includes(name), `${name} 不在复盘回合（C6）`)
  }
  assert.ok(!REQUEST_TOOLS.curate.includes('capsule_save'), '整理回合不能存新条目（C4）')
})

test('capsule_retire：reason 必填；下架后搜索不出、get 能取、带哈希的树照常能跑并给警告；locked / 内置不能下架；undo；同名新版本清标记', async () => {
  const ctx = setup()
  const { bridge, call, text, library, refs } = ctx
  await runTask(ctx)
  bridge.startCurate({ sessionId: 's1' })
  ctx.claim(2)
  const retire = (args) => call('capsule_retire', { requestId: 'k1', ...args })

  assert.match((await retire({ ref: 'code/test.has-item', reason: '  ' })).error, /reason is required/)
  assert.match((await retire({ ref: 'code/core.json.query', reason: 'x' })).error, /built-in entry/)
  assert.match((await retire({ ref: 'code/nope', reason: 'x' })).error, /no capsule named code\/nope/)
  assert.match((await retire({ ref: 'code/test.has-item', reason: 'x', supersededBy: 'code/test.has-item' })).error, /cannot be the entry itself/)
  assert.match((await call('capsule_retire', { requestId: 'p1', ref: 'code/test.has-item', reason: 'x' })).error, /p1 是 plan 请求，请用 bt_submit_tree 回答/)

  const done = await retire({ ref: refs['test.has-item'], reason: '被 air-below 取代（演示）', supersededBy: 'code/test.air-below' })
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.deepEqual([done.op, done.key, done.after.supersededBy, done.after.by], ['retire', 'code/test.has-item', 'code/test.air-below', 'k1'])
  assert.match(text('capsule_retire', {}, done), /已下架：code\/test\.has-item（取代者 code\/test\.air-below）/)

  assert.ok(!(await call('capsule_search', {})).items.some((r) => r.ref === 'code/test.has-item'))
  const withRetired = await call('capsule_search', { query: 'has-item', includeRetired: true })
  assert.deepEqual(withRetired.items[0], { ref: 'code/test.has-item', kind: 'condition', retired: 'code/test.air-below' }, '只给名字、种类与取代者')
  assert.equal((await call('capsule_get', { ref: 'code/test.has-item' })).retired.supersededBy, 'code/test.air-below')

  // 带哈希的引用照常装载；新树引用下架的名字 → 警告，不拦
  bridge.curateDone({ sessionId: 's1', requestId: 'k1', reason: '演示' })
  const tree = { seq: '演示', do: [{ sel: '有或无', do: [{ cond: 'code/test.has-item', read: ['inventory'], params: { item: 'diamond', count: 999 } }, { steps: '切栏', do: [['key/hotbar', { slot: 1 }]] }] }] }
  const submitted = await runTask(ctx, tree)
  assert.equal(ctx.executor.task.state, 'done')
  assert.match(submitted.warnings.join('\n'), /code\/test\.has-item is retired \(被 air-below 取代（演示）\); superseded by code\/test\.air-below\. The tree still runs/)

  bridge.startCurate({ sessionId: 's1', mode: 'all' })
  ctx.claim(4)
  await assert.rejects(() => call('capsule_retire', { requestId: 'k2', ref: 'code/test.has-item', undo: true }), /missing required property "reason"/)
  assert.match(bridge.retireCapsule({ sessionId: 's1', requestId: 'k2', ref: 'code/test.has-item', undo: true }).error, /reason is required/)
  const undone = await call('capsule_retire', { requestId: 'k2', ref: 'code/test.has-item', undo: true, reason: '误判' })
  assert.equal(undone.op, 'undo')
  assert.equal(library.readManifest()['code/test.has-item'].retired, undefined)
  assert.match((await call('capsule_retire', { requestId: 'k2', ref: 'code/test.has-item', undo: true, reason: 'x' })).error, /is not retired/)

  await call('capsule_retire', { requestId: 'k2', ref: 'code/test.air-below', reason: '演示' })
  const resaved = saveCapsule({ library, sandbox: ctx.sandbox, registry: ctx.registry }, 'code', {
    name: 'test.air-below', description: '氧气低于 value（新版）', signature: { inputs: { value: { type: 'int', required: true } }, returns: 'bool' },
    body: 'function main(p, state) { return state.player.vitals.air < p.value - 0 }'
  })
  assert.equal(resaved.ok, true)
  assert.equal(library.readManifest()['code/test.air-below'].retired, undefined, '同名新版本清掉下架标记')

  const locked = saveCapsule({ library, sandbox: ctx.sandbox, registry: ctx.registry }, 'code', {
    name: 'test.locked', locked: true, description: 'x', signature: { inputs: {}, returns: 'bool' }, body: 'function main() { return true }'
  })
  assert.equal(locked.ok, true)
  assert.match((await call('capsule_retire', { requestId: 'k2', ref: 'code/test.locked', reason: 'x' })).error, /is locked and cannot be retired/)
})

test('capsule_describe：不换哈希、文件与 manifest 一起改；内置不能改；bt_curate_done 写 curate.jsonl', async () => {
  const ctx = setup()
  const { bridge, call, text, library, refs } = ctx
  await runTask(ctx)
  bridge.startCurate({ sessionId: 's1' })
  ctx.claim(2)
  const before = library.readManifest()['code/test.air-below'].hash
  assert.match((await call('capsule_describe', { requestId: 'k1', ref: 'code/test.air-below', description: ' ' })).error, /description is required/)
  assert.match((await call('capsule_describe', { requestId: 'k1', ref: 'code/core.nbt.query', description: 'x' })).error, /built-in/)
  const changed = await call('capsule_describe', { requestId: 'k1', ref: 'code/test.air-below', description: '条件：玩家氧气低于 params.value（溺水前的守卫）' })
  assert.match(text('capsule_describe', {}, changed), /原来：氧气低于 value\n现在：条件：玩家氧气低于/)
  assert.equal(library.readManifest()['code/test.air-below'].hash, before, '不产生新版本')
  assert.equal(library.get(refs['test.air-below']).description, '条件：玩家氧气低于 params.value（溺水前的守卫）', '条目文件也改了，哈希仍对得上')
  assert.equal((await call('capsule_search', { query: '溺水' })).items[0].ref, 'code/test.air-below', '说明里命中也能搜到')

  assert.match((await call('bt_curate_done', { requestId: 'k1', reason: '' })).error, /reason is required/)
  const finished = await call('bt_curate_done', { requestId: 'k1', reason: '补了一条说明' })
  assert.match(text('bt_curate_done', {}, finished), /整理 k1 已结束；改动 1 处/)
  const [row] = fs.readFileSync(path.join(library.dir, 'curate.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual([row.requestId, row.trigger, row.outcome, row.sinceLast, row.reason], ['k1', 'manual', 'done', 1, '补了一条说明'])
  assert.deepEqual(row.described.map((c) => [c.key, c.before]), [['code/test.air-below', '氧气低于 value']])
  assert.match((await call('capsule_describe', { requestId: 'k1', ref: 'code/test.air-below', description: 'x' })).error, /已经回答过|已关闭/)
})

test('自动整理（C1 / C2）：everyTasks = 0 从不自动发；= 2 时第二个任务结束、空闲才发（经 deliverIdle）；复盘没结束就等复盘', async () => {
  const off = setup()
  await runTask(off)
  await runTask(off)
  assert.equal(off.idle.length, 0)
  assert.equal(off.stats.curateState().sinceLast, 2)

  const on = setup({ curate: { everyTasks: 2 } })
  await runTask(on)
  assert.equal(on.idle.length, 0)
  await runTask(on)
  assert.equal(on.idle.length, 1)
  assert.match(on.idle[0].text, /（自动发起：自上次整理以来已经结束了 2 个任务，达到 curate\.everyTasks = 2。人可以随时取消这一回合。）/)
  assert.match(on.idle[0].summary, /整理胶囊库：已累计 2 个任务/)
  assert.equal(on.stats.curateState().sinceLast, 0)

  const withReflect = setup({ reflect: { enabled: true }, curate: { everyTasks: 1 } })
  await runTask(withReflect)
  assert.equal(withReflect.idle.length, 0, '复盘在飞：先不整理')
  assert.equal(withReflect.delivered.at(-1).source.reason, 'reflect')
  withReflect.claim(2)
  withReflect.bridge.reflectDone({ sessionId: 's1', requestId: 'c1', summary: '没有值得存的' })
  assert.equal(withReflect.idle.length, 1, '复盘结束后发')
  assert.equal(withReflect.idle[0].source.reason, 'curate')
})

test('整理回合：没结束就提醒一次、再结束按放弃关闭；回合出错（含人取消）直接关闭、不重发；会话关闭也关', async () => {
  const ctx = setup()
  await runTask(ctx)
  const { bridge } = ctx
  bridge.startCurate({ sessionId: 's1' })
  ctx.claim(2)
  const first = bridge.onTurnStopping({ sessionId: 's1', turn: 2 })
  assert.match(first.steer.text, /整理请求 k1 还没有结束。本次整理已经做了 0 处改动/)
  assert.equal(bridge.onTurnStopping({ sessionId: 's1', turn: 2 }), null)
  assert.equal(bridge.curating().length, 0)

  bridge.startCurate({ sessionId: 's1' })
  ctx.claim(3)
  assert.equal(bridge.onTurnError({ sessionId: 's1', turn: 3, error: new Error('aborted') }), null)
  assert.equal(bridge.curating().length, 0)

  bridge.startCurate({ sessionId: 's1' })
  bridge.onSessionClosed('s1')
  const outcomes = fs.readFileSync(path.join(ctx.library.dir, 'curate.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(outcomes.map((r) => [r.requestId, r.outcome]), [['k1', 'abandoned'], ['k2', 'abandoned'], ['k3', 'abandoned']])
  assert.match(outcomes[1].reason, /the turn errored: aborted/)
})

test('清单超过 listLimit（C5）：只给目录——各前缀下几条、已下架几条、尚无记录几条', () => {
  const ctx = setup()
  const rows = libraryRows(ctx.library, ctx.stats)
  const full = renderLibrary(rows, { listLimit: 150 })
  assert.match(full, /^胶囊库在用 4 条（内置 2）；已下架 0 条不列，要看用 capsule_search 加 includeRetired\n\n- code\//)
  const dir = renderLibrary(rows, { listLimit: 3 })
  assert.match(dir, /在用的超过 3 条，只给目录；条目用 capsule_search/)
  assert.match(dir, /- code\/core\.\*：2 条，尚无记录 2/)
  assert.match(dir, /- code\/test\.\*：2 条，尚无记录 2/)
  // 已下架的不列、不算进 listLimit（整理范围方案 R4）
  const withRetired = rows.map((r) => (r.key === 'code/test.air-below' ? { ...r, retired: { reason: 'x' } } : r))
  const listed = renderLibrary(withRetired, { listLimit: 3 })
  assert.match(listed, /^胶囊库在用 3 条（内置 2）；已下架 1 条不列/)
  assert.doesNotMatch(listed, /test\.air-below|只给目录/)
})

test('GC（S2）：三处树的引用、子树传递闭包、当前版本、locked、近期用过的都保留；默认只演练；归档移文件并记索引；装载归档的引用报明原因', () => {
  const ctx = setup()
  const { library, sandbox, registry, stats } = ctx
  const save = (folder, entry) => {
    const result = saveCapsule({ library, sandbox, registry }, folder, entry)
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.ref
  }
  const cond = (name, body, extra = {}) => save('code', { name, description: name, signature: { inputs: {}, returns: 'bool' }, body, ...extra })
  const oldA = cond('gc.a', 'function main() { return true }')
  const curA = cond('gc.a', 'function main() { return !false }')
  const oldB = cond('gc.b', 'function main() { return 1 > 0 }')
  cond('gc.b', 'function main() { return 2 > 0 }')
  const oldC = cond('gc.c', 'function main() { return 3 > 0 }')
  cond('gc.c', 'function main() { return 4 > 0 }')
  const oldD = cond('gc.d', 'function main() { return 5 > 0 }')
  cond('gc.d', 'function main() { return 6 > 0 }')
  const oldE = cond('gc.e', 'function main() { return 7 > 0 }')
  cond('gc.e', 'function main() { return 8 > 0 }')
  const lockedOld = cond('gc.l', 'function main() { return 9 > 0 }', { locked: true })
  cond('gc.l', 'function main() { return 10 > 0 }')
  // 旧子树引用 oldB；当前子树引用 oldA（旧子树本身不被引用 → 会被收，但它的引用在扫描"库里 trees/ 的全部条目"时已计入）
  const oldTree = save('trees', { name: 'gc.t', description: 't', signature: {}, body: { cond: oldB } })
  save('trees', { name: 'gc.t', description: 't', signature: {}, body: { seq: 't', do: [{ cond: oldA }] } })

  const runtimeDir = path.join(tempDir(), 'runtime')
  fs.mkdirSync(path.join(runtimeDir, 'tasks', 'task-1', 'trees'), { recursive: true })
  fs.writeFileSync(path.join(runtimeDir, 'tasks', 'task-1', 'trees', 'v1.json'), JSON.stringify({ type: 'Condition', id: 'n1', ref: oldC }))
  const fastTreeDir = tempDir()
  fs.writeFileSync(path.join(fastTreeDir, 'v3.json'), JSON.stringify({ arms: [{ when: { ref: oldD } }] }))
  fs.writeFileSync(path.join(fastTreeDir, 'v3.meta.json'), JSON.stringify({ ref: oldE }))
  const now = Date.parse('2026-10-29T12:00:00Z')
  stats.data.refs[oldE] = { calls: 1, lastUsed: '2026-10-20T00:00:00Z' }

  const plan = planGc({ dir: library.dir, runtimeDir, fastTreeDir, stats, keepDays: 30, now })
  const kept = (ref) => plan.keep.get(ref)
  assert.equal(kept(curA), 'current')
  assert.equal(kept(oldA), 'referenced by library tree trees/gc.t@' + library.readManifest()['trees/gc.t'].hash)
  assert.match(kept(oldB), /referenced by library tree trees\/gc\.t@/)
  assert.match(kept(oldC), /tasks[\\/]task-1[\\/]trees[\\/]v1\.json/)
  assert.equal(kept(oldD), 'referenced by fast tree v3.json')
  assert.equal(kept(oldE), 'used within 30 days', 'meta 文件不是树；近期用过的保留')
  assert.equal(kept(lockedOld), 'locked')
  assert.deepEqual(plan.collect.map((c) => c.ref), [oldTree])
  assert.ok(fs.existsSync(plan.collect[0].file), '演练不动文件')

  const tooOld = planGc({ dir: library.dir, runtimeDir, fastTreeDir, stats, keepDays: 1, now })
  assert.ok(tooOld.collect.some((c) => c.ref === oldE))

  const { archived } = applyGc({ dir: library.dir, plan, stats, now })
  assert.equal(archived.length, 1)
  assert.ok(!fs.existsSync(plan.collect[0].file))
  const [index] = fs.readFileSync(path.join(library.dir, 'archive', 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(index.ref, oldTree)
  assert.match(index.to, /^archive[\\/]2026-10-29[\\/]trees[\\/]gc\.t@/)
  library.cache.clear()
  assert.throws(() => library.get(oldTree), /was archived by GC \(no saved tree referenced it\): archive[\\/]2026-10-29/)
})

// ── 整理范围（docs/胶囊库整理范围设计方案.md）──────────────────────────────

test('整理范围（R2、R3）：核心 = 之后用过 / 新存；相关 = 引用关系一层；同领域只列名字；内置、已下架、草稿不算', () => {
  const since = '2026-11-21T10:00:00.000Z'
  const row = (key, extra = {}) => ({ key, ref: `${key}@aaaa1111`, kind: key.startsWith('trees/') ? 'tree' : 'compute', description: `${key} 的说明`, olderVersions: 0, stat: null, issues: 0, ...extra })
  const used = { calls: 3, ok: 3, fail: 0, error: 0, tasks: 1, tasksDone: 1, tasksFailed: 0, lastUsed: '2026-11-21T11:00:00.000Z' }
  const rows = [
    row('trees/smithing.make-one', { stat: used }),
    row('code/smithing.plan', { savedAt: '2026-11-21T10:30:00.000Z' }),
    row('code/smithing.old', { stat: { ...used, lastUsed: '2026-11-20T00:00:00.000Z' }, savedAt: '2026-11-01T00:00:00.000Z' }),
    row('code/inv.count', {}),
    row('trees/craft.outer', {}),
    row('code/craft.other', {}),
    row('code/core.json.query', { builtin: true, stat: used }),
    row('code/smithing.gone', { retired: { reason: 'x' }, stat: used }),
    row('task/scratch', { draft: true, stat: used })
  ]
  const refs = { 'trees/smithing.make-one': ['code/inv.count', 'code/core.json.query'], 'trees/craft.outer': ['code/smithing.plan'] }
  const scope = curateScope(rows, { since, refsOf: (key) => (refs[key] ? new Set(refs[key]) : null) })
  assert.deepEqual(scope.core.map((r) => [r.key, r.why]), [['trees/smithing.make-one', ['用过']], ['code/smithing.plan', ['新存']]])
  assert.deepEqual(scope.related.map((r) => [r.key, r.usedBy, r.uses]), [['code/inv.count', ['trees/smithing.make-one'], []], ['trees/craft.outer', [], ['code/smithing.plan']]])
  assert.deepEqual([...scope.domains], [['smithing', ['code/smithing.old']]], '同领域：smithing 的其余条目；craft 不是核心条目的领域')
  assert.deepEqual(scopeCounts(scope), { core: 2, related: 2, domain: 1, outside: 1, retired: 1 })
  const text = renderScope(scope)
  assert.match(text, /^核心条目 2 条：上次整理之后在任务里用过的、之后新存的（含新版本）。\n相关条目 2 条/)
  assert.match(text, /库里还有 1 条在用的条目不在范围里；已下架的 1 条不列。/)
  assert.match(text, /## 核心条目\n- trees\/smithing\.make-one@aaaa1111（子树）用过 3 次.*｜之后：用过｜trees\/smithing\.make-one 的说明/)
  assert.match(text, /- code\/inv\.count@aaaa1111（Compute）.*｜被 trees\/smithing\.make-one 引用｜/)
  assert.match(text, /- trees\/craft\.outer@aaaa1111（子树）.*｜引用了 code\/smithing\.plan｜/)
  assert.match(text, /## 同领域的其余条目（只列名字，要看用 capsule_get）\n- smithing：code\/smithing\.old$/)
  assert.doesNotMatch(text, /core\.json\.query|smithing\.gone|task\/scratch|craft\.other/)
  assert.equal(domainOf('trees/smithing.make-one'), 'smithing')
  assert.equal(curateScope(rows, { since: '2026-11-22T00:00:00.000Z', refsOf: () => null }).core.length, 0, '之后什么都没发生：范围是空的')
})

test('savedAt（R2）：存新版本时记下；同一哈希再存一次、改说明、下架都不改它', () => {
  let clock = Date.parse('2026-11-21T10:00:00.000Z')
  const dir = tempDir('stevex-savedat-')
  const library = new CapsuleLibrary({ dir, now: () => clock })
  const entry = { name: 'inv.x', description: 'x', signature: { inputs: {}, returns: 'bool' }, body: 'function main() { return true }' }
  library.write('code', entry)
  assert.equal(library.readManifest()['code/inv.x'].savedAt, '2026-11-21T10:00:00.000Z')
  clock += 60000
  library.write('code', entry)
  library.describe('code/inv.x', '新说明')
  library.retire('code/inv.x', { reason: 'r', at: new Date(clock).toISOString() })
  assert.equal(library.readManifest()['code/inv.x'].savedAt, '2026-11-21T10:00:00.000Z')
  assert.equal(library.list().find((r) => r.ref.startsWith('code/inv.x@')).savedAt, '2026-11-21T10:00:00.000Z')
  library.write('code', { ...entry, body: 'function main() { return false }' })
  assert.equal(library.readManifest()['code/inv.x'].savedAt, '2026-11-21T10:01:00.000Z', '新版本')
})

test('lastDoneCurate（R1）：取最后一次完成的整理；放弃的不算；没有记录 → null', () => {
  const dir = tempDir('stevex-curatelog-')
  assert.equal(lastDoneCurate(dir), null)
  fs.writeFileSync(path.join(dir, 'curate.jsonl'), [
    JSON.stringify({ requestId: 'k1', at: '2026-11-21T10:00:00.000Z', outcome: 'done' }),
    JSON.stringify({ requestId: 'k2', at: '2026-11-21T11:00:00.000Z', outcome: 'done', mode: 'scoped' }),
    JSON.stringify({ requestId: 'k3', at: '2026-11-21T12:00:00.000Z', outcome: 'abandoned', mode: 'scoped' }),
    'not json'
  ].join('\n') + '\n')
  assert.deepEqual(lastDoneCurate(dir), { at: '2026-11-21T11:00:00.000Z', requestId: 'k2', mode: 'scoped' })
  assert.equal(lastCurateSeq(dir), 3, '放弃的整理也占号')
  assert.equal(lastCurateSeq(tempDir('stevex-curatelog-empty-')), 0)
})

test('/bt curate 按范围（R1、R5、R6、R8）：上次完成整理之后用过的条目进范围；范围是空的不发、计数清零；all 整理全库；curate.jsonl 记模式与范围', async () => {
  const ctx = setup()
  const { bridge, delivered, library } = ctx
  const first = bridge.startCurate({ sessionId: 's1' })
  assert.equal(first.mode, 'all', '从没完成过整理')
  ctx.claim(1)
  bridge.curateDone({ sessionId: 's1', requestId: first.requestId, reason: '第一次' })
  await new Promise((resolve) => setTimeout(resolve, 5))

  const tree = { seq: '演示', do: [{ sel: '有或无', do: [{ cond: 'code/test.has-item', read: ['inventory'], params: { item: 'diamond', count: 999 } }, { steps: '切栏', do: [['key/hotbar', { slot: 1 }]] }] }] }
  const plan = bridge.startPlanning({ sessionId: 's1', instruction: '演示' })
  ctx.claim(2)
  assert.equal(bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree }).ok, true)
  await runUntil(ctx.executor, () => ctx.executor.task.state === 'done' || ctx.executor.task.state === 'failed')

  const scoped = bridge.startCurate({ sessionId: 's1' })
  assert.deepEqual([scoped.ok, scoped.mode], [true, 'scoped'], JSON.stringify(scoped))
  const message = delivered.at(-1).text
  assert.match(message, /（人用 \/bt curate 发起）\n\n上次整理完成于 \S+（k1，全库），之后结束了 1 个任务/)
  assert.match(message, /## 本次整理范围\n\n```text\n核心条目 1 条/)
  assert.match(message, /- code\/test\.has-item@\w+（条件）.*｜之后：用过｜/)
  assert.match(message, /请按下面的「胶囊库整理」先看一遍本次整理范围，/)
  assert.doesNotMatch(message, /test\.air-below@/, '没用过的同领域条目只列名字')
  assert.match(message, /- test：code\/test\.air-below/)
  assert.match(bridge.curating().map((r) => r.mode).join(), /scoped/)
  ctx.claim(3)
  bridge.curateDone({ sessionId: 's1', requestId: scoped.requestId, reason: '看过了' })
  const log = fs.readFileSync(path.join(library.dir, 'curate.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual([log[0].mode, log[0].since, log[0].scope], ['all', null, null])
  assert.deepEqual([log[1].mode, log[1].since, log[1].scope], ['scoped', log[0].at, { core: 1, related: 0, domain: 1, outside: 0, retired: 0 }])

  await new Promise((resolve) => setTimeout(resolve, 5))
  const count = delivered.length
  const empty = bridge.startCurate({ sessionId: 's1' })
  assert.deepEqual([empty.ok, empty.skipped], [true, true])
  assert.match(empty.text, /之后没有任务用过、也没有新存的胶囊，不需要整理。要整理全库用 \/bt curate all/)
  assert.equal(delivered.length, count, '没发请求')
  assert.equal(ctx.stats.curateState().sinceLast, 0)

  bridge.curateSeq = 0 // 模拟 DSH 重启：请求号接着 curate.jsonl 编，不从 k1 重来
  const all = bridge.startCurate({ sessionId: 's1', mode: 'all' })
  assert.deepEqual([all.mode, all.requestId], ['all', 'k3'])
  assert.match(delivered.at(-1).text, /（人用 \/bt curate all 发起：整理全库）[\s\S]*## 胶囊库\n\n```text\n胶囊库在用 4 条/)
})
