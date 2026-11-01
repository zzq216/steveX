import fs from 'node:fs'
import path from 'node:path'

import { renderTemplate } from '../llm/prompts.js'
import { candidates, craftableResults, loadRecipes, sample } from './sampler.js'

/**
 * 训练器（训练场设计方案 §3）：/bt train 每轮"给材料 → 发任务 → 判定 → 记录"，可连续多轮。
 *
 * 每轮一个新会话（T13）：执行 /bt train 的会话只当控制台，每轮开始、结束各插一条通知；
 * 本轮的规划、执行、复盘都在本轮自己的会话里，轮与轮之间不共享上下文。
 *
 * 一轮：
 *   等空闲（上一轮的复盘 / 整理结束，T11）→ 新建本轮会话 → arena/prepare（重置 + 发材料）→ startPlanning（计时起点 t0）
 *   → 每 pollMs 查 arena/status，等任务 done / failed、规划作废或超时（超时中止任务，T6）
 *   → arena/finish（读最终状态、传送出场）→ 等本轮会话空闲（复盘结束）→ 统计回合与 token → 追加一行 jsonl
 *
 * 判定只看事实（T4）：crafted 统计有没有增加 + 任务怎么结束的。合成成功不打断 agent，只记时刻。
 */

/** 目前只有这一类场地；场地名就是类型名。 */
const KINDS = ['craft2x2']
/** 中止之后等任务真正停下的上限 */
const SETTLE_TIMEOUT_MS = 30000
/** 记录里最多留几条 chat/send 的内容 */
const MAX_CHAT_SAMPLES = 5
/** 这些请求的回合不算进本轮（任务结束之后才有，T10） */
const AFTER_TASK_REQUESTS = ['reflect', 'curate']

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const seconds = (label, ms) => (ms === null || ms === undefined ? '' : `，${label} ${(ms / 1000).toFixed(1)} 秒`)

/**
 * `/bt train` 的参数：`<场地> [item=…] [runs=…] [seed=…]`。
 * @returns {{ ok: true, arena, item, runs, seed } | { ok: false, error }}
 */
export function parseTrainArgs(words) {
  const [arena, ...options] = words
  if (!arena) return { ok: false, error: '缺场地名，例如 /bt train craft2x2' }
  const out = { ok: true, arena, item: null, runs: 1, seed: null }
  for (const option of options) {
    const match = /^(item|runs|seed)=(.+)$/.exec(option)
    if (!match) return { ok: false, error: `看不懂的选项 "${option}"（可用 item= / runs= / seed=）` }
    const [, key, value] = match
    if (key === 'item') {
      if (!/^([a-z0-9_.-]+:)?[a-z0-9_/.-]+$/.test(value)) return { ok: false, error: `item 不像物品 id：${value}` }
      out.item = value
    } else {
      const n = Number(value)
      if (key === 'runs' && !(Number.isInteger(n) && n >= 1 && n <= 1000)) return { ok: false, error: 'runs 要是 1–1000 的整数' }
      if (key === 'seed' && !(Number.isInteger(n) && n >= 0 && n <= 0xFFFFFFFF)) return { ok: false, error: 'seed 要是 0–4294967295 的整数' }
      out[key] = n
    }
  }
  return out
}

/** 会话事件按回合切片：turn → turn/start 到 turn/end 之间的事件（没结束的回合不收）。 */
export function sliceTurns(events) {
  const slices = new Map()
  let open = null
  for (const event of events) {
    if (event?.type === 'turn/start') open = { turn: event.data?.turn, events: [] }
    if (!open) continue
    open.events.push(event)
    if (event.type === 'turn/end' && event.data?.turn === open.turn) {
      slices.set(open.turn, open.events)
      open = null
    }
  }
  return slices
}

/**
 * 几个回合的 token 合计（F8）：每个回合用 DSH 的 deriveTurnTokenUsage 算，有一个算不出就整体记 null，不估算。
 * @returns {{ input, output, total, cacheRead?, cacheWrite?, reasoning? } | null}
 */
