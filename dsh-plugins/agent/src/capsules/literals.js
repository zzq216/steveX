import { walkSpec } from '../bt/build.js'

/**
 * 保存胶囊时查写死的值（P4 实施细则 §5，集成方案 §5.4 第 5 条）。
 *
 * 要保存的条目里的字面量，和这次任务里**观察到**的值比对：
 *   - 快照（给了 from 就只取那个节点及其子节点执行时的）：格子号、物品 id、坐标、朝向
 *   - 任务结束时的黑板，但只取观察来的键：初始黑板、查询（core.*）与动作写下的。大模型自己的 Compute 代码算出来的键、
 *     ForEach 的循环变量**不比**——代码里的常量和它自己的输出相同不是抄（P4 游戏内验收：合成格号 9、"1 原木 → 4 木板"的 4、
 *     match 词表 planks，全因和自己算出的黑板值相同被拒，零个真命中）
 * 一样就算命中——多半是把证据里看到的值抄成了常量。命中即拒绝，可以在 keepLiterals 里带理由保留。
 *
 * 代码条目只比字符串（物品 id 之类）：代码里的数字多是布局 / 配方常量，快照里又恰好到处是 0–45 的格子号，比了只会误报。
 * 树条目字符串和数字都比——`{ slot: 36 }` 写进树参数正是这道检查要挡的。
 * 不比：布尔、-1..2 的整数、长度 ≤ 2 的字符串、非整数（坐标比的是取整后的值）、wait 的 tick 数、命令注册表里的枚举参数。
 * 这些重合大多是巧合。换个写法（35 + 1、拼字符串）就躲得过去——P4 不防，靠 P6 的多图准入（§5.3）。
 */

const SNAPSHOT_NUMBER_KEYS = /^(slot|selectedSlot|hotbarSlot|x|y|z|yaw|pitch)$/i
const SNAPSHOT_STRING_KEYS = /^(id|item|itemId|block)$/i

/**
 * @param {object} task  执行器的任务对象（复盘请求持有的那个）
 * @param {object} [options]
 * @param {string|null} [options.from]  出处节点 id：只取它及其子节点执行时的快照（没有就退回全部）
 * @returns {Map<string, string>} 值的键（n:36 / s:minecraft:oak_log）→ 第一次在哪里见到
 */
export function collectEvidence(task, { from = null } = {}) {
  const seen = new Map()
  const add = (value, where) => {
    const key = valueKey(value)
    if (key && !seen.has(key)) seen.set(key, where)
  }
  const derived = derivedKeys(task)
  for (const [key, value] of Object.entries(task.blackboard.snapshot())) {
    if (derived.has(key)) continue
    walkLeaves(value, (leaf, path) => add(leaf, `黑板 ${key}${path ? (path.startsWith('[') ? '' : '.') + path : ''}`))
  }

  const names = task.snapshots.names()
  const own = from ? names.filter((name) => new RegExp(`^(before|after)@${escape(from)}(\\.|#|$)`).test(name)) : []
  for (const name of own.length ? own : names) {
    const entry = task.snapshots.get(name)
    walkLeaves(entry?.state ?? {}, (value, path, key, parent) => {
      const vec3 = Array.isArray(parent) && parent.length === 3 && parent.every((n) => typeof n === 'number')
      if (typeof value === 'number' && (SNAPSHOT_NUMBER_KEYS.test(key) || vec3)) add(value, `快照 ${name} 的 ${path}`)
      if (typeof value === 'string' && SNAPSHOT_STRING_KEYS.test(key)) add(value, `快照 ${name} 的 ${path}`)
    })
  }
  return seen
}

/**
 * 条目里要比对的字面量。
 * @param {'code'|'trees'} folder
 * @param {object|string} body  trees：编译后的执行格式（根 id 'c'）；code：源码
 * @param {object} [options]  { registry }：查命令参数是不是枚举
 * @returns {Array<{ path: string, value: number|string }>}
 */
export function findLiterals(folder, body, { registry = null } = {}) {
  return folder === 'code' ? codeLiterals(String(body)) : treeLiterals(body, registry)
}

/**
 * @returns {{ hits: Array<{ path, value, where }>, errors: string[] }}
 *   hits 是全部命中（含已在 keep 里声明保留的）；errors 是没声明保留的命中、以及 keep 里写错的项
 */
