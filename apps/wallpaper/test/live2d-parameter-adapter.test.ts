import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalMotionFrame } from '@rayure/protocol'

import {
  Live2dParameterAdapter,
  STANDARD_LIVE2D_RIG_PROFILE,
  validateLive2dRigProfile,
} from '../src/live2d/rig-profile.ts'

function quaternionFromYaw(degrees: number): [number, number, number, number] {
  const halfRadians = degrees / 2 * Math.PI / 180
  return [0, 0, Math.sin(halfRadians), Math.cos(halfRadians)]
}

function makeFrame(): CanonicalMotionFrame {
  return {
    timeMs: 0,
    rootPosition: [0, 0, 0],
    rootRotation: quaternionFromYaw(45),
    joints: {
      head: { position: [0, 1.8, 0], rotation: quaternionFromYaw(20) },
      left_shoulder: { position: [-0.2, 1.4, 0], rotation: [0, 0, 0, 1] },
      left_elbow: { position: [-0.8, 1.4, 0], rotation: [0, 0, 0, 1] },
      left_wrist: { position: [-0.8, 0.8, 0], rotation: [0, 0, 0, 1] },
      right_shoulder: { position: [0.2, 1.4, 0], rotation: [0, 0, 0, 1] },
      right_elbow: { position: [0.8, 1.4, 0], rotation: [0, 0, 0, 1] },
      right_wrist: { position: [0.8, 2, 0], rotation: [0, 0, 0, 1] },
    },
  }
}

test('Live2D adapter maps body, head and arm controls into standard parameters', () => {
  const adapter = new Live2dParameterAdapter(STANDARD_LIVE2D_RIG_PROFILE)
  const updates = adapter.mapFrame(makeFrame())
  const values = new Map(updates.map(update => [update.parameterId, update.value]))

  assert.ok(Math.abs((values.get('ParamAngleX') ?? 0) - 20) < 1e-9)
  assert.ok(Math.abs((values.get('ParamBodyAngleX') ?? 0) - 10) < 1e-9)
  assert.equal(values.get('ParamArmLA'), 90)
  assert.equal(values.get('ParamArmLB'), 90)
  assert.equal(values.get('ParamArmRA'), 0)
  assert.equal(values.get('ParamArmRB'), 90)
})

test('Live2D adapter clamps mapped controls and applies them to a parameter sink', () => {
  const adapter = new Live2dParameterAdapter({
    ...STANDARD_LIVE2D_RIG_PROFILE,
    parameters: [{ parameterId: 'CustomHead', control: 'headYaw', min: -5, max: 5, neutral: 0 }],
  })
  const received: Array<[string, number]> = []
  adapter.applyFrame(makeFrame(), { setParameterValue: (id, value) => received.push([id, value]) })
  assert.deepEqual(received, [['CustomHead', 5]])
})

test('Live2D adapter skips controls whose calibrated joints are absent', () => {
  const frame = makeFrame()
  const joints = { ...frame.joints }
  delete joints.left_wrist
  const incompleteFrame = { ...frame, joints }
  const adapter = new Live2dParameterAdapter(STANDARD_LIVE2D_RIG_PROFILE)
  const ids = adapter.mapFrame(incompleteFrame).map(update => update.parameterId)
  assert.ok(!ids.includes('ParamArmLB'))
  assert.ok(ids.includes('ParamAngleX'))
})

test('Live2D adapter maps alternating lower-body bend into Hiyori ParamLeg', () => {
  const frame = makeFrame()
  const walkingFrame: CanonicalMotionFrame = {
    ...frame,
    joints: {
      ...frame.joints,
      left_hip: { position: [-0.2, 1, 0], rotation: [0, 0, 0, 1] },
      left_knee: { position: [-0.2, 0.5, 0], rotation: [0, 0, 0, 1] },
      left_ankle: { position: [-0.2, 0, 0], rotation: [0, 0, 0, 1] },
      right_hip: { position: [0.2, 1, 0], rotation: [0, 0, 0, 1] },
      right_knee: { position: [0.2, 0.5, 0], rotation: [0, 0, 0, 1] },
      right_ankle: { position: [0.7, 0.5, 0], rotation: [0, 0, 0, 1] },
    },
  }
  const values = new Map(new Live2dParameterAdapter().mapFrame(walkingFrame).map(update => [update.parameterId, update.value]))
  assert.equal(values.get('ParamLeg'), 1)
})

test('Live2D rig profiles reject duplicate parameters and invalid ranges', () => {
  assert.throws(() => validateLive2dRigProfile({
    ...STANDARD_LIVE2D_RIG_PROFILE,
    parameters: [
      { parameterId: 'Duplicate', control: 'headYaw', min: -1, max: 1, neutral: 0 },
      { parameterId: 'Duplicate', control: 'headPitch', min: -1, max: 1, neutral: 0 },
    ],
  }), /Duplicate/i)
  assert.throws(() => validateLive2dRigProfile({
    ...STANDARD_LIVE2D_RIG_PROFILE,
    parameters: [{ parameterId: 'Invalid', control: 'headYaw', min: 2, max: 1, neutral: 0 }],
  }), /range/i)
})
