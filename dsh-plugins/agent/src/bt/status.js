/**
 * 返回码（行为树设计 §1）+ 一个独立的控制信号。
 *
 * NEEDS_EXPANSION 不是第四个返回码：它只由 PendingExpansion 产生，控制节点把它
 * 当成"还没做完"原样上抛（与 RUNNING 同一条路径），执行器据此挂起任务树（§4.3）。
 */
export const SUCCESS = 'SUCCESS'
export const FAILURE = 'FAILURE'
export const RUNNING = 'RUNNING'
export const NEEDS_EXPANSION = 'NEEDS_EXPANSION'

export function isTerminal(status) {
  return status === SUCCESS || status === FAILURE
}
