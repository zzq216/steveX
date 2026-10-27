import { SUCCESS, FAILURE, RUNNING, NEEDS_EXPANSION, isTerminal } from './status.js'
import { resolveParams, applyWrites } from './blackboard.js'
import { diffState, summarizeDiff } from './observe.js'

/**
 * 行为树节点（行为树设计 §2–§4）。
 *
 * tick 是**同步**的：要和 mod 打交道的叶子在第一次 tick 时发起异步操作并返回 RUNNING，
 * 之后每个 tick 只看它有没有完成。tick 里因此永远不会等待（§7.3 的硬约束）。
 *
 * 节点状态的三种变化：
 * - tick：一个节点上次返回过 SUCCESS / FAILURE，再被 tick 时从头开始（自动 reset）
 * - abort：中止当前活跃路径。控制节点**保留游标**、只转发给活跃孩子；叶子停掉在飞操作并回到起点
 *   ——被中断的最小任务（正在跑的 Steps / 原语）整段作废，祖先不动（§6.5.1）
 * - reopenFailure：根失败后的原地重试（§7.5 ①）。沿失败路径清掉"已结束"标记，失败叶子回到起点
 */
export class Node {
  constructor(spec) {
    this.id = spec.id
    this.type = spec.type
    this.name = spec.name ?? null
    this.spec = spec
    this.done = false
    this.started = false
    this.lastStatus = null
    this.lastError = null
  }

  tick(ctx) {
    if (this.done) this.reset()
    if (!this.started) {
      this.started = true
      ctx.onNode?.(this, 'enter')
    }
    const status = this.onTick(ctx)
    this.lastStatus = status
    if (isTerminal(status)) {
      this.done = true
      ctx.onNode?.(this, 'exit', status)
    }
    return status
  }

  reset() {
    this.done = false
    this.started = false
    this.lastStatus = null
    this.lastError = null
    this.onReset()
    for (const child of this.children()) child.reset()
  }

  abort(ctx) {
    this.onAbort(ctx)
  }

  /** @returns {boolean} 是否找到了可以重试的失败叶子 */
  reopenFailure() {
    if (this.lastStatus !== FAILURE) return false
    this.done = false
    return this.onReopenFailure()
  }

  children() { return [] }

  /** 展开时把一个孩子（PendingExpansion）换成新子树；游标不动，下一个 tick 直接跑新子树。 */
  replaceChild(oldChild, newChild) {
    throw new Error(`${this.type} cannot replace child ${oldChild.id} with ${newChild.id}`)
  }

  onTick() { throw new Error(`${this.type}.onTick not implemented`) }
  onReset() {}
  onAbort() {}
  onReopenFailure() { this.reset(); return true }

  /** 扁平内省（G1：按 id 索引，O(节点数) 读取）。 */
  describe() {
    return { id: this.id, type: this.type, name: this.name, status: this.lastStatus, error: this.lastError }
  }
}

// ── 控制节点 ────────────────────────────────────────────────────────────────

class Composite extends Node {
  constructor(spec, kids) {
    super(spec)
    this.kids = kids
    this.mode = spec.mode
    this.cursor = 0
    this.active = null
    this.recheck = null   // reactive 复查进行到第几个守卫（null = 没在复查）
    this.checkedAt = 0    // 上次复查完成的时间
  }

  children() { return this.kids }
  replaceChild(oldChild, newChild) { this.kids[this.kids.indexOf(oldChild)] = newChild }

  /** 补丁插入（P2 §3.2）：插在游标处的新节点下一个执行，原来的当前孩子顺延。 */
  insertChild(index, child) {
    this.kids.splice(index, 0, child)
    if (this.mode === 'memory' && index < this.cursor) this.cursor++
    if (this.active !== null && index <= this.active) this.active++
  }

  /** 补丁删除：删掉当前孩子时游标不动，下一个孩子成为当前孩子。 */
  removeChild(child) {
    const index = this.kids.indexOf(child)
    this.kids.splice(index, 1)
    if (this.mode === 'memory' && index < this.cursor) this.cursor--
    if (this.active === index) this.active = null
    else if (this.active !== null && index < this.active) this.active--
  }

