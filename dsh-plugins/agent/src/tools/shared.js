/**
 * 工具定义的共用件。src/tools/ 下的文件只做参数整形、调领域对象，返回 `defineTool` 的选项对象；
 * 包上 defineTool、注册进 DSH 的只有 index.js（集成方案 §2.3）。
 */

/** 所有工具的输出都是任意 JSON（领域对象自己定形状），由 render 转成给大模型看的文本。 */
export const JSON_OUTPUT = Object.freeze({ type: 'json' })

/** JSON 文本，超长截断并提示缩小查询（§5.2：不依赖 DSH 的 spill 落盘）。 */
export function jsonText(value, maxChars) {
  const text = JSON.stringify(value, null, 1) ?? 'null'
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…（结果共 ${text.length} 字符，已截断到 ${maxChars}；请缩小查询：加筛选、减 fields 或调小 limit）`
}

export function textBlocks(text) {
  return [{ type: 'text', text }]
}

/** 工具调用所属的会话（DSH 里 agent.id 就是 SessionId）；脚本 / 测试里没有 agent 时为 null。 */
export function sessionOf(exec) {
  return exec?.agent?.id ?? null
}
