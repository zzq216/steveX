import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SourceTree, FactStore, shaOf } from '../src/facts/index.js'
import { factTools } from '../src/tools/facts.js'
import { FactTurns } from '../src/llm/fact_turns.js'
import { loadPrompts } from '../src/llm/prompts.js'
import { tempDir } from './helpers.js'

const prompts = loadPrompts(fileURLToPath(new URL('../prompts', import.meta.url)))

/** 假的源码基准：base/src 是基准，base/secret.txt、base/outside/ 在基准外面。 */
function fakeBaseline() {
  const base = tempDir('stevex-src-')
  const root = path.join(base, 'src')
  const entity = path.join(root, 'net', 'minecraft', 'world', 'entity')
  fs.mkdirSync(entity, { recursive: true })
  const lines = Array.from({ length: 120 }, (_, i) => `\t// line ${i + 1}`)
  lines[9] = '\tpublic boolean isInLava() {'
  lines[10] = '\t\treturn this.wasTouchingLava;'
  lines[11] = '\t}'
  fs.writeFileSync(path.join(entity, 'Entity.java'), lines.join('\r\n'))
  fs.writeFileSync(path.join(entity, 'Mob.java'), 'class Mob {\n  void tick() { if (isInLava()) burn(); }\n}\n')
  fs.mkdirSync(path.join(root, 'META-INF'))
  fs.writeFileSync(path.join(root, 'META-INF', 'MANIFEST.MF'), 'Manifest-Version: 1.0\n')
  fs.writeFileSync(path.join(base, 'secret.txt'), 'API_KEY=sk-123\n')
  fs.mkdirSync(path.join(base, 'outside'))
  fs.writeFileSync(path.join(base, 'outside', 'Leak.java'), 'class Leak { String key = "sk-123"; }\n')
  return { base, root }
}

test('源码读取边界（P5-D9）：绝对路径、盘符、UNC、..、跳出基准的链接、非 .java 一律拒绝', () => {
  const { base, root } = fakeBaseline()
  const source = new SourceTree({ root })
  const rejected = [
    ['../secret.txt', /"\.\." is not allowed/],
    ['net/../../secret.txt', /"\.\." is not allowed/],
    ['..\\outside\\Leak.java', /"\.\." is not allowed/],
    [path.join(base, 'secret.txt'), /absolute paths/],
    ['C:/Windows/win.ini', /absolute paths/],
    ['\\\\server\\share\\x.java', /absolute paths/],
    ['/etc/passwd', /absolute paths/],
    ['META-INF/MANIFEST.MF', /only \.java files/],
    ['net/minecraft', /only \.java files/],
    ['net/x\0.java', /non-empty relative path/],
    ['', /non-empty relative path/],
    ['net/minecraft/Nope.java', /no such file/]
  ]
  for (const [file, pattern] of rejected) assert.throws(() => source.read({ file }), pattern, file)

  // 目录联接（Windows 不用管理员权限）指到基准外面：realpath 之后不在基准里
  let linked = false
  try {
    fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'net', 'link'), 'junction')
    linked = true
  } catch {
    // 建不了链接的环境跳过这一条
  }
  if (linked) {
    assert.throws(() => source.read({ file: 'net/link/Leak.java' }), /outside the source baseline/)
    assert.throws(() => source.resolve('net/link', 'dir'), /outside the source baseline/)
  }

  const ok = source.read({ file: 'net\\minecraft\\world\\entity\\Entity.java', start: 10, end: 12 })
  assert.equal(ok.file, 'net/minecraft/world/entity/Entity.java', '反斜杠也认，返回 / 分隔的相对路径')
  assert.equal(ok.total, 120)
  assert.match(ok.text, /^10 \| \tpublic boolean isInLava\(\) \{\n11 \| /)
  assert.doesNotMatch(ok.text, /\r/)
  const capped = new SourceTree({ root, readMaxLines: 50 }).read({ file: 'net/minecraft/world/entity/Entity.java', start: 1, end: 120 })
  assert.equal(capped.end, 50)
  assert.equal(capped.truncated, true)
  assert.throws(() => source.read({ file: 'net/minecraft/world/entity/Entity.java', start: 500 }), /has 120 lines/)
})

