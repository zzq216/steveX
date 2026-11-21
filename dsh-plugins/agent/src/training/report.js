import fs from 'node:fs'
import path from 'node:path'

/**
 * 训练记录汇总（训练场设计方案 T10）：按目标物品（或配方形状）看成功率、用时、虚报率、token。
 * 带工作站的场地另有"打开工作台"中位用时、工作台被挖掉的轮数（工作台训练场设计方案 W9），
 * 以及每轮引用了哪些在本场地第一轮之前就有的胶囊（W10）。
 * 箱子场地（箱子训练场设计方案 C12）：按 取放 × 数量关系、箱子大小、堆叠上限分组；多出"动了别的""丢失"两种结果，
 * 用时看"打开箱子""达成"（恰好搬完的那一刻）与任务用时。
 * 切石机场地（切石机训练场设计方案 Q10）：按材料种数、样式数、每次产出、材料家族分组；多出"切错"（miscut）。
 * 熔炉场地（熔炉训练场设计方案 K9）：按炉子、燃料燃烧时长档分组；多出"放错"（misplaced）。
 * 附魔台场地（附魔台训练场设计方案 N9）：按物品类别、目标档、目标附魔分组；多出"附错"（misenchanted）和"预览不一致"。
 * 信标场地（信标训练场设计方案 G8）：按目标效果、底座等级、付款物品分组；多出"多付""设错过""越界"。
 * 铁砧场地（铁砧训练场设计方案 A8）：按任务、物品、第二件物品的种类分组；多出"多次取出""多花经验""名字错"。
 */

