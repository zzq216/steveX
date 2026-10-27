import { walkSpec, specChildren } from './build.js'
import { collectRefs, refKnown } from './blackboard.js'
import { parseRef } from '../capsules/library.js'
import { checkCallParams } from '../capsules/signature.js'

/** 条件代码可以声明读取的状态来源（与 game/state.js 的 SOURCE_METHODS 一一对应）。 */
export const STATE_SOURCES = Object.freeze(['player', 'inventory', 'f3', 'container'])

/**
 * 校验器（行为树设计 §5.3 / §8.5 / 集成方案 §7.4.5）。
 * 校验不通过的树不会被装载；错误原文就是给大模型修正用的（§4.3 校验—修正循环），
 * 所以每条错误都要指明节点 id 和具体原因。
 *
 * @param {object} spec          执行格式树（胶囊引用已经 pin 过、带 @hash）
 * @param {object} options
 * @param {object} options.registry
 * @param {object} [options.library]               胶囊库（Compute / SubTree / 条件代码需要）
 * @param {'task'|'fast'} [options.kind='task']
 * @param {Iterable<string>} [options.initialKeys]  黑板上已有的键（`$key` 读引用的来源之一）
 * @param {number} [options.maxNodes]               单次提交的节点数上限（§8.5）
 * @returns {{ ok: boolean, errors: string[], nodeCount: number }}
 */
const MIN_EVERY_MS = 200
const PURE_LEAVES = ['Condition', 'Compute']

/** 不改变世界：Condition / Compute，或只由它们组成的控制节点 / 装饰器。 */
function isPure(spec) {
  if (PURE_LEAVES.includes(spec.type)) return true
  if (['Action', 'Steps', 'SubTree', 'PendingExpansion', 'Match'].includes(spec.type)) return false
  return specChildren(spec).every((child) => child && isPure(child))
}

