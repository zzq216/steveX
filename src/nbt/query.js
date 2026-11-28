'use strict'

const { QueryError } = require('./errors')

/**
 * 查询 body：筛选 → 投影 → 截断（docs/nbt查询api设计方案.md §5.2）。
 *
 * **纯函数**：只操作宿主传入的记录数组，零 I/O、无时钟副作用（时钟只为预算检查注入）。
 * 这一层就是未来沙箱里跑的 `core.nbt.query` 的 body；宿主装载器在 loader.js。
 */

const DEFAULT_LIMIT = 64
/** 2026-11-28 从 512 调到 4096：真正的约束是下面的字节预算（和黑板单值上限同为 256 KB）。 */
const MAX_LIMIT = 4096
/** 字节上限占位值；实测后回填（§4.5 / §10 审阅点 7）。 */
const DEFAULT_BYTE_CAP = 256 * 1024
/** 硬超时占位值；实测后回填（§3.4 / §4.5 / §10 审阅点 7）。 */
const DEFAULT_TIMEOUT_MS = 5000
/** 坐标糖：pos.x / pos.y / pos.z = 第 0/1/2 个元素（§4.2）。 */
const AXIS_INDEX = Object.freeze({ x: 0, y: 1, z: 2 })

const ALLOWED_PARAMS = new Set(['path', 'filters', 'fields', 'limit'])
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v)

function loadError(message) {
  return new QueryError('LOAD_ERROR', message)
}

/** 区间对象：只允许 min / max，至少一个，闭区间，min <= max。 */
function validateRange(value, where) {
  for (const key of Object.keys(value)) {
    if (key !== 'min' && key !== 'max') {
      throw loadError(`${where}: unknown range key "${key}" (only min / max)`)
    }
  }
  const hasMin = hasOwn(value, 'min')
  const hasMax = hasOwn(value, 'max')
  if (!hasMin && !hasMax) throw loadError(`${where}: range needs min or max`)
  if (hasMin && !isFiniteNumber(value.min)) throw loadError(`${where}: min must be a finite number`)
  if (hasMax && !isFiniteNumber(value.max)) throw loadError(`${where}: max must be a finite number`)
  if (hasMin && hasMax && value.min > value.max) throw loadError(`${where}: min > max`)
}

/**
 * 条件形态（§4.3）：number / string / boolean 单值；区间对象；数组 = 并集
 * （string 枚举，或 number/区间混合并集）。boolean 不搞并集。
 */
function validateCondition(value, where) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw loadError(`${where}: number condition must be finite`)
    return
  }
  if (typeof value === 'string' || typeof value === 'boolean') return
  if (Array.isArray(value)) {
    if (value.length === 0) throw loadError(`${where}: empty union array`)
    let sawString = false
    let sawNumber = false
    for (const item of value) {
      if (typeof item === 'string') {
        if (sawNumber) throw loadError(`${where}: union array mixes strings and numbers/ranges`)
        sawString = true
      } else if (typeof item === 'number') {
        if (sawString) throw loadError(`${where}: union array mixes strings and numbers/ranges`)
        if (!Number.isFinite(item)) throw loadError(`${where}: number condition must be finite`)
        sawNumber = true
      } else if (isPlainObject(item)) {
        if (sawString) throw loadError(`${where}: union array mixes strings and ranges`)
        validateRange(item, where)
        sawNumber = true
      } else {
        throw loadError(`${where}: union array element must be a string / number / range`)
      }
    }
    return
  }
  if (isPlainObject(value)) {
    validateRange(value, where)
    return
  }
  throw loadError(`${where}: unsupported condition value`)
}

/**
 * 参数校验（§3.1）：四个参数全部是字面量；`filters` / `fields` / `limit` 形态在这里判定。
 * `path` 只校验是字符串，白名单由 index.js 判（静态可判，§6.1）。
 *
 * @returns {{ path: string, filters: Array<[string, any]>, fields: string[], limit: number }}
 */