export function checkLiterals({ folder, body, evidence, keep = {}, registry = null }) {
  const errors = []
  if (keep === null || typeof keep !== 'object' || Array.isArray(keep)) return { hits: [], errors: ['keepLiterals must be an object { <path>: <reason> }'] }
  const hits = []
  for (const { path, value } of findLiterals(folder, body, { registry })) {
    const where = evidence.get(valueKey(value))
    if (where) hits.push({ path, value, where })
  }
  const hitPaths = new Set(hits.map((h) => h.path))
  for (const [path, reason] of Object.entries(keep)) {
    if (!hitPaths.has(path)) errors.push(`keepLiterals["${path}"]: no such hit (hits: ${[...hitPaths].join(', ') || 'none'})`)
    else if (typeof reason !== 'string' || !reason.trim()) errors.push(`keepLiterals["${path}"]: give a reason why this value is a constant`)
  }
  for (const hit of hits) {
    if (!(hit.path in keep)) errors.push(`${hit.path} = ${JSON.stringify(hit.value)}: same as ${hit.where}`)
  }
  if (errors.length && hits.some((h) => !(h.path in keep))) {
    const template = Object.fromEntries([...Object.entries(keep), ...hits.filter((h) => !(h.path in keep)).map((h) => [h.path, '<why this is a constant>'])])
    errors.push('these look like values copied from this task: make them inputs (signature.inputs + "$name") or read them in the tree; if one really is a constant, list it in keepLiterals with a reason')
    errors.push(`keepLiterals with every hit (keys exactly as above; drop the ones you turn into inputs): ${JSON.stringify(template)}`)
  }
  return { hits, errors }
}

// ── 内部 ───────────────────────────────────────────────────────────────────

/** 黑板里大模型自己的代码算出来的键：非 core.* 的 Compute 的 writes、ForEach 的 as / indexAs（所有树版本里出现过的）。 */
function derivedKeys(task) {
  const keys = new Set()
  for (const spec of [...(task.versions ?? []).map((v) => v.spec), task.spec].filter(Boolean)) {
    walkSpec(spec, (node) => {
      if (node.type === 'Compute' && typeof node.ref === 'string' && !node.ref.startsWith('code/core.')) {
        for (const key of Object.keys(node.writes ?? {})) keys.add(key)
      }
      if (node.type === 'ForEach') {
        if (node.as) keys.add(node.as)
        if (node.indexAs) keys.add(node.indexAs)
      }
    })
  }
  return keys
}

/** 值的比对键；不比的值返回 null。 */
function valueKey(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const n = Math.floor(value)
    return n >= -1 && n <= 2 ? null : `n:${n}`
  }
  if (typeof value === 'string') return value.length <= 2 ? null : `s:${value}`
  return null
}

function treeLiterals(spec, registry) {
  const out = []
  const visitNode = (node) => {
    if (node.params && typeof node.params === 'object') {
      const cmd = node.type === 'Action' ? node.cmd : null
      scanParams(node.params, `${node.id}.params`, cmd, registry, out)
    }
    if (node.type === 'Steps' && Array.isArray(node.do)) {
      node.do.forEach((step, i) => {
        if (!Array.isArray(step)) return
        const [cmd, params] = step
        if (cmd === 'wait') return
        if (params !== null && typeof params === 'object') scanParams(params, `${node.id}.do[${i}].params`, cmd, registry, out)
      })
    }
  }
  walkSpec(spec, visitNode)
  return out
}

function scanParams(params, base, cmd, registry, out) {
  for (const [key, value] of Object.entries(params)) {
    if (cmd && registry?.commands?.get(cmd)?.params?.[key]?.enum) continue
    walkLeaves(value, (leaf, sub) => {
      if (typeof leaf === 'string' && leaf.startsWith('$')) return
      if (typeof leaf === 'number' && !Number.isInteger(leaf)) return
      if (valueKey(leaf)) out.push({ path: sub ? `${base}.${key}${sub.startsWith('[') ? '' : '.'}${sub}` : `${base}.${key}`, value: leaf })
    })
  }
}

/** 源码里的字符串字面量（先去掉注释；数字不比，见文件头）。路径 = body:L<行>:<字面量>。 */
function codeLiterals(source) {
  const out = []
  const lines = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n')
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '')
    const strings = [...line.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2])
    for (const text of strings) if (valueKey(text) && !text.includes('${')) out.push({ path: `body:L${i + 1}:${JSON.stringify(text)}`, value: text })
  })
  return out
}

/** 叶子回调：(值, 相对路径, 键, 父容器)。 */
function walkLeaves(value, visit, path = '', key = '', parent = null) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkLeaves(item, visit, `${path}[${i}]`, String(i), value))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walkLeaves(v, visit, path ? `${path}.${k}` : k, k, value)
    return
  }
  visit(value, path, key, parent)
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
