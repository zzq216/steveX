import fs from 'node:fs'
import path from 'node:path'
import { compileTree } from '../bt/compiler.js'
import { walkSpec } from '../bt/build.js'
import { STATE_SOURCES } from '../bt/validator.js'
import { validateSignature } from '../capsules/signature.js'
import { SandboxError } from '../capsules/sandbox.js'

/**
 * 快树版本链（P3 实施细则 §7 / §8）：
 *
 *   <dir>/v<N>.json       执行格式的完整快树（胶囊引用都钉到 hash）
 *   <dir>/v<N>.meta.json  { version, base, by: 'reflection' | 'rollback' | 'manual', batchId?, events?, ops?, reason, code?, createdAt }
 *
 * - 版本 0 = 空快树（没有文件）。最新的一版就是生效的一版（只增不减，回滚也是新的一版，P3-D10）
 * - 补丁按 arm 名字寻址（then 根节点的名字，P3-D8）：add / replace / remove / move；otherwise 不能改
 * - 补丁附带的条件代码以 fast. 前缀暂存在胶囊库里，补丁被接受才写进库（P3-D9）
 * - 写操作串行：补丁写明 base，不是最新版就拒绝并附上差异（T9 约束 3）
 */
export const FAST_OPS = Object.freeze(['add', 'replace', 'remove', 'move'])
export const EMPTY_FAST_TREE = Object.freeze({ match: '快树', arms: [] })

export class FastVersions {
  /**
   * @param {object} options
   * @param {string|null} options.dir   版本链目录；null = 只在内存里（测试）
   * @param {import('../bt/executor.js').Executor} options.executor
   * @param {object} options.library    胶囊库（暂存 / 写入条件代码）
   * @param {object} options.sandbox
   * @param {object} [options.config]   { maxArms, maxNodesPerArm, maxEpisodeMs }
   */
  constructor({ dir = null, executor, library, sandbox, config = {}, now = () => Date.now() }) {
    this.dir = dir
    this.executor = executor
    this.library = library
    this.sandbox = sandbox
    this.config = { maxArms: 30, maxNodesPerArm: 15, maxEpisodeMs: 30000, ...config }
    this.now = now
    this.memory = new Map() // version → { spec, meta }（没有 dir 时）
    this.latestVersion = this.scan()
  }

  scan() {
    let best = 0
    if (this.dir && fs.existsSync(this.dir)) {
      for (const name of fs.readdirSync(this.dir)) {
        const match = /^v(\d+)\.json$/.exec(name)
        if (match) best = Math.max(best, Number(match[1]))
      }
    }
    for (const version of this.memory.keys()) best = Math.max(best, version)
    return best
  }

  latest() {
    return this.latestVersion
  }

  /** 写之前重新看一眼目录：别的进程（另一个 DSH、人手放的文件）可能已经写了更新的版本。 */
  refresh() {
    this.latestVersion = Math.max(this.latestVersion, this.scan())
  }

  /** 启动时装载最新版（版本 0 = 空快树）。旧版本文件不合法（比如引用的胶囊没了）→ 抛错。 */
  loadLatest() {
    const version = this.latestVersion
    const spec = version === 0 ? EMPTY_FAST_TREE : this.read(version).spec
    return this.executor.loadFastTree(spec, { version, meta: { by: 'startup' } })
  }

  /** @returns {{ spec, meta } | null} */
  read(version) {
    if (version === 0) return { spec: compileTree(EMPTY_FAST_TREE, { kind: 'fast', rootId: 'f' }), meta: { version: 0, by: 'empty', reason: '空快树' } }
    if (this.memory.has(version)) return this.memory.get(version)
    if (!this.dir) return null
    const file = path.join(this.dir, `v${version}.json`)
    if (!fs.existsSync(file)) return null
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'))
    const metaFile = path.join(this.dir, `v${version}.meta.json`)
    const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : { version, by: 'manual', reason: '（手放的版本文件，没有元数据）' }
    return { spec, meta }
  }

