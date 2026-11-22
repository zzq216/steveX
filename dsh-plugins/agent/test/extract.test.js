import test from 'node:test'
import assert from 'node:assert/strict'

import { applyConstructorStacks, buildProps, evalBurn, itemTagNames, parseFuels, recipeItemIds } from '../scripts/extract-item-props.js'
import { tagResolver, TAG_PREFIX } from '../scripts/lib/jar.js'

// 熔炉训练场设计方案 K10、F13：燃料表从 FuelValues.java 提取；构造函数里定堆叠上限的物品（斧、锹、锄）

test('evalBurn: Java integer arithmetic, left to right, truncating division', () => {
  assert.equal(evalBurn('i * 100', 200), 20000)
  assert.equal(evalBurn('i * 8 * 10', 200), 16000)
  assert.equal(evalBurn('i * 3 / 2', 200), 300)
  assert.equal(evalBurn('i * 3 / 4', 200), 150)
  assert.equal(evalBurn('i / 4', 200), 50)
  assert.equal(evalBurn('1 + i / 3', 200), 67)
  assert.equal(evalBurn('1 + i * 20', 200), 4001)
  assert.equal(evalBurn('i', 200), 200)
  assert.equal(evalBurn('Math.max(i, 2)', 200), null)
})

const FUEL_SOURCE = `
	public static FuelValues vanillaBurnTimes(HolderLookup.Provider provider, FeatureFlagSet featureFlagSet) {
		return vanillaBurnTimes(provider, featureFlagSet, 200);
	}

	public static FuelValues vanillaBurnTimes(HolderLookup.Provider provider, FeatureFlagSet featureFlagSet, int i) {
		return new FuelValues.Builder(provider, featureFlagSet)
			.add(Items.LAVA_BUCKET, i * 100)
			.add(Blocks.COAL_BLOCK, i * 8 * 10)
			.add(ItemTags.LOGS, i * 3 / 2)
			.add(ItemTags.WOOL_CARPETS, 1 + i / 3)
			.add(Items.STICK, i / 2)
			.add(Items.STICK, i)
			.remove(ItemTags.NON_FLAMMABLE_WOOD)
			.build();
	}
`
const TAGS_SOURCE = `
	public static final TagKey<Item> LOGS = bind("logs");
	public static final TagKey<Item> WOOL_CARPETS = bind("wool_carpets");
	public static final TagKey<Item> NON_FLAMMABLE_WOOD = bind("non_flammable_wood");
`
function tags(map) {
  const files = new Map(Object.entries(map).map(([tag, values]) => [`${TAG_PREFIX}${tag}.json`, JSON.stringify({ values })]))
  return tagResolver(files)
}

test('parseFuels: items, blocks and expanded tags; later entries win; remove drops non-flammable wood', () => {
  const resolveTag = tags({
    logs: ['#minecraft:oak_logs', 'minecraft:crimson_stem'],
    oak_logs: ['minecraft:oak_log', 'minecraft:oak_wood'],
    wool_carpets: ['minecraft:white_carpet'],
    non_flammable_wood: ['minecraft:crimson_stem']
  })
  const items = new Map([['LAVA_BUCKET', { id: 'lava_bucket' }], ['STICK', { id: 'stick' }]])
  const blocks = new Map([['COAL_BLOCK', 'coal_block']])
  const { fuels, problems } = parseFuels(FUEL_SOURCE, { items, blocks, tags: itemTagNames(TAGS_SOURCE), resolveTag })
  assert.deepEqual(problems, [])
  assert.deepEqual(Object.fromEntries(fuels), {
    'minecraft:lava_bucket': 20000, 'minecraft:coal_block': 16000, 'minecraft:oak_log': 300, 'minecraft:oak_wood': 300,
    'minecraft:white_carpet': 67, 'minecraft:stick': 200
  })

  const odd = parseFuels(FUEL_SOURCE.replace('.add(Items.STICK, i)', '.add(Items.STICK, someHelper(i))').replace('ItemTags.WOOL_CARPETS', 'ItemTags.CARPETS'), { items, blocks, tags: itemTagNames(TAGS_SOURCE), resolveTag })
  assert.ok(odd.problems.some((p) => /认不出的时长表达式/.test(p)))
  assert.ok(odd.problems.some((p) => /ItemTags\.CARPETS 没有标签名/.test(p)))
  assert.match(parseFuels('nothing here', { items, blocks, tags: new Map(), resolveTag }).problems[0], /找不到基准值/)
})

