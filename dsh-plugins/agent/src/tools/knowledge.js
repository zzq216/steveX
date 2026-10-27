import { JSON_OUTPUT, jsonText, textBlocks, sessionOf } from './shared.js'
import { STATE_SOURCES } from '../bt/validator.js'
import { SOURCE_METHODS } from '../game/state.js'
import { vocabText } from '../game/vocab.js'
import { structureOf } from '../llm/structure.js'

/**
 * 查知识（集成方案 §5.1）：command_docs（命令注册表）、data_shapes（树能读的数据长什么样）、
 * capsule_search / capsule_get（胶囊库）。
 *
 * data_shapes 给结构与词表，不给实例值（I13）：写处理数据的代码要知道字段名、类型、枚举型字段的取值，
 * 但不该知道此刻的值——否则又会把值抄进树里。
 *   state.*  四个状态来源：此刻的结构 + 静态词表（game/vocab.js）
 *   json.*   白名单 JSON（配方）：全量结构 + 统计出的词表——静态参考数据，取值范围就是接口
 *   nbt.*    记忆世界：只给结构——从世界状态里统计出的"取值"是实例值（附近有哪些实体）
 *
 * @param {object} services
 * @param {import('../game/state.js').GameState} services.game
 * @param {import('../game/registry.js').CommandRegistry} services.registry
 * @param {import('../capsules/library.js').CapsuleLibrary} services.library
 * @param {object} [services.json]            src/json 的查询 API（loadDocument）
 * @param {string[]} [services.jsonSources]   白名单 JSON 的数据源标识
 * @param {object|null} [services.nbt]        src/nbt 的查询 API（loadRecords）；null = 没配置记忆世界
 * @param {string[]} [services.nbtSources]
 * @param {() => string|null} [services.taskId]  任务级数据快照
 * @param {object} [services.bridge]  复盘回合里 capsule_get task/… 从复盘请求持有的草稿拷贝取（P4 §2.4）
 * @param {number} services.maxOutputChars
 */
