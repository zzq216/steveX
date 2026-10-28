import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, name, inject, runCommand } from '../src/index.js'
import { FakeMod } from './fake_mod.js'

/** 假的 DSH 上下文：只实现本插件用到的服务面（commands / tools / agents / systemPrompt / 事件）。 */
function fakeContext() {
  const effects = []
  const commands = []
  const tools = new Map()
  const guards = []
  const sections = []
  const listeners = new Map()
  const agents = new Map()
  const ctx = {
    provide(key, value) { ctx[key] = value },
    effect(fn) { effects.push(fn()) },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => list.splice(list.indexOf(handler), 1)
    },
    commands: { register(def) { commands.push(def); return () => commands.splice(commands.indexOf(def), 1) } },
    tools: {
      register(def) { tools.set(def.name, def); return () => tools.delete(def.name) },
      get(name) { return tools.get(name) },
      guard(fn) { guards.push(fn); return () => guards.splice(guards.indexOf(fn), 1) }
    },
    systemPrompt: { section(def) { sections.push(def); return () => sections.splice(sections.indexOf(def), 1) } },
    agents: {
      get: (id) => agents.get(id),
      withoutInitiator: (fn) => fn(),
      created: [],
      /** 同 DSH：agent/created 在 create 返回之前发出 */
      async create(options) {
        const agent = fakeAgent(options.sessionId)
        agents.set(agent.id, agent)
        ctx.agents.created.push(options)
        await emit('agent/created', { agent })
        return { agent, dispose: async () => {} }
      }
    }
  }
  const emit = async (event, payload, next) => {
    let result
    for (const handler of listeners.get(event) ?? []) result = await handler(payload, next)
    return result
  }
  /** 第一个拒绝理由（同 DSH：任一 guard 返回字符串即拒绝）。 */
  const guardReason = (name, agent) => guards.map((g) => g({ name, agent })).find((r) => typeof r === 'string')
  return { ctx, effects, commands, tools, guards, guardReason, sections, agents, emit, dispose: () => effects.forEach((d) => d?.()) }
}

/** 假 agent：记下 followup / steer / inject 与工具限制。 */
function fakeAgent(id) {
  const agent = {
    id, followups: [], steers: [], injects: [], restrictions: [],
    followup(m) { agent.followups.push(m) },
    steer(m) { agent.steers.push(m) },
    inject(m) { agent.injects.push(m) },
    ctx: {
      tools: {
        restrict(filter) {
          const entry = { ...filter, active: true }
          agent.restrictions.push(entry)
          return () => { entry.active = false }
        }
      }
    }
  }
  return agent
}

const quiet = { info() {}, warn() {} }

test('插件加载：提供 ctx.stevexBt、注册 /bt；卸载时停掉执行器', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stevex-bt-'))
  const { ctx, commands, dispose } = fakeContext()
  apply(ctx, { mod: new FakeMod(), runtimeDir, fastTreeDir: null, capsulesDir: path.join(runtimeDir, 'capsules'), logger: quiet })

  assert.equal(name, 'stevex-agent')
  assert.deepEqual(inject, ['commands', 'tools', 'agents', 'systemPrompt'])
  assert.ok(ctx.stevexBt.executor.timer, '执行器在跑')
  assert.equal(commands[0].name, 'bt')
  assert.match(commands[0].handler({ rawInput: '' }).text, /任务：无/)

  dispose()
  assert.equal(ctx.stevexBt.executor.timer, null)
  assert.equal(commands.length, 0)
})

test('/bt run 读树文件（带初始黑板）并开始任务；/bt nodes、/bt abort', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stevex-bt-'))
  const treeFile = path.join(runtimeDir, 'tree.json')
  fs.writeFileSync(treeFile, JSON.stringify({ goal: '测试', blackboard: { item: 3 }, root: { act: 'key/hotbar', params: { slot: '$item' } } }))
  const { ctx, dispose } = fakeContext()
  apply(ctx, { mod: new FakeMod(), runtimeDir, fastTreeDir: null, capsulesDir: path.join(runtimeDir, 'capsules'), logger: quiet })
  const { executor } = ctx.stevexBt

  const run = runCommand(executor, `run ${treeFile}`)
  assert.equal(run.kind, 'success', run.text)
  assert.equal(executor.task.goal, '测试')
  assert.equal(executor.task.blackboard.get('item'), 3)
  assert.match(runCommand(executor, 'nodes').text, /^n1 +Action/)
  assert.equal(runCommand(executor, 'abort').kind, 'success')
  assert.equal(executor.task.state, 'failed')
  assert.equal(runCommand(executor, 'resume').kind, 'error')
  assert.equal(runCommand(executor, 'bogus').kind, 'error')
  assert.ok(fs.existsSync(path.join(runtimeDir, 'tasks', executor.task.taskId, 'trees', 'v1.json')))
  dispose()
})

