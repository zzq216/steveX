import { JSON_OUTPUT, textBlocks, sessionOf } from './shared.js'
import { formatProfile } from '../history/profile.js'

/**
 * 任务历史（任务历史与复盘评估设计方案 H2、H3、H5）：task_search、task_get、task_assess。
 *
 * task_search / task_get 在规划、展开、修补、复盘回合可用（HISTORY_TOOLS）；task_get 在规划 / 展开 / 修补回合里
 * 看过的记录记为本任务的前驱，复盘时核对它记下的问题（H7）。task_assess 只在复盘回合（REFLECT_ONLY_TOOLS）。
 *
 * @param {object} services
 * @param {import('../history/store.js').TaskHistory} services.history
 * @param {import('../llm/bridge.js').Bridge} services.bridge
 * @param {number} services.maxOutputChars
 */
export function historyTools({ history, bridge, maxOutputChars }) {
  return [
    {
      name: 'task_search',
      description: [
        '查以往做过的任务（任务历史）：看有没有做过同类任务。',
        '给 query = 按空白拆成几个词，指令、物品 id 或用到的胶囊名里含任一词就返回，含的词越多越靠前，相同时新的在前；不给 = 最近的。',
        '每条返回任务 id、时间、指令、结果、执行时间 execMs、mod 调用次数 modCalls、回合数、待验证问题条数、用到的主要胶囊。找不到同类任务时返回空列表。',
        '要看某条的树、成本画像与复盘时记下的问题，用 task_get。已归档的默认不返回，includeArchived = true 时一起返回。'
      ].join('\n'),
      parameters: {
        query: { type: 'string', description: '一个或几个词（空白分隔），不区分大小写' },
        outcome: { type: 'string', enum: ['done', 'failed'], description: '只看做成 / 失败的' },
        limit: { type: 'integer', description: '最多几条（默认 10，上限 50）' },
        includeArchived: { type: 'boolean', description: '也返回已归档的记录' }
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(renderSearch(value, maxOutputChars)) },
      isConcurrencySafe: () => true,
      async execute(args) {
        return { ok: true, tasks: history.search({ query: args.query ?? '', outcome: args.outcome ?? null, limit: args.limit ?? 10, archived: Boolean(args.includeArchived) }) }
      }
    },
    {
      name: 'task_get',
      description: [
        '取一条任务记录：指令、结果、指标、成本画像（花在哪：按胶囊 / 节点的 mod 调用与执行时间）、最终的树、复盘时记下的问题（status：open 待验证 / resolved 已解决 / wrong 判断有误 / blocked 受现有能力限制）。',
        '在规划 / 展开 / 修补时看过的记录算作本任务参考过的任务：本任务复盘时会把它待验证的问题列出来，请你核对这次有没有解决。',
        '树太长时只给开头；node 给了就只给以这个节点 id 开头的那些行。'
      ].join('\n'),
      parameters: {
        taskId: { type: 'string', required: true, description: '任务 id（task_search 结果里的）' },
        node: { type: 'string', description: '只看这个节点的子树，如 "n1.6"' }
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(renderRecord(value, maxOutputChars)) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const rec = history.get(args.taskId, { node: args.node ?? null })
        if (!rec) return { ok: false, error: `没有任务记录 ${args.taskId}（用 task_search 查 id）` }
        const viewedBy = bridge?.noteHistoryView?.(sessionOf(exec), rec.taskId) ?? null
        return { ok: true, record: rec, ...(viewedBy ? { viewedBy } : {}) }
      }
    },
    {
      name: 'task_assess',
      description: [
        '复盘时评估这次的树：成本高（mod 调用多）、耗时长、等 LLM 回合多、容易出错的地方。依据是复盘请求里的成本画像（需要细节用 bt_inspect）。可以多次调用，后一次覆盖前一次。',
        '- issues：0–5 条 { where, kind, problem, evidence, idea?, status? }。status 不写 = open（待以后的任务核对）；写 blocked = 受现有能力限制（缺少某个命令 / 能力，换写法也改不了），不再进以后的核对，仍挂在胶囊上可见。where = 节点 id 或这次用到的胶囊引用（可不带 @hash）；kind = cost / time / turns / fragile / other；problem 写问题是什么；evidence 写成本画像或事件里的依据；idea 可选，写你设想的改法',
        '- none：没有值得记的问题时写理由（如"每次合成只调用一次子树，调用次数已接近下限"）。issues 与 none 二选一',
        '- claims：复盘请求里列出了"涉及这次所用版本的待核对判断"时，逐条核对 { ref: "<名字>@<新版哈希>", claim: <方括号里的序号>, status: confirmed（这次的情况印证了判断）| refuted（这次的情况推翻了判断）| open（这次的情况说明不了）, evidence }',
        '- review：复盘请求里列出了以往任务待验证的问题时，逐条核对 { record, issue, status: resolved | open | wrong | blocked, evidence }（blocked = 受现有能力限制，以后不再核对）。record = 那条问题所属的任务 id（如 "task-20261107022153-2"），issue = 问题前面方括号里的序号（数字，如 [0] 就写 0）',
        '这条评估会和这次的树一起存进任务历史；问题挂在胶囊上时，用到这个胶囊的规划在 capsule_search 里也看得到。任务做成时，结束复盘前必须先评估。'
      ].join('\n'),
      parameters: {
        requestId: { type: 'string', required: true, description: '复盘请求 id，如 "c1"' },
        issues: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '问题列表' },
        none: { type: 'string', description: '没有问题时：为什么' },
        review: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '对以往任务待验证问题的核对' },
        claims: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '对版本判断的核对' }
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(renderAssess(value)) },
      async execute(args, exec) {
        return bridge.assess({ sessionId: sessionOf(exec), requestId: args.requestId, issues: args.issues, none: args.none, review: args.review, claims: args.claims })
      }
    }
  ]
}

