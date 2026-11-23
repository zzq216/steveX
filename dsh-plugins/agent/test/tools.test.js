import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { createTools } from '../src/tools/index.js'
import { Bridge } from '../src/llm/bridge.js'
import { loadPrompts } from '../src/llm/prompts.js'
import { METHODS, READ_METHODS } from '../src/game/index.js'
import { NBT_SOURCES, saveCapsule } from '../src/capsules/index.js'
import { makeRuntime, runUntil } from './helpers.js'
import { FakeMod, allRecipes } from './fake_mod.js'

const prompts = loadPrompts(fileURLToPath(new URL('../prompts', import.meta.url)))

function setup({ mod } = {}) {
  const rt = makeRuntime(mod ? { mod } : {})
  const delivered = []
  const bridge = new Bridge({
    executor: rt.executor, library: rt.library, sandbox: rt.sandbox, prompts,
    deliver: (sessionId, message) => { delivered.push(message); return true }
  })
  const defs = createTools({
    game: rt.game, registry: rt.registry, library: rt.library, bridge,
    methods: METHODS, readMethods: READ_METHODS,
    nbt: null, nbtSources: NBT_SOURCES,
    json: rt.json, jsonSources: ['recipes'],
    taskId: () => bridge.currentTaskId(),
    maxOutputChars: 4000
  })
  // 用 DSH 自己的 defineTool 包一遍：参数 schema 不合法会在这里抛错
  const tools = Object.fromEntries(defs.map((def) => [def.name, defineTool(def)]))
  const exec = { agent: { id: 's1' } }
  const call = (name, args) => tools[name].execute(args, exec)
  const text = (name, args, value) => tools[name].output.render(args, value).map((b) => b.text).join('')
  return { ...rt, bridge, tools, call, text, delivered }
}

test('工具清单：二十个工具，没有任何按键 / 点击工具（I2）', () => {
  const { tools } = setup()
  assert.deepEqual(Object.keys(tools).sort(), [
    'bt_abort_task', 'bt_curate_done', 'bt_inspect', 'bt_reflect_done', 'bt_submit_expansion', 'bt_submit_patch', 'bt_submit_tree', 'bt_view', 'bt_write_code',
    'capsule_describe', 'capsule_get', 'capsule_repin', 'capsule_retire', 'capsule_save', 'capsule_search', 'command_docs', 'data_shapes', 'json_query', 'mod_query', 'nbt_query'
  ])
})

test('mod_query：只放行只读方法；透传参数与结果', async () => {
  const { call, tools, mod } = setup()
  assert.deepEqual(tools.mod_query.parameters.properties.method.enum.sort(), [...READ_METHODS].sort())
  const inv = await call('mod_query', { method: 'inventory' })
  assert.ok(Array.isArray(inv.slots))
  await assert.rejects(() => call('mod_query', { method: 'key/up', params: { pressed: true } }), /invalid arguments/)
  assert.equal(mod.calls.some(([method]) => method === 'key/up'), false, '有作用的方法根本不会发到 mod')
})

test('json_query / nbt_query：同一套查询参数；不在白名单的数据源被拒', async () => {
  const { call, text } = setup()
  const args = { path: 'recipes', records: 'recipes', filters: { result: 'minecraft:wooden_pickaxe' }, fields: ['type', 'pattern', 'key'], limit: 2 }
  const res = await call('json_query', args)
  if (allRecipes().length) {
    assert.equal(res.result[0].type, 'shaped')
    assert.match(text('json_query', args, res), /"pattern"/)
  }
  await assert.rejects(() => call('json_query', { path: '../configs/environments/x.json', fields: ['a'] }), /unknown json source ".."; allowed: recipes/)
  await assert.rejects(() => call('nbt_query', { path: 'entities', fields: ['id'] }), /not configured/)
})