export function sumTurnUsage(events, turns, deriveUsage) {
  if (!events || !deriveUsage) return null
  const slices = sliceTurns(events)
  const sum = { input: 0, output: 0, total: 0 }
  const optional = { cacheRead: 'cacheReadTokens', cacheWrite: 'cacheWriteTokens', reasoning: 'reasoningTokens' }
  const complete = Object.fromEntries(Object.keys(optional).map((k) => [k, true]))
  for (const turn of turns) {
    const slice = slices.get(turn)
    const usage = slice ? deriveUsage(slice) : undefined
    if (!usage) return null
    sum.input += usage.uncachedInputTokens
    sum.output += usage.outputTokens
    sum.total += usage.totalTokens
    for (const [key, field] of Object.entries(optional)) {
      if (usage[field] === undefined) complete[key] = false
      else sum[key] = (sum[key] ?? 0) + usage[field]
    }
  }
  for (const key of Object.keys(optional)) if (!complete[key]) delete sum[key]
  return sum
}

/**
 * 判定（T4）。
 * @returns {'success'|'crafted_but_failed'|'false_success'|'failed'|'timeout'|'aborted'}
 */
export function judge({ stopped, timedOut, setupError, taskState, crafted }) {
  if (stopped || setupError) return 'aborted'
  if (timedOut) return 'timeout'
  if (taskState === 'done') return crafted ? 'success' : 'false_success'
  return crafted ? 'crafted_but_failed' : 'failed'
}

export class Trainer {
  /**
   * @param {object} options
   * @param {object} options.bridge         Bridge（startPlanning / abort / busyReason / requests）
   * @param {object} options.executor       Executor（'task' / 'event' 事件、abortTask、task）
   * @param {object} options.game           GameState（mod.call、onCall）
   * @param {object} options.prompts        loadPrompts() 的结果（training.<场地>_<模式>）
   * @param {object} options.config         normalizeConfig().training
   * @param {string|null} options.runtimeDir
   * @param {(sessionId) => Promise<boolean>} options.whenIdle        会话回到空闲；会话不在了 → false
   * @param {(consoleSessionId) => Promise<string>} options.openSession  新建本轮的会话（模型跟随控制台会话），返回会话 id
   * @param {(sessionId, text) => void} options.notify                往控制台会话插一条通知（不开新回合）
   * @param {(sessionId) => boolean} options.sessionExists             控制台会话还在吗：不在了就不再开新的一轮
   * @param {(sessionId) => object[]|null} [options.sessionEvents]   会话的全部事件（算 token 用）
   * @param {(events) => object|undefined} [options.deriveUsage]      DSH 的 deriveTurnTokenUsage
   */
  constructor({ bridge, executor, game, prompts, config, runtimeDir, whenIdle, openSession, notify = () => {}, sessionExists = () => true,
    sessionEvents = () => null, deriveUsage = null, log = () => {}, now = () => Date.now(), sleep = defaultSleep, randomSeed = () => Math.floor(Math.random() * 0x100000000) }) {
    this.bridge = bridge
    this.executor = executor
    this.game = game
    this.prompts = prompts
    this.config = config
    this.runtimeDir = runtimeDir
    this.whenIdle = whenIdle
    this.openSession = openSession
    this.notify = notify
    this.sessionExists = sessionExists
    this.sessionEvents = sessionEvents
    this.deriveUsage = deriveUsage
    this.log = log
    this.now = now
    this.sleep = sleep
    this.randomSeed = randomSeed
    this.pool = null
    this.batch = null
    this.last = null
  }

  running() {
    return Boolean(this.batch)
  }

  /**
   * 开始一组训练（后台跑，立即返回）。
   * @returns {{ ok: true, text } | { ok: false, error }}
   */
  start({ sessionId, arena, item = null, runs = 1, seed = null }) {
    if (this.batch) return { ok: false, error: `训练 ${this.batch.id} 还在进行（第 ${this.batch.run}/${this.batch.runs} 轮）；先 /bt train stop` }
    if (!sessionId) return { ok: false, error: '/bt train 只能在会话里用' }
    if (!KINDS.includes(arena)) return { ok: false, error: `未知场地 ${arena}（目前只有 ${KINDS.join(', ')}）` }
    const arenaConfig = this.config.arenas[arena]
    if (!arenaConfig) return { ok: false, error: `配置里没有场地 ${arena}（training.arenas）` }
    let pool
    try {
      pool = this.candidates(arenaConfig)
      if (item) sample(pool, 0, item) // 目标没有配方就当场报错，不等到第一轮
    } catch (error) {
      return { ok: false, error: error.message }
    }
    const batch = {
      id: `b${new Date(this.now()).toISOString().replace(/[-:T]/g, '').slice(0, 14)}`,
      arena, arenaConfig, pool, sessionId, item, runs, seed,
      run: 0, outcomes: {}, current: null, stopping: false
    }
    this.batch = batch
    batch.promise = this.runBatch(batch)
      .catch((error) => this.log(`[train] ${batch.id} 出错停止：${error?.message ?? error}`))
      .finally(() => {
        if (this.batch === batch) this.batch = null
        this.last = batch
      })
    const what = item ? `目标 ${item}` : '每轮随机目标'
    return { ok: true, text: `训练 ${batch.id} 开始：场地 ${arena}，${runs} 轮，${what}${seed !== null ? `，seed=${seed}` : ''}。进度用 /bt train status 看` }
  }