  onReset() { this.cursor = 0; this.active = null; this.recheck = null; this.checkedAt = 0 }

  onAbort(ctx) {
    const index = this.mode === 'memory' ? this.cursor : this.active
    if (index !== null && index < this.kids.length) this.kids[index].abort(ctx)
    if (this.recheck !== null && this.recheck !== undefined && this.recheck !== index) this.kids[this.recheck]?.abort(ctx)
    this.recheck = null
  }

  /** reactive：本 tick 停在的孩子与上一 tick 的活跃孩子不同时，中止旧的那个。 */
  settleReactive(index, status, ctx) {
    if (this.active !== null && this.active !== index) this.kids[this.active].abort(ctx)
    this.active = isTerminal(status) ? null : index
  }

  describe() {
    return { ...super.describe(), mode: this.mode, cursor: this.mode === 'memory' ? this.cursor : this.active }
  }
}

/**
 * Sequence。reactive 模式有两种节奏（P2 实施细则 §6.2）：
 * - 没有复查间隔（快树：条件读缓存、同步、便宜）：每 tick 从第一个孩子重跑
 * - 有复查间隔（`every`，或任务树的缺省 ctx.reactiveEveryMs）：有活跃孩子时，间隔内只 tick 它；
 *   到点后依次重跑它前面的孩子（守卫）。守卫返回 RUNNING（现场读状态还没回来）**不算翻转**，活跃孩子照常跑；
 *   守卫 FAILURE → 中止活跃孩子，序列 FAILURE
 */
export class Sequence extends Composite {
  onTick(ctx) {
    if (this.mode === 'memory') {
      while (this.cursor < this.kids.length) {
        const status = this.kids[this.cursor].tick(ctx)
        if (status !== SUCCESS) return status
        this.cursor++
      }
      return SUCCESS
    }
    const every = this.spec.every ?? ctx.reactiveEveryMs ?? null
    if (every !== null && this.active !== null) return this.tickPaced(ctx, every)
    for (let i = 0; i < this.kids.length; i++) {
      const status = this.kids[i].tick(ctx)
      if (status !== SUCCESS) {
        this.settleReactive(i, status, ctx)
        if (this.active !== null) this.checkedAt = ctx.now()
        return status
      }
    }
    this.settleReactive(null, SUCCESS, ctx)
    return SUCCESS
  }

  tickPaced(ctx, every) {
    if (this.recheck === null && ctx.now() - this.checkedAt >= every) this.recheck = 0
    while (this.recheck !== null && this.recheck < this.active) {
      const guard = this.recheck
      const status = this.kids[guard].tick(ctx)
      if (status === RUNNING) break
      if (status !== SUCCESS) {
        this.recheck = null
        this.settleReactive(guard, status, ctx)
        return status
      }
      this.recheck++
    }
    if (this.recheck !== null && this.recheck >= this.active) {
      this.recheck = null
      this.checkedAt = ctx.now()
    }
    for (let i = this.active; i < this.kids.length; i++) {
      const status = this.kids[i].tick(ctx)
      if (status === SUCCESS) continue
      // 前面的活跃孩子已经成功结束，不用中止；往后挪
      this.active = isTerminal(status) ? null : i
      if (this.active === null) this.stopRecheck(ctx)
      return status
    }
    this.active = null
    this.stopRecheck(ctx)
    return SUCCESS
  }

  stopRecheck(ctx) {
    if (this.recheck !== null) this.kids[this.recheck].abort(ctx)
    this.recheck = null
  }

  onReopenFailure() {
    const child = this.mode === 'memory' ? this.kids[this.cursor] : null
    return child ? child.reopenFailure() : false
  }
}

