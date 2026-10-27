import { JSON_OUTPUT, textBlocks, sessionOf } from './shared.js'
import { FAST_INSPECT_KINDS } from '../fast/inspect.js'
import { FAST_OPS } from '../fast/versions.js'
import { ALL_STATE_SOURCES } from '../bt/evidence.js'

/**
 * 快树反思的工具（P3 实施细则 §6）：fast_inspect、fast_submit_patch、fast_skip。只在快树会话里准入。
 *
 * 提交不合法不是工具错误：返回 { ok: false, errors, attemptsLeft }，大模型在同一回合里修正再交。
 *
 * @param {object} services
 * @param {import('../llm/fast_bridge.js').FastBridge} services.fastBridge
 */
export function fastTools({ fastBridge, inspectMaxBytes = 8000 }) {
  return [
    {
      name: 'fast_inspect',
      description: [
        '看快树反思批次里的证据（批次消息里的目录列出了事件 id 与快照名）。what 选一种：',
        '- event：一条事件的全文（id，如 e12）',
        '- trace：一条事件底下的原始过程：每次掉血的时刻、数量、伤害类型；每次情节的结果（id，last）',
        '- snapshot：一份快照（name：before@e12 / after@e12 / live#n）；sources 只取部分来源；against 给另一份快照名 → 返回差异（含生命、氧气、状态标志）',
        '- arms：某个版本每个 arm 的命中统计（version，缺省 = 当前版本）',
        '- versions：版本链（不给 id = 列表；给 id = 那一版的树与补丁说明；再给 against = 两版差异）',
        '- live：现在读一次 sources（缺省全读），存成 live#n',
        '- eval：用某份快照（at）或现在的状态求一个 when 条件。还没提交的条件代码放在 code 里一起传——写 arm 之前先验证它在那次事故里会不会成立'
      ].join('\n'),
      parameters: {
        what: { type: 'string', enum: [...FAST_INSPECT_KINDS], required: true, description: '查看方式' },
        id: { type: 'json', description: 'event / trace：事件 id（"e12"）；versions：版本号（整数）' },
        last: { type: 'integer', description: 'trace：最近多少条（1–200，默认 50）' },
        name: { type: 'string', description: 'snapshot：快照名' },
        against: { type: 'json', description: 'snapshot：另一份快照名；versions：另一个版本号' },
        sources: { type: 'array', items: { type: 'string', enum: [...ALL_STATE_SOURCES] }, description: 'snapshot / live：只要这些来源' },
        version: { type: 'integer', description: 'arms：版本号' },
        when: { type: 'json', description: 'eval：一个条件节点（编写格式），如 { "cond": "code/fast.x", "read": ["player"], "params": {} }' },
        at: { type: 'string', description: 'eval：用这份快照求值（缺省 = 现在读）' },
        code: { type: 'json', description: 'eval：还没提交的条件代码 { "fast.<名字>": { signature, body, description? } }' }
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(value.ok ? capBytes(JSON.stringify(value.value, null, 1), inspectMaxBytes) : `没有结果：${value.error}`) },
      isConcurrencySafe: () => true,
      async execute(args) {
        // DSH 只收无损 JSON：快照来自 mod、树来自文件，统一过一遍 JSON
        return JSON.parse(JSON.stringify(await fastBridge.inspect(args)))
      }
    },
    {
      name: 'fast_submit_patch',
      description: [
        '提交快树补丁（批次消息里有当前快树与 base 版本号）。arm 用名字寻址（then 根节点的名字），ops 按顺序应用：',
        `- { "op": "add", "arm": { "when", "then" }, "before"?: 名字, "after"?: 名字 }：都不给就加在最后（otherwise 之前）。插入位置就是优先级：第一个成立的 when 赢`,
        '- { "op": "replace", "name": 名字, "arm": { "when", "then" } }：整条换掉',
        '- { "op": "remove", "name": 名字 }',
        '- { "op": "move", "name": 名字, "before" | "after": 名字 }',
        'otherwise 不能改。通过 → 写成新版本，自动生效（快树正在情节里则等情节结束）；不通过 → 逐条错误与剩余次数，请在本回合内修正后重交。',
        'base 不是最新版 → 拒绝并附上最新版与差异，在新版上重做。'
      ].join('\n'),
      parameters: {
        batchId: { type: 'string', required: true, description: '批次 id，如 "b3"' },
        base: { type: 'integer', required: true, description: '补丁基于的快树版本号' },
        ops: { type: 'array', required: true, items: { type: 'object', additionalProperties: true }, description: `补丁操作（${FAST_OPS.join(' / ')}）` },
        reason: { type: 'string', required: true, description: '事件说明了什么、这个改动为什么能解决它（记进版本链，以后的反思会读到）' },
        code: { type: 'json', description: '可选：when 用到的新条件代码 { "fast.<名字>": { signature, body, description? } }，returns 必须是 "bool"；补丁被接受时存进胶囊库' }
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(renderSubmit(value)) },
      async execute(args, exec) {
        return JSON.parse(JSON.stringify(fastBridge.submit({ sessionId: sessionOf(exec), batchId: args.batchId, base: args.base, ops: args.ops, code: args.code, reason: args.reason })))
      }
    },
    {
      name: 'fast_skip',
      description: '这一批不改快树，写明理由（比如：偶发的一次，或者缺少认出这种局面的感知）。理由会记进日志，以后的反思能看到。',
      parameters: {
        batchId: { type: 'string', required: true, description: '批次 id' },
        reason: { type: 'string', required: true, description: '为什么不改' }
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(value.ok ? `批次 ${value.batchId} 已结束（不改）` : `没有结束：${value.error}`) },
      async execute(args, exec) {
        return fastBridge.skip({ sessionId: sessionOf(exec), batchId: args.batchId, reason: args.reason })
      }
    }
  ]
}

function renderSubmit(value) {
  if (value.ok) {
    return [`快树补丁已接受：v${value.version}（批次 ${value.batchId}）`, `arm：${value.arms.join(' → ') || '（无）'}`, ...value.diff].join('\n')
  }
  if (value.error) return `提交失败：${value.error}`
  const lines = ['补丁不合法：', ...value.errors.map((e) => `- ${e}`)]
  if (value.conflict) {
    lines.push(`当前最新版是 v${value.conflict.latest}，之后的改动：`)
    for (const c of value.conflict.changes) lines.push(`  v${c.version}（${c.by}${c.batchId ? ` ${c.batchId}` : ''}）：${c.reason ?? ''}`)
    lines.push(...value.conflict.diff.map((d) => `  ${d}`))
  }
  lines.push(`剩余次数：${value.attemptsLeft}`)
  return lines.join('\n')
}

function capBytes(text, max) {
  const bytes = Buffer.byteLength(text)
  if (bytes <= max) return text
  let cut = text.slice(0, max)
  while (Buffer.byteLength(cut) > max) cut = cut.slice(0, -64)
  return `${cut}\n…（结果共 ${bytes} 字节，已截断到 ${max}；请缩小范围：sources 只取部分来源、trace 调小 last）`
}
