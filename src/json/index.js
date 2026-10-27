'use strict'

const { QueryError } = require('../nbt/errors')
const { validateParams: validateNbtParams, runQuery, DEFAULT_BYTE_CAP, DEFAULT_TIMEOUT_MS } = require('../nbt/query')
const { createSourceTable } = require('./sources')
const { createJsonLoader, DEFAULT_TASK_ID, DEFAULT_MAX_FILE_BYTES } = require('./loader')

/**
 * JSON 查询 API（docs/json查询api设计方案.md）。照 NBT 查询 API 的形状：
 * 宿主装载（白名单 + 任务级快照）→ 筛选 → 投影 → 截断，只出短列表。
 *
 *   const api = createJsonQueryApi({ sources: { recipes: '/abs/recipes.json' } })
 *   await api.query({
 *     path: 'recipes', records: 'recipes',
 *     filters: { result: 'minecraft:stick' }, fields: ['type', 'pattern', 'key', 'count'], limit: 4
 *   }, { taskId })
 *   // → { result, matchedCount, sourceVersion }
 *
 * 筛选 / 投影 / 截断的语义与 NBT 查询完全相同（复用 src/nbt/query.js）：
 * 字面量条件、区间对象、数组 = 并集、缺失字段 = 不匹配、投影键 = 路径字符串本身。
 */
const ALLOWED = new Set(['path', 'records', 'filters', 'fields', 'limit'])

function createJsonQueryApi(options = {}) {
  const sources = createSourceTable(options.sources ?? {})
  const loader = createJsonLoader({ sources, retries: options.retries, maxFileBytes: options.maxFileBytes })

  /** 静态校验（装载期，零 I/O）：参数形态 + path 语法与标识。返回规范化后的参数。 */
  function validateParams(params) {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      throw new QueryError('LOAD_ERROR', 'params must be an object')
    }
    for (const key of Object.keys(params)) {
      if (!ALLOWED.has(key)) throw new QueryError('LOAD_ERROR', `unknown param "${key}"`)
    }
    const records = params.records ?? ''
    if (typeof records !== 'string') throw new QueryError('LOAD_ERROR', 'records must be a string path (e.g. "recipes")')
    const { records: _r, ...rest } = params
    const normalized = validateNbtParams(rest)
    sources.parse(normalized.path)
    return { ...normalized, records }
  }

  async function query(params, callOptions = {}) {
    const normalized = validateParams(params)
    const snapshot = await loader.load(normalized.path, { taskId: callOptions.taskId })
    const list = pickRecords(snapshot.doc, normalized.records)
    const { result, matchedCount } = runQuery(list, normalized, {
      byteCap: options.byteCap,
      timeoutMs: options.timeoutMs,
      clock: callOptions.clock
    })
    return { result, matchedCount, sourceVersion: snapshot.version }
  }

  /**
   * 整个文档（data_shapes 统计结构与词表用，不进黑板、不给大模型看值）。同一套白名单与版本缓存。
   * @param {string} path  数据源标识（同 query 的 path）
   */
  async function loadDocument(path, callOptions = {}) {
    if (typeof path !== 'string' || path === '') throw new QueryError('LOAD_ERROR', 'path must be a non-empty string')
    sources.parse(path)
    const snapshot = await loader.load(path, { taskId: callOptions.taskId })
    return { doc: snapshot.doc, sourceVersion: snapshot.version }
  }

  return {
    query,
    loadDocument,
    validateParams,
    sourceIds: () => sources.ids,
    /** 当前版本戳（只 stat，不读内容） */
    version: (path) => loader.version(path),
    releaseTask: (taskId = DEFAULT_TASK_ID) => loader.releaseTask(taskId),
    clearCache: () => loader.clear(),
    cacheSize: () => loader.size()
  }
}

/** records 路径（对象键点分）→ 记录数组。不是数组时报错，并列出顶层哪些键是数组。 */
function pickRecords(doc, recordsPath) {
  let current = doc
  if (recordsPath !== '') {
    for (const segment of recordsPath.split('.')) {
      if (current === null || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, segment)) {
        current = undefined
        break
      }
      current = current[segment]
    }
  }
  if (Array.isArray(current)) return current
  const hint = doc !== null && typeof doc === 'object' && !Array.isArray(doc)
    ? Object.keys(doc).filter((k) => Array.isArray(doc[k]))
    : []
  throw new QueryError(
    'LOAD_ERROR',
    `records ${JSON.stringify(recordsPath)} is not an array in this file` +
      (hint.length ? `; top-level arrays: ${hint.join(', ')}` : '')
  )
}

module.exports = {
  createJsonQueryApi,
  pickRecords,
  QueryError,
  DEFAULT_TASK_ID,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_BYTE_CAP,
  DEFAULT_TIMEOUT_MS
}
