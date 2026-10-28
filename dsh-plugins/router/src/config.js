import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { RouterError } from './domain/router.js'
import { HANDLER_IDS } from './handlers.js'
import { DEFAULT_PROMPTS_DIR } from './prompts.js'

/** 路由日志默认写到 steveX/runtime/router/（runtime/ 不进 git）。 */
export const DEFAULT_LOG_DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'), 'runtime', 'router')

const PROVIDER_MODES = new Set(['stub', 'llm'])
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 插件 Config 校验（设计文档 §17.5：部署可变项走 validated Config）。
 * 不引入 Schemastery，保持包零 DSH 依赖；非法配置在插件加载时直接抛错。
 */
export function normalizeConfig(raw = {}) {
  if (!isPlainObject(raw)) throw new RouterError('BAD_CONFIG', 'router config must be an object')

  const providerRaw = raw.provider ?? {}
  if (!isPlainObject(providerRaw)) throw new RouterError('BAD_CONFIG', 'config.provider must be an object')

  // 阶段 B（细则 D9）：默认用大模型填槽；测试与离线开发显式写 stub
  const mode = providerRaw.mode ?? 'llm'
  if (!PROVIDER_MODES.has(mode)) {
    throw new RouterError('BAD_CONFIG', `config.provider.mode must be stub or llm (got ${JSON.stringify(mode)})`)
  }
  if (providerRaw.stubSlots !== undefined && providerRaw.stubSlots !== null && !isPlainObject(providerRaw.stubSlots)) {
    throw new RouterError('BAD_CONFIG', 'config.provider.stubSlots must be an object (or null)')
  }
  if (providerRaw.fillSlots !== undefined && providerRaw.fillSlots !== null && typeof providerRaw.fillSlots !== 'function') {
    throw new RouterError('BAD_CONFIG', 'config.provider.fillSlots must be a function (programmatic use only)')
  }
  const promptsDir = providerRaw.promptsDir ?? raw.promptsDir ?? DEFAULT_PROMPTS_DIR
  if (typeof promptsDir !== 'string' || promptsDir === '') {
    throw new RouterError('BAD_CONFIG', 'config.provider.promptsDir must be a non-empty string (or null = bundled prompts)')
  }

  // 大模型调用（细则 §5）：route null = 跟会话同一个 provider/model；reasoningEffort null = 模型支持的最低档
  const route = providerRaw.route ?? null
  if (route !== null && (!isPlainObject(route) || !nonEmpty(route.provider) || !nonEmpty(route.model))) {
    throw new RouterError('BAD_CONFIG', 'config.provider.route must be { provider, model } (or null = the session model)')
  }
  const reasoningEffort = providerRaw.reasoningEffort ?? null
  if (reasoningEffort !== null && !nonEmpty(reasoningEffort)) {
    throw new RouterError('BAD_CONFIG', 'config.provider.reasoningEffort must be a non-empty string (or null = lowest)')
  }
  const maxTokens = positiveInt(providerRaw.maxTokens ?? 1024, 'config.provider.maxTokens')
  const timeoutMs = positiveInt(providerRaw.timeoutMs ?? 15000, 'config.provider.timeoutMs')
  const contextMessages = nonNegativeInt(providerRaw.contextMessages ?? 6, 'config.provider.contextMessages')
  const contextChars = positiveInt(providerRaw.contextChars ?? 400, 'config.provider.contextChars')

  // confidenceThreshold 已删除（2026-10-28，追问只看 unknown）：旧 profile 里还写着的不报错、直接忽略

  const clarifyMaxTurns = raw.clarifyMaxTurns ?? 2
  if (!Number.isInteger(clarifyMaxTurns) || clarifyMaxTurns < 1) {
    throw new RouterError('BAD_CONFIG', 'config.clarifyMaxTurns must be an integer >= 1')
  }

  const enabledHandlers = raw.enabledHandlers ?? [...HANDLER_IDS]
  if (!Array.isArray(enabledHandlers) || enabledHandlers.length === 0) {
    throw new RouterError('BAD_CONFIG', 'config.enabledHandlers must be a non-empty array')
  }
  const seen = new Set()
  for (const id of enabledHandlers) {
    if (typeof id !== 'string' || !HANDLER_IDS.includes(id)) {
      throw new RouterError('BAD_CONFIG', `config.enabledHandlers has unknown handler ${JSON.stringify(id)}`)
    }
    if (seen.has(id)) throw new RouterError('BAD_CONFIG', `config.enabledHandlers has duplicate ${JSON.stringify(id)}`)
    seen.add(id)
  }

  const logDir = raw.logDir === undefined ? DEFAULT_LOG_DIR : raw.logDir
  if (logDir !== null && !nonEmpty(logDir)) {
    throw new RouterError('BAD_CONFIG', 'config.logDir must be a non-empty string (or null = no routing log)')
  }

  const logger = raw.logger === undefined ? console : raw.logger
  if (logger !== null && (typeof logger !== 'object' || Array.isArray(logger))) {
    throw new RouterError('BAD_CONFIG', 'config.logger must be an object or null')
  }

  return {
    provider: {
      mode,
      stubSlots: providerRaw.stubSlots ?? null,
      fillSlots: providerRaw.fillSlots ?? null,
      promptsDir,
      route: route === null ? null : { provider: route.provider, model: route.model },
      reasoningEffort,
      maxTokens,
      timeoutMs,
      contextMessages,
      contextChars
    },
    clarifyMaxTurns,
    enabledHandlers: [...enabledHandlers],
    logDir,
    logger
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value !== ''
}

function positiveInt(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new RouterError('BAD_CONFIG', `${name} must be an integer >= 1`)
  return value
}

function nonNegativeInt(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new RouterError('BAD_CONFIG', `${name} must be an integer >= 0`)
  return value
}
