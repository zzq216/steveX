import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { SourceError } from './source.js'

/**
 * 事实库（P5 实施细则 §3–§5，集成方案 §9）：带源码引用的 MC 事实。
 *
 *   <dir>/<name>.json                当前版
 *   <dir>/history/<name>@<rev>.json  被修订掉的旧版（原样留着）
 *
 * - 按名字寻址（不按内容哈希）：事实没有被谁钉住版本，修订后大家就该看到新版（§3.1）
 * - 同名必须 replaces 当前 rev（P5-D4）；没有删除——错的事实修订改对，真要删由人删文件
 * - 每条引用 = 基准里一个 .java 文件 + 行号范围，写入时由这里算所引行的内容哈希（sha），
 *   基准换版本后 check() 能查出失效的引用（§4.3）
 * - 不判断"引用的行和陈述有没有关系"（语义判断机器做不了）；写入后附几条相近的已有事实，让大模型自己看（§4.4）
 */
const NAME = /^[a-z0-9][a-z0-9._-]*$/
const MAX_STATEMENT = 500

export class FactStore {
  /**
   * @param {object} options
   * @param {string|null} options.dir  事实库目录；null = 不能写（测试 / 未配置）
   * @param {import('./source.js').SourceTree} options.source
   * @param {number} [options.maxRefLines=80]
   * @param {number} [options.maxRefs=5]
   */
  constructor({ dir, source, maxRefLines = 80, maxRefs = 5, now = () => new Date() }) {
    this.dir = dir
    this.source = source
    this.maxRefLines = maxRefLines
    this.maxRefs = maxRefs
    this.now = now
  }