const sec = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : '-')

function renderSearch(value, maxChars) {
  if (!value.tasks?.length) return '没有找到匹配的任务记录'
  const lines = [`${value.tasks.length} 条：`]
  for (const t of value.tasks) {
    lines.push(`- ${t.taskId}  ${t.at.slice(0, 16).replace('T', ' ')}  ${t.outcome ?? '?'}${t.archived ? '（已归档）' : ''}`)
    lines.push(`  指令：${t.goal}`)
    lines.push(`  执行 ${sec(t.execMs)}，mod 调用 ${t.modCalls ?? '-'}，回合 ${t.turns ?? '-'}${llmTimes(t)}，待验证问题 ${t.openIssues}${t.capsules.length ? `，胶囊：${t.capsules.join(', ')}` : ''}`)
  }
  const text = lines.join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截断；用 query 缩小范围或调小 limit）` : text
}

/** LLM 回合用时：规划（交树前）、执行中等 LLM（展开 / 修补）、复盘。没有记的不写。 */
function llmTimes(m) {
  const parts = [['规划', m.planMs], ['执行中等 LLM', m.waitMs], ['复盘', m.reflectMs]].filter(([, ms]) => Number.isFinite(ms))
  return parts.length ? `，${parts.map(([label, ms]) => `${label} ${sec(ms)}`).join('，')}` : ''
}

function renderRecord(value, maxChars) {
  if (!value.ok) return value.error
  const r = value.record
  const issues = r.assessment
    ? (r.assessment.issues.length
        ? r.assessment.issues.map((i) => `  [${i.index}] ${i.status}  ${i.where}（${i.kind}）：${i.problem}；证据：${i.evidence}${i.idea ? `；设想：${i.idea}` : ''}${(i.reviews ?? []).map((v) => `\n      核对（${v.by}）：${v.status}，${v.evidence}`).join('')}`).join('\n')
        : `  （没有问题：${r.assessment.none}）`)
    : '  （这次没有复盘评估）'
  const text = [
    `${r.taskId}  ${r.at.slice(0, 16).replace('T', ' ')}  ${r.outcome ?? '?'}${r.archived ? '（已归档）' : ''}`,
    `指令：${r.goal}`,
    `回合 ${r.metrics.turns ?? '-'}${r.metrics.tokens?.total ? `，token ${r.metrics.tokens.total}` : ''}${llmTimes(r.metrics)}${r.metrics.reflectTokens?.total ? `（复盘 token ${r.metrics.reflectTokens.total}）` : ''}${r.predecessors?.length ? `；参考过：${r.predecessors.join(', ')}` : ''}`,
    '',
    '成本画像：',
    formatProfile(r.profile),
    '',
    '复盘时记下的问题：',
    issues,
    '',
    '最终的树：',
    r.tree || '（没有）',
    ...(r.treeNote ? [r.treeNote] : []),
    ...(value.viewedBy ? ['', `（已记为任务 ${value.viewedBy} 参考过的任务：它复盘时会核对上面待验证的问题）`] : [])
  ].join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截断到 ${maxChars} 字符；用 node 参数只看某个子树）` : text
}

function renderAssess(value) {
  if (value.ok) return `已记下评估：${value.none ? '没有问题' : `${value.issues} 条问题`}${value.reviewed ? `，核对了 ${value.reviewed} 条以往的问题` : ''}${value.claims ? `，核对了 ${value.claims} 条版本判断` : ''}。用 bt_reflect_done 结束复盘（再调用 task_assess 会覆盖这次）`
  if (value.errors) return `评估没有记下，请按下面的错误修改后重交：\n- ${value.errors.join('\n- ')}`
  return `评估没有记下：${value.error}`
}

