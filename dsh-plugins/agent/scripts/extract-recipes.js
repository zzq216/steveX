#!/usr/bin/env node
/**
 * 从 Minecraft jar 提取合成配方与物品标签，生成 data/recipes.json——JSON 查询 API 的默认数据源（core.json.query 的 recipes），agent 写的 Compute 从这里查配方。
 * 同一次扫描另外生成 data/stonecutting.json（切石配方，core.json.query 的 stonecutting；切石机训练场设计方案 Q11）
 * 和 data/cooking.json（熔炉 / 高炉 / 烟熏炉 / 营火配方，core.json.query 的 cooking；熔炉训练场设计方案 K10）。
 *
 * 规则全在源码数据里（行为树设计 §9.4："只有一个正确答案，规则全在源码里"）：
 * 配方不手写，直接取 jar 内 data/minecraft/recipe/*.json 与 data/minecraft/tags/item/*.json。
 *
 * 用法：
 *   node scripts/extract-recipes.js                 # 自动在 loom 缓存里找 minecraft-merged-*.jar
 *   node scripts/extract-recipes.js --jar <path>    # 指定 jar
 *
 * recipes.json 只保留 crafting_shaped / crafting_shapeless；标签在提取时完全展开成物品 id 列表。
 * stonecutting.json 是 minecraft:stonecutting：{ name, input, result, count }，input 是单个物品 id（1.21.11 的切石配方材料都不是标签；
 * 遇到标签或多选时报错，不静默猜）。
 * cooking.json 是 { name, type: smelting|blasting|smoking|campfire_cooking, input: [ids], result, count, time }：input 是展开后的物品列表
 * （铁锭这类配方有多种原料），time 是烧一个的 tick 数（配方的 cookingtime）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findJar, readZipEntries, tagResolver, RECIPE_PREFIX, TAG_PREFIX } from './lib/jar.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const steveXRoot = path.resolve(pluginRoot, '../..')
const outFile = path.join(pluginRoot, 'data', 'recipes.json')
const stonecuttingFile = path.join(pluginRoot, 'data', 'stonecutting.json')
const cookingFile = path.join(pluginRoot, 'data', 'cooking.json')

/** 烹饪配方的类型（熔炉、高炉、烟熏炉、营火） */
const COOKING_TYPES = new Set(['smelting', 'blasting', 'smoking', 'campfire_cooking'])

function main() {
  const args = process.argv.slice(2)
  const jarArg = args.indexOf('--jar')
  const jar = jarArg >= 0 ? args[jarArg + 1] : findJar(steveXRoot)
  if (!jar) {
    console.error('找不到 minecraft-merged-*.jar；先跑一次 npm run mc:capture 让 loom 生成缓存，或用 --jar 指定')
    process.exit(1)
  }

  const files = readZipEntries(jar, (name) =>
    (name.startsWith(RECIPE_PREFIX) || name.startsWith(TAG_PREFIX)) && name.endsWith('.json'))

  const resolveTag = tagResolver(files)

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
  const stonecutting = []
  const cooking = []
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
    } else if (json.type === 'minecraft:stonecutting') {
      const input = ingredient(json.ingredient)
      if (input.length !== 1 || typeof json.ingredient !== 'string') throw new Error(`stonecutting recipe ${base.name}: ingredient is not a single item id (${JSON.stringify(json.ingredient)})`)
      stonecutting.push({ name: base.name, input: input[0], result: base.result, count: base.count })
    } else if (COOKING_TYPES.has(json.type?.replace(/^minecraft:/, ''))) {
      if (typeof json.cookingtime !== 'number') throw new Error(`cooking recipe ${base.name}: no cookingtime`)
      cooking.push({ name: base.name, type: json.type.replace(/^minecraft:/, ''), input: ingredient(json.ingredient), result: base.result, count: base.count, time: json.cookingtime })
    }
  }
  recipes.sort((a, b) => a.name.localeCompare(b.name))
  stonecutting.sort((a, b) => a.name.localeCompare(b.name))
  cooking.sort((a, b) => a.name.localeCompare(b.name))

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify({ source: path.basename(jar), recipes }) + '\n')
  console.log(`wrote ${recipes.length} crafting recipes to ${path.relative(steveXRoot, outFile)}`)
  fs.writeFileSync(stonecuttingFile, JSON.stringify({ source: path.basename(jar), recipes: stonecutting }) + '\n')
  console.log(`wrote ${stonecutting.length} stonecutting recipes to ${path.relative(steveXRoot, stonecuttingFile)}`)
  fs.writeFileSync(cookingFile, JSON.stringify({ source: path.basename(jar), recipes: cooking }) + '\n')
  console.log(`wrote ${cooking.length} cooking recipes to ${path.relative(steveXRoot, cookingFile)}`)
}

main()
