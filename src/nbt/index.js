'use strict'

const path = require('node:path')

const { QueryError } = require('./errors')
const { parseNbt, TAG, NbtReadError } = require('./nbt_reader')
const { SOURCE_PATHS, getSourceDef, parseCoordKey } = require('./sources')
const {
  validateParams,
  runQuery,
  resolvePath,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_BYTE_CAP,
  DEFAULT_TIMEOUT_MS
} = require('./query')
const { createSourceLoader, DEFAULT_TASK_ID } = require('./loader')

/**
 * NBT 查询 API（docs/nbt查询api设计方案.md）。
 *
 * 定位：胶囊 `core.nbt.query` 的实现。宿主侧装载器（loader.js）+ 沙箱 body（query.js）。
 * 用法：
 *
 *   const api = createNbtQueryApi({ visionRoot })          // visionRoot = stevex/vision 根目录（v2.55 起经 current.json 定位到 worlds/<worldKey>/）
 *   const out = await api.query({
 *     path: 'entities',
 *     filters: { type: 'minecraft:item', 'item.id': 'minecraft:diamond', 'pos.x': { min: -64, max: 64 } },
 *     fields: ['uuid', 'pos', 'item.count'],
 *     limit: 32
 *   }, { taskId: 'task-1' })
 *   // → { result, matchedCount, sourceVersion }
 *
 * 行为树运行时就绪后：`query()` 的返回值映射到 §3.2 的三个输出。
 * 快照语义（P2 实施细则 §6.3）：每次查询读当前版本（版本没变就复用已解析的结果），不按任务钉住。
 */

const DEFAULT_VISION_ROOT = path.resolve(__dirname, '../../run/stevex/vision')

/**
 * @param {object} [options]
 * @param {string} [options.visionRoot] 采集端落盘根目录
 * @param {number} [options.retries]    SOURCE_UNSTABLE 的重读次数（默认 1）
 * @param {number} [options.byteCap]    结果字节上限（§4.5；缺省占位值待实测）
 * @param {number} [options.timeoutMs]  硬超时（§3.4；缺省占位值待实测）
 */
function createNbtQueryApi(options = {}) {
  const visionRoot = options.visionRoot || DEFAULT_VISION_ROOT
  const loader = createSourceLoader({ visionRoot, retries: options.retries })

  /**
   * 执行一次查询。
   *
   * @param {object} params { path, filters?, fields, limit? }——四个参数必须是字面量（§3.1）
   * @param {object} [callOptions] { taskId, clock }（clock 仅测试注入）
   * @returns {Promise<{ result: Array, matchedCount: number, sourceVersion: string, world: object|null }>}
   *   world（v2.55）：数据来自哪个世界 { key, label, inWorld }；采集端还没写 current.json → null
   */
  async function query(params, callOptions = {}) {
    const normalized = validateParams(params)
    if (!SOURCE_PATHS.includes(normalized.path)) {
      throw new QueryError(
        'LOAD_ERROR',
        `path must be one of ${SOURCE_PATHS.join(' / ')} (got ${JSON.stringify(normalized.path)})`
      )
    }

    const snapshot = await loader.load(normalized.path, { taskId: callOptions.taskId })
    const { result, matchedCount } = runQuery(snapshot.records, normalized, {
      byteCap: options.byteCap,
      timeoutMs: options.timeoutMs,
      clock: callOptions.clock
    })

    return { result, matchedCount, sourceVersion: snapshot.version, world: snapshot.world ?? null }
  }

  /** 某个数据源的全部记录（data_shapes 统计结构与词表用）。同一套数据源白名单与任务级快照。 */
  async function loadRecords(path, callOptions = {}) {
    if (!SOURCE_PATHS.includes(path)) {
      throw new QueryError('LOAD_ERROR', `path must be one of ${SOURCE_PATHS.join(' / ')} (got ${JSON.stringify(path)})`)
    }
    const snapshot = await loader.load(path, { taskId: callOptions.taskId })
    return { records: snapshot.records, sourceVersion: snapshot.version, world: snapshot.world ?? null }
  }

  return {
    query,
    loadRecords,
    /** 当前版本戳（只 stat，不装载）；取不到 → null */
    version: (path) => {
      if (!SOURCE_PATHS.includes(path)) throw new QueryError('LOAD_ERROR', `path must be one of ${SOURCE_PATHS.join(' / ')}`)
      return loader.version(path)
    },
    /** 当前世界 { key, label, inWorld }；没有 current.json → null（v2.55） */
    world: () => loader.world(),
    releaseTask: (taskId = DEFAULT_TASK_ID) => loader.releaseTask(taskId),
    clearCache: () => loader.clear(),
    cacheSize: () => loader.size(),
    visionRoot
  }
}

module.exports = {
  createNbtQueryApi,
  // 供测试与后续树运行时复用
  QueryError,
  parseNbt,
  TAG,
  NbtReadError,
  SOURCE_PATHS,
  getSourceDef,
  parseCoordKey,
  validateParams,
  runQuery,
  resolvePath,
  DEFAULT_TASK_ID,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_BYTE_CAP,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VISION_ROOT
}