test('applyConstructorStacks: properties -> new AxeItem(…) reads the constructor; Item::new and plain classes stay at 64', () => {
  const items = new Map([
    ['IRON_AXE', { id: 'iron_axe', maxStack: 64, ctorClass: 'AxeItem' }],
    ['SIGN', { id: 'oak_sign', maxStack: 64, ctorClass: 'SignItem' }],
    ['BANNER', { id: 'white_banner', maxStack: 64, ctorClass: 'BannerItem' }],
    ['STICK', { id: 'stick', maxStack: 64, ctorClass: null }],
    ['MISSING', { id: 'mystery', maxStack: 64, ctorClass: 'NoSuchItem' }]
  ])
  const sources = {
    AxeItem: 'public class AxeItem extends Item {\n\tpublic AxeItem(ToolMaterial toolMaterial, float f, float g, Item.Properties properties) {\n\t\tsuper(properties.axe(toolMaterial, f, g));\n\t}\n}',
    SignItem: 'public class SignItem extends StandingAndWallBlockItem {\n\tpublic SignItem(Block block, Item.Properties properties) {\n\t\tsuper(block, properties);\n\t}\n}',
    BannerItem: 'public class BannerItem {\n\tpublic BannerItem(Block block, Item.Properties properties) {\n\t\tsuper(block, properties.stacksTo(16));\n\t}\n}'
  }
  const problems = applyConstructorStacks(items, (cls) => sources[cls] ?? null)
  assert.deepEqual([...items.values()].map((i) => [i.id, i.maxStack]), [['iron_axe', 1], ['oak_sign', 64], ['white_banner', 16], ['stick', 64], ['mystery', 64]])
  assert.deepEqual(problems.map((p) => p.id), ['mystery'])
})

test('buildProps: cooking inputs and every fuel are covered, fuels carry burn', () => {
  const items = new Map([
    ['RAW_IRON', { id: 'raw_iron', maxStack: 64, remainderField: null }],
    ['IRON_INGOT', { id: 'iron_ingot', maxStack: 64, remainderField: null }],
    ['COAL', { id: 'coal', maxStack: 64, remainderField: null }],
    ['LAVA_BUCKET', { id: 'lava_bucket', maxStack: 1, remainderField: 'BUCKET' }],
    ['BUCKET', { id: 'bucket', maxStack: 16, remainderField: null }]
  ])
  const cooking = [{ name: 'iron_ingot', type: 'smelting', input: ['minecraft:raw_iron'], result: 'minecraft:iron_ingot', count: 1, time: 200 }]
  assert.deepEqual([...recipeItemIds(cooking)].sort(), ['minecraft:iron_ingot', 'minecraft:raw_iron'])
  const { props, missing } = buildProps(cooking, items, new Map([['minecraft:coal', 1600], ['minecraft:lava_bucket', 20000]]))
  assert.deepEqual(missing, [])
  assert.deepEqual(props, {
    'minecraft:bucket': { maxStack: 16 },
    'minecraft:coal': { maxStack: 64, burn: 1600 },
    'minecraft:iron_ingot': { maxStack: 64 },
    'minecraft:lava_bucket': { maxStack: 1, remainder: 'minecraft:bucket', burn: 20000 },
    'minecraft:raw_iron': { maxStack: 64 }
  })
})

// 附魔台训练场设计方案 N10：可附魔程度、附魔台能出附魔的物品

