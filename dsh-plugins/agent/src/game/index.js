/**
 * 游戏层：mod 连接、状态读取、命令注册表、原始命令。
 *
 * 这里只放 agent **调用**的接口，不放技能：读世界的条件、合成 / 挖掘这类高层动作、
 * 配方解析，都由 agent 在训练中写成胶囊（条件代码 / Compute / 可复用子树），存进胶囊库。
 */
export { CommandRegistry } from './registry.js'
export { registerRawCommands, READ_METHODS } from './raw_commands.js'
export { GameState, SOURCE_METHODS, sleep } from './state.js'
export { STATE_VOCAB, vocabText } from './vocab.js'
export { createModClient, waitForConnection, METHODS } from './mod.js'