test('mc_source_search：ripgrep 只搜基准里的 .java；路径 / 上下文 / 截断；正则写错报错；glob 不能带路径', async () => {
  const { root } = fakeBaseline()
  const source = new SourceTree({ root })
  const all = await source.search({ pattern: 'isInLava', fixed: true })
  assert.equal(all.matches, 2)
  assert.equal(all.files, 2)
  assert.match(all.text, /^net\/minecraft\/world\/entity\/(Entity|Mob)\.java:\d+: /m)
  assert.doesNotMatch(all.text, /sk-123|Leak/, '基准外的文件搜不到')

  const scoped = await source.search({ pattern: 'wasTouching\\w+', path: 'net/minecraft/world/entity', glob: 'Ent*.java', context: 1 })
  assert.equal(scoped.matches, 1)
  assert.match(scoped.text, /Entity\.java-10- \tpublic boolean isInLava[\s\S]*Entity\.java:11: /)

  const limited = await source.search({ pattern: 'line \\d+', limit: 3 })
  assert.equal(limited.matches, 3)
  assert.equal(limited.truncated, true)

  await assert.rejects(source.search({ pattern: '(' }), /ripgrep: .*regex parse error/)
  await assert.rejects(source.search({ pattern: 'x', glob: '../*.java' }), /file-name pattern only/)
  await assert.rejects(source.search({ pattern: 'x', path: '../outside' }), /"\.\." is not allowed/)
  const oneFile = await source.search({ pattern: 'isInLava', fixed: true, path: 'net/minecraft/world/entity/Mob.java' })
  assert.equal(oneFile.matches, 1, 'path 可以是单个 .java 文件')
  assert.match(oneFile.text, /^net\/minecraft\/world\/entity\/Mob\.java:2: /)
  await assert.rejects(source.search({ pattern: 'x', path: 'META-INF/MANIFEST.MF' }), /only directories and \.java files/)
})

test('事实库（P5-D3 / D4 / D6）：引用校验、写入带哈希、同名要 replaces、旧版进 history、相近事实', () => {
  const { root } = fakeBaseline()
  const dir = tempDir('stevex-facts-')
  const store = new FactStore({ dir, source: new SourceTree({ root }), maxRefLines: 80, maxRefs: 5 })
  const ref = { file: 'net/minecraft/world/entity/Entity.java', lines: [10, 12] }

  const bad = store.write({ name: 'Lava Fact', statement: '', refs: [] })
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join('\n'), /name must match/)
  assert.match(bad.errors.join('\n'), /statement is required/)
  assert.match(bad.errors.join('\n'), /refs is required/)
  const refErrors = store.write({ name: 'x', statement: 's', refs: [
    { file: '../secret.txt', lines: [1, 1] },
    { file: ref.file, lines: [1, 81] },
    { file: ref.file, lines: [119, 121] },
    { file: ref.file, lines: [5, 3] }
  ] }).errors.join('\n')
  assert.match(refErrors, /refs\[0\]: .*"\.\." is not allowed/)
  assert.match(refErrors, /refs\[1\]: 81 lines/)
  assert.match(refErrors, /refs\[2\]: .* has 120 lines/)
  assert.match(refErrors, /refs\[3\]\.lines must be/)
  assert.match(store.write({ name: 'x', statement: 's', refs: Array(6).fill(ref) }).errors[0], /at most 5/)
  assert.equal(fs.readdirSync(dir).length, 0, '没写任何文件')

  const first = store.write({ name: 'entity.in-lava', statement: '实体是否在岩浆里取 wasTouchingLava', refs: [ref], tags: ['lava'] }, { kind: 'fact-check', sessionId: 's1', taskId: null })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.created, true)
  assert.equal(first.fact.rev, 1)
  const fileLines = fs.readFileSync(path.join(root, ref.file), 'utf8').split('\r\n')
  assert.equal(first.fact.refs[0].sha, shaOf(fileLines, 10, 12), '哈希由工具算')
  assert.deepEqual(first.fact.source, { kind: 'fact-check', sessionId: 's1' }, 'null 字段不落盘')

  const dup = store.write({ name: 'entity.in-lava', statement: '换个说法', refs: [ref] })
  assert.equal(dup.ok, false)
  assert.match(dup.errors[0], /already exists \(rev 1\): "实体是否在岩浆里取 wasTouchingLava".*replaces: 1/)
  assert.match(store.write({ name: 'entity.in-lava', statement: 's', refs: [ref], replaces: 7 }).errors[0], /not the current rev/)
  assert.match(store.write({ name: 'nope', statement: 's', refs: [ref], replaces: 1 }).errors[0], /no fact named nope/)

  const revised = store.write({ name: 'entity.in-lava', statement: '实体在岩浆里 = wasTouchingLava 为真', refs: [ref], replaces: 1 })
  assert.equal(revised.ok, true)
  assert.equal(revised.fact.rev, 2)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'history', 'entity.in-lava@1.json'), 'utf8')).rev, 1, '旧版原样留着')

  const other = store.write({ name: 'mob.burns-in-lava', statement: 'Mob 在岩浆里每 tick 燃烧', refs: [{ file: 'net/minecraft/world/entity/Mob.java', lines: [2, 2] }] })
  assert.deepEqual(other.similar.map((f) => f.name), ['entity.in-lava'], '写入后附相近的已有事实')
})

