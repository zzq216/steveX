import fs from 'node:fs'
import path from 'node:path'

/**
 * 训练记录汇总（训练场设计方案 T10）：按目标物品（或配方形状）看成功率、用时、虚报率、token。
 * 带工作站的场地另有"打开工作台"中位用时、工作台被挖掉的轮数（工作台训练场设计方案 W9），
 * 以及每轮引用了哪些在本场地第一轮之前就有的胶囊（W10）。
 */

export function readRecords(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

const pct = (n, total) => (total ? `${Math.round((n / total) * 100)}%` : '-')
const secs = (ms) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)}s`)

/**
 * @param {object[]} records
 * @param {{ last?: number|null, batch?: string|null, by?: 'target'|'shape'|'portions' }} [filter]
 * @returns {{ rows: object[], total: object, by: string, station: boolean, multi: boolean }}
 *   station = 记录里有工作站字段；multi = 有多份模式的轮次（T14，多出"超量""做够中位"两列）
 */
export function summarize(records, { last = null, batch = null, by = 'target' } = {}) {
  let picked = batch ? records.filter((r) => r.batch === batch) : records
  if (last) picked = picked.slice(-last)
  const station = picked.some((r) => r.stationIntact !== null && r.stationIntact !== undefined)
  const multi = picked.some((r) => r.single === false)
  // 任务历史（任务历史方案 H10）：记录里有 assessed 字段才显示这几列
  const historyCols = picked.some((r) => r.assessed !== undefined)
  const group = (list) => {
    const count = (outcome) => list.filter((r) => r.outcome === outcome).length
    const success = list.filter((r) => r.outcome === 'success')
    const tokens = list.map((r) => r.tokens?.total).filter((n) => Number.isInteger(n))
    return {
      runs: list.length,
      success: count('success'),
      falseSuccess: count('false_success'),
      craftedButFailed: count('crafted_but_failed'),
      failed: count('failed'),
      timeout: count('timeout'),
      aborted: count('aborted'),
      overshoot: count('overshoot'),
      assessed: list.filter((r) => r.assessed).length,
      withIssues: list.filter((r) => r.assessed && r.issues > 0).length,
      withPredecessor: list.filter((r) => (r.predecessors ?? []).length > 0).length,
      reviewed: list.reduce((n, r) => n + (r.reviewed ?? 0), 0),
      resolved: list.reduce((n, r) => n + (r.resolved ?? 0), 0),
      medianModCalls: median(success.map((r) => r.modCalls).filter((n) => Number.isInteger(n))),
      medianReachedMs: median(success.map((r) => r.reachedMs).filter((n) => n !== null && n !== undefined)),
      medianCraftedMs: median(success.map((r) => r.craftedMs).filter((n) => n !== null)),
      medianOpenedMs: median(success.map((r) => r.openedMs).filter((n) => n !== null && n !== undefined)),
      medianTaskMs: median(success.map((r) => r.taskMs).filter((n) => n !== null)),
      medianTokens: median(tokens),
      chatSend: list.filter((r) => r.usedChatSend).length,
      stationBroken: list.filter((r) => r.stationIntact === false).length
    }
  }
  const groups = new Map()
  for (const r of picked) {
    const key = (by === 'shape' ? r.shape : by === 'portions' ? portionsKey(r) : r.target) ?? '（未记录）'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const rows = [...groups].map(([key, list]) => ({ key, ...group(list) })).sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key))
  return { rows, total: { key: '（合计）', ...group(picked) }, by, station, multi, historyCols }
}

/** --by portions 的分组键：n/m；单次模式记"单次"；T14 之前的记录没有这些字段 → null */
function portionsKey(r) {
  if (r.single === true) return '单次'
  return Number.isInteger(r.portions) && Number.isInteger(r.crafts) ? `${r.portions}/${r.crafts}` : null
}

const BY_LABEL = { target: '目标', shape: '形状', portions: 'n/m' }

export function formatSummary({ rows, total, by = 'target', station = false, multi = false, historyCols = false }) {
  if (total.runs === 0) return '没有训练记录'
  const head = [BY_LABEL[by] ?? '目标', '轮数', '成功率', '虚报', '做出但报失败', '失败', '超时', '中止', ...(multi ? ['超量'] : []),
    ...(station ? ['打开工作台中位'] : []), '合成中位', ...(multi ? ['做够中位'] : []), '任务中位', 'token中位', '用过chat/send', ...(station ? ['工作台被挖'] : []),
    ...(historyCols ? ['mod调用中位', '评估提出问题', '有前驱', '前驱问题解决'] : [])]
  const line = (r) => [r.key, r.runs, pct(r.success, r.runs), r.falseSuccess, r.craftedButFailed, r.failed, r.timeout, r.aborted, ...(multi ? [r.overshoot] : []),
    ...(station ? [secs(r.medianOpenedMs)] : []), secs(r.medianCraftedMs), ...(multi ? [secs(r.medianReachedMs)] : []), secs(r.medianTaskMs), r.medianTokens ?? '-', r.chatSend,
    ...(station ? [r.stationBroken] : []),
    ...(historyCols ? [r.medianModCalls ?? '-', pct(r.withIssues, r.assessed), pct(r.withPredecessor, r.runs), r.reviewed ? `${r.resolved}/${r.reviewed}` : '-'] : [])].join('\t')
  return [head.join('\t'), ...rows.map(line), line(total)].join('\n')
}

/**
 * 每轮引用了哪些"本场地第一轮之前就有"的胶囊（W10，看 2×2 时期的胶囊有没有迁移过来）。
 * 条目文件按内容哈希命名、只写一次，文件的修改时间就是它的创建时间；归档（下架）了的到 archive/ 下找。
 * 内置胶囊、草稿（task/）不在库目录里，不算。
 * @param {object[]} records  同一场地的全部记录（第一轮取 records[0].t0）
 * @param {string} capsulesDir
 * @returns {{ since: string|null, runs: Array<{ batch, run, target, outcome, refs: string[], record }> }}  record = 原记录对象
 */
export function priorCapsules(records, capsulesDir) {
  const since = records.find((r) => r.t0)?.t0 ?? null
  if (!since || !capsulesDir) return { since, runs: [] }
  const cutoff = Date.parse(since)
  const created = new Map()
  const createdAt = (ref) => {
    if (!created.has(ref)) created.set(ref, entryMtime(capsulesDir, ref))
    return created.get(ref)
  }
  const runs = []
  for (const r of records) {
    const refs = (r.capsules ?? []).filter((ref) => {
      const at = createdAt(ref)
      return at !== null && at < cutoff
    })
    if (refs.length) runs.push({ batch: r.batch, run: r.run, target: r.target, outcome: r.outcome, refs, record: r })
  }
  return { since, runs }
}

function entryMtime(capsulesDir, ref) {
  const at = ref.lastIndexOf('@')
  const slash = ref.indexOf('/')
  if (at < 0 || slash < 0) return null
  const folder = ref.slice(0, slash)
  const file = `${ref.slice(slash + 1, at)}@${ref.slice(at + 1)}.json`
  const candidates = [path.join(capsulesDir, folder, file)]
  const archive = path.join(capsulesDir, 'archive')
  if (fs.existsSync(archive)) for (const day of fs.readdirSync(archive)) candidates.push(path.join(archive, day, folder, file))
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.statSync(candidate).mtimeMs
  }
  return null
}

export function formatPriorCapsules({ since, runs }) {
  if (!since) return ''
  if (runs.length === 0) return `第一轮（${since}）之前就有的胶囊：没有一轮引用过`
  const counts = new Map()
  for (const { refs } of runs) for (const ref of refs) counts.set(ref, (counts.get(ref) ?? 0) + 1)
  const lines = [`引用了第一轮（${since}）之前就有的胶囊的轮次：${runs.length}`]
  for (const r of runs) lines.push(`  ${r.batch} #${r.run} ${r.target} ${r.outcome}：${r.refs.join(', ')}`)
  lines.push('按胶囊：')
  for (const [ref, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) lines.push(`  ${ref}\t${n} 轮`)
  return lines.join('\n')
}
