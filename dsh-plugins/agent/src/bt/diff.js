import { walkSpec } from './build.js'

/**
 * 任务树两版之差（P4 §3.3）：按节点 id 对齐，列出新增 / 删除 / 改动的节点；改动给字段级差异。
 * 任务树的 id 是层级路径，展开 / 补丁不改已有节点的 id，所以按 id 对齐就是按"同一个节点"对齐。
 * （快树按 arm 名字对齐，见 fast/versions.js 的 diffTrees——快树补丁按名字寻址，P3-D8）
 *
 * @returns {{ added: object[], removed: object[], changed: object[] }}
 *   added / removed：[{ id, type, name? }]；changed：[{ id, type, name?, fields: { 字段: { from, to } } }]
 */
export function diffSpecs(from, to) {
  const before = flatten(from)
  const after = flatten(to)
  const brief = (node) => strip({ id: node.id, type: node.type, name: node.name })
  const added = []
  const removed = []
  const changed = []
  for (const [id, node] of after) {
    const old = before.get(id)
    if (!old) {
      added.push(brief(node))
      continue
    }
    const fields = {}
    for (const key of new Set([...Object.keys(old.fields), ...Object.keys(node.fields)])) {
      const a = JSON.stringify(old.fields[key])
      const b = JSON.stringify(node.fields[key])
      if (a !== b) fields[key] = strip({ from: old.fields[key], to: node.fields[key] })
    }
    if (Object.keys(fields).length) changed.push({ ...brief(node), fields })
  }
  for (const [id, node] of before) if (!after.has(id)) removed.push(brief(node))
  return { added, removed, changed }
}

/** id → { id, type, name, fields }。fields 不含孩子（孩子各自比），但含孩子的 id 列表：顺序变了也算改动。 */
function flatten(spec) {
  const out = new Map()
  walkSpec(spec, (node) => {
    const { children, child, arms, otherwise, until, expect, origin, ...rest } = node
    const fields = { ...rest }
    if (children) fields.children = children.map((kid) => kid.id)
    if (child) fields.child = child.id
    if (until) fields.until = until.id
    if (expect) fields.expect = expect.id
    delete fields.id
    out.set(node.id, { id: node.id, type: node.type, name: node.name, fields })
  })
  return out
}

function strip(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))
}
