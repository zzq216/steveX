import { walkSpec } from './build.js'

/**
 * 补丁（P2 实施细则 §3）：大模型回答 recover / escalate / failed / died 请求时交的一组操作。
 *
 *   { op: 'replace' | 'insert-before' | 'insert-after', id, node }   node 是编写格式
 *   { op: 'remove', id }
 *
 * 这里只做规划：逐条检查、编译、在执行格式树的副本上应用，不碰运行中的节点。
 * 执行器拿到 steps 后再把同样的操作施加到运行中的树上（executor.applyPatchSteps）。
 *
 * - 操作点名的都是**补丁之前就有的** id；新节点的 id 由这里分配：`<锚点>.p<版本>`，同一锚点再有新节点时 `…p5b`、`…p5c`（§3.3）
 * - 补丁不能改已经过去的事（§3.2）：memory 模式的 Sequence / Selector 里，游标左边的孩子已经执行完，
 *   replace / remove 它、或者插在它们中间都会被拒——改了也不会重跑。上面有 Repeat / ForEach 时下一轮会重跑，不拒
 * - insert-* 只能插进 Sequence / Selector；replace 只能换整个节点（不能单独换 Match 的条件或 Action 的 expect）
 * - 同一锚点多次 insert-after：按操作顺序排在锚点后面（A 之后插 B、再插 C → A, B, C）
 *
 * @param {object} options
 * @param {object} options.spec      当前执行格式树
 * @param {import('./nodes.js').Node} options.root  运行中的根节点（只读：看游标判断哪些已经执行完）
 * @param {object[]} options.ops
 * @param {number} options.version   补丁生效后的树版本号
 * @param {(node: object, rootId: string) => { spec: object, check: { ok: boolean, errors: string[], nodeCount: number } }} options.compile
 * @param {number} [options.maxNodes]  整份补丁新节点的合计上限
 * @param {object} [options.origin]    打在每个新子树根上的来源标记 { request, type }（§4.6，供 P4 识别临时补丁）
 * @returns {{ errors: string[] } | { errors: [], spec: object, steps: object[], ids: string[], nodeCount: number }}
 */
export function planPatch({ spec, root, ops, version, compile, maxNodes, origin }) {
  if (!Array.isArray(ops)) return { errors: ['ops must be a list of { op, id, node? }'] }

  let work = structuredClone(spec)
  const index = indexSpec(work)
  const live = indexLive(root)
  const gone = new Map()      // id → 哪条操作把它（或它的祖先）换掉 / 删掉了
  const tails = new Map()     // insert-after 锚点 → 本补丁里最后插在它后面的节点
  const suffixes = new Map()  // 锚点 → 已分配的新 id 个数
  const errors = []
  const steps = []
  const ids = []
  let nodeCount = 0

  ops.forEach((op, i) => {
    const at = `ops[${i}]`
    const fail = (message) => errors.push(`${at}: ${message}`)

    if (!op || typeof op !== 'object') return fail('each op must be an object { op, id, node? }')
    if (!OPS.includes(op.op)) return fail(`unknown op "${op.op}"; use one of ${OPS.join(' / ')}`)
    if (typeof op.id !== 'string') return fail('id must be a node id string such as "n1.3"')
    if (op.op === 'remove' && op.node !== undefined) return fail('remove takes no node')
    if (op.op !== 'remove' && (op.node === undefined || op.node === null)) return fail(`${op.op} needs a node`)
    if (gone.has(op.id)) return fail(`${op.id} was already replaced or removed by ${gone.get(op.id)} in this patch`)

    const entry = index.get(op.id)
    if (!entry) {
      return fail(op.id.includes('/')
        ? `${op.id} is inside a capsule; capsule internals cannot be patched — replace the whole use node (${op.id.split('/')[0]})`
        : `no node ${op.id} in the task tree`)
    }
    const { node: target, parent } = entry
    const inList = parent && (parent.type === 'Sequence' || parent.type === 'Selector')

    if (op.op !== 'replace' && !inList) {
      return fail(parent
        ? `${op.id} is the child of a ${parent.type}, not of a seq / sel; ${op.op} only works inside seq / sel — use replace to turn it into a seq`
        : `${op.id} is the root; ${op.op} the root is not possible — use replace`)
    }
    if (op.op === 'replace' && parent && !inList && !SINGLE_CHILD.includes(parent.type)) {
      return fail(`${op.id} is part of ${parent.type} ${parent.id} (a condition or expect), not a child slot; replace ${parent.id} instead`)
    }
    if (op.op === 'replace' && parent?.type === 'Repeat' && parent.child !== target) {
      return fail(`${op.id} is the until condition of ${parent.id}; replace ${parent.id} instead`)
    }

    const path = live.get(op.id)
    const timing = path ? checkTiming(op.op, path) : null
    if (timing) return fail(timing)

    const n = suffixes.get(op.id) ?? 0
    suffixes.set(op.id, n + 1)
    const newId = n === 0 ? `${op.id}.p${version}` : `${op.id}.p${version}${String.fromCharCode(97 + n)}`

    let sub = null
    if (op.op !== 'remove') {
      const { spec: compiled, check } = compile(op.node, newId)
      if (!check.ok) {
        errors.push(...check.errors.map((e) => `${at}: ${e}`))
        return
      }
      sub = compiled
      if (origin) sub.origin = origin
      nodeCount += check.nodeCount
      walkSpec(sub, (node) => ids.push(node.id))
    }

    const step = { op: op.op, id: op.id, parentId: parent?.id ?? null, spec: sub }
    switch (op.op) {
      case 'replace':
        if (!parent) work = sub
        else if (inList) parent.children[parent.children.indexOf(target)] = sub
        else parent.child = sub
        markGone(target, at)
        break
      case 'remove':
        parent.children.splice(parent.children.indexOf(target), 1)
        markGone(target, at)
        break
      case 'insert-before':
        parent.children.splice(parent.children.indexOf(target), 0, sub)
        break
      case 'insert-after': {
        const anchor = tails.get(op.id) ?? target
        parent.children.splice(parent.children.indexOf(anchor) + 1, 0, sub)
        step.afterId = anchor.id
        tails.set(op.id, sub)
        break
      }
    }
    steps.push(step)
  })

  if (maxNodes !== undefined && nodeCount > maxNodes) {
    errors.push(`the patch adds ${nodeCount} nodes, over the limit of ${maxNodes}——把一部分改成 expand，留到执行时再规划`)
  }
  if (errors.length) return { errors }
  return { errors: [], spec: work, steps, ids, nodeCount }

  function markGone(node, at) {
    walkSpec(node, (n) => gone.set(n.id, at))
  }
}

