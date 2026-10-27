import { JSON_OUTPUT, textBlocks, sessionOf } from './shared.js'
import { renderDirectory, INSPECT_KINDS, ALL_STATE_SOURCES } from '../bt/evidence.js'

/**
 * 看树与提交（集成方案 §5.1）：bt_view、bt_inspect、bt_submit_tree、bt_submit_expansion、bt_submit_patch、bt_abort_task。
 * 复盘回合里（P4）bt_view / bt_inspect 看的是复盘请求持有的那个已结束的任务。
 *
 * 提交不合法不是工具错误：返回 { ok: false, errors, attemptsLeft }，大模型在同一回合里修正再交（§4.2）。
 * 结果都带 taskId / requestId / 树版本号——DSH 会话日志因此记下了"这次提交对应哪个任务的哪一版树"（§5.2 / §8.2）。
 *
 * @param {object} services
 * @param {import('../llm/bridge.js').Bridge} services.bridge
 * @param {number} services.maxOutputChars
 */
export function treeTools({ bridge, maxOutputChars, inspectMaxBytes = 8000 }) {
  const code = {
    type: 'json',
    description: '可选：本次提交附带的任务内代码草稿 { 名字: { signature, body, description? } }；树里用 "task/名字" 引用（cond 或 compute），只在本任务内有效。同名重写 = 新版本'
  }

  return [
    {
      name: 'bt_view',
      description: '看当前任务：树（每个节点的 id、种类与最近一次返回码；← 标出待展开的节点）、黑板、在飞请求、代码草稿。',
      parameters: {},
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(renderView(value, maxOutputChars)) },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        return bridge.view({ sessionId: sessionOf(exec) })
      }
    },
    {
      name: 'bt_inspect',
      description: [
        '看当前任务"发生了什么"（修复 / 复盘请求的目录里列出了可看的东西）。what 选一种：',
        '- events：本任务事件日志，可按 node（id 前缀）、type（事件类型前缀，如 node / observe / patch）、last（最近 N 条，默认 30）过滤',
        '- snapshot：一份快照（name 取自目录，如 before@n1.3.2、episode-end）；sources 只取部分来源；against 给另一份快照名 → 返回两份之间的差异',
        '- node：一个节点的定义、状态、错误、执行次数、补丁来源',
        '- eval：用现在（或 at 指定的快照里）的状态和当前黑板对一个 cond 节点求值',
        '- blackboard：黑板里 keys 这些键的值',
        '- live：现在读一次 sources（player / inventory / container / f3，缺省全读），同时存成 live#n 快照供之后对比',
        '- versions：本任务读过的记忆数据源的版本',
        '- tree：树的版本链。不给 version = 版本表（每一版从哪来：大纲 / 展开 / 修复）；给 version = 那一版的树；再给 against（另一个版本号）= 两版之差',
        '复盘已结束的任务时没有 live，eval 要给 at（任务过程中的快照）。',
        '记忆世界（方块、实体、配方）的值这里看不到：树要用到就在树里查。'
      ].join('\n'),
      parameters: {
        what: { type: 'string', enum: [...INSPECT_KINDS], required: true, description: '查看方式' },
        node: { type: 'string', description: 'events：节点 id 前缀' },
        type: { type: 'string', description: 'events：事件类型前缀' },
        last: { type: 'integer', description: 'events：最近多少条（1–200，默认 30）' },
        name: { type: 'string', description: 'snapshot：快照名' },
        against: { type: 'string', description: 'snapshot：另一份快照名，给了就返回差异（from = against，to = name）；tree：另一个版本号（如 "3"）' },
        version: { type: 'integer', description: 'tree：版本号' },
        sources: { type: 'array', items: { type: 'string', enum: [...ALL_STATE_SOURCES] }, description: 'snapshot / live：只要这些来源' },
        id: { type: 'string', description: 'node / eval：节点 id' },
        at: { type: 'string', description: 'eval：用这份快照求值（缺省 = 现在读）' },
        keys: { type: 'array', items: { type: 'string' }, description: 'blackboard：要看的键' }
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(value.ok ? capBytes(JSON.stringify(value.value, null, 1), inspectMaxBytes) : `没有结果：${value.error}`) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        // DSH 只收无损 JSON（undefined、NaN、函数都不行）：快照来自 mod、节点定义来自树，统一过一遍 JSON
        return JSON.parse(JSON.stringify(await bridge.inspect(args, { sessionId: sessionOf(exec) })))
      }
    },
    {
      name: 'bt_submit_tree',
      description: [
        '提交新任务的大纲树（编写格式，见系统提示词"树的编写格式"）。requestId 是规划请求的 id（pN）。',
        '通过 → 任务立即开始执行；不通过 → 返回逐条错误与剩余次数，请在本回合内修正后重交。'
      ].join('\n'),
      parameters: {
        requestId: { type: 'string', required: true, description: '规划请求 id，如 "p1"' },
        tree: { type: 'json', required: true, description: '大纲树（编写格式的根节点）' },
        code,
        blackboard: { type: 'object', additionalProperties: true, description: '可选：任务开始时的黑板（常量、目标数量等）' }
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(renderSubmission(value)) },
      async execute(args, exec) {
        return bridge.submitTree({ sessionId: sessionOf(exec), requestId: args.requestId, tree: args.tree, code: args.code, blackboard: args.blackboard })
      }
    },
    {
      name: 'bt_submit_expansion',
      description: [
        '提交一个展开：用一棵子树（编写格式）替换展开请求里的那个 expand 节点。requestId 是展开请求的 id（rN）。',
        '子树里可以再带 expand（只沿第一条路径拆到底，其余留给以后展开）。通过 → 任务树下一个 tick 继续；不通过 → 逐条错误与剩余次数，本回合内修正后重交。'
      ].join('\n'),
      parameters: {
        requestId: { type: 'string', required: true, description: '展开请求 id，如 "r3"' },
        subtree: { type: 'json', required: true, description: '替换 expand 节点的子树（编写格式）' },
        code
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(renderSubmission(value)) },
      async execute(args, exec) {
        return bridge.submitExpansion({ sessionId: sessionOf(exec), requestId: args.requestId, subtree: args.subtree, code: args.code })
      }
    },
    {
      name: 'bt_submit_patch',
      description: [
        '回答修复请求（recover / escalate / failed / died）：一组修改任务树的操作。requestId 是修复请求的 id（rN）。',
        'ops 每项是 { op, id, node? }：replace（换掉 id 节点）、insert-before / insert-after（在 seq / sel 里 id 节点的前 / 后插入）、remove（删掉 id 节点）；node 是编写格式的子树。',
        'ops 为空 = 原树继续（被中断 / 失败的那一步从头重新开始）。',
        '已经执行完的步骤不会重跑，改它们会被拒绝；要补做，在当前步骤前 insert-before。',
        '通过 → 任务树下一个 tick 继续；不通过 → 逐条错误与剩余次数，本回合内修正后重交。'
      ].join('\n'),
      parameters: {
        requestId: { type: 'string', required: true, description: '修复请求 id，如 "r5"' },
        ops: { type: 'array', required: true, items: { type: 'object', additionalProperties: true }, description: '操作列表，可以为空' },
        code
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(renderSubmission(value)) },
      async execute(args, exec) {
        return bridge.submitPatch({ sessionId: sessionOf(exec), requestId: args.requestId, ops: args.ops, code: args.code })
      }
    },
    {
      name: 'bt_abort_task',
      description: '放弃：正在规划的新任务，或正在执行的任务（默认中止流程：松开按键、关容器）。写明理由。',
      parameters: {
        reason: { type: 'string', required: true, description: '为什么放弃' },
        requestId: { type: 'string', description: '可选：要放弃的请求 id' }
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(value.ok ? `已放弃${value.cancelled === 'plan' ? `规划请求 ${value.requestId}` : `任务 ${value.taskId}`}` : `没有放弃：${value.error}`) },
      async execute(args, exec) {
        return bridge.abort({ sessionId: sessionOf(exec), requestId: args.requestId ?? null, reason: args.reason })
      }
    }
  ]
}

