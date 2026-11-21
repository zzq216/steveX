import fs from 'node:fs'
import path from 'node:path'
import { capsuleRefs, hashEntry, parseRef } from './library.js'
import { capsuleNameProblem } from './save.js'

/**
 * 胶囊改名（2026-11-21，capsule_search 只给名字之后的一次性迁移；以后也能用）。离线动作：跑之前停掉 DSH——
 * 插件把使用统计留在内存里，退出时写回 stats.json，会盖掉这里的改动。
 *
 * 一个名字从 old 改成 new（同一文件夹）：
 * - 条目文件：old 的每个版本按同一哈希复制一份 new@hash（哈希不含名字，所以哈希不变），旧文件原样留着——
 *   已保存的树、任务历史、快树里带哈希的旧引用照常能装载
 * - manifest：加 new（最新版哈希、说明、locked 照抄）；old 下架，取代者写 new
 * - 子树：最新版正文里引用了改名条目的，引用换成新名字（同一哈希），存成这棵子树的新版本（子树自己改名就直接存在新名字下）；
 *   被换了版本的子树又被别的子树引用时，一路往上换，直到不再变化
 * - 说明：所有在用条目说明里写到的旧名字（带文件夹前缀的写法）换成新名字；说明不在哈希里，不产生新版本
 * - versions.json：old 的版本记录抄到 new 下；子树因换引用产生的新版本记一条"只换了引用名"
 * - stats.json：old@hash 的统计抄到 new@hash；子树的新版本抄它上一版的统计（内容相同，只是引用名不同）
 * - notes.json：挂在 old 上的已知问题移到 new 下
 *
 * @param {{ dir: string, renames: Record<string, string>, text?: Record<string, string>, now?: () => Date, by?: string }} options
 *   renames = { "code/old": "code/new", "trees/old": "trees/new" }；text = 说明里不带文件夹前缀的写法要怎么换（逐字替换，可选）
 * @returns {{ errors: string[], plan?: object }}  plan 由 applyRename 执行
 */
