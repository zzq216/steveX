'use strict'

const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const NBT = require('./helpers')
const { createNbtQueryApi } = require('../../src/nbt')

function writeTerrain(root) {
  const store = path.join(root, 'terrain_union')
  NBT.writeRegion(store, 'minecraft:overworld', 0, 0, 'blocks', NBT.compound({
    '1,64,2': NBT.compound({ block: NBT.string('minecraft:stone'), state: NBT.compound({}) }),
    '2,64,3': NBT.compound({ block: NBT.string('minecraft:stone'), state: NBT.compound({}) }),
    '3,10,4': NBT.compound({
      block: NBT.string('minecraft:diamond_ore'),
      state: NBT.compound({ waterlogged: NBT.string('false') })
    })
  }), 1000)
  NBT.writeIndex(store, { 'minecraft:overworld': { '0,0': 1000 } })
}

test('端到端：查询 → 投影 → 截断（§3.3 的形状）', async () => {
  const root = NBT.makeTempDir()
  try {
    writeTerrain(root)
    const api = createNbtQueryApi({ visionRoot: root })

    const out = await api.query({
      path: 'terrain',
      filters: { block: 'minecraft:stone' },
      fields: ['pos', 'block'],
      limit: 1
    }, { taskId: 'task-1' })

    assert.equal(out.result.length, 1)
    assert.deepEqual(out.result[0], { pos: [1, 64, 2], block: 'minecraft:stone' })
    assert.equal(out.matchedCount, 2)
    assert.equal(typeof out.sourceVersion, 'string')
    assert.equal(api.cacheSize(), 1)

    assert.equal(await api.version('terrain'), out.sourceVersion, '只 stat 探到的版本与装载时一致')
    api.releaseTask('task-1') // 兼容旧接口：缓存按版本，不再按任务钉住（P2 §6.3）
    assert.equal(api.cacheSize(), 1)
  } finally {
    NBT.removeDir(root)
  }
})

test('path 白名单：只收五个数据源标识，拒绝文件路径', async () => {
  const root = NBT.makeTempDir()
  try {
    writeTerrain(root)
    const api = createNbtQueryApi({ visionRoot: root })

    for (const badPath of ['vision/terrain_union', '../entities_union.nbt', 'terrain_union/r.0.0.nbt', 42]) {
      await assert.rejects(
        api.query({ path: badPath, fields: ['pos'] }),
        (e) => e.code === 'LOAD_ERROR',
        String(badPath)
      )
    }
  } finally {
    NBT.removeDir(root)
  }
})

test('参数校验失败 → LOAD_ERROR，不触 I/O', async () => {
  const root = NBT.makeTempDir()
  try {
    const api = createNbtQueryApi({ visionRoot: root })
    const bad = [
      { filters: {} },                                    // 缺 path
      { path: 'terrain' },                                // 缺 fields
      { path: 'terrain', fields: [] },
      { path: 'terrain', fields: ['pos'], limit: 0 },
      { path: 'terrain', fields: ['pos'], filters: { 'pos.y': { min: 1, max: 0 } } },
      { path: 'terrain', fields: ['pos'], unknown: true }
    ]
    for (const params of bad) {
      await assert.rejects(api.query(params), (e) => e.code === 'LOAD_ERROR', JSON.stringify(params))
    }
  } finally {
    NBT.removeDir(root)
  }
})

test('数据源缺失 → SOURCE_MISSING', async () => {
  const root = NBT.makeTempDir()
  try {
    const api = createNbtQueryApi({ visionRoot: root })
    await assert.rejects(
      api.query({ path: 'biomes', fields: ['biome'] }),
      (e) => e.code === 'SOURCE_MISSING'
    )
  } finally {
    NBT.removeDir(root)
  }
})

test('byteCap / timeoutMs 由 API 透传（§4.5）', async () => {
  const root = NBT.makeTempDir()
  try {
    writeTerrain(root)

    const tiny = createNbtQueryApi({ visionRoot: root, byteCap: 1 })
    const out = await tiny.query({ path: 'terrain', fields: ['block'] }, { taskId: 'a' })
    assert.equal(out.result.length, 0)
    assert.equal(out.matchedCount, 3)

    let calls = 0
    const clock = () => (calls++ === 0 ? 0 : 1000)
    const timed = createNbtQueryApi({ visionRoot: root, timeoutMs: 1 })
    await assert.rejects(
      timed.query({ path: 'terrain', fields: ['block'] }, { taskId: 'b', clock }),
      (e) => e.code === 'TIMEOUT'
    )
  } finally {
    NBT.removeDir(root)
  }
})
