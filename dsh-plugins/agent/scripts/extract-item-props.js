#!/usr/bin/env node
/**
 * 从 1.21.11 反编译源码提取物品的堆叠上限、合成剩余物和燃料时长，生成 data/item-props.json（训练场设计方案 T14）：
 * 训练器按它算"n 份材料 + 全部做光的产物 + 剩余物"能不能放进主物品栏；熔炉题按它过滤物品池、算燃料能烧几个（熔炉训练场设计方案 K10）。
 *
 * 规则只在源码里：Items.java 的注册语句 + Item.Properties（Item.java）。
 *   - 堆叠上限：没写 = 64；stacksTo(k) = k；durability(…) 和内部调用它的辅助方法（sword/pickaxe/humanoidArmor…）= 1；
 *     wolfArmor/horseArmor/nautilusArmor 在 Item.java 里 stacksTo(1)。
 *     写成 properties -> new XItem(…) 或 XItem::new 的，再看 XItem 的构造函数里有没有这些写法（斧、锹、锄就是这样，熔炉方案 F13）
 *   - 剩余物：craftRemainder(X)
 *   - 燃料时长（burn，熔炉的基准 tick 数）：FuelValues.vanillaBurnTimes 的 .add(…, 表达式) / .remove(标签)，基准值 200，
 *     表达式按 Java 整数运算求值；标签按 jar 里 data/minecraft/tags/item 展开（ItemTags.java 给字段名 → 标签名）。
 *     高炉、烟熏炉的时长是它的一半（整数除法），不另存
 *   - 可附魔程度（enchantable，附魔台训练场设计方案 N10）：.enchantable(n)；工具 / 剑 / 矛取 ToolMaterial 的 enchantmentValue，
 *     humanoidArmor 取 ArmorMaterials 的 enchantmentValue。附魔台出不了附魔的（jar 里 in_enchanting_table 的附魔都不把它列为主要物品）
 *     另记 enchantingTable: false
 * 物品 id：registerItem("名字", …) 取名字；registerBlock(Blocks.X, …) 取方块 X 的注册名（Blocks.java）。
 *
 *   - 纹饰材料（trimMaterial，锻造台训练场设计方案 M9）：.trimMaterial(TrimMaterials.X)，按 TrimMaterials.java 的 registryKey("名字") 换成注册名
 *     （如金锭 → minecraft:gold）。这个对应关系只在源码里，配方 json 里没有
 * 同样的内容另存一份数组格式的 data/items.json（{ source, items: [{ id, maxStack, remainder?, burn?, enchantable?, enchantingTable?, trimMaterial? }] }），给 agent 的 json.items 查。
 * 只输出 recipes.json、cooking.json、smithing.json 里出现过的材料、产物、全部燃料、全部可附魔物品和它们的剩余物；有一个找不到或写法认不出就报错退出，不按 64 猜。
 *
 * 用法：
 *   node scripts/extract-item-props.js                  # 源码基准 steveX/1.21.11_src，配方 data/recipes.json + data/cooking.json + data/smithing.json
 *   node scripts/extract-item-props.js --src <dir> --recipes <file> --cooking <file> --smithing <file> --jar <path>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findJar, readZipEntries, tagResolver, TAG_PREFIX } from './lib/jar.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const steveXRoot = path.resolve(pluginRoot, '../..')
const outFile = path.join(pluginRoot, 'data', 'item-props.json')
/** 同样的内容排成数组，给 agent 用 core.json.query 查（json.items；查询只认数组，熔炉训练场设计方案 K10） */
const listFile = path.join(pluginRoot, 'data', 'items.json')

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
export function parseItems(source, { ids: blocks, copper }, refs = new Map(), materials = null, trimKeys = null) {
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
    const ctor = !stacks.length && maxStack === 64 ? /properties\s*->\s*new\s+(\w+)\(|(\w+)::new\b/.exec(text) : null
    const ctorClass = ctor ? ctor[1] ?? ctor[2] : null
    const entry = { id, maxStack, remainderField: remainder ? remainder[1] : null, ctorClass: ctorClass === 'Item' ? null : ctorClass }
    if (materials) {
      const value = enchantabilityOf(text, materials)
      if (value?.problem) problems.push({ id, text: `${id}: ${value.problem}` })
      else if (value !== null) entry.enchantable = value
    }
    // 锻造台训练场设计方案 M9：能当哪种纹饰材料
    const trim = /\.trimMaterial\(([^)]*)\)/.exec(text)
    if (trim && trimKeys) {
      const key = /^TrimMaterials\.(\w+)$/.exec(trim[1].trim())
      const name = key ? trimKeys.get(key[1]) : null
      if (name) entry.trimMaterial = name
      else problems.push({ id, text: `${id}: 认不出的纹饰材料 ${trim[1]}` })
    }
    items.set(field, entry)
  }
  return { items, problems }
}

