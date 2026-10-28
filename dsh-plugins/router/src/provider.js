import { RouterError } from './domain/router.js'
import { defaultSlots, validateSlotJson } from './domain/slots.js'

/**
 * Router provider（设计文档 §17.3）：一个插件、两种模式。
 *
 *   stub：返回脚本化槽位（默认 = 全 none），测试/开发用；
 *   llm ：委托给 fillSlots（index.js 默认用 llm_slots.js + ctx.llm 构造；测试可程序化注入）。
 *
 * 两种模式产出的都是 §7 的 SlotJSON，经同一份校验后交给编排器。
 */
export function createRouterProvider(options = {}) {
  const mode = options.mode ?? 'stub'

  if (mode === 'stub') {
    const scripted = options.stubSlots ?? null
    return {
      mode,
      async fillSlots() {
        return validateSlotJson(scripted ?? defaultSlots())
      }
    }
  }

  if (mode === 'llm') {
    const fillSlots = options.fillSlots
    if (typeof fillSlots !== 'function') {
      throw new RouterError(
        'PROVIDER_NOT_IMPLEMENTED',
        'router-provider: mode=llm needs a fillSlots function'
      )
    }
    return {
      mode,
      async fillSlots(context) {
        return validateSlotJson(await fillSlots(context))
      }
    }
  }

  throw new RouterError('BAD_PROVIDER_MODE', `router-provider: unknown mode ${JSON.stringify(mode)}`)
}
