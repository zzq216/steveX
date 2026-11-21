import { compileTree } from '../bt/compiler.js'
import { validateTree } from '../bt/validator.js'
import { pinRefs, walkSpec } from '../bt/build.js'
import { validateSignature } from './signature.js'
import { parseRef } from './library.js'
import { SandboxError } from './sandbox.js'

/**
 * 胶囊命名规则（2026-11-21）：capsule_search 只给名字，规划靠名字挑候选，名字要写成"领域.做什么"——
 * 至少两段（点分隔），第一段是领域（字母数字），不能用 tmp / test 这类临时名当领域。只查新名字：已有的名字替换时不查（bridge.saveCapsule）。
 * @returns {string|null} 不合规的理由
 */
export const CAPSULE_NAME_RULE = /^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9_-]*)+$/
export const TEMP_DOMAINS = Object.freeze(['tmp', 'temp', 'test', 'tests', 'debug', 'draft', 'misc', 'new', 'foo', 'x'])
export function capsuleNameProblem(name) {
  if (typeof name !== 'string' || !CAPSULE_NAME_RULE.test(name)) {
    return `name "${name}" must read "<domain>.<what-it-does>" (lowercase, dot-separated, e.g. "craft.plan-batch-fill", "anvil.slot0-has-item"): capsule_search returns names only, so the planner picks candidates by name`
  }
  const domain = name.slice(0, name.indexOf('.'))
  if (TEMP_DOMAINS.includes(domain)) return `name "${name}" uses "${domain}" as its domain; name the area it works in (craft / container / inv / anvil / beacon …) so it can be found by name`
  return null
}

/**
 * 保存一个胶囊条目（P1 的 capsule_save 工具、scripts/capsule-save.js 都走这里）。
 *
 * 落盘前的语义校验：
 * - signature 形态（signature.js）
 * - code/：body 能去类型、能编译、定义了 main（沙箱 compile）
 * - trees/：body 编译成执行格式（根 id 'c'），按 signature.inputs 作为初始黑板键过校验器；
 *   胶囊里引用的其他胶囊钉到 hash。胶囊里不能读"调用方的任务帧"——调用点必须给全（行为树设计 §8.2）
 *
 * 复盘时的 capsule_save（P4 §4）多两个钩子；scripts/capsule-save.js 不传，就不查：
 * - rewriteDraft(ref)：子树里的 task/ 引用 → 本次复盘已转正的 code/…@hash（P4-D7）；返回 null = 没转正，照旧拒绝
 * - check(folder, body)：写库前的附加检查（P4 §5 写死的值、§4.4 子树丢了 read），body 是编译后的执行格式 / 源码；返回错误列表
 *
 * @param {{ library, sandbox, registry }} services
 * @param {'code'|'trees'} folder
 * @param {{ name, description?, locked?, signature, preconditions?, body }} entry
 * @param {{ rewriteDraft?: (ref: string) => string|null, check?: (folder, body) => string[] }} [hooks]
 * @returns {{ ok: true, ref, hash, created, rewritten? } | { ok: false, errors: string[] }}
 */
export function saveCapsule({ library, sandbox, registry }, folder, entry, { rewriteDraft = null, check: extraCheck = null } = {}) {
  const errors = validateSignature(entry?.signature)
  if (errors.length) return { ok: false, errors }
  let body = entry.body
  const rewritten = []

  if (folder === 'code') {
    if (typeof body !== 'string') return { ok: false, errors: ['code body must be TS / JS source text defining function main(params, state)'] }
    try {
      sandbox.compile(body)
    } catch (error) {
      return { ok: false, errors: [error instanceof SandboxError ? error.message : String(error)] }
    }
  } else if (folder === 'trees') {
    if (entry.signature.returns) return { ok: false, errors: ['a tree capsule cannot declare returns'] }
    try {
      body = compileTree(body, { kind: 'task', rootId: 'c' })
    } catch (error) {
      return { ok: false, errors: [error.message] }
    }
    if (rewriteDraft) {
      walkSpec(body, (node) => {
        if (typeof node.ref !== 'string' || !node.ref.startsWith('task/')) return
        const to = rewriteDraft(node.ref)
        if (!to) return
        rewritten.push({ id: node.id, from: node.ref, to })
        node.ref = to
      })
    }
    // 先查草稿引用再钉：草稿区在任务结束时已关掉，钉 task/ 只会报"找不到草稿"，说不清该怎么办
    const drafts = []
    walkSpec(body, (node) => { if (typeof node.ref === 'string' && node.ref.startsWith('task/')) drafts.push(`[${node.id}] ${node.ref}`) })
    if (drafts.length) {
      return { ok: false, errors: drafts.map((d) => `${d}: a library capsule cannot reference a task draft; save the draft as code/ first${rewriteDraft ? ' (capsule_save folder "code", from: that task/ ref), then this tree again' : ''}`) }
    }
    const pinned = pinRefs(body, library)
    if (pinned.errors.length) return { ok: false, errors: pinned.errors }
    body = pinned.spec
    const check = validateTree(body, {
      registry, library, kind: 'task', initialKeys: Object.keys(entry.signature.inputs ?? {})
    })
    if (!check.ok) return { ok: false, errors: check.errors }
  } else {
    return { ok: false, errors: ['folder must be code or trees'] }
  }
  if (extraCheck) {
    const extraErrors = extraCheck(folder, body)
    if (extraErrors.length) return { ok: false, errors: extraErrors }
  }

  try {
    return { ok: true, ...library.write(folder, { ...entry, body }), ...(rewritten.length ? { rewritten } : {}) }
  } catch (error) {
    return { ok: false, errors: [error.message] }
  }
}