test('command_docs / capsule_search / capsule_get', async () => {
  const { call } = setup()
  const all = await call('command_docs', {})
  assert.ok(all.some((d) => d.name === 'container/slot'))
  assert.ok(all.some((d) => d.name === 'inventory' && d.read))
  const slot = await call('command_docs', { name: 'container/slot' })
  assert.ok(slot.params.slot)
  assert.deepEqual((await call('command_docs', { prefix: 'blackboard/' })).map((d) => d.name).sort(), ['blackboard/compare', 'blackboard/has'])
  await assert.rejects(() => call('command_docs', { name: 'fly' }), /unknown command/)

  const found = await call('capsule_search', { query: 'json' })
  assert.deepEqual(found.items[0], { ref: 'code/core.json.query', kind: 'query' })
  assert.equal(found.total, found.items.length)
  assert.ok(Object.keys((await call('capsule_get', { ref: found.items[0].ref })).signature.inputs).includes('fields'))
  const page = await call('capsule_search', { limit: 1, offset: 1 })
  assert.equal(page.items.length, 1)
  assert.equal(page.offset, 1)
  assert.equal(page.next, page.total > 2 ? 2 : undefined)
  const got = await call('capsule_get', { ref: 'code/test.has-item' })
  assert.match(got.ref, /^code\/test\.has-item@[0-9a-f]{8}$/)
  assert.equal(got.signature.returns, 'bool')
  assert.match(got.body, /function main/)
  assert.equal((await call('capsule_get', { ref: 'code/core.json.query' })).host, true)
})

test('capsule_get：正文按行号列在最后，放不下就写明从哪行接着读；start / lines 只读一段；withBody: false 不带正文（2026-11-13）', async () => {
  const { call, text, library, sandbox, registry } = setup()
  const body = Array.from({ length: 900 }, (_, i) => `  const v${i} = ${i} // ${'x'.repeat(40)}`).join('\n')
  saveCapsule({ library, sandbox, registry }, 'code', { name: 'test.long', description: '很长的代码', signature: { outputs: { v: { type: 'int' } } }, body: `function main() {\n${body}\n  return { v: 1 }\n}` })
  const got = await call('capsule_get', { ref: 'code/test.long' })
  const full = text('capsule_get', {}, got)
  assert.match(full, /"description": "很长的代码"/, '契约照旧是 JSON')
  assert.match(full, /正文（共 903 行）：\n1: function main\(\) \{\n2: {3}const v0 = 0/)
  const next = Number(full.match(/用 start: (\d+) 接着读/)[1])
  assert.ok(full.length <= 4000 + 400 && next > 2, '放不下时只列能放下的行，写明从哪行接着读')

  const page = text('capsule_get', { ref: 'code/test.long', start: next, lines: 5 }, got)
  assert.match(page, new RegExp(`^code/test\\.long@\\w+ 正文（共 903 行）\\n${next}: `))
  assert.doesNotMatch(page, /"description"/, '只读一段时不重复契约')
  assert.match(page, new RegExp(`第 ${next}–${next + 4} 行；后面还有`))
  const tail = text('capsule_get', { ref: 'code/test.long', start: 902 }, got)
  assert.match(tail, /902: {3}return \{ v: 1 \}\n903: \}$/, '读到末尾不再提示接着读')
  assert.match(text('capsule_get', { ref: 'code/test.long', start: 2000 }, got), /从第 2000 行起没有内容：正文共 903 行/)

  const meta = text('capsule_get', { ref: 'code/test.long', withBody: false }, got)
  assert.match(meta, /正文共 903 行（没有列出；要看用 start \/ lines）$/)
  assert.doesNotMatch(meta, /const v0/)
  const host = await call('capsule_get', { ref: 'code/core.json.query' })
  assert.doesNotMatch(text('capsule_get', {}, host), /正文/, '内置查询没有正文')
})

