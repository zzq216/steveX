/**
 * 读游戏 jar 的共用小工具（extract-recipes.js、extract-item-props.js 共用；熔炉训练场设计方案 K10）。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** 在 loom 缓存里找 minecraft-merged-*.jar（不含 sources）；找不到 → null。 */
export function findJar(steveXRoot) {
  const base = path.join(steveXRoot, 'vendor', 'stevex-template-1.21.11', '.gradle', 'loom-cache', 'minecraftMaven')
  const stack = [base]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (/^minecraft-merged-.*\.jar$/.test(entry.name) && !entry.name.includes('sources')) return full
    }
  }
  return null
}

/** 最小 zip 读取：只取需要的条目（中央目录 + inflateRaw）。 */
export function readZipEntries(file, wanted) {
  const buf = fs.readFileSync(file)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error(`not a zip file: ${file}`)
  let offset = buf.readUInt32LE(eocd + 16)
  const out = new Map()
  while (offset + 46 <= buf.length && buf.readUInt32LE(offset) === 0x02014b50) {
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen)
    offset += 46 + nameLen + extraLen + commentLen
    if (!wanted(name)) continue
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(start, start + compSize)
    let data
    if (method === 0) data = raw
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else throw new Error(`unsupported zip method ${method} for ${name}`)
    out.set(name, data.toString('utf8'))
  }
  return out
}

export const RECIPE_PREFIX = 'data/minecraft/recipe/'
export const TAG_PREFIX = 'data/minecraft/tags/item/'

/**
 * 物品标签解析器：files 是 readZipEntries 的结果（含 TAG_PREFIX 下的条目）。
 * 返回 resolveTag('minecraft:logs') → 完全展开、排序后的物品 id 列表；不存在的标签 → []。
 */
export function tagResolver(files) {
  const rawTags = new Map()
  for (const [name, text] of files) {
    if (!name.startsWith(TAG_PREFIX) || !name.endsWith('.json')) continue
    const tag = 'minecraft:' + name.slice(TAG_PREFIX.length, -'.json'.length)
    rawTags.set(tag, JSON.parse(text).values ?? [])
  }
  const resolved = new Map()
  function resolveTag(tag, seen = new Set()) {
    if (resolved.has(tag)) return resolved.get(tag)
    if (seen.has(tag)) return []
    seen.add(tag)
    const ids = new Set()
    for (const value of rawTags.get(tag) ?? []) {
      const id = typeof value === 'string' ? value : value.id
      if (id.startsWith('#')) for (const sub of resolveTag(id.slice(1), seen)) ids.add(sub)
      else ids.add(id)
    }
    const list = [...ids].sort()
    resolved.set(tag, list)
    return list
  }
  resolveTag.has = (tag) => rawTags.has(tag)
  return resolveTag
}
