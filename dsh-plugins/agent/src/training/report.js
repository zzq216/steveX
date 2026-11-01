import fs from 'node:fs'

/** 训练记录汇总（训练场设计方案 T10）：按目标物品看成功率、用时、虚报率、token。 */

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
 * @param {{ last?: number|null, batch?: string|null }} [filter]
 * @returns {{ rows: object[], total: object }}
 */
export function summarize(records, { last = null, batch = null } = {}) {
  let picked = batch ? records.filter((r) => r.batch === batch) : records
  if (last) picked = picked.slice(-last)
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
      medianCraftedMs: median(success.map((r) => r.craftedMs).filter((n) => n !== null)),
      medianTaskMs: median(success.map((r) => r.taskMs).filter((n) => n !== null)),
      medianTokens: median(tokens),
      chatSend: list.filter((r) => r.usedChatSend).length
    }
  }
  const byTarget = new Map()
  for (const r of picked) {
    if (!byTarget.has(r.target)) byTarget.set(r.target, [])
    byTarget.get(r.target).push(r)
  }
  const rows = [...byTarget].map(([target, list]) => ({ target, ...group(list) })).sort((a, b) => b.runs - a.runs || a.target.localeCompare(b.target))
  return { rows, total: { target: '（合计）', ...group(picked) } }
}

export function formatSummary({ rows, total }) {
  if (total.runs === 0) return '没有训练记录'
  const head = ['目标', '轮数', '成功率', '虚报', '做出但报失败', '失败', '超时', '中止', '合成中位', '任务中位', 'token中位', '用过chat/send']
  const line = (r) => [r.target, r.runs, pct(r.success, r.runs), r.falseSuccess, r.craftedButFailed, r.failed, r.timeout, r.aborted,
    secs(r.medianCraftedMs), secs(r.medianTaskMs), r.medianTokens ?? '-', r.chatSend].join('\t')
  return [head.join('\t'), ...rows.map(line), line(total)].join('\n')
}