export class Selector extends Composite {
  onTick(ctx) {
    if (this.mode === 'memory') {
      while (this.cursor < this.kids.length) {
        const status = this.kids[this.cursor].tick(ctx)
        if (status !== FAILURE) return status
        this.cursor++
      }
      return FAILURE
    }
    for (let i = 0; i < this.kids.length; i++) {
      const status = this.kids[i].tick(ctx)
      if (status !== FAILURE) {
        this.settleReactive(i, status, ctx)
        return status
      }
    }
    this.settleReactive(null, FAILURE, ctx)
    return FAILURE
  }

  /** 全部孩子都失败了：重试最后一个备选。 */
  onReopenFailure() {
    if (this.mode !== 'memory' || this.kids.length === 0) return false
    this.cursor = this.kids.length - 1
    return this.kids[this.cursor].reopenFailure()
  }
}

/**
 * Match：互斥分类（§3.3）。`when` 用缓存读（`local_cached`），每 tick 重评；
 * 但**情节是边缘触发的**（§7.2）：命中的 arm 一旦 RUNNING，就跑完它才重新分类。
 * 执行器对快树根直接用 select() / tickArm()，以便在 arm 生效前先中止任务树。
 */
export class Match extends Node {
  constructor(spec, arms, otherwise) {
    super(spec)
    this.arms = arms // [{ when: Condition, then: Node }]
    this.otherwise = otherwise
    this.activeArm = null // -1 = otherwise
  }

  children() { return [...this.arms.flatMap((arm) => [arm.when, arm.then]), this.otherwise] }
  onReset() { this.activeArm = null }

  replaceChild(oldChild, newChild) {
    if (this.otherwise === oldChild) this.otherwise = newChild
    for (const arm of this.arms) if (arm.then === oldChild) arm.then = newChild
  }

  /** @returns {number} 第一个为真的 arm 下标；全假为 -1（otherwise） */
  select(ctx) {
    for (let i = 0; i < this.arms.length; i++) {
      if (this.arms[i].when.evaluateCached(ctx)) return i
    }
    return -1
  }

  branch(index) {
    return index === -1 ? this.otherwise : this.arms[index].then
  }

  tickArm(index, ctx) {
    if (this.activeArm !== index) {
      if (this.activeArm !== null) this.branch(this.activeArm).abort(ctx)
      this.branch(index).reset()
      this.activeArm = index
    }
    const status = this.branch(index).tick(ctx)
    this.lastStatus = status
    return status
  }

  onTick(ctx) {
    const inEpisode = this.activeArm !== null && this.activeArm !== -1 && !this.branch(this.activeArm).done
    const index = inEpisode ? this.activeArm : this.select(ctx)
    return this.tickArm(index, ctx)
  }

  onAbort(ctx) {
    if (this.activeArm !== null) this.branch(this.activeArm).abort(ctx)
  }

  onReopenFailure() {
    return this.activeArm === null ? false : this.branch(this.activeArm).reopenFailure()
  }

  describe() {
    return { ...super.describe(), activeArm: this.activeArm }
  }
}

/** Repeat：`n` 或 `until` 二选一（§3.5）。每轮开始时孩子游标归零；`until` 先检查后执行。 */
export class Repeat extends Node {
  constructor(spec, child, until) {
    super(spec)
    this.child = child
    this.until = until
    this.n = spec.n
    this.maxIterations = spec.maxIterations
    this.iteration = 0
    this.phase = until ? 'check' : 'body'
  }

  children() { return this.until ? [this.until, this.child] : [this.child] }
  replaceChild(oldChild, newChild) { if (this.child === oldChild) this.child = newChild }
  onReset() { this.iteration = 0; this.phase = this.until ? 'check' : 'body' }

  onTick(ctx) {
    if (this.phase === 'check') {
      const done = this.until.tick(ctx)
      if (!isTerminal(done)) return done
      if (done === SUCCESS) return SUCCESS
      this.phase = 'body'
    }
    if (this.n !== undefined && this.iteration >= this.n) return SUCCESS
    if (this.maxIterations !== undefined && this.iteration >= this.maxIterations) {
      this.lastError = `reached maxIterations (${this.maxIterations})`
      return FAILURE
    }
    const status = this.child.tick(ctx)
    if (status !== SUCCESS) return status
    this.iteration++
    this.child.reset()
    if (this.until) {
      this.until.reset()
      this.phase = 'check'
    } else if (this.iteration >= this.n) {
      return SUCCESS
    }
    // 每轮之间让出一个 tick：循环体瞬时成功时也不会在一个 tick 里空转
    return RUNNING
  }

