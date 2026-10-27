#!/usr/bin/env node
/**
 * 不启动 DSH，直连 mod 跑一棵手写树（P0 调试入口，与 /bt run 是同一套运行时）。
 *
 *   node scripts/bt-run.js <tree.json> [--fast <fast.json>] [--url ws://127.0.0.1:25550] [--quiet]
 *
 * 路径相对当前目录。前提：采集端 mod 已进入世界（npm run mc:capture）。
 * Ctrl+C：放弃任务（松键、关容器）后退出。任务结束（done / failed）后自动退出。
 * 事件日志写在 steveX/runtime/tasks/<taskId>/。
 */
import fs from 'node:fs'
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { createRuntime } from '../src/runtime.js'
import { waitForConnection } from '../src/game/index.js'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const value = args[i + 1]
  args.splice(i, 2)
  return value
}
const fastPath = flag('--fast')
const url = flag('--url')
const quiet = args.includes('--quiet')
if (quiet) args.splice(args.indexOf('--quiet'), 1)
const treePath = args[0]

if (!treePath) {
  console.error('usage: node scripts/bt-run.js <tree.json> [--fast <fast.json>] [--url ws://host:port] [--quiet]')
  process.exit(2)
}

const config = normalizeConfig({ ...(url ? { modUrl: url } : {}), logger: console })
const runtime = createRuntime(config)
const { executor, mod } = runtime

if (fastPath) {
  executor.loadFastTree(readJson(fastPath))
  console.log(`[bt] fast tree loaded from ${fastPath}`)
}

executor.on('event', (record) => {
  if (record.event === 'node') {
    if (quiet || record.phase !== 'exit') return
    console.log(`  ${record.status === 'FAILURE' ? '✗' : '✓'} ${record.id} ${record.type}${record.name ? ` ${record.name}` : ''}${record.error ? ` — ${record.error}` : ''}`)
    return
  }
  const { seq, at, taskId, event, ...rest } = record
  console.log(`[${event}] ${JSON.stringify(rest)}`)
})

console.log(`[bt] connecting to ${config.modUrl} …`)
if (!(await waitForConnection(mod, 15000))) {
  console.error('[bt] mod not reachable — is the capture client running and in a world?')
  runtime.dispose()
  process.exit(1)
}

const tree = readJson(treePath)
const taskId = executor.startTask({ tree: tree.root ?? tree, goal: tree.goal ?? path.basename(treePath), blackboard: tree.blackboard ?? {} })
console.log(`[bt] task ${taskId} started; events → ${path.join(config.runtimeDir, 'tasks', taskId)}`)
executor.start()

executor.on('task', (summary) => {
  if (summary.state !== 'done' && summary.state !== 'failed') return
  console.log(`[bt] task ${summary.state}: ${summary.result}`)
  console.log(`[bt] blackboard: ${JSON.stringify(executor.task.blackboard.snapshot(), null, 2)}`)
  setTimeout(() => { runtime.dispose(); process.exit(summary.state === 'done' ? 0 : 1) }, 300)
})

process.on('SIGINT', () => {
  console.log('\n[bt] interrupted — aborting task')
  try { executor.abortTask('interrupted by Ctrl+C') } catch {}
  setTimeout(() => { runtime.dispose(); process.exit(130) }, 500)
})

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
}
