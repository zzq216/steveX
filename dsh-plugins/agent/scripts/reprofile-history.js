#!/usr/bin/env node
/**
 * 按新口径重算任务历史与训练记录里的成本数字（2026-11-13）。
 *
 *   node scripts/reprofile-history.js [--history <dir>] [--runtime <dir>]           只打印会改什么（不写）
 *   node scripts/reprofile-history.js --write [--history <dir>] [--runtime <dir>]   写回
 *
 * 新口径：成本画像的 mod 调用只算树自己发出的动作与读取；执行器在 Steps / Action 前后的观察读取（calls.observe）
 * 与等稳定读取（calls.settle）单列、不算（history/profile.js 文件头）。旧事件没有 calls.observe，按同一规则换算。
 *
 * 改的东西：
 *   <history>/task-*.json 与 archive/task-*.json：profile 整个重算；metrics 里的 execMs / waitMs / durationMs / modCalls /
 *     actions / reads / nodeRuns 跟着改，另加 observeReads / settleReads
 *   <history>/index.json：每条的 modCalls / execMs
 *   <runtime>/training/*.jsonl：每行的 modCalls / actions / reads（按 taskId 对上历史记录）
 * 事件日志（<runtime>/tasks/<id>/events.jsonl）不在了的任务跳过、原样保留。
 *
 * 插件运行时内存里有一份索引，下一个任务结束时会整份写回 index.json——写回前先停掉 DSH。
 */
import fs from 'node:fs'
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { buildProfile } from '../src/history/profile.js'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? path.resolve(args.splice(i, 2)[1]) : null
}
const historyArg = flag('--history')
const runtimeArg = flag('--runtime')
const writeIndex = args.indexOf('--write')
const write = writeIndex >= 0
if (write) args.splice(writeIndex, 1)
if (args.length) {
  console.error('usage: node scripts/reprofile-history.js [--write] [--history <dir>] [--runtime <dir>]')
  process.exit(2)
}
const config = normalizeConfig({ ...(historyArg ? { historyDir: historyArg } : {}), ...(runtimeArg ? { runtimeDir: runtimeArg } : {}), logger: null })
const historyDir = config.historyDir
const runtimeDir = config.runtimeDir
const options = { top: config.history.profileTop, repeatMin: config.history.repeatMin }

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 1) + '\n')

function eventsOf(taskId) {
  const file = path.join(runtimeDir, 'tasks', taskId, 'events.jsonl')
  if (!fs.existsSync(file)) return null
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim()).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

const recordFiles = [historyDir, path.join(historyDir, 'archive')]
  .filter((dir) => fs.existsSync(dir))
  .flatMap((dir) => fs.readdirSync(dir).filter((name) => /^task-.*\.json$/.test(name)).map((name) => path.join(dir, name)))

const updated = new Map() // taskId → metrics
let skipped = 0
for (const file of recordFiles) {
  const rec = readJson(file)
  const events = eventsOf(rec.taskId)
  const profile = events ? buildProfile(events, options) : null
  if (!profile) {
    skipped++
    continue
  }
  const before = rec.metrics?.modCalls ?? null
  rec.profile = profile
  rec.metrics = {
    ...(rec.metrics ?? {}),
    execMs: profile.execMs, waitMs: profile.waitMs, durationMs: profile.durationMs,
    modCalls: profile.modCalls, actions: profile.actions, reads: profile.reads, nodeRuns: profile.nodeRuns,
    observeReads: profile.observeReads, settleReads: profile.settleReads
  }
  updated.set(rec.taskId, rec.metrics)
  console.log(`${rec.taskId}  mod 调用 ${before ?? '?'} → ${profile.modCalls}（动作 ${profile.actions} / 读取 ${profile.reads}；观察 ${profile.observeReads}、等稳定 ${profile.settleReads} 单列）${file.includes(`${path.sep}archive${path.sep}`) ? '  [archive]' : ''}`)
  if (write) writeJson(file, rec)
}

const indexFile = path.join(historyDir, 'index.json')
let indexChanged = 0
if (fs.existsSync(indexFile)) {
  const index = readJson(indexFile)
  for (const [taskId, row] of Object.entries(index.tasks ?? {})) {
    const m = updated.get(taskId)
    if (!m) continue
    row.modCalls = m.modCalls
    row.execMs = m.execMs
    indexChanged++
  }
  if (write) writeJson(indexFile, index)
}

let trainingChanged = 0
const trainingDir = path.join(runtimeDir, 'training')
if (fs.existsSync(trainingDir)) {
  for (const name of fs.readdirSync(trainingDir).filter((n) => n.endsWith('.jsonl'))) {
    const file = path.join(trainingDir, name)
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const out = lines.map((line) => {
      if (!line.trim()) return line
      let row
      try { row = JSON.parse(line) } catch { return line }
      const m = updated.get(row.taskId)
      if (!m || row.modCalls === undefined) return line
      row.modCalls = m.modCalls
      row.actions = m.actions
      row.reads = m.reads
      trainingChanged++
      return JSON.stringify(row)
    })
    if (write) fs.writeFileSync(file, out.join('\n'))
  }
}

console.log(`\n${write ? '已写回' : '只是预览（加 --write 写回）'}：历史记录 ${updated.size} 条（事件日志不在、跳过 ${skipped} 条），索引 ${indexChanged} 条，训练记录 ${trainingChanged} 行`)
