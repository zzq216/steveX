import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { validateSignature } from './signature.js'

/**
 * 胶囊库（算法层 §8）：技能库与子树模板是同一个库，按 kind 分文件夹。
 *
 *   <dir>/code/<name>@<hash>.json    Compute / 条件代码（body = TS 源码）
 *   <dir>/trees/<name>@<hash>.json   可复用子树（body = 执行格式树）
 *   <dir>/manifest.json              每个 "文件夹/name" 的最新 hash + 一句话描述（给大模型选条目用）+ 下架标记
 *   <dir>/archive/<日期>/…            GC 归档（scripts/capsule-gc.js）：无人引用的旧版本移到这里，不真删
 *
 * - 引用 = `文件夹/name@hash`，前缀即 kind；哈希覆盖 signature + preconditions + body，不含 name / locked / description
 * - 改一个字符 = 新条目，老条目原样留下；取不到是错误，**不会退回最新版**（§8.4）
 * - 编写时可以省略 @hash（`code/name`），装载树时由 pin() 钉到当前最新版，存进树文件的永远带 hash
 * - 内置条目（core.*）由宿主实现（body = { host: 'json.query' }），只在内存里，不落盘
 * - 任务内代码草稿（集成方案 §5.1.0）：`task/<name>@hash`，只在当前任务内可引用，任务结束即失效；
 *   校验与运行照 code/ 条目，落在 runtime/tasks/<taskId>/code/，不进库、不进 manifest
 * - 暂存（P3 §7.2）：快树补丁附带的条件代码在补丁被接受之前只在内存里——能被钉住、能求值，
 *   补丁被拒就丢掉（不进库、不动 manifest）；被接受时 commitStaged() 写进库，哈希与暂存时相同
 * - 下架（整理方案 §5.4）：manifest 该名字加 `retired`，条目文件不动、带哈希的引用照常能装载；
 *   capsule_search 默认不列它。同名写入新版本（write）时下架标记自然清掉
 */
export class LibraryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LibraryError'
  }
}

export const FOLDERS = Object.freeze(['code', 'trees'])
const NAME = /^[a-z0-9][a-z0-9._-]*$/
const REF = /^(code|trees|task)\/([a-z0-9][a-z0-9._-]*)(?:@([0-9a-f]{4,64}))?$/

export function parseRef(ref) {
  const match = typeof ref === 'string' ? REF.exec(ref) : null
  if (!match) throw new LibraryError(`bad capsule ref ${JSON.stringify(ref)} (expected code/<name>[@hash], trees/<name>[@hash] or task/<name>[@hash])`)
  return { folder: match[1], name: match[2], hash: match[3] ?? null }
}

export function hashEntry(entry) {
  const canonical = stableStringify({ signature: entry.signature, preconditions: entry.preconditions ?? [], body: entry.body })
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8)
}

export class CapsuleLibrary {
  /**
   * @param {object} options
   * @param {string|null} options.dir    库目录；null = 只用内置条目（测试 / 未配置）
   * @param {Array<{ folder, entry, host }>} [options.builtins]  宿主实现的内置条目
   */
  constructor({ dir, builtins = [] }) {
    this.dir = dir
    this.builtins = new Map() // "folder/name@hash" → { entry, host }
    this.builtinLatest = new Map() // "folder/name" → hash
    for (const { folder, entry, host } of builtins) {
      const hash = hashEntry(entry)
      const full = { ...entry, hash, locked: true }
      this.builtins.set(`${folder}/${entry.name}@${hash}`, { entry: Object.freeze(full), host })
      this.builtinLatest.set(`${folder}/${entry.name}`, hash)
    }
    this.cache = new Map()
    this.drafts = null // { taskId, dir, entries: Map<"task/name@hash", entry>, latest: Map<name, hash> }
    this.staged = null // { entries: Map<"code/name@hash", entry>, latest: Map<"code/name", hash>, raw: entry[] }
  }

  // ── 暂存（快树补丁的条件代码）────────────────────────────────────────────