  /** 中止当前轮并停止后续轮次（本轮记 aborted）。 */
  stop() {
    const batch = this.batch
    if (!batch) return { ok: false, error: '没有进行中的训练' }
    batch.stopping = true
    return { ok: true, text: `训练 ${batch.id} 正在停止：中止第 ${batch.run} 轮，不再开新的一轮` }
  }

  status() {
    const batch = this.batch ?? this.last
    if (!batch) return '还没有训练过（/bt train craft2x2 [item=…] [runs=…] [seed=…]）'
    const lines = [`训练 ${batch.id}${this.batch ? (batch.stopping ? '（正在停止）' : '（进行中）') : '（已结束）'}：场地 ${batch.arena}，第 ${batch.run}/${batch.runs} 轮`]
    const current = batch.current
    if (this.batch && current) {
      const elapsed = current.t0 ? `${Math.round((this.now() - current.t0) / 1000)}s` : '未开始'
      lines.push(`本轮：${current.target}（配方 ${current.recipe}，seed=${current.seed}），${current.phase}，已用 ${elapsed}${current.sessionId ? `，会话 ${current.sessionId}` : ''}${current.taskId ? `，任务 ${current.taskId}` : ''}`)
    }
    const outcomes = Object.entries(batch.outcomes).map(([k, v]) => `${k} ${v}`).join('，')
    lines.push(`结果：${outcomes || '（还没有）'}`)
    return lines.join('\n')
  }

  dispose() {
    if (this.batch) this.batch.stopping = true
  }

  candidates(arenaConfig) {
    this.pool ??= loadRecipes(this.config.recipes)
    return candidates(this.pool, arenaConfig.exclude)
  }

  async runBatch(batch) {
    for (let i = 1; i <= batch.runs && !batch.stopping; i++) {
      // 控制台会话关了：没地方发通知，也取不到要跟随的模型（T13）
      if (!this.sessionExists(batch.sessionId)) {
        this.log(`[train] ${batch.id}：控制台会话 ${batch.sessionId} 已关闭，不再开新的一轮`)
        break
      }
      batch.run = i
      const seed = batch.seed !== null ? (batch.seed + (i - 1) * 0x9E3779B9) >>> 0 : this.randomSeed()
      const record = await this.runOne(batch, i, seed)
      batch.outcomes[record.outcome] = (batch.outcomes[record.outcome] ?? 0) + 1
      this.write(batch.arena, record)
      this.log(`[train] ${batch.id} #${i} ${record.target}: ${record.outcome}${record.craftedMs !== null ? ` (${record.craftedMs} ms)` : ''}${record.error ? ` — ${record.error}` : ''}`)
      this.tellConsole(batch, `第 ${i}/${batch.runs} 轮结果 ${record.outcome}${seconds('合成用时', record.craftedMs)}${seconds('任务用时', record.taskMs)}${record.error ? `（${record.error}）` : ''}`)
      if (record.setupFailed) break
    }
    batch.current = null
    this.log(`[train] ${batch.id} 结束：${JSON.stringify(batch.outcomes)}`)
    const outcomes = Object.entries(batch.outcomes).map(([k, v]) => `${k} ${v}`).join('，')
    this.tellConsole(batch, `训练 ${batch.id} 结束：${outcomes || '没有跑完任何一轮'}。记录在 runtime/training/${batch.arena}.jsonl`)
  }

  tellConsole(batch, text) {
    if (!this.sessionExists(batch.sessionId)) return
    try {
      this.notify(batch.sessionId, text)
    } catch (error) {
      this.log(`[train] 控制台通知失败：${error?.message ?? error}`)
    }
  }

