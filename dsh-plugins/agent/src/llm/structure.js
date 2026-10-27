/**
 * 数据的结构（I13）：给大模型看"有哪些字段、什么类型"，不给值。
 *
 * 和黑板形状（bridge.js shapeOf）同一个原则，但面向更大、更不规则的数据（背包每格的组件各不相同、上千条配方）：
 * - 列表里的元素合并成一个结构，只在部分元素里出现的字段标 `?`；类型不一致的写成并集
 * - 键本身来自数据的对象（配方 key 的 "#" / "X"、属性表的 "minecraft:attack_damage"）显示成 map<键, 值>
 * - `vocab: true`：取值很少的字符串字段列出全部取值（词表），取值多的只给种数。**只对静态参考数据开**（配方）——
 *   词表是接口的一部分（可复用的树会拿它做比较）；而从一次状态快照或记忆世界里统计出来的"取值"是实例值
 *
 *   recipes: list(1500) of {
 *     type: "shaped" | "shapeless"
 *     result: string（812 种）
 *     key?: map<"#" | "X" | …, list(1..8) of string（640 种）>
 *   }
 */
const MAX_DEPTH = 6
const MAX_FIELDS = 40
const VOCAB_MAX = 16          // 不超过这么多种取值的字符串字段列出全部取值
const DISTINCT_CAP = 1000     // 种数统计的上限（超过只写 "1000+ 种"）
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * @param {*} value
 * @param {object} [options]
 * @param {number} [options.maxDepth=6]
 * @param {boolean} [options.vocab=false]  统计字符串取值（只给静态参考数据开）
 */
export function structureOf(value, { maxDepth = MAX_DEPTH, vocab = false } = {}) {
  return print(shape(value, 0, { maxDepth, vocab }), '', vocab)
}

function scalar(type, value, opts) {
  const node = { kind: 'scalar', types: new Set([type]), values: null, overflow: false }
  if (opts.vocab && type === 'string') node.values = new Set([value])
  return node
}

function shape(value, depth, opts) {
  if (value === null || value === undefined) return scalar('null', null, opts)
  if (typeof value === 'boolean') return scalar('bool', value, opts)
  if (typeof value === 'number') return scalar(Number.isInteger(value) ? 'int' : 'number', value, opts)
  if (typeof value === 'string') return scalar('string', value, opts)
  if (Array.isArray(value)) {
    const node = { kind: 'list', lengths: new Set([value.length]), item: null }
    if (depth < opts.maxDepth) for (const item of value) node.item = merge(node.item, shape(item, depth + 1, opts))
    return node
  }
  const fields = new Map()
  if (depth < opts.maxDepth) for (const [k, v] of Object.entries(value)) fields.set(k, { node: shape(v, depth + 1, opts), optional: false })
  return { kind: 'object', fields, truncated: depth >= opts.maxDepth }
}

/** 两个结构合并成一个（列表元素逐个并进来）。 */
function merge(a, b) {
  if (!a) return b
  if (!b) return a
  if (a.kind === 'scalar' && b.kind === 'scalar') {
    const node = { kind: 'scalar', types: new Set([...a.types, ...b.types]), values: null, overflow: a.overflow || b.overflow }
    if (a.values || b.values) {
      node.values = new Set(a.values ?? [])
      for (const v of b.values ?? []) {
        if (node.values.size >= DISTINCT_CAP) { node.overflow = true; break }
        node.values.add(v)
      }
    }
    return node
  }
  if (a.kind === 'list' && b.kind === 'list') return { kind: 'list', lengths: new Set([...a.lengths, ...b.lengths]), item: merge(a.item, b.item) }
  if (a.kind === 'object' && b.kind === 'object') {
    const fields = new Map()
    for (const key of new Set([...a.fields.keys(), ...b.fields.keys()])) {
      const fa = a.fields.get(key)
      const fb = b.fields.get(key)
      fields.set(key, { node: merge(fa?.node, fb?.node), optional: !fa || !fb || fa.optional || fb.optional })
    }
    return { kind: 'object', fields, truncated: a.truncated || b.truncated }
  }
  return { kind: 'union', options: [a, b] }
}

/** 键本身是数据（不是标识符，或者多到不像是固定字段）→ 当成 map 打印。 */
function isMap(node) {
  const keys = [...node.fields.keys()]
  return keys.length > 0 && (keys.some((k) => !IDENT.test(k)) || keys.length > MAX_FIELDS)
}

function printScalar(node, vocab) {
  const types = [...node.types]
  if (!vocab || !node.values || node.values.size === 0) return types.join(' | ')
  const others = types.filter((t) => t !== 'string')
  const n = node.values.size
  const strings = !node.overflow && n <= VOCAB_MAX
    ? [...node.values].sort().map((v) => JSON.stringify(v)).join(' | ')
    : `string（${node.overflow ? `${DISTINCT_CAP}+` : n} 种）`
  return [strings, ...others].join(' | ')
}

function print(node, indent, vocab) {
  switch (node.kind) {
    case 'scalar': return printScalar(node, vocab)
    case 'list': {
      const n = node.lengths.size === 1 ? [...node.lengths][0] : `${Math.min(...node.lengths)}..${Math.max(...node.lengths)}`
      return node.item ? `list(${n}) of ${print(node.item, indent, vocab)}` : `list(${n})`
    }
    case 'object': {
      if (node.truncated) return '{…}'
      if (node.fields.size === 0) return '{}'
      if (isMap(node)) {
        const keys = [...node.fields.keys()].sort()
        const keyText = keys.length <= MAX_FIELDS ? keys.map((k) => JSON.stringify(k)).join(' | ') : `string（${keys.length} 种键）`
        let value = null
        for (const { node: v } of node.fields.values()) value = merge(value, v)
        return `map<${keyText}, ${print(value, indent, vocab)}>`
      }
      const inner = `${indent}  `
      const entries = [...node.fields].slice(0, MAX_FIELDS)
      const lines = entries.map(([k, f]) => `${inner}${k}${f.optional ? '?' : ''}: ${print(f.node, inner, vocab)}`)
      if (node.fields.size > MAX_FIELDS) lines.push(`${inner}…另 ${node.fields.size - MAX_FIELDS} 个字段`)
      return `{\n${lines.join('\n')}\n${indent}}`
    }
    default: return node.options.map((o) => print(o, indent, vocab)).join(' | ')
  }
}
