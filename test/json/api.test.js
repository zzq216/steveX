'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const { createJsonQueryApi } = require('../../src/json')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stevex-json-'))
}

const RECIPES = {
  source: 'test',
  recipes: [
    { name: 'stick', result: 'minecraft:stick', count: 4, type: 'shaped', pattern: ['#', '#'], key: { '#': ['minecraft:oak_planks'] } },
    { name: 'oak_planks', result: 'minecraft:oak_planks', count: 4, type: 'shapeless', ingredients: [['minecraft:oak_log']] },
    { name: 'crafting_table', result: 'minecraft:crafting_table', count: 1, type: 'shaped', pattern: ['##', '##'], key: { '#': ['minecraft:oak_planks'] } }
  ]
}

function setup() {
  const root = tempDir()
  const file = path.join(root, 'recipes.json')
  fs.writeFileSync(file, JSON.stringify(RECIPES))
  const dir = path.join(root, 'data')
  fs.mkdirSync(path.join(dir, 'tags'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'tags', 'planks.json'), JSON.stringify(['minecraft:oak_planks', 'minecraft:birch_planks']))
  fs.writeFileSync(path.join(root, 'secret.json'), JSON.stringify([{ key: 'sk-123' }]))
  const api = createJsonQueryApi({ sources: { recipes: file, data: dir } })
  return { root, file, dir, api }
}

test('端到端：按产物查配方，投影、截断、matchedCount 如实', async () => {
  const { api } = setup()
  const out = await api.query({
    path: 'recipes', records: 'recipes',
    filters: { result: 'minecraft:stick' },
    fields: ['type', 'pattern', 'key', 'count']
  }, { taskId: 't1' })
  assert.deepEqual(out.result, [{ type: 'shaped', pattern: ['#', '#'], key: { '#': ['minecraft:oak_planks'] }, count: 4 }])
  assert.equal(out.matchedCount, 1)
  assert.match(out.sourceVersion, /^\d+(\.\d+)?:\d+$/)

  const shaped = await api.query({ path: 'recipes', records: 'recipes', filters: { type: 'shaped' }, fields: ['name'], limit: 1 }, { taskId: 't1' })
  assert.deepEqual(shaped.result, [{ name: 'stick' }])
  assert.equal(shaped.matchedCount, 2)
})

test('目录源：<标识>/<相对路径>；根就是数组时 records 省略', async () => {
  const { api } = setup()
  const out = await api.query({ path: 'data/tags/planks.json', fields: ['.'] }, {})
  // 字符串数组的元素不是对象：筛选与投影都按"字段缺失"处理
  assert.equal(out.matchedCount, 2)
  assert.deepEqual(out.result, [{}, {}])
})

test('按版本缓存：文件被改后同一任务里下一次查询就读到新内容（P2 §6.3）', async () => {
  const { api, file } = setup()
  const q = { path: 'recipes', records: 'recipes', fields: ['name'], limit: 512 }
  assert.equal((await api.query(q, { taskId: 'a' })).matchedCount, 3)
  fs.writeFileSync(file, JSON.stringify({ recipes: [] }))
  assert.equal((await api.query(q, { taskId: 'a' })).matchedCount, 0)
})

test('白名单：文件路径、..、未知标识、目录源少了文件名、符号链接逃逸都被拒', async () => {
  const { api, root, dir } = setup()
  const fields = ['key']
  for (const bad of ['../secret.json', '/etc/passwd', 'C:/x.json', 'recipes\\x', 'nope', 'data/../secret.json', 'data/tags/planks.txt']) {
    await assert.rejects(api.query({ path: bad, fields }), (e) => e.code === 'LOAD_ERROR', bad)
  }
  await assert.rejects(api.query({ path: 'data', fields }), /is a directory/)
  await assert.rejects(api.query({ path: 'recipes/x.json', fields }), /is a file/)

  let linked = false
  try {
    fs.symlinkSync(path.join(root, 'secret.json'), path.join(dir, 'link.json'))
    linked = true
  } catch {}
  if (linked) await assert.rejects(api.query({ path: 'data/link.json', fields }), /escapes its source directory/)
})

test('静态校验不碰磁盘：参数形态错误是 LOAD_ERROR；records 不是数组时提示顶层数组键', async () => {
  const { api } = setup()
  assert.throws(() => api.validateParams({ path: 'recipes', fields: [] }), /fields must be a non-empty/)
  assert.throws(() => api.validateParams({ path: 'recipes', fields: ['a'], limit: 0 }), /limit/)
  assert.throws(() => api.validateParams({ path: 'recipes', fields: ['a'], colour: 1 }), /unknown param "colour"/)
  assert.throws(() => api.validateParams({ path: 'recipes', fields: ['a'], filters: { count: [1, 'x'] } }), /mixes/)
  await assert.rejects(api.query({ path: 'recipes', fields: ['a'] }), /top-level arrays: recipes/)
})

test('文件缺失 / 损坏：SOURCE_MISSING / SOURCE_CORRUPT，与"没有结果"可区分', async () => {
  const { api, file } = setup()
  fs.writeFileSync(file, '{ not json')
  await assert.rejects(api.query({ path: 'recipes', records: 'recipes', fields: ['a'] }), (e) => e.code === 'SOURCE_CORRUPT')
  fs.rmSync(file)
  await assert.rejects(api.query({ path: 'recipes', records: 'recipes', fields: ['a'] }, { taskId: 'x' }), (e) => e.code === 'SOURCE_MISSING')
})

test('loadDocument（data_shapes 用）：整份文档，同一套白名单——白名单外的文件读不到', async () => {
  const { api, root } = setup()
  const { doc, sourceVersion } = await api.loadDocument('recipes')
  assert.deepEqual(doc, RECIPES)
  assert.equal(typeof sourceVersion, 'string')
  assert.deepEqual(await api.loadDocument('data/tags/planks.json').then((r) => r.doc), ['minecraft:oak_planks', 'minecraft:birch_planks'])
  for (const bad of ['../secret.json', path.join(root, 'secret.json'), 'secret', '']) {
    await assert.rejects(() => api.loadDocument(bad), (error) => error.code === 'LOAD_ERROR', bad)
  }
})