  async runOne(batch, run, seed) {
    const { arena, arenaConfig } = batch
    const picked = sample(batch.pool, seed, batch.item)
    const watch = craftableResults(batch.pool, picked.materials, picked.target)
    const mode = arenaConfig.mode
    const current = { run, seed, recipe: picked.recipe, target: picked.target, phase: '等空闲', t0: null, sessionId: null, taskId: null }
    batch.current = current
    const record = {
      arena, run, batch: batch.id, seed, recipe: picked.recipe, target: picked.target, mode,
      items: picked.materials, slots: picked.slots, watch,
      sessionId: null, taskId: null, outcome: null, t0: null, craftedMs: null, taskMs: null,
      craftedDelta: 0, craftedItem: null, inventoryHasTarget: false, insideArena: null,
      planAttempts: 0, treeVersions: null, nodeCalls: 0, capsules: [], turns: 0, tokens: null,
      usedChatSend: false, chatSends: [], error: null
    }
    const finishRecord = (fields) => Object.assign(record, fields)

    if (!(await this.waitIdle(null, batch))) return finishRecord({ outcome: 'aborted', error: 'stopped before start' })

    current.phase = '新建会话'
    let sessionId
    try {
      sessionId = await this.openSession(batch.sessionId)
    } catch (error) {
      return finishRecord({ outcome: 'aborted', error: `openSession: ${error?.message ?? error}`, setupFailed: true })
    }
    current.sessionId = sessionId
    finishRecord({ sessionId })
    this.tellConsole(batch, `第 ${run}/${batch.runs} 轮：会话 ${sessionId}，目标 ${picked.target}（配方 ${picked.recipe}，seed=${seed}）`)

    current.phase = '准备场地'
    const origin = arenaConfig.origin
    const prepared = await this.game.mod.call('arena/prepare', { arena, origin, items: picked.slots, watch, dayTime: 1000 })
    if (!prepared?.ok) {
      return finishRecord({ outcome: 'aborted', error: `arena/prepare: ${prepared?.error ?? 'no response'}`, setupFailed: true })
    }

    // 旁听：本轮的节点、任务结束、chat/send
    const state = { taskEnd: null, taskSeen: false, nodeCalls: 0, refs: new Set() }
    const onTask = (summary) => {
      if (!state.taskId || summary?.taskId !== state.taskId) return
      state.taskSeen = true
      if (summary.state === 'done' || summary.state === 'failed') state.taskEnd ??= { ...summary, at: this.now() }
    }
    const onEvent = (rec) => {
      if (!state.taskId || rec?.taskId !== state.taskId || rec.event !== 'node' || rec.phase !== 'exit') return
      state.nodeCalls++
      if (typeof rec.ref === 'string') state.refs.add(rec.ref)
    }
    const offCall = this.game.onCall?.((method, params) => {
      if (method !== 'chat/send' || !state.taskId) return
      record.usedChatSend = true
      if (record.chatSends.length < MAX_CHAT_SAMPLES) record.chatSends.push(String(params?.text ?? '').slice(0, 200))
    })
    this.executor.on('task', onTask)
    this.executor.on('event', onEvent)

    let stopped = false
    let timedOut = false
    let lastStatus = null
    try {
      const instruction = renderTemplate(this.prompts.training[`${arena}_${mode}`], { target: picked.target })
      const t0 = this.now()
      const planned = this.bridge.startPlanning({ sessionId, instruction })
      if (!planned.ok) {
        await this.game.mod.call('arena/finish', { arena, origin })
        return finishRecord({ outcome: 'aborted', error: `startPlanning: ${planned.error}`, setupFailed: true })
      }
      state.taskId = planned.taskId
      current.taskId = planned.taskId
      current.t0 = t0
      current.phase = '进行中'
      finishRecord({ taskId: planned.taskId, t0: new Date(t0).toISOString() })

      let abortedAt = null
      const ended = () => state.taskEnd || this.planFailed(planned, state)
      while (!ended()) {
        await this.sleep(this.config.pollMs)
        const res = await this.game.mod.call('arena/status', {})
        if (res?.ok) lastStatus = res.data
        if (ended()) break
        if (abortedAt !== null) {
          if (this.now() - abortedAt > SETTLE_TIMEOUT_MS) {
            record.error = 'task did not stop within 30s after abort'
            break
          }
          continue
        }
        if (batch.stopping) {
          stopped = true
          abortedAt = this.now()
          this.abortRun(sessionId, planned, 'training stopped (/bt train stop)', 'user')
        } else if (this.now() - t0 > this.config.timeoutSec * 1000) {
          timedOut = true
          abortedAt = this.now()
          current.phase = '超时，中止中'
          this.abortRun(sessionId, planned, `training timeout after ${this.config.timeoutSec}s`, 'timeout')
        }
      }

      current.phase = '结束本轮'
      const finished = await this.game.mod.call('arena/finish', { arena, origin })
      const final = finished?.ok ? finished.data : lastStatus
      if (!finished?.ok) record.error ??= `arena/finish: ${finished?.error ?? 'no response'}`
      const delta = final?.craftedDelta ?? {}
      const crafted = mode === 'hidden' ? watch.some((id) => (delta[id] ?? 0) > 0) : (delta[picked.target] ?? 0) > 0
      const craftedAtMs = final?.craftedAtMs ?? null
      finishRecord({
        outcome: judge({ stopped, timedOut, setupError: false, taskState: state.taskEnd?.state ?? 'failed', crafted }),
        craftedMs: craftedAtMs !== null ? craftedAtMs - t0 : null,
        taskMs: state.taskEnd ? state.taskEnd.at - t0 : null,
        craftedDelta: delta[picked.target] ?? 0,
        craftedItem: final?.craftedItem ?? null,
        inventoryHasTarget: (final?.inventory?.[picked.target] ?? 0) > 0,
        insideArena: final?.insideArena ?? null,
        treeVersions: state.taskEnd?.version ?? null,
        nodeCalls: state.nodeCalls,
        capsules: [...state.refs].sort()
      })
      if (state.taskEnd?.result && state.taskEnd.state === 'failed') record.taskResult = state.taskEnd.result
      if (!state.taskEnd && !stopped && !timedOut) record.error ??= 'planning closed without a tree'
    } finally {
      this.executor.off('task', onTask)
      this.executor.off('event', onEvent)
      offCall?.()
    }

    // 复盘 / 整理结束后再统计：它们的回合不算进本轮，但要等它们结束才能开下一轮（复盘在本轮的会话里）
    current.phase = '等复盘 / 整理结束'
    await this.waitIdle(sessionId, batch)
    const turns = this.turnsOf(record.taskId, sessionId)
    const plan = [...this.bridge.requests.values()].find((r) => r.type === 'plan' && r.taskId === record.taskId)
    finishRecord({
      planAttempts: plan ? plan.invalidAttempts + (plan.answered ? 1 : 0) : 0,
      turns: turns.length,
      tokens: sumTurnUsage(this.sessionEvents(sessionId), turns, this.deriveUsage)
    })
    return record
  }

