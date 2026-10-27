import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeMod, allRecipes } from './fake_mod.js'
import { makeRuntime, runUntil } from './helpers.js'

// ── ForEach ─────────────────────────────────────────────────────────────────

test('ForEach：逐项写进 as / indexAs；Steps 用 "$item" 作整个 params、用 "$item.slot" 取字段', async () => {
  const mod = new FakeMod()
  const { executor } = makeRuntime({ mod })
  executor.startTask({
    blackboard: { plan: [{ slot: 2 }, { slot: 5 }, { slot: 7 }] },
    tree: { forEach: '$plan', as: 'item', indexAs: 'i', do: { steps: '选格', do: [['key/hotbar', '$item'], ['key/hotbar', { slot: '$item.slot' }]] } }
  })
  await runUntil(executor, () => executor.task.state === 'done')
  assert.deepEqual(mod.calls.filter(([m]) => m === 'key/hotbar').map(([, p]) => p.slot), [2, 2, 5, 5, 7, 7])
  assert.equal(executor.task.blackboard.get('i'), 2)
})

test('ForEach：被打断后从同一项重来（下标不动），空列表直接 SUCCESS，非列表 FAILURE', async () => {
  const mod = new FakeMod()
  const { executor, game } = makeRuntime({ mod })
  executor.loadFastTree({ match: 'm', arms: [
    { when: { cond: 'code/test.air-below', read: ['player'], params: { value: 100 } }, then: { steps: '跳', do: [['key/jump', { pressed: true }], ['key/jump', { pressed: false }]] } }
  ] })
  const answer = () => {
    const pending = executor.task?.pending
    if (pending?.type === 'recover') executor.submitPatch(pending.requestId, [])
    return game.pollOnce()
  }
  executor.startTask({
    blackboard: { plan: [1, 2, 3] },
    tree: { forEach: '$plan', as: 'n', do: { steps: '走', do: [['key/hotbar', { slot: '$n' }], ['key/up', { pressed: true }], ['wait', 30], ['key/up', { pressed: false }]] } }
  })
  await runUntil(executor, () => mod.calls.filter(([m]) => m === 'key/hotbar').length === 2, { beforeTick: answer })
  mod.air = 10
  await runUntil(executor, () => executor.episode !== null, { beforeTick: answer })
  mod.air = 300
  await runUntil(executor, () => executor.task.state === 'done', { beforeTick: answer })
  assert.deepEqual(mod.calls.filter(([m]) => m === 'key/hotbar').map(([, p]) => p.slot), [1, 2, 2, 3], '第 2 项重跑，第 1 项没有')

  const empty = makeRuntime()
  empty.executor.startTask({ blackboard: { plan: [] }, tree: { forEach: '$plan', as: 'x', do: { act: 'key/hotbar', params: { slot: 0 } } } })
  await runUntil(empty.executor, () => empty.executor.task.state === 'done')

  const notList = makeRuntime()
  notList.executor.startTask({ blackboard: { plan: 3 }, tree: { forEach: '$plan', as: 'x', do: { act: 'key/hotbar', params: { slot: 0 } } } })
  await runUntil(notList.executor, () => notList.executor.task.state === 'suspended')
  assert.match(notList.executor.task.root.lastError, /is not a list/)
})

// ── Compute ─────────────────────────────────────────────────────────────────

const doubler = {
  folder: 'code',
  name: 'test.double',
  signature: { inputs: { xs: { type: 'list', item: 'number', required: true } }, outputs: { doubled: { type: 'list' }, total: { type: 'number' } } },
  body: 'function main(p) { const doubled = p.xs.map((x) => x * 2); return { doubled, total: doubled.reduce((a, b) => a + b, 0) } }'
}

test('Compute：缺省把每个输出写进同名键；writes 可以改名、取路径；输入输出都按 signature 校验', async () => {
  const { executor } = makeRuntime({ capsules: [doubler] })
  executor.startTask({ blackboard: { nums: [1, 2] }, tree: { seq: 's', do: [
    { compute: 'code/test.double', params: { xs: '$nums' } },
    { compute: 'code/test.double', params: { xs: '$doubled' }, writes: { quad: 'doubled', first: 'doubled.0' } }
  ] } })
  await runUntil(executor, () => executor.task.state === 'done')
  const bb = executor.task.blackboard
  assert.deepEqual([bb.get('doubled'), bb.get('total'), bb.get('quad'), bb.get('first')], [[2, 4], 6, [4, 8], 4])

  const wrong = makeRuntime({ capsules: [doubler] })
  wrong.executor.startTask({ blackboard: { nums: 'oops' }, tree: { compute: 'code/test.double', params: { xs: '$nums' } } })
  await runUntil(wrong.executor, () => wrong.executor.task.state === 'suspended')
  assert.match(wrong.executor.task.root.lastError, /param "xs" must be list/)

  assert.throws(
    () => makeRuntime({ capsules: [doubler] }).executor.startTask({ tree: { compute: 'code/test.double', params: { xs: [1] }, writes: { x: 'nope' } } }),
    /writes\["x"\] must be one of the outputs/
  )
  assert.throws(
    () => makeRuntime().executor.startTask({ tree: { compute: 'code/test.has-item', params: { item: 'x' } } }),
    /is a condition/
  )
})