/**
 * 工具材质、盔甲材质的可附魔程度（附魔台训练场设计方案 N10）：ToolMaterial.java 的 new ToolMaterial(…, enchantmentValue, …)、
 * ArmorMaterials.java 的 new ArmorMaterial(durability, makeDefense(…), enchantmentValue, …)。
 * 同时核对辅助方法真的给了"可附魔"属性：ToolMaterial.applyCommonProperties、Item.Properties.spear / humanoidArmor 里有 .enchantable(…)。
 * @returns {{ tool: Map<string, number>, armor: Map<string, number>, problems: string[] }}
 */
export function materialValues(toolSource, armorSource, itemSource) {
  const problems = []
  const tool = new Map()
  for (const m of toolSource.matchAll(/public static final ToolMaterial (\w+) = new ToolMaterial\(\s*[\w.]+,\s*\d+,\s*[\d.]+F,\s*[\d.]+F,\s*(\d+),/g)) tool.set(m[1], Number(m[2]))
  const armor = new Map()
  for (const m of armorSource.matchAll(/ArmorMaterial (\w+) = new ArmorMaterial\(\s*\d+,\s*makeDefense\([^)]*\),\s*(\d+),/g)) armor.set(m[1], Number(m[2]))
  if (!tool.size) problems.push('ToolMaterial.java：认不出材质的定义')
  if (!armor.size) problems.push('ArmorMaterials.java：认不出材质的定义')
  if (!/applyCommonProperties\([^)]*\)\s*\{[^}]*\.enchantable\(this\.enchantmentValue\)/.test(toolSource)) problems.push('ToolMaterial.applyCommonProperties 里没有 .enchantable(this.enchantmentValue)')
  for (const helper of ['spear', 'humanoidArmor']) {
    const at = itemSource.indexOf(`public Item.Properties ${helper}(`)
    const body = at < 0 ? '' : itemSource.slice(at, itemSource.indexOf('\n\t\t}', at))
    if (!/\.enchantable\(\w+\.enchantmentValue\(\)\)/.test(body)) problems.push(`Item.Properties.${helper} 里没有 .enchantable(…enchantmentValue())`)
  }
  return { tool, armor, problems }
}

/**
 * 一条物品注册语句的可附魔程度：.enchantable(n)；工具 / 剑 / 矛（含 new AxeItem(ToolMaterial.X, …) 这类构造函数）取工具材质；
 * humanoidArmor 取盔甲材质。都没有 → null（没有"可附魔"属性）；材质认不出 → { problem }。
 */
