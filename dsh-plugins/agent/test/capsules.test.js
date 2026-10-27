import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { Sandbox, SandboxError, CapsuleLibrary, saveCapsule, hashEntry, parseRef } from '../src/capsules/index.js'
import { createDefaultRegistry } from '../src/commands.js'
import { tempDir } from './helpers.js'

// ── 沙箱 ────────────────────────────────────────────────────────────────────

test('沙箱：TS 去类型后运行；params / state 经 JSON 进出', () => {
  const sb = new Sandbox()
  const out = sb.run(`
    interface P { xs: number[] }
    function main(p: P, state: { inventory: { slots: { count: number }[] } }) {
      return { sum: p.xs.reduce((a: number, b: number) => a + b, 0), total: state.inventory.slots.length }
    }`, { xs: [1, 2, 3] }, { state: { inventory: { slots: [{ count: 1 }] } } })
  assert.deepEqual(out, { sum: 6, total: 1 })
})

test('沙箱：没有 require / process / Date / Math.random / eval / new Function / 定时器', () => {
  const sb = new Sandbox()
  const probe = (expr) => sb.run(`function main() { return { v: typeof (${expr}) } }`, {})
  for (const name of ['require', 'process', 'setTimeout', 'fetch', 'Buffer', 'Date', 'WebAssembly']) {
    assert.equal(probe(name).v, 'undefined', name)
  }
  assert.throws(() => sb.run('function main() { return { r: Math.random() } }', {}), /Math.random is not available/)
  assert.throws(() => sb.run('function main() { return { r: eval("1") } }', {}), /Code generation from strings disallowed/)
  assert.throws(() => sb.run('function main() { return { r: new Function("return 1")() } }', {}), /Code generation from strings disallowed/)
})

test('沙箱：模块级状态不会跨调用残留（每次全新 context）', () => {
  const sb = new Sandbox()
  const code = 'let n = 0\nfunction main() { n++; return { n } }'
  assert.deepEqual(sb.run(code, {}), { n: 1 })
  assert.deepEqual(sb.run(code, {}), { n: 1 })
})

test('沙箱：硬超时、异步、语法错误、import、超大返回值都是 SandboxError', () => {
  const sb = new Sandbox({ timeoutMs: 50, maxOutputBytes: 100 })
  assert.throws(() => sb.run('function main() { for (;;) {} }', {}), /exceeded the 50 ms budget/)
  assert.throws(() => sb.run('async function main() { return {} }', {}), /must be synchronous/)
  assert.throws(() => sb.compile('function main( {'), SandboxError)
  assert.throws(() => sb.compile('import fs from "fs"\nfunction main() {}'), /不能用 import/)
  assert.throws(() => sb.run('function notMain() {}', {}), /must define function main/)
  assert.throws(() => sb.run('function main() { return { s: "x".repeat(200) } }', {}), /over 100 bytes/)
})

// ── 胶囊库 ──────────────────────────────────────────────────────────────────

function services(dir) {
  return { library: new CapsuleLibrary({ dir }), sandbox: new Sandbox(), registry: createDefaultRegistry() }
}

const counter = {
  name: 'demo.add',
  description: '加法',
  signature: { inputs: { a: { type: 'number', required: true }, b: { type: 'number', required: true } }, outputs: { sum: { type: 'number' } } },
  body: 'function main(p) { return { sum: p.a + p.b } }'
}

test('胶囊库：保存 → 内容哈希命名 → manifest 记最新版；同内容重复保存不出新版本', () => {
  const dir = tempDir()
  const svc = services(dir)
  const first = saveCapsule(svc, 'code', counter)
  assert.equal(first.ok, true)
  assert.match(first.ref, /^code\/demo\.add@[0-9a-f]{8}$/)
  assert.ok(fs.existsSync(path.join(dir, 'code', `demo.add@${first.hash}.json`)))
  assert.equal(saveCapsule(svc, 'code', counter).created, false)
  assert.equal(saveCapsule(svc, 'code', { ...counter, description: '只改描述' }).hash, first.hash, '描述不进哈希')

  const second = saveCapsule(svc, 'code', { ...counter, body: 'function main(p) { return { sum: p.b + p.a } }' })
  assert.notEqual(second.hash, first.hash)
  assert.equal(svc.library.pin('code/demo.add'), second.ref, '省略 hash = 当前最新版')
  assert.equal(svc.library.get(first.ref).body, counter.body, '旧版本仍然取得到（引用不随库变）')
  assert.deepEqual(svc.library.list().map((r) => r.ref), [second.ref])
})

test('胶囊库：磁盘上被改过的条目拒绝装载；不存在的 hash 是错误、不退回最新版', () => {
  const dir = tempDir()
  const svc = services(dir)
  const { ref, hash } = saveCapsule(svc, 'code', counter)
  const file = path.join(dir, 'code', `demo.add@${hash}.json`)
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'))
  tampered.body = 'function main() { return { sum: 0 } }'
  fs.writeFileSync(file, JSON.stringify(tampered))
  const fresh = new CapsuleLibrary({ dir })
  assert.throws(() => fresh.get(ref), /modified on disk/)
  assert.throws(() => fresh.get('code/demo.add@00000000'), /not found/)
  assert.throws(() => parseRef('code/Demo'), /bad capsule ref/)
  assert.equal(hashEntry({ signature: {}, body: 'x' }), hashEntry({ body: 'x', signature: {}, preconditions: [] }), '哈希与键顺序无关')
})

test('胶囊库：保存时校验——签名、代码能编译、子树能过校验器、子树只能读形参', () => {
  const svc = services(tempDir())
  assert.match(saveCapsule(svc, 'code', { ...counter, signature: { inputs: { a: { type: 'float' } } } }).errors[0], /type must be one of/)
  assert.match(saveCapsule(svc, 'code', { ...counter, body: 'function main( {' }).errors[0], /syntax error/)
  assert.match(saveCapsule(svc, 'code', { ...counter, signature: { returns: 'bool', outputs: { x: { type: 'int' } } } }).errors[0], /cannot also declare outputs/)

  const tree = {
    name: 'demo.press',
    signature: { inputs: { slot: { type: 'int', required: true } }, outputs: { pressed: { type: 'int' } } },
    body: { seq: '按', do: [{ act: 'key/hotbar', params: { slot: '$slot' }, writes: { pressed: '+1' } }] }
  }
  const ok = saveCapsule(svc, 'trees', tree)
  assert.equal(ok.ok, true, ok.errors?.join('\n'))
  assert.equal(svc.library.get(ok.ref).body.id, 'c', '存的是执行格式，根 id = c')

  const leaky = saveCapsule(svc, 'trees', { ...tree, name: 'demo.leaky', body: { act: 'key/hotbar', params: { slot: '$callerKey' } } })
  assert.match(leaky.errors[0], /reads "\$callerKey" but nothing writes/)
  assert.match(saveCapsule(svc, 'trees', { ...tree, name: 'demo.bad', body: { act: 'fly' } }).errors[0], /unknown command "fly"/)
})
