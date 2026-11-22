import fs from 'node:fs'
import path from 'node:path'
import { usageSummary } from './stats.js'
import { capsuleRefs } from './library.js'

/**
 * 整理回合的证据与记录（胶囊库整理设计方案 §5.3 / §5.5）。零 DSH 依赖。
 *
 * - 全库清单：每个条目一行，按名字排序，不按好坏排、不预先挑"可疑条目"（C3）
 * - 条目超过 listLimit 时不给全量，改给目录：各名字前缀下几条、几条已下架、几条尚无记录（C5）
 * - <capsulesDir>/curate.jsonl：每次整理（或脚本下架）一行，改动前后的值都记下，便于人回看与撤销
 * - 整理范围（胶囊库整理范围设计方案）：缺省只列上次完成的整理之后用过、新存的条目（核心），加上和它们有引用关系的条目（相关）、
 *   同领域的其余条目（只列名字）；已下架的条目不列（R4）
 */
export const RETIRE_REASON_MAX = 500

/** 库里的条目（不含任务草稿），按引用排序；带同名旧版本数与统计。 */
export function libraryRows(library, stats, history = null) {
  const versions = countVersions(library.dir)
  return library.list()
    .filter((row) => !row.draft)
    .map((row) => {
      const key = row.ref.slice(0, row.ref.lastIndexOf('@'))
      // 版本说明（胶囊版本说明方案 V10）：最新版跑没跑过、版本判断的状态计数——只是证据
      const untested = !row.builtin && stats ? !stats.ran(row.ref) : false
      const claims = library.versions?.claimCounts(key) ?? null
      return { ...row, key, olderVersions: Math.max(0, (versions.get(key) ?? 1) - 1), stat: stats?.byName(key)?.total ?? null, issues: history?.notesFor(key).length ?? 0, untested, claims }
    })
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
}

/**
 * 全库清单或目录的正文（`/bt curate all` 的 {{library}}）。已下架的条目不列、不算进 listLimit，只写总数（整理范围方案 R4）。
 */
export function renderLibrary(allRows, { listLimit }) {
  const rows = allRows.filter((r) => !r.retired)
  const retired = allRows.length - rows.length
  const head = `胶囊库在用 ${rows.length} 条（内置 ${rows.filter((r) => r.builtin).length}）；已下架 ${retired} 条不列，要看用 capsule_search 加 includeRetired`
  if (rows.length <= listLimit) {
    return [head, '', ...rows.map((row) => renderRow(row))].join('\n')
  }
  const groups = new Map()
  for (const row of rows) {
    const name = row.key.slice(row.key.indexOf('/') + 1)
    const prefix = `${row.key.slice(0, row.key.indexOf('/'))}/${name.includes('.') ? name.slice(0, name.indexOf('.') + 1) : name}`
    const g = groups.get(prefix) ?? { n: 0, unused: 0 }
    g.n++
    if (!row.stat?.calls) g.unused++
    groups.set(prefix, g)
  }
  return [
    `${head}。在用的超过 ${listLimit} 条，只给目录；条目用 capsule_search、capsule_get 自己查`,
    '',
    ...[...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([prefix, g]) => `- ${prefix}*：${g.n} 条，尚无记录 ${g.unused}`)
  ].join('\n')
}

/** curate.jsonl 里最后一次完成（outcome: done）的整理：{ at, requestId, mode }；没有 → null（整理范围方案 R1） */
export function lastDoneCurate(dir) {
  const file = dir ? path.join(dir, 'curate.jsonl') : null
  if (!file || !fs.existsSync(file)) return null
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    let record
    try {
      record = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (record?.outcome === 'done' && typeof record.at === 'string') return { at: record.at, requestId: record.requestId ?? null, mode: record.mode ?? 'all' }
  }
  return null
}

/** curate.jsonl 里已用过的最大请求号（"k12" → 12）；没有记录 → 0。新请求接着编，DSH 重启后不撞号 */
export function lastCurateSeq(dir) {
  const file = dir ? path.join(dir, 'curate.jsonl') : null
  if (!file || !fs.existsSync(file)) return 0
  let max = 0
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /"requestId":"k(\d+)"/.exec(line)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max
}

/** 名字的领域：去掉文件夹后的第一段（"trees/smithing.make-one" → "smithing"；整理范围方案 R3） */
export const domainOf = (key) => {
  const name = key.slice(key.indexOf('/') + 1)
  return name.includes('.') ? name.slice(0, name.indexOf('.')) : name
}

/**
 * 整理范围（整理范围方案 R2、R3）。只看在用的库条目（不含内置、草稿、已下架）。
 * - 核心：之后用过（同名各版本的 lastUsed 晚于 since）或之后新存（manifest 的 savedAt 晚于 since）
 * - 相关：核心子树正文里引用的条目、正文里引用了核心条目的子树，只走一层
 * - 同领域：名字第一段和某个核心条目相同的其余条目，只列名字
 * @param {object[]} rows  libraryRows 的结果
 * @param {(key: string) => Set<string>|null} refsOf  子树（最新版）正文里引用的条目名字；不是子树 / 读不到 → null
 * @returns {{ core: object[], related: object[], domains: Map<string, string[]>, outside: number, retired: number }}
 *   core 的每行带 why: ['用过', '新存']；related 的每行带 usedBy / uses（核心条目的名字）
 */
