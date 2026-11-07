#!/usr/bin/env node
/**
 * 从 1.21.11 反编译源码提取物品的堆叠上限与合成剩余物，生成 data/item-props.json（训练场设计方案 T14）：
 * 训练器按它算"n 份材料 + 全部做光的产物 + 剩余物"能不能放进主物品栏。
 *
 * 规则只在源码里：Items.java 的注册语句 + Item.Properties（Item.java）。
 *   - 堆叠上限：没写 = 64；stacksTo(k) = k；durability(…) 和内部调用它的辅助方法（sword/pickaxe/humanoidArmor…）= 1；
 *     wolfArmor/horseArmor/nautilusArmor 在 Item.java 里 stacksTo(1)
 *   - 剩余物：craftRemainder(X)
 * 物品 id：registerItem("名字", …) 取名字；registerBlock(Blocks.X, …) 取方块 X 的注册名（Blocks.java）。
 *
 * 只输出 recipes.json 里出现过的材料、产物和它们的剩余物；有一个找不到或写法认不出就报错退出，不按 64 猜。
 *
 * 用法：
 *   node scripts/extract-item-props.js                  # 源码基准 steveX/1.21.11_src，配方 data/recipes.json
 *   node scripts/extract-item-props.js --src <dir> --recipes <file>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const steveXRoot = path.resolve(pluginRoot, '../..')
const outFile = path.join(pluginRoot, 'data', 'item-props.json')

/** 这些 Item.Properties 方法内部调用 durability(…) 或 stacksTo(1)（Item.java），堆叠上限都是 1 */
const STACK_ONE_HELPERS = ['durability', 'tool', 'pickaxe', 'axe', 'hoe', 'shovel', 'sword', 'spear', 'humanoidArmor', 'wolfArmor', 'horseArmor', 'nautilusArmor']
const STACK_ONE = new RegExp(`\\.(${STACK_ONE_HELPERS.join('|')})\\(`)

/** 一个 Java 文件里所有 `public static final <Type> NAME = …;` 声明：NAME → 声明文本（到下一个 public static final 为止）。 */
export function declarations(source, type) {
  const out = new Map()
  const re = new RegExp(`public static final ${type} (\\w+) = `, 'g')
  const starts = []
  let match
  while ((match = re.exec(source))) starts.push({ name: match[1], at: match.index + match[0].length })
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].at : source.length
    const text = source.slice(starts[i].at, end)
    out.set(starts[i].name, text.slice(0, text.lastIndexOf(';') + 1))
  }
  return out
}

/** references/Blocks.java、references/Items.java：字段名 → createKey 的名字。 */
export function referenceKeys(source) {
  const keys = new Map()
  for (const m of source.matchAll(/public static final ResourceKey<\w+> (\w+) = createKey\("([a-z0-9_]+)"\)/g)) keys.set(m[1], m[2])
  return keys
}