  /** 全部版本的元数据（从新到旧）。 */
  list(limit = Infinity) {
    const out = []
    for (let v = this.latestVersion; v >= 1 && out.length < limit; v--) {
      const entry = this.read(v)
      if (entry) out.push(entry.meta)
    }
    return out
  }

  // ── 写 ───────────────────────────────────────────────────────────────────

  /**
   * 反思会话的补丁（fast_submit_patch）。
   * @param {object} patch  { base, ops, code?, reason, batchId?, events? }
   * @returns {{ ok: true, version, arms, diff } | { ok: false, errors: string[], conflict?: object }}
   */
  submit({ base, ops, code = null, reason, batchId = null, events = [] }) {
    const errors = []
    if (!Number.isInteger(base)) errors.push('base must be the version number the patch is based on (an integer)')
    if (!Array.isArray(ops) || ops.length === 0) errors.push('ops must be a non-empty list (to change nothing, use fast_skip)')
    if (typeof reason !== 'string' || !reason.trim()) errors.push('reason is required: say what the events showed and why this change fixes it')
    if (errors.length) return { ok: false, errors }
    this.refresh()
    if (base !== this.latestVersion) return { ok: false, errors: [`base v${base} is not the latest version v${this.latestVersion}; redo the patch on v${this.latestVersion}`], conflict: this.conflict(base) }

    const codeEntries = normalizeCode(code, errors)
    if (errors.length) return { ok: false, errors }
    const current = this.read(base).spec
    return this.withStaged(codeEntries, (stageErrors) => {
      if (stageErrors.length) return { ok: false, errors: stageErrors }
      const applied = applyOps(current, ops)
      if (applied.errors.length) return { ok: false, errors: applied.errors }
      const checked = this.check(applied.tree)
      if (!checked.ok) return checked
      return this.commit(checked.spec, {
        base, by: 'reflection', batchId, events, ops, reason: reason.trim(),
        code: codeEntries.length ? codeEntries.map((e) => e.name) : undefined
      }, codeEntries.length > 0)
    })
  }

  /** /bt fast rollback：把第 target 版的内容另存为新的一版（P3-D10）。 */
  rollback(target, reason = null) {
    this.refresh()
    if (!Number.isInteger(target) || target < 0 || target > this.latestVersion) {
      return { ok: false, errors: [`no version v${target} (latest is v${this.latestVersion})`] }
    }
    if (target === this.latestVersion) return { ok: false, errors: [`v${target} is already the current version`] }
    const entry = this.read(target)
    if (!entry) return { ok: false, errors: [`version file v${target} is missing`] }
    const checked = this.check(entry.spec)
    if (!checked.ok) return { ok: false, errors: [`v${target} no longer validates:`, ...checked.errors] }
    return this.commit(checked.spec, { base: this.latestVersion, by: 'rollback', target, reason: reason ?? `回滚到 v${target}` }, false)
  }

  /** /bt fast load：人手动放一版（比如手写的初始反射），走同样的校验。 */
  loadManual(tree, reason) {
    this.refresh()
    const checked = this.check(tree)
    if (!checked.ok) return checked
    return this.commit(checked.spec, { base: this.latestVersion, by: 'manual', reason }, false)
  }

  /** 暂存代码 → fn → 无论成败都撤掉暂存（被接受的那次由 commit 写进库）。 */
  withStaged(entries, fn) {
    const errors = []
    for (const entry of entries) errors.push(...checkCode(entry, this.sandbox))
    if (errors.length) return fn(errors)
    try {
      this.library.stage(entries)
    } catch (error) {
      return fn([error.message])
    }
    try {
      return fn([])
    } finally {
      this.library.unstage()
    }
  }

