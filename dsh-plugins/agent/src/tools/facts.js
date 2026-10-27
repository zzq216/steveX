import { JSON_OUTPUT, jsonText, textBlocks, sessionOf } from './shared.js'
import { SourceError } from '../facts/source.js'

/**
 * 事实库与 MC 源码（P5 实施细则 §4–§6）：fact_search、fact_write、mc_source_search、mc_source_read。
 *
 * 源码与事实是接口知识（和 command_docs 同类），不是此刻的世界状态，所以进所有回合（P5-D11，不违反 I13）。
 * 只读源码基准：路径一律相对基准，越界的拒绝（P5-D9）。
 * 用过源码 / 写过事实都告诉适配层（turns.note），回合结束时据此决定要不要提醒补事实库（§7）。
 *
 * @param {object} services
 * @param {{ store: import('../facts/store.js').FactStore, source: import('../facts/source.js').SourceTree }} services.facts
 * @param {{ note: (sessionId, kind: 'source'|'write') => void, source: (sessionId) => object }} [services.factTurns]
 * @param {number} services.maxOutputChars
 */
export function factTools({ facts, factTurns = { note() {}, source: () => ({}) }, maxOutputChars }) {
  const { store, source } = facts
  const render = (_args, value) => textBlocks(jsonText(value, maxOutputChars))

  return [
    {
      name: 'fact_search',
      description: [
        '查事实库：从 MC 源码里确认过、带源码引用的事实。查 MC 机制先查这里，库里有、引用有效就不必再翻源码。',
        'query 按空白拆成几个词，名字、陈述、标签里含任一词就返回，含的词越多越靠前（中文没有分词：搜不到就换几个短词再搜）；不给 = 全部。',
        '返回每条的名字、陈述、源码引用（文件 + 行号；要看原文用 mc_source_read）与修订号；引用对不上当前源码的标出 stale。'
      ].join('\n'),
      parameters: {
        query: { type: 'string', description: '一个或几个词（空白分隔），不区分大小写' },
        tags: { type: 'array', items: { type: 'string' }, description: '只要带这些标签的' },
        limit: { type: 'integer', description: '最多几条（1–50，默认 20）' }
      },
      output: { schema: JSON_OUTPUT, render },
      isConcurrencySafe: () => true,
      async execute(args) {
        return store.search({ query: args.query ?? '', tags: args.tags ?? [], limit: args.limit })
      }
    },
    {
      name: 'fact_write',
      description: [
        '写一条事实进事实库（必须附源码引用，引用不成立就拒绝）。',
        '- name：小写点分的名字（如 "damage.lava-sets-fire"）；statement：一句话写"游戏里是什么样"，≤ 500 字，一条事实一件事',
        '- refs：1–5 条 { file, lines: [start, end] }，file 是源码基准里的相对路径（mc_source_search 结果里的那种），每条 ≤ 80 行，指向能直接看出这件事的那几行',
        '- 名字已存在：要修订它就写 replaces: <当前修订号>（错误里会给出已有内容）；不是同一件事就换个名字',
        '写入成功后返回至多 3 条相近的已有事实：重复了可以改成修订，矛盾了回头再确认。'
      ].join('\n'),
      parameters: {
        name: { type: 'string', required: true, description: '事实名，小写点分' },
        statement: { type: 'string', required: true, description: '一句话的事实' },
        refs: {
          type: 'array', required: true, description: '源码引用',
          items: { type: 'object', additionalProperties: true, properties: { file: { type: 'string' }, lines: { type: 'array', items: { type: 'integer' } } } }
        },
        tags: { type: 'array', items: { type: 'string' }, description: '可选：标签' },
        replaces: { type: 'integer', description: '名字已存在时必填：它当前的修订号' }
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(renderWrite(value)) },
      async execute(args, exec) {
        const sessionId = sessionOf(exec)
        const result = store.write(args, { ...factTurns.source(sessionId), sessionId })
        if (result.ok) factTurns.note(sessionId, 'write')
        return result
      }
    },
    {
      name: 'mc_source_search',
      description: [
        '在 MC 反编译源码（1.21.11 基准，客户端与服务端合一，只有 .java）里搜索（ripgrep）。',
        '- pattern：正则（ripgrep 语法）；fixed: true 按字面量搜（搜带括号的方法调用时用）',
        '- path：只搜这个子目录或这一个 .java 文件（基准内相对路径，如 net/minecraft/world/entity 或 net/minecraft/world/entity/Entity.java）；glob：文件名过滤（如 *Entity*.java）',
        '- context：每处命中前后各带几行（0–3）；limit：最多几处命中（默认 50，上限 200）',
        '结果每行 "文件:行号: 内容"（上下文行是 "文件-行号-"），文件路径就是 fact_write 的 refs[].file 要的形状。读一段用 mc_source_read。'
      ].join('\n'),
      parameters: {
        pattern: { type: 'string', required: true, description: '正则或字面量' },
        fixed: { type: 'boolean', description: '按字面量搜' },
        path: { type: 'string', description: '基准内的子目录或 .java 文件' },
        glob: { type: 'string', description: '文件名模式' },
        context: { type: 'integer', description: '上下文行数 0–3' },
        limit: { type: 'integer', description: '最多几处命中' }
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(renderSearch(value, maxOutputChars)) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        factTurns.note(sessionOf(exec), 'source')
        try {
          return { ok: true, ...(await source.search(args)) }
        } catch (error) {
          return { ok: false, error: error instanceof SourceError ? error.message : String(error) }
        }
      }
    },
    {
      name: 'mc_source_read',
      description: '读 MC 反编译源码的一段（带行号）。file 是基准内的相对路径（mc_source_search 结果里的那种）；start 缺省 1，end 缺省 start + 199，一次最多 300 行。',
      parameters: {
        file: { type: 'string', required: true, description: '如 net/minecraft/world/entity/Entity.java' },
        start: { type: 'integer', description: '起始行（从 1 开始）' },
        end: { type: 'integer', description: '结束行（含）' }
      },
      output: { schema: JSON_OUTPUT, render: (_args, value) => textBlocks(renderRead(value)) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        factTurns.note(sessionOf(exec), 'source')
        try {
          return { ok: true, ...source.read(args) }
        } catch (error) {
          return { ok: false, error: error instanceof SourceError ? error.message : String(error) }
        }
      }
    }
  ]
}