export function curateScope(rows, { since, refsOf }) {
  const base = Date.parse(since)
  const live = rows.filter((r) => !r.retired && !r.builtin && !r.draft)
  const later = (at) => typeof at === 'string' && Date.parse(at) > base
  const core = []
  for (const row of live) {
    const why = [later(row.stat?.lastUsed) ? '用过' : null, later(row.savedAt) ? '新存' : null].filter(Boolean)
    if (why.length) core.push({ ...row, why })
  }
  const coreKeys = new Set(core.map((r) => r.key))
  const byKey = new Map(live.map((r) => [r.key, r]))
  const related = new Map()
  const link = (key, field, other) => {
    if (coreKeys.has(key) || !byKey.has(key)) return
    if (!related.has(key)) related.set(key, { ...byKey.get(key), usedBy: [], uses: [] })
    const r = related.get(key)
    if (!r[field].includes(other)) r[field].push(other)
  }
  for (const row of core) for (const key of refsOf(row.key) ?? []) link(key, 'usedBy', row.key)
  for (const row of live) {
    if (coreKeys.has(row.key)) continue
    for (const key of refsOf(row.key) ?? []) if (coreKeys.has(key)) link(row.key, 'uses', key)
  }
  const coreDomains = new Set(core.map((r) => domainOf(r.key)))
  const domains = new Map()
  for (const row of live) {
    if (coreKeys.has(row.key) || related.has(row.key) || !coreDomains.has(domainOf(row.key))) continue
    const d = domainOf(row.key)
    if (!domains.has(d)) domains.set(d, [])
    domains.get(d).push(row.key)
  }
  const listed = core.length + related.size + [...domains.values()].reduce((n, list) => n + list.length, 0)
  return {
    core,
    related: [...related.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    domains: new Map([...domains].sort(([a], [b]) => (a < b ? -1 : 1))),
    outside: live.length - listed,
    retired: rows.filter((r) => r.retired).length
  }
}

/** 子树最新版正文里引用的条目名字（去掉 @hash，不含 task/ 草稿）；不是子树、读不到 → null */
export function treeRefs(library, row) {
  if (row.kind !== 'tree') return null
  const entry = library.tryGet(row.ref)
  if (!entry) return null
  return new Set([...capsuleRefs(entry.body)].filter((ref) => !ref.startsWith('task/')).map((ref) => (ref.includes('@') ? ref.slice(0, ref.lastIndexOf('@')) : ref)))
}

/** 范围里各类的条数（curate.jsonl 的 scope，R8） */
export const scopeCounts = (scope) => ({
  core: scope.core.length, related: scope.related.length,
  domain: [...scope.domains.values()].reduce((n, list) => n + list.length, 0), outside: scope.outside, retired: scope.retired
})

/** 整理范围的正文（缺省整理的 {{library}}，整理范围方案 §3） */
export function renderScope(scope) {
  const counts = scopeCounts(scope)
  const lines = [
    `核心条目 ${counts.core} 条：上次整理之后在任务里用过的、之后新存的（含新版本）。`,
    `相关条目 ${counts.related} 条：和核心条目有引用关系的子树和代码（只走一层）。`,
    `同领域的其余条目 ${counts.domain} 条：只列名字。`,
    `库里还有 ${counts.outside} 条在用的条目不在范围里；已下架的 ${counts.retired} 条不列。`,
    '',
    '## 核心条目',
    ...scope.core.map((row) => renderRow(row, `之后：${row.why.join('、')}`))
  ]
  if (scope.related.length) {
    lines.push('', '## 相关条目')
    for (const row of scope.related) {
      const via = [row.usedBy.length ? `被 ${row.usedBy.join('、')} 引用` : null, row.uses.length ? `引用了 ${row.uses.join('、')}` : null].filter(Boolean).join('；')
      lines.push(renderRow(row, via))
    }
  }
  if (scope.domains.size) {
    lines.push('', '## 同领域的其余条目（只列名字，要看用 capsule_get）')
    for (const [domain, keys] of scope.domains) lines.push(`- ${domain}：${keys.join('、')}`)
  }
  return lines.join('\n')
}

function renderRow(row, note = null) {
  const kind = { compute: 'Compute', condition: '条件', query: '内置查询', tree: '子树' }[row.kind] ?? row.kind
  const flags = [row.builtin ? '内置' : null, row.locked && !row.builtin ? 'locked' : null].filter(Boolean)
  const tail = [
    usageSummary(row.stat, row.kind, row.key),
    `同名旧版本 ${row.olderVersions}${row.untested && row.olderVersions > 0 ? '，最新版未执行' : ''}`,
    row.claims && row.claims.open + row.claims.confirmed + row.claims.refuted > 0 ? `版本判断 open ${row.claims.open} / 成立 ${row.claims.confirmed} / 不成立 ${row.claims.refuted}（capsule_get 看版本链）` : null,
    row.issues ? `已知问题 ${row.issues} 条（待验证，capsule_get 看）` : null,
    row.retired ? `已下架：${row.retired.reason}${row.retired.supersededBy ? `，取代者 ${row.retired.supersededBy}` : ''}` : null,
    note,
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
