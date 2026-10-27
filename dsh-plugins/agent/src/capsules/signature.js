/**
 * 胶囊契约（算法层 §4.3）：`signature` 同时约束调用点与实现两侧。
 *
 *   {
 *     inputs:  { 名字: { type, required?, item?, hint? } },   // 调用点的 params
 *     outputs: { 名字: { type, item?, hint? } },              // Compute 的返回对象 / SubTree 回传的键
 *     returns: 'bool'                                          // 只有"条件代码"才有：main 返回布尔值
 *   }
 *
 * 一个代码条目要么是 Compute（有 outputs、没有 returns），要么是条件（returns: 'bool'、没有 outputs）。
 */
export const VALUE_TYPES = Object.freeze(['any', 'string', 'number', 'int', 'bool', 'list', 'object', 'vec3'])

const NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/

const CHECKS = {
  any: () => true,
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  int: (v) => Number.isInteger(v),
  bool: (v) => typeof v === 'boolean',
  list: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  vec3: (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
}

/** @returns {string | null} 不符合时的说明 */
export function checkValue(value, spec) {
  const type = spec?.type ?? 'any'
  if (!CHECKS[type](value)) return `must be ${type}`
  if (type === 'list' && spec.item) {
    for (let i = 0; i < value.length; i++) {
      const problem = checkValue(value[i], { type: spec.item })
      if (problem) return `[${i}] ${problem}`
    }
  }
  return null
}

/** 校验 signature 本身的形态。@returns {string[]} */
export function validateSignature(signature) {
  const errors = []
  if (signature === null || typeof signature !== 'object' || Array.isArray(signature)) return ['signature must be an object']
  for (const key of Object.keys(signature)) {
    if (!['inputs', 'outputs', 'returns'].includes(key)) errors.push(`signature: unknown key "${key}"`)
  }
  for (const part of ['inputs', 'outputs']) {
    const group = signature[part] ?? {}
    if (group === null || typeof group !== 'object' || Array.isArray(group)) {
      errors.push(`signature.${part} must be an object`)
      continue
    }
    for (const [name, spec] of Object.entries(group)) {
      if (!NAME.test(name)) errors.push(`signature.${part}: bad name "${name}"`)
      if (!VALUE_TYPES.includes(spec?.type)) errors.push(`signature.${part}.${name}: type must be one of ${VALUE_TYPES.join(', ')}`)
      if (spec?.item !== undefined && (spec.type !== 'list' || !VALUE_TYPES.includes(spec.item))) {
        errors.push(`signature.${part}.${name}: item is only for list, and must be a value type`)
      }
    }
  }
  if (signature.returns !== undefined && signature.returns !== 'bool') errors.push('signature.returns can only be "bool"')
  if (signature.returns === 'bool' && Object.keys(signature.outputs ?? {}).length > 0) {
    errors.push('a condition (returns: "bool") cannot also declare outputs')
  }
  return errors
}

/**
 * 调用点 params 对 signature.inputs（字面量查类型；`$` 引用运行时才知道值，只查名字）。
 * @returns {string[]}
 */
export function checkCallParams(signature, params, { literalOnly = false } = {}) {
  const errors = []
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return ['params must be an object']
  const inputs = signature.inputs ?? {}
  for (const [name, spec] of Object.entries(inputs)) {
    if (params[name] === undefined) {
      if (spec.required) errors.push(`missing required param "${name}"`)
      continue
    }
    if (isRef(params[name])) {
      if (literalOnly) errors.push(`param "${name}" must be a literal (this entry does not accept "$" references)`)
      continue
    }
    const problem = checkValue(params[name], spec)
    if (problem) errors.push(`param "${name}" ${problem}`)
  }
  for (const name of Object.keys(params)) {
    if (!(name in inputs)) errors.push(`unknown param "${name}"`)
  }
  return errors
}

/** 运行时：实际传入的值对 signature.inputs（`$` 已解析）。 */
export function checkResolvedInputs(signature, params) {
  const errors = []
  for (const [name, spec] of Object.entries(signature.inputs ?? {})) {
    if (params[name] === undefined) {
      if (spec.required) errors.push(`missing required param "${name}"`)
      continue
    }
    const problem = checkValue(params[name], spec)
    if (problem) errors.push(`param "${name}" ${problem}`)
  }
  return errors
}

/** Compute 的返回值对 signature.outputs。缺的输出不报错（不写），多出来的报错。 */
export function checkOutputs(signature, output) {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return ['main must return an object']
  const outputs = signature.outputs ?? {}
  const errors = []
  for (const [name, value] of Object.entries(output)) {
    if (!(name in outputs)) {
      errors.push(`returned undeclared output "${name}"`)
      continue
    }
    const problem = checkValue(value, outputs[name])
    if (problem) errors.push(`output "${name}" ${problem}`)
  }
  return errors
}

export function isRef(value) {
  return typeof value === 'string' && value.startsWith('$') && value.length > 1
}
