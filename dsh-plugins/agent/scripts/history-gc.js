#!/usr/bin/env node
/**
 * 任务历史的淘汰（任务历史与复盘评估设计方案 H9 规则 2、3；规则 1 在写记录时自动执行）。
 *
 *   node scripts/history-gc.js [--apply] [--history <dir>]
 *
 * 默认演练：只列出会归档哪些记录、为什么。--apply 才移到 <历史目录>/archive/（task_search 默认不再返回，可以手动移回）。
 * 不删除任何记录。跑 --apply 之前先停掉 DSH：插件把索引留在内存里，下一次写记录时会把这次的归档标记覆盖掉。
 */
import path from 'node:path'
import { normalizeConfig } from '../src/config.js'
import { TaskHistory } from '../src/history/store.js'

const args = process.argv.slice(2)
const take = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : null
}
const historyArg = take('--history')
const apply = args.includes('--apply')
const config = normalizeConfig({ logger: null, ...(historyArg ? { historyDir: path.resolve(historyArg) } : {}) })
if (!config.historyDir) {
  console.error('historyDir is null: task history is disabled')
  process.exit(2)
}
const history = new TaskHistory({ dir: config.historyDir, capsulesDir: config.capsulesDir, config: config.history })
const out = history.gc({ apply })
console.log(`${config.historyDir}：活跃记录 ${Object.values(history.index).filter((r) => !r.archived).length} 条`)
if (out.length === 0) {
  console.log('没有要归档的记录')
} else {
  console.log(`${apply ? '已归档' : '将归档（演练，加 --apply 才执行）'} ${out.length} 条：`)
  for (const { taskId, reason } of out) console.log(`  ${taskId}  ${reason}`)
}