test('/bt run：树不合法时返回逐条错误', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stevex-bt-'))
  const treeFile = path.join(runtimeDir, 'bad.json')
  fs.writeFileSync(treeFile, JSON.stringify({ act: 'fly' }))
  const { ctx, dispose } = fakeContext()
  apply(ctx, { mod: new FakeMod(), runtimeDir, fastTreeDir: null, capsulesDir: path.join(runtimeDir, 'capsules'), logger: quiet })
  const res = runCommand(ctx.stevexBt.executor, `run ${treeFile}`)
  assert.equal(res.kind, 'error')
  assert.match(res.text, /unknown command "fly"/)
  dispose()
})

function loadPlugin(extra = {}) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stevex-bt-'))
  const fake = fakeContext()
  apply(fake.ctx, { mod: new FakeMod(), runtimeDir, fastTreeDir: null, capsulesDir: path.join(runtimeDir, 'capsules'), logger: quiet, ...extra })
  return { ...fake, runtimeDir }
}

const enter = (messages) => async () => ({ kind: 'enter', messages })

test('装载：注册二十二个工具（含三个 fast_*、两个复盘工具、四个事实 / 源码工具）与三段系统提示词（不插值）', () => {
  const { tools, sections, dispose } = loadPlugin()
  assert.equal(tools.size, 22)
  assert.ok(tools.get('bt_submit_tree').output.schema, '经过 defineTool')
  assert.deepEqual(sections.map((s) => s.name), ['stevex:identity', 'stevex:authoring', 'stevex:catalog'])
  assert.ok(sections.every((s) => s.interpolate === false))
  assert.match(sections[2].text(), /code\/core\.json\.query/)
  dispose()
  assert.equal(tools.size, 0)
})

