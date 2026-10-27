'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const NBT = require('./helpers')
const { createSourceLoader } = require('../../src/nbt/loader')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('terrain：分片目录合并 + 隐式 pos/dim', async () => {
  const root = NBT.makeTempDir()
  try {
    const store = path.join(root, 'terrain_union')
    NBT.writeRegion(store, 'minecraft:overworld', 0, 0, 'blocks', NBT.compound({
      '1,64,2': NBT.compound({ block: NBT.string('minecraft:stone'), state: NBT.compound({}) }),
      '-3,10,7': NBT.compound({
        block: NBT.string('minecraft:diamond_ore'),
        state: NBT.compound({ waterlogged: NBT.string('false') })
      })
    }), 1000)
    NBT.writeIndex(store, { 'minecraft:overworld': { '0,0': 1000 } })

    const loader = createSourceLoader({ visionRoot: root })
    const snapshot = await loader.load('terrain', { taskId: 't1' })

    assert.equal(snapshot.records.length, 2)
    assert.deepEqual(snapshot.records[0], {
      block: 'minecraft:stone',
      state: {},
      pos: [1, 64, 2],
      dim: 'minecraft:overworld'
    })
    assert.deepEqual(snapshot.records[1].state, { waterlogged: 'false' })
    assert.equal(typeof snapshot.version, 'string')
    assert.ok(snapshot.version.length > 0)
  } finally {
    NBT.removeDir(root)
  }
})

test('entities：单文件 + 维桶 + union 独有 cells', async () => {
  const root = NBT.makeTempDir()
  try {
    NBT.writeNbtFile(path.join(root, 'entities_union.nbt'), NBT.compound({
      currentDimension: NBT.string('minecraft:overworld'),
      worlds: NBT.compound({
        'minecraft:overworld': NBT.compound({
          updatedAt: NBT.long(1000),
          entities: NBT.compound({
            'uuid-1': NBT.compound({
              id: NBT.int(1),
              type: NBT.string('minecraft:zombie'),
              pos: NBT.list(NBT.T.DOUBLE, [NBT.double(1), NBT.double(64), NBT.double(2)]),
              onGround: NBT.bool(true),
              living: NBT.compound({ baby: NBT.bool(false), pose: NBT.string('standing') }),
              cells: NBT.list(NBT.T.STRING, [NBT.string('1,64,2')])
            }),
            'uuid-2': NBT.compound({
              id: NBT.int(2),
              type: NBT.string('minecraft:item'),
              item: NBT.compound({ id: NBT.string('minecraft:diamond'), count: NBT.int(1) })
            })
          })
        }),
        'minecraft:the_nether': NBT.compound({
          updatedAt: NBT.long(2000),
          entities: NBT.compound({
            'uuid-3': NBT.compound({ id: NBT.int(3), type: NBT.string('minecraft:piglin') })
          })
        })
      })
    }))

    const loader = createSourceLoader({ visionRoot: root })
    const snapshot = await loader.load('entities')

    assert.equal(snapshot.records.length, 3)
    assert.equal(snapshot.records[0].uuid, 'uuid-1')
    assert.equal(snapshot.records[0].dim, 'minecraft:overworld')
    assert.deepEqual(snapshot.records[0].cells, ['1,64,2'])
    assert.equal(snapshot.records[0].onGround, true) // TAG_Byte(1) → boolean（数据源层归一）
    assert.equal(snapshot.records[0].living.baby, false)
    assert.equal(snapshot.records[1].item.id, 'minecraft:diamond')
    assert.equal(snapshot.records[2].dim, 'minecraft:the_nether')
  } finally {
    NBT.removeDir(root)
  }
})

