'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { validateParams, runQuery } = require('../../src/nbt/query')

const records = [
  {
    uuid: 'u1', dim: 'minecraft:overworld', id: 1, type: 'minecraft:item',
    pos: [1, 64, 2], onGround: true, health: 20,
    item: { id: 'minecraft:diamond', count: 3 }
  },
  {
    uuid: 'u2', dim: 'minecraft:overworld', id: 2, type: 'minecraft:item',
    pos: [-5, 12, 9], onGround: false, health: 20,
    item: { id: 'minecraft:stone', count: 1 }
  },
  {
    uuid: 'u3', dim: 'minecraft:the_nether', id: 3, type: 'minecraft:zombie',
    pos: [100, 40, -7], onGround: true, health: 10,
    living: { baby: false, pose: 'standing' }
  },
  {
    uuid: 'u4', dim: 'minecraft:overworld', id: 4, type: 'minecraft:oak_stairs',
    pos: [0, -64, 0], state: { facing: 'north', waterlogged: 'true' },
    block: 'minecraft:oak_stairs'
  }
]

function normalize(params) {
  return validateParams(Object.assign({ path: 'terrain', fields: ['uuid'] }, params))
}

function matched(filters) {
  return runQuery(records, normalize({ filters }), { timeoutMs: 0 }).matchedCount
}

test('默认值：limit=64，filters 缺省 = 全部命中', () => {
  const q = normalize({})
  assert.equal(q.limit, 64)
  assert.deepEqual(q.filters, [])
  const { result, matchedCount } = runQuery(records, q, { timeoutMs: 0 })
  assert.equal(matchedCount, records.length)
  assert.deepEqual(result.map((r) => r.uuid), ['u1', 'u2', 'u3', 'u4'])
})

test('number：单值 / 闭区间 / 单侧开 / 并集', () => {
  assert.equal(matched({ 'pos.y': 64 }), 1)
  assert.equal(matched({ 'pos.y': { min: 20, max: 60 } }), 1) // u3
  assert.equal(matched({ 'pos.y': { min: 60 } }), 1) // u1
  assert.equal(matched({ 'pos.y': { max: 0 } }), 1) // u4
  assert.equal(matched({ 'pos.y': [64, 40] }), 2) // u1 + u3
  assert.equal(matched({ 'pos.y': [{ min: -10, max: 20 }, 64] }), 2) // u2 + u1
})

test('string：单值 / 枚举并集', () => {
  assert.equal(matched({ type: 'minecraft:zombie' }), 1)
  assert.equal(matched({ type: ['minecraft:item', 'minecraft:zombie'] }), 3)
  assert.equal(matched({ dim: 'minecraft:overworld' }), 3)
})

test('boolean 单值；state.* 是 string，boolean 条件恒不匹配', () => {
  assert.equal(matched({ onGround: true }), 2) // u1 + u3
  assert.equal(matched({ 'state.waterlogged': true }), 0)
  assert.equal(matched({ 'state.waterlogged': 'true' }), 1) // u4
})

test('嵌套路径与坐标糖', () => {
  assert.equal(matched({ 'item.id': 'minecraft:diamond' }), 1)
  assert.equal(matched({ 'item.count': { min: 2 } }), 1)
  assert.equal(matched({ 'living.baby': false }), 1) // 缺 living 的记录不匹配
  assert.equal(matched({ 'pos.x': { min: 0 } }), 3) // u1(1) + u3(100) + u4(0)
  assert.equal(matched({ 'pos.q': 1 }), 0) // 数组只认 .x/.y/.z
})

test('多键 = AND；缺失 / 类型不符 → 不匹配', () => {
  assert.equal(matched({ type: 'minecraft:item', 'item.id': 'minecraft:diamond' }), 1)
  assert.equal(matched({ 'item.id': 'minecraft:stone', dim: 'minecraft:the_nether' }), 0)
  assert.equal(matched({ 'state.facing': ['north', 'east'] }), 1) // u4
})