  /**
   * 校验一棵完整快树：编译、钉引用、快树校验器，加上快树进化专有的规则（P3 §7.3）。
   * @returns {{ ok: true, spec } | { ok: false, errors }}
   */
  check(tree) {
    const { spec, check } = this.executor.prepare(tree, { kind: 'fast', rootId: 'f' })
    if (!check.ok) return { ok: false, errors: check.errors }
    const errors = []
    const names = new Set()
    if (spec.arms.length > this.config.maxArms) errors.push(`the fast tree may have at most ${this.config.maxArms} arms (got ${spec.arms.length})`)
    spec.arms.forEach((arm, i) => {
      const name = arm.then.name
      const label = name ? `arm "${name}"` : `arm ${i + 1}`
      if (!name) errors.push(`${label}: the root of "then" needs a name (the seq / steps name, or "name") — arms are addressed by it`)
      else if (names.has(name)) errors.push(`${label}: two arms share this name; arm names must be unique`)
      names.add(name)
      let nodes = 0
      walkSpec(arm.then, (node) => {
        nodes++
        if (node.type === 'Steps') {
          const waits = node.do.filter(([cmd]) => cmd === 'wait').reduce((sum, [, ms]) => sum + (Number(ms) || 0), 0)
          if (waits > this.config.maxEpisodeMs) errors.push(`${label} [${node.id}]: waits add up to ${waits} ms; an episode is cut off after ${this.config.maxEpisodeMs} ms`)
        }
      })
      if (nodes > this.config.maxNodesPerArm) errors.push(`${label}: "then" has ${nodes} nodes; at most ${this.config.maxNodesPerArm}`)
      walkSpec(arm.when, (node) => {
        const bad = (node.read ?? []).filter((s) => !STATE_SOURCES.includes(s))
        if (bad.length) errors.push(`${label} when [${node.id}]: read ${bad.join(', ')} is not a polled state source (${STATE_SOURCES.join(' / ')})`)
      })
    })
    if (errors.length) return { ok: false, errors }
    errors.push(...this.trial(spec))
    return errors.length ? { ok: false, errors } : { ok: true, spec }
  }

  /** 每个 when 用当前缓存试算一次：抛错（字段不存在、超时……）的条件每 tick 都会是假，等于这条 arm 永远不生效。 */
  trial(spec) {
    const errors = []
    let built
    try {
      built = this.executor.build(spec)
    } catch (error) {
      return [error.message]
    }
    const ctx = this.executor.context(null)
    built.root.arms.forEach((arm, i) => {
      const snapshot = this.executor.game.cached(arm.when.command.sources ?? [])
      if (snapshot === null) return // 还没轮询到这些来源：装上之后才有
      try {
        arm.when.test(snapshot, ctx)
      } catch (error) {
        errors.push(`arm "${spec.arms[i].then.name}": its "when" throws on the current state: ${error.message}`)
      }
    })
    return errors
  }

  commit(spec, meta, withCode) {
    const version = this.latestVersion + 1
    const full = strip({ version, ...meta, createdAt: new Date(this.now()).toISOString() })
    if (withCode) full.codeRefs = this.library.commitStaged()
    if (this.dir) {
      fs.mkdirSync(this.dir, { recursive: true })
      // 'wx'：版本文件只增不改。另一个进程抢先写了同号版本 → 不覆盖（游戏内验收：旧进程把人手放的 v2 盖掉了）
      try {
        fs.writeFileSync(path.join(this.dir, `v${version}.json`), JSON.stringify(spec, null, 2) + '\n', { flag: 'wx' })
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        this.refresh()
        return { ok: false, errors: [`v${version} was written by someone else meanwhile; redo on v${this.latestVersion}`], conflict: this.conflict(meta.base) }
      }
      fs.writeFileSync(path.join(this.dir, `v${version}.meta.json`), JSON.stringify(full, null, 2) + '\n')
    } else {
      this.memory.set(version, { spec, meta: full })
    }
    const previous = this.read(this.latestVersion)?.spec
    this.latestVersion = version
    this.executor.loadFastTree(spec, { version, meta: strip({ by: meta.by, batchId: meta.batchId ?? undefined }) })
    return { ok: true, version, arms: spec.arms.map((arm) => arm.then.name), diff: previous ? diffTrees(previous, spec) : [] }
  }