const TOOL_SOURCE = `
	public static final ToolMaterial WOOD = new ToolMaterial(BlockTags.INCORRECT_FOR_WOODEN_TOOL, 59, 2.0F, 0.0F, 15, ItemTags.WOODEN_TOOL_MATERIALS);
	public static final ToolMaterial GOLD = new ToolMaterial(BlockTags.INCORRECT_FOR_GOLD_TOOL, 32, 12.0F, 0.0F, 22, ItemTags.GOLD_TOOL_MATERIALS);

	private Item.Properties applyCommonProperties(Item.Properties properties) {
		return properties.durability(this.durability).repairable(this.repairItems).enchantable(this.enchantmentValue);
	}
`
const ARMOR_SOURCE = `
	ArmorMaterial GOLD = new ArmorMaterial(
		7, makeDefense(1, 3, 5, 2, 7), 25, SoundEvents.ARMOR_EQUIP_GOLD, 0.0F, 0.0F, ItemTags.REPAIRS_GOLD_ARMOR, EquipmentAssets.GOLD
	);
`
const ITEM_SOURCE = `
		public Item.Properties spear(ToolMaterial toolMaterial, float f) {
			return this.durability(toolMaterial.durability())
				.enchantable(toolMaterial.enchantmentValue())
		}

		public Item.Properties humanoidArmor(ArmorMaterial armorMaterial, ArmorType armorType) {
			return this.durability(armorType.getDurability(armorMaterial.durability()))
				.enchantable(armorMaterial.enchantmentValue())
		}
`

test('materialValues / enchantabilityOf: tool and armor materials, explicit values, constructors, and unknown materials', async () => {
  const { materialValues, enchantabilityOf } = await import('../scripts/extract-item-props.js')
  const m = materialValues(TOOL_SOURCE, ARMOR_SOURCE, ITEM_SOURCE)
  assert.deepEqual(m.problems, [])
  assert.deepEqual([Object.fromEntries(m.tool), Object.fromEntries(m.armor)], [{ WOOD: 15, GOLD: 22 }, { GOLD: 25 }])
  assert.equal(enchantabilityOf('registerItem("bow", BowItem::new, new Item.Properties().durability(384).enchantable(1));', m), 1)
  assert.equal(enchantabilityOf('registerItem("golden_sword", new Item.Properties().sword(ToolMaterial.GOLD, 3.0F, -2.4F));', m), 22)
  assert.equal(enchantabilityOf('registerItem("wooden_axe", properties -> new AxeItem(ToolMaterial.WOOD, 6.0F, -3.2F, properties));', m), 15)
  assert.equal(enchantabilityOf('registerItem("golden_boots", new Item.Properties().humanoidArmor(ArmorMaterials.GOLD, ArmorType.BOOTS));', m), 25)
  assert.equal(enchantabilityOf('registerItem("shield", ShieldItem::new, new Item.Properties().durability(336));', m), null)
  assert.match(enchantabilityOf('registerItem("ruby_sword", new Item.Properties().sword(ToolMaterial.RUBY, 3.0F, -2.4F));', m).problem, /ToolMaterial\.RUBY/)
  const broken = materialValues(TOOL_SOURCE.replace('.enchantable(this.enchantmentValue)', ''), ARMOR_SOURCE, ITEM_SOURCE.replace('.enchantable(armorMaterial.enchantmentValue())', ''))
  assert.equal(broken.problems.length, 2)
})

