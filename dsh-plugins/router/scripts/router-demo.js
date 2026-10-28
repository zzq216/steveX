/**
 * 路由框架演示（不依赖 DSH）：
 *   node scripts/router-demo.js
 *
 * 用脚本化槽位驱动 domain 编排器，打印选择结果、各 handler 的占位输出，
 * 以及 turn scope 的 LIFO / 异常隔离行为。
 */
import { createRouter } from '../src/domain/router.js'
import { createTurnScope } from '../src/domain/turn_scope.js'
import { createHandlers } from '../src/handlers.js'

function makeSlots({
  domain = 'minecraft',
  knowledge = 'none',
  action = 'none',
  artifact = 'none',
  reason = ''
} = {}) {
  const slot = (value) => ({ value, payload: null })
  return {
    slots: { domain: slot(domain), knowledge: slot(knowledge), action: slot(action), artifact: slot(artifact) },
    reason,
    clarification: null
  }
}

const cases = [
  ['正常回答', makeSlots({ domain: 'general', reason: '与 MC 无关' })],
  ['MC 事实', makeSlots({ knowledge: 'fact', reason: '陈述熔炉的熔炼时间' })],
  ['MC 任务', makeSlots({ action: 'execute', reason: '去挖 8 个铁矿' })],
  ['事实 + 任务', makeSlots({ knowledge: 'fact', action: 'execute', reason: '陈述熔炼时间，再去烧铁' })],
  ['快树（未支持）', makeSlots({ artifact: 'fast_tree', reason: '修改快树' })],
  ['unknown → 追问', makeSlots({ knowledge: 'unknown' })]
]

const router = createRouter()
for (const handler of createHandlers()) router.registerHandler(handler)

console.log('handlers:', router.handlerIds().join(', '))

for (const [label, slots] of cases) {
  const scope = createTurnScope({ label })
  const { decision, parts, errors } = await router.run(slots, { turn: scope, clarifyCount: 1 })

  console.log(`\n=== ${label} ===`)
  console.log('reason  :', slots.reason || '-')
  console.log('order   :', decision.order.join(' -> '), decision.exclusive ? '(exclusive)' : '')
  for (const part of parts) {
    console.log(`part    : ${part.id}: ${part.result?.text ?? JSON.stringify(part.result)}`)
  }
  if (errors.length > 0) console.log('errors  :', errors.map((entry) => entry.id).join(', '))
  const disposed = await scope.disposeAll()
  console.log('turn scope disposed:', disposed.count, 'disposer(s)')
}

console.log('\n=== turn scope：LIFO + 异常隔离 + 幂等 ===')
const disposedOrder = []
const scope = createTurnScope({ label: 'lifo' })
scope.onDispose(() => disposedOrder.push('first'))
scope.onDispose(() => { throw new Error('boom') })
scope.onDispose(async () => disposedOrder.push('third'))

const firstPass = await scope.disposeAll()
console.log('dispose order:', disposedOrder.join(' -> '))
console.log('errors       :', firstPass.errors.map((error) => error.message).join(', '))
const secondPass = await scope.disposeAll()
console.log('second pass  :', secondPass.count, 'disposer(s) (idempotent)')