test('fact_search（P5-D7）：多词任一命中、按命中数排序、标签过滤；引用失效标 stale；check 列出失效的', () => {
  const { root } = fakeBaseline()
  const store = new FactStore({ dir: tempDir('stevex-facts-'), source: new SourceTree({ root }) })
  store.write({ name: 'entity.in-lava', statement: '在岩浆里 lava', refs: [{ file: 'net/minecraft/world/entity/Entity.java', lines: [10, 12] }], tags: ['lava'] })
  store.write({ name: 'mob.burn', statement: 'Mob 着火 lava burn', refs: [{ file: 'net/minecraft/world/entity/Mob.java', lines: [2, 2] }] })
  assert.deepEqual(store.search({ query: 'lava burn' }).facts.map((f) => f.name), ['mob.burn', 'entity.in-lava'])
  assert.deepEqual(store.search({ query: 'lava', tags: ['lava'] }).facts.map((f) => f.name), ['entity.in-lava'])
  assert.equal(store.search({ query: '水' }).total, 0)
  assert.equal(store.search().total, 2)
  assert.equal(store.search().facts[0].refs[0].sha, undefined, '只给文件与行号')
  assert.deepEqual(store.check(), [])

  fs.writeFileSync(path.join(root, 'net/minecraft/world/entity/Mob.java'), 'class Mob {\n  void tick() { if (isInWater()) swim(); }\n}\n')
  assert.deepEqual(store.check(), [{ name: 'mob.burn', file: 'net/minecraft/world/entity/Mob.java', lines: [2, 2], status: 'content changed' }])
  assert.equal(store.search({ query: 'burn' }).facts[0].refs[0].stale, 'content changed')
})

