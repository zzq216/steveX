'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const { parseNbt, NbtReadError } = require('./nbt_reader')
const { QueryError } = require('./errors')
const { getSourceDef } = require('./sources')

/**
 * 宿主装载器（docs/nbt查询api设计方案.md §5.1，2026-10-17 定：静态校验 + 懒装载）。
 *
 * 职责：
 *   - 懒装载：首次查询前读盘，树装载不动 I/O；
 *   - 缓存按 `(path, 版本戳)`（P2 实施细则 §6.3，2026-10-25 改）：每次查询先只取版本戳（stat），
 *     没变就用已解析的结果、变了就重新装载——同一任务里先后两次查询可以看到不同版本，
 *     这是树里"复查"能发现记忆变化的前提；一致性只在一次装载之内。
 *     原来按 `(taskId, path)` 钉住整个任务，复查永远读到旧数据，已废弃；`releaseTask` 保留为空操作；
 *   - 版本戳：单文件源 = mtime + 尺寸；分片源 = `_index.nbt` 的 mtime + 尺寸
 *     （containers 另并 `ender.nbt`）；无索引时退化为 `noidx:<max updatedAt>:<区文件数>`；
 *   - 读一致性：读前读后各取一次版本，不一致重读一次，仍不一致 = SOURCE_UNSTABLE；
 *     分片源另核对"区文件自报 updatedAt == 索引条目"，防 commit 的中间态
 *     （区文件先写、索引后写完，见 VisionRegions.commit）。
 */

const DEFAULT_TASK_ID = '__default__'
const INDEX_FILE = '_index.nbt'
const REGION_FILE = /^r\.(-?\d+)\.(-?\d+)\.nbt$/

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

function corrupt(message) {
  return new QueryError('SOURCE_CORRUPT', `unexpected NBT structure: ${message}`)
}

function dimDirName(dimensionId) {
  return dimensionId.replaceAll(':', '_')
}

async function statOrNull(file) {
  try {
    return await fs.stat(file)
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
    throw e
  }
}

function sameStat(a, b) {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

function versionOf(stat) {
  return `${stat.mtimeMs}:${stat.size}`
}

/** 读文件 + 解析；parse 失败统一映射成 SOURCE_CORRUPT（§7）。 */
async function readParsed(file) {
  let buffer
  try {
    buffer = await fs.readFile(file)
  } catch (e) {
    throw new QueryError('SOURCE_MISSING', `source file not readable: ${file}`, { cause: e })
  }
  try {
    return parseNbt(buffer)
  } catch (e) {
    if (e instanceof NbtReadError) {
      throw new QueryError('SOURCE_CORRUPT', `failed to parse ${file}: ${e.message}`, { cause: e })
    }
    throw e
  }
}

/** 索引（维 → 区键 → updatedAt）。索引是派生数据，只在存在时用来交叉核对。 */
function extractIndex(value) {
  if (!isPlainObject(value)) throw corrupt('index root')
  const dims = value.dimensions
  if (!isPlainObject(dims)) throw corrupt('index.dimensions')
  const index = new Map()
  for (const dim of Object.keys(dims)) {
    const regions = dims[dim]
    if (!isPlainObject(regions)) throw corrupt(`index.dimensions["${dim}"]`)
    const perDim = new Map()
    for (const key of Object.keys(regions)) {
      const updatedAt = regions[key]
      if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
        throw corrupt(`index.dimensions["${dim}"]["${key}"] is not a number`)
      }
      perDim.set(key, updatedAt)
    }
    index.set(dim, perDim)
  }
  return index
}

async function loadSingle(def, visionRoot) {
  const file = path.join(visionRoot, def.file)
  const before = await statOrNull(file)
  if (!before || !before.isFile()) {
    throw new QueryError('SOURCE_MISSING', `source file missing: ${file}`)
  }
  const parsed = await readParsed(file)
  const after = await statOrNull(file)
  if (!sameStat(before, after)) {
    throw new QueryError('SOURCE_UNSTABLE', `source changed while reading: ${file}`)
  }
  return { records: def.extract(parsed.value), version: versionOf(before) }
}

