import { CommandRegistry, registerRawCommands } from './game/index.js'
import { registerBuiltinConditions } from './bt/builtins.js'

/** 默认命令注册表：mod 的原始命令 + 执行器自带的黑板条件。其余能力都在胶囊库里。 */
export function createDefaultRegistry() {
  const registry = new CommandRegistry()
  registerRawCommands(registry)
  registerBuiltinConditions(registry)
  return registry
}
