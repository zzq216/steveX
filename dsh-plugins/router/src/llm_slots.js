import { RouterError } from './domain/router.js'
import { SLOT_NAMES, SLOT_VALUES, defaultSlots, validateSlotJson } from './domain/slots.js'

/**
 * llm 模式的填槽（阶段 B 细则 §4 / §5）：组装路由提示词 → 调一次模型 → 解析校验，不合法重试一次。
 *
 * 零 DSH 依赖：模型调用通过注入的 `complete({ system, user, signal }) → { text, model? }` 完成，
 * 由 index.js 用 ctx.llm 实现；测试里换成假的。
 */

const SYSTEM = '你是 steveX 的输入路由器。steveX 是一个在 Minecraft 客户端里行动的 agent。'
  + '你的唯一工作：读用户这一条消息，按下面的定义填四个槽位，只输出一个 JSON 对象。'
  + '不要回答用户的问题、不要调用工具、不要写计划、不要在 JSON 前后加任何解释。'

/** [OUTPUT] 块：由词表生成，词表加值时自动跟上（设计方案 §7）。 */
export function outputSpec() {
  const lines = SLOT_NAMES.map((name) => `    "${name}": { "value": ${SLOT_VALUES[name].map((v) => `"${v}"`).join(' | ')}, "payload": … | null }`)
  return [
    '只输出下面这个形状的 JSON（四个槽位必须全部给出，每个都带 payload 键，可以是 null）：',
    '{',
    '  "slots": {',
    lines.join(',\n'),
    '  },',
    '  "reason": "一句话判据",',
    '  "clarification": null，或者有槽位是 unknown 时要向用户确认的一句话',
    '}'
  ].join('\n')
}

/** 路由系统提示词：[SYSTEM] [SLOT_DEFS] [RULES] [FEW_SHOT] [OUTPUT]，顺序固定（设计方案 §6）。 */
export function buildSystemPrompt(prompts) {
  return [
    `[SYSTEM]\n${SYSTEM}`,
    `[SLOT_DEFS]\n${prompts.slotDefs}`,
    `[RULES]\n${prompts.rules}`,
    `[FEW_SHOT]\n${prompts.fewShot}`,
    `[OUTPUT]\n${outputSpec()}`
  ].join('\n\n')
}

/**
 * 会话历史 → 最近 limit 条人 / steveX 的文本（细则 D12）。
 * 丢掉工具调用与结果、丢掉执行器 / 路由 / 事实流程注入的 stevex-* 请求正文；每条截到 chars 字。
 * @param {object[]} history  agent.session.deriveMessages() 的结果
 * @param {object} options
 * @param {Set<string>} [options.exclude]  本 step 的消息 id（还没落进历史时不会重复，这里只是保险）
 */
export function historyLines(history = [], { limit = 6, chars = 400, exclude = new Set() } = {}) {
  if (limit === 0) return []
  const lines = []
  for (const message of history) {
    if (message?.id !== undefined && exclude.has(message.id)) continue
    let who
    if (message?.role === 'user' && message.source?.kind === 'user') who = '用户'
    else if (message?.role === 'assistant') who = 'steveX'
    else continue
    const text = textOf(message.content)
    if (!text) continue
    lines.push(`${who}：${clip(text, chars)}`)
  }
  return lines.slice(-limit)
}

/** [CONTEXT] + [USER]。pending = 上一轮的追问（细则 D5）。 */
export function buildUserPrompt({ userText, history = [], pending = null }) {
  const context = history.length ? history.join('\n') : '（没有之前的对话）'
  const parts = [`[CONTEXT]\n${context}`]
  if (pending) {
    parts.push(`[PENDING_CLARIFICATION]\n上一轮你没能判定，steveX 向用户追问了：「${pending.question}」\n用户当时的原话：「${pending.userText}」\n下面是用户对追问的回答，请结合原话一起填槽。`)
  }
  parts.push(`[USER]\n${userText}`)
  return parts.join('\n\n')
}

/** 回复 → 校验过的 SlotJSON。容忍 ```json 围栏与前后多余文字：取第一个配平的 {…}。 */
export function parseSlotReply(text) {
  const json = firstObject(String(text ?? ''))
  if (json === null) throw new RouterError('ROUTER_OUTPUT_INVALID', 'the reply contains no JSON object')
  let value
  try {
    value = JSON.parse(json)
  } catch (error) {
    throw new RouterError('ROUTER_OUTPUT_INVALID', `the reply is not valid JSON: ${error.message}`)
  }
  try {
    return validateSlotJson(value)
  } catch (error) {
    throw new RouterError('ROUTER_OUTPUT_INVALID', error.message)
  }
}

/**
 * @param {object} options
 * @param {object} options.prompts   loadPromptBlocks() 的结果
 * @param {(request: { system: string, user: string, signal?: AbortSignal, agent?: object }) => Promise<{ text: string, model?: string }>} options.complete
 * @param {number} [options.retries=1]  输出不合法时的重试次数（设计方案 §7）
 * @returns {(context: object) => Promise<object>}  provider 用的 fillSlots
 */
export function createLlmFillSlots({ prompts, complete, retries = 1 }) {
  if (typeof complete !== 'function') throw new RouterError('PROVIDER_NOT_IMPLEMENTED', 'router-provider: mode=llm needs a model (complete) function')
  const system = buildSystemPrompt(prompts)

  /**
   * @param {object} context
   * @param {string} context.userText
   * @param {string[]} [context.history]   historyLines() 的结果
   * @param {object|null} [context.pending]
   * @param {AbortSignal} [context.signal]
   * @param {object} [context.agent]
   * @param {object} [context.trace]  调用方传进来收集 attempts / model 的对象（进路由日志）
   */
  return async function fillSlots(context) {
    const trace = context.trace ?? {}
    // 本 step 没有人说的文字（比如只发了图片）：没什么可判的，按普通对话走，不调模型
    if (!context.userText?.trim()) return { ...defaultSlots(), reason: 'no user text' }
    const base = buildUserPrompt(context)
    let user = base
    let lastError = null
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      trace.attempts = attempt
      const reply = await complete({ system, user, signal: context.signal, agent: context.agent })
      if (reply?.model) trace.model = reply.model
      try {
        return parseSlotReply(reply?.text)
      } catch (error) {
        lastError = error
        user = `${base}\n\n[RETRY]\n你上一次的输出不合法：${error.message}\n上一次的输出：${clip(String(reply?.text ?? ''), 600)}\n请重新只输出符合 [OUTPUT] 的 JSON。`
      }
    }
    throw lastError
  }
}

function textOf(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n').trim()
}

function clip(text, chars) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat
}

function firstObject(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}