test('Compute 的 read：状态作为第二个参数进沙箱，不进黑板', async () => {
  const counter = {
    folder: 'code', name: 'test.count-stacks',
    signature: { outputs: { stacks: { type: 'int' } } },
    body: 'function main(p, state) { return { stacks: state.inventory.slots.length } }'
  }
  const { executor } = makeRuntime({ mod: new FakeMod({ inventory: { 0: ['dirt', 1], 9: ['stone', 3] } }), capsules: [counter] })
  executor.startTask({ tree: { compute: 'code/test.count-stacks', read: ['inventory'] } })
  await runUntil(executor, () => executor.task.state === 'done')
  assert.deepEqual(executor.task.blackboard.snapshot(), { stacks: 2 })
})

// ── JSON 查询 ───────────────────────────────────────────────────────────────

test('core.json.query：树里查配方；参数只许字面量；白名单在装载期就拦下', { skip: allRecipes().length === 0 && 'data/recipes.json 未生成' }, async () => {
  const { executor } = makeRuntime()
  executor.startTask({ tree: { compute: 'code/core.json.query', params: {
    path: 'recipes', records: 'recipes', filters: { result: 'minecraft:stick' }, fields: ['type', 'pattern', 'count'], limit: 2
  }, writes: { recipe: 'result.0', matched: 'matchedCount' } } })
  await runUntil(executor, () => executor.task.state === 'done')
  assert.deepEqual(executor.task.blackboard.get('recipe'), { type: 'shaped', pattern: ['#', '#'], count: 4 })

  const bad = (params) => () => makeRuntime().executor.startTask({ blackboard: { p: 'recipes' }, tree: { compute: 'code/core.json.query', params } })
  assert.throws(bad({ path: '../secret.json', fields: ['a'] }), /unknown json source "\.\."/)
  assert.throws(bad({ path: 'recipes/../x.json', fields: ['a'] }), /segment "\.\." is not allowed/)
  assert.throws(bad({ path: 'nope', fields: ['a'] }), /unknown json source "nope"/)
  assert.throws(bad({ path: '$p', fields: ['a'] }), /must be a literal/)
  assert.throws(bad({ path: 'recipes' }), /missing required param "fields"/)
})

// ── SubTree ─────────────────────────────────────────────────────────────────

const pressTwice = {
  folder: 'trees',
  name: 'test.press-twice',
  signature: { inputs: { slot: { type: 'int', required: true } }, outputs: { pressed: { type: 'int' } } },
  body: { seq: '按两下', do: [
    { act: 'key/hotbar', params: { slot: '$slot' }, writes: { pressed: '+1' } },
    { act: 'key/hotbar', params: { slot: '$slot' }, writes: { pressed: '+1', scratch: '.' } }
  ] }
}

test('SubTree：实例帧装形参与内部变量，退出时只把 outputs 拷回；内部节点 id = 调用点/胶囊内 id', async () => {
  const mod = new FakeMod()
  const { executor } = makeRuntime({ mod, capsules: [pressTwice] })
  executor.startTask({ blackboard: { target: 6 }, tree: { seq: 's', do: [
    { use: 'trees/test.press-twice', params: { slot: '$target' } },
    { cond: 'blackboard/compare', params: { key: 'pressed', op: '==', value: 2 } }
  ] } })
  await runUntil(executor, () => executor.task.state === 'done')
  assert.deepEqual(mod.calls.filter(([m]) => m === 'key/hotbar').map(([, p]) => p.slot), [6, 6])
  assert.deepEqual(executor.task.blackboard.snapshot(), { target: 6, pressed: 2 }, 'scratch / slot 留在实例帧里，没有漏出来')
  assert.ok(executor.task.byId.has('n1.1/c.1'))
  assert.match(executor.task.spec.children[0].ref, /^trees\/test\.press-twice@/)
})

test('SubTree：调用点参数按 signature 校验', () => {
  const { executor } = makeRuntime({ capsules: [pressTwice] })
  assert.throws(() => executor.startTask({ tree: { use: 'trees/test.press-twice', params: { slot: 'six' } } }), /param "slot" must be int/)
  assert.throws(() => executor.startTask({ tree: { use: 'trees/test.press-twice' } }), /missing required param "slot"/)
  assert.throws(() => executor.startTask({ tree: { use: 'code/test.double' } }), /SubTree needs a trees\/ ref|no capsule named/)
})

