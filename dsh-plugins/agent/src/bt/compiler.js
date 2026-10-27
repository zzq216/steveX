/**
 * 编译器：编写格式 → 执行格式（行为树设计 §8.5）。
 *
 * 大模型（或手写树的人）只写短格式；`id` / `type` / `mode` 全部由这里补全。
 * 编写格式里也可以直接嵌一段执行格式（带 `type` 的节点），缺 `id` 的会被补上。
 *
 * | 编写格式 | 执行格式 |
 * |---|---|
 * | { seq: name, do: [...], mode?, every? } / { sel: ... }  | Sequence / Selector（every：reactive 序列的复查间隔，毫秒） |
 * | { cond: cmd, params? }                                  | Condition（命令注册表里的条件，如 blackboard/compare） |
 * | { cond: 'code/…' 或 'task/…', read: [来源], params? }   | Condition（条件代码 / 任务内草稿；read ⊆ player / inventory / f3 / container） |
 * | { act: cmd, params?, writes?, expect? }                 | Action |
 * | { steps: name, do: [[cmd, params?], ...], expect? }     | Steps |
 * | { compute: 'code/…', read?: [来源], params?, writes? }  | Compute（read 的状态作为 main 的第二个参数） |
 * | { use: 'trees/…', params? }                             | SubTree |
 * | { expand: goal }                                        | PendingExpansion |
 * | { repeat: name, n | until+maxIterations, do }           | Repeat |
 * | { forEach: '$list', as, indexAs?, maxIterations?, do }  | ForEach |
 * | { match: name, arms: [{ when, then }], otherwise? }     | Match（otherwise 缺省 = 空 Sequence） |
 * | { invert: node } / { retry: n, delayMs?, do } / { timeout: ms, do } | 装饰器 |
 *
 * 胶囊引用可以省略 @hash（`code/name`）：执行器装载时钉到当前最新版（build.js pinRefs）。
 */
export class CompileError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CompileError'
  }
}

/**
 * @param {object} authored
 * @param {object} [options]
 * @param {'task'|'fast'} [options.kind='task']  快树还是任务树（两者的 seq / sel 缺省都是 memory）
 * @param {string} [options.rootId='n1']         根节点 id；孩子是 `<父 id>.<序号>`
 *
 * 快树的"反应式"在 Match 一层：每 tick 重评 when、情节边缘触发（行为树设计 §7.2）。arm 里的 seq 缺省也是 memory——
 * 原先快树缺省 reactive，reactive seq 每 tick 从第一个孩子重跑，已完成的动作被重置重做、后面的动作被中止，
 * 两个以上动作的 arm 永远走不到最后（P3 游戏内验收发现；系统提示词一直写的是缺省 memory）。
 */
