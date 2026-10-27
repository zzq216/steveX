'use strict'

const fs = require('node:fs/promises')

const { QueryError } = require('../nbt/errors')

/**
 * 宿主装载器（docs/json查询api设计方案.md §5.1）：懒装载 + 按版本缓存 + 读一致性。
 *
 * - 首次查询前才读盘；树装载不动 I/O
 * - 缓存按 `(path, 版本戳)`（P2 实施细则 §6.3，2026-10-25 改，与 NBT 装载器统一）：每次先 stat，
 *   版本没变就用已解析的结果，变了就重读。原来按任务钉住，已废弃；`releaseTask` 保留为空操作
 * - 版本戳 = mtime + 尺寸；读前读后各取一次，不一致重读，仍不一致 = SOURCE_UNSTABLE
 */
const DEFAULT_TASK_ID = '__default__'
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024

function createJsonLoader({ sources, retries = 1, maxFileBytes = DEFAULT_MAX_FILE_BYTES }) {
  const cache = new Map() // path → { doc, version }

  async function stat(file) {
    try {
      return await fs.stat(file)
    } catch (error) {
      throw new QueryError('SOURCE_MISSING', `json file not readable: ${file}`, { cause: error })
    }
  }

  async function readOnce(file) {
    const before = await stat(file)
    if (before.size > maxFileBytes) {
      throw new QueryError('SOURCE_TOO_LARGE', `json file is ${before.size} bytes, over the ${maxFileBytes}-byte limit`)
    }
    let text
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (error) {
      throw new QueryError('SOURCE_MISSING', `json file not readable: ${file}`, { cause: error })
    }
    const after = await stat(file)
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) return null
    let doc
    try {
      doc = JSON.parse(text)
    } catch (error) {
      throw new QueryError('SOURCE_CORRUPT', `failed to parse ${file}: ${error.message}`, { cause: error })
    }
    return { doc, version: `${after.mtimeMs}:${after.size}` }
  }

  async function load(p) {
    const file = await sources.resolve(p)
    const current = await stat(file)
    const cached = cache.get(p)
    if (cached && cached.version === `${current.mtimeMs}:${current.size}`) return cached
    for (let attempt = 0; attempt <= retries; attempt++) {
      const snapshot = await readOnce(file)
      if (snapshot) {
        cache.set(p, snapshot)
        return snapshot
      }
    }
    throw new QueryError('SOURCE_UNSTABLE', `${p} kept changing while being read`)
  }

  /** 当前版本戳（只 stat）。 */
  async function version(p) {
    const s = await stat(await sources.resolve(p))
    return `${s.mtimeMs}:${s.size}`
  }

  return {
    load,
    version,
    releaseTask: () => {},
    clear: () => cache.clear(),
    size: () => cache.size
  }
}

module.exports = { createJsonLoader, DEFAULT_TASK_ID, DEFAULT_MAX_FILE_BYTES }