  // ── 读 ───────────────────────────────────────────────────────────────────

  /** 版本冲突时附上的东西：base 之后每一版的理由，以及两版的差异。 */
  conflict(base) {
    const changes = []
    for (let v = Math.max(base, 0) + 1; v <= this.latestVersion; v++) {
      const meta = this.read(v)?.meta
      if (meta) changes.push(strip({ version: v, by: meta.by, batchId: meta.batchId, reason: meta.reason }))
    }
    const from = this.read(base)?.spec
    const to = this.read(this.latestVersion)?.spec
    return { latest: this.latestVersion, changes, diff: from && to ? diffTrees(from, to) : [] }
  }

  diff(a, b) {
    const from = this.read(a)?.spec
    const to = this.read(b)?.spec
    if (!from || !to) return null
    return diffTrees(from, to)
  }
}

// ── 补丁 ───────────────────────────────────────────────────────────────────

/**
 * 在当前快树（执行格式）上应用 ops，返回待编译的整棵树（已有 arm 去掉 id，编译时重新按位置分配）。
 * @returns {{ tree, errors: string[] }}
 */
export function applyOps(spec, ops) {
  const errors = []
  const arms = spec.arms.map((arm) => ({ name: arm.then.name ?? null, arm: { when: withoutIds(arm.when), then: withoutIds(arm.then) } }))
  const find = (name, at) => {
    const index = arms.findIndex((a) => a.name === name)
    if (index === -1) errors.push(`${at}: no arm named "${name}" (arms now: ${arms.map((a) => a.name).join(', ') || 'none'})`)
    return index
  }
  const place = (op, at, self = null) => {
    if (op.before !== undefined && op.after !== undefined) {
      errors.push(`${at}: give "before" or "after", not both`)
      return -1
    }
    const anchor = op.before ?? op.after
    if (anchor === undefined) return arms.length
    if (anchor === self) {
      errors.push(`${at}: an arm cannot be placed relative to itself`)
      return -1
    }
    const index = find(anchor, at)
    if (index === -1) return -1
    return op.before !== undefined ? index : index + 1
  }

  ops.forEach((op, i) => {
    const at = `ops[${i}]`
    if (op === null || typeof op !== 'object' || !FAST_OPS.includes(op.op)) {
      errors.push(`${at}: op must be one of ${FAST_OPS.join(' / ')}`)
      return
    }
    switch (op.op) {
      case 'add': {
        const name = armName(op.arm, at, errors)
        if (name === null) return
        if (arms.some((a) => a.name === name)) return void errors.push(`${at}: an arm named "${name}" already exists (use replace to change it)`)
        const index = place(op, at)
        if (index !== -1) arms.splice(index, 0, { name, arm: op.arm })
        return
      }
      case 'replace': {
        const index = find(op.name, at)
        const name = armName(op.arm, at, errors)
        if (index === -1 || name === null) return
        if (arms.some((a, j) => j !== index && a.name === name)) return void errors.push(`${at}: another arm is already named "${name}"`)
        arms[index] = { name, arm: op.arm }
        return
      }
      case 'remove': {
        const index = find(op.name, at)
        if (index !== -1) arms.splice(index, 1)
        return
      }
      case 'move': {
        const index = find(op.name, at)
        if (index === -1) return
        if (op.before === undefined && op.after === undefined) return void errors.push(`${at}: move needs "before" or "after"`)
        const [moved] = arms.splice(index, 1)
        const target = place(op, at, op.name)
        if (target === -1) arms.splice(index, 0, moved)
        else arms.splice(target, 0, moved)
      }
    }
  })
  const tree = { type: 'Match', id: 'f', name: spec.name, arms: arms.map((a) => a.arm), otherwise: withoutIds(spec.otherwise) }
  return { tree, errors }
}

