import fs from 'node:fs'
import path from 'node:path'
import { parseRef } from './library.js'

/**
 * 胶囊库 GC（胶囊库整理设计方案 §6，算法层 §8.6）：离线、由人跑（scripts/capsule-gc.js），默认只演练。
 *
 * 保留集（任一满足即保留）：
 *   1. manifest 里每个名字的当前版本（含已下架的）
 *   2. locked 条目
 *   3. 被任何一棵已保存的树引用过的版本：库里 trees/ 的全部条目（含旧版本）、runtime/tasks/*\/trees/v*.json、快树版本库
 *   4. 保留下来的子树胶囊再引用的版本（传递闭包）
 *   5. stats.json 里最近 keepDays 天内用过的（防 runtime/ 被清理后误收还在用的版本）
 * 其余移到 archive/<日期>/<文件夹>/<文件>，archive/index.jsonl 记一行（原路径、原因、当时的统计）。不真删。
 */
const REF = /^(code|trees)\/[a-z0-9][a-z0-9._-]*@[0-9a-f]{4,64}$/

/**
 * @param {{ dir: string, runtimeDir?: string|null, fastTreeDir?: string|null, stats?: import('./stats.js').CapsuleStats|null, keepDays?: number, now?: number }} options
 * @returns {{ entries: number, keep: Map<string, string>, collect: Array<{ ref, file }> }}  keep: ref → 保留的理由
 */
export function planGc({ dir, runtimeDir = null, fastTreeDir = null, stats = null, keepDays = 30, now = Date.now() }) {
  const entries = listEntries(dir)
  const keep = new Map()
  const mark = (ref, why) => { if (!keep.has(ref)) keep.set(ref, why) }

  const manifest = readJson(path.join(dir, 'manifest.json')) ?? {}
  for (const [key, info] of Object.entries(manifest)) mark(`${key}@${info.hash}`, info.retired ? 'current (retired)' : 'current')
  for (const { ref, file } of entries) if (readJson(file)?.locked) mark(ref, 'locked')

  for (const { ref, file } of entries) {
    if (ref.startsWith('trees/')) for (const r of refsIn(readJson(file)?.body)) mark(r, `referenced by library tree ${ref}`)
  }
  for (const file of treeFiles(runtimeDir && path.join(runtimeDir, 'tasks'), true)) {
    for (const r of refsIn(readJson(file))) mark(r, `referenced by ${path.relative(runtimeDir, file)}`)
  }
  for (const file of treeFiles(fastTreeDir, false)) {
    for (const r of refsIn(readJson(file))) mark(r, `referenced by fast tree ${path.basename(file)}`)
  }

  const cutoff = new Date(now - keepDays * 86400000).toISOString()
  for (const [ref, row] of Object.entries(stats?.data.refs ?? {})) {
    if (row.lastUsed && row.lastUsed >= cutoff) mark(ref, `used within ${keepDays} days`)
  }

  // 传递闭包：保留下来的子树胶囊里再引用的版本
  const byRef = new Map(entries.map((e) => [e.ref, e]))
  const queue = [...keep.keys()]
  while (queue.length) {
    const ref = queue.shift()
    if (!ref.startsWith('trees/')) continue
    const entry = byRef.get(ref)
    if (!entry) continue
    for (const r of refsIn(readJson(entry.file)?.body)) {
      if (!keep.has(r)) {
        keep.set(r, `referenced by kept tree ${ref}`)
        queue.push(r)
      }
    }
  }

  return { entries: entries.length, keep, collect: entries.filter((e) => !keep.has(e.ref)) }
}

/** 按 planGc 的结果归档。@returns {{ archived: Array<{ ref, to }> }} */
export function applyGc({ dir, plan, stats = null, now = Date.now() }) {
  const day = new Date(now).toISOString().slice(0, 10)
  const at = new Date(now).toISOString()
  const archiveRoot = path.join(dir, 'archive')
  const archived = []
  for (const { ref, file } of plan.collect) {
    const { folder } = parseRef(ref)
    const to = path.join(archiveRoot, day, folder, path.basename(file))
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(file, to)
    const row = stats?.data.refs[ref] ?? null
    if (row) delete stats.data.refs[ref]
    fs.appendFileSync(path.join(archiveRoot, 'index.jsonl'), JSON.stringify({
      at, ref, from: path.relative(dir, file), to: path.relative(dir, to), reason: 'no saved tree referenced it', stats: row
    }) + '\n')
    archived.push({ ref, to })
  }
  if (archived.length) stats?.save()
  return { archived }
}

function listEntries(dir) {
  const out = []
  for (const folder of ['code', 'trees']) {
    const sub = path.join(dir, folder)
    if (!fs.existsSync(sub)) continue
    for (const name of fs.readdirSync(sub)) {
      const match = /^(.+)@([0-9a-f]+)\.json$/.exec(name)
      if (match) out.push({ ref: `${folder}/${match[1]}@${match[2]}`, file: path.join(sub, name) })
    }
  }
  return out
}

/** runtime/tasks/<id>/trees/v*.json（nested = true）或 <dir>/v*.json（快树） */
function treeFiles(dir, nested) {
  if (!dir || !fs.existsSync(dir)) return []
  if (!nested) return fs.readdirSync(dir).filter((n) => /^v\d+\.json$/.test(n)).map((n) => path.join(dir, n))
  const out = []
  for (const task of fs.readdirSync(dir)) {
    const trees = path.join(dir, task, 'trees')
    if (fs.existsSync(trees)) out.push(...treeFiles(trees, false))
  }
  return out
}

/** 树（任意 JSON）里所有带哈希的 code/ trees/ 引用 */
function refsIn(value, out = new Set()) {
  if (Array.isArray(value)) for (const v of value) refsIn(v, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'ref' && typeof v === 'string' && REF.test(v)) out.add(v)
      else refsIn(v, out)
    }
  }
  return out
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