test('containers：区文件 + ender.nbt 全局桶', async () => {
  const root = NBT.makeTempDir()
  try {
    const store = path.join(root, 'containers')
    NBT.writeRegion(store, 'minecraft:overworld', 0, 0, 'containers', NBT.compound({
      '10,20,30': NBT.compound({
        typeId: NBT.string('minecraft:chest'),
        block: NBT.string('minecraft:chest'),
        state: NBT.compound({ facing: NBT.string('north') }),
        items: NBT.list(NBT.T.COMPOUND, [
          NBT.compound({
            slot: NBT.int(0),
            item: NBT.compound({ id: NBT.string('minecraft:diamond'), count: NBT.int(2) })
          })
        ])
      })
    }), 1000)
    NBT.writeIndex(store, { 'minecraft:overworld': { '0,0': 1000 } })
    NBT.writeNbtFile(path.join(store, 'ender.nbt'), NBT.compound({
      version: NBT.int(1),
      enderInventory: NBT.compound({
        items: NBT.list(NBT.T.COMPOUND, [
          NBT.compound({ slot: NBT.int(3), item: NBT.compound({ id: NBT.string('minecraft:stick'), count: NBT.int(1) }) })
        ])
      })
    }))

    const loader = createSourceLoader({ visionRoot: root })
    const { records } = await loader.load('containers')

    assert.equal(records.length, 2)
    const container = records.find((r) => r.scope === 'container')
    const ender = records.find((r) => r.scope === 'ender')
    assert.deepEqual(container.pos, [10, 20, 30])
    assert.equal(container.dim, 'minecraft:overworld')
    assert.equal(container.items[0].item.id, 'minecraft:diamond')
    assert.deepEqual(ender.items[0].item.id, 'minecraft:stick')
    assert.equal('pos' in ender, false)
    assert.equal('dim' in ender, false)
  } finally {
    NBT.removeDir(root)
  }
})

test('block_entities：忽略 _pose.nbt / _index.nbt 等非区文件', async () => {
  const root = NBT.makeTempDir()
  try {
    const store = path.join(root, 'block_entities')
    NBT.writeRegion(store, 'minecraft:overworld', 0, 0, 'blockEntities', NBT.compound({
      '5,6,7': NBT.compound({
        typeId: NBT.string('minecraft:sign'),
        block: NBT.string('minecraft:oak_sign'),
        state: NBT.compound({}),
        nbt: NBT.compound({}),
        timestamp: NBT.long(1234)
      })
    }), 1000)
    NBT.writeIndex(store, { 'minecraft:overworld': { '0,0': 1000 } })
    fs.writeFileSync(path.join(store, '_pose.nbt'), Buffer.from('not an nbt file'))

    const loader = createSourceLoader({ visionRoot: root })
    const { records } = await loader.load('block_entities')

    assert.equal(records.length, 1)
    assert.deepEqual(records[0].pos, [5, 6, 7])
    assert.equal(records[0].timestamp, 1234)
    assert.deepEqual(records[0].nbt, {})
  } finally {
    NBT.removeDir(root)
  }
})

test('biomes：quart cell（"qx,qy,qz" → quart 数组）', async () => {
  const root = NBT.makeTempDir()
  try {
    const store = path.join(root, 'biomes')
    NBT.writeRegion(store, 'minecraft:overworld', 0, 0, 'cells', NBT.compound({
      '0,4,0': NBT.string('minecraft:plains'),
      '-1,4,2': NBT.string('minecraft:desert')
    }), 1000)
    NBT.writeIndex(store, { 'minecraft:overworld': { '0,0': 1000 } })

    const loader = createSourceLoader({ visionRoot: root })
    const { records } = await loader.load('biomes')

    assert.equal(records.length, 2)
    assert.deepEqual(records[0], { biome: 'minecraft:plains', quart: [0, 4, 0], dim: 'minecraft:overworld' })
    assert.deepEqual(records[1].quart, [-1, 4, 2])
  } finally {
    NBT.removeDir(root)
  }
})

test('缓存按版本：版本没变复用同一份；文件变了同一任务里下一次查询就读到新数据（P2 §6.3）', async () => {
  const root = NBT.makeTempDir()
  try {
    const store = path.join(root, 'terrain_union')
    const write = (block, updatedAt) => {
      NBT.writeRegion(store, 'minecraft:overworld', 0, 0, 'blocks', NBT.compound({
        '1,64,2': NBT.compound({ block: NBT.string(block), state: NBT.compound({}) })
      }), updatedAt)
      NBT.writeIndex(store, { 'minecraft:overworld': { '0,0': updatedAt } })
    }
    write('minecraft:stone', 1000)

    const loader = createSourceLoader({ visionRoot: root })
    const first = await loader.load('terrain', { taskId: 'taskA' })
    assert.equal(first.records[0].block, 'minecraft:stone')
    assert.equal(loader.size(), 1)

    await sleep(20)
    write('minecraft:diamond_ore', 2000)

    assert.notEqual(await loader.version('terrain'), first.version, '文件变了，只 stat 探到的版本跟着变')
    const fresh = await loader.load('terrain', { taskId: 'taskA' })
    assert.notStrictEqual(fresh, first)
    assert.equal(fresh.records[0].block, 'minecraft:diamond_ore')
    assert.equal(await loader.version('terrain'), fresh.version)

    const again = await loader.load('terrain', { taskId: 'taskB' })
    assert.strictEqual(again, fresh, '版本没变：不重复解析，跨任务共用')
    assert.equal(loader.size(), 1)
  } finally {
    NBT.removeDir(root)
  }
})