  onAbort(ctx) {
    if (this.phase === 'check') this.until.abort(ctx)
    else this.child.abort(ctx)
  }

  onReopenFailure() {
    this.phase = 'body'
    if (this.child.lastStatus === FAILURE) return this.child.reopenFailure()
    // 失败来自 maxIterations：没有可以重试的叶子
    return false
  }

  describe() {
    return { ...super.describe(), iteration: this.iteration }
  }
}

/**
 * ForEach：逐项遍历黑板上的一个列表（行为树设计 §3.5，2026-10-24 加入）。
 *
 * - 进入时把 `list`（必须是 `$key` 引用）取一份快照；循环中途改那个键不影响本次遍历
 * - 每轮把当前元素写进 `as`（可选 `indexAs` 写下标），孩子游标归零后执行
 * - 孩子 FAILURE → 整个 ForEach FAILURE；全部 SUCCESS（含空列表）→ SUCCESS
 * - 被中止时**下标不动**：恢复后从被打断的那一项重来。这是它不用"pop 一个元素再处理"的原因——
 *   pop 之后被打断，那一项就丢了
 */
export class ForEach extends Node {
  constructor(spec, child) {
    super(spec)
    this.child = child
    this.items = null
    this.index = 0
  }

  children() { return [this.child] }
  replaceChild(oldChild, newChild) { if (this.child === oldChild) this.child = newChild }
  onReset() { this.items = null; this.index = 0 }

  onTick(ctx) {
    if (this.items === null) {
      let items
      try {
        items = resolveParams(this.spec.list, ctx.blackboard)
      } catch (error) {
        this.lastError = error.message
        return FAILURE
      }
      if (!Array.isArray(items)) {
        this.lastError = `${this.spec.list} is not a list`
        return FAILURE
      }
      if (this.spec.maxIterations !== undefined && items.length > this.spec.maxIterations) {
        this.lastError = `${this.spec.list} has ${items.length} items, over maxIterations (${this.spec.maxIterations})`
        return FAILURE
      }
      this.items = items
      this.index = 0
    }
    if (this.index >= this.items.length) return SUCCESS
    if (!this.child.started) {
      try {
        ctx.blackboard.set(this.spec.as, this.items[this.index])
        if (this.spec.indexAs) ctx.blackboard.set(this.spec.indexAs, this.index)
      } catch (error) {
        this.lastError = error.message
        return FAILURE
      }
    }
    const status = this.child.tick(ctx)
    if (status !== SUCCESS) {
      if (status === FAILURE) this.lastError = `item ${this.index}: ${this.child.lastError ?? 'failed'}`
      return status
    }
    this.index++
    this.child.reset()
    return this.index >= this.items.length ? SUCCESS : RUNNING
  }

  onAbort(ctx) { this.child.abort(ctx) }
  onReopenFailure() { return this.child.reopenFailure() }

  describe() {
    return { ...super.describe(), index: this.index, total: this.items?.length ?? null }
  }
}

/**
 * SubTree：调用 `capsules/trees/` 里的一棵可复用子树（行为树设计 §5.1.1 / §8.3）。
 *
 * - 胶囊体在装载时实例化（build.js），内部节点 id = `<调用点 id>/<胶囊内 id>`
 * - 进入时创建实例帧：形参（params，`$` 在调用方解析）拷进去；胶囊里的读先查实例帧、再查任务帧；写只写实例帧
 * - 退出（SUCCESS / FAILURE 都算）时把 signature.outputs 声明的键拷回调用方，然后丢弃实例帧
 * - 被中止时实例帧**冻结保留**（恢复时"这个胶囊走到哪了"是证据之一）
 */