export function validateTree(spec, { registry, library = null, kind = 'task', initialKeys = [], maxNodes } = {}) {
  const errors = []
  const ids = new Set()
  const writtenKeys = new Set(initialKeys)
  const refs = []
  let nodeCount = 0

  const err = (node, message) => errors.push(`[${node?.id ?? '?'}] ${message}`)

  /**
   * reactive 序列的复查间隔与任务树里的限制（P2 实施细则 §6.2，P2-D14 / D16）。
   * 复查会重跑活跃孩子前面的所有孩子（守卫）：守卫里有动作就会重复做事，所以任务树里只有最后一个孩子可以改变世界；
   * reactive sel 的分支本身带动作、复查时会和正在跑的分支同时动，只留在快树里。
   */
  function checkReactive(node) {
    if (node.every !== undefined) {
      const min = kind === 'task' ? MIN_EVERY_MS : 1
      if (node.type !== 'Sequence' || node.mode !== 'reactive') err(node, 'every only applies to a reactive seq (mode: "reactive")')
      else if (!(Number.isInteger(node.every) && node.every >= min)) err(node, `every must be an integer >= ${min} (milliseconds); each recheck reads state live, so rechecking more often competes with the actions for the mod`)
    }
    if (node.mode !== 'reactive' || !Array.isArray(node.children)) return
    if (kind === 'task' && node.type === 'Selector') {
      err(node, 'a reactive sel is not allowed in a task tree: its branches carry actions, and a recheck would start a higher branch while another is still running. Use a memory sel, or a reactive seq whose guards come first')
      return
    }
    node.children.slice(0, -1).forEach((child) => {
      if (child && !isPure(child)) {
        err(node, `${child.id} (${child.type}) comes before the last child of a reactive ${node.type === 'Selector' ? 'sel' : 'seq'}; every recheck re-runs the children before the running one, so only cond / compute (or seq / sel / decorators made only of them) may come before the last child — move the action to the end, or use mode "memory"`)
      }
    })
  }

  if (spec === null || typeof spec !== 'object') {
    return { ok: false, errors: ['tree must be an object'], nodeCount: 0 }
  }
  if (kind === 'fast' && spec.type !== 'Match') err(spec, '快树的根必须是 Match')

  walkSpec(spec, (node, parent) => {
    nodeCount++
    if (node === null || typeof node !== 'object') {
      errors.push(`[${parent?.id ?? '?'}] child must be an object`)
      return
    }
    if (typeof node.id !== 'string' || node.id === '') err(node, 'missing id')
    else if (ids.has(node.id)) err(node, `duplicate id "${node.id}"`)
    else ids.add(node.id)

    switch (node.type) {
      case 'Sequence':
      case 'Selector':
        if (!Array.isArray(node.children)) err(node, `${node.type} needs a children array`)
        if (node.mode !== 'memory' && node.mode !== 'reactive') err(node, `${node.type}.mode must be "memory" or "reactive"`)
        checkReactive(node)
        break
      case 'Match':
        if (!Array.isArray(node.arms)) err(node, 'Match needs an arms array')
        else node.arms.forEach((arm, i) => {
          if (!arm?.when || arm.when.type !== 'Condition') err(node, `arms[${i}].when must be a Condition`)
          if (!arm?.then) err(node, `arms[${i}].then is missing`)
        })
        if (!node.otherwise) err(node, 'Match.otherwise is required')
        break
      case 'Repeat': {
        const hasN = node.n !== undefined
        const hasUntil = node.until !== undefined
        if (hasN === hasUntil) err(node, 'Repeat needs exactly one of n / until')
        if (hasN && !(Number.isInteger(node.n) && node.n > 0)) err(node, 'Repeat.n must be a positive integer')
        if (hasUntil && node.until?.type !== 'Condition') err(node, 'Repeat.until must be a Condition')
        if (hasUntil && !(Number.isInteger(node.maxIterations) && node.maxIterations > 0)) {
          err(node, 'Repeat with until needs a positive integer maxIterations')
        }
        if (!node.child) err(node, 'Repeat.child is missing')
        break
      }
      case 'ForEach':
        if (kind === 'fast') err(node, '快树不读写黑板（ForEach 遍历的是黑板列表）')
        if (typeof node.list !== 'string' || !node.list.startsWith('$') || node.list.length < 2) {
          err(node, 'ForEach.list must be a "$key" reference to a blackboard list')
        } else {
          refs.push({ node, key: node.list.slice(1) })
        }
        if (typeof node.as !== 'string' || node.as === '' || node.as.startsWith('$')) err(node, 'ForEach.as must be a blackboard key name (no "$")')
        else writtenKeys.add(node.as)
        if (node.indexAs !== undefined) {
          if (typeof node.indexAs !== 'string' || node.indexAs === '' || node.indexAs.startsWith('$')) err(node, 'ForEach.indexAs must be a blackboard key name')
          else writtenKeys.add(node.indexAs)
        }
        if (node.maxIterations !== undefined && !(Number.isInteger(node.maxIterations) && node.maxIterations > 0)) {
          err(node, 'ForEach.maxIterations must be a positive integer')
        }
        if (!node.child) err(node, 'ForEach.child is missing')
        break
      case 'Inverter':
        if (!node.child) err(node, 'Inverter.child is missing')
        break
      case 'Retry':
        if (!node.child) err(node, 'Retry.child is missing')
        if (!(Number.isInteger(node.n) && node.n >= 0)) err(node, 'Retry.n must be a non-negative integer')
        break
      case 'Timeout':
        if (!node.child) err(node, 'Timeout.child is missing')
        if (!(typeof node.ms === 'number' && node.ms > 0)) err(node, 'Timeout.ms must be a positive number')
        break
      case 'Condition':
        if (node.ref !== undefined) checkConditionCode(node)
        else {
          checkCommand(node, node.cmd, node.params, 'condition')
          if (isWhen(node, parent)) {
            const cmd = registry.get(node.cmd)
            if (cmd && cmd.cost !== 'local_cached') err(node, `Match.when 只能用 cost=local_cached 的条件，"${node.cmd}" 是 ${cmd.cost}`)
          }
        }
        break
      case 'Action':
        if (registry.get(node.cmd)?.read) {
          err(node, `"${node.cmd}" 是读取命令，读取命令不能当 Action 用（世界状态不进黑板）——读状态请用 Condition`)
          break
        }
        checkCommand(node, node.cmd, node.params, 'action')
        checkWrites(node, (source) => typeof source === 'string')
        checkExpect(node)
        break
      case 'Steps':
        if (!Array.isArray(node.do) || node.do.length === 0) {
          err(node, 'Steps.do must be a non-empty list')
          break
        }
        node.do.forEach((step, i) => {
          if (!Array.isArray(step) || typeof step[0] !== 'string') {
            err(node, `do[${i}] must be [cmd, params?]`)
            return
          }
          const [cmd, params] = step
          if (cmd === 'wait') {
            if (!(typeof params === 'number' && params >= 0)) err(node, `do[${i}]: wait needs a millisecond number`)
            return
          }
          const command = registry.get(cmd)
          if (command?.kind === 'action' && command.read) {
            err(node, `do[${i}]: "${cmd}" 是读取命令，Steps 里不能有读取（D8）——拆成 Steps + Condition + Steps`)
            return
          }
          checkCommand(node, cmd, params, 'action', `do[${i}]: `)
        })
        checkExpect(node)
        break
      case 'Compute':
        checkCompute(node)
        break
      case 'SubTree':
        checkSubTree(node)
        break
      case 'PendingExpansion':
        if (typeof node.goal !== 'string' || node.goal.trim() === '') err(node, 'PendingExpansion.goal must be a non-empty string')
        if (kind === 'fast') err(node, '快树里不能有 PendingExpansion（快树运行时没有大模型）')
        break
      default:
        err(node, `unknown node type "${node.type}"`)
    }
  })

  for (const { node, key } of refs) {
    if (!refKnown(key, writtenKeys)) err(node, `reads "$${key}" but nothing writes that blackboard key`)
  }
  if (maxNodes !== undefined && nodeCount > maxNodes) {
    errors.push(`tree has ${nodeCount} nodes, over the limit of ${maxNodes}——把一部分改成 expand，留到执行时再规划`)
  }

  return { ok: errors.length === 0, errors, nodeCount }

  function checkCommand(node, name, params, kindWanted, prefix = '') {
    const command = registry.get(name)
    if (!command) {
      err(node, `${prefix}unknown command "${name}"`)
      return
    }
    if (command.kind !== kindWanted) {
      err(node, `${prefix}"${name}" is a ${command.kind}, not a ${kindWanted}`)
      return
    }
    if (kind === 'fast' && name.startsWith('blackboard/')) err(node, `${prefix}快树不读写黑板`)
    // 整个 params 是一个 "$key"：参数对象来自黑板（如 ForEach 的当前元素），运行时才知道内容
    if (!(typeof params === 'string' && params.startsWith('$'))) {
      for (const message of checkParams(command, params ?? {})) err(node, `${prefix}${name}: ${message}`)
    }
    collect(node, params)
  }

  function collect(node, params) {
    const found = collectRefs(params ?? {})
    if (kind === 'fast' && found.size > 0) err(node, `快树不读写黑板（参数里有 ${[...found].map((k) => `$${k}`).join(', ')}）`)
    for (const key of found) refs.push({ node, key })
  }

  /** 取胶囊条目；取不到 / 前缀不对都报到节点上，返回 null。 */
  function capsule(node, folderWanted) {
    if (!library) {
      err(node, `${node.ref}: no capsule library configured`)
      return null
    }
    let parsed
    try {
      parsed = parseRef(node.ref)
    } catch (error) {
      err(node, error.message)
      return null
    }
    // 任务内代码草稿（task/）可以出现在任何要 code/ 的地方
    if (parsed.folder !== folderWanted && !(folderWanted === 'code' && parsed.folder === 'task')) {
      err(node, `${node.type} needs a ${folderWanted}/ ref, got ${node.ref}`)
      return null
    }
    try {
      return library.get(node.ref)
    } catch (error) {
      err(node, error.message)
      return null
    }
  }

  function checkConditionCode(node) {
    const entry = capsule(node, 'code')
    if (!Array.isArray(node.read) || node.read.some((s) => !STATE_SOURCES.includes(s))) {
      err(node, `Condition.read must be a list drawn from ${STATE_SOURCES.join(' / ')}`)
    }
    if (!entry) return
    if (entry.body?.host) err(node, `${node.ref} is a query, it cannot be a condition`)
    if (entry.signature.returns !== 'bool') err(node, `${node.ref} is not a condition (its signature has no returns: "bool"); use it as compute`)
    for (const message of checkCallParams(entry.signature, node.params ?? {})) err(node, `${node.ref}: ${message}`)
    collect(node, node.params)
  }

  function checkCompute(node) {
    if (kind === 'fast') err(node, '快树里不能有 Compute（快树不读写黑板）')
    const entry = capsule(node, 'code')
    if (!entry) return
    if (entry.signature.returns === 'bool') {
      err(node, `${node.ref} is a condition (returns: "bool"); use it as { cond: "${node.ref}", read: [...] }`)
      return
    }
    const host = library.host(node.ref)
    if (node.read !== undefined) {
      if (host) err(node, `${node.ref} is a query and does not take read`)
      else if (!Array.isArray(node.read) || node.read.some((s) => !STATE_SOURCES.includes(s))) {
        err(node, `Compute.read must be a list drawn from ${STATE_SOURCES.join(' / ')}`)
      }
    }
    const literalOnly = Boolean(entry.body?.literalParams)
    for (const message of checkCallParams(entry.signature, node.params ?? {}, { literalOnly })) err(node, `${node.ref}: ${message}`)
    if (host?.validate && !Object.values(node.params ?? {}).some((v) => typeof v === 'string' && v.startsWith('$'))) {
      for (const message of host.validate(node.params ?? {})) err(node, `${node.ref}: ${message}`)
    }
    collect(node, node.params)
    const outputs = Object.keys(entry.signature.outputs ?? {})
    if (node.writes === undefined) {
      for (const key of outputs) writtenKeys.add(key)
      return
    }
    checkWrites(node, (source) => typeof source === 'string' && (/^\+\d+$/.test(source) || outputs.includes(source.split('.')[0])),
      `must be one of the outputs (${outputs.join(', ')}) or a path into one`)
  }

  function checkSubTree(node) {
    if (kind === 'fast') err(node, '快树里不能有 SubTree（第一版）')
    const entry = capsule(node, 'trees')
    if (!entry) return
    for (const message of checkCallParams(entry.signature, node.params ?? {})) err(node, `${node.ref}: ${message}`)
    collect(node, node.params)
    for (const key of Object.keys(entry.signature.outputs ?? {})) writtenKeys.add(key)
  }

  function checkWrites(node, sourceOk, hint = 'must be a string') {
    if (node.writes === undefined) return
    if (node.writes === null || typeof node.writes !== 'object' || Array.isArray(node.writes)) {
      err(node, 'writes must be an object mapping blackboard key → result path')
      return
    }
    if (kind === 'fast') err(node, '快树不读写黑板')
    for (const [key, source] of Object.entries(node.writes)) {
      if (!sourceOk(source)) err(node, `writes["${key}"] ${hint}`)
      writtenKeys.add(key)
    }
  }

  function checkExpect(node) {
    if (node.expect !== undefined && node.expect?.type !== 'Condition') err(node, 'expect must be a Condition')
  }
}

function isWhen(node, parent) {
  return parent?.type === 'Match' && (parent.arms ?? []).some((arm) => arm.when === node)
}

const TYPE_CHECKS = {
  any: () => true,
  bool: (v) => typeof v === 'boolean',
  int: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  string: (v) => typeof v === 'string',
  list: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 按命令声明的参数 schema 校验（未知参数也算错，防拼写错误静默失效）。 */
export function checkParams(command, params) {
  const messages = []
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return ['params must be an object']
  const defs = command.params ?? {}
  for (const [name, def] of Object.entries(defs)) {
    const value = params[name]
    if (value === undefined) {
      if (def.required) messages.push(`missing required param "${name}"`)
      continue
    }
    if (typeof value === 'string' && value.startsWith('$')) continue
    const check = TYPE_CHECKS[def.type ?? 'any']
    if (!check(value)) messages.push(`param "${name}" must be ${def.type}`)
    else if (def.enum && !def.enum.includes(value)) messages.push(`param "${name}" must be one of ${def.enum.join(', ')}`)
  }
  for (const name of Object.keys(params)) {
    if (!(name in defs)) messages.push(`unknown param "${name}"`)
  }
  return messages
}
