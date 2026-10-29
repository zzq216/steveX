import { JSON_OUTPUT, textBlocks, sessionOf } from './shared.js'

/**
 * 胶囊库整理（整理方案 §5.4）：capsule_retire、capsule_describe、bt_curate_done。只在整理回合可用（guard，CURATE_ONLY_TOOLS）。
 *
 * 改不动不是工具错误：返回 { ok: false, error }，大模型按原文改了重交，不计次数。
 *
 * @param {object} services
 * @param {import('../llm/bridge.js').Bridge} services.bridge
 */
export function curateTools({ bridge }) {
  return [
    {
      name: 'capsule_retire',
      description: [
        '整理时下架胶囊库里的一个条目（按名字），或撤销下架（undo: true）。可以多次调用。',
        '- 下架后 capsule_search 默认不返回它；capsule_get 照常能取；已保存的树里带哈希的引用照常能跑；新提交的树引用它只收到警告',
        '- reason 必填（下架或撤销都要写为什么），会记进库里；supersededBy 可选：取代它的条目',
        '- 内置条目与 locked 条目不能下架'
      ].join('\n'),
      parameters: {
        requestId: { type: 'string', required: true, description: '整理请求 id，如 "k1"' },
        ref: { type: 'string', required: true, description: '"code/<名字>" 或 "trees/<名字>"，可带 @hash' },
        reason: { type: 'string', required: true, description: '为什么下架（undo 时：为什么撤销）' },
        supersededBy: { type: 'string', description: '可选：取代它的条目，如 "code/craft.plan-grid-clicks"' },
        undo: { type: 'boolean', description: 'true = 撤销下架' }
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(renderChange(value)) },
      async execute(args, exec) {
        return JSON.parse(JSON.stringify(bridge.retireCapsule({ sessionId: sessionOf(exec), ...args })))
      }
    },
    {
      name: 'capsule_describe',
      description: '整理时改一个条目的说明（规划时在 capsule_search 里看到的那一行）。说明不在哈希里：不产生新版本，引用它的树不受影响。内置条目不能改。',
      parameters: {
        requestId: { type: 'string', required: true, description: '整理请求 id，如 "k1"' },
        ref: { type: 'string', required: true, description: '"code/<名字>" 或 "trees/<名字>"，可带 @hash' },
        description: { type: 'string', required: true, description: '新的说明：一句话，做什么、在什么前提下用' }
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(renderChange(value)) },
      async execute(args, exec) {
        return bridge.describeCapsule({ sessionId: sessionOf(exec), ...args })
      }
    },
    {
      name: 'bt_curate_done',
      description: '结束整理。reason 写改了什么、为什么；什么都没改就写为什么不需要改。',
      parameters: {
        requestId: { type: 'string', required: true, description: '整理请求 id，如 "k1"' },
        reason: { type: 'string', required: true, description: '整理的结论' }
      },
      output: {
        schema: JSON_OUTPUT,
        render: (_args, value) => textBlocks(value.ok ? `整理 ${value.requestId} 已结束；改动 ${value.changes.length} 处` : `没有结束：${value.error}`)
      },
      async execute(args, exec) {
        return JSON.parse(JSON.stringify(bridge.curateDone({ sessionId: sessionOf(exec), requestId: args.requestId, reason: args.reason })))
      }
    }
  ]
}

function renderChange(value) {
  if (!value.ok) return `没有改：${value.error}`
  if (value.op === 'retire') return `已下架：${value.key}${value.after.supersededBy ? `（取代者 ${value.after.supersededBy}）` : ''}${value.before ? '；原来就已下架，理由已更新' : ''}`
  if (value.op === 'undo') return `已撤销下架：${value.key}`
  return `已改说明：${value.key}\n原来：${value.before || '（无）'}\n现在：${value.after}`
}
