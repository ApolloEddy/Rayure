import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createLive2dDebugMotion,
  Live2dDebugProbe,
} from '../src/live2d/debug-probe.ts'

test('Live2D debug probe exercises the parameter path without claiming a native model', () => {
  const snapshots = [] as Array<ReturnType<Live2dDebugProbe['snapshot']>>
  const probe = new Live2dDebugProbe({ onSnapshot: snapshot => snapshots.push(snapshot) })
  probe.bind(createLive2dDebugMotion())

  assert.equal(probe.advance(0), true)
  const initial = probe.snapshot()
  assert.equal(initial.mode, 'parameter-probe')
  assert.equal(initial.nativeModelLoaded, false)
  assert.equal(initial.parameters.ParamAngleX, 0)

  assert.equal(probe.advance(0.7), true)
  assert.equal(probe.snapshot().parameters.ParamAngleX, 14)
  assert.ok(snapshots.length >= 2)
  probe.dispose()
  assert.equal(probe.advance(1), false)
})

test('Live2D debug probe loops a fixture and ignores non-finite values', () => {
  const probe = new Live2dDebugProbe()
  const motion = createLive2dDebugMotion()
  probe.bind(motion)
  probe.setParameterValue('Custom', Number.NaN)
  assert.equal(probe.snapshot().parameters.Custom, undefined)

  probe.advance(2, motion)
  probe.advance(0, motion)
  assert.equal(probe.snapshot().parameters.ParamAngleX, 0)
})
