import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { CapsuleLibrary } from '../src/capsules/library.js'
import { applyRename, planRename, replaceNames } from '../src/capsules/rename.js'
import { tempDir } from './helpers.js'

const cond = (name, body, description = name) => ({ name, description, signature: { inputs: {}, returns: 'bool' }, body })
const tree = (name, refs, description = name) => ({
  name, description, signature: { inputs: {} },
  body: { type: 'Sequence', id: 'c', mode: 'memory', children: refs.map((ref, i) => ({ type: 'Condition', id: `c.${i + 1}`, ref, params: {} })) }
})
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

test('胶囊改名（2026-11-21）：同一哈希搬到新名字下、旧名字下架；引用它的子树一路往上换版本；说明、版本记录、统计、已知问题跟着走', () => {
  const dir = tempDir('stevex-rename-')
  const library = new CapsuleLibrary({ dir })
  const v1 = library.write('code', cond('old-cond', 'function main() { return false }')).ref
  const v2 = library.write('code', cond('old-cond', 'function main() { return true }', '条件：总是真；旧版见 code/old-cond-extra 以外')).ref
  const keep = library.write('code', cond('inv.keep', 'function main() { return true }', '和 code/old-cond 一起用；不要和 code/old-cond-x 混')).ref
  const inner = library.write('trees', tree('craft.inner', [v2, keep])).ref
  const outer = library.write('trees', tree('craft.outer', [inner], '外层，调用 trees/craft.inner')).ref
  const h2 = v2.split('@')[1]
  fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({ version: 1, tasks: [], refs: { [v2]: { calls: 3 }, [inner]: { calls: 2 } } }))
  fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ version: 1, issues: { 'code/old-cond': [{ id: 'i1', hash: h2, problem: 'p' }] } }))
  library.versions.record('code/old-cond', h2, { parent: v1.split('@')[1], note: { change: '改成总是真', none: '修错', claims: [] } })

  const renames = { 'code/old-cond': 'code/inv.always-true', 'trees/craft.inner': 'trees/craft.inner-step' }
  assert.match(planRename({ dir, renames: { 'code/old-cond': 'code/bad-name' } }).errors[0], /must read "<domain>\.<what-it-does>"/)
  assert.match(planRename({ dir, renames: { 'code/nope': 'code/inv.x' } }).errors[0], /no such capsule/)
  assert.match(planRename({ dir, renames: { 'code/old-cond': 'code/inv.keep' } }).errors[0], /already exists/)

  const { errors, plan } = planRename({ dir, renames, by: 'test' })
  assert.deepEqual(errors, [])
  applyRename(plan)
  const after = new CapsuleLibrary({ dir })
  const manifest = readJson(path.join(dir, 'manifest.json'))

  // 代码：两个版本都按同一哈希搬到新名字下；旧名字下架、取代者是新名字；旧引用照常能装载
  assert.equal(after.pin('code/inv.always-true'), `code/inv.always-true@${h2}`)
  assert.ok(after.get(`code/inv.always-true@${v1.split('@')[1]}`), '旧版本也搬过去了')
  assert.equal(manifest['code/old-cond'].retired.supersededBy, 'code/inv.always-true')
  assert.ok(after.get(v2), '带哈希的旧引用照常装载')

  // 子树：inner 改名且引用换了 → 新哈希；outer 只因 inner 换了版本 → 同名新版本，引用指向 inner 的新名字新版本
  const innerNow = after.pin('trees/craft.inner-step')
  assert.notEqual(innerNow.split('@')[1], inner.split('@')[1])
  assert.deepEqual(after.get(innerNow).body.children.map((c) => c.ref), [`code/inv.always-true@${h2}`, keep])
  const outerNow = after.pin('trees/craft.outer')
  assert.notEqual(outerNow, outer)
  assert.deepEqual(after.get(outerNow).body.children.map((c) => c.ref), [innerNow])
  assert.ok(after.get(outer), '旧版子树照常装载')
  assert.equal(manifest['trees/craft.inner'].retired.supersededBy, 'trees/craft.inner-step')
  // savedAt（整理范围方案 R2）：新名字、换了版本的子树记迁移时刻，下一次整理会看到
  for (const key of ['code/inv.always-true', 'trees/craft.inner-step', 'trees/craft.outer']) assert.equal(manifest[key].savedAt, plan.at, key)

  // 说明：带前缀的旧名字换掉，前缀相同的别的名字不动
  assert.equal(manifest['code/inv.keep'].description, '和 code/inv.always-true 一起用；不要和 code/old-cond-x 混')
  assert.equal(after.get(keep).description, manifest['code/inv.keep'].description, '条目文件里的说明也改了，哈希不变')
  assert.equal(manifest['trees/craft.outer'].description, '外层，调用 trees/craft.inner-step')

  // 版本记录、统计、已知问题
  const versions = readJson(path.join(dir, 'versions.json')).entries
  assert.equal(versions['code/inv.always-true'][h2].change, '改成总是真')
  assert.equal(versions['trees/craft.outer'][outerNow.split('@')[1]].parent, outer.split('@')[1])
  const stats = readJson(path.join(dir, 'stats.json')).refs
  assert.deepEqual(stats[`code/inv.always-true@${h2}`], { calls: 3 })
  assert.deepEqual(stats[innerNow], { calls: 2 }, '子树的新版本抄上一版的统计')
  const notes = readJson(path.join(dir, 'notes.json')).issues
  assert.deepEqual([notes['code/old-cond'], notes['code/inv.always-true'][0].id], [undefined, 'i1'])
})

test('replaceNames：只换带文件夹前缀的完整名字', () => {
  const renames = { 'code/a.b': 'code/x.y' }
  assert.equal(replaceNames('用 code/a.b、code/a.b@1234、code/a.b-c 和 code/a.bc。结尾 code/a.b.', renames), '用 code/x.y、code/x.y@1234、code/a.b-c 和 code/a.bc。结尾 code/x.y.')
})
