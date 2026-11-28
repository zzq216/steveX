#!/usr/bin/env node
/**
 * 训练记录汇总（训练场设计方案 T10；工作台训练场设计方案 W9、W10；箱子训练场设计方案 C12）。
 *
 *   node scripts/training-report.js [场地=craft2x2] [--by target|shape|portions|task|chest|stack|fill|targets|materials|styles|yield|family|station|band|kind|slot|enchantment|effect|level|payment|item|second|tasks|pattern|material|group|animal|banners|color|ops|scale|spare|ingredient|bottle|cells|k|profession|chain|curses|hand|ops|edits|dist|weapon|ground|memory|points|edge] [--last <N>] [--batch <批次>] [--runtime <dir>]
 *
 * 箱子场地（type: storage）缺省按 task（取放 / 数量关系）分组，也可以按 chest（箱子大小）、stack（堆叠上限）、fill（每格数量随机 / 取满）、targets（每轮几种目标）、target 分组。
 *
 * 切石机场地（type: stonecut）缺省按 family（材料家族）分组，也可以按 materials（材料种数）、styles（样式数）、yield（每次产出）、target 分组。
 * 熔炉场地（type: cook）缺省按 station（炉子）分组，也可以按 band（燃料燃烧时长档）、target（原料）分组。
 * 附魔台场地（type: enchant）缺省按 kind（物品类别）分组，也可以按 slot（目标档）、enchantment（目标附魔）、target（物品）分组。
 * 信标场地（type: beacon）缺省按 effect（目标效果，I、II 级分开）分组，也可以按 level（底座等级）、payment（付款物品）、target 分组。
 * 铁砧场地（type: anvil）缺省按 task（合并 / 改名 / 合并加改名）分组，也可以按 item（物品）、second（第二件的种类）、target 分组。
 * 坐骑场地（type: mount）缺省按 group（马 / 驴 / 骆驼 / 羊驼 / 鹦鹉螺）分组，也可以按 animal、task、target 分组。
 * 织布机场地（type: loom）缺省按 styles（样式数）分组，也可以按 banners（底色种数）、pattern（图案）、color（颜色）、item（用没用图案物）、target 分组。
 * 酿造台场地（type: brew）缺省按 ingredient（材料）分组，也可以按 bottle（开局瓶子）、kind（药水配方 / 换瓶子配方）、target 分组。
 * 合成器场地（type: crafter）缺省按 cells（配方占几格）分组，也可以按 shape、portions（n）、target 分组。
 * 村民交易场地（type: trade）缺省按 k（几笔交易）分组，也可以按 profession、level、chain（有没有串联交易）分组。
 * 制图台场地（type: cartography）缺省按 task（放大 / 锁定 / 复制 / 连续操作）分组，也可以按 scale（开局缩放等级）、spare（余量）、ops（chain 题的步数）、target 分组。
 * 锻造台场地（type: smithing）缺省按 kind（升级 / 纹饰 / 混合）分组，也可以按 tasks（题数）、pattern（纹饰样式）、material（纹饰材料）、target 分组。
 *
 * 读 runtime/training/<场地>.jsonl，按目标物品（或配方形状）输出成功率、虚报 / 失败 / 超时次数、成功轮的合成与任务中位用时、token 中位数。
 * 带工作站的场地另有"打开工作台"中位用时、工作台被挖掉的轮数，并列出每轮引用了哪些在该场地第一轮之前就有的胶囊。
 */
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { formatPriorCapsules, formatSummary, priorCapsules, readRecords, summarize } from '../src/training/report.js'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : null
}
const runtimeDir = flag('--runtime')
const last = flag('--last')
const batch = flag('--batch')
const byFlag = flag('--by')
if (args.length > 1 || (byFlag !== null && !['target', 'shape', 'portions', 'task', 'chest', 'stack', 'fill', 'targets', 'materials', 'styles', 'yield', 'family', 'station', 'band', 'kind', 'slot', 'enchantment', 'effect', 'level', 'payment', 'item', 'second', 'tasks', 'pattern', 'material', 'group', 'animal', 'banners', 'color', 'ops', 'scale', 'spare', 'ingredient', 'bottle', 'cells', 'k', 'profession', 'chain', 'curses', 'hand', 'edits', 'dist', 'weapon', 'ground', 'memory', 'points', 'edge'].includes(byFlag)) || (last !== null && !(Number.isInteger(Number(last)) && Number(last) > 0))) {
  console.error('usage: node scripts/training-report.js [arena] [--by target|shape|portions|task|chest|stack|fill|targets|materials|styles|yield|family|station|band|kind|slot|enchantment|effect|level|payment|item|second|tasks|pattern|material|group|animal|banners|color|ops|scale|spare|ingredient|bottle|cells|k|profession|chain|curses|hand|ops|edits|dist|weapon|ground|memory|points|edge] [--last <N>] [--batch <id>] [--runtime <dir>]')
  process.exit(2)
}
const config = normalizeConfig({ ...(runtimeDir ? { runtimeDir: path.resolve(runtimeDir) } : {}), logger: null })
const arena = args[0] ?? 'craft2x2'
const DEFAULT_BY = { storage: 'task', stonecut: 'family', cook: 'station', enchant: 'kind', beacon: 'effect', anvil: 'task', smithing: 'kind', mount: 'group', loom: 'styles', cartography: 'task', brew: 'ingredient', crafter: 'cells', trade: 'k', grindstone: 'k', book: 'k', sign: 'kind', bow: 'targets', route: 'ground', goal: 'ground' }
const by = byFlag ?? DEFAULT_BY[config.training.arenas[arena]?.type] ?? 'target'
const file = path.join(config.runtimeDir, 'training', `${arena}.jsonl`)
const records = readRecords(file)
let picked = batch ? records.filter((r) => r.batch === batch) : records
if (last) picked = picked.slice(-Number(last))
const summary = summarize(picked, { by })
console.log(`${file}${batch ? `，批次 ${batch}` : ''}${last ? `，最近 ${last} 轮` : ''}\n`)
console.log(formatSummary(summary))
if (summary.station) {
  // "第一轮"按整份记录算（不受 --batch / --last 影响），只列筛选出的轮次
  const { since, runs } = priorCapsules(records, config.capsulesDir)
  const keep = new Set(picked)
  console.log(`\n${formatPriorCapsules({ since, runs: runs.filter((r) => keep.has(r.record)) })}`)
}
