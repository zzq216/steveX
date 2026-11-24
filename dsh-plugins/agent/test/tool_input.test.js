import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ToolInputTrace, diagnose, renderDetail, snippetAt, visible, fenceFor, MAX_TEXT, MAX_AGENTS, KEEP_FILES, MARK, NO_SOURCE } from '../src/llm/tool_input_trace.js'
import { loadPrompts, renderTemplate } from '../src/llm/prompts.js'
import { tempDir } from './helpers.js'

const prompts = loadPrompts(fileURLToPath(new URL('../prompts', import.meta.url)))
const MALFORMED = { message: 'DeepSeek Messages stream: tool input is invalid JSON', code: 'MALFORMED_RESPONSE' }

/** 按 DSH 的形状发一次请求的块（坏工具参数定位设计方案 F2、F3）：块开头一块带名字、参数为空，之后参数分段 */
function feed(trace, agentId, calls, { attemptId = 'a1', pieces = 3 } = {}) {
  trace.onFrame(agentId, { type: 'start', attemptId, turn: 4, step: 2 })
  trace.onFrame(agentId, { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: '先说两句' } })
  for (const [i, { name, text }] of calls.entries()) {
    const index = i + 1
    trace.onFrame(agentId, { type: 'chunk', chunk: { type: 'block-start', index, blockType: 'tool-call' } })
    trace.onFrame(agentId, { type: 'chunk', chunk: { type: 'tool-call-delta', index, id: `call-${index}`, name, argumentsDelta: '' } })
    const size = Math.ceil(text.length / pieces)
    for (let k = 0; k < text.length; k += size) trace.onFrame(agentId, { type: 'chunk', chunk: { type: 'tool-call-delta', index, id: `call-${index}`, argumentsDelta: text.slice(k, k + size) } })
  }
  trace.onFrame(agentId, { type: 'end', attemptId, outcome: { kind: 'abandoned' } })
}

test('tool input trace: assembles the arguments of each call from the streamed deltas, finds the first call that does not parse, and points at the spot (Q1, Q2)', () => {
  const trace = new ToolInputTrace()
  const good = JSON.stringify({ requestId: 'p3', tree: { seq: 'x', do: [] } })
  const bad = '{"requestId":"p3","tree":{"seq":"射箭" "do":[]}}'
  feed(trace, 's1', [{ name: 'bt_inspect', text: good }, { name: 'bt_submit_tree', text: bad }, { name: 'bt_view', text: '{"a":' }])
  const attempt = trace.take('s1')
  assert.equal(trace.take('s1'), null, '取走后就没了')
  assert.deepEqual([attempt.attemptId, attempt.turn, attempt.step, attempt.calls.size], ['a1', 4, 2, 3])
  assert.equal(attempt.calls.get(2).text, bad)
  const d = diagnose(attempt)
  assert.deepEqual([d.ordinal, d.total, d.name, d.length, d.clipped], [2, 3, 'bt_submit_tree', bad.length, false])
  assert.match(d.message, /Expected ',' or '}' after property value in JSON at position 37 \(line 1 column 38\)/)
  assert.equal(d.position, 37)
  assert.equal(d.snippet, `{"requestId":"p3","tree":{"seq":"射箭" ${MARK}"do":[]}}`)

  const detail = renderDetail(d)
  assert.ok(detail.startsWith(`出错的是这条消息里的第 2 个工具调用 \`bt_submit_tree\`（共 3 个），参数原文 ${bad.length} 个字符。解析器报错：\n\n\`\`\`text\nExpected `), detail)
  assert.ok(detail.includes(`出错位置前后的原文（${MARK} 是解析器停下的位置）：\n\n\`\`\`text\n{"requestId"`), detail)
  assert.ok(detail.endsWith('```\n\n'))
  assert.doesNotMatch(detail, /应该|建议|改成|拆/, 'Q2：只列事实，不给建议')
})