/**
 * 换引用（docs/胶囊换引用设计方案.md）：把库里子树 tree 最新版中，names 列出的名字的引用换成它们现在的最新版，存成这棵子树的新版本。
 * signature、preconditions、description 和其余引用原样保留；照常过树校验（R4：换上去的版本输入输出变了就校验不过），
 * 不做写死值检查（其余内容当初保存时已查过）。
 * @param {{ library, registry }} services
 * @param {string} tree   "trees/<name>"（可以带最新版的 @hash）
 * @param {string[]} names  要换的名字（"code/<name>" / "trees/<name>"，不带 @hash）
 * @returns {{ ok: true, ref, hash, created, parent, changes: Array<{ ref, from: string[], to }> } | { ok: false, errors: string[] }}
 */
export function repinTree({ library, registry }, tree, names) {
  let target
  try {
    target = parseRef(tree)
  } catch (error) {
    return { ok: false, errors: [error.message] }
  }
  if (target.folder !== 'trees') return { ok: false, errors: [`tree must be a tree capsule (trees/<name>), got ${tree}`] }
  const key = `trees/${target.name}`
  const info = library.readManifest()[key]
  if (!info) return { ok: false, errors: [`no capsule named ${key}`] }
  if (target.hash && target.hash !== info.hash) return { ok: false, errors: [`${tree} is not the latest version of ${key} (latest: @${info.hash}); only the latest version can be repinned`] }
  if (info.locked) return { ok: false, errors: [`${key} is locked (a hand-made base entry) and cannot be replaced`] }
  if (!Array.isArray(names) || names.length === 0) return { ok: false, errors: ['refs is required: the names to move to their latest version, e.g. ["code/x"]'] }
  const entry = library.get(`${key}@${info.hash}`)
  const body = structuredClone(entry.body)
  const errors = []
  const changes = []
  for (const name of [...new Set(names)]) {
    let ref
    try {
      ref = parseRef(name)
    } catch (error) {
      errors.push(error.message)
      continue
    }
    if (ref.hash) { errors.push(`${name}: write the name without @hash; it is moved to its latest version`); continue }
    if (ref.folder === 'task') { errors.push(`${name}: task drafts are not library entries`); continue }
    const nameKey = `${ref.folder}/${ref.name}`
    if (nameKey === key) { errors.push(`${name}: a tree cannot repin itself`); continue }
    let latest
    try {
      latest = library.pin(nameKey)
    } catch (error) {
      errors.push(`${name}: ${error.message}`)
      continue
    }
    const from = new Set()
    let found = false
    walkSpec(body, (node) => {
      if (typeof node.ref !== 'string' || !node.ref.startsWith(`${nameKey}@`)) return
      found = true
      if (node.ref === latest) return
      from.add(node.ref.slice(node.ref.lastIndexOf('@') + 1))
      node.ref = latest
    })
    if (!found) errors.push(`${name}: ${key}@${info.hash} does not reference ${nameKey}`)
    else if (!from.size) errors.push(`${name}: ${key}@${info.hash} already uses its latest version ${latest}`)
    else changes.push({ ref: nameKey, from: [...from].sort(), to: latest.slice(latest.lastIndexOf('@') + 1) })
  }
  if (errors.length) return { ok: false, errors }
  const check = validateTree(body, { registry, library, kind: 'task', initialKeys: Object.keys(entry.signature.inputs ?? {}) })
  if (!check.ok) {
    return { ok: false, errors: [`after moving to the latest versions the tree no longer validates (the new versions' inputs / outputs probably changed); nothing was saved — save the tree by hand with capsule_save if you still want it:`, ...check.errors] }
  }
  try {
    const written = library.write('trees', {
      name: target.name, description: entry.description, signature: entry.signature,
      ...(entry.preconditions?.length ? { preconditions: entry.preconditions } : {}), body
    })
    return { ok: true, ...written, parent: info.hash, changes }
  } catch (error) {
    return { ok: false, errors: [error.message] }
  }
}

/**
 * 写一条任务内代码草稿（集成方案 §5.1.0）：校验照 code/ 条目，只是不进库。
 * @param {{ library, sandbox }} services
 * @param {string} name
 * @param {{ description?, signature, body }} entry
 * @returns {{ ok: true, ref, hash } | { ok: false, errors: string[] }}
 */
export function saveDraft({ library, sandbox }, name, entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, errors: ['a draft must be { signature, body, description? }'] }
  const errors = validateSignature(entry.signature)
  if (errors.length) return { ok: false, errors }
  if (typeof entry.body !== 'string') return { ok: false, errors: ['draft body must be TS / JS source text defining function main(params, state)'] }
  try {
    sandbox.compile(entry.body)
  } catch (error) {
    return { ok: false, errors: [error instanceof SandboxError ? error.message : String(error)] }
  }
  try {
    return { ok: true, ...library.writeDraft({ name, description: entry.description, signature: entry.signature, body: entry.body }) }
  } catch (error) {
    return { ok: false, errors: [error.message] }
  }
}