  /**
   * 暂存一批 code/ 条目（语义校验由调用方负责）。之后 pin("code/<name>") 先找暂存的。
   * @param {Array<{ name, description?, signature, body }>} entries
   * @returns {string[]} 每个条目的完整引用
   */
  stage(entries) {
    const staged = { entries: new Map(), latest: new Map(), raw: [] }
    const refs = []
    for (const entry of entries) {
      if (!NAME.test(entry?.name ?? '')) throw new LibraryError(`capsule name must match ${NAME}`)
      if (this.builtinLatest.has(`code/${entry.name}`)) throw new LibraryError(`code/${entry.name} is a built-in name`)
      const stored = {
        name: entry.name,
        ...(entry.description ? { description: entry.description } : {}),
        signature: entry.signature,
        body: entry.body
      }
      const hash = hashEntry(stored)
      staged.entries.set(`code/${entry.name}@${hash}`, deepFreeze({ ...stored, hash }))
      staged.latest.set(`code/${entry.name}`, hash)
      staged.raw.push(stored)
      refs.push(`code/${entry.name}@${hash}`)
    }
    this.staged = staged
    return refs
  }

  unstage() {
    this.staged = null
  }

  /** 把暂存的条目写进库（补丁被接受）。@returns {string[]} 引用 */
  commitStaged() {
    const refs = (this.staged?.raw ?? []).map((entry) => this.write('code', entry).ref)
    this.staged = null
    return refs
  }

  manifestPath() {
    return this.dir ? path.join(this.dir, 'manifest.json') : null
  }

  readManifest() {
    const file = this.manifestPath()
    if (!file || !fs.existsSync(file)) return {}
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }

  /** 全部条目的摘要（内置 + 库里的最新版），给大模型 / 人看。 */
  list() {
    const out = []
    for (const [key, hash] of this.builtinLatest) {
      const { entry } = this.builtins.get(`${key}@${hash}`)
      out.push({ ref: `${key}@${hash}`, description: entry.description ?? '', locked: true, builtin: true, kind: kindOf(key, entry) })
    }
    for (const [key, info] of Object.entries(this.readManifest())) {
      const entry = this.tryGet(`${key}@${info.hash}`)
      out.push({ ref: `${key}@${info.hash}`, description: info.description ?? '', locked: Boolean(info.locked), builtin: false, kind: entry ? kindOf(key, entry) : 'missing', ...(info.retired ? { retired: info.retired } : {}) })
    }
    for (const [name, hash] of this.drafts?.latest ?? []) {
      const entry = this.drafts.entries.get(`task/${name}@${hash}`)
      out.push({ ref: `task/${name}@${hash}`, description: entry.description ?? '', locked: false, builtin: false, draft: true, kind: kindOf('task/', entry) })
    }
    return out
  }

  /** 省略了 hash 的引用钉到当前最新版；已带 hash 的原样返回（仍检查存在）。 */
  pin(ref) {
    const { folder, name, hash } = parseRef(ref)
    const key = `${folder}/${name}`
    if (hash) {
      this.get(ref)
      return ref
    }
    const stagedHash = this.staged?.latest.get(key)
    if (stagedHash) return `${key}@${stagedHash}`
    if (folder === 'task') {
      const draft = this.drafts?.latest.get(name)
      if (!draft) throw new LibraryError(`no task draft named ${key} (drafts exist only in the current task: submit them in the "code" field)`)
      return `${key}@${draft}`
    }
    const latest = this.builtinLatest.get(key) ?? this.readManifest()[key]?.hash
    if (!latest) throw new LibraryError(`no capsule named ${key}`)
    return `${key}@${latest}`
  }

  /** @returns {object} 条目（冻结）。内置条目额外带不可序列化的 host。 */
  get(ref) {
    const { folder, name, hash } = parseRef(ref)
    if (!hash) throw new LibraryError(`capsule ref ${ref} has no @hash; pin it first`)
    const key = `${folder}/${name}@${hash}`
    if (folder === 'task') {
      const draft = this.drafts?.entries.get(key)
      if (!draft) throw new LibraryError(`task draft ${key} not found (drafts are only valid inside the task that wrote them)`)
      return draft
    }
    const staged = this.staged?.entries.get(key)
    if (staged) return staged
    const builtin = this.builtins.get(key)
    if (builtin) return builtin.entry
    if (this.cache.has(key)) return this.cache.get(key)
    if (!this.dir) throw new LibraryError(`capsule ${key} not found (no capsule library directory configured)`)
    const file = path.join(this.dir, folder, `${name}@${hash}.json`)
    if (!fs.existsSync(file)) {
      const archived = this.archivedPath(folder, `${name}@${hash}.json`)
      throw new LibraryError(archived
        ? `capsule ${key} was archived by GC (no saved tree referenced it): ${path.relative(this.dir, archived)}`
        : `capsule ${key} not found`)
    }
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (hashEntry(entry) !== hash) throw new LibraryError(`capsule ${key} was modified on disk (content no longer matches its hash)`)
    const frozen = deepFreeze({ ...entry, hash })
    this.cache.set(key, frozen)
    return frozen
  }