  /** 全部当前版事实（按名字排序）。 */
  list() {
    if (!this.dir || !fs.existsSync(this.dir)) return []
    return fs.readdirSync(this.dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .flatMap((file) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8'))]
        } catch {
          return []
        }
      })
  }

  get(name) {
    if (!this.dir || !NAME.test(name ?? '')) return null
    const file = path.join(this.dir, `${name}.json`)
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
  }

  /**
   * fact_write。
   * @param {{ name, statement, refs, tags?, replaces? }} entry
   * @param {object} source  写入时所在的回合 { kind, sessionId, taskId, requestId }，由调用方填
   * @returns {{ ok: true, fact, created, similar } | { ok: false, errors: string[] }}
   */
  write(entry, source = {}) {
    if (!this.dir) return { ok: false, errors: ['no fact library directory configured'] }
    const errors = []
    const { name, statement, refs, tags = [], replaces } = entry ?? {}
    if (typeof name !== 'string' || !NAME.test(name)) errors.push(`name must match ${NAME} (lowercase, dot-separated, e.g. "damage.lava-sets-fire")`)
    if (typeof statement !== 'string' || !statement.trim()) errors.push('statement is required: one sentence saying what is true in the game')
    else if (statement.length > MAX_STATEMENT) errors.push(`statement is ${statement.length} characters; keep it under ${MAX_STATEMENT} (one fact per entry — split it)`)
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || !t.trim())) errors.push('tags must be a list of non-empty strings')
    const checked = this.checkRefs(refs)
    errors.push(...checked.errors)
    if (errors.length) return { ok: false, errors }

    const current = this.get(name)
    if (current) {
      if (replaces === undefined) {
        return { ok: false, errors: [`${name} already exists (rev ${current.rev}): "${current.statement}" refs ${refs2text(current.refs)}. To revise it, resubmit with replaces: ${current.rev}; if this is a different fact, pick another name`] }
      }
      if (replaces !== current.rev) return { ok: false, errors: [`replaces ${replaces} is not the current rev of ${name} (current: rev ${current.rev}, "${current.statement}"); look at it again and resubmit`] }
    } else if (replaces !== undefined) {
      return { ok: false, errors: [`replaces given, but there is no fact named ${name} yet`] }
    }

    const fact = {
      name,
      statement: statement.trim(),
      refs: checked.refs,
      ...(tags.length ? { tags: [...new Set(tags.map((t) => t.trim()))] } : {}),
      rev: current ? current.rev + 1 : 1,
      createdAt: this.now().toISOString(),
      source: withoutNullish(source)
    }
    fs.mkdirSync(this.dir, { recursive: true })
    if (current) {
      const history = path.join(this.dir, 'history')
      fs.mkdirSync(history, { recursive: true })
      fs.writeFileSync(path.join(history, `${name}@${current.rev}.json`), JSON.stringify(current, null, 2) + '\n')
    }
    writeAtomic(path.join(this.dir, `${name}.json`), JSON.stringify(fact, null, 2) + '\n')
    return { ok: true, fact, created: !current, similar: this.similar(fact) }
  }

  /**
   * 引用校验（P5-D6）：基准内 .java、1 ≤ start ≤ end ≤ 行数、单条 ≤ maxRefLines 行、1–maxRefs 条。
   * @returns {{ refs: Array<{ file, lines: [number, number], sha }>, errors: string[] }}
   */
  checkRefs(refs) {
    if (!Array.isArray(refs) || refs.length === 0) return { refs: [], errors: ['refs is required: 1–5 source references [{ file, lines: [start, end] }] into the MC source baseline'] }
    if (refs.length > this.maxRefs) return { refs: [], errors: [`${refs.length} refs; at most ${this.maxRefs} — a fact that needs more is several facts`] }
    const out = []
    const errors = []
    refs.forEach((ref, i) => {
      const at = `refs[${i}]`
      const [start, end] = Array.isArray(ref?.lines) ? ref.lines : []
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        errors.push(`${at}.lines must be [start, end] with 1 ≤ start ≤ end`)
        return
      }
      if (end - start + 1 > this.maxRefLines) {
        errors.push(`${at}: ${end - start + 1} lines; point at the lines that show the fact (at most ${this.maxRefLines})`)
        return
      }
      let lines
      let file
      try {
        file = this.source.resolve(ref.file, 'file').rel
        lines = this.source.lines(file)
      } catch (error) {
        errors.push(`${at}: ${error instanceof SourceError ? error.message : String(error)}`)
        return
      }
      if (end > lines.length) {
        errors.push(`${at}: ${file} has ${lines.length} lines; ${start}-${end} is past the end`)
        return
      }
      out.push({ file, lines: [start, end], sha: shaOf(lines, start, end) })
    })
    return { refs: out, errors }
  }

  /**
   * fact_search（P5-D7）：多词任一命中（name / statement / tags），命中词越多越靠前。
   * @returns {{ total: number, facts: object[] }}  每条带 refs（不带源码正文）；失效的引用标 stale
   */
  search({ query = '', tags = [], limit = 20 } = {}) {
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const wanted = Array.isArray(tags) ? tags : []
    const rows = []
    for (const fact of this.list()) {
      if (wanted.length && !wanted.every((t) => (fact.tags ?? []).includes(t))) continue
      const hay = [fact.name, fact.statement, ...(fact.tags ?? [])].join('\n').toLowerCase()
      const score = words.filter((w) => hay.includes(w)).length
      if (words.length && score === 0) continue
      rows.push({ fact, score })
    }
    rows.sort((a, b) => b.score - a.score || a.fact.name.localeCompare(b.fact.name))
    const max = Math.min(50, Math.max(1, Number.isInteger(limit) ? limit : 20))
    return {
      total: rows.length,
      facts: rows.slice(0, max).map(({ fact }) => ({
        name: fact.name,
        statement: fact.statement,
        refs: fact.refs.map((ref) => (this.refStatus(ref) === 'ok' ? { file: ref.file, lines: ref.lines } : { file: ref.file, lines: ref.lines, stale: this.refStatus(ref) })),
        ...(fact.tags ? { tags: fact.tags } : {}),
        rev: fact.rev
      }))
    }
  }

  /**
   * 写入后附上的相近事实（§4.4）：陈述里的英文词（≥ 3 字符）与中文二字组，和已有事实的名字 / 陈述 / 标签重合 ≥ 30% 的，至多 3 条。
   * 中文没有空白分词，按 fact_search 那样拆词几乎永远落空（单元测试发现），这里用二字组。
   */
  similar(fact) {
    const tokens = tokensOf(fact.statement)
    if (tokens.length === 0) return []
    return this.list()
      .filter((other) => other.name !== fact.name)
      .map((other) => {
        const hay = [other.name, other.statement, ...(other.tags ?? [])].join('\n').toLowerCase()
        return { other, score: tokens.filter((t) => hay.includes(t)).length / tokens.length }
      })
      .filter(({ score }) => score >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ other }) => ({ name: other.name, statement: other.statement, rev: other.rev }))
  }

  /** /bt facts check：每条引用重算哈希。@returns {Array<{ name, file, lines, status }>} 只列失效的 */
  check() {
    const bad = []
    for (const fact of this.list()) {
      for (const ref of fact.refs ?? []) {
        const status = this.refStatus(ref)
        if (status !== 'ok') bad.push({ name: fact.name, file: ref.file, lines: ref.lines, status })
      }
    }
    return bad
  }

  /** 'ok' | 'file missing' | 'lines out of range' | 'content changed' */
  refStatus(ref) {
    let lines
    try {
      lines = this.source.lines(ref.file)
    } catch {
      return 'file missing'
    }
    const [start, end] = ref.lines
    if (end > lines.length) return 'lines out of range'
    return shaOf(lines, start, end) === ref.sha ? 'ok' : 'content changed'
  }
}

/** 所引行的内容哈希：去掉行尾空白后按 \n 连起来，sha256 前 8 位。 */
export function shaOf(lines, start, end) {
  const text = lines.slice(start - 1, end).map((line) => line.trimEnd()).join('\n')
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 8)
}

/** 英文词（≥ 3 字符）+ 中文二字组，去重。 */
function tokensOf(text) {
  const lower = String(text).toLowerCase()
  const words = lower.match(/[a-z0-9_]{3,}/g) ?? []
  const grams = []
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) grams.push(run)
    for (let i = 0; i + 1 < run.length; i++) grams.push(run.slice(i, i + 2))
  }
  return [...new Set([...words, ...grams])]
}

function refs2text(refs) {
  return (refs ?? []).map((r) => `${r.file}:${r.lines[0]}-${r.lines[1]}`).join(', ')
}

function withoutNullish(object) {
  return Object.fromEntries(Object.entries(object ?? {}).filter(([, v]) => v !== null && v !== undefined))
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}
