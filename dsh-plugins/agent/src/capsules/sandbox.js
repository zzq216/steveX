import crypto from 'node:crypto'
import vm from 'node:vm'
import * as nodeModule from 'node:module'

/**
 * Compute 沙箱（算法层 §3.3 / §3.4）：纯函数 + 硬超时。
 *
 * 代码条目的 body 是 TS（或 JS）源码，定义一个同步函数：
 *   function main(params, state) { … }
 *   - Compute：params = 调用点参数（`$` 已解析），返回一个对象，键 = signature.outputs
 *   - 条件：   params 同上，state = 读到的状态快照（{ player?, inventory?, f3?, container? }），返回布尔值
 *
 * 沙箱里没有：require / import / process / 文件 / 网络 / 定时器 / Date / Math.random / eval / new Function / WebAssembly。
 * 每次调用一个全新的 context（模块级变量不会跨调用残留，保证同样的输入得到同样的输出）。
 * 进出都经过 JSON：参数和返回值必须可序列化，宿主对象不会漏进沙箱。
 *
 * 注意：node:vm 不是安全边界。它防的是"生成的代码无意中碰到宿主"和"死循环卡住 tick"，
 * 不防蓄意的逃逸。胶囊代码来自本项目的大模型、存在本地仓库里，这个威胁模型下够用。
 */
export class SandboxError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SandboxError'
  }
}

const PRELUDE = new vm.Script(`
'use strict';
Math.random = function () { throw new Error('Math.random is not available in the sandbox; pass a seed in params') };
globalThis.Date = undefined;
globalThis.WebAssembly = undefined;
`)

// __unread：节点没在 read 里声明的状态源。代码读它们时直接抛错——否则读到 undefined，
// 条件会静默按"没有"判断（task-20261027130758-2：read: [] 的界面判断恒判"已关"，关界面被跳过）。
const INVOKE = new vm.Script(`
(function () {
  if (typeof globalThis.__main !== 'function') throw new Error('the code must define function main(params, state)');
  let state = globalThis.__state === undefined ? undefined : JSON.parse(globalThis.__state);
  const unread = globalThis.__unread === undefined ? [] : JSON.parse(globalThis.__unread);
  if (state !== null && typeof state === 'object' && unread.length) {
    state = new Proxy(state, {
      get(target, key, receiver) {
        if (typeof key === 'string' && unread.includes(key) && !Object.prototype.hasOwnProperty.call(target, key)) {
          throw new Error('state.' + key + ' is not read by this node: add "' + key + '" to the node\\'s read (e.g. read: ["' + key + '"])');
        }
        return Reflect.get(target, key, receiver);
      }
    });
  }
  const out = globalThis.__main(JSON.parse(globalThis.__params), state);
  if (out !== null && typeof out === 'object' && typeof out.then === 'function') throw new Error('main must be synchronous (no async / Promise)');
  return out === undefined ? 'null' : JSON.stringify(out);
})()
`)

const stripTypes = typeof nodeModule.stripTypeScriptTypes === 'function'
  ? (source) => withoutWarning(() => nodeModule.stripTypeScriptTypes(source, { mode: 'strip' }))
  : (source) => source

export class Sandbox {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs=1000]          Compute 单次调用的硬超时
   * @param {number} [options.conditionTimeoutMs=50]   条件代码单次调用的硬超时（快树每 tick 都要算）
   * @param {number} [options.maxOutputBytes=65536]
   */
  constructor({ timeoutMs = 1000, conditionTimeoutMs = 50, maxOutputBytes = 65536 } = {}) {
    this.timeoutMs = timeoutMs
    this.conditionTimeoutMs = conditionTimeoutMs
    this.maxOutputBytes = maxOutputBytes
    this.scripts = new Map() // 源码哈希 → vm.Script
  }

  /** 编译（去类型 + 语法检查），结果按源码缓存。保存条目时也用它做静态检查。 */
  compile(source) {
    if (typeof source !== 'string' || source.trim() === '') throw new SandboxError('code body must be a non-empty string')
    const key = crypto.createHash('sha256').update(source).digest('hex')
    const cached = this.scripts.get(key)
    if (cached) return cached
    let js
    try {
      js = stripTypes(source)
    } catch (error) {
      throw new SandboxError(`syntax error (TypeScript): ${error.message}`)
    }
    let script
    try {
      script = new vm.Script(`${js}\n;globalThis.__main = typeof main === 'function' ? main : undefined;`, { filename: 'capsule.ts' })
    } catch (error) {
      throw new SandboxError(`syntax error: ${error.message}${/import|export/.test(source) ? '（沙箱代码不能用 import / export，直接写 function main）' : ''}`)
    }
    this.scripts.set(key, script)
    return script
  }

  /**
   * 运行一次。超时 / 抛错 / 返回值不可序列化都抛 SandboxError。
   * @param {object} [options]
   * @param {string[]} [options.unread]  节点没声明 read 的状态源：代码读 state.<源> 时抛错（不静默给 undefined）
   * @returns {any} main 的返回值（经 JSON 往返）
   */
  run(source, params, { state, timeoutMs, unread } = {}) {
    const script = this.compile(source)
    const budget = timeoutMs ?? this.timeoutMs
    const context = vm.createContext({}, {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate'
    })
    context.__params = JSON.stringify(params ?? {})
    context.__state = state === undefined ? undefined : JSON.stringify(state)
    context.__unread = unread?.length ? JSON.stringify(unread) : undefined
    const deadline = Date.now() + budget
    let text
    try {
      PRELUDE.runInContext(context)
      script.runInContext(context, { timeout: budget })
      text = INVOKE.runInContext(context, { timeout: Math.max(1, deadline - Date.now()) })
    } catch (error) {
      if (/timed out/.test(String(error?.message))) throw new SandboxError(`exceeded the ${budget} ms budget`)
      throw new SandboxError(error?.message ?? String(error))
    }
    if (typeof text !== 'string') throw new SandboxError('return value is not JSON-serializable')
    if (Buffer.byteLength(text, 'utf8') > this.maxOutputBytes) {
      throw new SandboxError(`return value is over ${this.maxOutputBytes} bytes; return a short summary instead`)
    }
    return JSON.parse(text)
  }
}

/** stripTypeScriptTypes 在部分 Node 版本里会打一次 ExperimentalWarning；这里只吞掉那一条。 */
function withoutWarning(fn) {
  const original = process.emitWarning
  process.emitWarning = (warning, ...rest) => {
    const text = typeof warning === 'string' ? warning : warning?.message
    if (/stripTypeScriptTypes|Type Stripping/i.test(String(text))) return
    return original.call(process, warning, ...rest)
  }
  try {
    return fn()
  } finally {
    process.emitWarning = original
  }
}
