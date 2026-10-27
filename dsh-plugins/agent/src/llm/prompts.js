import fs from 'node:fs'
import path from 'node:path'

/**
 * 提示词资源（集成方案 §2.3 / §6）：正文在 prompts/ 下的 .md 文件里，与代码分离，改内容不改代码。
 *
 *   system/*.md    常驻系统提示词分段（§6.3），只放很少变化的东西
 *   skills/*.md    skill 正文，由代码按场景放进请求（I6），不让大模型自己挑
 *   requests/*.md  执行器各类请求的消息模板，`{{名字}}` 是占位
 *
 * 缺文件、空文件、仍带占位标记 → 装载时报错，不允许静默用空提示词上线（同路由 prompts.js）。
 */
export const PLACEHOLDER_MARKER = 'TODO(内容层)'

export const PROMPT_FILES = Object.freeze({
  system: ['identity', 'authoring'],
  skills: ['outline', 'expand', 'recover', 'reflect', 'review', 'fast_reflect', 'fast_author', 'fact_check', 'fact_record'],
  requests: ['plan', 'expand', 'recover', 'escalate', 'failed', 'died', 'reminder', 'retry', 'task_end', 'reflect', 'reflect_reminder', 'reflect_retry', 'fast_batch', 'fast_reminder', 'fast_retry', 'fact_check', 'fact_reminder']
})

export function loadPrompts(dir) {
  const prompts = {}
  for (const [group, names] of Object.entries(PROMPT_FILES)) {
    prompts[group] = {}
    for (const name of names) {
      const file = path.join(dir, group, `${name}.md`)
      let text
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        throw new Error(`stevex-agent: prompt file missing: ${file}`)
      }
      if (text.trim() === '') throw new Error(`stevex-agent: prompt file is empty: ${file}`)
      if (text.includes(PLACEHOLDER_MARKER)) throw new Error(`stevex-agent: prompt content is not filled yet: ${file}`)
      prompts[group][name] = text.trim()
    }
  }
  return prompts
}

/** `{{名字}}` 换成 vars 里的值；模板里用到却没给的变量是错误（防止漏填的请求发给大模型）。 */
export function renderTemplate(template, vars) {
  return template.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, key) => {
    if (!(key in vars) || vars[key] === undefined) throw new Error(`prompt template: missing variable "${key}"`)
    return String(vars[key])
  })
}