// ── 可观测性 ────────────────────────────────────────────────────────────────

test('可观测性：每个 Steps / Action 前后的差异进事件日志；expect 不成立 → 失败并附上实际发生的差异', async () => {
  const mod = new FakeMod({ inventory: { 0: ['oak_log', 2] } })
  const { executor, events, requests } = makeRuntime({ mod, config: { observe: { enabled: true } } })
  executor.startTask({ tree: { seq: 's', do: [
    { act: 'key/inventory' },
    { steps: '拿起原木放到第 9 格', do: [['container/slot', { slot: 36 }], ['container/slot', { slot: 9 }]] },
    { act: 'container/close', expect: { cond: 'code/test.has-item', read: ['inventory'], params: { item: 'oak_log', count: 3 } } }
  ] } })
  await runUntil(executor, () => executor.task.state === 'suspended')

  const moved = events.find((e) => e.event === 'observe' && e.id === 'n1.2')
  assert.deepEqual(moved.diff.container.slots, [{ slot: 9, before: '空', after: 'oak_log×2' }, { slot: 36, before: 'oak_log×2', after: '空' }])
  assert.equal(events.find((e) => e.event === 'observe' && e.id === 'n1.1').diff.container.screen, 'none → inventory')

  // 第一次：界面被关掉了，但原木还是 2 个；自动重试（§7.5 ①）时界面已经关着，所以什么都没变
  const attempts = events.filter((e) => e.event === 'node' && e.id === 'n1.3' && e.status === 'FAILURE').map((e) => e.error)
  assert.match(attempts[0], /expect 不成立：code\/test\.has-item@[0-9a-f]+ \{"item":"oak_log","count":3\}；实际发生：界面 inventory → none/)
  assert.match(attempts[1], /实际发生：世界状态没有变化/)
  const failed = requests.at(-1)
  assert.equal(failed.type, 'failed')
  assert.equal(failed.evidence.observed.nodeId, 'n1.3')
})

// ── 端到端：agent 自己写的配方解析 + 点击计划 ───────────────────────────────

const planCraft = {
  folder: 'code',
  name: 'test.plan-2x2',
  description: '把一条无序配方摆进背包界面的 2×2 合成格：返回点击列表（测试夹具，代表 agent 训练出来的代码）',
  signature: { inputs: { recipe: { type: 'object', required: true } }, outputs: { clicks: { type: 'list' } } },
  body: `function main(p: { recipe: any }, state: any) {
  const grid = [1, 2, 3, 4]
  const clicks: any[] = []
  p.recipe.ingredients.forEach((options: string[], i: number) => {
    const source = state.container.slots.find((s: any) => s.slot >= 5 && options.includes(s.id))
    if (!source) throw new Error('missing ' + options[0])
    clicks.push({ slot: source.slot, button: 0, clickType: 0 })
    clicks.push({ slot: grid[i], button: 1, clickType: 0 })
    clicks.push({ slot: source.slot, button: 0, clickType: 0 })
  })
  return { clicks }
}`
}

test('端到端：查配方（json 查询）→ 算点击计划（Compute 读界面）→ 逐项点击（ForEach）→ 取产物（expect 校验）',
  { skip: allRecipes().length === 0 && 'data/recipes.json 未生成' }, async () => {
    const mod = new FakeMod({ inventory: { 3: ['oak_log', 2] } })
    const { executor } = makeRuntime({ mod, capsules: [planCraft], config: { observe: { enabled: true } } })
    executor.startTask({ tree: { seq: '原木 → 木板', do: [
      { act: 'key/inventory' },
      { compute: 'code/core.json.query', params: {
        path: 'recipes', records: 'recipes', filters: { result: 'minecraft:oak_planks' }, fields: ['ingredients', 'count'], limit: 1
      }, writes: { recipe: 'result.0' } },
      { compute: 'code/test.plan-2x2', read: ['container'], params: { recipe: '$recipe' } },
      { forEach: '$clicks', as: 'click', do: { steps: '点一下', do: [['container/slot', '$click']] } },
      { act: 'container/slot', params: { slot: 0, clickType: 1 }, expect: { cond: 'code/test.has-item', read: ['inventory'], params: { item: 'oak_planks', count: 4 } } },
      { act: 'container/close' }
    ] } })
    await runUntil(executor, () => executor.task.state === 'done' || executor.task.pending?.type === 'failed')
    assert.equal(executor.task.state, 'done', executor.task.pending ? JSON.stringify(executor.task.pending.evidence) : '')
    assert.equal(mod.count('oak_planks'), 4, '合成格里放了 1 个原木 → 4 块木板')
    assert.equal(mod.count('oak_log'), 1, '另一个原木放回了原处')
  })
