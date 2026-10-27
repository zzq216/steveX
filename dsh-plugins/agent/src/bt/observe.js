/**
 * 可观测性（算法层 §8.8.2）：每个最小任务前后各读一次状态，给出"实际发生了什么"的差异。
 *
 * 为什么必须有：点击是乐观执行的，赌输时服务端静默覆盖客户端（行为树设计 §9.3.1），
 * 日志上每一步都是 ok。没有差异报告，大模型只看到"全部成功、背包里没东西"，无从定位。
 *
 * 差异只描述能读到的世界：背包格、界面（类型 / 格子 / 光标）、脚下方块坐标、准星方块。
 * "期望"由节点上的 `expect` 条件声明（节点结束后对读到的状态求值，不成立 = 节点失败）。
 */
export const DEFAULT_OBSERVE_SOURCES = Object.freeze(['inventory', 'container', 'f3'])

/** @returns {object|null} 没有任何变化时返回 null */
export function diffState(before, after) {
  if (!before || !after) return null
  const diff = {}

  if (before.inventory && after.inventory) {
    const changes = diffSlots(before.inventory.slots, after.inventory.slots)
    if (changes.length) diff.inventory = changes
  }

  if (before.container && after.container) {
    const b = before.container
    const a = after.container
    const out = {}
    if (b.type !== a.type) out.screen = `${b.type} → ${a.type}`
    else if (a.type !== 'none') {
      const changes = diffSlots(b.slots, a.slots)
      if (changes.length) out.slots = changes
    }
    const carriedBefore = stack(b.carriedItem)
    const carriedAfter = stack(a.carriedItem)
    if (carriedBefore !== carriedAfter) out.carried = `${carriedBefore} → ${carriedAfter}`
    if (Object.keys(out).length) diff.container = out
  }

  if (before.f3 && after.f3) {
    const pb = before.f3.position?.block
    const pa = after.f3.position?.block
    if (pb && pa && pb.join(',') !== pa.join(',')) diff.position = `${pb.join(',')} → ${pa.join(',')}`
    const tb = block(before.f3.target?.block)
    const ta = block(after.f3.target?.block)
    if (tb !== ta) diff.target = `${tb} → ${ta}`
  }

  return Object.keys(diff).length ? diff : null
}

/** 一行文字（错误信息 / 证据里用）。 */
export function summarizeDiff(diff) {
  if (!diff) return '世界状态没有变化'
  const parts = []
  if (diff.inventory) parts.push(`背包 ${diff.inventory.map((c) => `[${c.slot}] ${c.before} → ${c.after}`).join('; ')}`)
  if (diff.container?.screen) parts.push(`界面 ${diff.container.screen}`)
  if (diff.container?.slots) parts.push(`界面格 ${diff.container.slots.map((c) => `[${c.slot}] ${c.before} → ${c.after}`).join('; ')}`)
  if (diff.container?.carried) parts.push(`光标 ${diff.container.carried}`)
  if (diff.position) parts.push(`位置 ${diff.position}`)
  if (diff.target) parts.push(`准星 ${diff.target}`)
  return parts.join('；')
}

function diffSlots(beforeSlots = [], afterSlots = []) {
  const b = new Map(beforeSlots.map((s) => [s.slot, stack(s)]))
  const a = new Map(afterSlots.map((s) => [s.slot, stack(s)]))
  const changes = []
  for (const slot of [...new Set([...b.keys(), ...a.keys()])].sort((x, y) => x - y)) {
    const before = b.get(slot) ?? '空'
    const after = a.get(slot) ?? '空'
    if (before !== after) changes.push({ slot, before, after })
  }
  return changes
}

function stack(s) {
  return s ? `${s.id.replace(/^minecraft:/, '')}×${s.count}` : '空'
}

function block(b) {
  return b ? `${b.id.replace(/^minecraft:/, '')}@${b.x},${b.y},${b.z}` : '无'
}
