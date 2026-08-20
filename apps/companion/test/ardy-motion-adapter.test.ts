import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ARDY_CORE_JOINT_NAMES,
  convertArdyMotion,
} from '../src/ardy-motion-adapter.ts'

function makeMotion() {
  const joints = Object.fromEntries(ARDY_CORE_JOINT_NAMES.map((name, index) => [name, {
    position: [index / 10, 1, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
  }]))
  return {
    schema: 'rayure.ardy-motion.v1' as const,
    backend: 'ardy-core',
    fps: 20,
    jointNames: [...ARDY_CORE_JOINT_NAMES],
    frames: [
      {
        timeMs: 0,
        rootPosition: [0, 0, 0] as [number, number, number],
        rootRotation: [0, 0, 0, 1] as [number, number, number, number],
        joints,
        footContacts: ['LeftFoot', 'RightFoot'],
      },
      {
        timeMs: 50,
        rootPosition: [0, 0, 0] as [number, number, number],
        rootRotation: [0, 0, 0, 1] as [number, number, number, number],
        joints,
      },
    ],
  }
}

test('ARDY Core motion converts to Canonical Motion with Live2D-friendly upper-body names', () => {
  const motion = convertArdyMotion(makeMotion())

  assert.equal(motion.schema, 'rayure.motion.v1')
  assert.equal(motion.backend, 'ardy-core')
  assert.equal(motion.jointSetId, 'ardy-core-27')
  assert.equal(motion.jointNames.length, 27)
  assert.ok(motion.jointNames.includes('head'))
  assert.ok(motion.jointNames.includes('left_elbow'))
  assert.ok(motion.jointNames.includes('right_wrist'))
  assert.deepEqual(motion.frames[0]!.footContacts, ['left_ankle', 'right_ankle'])
})

test('ARDY Core motion rejects a non-Core skeleton or unknown foot contact', () => {
  const wrongSkeleton = makeMotion() as unknown as { jointNames: string[] }
  wrongSkeleton.jointNames[0] = 'Unknown'
  assert.throws(() => convertArdyMotion(wrongSkeleton), /jointNames|Core skeleton/i)

  const unknownContact = makeMotion()
  unknownContact.frames[0]!.footContacts = ['Missing']
  assert.throws(() => convertArdyMotion(unknownContact), /foot contact|joint/i)
})

test('ARDY Core motion rejects malformed frame ordering and missing joints', () => {
  const outOfOrder = makeMotion()
  outOfOrder.frames[1]!.timeMs = 0
  assert.throws(() => convertArdyMotion(outOfOrder), /strictly increasing|time/i)

  const missingJoint = makeMotion()
  delete missingJoint.frames[0]!.joints.Head
  assert.throws(() => convertArdyMotion(missingJoint), /joints|missing/i)
})
