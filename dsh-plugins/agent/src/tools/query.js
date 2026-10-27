import { JSON_OUTPUT, jsonText, textBlocks } from './shared.js'

/**
 * 读状态 / 查记忆与数据（集成方案 §5.1）：mod_query、nbt_query、json_query。
 * 都只读、可并行；查询参数与树里 core.*.query 的参数是同一套（同一个宿主 API）。
 *
 * @param {object} services
 * @param {{ mod: { call(method, params): Promise<{ ok, data?, error? }> } }} services.game
 * @param {Array<{ method, zh?, description }>} services.methods   mod 方法表（steveX src/mod/methods.js）
 * @param {Set<string>} services.readMethods                      放行的只读方法
 * @param {object|null} services.nbt     createNbtQueryApi()；null = 没配置 visionRoot
 * @param {string[]} services.nbtSources
 * @param {object} services.json         createJsonQueryApi()
 * @param {string[]} services.jsonSources
 * @param {() => string|null} services.taskId  当前任务（或正在规划的任务）的 id：查询按任务钉数据快照
 * @param {number} services.maxOutputChars
 */
export function queryTools({ game, methods, readMethods, nbt, nbtSources, json, jsonSources, taskId, maxOutputChars }) {
  const allowed = methods.filter((m) => readMethods.has(m.method))
  const render = (_args, value) => textBlocks(jsonText(value, maxOutputChars))
  const queryParams = {
    filters: { type: 'object', additionalProperties: true, description: '键 = 记录内的点分路径，值 = 字面量 / { "min", "max" } 区间 / 数组（任一）；多个键是 AND' },
    fields: { type: 'array', items: { type: 'string' }, required: true, description: '投影：输出哪些路径（必填、非空）' },
    limit: { type: 'integer', description: '最多返回几条，1..512，默认 64' }
  }
  const options = () => ({ taskId: taskId() ?? undefined })

  return [
    {
      name: 'mod_query',
      description: [
        '读游戏的实时状态：直接透传采集端 mod 的只读方法，不会对世界产生作用。',
        '方块与实体请用 nbt_query 查记忆世界；对世界的一切作用只能写成行为树提交。',
        '可用方法：',
        ...allowed.map((m) => `- ${m.method}：${m.zh ?? m.description}`)
      ].join('\n'),
      parameters: {
        method: { type: 'string', required: true, enum: allowed.map((m) => m.method), description: 'mod 方法名' },
        params: { type: 'object', additionalProperties: true, description: '方法参数；无参方法省略或 {}' }
      },
      output: { schema: JSON_OUTPUT, render },
      isConcurrencySafe: () => true,
      async execute(args) {
        const res = await game.mod.call(args.method, args.params ?? {})
        if (!res?.ok) throw new Error(`${args.method}: ${res?.error ?? 'no response'}`)
        return res.data ?? null
      }
    },
    {
      name: 'nbt_query',
      description: [
        '查记忆世界（采集端见过并落盘的 NBT）：实体 / 容器 / 方块实体 / 生物群系 / 地形。只出短列表。',
        '记忆可能过期：只是你见过的样子，不保证现在还是这样。',
        `path 可选：${nbtSources.join(' / ')}。参数与树里 { "compute": "code/core.nbt.query" } 相同。`
      ].join('\n'),
      parameters: {
        path: { type: 'string', required: true, enum: nbtSources, description: '数据源' },
        ...queryParams
      },
      output: { schema: JSON_OUTPUT, render },
      isConcurrencySafe: () => true,
      async execute(args) {
        if (!nbt) throw new Error('NBT query is not configured (visionRoot is null)')
        return nbt.query(args, options())
      }
    },
    {
      name: 'json_query',
      description: [
        '查白名单里的 JSON 数据文件（第一个用途：合成配方）。只出短列表。',
        `可用数据源：${jsonSources.join(' / ') || '无'}。参数与树里 { "compute": "code/core.json.query" } 相同；`,
        '例：{ "path": "recipes", "records": "recipes", "filters": { "result": "minecraft:wooden_pickaxe" }, "fields": ["type", "pattern", "key", "count"] }'
      ].join('\n'),
      parameters: {
        path: { type: 'string', required: true, description: '数据源标识，或 <目录源>/<相对路径>.json；不接受文件路径' },
        records: { type: 'string', description: '记录数组在文件里的点分路径（如 "recipes"）；文件根就是数组时省略' },
        ...queryParams
      },
      output: { schema: JSON_OUTPUT, render },
      isConcurrencySafe: () => true,
      async execute(args) {
        return json.query(args, options())
      }
    }
  ]
}