test('enchantingTableItems: primary items of in_enchanting_table enchantments; buildProps adds every enchantable item', async () => {
  const { enchantingTableItems, buildProps } = await import('../scripts/extract-item-props.js')
  const files = new Map([
    [`${TAG_PREFIX}swords.json`, JSON.stringify({ values: ['minecraft:golden_sword'] })],
    [`${TAG_PREFIX}durability.json`, JSON.stringify({ values: ['#minecraft:swords', 'minecraft:shield'] })],
    ['data/minecraft/tags/enchantment/in_enchanting_table.json', JSON.stringify({ values: ['#minecraft:non_treasure'] })],
    ['data/minecraft/tags/enchantment/non_treasure.json', JSON.stringify({ values: ['minecraft:sharpness', 'minecraft:unbreaking'] })],
    ['data/minecraft/enchantment/sharpness.json', JSON.stringify({ supported_items: '#minecraft:swords' })],
    ['data/minecraft/enchantment/unbreaking.json', JSON.stringify({ supported_items: '#minecraft:durability', primary_items: '#minecraft:swords' })],
    ['data/minecraft/enchantment/mending.json', JSON.stringify({ supported_items: '#minecraft:durability' })]
  ])
  const covered = enchantingTableItems(files, tagResolver(files))
  assert.deepEqual([...covered].sort(), ['minecraft:golden_sword'], 'shield is only a supported item of unbreaking, mending is not on the table')
  const items = new Map([
    ['GOLDEN_SWORD', { id: 'golden_sword', maxStack: 1, remainderField: null, enchantable: 22 }],
    ['SHIELD', { id: 'shield', maxStack: 1, remainderField: null }],
    ['TRIDENT', { id: 'trident', maxStack: 1, remainderField: null, enchantable: 1 }],
    ['BOOK', { id: 'book', maxStack: 64, remainderField: null, enchantable: 1 }]
  ])
  const { props, missing } = buildProps([], items, new Map(), covered)
  assert.deepEqual(missing, [])
  assert.deepEqual(props, {
    'minecraft:book': { maxStack: 64, enchantable: 1 },
    'minecraft:golden_sword': { maxStack: 1, enchantable: 22 },
    'minecraft:trident': { maxStack: 1, enchantable: 1, enchantingTable: false }
  })
})

test('smithing data (锻造台方案 M9): smithing.json entries, trim material keys, trimMaterial on items, smithing items are covered', async () => {
  const { smithingEntry } = await import('../scripts/extract-recipes.js')
  const { trimMaterialKeys, parseItems } = await import('../scripts/extract-item-props.js')
  const tags = { 'minecraft:trimmable_armor': ['minecraft:iron_chestplate', 'minecraft:turtle_helmet'], 'minecraft:trim_materials': ['minecraft:gold_ingot', 'minecraft:redstone'], 'minecraft:netherite_tool_materials': ['minecraft:netherite_ingot'] }
  const ingredient = (spec) => [...new Set([spec].flat().flatMap((id) => (id.startsWith('#') ? tags[id.slice(1)] : [id])))].sort()
  assert.deepEqual(
    smithingEntry('netherite_sword_smithing', { type: 'minecraft:smithing_transform', template: 'minecraft:netherite_upgrade_smithing_template', base: 'minecraft:diamond_sword', addition: '#minecraft:netherite_tool_materials', result: { id: 'minecraft:netherite_sword' } }, ingredient),
    { name: 'netherite_sword_smithing', type: 'transform', template: 'minecraft:netherite_upgrade_smithing_template', base: 'minecraft:diamond_sword', addition: ['minecraft:netherite_ingot'], result: 'minecraft:netherite_sword' })
  assert.deepEqual(
    smithingEntry('sentry', { type: 'minecraft:smithing_trim', template: 'minecraft:sentry_armor_trim_smithing_template', base: '#minecraft:trimmable_armor', addition: '#minecraft:trim_materials', pattern: 'minecraft:sentry' }, ingredient),
    { name: 'sentry', type: 'trim', template: 'minecraft:sentry_armor_trim_smithing_template', base: ['minecraft:iron_chestplate', 'minecraft:turtle_helmet'], addition: ['minecraft:gold_ingot', 'minecraft:redstone'], pattern: 'minecraft:sentry' })
  assert.throws(() => smithingEntry('x', { type: 'minecraft:smithing_trim', template: '#minecraft:trimmable_armor', base: 'a', addition: 'b', pattern: 'p' }, ingredient), /template is not a single item id/)

  const keys = trimMaterialKeys('public static final ResourceKey<TrimMaterial> GOLD = registryKey("gold");\n\tpublic static final ResourceKey<TrimMaterial> LAPIS = registryKey("lapis");')
  assert.deepEqual([...keys], [['GOLD', 'minecraft:gold'], ['LAPIS', 'minecraft:lapis']])
  const source = [
    'public static final Item GOLD_INGOT = registerItem("gold_ingot", new Item.Properties().trimMaterial(TrimMaterials.GOLD));',
    'public static final Item STICK = registerItem("stick");',
    'public static final Item ODD = registerItem("odd", new Item.Properties().trimMaterial(TrimMaterials.UNKNOWN));'
  ].join('\n')
  const { items, problems } = parseItems(source, { ids: new Map(), copper: new Map() }, new Map(), null, keys)
  assert.equal(items.get('GOLD_INGOT').trimMaterial, 'minecraft:gold')
  assert.equal(items.get('STICK').trimMaterial, undefined)
  assert.match(problems.map((p) => p.text).join('\n'), /odd: 认不出的纹饰材料 TrimMaterials\.UNKNOWN/)

  const smithing = [
    { name: 'up', type: 'transform', template: 'minecraft:netherite_upgrade_smithing_template', base: 'minecraft:diamond_sword', addition: ['minecraft:netherite_ingot'], result: 'minecraft:netherite_sword' },
    { name: 'trim', type: 'trim', template: 'minecraft:sentry_armor_trim_smithing_template', base: ['minecraft:iron_chestplate'], addition: ['minecraft:gold_ingot'], pattern: 'minecraft:sentry' }
  ]
  assert.deepEqual([...recipeItemIds(smithing)].sort(), ['minecraft:diamond_sword', 'minecraft:gold_ingot', 'minecraft:iron_chestplate', 'minecraft:netherite_ingot', 'minecraft:netherite_sword', 'minecraft:netherite_upgrade_smithing_template', 'minecraft:sentry_armor_trim_smithing_template'])
  const all = new Map(['diamond_sword', 'gold_ingot', 'iron_chestplate', 'netherite_ingot', 'netherite_sword', 'netherite_upgrade_smithing_template', 'sentry_armor_trim_smithing_template'].map((id) => [id.toUpperCase(), { id, maxStack: id.includes('_s') || id.includes('chestplate') ? 1 : 64, remainderField: null, ...(id === 'gold_ingot' ? { trimMaterial: 'minecraft:gold' } : {}) }]))
  const { props, missing } = buildProps(smithing, all)
  assert.deepEqual(missing, [])
  assert.equal(props['minecraft:gold_ingot'].trimMaterial, 'minecraft:gold')
  assert.equal(props['minecraft:netherite_ingot'].trimMaterial, undefined)
})

