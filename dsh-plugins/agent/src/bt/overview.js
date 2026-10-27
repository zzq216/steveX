import { specChildren } from './build.js'

/**
 * 树概览：执行格式树 → 一行一个节点的缩进文本（带 id 与状态），给大模型看（展开请求、bt_view）。
 * 只渲染树文件里的节点；SubTree 的胶囊体不展开（它的内部 id 是 `<调用点>/<胶囊内 id>`）。
 *
 *   n1 seq "做木镐" [RUNNING]
 *     n1.1 steps "走到树前" (4 步) [SUCCESS]
 *     n1.2 expand "砍 3 块原木" ← 待展开
 *
 * @param {object} spec
 * @param {object} [options]
 * @param {Map<string, string|null>} [options.statuses]  id → 最近一次返回码
 * @param {string} [options.mark]                        要标出的节点 id（展开请求里的那个 expand / 修复请求出事的节点）
 * @param {string} [options.markLabel='← 待展开']
 *
 * 补丁加的子树根上标出来源（P2 §4.6）：`(补丁 r12 recover)`。
 */
export function renderTree(spec, { statuses = new Map(), mark = null, markLabel = '← 待展开' } = {}) {
  const lines = []
  function visit(node, depth, role = '') {
    const status = statuses.get(node.id)
    const marked = node.id === mark ? markLabel : status ? `[${status}]` : ''
    const origin = node.origin ? `(补丁 ${node.origin.request} ${node.origin.type})` : ''
    const suffix = [origin, marked].filter(Boolean).join(' ')
    lines.push(`${'  '.repeat(depth)}${role}${node.id} ${label(node)}${suffix ? ` ${suffix}` : ''}`)
    if (node.type === 'Match') {
      node.arms.forEach((arm) => {
        visit(arm.when, depth + 1, 'when ')
        visit(arm.then, depth + 1, 'then ')
      })
      visit(node.otherwise, depth + 1, 'otherwise ')
      return
    }
    if (node.type === 'Repeat' && node.until) visit(node.until, depth + 1, 'until ')
    for (const child of specChildren(node)) {
      if (node.type === 'Repeat' && child === node.until) continue
      visit(child, depth + 1, (node.type === 'Action' || node.type === 'Steps') ? 'expect ' : '')
    }
  }
  visit(spec, 0)
  return lines.join('\n')
}

function label(node) {
  const name = node.name ? ` "${node.name}"` : ''
  switch (node.type) {
    case 'Sequence': return `seq${name}${node.mode === 'reactive' ? ' (reactive)' : ''}`
    case 'Selector': return `sel${name}${node.mode === 'reactive' ? ' (reactive)' : ''}`
    case 'Match': return `match${name}`
    case 'Condition':
      return node.ref
        ? `cond ${node.ref}${node.read?.length ? ` read=${node.read.join(',')}` : ''} ${brief(node.params)}`
        : `cond ${node.cmd} ${brief(node.params)}`
    case 'Action': return `act ${node.cmd} ${brief(node.params)}${writes(node)}`
    case 'Steps': return `steps${name} (${node.do.length} 步: ${node.do.map(([cmd]) => cmd).join(', ')})`.slice(0, 160)
    case 'Compute': return `compute ${node.ref}${name} ${brief(node.params)}${writes(node)}`
    case 'SubTree': return `use ${node.ref}${name} ${brief(node.params)}`
    case 'PendingExpansion': return `expand "${node.goal}"`
    case 'Repeat': return `repeat${name} ${node.n !== undefined ? `n=${node.n}` : `until, max=${node.maxIterations}`}`
    case 'ForEach': return `forEach ${node.list} as ${node.as}${name}`
    case 'Inverter': return `invert${name}`
    case 'Retry': return `retry ${node.n}${name}`
    case 'Timeout': return `timeout ${node.ms}ms${name}`
    default: return node.type
  }
}

function writes(node) {
  return node.writes ? ` → ${Object.keys(node.writes).join(', ')}` : ''
}

function brief(value, max = 100) {
  if (value === undefined || (value && typeof value === 'object' && Object.keys(value).length === 0)) return ''
  const text = JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 节点到根的路径（不含自身）上每一层的 "id 名字"，给展开请求说明"这一步在整棵树的哪里"。 */
export function ancestorsOf(spec, id) {
  const path = []
  function find(node) {
    if (node.id === id) return true
    for (const child of specChildren(node)) {
      path.push(node)
      if (find(child)) return true
      path.pop()
    }
    return false
  }
  return find(spec) ? path.map((node) => `${node.id}${node.name ? ` "${node.name}"` : ''}`) : []
}