export function enchantabilityOf(text, { tool, armor }) {
  const explicit = /\.enchantable\((\d+)\)/.exec(text)
  if (explicit) return Number(explicit[1])
  const toolMatch = /(?:\.(?:sword|pickaxe|axe|hoe|shovel|spear|tool)\(|new (?:Axe|Shovel|Hoe)Item\()\s*ToolMaterial\.(\w+)/.exec(text)
  if (toolMatch) return tool.has(toolMatch[1]) ? tool.get(toolMatch[1]) : { problem: `认不出工具材质 ToolMaterial.${toolMatch[1]}` }
  const armorMatch = /\.humanoidArmor\(\s*ArmorMaterials\.(\w+)/.exec(text)
  if (armorMatch) return armor.has(armorMatch[1]) ? armor.get(armorMatch[1]) : { problem: `认不出盔甲材质 ArmorMaterials.${armorMatch[1]}` }
  if (/\.enchantable\(/.test(text)) return { problem: 'enchantable 的参数不是字面量' }
  return null
}

/**
 * 附魔台能给哪些物品出附魔（附魔台训练场设计方案 E10）：in_enchanting_table 标签里的附魔，把物品列为"主要物品"
 * （primary_items，没写就是 supported_items，且要同时在 supported_items 里）的。书例外，返回值里不含书，由调用方单独处理。
 * @param {Map<string, string>} files  jar 里 data/minecraft/enchantment/*.json 与 data/minecraft/tags/enchantment/*.json
 * @returns {Set<string>} 物品 id
 */
export function enchantingTableItems(files, resolveTag) {
  const prefix = 'data/minecraft/tags/enchantment/'
  const raw = new Map()
  for (const [name, text] of files) if (name.startsWith(prefix) && name.endsWith('.json')) raw.set(`minecraft:${name.slice(prefix.length, -5)}`, JSON.parse(text).values ?? [])
  const expand = (tag, seen = new Set()) => {
    if (seen.has(tag)) return []
    seen.add(tag)
    const out = []
    for (const v of raw.get(tag) ?? []) {
      const id = typeof v === 'string' ? v : v.id
      if (id.startsWith('#')) out.push(...expand(id.slice(1), seen))
      else out.push(id)
    }
    return out
  }
  const itemsOf = (spec) => {
    if (spec === undefined || spec === null) return null
    const out = new Set()
    for (const part of Array.isArray(spec) ? spec : [spec]) {
      if (part.startsWith('#')) for (const id of resolveTag(part.slice(1))) out.add(id)
      else out.add(part)
    }
    return out
  }
  const covered = new Set()
  for (const enchantment of expand('minecraft:in_enchanting_table')) {
    const text = files.get(`data/minecraft/enchantment/${enchantment.replace(/^minecraft:/, '')}.json`)
    if (!text) continue
    const json = JSON.parse(text)
    const supported = itemsOf(json.supported_items) ?? new Set()
    const primary = itemsOf(json.primary_items) ?? supported
    for (const id of primary) if (supported.has(id)) covered.add(id)
  }
  return covered
}

/**
 * 构造函数里定堆叠上限的物品（熔炉方案 F13）：items 里记了 ctorClass 的，读那个类的源码，
 * 在它的构造函数（public 类名(…) { … }，到第一个 '}'）里找 stacksTo(k) 或会让上限变成 1 的写法（STACK_ONE_HELPERS）。
 * readClass(类名) → 源码文本，找不到 → null（记进 problems）。原地改 items 的 maxStack。
 * @returns {Array<{ id: string, text: string }>} problems
 */
export function applyConstructorStacks(items, readClass) {
  const problems = []
  const cache = new Map()
  for (const item of items.values()) {
    if (!item.ctorClass) continue
    if (!cache.has(item.ctorClass)) {
      const source = readClass(item.ctorClass)
      if (source == null) cache.set(item.ctorClass, { missing: true })
      else {
        const ctorRe = new RegExp(`public ${item.ctorClass}\\([^)]*\\)\\s*\\{[^}]*\\}`, 'g')
        const ctors = [...source.matchAll(ctorRe)].map((m) => m[0]).join('\n')
        const stacks = [...ctors.matchAll(/\.stacksTo\(([^)]*)\)/g)].map((m) => m[1].trim())
        cache.set(item.ctorClass, { stacks, one: STACK_ONE.test(ctors) })
      }
    }
    const info = cache.get(item.ctorClass)
    if (info.missing) problems.push({ id: item.id, text: `${item.id}: 找不到 ${item.ctorClass}.java` })
    else if (info.stacks.some((arg) => !/^\d+$/.test(arg))) problems.push({ id: item.id, text: `${item.id}: ${item.ctorClass} 构造函数里 stacksTo 的参数不是字面量` })
    else if (info.stacks.length) item.maxStack = Number(info.stacks.at(-1))
    else if (info.one) item.maxStack = 1
  }
  return problems
}

/** ItemTags.java：字段名 → 标签名（minecraft:xxx）。 */
export function itemTagNames(source) {
  const out = new Map()
  for (const m of source.matchAll(/public static final TagKey<Item> (\w+) = bind\("([a-z0-9_/]+)"\)/g)) out.set(m[1], `minecraft:${m[2]}`)
  return out
}

/** FuelValues 里的时长表达式（只认整数、i、+、*、/），按 Java 整数运算（从左到右、除法截断）求值；认不出 → null。 */
export function evalBurn(expr, base) {
  const text = expr.replace(/\s+/g, '')
  if (!/^[0-9i*/+]+$/.test(text)) return null
  const value = (t) => (t === 'i' ? base : /^\d+$/.test(t) ? Number(t) : NaN)
  let total = 0
  for (const term of text.split('+')) {
    const tokens = term.split(/([*/])/)
    let acc = value(tokens[0])
    for (let k = 1; k < tokens.length; k += 2) {
      const v = value(tokens[k + 1])
      acc = tokens[k] === '*' ? acc * v : Math.trunc(acc / v)
    }
    if (!Number.isFinite(acc)) return null
    total += acc
  }
  return total
}

/**
 * FuelValues.java → 燃料表 id → 熔炉基准时长。按源码顺序登记（后登记的覆盖前面的，FuelValues.Builder.putInternal），最后执行 remove。
 * @param {{ items: Map, blocks: Map, tags: Map, resolveTag: Function }} names
 *   items：Items 字段名 → { id }；blocks：Blocks 字段名 → 注册名；tags：ItemTags 字段名 → 标签名；resolveTag：标签名 → 物品 id 列表
 * @returns {{ fuels: Map<string, number>, problems: string[] }}
 */
export function parseFuels(source, { items, blocks, tags, resolveTag }) {
  const problems = []
  const fuels = new Map()
  const baseMatch = /vanillaBurnTimes\(provider, featureFlagSet, (\d+)\)/.exec(source)
  const start = source.indexOf('vanillaBurnTimes(HolderLookup.Provider provider, FeatureFlagSet featureFlagSet, int i)')
  const end = start < 0 ? -1 : source.indexOf('.build();', start)
  if (!baseMatch || end < 0) return { fuels, problems: ['FuelValues：找不到基准值或 vanillaBurnTimes(…, int i) 的方法体'] }
  const base = Number(baseMatch[1])
  const tagIds = (field) => {
    const tag = tags.get(field)
    if (!tag) { problems.push(`FuelValues：ItemTags.${field} 没有标签名`); return [] }
    if (resolveTag.has && !resolveTag.has(tag)) { problems.push(`FuelValues：jar 里没有标签 ${tag}`); return [] }
    return resolveTag(tag)
  }
  const lines = source.slice(start, end).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('.'))
  for (const line of lines) {
    const add = /^\.add\((ItemTags|Items|Blocks)\.(\w+),\s*(.+)\)$/.exec(line)
    const remove = /^\.remove\(ItemTags\.(\w+)\)$/.exec(line)
    if (add) {
      const ticks = evalBurn(add[3], base)
      if (ticks == null) { problems.push(`FuelValues：认不出的时长表达式 ${line}`); continue }
      let ids
      if (add[1] === 'ItemTags') ids = tagIds(add[2])
      else {
        const id = add[1] === 'Items' ? items.get(add[2])?.id : blocks.get(add[2])
        if (!id) { problems.push(`FuelValues：${add[1]}.${add[2]} 没有注册名`); continue }
        ids = [`minecraft:${id}`]
      }
      for (const id of ids) fuels.set(id, ticks)
    } else if (remove) {
      for (const id of tagIds(remove[1])) fuels.delete(id)
    } else problems.push(`FuelValues：认不出的写法 ${line}`)
  }
  return { fuels, problems }
}

/**
 * TrimMaterials.java 里的纹饰材料：字段名 → 注册名（`public static final ResourceKey<TrimMaterial> GOLD = registryKey("gold")` → GOLD → minecraft:gold）。
 */
export function trimMaterialKeys(source) {
  const out = new Map()
  for (const m of source.matchAll(/ResourceKey<TrimMaterial>\s+(\w+)\s*=\s*registryKey\("([a-z0-9_]+)"\)/g)) out.set(m[1], `minecraft:${m[2]}`)
  return out
}

/**
 * 配方里出现过的全部物品 id（材料的每个可选项 + 产物）。烹饪配方（cooking.json）的材料是 input：物品 id 列表。
 * 锻造配方（smithing.json）：模板、底材、材料（单个 id 或列表）和升级的产物。
 */
export function recipeItemIds(recipes) {
  const ids = new Set()
  for (const recipe of recipes) {
    if (recipe.type === 'transform' || recipe.type === 'trim') {
      for (const value of [recipe.template, recipe.base, recipe.addition, recipe.result]) {
        for (const id of [value].flat()) if (id) ids.add(id)
      }
      continue
    }
    ids.add(recipe.result)
    const options = recipe.type === 'shaped' ? Object.values(recipe.key ?? {}) : Array.isArray(recipe.input) ? [recipe.input] : recipe.ingredients ?? []
    for (const list of options) for (const id of list) ids.add(id)
  }
  return ids
}

/**
 * @param {Map<string, number>} [fuels]  id → 熔炉基准燃料时长；全部燃料都输出，并带上 burn
 * @param {Set<string>|null} [tableItems]  附魔台能出附魔的物品（enchantingTableItems）；给了就输出全部有"可附魔"属性的物品，
 *   带上 enchantable（可附魔程度），附魔台出不了附魔的另记 enchantingTable: false（书总是出得了）
 * @returns {{ props: object, missing: string[] }}  props: id → { maxStack, remainder?, burn?, enchantable?, enchantingTable?, trimMaterial? }
 */
export function buildProps(recipes, items, fuels = new Map(), tableItems = null) {
  const byId = new Map([...items.values()].map((item) => [`minecraft:${item.id}`, item]))
  const wanted = recipeItemIds(recipes)
  for (const id of fuels.keys()) wanted.add(id)
  if (tableItems) for (const item of items.values()) if (item.enchantable !== undefined) wanted.add(`minecraft:${item.id}`)
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
    if (fuels.has(id)) entry.burn = fuels.get(id)
    if (tableItems && item.enchantable !== undefined) {
      entry.enchantable = item.enchantable
      if (id !== 'minecraft:book' && !tableItems.has(id)) entry.enchantingTable = false
    }
    if (item.trimMaterial) entry.trimMaterial = item.trimMaterial
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
  const cookingFile = path.resolve(take('--cooking') ?? path.join(pluginRoot, 'data', 'cooking.json'))
  const smithingFile = path.resolve(take('--smithing') ?? path.join(pluginRoot, 'data', 'smithing.json'))
  const jar = take('--jar') ?? findJar(steveXRoot)
  if (!jar) {
    console.error('找不到 minecraft-merged-*.jar（燃料表要展开物品标签）；先跑一次 npm run mc:capture 让 loom 生成缓存，或用 --jar 指定')
    process.exit(1)
  }
  for (const file of [cookingFile, smithingFile]) {
    if (!fs.existsSync(file)) {
      console.error(`找不到 ${file}（先运行 npm run extract-recipes）`)
      process.exit(1)
    }
  }
  const read = (rel) => fs.readFileSync(path.join(src, rel), 'utf8')
  const blocks = blockIds(read('net/minecraft/world/level/block/Blocks.java'), referenceKeys(read('net/minecraft/references/Blocks.java')))
  const materials = materialValues(read('net/minecraft/world/item/ToolMaterial.java'), read('net/minecraft/world/item/equipment/ArmorMaterials.java'), read('net/minecraft/world/item/Item.java'))
  const trimKeys = trimMaterialKeys(read('net/minecraft/world/item/equipment/trim/TrimMaterials.java'))
  const { items, problems } = parseItems(read('net/minecraft/world/item/Items.java'), blocks, referenceKeys(read('net/minecraft/references/Items.java')), materials, trimKeys)
  // 构造函数里定堆叠上限的物品类（斧、锹、锄……），在 world/item 下按类名找源码
  const classFiles = new Map()
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.java') && !classFiles.has(entry.name.slice(0, -5))) classFiles.set(entry.name.slice(0, -5), full)
    }
  }
  walk(path.join(src, 'net/minecraft/world/item'))
  problems.push(...applyConstructorStacks(items, (cls) => (classFiles.has(cls) ? fs.readFileSync(classFiles.get(cls), 'utf8') : null)))
  const jarFiles = readZipEntries(jar, (name) => (name.startsWith(TAG_PREFIX) || name.startsWith('data/minecraft/enchantment/') || name.startsWith('data/minecraft/tags/enchantment/')) && name.endsWith('.json'))
  const resolveTag = tagResolver(jarFiles)
  const { fuels, problems: fuelProblems } = parseFuels(read('net/minecraft/world/level/block/entity/FuelValues.java'), {
    items, blocks: blocks.ids, tags: itemTagNames(read('net/minecraft/tags/ItemTags.java')), resolveTag
  })
  const tableItems = enchantingTableItems(jarFiles, resolveTag)
  if (!tableItems.size) fuelProblems.push('jar 里找不到附魔台附魔（in_enchanting_table）')
  const recipes = [
    ...JSON.parse(fs.readFileSync(recipesFile, 'utf8')).recipes,
    ...JSON.parse(fs.readFileSync(cookingFile, 'utf8')).recipes,
    ...JSON.parse(fs.readFileSync(smithingFile, 'utf8')).recipes
  ]
  const { props, missing } = buildProps(recipes, items, fuels, tableItems)
  // 认不出的写法只在落到要输出的物品上时才算错；连 id 都认不出的，要用到它就会出现在 missing 里
  const relevant = problems.filter((p) => p.id && props[`minecraft:${p.id}`]).map((p) => p.text)
  if (missing.length || relevant.length || fuelProblems.length || materials.problems.length) {
    for (const line of [...missing.map((id) => `找不到：${id}`), ...relevant, ...fuelProblems, ...materials.problems]) console.error(line)
    for (const p of problems.filter((q) => !q.id)) console.error(`（参考）${p.text}`)
    process.exit(1)
  }
  const out = { source: path.relative(steveXRoot, src).replaceAll('\\', '/'), items: props }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n')
  fs.writeFileSync(listFile, JSON.stringify({ source: out.source, items: Object.entries(props).map(([id, p]) => ({ id, ...p })) }) + '\n')
  const counts = {}
  for (const { maxStack } of Object.values(props)) counts[maxStack] = (counts[maxStack] ?? 0) + 1
  const remainders = Object.entries(props).filter(([, p]) => p.remainder).map(([id, p]) => `${id} → ${p.remainder}`)
  console.log(`${outFile}：${Object.keys(props).length} 个物品；堆叠上限分布 ${JSON.stringify(counts)}`)
  console.log(`合成剩余物：${remainders.join('，') || '无'}`)
  const bands = {}
  for (const { burn } of Object.values(props)) if (burn) bands[burn] = (bands[burn] ?? 0) + 1
  console.log(`燃料 ${fuels.size} 种；时长分布 ${JSON.stringify(bands)}`)
  const enchantables = Object.entries(props).filter(([, p]) => p.enchantable !== undefined)
  const notOnTable = enchantables.filter(([, p]) => p.enchantingTable === false).map(([id]) => id)
  console.log(`可附魔 ${enchantables.length} 种${notOnTable.length ? `（其中附魔台出不了附魔的：${notOnTable.join('，')}）` : ''}`)
  const trims = Object.entries(props).filter(([, p]) => p.trimMaterial).map(([id, p]) => `${id} → ${p.trimMaterial}`)
  console.log(`纹饰材料 ${trims.length} 种：${trims.join('，')}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