test('brewing data (酿造台方案 P10): mixes, start mixes expanded, container recipes, fuel tag, constants; unknown lines are errors', async () => {
  const { parseBrewing, potionNames, brewingItemIds } = await import('../scripts/extract-item-props.js')
  const potions = potionNames([
    'public static final Holder<Potion> WATER = register("water", new Potion("water"));',
    'public static final Holder<Potion> MUNDANE = register("mundane", new Potion("mundane"));',
    'public static final Holder<Potion> AWKWARD = register("awkward", new Potion("awkward"));',
    'public static final Holder<Potion> LEAPING = register(',
    '\t\t"leaping", new Potion("leaping", new MobEffectInstance(MobEffects.JUMP_BOOST, 3600))',
    '\t);'
  ].join('\n'))
  assert.deepEqual([...potions], [['WATER', 'minecraft:water'], ['MUNDANE', 'minecraft:mundane'], ['AWKWARD', 'minecraft:awkward'], ['LEAPING', 'minecraft:leaping']])
  const items = new Map(['POTION', 'SPLASH_POTION', 'GUNPOWDER', 'NETHER_WART', 'RABBIT_FOOT'].map((f) => [f, { id: f.toLowerCase() }]))
  const source = [
    'public class PotionBrewing {',
    '\tpublic static void addVanillaMixes(PotionBrewing.Builder builder) {',
    '\t\tbuilder.addContainer(Items.POTION);',
    '\t\tbuilder.addContainerRecipe(Items.POTION, Items.GUNPOWDER, Items.SPLASH_POTION);',
    '\t\tbuilder.addMix(Potions.WATER, Items.NETHER_WART, Potions.AWKWARD);',
    '\t\tbuilder.addStartMix(Items.RABBIT_FOOT, Potions.LEAPING);',
    '\t}',
    '\tpublic static class Builder {',
    '\t\tpublic void addStartMix(Item item, Holder<Potion> holder) {',
    '\t\t\tif (holder.value().isEnabled(this.enabledFeatures)) {',
    '\t\t\t\tthis.addMix(Potions.WATER, item, Potions.MUNDANE);',
    '\t\t\t\tthis.addMix(Potions.AWKWARD, item, holder);',
    '\t\t\t}',
    '\t\t}',
    '\t}',
    '}'
  ].join('\n')
  const stand = 'public static final int FUEL_USES = 20;\n\t\t\t} else if (!bl || x) {\n\t\t\t\tbrewingStandBlockEntity.brewTime = 0;\n\t\t} else if (bl && brewingStandBlockEntity.fuel > 0) {\n\t\t\tbrewingStandBlockEntity.fuel--;\n\t\t\tbrewingStandBlockEntity.brewTime = 400;'
  const resolveTag = Object.assign((tag) => (tag === 'minecraft:brewing_fuel' ? ['minecraft:blaze_powder'] : []), { has: (tag) => tag === 'minecraft:brewing_fuel' })
  const { brewing, problems } = parseBrewing(source, { items, potions, resolveTag, stand })
  assert.deepEqual(problems, [])
  assert.deepEqual(brewing, {
    fuel: [{ id: 'minecraft:blaze_powder', charges: 20 }],
    containers: [{ id: 'minecraft:potion' }],
    potionMixes: [
      { from: 'minecraft:water', ingredient: 'minecraft:nether_wart', to: 'minecraft:awkward', time: 400 },
      { from: 'minecraft:water', ingredient: 'minecraft:rabbit_foot', to: 'minecraft:mundane', time: 400 },
      { from: 'minecraft:awkward', ingredient: 'minecraft:rabbit_foot', to: 'minecraft:leaping', time: 400 }
    ],
    containerMixes: [{ from: 'minecraft:potion', ingredient: 'minecraft:gunpowder', to: 'minecraft:splash_potion', time: 400 }]
  })
  assert.deepEqual([...brewingItemIds(brewing)].sort(), ['minecraft:blaze_powder', 'minecraft:gunpowder', 'minecraft:nether_wart', 'minecraft:potion', 'minecraft:rabbit_foot', 'minecraft:splash_potion'])
  const odd = parseBrewing(source.replace('builder.addMix(Potions.WATER', 'builder.addFancyMix(Potions.WATER'), { items, potions, resolveTag, stand })
  assert.equal(odd.brewing, null)
  assert.match(odd.problems.join('\n'), /认不出的写法 builder\.addFancyMix/)
  assert.match(parseBrewing(source.replace('Items.NETHER_WART', 'Items.MISSING'), { items, potions, resolveTag, stand }).problems.join('\n'), /Items\.MISSING 没有注册名/)
  assert.match(parseBrewing(source, { items, potions, resolveTag, stand: 'nothing' }).problems.join('\n'), /找不到 FUEL_USES/)
})