  /** 规划请求关掉了却没有任务（大纲次数用完、被中止）。 */
  planFailed(planned, state) {
    const req = this.bridge.requests.get(planned.requestId)
    return Boolean(req?.closed) && !state.taskSeen && this.executor.task?.taskId !== planned.taskId
  }

  abortRun(sessionId, planned, reason, by) {
    const task = this.executor.task
    try {
      if (task?.taskId === planned.taskId && ['running', 'suspended', 'paused'].includes(task.state)) {
        this.executor.abortTask(reason, { by })
      } else {
        this.bridge.abort({ sessionId, requestId: planned.requestId, reason })
      }
    } catch (error) {
      this.log(`[train] abort failed: ${error.message}`)
    }
  }

  /** 本任务的规划、修补、展开请求绑定过的回合号（不含复盘、整理）。 */
  turnsOf(taskId, sessionId) {
    if (!taskId) return []
    const turns = new Set()
    for (const req of this.bridge.requests.values()) {
      if (req.taskId !== taskId || AFTER_TASK_REQUESTS.includes(req.type)) continue
      for (const bound of req.boundTurns ?? []) if (bound.sessionId === sessionId) turns.add(bound.turn)
    }
    return [...turns].sort((a, b) => a - b)
  }

  /**
   * 等到没有任务、请求；给了 sessionId 还要等这个会话空闲。会话不在了 → false；要停止时也 → false。
   */
  async waitIdle(sessionId, batch) {
    for (;;) {
      if (batch.stopping && !this.bridge.busyReason()) return false
      while (this.bridge.busyReason()) await this.sleep(this.config.pollMs)
      if (sessionId && !(await this.whenIdle(sessionId))) return false
      if (!this.bridge.busyReason()) return !batch.stopping
    }
  }

  write(arena, record) {
    if (!this.runtimeDir) return
    const { setupFailed, ...line } = record
    const dir = path.join(this.runtimeDir, 'training')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, `${arena}.jsonl`), JSON.stringify(line) + '\n')
  }
}