async function loadSharded(def, visionRoot) {
  const storeDir = path.join(visionRoot, def.dir)
  const storeStat = await statOrNull(storeDir)
  if (!storeStat || !storeStat.isDirectory()) {
    throw new QueryError('SOURCE_MISSING', `source directory missing: ${storeDir}`)
  }

  const indexPath = path.join(storeDir, INDEX_FILE)
  const indexStatBefore = await statOrNull(indexPath)
  const enderPath = def.enderFile ? path.join(storeDir, def.enderFile) : null
  const enderStatBefore = enderPath ? await statOrNull(enderPath) : null

  // 索引只是交叉核对的门控；缺失时按区文件自报的 updatedAt 退化出版本戳
  let index = null
  let unseenIndexEntries = null
  if (indexStatBefore && indexStatBefore.isFile()) {
    index = extractIndex((await readParsed(indexPath)).value)
    unseenIndexEntries = new Set()
    for (const [dim, regions] of index) {
      for (const regionKey of regions.keys()) unseenIndexEntries.add(`${dim}\u0000${regionKey}`)
    }
  }

  const dirents = await fs.readdir(storeDir, { withFileTypes: true })
  const dimDirNames = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()

  const records = []
  let maxUpdatedAt = 0
  let regionCount = 0

  for (const dirName of dimDirNames) {
    const dimDir = path.join(storeDir, dirName)
    const names = (await fs.readdir(dimDir)).filter((name) => REGION_FILE.test(name)).sort()
    for (const name of names) {
      const match = REGION_FILE.exec(name)
      const file = path.join(dimDir, name)
      const root = (await readParsed(file)).value
      if (!isPlainObject(root)) throw corrupt(`region ${file}: root is not a compound`)

      const dim = root.dimension
      if (typeof dim !== 'string' || dim === '') throw corrupt(`region ${file}: missing dimension`)
      if (dimDirName(dim) !== dirName) {
        throw corrupt(`region ${file}: declares dimension "${dim}" but sits under "${dirName}"`)
      }
      const regionX = Number(match[1])
      const regionZ = Number(match[2])
      if (root.regionX !== regionX || root.regionZ !== regionZ) {
        throw corrupt(`region ${file}: regionX/regionZ do not match the file name`)
      }
      const updatedAt = root.updatedAt
      if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
        throw corrupt(`region ${file}: missing updatedAt`)
      }

      if (index) {
        const perDim = index.get(dim)
        const regionKey = `${regionX},${regionZ}`
        const indexed = perDim ? perDim.get(regionKey) : undefined
        if (indexed !== updatedAt) {
          throw new QueryError(
            'SOURCE_UNSTABLE',
            `region ${file}: updatedAt ${updatedAt} does not match index entry ${indexed}`
          )
        }
        unseenIndexEntries.delete(`${dim}\u0000${regionKey}`)
      }

      maxUpdatedAt = Math.max(maxUpdatedAt, updatedAt)
      const regionRecords = def.extractRegion(root, dim)
      for (const record of regionRecords) records.push(record)
      regionCount++
    }
  }

  // containers 的末影箱：跨维全局、无坐标（§4.1）
  if (unseenIndexEntries && unseenIndexEntries.size > 0) {
    const missing = [...unseenIndexEntries][0].replace('\u0000', '/')
    throw new QueryError('SOURCE_UNSTABLE', `index references missing region ${missing}`)
  }

  if (def.enderFile && enderStatBefore && enderStatBefore.isFile()) {
    const enderRoot = (await readParsed(enderPath)).value
    const enderRecords = def.extractEnder(enderRoot)
    for (const record of enderRecords) records.push(record)
  }

  const indexStatAfter = await statOrNull(indexPath)
  const enderStatAfter = enderPath ? await statOrNull(enderPath) : null
  if (!sameStat(indexStatBefore, indexStatAfter) || !sameStat(enderStatBefore, enderStatAfter)) {
    throw new QueryError('SOURCE_UNSTABLE', `source changed while reading: ${storeDir}`)
  }

  const version = indexStatBefore && indexStatBefore.isFile()
    ? `${versionOf(indexStatBefore)}${enderStatBefore ? `|ender:${versionOf(enderStatBefore)}` : ''}`
    : `noidx:${maxUpdatedAt}:${regionCount}`

  return { records, version }
}

