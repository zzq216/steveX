import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSystemPrompt, buildUserPrompt, createLlmFillSlots, historyLines, outputSpec, parseSlotReply } from '../src/llm_slots.js'
import { DEFAULT_PROMPTS_DIR, loadPromptBlocks } from '../src/prompts.js'
import { SLOT_VALUES } from '../src/domain/slots.js'
import { makeSlots } from './helpers.js'

const prompts = loadPromptBlocks(DEFAULT_PROMPTS_DIR)

const human = (text, id) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text }] })

test('系统提示词：五个块按固定顺序拼接，[OUTPUT] 由词表生成', () => {
  const system = buildSystemPrompt(prompts)
  const order = ['[SYSTEM]', '[SLOT_DEFS]', '[RULES]', '[FEW_SHOT]', '[OUTPUT]'].map((block) => system.indexOf(block))
  assert.ok(order.every((index) => index >= 0))
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  for (const value of SLOT_VALUES.action) assert.ok(outputSpec().includes(`"${value}"`))
  assert.ok(!system.includes('<!--'))
})

test('历史：只留人 / steveX 的文本，丢工具与 stevex-* 请求，截断并取最近 N 条', () => {
  const history = [
    human('第一句', 'a'),
    assistant('好的'),
    { role: 'user', content: [{ type: 'text', text: '# 展开请求 r1' }], source: { kind: 'stevex-bt' } },
    { role: 'tool', content: [{ type: 'text', text: '工具结果' }] },
    human('x'.repeat(50), 'b'),
    human('本 step 的话', 'now')
  ]
  const lines = historyLines(history, { limit: 2, chars: 10, exclude: new Set(['now']) })
  assert.deepEqual(lines, ['steveX：好的', `用户：${'x'.repeat(9)}…`])
  assert.deepEqual(historyLines(history, { limit: 0 }), [])
})

test('用户提示词：[CONTEXT] [PENDING_CLARIFICATION] [USER]', () => {
  const plain = buildUserPrompt({ userText: '做一把木镐', history: [] })
  assert.match(plain, /\[CONTEXT\]\n（没有之前的对话）\n\n\[USER\]\n做一把木镐/)
  const withPending = buildUserPrompt({ userText: '现在就去', history: ['用户：要不要挖铁'], pending: { question: '现在去吗？', userText: '要不要挖铁' } })
  assert.match(withPending, /\[CONTEXT\][\s\S]*\[PENDING_CLARIFICATION\][\s\S]*现在去吗？[\s\S]*要不要挖铁[\s\S]*\[USER\]\n现在就去$/)
})

test('解析：容忍围栏与前后文字；字符串里的花括号不打断配平', () => {
  const slots = makeSlots({ action: 'execute', payloads: { action: { instruction: '放 {一个} 箱子' } } })
  const parsed = parseSlotReply(`好的：\n\`\`\`json\n${JSON.stringify(slots)}\n\`\`\`\n完毕`)
  assert.equal(parsed.slots.action.payload.instruction, '放 {一个} 箱子')
  assert.throws(() => parseSlotReply('没有 JSON'), (e) => e.code === 'ROUTER_OUTPUT_INVALID')
  assert.throws(() => parseSlotReply('{"slots": {}}'), (e) => e.code === 'ROUTER_OUTPUT_INVALID')
})

test('fillSlots：输出不合法 → 带着错误重试一次；仍不合法 → 抛 ROUTER_OUTPUT_INVALID', async () => {
  const requests = []
  const replies = ['不是 JSON', JSON.stringify(makeSlots({ knowledge: 'fact' }))]
  const fill = createLlmFillSlots({ prompts, complete: async (request) => { requests.push(request); return { text: replies.shift(), model: 'p/m' } } })
  const trace = {}
  const slots = await fill({ userText: '岩浆会点燃玩家', history: [], trace })
  assert.equal(slots.slots.knowledge.value, 'fact')
  assert.deepEqual(trace, { attempts: 2, model: 'p/m' })
  assert.equal(requests.length, 2)
  assert.doesNotMatch(requests[0].user, /\[RETRY\]/)
  assert.match(requests[1].user, /\[RETRY\][\s\S]*不合法[\s\S]*不是 JSON/)

  const bad = createLlmFillSlots({ prompts, complete: async () => ({ text: '{}' }) })
  await assert.rejects(bad({ userText: '做木镐' }), (e) => e.code === 'ROUTER_OUTPUT_INVALID')
})

test('fillSlots：没有文字 → 不调模型，按普通对话；模型报错原样抛出（交给降级）', async () => {
  let calls = 0
  const fill = createLlmFillSlots({ prompts, complete: async () => { calls++; throw new Error('boom') } })
  const slots = await fill({ userText: '  ' })
  assert.equal(calls, 0)
  assert.equal(slots.slots.action.value, 'none')
  await assert.rejects(fill({ userText: '做木镐' }), /boom/)
  assert.equal(calls, 1)
})