test('tool input trace: an unterminated input points at its end; long text is cut to 80 characters either side; control characters show as symbols; the fence outgrows backticks in the text; nothing to show → the fixed sentence', () => {
  const trace = new ToolInputTrace()
  const text = `{"code":"${'a'.repeat(200)}`
  feed(trace, 's1', [{ name: 'bt_submit_tree', text }])
  const d = diagnose(trace.take('s1'))
  assert.match(d.message, /Unterminated string in JSON|Unexpected end of JSON input/)
  assert.ok(d.position > 100)
  assert.ok(d.snippet.startsWith('…') && d.snippet.includes(MARK))

  const long = 'x'.repeat(300)
  assert.equal(snippetAt(long, 150), `…${'x'.repeat(80)}${MARK}${'x'.repeat(80)}…`)
  assert.equal(snippetAt('ab', 1), `a${MARK}b`)
  assert.equal(visible('a\nb\tc\rd\u0001e\u007f'), 'a␊b␉c␍d␁e␡')
  assert.equal(fenceFor('no ticks'), '```')
  assert.equal(fenceFor('x ```` y'), '`````')
  const raw = feedOne('{"body":"line1\nline2"}')
  assert.match(raw.message, /Bad control character in string literal/)
  assert.ok(raw.snippet.includes('␊'), raw.snippet)
  assert.ok(renderDetail({ ...raw, snippet: 'a ``` b' }).includes('````text\na ``` b\n````'))

  assert.equal(renderDetail(null), `${NO_SOURCE}\n\n`)
  assert.equal(diagnose(null), null)
  const fine = new ToolInputTrace()
  feed(fine, 's1', [{ name: 'bt_view', text: '{"a":1}' }, { name: 'bt_view', text: '' }])
  assert.equal(diagnose(fine.take('s1')), null, '都解析得了：指不出位置')
})

function feedOne(text) {
  const trace = new ToolInputTrace()
  feed(trace, 's1', [{ name: 'bt_submit_tree', text }])
  return diagnose(trace.take('s1'))
}

test('tool input trace: a new start replaces the last request; text past 2 MB is clipped and said so; at most 32 sessions, the least recently active dropped (Q1)', () => {
  const trace = new ToolInputTrace()
  feed(trace, 's1', [{ name: 'old', text: '{' }], { attemptId: 'a1' })
  feed(trace, 's1', [{ name: 'bt_submit_tree', text: '{"a":1}' }], { attemptId: 'a2' })
  const again = trace.take('s1')
  assert.deepEqual([again.attemptId, again.calls.size, again.calls.get(1).name], ['a2', 1, 'bt_submit_tree'])

  const big = new ToolInputTrace()
  big.onFrame('s1', { type: 'start', attemptId: 'a1' })
  big.onFrame('s1', { type: 'chunk', chunk: { type: 'tool-call-delta', index: 1, id: 'c', name: 'bt_submit_tree', argumentsDelta: `{"x":"${'y'.repeat(MAX_TEXT)}` } })
  big.onFrame('s1', { type: 'chunk', chunk: { type: 'tool-call-delta', index: 1, id: 'c', argumentsDelta: '"}' } })
  const clipped = big.take('s1')
  assert.deepEqual([clipped.size, clipped.clipped, clipped.calls.get(1).text.length], [MAX_TEXT, true, MAX_TEXT])
  assert.match(renderDetail(diagnose(clipped)), new RegExp(`原文太长，只记了前 ${MAX_TEXT} 个字符`))

  const many = new ToolInputTrace()
  for (let i = 0; i <= MAX_AGENTS; i++) many.onFrame(`s${i}`, { type: 'start', attemptId: `a${i}` })
  assert.equal(many.attempts.size, MAX_AGENTS)
  assert.equal(many.take('s0'), null, '最久没动的被丢掉')
  // 有动静的会话不会被丢
  const lru = new ToolInputTrace()
  for (let i = 0; i < MAX_AGENTS; i++) lru.onFrame(`s${i}`, { type: 'start', attemptId: `a${i}` })
  lru.onFrame('s0', { type: 'chunk', chunk: { type: 'tool-call-delta', index: 1, id: 'c', name: 't', argumentsDelta: '{' } })
  lru.onFrame('new', { type: 'start', attemptId: 'b' })
  assert.notEqual(lru.take('s0'), null)
  assert.equal(lru.take('s1'), null)
  // 没有 start 的块（插件中途加载）不记
  const late = new ToolInputTrace()
  late.onFrame('s1', { type: 'chunk', chunk: { type: 'tool-call-delta', index: 1, id: 'c', name: 't', argumentsDelta: '{' } })
  assert.equal(late.take('s1'), null)
})

