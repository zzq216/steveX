#!/usr/bin/env node
/**
 * 胶囊使用统计（胶囊库整理设计方案 §3）。
 *
 *   node scripts/capsule-stats.js [--capsules <dir>]                      打印每个条目的统计摘要（同名各版本加总）
 *   node scripts/capsule-stats.js --rebuild [--runtime <dir>] [--capsules <dir>]
 *       从 runtime/tasks/*\/events.jsonl 全量重算 stats.json（整理计数保留）。runtime/ 被清理过就只能重算到剩下的部分
 *
 * 平时不用跑：插件在每个任务结束时自动累计。改动之前的事件没有 ref，重算不出来（D4）。
 */
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { createCapsules } from '../src/runtime.js'
import { rebuildStats, usageSummary } from '../src/capsules/index.js'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? path.resolve(args.splice(i, 2)[1]) : null
}
const capsulesDir = flag('--capsules')
const runtimeDir = flag('--runtime')
const config = normalizeConfig({ ...(capsulesDir ? { capsulesDir } : {}), ...(runtimeDir ? { runtimeDir } : {}), logger: null })
const { library, stats } = createCapsules(config)

if (args[0] === '--rebuild') {
  const result = rebuildStats(stats, config.runtimeDir)
  console.log(`rebuilt from ${result.tasks} task logs in ${config.runtimeDir}: ${result.recorded} finished tasks, ${result.refs} refs → ${stats.file}`)
  process.exit(0)
}
if (args.length) {
  console.error('usage: node scripts/capsule-stats.js [--rebuild] [--runtime <dir>] [--capsules <dir>]')
  process.exit(2)
}

for (const row of library.list().filter((r) => !r.draft)) {
  const key = row.ref.slice(0, row.ref.lastIndexOf('@'))
  console.log(`${row.ref.padEnd(44)} ${row.kind.padEnd(9)} ${row.retired ? '[已下架] ' : ''}${usageSummary(stats.byName(key)?.total ?? null, row.kind, key)}`)
}
const curate = stats.curateState()
console.log(`\n统计了 ${stats.data.tasks.length} 个任务；上次整理 ${curate.lastAt ?? '（还没有）'}，之后结束了 ${curate.sinceLast} 个任务`)
