import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { Bridge } from '../src/llm/bridge.js'
import { loadPrompts } from '../src/llm/prompts.js'
import { createTools } from '../src/tools/index.js'
import { CapsuleStats } from '../src/capsules/stats.js'
import { CapsuleVersions } from '../src/capsules/versions.js'
import { libraryRows, renderLibrary } from '../src/capsules/curate.js'
import { planGc } from '../src/capsules/gc.js'
import { saveCapsule } from '../src/capsules/save.js'
import { TaskHistory } from '../src/history/store.js'
import { METHODS, READ_METHODS } from '../src/game/index.js'
import { NBT_SOURCES } from '../src/capsules/index.js'
import { makeRuntime, runUntil } from './helpers.js'

const prompts = loadPrompts(fileURLToPath(new URL('../prompts', import.meta.url)))

function setup() {
  const rt = makeRuntime()
  const stats = new CapsuleStats({ dir: rt.library.dir })
  const history = new TaskHistory({ dir: null })
  rt.executor.on('event', (record) => { stats.observe(record); history.observe(record) })
  const delivered = []
  const bridge = new Bridge({
    executor: rt.executor, library: rt.library, sandbox: rt.sandbox, registry: rt.registry, prompts, stats, history,
    taskUsage: () => ({ turns: 1, tokens: null }),
    deliver: (sessionId, message) => { delivered.push({ sessionId, ...message }); return true },
    notify: () => {}
  })
  const claim = (turn) => {
    const message = delivered.at(-1)
    return bridge.onPreStep({ sessionId: message.sessionId, turn, step: 1, messages: [{ source: message.source }] })
  }
  const defs = createTools({
    game: rt.game, registry: rt.registry, library: rt.library, stats, bridge, history,
    methods: METHODS, readMethods: READ_METHODS, nbt: null, nbtSources: NBT_SOURCES,
    json: rt.json, jsonSources: ['recipes'], taskId: () => bridge.currentTaskId(), maxOutputChars: 20000
  })
  const tools = Object.fromEntries(defs.map((def) => [def.name, defineTool(def)]))
  const call = (name, args) => tools[name].execute(args, { agent: { id: 's1' } })
  const save = (body) => {
    const result = saveCapsule({ library: rt.library, sandbox: rt.sandbox, registry: rt.registry }, 'code', { name: 'v.cond', description: '演示条件', signature: { inputs: {}, returns: 'bool' }, body })
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.ref
  }
  return { ...rt, stats, history, bridge, delivered, claim, call, save }
}

const NOTE = {
  change: '换了写法',
  claims: [
    { better: 'new', when: '材料碎成很多堆时', basis: 'inferred' },
    { better: 'old', when: '材料只有一整堆时', basis: 'measured', evidence: 'task-x：旧版 9 次调用' }
  ]
}

test('CapsuleVersions：versionNote 校验；记录、版本链、涉及某版本的判断、受保护的旧版、核对', () => {
  assert.match(CapsuleVersions.check(undefined).errors[0], /versionNote is required/)
  const bad = CapsuleVersions.check({ change: ' ', claims: [{ better: 'both', when: '', basis: 'guess' }, {}, {}, {}] }).errors.join('\n')
  for (const pattern of [/change 必填/, /最多 3 条/, /better 要是 new \/ old/, /when 必填/, /basis 要是 measured \/ inferred/]) assert.match(bad, pattern)
  assert.match(CapsuleVersions.check({ change: 'x' }).errors[0], /要写 claims.*或写 none/)
  assert.deepEqual(CapsuleVersions.check({ change: ' 修错 ', none: ' 旧版没有更好的情况 ' }).note, { change: '修错', none: '旧版没有更好的情况', claims: [] })

  const v = new CapsuleVersions({ now: () => Date.parse('2026-11-07T00:00:00Z') })
  v.record('code/a', 'h2', { parent: 'h1', by: 'task-1', note: CapsuleVersions.check(NOTE).note })
  v.record('code/a', 'h3', { parent: 'h2', by: 'task-2', note: CapsuleVersions.check({ change: '修错', none: '纯修错' }).note })
  assert.deepEqual(v.chain('code/a', 'h3').map((c) => [c.hash, c.record?.parent ?? null]), [['h3', 'h2'], ['h2', 'h1'], ['h1', null]])
  assert.deepEqual(v.claimsInvolving('code/a', 'h1').map((c) => [c.newHash, c.index, c.side]), [['h2', 0, 'old'], ['h2', 1, 'old']])
  assert.deepEqual(v.claimsInvolving('code/a', 'h2').map((c) => c.side), ['new', 'new'], 'h3 的记录没有判断')
  assert.deepEqual([...v.protectedVersions()], [['code/a@h1', 'version claim: better when 材料只有一整堆时 (open)']])
  assert.equal(v.review('code/a', 'h2', 1, { status: 'refuted', evidence: '一整堆时新版也是 9 次', by: 'task-3' }), true)
  assert.equal(v.review('code/a', 'h2', 9, { status: 'refuted', evidence: 'x', by: 'task-3' }), false)
  assert.equal(v.protectedVersions().size, 0, '被否定后不再保护')
  assert.deepEqual(v.claimCounts('code/a'), { open: 1, confirmed: 0, refuted: 1 })
  assert.equal(v.get('code/a', 'h2').claims[1].reviews[0].by, 'task-3')
})

