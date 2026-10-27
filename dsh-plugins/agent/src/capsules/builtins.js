import { createRequire } from 'node:module'

/**
 * 内置条目（locked，宿主实现）：两套查询 API。
 *
 * 它们按设计是 `code/` 下的条目（nbt查询api设计方案 §2.1），树里用 Compute 节点调用；
 * 但需要读盘，所以 body 不是沙箱代码，而是 `{ host: '…' }`——由宿主装载器取数据、再跑纯筛选。
 * 四 / 五个参数**只允许字面量**（数据源与白名单在装载期静态可判，§3.1）。
 */
const require = createRequire(import.meta.url)
const { createNbtQueryApi, SOURCE_PATHS: NBT_SOURCES } = require('../../../../src/nbt/index.js')
const { createJsonQueryApi } = require('../../../../src/json/index.js')

export { NBT_SOURCES }

const QUERY_INPUTS = {
  filters: { type: 'object', hint: '键 = 记录内点分路径，值 = 条件（字面量 / {min,max} 区间 / 数组 = 并集），多键 AND' },
  fields: { type: 'list', item: 'string', required: true, hint: '投影：输出哪些路径（必填、非空）' },
  limit: { type: 'int', hint: '最多返回几条，1..512，默认 64' }
}
const QUERY_OUTPUTS = {
  result: { type: 'list', hint: '命中并投影后的记录（键 = fields 里的路径字符串）' },
  matchedCount: { type: 'number', hint: '截断前的命中总数' },
  sourceVersion: { type: 'string', hint: '数据源快照版本戳' }
}

/**
 * @param {object} options
 * @param {Record<string,string>} options.jsonSources  标识 → 绝对路径（文件或目录）
 * @param {string|null} options.visionRoot             采集端落盘目录（NBT 查询）
 */
export function createBuiltins({ jsonSources = {}, visionRoot = null } = {}) {
  const json = createJsonQueryApi({ sources: jsonSources })
  const nbt = visionRoot ? createNbtQueryApi({ visionRoot }) : null
  const jsonIds = Object.keys(jsonSources)

  const builtins = [
    {
      folder: 'code',
      entry: {
        name: 'core.json.query',
        description: `查询白名单里的 JSON 文件（可用数据源：${jsonIds.join(' / ') || '无'}）；只出短列表`,
        signature: {
          inputs: {
            path: { type: 'string', required: true, hint: '数据源标识，或 <目录源>/<相对路径>.json；不接受文件路径' },
            records: { type: 'string', hint: '记录数组在文件里的点分路径（如 "recipes"）；文件根就是数组时省略' },
            ...QUERY_INPUTS
          },
          outputs: QUERY_OUTPUTS
        },
        body: { host: 'json.query', literalParams: true }
      },
      host: {
        validate: (params) => tryValidate(() => json.validateParams(params)),
        run: (params, { taskId }) => json.query(params, { taskId }),
        version: (params) => json.version(params.path),
        releaseTask: (taskId) => json.releaseTask(taskId)
      }
    },
    {
      folder: 'code',
      entry: {
        name: 'core.nbt.query',
        description: '查询记忆世界落盘的 NBT（entities / containers / block_entities / biomes / terrain）；只出短列表',
        signature: {
          inputs: {
            path: { type: 'string', required: true, hint: NBT_SOURCES.join(' / ') },
            ...QUERY_INPUTS
          },
          outputs: {
            ...QUERY_OUTPUTS,
            // v2.55（多世界记忆隔离）：数据来自哪个世界；采集端还没写 current.json 时为 null
            world: { type: 'any', hint: '数据来自哪个世界 { key, label, inWorld }；未知时为 null' }
          }
        },
        body: { host: 'nbt.query', literalParams: true }
      },
      host: {
        validate: (params) => {
          if (!NBT_SOURCES.includes(params?.path)) return [`path must be one of ${NBT_SOURCES.join(' / ')}`]
          return []
        },
        run: (params, { taskId }) => {
          if (!nbt) throw new Error('NBT query is not configured (visionRoot is null)')
          return nbt.query(params, { taskId })
        },
        version: (params) => (nbt ? nbt.version(params.path) : null),
        releaseTask: (taskId) => nbt?.releaseTask(taskId)
      }
    }
  ]
  return { builtins, json, nbt }
}

function tryValidate(fn) {
  try {
    fn()
    return []
  } catch (error) {
    return [error.message]
  }
}