const OPS = ['replace', 'insert-before', 'insert-after', 'remove']
const SINGLE_CHILD = ['Repeat', 'ForEach', 'Inverter', 'Retry', 'Timeout']
const LOOPS = ['Repeat', 'ForEach']

/**
 * §3.2：补丁不能改已经过去的事。
 * @param {string} op
 * @param {import('./nodes.js').Node[]} path  根 → 目标节点（运行中的树）
 * @returns {string | null}  拒绝的理由
 */
function checkTiming(op, path) {
  const inserting = op === 'insert-before' || op === 'insert-after'
  // replace / remove：目标自己也不能是已经执行完的；insert：只看到它的父节点为止，再单独看插入位置
  const upTo = inserting ? path.length - 1 : path.length
  let loop = false
  for (let i = 0; i + 1 < upTo; i++) {
    const parent = path[i]
    const child = path[i + 1]
    if (!loop && isMemoryList(parent) && parent.kids.indexOf(child) < parent.cursor) {
      return `${child.id} has already finished; changing it will not make it run again — to redo it, insert-before the current step ${currentStep(parent)}`
    }
    if (LOOPS.includes(parent.type)) loop = true
  }
  if (!inserting) return null

  const parent = path.at(-2)
  const anchor = path.at(-1)
  for (const node of path.slice(0, -2)) if (LOOPS.includes(node.type)) loop = true
  if (loop || !isMemoryList(parent)) return null
  const position = parent.kids.indexOf(anchor) + (op === 'insert-after' ? 1 : 0)
  if (position < parent.cursor) {
    return `that position is between steps of ${parent.id} that have already finished, so the new node would never run — insert at the current position: ${currentStep(parent)}`
  }
  return null
}

function isMemoryList(node) {
  return (node.type === 'Sequence' || node.type === 'Selector') && node.mode === 'memory'
}

function currentStep(parent) {
  return parent.cursor < parent.kids.length
    ? `insert-before ${parent.kids[parent.cursor].id}`
    : `insert-after ${parent.kids.at(-1).id}`
}

/** id → { node, parent }（执行格式树的副本，原地改）。 */
function indexSpec(spec) {
  const index = new Map()
  walkSpec(spec, (node, parent) => index.set(node.id, { node, parent }))
  return index
}

/** id → 根到该节点的路径（运行中的树）。胶囊内部的节点不进来（补丁不能点名它们）。 */
function indexLive(root) {
  const index = new Map()
  const visit = (node, path) => {
    const here = [...path, node]
    index.set(node.id, here)
    if (node.type === 'SubTree') return
    for (const kid of node.children()) visit(kid, here)
  }
  visit(root, [])
  return index
}
