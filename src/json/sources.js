'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const { QueryError } = require('../nbt/errors')

/**
 * 数据源白名单（docs/json查询api设计方案.md §4.1 / §6.1）。
 *
 * `sources` 是配置里的 `{ 标识: 文件或目录 }`。`path` 参数只能是：
 *   - `<标识>`              标识指向一个 .json 文件
 *   - `<标识>/<相对路径>`   标识指向一个目录，相对路径逐段只允许 [A-Za-z0-9._-]、不得是 . / ..、以 .json 结尾
 *
 * 静态检查（装载期，零 I/O）只看语法与标识；运行期再用 realpath 确认文件真的落在目录里
 * （符号链接逃逸在这一步被拦下）。
 */

const ID = /^[a-z][a-z0-9_-]*$/
const SEGMENT = /^[A-Za-z0-9._-]+$/

function loadError(message) {
  return new QueryError('LOAD_ERROR', message)
}

/**
 * @param {Record<string, string>} sources  标识 → 绝对路径
 * @returns {{ ids: string[], parse(p: string): { id: string, rest: string[] }, resolve(p: string): Promise<string> }}
 */
function createSourceTable(sources = {}) {
  const table = new Map()
  for (const [id, target] of Object.entries(sources)) {
    if (!ID.test(id)) throw new Error(`json source id "${id}" must match ${ID}`)
    if (typeof target !== 'string' || !path.isAbsolute(target)) {
      throw new Error(`json source "${id}" must map to an absolute path`)
    }
    table.set(id, path.normalize(target))
  }

  /** 静态解析：语法 + 标识存在。不碰磁盘。 */
  function parse(p) {
    if (typeof p !== 'string' || p === '') throw loadError('path is required (string literal)')
    if (p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
      throw loadError(`path must be a source id, not a file path (got ${JSON.stringify(p)})`)
    }
    const [id, ...rest] = p.split('/')
    if (!table.has(id)) {
      throw loadError(`unknown json source "${id}"; allowed: ${[...table.keys()].join(' / ') || '(none configured)'}`)
    }
    for (const segment of rest) {
      if (!SEGMENT.test(segment) || segment === '.' || segment === '..') {
        throw loadError(`path segment ${JSON.stringify(segment)} is not allowed`)
      }
    }
    if (rest.length > 0 && !rest[rest.length - 1].endsWith('.json')) {
      throw loadError('path inside a directory source must end with .json')
    }
    return { id, rest }
  }

  /** 运行期解析：确认文件 / 目录形态，并用 realpath 防符号链接逃逸。 */
  async function resolve(p) {
    const { id, rest } = parse(p)
    const target = table.get(id)
    let stat
    try {
      stat = await fs.stat(target)
    } catch (error) {
      throw new QueryError('SOURCE_MISSING', `json source "${id}" not found at ${target}`, { cause: error })
    }
    if (rest.length === 0) {
      if (!stat.isFile()) throw loadError(`json source "${id}" is a directory; use "${id}/<file>.json"`)
      return target
    }
    if (!stat.isDirectory()) throw loadError(`json source "${id}" is a file; use just "${id}"`)
    const file = path.join(target, ...rest)
    let realDir
    let realFile
    try {
      realDir = await fs.realpath(target)
      realFile = await fs.realpath(file)
    } catch (error) {
      throw new QueryError('SOURCE_MISSING', `json file not found: ${p}`, { cause: error })
    }
    if (!realFile.startsWith(realDir + path.sep)) throw loadError(`path ${JSON.stringify(p)} escapes its source directory`)
    return realFile
  }

  return { ids: [...table.keys()], parse, resolve }
}

module.exports = { createSourceTable }
