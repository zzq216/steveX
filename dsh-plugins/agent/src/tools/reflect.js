import { JSON_OUTPUT, textBlocks, sessionOf } from './shared.js'

/**
 * 任务复盘（P4 §4 / §6）：capsule_save、bt_reflect_done。只在复盘回合可用（guard，REFLECT_ONLY_TOOLS）。
 *
 * 存不进去不是工具错误：返回 { ok: false, errors }，大模型按错误原文改了重交；不计次数（P4 §4.4）。
 *
 * @param {object} services
 * @param {import('../llm/bridge.js').Bridge} services.bridge
 */
export function reflectTools({ bridge }) {
  return [
    {
      name: 'capsule_save',
      description: [
        '复盘时把这次任务里的子树或代码存进胶囊库（可以多次调用）。存进去之后，下一次规划就能 use: "trees/<name>" / compute: "code/<name>" 引用它。',
        '- folder "trees"：signature + body（编写格式的子树）。胶囊不能读调用方的任务帧：子树用到的外部值写成 signature.inputs，树里用 "$名字" 引用；写出的值是 signature.outputs。from 写它在任务树里对应的节点 id（只记出处）',
        '- folder "code"：from 写一个代码草稿（"task/<名字>"）就是转正，signature / body 省略 = 沿用草稿；也可以直接给 signature + body',
        '- 子树里引用的 task/ 草稿：本次复盘里已经转正过的会自动换成 code/ 引用；没转正的要先转正',
        '- 子树里调用代码的节点要带上它在任务树里的 read（代码读 state.<来源> 靠它）：给了 from 时会对照原节点检查，少了会被拒绝',
        '- 库里已有同名条目时必须写 replaces（它最新版的 hash），表示有意替换；否则换个名字',
        '- 字面量和这次任务里观察到的值相同（快照里的格子号、坐标、物品 id，查询 / 初始黑板里的值）会被拒绝：改成参数或读取；确实是常量就写进 keepLiterals，每条带理由（键照抄被拒时给的位置）。代码只比字符串'
      ].join('\n'),
      parameters: {
        requestId: { type: 'string', required: true, description: '复盘请求 id，如 "c1"' },
        folder: { type: 'string', enum: ['code', 'trees'], required: true, description: '存成子树（trees）还是代码（code）' },
        name: { type: 'string', required: true, description: '库内名字：小写字母 / 数字开头，可用 . _ -，如 "craft.wooden-pickaxe"' },
        description: { type: 'string', required: true, description: '一句话：做什么、在什么前提下用。规划时在胶囊清单里看到的就是这一行' },
        from: { type: 'string', description: 'trees：任务树里的节点 id（如 "n1.3"）；code：要转正的草稿（如 "task/plan-grid"）' },
        signature: { type: 'json', description: '{ inputs?, outputs?, returns? }；code 转正时可省略' },
        body: { type: 'json', description: 'trees：编写格式的子树；code：TS / JS 源码（定义 main(params, state)）。code 转正时可省略' },
        preconditions: { type: 'array', items: { type: 'string' }, description: '可选：适用条件' },
        replaces: { type: 'string', description: '替换库里已有的同名条目时：它当前最新版的 hash' },
        keepLiterals: { type: 'object', additionalProperties: true, description: '确认保留的字面量 { "<被拒时给出的位置>": "为什么是常量" }' }
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(renderSave(value)) },
      async execute(args, exec) {
        return JSON.parse(JSON.stringify(bridge.saveCapsule({ sessionId: sessionOf(exec), ...args })))
      }
    },
    {
      name: 'bt_reflect_done',
      description: '结束复盘。summary 写存了什么、为什么；什么都没存就写为什么这次没有值得存的。',
      parameters: {
        requestId: { type: 'string', required: true, description: '复盘请求 id，如 "c1"' },
        summary: { type: 'string', required: true, description: '复盘的结论' }
      },
      output: {
        schema: JSON_OUTPUT,
        render: (_args, value) => textBlocks(value.ok ? `复盘 ${value.requestId} 已结束；存下：${value.saved.join(', ') || '（无）'}` : `没有结束：${value.error}`)
      },
      async execute(args, exec) {
        return bridge.reflectDone({ sessionId: sessionOf(exec), requestId: args.requestId, summary: args.summary })
      }
    }
  ]
}

function renderSave(value) {
  if (value.ok) {
    const lines = [`已存：${value.ref}${value.created ? '' : '（库里已有完全相同的条目，没有新写）'}`]
    if (value.rewritten) lines.push(`草稿引用已换成转正后的条目：${value.rewritten.map((r) => `${r.id} ${r.from} → ${r.to}`).join('；')}`)
    if (value.from?.node) lines.push(`出处 ${value.from.node}：这次任务里执行 ${value.from.runs} 次，成功 ${value.from.successes} 次`)
    if (value.from?.draft) lines.push(`转正自 ${value.from.draft}`)
    if (value.keptLiterals) lines.push(`保留的字面量：${Object.keys(value.keptLiterals).join(', ')}`)
    return lines.join('\n')
  }
  if (value.errors) return `没有存：\n${value.errors.map((e) => `- ${e}`).join('\n')}\n请修正后重交（不计次数）。`
  return `没有存：${value.error}`
}