export class SubTree extends Node {
  constructor(spec, child, entry) {
    super(spec)
    this.child = child
    this.entry = entry
    this.frame = null
  }

  children() { return [this.child] }
  onReset() { this.frame = null }

  onTick(ctx) {
    if (!this.frame) {
      try {
        this.frame = ctx.blackboard.child(resolveParams(this.spec.params ?? {}, ctx.blackboard))
      } catch (error) {
        this.lastError = error.message
        return FAILURE
      }
    }
    const status = this.child.tick({ ...ctx, blackboard: this.frame })
    if (!isTerminal(status)) return status
    try {
      for (const key of Object.keys(this.entry.signature.outputs ?? {})) {
        if (this.frame.hasOwn(key)) ctx.blackboard.set(key, this.frame.get(key))
      }
    } catch (error) {
      this.lastError = error.message
      return FAILURE
    }
    if (status === FAILURE) this.lastError = this.child.lastError
    this.frame = null
    return status
  }

  onAbort(ctx) { this.child.abort(ctx) }
  onReopenFailure() { return this.child.reopenFailure() }

  describe() {
    return { ...super.describe(), ref: this.spec.ref, frame: this.frame?.snapshot() ?? null }
  }
}

// ── 装饰器 ──────────────────────────────────────────────────────────────────

class Decorator extends Node {
  constructor(spec, child) {
    super(spec)
    this.child = child
  }

  children() { return [this.child] }
  replaceChild(oldChild, newChild) { if (this.child === oldChild) this.child = newChild }
  onAbort(ctx) { this.child.abort(ctx) }
  onReopenFailure() { return this.child.reopenFailure() }
}

export class Inverter extends Decorator {
  onTick(ctx) {
    const status = this.child.tick(ctx)
    if (status === SUCCESS) return FAILURE
    if (status === FAILURE) return SUCCESS
    return status
  }
}

export class Retry extends Decorator {
  constructor(spec, child) {
    super(spec, child)
    this.n = spec.n
    this.delayMs = spec.delayMs ?? 0
    this.attempts = 0
    this.waitUntil = 0
  }

  onReset() { this.attempts = 0; this.waitUntil = 0 }

  onTick(ctx) {
    if (this.waitUntil > ctx.now()) return RUNNING
    const status = this.child.tick(ctx)
    if (status !== FAILURE) return status
    if (this.attempts >= this.n) {
      this.lastError = this.child.lastError
      return FAILURE
    }
    this.attempts++
    this.child.reset()
    this.waitUntil = ctx.now() + this.delayMs
    return RUNNING
  }
}

export class Timeout extends Decorator {
  constructor(spec, child) {
    super(spec, child)
    this.ms = spec.ms
    this.startedAt = null
  }

  onReset() { this.startedAt = null }

  onTick(ctx) {
    if (this.startedAt === null) this.startedAt = ctx.now()
    if (ctx.now() - this.startedAt > this.ms) {
      this.child.abort(ctx)
      this.child.reset()
      this.lastError = `timed out after ${this.ms} ms`
      return FAILURE
    }
    return this.child.tick(ctx)
  }

  onReopenFailure() {
    this.startedAt = null
    if (this.child.lastStatus === FAILURE) return this.child.reopenFailure()
    this.child.reset()
    return true
  }
}

// ── 叶子 ────────────────────────────────────────────────────────────────────

/** 在飞的异步操作：第一次 tick 启动，之后只看结果。中止 = 作废这一次操作。 */
class AsyncLeaf extends Node {
  constructor(spec) {
    super(spec)
    this.op = null
  }

  onReset() {
    if (this.op) this.op.controller.abort()
    this.op = null
  }

  /** 中止：作废在飞操作；执行器会等它真正结束后再松键（ctx.trackAbort），以免迟到的按下盖掉松开。 */
  onAbort(ctx) {
    if (this.op && !this.op.settled) ctx?.trackAbort?.(this.op.promise)
    this.onReset()
    this.done = false
    this.started = false
    this.lastStatus = null
  }

