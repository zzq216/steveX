import { renderTemplate } from './prompts.js'

/**
 * v1 五个 handler（设计文档 §3 / §4.2；阶段 B 细则 §6 / §8）。
 *
 * 返回值 `{ text, prompt? }`：`text` 只进日志；`prompt` 是要放进本 step 的模型可见正文（由 index.js 注入）。
 * - `task`（集成方案 §6.1，P1）与 `fact`（P5 §2）：登记请求 / 事实确认、注入 skill、限制本回合的工具——
 *   这些都由 steveX agent 插件的 `planInTurn` / `factInTurn` 完成，路由只负责选中它、把正文放进回合；
 * - `clarify`：让主模型替路由问一句（pre-step 不能跳过主模型直接回话，细则 D4）；
 * - `unsupported`：告诉主模型这项能力暂不支持，让它如实转告；
 * - `default`：正常对话，不注入（降级 / 追问上限的说明由 index.js 作为 notice 注入）。
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

/** 事实陈述：槽位 payload 里抽出的 statement 优先，否则用本 step 里人说的话（细则 D3）。 */
export function statementOf(slots, messages = []) {
  const fromSlot = slots.slots.knowledge.payload?.statement
  if (typeof fromSlot === 'string' && fromSlot.trim()) return fromSlot.trim()
  return userText(messages)
}

/** 追问的那句话：路由给的 clarification 优先，否则按哪个决定性槽位是 unknown 套 clarify.md 的模板。 */
export function clarifyQuestion(slots, sections) {
  if (typeof slots.clarification === 'string' && slots.clarification.trim()) return slots.clarification.trim()
  const unsure = ['action', 'knowledge', 'artifact'].find((name) => slots.slots[name].value === 'unknown')
  return sections?.[unsure ?? 'other'] ?? sections?.other ?? '你是想让我在游戏里去做这件事，还是只是聊聊？'
}

/** 本 step 里人说的话。 */
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
        const result = service.factInTurn({ agent: context.agent, turn: context.turnId, statement: statementOf(slots, context.messages) })
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
      run: async (slots, context) => ({
        text: `unsupported: artifact=${slots.slots.artifact.value}`,
        prompt: context.prompts?.unsupported
      })
    },
    {
      id: 'clarify',
      match: () => false, // 由编排器在"需要追问"时独占选用
      provides: [],
      requires: [],
      onFailure: 'stop',
      priority: 0,
      run: async (slots, context) => {
        const question = clarifyQuestion(slots, context.prompts?.clarifySections)
        const template = context.prompts?.clarifySections?.instruction
        return {
          text: `clarify #${context.clarifyCount ?? 1}: ${question}`,
          prompt: template ? renderTemplate(template, { question }) : undefined,
          question
        }
      }
    },
    {
      id: 'default',
      match: () => false, // 编排器兜底
      provides: [],
      requires: [],
      onFailure: 'stop',
      priority: 100,
      run: async () => ({ text: 'default: ordinary conversation' })
    }
  ]

  const allowed = enabled === null ? HANDLER_IDS : enabled
  return all.filter((handler) => allowed.includes(handler.id))
}
