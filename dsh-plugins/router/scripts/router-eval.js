#!/usr/bin/env node
/**
 * 路由评测（阶段 B 细则 D10）：用真模型跑 test/router-eval/cases.jsonl，对比槽位取值。
 * 需要真模型，不进 npm test，只在本机手动跑：
 *
 *   ROUTER_EVAL_API_KEY=sk-... npm run eval
 *   npm run eval -- --base-url https://api.deepseek.com --model deepseek-chat --only fact
 *
 * 走 OpenAI 兼容的 /chat/completions。key 只从环境变量读（ROUTER_EVAL_API_KEY，没有再读 DEEPSEEK_API_KEY），
 * 不读 DSH 的配置文件。提示词与线上同一套（llm_slots.js + prompts/）。
 * 期望值：字符串 = 必须相等；数组 = 其中之一；没写的槽位不检查。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { createLlmFillSlots } from '../src/llm_slots.js'
import { DEFAULT_PROMPTS_DIR, loadPromptBlocks } from '../src/prompts.js'
import { needsClarification } from '../src/domain/slots.js'

const { values: args } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'https://api.deepseek.com' },
    model: { type: 'string', default: 'deepseek-chat' },
    only: { type: 'string' },
    cases: { type: 'string', default: fileURLToPath(new URL('../test/router-eval/cases.jsonl', import.meta.url)) },
    'timeout-ms': { type: 'string', default: '30000' }
  }
})

const apiKey = process.env.ROUTER_EVAL_API_KEY ?? process.env.DEEPSEEK_API_KEY
if (!apiKey) {
  console.error('set ROUTER_EVAL_API_KEY (or DEEPSEEK_API_KEY) to run the router eval')
  process.exit(2)
}

async function complete({ system, user }) {
  const response = await fetch(`${args['base-url'].replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: args.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 1024, temperature: 0 }),
    signal: AbortSignal.timeout(Number(args['timeout-ms']))
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const body = await response.json()
  return { text: body.choices?.[0]?.message?.content ?? '', model: args.model }
}

const fillSlots = createLlmFillSlots({ prompts: loadPromptBlocks(DEFAULT_PROMPTS_DIR), complete })
const cases = readFileSync(args.cases, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line))
  .filter((item) => !args.only || item.id.startsWith(args.only))

let passed = 0
const failures = []
for (const item of cases) {
  const started = Date.now()
  try {
    const slots = await fillSlots({ userText: item.text, history: [] })
    const wrong = Object.entries(item.expect).filter(([name, want]) => {
      const got = slots.slots[name].value
      return Array.isArray(want) ? !want.includes(got) : got !== want
    }).map(([name, want]) => `${name}=${slots.slots[name].value} (want ${[].concat(want).join('|')})`)
    const clarify = needsClarification(slots) ? ' [clarify]' : ''
    if (wrong.length) failures.push({ item, detail: wrong.join(', ') })
    else passed++
    console.log(`${wrong.length ? '✖' : '✔'} ${item.id} ${Date.now() - started}ms${clarify}  ${item.text}${wrong.length ? `\n    ${wrong.join(', ')}` : ''}`)
  } catch (error) {
    failures.push({ item, detail: error.message })
    console.log(`✖ ${item.id} error: ${error.message}`)
  }
}

console.log(`\n${passed}/${cases.length} passed`)
process.exit(failures.length ? 1 : 0)
