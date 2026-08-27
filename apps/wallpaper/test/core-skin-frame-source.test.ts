import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalMotion } from '@rayure/protocol'

import {
  ArdyMotionSource,
  CoreSkinFrameError,
  chooseWebmMimeType,
  loadCanonicalMotionFixture,
  mediaTimeToVmdFrame,
} from '../src/ardy3d/core-skin-frame-source.ts'

const JOINT_NAMES = [
  'hips', 'spine', 'spine1', 'spine2', 'spine3', 'neck', 'head',
  'right_shoulder', 'right_upper_arm', 'right_elbow', 'right_wrist', 'right_hand_end', 'right_thumb',
  'left_shoulder', 'left_upper_arm', 'left_elbow', 'left_wrist', 'left_hand_end', 'left_thumb',
  'right_hip', 'right_knee', 'right_ankle', 'right_toe',
  'left_hip', 'left_knee', 'left_ankle', 'left_toe',
] as const

function makeMotion(): CanonicalMotion {
  const joints = Object.fromEntries(JOINT_NAMES.map(name => [name, {
    position: [0, 1, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
  }]))
  return {
    schema: 'rayure.motion.v1',
    backend: 'phase1-test',
    jointSetId: 'ardy-core-27',
    jointNames: [...JOINT_NAMES],
    fps: 20,
    frames: [0, 50, 100].map(timeMs => ({
      timeMs,
      rootPosition: [timeMs / 1000, 0, 0] as [number, number, number],
      rootRotation: [0, 0, 0, 1] as [number, number, number, number],
      joints,
    })),
  }
}

test('ArdyMotionSource seeks and steps exact source timestamps without interpolation', () => {
  const source = new ArdyMotionSource()
  source.load(makeMotion())

  assert.equal(source.frameCount, 3)
  assert.equal(source.sourceFps, 20)
  assert.equal(source.durationMs, 100)
  assert.equal(source.currentFrame, undefined)
  assert.equal(source.step()?.timeMs, 0)
  assert.equal(source.step()?.timeMs, 50)
  assert.equal(source.seek(2).timeMs, 100)
  assert.equal(source.step(), undefined)
  assert.equal(source.frameIndex, 2)

  source.reset()
  assert.equal(source.frameIndex, -1)
  assert.equal(source.step()?.timeMs, 0)
})

test('ArdyMotionSource rejects invalid motion and out-of-range cursors', () => {
  const source = new ArdyMotionSource()
  const invalid = makeMotion() as unknown as { jointSetId: string }
  invalid.jointSetId = 'not-ardy-core-27'
  assert.throws(
    () => source.load(invalid as unknown as CanonicalMotion),
    (error: unknown) => error instanceof CoreSkinFrameError && error.code === 'SOURCE_MOTION_INVALID',
  )

  source.load(makeMotion())
  assert.throws(() => source.seek(-1), /outside the loaded motion/)
  assert.throws(() => source.seek(3), /outside the loaded motion/)
})

test('fixture loader only accepts the local ARDY asset endpoint and validates JSON', async () => {
  const motion = makeMotion()
  const goodFetch: typeof fetch = async () => new Response(JSON.stringify(motion), { status: 200 })
  const loaded = await loadCanonicalMotionFixture('/@rayure-assets/walk-motion.json', goodFetch)
  assert.deepEqual(loaded, motion)

  await assert.rejects(
    loadCanonicalMotionFixture('https://example.com/@rayure-assets/walk-motion.json', goodFetch),
    (error: unknown) => error instanceof CoreSkinFrameError && error.code === 'SOURCE_MOTION_INVALID',
  )
  await assert.rejects(
    loadCanonicalMotionFixture('/@rayure-assets/walk-motion.json', async () => new Response('{', { status: 200 })),
    /valid JSON/,
  )
})

test('media timestamps map to sparse VMD 30 FPS frames without changing duration', () => {
  assert.equal(mediaTimeToVmdFrame(0), 0)
  assert.equal(mediaTimeToVmdFrame(50), 2)
  assert.equal(mediaTimeToVmdFrame(100), 3)
  assert.equal(mediaTimeToVmdFrame(150, 50), 3)
  assert.equal(mediaTimeToVmdFrame(200, 50), 5)
})

test('WebM support is optional and is reported as unavailable in Node', () => {
  assert.equal(chooseWebmMimeType(), undefined)
})
