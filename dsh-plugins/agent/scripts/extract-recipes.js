#!/usr/bin/env node
/**
 * 从 Minecraft jar 提取合成配方与物品标签，生成 data/recipes.json——JSON 查询 API 的默认数据源（core.json.query 的 recipes），agent 写的 Compute 从这里查配方。
 *
 * 规则全在源码数据里（行为树设计 §9.4："只有一个正确答案，规则全在源码里"）：
 * 配方不手写，直接取 jar 内 data/minecraft/recipe/*.json 与 data/minecraft/tags/item/*.json。
 *
 * 用法：
 *   node scripts/extract-recipes.js                 # 自动在 loom 缓存里找 minecraft-merged-*.jar
 *   node scripts/extract-recipes.js --jar <path>    # 指定 jar
 *
 * 只保留 crafting_shaped / crafting_shapeless；标签在提取时完全展开成物品 id 列表。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const steveXRoot = path.resolve(pluginRoot, '../..')
const outFile = path.join(pluginRoot, 'data', 'recipes.json')

function findJar() {
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
function readZipEntries(file, wanted) {
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

const RECIPE_PREFIX = 'data/minecraft/recipe/'
const TAG_PREFIX = 'data/minecraft/tags/item/'

function main() {
  const args = process.argv.slice(2)
  const jarArg = args.indexOf('--jar')
  const jar = jarArg >= 0 ? args[jarArg + 1] : findJar()
  if (!jar) {
    console.error('找不到 minecraft-merged-*.jar；先跑一次 npm run mc:capture 让 loom 生成缓存，或用 --jar 指定')
    process.exit(1)
  }

  const files = readZipEntries(jar, (name) =>
    (name.startsWith(RECIPE_PREFIX) || name.startsWith(TAG_PREFIX)) && name.endsWith('.json'))

  const rawTags = new Map()
  for (const [name, text] of files) {
    if (!name.startsWith(TAG_PREFIX)) continue
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

  function ingredient(spec) {
    const parts = Array.isArray(spec) ? spec : [spec]
    const ids = new Set()
    for (const part of parts) {
      const id = typeof part === 'string' ? part : part.item ?? part.tag
      if (id.startsWith('#')) for (const sub of resolveTag(id.slice(1))) ids.add(sub)
      else ids.add(id)
    }
    return [...ids].sort()
  }

  const recipes = []
  for (const [name, text] of files) {
    if (!name.startsWith(RECIPE_PREFIX)) continue
    const json = JSON.parse(text)
    const base = {
      name: name.slice(RECIPE_PREFIX.length, -'.json'.length),
      result: json.result?.id,
      count: json.result?.count ?? 1
    }
    if (json.type === 'minecraft:crafting_shaped') {
      const key = {}
      for (const [ch, spec] of Object.entries(json.key)) key[ch] = ingredient(spec)
      recipes.push({ ...base, type: 'shaped', pattern: json.pattern, key })
    } else if (json.type === 'minecraft:crafting_shapeless') {
      recipes.push({ ...base, type: 'shapeless', ingredients: json.ingredients.map(ingredient) })
    }
  }
  recipes.sort((a, b) => a.name.localeCompare(b.name))

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify({ source: path.basename(jar), recipes }) + '\n')
  console.log(`wrote ${recipes.length} crafting recipes to ${path.relative(steveXRoot, outFile)}`)
}

main()