test('提交类工具：结果带 taskId / requestId / 版本号；不合法不是工具错误', async () => {
  const { call, text, bridge, executor, delivered } = setup()
  assert.match(text('bt_view', {}, await call('bt_view', {})), /没有任务/)

  const plan = bridge.startPlanning({ sessionId: 's1', instruction: '演示' })
  const tree = { seq: '演示', do: [{ steps: '切栏', do: [['key/hotbar', { slot: 2 }]] }, { expand: '下一步' }] }
  const bad = await call('bt_submit_tree', { requestId: plan.requestId, tree: { act: 'fly' } })
  assert.equal(bad.ok, false)
  assert.match(text('bt_submit_tree', {}, bad), /不合法：\n- \[n1\] unknown command "fly"\n还剩 2 次/)

  const ok = await call('bt_submit_tree', { requestId: plan.requestId, tree })
  assert.equal(ok.ok, true)
  assert.match(text('bt_submit_tree', {}, ok), new RegExp(`已接受：任务 ${plan.taskId}，请求 ${plan.requestId}，树 v1`))

  await runUntil(executor, () => executor.task.state === 'suspended')
  const requestId = delivered.at(-1).source.requestId
  const view = text('bt_view', {}, await call('bt_view', {}))
  assert.match(view, new RegExp(`在飞请求：${requestId} expand @n1.2`))
  const exp = await call('bt_submit_expansion', { requestId, subtree: { steps: '再切栏', do: [['key/hotbar', { slot: 3 }]] } })
  assert.equal(exp.ok, true)
  assert.match(text('bt_submit_expansion', {}, exp), /树 v2。新节点：n1\.2\.1/)
  await runUntil(executor, () => executor.task.state === 'done')

  const none = await call('bt_abort_task', { reason: 'x' })
  assert.match(text('bt_abort_task', {}, none), /没有放弃/)
})

test('data_shapes：状态来源给结构 + 静态词表，不给值（I13）', async () => {
  const { call, text } = setup({ mod: new FakeMod({ inventory: { 0: ['oak_log', 5], 3: ['stick', 2] } }) })
  const res = await call('data_shapes', { sources: ['state.player', 'state.inventory', 'state.f3', 'state.container'] })
  assert.deepEqual(Object.keys(res), ['state.player', 'state.inventory', 'state.f3', 'state.container'])
  const out = text('data_shapes', {}, res)
  assert.match(out, /state\.inventory: \{/)
  assert.match(out, /slots: list\(\d+(\.\.\d+)?\) of \{/)
  assert.match(out, /id: string/)
  assert.doesNotMatch(out, /oak_log|stick/, '没有任何具体值（物品 id、数量都不出现）')
  assert.match(out, /词表 state\.container\.type ∈ "none" \| "inventory" \| .*"crafting"/, '枚举型字段给全部取值')
  assert.match(out, /工作台 crafting/)
})

test('data_shapes：白名单 JSON 给全量记录的结构与词表；默认不含 nbt；参数枚举只列已配置的数据源', async () => {
  const { tools, call, text } = setup()
  assert.deepEqual(tools.data_shapes.parameters.properties.sources.items.enum,
    ['state.player', 'state.inventory', 'state.f3', 'state.container', 'json.recipes'], '没配置记忆世界 → 没有 nbt.*')
  const res = await call('data_shapes', { sources: ['json.recipes'] })
  const out = text('data_shapes', {}, res)
  assert.match(out, /code\/core\.json\.query/, '告诉模型树里怎么查')
  assert.match(out, /recipes: list\(\d+\) of \{/)
  assert.match(out, /type: "shaped" \| "shapeless"/, '取值少的字段给词表')
  assert.match(out, /result: string（\d+\+? 种）/, '取值多的字段（物品 id）只给种数')
  assert.match(out, /key\?: map<"#" \| .*, list\(.*\) of string（\d+\+? 种）>/, '键是数据的对象显示成 map')
  assert.doesNotMatch(out, /wooden_pickaxe|oak_planks/, '具体物品 id 不出现')
  assert.match(out, /说明：key \/ ingredients 里的标签已经展开成具体物品 id.*可能带空格组成的空列或空行/, '数据源本身的性质写明，免得猜')
  const all = await call('data_shapes', {})
  assert.deepEqual(Object.keys(all), ['state.player', 'state.inventory', 'state.f3', 'state.container', 'json.recipes'])
})
