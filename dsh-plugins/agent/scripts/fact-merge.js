#!/usr/bin/env node
/**
 * 合并事实库里重复的事实（2026-11-07）。默认只演练。
 *
 *   node scripts/fact-merge.js <plan.json>            演练：列出每组合并后的陈述、引用、要移走的事实
 *   node scripts/fact-merge.js <plan.json> --apply    真的合并：keep 写新修订（旧名字记进 aliases），drop 的文件移进 facts/merged/
 *
 * plan.json：[{ "keep": "<名字>", "drop": ["<名字>", …], "statement": "合并后的一句话", "tags"?: [...] }, …]
 * 引用取 keep 与 drop 的并集（去重，至多 maxRefs 条，keep 的在前），并按源码基准重新校验。
 * 跑之前最好先停掉 DSH，免得和正在写事实的回合撞上。
 */
import fs from 'node:fs'
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { FactStore, SourceTree } from '../src/facts/index.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const [planFile] = args.filter((a) => a !== '--apply')
if (!planFile) {
  console.error('usage: node scripts/fact-merge.js <plan.json> [--apply]')
  process.exit(2)
}

const config = normalizeConfig({ logger: null })
const source = new SourceTree({ root: config.facts.sourceRoot, readMaxLines: config.facts.readMaxLines, searchLimit: config.facts.searchLimit })
const store = new FactStore({ dir: config.facts.dir, source, maxRefLines: config.facts.maxRefLines, maxRefs: config.facts.maxRefs })
const plan = JSON.parse(fs.readFileSync(path.resolve(planFile), 'utf8'))

let failed = 0
for (const group of plan) {
  const keep = store.get(group.keep)
  const drops = (group.drop ?? []).map((name) => store.get(name))
  console.log(`\n== ${group.keep}  ← ${(group.drop ?? []).join(', ')}`)
  if (!keep || drops.some((f) => !f)) {
    console.log('   缺少事实：', [group.keep, ...(group.drop ?? [])].filter((n) => !store.get(n)).join(', '))
    failed++
    continue
  }
  console.log(`   陈述：${group.statement}`)
  if (!apply) continue
  const result = store.merge(group, { kind: 'merge-script' })
  if (!result.ok) {
    console.log(`   没有合并：${result.errors.join('；')}`)
    failed++
    continue
  }
  console.log(`   已合并：rev ${result.fact.rev}，引用 ${result.fact.refs.length} 条，aliases ${result.fact.aliases.join(', ')}`)
}
console.log(apply ? `\n完成，失败 ${failed} 组` : '\n（演练；加 --apply 才会合并）')
process.exit(failed ? 1 : 0)