  tryGet(ref) {
    try { return this.get(ref) } catch { return null }
  }

  /** 内置条目的宿主实现；普通条目返回 null。 */
  host(ref) {
    return this.builtins.get(ref)?.host ?? null
  }

  /**
   * 写入一个条目（不做语义校验——那由 capsules/save.js 负责）。
   * 同内容已存在则什么都不写（哈希相同 = 同一条目）。manifest 的最新版指向它。
   * @returns {{ ref: string, hash: string, created: boolean }}
   */
  write(folder, entry) {
    if (!this.dir) throw new LibraryError('no capsule library directory configured')
    if (!FOLDERS.includes(folder)) throw new LibraryError(`folder must be code or trees`)
    if (!NAME.test(entry?.name ?? '')) throw new LibraryError(`capsule name must match ${NAME}`)
    if (this.builtinLatest.has(`${folder}/${entry.name}`)) throw new LibraryError(`${folder}/${entry.name} is a built-in name`)
    const signatureErrors = validateSignature(entry.signature)
    if (signatureErrors.length) throw new LibraryError(signatureErrors.join('; '))

    const stored = {
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.locked ? { locked: true } : {}),
      signature: entry.signature,
      ...(entry.preconditions?.length ? { preconditions: entry.preconditions } : {}),
      body: entry.body
    }
    const hash = hashEntry(stored)
    const dir = path.join(this.dir, folder)
    const file = path.join(dir, `${entry.name}@${hash}.json`)
    const created = !fs.existsSync(file)
    if (created) {
      fs.mkdirSync(dir, { recursive: true })
      writeAtomic(file, JSON.stringify(stored, null, 2) + '\n')
    }
    const manifest = this.readManifest()
    manifest[`${folder}/${entry.name}`] = { hash, description: entry.description ?? '', ...(entry.locked ? { locked: true } : {}) }
    fs.mkdirSync(this.dir, { recursive: true })
    writeAtomic(this.manifestPath(), JSON.stringify(sortKeys(manifest), null, 2) + '\n')
    return { ref: `${folder}/${entry.name}@${hash}`, hash, created }
  }

  /** 一个已归档文件的位置（archive/<日期>/<folder>/<file>，取最新的那次）；没有 = null */
  archivedPath(folder, file) {
    const root = path.join(this.dir, 'archive')
    if (!fs.existsSync(root)) return null
    for (const day of fs.readdirSync(root).sort().reverse()) {
      const candidate = path.join(root, day, folder, file)
      if (fs.existsSync(candidate)) return candidate
    }
    return null
  }

  // ── 整理（整理方案 §5.4）：下架、改说明。条目内容与哈希都不动 ──────────

  /** "folder/name[@hash]" → manifest 的键与当前项；内置条目、找不到 → 抛错 */
  manifestEntry(ref) {
    const { folder, name } = parseRef(ref)
    if (folder === 'task') throw new LibraryError(`${ref} is a task draft, not a library entry`)
    const key = `${folder}/${name}`
    if (this.builtinLatest.has(key)) throw new LibraryError(`${key} is a built-in entry and cannot be changed`)
    const manifest = this.readManifest()
    if (!manifest[key]) throw new LibraryError(`no capsule named ${key}`)
    return { key, manifest, info: manifest[key] }
  }

  /** @returns {{ key, hash, before: object|null, after: object }} */
  retire(ref, { reason, supersededBy = null, at, by = null }) {
    const { key, manifest, info } = this.manifestEntry(ref)
    if (info.locked) throw new LibraryError(`${key} is locked and cannot be retired`)
    if (supersededBy !== null) {
      const target = this.pin(supersededBy)
      if (target.startsWith(`${key}@`)) throw new LibraryError('supersededBy cannot be the entry itself')
      supersededBy = target.slice(0, target.lastIndexOf('@'))
    }
    const before = info.retired ?? null
    const after = { at, reason, ...(supersededBy ? { supersededBy } : {}), ...(by ? { by } : {}) }
    manifest[key] = { ...info, retired: after }
    this.writeManifest(manifest)
    return { key, hash: info.hash, before, after }
  }

  /** @returns {{ key, hash, before: object }} */
  unretire(ref) {
    const { key, manifest, info } = this.manifestEntry(ref)
    if (!info.retired) throw new LibraryError(`${key} is not retired`)
    const { retired: before, ...rest } = info
    manifest[key] = rest
    this.writeManifest(manifest)
    return { key, hash: info.hash, before }
  }

  /** 改说明：manifest 与当前版本文件里的 description 一起改；description 不在哈希里，不产生新版本。@returns {{ key, hash, before, after }} */
  describe(ref, description) {
    const { key, manifest, info } = this.manifestEntry(ref)
    const { folder, name } = parseRef(key)
    const file = path.join(this.dir, folder, `${name}@${info.hash}.json`)
    if (fs.existsSync(file)) {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
      writeAtomic(file, JSON.stringify(withDescription(stored, description), null, 2) + '\n')
      this.cache.delete(`${key}@${info.hash}`)
    }
    manifest[key] = { ...info, description }
    this.writeManifest(manifest)
    return { key, hash: info.hash, before: info.description ?? '', after: description }
  }

  writeManifest(manifest) {
    fs.mkdirSync(this.dir, { recursive: true })
    writeAtomic(this.manifestPath(), JSON.stringify(sortKeys(manifest), null, 2) + '\n')
  }

  // ── 任务内代码草稿 ──────────────────────────────────────────────────────

  /** 开始一个任务的草稿区（任务串行：同时只有一个）。dir = runtime/tasks/<taskId>/code，null = 不落盘。 */
  beginDrafts(taskId, dir = null) {
    this.drafts = { taskId, dir, entries: new Map(), latest: new Map() }
  }

  /** 任务结束：草稿不再可引用（落盘的文件留作记录）。 */
  endDrafts(taskId) {
    if (this.drafts?.taskId === taskId) this.drafts = null
  }

  /**
   * 写一条草稿（语义校验由 capsules/save.js 的 saveDraft 负责）。同名重写 = 新版本，老版本仍可被已钉住的树引用。
   * @returns {{ ref: string, hash: string }}
   */
  writeDraft(entry) {
    if (!this.drafts) throw new LibraryError('no task is accepting code drafts right now')
    if (!NAME.test(entry?.name ?? '')) throw new LibraryError(`draft name must match ${NAME}`)
    const signatureErrors = validateSignature(entry.signature)
    if (signatureErrors.length) throw new LibraryError(signatureErrors.join('; '))
    const stored = {
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      signature: entry.signature,
      body: entry.body
    }
    const hash = hashEntry(stored)
    const ref = `task/${entry.name}@${hash}`
    this.drafts.entries.set(ref, deepFreeze({ ...structuredClone(stored), hash }))
    this.drafts.latest.set(entry.name, hash)
    if (this.drafts.dir) {
      fs.mkdirSync(this.drafts.dir, { recursive: true })
      writeAtomic(path.join(this.drafts.dir, `${entry.name}@${hash}.json`), JSON.stringify(stored, null, 2) + '\n')
    }
    return { ref, hash }
  }
}

function kindOf(key, entry) {
  if (key.startsWith('trees/')) return 'tree'
  if (entry.signature?.returns === 'bool') return 'condition'
  return entry.body?.host ? 'query' : 'compute'
}

/** 条目文件的字段顺序照 write()：name、description、其余 */
function withDescription(stored, description) {
  const { name, description: _old, ...rest } = stored
  return { name, ...(description ? { description } : {}), ...rest }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sortKeys(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]))
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}
