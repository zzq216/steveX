#!/usr/bin/env node
/**
 * 训练记录汇总（训练场设计方案 T10）。
 *
 *   node scripts/training-report.js [场地=craft2x2] [--last <N>] [--batch <批次>] [--runtime <dir>]
 *
 * 读 runtime/training/<场地>.jsonl，按目标物品输出成功率、虚报 / 失败 / 超时次数、成功轮的合成与任务中位用时、token 中位数。
 */
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { formatSummary, readRecords, summarize } from '../src/training/report.js'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : null
}
const runtimeDir = flag('--runtime')
const last = flag('--last')
const batch = flag('--batch')
if (args.length > 1 || (last !== null && !(Number.isInteger(Number(last)) && Number(last) > 0))) {
  console.error('usage: node scripts/training-report.js [arena] [--last <N>] [--batch <id>] [--runtime <dir>]')
  process.exit(2)
}
const config = normalizeConfig({ ...(runtimeDir ? { runtimeDir: path.resolve(runtimeDir) } : {}), logger: null })
const arena = args[0] ?? 'craft2x2'
const file = path.join(config.runtimeDir, 'training', `${arena}.jsonl`)
console.log(`${file}${batch ? `，批次 ${batch}` : ''}${last ? `，最近 ${last} 轮` : ''}\n`)
console.log(formatSummary(summarize(readRecords(file), { last: last ? Number(last) : null, batch })))
