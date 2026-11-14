import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeMod, allRecipes } from './fake_mod.js'
import { buildReflectDirectory, renderReflectDirectory } from '../src/bt/evidence.js'
import { makeRuntime, runUntil } from './helpers.js'
import { blackboardView, renderExpansionContext } from '../src/llm/bridge.js'

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

test('没声明 read 的状态源：代码一读就报错，不静默当成 undefined（task-20261027130758-2）', async () => {
  const menuOpen = {
    folder: 'code', name: 'test.menu-open',
    signature: { inputs: { expected: { type: 'string', required: true } }, returns: 'bool' },
    body: "function main(p, state) { var c = state.container || {}; return (c.type || 'none') === p.expected }"
  }
  const onlyParams = {
    folder: 'code', name: 'test.flag',
    signature: { inputs: { flag: { type: 'bool', required: true } }, returns: 'bool' },
    body: 'function main(p) { return p.flag === true }'
  }

  // read: [] 的界面判断：原来恒判"已关"（expected none → 真）；现在节点失败，错误点名缺的 read
  const { executor } = makeRuntime({ capsules: [menuOpen, onlyParams] })
  const failures = []
  executor.on('request', (r) => { if (r.type === 'failed') failures.push(r.evidence.error) })
  executor.startTask({ tree: { cond: 'code/test.menu-open', read: [], params: { expected: 'none' } } })
  await runUntil(executor, () => failures.length > 0 || executor.task.state === 'done')
  assert.equal(executor.task.state === 'done', false, '不能再误判成立')
  assert.match(failures[0], /state\.container is not read by this node: add "container"/)

  // 声明了 read → 照常判断；只用 params 的条件不读状态，read: [] 不受影响
  const ok = makeRuntime({ capsules: [menuOpen, onlyParams] }).executor
  ok.startTask({ tree: { seq: 't', do: [
    { cond: 'code/test.menu-open', read: ['container'], params: { expected: 'none' } },
    { cond: 'code/test.flag', read: [], params: { flag: true } }
  ] } })
  await runUntil(ok, () => ok.task.state === 'done')

  // Compute 同理：没 read 时读 state.inventory 报错
  const counter = {
    folder: 'code', name: 'test.count-unread',
    signature: { outputs: { stacks: { type: 'int' } } },
    body: 'function main(p, state) { return { stacks: state.inventory.slots.length } }'
  }
  const c = makeRuntime({ capsules: [counter] }).executor
  const cFailures = []
  c.on('request', (r) => { if (r.type === 'failed') cFailures.push(r.evidence.error) })
  c.startTask({ tree: { compute: 'code/test.count-unread' } })
  await runUntil(c, () => cFailures.length > 0 || c.task.state === 'done')
  assert.match(cFailures[0], /state\.inventory is not read by this node/)
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

test('SubTree：退出时实例帧留一份在任务上，bt_inspect blackboard 给 id 能看到子树里的中间值；复盘目录列出子树黑板', async () => {
  const { executor } = makeRuntime({ capsules: [pressTwice] })
  executor.startTask({ blackboard: { target: 6 }, tree: { seq: 's', do: [{ use: 'trees/test.press-twice', params: { slot: '$target' } }] } })
  await runUntil(executor, () => executor.task.state === 'done')
  const task = executor.task
  const top = await executor.inspect({ what: 'blackboard', keys: ['scratch'] }, { reflect: true })
  assert.deepEqual(top.value.missing, ['scratch'])
  assert.match(top.value.subtreeFrames, /n1\.1 \(trees\/test\.press-twice@\w+: slot, pressed, scratch\)/, '任务帧里没有时指向子树黑板')
  const inner = await executor.inspect({ what: 'blackboard', id: 'n1.1', keys: ['scratch', 'slot', 'pressed'] }, { reflect: true })
  assert.equal(inner.ok, true, JSON.stringify(inner))
  assert.deepEqual(inner.value.values, { scratch: { status: 'ok' }, slot: 6, pressed: 2 }, 'scratch = 第二次按键的返回值')
  assert.equal(inner.value.frame.status, 'SUCCESS')
  assert.match((await executor.inspect({ what: 'blackboard', id: 'n9' }, { reflect: true })).error, /no subtree frame for "n9".*kept: n1\.1/)
  const dir = renderReflectDirectory(buildReflectDirectory(task))
  assert.match(dir, /子树黑板（退出时的值，bt_inspect what=blackboard 加 id=<节点>）：n1\.1（trees\/test\.press-twice@\w+）：slot · pressed · scratch/)
  assert.deepEqual(task.blackboard.snapshot(), { target: 6, pressed: 2 }, '任务帧照旧只拿到 outputs')
})

test('SubTree：调用点参数按 signature 校验', () => {
  const { executor } = makeRuntime({ capsules: [pressTwice] })
  assert.throws(() => executor.startTask({ tree: { use: 'trees/test.press-twice', params: { slot: 'six' } } }), /param "slot" must be int/)
  assert.throws(() => executor.startTask({ tree: { use: 'trees/test.press-twice' } }), /missing required param "slot"/)
  assert.throws(() => executor.startTask({ tree: { use: 'code/test.double' } }), /SubTree needs a trees\/ ref|no capsule named/)
})

// ── 展开请求的现场（2026-11-13）──────────────────────────────────────────────

const fakePlanner = {
  folder: 'code',
  name: 'test.plan',
  signature: { outputs: { mode: { type: 'string' }, missing: { type: 'list' }, big: { type: 'list' } } },
  body: 'function main() { return { mode: "short", missing: [{ id: "minecraft:white_wool", need: 3 }], big: Array.from({ length: 80 }, (_, i) => i) } }'
}
const modeIsOk = { cond: 'blackboard/compare', name: '守卫：计划可行', params: { key: 'mode', op: '==', value: 'ok' } }
const pickaxeQuery = { compute: 'code/core.json.query', params: { path: 'recipes', records: 'recipes', filters: { result: 'minecraft:wooden_pickaxe' }, fields: ['type', 'pattern'] }, writes: { recipes: 'result' } }

test('展开请求附现场：前面失败的分支停在哪、小值给值、大块数据与记忆世界查询结果只给形状', async () => {
  const { executor, requests } = makeRuntime({ capsules: [fakePlanner] })
  executor.startTask({ tree: { seq: '做', do: [pickaxeQuery, { sel: '路线', do: [
    { seq: '主路线', do: [{ compute: 'code/test.plan' }, modeIsOk] },
    { expand: '兜底' }
  ] }] } })
  await runUntil(executor, () => executor.task.state === 'suspended')
  const req = requests.at(-1)
  assert.equal(req.type, 'expand')
  assert.deepEqual(req.context.failures, [{ arm: { id: 'n1.2.1', name: '主路线' }, at: { id: 'n1.2.1.2', name: '守卫：计划可行', type: 'Condition' }, error: null, frames: [] }])
  assert.deepEqual(req.context.frames, [])
  assert.deepEqual(req.context.hidden, ['recipes'])

  const view = blackboardView(req.blackboard, { hidden: req.context.hidden })
  assert.match(view, /^mode = "short"$/m)
  assert.match(view, /^missing = \[\{"id":"minecraft:white_wool","need":3\}\]$/m)
  assert.match(view, /^big: list\(80\) of int（\d+ 字节，只给形状）$/m)
  assert.match(view, /^recipes: .*（记忆世界查询结果，只给形状）$/m)
  const text = renderExpansionContext(req.context)
  assert.match(text, /## 前面没做成的分支（近的在前）\n\n- n1\.2\.1「主路线」：失败在 n1\.2\.1\.2「守卫：计划可行」（Condition）；错误：（无：条件不成立）/)
  assert.equal(renderExpansionContext({ frames: [], failures: [], hidden: [] }), '', '没有现场就不加段落')
})

test('展开点在库里子树内部：消息给出子树的黑板；展开出来的节点读子树里写的键不被误判成"没有节点写过"', async () => {
  const inner = {
    folder: 'trees',
    name: 'test.plan-then-expand',
    signature: { outputs: {} },
    body: { seq: '子树', do: [{ compute: 'code/test.plan' }, { sel: '路线', do: [modeIsOk, { expand: '兜底' }] }] }
  }
  const { executor, requests } = makeRuntime({ capsules: [fakePlanner, doubler, inner] })
  executor.startTask({ blackboard: { goal: 3 }, tree: { seq: '做', do: [{ use: 'trees/test.plan-then-expand' }] } })
  await runUntil(executor, () => executor.task.state === 'suspended')
  const req = requests.at(-1)
  assert.equal(req.evidence.nodeId, 'n1.1/c.2.2')
  assert.deepEqual(req.context.frames.map((f) => [f.id, Object.keys(f.values).sort()]), [['n1.1', ['big', 'missing', 'mode']]])
  assert.deepEqual(req.blackboard, { goal: 3 }, '任务帧里没有子树的中间值')
  const text = renderExpansionContext(req.context)
  assert.match(text, /## 展开点所在子树的黑板.*\n\nn1\.1（trees\/test\.plan-then-expand@\w+）：\n {2}mode = "short"/)
  assert.match(text, /\n- n1\.1\/c\.2\.1「守卫：计划可行」（Condition）；错误：（无：条件不成立）\n/, '同一个 sel 里排在前面的分支（分支本身就是失败的节点）')

  const res = executor.submitExpansion(req.requestId, { compute: 'code/test.double', params: { xs: '$big' } })
  assert.equal(res.ok, true, JSON.stringify(res))
  await runUntil(executor, () => executor.task.state === 'done')
})

test('前面失败的分支是 use 子树：附上它退出时的黑板（失败原因在里面）；子树里的查询结果仍只给形状', async () => {
  const mainRoute = {
    folder: 'trees',
    name: 'test.main-route',
    signature: { outputs: {} },
    body: { seq: '主路线', do: [pickaxeQuery, { compute: 'code/test.plan' }, modeIsOk] }
  }
  const { executor, requests } = makeRuntime({ capsules: [fakePlanner, mainRoute] })
  executor.startTask({ tree: { sel: '做', do: [{ use: 'trees/test.main-route', name: '主路线' }, { expand: '兜底' }] } })
  await runUntil(executor, () => executor.task.state === 'suspended')
  const req = requests.at(-1)
  const [failure] = req.context.failures
  assert.equal(failure.at.id, 'n1.1/c.3')
  assert.deepEqual(failure.frames.map((f) => f.id), ['n1.1'])
  assert.equal(failure.frames[0].values.mode, 'short')
  assert.ok(req.context.hidden.includes('recipes'), '子树里的查询节点也算')
  const text = renderExpansionContext(req.context)
  assert.match(text, /- n1\.1「主路线」：失败在 n1\.1\/c\.3「守卫：计划可行」（Condition）；错误：（无：条件不成立）\n {2}子树 n1\.1（trees\/test\.main-route@\w+）退出时的黑板：\n/)
  assert.match(text, /^ {4}mode = "short"$/m)
  assert.match(text, /^ {4}recipes: .*（记忆世界查询结果，只给形状）$/m)
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

  // 按命令缩小观察来源（2026-11-13）：只有 container/slot 的叶子只读 container；观察读取记 calls.observe，不算树的 reads
  const exitOf = (id) => events.find((e) => e.event === 'node' && e.phase === 'exit' && e.id === id)
  const { actions, reads, observe } = exitOf('n1.2').calls
  assert.deepEqual({ actions, reads, observe }, { actions: 2, reads: 0, observe: 2 }, '点格子：前后各读 container 一次')
  assert.deepEqual(Object.keys(executor.task.snapshots.get('before@n1.2').state), ['container'])
  assert.equal(exitOf('n1.1').calls.observe, 6, '其余命令照旧读 inventory / container / f3')
  assert.deepEqual(Object.keys(executor.task.snapshots.get('before@n1.1').state).sort(), ['container', 'f3', 'inventory'])

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

test('快照等状态稳定（observe.settle）：动作后服务端结果晚到，"执行后"快照、差异与 expect 都看到稳定后的状态；等待的读取记在 calls.settle', async () => {
  /** 产物格 Shift 点击那种：动作发出后，背包里的变化要再读两次才出现 */
  class LaggyMod extends FakeMod {
    handle(method, p) {
      if (method === 'key/hotbar') {
        this.lag = { readsLeft: 2, apply: () => { this.inv[5] = { id: 'minecraft:stick', count: 32 } } }
        return {}
      }
      if (method === 'inventory' && this.lag && --this.lag.readsLeft <= 0) {
        this.lag.apply()
        this.lag = null
      }
      return super.handle(method, p)
    }
  }
  const tree = { seq: 's', do: [{ act: 'key/hotbar', params: { slot: 1 }, expect: { cond: 'code/test.has-item', read: ['inventory'], params: { item: 'stick', count: 32 } } }] }

  const settled = makeRuntime({ mod: new LaggyMod(), config: { observe: { enabled: true, sources: ['inventory', 'container', 'f3'], settle: { intervalMs: 1, maxReads: 4 } } } })
  settled.executor.startTask({ tree })
  await runUntil(settled.executor, () => settled.executor.task.state === 'done')
  const diff = settled.events.find((e) => e.event === 'observe' && e.id === 'n1.1').diff
  assert.deepEqual(diff.inventory, [{ slot: 5, before: '空', after: 'stick×32' }])
  const exit = settled.events.find((e) => e.event === 'node' && e.id === 'n1.1' && e.phase === 'exit')
  assert.equal(exit.calls.observe, 6, '前后各读 3 个来源，记在执行器的观察读取（2026-11-13）')
  assert.equal(exit.calls.reads, 0, 'expect 要的 inventory 已在观察来源里，不再另读，树自己的读取为 0')
  assert.ok(exit.calls.settle >= 4, '等稳定的读取单独记')

  // 不等（maxReads 0，以前的行为）：expect 读到的是中间状态
  const raw = makeRuntime({ mod: new LaggyMod(), config: { observe: { enabled: true, sources: ['inventory', 'container', 'f3'], settle: { maxReads: 0 } } } })
  raw.executor.startTask({ tree })
  await runUntil(raw.executor, () => raw.executor.task.state !== 'running')
  const first = raw.events.find((e) => e.event === 'node' && e.id === 'n1.1' && e.status === 'FAILURE')
  assert.match(first.error, /expect 不成立/)
})
