import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createParameterCrossfade,
  sampleParameterCrossfade,
} from '../src/live2d/parameter-crossfade.ts'

test('parameter crossfade interpolates from the captured pose to the new target', () => {
  const crossfade = createParameterCrossfade(new Map([['ParamAngleX', -20]]), 100, 200)
  assert.ok(crossfade)
  assert.deepEqual(sampleParameterCrossfade(crossfade, 'ParamAngleX', 20, 100), { value: -20, done: false })
  assert.deepEqual(sampleParameterCrossfade(crossfade, 'ParamAngleX', 20, 200), { value: 0, done: false })
  assert.deepEqual(sampleParameterCrossfade(crossfade, 'ParamAngleX', 20, 350), { value: 20, done: true })
})

test('parameter crossfade uses the target for uncaptured parameters and rejects invalid durations', () => {
  assert.equal(createParameterCrossfade(new Map(), 0, 0), undefined)
  assert.equal(createParameterCrossfade(new Map(), Number.NaN, 100), undefined)
  const crossfade = createParameterCrossfade(new Map(), 0, 100)
  assert.ok(crossfade)
  assert.deepEqual(sampleParameterCrossfade(crossfade, 'ParamUnknown', 0.7, 50), { value: 0.7, done: false })
  assert.deepEqual(sampleParameterCrossfade(crossfade, 'ParamUnknown', 0.7, 100), { value: 0.7, done: true })
})
