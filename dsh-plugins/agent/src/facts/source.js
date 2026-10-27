import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/**
 * MC 源码基准（P5 实施细则 §6，集成方案 §9）：mc_source_search / mc_source_read 与 fact_write 的引用校验都走这里。
 *
 * 读取边界（P5-D9）：只读基准目录（配置给的，不由大模型给）。大模型给的路径一律是基准内的相对路径，
 * 绝对路径、盘符、UNC、`..`、跳出基准的链接都拒绝——steveX/configs/environments/ 里有 API key。
 * 搜索用 ripgrep（DSH 依赖里带的 @vscode/ripgrep，不靠 PATH），参数数组直接传、不经 shell，固定 --no-config / --no-follow。
 */
export class SourceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SourceError'
  }
}

export class SourceTree {
  /**
   * @param {object} options
   * @param {string} options.root  源码基准目录
   * @param {number} [options.readMaxLines=300]
   * @param {number} [options.searchLimit=200]
   * @param {number} [options.timeoutMs=10000]
   * @param {() => Promise<string>} [options.rgPath]  测试注入；缺省按包名解析 @vscode/ripgrep
   */
  constructor({ root, readMaxLines = 300, searchLimit = 200, timeoutMs = 10000, rgPath = resolveRipgrep }) {
    this.root = root
    this.readMaxLines = readMaxLines
    this.searchLimit = searchLimit
    this.timeoutMs = timeoutMs
    this.rgPath = rgPath
    this.realRoot = null
  }

  rootReal() {
    if (!this.realRoot) {
      try {
        this.realRoot = fs.realpathSync(this.root)
      } catch {
        throw new SourceError(`the MC source baseline is missing: ${this.root}`)
      }
    }
    return this.realRoot
  }

  /**
   * 大模型给的相对路径 → 基准内的绝对路径。
   * @param {string} rel
   * @param {'file'|'dir'|'search'} kind  file：必须是 .java 文件；dir：必须是目录；search：目录或 .java 文件（mc_source_search 的 path）
   * @returns {{ full: string, rel: string }}  rel 是规范化后的相对路径（/ 分隔）
   */
  resolve(rel, kind = 'file') {
    if (typeof rel !== 'string' || rel.trim() === '' || rel.includes('\0')) throw new SourceError('path must be a non-empty relative path inside the source baseline')
    if (/^[a-zA-Z]:/.test(rel) || /^[\\/]/.test(rel)) throw new SourceError(`${rel}: absolute paths are not allowed; give a path relative to the source baseline (e.g. net/minecraft/world/entity/Entity.java)`)
    const parts = rel.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.')
    if (parts.includes('..')) throw new SourceError(`${rel}: ".." is not allowed; only files inside the source baseline can be read`)
    const root = this.rootReal()
    const full = path.resolve(root, ...parts)
    if (!inside(root, full)) throw new SourceError(`${rel}: outside the source baseline`)
    let real
    try {
      real = fs.realpathSync(full)
    } catch {
      throw new SourceError(`${rel}: no such ${kind === 'dir' ? 'directory' : kind === 'search' ? 'file or directory' : 'file'} in the source baseline`)
    }
    if (!inside(root, real)) throw new SourceError(`${rel}: outside the source baseline`)
    const stat = fs.statSync(real)
    if (kind === 'dir' && !stat.isDirectory()) throw new SourceError(`${rel}: not a directory`)
    // 搜索可以只搜一个文件（P5 DSH 内验收：大模型把 path 指向 Entity.java 被拒，改用 glob 才绕过去）
    if (kind === 'search' && !stat.isDirectory() && (!stat.isFile() || !real.endsWith('.java'))) throw new SourceError(`${rel}: only directories and .java files in the source baseline can be searched`)
    if (kind === 'file' && (!stat.isFile() || !real.endsWith('.java'))) throw new SourceError(`${rel}: only .java files in the source baseline can be read`)
    return { full: real, rel: parts.join('/') }
  }

  /** 文件的全部行（去掉行尾 \r）。 */
  lines(rel) {
    const { full } = this.resolve(rel, 'file')
    return fs.readFileSync(full, 'utf8').split('\n').map((line) => line.replace(/\r$/, ''))
  }

