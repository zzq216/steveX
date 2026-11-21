#!/usr/bin/env node
/**
 * 胶囊改名（src/capsules/rename.js）：旧名字下架、内容按同一哈希搬到新名字下，引用它们的子树换成新名字。默认只演练。
 *
 *   node scripts/capsule-rename.js --map <renames.json>            演练：列出要写的条目、换版本的子树、改说明的条目
 *   node scripts/capsule-rename.js --map <renames.json> --apply    先把整个库目录备份到 <runtime>/backup/capsules-<时间>，再执行
 *   选项：--capsules <dir>  --runtime <dir>
 *
 * renames.json：{ "renames": { "code/old": "code/new", … }, "text"?: { "说明里不带前缀的写法": "新写法", … } }
 * 离线动作：跑之前先停掉 DSH（插件退出时把内存里的使用统计写回 stats.json，会盖掉这里的改动）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { applyRename, planRename } from '../src/capsules/rename.js'

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
const mapFile = take('--map')
const capsulesDir = take('--capsules')
const runtimeDir = take('--runtime')
const apply = has('--apply')
if (args.length || !mapFile) {
  console.error('usage: node scripts/capsule-rename.js --map <renames.json> [--apply] [--capsules <dir>] [--runtime <dir>]')
  process.exit(2)
}

const config = normalizeConfig({ ...(capsulesDir ? { capsulesDir: path.resolve(capsulesDir) } : {}), ...(runtimeDir ? { runtimeDir: path.resolve(runtimeDir) } : {}), logger: null })
const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
const { errors, plan } = planRename({ dir: config.capsulesDir, renames: map.renames, text: map.text ?? {} })
if (errors.length) {
  console.error(`not renamed:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
  process.exit(1)
}

console.log(`${plan.renames.length} renames in ${config.capsulesDir}`)
for (const [from, to] of plan.renames) console.log(`  ${from}  →  ${to}`)
console.log(`\ntrees moved to a new version or name: ${plan.trees.length}`)
for (const t of plan.trees) console.log(`  ${t.from}  →  ${t.to}${t.changed ? '（引用换成新名字）' : ''}`)
console.log(`\nentry files to write: ${plan.files.length}`)
console.log(`descriptions changed: ${plan.descriptions.length}`)
for (const d of plan.descriptions) console.log(`  ${d.key}`)
const left = Object.entries(plan.manifest).filter(([, info]) => !info.retired).flatMap(([key, info]) => plan.renames.filter(([from]) => (info.description ?? '').includes(from.slice(from.indexOf('/') + 1))).map(([from]) => `${key} 的说明里还有 ${from.slice(from.indexOf('/') + 1)}`))
if (left.length) console.log(`\nunprefixed mentions left (add them to "text" if they should change):\n${left.map((l) => `  ${l}`).join('\n')}`)
if (!apply) {
  console.log('\ndry run: nothing written. Re-run with --apply.')
  process.exit(0)
}
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
const backup = path.join(config.runtimeDir, 'backup', `capsules-${stamp}`)
fs.cpSync(config.capsulesDir, backup, { recursive: true })
console.log(`\nbacked up ${config.capsulesDir} → ${backup}`)
const { written, described } = applyRename(plan)
console.log(`wrote ${written} entry files, updated ${described} descriptions in place; manifest, versions.json, stats.json, notes.json updated`)