export function planRename({ dir, renames, text: textMap = {}, now = () => new Date(), by = 'capsule-rename' }) {
  const errors = []
  const manifest = readJson(path.join(dir, 'manifest.json'), {})
  const pairs = Object.entries(renames ?? {})
  if (!pairs.length) errors.push('renames is empty')
  const targets = new Set()
  for (const [from, to] of pairs) {
    let a, b
    try {
      a = parseRef(from)
      b = parseRef(to)
    } catch (error) {
      errors.push(error.message)
      continue
    }
    if (a.hash || b.hash) { errors.push(`${from} → ${to}: write names without @hash`); continue }
    if (a.folder !== b.folder || a.folder === 'task') { errors.push(`${from} → ${to}: both must be in the same library folder (code or trees)`); continue }
    const info = manifest[from]
    if (!info) errors.push(`${from}: no such capsule`)
    else if (info.retired) errors.push(`${from}: already retired`)
    else if (info.locked) errors.push(`${from}: locked`)
    if (manifest[to]) errors.push(`${to}: already exists`)
    if (targets.has(to)) errors.push(`${to}: named twice`)
    targets.add(to)
    const problem = capsuleNameProblem(b.name)
    if (problem) errors.push(`${to}: ${problem}`)
  }
  if (errors.length) return { errors }

  const at = now().toISOString()
  const files = [] // { key, hash, entry }：要写的条目文件
  const refMap = new Map() // "folder/old@hash" → "folder/new@hash"
  const newManifest = { ...manifest }
  const versionCopies = [] // [old, new]
  const versionRecords = [] // { key, hash, parent }
  const statCopies = [] // [fromRef, toRef]

  // 1. 改名条目的每个版本：同一哈希抄到新名字下
  for (const [from, to] of pairs) {
    const { folder, name } = parseRef(from)
    const newName = parseRef(to).name
    for (const hash of versionHashes(dir, folder, name)) {
      refMap.set(`${from}@${hash}`, `${to}@${hash}`)
      statCopies.push([`${from}@${hash}`, `${to}@${hash}`])
      if (folder === 'code') files.push({ key: to, hash, entry: { ...readEntry(dir, folder, name, hash), name: newName } })
    }
    versionCopies.push([from, to])
  }

  // 2. 子树：正文里的引用换成新名字，一路往上换到不再变化
  const liveTrees = Object.entries(manifest).filter(([key, info]) => key.startsWith('trees/') && !info.retired).map(([key, info]) => ({ key, hash: info.hash }))
  const treeResult = new Map() // key → { target, hash, entry, changed }
  for (let round = 0; round <= liveTrees.length; round++) {
    let moved = false
    for (const { key, hash } of liveTrees) {
      const { name } = parseRef(key)
      const entry = readEntry(dir, 'trees', name, hash)
      const body = replaceRefs(entry.body, refMap)
      const target = renames[key] ?? key
      const changed = JSON.stringify(body) !== JSON.stringify(entry.body)
      const next = { ...entry, name: parseRef(target).name, body }
      const nextHash = hashEntry(next)
      const prev = treeResult.get(key)
      if (prev && prev.hash === nextHash) continue
      treeResult.set(key, { target, hash: nextHash, entry: next, changed, oldHash: hash })
      if (target !== key || changed) {
        refMap.set(`${key}@${hash}`, `${target}@${nextHash}`)
        moved = true
      }
    }
    if (!moved) break
  }
  for (const [key, r] of treeResult) {
    if (r.target === key && !r.changed) continue
    files.push({ key: r.target, hash: r.hash, entry: r.entry })
    if (r.changed) {
      versionRecords.push({ key: r.target, hash: r.hash, parent: r.oldHash })
      statCopies.push([`${key}@${r.oldHash}`, `${r.target}@${r.hash}`])
    }
    if (r.target !== key) {
      // 改名的子树：旧版本也抄到新名字下（版本链、带 @hash 的旧版引用都还能用）
      const { name } = parseRef(key)
      for (const hash of versionHashes(dir, 'trees', name)) {
        if (hash === r.hash) continue
        files.push({ key: r.target, hash, entry: { ...readEntry(dir, 'trees', name, hash), name: parseRef(r.target).name } })
      }
    }
  }

  // 3. manifest：新名字指向最新版；不改名但换了版本的子树指向新版；旧名字下架
  for (const [from, to] of pairs) {
    const info = manifest[from]
    const hash = from.startsWith('trees/') ? treeResult.get(from).hash : info.hash
    newManifest[to] = { hash, description: info.description ?? '', ...(info.locked ? { locked: true } : {}) }
    newManifest[from] = { ...info, retired: { at, reason: `改名为 ${to}（胶囊改名迁移）`, supersededBy: to, by } }
  }
  for (const [key, r] of treeResult) if (r.target === key && r.changed) newManifest[key] = { ...manifest[key], hash: r.hash }

  // 4. 说明里写到的旧名字换成新名字（在用条目）
  const descriptions = []
  for (const [key, info] of Object.entries(newManifest)) {
    if (info.retired) continue
    const text = replaceText(replaceNames(info.description ?? '', renames), textMap)
    if (text !== (info.description ?? '')) {
      descriptions.push({ key, before: info.description ?? '', after: text })
      newManifest[key] = { ...info, description: text }
    }
  }
  for (const f of files) {
    const desc = newManifest[f.key]?.hash === f.hash ? newManifest[f.key].description : replaceText(replaceNames(f.entry.description ?? '', renames), textMap)
    f.entry = withDescription(f.entry, desc)
  }
  const describeFiles = descriptions
    .filter(({ key }) => !files.some((f) => f.key === key && f.hash === newManifest[key].hash))
    .map(({ key, after }) => ({ key, hash: newManifest[key].hash, description: after }))

  for (const f of files) {
    if (hashEntry(f.entry) !== f.hash) errors.push(`internal: ${f.key}@${f.hash} hash changed while renaming`)
  }
  if (errors.length) return { errors }
  return {
    errors: [],
    plan: { dir, at, by, renames: pairs, files, describeFiles, manifest: newManifest, versionCopies, versionRecords, statCopies, descriptions, trees: [...treeResult].filter(([key, r]) => r.target !== key || r.changed).map(([key, r]) => ({ from: `${key}@${r.oldHash}`, to: `${r.target}@${r.hash}`, changed: r.changed })) }
  }
}

