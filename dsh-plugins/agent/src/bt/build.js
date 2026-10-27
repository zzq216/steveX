import {
  Sequence, Selector, Match, Repeat, ForEach, Inverter, Retry, Timeout,
  Condition, Action, Steps, Compute, SubTree, PendingExpansion
} from './nodes.js'
import { checkResolvedInputs, checkOutputs } from '../capsules/signature.js'

/**
 * 执行格式（行为树设计 §8.1）→ 运行时节点对象。
 * 调用前必须先过校验器（validator.js）；这里只做构造，遇到不合法的输入直接抛错。
 *
 * @param {object} spec
 * @param {object} options
 * @param {object} options.registry
 * @param {object} [options.capsules]  { library, sandbox, maxDepth }：Compute / SubTree / 条件代码需要
 * @returns {{ root: import('./nodes.js').Node, byId: Map<string, import('./nodes.js').Node> }}
 */
export function buildTree(spec, { registry, capsules = null }) {
  const byId = new Map()
  const maxDepth = capsules?.maxDepth ?? 8

  function command(name, kind) {
    const cmd = registry.get(name)
    if (!cmd || cmd.kind !== kind) throw new Error(`unknown ${kind} command: ${name}`)
    return cmd
  }

  function entry(ref) {
    if (!capsules?.library) throw new Error(`${ref}: no capsule library configured`)
    return capsules.library.get(ref)
  }

  function condition(node) {
    if (!node.ref) return new Condition(node, command(node.cmd, 'condition'))
    const e = entry(node.ref)
    const { sandbox } = capsules
    return new Condition(node, {
      sources: node.read ?? [],
      test(snapshot, params) {
        const problems = checkResolvedInputs(e.signature, params)
        if (problems.length) throw new Error(`${node.ref}: ${problems.join('; ')}`)
        const value = sandbox.run(e.body, params, { state: snapshot, timeoutMs: sandbox.conditionTimeoutMs })
        if (typeof value !== 'boolean') throw new Error(`${node.ref} must return true / false, got ${JSON.stringify(value)}`)
        return value
      }
    })
  }

  function compute(node) {
    const e = entry(node.ref)
    const host = capsules.library.host(node.ref)
    return new Compute(node, {
      entry: e,
      async invoke(params, ctx, state) {
        const problems = checkResolvedInputs(e.signature, params)
        if (problems.length) throw new Error(`${node.ref}: ${problems.join('; ')}`)
        const output = host
          ? await host.run(params, { taskId: ctx.taskId })
          : capsules.sandbox.run(e.body, params, { state })
        // 查询节点读到的数据源版本：修复请求的目录据此列出"记忆来源已换代"（P2-D17）
        if (host?.version && typeof output?.sourceVersion === 'string') {
          ctx.onQuery?.({ nodeId: node.id, ref: node.ref, source: params.path, version: output.sourceVersion, probe: () => host.version(params) })
        }
        const outProblems = checkOutputs(e.signature, output)
        if (outProblems.length) throw new Error(`${node.ref}: ${outProblems.join('; ')}`)
        return output
      }
    })
  }

  function build(node, depth = 0, stack = []) {
    let built
    const sub = (child) => build(child, depth, stack)
    switch (node.type) {
      case 'Sequence': built = new Sequence(node, node.children.map(sub)); break
      case 'Selector': built = new Selector(node, node.children.map(sub)); break
      case 'Match':
        built = new Match(node, node.arms.map((arm) => ({ when: sub(arm.when), then: sub(arm.then) })), sub(node.otherwise))
        break
      case 'Repeat': built = new Repeat(node, sub(node.child), node.until ? sub(node.until) : null); break
      case 'ForEach': built = new ForEach(node, sub(node.child)); break
      case 'Inverter': built = new Inverter(node, sub(node.child)); break
      case 'Retry': built = new Retry(node, sub(node.child)); break
      case 'Timeout': built = new Timeout(node, sub(node.child)); break
      case 'Condition': built = condition(node); break
      case 'Action': built = new Action(node, command(node.cmd, 'action'), node.expect ? sub(node.expect) : null); break
      case 'Steps':
        built = new Steps(node, node.do.map(([cmd]) => (cmd === 'wait' ? null : command(cmd, 'action'))), node.expect ? sub(node.expect) : null)
        break
      case 'Compute': built = compute(node); break
      case 'SubTree': {
        if (stack.includes(node.ref)) throw new Error(`capsule recursion: ${[...stack, node.ref].join(' → ')}`)
        if (depth >= maxDepth) throw new Error(`capsule nesting deeper than ${maxDepth} at ${node.id}`)
        const e = entry(node.ref)
        const body = instantiate(e.body, node.id)
        built = new SubTree(node, build(body, depth + 1, [...stack, node.ref]), e)
        break
      }
      case 'PendingExpansion': built = new PendingExpansion(node); break
      default: throw new Error(`node type not supported: ${node.type}`)
    }
    if (byId.has(built.id)) throw new Error(`duplicate node id: ${built.id}`)
    byId.set(built.id, built)
    return built
  }

  return { root: build(spec), byId }
}

