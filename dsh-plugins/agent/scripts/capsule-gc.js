#!/usr/bin/env node
/**
 * 胶囊库 GC（胶囊库整理设计方案 §6）：把没有任何已保存的树引用的旧版本移进 archive/。默认只演练。
 *
 *   node scripts/capsule-gc.js                    演练：列出会被归档的条目与保留的理由
 *   node scripts/capsule-gc.js --apply            真的归档（移到 <库>/archive/<日期>/…，archive/index.jsonl 记一行）
 *   选项：--keep-days <n>（默认 30：最近 n 天用过的不收）  --capsules <dir>  --runtime <dir>  --verbose（列出全部保留项）
 *
 * 不在插件运行时跑：GC 是离线动作（算法层 §8.6）。跑之前最好先停掉 DSH，免得和正在写库的复盘撞上。
 */
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { createCapsules } from '../src/runtime.js'
import { planGc, applyGc } from '../src/capsules/gc.js'

const args = process.argv.slice(2)
const take = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : null
}
const has = (name) => {
  const i = args.indexOf(name)
  if (i >= 0) args.splice(i, 1)
  return i >= 0
}
const capsulesDir = take('--capsules')
const runtimeDir = take('--runtime')
const keepDays = Number(take('--keep-days') ?? 30)
const apply = has('--apply')
const verbose = has('--verbose')
if (args.length || !Number.isFinite(keepDays) || keepDays < 0) {
  console.error('usage: node scripts/capsule-gc.js [--apply] [--keep-days <n>] [--capsules <dir>] [--runtime <dir>] [--verbose]')
  process.exit(2)
}

const config = normalizeConfig({ ...(capsulesDir ? { capsulesDir: path.resolve(capsulesDir) } : {}), ...(runtimeDir ? { runtimeDir: path.resolve(runtimeDir) } : {}), logger: null })
const { stats } = createCapsules(config)
const plan = planGc({ dir: config.capsulesDir, runtimeDir: config.runtimeDir, fastTreeDir: config.fastTreeDir, stats, keepDays })

console.log(`${plan.entries} entries in ${config.capsulesDir}; keep ${plan.entries - plan.collect.length}, archive ${plan.collect.length}`)
if (verbose) for (const [ref, why] of plan.keep) console.log(`  keep    ${ref.padEnd(44)} ${why}`)
for (const { ref } of plan.collect) console.log(`  archive ${ref}`)
if (!apply) {
  if (plan.collect.length) console.log('\ndry run: nothing moved. Re-run with --apply to archive.')
  process.exit(0)
}
const { archived } = applyGc({ dir: config.capsulesDir, plan, stats })
console.log(`\narchived ${archived.length} entries under ${path.join(config.capsulesDir, 'archive')}`)