  /** @param {(signal: AbortSignal) => Promise<any>} start */
  pump(start, onResult) {
    if (!this.op) {
      const controller = new AbortController()
      const op = { controller, settled: false, ok: false, value: undefined, error: null, promise: null }
      this.op = op
      op.promise = Promise.resolve()
        .then(() => start(controller.signal))
        .then(
          (value) => { op.settled = true; op.ok = true; op.value = value },
          (error) => { op.settled = true; op.ok = false; op.error = error }
        )
      return RUNNING
    }
    if (!this.op.settled) return RUNNING
    const op = this.op
    this.op = null
    if (!op.ok) {
      this.lastError = op.error?.message ?? String(op.error)
      return FAILURE
    }
    return onResult(op.value)
  }
}

/**
 * 会改变世界的叶子（Steps / Action）：前后各读一次状态，报告差异；有 `expect` 时结束后对读到的状态求值
 * （算法层 §8.8.2 的可观测性）。差异写进事件日志，失败时也附在错误文本里。
 */
class WorldLeaf extends AsyncLeaf {
  constructor(spec, expect = null) {
    super(spec)
    this.expect = expect
  }

  async observed(ctx, signal, run) {
    const observeSources = ctx.observe?.sources ?? []
    const sources = [...new Set([...observeSources, ...(this.expect?.command.sources ?? [])])]
    const before = observeSources.length ? await ctx.game.read(observeSources, signal) : null
    // 前后快照留给修复请求按需查看（P2 §4.3）
    if (before) ctx.onSnapshot?.(this, 'before', before)
    let result
    try {
      result = await run()
    } catch (error) {
      if (signal.aborted || !before) throw error
      const after = await ctx.game.read(observeSources).catch(() => null)
      if (after) ctx.onSnapshot?.(this, 'after', after)
      const diff = diffState(before, after)
      ctx.onObserve?.(this, diff)
      throw new Error(`${error.message}（失败前已发生：${summarizeDiff(diff)}）`)
    }
    if (sources.length === 0) return result
    const after = await ctx.game.read(sources, signal)
    if (before) ctx.onSnapshot?.(this, 'after', after)
    const diff = before ? diffState(before, after) : null
    if (before) ctx.onObserve?.(this, diff)
    if (this.expect && !this.expect.test(after, ctx)) {
      throw new Error(`expect 不成立：${describeCondition(this.expect.spec)}；实际发生：${summarizeDiff(diff)}`)
    }
    return result
  }
}

/**
 * Condition（§4.1）。只读、无副作用。条件来自两处，节点本身一样：
 * - 命令注册表里的条件（目前只有 blackboard/*）
 * - 条件代码：`capsules/code/` 里 returns: 'bool' 的条目，`read` 声明它要哪些状态来源（build.js 把它包成同一个接口）
 *
 * - 快树 / Match 的 `when`：同步读状态缓存（evaluateCached）
 * - 任务树：执行到这里时现场向 mod 读一次（集成方案 §3.3"按需读取"），读的过程中返回 RUNNING
 */
export class Condition extends AsyncLeaf {
  constructor(spec, command) {
    super(spec)
    this.command = command
  }

  test(snapshot, ctx) {
    const params = resolveParams(this.spec.params ?? {}, ctx.blackboard)
    return this.command.test(snapshot, params, ctx) === true
  }

  evaluateCached(ctx) {
    try {
      const snapshot = ctx.game.cached(this.command.sources ?? [])
      if (snapshot === null) return false
      return this.test(snapshot, ctx)
    } catch (error) {
      this.lastError = error.message
      return false
    }
  }

  onTick(ctx) {
    const sources = this.command.sources ?? []
    const judge = (snapshot) => {
      try {
        return this.test(snapshot, ctx) ? SUCCESS : FAILURE
      } catch (error) {
        this.lastError = error.message
        return FAILURE
      }
    }
    if (sources.length === 0) return judge({})
    return this.pump((signal) => ctx.game.read(sources, signal), judge)
  }
}

