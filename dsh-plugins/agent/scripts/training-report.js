#!/usr/bin/env node
/**
 * 训练记录汇总（训练场设计方案 T10；工作台训练场设计方案 W9、W10）。
 *
 *   node scripts/training-report.js [场地=craft2x2] [--by target|shape|portions] [--last <N>] [--batch <批次>] [--runtime <dir>]
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
const by = flag('--by') ?? 'target'
if (args.length > 1 || !['target', 'shape', 'portions'].includes(by) || (last !== null && !(Number.isInteger(Number(last)) && Number(last) > 0))) {
  console.error('usage: node scripts/training-report.js [arena] [--by target|shape|portions] [--last <N>] [--batch <id>] [--runtime <dir>]')
  process.exit(2)
}
const config = normalizeConfig({ ...(runtimeDir ? { runtimeDir: path.resolve(runtimeDir) } : {}), logger: null })
const arena = args[0] ?? 'craft2x2'
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
