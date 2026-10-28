import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RouterError } from './domain/router.js'

/**
 * 提示词内容加载（设计文档 §6 / §16；阶段 B 细则 §10）。
 *
 * 文件缺失、为空、或仍带 TODO 标记 → **拒绝上线**，不允许静默使用空提示词。
 * `fact` / `task` handler 的 skill 正文在 agent 插件的 prompts/skills/（单一真相），这里不留副本。
 */
export const PLACEHOLDER_MARKER = 'TODO(内容层)'

/** 本包自带的提示词目录（config.provider.promptsDir 的默认值）。 */
export const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL('../prompts', import.meta.url))

export const PROMPT_FILES = Object.freeze({
  slotDefs: 'router/slot_defs.md',
  rules: 'router/rules.md',
  fewShot: 'router/few_shot.md',
  default: 'handlers/default.md',
  unsupported: 'handlers/unsupported.md',
  clarify: 'handlers/clarify.md'
})

/** 带小节的文件：小节缺了也算没填好。 */
const REQUIRED_SECTIONS = Object.freeze({
  default: ['degraded', 'clarify-limit'],
  clarify: ['instruction', 'knowledge', 'action', 'artifact', 'other']
})

export function loadPromptBlocks(dir) {
  if (typeof dir !== 'string' || dir === '') {
    throw new RouterError('MISSING_PROMPTS_DIR', 'router: promptsDir is required when prompt content is loaded')
  }

  const blocks = {}
  for (const [key, relative] of Object.entries(PROMPT_FILES)) {
    const file = join(dir, relative)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      throw new RouterError('PROMPT_MISSING', `router: prompt file missing: ${file}`)
    }
    if (text.trim() === '') {
      throw new RouterError('PROMPT_EMPTY', `router: prompt file is empty: ${file}`)
    }
    if (text.includes(PLACEHOLDER_MARKER)) {
      throw new RouterError('PROMPT_PLACEHOLDER', `router: prompt content is not filled yet: ${file}`)
    }
    blocks[key] = stripComments(text).trim()
  }

  for (const [key, names] of Object.entries(REQUIRED_SECTIONS)) {
    const sections = parseSections(blocks[key])
    const missing = names.filter((name) => !sections[name])
    if (missing.length) {
      throw new RouterError('PROMPT_SECTION_MISSING', `router: ${PROMPT_FILES[key]} is missing section(s): ${missing.join(', ')}`)
    }
    blocks[`${key}Sections`] = sections
  }
  return blocks
}

/** `## 名字` 分节 → { 名字: 正文 }。 */
export function parseSections(text) {
  const sections = {}
  let current = null
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(\S+)\s*$/.exec(line)
    if (heading) {
      current = heading[1]
      sections[current] = []
    } else if (current) {
      sections[current].push(line)
    }
  }
  return Object.fromEntries(Object.entries(sections).map(([name, lines]) => [name, lines.join('\n').trim()]))
}

/** `{name}` 占位替换；没给的值原样保留，方便发现漏传。 */
export function renderTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
}

function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}