function renderSubmission(value) {
  if (value.ok) {
    const head = `已接受：任务 ${value.taskId}，请求 ${value.requestId}，树 v${value.version}。`
    if (value.tree) return `${head}任务已开始执行。\n${value.tree}`
    return `${head}新节点：${(value.ids ?? []).join(', ')}`
  }
  if (value.stale) {
    const directory = value.directory ? `\n\n新的目录：\n${renderDirectory(value.directory)}` : ''
    return `被拒绝（不计入次数）：${value.error}\n期间发生：\n${JSON.stringify(value.events, null, 1)}${directory}`
  }
  if (value.errors) {
    const tail = value.planningFailed || value.taskFailed
      ? '次数已用完，' + (value.planningFailed ? '规划请求作废。' : '任务失败。')
      : `还剩 ${value.attemptsLeft} 次，请修正后重交。`
    return `不合法：\n${value.errors.map((e) => `- ${e}`).join('\n')}\n${tail}`
  }
  return `没有接受：${value.error}`
}

/** 按 UTF-8 字节截断（P2 §4.4：每次结果不超过 inspectMaxBytes），提示缩小范围。 */
function capBytes(text, maxBytes) {
  const bytes = Buffer.byteLength(text)
  if (bytes <= maxBytes) return text
  let cut = text.slice(0, maxBytes)
  while (Buffer.byteLength(cut) > maxBytes) cut = cut.slice(0, -64)
  return `${cut}\n…（结果共 ${bytes} 字节，已截断到 ${maxBytes}；请缩小范围：snapshot 加 sources 或用 against 只看差异，events 加 node / type 过滤或调小 last）`
}

function renderView(value, maxChars) {
  const lines = []
  if (value.planning) lines.push(`规划中：请求 ${value.planning.requestId}（任务 ${value.planning.taskId}）— ${value.planning.instruction}`)
  const task = value.task
  if (!task) {
    lines.push(lines.length ? '' : '没有任务')
    return lines.join('\n').trim()
  }
  if (value.reviewing) lines.push(`复盘中（请求 ${value.reviewing}）：下面是已结束的那个任务`)
  lines.push(`任务 ${task.taskId}：${task.state}，树 v${task.version}${task.goal ? ` — ${task.goal}` : ''}`)
  if (task.pending) lines.push(`在飞请求：${task.pending.requestId} ${task.pending.type}${task.pending.nodeId ? ` @${task.pending.nodeId}` : ''}${task.pending.stale ? '（已过期）' : ''}${task.pending.title ? ` — ${task.pending.title}` : ''}`)
  if (task.result) lines.push(`结果：${task.result}`)
  lines.push('', '树：', task.tree, '', '黑板：', task.blackboard)
  if (task.drafts.length) lines.push('', `代码草稿：${task.drafts.join(', ')}`)
  const text = lines.join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截断）` : text
}