/** arm 的名字 = then 根节点编译后的名字。不合法 → 记错误、返回 null。 */
function armName(arm, at, errors) {
  if (arm === null || typeof arm !== 'object' || !arm.when || !arm.then) {
    errors.push(`${at}: arm must be { "when": <condition>, "then": <node> }`)
    return null
  }
  try {
    const name = compileTree(arm.then, { kind: 'fast', rootId: 'x' }).name
    if (!name) {
      errors.push(`${at}: the root of "then" needs a name (the seq / steps name, or "name") — arms are addressed by it`)
      return null
    }
    return name
  } catch (error) {
    errors.push(`${at}: ${error.message}`)
    return null
  }
}

/** code 参数：{ 名字: { signature, body, description? } } → 条目列表。名字必须以 fast. 开头。 */
export function normalizeCode(code, errors) {
  if (code === null || code === undefined) return []
  if (typeof code !== 'object' || Array.isArray(code)) {
    errors.push('code must be an object { "fast.<name>": { signature, body, description? } }')
    return []
  }
  const entries = []
  for (const [name, entry] of Object.entries(code)) {
    if (!name.startsWith('fast.')) {
      errors.push(`code "${name}": fast-tree condition code must be named fast.<name> (it is saved to the capsule library with the patch)`)
      continue
    }
    if (entry === null || typeof entry !== 'object') {
      errors.push(`code "${name}": must be { signature, body, description? }`)
      continue
    }
    entries.push({ name, description: entry.description, signature: entry.signature, body: entry.body })
  }
  return entries
}

function checkCode(entry, sandbox) {
  const at = `code "${entry.name}"`
  const errors = validateSignature(entry.signature).map((e) => `${at}: ${e}`)
  if (errors.length) return errors
  if (entry.signature.returns !== 'bool') return [`${at}: fast-tree code is used in "when", so it must declare returns: "bool"`]
  if (typeof entry.body !== 'string') return [`${at}: body must be TS / JS source text defining function main(params, state)`]
  try {
    sandbox.compile(entry.body)
  } catch (error) {
    return [`${at}: ${error instanceof SandboxError ? error.message : String(error)}`]
  }
  return []
}

// ── 差异 ───────────────────────────────────────────────────────────────────

/** 两版快树按 arm 名字比较：增、删、改、顺序。@returns {string[]} */
export function diffTrees(from, to) {
  const key = (arm) => arm.then.name ?? arm.then.id
  const body = (arm) => JSON.stringify({ when: withoutIds(arm.when), then: withoutIds(arm.then) })
  const before = new Map(from.arms.map((arm) => [key(arm), arm]))
  const after = new Map(to.arms.map((arm) => [key(arm), arm]))
  const lines = []
  for (const [name, arm] of after) {
    if (!before.has(name)) lines.push(`+ 新增 arm "${name}"`)
    else if (body(before.get(name)) !== body(arm)) lines.push(`~ 改了 arm "${name}"`)
  }
  for (const name of before.keys()) if (!after.has(name)) lines.push(`- 删除 arm "${name}"`)
  const order = (spec) => spec.arms.map(key).filter((name) => before.has(name) && after.has(name))
  if (order(from).join('\u0000') !== order(to).join('\u0000')) lines.push(`↕ 顺序：${to.arms.map(key).join(' → ')}`)
  return lines
}

function withoutIds(node) {
  if (Array.isArray(node)) return node.map(withoutIds)
  if (node === null || typeof node !== 'object') return node
  const out = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === 'id') continue
    // params / writes 里的值原样保留（不是节点）
    out[k] = k === 'params' || k === 'writes' || k === 'do' ? structuredClone(v) : withoutIds(v)
  }
  return out
}

function strip(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))
}