export function readRecords(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

const pct = (n, total) => (total ? `${Math.round((n / total) * 100)}%` : '-')
const secs = (ms) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)}s`)

/**
 * @param {object[]} records
 * @param {{ last?: number|null, batch?: string|null, by?: 'target'|'shape'|'portions'|'task'|'chest'|'stack'|'fill'|'targets'|'materials'|'styles'|'yield'|'family'|'station'|'band'|'kind'|'slot'|'enchantment'|'effect'|'level'|'payment'|'item'|'second' }} [filter]
 * @returns {{ rows: object[], total: object, by: string, station: boolean, multi: boolean, storage: boolean, cutter: boolean, cooker: boolean, enchanter: boolean, beaconer: boolean, anviler: boolean }}
 *   station = 记录里有工作站字段；multi = 有多份模式的轮次（T14，多出"超量""做够中位"两列）；storage = 箱子题的记录（换一套列）；cutter = 切石题的记录；cooker = 熔炉题的记录；enchanter = 附魔台题的记录；beaconer = 信标题的记录；anviler = 铁砧题的记录
 */
export function summarize(records, { last = null, batch = null, by = 'target' } = {}) {
  let picked = batch ? records.filter((r) => r.batch === batch) : records
  if (last) picked = picked.slice(-last)
  const station = picked.some((r) => r.stationIntact !== null && r.stationIntact !== undefined)
  const multi = picked.some((r) => r.single === false)
  const storage = picked.some((r) => r.kind === 'take' || r.kind === 'put')
  const cutter = picked.some(isCutterRecord)
  const cooker = picked.some(isCookRecord)
  const enchanter = picked.some(isEnchantRecord)
  const beaconer = picked.some(isBeaconRecord)
  const anviler = picked.some(isAnvilRecord)
  // 任务历史（任务历史方案 H10）：记录里有 assessed 字段才显示这几列
  const historyCols = picked.some((r) => r.assessed !== undefined)
  const group = (list) => {
    const count = (outcome) => list.filter((r) => r.outcome === outcome).length
    const success = list.filter((r) => r.outcome === 'success')
    const tokens = list.map((r) => r.tokens?.total).filter((n) => Number.isInteger(n))
    return {
      runs: list.length,
      success: count('success'),
      falseSuccess: count('false_success'),
      craftedButFailed: count('crafted_but_failed'),
      failed: count('failed'),
      timeout: count('timeout'),
      aborted: count('aborted'),
      overshoot: count('overshoot'),
      disturbed: count('disturbed'),
      lost: count('lost'),
      miscut: count('miscut'),
      misplaced: count('misplaced'),
      misenchanted: count('misenchanted'),
      previewMismatch: list.filter((r) => r.matchedPreview === false).length,
      overpaid: list.filter((r) => Number.isInteger(r.paid) && r.paid > 1).length,
      wrongSet: list.filter((r) => r.wrongSets > 0).length,
      illegal: list.filter((r) => r.illegal === true).length,
      multiTake: list.filter((r) => Array.isArray(r.takes) && r.takes.length > 1).length,
      overspent: list.filter((r) => Number.isInteger(r.levelsUsed) && Number.isInteger(r.cost) && r.levelsUsed > r.cost).length,
      nameWrong: list.filter((r) => r.nameWrong === true).length,
      assessed: list.filter((r) => r.assessed).length,
      withIssues: list.filter((r) => r.assessed && r.issues > 0).length,
      withPredecessor: list.filter((r) => (r.predecessors ?? []).length > 0).length,
      reviewed: list.reduce((n, r) => n + (r.reviewed ?? 0), 0),
      resolved: list.reduce((n, r) => n + (r.resolved ?? 0), 0),
      medianModCalls: median(success.map((r) => r.modCalls).filter((n) => Number.isInteger(n))),
      medianReachedMs: median(success.map((r) => r.reachedMs).filter((n) => n !== null && n !== undefined)),
      medianCraftedMs: median(success.map((r) => r.craftedMs).filter((n) => n !== null)),
      medianOpenedMs: median(success.map((r) => r.openedMs).filter((n) => n !== null && n !== undefined)),
      medianTaskMs: median(success.map((r) => r.taskMs).filter((n) => n !== null)),
      medianTokens: median(tokens),
      chatSend: list.filter((r) => r.usedChatSend).length,
      stationBroken: list.filter((r) => r.stationIntact === false).length
    }
  }
  const groups = new Map()
  for (const r of picked) {
    const key = groupKey(r, by) ?? '（未记录）'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const rows = [...groups].map(([key, list]) => ({ key, ...group(list) })).sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key))
  return { rows, total: { key: '（合计）', ...group(picked) }, by, station, multi, storage, cutter, cooker, enchanter, beaconer, anviler, historyCols }
}

/** 切石题的记录：materials 是 [{ id, family, styles }]（合成题的材料字段叫 items） */
const isCutterRecord = (r) => Array.isArray(r.materials)
/** 熔炉题的记录：有 cookTicks（K9） */
const isCookRecord = (r) => typeof r.cookTicks === 'number'
/** 附魔台题的记录：有 goal（目标档和附魔）和 offers（三档预览） */
const isEnchantRecord = (r) => Boolean(r.goal && Array.isArray(r.offers))
/** 信标题的记录：有底座等级和付款物品（G8） */
const isBeaconRecord = (r) => Number.isInteger(r.beaconLevel) && typeof r.payment?.item === 'string'
/** 铁砧题的记录：task 是 merge / rename / both，有 levelsUsed 字段（A8） */
const isAnvilRecord = (r) => ['merge', 'rename', 'both'].includes(r.task) && 'levelsUsed' in r

const ANVIL_TASK_NAMES = { merge: '合并', rename: '改名', both: '合并加改名' }
const ANVIL_SECOND_NAMES = { same: '同种物品', book: '附魔书' }

/** 信标题按目标效果分组的键：speed II；再生题都归在 regeneration（G8） */
function beaconEffectKey(r) {
  const wants = r.goal?.effects ?? []
  if (wants.some((w) => w.effect === 'minecraft:regeneration')) return 'regeneration'
  const w = wants[0]
  return w ? `${w.effect.replace(/^minecraft:/, '')} ${w.amplifier === 2 ? 'II' : 'I'}` : null
}

const KIND_NAMES = { sword: '剑', pickaxe: '镐', axe: '斧', shovel: '锹', hoe: '锄', spear: '矛', helmet: '头盔', chestplate: '胸甲', leggings: '护腿', boots: '靴子', bow: '弓', crossbow: '弩', trident: '三叉戟', mace: '重锤', fishing_rod: '钓鱼竿', book: '书' }

const STATION_NAMES = { furnace: '熔炉', blast_furnace: '高炉', smoker: '烟熏炉' }

const CHEST_NAMES = { small: '小箱子', large: '大箱子', hopper: '漏斗', dispenser: '发射器' }
const FILL_NAMES = { random: '随机数量', full: '每格满' }

function groupKey(r, by) {
  if (by === 'shape') return r.shape
  if (by === 'portions') return portionsKey(r)
  if (by === 'task') return isAnvilRecord(r) ? ANVIL_TASK_NAMES[r.task] : r.kind && r.rel ? `${r.kind}/${r.rel}` : null
  if (by === 'chest') return CHEST_NAMES[r.chest] ?? null
  if (by === 'stack') return Number.isInteger(r.stackClass) ? String(r.stackClass) : null
  // 加 fill 之前的箱子记录都是随机数量
  if (by === 'fill') return r.kind ? FILL_NAMES[r.fill ?? 'random'] : null
  // 加 targets 之前的箱子记录都是一种目标（§9 C26）
  if (by === 'targets') return r.kind ? `${r.targetCount ?? 1} 种` : null
  // 切石题（Q10）
  if (by === 'materials') return isCutterRecord(r) ? `${r.materialCount} 种材料` : null
  if (by === 'styles') return isCutterRecord(r) ? `${r.targetCount} 种样式` : null
  if (by === 'yield') return isCutterRecord(r) ? [...new Set(r.materials.flatMap((m) => m.styles.map((s) => s.yield)))].sort((a, b) => a - b).map((y) => `×${y}`).join('+') : null
  if (by === 'family') return isCutterRecord(r) ? r.materials.map((m) => m.family).sort().join('+') : null
  // 熔炉题（K9）
  if (by === 'station') return isCookRecord(r) ? STATION_NAMES[r.station] ?? r.station : null
  if (by === 'band') return isCookRecord(r) ? `燃烧 ${r.fuel.band}` : null
  // 附魔台题（N9）
  if (by === 'kind') return isEnchantRecord(r) ? KIND_NAMES[r.item?.kind] ?? r.item?.kind ?? null : null
  if (by === 'slot') return isEnchantRecord(r) ? `第 ${r.goal.slot} 档` : null
  if (by === 'enchantment') return isEnchantRecord(r) ? r.goal.enchantment.replace(/^minecraft:/, '') : null
  // 信标题（G8）
  if (by === 'effect') return isBeaconRecord(r) ? beaconEffectKey(r) : null
  if (by === 'level') return isBeaconRecord(r) ? `底座 ${r.beaconLevel} 级` : null
  if (by === 'payment') return isBeaconRecord(r) ? r.payment.item.replace(/^minecraft:/, '') : null
  // 铁砧题（A8）
  if (by === 'item') return isAnvilRecord(r) && typeof r.item === 'string' ? r.item.replace(/^minecraft:/, '') : null
  if (by === 'second') return isAnvilRecord(r) ? (r.second ? ANVIL_SECOND_NAMES[r.second.kind] ?? r.second.kind : '无（改名）') : null
  return r.target
}

/** --by portions 的分组键：n/m；单次模式记"单次"；T14 之前的记录没有这些字段 → null */
function portionsKey(r) {
  if (r.single === true) return '单次'
  return Number.isInteger(r.portions) && Number.isInteger(r.crafts) ? `${r.portions}/${r.crafts}` : null
}

const BY_LABEL = { target: '目标', shape: '形状', portions: 'n/m', task: '取放/关系', chest: '箱子', stack: '堆叠上限', fill: '每格数量', targets: '目标数', materials: '材料种数', styles: '样式数', yield: '每次产出', family: '材料家族', station: '炉子', band: '燃料档', kind: '物品类别', slot: '目标档', enchantment: '目标附魔', effect: '目标效果', level: '底座等级', payment: '付款物品', item: '物品', second: '第二件' }

export function formatSummary({ rows, total, by = 'target', station = false, multi = false, storage = false, cutter = false, cooker = false, enchanter = false, beaconer = false, anviler = false, historyCols = false }) {
  if (total.runs === 0) return '没有训练记录'
  if (anviler) return formatAnvil({ rows, total, by, historyCols })
  if (beaconer) return formatBeacon({ rows, total, by, historyCols })
  if (enchanter) return formatEnchant({ rows, total, by, historyCols })
  if (cooker) return formatCook({ rows, total, by, historyCols })
  if (cutter) return formatCutter({ rows, total, by, historyCols })
  if (storage) return formatStorage({ rows, total, by, historyCols })
  const head = [BY_LABEL[by] ?? '目标', '轮数', '成功率', '虚报', '做出但报失败', '失败', '超时', '中止', ...(multi ? ['超量'] : []),
    ...(station ? ['打开工作台中位'] : []), '合成中位', ...(multi ? ['做够中位'] : []), '任务中位', 'token中位', '用过chat/send', ...(station ? ['工作台被挖'] : []),
    ...(historyCols ? ['mod调用中位', '评估提出问题', '有前驱', '前驱问题解决'] : [])]
  const line = (r) => [r.key, r.runs, pct(r.success, r.runs), r.falseSuccess, r.craftedButFailed, r.failed, r.timeout, r.aborted, ...(multi ? [r.overshoot] : []),
    ...(station ? [secs(r.medianOpenedMs)] : []), secs(r.medianCraftedMs), ...(multi ? [secs(r.medianReachedMs)] : []), secs(r.medianTaskMs), r.medianTokens ?? '-', r.chatSend,
    ...(station ? [r.stationBroken] : []),
    ...(historyCols ? [r.medianModCalls ?? '-', pct(r.withIssues, r.assessed), pct(r.withPredecessor, r.runs), r.reviewed ? `${r.resolved}/${r.reviewed}` : '-'] : [])].join('\t')
  return [head.join('\t'), ...rows.map(line), line(total)].join('\n')
}

/** 箱子题的表（C12）：没有合成相关的列；达成中位 = 恰好搬完那一刻（只算成功轮） */
function formatStorage({ rows, total, by, historyCols }) {
  const head = [BY_LABEL[by] ?? '目标', '轮数', '成功率', '虚报', '失败', '超时', '中止', '超量', '动了别的', '丢失',
    '打开箱子中位', '达成中位', '任务中位', 'token中位', '用过chat/send', '箱子被挖',
    ...(historyCols ? ['mod调用中位', '评估提出问题', '有前驱', '前驱问题解决'] : [])]
  const line = (r) => [r.key, r.runs, pct(r.success, r.runs), r.falseSuccess, r.failed, r.timeout, r.aborted, r.overshoot, r.disturbed, r.lost,
    secs(r.medianOpenedMs), secs(r.medianReachedMs), secs(r.medianTaskMs), r.medianTokens ?? '-', r.chatSend, r.stationBroken,
    ...(historyCols ? [r.medianModCalls ?? '-', pct(r.withIssues, r.assessed), pct(r.withPredecessor, r.runs), r.reviewed ? `${r.resolved}/${r.reviewed}` : '-'] : [])].join('\t')
  return [head.join('\t'), ...rows.map(line), line(total)].join('\n')
}

/** 切石题的表（Q10）："切错" = 出现了题目没要的产物；达成中位 = 恰好切完那一刻（只算成功轮） */
function formatCutter({ rows, total, by, historyCols }) {
  const head = [BY_LABEL[by] ?? '目标', '轮数', '成功率', '虚报', '失败', '超时', '中止', '超量', '切错', '丢失',
    '打开切石机中位', '达成中位', '任务中位', 'token中位', '用过chat/send', '切石机被挖',
    ...(historyCols ? ['mod调用中位', '评估提出问题', '有前驱', '前驱问题解决'] : [])]
  const line = (r) => [r.key, r.runs, pct(r.success, r.runs), r.falseSuccess, r.failed, r.timeout, r.aborted, r.overshoot, r.miscut, r.lost,
    secs(r.medianOpenedMs), secs(r.medianReachedMs), secs(r.medianTaskMs), r.medianTokens ?? '-', r.chatSend, r.stationBroken,
    ...(historyCols ? [r.medianModCalls ?? '-', pct(r.withIssues, r.assessed), pct(r.withPredecessor, r.runs), r.reviewed ? `${r.resolved}/${r.reviewed}` : '-'] : [])].join('\t')
  return [head.join('\t'), ...rows.map(line), line(total)].join('\n')
}

/** 附魔台题的表（N9）："附错" = 附魔了但没有目标附魔；"预览不一致" = 实际附魔和预览的目标档结果对不上（不是 agent 的问题）；达成中位 = 附魔好、关掉界面的那一刻（只算成功轮） */
function formatEnchant({ rows, total, by, historyCols }) {
  const head = [BY_LABEL[by] ?? '目标', '轮数', '成功率', '虚报', '失败', '超时', '中止', '附错', '丢失', '预览不一致',
    '打开附魔台中位', '达成中位', '任务中位', 'token中位', '用过chat/send', '附魔台被挖',
    ...(historyCols ? ['mod调用中位', '评估提出问题', '有前驱', '前驱问题解决'] : [])]
  const line = (r) => [r.key, r.runs, pct(r.success, r.runs), r.falseSuccess, r.failed, r.timeout, r.aborted, r.misenchanted, r.lost, r.previewMismatch,
    secs(r.medianOpenedMs), secs(r.medianReachedMs), secs(r.medianTaskMs), r.medianTokens ?? '-', r.chatSend, r.stationBroken,
    ...(historyCols ? [r.medianModCalls ?? '-', pct(r.withIssues, r.assessed), pct(r.withPredecessor, r.runs), r.reviewed ? `${r.resolved}/${r.reviewed}` : '-'] : [])].join('\t')
  return [head.join('\t'), ...rows.map(line), line(total)].join('\n')
}

/**
 * 信标题的表（G8）："多付" = 付了不止一次；"设错过" = 有一次设出的效果不满足要求（最后改对了也算）；
 * "越界" = 最终设置是原版界面设不出来的；达成中位 = 设好、关掉界面的那一刻（只算成功轮）
 */
function formatBeacon({ rows, total, by, historyCols }) {
  const head = [BY_LABEL[by] ?? '目标', '轮数', '成功率', '虚报', '失败', '超时', '中止', '丢失', '多付', '设错过', '越界',
    '打开信标中位', '达成中位', '任务中位', 'token中位', '用过chat/send', '信标被挖',
    ...(historyCols ? ['mod调用中位', '评估提出问题', '有前驱', '前驱问题解决'] : [])]
  const line = (r) => [r.key, r.runs, pct(r.success, r.runs), r.falseSuccess, r.failed, r.timeout, r.aborted, r.lost, r.overpaid, r.wrongSet, r.illegal,
    secs(r.medianOpenedMs), secs(r.medianReachedMs), secs(r.medianTaskMs), r.medianTokens ?? '-', r.chatSend, r.stationBroken,
    ...(historyCols ? [r.medianModCalls ?? '-', pct(r.withIssues, r.assessed), pct(r.withPredecessor, r.runs), r.reviewed ? `${r.resolved}/${r.reviewed}` : '-'] : [])].join('\t')
  return [head.join('\t'), ...rows.map(line), line(total)].join('\n')
}

/**
 * 铁砧题的表（A8）："多次取出" = 取出产物不止一次；"多花经验" = 实际花掉的等级比预览的花费（A 放左、B 放右一次做完）多；
 * "名字错" = 附魔对、名字不对，或者合并题多改了名；达成中位 = 目标物品第一次出现在物品栏里的那一刻（只算成功轮）
 */
function formatAnvil({ rows, total, by, historyCols }) {
  const head = [by === 'task' ? '任务' : BY_LABEL[by] ?? '目标', '轮数', '成功率', '虚报', '失败', '超时', '中止', '丢失', '多次取出', '多花经验', '名字错',
    '打开铁砧中位', '达成中位', '任务中位', 'token中位', '用过chat/send', '铁砧被挖',
    ...(historyCols ? ['mod调用中位', '评估提出问题', '有前驱', '前驱问题解决'] : [])]
  const line = (r) => [r.key, r.runs, pct(r.success, r.runs), r.falseSuccess, r.failed, r.timeout, r.aborted, r.lost, r.multiTake, r.overspent, r.nameWrong,
    secs(r.medianOpenedMs), secs(r.medianReachedMs), secs(r.medianTaskMs), r.medianTokens ?? '-', r.chatSend, r.stationBroken,
    ...(historyCols ? [r.medianModCalls ?? '-', pct(r.withIssues, r.assessed), pct(r.withPredecessor, r.runs), r.reviewed ? `${r.resolved}/${r.reviewed}` : '-'] : [])].join('\t')
  return [head.join('\t'), ...rows.map(line), line(total)].join('\n')
}

/** 熔炉题的表（K9）："放错" = 原料格 / 燃料格里有别的东西或出现了额外物品；"放多" = 烧掉的原料或燃料超过要求；达成中位 = 恰好放好的那一刻（只算成功轮） */
function formatCook({ rows, total, by, historyCols }) {
  const head = [BY_LABEL[by] ?? '目标', '轮数', '成功率', '虚报', '失败', '超时', '中止', '放多', '放错', '丢失',
    '打开炉子中位', '达成中位', '任务中位', 'token中位', '用过chat/send', '炉子被挖',
    ...(historyCols ? ['mod调用中位', '评估提出问题', '有前驱', '前驱问题解决'] : [])]
  const line = (r) => [r.key, r.runs, pct(r.success, r.runs), r.falseSuccess, r.failed, r.timeout, r.aborted, r.overshoot, r.misplaced, r.lost,
    secs(r.medianOpenedMs), secs(r.medianReachedMs), secs(r.medianTaskMs), r.medianTokens ?? '-', r.chatSend, r.stationBroken,
    ...(historyCols ? [r.medianModCalls ?? '-', pct(r.withIssues, r.assessed), pct(r.withPredecessor, r.runs), r.reviewed ? `${r.resolved}/${r.reviewed}` : '-'] : [])].join('\t')
  return [head.join('\t'), ...rows.map(line), line(total)].join('\n')
}

/**
 * 每轮引用了哪些"本场地第一轮之前就有"的胶囊（W10，看 2×2 时期的胶囊有没有迁移过来）。
 * 条目文件按内容哈希命名、只写一次，文件的修改时间就是它的创建时间；归档（下架）了的到 archive/ 下找。
 * 内置胶囊、草稿（task/）不在库目录里，不算。
 * @param {object[]} records  同一场地的全部记录（第一轮取 records[0].t0）
 * @param {string} capsulesDir
 * @returns {{ since: string|null, runs: Array<{ batch, run, target, outcome, refs: string[], record }> }}  record = 原记录对象
 */
export function priorCapsules(records, capsulesDir) {
  const since = records.find((r) => r.t0)?.t0 ?? null
  if (!since || !capsulesDir) return { since, runs: [] }
  const cutoff = Date.parse(since)
  const created = new Map()
  const createdAt = (ref) => {
    if (!created.has(ref)) created.set(ref, entryMtime(capsulesDir, ref))
    return created.get(ref)
  }
  const runs = []
  for (const r of records) {
    const refs = (r.capsules ?? []).filter((ref) => {
      const at = createdAt(ref)
      return at !== null && at < cutoff
    })
    if (refs.length) runs.push({ batch: r.batch, run: r.run, target: r.target, outcome: r.outcome, refs, record: r })
  }
  return { since, runs }
}

function entryMtime(capsulesDir, ref) {
  const at = ref.lastIndexOf('@')
  const slash = ref.indexOf('/')
  if (at < 0 || slash < 0) return null
  const folder = ref.slice(0, slash)
  const file = `${ref.slice(slash + 1, at)}@${ref.slice(at + 1)}.json`
  const candidates = [path.join(capsulesDir, folder, file)]
  const archive = path.join(capsulesDir, 'archive')
  if (fs.existsSync(archive)) for (const day of fs.readdirSync(archive)) candidates.push(path.join(archive, day, folder, file))
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.statSync(candidate).mtimeMs
  }
  return null
}

export function formatPriorCapsules({ since, runs }) {
  if (!since) return ''
  if (runs.length === 0) return `第一轮（${since}）之前就有的胶囊：没有一轮引用过`
  const counts = new Map()
  for (const { refs } of runs) for (const ref of refs) counts.set(ref, (counts.get(ref) ?? 0) + 1)
  const lines = [`引用了第一轮（${since}）之前就有的胶囊的轮次：${runs.length}`]
  for (const r of runs) lines.push(`  ${r.batch} #${r.run} ${r.target} ${r.outcome}：${r.refs.join(', ')}`)
  lines.push('按胶囊：')
  for (const [ref, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) lines.push(`  ${ref}\t${n} 轮`)
  return lines.join('\n')
}
