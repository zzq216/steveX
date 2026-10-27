import { resolveRef } from './blackboard.js'

/**
 * 执行器自带的条件：只读黑板（任务执行状态），不读游戏世界，所以不属于"要训练出来的条件"。
 * 读世界的条件由 agent 写成条件代码（capsules/code，returns: 'bool'）。
 *
 * key 支持字段路径，规则与 `$key` 读引用相同（`plan.cells` 先找键 `plan.cells`，再找键 `plan` 的 `cells` 字段）。
 */
const OPS = {
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b
}

function lookup(blackboard, key) {
  try {
    return { found: true, value: resolveRef(`$${key}`, blackboard) }
  } catch {
    return { found: false, value: undefined }
  }
}

export function registerBuiltinConditions(registry) {
  const cond = (def) => registry.register({ kind: 'condition', cost: 'local_cached', sources: [], ...def })

  cond({
    name: 'blackboard/compare',
    description: '黑板值比较：key 对应的值 op value（key 不存在 = 不成立）。列表 / 字符串可以用 key.length 比长度',
    params: {
      key: { type: 'string', required: true },
      op: { type: 'string', required: true, enum: Object.keys(OPS) },
      value: { type: 'any', required: true }
    },
    test: (_s, p, ctx) => {
      const { found, value } = lookup(ctx.blackboard, p.key)
      return found && OPS[p.op](value, p.value)
    }
  })

  cond({
    name: 'blackboard/has',
    description: '黑板上有 key',
    params: { key: { type: 'string', required: true } },
    test: (_s, p, ctx) => lookup(ctx.blackboard, p.key).found
  })
}
