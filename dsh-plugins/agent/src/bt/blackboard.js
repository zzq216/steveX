/**
 * 黑板（行为树设计 §5）：任务帧 + 胶囊实例帧两级作用域（§5.1.1）。
 *
 * - 只存任务执行状态，不存世界状态（§5.2）
 * - 所有写入走同一个入口（写入关卡）：值必须可整体序列化、且不超过大小上限，
 *   超限 = 写入被拒、节点 FAILURE（§5.3）
 * - 实例帧（SubTree 调用时创建）：读先查自己、再查任务帧；写只写自己。
 *   跨边界只能经胶囊的 outputs 拷回调用方（由 SubTree 节点负责）
 */
export class BlackboardError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BlackboardError'
  }
}

export class Blackboard {
  /**
   * @param {object} [options]
   * @param {number} [options.maxValueBytes=16384]  单个值序列化后的字节上限
   * @param {object} [options.initial]              初始键值
   * @param {Blackboard|null} [options.parent]      实例帧的回落帧（任务帧）
   */
  constructor({ maxValueBytes = 16384, initial = {}, parent = null } = {}) {
    this.maxValueBytes = maxValueBytes
    this.parent = parent
    this.values = new Map()
    for (const [key, value] of Object.entries(initial)) this.set(key, value)
  }

  /** 实例帧：继承上限，读回落到 parent。 */
  child(initial = {}) {
    return new Blackboard({ maxValueBytes: this.maxValueBytes, initial, parent: this.taskFrame() })
  }

  taskFrame() {
    let frame = this
    while (frame.parent) frame = frame.parent
    return frame
  }

  hasOwn(key) {
    return this.values.has(key)
  }

  has(key) {
    return this.values.has(key) || Boolean(this.parent?.has(key))
  }

  get(key) {
    if (this.values.has(key)) return structuredClone(this.values.get(key))
    return this.parent ? this.parent.get(key) : undefined
  }

  /** 写入关卡。 */
  set(key, value) {
    if (typeof key !== 'string' || key === '') throw new BlackboardError('blackboard key must be a non-empty string')
    let text
    try {
      text = JSON.stringify(value)
    } catch (error) {
      throw new BlackboardError(`blackboard value for "${key}" is not serializable: ${error.message}`)
    }
    if (text === undefined) throw new BlackboardError(`blackboard value for "${key}" is not serializable`)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.maxValueBytes) {
      throw new BlackboardError(`blackboard value for "${key}" is ${bytes} bytes, over the ${this.maxValueBytes}-byte limit`)
    }
    this.values.set(key, JSON.parse(text))
  }

  /** 本帧的键值（不含 parent）。 */
  snapshot() {
    return Object.fromEntries([...this.values].map(([key, value]) => [key, structuredClone(value)]))
  }
}

/**
 * `"$key"` 读引用 → 值。支持取字段：`$cell.slot` 先找键 `cell.slot`，没有再找键 `cell` 取它的 `slot` 字段
 * （键名本身可以带点，如 `mine.count`，所以按"最长的已存在前缀"解析）。
 */
export function resolveRef(text, blackboard) {
  const key = text.slice(1)
  if (blackboard.has(key)) return blackboard.get(key)
  const parts = key.split('.')
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join('.')
    if (!blackboard.has(prefix)) continue
    const value = pickPath(blackboard.get(prefix), parts.slice(i).join('.'))
    if (value === undefined) throw new BlackboardError(`blackboard key "${prefix}" has no field "${parts.slice(i).join('.')}"`)
    return value
  }
  throw new BlackboardError(`blackboard has no key "${key}"`)
}

/** `"$key"` 读引用 → 黑板值；其余字面量原样返回。递归处理数组与对象。 */
export function resolveParams(params, blackboard) {
  if (typeof params === 'string' && params.startsWith('$') && params.length > 1) return resolveRef(params, blackboard)
  if (Array.isArray(params)) return params.map((item) => resolveParams(item, blackboard))
  if (params !== null && typeof params === 'object') {
    return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, resolveParams(v, blackboard)]))
  }
  return params
}

/** 收集参数里出现的全部 `$key` 读引用（校验器用）。 */
export function collectRefs(params, out = new Set()) {
  if (typeof params === 'string' && params.startsWith('$') && params.length > 1) out.add(params.slice(1))
  else if (Array.isArray(params)) for (const item of params) collectRefs(item, out)
  else if (params !== null && typeof params === 'object') for (const v of Object.values(params)) collectRefs(v, out)
  return out
}

/** 读引用是否有来源：键本身或它的某个前缀被写过（与 resolveRef 同一套规则）。 */
export function refKnown(key, writtenKeys) {
  if (writtenKeys.has(key)) return true
  const parts = key.split('.')
  for (let i = parts.length - 1; i >= 1; i--) {
    if (writtenKeys.has(parts.slice(0, i).join('.'))) return true
  }
  return false
}

/**
 * 按 `writes` 映射把结果写进黑板（§8.1）。
 * 值来源："+1" / "+N" 递增；其余视为结果对象里的字段路径（"a.b.0"），"." 表示整个结果。
 */
export function applyWrites(writes, result, blackboard) {
  if (!writes) return
  for (const [key, source] of Object.entries(writes)) {
    if (typeof source === 'string' && /^\+\d+$/.test(source)) {
      const current = blackboard.has(key) ? blackboard.get(key) : 0
      if (typeof current !== 'number') throw new BlackboardError(`cannot increment non-number key "${key}"`)
      blackboard.set(key, current + Number(source.slice(1)))
    } else {
      blackboard.set(key, pickPath(result, source))
    }
  }
}

export function pickPath(value, pathText) {
  if (pathText === '.' || pathText === '') return value
  let current = value
  for (const part of String(pathText).split('.')) {
    if (current === null || current === undefined) return undefined
    current = current[part]
  }
  return current
}
