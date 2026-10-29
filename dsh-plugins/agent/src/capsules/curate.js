import fs from 'node:fs'
import path from 'node:path'
import { usageSummary } from './stats.js'

/**
 * 整理回合的证据与记录（胶囊库整理设计方案 §5.3 / §5.5）。零 DSH 依赖。
 *
 * - 全库清单：每个条目一行，按名字排序，不按好坏排、不预先挑"可疑条目"（C3）
 * - 条目超过 listLimit 时不给全量，改给目录：各名字前缀下几条、几条已下架、几条尚无记录（C5）
 * - <capsulesDir>/curate.jsonl：每次整理（或脚本下架）一行，改动前后的值都记下，便于人回看与撤销
 */
export const RETIRE_REASON_MAX = 500

/** 库里的条目（不含任务草稿），按引用排序；带同名旧版本数与统计。 */
export function libraryRows(library, stats) {
  const versions = countVersions(library.dir)
  return library.list()
    .filter((row) => !row.draft)
    .map((row) => {
      const key = row.ref.slice(0, row.ref.lastIndexOf('@'))
      return { ...row, key, olderVersions: Math.max(0, (versions.get(key) ?? 1) - 1), stat: stats?.byName(key)?.total ?? null }
    })
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
}

/** 清单或目录的正文（整理请求的 {{library}}）。 */
export function renderLibrary(rows, { listLimit }) {
  const retired = rows.filter((r) => r.retired).length
  const head = `胶囊库共 ${rows.length} 条（内置 ${rows.filter((r) => r.builtin).length}，已下架 ${retired}）`
  if (rows.length <= listLimit) {
    return [head, '', ...rows.map(renderRow)].join('\n')
  }
  const groups = new Map()
  for (const row of rows) {
    const name = row.key.slice(row.key.indexOf('/') + 1)
    const prefix = `${row.key.slice(0, row.key.indexOf('/'))}/${name.includes('.') ? name.slice(0, name.indexOf('.') + 1) : name}`
    const g = groups.get(prefix) ?? { n: 0, retired: 0, unused: 0 }
    g.n++
    if (row.retired) g.retired++
    if (!row.stat?.calls) g.unused++
    groups.set(prefix, g)
  }
  return [
    `${head}：超过 ${listLimit} 条，只给目录；条目用 capsule_search（includeRetired 看已下架的）、capsule_get 自己查`,
    '',
    ...[...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([prefix, g]) => `- ${prefix}*：${g.n} 条，已下架 ${g.retired}，尚无记录 ${g.unused}`)
  ].join('\n')
}

function renderRow(row) {
  const kind = { compute: 'Compute', condition: '条件', query: '内置查询', tree: '子树' }[row.kind] ?? row.kind
  const flags = [row.builtin ? '内置' : null, row.locked && !row.builtin ? 'locked' : null].filter(Boolean)
  const tail = [
    usageSummary(row.stat, row.kind, row.key),
    `同名旧版本 ${row.olderVersions}`,
    row.retired ? `已下架：${row.retired.reason}${row.retired.supersededBy ? `，取代者 ${row.retired.supersededBy}` : ''}` : null,
    row.description || '（无说明）'
  ].filter(Boolean)
  return `- ${row.ref}（${kind}${flags.length ? `，${flags.join('，')}` : ''}）${tail.join('｜')}`
}

/** 库目录里每个 "folder/name" 有几个版本文件 */
function countVersions(dir) {
  const counts = new Map()
  if (!dir) return counts
  for (const folder of ['code', 'trees']) {
    const sub = path.join(dir, folder)
    if (!fs.existsSync(sub)) continue
    for (const file of fs.readdirSync(sub)) {
      const match = /^(.+)@[0-9a-f]+\.json$/.exec(file)
      if (match) counts.set(`${folder}/${match[1]}`, (counts.get(`${folder}/${match[1]}`) ?? 0) + 1)
    }
  }
  return counts
}

/** 下架理由：必填、非空，截到 RETIRE_REASON_MAX 字。@returns {{ reason } | { error }} */
export function checkReason(reason, what = 'reason') {
  if (typeof reason !== 'string' || !reason.trim()) return { error: `${what} is required: why — it is kept in the manifest and curate.jsonl so the decision can be reviewed or undone later` }
  return { reason: reason.trim().slice(0, RETIRE_REASON_MAX) }
}

/** curate.jsonl 追加一行；dir = null 不落盘 */
export function appendCurateLog(dir, record) {
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, 'curate.jsonl'), JSON.stringify(record) + '\n')
}
