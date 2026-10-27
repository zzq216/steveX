/**
 * 命令注册表（行为树设计 §9）。树里能用的每一条命令都在这里登记，校验器与执行器只认这里。
 *
 * 条目：
 *   { name, kind: 'condition' | 'action', cost: 'local_cached' | 'local_scan' | 'server',
 *     description, params: { 名字: { type, required?, enum?, hint? } },
 *     // condition
 *     sources: ['player' | 'inventory' | 'f3' | 'container'], test(snapshot, params, ctx) → boolean
 *     // action
 *     run(params, env) → Promise<result>, read?: boolean }
 *
 * `read: true` 的 action 是读取命令：不能出现在 Steps 里（D8），也不能当 Action 用（世界状态不进黑板，§5.2）。
 */
const KINDS = new Set(['condition', 'action'])
const COSTS = new Set(['local_cached', 'local_scan', 'server'])

export class CommandRegistry {
  constructor() {
    this.commands = new Map()
  }

  register(def) {
    if (typeof def?.name !== 'string' || def.name === '') throw new Error('command needs a name')
    if (this.commands.has(def.name)) throw new Error(`command already registered: ${def.name}`)
    if (!KINDS.has(def.kind)) throw new Error(`${def.name}: kind must be condition or action`)
    if (!COSTS.has(def.cost)) throw new Error(`${def.name}: cost must be local_cached, local_scan or server`)
    if (def.kind === 'condition' && typeof def.test !== 'function') throw new Error(`${def.name}: condition needs test()`)
    if (def.kind === 'action' && typeof def.run !== 'function') throw new Error(`${def.name}: action needs run()`)
    this.commands.set(def.name, Object.freeze({ params: {}, sources: [], ...def }))
    return () => this.commands.delete(def.name)
  }

  get(name) {
    return this.commands.get(name)
  }

  list() {
    return [...this.commands.values()]
  }

  /** 给人 / 大模型看的命令文档（command_docs 工具的数据源）。 */
  docs(filter = () => true) {
    return this.list().filter(filter).map((cmd) => ({
      name: cmd.name,
      kind: cmd.kind,
      cost: cmd.cost,
      read: Boolean(cmd.read),
      description: cmd.description ?? '',
      params: cmd.params
    }))
  }
}