test('tool input trace: report saves the whole request to runtime/malformed (last 50 kept) and returns the retry paragraph and a log summary (Q4)', () => {
  const dir = path.join(tempDir('stevex-malformed-'), 'malformed')
  let clock = Date.parse('2026-11-24T13:59:11.457Z')
  const trace = new ToolInputTrace({ dir, now: () => clock })
  feed(trace, 'session-1', [{ name: 'bt_submit_tree', text: '{"a":1 "b":2}' }])
  const report = trace.report({ sessionId: 'session-1', turn: 7, error: MALFORMED, attempt: trace.take('session-1') })
  assert.match(report.detail, /^出错的是这条消息里的第 1 个工具调用 `bt_submit_tree`/)
  assert.equal(report.summary, 'in bt_submit_tree at line 1 column 8 (13 chars)')
  assert.equal(path.basename(report.file), '20261124-135911457-session-1.json')
  const saved = JSON.parse(fs.readFileSync(report.file, 'utf8'))
  assert.deepEqual([saved.sessionId, saved.turn, saved.error, saved.calls[0].text, saved.diagnosis.position], ['session-1', 7, MALFORMED.message, '{"a":1 "b":2}', 7])

  const none = trace.report({ sessionId: 'session-2', turn: 1, error: MALFORMED, attempt: null })
  assert.deepEqual([none.detail, none.summary], [`${NO_SOURCE}\n\n`, null])
  for (let i = 0; i < KEEP_FILES + 5; i++) {
    clock += 1000
    trace.report({ sessionId: `s${i}`, turn: 1, error: MALFORMED, attempt: null })
  }
  assert.equal(fs.readdirSync(dir).length, KEEP_FILES)
  assert.equal(new ToolInputTrace().report({ sessionId: 's', turn: 1, error: MALFORMED, attempt: null }).file, null, '没给目录就不存')
})

test('retry templates: the detail paragraph sits right after the error block in all three; empty detail leaves the message as before; the fast-tree guess about long submissions is gone (Q3, Q5)', () => {
  const detail = renderDetail(null)
  for (const [name, vars] of [
    ['retry', { requestId: 'p3', submitTool: 'bt_submit_tree', charge: 'c', error: 'E', drafts: '（没有）' }],
    ['reflect_retry', { requestId: 'c1', submitTool: 'bt_reflect_done', charge: 'c', error: 'E' }],
    ['fast_retry', { batchId: 'f1', attemptsLeft: 2, error: 'E' }]
  ]) {
    const template = prompts.requests[name]
    assert.ok(!template.includes('\r'), `${name} has no CR`)
    const withDetail = renderTemplate(template, { ...vars, detail })
    assert.ok(withDetail.includes(`\`\`\`text\nE\n\`\`\`\n\n${NO_SOURCE}\n\n请`), name)
    const plain = renderTemplate(template, { ...vars, detail: '' })
    assert.ok(plain.includes('```text\nE\n```\n\n请'), name)
  }
  assert.doesNotMatch(prompts.requests.fast_retry, /多半是一次提交太长|写短|拆成几次/)
})