/** 胶囊体实例化：内部节点 id = `<调用点 id>/<胶囊内 id>`（§5.1.1）。树文件里不展开。 */
export function instantiate(body, callId) {
  const copy = structuredClone(body)
  walkSpec(copy, (node) => { node.id = `${callId}/${node.id}` })
  return copy
}

/**
 * 把编写时省略了 @hash 的胶囊引用钉到当前最新版（存进树文件的永远带 hash，算法层 §8.4）。
 * 返回新树；钉不上的（名字不存在）收集成错误，交给校验—修正循环。
 */
export function pinRefs(spec, library) {
  const errors = []
  const copy = structuredClone(spec)
  walkSpec(copy, (node) => {
    if (typeof node.ref !== 'string') return
    if (!library) {
      errors.push(`[${node.id}] ${node.ref}: no capsule library configured`)
      return
    }
    try {
      node.ref = library.pin(node.ref)
    } catch (error) {
      errors.push(`[${node.id}] ${error.message}`)
    }
  })
  return { spec: copy, errors }
}

/** 遍历执行格式树（含 Match 的 when / otherwise、Repeat 的 until、Steps / Action 的 expect）。 */
export function walkSpec(spec, visit, parent = null) {
  visit(spec, parent)
  for (const child of specChildren(spec)) walkSpec(child, visit, spec)
}

export function specChildren(spec) {
  switch (spec?.type) {
    case 'Sequence':
    case 'Selector':
      return spec.children ?? []
    case 'Match':
      return [...(spec.arms ?? []).flatMap((arm) => [arm?.when, arm?.then]), spec.otherwise].filter(Boolean)
    case 'Repeat':
      return [spec.until, spec.child].filter(Boolean)
    case 'ForEach':
    case 'Inverter':
    case 'Retry':
    case 'Timeout':
      return spec.child ? [spec.child] : []
    case 'Action':
    case 'Steps':
      return spec.expect ? [spec.expect] : []
    default:
      return []
  }
}

/** 返回把 `id` 节点替换成 `replacement` 之后的新执行格式树（不改动原树）。 */
export function replaceSpec(spec, id, replacement) {
  if (spec.id === id) return replacement
  const copy = { ...spec }
  switch (spec.type) {
    case 'Sequence':
    case 'Selector':
      copy.children = spec.children.map((child) => replaceSpec(child, id, replacement))
      break
    case 'Match':
      copy.arms = spec.arms.map((arm) => ({ when: replaceSpec(arm.when, id, replacement), then: replaceSpec(arm.then, id, replacement) }))
      copy.otherwise = replaceSpec(spec.otherwise, id, replacement)
      break
    case 'Repeat':
      if (spec.until) copy.until = replaceSpec(spec.until, id, replacement)
      copy.child = replaceSpec(spec.child, id, replacement)
      break
    case 'ForEach':
    case 'Inverter':
    case 'Retry':
    case 'Timeout':
      copy.child = replaceSpec(spec.child, id, replacement)
      break
    default:
      break
  }
  return copy
}