/**
 * 只取版本戳、不读内容（与装载时算出的版本同一套规则）。
 * 取不到（文件缺失、分片源没有索引）→ null：调用方按"未知"处理，装载时照常重读。
 */
async function probeVersion(def, visionRoot) {
  if (def.kind === 'single') {
    const stat = await statOrNull(path.join(visionRoot, def.file))
    return stat && stat.isFile() ? versionOf(stat) : null
  }
  const storeDir = path.join(visionRoot, def.dir)
  const indexStat = await statOrNull(path.join(storeDir, INDEX_FILE))
  if (!indexStat || !indexStat.isFile()) return null
  const enderStat = def.enderFile ? await statOrNull(path.join(storeDir, def.enderFile)) : null
  return `${versionOf(indexStat)}${enderStat ? `|ender:${versionOf(enderStat)}` : ''}`
}

async function withRetry(fn, retries) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof QueryError && e.code === 'SOURCE_UNSTABLE' && attempt < retries) {
        lastError = e
        continue
      }
      throw e
    }
  }
  throw lastError
}

/**
 * 创建宿主装载器。
 *
 * @param {object} options
 * @param {string} options.visionRoot 采集端落盘根目录（含 entities_union.nbt 与四个分片目录）
 * @param {number} [options.retries]  SOURCE_UNSTABLE 的重读次数（默认 1）
 */
function createSourceLoader({ visionRoot, retries = 1 } = {}) {
  if (!visionRoot) throw new Error('createSourceLoader: visionRoot is required')

  /** path → 最近一次装载的 snapshot（只留最新版本：旧版本没人引用后随 GC 回收） */
  const cache = new Map()
  /** 在途装载（key = path + 探到的版本），合并并发请求 */
  const pending = new Map()
  /** clear() 之后，旧的在途装载不得回填缓存 */
  let generation = 0

  /**
   * @param {string} sourcePath
   * @param {object} [options]  { taskId }：保留参数（调用方照旧传），不再影响缓存
   */
  async function load(sourcePath) {
    const def = getSourceDef(sourcePath)
    const probed = await probeVersion(def, visionRoot)
    const cached = cache.get(sourcePath)
    if (cached && probed !== null && cached.version === probed) return cached

    const gen = generation
    const pendingKey = `${sourcePath}\u0000${probed}\u0000${gen}`
    let promise = pending.get(pendingKey)
    if (!promise) {
      promise = withRetry(
        () => (def.kind === 'single' ? loadSingle(def, visionRoot) : loadSharded(def, visionRoot)),
        retries
      )
        .then((snapshot) => {
          if (generation === gen) cache.set(sourcePath, snapshot)
          return snapshot
        })
        .finally(() => {
          pending.delete(pendingKey)
        })
      pending.set(pendingKey, promise)
    }
    return promise
  }

  /** 当前版本戳（只 stat）；取不到 → null。修复请求的目录用它判断"记忆来源已换代"（P2-D17）。 */
  async function version(sourcePath) {
    return probeVersion(getSourceDef(sourcePath), visionRoot)
  }

  /** 兼容旧接口：缓存不再按任务钉住，任务结束不用释放 */
  function releaseTask() {}

  function clear() {
    generation += 1
    cache.clear()
    pending.clear()
  }

  return { load, version, releaseTask, clear, size: () => cache.size }
}

module.exports = {
  DEFAULT_TASK_ID,
  createSourceLoader,
  // 供测试/诊断
  extractIndex,
  loadSingle,
  loadSharded,
  probeVersion
}
