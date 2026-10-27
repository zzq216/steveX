import { compileTree } from '../bt/compiler.js'
import { validateTree } from '../bt/validator.js'
import { pinRefs, walkSpec } from '../bt/build.js'
import { validateSignature } from './signature.js'
import { SandboxError } from './sandbox.js'

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
