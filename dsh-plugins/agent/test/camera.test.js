import test from 'node:test'
import assert from 'node:assert/strict'

import { GameState, CAMERA_METHODS, DEFAULT_CAMERA } from '../src/game/state.js'
import { CommandRegistry } from '../src/game/registry.js'
import { registerRawCommands } from '../src/game/raw_commands.js'
import { normalizeConfig } from '../src/config.js'

/** 视角平滑转动设计方案 S5：转法由配置决定，agent 改不了，切换不改变 agent 看到的东西 */

function recordingMod() {
  const calls = []
  return { calls, mod: { async call(method, params) { calls.push([method, params]); return { ok: true, data: { status: 'ok' } } } } }
}

test('camera mode: every camera call made through the command environment carries the configured instant / speed; other methods are untouched', async () => {
  for (const camera of [{ instant: false, speed: 360 }, { instant: true, speed: 720 }]) {
    const { calls, mod } = recordingMod()
    const env = new GameState({ mod, camera }).env()
    await env.must('camera/turn', { dx: 90, dy: -10 })
    await env.call('camera/look-at', { x: 1, y: 2, z: 3 })
    await env.must('key/use', { pressed: true })
    assert.deepEqual(calls, [
      ['camera/turn', { dx: 90, dy: -10, ...camera }],
      ['camera/look-at', { x: 1, y: 2, z: 3, ...camera }],
      ['key/use', { pressed: true }]
    ])
  }
  // 不给配置时按缺省（平滑，360 度/秒）
  const { calls, mod } = recordingMod()
  await new GameState({ mod }).env().must('camera/turn', { dx: 1 })
  assert.deepEqual(calls[0][1], { dx: 1, ...DEFAULT_CAMERA })
  assert.deepEqual(DEFAULT_CAMERA, { instant: false, speed: 360 })
})

test('camera mode: the agent cannot set instant / speed — the call is rejected before reaching the mod, and the raw command schema does not offer them', async () => {
  const { calls, mod } = recordingMod()
  const env = new GameState({ mod, camera: { instant: false, speed: 360 } }).env()
  await assert.rejects(env.must('camera/turn', { dx: 10, instant: true }), /camera\/turn: instant 由配置决定，调用里不能写/)
  await assert.rejects(env.call('camera/look-at', { x: 0, y: 0, z: 0, speed: 3600 }), /speed 由配置决定/)
  await assert.rejects(env.must('camera/look-at', { x: 0, y: 0, z: 0, instant: false, speed: 360 }), /instant、speed 由配置决定/)
  assert.equal(calls.length, 0)

  const registry = new CommandRegistry()
  registerRawCommands(registry)
  for (const method of CAMERA_METHODS) {
    const params = registry.get(method).params
    assert.equal('instant' in params, false, method)
    assert.equal('speed' in params, false, method)
  }
  assert.deepEqual(Object.keys(registry.get('camera/turn').params), ['dx', 'dy'])
  assert.deepEqual(Object.keys(registry.get('camera/look-at').params), ['x', 'y', 'z'])
  // 说明文字两种转法都一样，切换开关不改变 agent 看到的东西
  assert.doesNotMatch(registry.get('camera/turn').description, /平滑|瞬间|instant|speed/)
})

test('camera mode: config defaults and checks', () => {
  assert.deepEqual(normalizeConfig({}).camera, { instant: false, speed: 360 })
  assert.deepEqual(normalizeConfig({ camera: { instant: true } }).camera, { instant: true, speed: 360 })
  assert.throws(() => normalizeConfig({ camera: { instant: 'yes' } }), /camera\.instant must be true or false/)
  for (const speed of [0, 29, 3601, '360']) assert.throws(() => normalizeConfig({ camera: { speed } }), /camera\.speed must be a number within 30-3600/, String(speed))
})
