import test from 'node:test'
import assert from 'node:assert/strict'

import { compileTree, validateTree, pinRefs } from '../src/bt/index.js'
import { createDefaultRegistry } from '../src/commands.js'
import { makeRuntime } from './helpers.js'

const registry = createDefaultRegistry()

test('编译：补 id / type / mode；条件代码、compute、use、forEach、expect 的编写格式', () => {
  const spec = compileTree({ seq: '主链', do: [
    { cond: 'code/x.has', read: ['inventory'], params: { item: 'stick' } },
    { compute: 'code/x.plan', read: ['container'], params: { n: 1 }, writes: { plan: 'clicks' } },
    { use: 'trees/x.walk', params: { to: [1, 2, 3] } },
    { forEach: '$plan', as: 'click', do: { steps: '点', do: [['container/slot', '$click']] } },
    { act: 'container/close', expect: { cond: 'blackboard/has', params: { key: 'plan' } } },
    { expand: '下一步' }
  ] })

  assert.equal(spec.id, 'n1')
  assert.equal(spec.mode, 'memory')
  assert.deepEqual(spec.children.map((c) => c.type), ['Condition', 'Compute', 'SubTree', 'ForEach', 'Action', 'PendingExpansion'])
  assert.deepEqual(spec.children[0], { id: 'n1.1', type: 'Condition', ref: 'code/x.has', read: ['inventory'], params: { item: 'stick' } })
  assert.equal(spec.children[1].read[0], 'container')
  assert.equal(spec.children[3].child.id, 'n1.4.1')
  assert.equal(spec.children[4].expect.id, 'n1.5.e')
})

test('编译：快树的 seq 缺省也是 memory（反应式在 Match 一层），match 缺 otherwise 时补空 Sequence', () => {
  const spec = compileTree({ match: '局势', arms: [
    { when: { cond: 'blackboard/has', params: { key: 'k' } }, then: { seq: '上浮', do: [{ steps: '跳', do: [['key/jump', { pressed: true }]] }] } }
  ] }, { kind: 'fast', rootId: 'f' })
  assert.equal(spec.arms[0].then.mode, 'memory')
  assert.equal(spec.otherwise.type, 'Sequence')
})

test('编译：执行格式节点原样保留，缺 id 的按位置补；ensure 语法糖已移除', () => {
  const spec = compileTree({ seq: 'x', do: [{ type: 'Action', cmd: 'key/drop' }, { type: 'Action', id: 'keep', cmd: 'key/drop' }] })
  assert.deepEqual(spec.children.map((c) => c.id), ['n1.1', 'keep'])
  assert.throws(() => compileTree({ ensure: 'stick' }), /unrecognised node/)
})

test('校验：未知命令、错参数、Steps 里的读取、Repeat 规则都报到节点上', () => {
  const spec = compileTree({ seq: 'bad', do: [
    { act: 'no-such-command' },
    { act: 'key/hotbar', params: { slot: 'two', colour: 'red' } },
    { steps: '读背包', do: [['inventory'], ['wait', 'soon']] },
    { act: 'inventory' },
    { repeat: 'r', until: { cond: 'blackboard/has', params: { key: 'x' } }, do: { act: 'key/drop' } },
    { cond: 'key/drop' }
  ] })
  const text = validateTree(spec, { registry }).errors.join('\n')
  assert.match(text, /\[n1\.1\] unknown command "no-such-command"/)
  assert.match(text, /\[n1\.2\] key\/hotbar: param "slot" must be int/)
  assert.match(text, /\[n1\.2\] key\/hotbar: unknown param "colour"/)
  assert.match(text, /\[n1\.3\] do\[0\]: "inventory" 是读取命令/)
  assert.match(text, /\[n1\.3\] do\[1\]: wait needs a millisecond number/)
  assert.match(text, /\[n1\.4\] .*读取命令不能当 Action 用/)
  assert.match(text, /\[n1\.5\] Repeat with until needs a positive integer maxIterations/)
  assert.match(text, /\[n1\.6\] "key\/drop" is a action, not a condition/)
})