export function compileTree(authored, { kind = 'task', rootId = 'n1' } = {}) {
  const defaultMode = 'memory'

  function compile(node, id) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      throw new CompileError(`[${id}] node must be an object`)
    }
    if (typeof node.type === 'string') return compileExecution(node, id)

    const name = (key) => (typeof node[key] === 'string' ? node[key] : undefined)
    const label = node.name
    const expect = () => (node.expect !== undefined ? compile(node.expect, `${id}.e`) : undefined)

    if ('seq' in node || 'sel' in node) {
      const type = 'seq' in node ? 'Sequence' : 'Selector'
      const kids = list(node.do, id, type)
      return strip({ id, type, name: name('seq') ?? name('sel') ?? label, mode: node.mode ?? defaultMode, every: node.every,
        children: kids.map((kid, i) => compile(kid, `${id}.${i + 1}`)) })
    }
    if ('cond' in node) {
      if (typeof node.cond === 'string' && /^(code|task)\//.test(node.cond)) {
        return strip({ id, type: 'Condition', name: label, ref: node.cond, read: node.read ?? [], params: node.params ?? {} })
      }
      return strip({ id, type: 'Condition', name: label, cmd: node.cond, params: node.params ?? {} })
    }
    if ('act' in node) {
      return strip({ id, type: 'Action', name: label, cmd: node.act, params: node.params ?? {}, writes: node.writes, expect: expect() })
    }
    if ('steps' in node) return strip({ id, type: 'Steps', name: name('steps') ?? label, do: list(node.do, id, 'Steps'), expect: expect() })
    if ('compute' in node) {
      return strip({ id, type: 'Compute', name: label, ref: node.compute, read: node.read, params: node.params ?? {}, writes: node.writes })
    }
    if ('use' in node) return strip({ id, type: 'SubTree', name: label, ref: node.use, params: node.params ?? {} })
    if ('expand' in node) return { id, type: 'PendingExpansion', goal: node.expand }
    if ('repeat' in node) {
      const spec = { id, type: 'Repeat', name: name('repeat') ?? label, n: node.n, maxIterations: node.maxIterations }
      if (node.until !== undefined) spec.until = compile(node.until, `${id}.u`)
      spec.child = compile(node.do, `${id}.1`)
      return strip(spec)
    }
    if ('forEach' in node) {
      return strip({ id, type: 'ForEach', name: label, list: node.forEach, as: node.as, indexAs: node.indexAs,
        maxIterations: node.maxIterations, child: compile(node.do, `${id}.1`) })
    }
    if ('match' in node) {
      const arms = list(node.arms, id, 'Match.arms').map((arm, i) => ({
        when: compile(arm?.when, `${id}.w${i + 1}`),
        then: compile(arm?.then, `${id}.${i + 1}`)
      }))
      const otherwise = node.otherwise !== undefined
        ? compile(node.otherwise, `${id}.o`)
        : { id: `${id}.o`, type: 'Sequence', name: 'otherwise', mode: defaultMode, children: [] }
      return strip({ id, type: 'Match', name: name('match') ?? label, arms, otherwise })
    }
    if ('invert' in node) return strip({ id, type: 'Inverter', name: label, child: compile(node.invert, `${id}.1`) })
    if ('retry' in node) {
      return strip({ id, type: 'Retry', name: label, n: node.retry, delayMs: node.delayMs, child: compile(node.do, `${id}.1`) })
    }
    if ('timeout' in node) return strip({ id, type: 'Timeout', name: label, ms: node.timeout, child: compile(node.do, `${id}.1`) })
    throw new CompileError(`[${id}] unrecognised node: ${JSON.stringify(node).slice(0, 120)}${hintFor(node)}`)
  }

  /** 执行格式节点：保留已有 id，缺的按位置补；孩子同样递归。 */
  function compileExecution(node, id) {
    const out = { ...node, id: node.id ?? id }
    const own = out.id
    if ((out.type === 'Sequence' || out.type === 'Selector') && out.mode === undefined) out.mode = defaultMode
    if (Array.isArray(node.children)) out.children = node.children.map((kid, i) => compile(kid, `${own}.${i + 1}`))
    if (Array.isArray(node.arms)) {
      out.arms = node.arms.map((arm, i) => ({ when: compile(arm.when, `${own}.w${i + 1}`), then: compile(arm.then, `${own}.${i + 1}`) }))
    }
    if (node.otherwise) out.otherwise = compile(node.otherwise, `${own}.o`)
    if (node.until) out.until = compile(node.until, `${own}.u`)
    if (node.child) out.child = compile(node.child, `${own}.1`)
    if (node.expect) out.expect = compile(node.expect, `${own}.e`)
    return out
  }

  return compile(authored, rootId)
}

/** 认不出的节点：猜它想写什么，给出改法（错误原文是给大模型修正用的）。 */
const NODE_KEYS = ['seq', 'sel', 'cond', 'act', 'steps', 'compute', 'use', 'expand', 'repeat', 'forEach', 'match', 'invert', 'retry', 'timeout']
function hintFor(node) {
  const keys = Object.keys(node)
  if ('do' in node && Array.isArray(node.do)) {
    const looksLikeSteps = node.do.length > 0 && node.do.every((step) => Array.isArray(step))
    return looksLikeSteps
      ? `. A node with a "do" list of [command, params] pairs is written { "steps": <name>, "do": [...] }`
      : `. A node with a "do" list of child nodes is written { "seq": <name>, "do": [...] } (or "sel" for fallback); "name" alone does not make a sequence`
  }
  if ('do' in node) return `. A single "do" child needs a decorator or loop key: "repeat", "forEach", "retry" or "timeout"`
  if ('type' in node) return '. "type" must be a string execution-format type (e.g. "Sequence")'
  return `. Every authored node needs exactly one of: ${NODE_KEYS.join(', ')} (got keys: ${keys.join(', ') || 'none'})`
}

function list(value, id, what) {
  if (!Array.isArray(value)) throw new CompileError(`[${id}] ${what} needs a "do" list`)
  return value
}

function strip(spec) {
  for (const key of Object.keys(spec)) if (spec[key] === undefined) delete spec[key]
  return spec
}