export function knowledgeTools({ registry, library, game, json = null, jsonSources = [], nbt = null, nbtSources = [], taskId = () => null, bridge = null, maxOutputChars }) {
  const render = (_args, value) => textBlocks(jsonText(value, maxOutputChars))
  const sourceNames = [
    ...STATE_SOURCES.map((s) => `state.${s}`),
    ...(json ? jsonSources.map((s) => `json.${s}`) : []),
    ...(nbt ? nbtSources.map((s) => `nbt.${s}`) : [])
  ]
  const defaults = sourceNames.filter((s) => !s.startsWith('nbt.'))

  async function describe(name, signal) {
    const [kind, id] = [name.slice(0, name.indexOf('.')), name.slice(name.indexOf('.') + 1)]
    if (kind === 'state') {
      const snapshot = await game.read([id], signal)
      const vocab = vocabText(id)
      return `state.${id}: ${structureOf(snapshot[id])}${vocab ? `\n${vocab}` : ''}`
    }
    if (kind === 'json') {
      const { doc } = await json.loadDocument(id, { taskId: taskId() })
      return `json.${id}（树里：{ "compute": "code/core.json.query", "params": { "path": "${id}", "records": <记录数组的路径>, … } }）: ${structureOf(doc, { vocab: true })}`
    }
    const { records } = await nbt.loadRecords(id, { taskId: taskId() })
    return `nbt.${id}（树里：{ "compute": "code/core.nbt.query", "params": { "path": "${id}", … } }）: ${structureOf(records)}`
  }

  return [
    {
      name: 'data_shapes',
      description: [
        '树能读到的数据长什么样：字段名、类型、枚举型字段的全部取值（词表），**不返回实例值**（此刻的格子号、数量、坐标……）。写读数据的条件代码 / Compute 之前先查，不要猜字段名和取值。',
        `- state.<来源>：条件代码 / Compute 用 read 声明的 ${STATE_SOURCES.join(' / ')}，代码里是 main(params, state) 的 state.<来源>。结构随当时的界面变化（开着容器时 container 的字段更多）；字段含义用 command_docs 查对应的读取命令（${STATE_SOURCES.map((s) => `${s} → ${SOURCE_METHODS[s]}`).join('、')}）`,
        '- json.<数据源>：白名单 JSON（如配方），树里用 code/core.json.query 查；给全量记录合并后的结构与词表',
        '- nbt.<数据源>：记忆世界，树里用 code/core.nbt.query 查；只给结构',
        '列表元素合并显示，只在部分元素里有的字段标 ?；键本身是数据的对象显示成 map<键, 值>。'
      ].join('\n'),
      parameters: {
        sources: { type: 'array', items: { type: 'string', enum: sourceNames }, description: `要看哪些；省略 = ${defaults.join('、')}` }
      },
      output: {
        schema: JSON_OUTPUT,
        render: (_args, value) => textBlocks(Object.values(value).join('\n\n').slice(0, maxOutputChars))
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const names = args.sources?.length ? [...new Set(args.sources)] : defaults
        const out = {}
        await Promise.all(names.map(async (name) => {
          try {
            out[name] = await describe(name, exec?.signal)
          } catch (error) {
            out[name] = `${name}: （读取失败：${error.message}）`
          }
        }))
        return Object.fromEntries(names.map((n) => [n, out[n]]))
      }
    },
    {
      name: 'command_docs',
      description: [
        '查命令注册表：树里 cond / act / steps 能用的每一条命令（mod 原始命令 + 黑板条件）。',
        '不给参数 = 列出全部命令名与一句话说明；给 name = 该命令的参数 schema；给 prefix = 按前缀过滤（如 "container/"）。',
        'read=true 的是读取命令：不能出现在 act / steps 里，读状态请用条件代码（cond + read）或 Compute 的 read。'
      ].join('\n'),
      parameters: {
        name: { type: 'string', description: '命令全名，如 "container/slot"' },
        prefix: { type: 'string', description: '名字前缀过滤' }
      },
      output: { schema: JSON_OUTPUT, render },
      isConcurrencySafe: () => true,
      async execute(args) {
        if (args.name) {
          const [doc] = registry.docs((cmd) => cmd.name === args.name)
          if (!doc) throw new Error(`unknown command "${args.name}"; call command_docs without arguments to list them`)
          return doc
        }
        const prefix = args.prefix ?? ''
        return registry.docs((cmd) => cmd.name.startsWith(prefix)).map((doc) => ({
          name: doc.name, kind: doc.kind, ...(doc.read ? { read: true } : {}), description: doc.description
        }))
      }
    },
    {
      name: 'capsule_search',
      description: [
        '查胶囊库：可复用的条件代码（cond）、Compute 代码（compute）、子树（use），以及本任务的代码草稿（task/）。',
        '给 query = 按空白拆成几个词，引用名或说明里含任一词就返回，含的词越多越靠前；不给 = 全部。返回每条的引用、种类、说明与输入 / 输出名；要看完整契约与正文用 capsule_get。'
      ].join('\n'),
      parameters: {
        query: { type: 'string', description: '一个或几个词（空白分隔），不区分大小写' }
      },
      output: { schema: JSON_OUTPUT, render },
      isConcurrencySafe: () => true,
      async execute(args) {
        const words = (args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
        const hits = (row) => words.filter((w) => row.ref.toLowerCase().includes(w) || row.description.toLowerCase().includes(w)).length
        return library.list()
          .map((row) => ({ row, n: words.length ? hits(row) : 1 }))
          .filter(({ n }) => n > 0)
          .sort((a, b) => b.n - a.n)
          .map(({ row }) => {
            const entry = library.tryGet(row.ref)
            return {
              ref: row.ref, kind: row.kind, description: row.description,
              inputs: Object.keys(entry?.signature.inputs ?? {}),
              ...(entry?.signature.outputs ? { outputs: Object.keys(entry.signature.outputs) } : {}),
              ...(row.locked ? { locked: true } : {}),
              ...(row.draft ? { draft: true } : {})
            }
          })
      }
    },
    {
      name: 'capsule_get',
      description: '取一个胶囊条目的完整契约（signature：inputs / outputs / returns）与正文（代码或子树）。ref 可以省略 @hash，取最新版。',
      parameters: {
        ref: { type: 'string', required: true, description: '如 "code/core.json.query"、"trees/x@1a2b3c4d"、"task/plan-grid"' }
      },
      output: { schema: JSON_OUTPUT, render },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const draft = String(args.ref).startsWith('task/') ? bridge?.reflectDraft?.(sessionOf(exec), args.ref) : null
        if (draft) return { ref: `task/${draft.name}@${draft.hash}`, description: draft.description ?? '', signature: draft.signature, body: draft.body }
        const ref = library.pin(args.ref)
        const entry = library.get(ref)
        const host = Boolean(library.host(ref))
        return {
          ref,
          description: entry.description ?? '',
          signature: entry.signature,
          ...(entry.preconditions?.length ? { preconditions: entry.preconditions } : {}),
          ...(host ? { host: true, note: '宿主实现的内置查询：参数只许字面量' } : { body: entry.body })
        }
      }
    }
  ]
}