test('校验：黑板读引用必须有来源（$key 与 $key.field 同一套规则）；节点数上限', () => {
  const spec = compileTree({ seq: 'refs', do: [{ act: 'key/hotbar', params: { slot: '$cell.slot' } }] })
  assert.match(validateTree(spec, { registry }).errors[0], /reads "\$cell\.slot" but nothing writes/)
  assert.deepEqual(validateTree(spec, { registry, initialKeys: ['cell'] }).errors, [])
  assert.deepEqual(validateTree(spec, { registry, initialKeys: ['cell.slot'] }).errors, [])
  assert.match(validateTree(spec, { registry, initialKeys: ['cell'], maxNodes: 1 }).errors[0], /over the limit of 1/)
})

test('校验：ForEach 的 list 必须是 $引用，as 会成为后续读引用的来源', () => {
  const ok = compileTree({ forEach: '$plan', as: 'step', do: { act: 'key/hotbar', params: { slot: '$step.slot' } } })
  assert.deepEqual(validateTree(ok, { registry, initialKeys: ['plan'] }).errors, [])
  const bad = compileTree({ forEach: 'plan', as: '$step', do: { act: 'key/drop' } })
  const text = validateTree(bad, { registry }).errors.join('\n')
  assert.match(text, /ForEach.list must be a "\$key" reference/)
  assert.match(text, /ForEach.as must be a blackboard key name/)
})

test('校验：快树规则——根是 Match；不能有 PendingExpansion / Compute / ForEach / 黑板', () => {
  const spec = compileTree({ match: 'm', arms: [
    { when: { cond: 'blackboard/has', params: { key: 'x' } }, then: { seq: 's', do: [{ expand: '想想办法' }, { forEach: '$l', as: 'i', do: { act: 'key/drop' } }] } }
  ] }, { kind: 'fast', rootId: 'f' })
  const text = validateTree(spec, { registry, kind: 'fast' }).errors.join('\n')
  assert.match(text, /快树不读写黑板/)
  assert.match(text, /快树里不能有 PendingExpansion/)
  assert.match(validateTree({ id: 'f', type: 'Sequence', mode: 'reactive', children: [] }, { registry, kind: 'fast' }).errors[0], /快树的根必须是 Match/)
})

test('胶囊引用：pin 把省略的 hash 补上；条件代码的 read 只能是已知来源；条件与 compute 不能混用', () => {
  const { library, refs } = makeRuntime()
  const authored = compileTree({ seq: 's', do: [
    { cond: 'code/test.has-item', read: ['inventory'], params: { item: 'stick' } },
    { cond: 'code/test.has-item', read: ['vision'], params: { item: 'stick' } },
    { cond: 'code/core.json.query', read: [], params: { path: 'recipes', fields: ['a'] } }
  ] })
  const { spec, errors } = pinRefs(authored, library)
  assert.deepEqual(errors, [])
  assert.equal(spec.children[0].ref, refs['test.has-item'])
  const text = validateTree(spec, { registry, library }).errors.join('\n')
  assert.match(text, /\[n1\.2\] Condition.read must be a list drawn from player \/ inventory \/ f3 \/ container/)
  assert.match(text, /\[n1\.3\] .*is a query, it cannot be a condition/)
  assert.doesNotMatch(text, /\[n1\.1\]/)
  assert.match(pinRefs(compileTree({ cond: 'code/nope', read: [] }), library).errors[0], /no capsule named code\/nope/)
})

test('认不出的节点：错误里给出改法（首测：模型把顺序节点写成 { name, do }）', () => {
  assert.throws(() => compileTree({ name: '子任务', do: [{ expand: 'x' }] }), /\{ "seq": <name>, "do": \[\.\.\.\] \}.*"name" alone does not make a sequence/)
  assert.throws(() => compileTree({ name: '按键', do: [['key/jump'], ['wait', 100]] }), /\{ "steps": <name>, "do": \[\.\.\.\] \}/)
  assert.throws(() => compileTree({ do: { expand: 'x' } }), /"repeat", "forEach", "retry" or "timeout"/)
  assert.throws(() => compileTree({ foo: 1 }), /exactly one of: seq, sel.*\(got keys: foo\)/)
})