/** 执行 planRename 的计划。@returns {{ written: number, described: number }} */
export function applyRename(plan) {
  const { dir } = plan
  let written = 0
  for (const f of plan.files) {
    const { folder, name } = parseRef(f.key)
    const file = path.join(dir, folder, `${name}@${f.hash}.json`)
    if (fs.existsSync(file)) continue
    fs.mkdirSync(path.dirname(file), { recursive: true })
    writeAtomic(file, JSON.stringify(f.entry, null, 2) + '\n')
    written++
  }
  for (const d of plan.describeFiles) {
    const { folder, name } = parseRef(d.key)
    const file = path.join(dir, folder, `${name}@${d.hash}.json`)
    if (!fs.existsSync(file)) continue
    writeAtomic(file, JSON.stringify(withDescription(readJson(file, {}), d.description), null, 2) + '\n')
  }
  writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify(sortKeys(plan.manifest), null, 2) + '\n')

  const versionsFile = path.join(dir, 'versions.json')
  const versions = readJson(versionsFile, { version: 1, entries: {} })
  versions.entries ??= {}
  for (const [from, to] of plan.versionCopies) if (versions.entries[from]) versions.entries[to] = structuredClone(versions.entries[from])
  for (const r of plan.versionRecords) {
    versions.entries[r.key] ??= {}
    versions.entries[r.key][r.hash] = {
      parent: r.parent, at: plan.at, by: plan.by,
      change: '胶囊改名迁移：正文里引用的胶囊换成新名字（同一哈希、同一内容）',
      none: '只换了引用名，执行起来和旧版完全相同',
      claims: []
    }
  }
  writeAtomic(versionsFile, JSON.stringify(versions, null, 2) + '\n')

  const statsFile = path.join(dir, 'stats.json')
  if (fs.existsSync(statsFile)) {
    const stats = readJson(statsFile, null)
    if (stats?.refs) {
      for (const [from, to] of plan.statCopies) if (stats.refs[from] && !stats.refs[to]) stats.refs[to] = structuredClone(stats.refs[from])
      writeAtomic(statsFile, JSON.stringify(stats, null, 2) + '\n')
    }
  }

  const notesFile = path.join(dir, 'notes.json')
  if (fs.existsSync(notesFile)) {
    const notes = readJson(notesFile, null)
    if (notes?.issues) {
      for (const [from, to] of plan.renames) {
        if (!notes.issues[from]) continue
        notes.issues[to] = [...(notes.issues[to] ?? []), ...notes.issues[from]]
        delete notes.issues[from]
      }
      writeAtomic(notesFile, JSON.stringify(notes, null, 1) + '\n')
    }
  }
  return { written, described: plan.describeFiles.length }
}

/** 正文里的胶囊引用按 refMap 换掉（只看 ref 字段的字符串） */
function replaceRefs(value, refMap) {
  if (Array.isArray(value)) return value.map((v) => replaceRefs(v, refMap))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'ref' && typeof v === 'string' && refMap.has(v) ? refMap.get(v) : replaceRefs(v, refMap)]))
  }
  return value
}

/** 说明文字里带文件夹前缀的旧名字换成新名字（后面紧跟名字字符的不算，如 code/a 不会换掉 code/a-b） */
export function replaceNames(text, renames) {
  let out = text
  for (const [from, to] of Object.entries(renames).sort((a, b) => b[0].length - a[0].length)) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`${escaped}(?![a-z0-9._-]*[a-z0-9_-])`, 'g'), to)
  }
  return out
}

/** 逐字替换（长的先换） */
function replaceText(text, textMap) {
  let out = text
  for (const [from, to] of Object.entries(textMap).sort((a, b) => b[0].length - a[0].length)) out = out.split(from).join(to)
  return out
}

/** 库目录里这个名字的版本哈希（不含已归档的） */
function versionHashes(dir, folder, name) {
  const sub = path.join(dir, folder)
  if (!fs.existsSync(sub)) return []
  return fs.readdirSync(sub).filter((f) => f.startsWith(`${name}@`) && f.endsWith('.json')).map((f) => f.slice(name.length + 1, -5))
}

function readEntry(dir, folder, name, hash) {
  return readJson(path.join(dir, folder, `${name}@${hash}.json`), null) ?? (() => { throw new Error(`missing ${folder}/${name}@${hash}`) })()
}

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback
}

function withDescription(stored, description) {
  const { name, description: _old, ...rest } = stored
  return { name, ...(description ? { description } : {}), ...rest }
}

function sortKeys(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]))
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

export { capsuleRefs }
