/**
 * v1 五个 handler（设计文档 §3 / §4.2）。
 *
 * 返回值 `{ text, prompt? }`：`text` 只进日志；`prompt` 是要放进本 step 的模型可见正文（由 index.js 注入）。
 * `task`（集成方案 §6.1，P1）与 `fact`（P5 §2）已真实化：登记请求 / 事实确认、注入 skill、限制本回合的工具——
 * 这些都由 steveX agent 插件的 `planInTurn` / `factInTurn` 完成，路由只负责选中它、把正文放进回合。
 * 其余仍是**桩**（只返回占位文本、不注入），内容阶段（B）再换成真实实现；接口不变。
 *
 * 注意：handler 的 `run` 不等于执行整个流程——它只负责准入与编排；
 * 事实/慢树的本体在各自能力服务里。
 */

export const HANDLER_IDS = Object.freeze(['fact', 'task', 'default', 'unsupported', 'clarify'])

const isMc = (slots) => slots.domain.value === 'minecraft'

/** 指令正文：槽位 payload 里抽出的 instruction 优先，否则用本 step 里人说的话。 */
export function instructionOf(slots, messages = []) {
  const fromSlot = slots.slots.action.payload?.instruction
  if (typeof fromSlot === 'string' && fromSlot.trim()) return fromSlot.trim()
  return userText(messages)
}

/** 本 step 里人说的话（事实确认的陈述就是它）。 */
export function userText(messages = []) {
  return messages
    .filter((message) => message?.source?.kind === 'user')
    .flatMap((message) => message.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * @param {object} [options]
 * @param {string[]|null} [options.enabled]
 * @param {() => object|null} [options.planner]  取 steveX agent 插件的服务（ctx.stevexBt）；没装时返回 null
 */
export function createHandlers({ enabled = null, planner = () => null } = {}) {
  const all = [
    {
      id: 'fact',
      match: (slots) => isMc(slots.slots) && slots.slots.knowledge.value === 'fact',
      provides: ['facts'],
      requires: [],
      onFailure: 'continue',
      priority: 10,
      run: async (slots, context) => {
        const service = planner()
        if (!service?.factInTurn) throw new Error('fact handler: the stevex-agent plugin (ctx.stevexBt) is not loaded')
        const result = service.factInTurn({ agent: context.agent, turn: context.turnId, statement: userText(context.messages) })
        if (result.ok) return { text: 'fact: confirming against MC source', prompt: result.text }
        return { text: `fact: not started (${result.error})` }
      }
    },
    {
      id: 'task',
      match: (slots) => isMc(slots.slots) && slots.slots.action.value === 'execute',
      provides: [],
      requires: ['facts'], // 软依赖：事实 handler 也被选中时排在它后面
      onFailure: 'continue',
      priority: 30,
      run: async (slots, context) => {
        const service = planner()
        if (!service) throw new Error('task handler: the stevex-agent plugin (ctx.stevexBt) is not loaded')
        const instruction = instructionOf(slots, context.messages)
        const result = service.planInTurn({ agent: context.agent, turn: context.turnId, instruction })
        if (result.ok) return { text: `task ${result.taskId}: plan request ${result.requestId}`, prompt: result.text }
        // 任务串行（D12）：已有任务在跑时不自动替换，回复人并等他确认（§6.1）
        return {
          text: `task: not started (${result.error})`,
          prompt: `（steveX 执行器）没有开始新任务：${result.error}\n请把原因告诉用户。如果用户要换任务，先确认是否放弃当前任务；确认后用 bt_abort_task 放弃，再请用户重新下指令。`
        }
      }
    },
    {
      id: 'unsupported',
      match: (slots) => slots.slots.artifact.value !== 'none',
      provides: [],
      requires: [],
      onFailure: 'continue',
      priority: 20,
      run: async () => ({ text: '[stub] unsupported: 该能力暂不支持（不会执行任何写操作）' })
    },
    {
      id: 'clarify',
      match: () => false, // 由编排器在"需要追问"时独占选用
      provides: [],
      requires: [],
      onFailure: 'stop',
      priority: 0,
      run: async (slots, context) => ({
        text: slots.clarification
          ?? `[stub] clarify: 你是在问事实，还是要我去做？（第 ${context.clarifyCount ?? 1} 次追问）`
      })
    },
    {
      id: 'default',
      match: () => false, // 编排器兜底
      provides: [],
      requires: [],
      onFailure: 'stop',
      priority: 100,
      run: async () => ({ text: '[stub] default: 正常回答内容待接入（阶段 B）' })
    }
  ]

  const allowed = enabled === null ? HANDLER_IDS : enabled
  return all.filter((handler) => allowed.includes(handler.id))
}
