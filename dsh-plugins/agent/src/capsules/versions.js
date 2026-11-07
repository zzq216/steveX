import fs from 'node:fs'
import path from 'node:path'

/**
 * 胶囊版本说明（胶囊版本说明设计方案）：同名新版本替换旧版时记下"改了什么、各自在什么情况下更好"。
 *
 *   <capsulesDir>/versions.json   { version, entries: { "<folder>/<name>": { "<hash>": { parent, at, by, change, none?, claims[] } } } }
 *
 * 和 stats.json、notes.json 一样在条目之外、不改哈希（V1）；只留本地。
 * 判断（claim）是待验证的假设：{ better: new | old, when, basis: measured | inferred, evidence?, status, reviews? }，
 * 默认 open，由以后用到相关版本的任务在复盘时核对成 confirmed / refuted（V4）。
 * 一条判断记在**新版**那条记录下，better 指明是新版（这条记录的哈希）还是旧版（parent）更好。
 */
const VERSION = 1
export const CLAIM_BETTER = Object.freeze(['new', 'old'])
export const CLAIM_BASIS = Object.freeze(['measured', 'inferred'])
export const CLAIM_STATUS = Object.freeze(['open', 'confirmed', 'refuted'])
const MAX_CLAIMS = 3

export class CapsuleVersions {
  /**
   * @param {object} options
   * @param {string|null} options.dir  胶囊库目录；null = 只在内存里（测试 / 未配置）
   * @param {() => number} [options.now]
   */
  constructor({ dir = null, now = () => Date.now() } = {}) {
    this.file = dir ? path.join(dir, 'versions.json') : null
    this.now = now
    this.data = { version: VERSION, entries: {} }
    if (this.file && fs.existsSync(this.file)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        if (loaded && typeof loaded.entries === 'object') this.data = { version: VERSION, entries: loaded.entries }
      } catch {
        // 坏文件不挡插件启动：当作空的，下次写入时覆盖
      }
    }
  }

  /**
   * 校验 capsule_save 的 versionNote（V2、V3）。@returns {{ ok: true, note } | { ok: false, errors: string[] }}
   * note = { change, none? , claims: [{ better, when, basis, evidence? }] }
   */
  static check(note) {
    const errors = []
    if (!note || typeof note !== 'object' || Array.isArray(note)) {
      return { ok: false, errors: ['versionNote is required when replacing (replaces given): { change, claims } or { change, none } — see the parameter description'] }
    }
    const change = typeof note.change === 'string' ? note.change.trim() : ''
    if (!change) errors.push('versionNote.change 必填：相对旧版改了什么（一两句）')
    const claims = Array.isArray(note.claims) ? note.claims : note.claims == null ? [] : null
    if (claims === null) errors.push('versionNote.claims 要是数组')
    const none = typeof note.none === 'string' && note.none.trim() ? note.none.trim() : null
    if (claims && claims.length === 0 && !none) errors.push('versionNote 要写 claims（1–3 条：哪一版在什么情况下更好），或写 none（为什么旧版没有更好的情况，如纯修错）')
    if (claims && claims.length > 0 && none) errors.push('versionNote 的 claims 和 none 只能写一个')
    if (claims && claims.length > MAX_CLAIMS) errors.push(`versionNote.claims 最多 ${MAX_CLAIMS} 条`)
    const cleaned = []
    for (const [i, claim] of (claims ?? []).entries()) {
      const at = `versionNote.claims[${i}]`
      if (!claim || typeof claim !== 'object') { errors.push(`${at} 要是对象`); continue }
      if (!CLAIM_BETTER.includes(claim.better)) errors.push(`${at}.better 要是 ${CLAIM_BETTER.join(' / ')} 之一（哪一版更好）`)
      if (typeof claim.when !== 'string' || !claim.when.trim()) errors.push(`${at}.when 必填：在什么情况下（执行前或执行时能观察到的条件）`)
      if (!CLAIM_BASIS.includes(claim.basis)) errors.push(`${at}.basis 要是 ${CLAIM_BASIS.join(' / ')} 之一（实测 / 推测）`)
      const evidence = typeof claim.evidence === 'string' ? claim.evidence.trim() : ''
      if (claim.basis === 'measured' && !evidence) errors.push(`${at}.evidence 必填（basis 是 measured）：哪个任务、什么数字`)
      cleaned.push({ better: claim.better, when: String(claim.when ?? '').trim(), basis: claim.basis, ...(evidence ? { evidence } : {}) })
    }
    if (errors.length) return { ok: false, errors }
    return { ok: true, note: { change, ...(none ? { none } : {}), claims: cleaned } }
  }

  /** 记下一次替换：key = "folder/name"，hash = 新版，parent = 被替换的旧版。同一哈希再记一次会覆盖说明、保留已有判断的核对。 */
  record(key, hash, { parent, by = null, note }) {
    const versions = (this.data.entries[key] ??= {})
    versions[hash] = {
      parent, at: new Date(this.now()).toISOString(), ...(by ? { by } : {}),
      change: note.change, ...(note.none ? { none: note.none } : {}),
      claims: note.claims.map((c) => ({ ...c, status: 'open' }))
    }
    this.save()
    return versions[hash]
  }

  /** 一个版本的记录（没有 = null）。 */
  get(key, hash) {
    return this.data.entries[key]?.[hash] ?? null
  }

  /** 一个名字下记过的全部版本 { hash: record }。 */
  all(key) {
    return this.data.entries[key] ?? {}
  }

  /**
   * 从 hash 沿 parent 往上的链，最多 limit 项（含 hash 自己）。没记录的版本也列一项（record = null），然后停下。
   * @returns {Array<{ hash, record }>}
   */
  chain(key, hash, limit = 5) {
    const out = []
    const seen = new Set()
    let cur = hash
    while (cur && !seen.has(cur) && out.length < limit) {
      seen.add(cur)
      const record = this.get(key, cur)
      out.push({ hash: cur, record })
      cur = record?.parent ?? null
    }
    return out
  }

  /**
   * 涉及某个版本的判断：这个版本是新版一侧（记录在它下面）或旧版一侧（某个记录的 parent 是它）。
   * @returns {Array<{ key, newHash, oldHash, index, claim, side: 'new' | 'old' }>}  side = 这个版本在判断里是哪一侧
   */
  claimsInvolving(key, hash) {
    const out = []
    for (const [newHash, record] of Object.entries(this.all(key))) {
      if (newHash !== hash && record.parent !== hash) continue
      for (const [index, claim] of (record.claims ?? []).entries()) {
        out.push({ key, newHash, oldHash: record.parent, index, claim, side: newHash === hash ? 'new' : 'old' })
      }
    }
    return out
  }

  /** "旧版更好"一侧、且没被否定的版本：GC 要保留它们（V11）。@returns {Map<"key@hash", string>} 引用 → 理由 */
  protectedVersions() {
    const out = new Map()
    for (const [key, versions] of Object.entries(this.data.entries)) {
      for (const record of Object.values(versions)) {
        if (!record.parent) continue
        for (const claim of record.claims ?? []) {
          if (claim.better !== 'old' || claim.status === 'refuted') continue
          const ref = `${key}@${record.parent}`
          if (!out.has(ref)) out.set(ref, `version claim: better when ${claim.when} (${claim.status})`)
        }
      }
    }
    return out
  }

  /** 各状态的判断条数（整理清单用，V10）。@returns {{ open, confirmed, refuted }} */
  claimCounts(key) {
    const counts = { open: 0, confirmed: 0, refuted: 0 }
    for (const record of Object.values(this.all(key))) for (const claim of record.claims ?? []) counts[claim.status] = (counts[claim.status] ?? 0) + 1
    return counts
  }

  /** 核对一条判断（V4）：状态以最后一次为准，记录全留。@returns {boolean} 找到了没有 */
  review(key, newHash, index, { status, evidence, by }) {
    const claim = this.get(key, newHash)?.claims?.[index]
    if (!claim) return false
    claim.status = status
    claim.reviews = [...(claim.reviews ?? []), { by, status, evidence, at: new Date(this.now()).toISOString() }]
    this.save()
    return true
  }

  save() {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n')
    fs.renameSync(tmp, this.file)
  }
}