  /**
   * mc_source_read：读一段，带行号。
   * @returns {{ file, total, start, end, text, truncated }}
   */
  read({ file, start = 1, end } = {}) {
    const { rel } = this.resolve(file, 'file')
    const lines = this.lines(rel)
    const total = lines.length
    const from = Number.isInteger(start) && start >= 1 ? start : 1
    if (from > total) throw new SourceError(`${rel} has ${total} lines; start ${from} is past the end`)
    const wanted = Number.isInteger(end) && end >= from ? end : from + 199
    const to = Math.min(wanted, total, from + this.readMaxLines - 1)
    const width = String(to).length
    const text = lines.slice(from - 1, to).map((line, i) => `${String(from + i).padStart(width)} | ${line}`).join('\n')
    return { file: rel, total, start: from, end: to, text, truncated: to < Math.min(wanted, total) }
  }

  /**
   * mc_source_search：ripgrep。
   * @param {object} args  { pattern, fixed?, path?, glob?, context?, limit? }
   * @returns {Promise<{ matches: number, files: number, text: string, truncated: boolean }>}
   */
  async search({ pattern, fixed = false, path: sub, glob, context = 0, limit } = {}) {
    if (typeof pattern !== 'string' || pattern === '') throw new SourceError('pattern is required')
    if (glob !== undefined && (typeof glob !== 'string' || glob === '' || /[\\/]|\.\./.test(glob) || glob.startsWith('!'))) {
      throw new SourceError('glob is a file-name pattern only (e.g. *Entity*.java): no "/", "\\", ".." or leading "!"')
    }
    const max = clampInt(limit, 50, 1, this.searchLimit)
    const around = clampInt(context, 0, 0, 3)
    const args = ['--no-config', '--no-follow', '--json', '--type', 'java', '--context', String(around)]
    if (fixed) args.push('--fixed-strings')
    if (glob) args.push('--glob', glob)
    args.push('-e', pattern)
    // 总是给搜索路径：不给的话 rg 发现 stdin 不是终端，会去搜 stdin
    args.push(sub !== undefined ? this.resolve(sub, 'search').rel : '.')

    const rg = await this.rgPath()
    const root = this.rootReal()
    const lines = []
    const files = new Set()
    let matches = 0
    let truncated = false
    await new Promise((resolve, reject) => {
      const child = spawn(rg, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => {
        truncated = true
        child.kill()
      }, this.timeoutMs)
      let buffer = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        let cut
        while ((cut = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 1)
          if (truncated) continue
          let event
          try { event = JSON.parse(line) } catch { continue }
          if (event.type !== 'match' && event.type !== 'context') continue
          if (event.type === 'match' && matches >= max) {
            truncated = true
            child.kill()
            continue
          }
          const file = String(event.data.path?.text ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
          const text = String(event.data.lines?.text ?? '').replace(/\r?\n$/, '')
          const shown = text.length > 300 ? `${text.slice(0, 300)}…（这一行共 ${text.length} 字符）` : text
          if (event.type === 'match') {
            matches++
            files.add(file)
          }
          lines.push({ match: event.type === 'match', file, line: event.data.line_number, shown })
        }
      })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new SourceError(`ripgrep failed to start: ${error.message}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        // 0 = 有命中，1 = 没有命中，2 = 出错（如正则写错）；被我们杀掉的 code 为 null
        if (code === 2 && !truncated) reject(new SourceError(`ripgrep: ${stderr.trim().split('\n').slice(0, 3).join(' ')}`))
        else resolve()
      })
    })
    // 截断时去掉最后一处命中之后、属于下一处命中的前置上下文
    const last = lines.findLastIndex((l) => l.match)
    const kept = truncated && last >= 0
      ? lines.filter((l, i) => i <= last || (l.file === lines[last].file && l.line <= lines[last].line + around))
      : lines
    const text = kept.map((l) => `${l.file}${l.match ? ':' : '-'}${l.line}${l.match ? ':' : '-'} ${l.shown}`).join('\n')
    return { matches, files: files.size, text, truncated }
  }
}

/** @vscode/ripgrep 的 rg 可执行文件（DSH 的 dsh-tool-fs-search 依赖它；steveX/package.json 也显式声明了）。 */
export async function resolveRipgrep() {
  try {
    const { rgPath } = await import('@vscode/ripgrep')
    return rgPath
  } catch (error) {
    throw new SourceError(`ripgrep not found (@vscode/ripgrep): ${error.message}`)
  }
}

function inside(root, full) {
  const rel = path.relative(root, full)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function clampInt(value, fallback, min, max) {
  if (!Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}