test('P1 适配层：/bt task → followup → 回合绑定（守卫按请求放行）→ 没提交就 steer → 提交后恢复会话名单', async () => {
  const { ctx, commands, tools, agents, emit, guardReason, dispose } = loadPlugin()
  const agent = fakeAgent('s1')
  agents.set('s1', agent)

  await emit('agent/created', { agent })
  assert.equal(agent.restrictions.length, 1, 'exclusiveTools：会话只看得到 steveX 的工具')
  assert.equal(agent.restrictions[0].allow.length, 19, '普通会话看不到 fast_*')
  assert.equal(agent.restrictions[0].allow.includes('todo_write'), false, '没注册的内置工具不进 allow（restrict 会拒绝未知名字）')

  const started = commands[0].handler({ rawInput: 'task 做一把木镐', agent })
  assert.equal(started.kind, 'success', started.text)
  const [message] = agent.followups
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'stevex-bt')
  assert.equal(message.source.form, 'notice')
  assert.match(message.source.summary, /规划任务：做一把木镐/)
  assert.match(message.content[0].text, /指令：\*\*做一把木镐\*\*/)

  const decision = await emit('agent/pre-step', { agent, turn: 1, step: 1 }, enter([message]))
  assert.equal(decision.kind, 'enter')
  assert.equal(agent.restrictions.length, 1, '回合级不再 restrict：工具清单整个会话不变（KV 缓存）')
  assert.equal(guardReason('bt_submit_tree', agent), undefined)
  assert.equal(guardReason('data_shapes', agent), undefined, '规划时可以查状态的结构')
  assert.match(guardReason('bt_submit_expansion', agent), /executor request/)
  assert.match(guardReason('mod_query', agent), /I13/, '规划回合不能直接读状态')
  assert.match(guardReason('json_query', agent), /"compute": "code\/core\.json\.query".*data_shapes/, '拒绝理由给出树里的等价写法')

  await emit('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steers.length, 1)
  assert.match(agent.steers[0].content[0].text, /还剩 2 次/)
  assert.match(guardReason('mod_query', agent), /I13/, '提醒后回合继续，限制保留')

  const result = await tools.get('bt_submit_tree').execute({
    requestId: message.source.requestId,
    tree: { seq: '木镐', do: [{ steps: '切栏', do: [['key/hotbar', { slot: 1 }]] }, { expand: '合成木镐' }] }
  }, { agent })
  assert.equal(result.ok, true)
  await emit('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steers.length, 1)
  assert.equal(guardReason('mod_query', agent), undefined, '回合结束，回到会话名单')

  const { executor } = ctx.stevexBt
  executor.stop()
  for (let i = 0; i < 200 && executor.task.state !== 'suspended'; i++) {
    executor.tick()
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(agent.followups.length, 2, 'expand 请求叫醒同一个会话')
  assert.equal(agent.followups[1].source.reason, 'expand')

  assert.match(commands[0].handler({ rawInput: 'status', agent }).text, /在飞请求：r\d+ expand/)
  await emit('agent/disposed', { agent })
  assert.equal(executor.task.state, 'failed', '会话关掉 → 任务失败')
  dispose()
})

test('P5 适配层：/bt fact → followup → 事实确认回合（守卫按名单放行）→ 查了源码没写事实提醒一次；请求没交时先提醒请求；/bt facts', async () => {
  const factsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stevex-facts-'))
  const { ctx, commands, tools, agents, emit, guardReason, dispose } = loadPlugin({ facts: { dir: factsDir } })
  const agent = fakeAgent('s1')
  agents.set('s1', agent)
  await emit('agent/created', { agent })
  const bt = (rawInput) => commands[0].handler({ rawInput, agent })

  assert.equal(bt('fact 岩浆会点燃玩家').kind, 'success')
  const [message] = agent.followups
  assert.equal(message.source.kind, 'stevex-fact')
  assert.match(message.content[0].text, /> 岩浆会点燃玩家/)
  await emit('agent/pre-step', { agent, turn: 1, step: 1 }, enter([message]))
  assert.equal(guardReason('mc_source_search', agent), undefined)
  assert.equal(guardReason('fact_write', agent), undefined)
  assert.match(guardReason('mod_query', agent), /while confirming an MC fact/)
  assert.match(guardReason('bt_submit_tree', agent), /while confirming an MC fact/)

  const read = await tools.get('mc_source_read').execute({ file: 'net/minecraft/world/entity/LivingEntity.java', start: 1392, end: 1397 }, { agent })
  assert.equal(read.ok, true, '默认的源码基准就是 steveX/1.21.11_src')
  assert.match(read.text, /getLastDamageSource/)
  const leak = await tools.get('mc_source_read').execute({ file: '../configs/environments/default.yaml' }, { agent })
  assert.equal(leak.ok, false)

  await emit('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steers.length, 1)
  assert.match(agent.steers[0].content[0].text, /本回合查阅了 MC 源码/)
  assert.equal(agent.steers[0].source.kind, 'stevex-fact')
  await emit('agent/turn-stopping', { agent, turn: 1 })
  assert.equal(agent.steers.length, 1, '每回合只提醒一次')
  assert.equal(guardReason('mod_query', agent), undefined, '回合结束，回到会话名单')

  const wrote = await tools.get('fact_write').execute({ name: 'damage.last-source-expires', statement: '最近一次伤害来源超过 40 tick 就清空', refs: [{ file: 'net/minecraft/world/entity/LivingEntity.java', lines: [1392, 1397] }] }, { agent })
  assert.equal(wrote.ok, true, JSON.stringify(wrote))
  assert.deepEqual(wrote.fact.source, { kind: 'chat', sessionId: 's1' })
  assert.match(bt('facts 伤害 40').text, /damage\.last-source-expires（rev 1）/)
  assert.match(bt('facts check').text, /1 条事实，引用全部有效/)

  // 规划回合：查了源码、请求又没交 → 只提醒请求；交了之后回合再要结束 → 才提醒补事实
  bt('task 做一把木镐')
  const plan = agent.followups.at(-1)
  await emit('agent/pre-step', { agent, turn: 2, step: 1 }, enter([plan]))
  assert.equal(guardReason('mc_source_search', agent), undefined, '规划回合也能查源码（P5-D11）')
  await tools.get('mc_source_search').execute({ pattern: 'class CraftingMenu', limit: 1 }, { agent })
  await emit('agent/turn-stopping', { agent, turn: 2 })
  assert.match(agent.steers.at(-1).content[0].text, /还剩 2 次/, '先提醒请求')
  const submitted = await tools.get('bt_submit_tree').execute({ requestId: plan.source.requestId, tree: { seq: '木镐', do: [{ expand: '合成木镐' }] } }, { agent })
  assert.equal(submitted.ok, true)
  await emit('agent/turn-stopping', { agent, turn: 2 })
  assert.match(agent.steers.at(-1).content[0].text, /本回合查阅了 MC 源码/, '请求交了，再提醒补事实')
  ctx.stevexBt.executor.stop()
  dispose()
})

test('路由接口 factInTurn：在人发起的回合里确认事实，返回放进本 step 的正文；和规划同一回合时工具取并集', () => {
  const { ctx, agents, guardReason, dispose } = loadPlugin()
  const agent = fakeAgent('s1')
  agents.set('s1', agent)
  const res = ctx.stevexBt.factInTurn({ agent, turn: 3, statement: '岩浆会点燃玩家' })
  assert.equal(res.ok, true)
  assert.match(res.text, /skill：事实确认/)
  assert.equal(agent.followups.length, 0)
  assert.match(guardReason('bt_submit_tree', agent), /confirming an MC fact/)
  assert.equal(ctx.stevexBt.planInTurn({ agent, turn: 3, instruction: '绕开岩浆去挖铁' }).ok, true)
  assert.equal(guardReason('bt_submit_tree', agent), undefined, '并集：规划的工具也放行')
  assert.equal(guardReason('fact_write', agent), undefined)
  ctx.stevexBt.executor.stop()
  dispose()
})

test('路由接口 planInTurn：在人发起的回合里规划，返回放进本 step 的请求正文', () => {
  const { ctx, agents, guardReason, dispose } = loadPlugin()
  const agent = fakeAgent('s1')
  agents.set('s1', agent)
  const res = ctx.stevexBt.planInTurn({ agent, turn: 3, instruction: '做一把木镐' })
  assert.equal(res.ok, true)
  assert.match(res.text, /规划请求 p1/)
  assert.equal(agent.followups.length, 0)
  assert.match(guardReason('mod_query', agent), /I13/, '回合内规划同样只放行规划请求的工具')
  assert.match(ctx.stevexBt.planInTurn({ agent, turn: 4, instruction: '再来' }).error, /还在等 bt_submit_tree/)
  dispose()
})

test('planner.enabled = false：不注册工具，本地应答器照旧回答全部请求', () => {
  const { tools, sections, ctx, dispose } = loadPlugin({ planner: { enabled: false } })
  assert.equal(tools.size, 0)
  assert.equal(sections.length, 0)
  assert.equal(ctx.stevexBt.bridge, null)
  assert.match(ctx.stevexBt.planInTurn({ agent: fakeAgent('s1'), turn: 1, instruction: 'x' }).error, /disabled/)
  dispose()
})

test('/bt 声明了 input：Web 输入框才会把带参数的 "/bt task …" 当命令执行', () => {
  const { commands, dispose } = loadPlugin()
  assert.match(commands[0].input?.hint ?? '', /task <指令>/)
  dispose()
})

test('工具守卫：会话里不在名单的工具（如漏过可见性限制的 subagent）调用被拒；规划回合只放行该请求的工具', async () => {
  const { commands, guards, guardReason, agents, emit, dispose } = loadPlugin()
  assert.equal(guards.length, 1)
  const agent = fakeAgent('s1')
  agents.set('s1', agent)

  assert.match(guardReason('subagent', agent), /not available in a steveX session/)
  assert.equal(guardReason('mod_query', agent), undefined, '普通问答可以直接查')
  assert.equal(guardReason('ask_user_question', agent), undefined)
  assert.equal(guardReason('anything', undefined), undefined, '不属于任何 agent 的内部调用不拦')

  commands[0].handler({ rawInput: ' task 切到 1 号栏', agent })
  await emit('agent/pre-step', { agent, turn: 1, step: 1 }, enter([agent.followups[0]]))
  assert.match(guardReason('mod_query', agent), /answering an executor request.*I13/)
  assert.equal(guardReason('bt_submit_tree', agent), undefined)
  assert.match(guardReason('bt_submit_expansion', agent), /answering an executor request/, '规划回合不能交展开')

  await emit('agent/turn-stopping', { agent, turn: 1 }) // 没提交 → steer，回合继续，限制保留
  assert.match(guardReason('mod_query', agent), /answering an executor request/)
  await emit('agent/disposed', { agent })
  assert.match(guardReason('subagent', agent), /not available in a steveX session/)
  dispose()
})

test('快树反思（P3）：批次 → ctx.agents.create 开会话（stevex 预设）→ followup 目录；会话只准入 fast_* 与接口知识；没提交 → steer；/bt fast 子命令', async () => {
  const { ctx, commands, agents, emit, guardReason, dispose } = loadPlugin({ planner: { exclusiveTools: true } })
  const { executor, fast } = ctx.stevexBt
  const bt = (rawInput) => commands[0].handler({ rawInput })
  assert.match(bt('fast status').text, /快树 v0，版本链最新 v0/)
  assert.match(bt('fast status').text, /待反思事件：无/)
  assert.equal(bt('fast reflect').text, '没有待反思的事件')

  // 构造一条 otherwise 下的掉血事件
  const mod = executor.game.mod
  await executor.game.pollOnce()
  executor.tick()
  mod.health = 15
  mod.lastDamage = { type: 'minecraft:fall', ticksAgo: 0 }
  await executor.game.pollOnce()
  executor.tick()
  assert.match(bt('fast reflect').text, /批次 b1（e1）已开始反思/)
  await new Promise((resolve) => setTimeout(resolve, 20))

  const [options] = ctx.agents.created
  assert.equal(options.meta.agentPreset, 'stevex')
  const session = agents.get(options.sessionId)
  assert.ok(session.restrictions[0].allow.includes('fast_submit_patch'), '快树会话看得到 fast_*')
  assert.equal(session.restrictions[0].allow.includes('bt_submit_tree'), false)
  assert.equal(session.followups[0].source.kind, 'stevex-fast')
  assert.match(session.followups[0].content[0].text, /快树反思批次 b1/)
  assert.equal(guardReason('fast_inspect', session), undefined)
  assert.equal(guardReason('capsule_get', session), undefined)
  assert.match(guardReason('mod_query', session), /not available in a fast-tree reflection session/)
  assert.match(guardReason('bt_submit_patch', session), /fast-tree reflection session/)
  const normal = fakeAgent('s1')
  agents.set('s1', normal)
  assert.match(guardReason('fast_submit_patch', normal), /only for fast-tree reflection sessions/)
  assert.match(guardReason('capsule_save', normal), /only for answering a task review/, '复盘工具只在复盘回合可用')

  await emit('agent/turn-stopping', { agent: session, turn: 1 })
  assert.match(session.steers[0].content[0].text, /快树批次 b1 还没有结束/)
  assert.match(bt('fast status').text, /在飞 b1/)

  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stevex-fast-')), 'reflex.json')
  fs.writeFileSync(tmp, JSON.stringify({ match: '反射', arms: [{ when: { cond: 'blackboard/has', params: { key: 'x' } }, then: { steps: '跳', do: [['key/jump', { pressed: true }], ['key/jump', { pressed: false }]] } }] }))
  assert.match(bt(`fast load ${tmp} 手写的初始反射`).text, /快树不合法[\s\S]*黑板/)
  fs.writeFileSync(tmp, JSON.stringify({ match: '反射', arms: [{ when: { cond: 'code/example.air-below', read: ['player'], params: { value: 1 } }, then: { steps: '跳', do: [['key/jump', { pressed: true }], ['key/jump', { pressed: false }]] } }] }))
  assert.match(bt(`fast load ${tmp}`).text, /no capsule named code\/example\.air-below/)
  fs.writeFileSync(tmp, JSON.stringify({ match: '反射', arms: [] }))
  assert.match(bt(`fast load ${tmp} 空的`).text, /快树 v1：（没有 arm）/)
  assert.equal(fast.versions.latest(), 1)
  assert.match(bt('fast log').text, /v1  manual[\s\S]*空的/)
  assert.match(bt('fast rollback 0').text, /已回滚：v0 另存为 v2/)
  assert.match(bt('fast rollback x').text, /用法/)
  assert.equal(bt('fast bogus').kind, 'error')
  await emit('agent/disposed', { agent: session })
  assert.match(bt('fast log').text, /b1 abandoned（e1）：session .* was closed/)
  dispose()
})

test('agent/error：绑定了请求的回合出错 → followup 一条重试消息，并解除该回合的工具名单', async () => {
  const { commands, agents, emit, guardReason, dispose } = loadPlugin()
  const agent = fakeAgent('s1')
  agents.set('s1', agent)
  commands[0].handler({ rawInput: ' task 做一把木镐', agent })
  await emit('agent/pre-step', { agent, turn: 1, step: 1 }, enter([agent.followups[0]]))
  assert.match(guardReason('mod_query', agent), /I13/)

  // 和 DSH 一样：出错的回合在 agent/error 发出时还在跑，这时的 followup 叫不醒驱动器——必须等 idle 再发
  let settle
  agent.whenIdle = () => new Promise((resolve) => { settle = resolve })
  await emit('agent/error', { agent, turn: 1, step: 3, error: new Error('tool input is invalid JSON') })
  assert.equal(agent.followups.length, 1, '回合还没结束：不能在 agent/error 里直接 followup')
  settle()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(agent.followups.length, 2)
  assert.equal(agent.followups[1].source.reason, 'retry')
  assert.match(agent.followups[1].content[0].text, /tool input is invalid JSON/)
  assert.equal(guardReason('mod_query', agent), undefined, '出错的回合已结束，回到会话名单')
  dispose()
})
