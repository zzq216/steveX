/**
 * P0 的本地应答器：没有大模型时代替它回答执行器的请求（集成方案 §10 P0）。
 *
 * - recover / escalate → 原树继续（空补丁）：被中断的最小任务已经归零，从它重新开始
 * - failed / died      → 放弃任务
 * - expand             → 无法回答，任务保持挂起；人用 /bt abort 结束，或在 P1 交给大模型
 *
 * P1 起 expand 交给大模型（src/llm/bridge.js），这里用 `types` 去掉它；P2b 起属于某个会话的任务的修复请求
 * 也交给大模型，这里用 `skip` 跳过。只剩 /bt run 跑的手写树（不属于任何会话）和 scripts/bt-run.js 由这里回答（P2 §9.3）。
 *
 * @param {object} [options]
 * @param {string[]} [options.types]  只回答这些类型的请求（缺省 = 全部）
 * @param {(request) => boolean} [options.skip]  返回 true 的请求不回答
 */
export function createLocalResponder(executor, { log = () => {}, types = null, skip = null } = {}) {
  const onRequest = (request) => {
    const { requestId, type, evidence } = request
    if (types && !types.includes(type)) return
    if (skip?.(request)) return
    switch (type) {
      case 'recover':
      case 'escalate':
        log(`[bt] ${type} ${requestId}: 快树情节"${evidence.fastArm}"结束，被中断的 ${evidence.interrupted?.id ?? '（无）'} 从头重跑`)
        queueMicrotask(() => executor.submitPatch(requestId, []))
        break
      case 'died':
        log(`[bt] died ${requestId}: ${evidence.deathMessage ?? '死亡'}，已重生；没有大模型，放弃任务`)
        queueMicrotask(() => executor.answerRequest(requestId, { action: 'abort', reason: `died: ${evidence.deathMessage ?? 'unknown cause'}` }))
        break
      case 'failed':
        log(`[bt] failed ${requestId}: 节点 ${evidence.nodeId} 失败（${evidence.error ?? '无错误文本'}），P0 无大模型，放弃任务`)
        queueMicrotask(() => executor.answerRequest(requestId, { action: 'abort', reason: `node ${evidence.nodeId} failed: ${evidence.error}` }))
        break
      case 'expand':
        log(`[bt] expand ${requestId}: 节点 ${evidence.nodeId}"${evidence.goal}"需要展开；P0 没有大模型，任务挂起（/bt abort 结束）`)
        break
      default:
        log(`[bt] unhandled request ${type} ${requestId}`)
    }
  }
  executor.on('request', onRequest)
  return () => executor.off('request', onRequest)
}
