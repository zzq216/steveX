import { JSON_OUTPUT, jsonText, textBlocks, sessionOf } from './shared.js'
import { usageSummary } from '../capsules/stats.js'
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
export function knowledgeTools({ registry, library, stats = null, history = null, game, json = null, jsonSources = [], nbt = null, nbtSources = [], taskId = () => null, bridge = null, maxOutputChars }) {
  const render = (_args, value) => textBlocks(jsonText(value, maxOutputChars))
  // 胶囊的已知问题（任务历史方案 H8）：复盘时记下、还待验证的
  const notesOf = (ref) => history?.notesFor(ref) ?? []
  // 使用统计（整理方案 §4）：只展示，不参与排序；没有数据写"尚无记录"（没用过 ≠ 没用）
  const keyOf = (ref) => ref.slice(0, ref.lastIndexOf('@'))
  const usageOf = (ref, kind) => stats ? usageSummary(stats.byName(keyOf(ref))?.total ?? null, kind, keyOf(ref)) : '（没有统计）'
  const usageDetail = (ref, entry) => {
    const key = keyOf(ref)
    const kind = entry.signature.returns === 'bool' ? 'condition' : 'compute'
    const named = stats.byName(key)
    const row = stats.get(ref)
    return {
      thisVersion: usageSummary(row, kind, key),
      allVersions: usageSummary(named?.total ?? null, kind, key),
      ...(named && named.versions.length > 1 ? { versions: named.versions.map(({ hash, row: r }) => `@${hash}: ${usageSummary(r, kind)}`) } : {}),
      ...(row?.lastUsed ? { firstUsed: row.firstUsed, lastUsed: row.lastUsed } : {}),
      ...(row?.errors?.length ? { recentErrors: row.errors } : {})
    }
  }
  // 版本说明（胶囊版本说明设计方案 V5、V6）：版本数、最新版跑没跑过、旧版在什么情况下更好、版本链
  const versions = library.versions ?? null
  const untested = (ref) => (stats ? !stats.ran(ref) : undefined)
  const archived = (ref) => !library.tryGet(ref)
  const olderBetterWhen = (key) => {
    if (!versions) return []
    const out = []
    for (const record of Object.values(versions.all(key))) {
      if (!record.parent || archived(`${key}@${record.parent}`)) continue
      for (const claim of record.claims ?? []) {
        if (claim.better !== 'old' || claim.status === 'refuted') continue
        out.push(`@${record.parent}：${claim.when}（${claim.basis === 'measured' ? '实测' : '推测'}，${claim.status}）`)
      }
    }
    return out.slice(0, 2)
  }
  const versionInfo = (ref) => {
    const key = keyOf(ref)
    const count = library.versionHashes(key).length
    const older = olderBetterWhen(key)
    return {
      ...(count >= 2 ? { versions: count } : {}),
      ...(untested(ref) ? { untested: true } : {}),
      ...(older.length ? { olderBetterWhen: older } : {})
    }
  }
  const versionUsage = (ref, kind) => {
    if (archived(ref)) return '已归档'
    if (!stats) return '（没有统计）'
    return stats.ran(ref) ? usageSummary(stats.get(ref), kind, keyOf(ref)) : '未执行'
  }
  const versionChain = (key, latestHash, kind) => {
    if (!versions) return null
    const chain = versions.chain(key, latestHash, 5)
    const rows = chain.map(({ hash, record }) => ({
      ref: `${key}@${hash}`,
      parent: record?.parent ?? null,
      ...(record?.at ? { at: record.at } : {}),
      change: record?.change ?? '（没有记录）',
      ...(record?.none ? { none: record.none } : {}),
      ...(record?.claims?.length ? { claims: record.claims.map((c) => ({ better: c.better === 'new' ? `这一版（@${hash}）` : `旧版（@${record.parent}）`, when: c.when, basis: c.basis, ...(c.evidence ? { evidence: c.evidence } : {}), status: c.status, ...(c.reviews?.length ? { reviews: c.reviews } : {}) })) } : {}),
      usage: versionUsage(`${key}@${hash}`, kind),
      knownIssues: notesOf(key).filter((n) => n.hash === hash).length
    }))
    const inChain = new Set(chain.map((c) => c.hash))
    const others = library.versionHashes(key).filter((h) => !inChain.has(h)).map((h) => ({ ref: `${key}@${h}`, usage: versionUsage(`${key}@${h}`, kind) }))
    return { rows, others }
  }
  /**
   * 数据源本身的事实（2026-11-13）：结构与词表看不出来、模型会去猜的性质。只描述数据，不说该怎么用。
   * 起因：盾牌任务猜"配方里的木板是 #minecraft:planks 标签"，写了用不上的标签解析器还存进了库；
   * 雕纹铜任务的 2x2 规划器把 [" M ", " M "] 当成 3 列宽。
   */
  const JSON_NOTES = {
    recipes: 'key / ingredients 里的标签已经展开成具体物品 id（数据里没有 #minecraft:… 形式的标签）；shaped 的 pattern 按配方生成器里的写法原样保留，可能带空格组成的空列或空行（如 [" M ", " M "]）。'
  }
  const sourceNames = [
    ...STATE_SOURCES.map((s) => `state.${s}`),
    ...(json ? jsonSources.map((s) => `json.${s}`) : []),
    ...(nbt ? nbtSources.map((s) => `nbt.${s}`) : [])
  ]
  const defaults = sourceNames.filter((s) => !s.startsWith('nbt.'))

  function chainFields(key, latestHash, entry) {
    if (library.versionHashes(key).length < 2 && !versions?.get(key, latestHash)) return {}
    const kind = entry.signature.returns === 'bool' ? 'condition' : 'compute'
    const chain = versionChain(key, latestHash, kind)
    if (!chain) return {}
    return { versionChain: chain.rows, ...(chain.others.length ? { otherVersions: chain.others } : {}) }
  }

  async function describe(name, signal) {
    const [kind, id] = [name.slice(0, name.indexOf('.')), name.slice(name.indexOf('.') + 1)]
    if (kind === 'state') {
      const snapshot = await game.read([id], signal)
      const vocab = vocabText(id)
      return `state.${id}: ${structureOf(snapshot[id])}${vocab ? `\n${vocab}` : ''}`
    }
    if (kind === 'json') {
      const { doc } = await json.loadDocument(id, { taskId: taskId() })
      const note = JSON_NOTES[id] ? `\n说明：${JSON_NOTES[id]}` : ''
      return `json.${id}（树里：{ "compute": "code/core.json.query", "params": { "path": "${id}", "records": <记录数组的路径>, … } }）: ${structureOf(doc, { vocab: true })}${note}`
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
        '给 query = 按空白拆成几个词，引用名或说明里含任一词就返回，含的词越多越靠前；不给 = 全部。返回每条的引用、种类、说明、输入 / 输出名与使用统计（usage，同名各版本加总；只是记录，不影响排序）；要看完整契约、正文与统计明细用 capsule_get。',
        '已下架的条目默认不返回；includeRetired = true 时一起返回，并带 retired（下架理由与取代者）。',
        'knownIssues = 以往任务复盘时记下、还待验证（open）或受现有能力限制（blocked）的问题条数（内容用 capsule_get 看）。',
        'versions = 同名版本数（≥2 才有）；untested = 列出的这一版还没在任务里执行过；olderBetterWhen = 替换时记下的"旧版在什么情况下更好"的判断（最多 2 条，带旧版哈希、实测 / 推测与核对状态；要用旧版就写带 @hash 的引用）。版本链用 capsule_get 看'
      ].join('\n'),
      parameters: {
        query: { type: 'string', description: '一个或几个词（空白分隔），不区分大小写' },
        includeRetired: { type: 'boolean', description: '也返回已下架的条目（默认 false）' }
      },
      output: { schema: JSON_OUTPUT, render },
      isConcurrencySafe: () => true,
      async execute(args) {
        const words = (args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
        const hits = (row) => words.filter((w) => row.ref.toLowerCase().includes(w) || row.description.toLowerCase().includes(w)).length
        return library.list()
          .filter((row) => args.includeRetired || !row.retired)
          .map((row) => ({ row, n: words.length ? hits(row) : 1 }))
          .filter(({ n }) => n > 0)
          .sort((a, b) => b.n - a.n)
          .map(({ row }) => {
            const entry = library.tryGet(row.ref)
            return {
              ref: row.ref, kind: row.kind, description: row.description,
              inputs: Object.keys(entry?.signature.inputs ?? {}),
              ...(entry?.signature.outputs ? { outputs: Object.keys(entry.signature.outputs) } : {}),
              ...(row.draft ? {} : { usage: usageOf(row.ref, row.kind) }),
              ...(!row.draft && notesOf(row.ref).length ? { knownIssues: notesOf(row.ref).length } : {}),
              ...(!row.draft && !row.builtin ? versionInfo(row.ref) : {}),
              ...(row.locked ? { locked: true } : {}),
              ...(row.draft ? { draft: true } : {}),
              ...(row.retired ? { retired: row.retired } : {})
            }
          })
      }
    },
    {
      name: 'capsule_get',
      description: '取一个胶囊条目的完整契约（signature：inputs / outputs / returns）、正文（代码或子树）与使用统计（这个版本、同名所有版本、最近的错误样本、转正前作为草稿时的数字）。ref 可以省略 @hash，取最新版。同名有多个版本时带 versionChain：从最新版沿替换关系往前最多 5 版，每版写改了什么、替换时记下的判断（哪一版在什么情况下更好、实测 / 推测、核对状态）、这一版的使用（"未执行" / "已归档"）与已知问题数；不在链上的旧版本列在 otherVersions。',
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
        const key = ref.slice(0, ref.lastIndexOf('@'))
        const info = library.readManifest()[key]
        return {
          ref,
          description: entry.description ?? '',
          signature: entry.signature,
          ...(entry.preconditions?.length ? { preconditions: entry.preconditions } : {}),
          ...(info?.retired ? { retired: info.retired } : {}),
          ...(info && info.hash !== entry.hash ? { latest: `${key}@${info.hash}` } : {}),
          ...(stats ? { usage: usageDetail(ref, entry) } : {}),
          ...(notesOf(ref).length ? { knownIssues: notesOf(ref).map((n) => ({ ...n, version: n.hash === entry.hash ? '这个版本' : n.hash ? `针对 @${n.hash}` : '版本未知' })) } : {}),
          ...(!host && info ? chainFields(key, info.hash, entry) : {}),
          ...(host ? { host: true, note: '宿主实现的内置查询：参数只许字面量' } : { body: entry.body })
        }
      }
    }
  ]
}