function renderWrite(value) {
  if (!value.ok) return `没有写入：\n${value.errors.map((e) => `- ${e}`).join('\n')}`
  const f = value.fact
  const lines = [`已${value.created ? '写入' : `修订为 rev ${f.rev}`}：${f.name} — ${f.statement}`]
  lines.push(`引用：${f.refs.map((r) => `${r.file}:${r.lines[0]}-${r.lines[1]}`).join(', ')}`)
  if (value.similar.length) {
    lines.push('相近的已有事实（重复就改成修订，矛盾就回头确认）：')
    for (const s of value.similar) lines.push(`- ${s.name}（rev ${s.rev}）：${s.statement}`)
  }
  return lines.join('\n')
}

function renderSearch(value, maxChars) {
  if (!value.ok) return `搜索失败：${value.error}`
  if (value.matches === 0) return '没有命中'
  const head = `${value.matches} 处命中，${value.files} 个文件${value.truncated ? `（已截断：命中太多或超时；缩小 path / glob、改 pattern，或调大 limit）` : ''}`
  const text = `${head}\n${value.text}`
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截断到 ${maxChars} 字符）` : text
}

function renderRead(value) {
  if (!value.ok) return `读取失败：${value.error}`
  return `${value.file}（共 ${value.total} 行）第 ${value.start}–${value.end} 行${value.truncated ? '（一次最多 300 行，后面的用 start 接着读）' : ''}\n${value.text}`
}