/** Action（§4.2）：一个 Action = 一条命令（mod 的原始命令）。 */
export class Action extends WorldLeaf {
  constructor(spec, command, expect) {
    super(spec, expect)
    this.command = command
  }

  onTick(ctx) {
    return this.pump(
      (signal) => this.observed(ctx, signal, () => {
        const params = resolveParams(this.spec.params ?? {}, ctx.blackboard)
        return this.command.run(params, ctx.game.env(signal))
      }),
      (result) => {
        try {
          applyWrites(this.spec.writes, result, ctx.blackboard)
        } catch (error) {
          this.lastError = error.message
          return FAILURE
        }
        return SUCCESS
      }
    )
  }
}

/** Steps（§4.4）：最小任务。一段无读取、无分支的命令序列，作为一个整体执行与作废。 */
export class Steps extends WorldLeaf {
  constructor(spec, commands, expect) {
    super(spec, expect)
    this.commands = commands // 与 spec.do 一一对应；wait 为 null
    this.stepIndex = 0
  }

  onTick(ctx) {
    return this.pump(
      (signal) => this.observed(ctx, signal, async () => {
        const env = ctx.game.env(signal)
        for (let i = 0; i < this.spec.do.length; i++) {
          if (signal.aborted) throw new Error('aborted')
          this.stepIndex = i
          const [cmd, params] = this.spec.do[i]
          try {
            if (cmd === 'wait') await env.sleep(Number(params))
            else await this.commands[i].run(resolveParams(params ?? {}, ctx.blackboard), env)
          } catch (error) {
            throw new Error(`step ${i} (${cmd}): ${error.message}`)
          }
        }
      }),
      () => SUCCESS
    )
  }

  onReset() {
    super.onReset()
    this.stepIndex = 0
  }
}

/**
 * Compute（§4.5 / 算法层 §3）：调用 `capsules/code/` 里的代码条目。
 * 不碰按键：沙箱条目是纯函数；内置查询条目（core.*）由宿主读白名单里的数据。
 * `read` 声明要哪些状态来源：执行时现场读一次，作为 main 的第二个参数 state 传入（与条件代码相同）。
 * 世界状态因此只进沙箱、不进黑板——进黑板的只有算出来的结论（如一份点击计划）。
 * 返回对象按 signature.outputs 校验，再按 `writes`（缺省 = 每个输出写进同名黑板键）写黑板。
 */
export class Compute extends AsyncLeaf {
  /** @param {{ entry, invoke(params, ctx, state): any|Promise<any> }} capsule  build.js 组装 */
  constructor(spec, capsule) {
    super(spec)
    this.capsule = capsule
  }

  onTick(ctx) {
    return this.pump(
      async (signal) => {
        const params = resolveParams(this.spec.params ?? {}, ctx.blackboard)
        const read = this.spec.read ?? []
        const state = read.length ? await ctx.game.read(read, signal) : undefined
        return this.capsule.invoke(params, ctx, state)
      },
      (output) => {
        try {
          const writes = this.spec.writes ?? Object.fromEntries(Object.keys(this.capsule.entry.signature.outputs ?? {}).filter((k) => k in output).map((k) => [k, k]))
          applyWrites(writes, output, ctx.blackboard)
        } catch (error) {
          this.lastError = error.message
          return FAILURE
        }
        return SUCCESS
      }
    )
  }

  describe() {
    return { ...super.describe(), ref: this.spec.ref }
  }
}

/** PendingExpansion（§4.3）：上抛 NEEDS_EXPANSION，由执行器挂起任务树、请求展开。 */
export class PendingExpansion extends Node {
  onTick(ctx) {
    ctx.requestExpansion?.(this)
    return NEEDS_EXPANSION
  }

  onReopenFailure() { return false }
}

function describeCondition(spec) {
  const what = spec.cmd ?? spec.ref
  const params = spec.params && Object.keys(spec.params).length ? ` ${JSON.stringify(spec.params)}` : ''
  return `${spec.name ? `${spec.name}（${what}）` : what}${params}`
}
