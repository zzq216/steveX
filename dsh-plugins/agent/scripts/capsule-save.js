#!/usr/bin/env node
/**
 * 把一个胶囊条目存进胶囊库（P1 的 capsule_save 工具走同一个 saveCapsule）。
 *
 *   node scripts/capsule-save.js <entry.json> [--capsules <dir>]
 *   node scripts/capsule-save.js --list [--capsules <dir>]
 *
 * entry.json：{ "folder": "code" | "trees", "name", "description"?, "signature", "body" }
 *   code  的 body 是 TS / JS 源码字符串（定义 function main(params, state)）；也可以写 "bodyFile": "x.ts"（相对 entry.json）
 *   trees 的 body 是一棵树（编写格式或执行格式）
 * 成功打印引用 `文件夹/name@hash`。同内容重复保存不会产生新版本。
 */
import fs from 'node:fs'
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { createCapsules } from '../src/runtime.js'
import { createDefaultRegistry } from '../src/commands.js'
import { saveCapsule } from '../src/capsules/index.js'

const args = process.argv.slice(2)
const dirFlag = args.indexOf('--capsules')
const overrides = dirFlag >= 0 ? { capsulesDir: path.resolve(args.splice(dirFlag, 2)[1]) } : {}
const config = normalizeConfig({ ...overrides, logger: null })
const { library, sandbox } = createCapsules(config)

if (args[0] === '--list') {
  for (const row of library.list()) console.log(`${row.ref.padEnd(40)} ${row.kind.padEnd(9)} ${row.description}`)
  process.exit(0)
}

const file = args[0]
if (!file) {
  console.error('usage: node scripts/capsule-save.js <entry.json> [--capsules <dir>] | --list')
  process.exit(2)
}
const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
const { folder, bodyFile, ...entry } = raw
if (bodyFile) entry.body = fs.readFileSync(path.resolve(path.dirname(file), bodyFile), 'utf8')

const result = saveCapsule({ library, sandbox, registry: createDefaultRegistry() }, folder, entry)
if (!result.ok) {
  console.error(`rejected:\n  ${result.errors.join('\n  ')}`)
  process.exit(1)
}
console.log(`${result.created ? 'saved' : 'already in library'}: ${result.ref}  (${config.capsulesDir})`)
