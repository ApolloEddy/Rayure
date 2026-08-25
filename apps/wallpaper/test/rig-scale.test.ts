import assert from 'node:assert/strict'
import test from 'node:test'

import { detectRigPositionScale, scaleCanonicalFrame } from '../src/ardy3d/rig-scale.ts'
import type { CanonicalMotionFrame } from '@rayure/protocol'

test('detectRigPositionScale tells meters (CoreSkin) from centimeters (PMX/MMD)', () => {
  // ARDY mannequin: hips ≈ 0.97m.
  assert.equal(detectRigPositionScale(0.9696), 1)
  // MMD model: hips ≈ 97cm.
  assert.equal(detectRigPositionScale(97.2), 100)
  assert.equal(detectRigPositionScale(-97.2), 100)
  // Unknown / NaN defaults to no scaling.
  assert.equal(detectRigPositionScale(Number.NaN), 1)
})

test('detectRigPositionScale scales small non-MMD rigs continuously', () => {
  // albedo.pmx is ~22 units tall with bind hips ≈ 12: the old {1, 100} bucket
  // would classify it as "centimeters" and drive the figure 8× too large, off
  // the camera's bind-pose frame.  The ratio must land on ≈12 instead.
  assert.equal(detectRigPositionScale(12), 12)
  assert.equal(detectRigPositionScale(12.4), 13)
  // A hips height of ~0 (bind world matrix not yet composed) falls back to 1,
  // never collapsing to scale 0.
  assert.equal(detectRigPositionScale(0), 1)
})

test('scaleCanonicalFrame multiplies positions, leaves rotations and metadata alone', () => {
  const frame: CanonicalMotionFrame = {
    timeMs: 50,
    rootPosition: [0, 0.97, 0],
    rootRotation: [0, 0, 0, 1],
    joints: {
      hips: { position: [0, 0.97, 0], rotation: [0, 0, 0, 1] },
      head: { position: [0, 1.62, 0.05], rotation: [0.1, 0, 0, 0.99] },
    },
    footContacts: ['left', 'right'],
  }

  const scaled = scaleCanonicalFrame(frame, 100)
  assert.notEqual(scaled, frame) // scaled copy
  assert.deepEqual(scaled.joints.hips?.position, [0, 97, 0])
  assert.deepEqual(scaled.joints.head?.position, [0, 162, 5])
  assert.deepEqual(scaled.joints.head?.rotation, frame.joints.head?.rotation)
  assert.equal(scaled.timeMs, 50)
  assert.deepEqual(scaled.rootPosition, frame.rootPosition)
  assert.deepEqual(scaled.footContacts, frame.footContacts)

  // Scale 1 is a pass-through of the same object reference (no allocation).
  assert.equal(scaleCanonicalFrame(frame, 1), frame)
})
