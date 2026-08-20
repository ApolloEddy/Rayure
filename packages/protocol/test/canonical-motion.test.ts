import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CANONICAL_MOTION_JOINT_COUNT,
  CanonicalMotionValidationError,
  createCanonicalMotion,
  validateCanonicalMotion,
} from '../src/canonical-motion.ts'

const jointNames = Array.from({ length: CANONICAL_MOTION_JOINT_COUNT }, (_, index) => `joint-${index}`)

function makeMotion() {
  const rootPosition: [number, number, number] = [0, 0, 0]
  const rootRotation: [number, number, number, number] = [0, 0, 0, 1]
  const joints = Object.fromEntries(jointNames.map((name, index) => [name, {
    position: [index / 10, 1, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
  }]))
  return {
    schema: 'rayure.motion.v1' as const,
    backend: 'fixture',
    jointSetId: 'ardy-core-27' as const,
    jointNames,
    fps: 20,
    frames: [
      {
        timeMs: 0,
        rootPosition,
        rootRotation,
        joints,
        footContacts: ['joint-0'],
      },
      {
        timeMs: 50,
        rootPosition,
        rootRotation,
        joints,
      },
    ],
  }
}

test('Canonical Motion v1 accepts a complete 27-joint fixture', () => {
  const motion = createCanonicalMotion(makeMotion())
  assert.equal(motion.frames.length, 2)
  assert.doesNotThrow(() => validateCanonicalMotion(motion))
})

test('Canonical Motion v1 rejects incomplete or duplicate joint definitions', () => {
  const incomplete = makeMotion()
  incomplete.jointNames = incomplete.jointNames.slice(0, -1)
  assert.throws(() => validateCanonicalMotion(incomplete), CanonicalMotionValidationError)

  const duplicate = makeMotion()
  duplicate.jointNames = [...duplicate.jointNames.slice(0, -1), duplicate.jointNames[0] as string]
  assert.throws(() => validateCanonicalMotion(duplicate), /duplicates/i)
})

test('Canonical Motion v1 rejects invalid frame ordering, unknown joints and zero quaternions', () => {
  const outOfOrder = makeMotion()
  outOfOrder.frames[1]!.timeMs = 0
  assert.throws(() => validateCanonicalMotion(outOfOrder), /strictly increasing/i)

  const unknownContact = makeMotion()
  unknownContact.frames[0]!.footContacts = ['missing-joint']
  assert.throws(() => validateCanonicalMotion(unknownContact), /Unknown foot contact/i)

  const invalidRotation = makeMotion()
  invalidRotation.frames[0]!.rootRotation = [0, 0, 0, 0]
  assert.throws(() => validateCanonicalMotion(invalidRotation), /zero quaternion/i)
})