test('brewing data (酿造台方案 P10): the extracted brewing.json matches 1.21.11 (41 mixes + 2×11 start mixes, 2 container recipes, blaze powder)', async () => {
  const { readFile } = await import('node:fs/promises')
  const brewing = JSON.parse(await readFile(new URL('../data/brewing.json', import.meta.url), 'utf8'))
  assert.equal(brewing.potionMixes.length, 63)
  assert.equal(brewing.containerMixes.length, 2)
  assert.deepEqual(brewing.fuel, [{ id: 'minecraft:blaze_powder', charges: 20 }])
  assert.deepEqual(brewing.containers.map((c) => c.id), ['minecraft:potion', 'minecraft:splash_potion', 'minecraft:lingering_potion'])
  assert.ok(brewing.potionMixes.every((m) => m.time === 400 && m.from.startsWith('minecraft:') && m.to.startsWith('minecraft:')))
  const props = JSON.parse(await readFile(new URL('../data/item-props.json', import.meta.url), 'utf8')).items
  for (const m of [...brewing.potionMixes, ...brewing.containerMixes]) assert.ok(props[m.ingredient], `${m.ingredient} is in item-props`)
  assert.equal(props['minecraft:turtle_helmet'].maxStack, 1)
  assert.equal(props['minecraft:potion'].maxStack, 1)
})