test('SOURCE_MISSING：目录 / 文件不存在', async () => {
  const root = NBT.makeTempDir()
  try {
    const loader = createSourceLoader({ visionRoot: root })
    await assert.rejects(loader.load('terrain'), (e) => e.code === 'SOURCE_MISSING')
    await assert.rejects(loader.load('entities'), (e) => e.code === 'SOURCE_MISSING')
  } finally {
    NBT.removeDir(root)
  }
})

test('SOURCE_CORRUPT：损坏文件 / 结构不符', async () => {
  const root = NBT.makeTempDir()
  try {
    const store = path.join(root, 'terrain_union')
    fs.mkdirSync(path.join(store, 'minecraft_overworld'), { recursive: true })
    fs.writeFileSync(path.join(store, 'minecraft_overworld', 'r.0.0.nbt'), Buffer.from('not an nbt file'))

    const loader = createSourceLoader({ visionRoot: root })
    await assert.rejects(loader.load('terrain'), (e) => e.code === 'SOURCE_CORRUPT')

    // 合法 NBT，但缺了记录集的 leaf（blocks）
    NBT.removeDir(root)
    fs.mkdirSync(root, { recursive: true })
    NBT.writeNbtFile(path.join(store, 'minecraft_overworld', 'r.0.0.nbt'), NBT.compound({
      dimension: NBT.string('minecraft:overworld'),
      regionX: NBT.int(0),
      regionZ: NBT.int(0),
      updatedAt: NBT.long(1000)
    }))
    const loader2 = createSourceLoader({ visionRoot: root })
    await assert.rejects(loader2.load('terrain'), (e) => e.code === 'SOURCE_CORRUPT')
  } finally {
    NBT.removeDir(root)
  }
})

test('SOURCE_UNSTABLE：区文件 updatedAt 与索引不一致（commit 中间态）', async () => {
  const root = NBT.makeTempDir()
  try {
    const store = path.join(root, 'terrain_union')
    NBT.writeRegion(store, 'minecraft:overworld', 0, 0, 'blocks', NBT.compound({
      '1,64,2': NBT.compound({ block: NBT.string('minecraft:stone'), state: NBT.compound({}) })
    }), 1000)
    NBT.writeIndex(store, { 'minecraft:overworld': { '0,0': 999 } })

    const loader = createSourceLoader({ visionRoot: root })
    await assert.rejects(loader.load('terrain'), (e) => e.code === 'SOURCE_UNSTABLE')
    assert.equal(loader.size(), 0) // 失败不缓存
  } finally {
    NBT.removeDir(root)
  }
})

test('空数据源：目录存在但没有区文件 → 0 条记录且成功', async () => {
  const root = NBT.makeTempDir()
  try {
    fs.mkdirSync(path.join(root, 'terrain_union'), { recursive: true })
    const loader = createSourceLoader({ visionRoot: root })
    const snapshot = await loader.load('terrain')
    assert.equal(snapshot.records.length, 0)
    assert.equal(snapshot.version, 'noidx:0:0')
  } finally {
    NBT.removeDir(root)
  }
})

test('SOURCE_UNSTABLE: index entry without a region file is rejected', async () => {
  const root = NBT.makeTempDir()
  try {
    const store = path.join(root, 'terrain_union')
    fs.mkdirSync(store, { recursive: true })
    NBT.writeIndex(store, { 'minecraft:overworld': { '0,0': 1000 } })

    const loader = createSourceLoader({ visionRoot: root, retries: 0 })
    await assert.rejects(
      loader.load('terrain'),
      (error) => error.code === 'SOURCE_UNSTABLE' && error.message.includes('minecraft:overworld/0,0')
    )
  } finally {
    NBT.removeDir(root)
  }
})