function validateParams(params) {
  if (!isPlainObject(params)) throw loadError('params must be an object')
  for (const key of Object.keys(params)) {
    if (!ALLOWED_PARAMS.has(key)) throw loadError(`unknown param "${key}"`)
  }
  if (typeof params.path !== 'string') throw loadError('path is required (string literal)')

  const filters = params.filters === undefined ? {} : params.filters
  if (!isPlainObject(filters)) throw loadError('filters must be an object')
  const filterEntries = []
  for (const path of Object.keys(filters)) {
    if (!path) throw loadError('filters: empty path')
    validateCondition(filters[path], `filters["${path}"]`)
    filterEntries.push([path, filters[path]])
  }

  const fields = params.fields
  if (!Array.isArray(fields) || fields.length === 0) {
    throw loadError('fields must be a non-empty string[] (no default — §3.1)')
  }
  for (const field of fields) {
    if (typeof field !== 'string' || field === '') throw loadError('fields entries must be non-empty strings')
  }

  const limit = params.limit === undefined ? DEFAULT_LIMIT : params.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw loadError(`limit must be an integer in 1..${MAX_LIMIT}`)
  }

  return { path: params.path, filters: filterEntries, fields, limit }
}

/**
 * 解析记录内路径（§4.2）：嵌套对象按点号下钻；坐标数组允许 .x/.y/.z。
 * 缺失 / 类型不对 → undefined（filter 语义：不匹配，不报错）。
 */
function resolvePath(record, path) {
  let current = record
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    if (Array.isArray(current)) {
      const index = AXIS_INDEX[segment]
      if (index === undefined || index >= current.length) return undefined
      current = current[index]
      continue
    }
    if (!hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

function matchesCondition(value, condition) {
  if (typeof condition === 'number') return typeof value === 'number' && value === condition
  if (typeof condition === 'string') return typeof value === 'string' && value === condition
  if (typeof condition === 'boolean') return typeof value === 'boolean' && value === condition
  if (Array.isArray(condition)) {
    for (const item of condition) {
      if (matchesCondition(value, item)) return true
    }
    return false
  }
  if (isPlainObject(condition)) {
    if (typeof value !== 'number') return false
    if (hasOwn(condition, 'min') && value < condition.min) return false
    if (hasOwn(condition, 'max') && value > condition.max) return false
    return true
  }
  return false
}

function matchesAll(record, filterEntries) {
  for (const [path, condition] of filterEntries) {
    const value = resolvePath(record, path)
    if (value === undefined || !matchesCondition(value, condition)) return false
  }
  return true
}

/** 投影（§4.4）：键 = fields 里的路径字符串本身；缺失字段 → 该键缺席。 */
function project(record, fields) {
  const projected = {}
  for (const field of fields) {
    const value = resolvePath(record, field)
    if (value === undefined) continue
    if (field === '__proto__') {
      Object.defineProperty(projected, field, { value, enumerable: true, writable: true, configurable: true })
    } else {
      projected[field] = value
    }
  }
  return projected
}

/**
 * 执行查询（§4.5）：全量扫描（matchedCount 必须精确，所以 limit 不能提前退出）、
 * 命中后投影、`limit` 与字节上限双重截断。
 *
 * @param {Array} records 宿主装载的整份记录集
 * @param {{ filters: Array<[string, any]>, fields: string[], limit: number }} query validateParams 的产物
 * @param {object} [options] { byteCap, timeoutMs, clock }
 * @returns {{ result: Array<object>, matchedCount: number }}
 */
function runQuery(records, query, options = {}) {
  const byteCap = options.byteCap ?? DEFAULT_BYTE_CAP
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const clock = options.clock ?? Date.now
  const deadline = timeoutMs > 0 ? clock() + timeoutMs : Infinity

  const result = []
  let matchedCount = 0
  let bytes = 2 // 结果数组的 '[' + ']'
  let full = false

  for (let i = 0; i < records.length; i++) {
    if ((i & 4095) === 0 && clock() > deadline) {
      throw new QueryError('TIMEOUT', `query exceeded ${timeoutMs}ms`)
    }

    const record = records[i]
    if (!matchesAll(record, query.filters)) continue
    matchedCount++

    if (full || result.length >= query.limit) {
      full = true
      continue
    }

    const projected = project(record, query.fields)
    // +1 = 数组元素之间的逗号（最后一条多算 1 字节，可忽略）
    const size = Buffer.byteLength(JSON.stringify(projected), 'utf8') + 1
    if (bytes + size > byteCap) {
      // 字节上限先到：按前缀截断；matchedCount 仍如实统计到末尾
      full = true
      continue
    }
    bytes += size
    result.push(projected)
  }

  return { result, matchedCount }
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_BYTE_CAP,
  DEFAULT_TIMEOUT_MS,
  validateCondition,
  validateParams,
  resolvePath,
  matchesCondition,
  project,
  runQuery
}