test('工具：fact_write 的 source 由适配层填；mc_source_* 记账；越界的读取返回错误而不是抛出', async () => {
  const { root } = fakeBaseline()
  const source = new SourceTree({ root })
  const store = new FactStore({ dir: tempDir('stevex-facts-'), source })
  const notes = []
  const tools = Object.fromEntries(factTools({
    facts: { store, source }, maxOutputChars: 20000,
    factTurns: { note: (sessionId, kind) => notes.push([sessionId, kind]), source: () => ({ kind: 'plan', taskId: 't1', requestId: 'p1' }) }
  }).map((t) => [t.name, t]))
  const exec = { agent: { id: 's1' } }
  const render = (name, args, value) => tools[name].output.render(args, value)[0].text

  const read = await tools.mc_source_read.execute({ file: '../secret.txt' }, exec)
  assert.equal(read.ok, false)
  assert.match(render('mc_source_read', {}, read), /读取失败：.*"\.\." is not allowed/)
  const found = await tools.mc_source_search.execute({ pattern: 'isInLava', fixed: true }, exec)
  assert.match(render('mc_source_search', {}, found), /^2 处命中，2 个文件/)
  assert.deepEqual(notes, [['s1', 'source'], ['s1', 'source']])

  const failed = await tools.fact_write.execute({ name: 'x', statement: 's', refs: [] }, exec)
  assert.equal(failed.ok, false)
  assert.equal(notes.length, 2, '没写成不算写过事实')
  const wrote = await tools.fact_write.execute({ name: 'entity.in-lava', statement: '在岩浆里', refs: [{ file: 'net/minecraft/world/entity/Entity.java', lines: [10, 12] }] }, exec)
  assert.equal(wrote.ok, true)
  assert.deepEqual(wrote.fact.source, { kind: 'plan', taskId: 't1', requestId: 'p1', sessionId: 's1' })
  assert.deepEqual(notes.at(-1), ['s1', 'write'])
  assert.match(render('fact_write', {}, wrote), /已写入：entity\.in-lava/)
  const searched = await tools.fact_search.execute({ query: '岩浆' }, exec)
  assert.equal(searched.facts[0].name, 'entity.in-lava')
})

test('FactTurns（P5 §2 / §7）：/bt fact 开回合并绑定工具；查了源码没写事实提醒一次；写了不提醒；回合结束清账', () => {
  const delivered = []
  const bound = []
  const turns = new FactTurns({
    prompts, tools: ['fact_search', 'fact_write'],
    deliver: (sessionId, message) => { delivered.push({ sessionId, ...message }); return true },
    onBind: (sessionId, turn, tools) => bound.push({ sessionId, turn, tools }),
    describe: () => ({ kind: 'expand', taskId: 't1', requestId: 'r3' })
  })
  assert.equal(turns.start({ sessionId: 's1', statement: '  ' }).ok, false)
  assert.equal(turns.start({ sessionId: 's1', statement: '岩浆会点燃玩家' }).ok, true)
  assert.match(delivered[0].text, /> 岩浆会点燃玩家[\s\S]*skill：事实确认/)
  assert.deepEqual(delivered[0].source, { kind: 'stevex-fact', factCheckId: 'f1', reason: 'fact-check' })

  turns.onPreStep({ sessionId: 's1', turn: 4, step: 1, messages: [{ source: delivered[0].source }] })
  assert.deepEqual(bound, [{ sessionId: 's1', turn: 4, tools: ['fact_search', 'fact_write'] }])
  assert.deepEqual(turns.source('s1'), { kind: 'fact-check' })
  assert.equal(turns.onTurnStopping({ sessionId: 's1', turn: 4 }), null, '没查源码不提醒')
  turns.note('s1', 'source')
  const steer = turns.onTurnStopping({ sessionId: 's1', turn: 4 })
  assert.match(steer.text, /本回合查阅了 MC 源码[\s\S]*skill：完善事实库/)
  assert.equal(turns.onTurnStopping({ sessionId: 's1', turn: 4 }), null, '每回合只提醒一次')
  turns.endTurn('s1', 4)

  turns.onPreStep({ sessionId: 's1', turn: 5, step: 1, messages: [{ source: { kind: 'stevex-bt', requestId: 'r3' } }] })
  assert.deepEqual(turns.source('s1'), { kind: 'expand', taskId: 't1', requestId: 'r3' }, '别的回合按请求填来源')
  turns.note('s1', 'source')
  turns.note('s1', 'write')
  assert.equal(turns.onTurnStopping({ sessionId: 's1', turn: 5 }), null, '写了事实不提醒')
  assert.equal(bound.length, 1, '不是事实确认的回合不绑定')
})
