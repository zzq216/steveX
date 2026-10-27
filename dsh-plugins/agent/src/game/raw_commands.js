import { METHODS } from './mod.js'

/**
 * 原始命令：把 mod 的方法登记成注册表条目（行为树设计 §9.4：原始命令是"底层逃生口"）。
 * 说明与参数 schema 直接取自 steveX 的 methods.js，mod 加了方法这里自动跟上。
 *
 * - 有作用的方法 → action，可以出现在 Steps / Action 里
 * - 读取方法 → action + read:true：校验器拒绝它出现在 Steps / Action 里，读状态请用 Condition
 * - vision/snapshot 不登记：它会写记忆文件，属于采集循环的职责（集成方案 §5.1.1）
 * - player/respawn 不登记：死亡后由执行器自动重生（P2 实施细则 §8.3），不出现在树里
 */
export const READ_METHODS = new Set([
  'player', 'inventory', 'f3', 'sound', 'profiler', 'status', 'tablist', 'settings/get',
  'container/get', 'sign/get', 'book/get', 'vision/entity'
])
const SKIPPED = new Set(['vision/snapshot', 'settings/set', 'player/respawn'])

const TYPE_MAP = { bool: 'bool', int: 'int', double: 'number', string: 'string' }

export function registerRawCommands(registry) {
  for (const m of METHODS) {
    if (SKIPPED.has(m.method)) continue
    const params = {}
    for (const def of m.paramDefs ?? []) {
      params[def.name] = { type: TYPE_MAP[def.type] ?? 'any', required: Boolean(def.required), hint: def.hint }
    }
    const read = READ_METHODS.has(m.method)
    registry.register({
      name: m.method,
      kind: 'action',
      cost: read ? 'local_scan' : 'server',
      read,
      description: m.zh ?? m.description,
      params,
      run: (p, env) => {
        if (p === null || typeof p !== 'object' || Array.isArray(p)) throw new Error(`params must resolve to an object, got ${JSON.stringify(p)}`)
        return env.must(m.method, p)
      }
    })
  }
}