test('投影：扁平键、缺失字段缺席、顺序保留', () => {
  const q = normalize({ filters: { type: 'minecraft:item' }, fields: ['uuid', 'pos', 'item.id'] })
  const { result } = runQuery(records, q, { timeoutMs: 0 })
  assert.deepEqual(result, [
    { uuid: 'u1', pos: [1, 64, 2], 'item.id': 'minecraft:diamond' },
    { uuid: 'u2', pos: [-5, 12, 9], 'item.id': 'minecraft:stone' }
  ])
  assert.equal('item.id' in result[0], true)

  const q3 = normalize({ filters: { uuid: 'u3' }, fields: ['uuid', 'item.id'] })
  const out3 = runQuery(records, q3, { timeoutMs: 0 }).result
  assert.equal('item.id' in out3[0], false) // 缺失 → 键缺席，不写 null
})

test('limit 截断不失败，matchedCount 仍为截断前总数', () => {
  const q = normalize({ fields: ['uuid'], limit: 2, filters: { dim: 'minecraft:overworld' } })
  const { result, matchedCount } = runQuery(records, q, { timeoutMs: 0 })
  assert.equal(result.length, 2)
  assert.equal(matchedCount, 3)
})

test('字节上限：按前缀截断，matchedCount 如实', () => {
  const big = Array.from({ length: 4 }, (_, i) => ({ uuid: `u${i}`, blob: 'x'.repeat(100) }))
  const q = normalize({ fields: ['uuid', 'blob'] })

  const zero = runQuery(big, q, { byteCap: 50, timeoutMs: 0 })
  assert.equal(zero.matchedCount, 4)
  assert.equal(zero.result.length, 0)

  const one = runQuery(big, q, { byteCap: 130, timeoutMs: 0 })
  assert.equal(one.result.length, 1)
  assert.equal(one.matchedCount, 4)

  const all = runQuery(big, q, { byteCap: 1000, timeoutMs: 0 })
  assert.equal(all.result.length, 4)
})

test('硬超时：预算耗尽 → TIMEOUT', () => {
  let calls = 0
  const clock = () => (calls++ === 0 ? 0 : 1000) // 第一次取 deadline，之后时钟直接越过预算
  assert.throws(
    () => runQuery(records, normalize({}), { timeoutMs: 1, clock }),
    (e) => e.code === 'TIMEOUT'
  )
})

test('参数形态校验（§4.3 / §3.1）', () => {
  const bad = [
    { path: 'terrain', fields: ['uuid'], extra: 1 },            // 未知参数
    { fields: ['uuid'] },                                       // 缺 path
    { path: 42, fields: ['uuid'] },                             // path 非字符串
    { path: 'terrain', fields: [] },                            // fields 空
    { path: 'terrain', fields: [''] },                          // fields 元素空
    { path: 'terrain', fields: 'uuid' },                        // fields 非数组
    { path: 'terrain', fields: ['uuid'], limit: 0 },            // limit 下界
    { path: 'terrain', fields: ['uuid'], limit: 4097 },         // limit 上界
    { path: 'terrain', fields: ['uuid'], limit: 1.5 },          // limit 非整数
    { path: 'terrain', fields: ['uuid'], filters: [] },         // filters 非对象
    { path: 'terrain', fields: ['uuid'], filters: { 'pos.y': { min: 0, eps: 1 } } }, // 区间未知键
    { path: 'terrain', fields: ['uuid'], filters: { 'pos.y': {} } },                 // 空区间
    { path: 'terrain', fields: ['uuid'], filters: { 'pos.y': { min: 5, max: 1 } } }, // min > max
    { path: 'terrain', fields: ['uuid'], filters: { type: [] } },                    // 空并集
    { path: 'terrain', fields: ['uuid'], filters: { type: ['a', 1] } },              // 混合并集
    { path: 'terrain', fields: ['uuid'], filters: { onGround: [true, false] } },     // boolean 并集
    { path: 'terrain', fields: ['uuid'], filters: { 'pos.y': NaN } },                // 非有限数
    { path: 'terrain', fields: ['uuid'], filters: { 'pos.y': null } }                // 非法条件
  ]

  for (const params of bad) {
    assert.throws(() => validateParams(params), (e) => e.code === 'LOAD_ERROR', JSON.stringify(params))
  }
})

test('合法条件形态全部通过', () => {
  const cases = [
    { 'pos.y': 64 },
    { 'pos.y': { min: 0 } },
    { 'pos.y': { max: 64 } },
    { 'pos.y': [{ min: 0, max: 1 }, 64] },
    { type: ['a', 'b'] },
    { onGround: true },
    { 'state.lit': 'true' }
  ]
  for (const filters of cases) assert.doesNotThrow(() => validateParams({ path: 'terrain', fields: ['uuid'], filters }))
})