test('版本说明全流程：capsule_search / capsule_get 显示版本与判断；用到的任务复盘时核对；整理清单的计数；GC 保护旧版', async () => {
  const ctx = setup()
  const { bridge, library, stats, call, claim, delivered, save } = ctx
  const v1 = save('function main() { return true }')
  const v2 = save('function main() { return !false }')
  const h1 = v1.split('@')[1]
  const h2 = v2.split('@')[1]
  library.versions.record('code/v.cond', h2, { parent: h1, by: 'task-0', note: CapsuleVersions.check(NOTE).note })

  // V5：规划时的清单
  const [row] = await call('capsule_search', { query: 'v.cond' })
  assert.equal(row.ref, v2)
  assert.equal(row.versions, 2)
  assert.equal(row.untested, true)
  assert.deepEqual(row.olderBetterWhen, [`@${h1}：材料只有一整堆时（实测，open）`])
  // V6：版本链
  const got = await call('capsule_get', { ref: 'code/v.cond' })
  assert.deepEqual(got.versionChain.map((r) => [r.ref, r.parent, r.usage]), [[v2, h1, '未执行'], [v1, null, '未执行']])
  assert.equal(got.versionChain[0].change, '换了写法')
  assert.deepEqual(got.versionChain[0].claims.map((c) => [c.better, c.status]), [[`这一版（@${h2}）`, 'open'], [`旧版（@${h1}）`, 'open']])
  assert.equal(got.versionChain[1].change, '（没有记录）')
  // V11：GC 保护"旧版更好"一侧
  assert.match(planGc({ dir: library.dir, stats }).keep.get(v1), /version claim: better when 材料只有一整堆时 \(open\)/)

  // 一个用到新版的任务
  const plan = bridge.startPlanning({ sessionId: 's1', instruction: '演示' })
  claim(1)
  assert.equal(bridge.submitTree({ sessionId: 's1', requestId: plan.requestId, tree: { seq: '演示', do: [{ cond: 'code/v.cond' }] } }).ok, true)
  await runUntil(ctx.executor, () => ctx.executor.task.state === 'done')
  const review = delivered.at(-1)
  assert.match(review.text, /## 涉及这次所用版本的待核对判断[\s\S]*code\/v\.cond@\w+（替换了 @\w+）\[0\] 新版 @\w+ 更好：材料碎成很多堆时（推测）；这次用到的是新版/)
  assert.match(review.text, /\[1\] 旧版 @\w+ 更好：材料只有一整堆时（实测：task-x：旧版 9 次调用）/)
  claim(2)
  const wrong = bridge.assess({ sessionId: 's1', requestId: 'c1', none: '就一个条件', claims: [{ ref: 'code/v.cond', claim: 0, status: 'confirmed', evidence: 'x' }] })
  assert.match(wrong.errors.join('\n'), new RegExp(`claims\\[0\\]：对不上待核对的判断.*这次能核对的是：\\{ ref: "code/v\\.cond@${h2}", claim: 0 \\}、\\{ ref: "code/v\\.cond@${h2}", claim: 1 \\}`))
  assert.match(bridge.assess({ sessionId: 's1', requestId: 'c1', none: 'x', claims: [{ ref: v2, claim: 0, status: 'yes', evidence: '' }] }).errors.join('\n'), /status 要是 confirmed \/ refuted \/ open[\s\S]*evidence 必填/)
  const ok = bridge.assess({ sessionId: 's1', requestId: 'c1', none: '就一个条件', claims: [{ ref: v2, claim: '[1]', status: 'refuted', evidence: '这次一整堆，新版也只调用一次' }] })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(ok.claims, 1)
  assert.equal(bridge.reflectDone({ sessionId: 's1', requestId: 'c1', summary: '核对了一条版本判断' }).ok, true)
  const after = library.versions.get('code/v.cond', h2).claims
  assert.deepEqual(after.map((c) => c.status), ['open', 'refuted'])
  assert.equal(after[1].reviews[0].evidence, '这次一整堆，新版也只调用一次')

  // 新版跑过了：不再 untested；被否定的旧版判断不再列出、GC 不再保护
  const [row2] = await call('capsule_search', { query: 'v.cond' })
  assert.equal(row2.untested, undefined)
  assert.equal(row2.olderBetterWhen, undefined)
  assert.equal(planGc({ dir: library.dir, stats }).keep.get(v1), undefined)
  // V10：整理清单
  const listed = renderLibrary(libraryRows(library, stats), { listLimit: 150 })
  assert.match(listed, /code\/v\.cond@\w+（条件）[^\n]*同名旧版本 1｜版本判断 open 1 \/ 成立 0 \/ 不成立 1（capsule_get 看版本链）/)
  assert.ok(stats.ran(v2) && !stats.ran(v1))
})
