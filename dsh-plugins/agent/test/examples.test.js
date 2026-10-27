import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { compileTree, validateTree, pinRefs } from '../src/bt/index.js'
import { saveCapsule } from '../src/capsules/index.js'
import { makeRuntime } from './helpers.js'

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8'))

function check(tree, kind = 'task', extraCapsules = []) {
  const { library, sandbox, registry } = makeRuntime()
  for (const name of extraCapsules) {
    const { folder, ...entry } = read(name)
    const saved = saveCapsule({ library, sandbox, registry }, folder, entry)
    assert.equal(saved.ok, true, saved.errors?.join('\n'))
  }
  const { spec, errors } = pinRefs(compileTree(tree, { kind, rootId: kind === 'fast' ? 'f' : 'n1' }), library)
  assert.deepEqual(errors, [])
  return validateTree(spec, { registry, library, kind }).errors
}

for (const name of ['walk_loop.json', 'recipe_query.json']) {
  test(`示例任务树 ${name} 能编译并通过校验`, () => {
    assert.deepEqual(check(read(name).root), [])
  })
}

test('示例快树 fast_drowning.json（配示例条件代码）能编译并通过快树校验', () => {
  assert.deepEqual(check(read('fast_drowning.json'), 'fast', ['capsules/example.air-below.json']), [])
})
