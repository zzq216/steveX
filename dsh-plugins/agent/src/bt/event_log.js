import fs from 'node:fs'
import path from 'node:path'

/**
 * 任务事件日志 + 树版本链（集成方案 §8.1）。
 *
 *   <runtimeDir>/tasks/<taskId>/events.jsonl   tick 级事件，每行一条，带递增序号 seq
 *   <runtimeDir>/tasks/<taskId>/trees/v<N>.json 每次装载 / 展开后的完整执行格式树
 *   <runtimeDir>/fast/events.jsonl             快树情节（跨任务累积）
 *
 * runtimeDir 为 null 时只在内存里保留（测试用）。写盘是同步追加：事件量是"节点进出"级别，
 * 不是每 tick 一行，同步写不会拖慢 tick。
 */
export class EventLog {
  constructor({ runtimeDir = null, keepInMemory = 2000 } = {}) {
    this.runtimeDir = runtimeDir
    this.keepInMemory = keepInMemory
    this.seq = 0
    this.recent = []
  }

  taskDir(taskId) {
    return this.runtimeDir ? path.join(this.runtimeDir, 'tasks', taskId) : null
  }

  append(taskId, event) {
    const record = { seq: ++this.seq, at: new Date().toISOString(), taskId, ...event }
    this.recent.push(record)
    if (this.recent.length > this.keepInMemory) this.recent.shift()
    const dir = taskId ? this.taskDir(taskId) : this.runtimeDir && path.join(this.runtimeDir, 'fast')
    if (dir) {
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(record) + '\n')
    }
    return record
  }

  writeTreeVersion(taskId, version, spec) {
    const dir = this.taskDir(taskId)
    if (!dir) return null
    const treesDir = path.join(dir, 'trees')
    fs.mkdirSync(treesDir, { recursive: true })
    const file = path.join(treesDir, `v${version}.json`)
    fs.writeFileSync(file, JSON.stringify(spec, null, 2) + '\n')
    return file
  }
}
