/**
 * 状态来源的静态词表（I13 补充，2026-10-24）：枚举型字段的全部取值。
 *
 * 词表是接口的一部分——可复用的树要拿这些常量做比较（`state.container.type === 'crafting'`），给大模型看不违反 I13；
 * 不给的是实例值（此刻的格子号、数量、坐标）。一次状态快照里只看得到当前那一个值，统计不出取值范围，
 * 所以这里按 mod 与 MC 源码手工列出，每条都注明出处。mod 加了新的枚举型字段时在这里补。
 */
const MENU_TYPES = [
  'generic_9x1', 'generic_9x2', 'generic_9x3', 'generic_9x4', 'generic_9x5', 'generic_9x6', 'generic_3x3',
  'crafter_3x3', 'anvil', 'beacon', 'blast_furnace', 'brewing_stand', 'crafting', 'enchantment', 'furnace',
  'grindstone', 'hopper', 'lectern', 'loom', 'merchant', 'shulker_box', 'smithing', 'smoker', 'cartography_table',
  'stonecutter'
]

export const STATE_VOCAB = Object.freeze({
  container: Object.freeze({
    type: Object.freeze({
      values: Object.freeze(['none', 'inventory', ...MENU_TYPES]),
      note: 'none = 没有打开容器界面；inventory = 玩家背包（按 E）；其余 = MC 菜单注册名：工作台 crafting、熔炉 furnace、'
        + '箱子 generic_9x3、大箱子 generic_9x6、发射器 / 投掷器 generic_3x3、村民交易 merchant、附魔台 enchantment',
      source: 'vendor/stevex-template-1.21.11/src/main/java/name/modid/api/ContainerApi.java:74-85；'
        + '1.21.11_src/net/minecraft/world/inventory/MenuType.java:12-36'
    })
  })
})

/** 某个来源的词表，渲染成给大模型看的几行文本；没有词表返回空串。 */
export function vocabText(source) {
  const fields = STATE_VOCAB[source]
  if (!fields) return ''
  return Object.entries(fields).map(([field, v]) => {
    return `词表 state.${source}.${field} ∈ ${v.values.map((x) => JSON.stringify(x)).join(' | ')}\n  （${v.note}）`
  }).join('\n')
}