/** 注册调用的第一个参数：字面量名字，或 net.minecraft.references.<类>.X（经 refs 换成名字）。 */
function firstName(text, refs, kind) {
  const literal = /^\w+\(\s*"([a-z0-9_]+)"/.exec(text)
  if (literal) return literal[1]
  const ref = new RegExp(`^\\w+\\(\\s*net\\.minecraft\\.references\\.${kind}\\.(\\w+)`).exec(text)
  return ref ? refs.get(ref[1]) ?? null : null
}

/** 铜的 8 个氧化 / 打蜡变体（WeatheringCopperBlocks.create 的命名规则） */
const COPPER_VARIANTS = ['', 'exposed_', 'weathered_', 'oxidized_', 'waxed_', 'waxed_exposed_', 'waxed_weathered_', 'waxed_oxidized_']

/**
 * Blocks.java：字段名 → 注册名；WeatheringCopperBlocks 字段 → 8 个变体的注册名。
 * 方块都经 register / registerXxx(名字, …) 注册，名字取第一个参数。
 */
export function blockIds(source, refs = new Map()) {
  const ids = new Map()
  const copper = new Map()
  for (const [field, text] of declarations(source, 'Block')) {
    const name = firstName(text, refs, 'Blocks')
    if (name) ids.set(field, name)
  }
  for (const [field, text] of declarations(source, 'WeatheringCopperBlocks')) {
    const m = /^WeatheringCopperBlocks\.create\(\s*"([a-z0-9_]+)"/.exec(text)
    if (m) copper.set(field, COPPER_VARIANTS.map((prefix) => prefix + m[1]))
  }
  return { ids, copper }
}

/**
 * Items.java：字段名 → { id, maxStack, remainderField }。认不出的写法记在 problems 里（id 认不出时为 null）。
 * WeatheringCopperItems（铜栏杆、铜链、铜灯笼……）每组 8 个变体，按 Items::registerBlock 注册，堆叠上限 64。
 * @returns {{ items: Map<string, {id, maxStack, remainderField}>, problems: Array<{ id: string|null, text: string }> }}
 */
export function parseItems(source, { ids: blocks, copper }, refs = new Map()) {
  const items = new Map()
  const problems = []
  for (const [field, text] of declarations(source, 'WeatheringCopperItems')) {
    const m = /^WeatheringCopperItems\.create\(\s*Blocks\.(\w+),\s*Items::registerBlock\s*\)/.exec(text)
    const names = m ? copper.get(m[1]) : null
    if (!names) {
      problems.push({ id: null, text: `${field}: 认不出的铜物品组写法 ${text.slice(0, 60)}` })
      continue
    }
    names.forEach((id, i) => items.set(`${field}#${i}`, { id, maxStack: 64, remainderField: null }))
  }
  for (const [field, text] of declarations(source, 'Item')) {
    let id = null
    const named = /^registerItem\(/.test(text) ? firstName(text.replace(/^registerItem\(\s*vanillaItemId\(/, 'registerItem('), refs, 'Items') : null
    const block = /^registerBlock\(\s*Blocks\.(\w+)/.exec(text)
    if (named) id = named
    else if (block) {
      id = blocks.get(block[1]) ?? null
      if (!id) problems.push({ id: null, text: `${field}: Blocks.${block[1]} 没有注册名` })
    } else if (/^registerSpawnEgg\(/.test(text)) {
      id = field.toLowerCase() // 刷怪蛋不会是配方材料，id 只用来占位
    } else {
      problems.push({ id: null, text: `${field}: 认不出的注册写法 ${text.slice(0, 60)}` })
      continue
    }
    let maxStack = 64
    const stacks = [...text.matchAll(/\.stacksTo\(([^)]*)\)/g)].map((m) => m[1].trim())
    if (stacks.some((arg) => !/^\d+$/.test(arg))) problems.push({ id, text: `${id}: stacksTo 的参数不是字面量` })
    else if (stacks.length) maxStack = Number(stacks.at(-1))
    else if (STACK_ONE.test(text)) maxStack = 1
    if (/MAX_STACK_SIZE|MAX_DAMAGE/.test(text)) problems.push({ id, text: `${id}: 直接设置了 MAX_STACK_SIZE / MAX_DAMAGE 组件` })
    const remainder = /\.craftRemainder\((\w+)\)/.exec(text)
    items.set(field, { id, maxStack, remainderField: remainder ? remainder[1] : null })
  }
  return { items, problems }
}

/** 配方里出现过的全部物品 id（材料的每个可选项 + 产物）。 */
export function recipeItemIds(recipes) {
  const ids = new Set()
  for (const recipe of recipes) {
    ids.add(recipe.result)
    const options = recipe.type === 'shaped' ? Object.values(recipe.key ?? {}) : recipe.ingredients ?? []
    for (const list of options) for (const id of list) ids.add(id)
  }
  return ids
}

/** @returns {{ props: object, missing: string[] }}  props: id → { maxStack, remainder? } */
export function buildProps(recipes, items) {
  const byId = new Map([...items.values()].map((item) => [`minecraft:${item.id}`, item]))
  const wanted = recipeItemIds(recipes)
  const props = {}
  const missing = []
  const add = (id) => {
    if (props[id]) return
    const item = byId.get(id)
    if (!item) return missing.push(id)
    const entry = { maxStack: item.maxStack }
    if (item.remainderField) {
      const remainder = items.get(item.remainderField)
      if (!remainder) return missing.push(`${id} 的剩余物 ${item.remainderField}`)
      entry.remainder = `minecraft:${remainder.id}`
    }
    props[id] = entry
    if (entry.remainder) add(entry.remainder)
  }
  for (const id of [...wanted].sort()) add(id)
  return { props: Object.fromEntries(Object.entries(props).sort(([a], [b]) => a.localeCompare(b))), missing }
}

function main() {
  const args = process.argv.slice(2)
  const take = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args.splice(i, 2)[1] : null
  }
  const src = path.resolve(take('--src') ?? path.join(steveXRoot, '1.21.11_src'))
  const recipesFile = path.resolve(take('--recipes') ?? path.join(pluginRoot, 'data', 'recipes.json'))
  const read = (rel) => fs.readFileSync(path.join(src, rel), 'utf8')
  const blocks = blockIds(read('net/minecraft/world/level/block/Blocks.java'), referenceKeys(read('net/minecraft/references/Blocks.java')))
  const { items, problems } = parseItems(read('net/minecraft/world/item/Items.java'), blocks, referenceKeys(read('net/minecraft/references/Items.java')))
  const recipes = JSON.parse(fs.readFileSync(recipesFile, 'utf8')).recipes
  const { props, missing } = buildProps(recipes, items)
  // 认不出的写法只在落到要输出的物品上时才算错；连 id 都认不出的，要用到它就会出现在 missing 里
  const relevant = problems.filter((p) => p.id && props[`minecraft:${p.id}`]).map((p) => p.text)
  if (missing.length || relevant.length) {
    for (const line of [...missing.map((id) => `找不到：${id}`), ...relevant]) console.error(line)
    for (const p of problems.filter((q) => !q.id)) console.error(`（参考）${p.text}`)
    process.exit(1)
  }
  const out = { source: path.relative(steveXRoot, src).replaceAll('\\', '/'), items: props }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n')
  const counts = {}
  for (const { maxStack } of Object.values(props)) counts[maxStack] = (counts[maxStack] ?? 0) + 1
  const remainders = Object.entries(props).filter(([, p]) => p.remainder).map(([id, p]) => `${id} → ${p.remainder}`)
  console.log(`${outFile}：${Object.keys(props).length} 个物品；堆叠上限分布 ${JSON.stringify(counts)}`)
  console.log(`合成剩余物：${remainders.join('，') || '无'}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
