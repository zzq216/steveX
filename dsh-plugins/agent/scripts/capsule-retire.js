#!/usr/bin/env node
/**
 * 人手动下架 / 撤销下架一个胶囊条目（胶囊库整理设计方案 §5.4；整理回合里的 capsule_retire 走同一个 library.retire）。
 *
 *   node scripts/capsule-retire.js <文件夹/名字> --reason <为什么> [--superseded-by <文件夹/名字>] [--capsules <dir>]
 *   node scripts/capsule-retire.js <文件夹/名字> --undo --reason <为什么撤销> [--capsules <dir>]
 *
 * --reason 必填。改动记进 <库>/curate.jsonl（trigger: "script"）。条目文件不动，带哈希的引用照常能装载。
 */
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { createCapsules } from '../src/runtime.js'
import { checkReason, appendCurateLog } from '../src/capsules/curate.js'

const args = process.argv.slice(2)
const take = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : null
}
const capsulesDir = take('--capsules')
const reason = take('--reason')
const supersededBy = take('--superseded-by')
const undoAt = args.indexOf('--undo')
const undo = undoAt >= 0
if (undo) args.splice(undoAt, 1)
const [ref, ...extra] = args
const why = checkReason(reason, '--reason')
if (!ref || extra.length || why.error) {
  if (why.error && ref) console.error(why.error)
  console.error('usage: node scripts/capsule-retire.js <folder/name> --reason <why> [--superseded-by <folder/name>] [--undo] [--capsules <dir>]')
  process.exit(2)
}

const config = normalizeConfig({ ...(capsulesDir ? { capsulesDir: path.resolve(capsulesDir) } : {}), logger: null })
const { library } = createCapsules(config)
const at = new Date().toISOString()
try {
  const change = undo
    ? { op: 'undo', ...library.unretire(ref), reason: why.reason }
    : { op: 'retire', ...library.retire(ref, { reason: why.reason, supersededBy, at, by: 'script' }) }
  delete change.hash
  appendCurateLog(config.capsulesDir, {
    requestId: null, at, trigger: 'script', outcome: 'done',
    retired: undo ? [] : [change], undone: undo ? [change] : [], described: [], reason: why.reason
  })
  console.log(undo ? `unretired ${change.key}` : `retired ${change.key}${change.after.supersededBy ? ` (superseded by ${change.after.supersededBy})` : ''}`)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
