import assert from 'node:assert/strict'
import test from 'node:test'

import { validateCanonicalMotion } from '@rayure/protocol'
import type {
  CanonicalJointPose,
  CanonicalMotion,
  CanonicalMotionFrame,
} from '@rayure/protocol'

import { CANONICAL_ARDY_CORE_JOINT_NAMES } from '../src/ardy-motion-adapter.ts'
import { isDegenerateMotion, trimStaticTailAndReturnToNeutral } from '../src/motion-tail-trim.ts'

const BLEND_FRAMES = 10
const RAISE_HOLD_END = 30

/**
 * Builds a synthetic canonical motion. Every joint rides the root so a
 * `rootX` translation moves the whole body (as real world-space ARDY output
 * does); `right_wrist` additionally deviates along z so a single joint can
 * carry the gesture.
 */
function makeMotion(options: {
  frameCount: number
  fps?: number
  wristZ: (frame: number) => number
  rootX?: (frame: number) => number
}): CanonicalMotion {
  const { frameCount, fps = 20, wristZ, rootX } = options
  const frames: CanonicalMotionFrame[] = []
  for (let i = 0; i < frameCount; i += 1) {
    const rx = rootX?.(i) ?? 0
    const joints: Record<string, CanonicalJointPose> = {}
    for (const name of CANONICAL_ARDY_CORE_JOINT_NAMES) {
      joints[name] = { position: [rx, 1, 0], rotation: [0, 0, 0, 1] }
    }
    joints.right_wrist!.position = [rx, 1, wristZ(i)]
    frames.push({
      timeMs: Math.round((i * 1000) / fps),
      rootPosition: [rx, 0, 0],
      rootRotation: [0, 0, 0, 1],
      joints,
    })
  }
  return {
    schema: 'rayure.motion.v1',
    backend: 'ardy-core',
    jointSetId: 'ardy-core-27',
    jointNames: CANONICAL_ARDY_CORE_JOINT_NAMES,
    fps,
    frames,
  }
}

/** Wave: wrist rises from 0.3 to 0.7 over 30 frames, then holds still. */
function waveMotion(): CanonicalMotion {
  return makeMotion({
    frameCount: 60,
    wristZ: i => (i <= RAISE_HOLD_END ? 0.3 + (0.4 * i) / RAISE_HOLD_END : 0.7),
  })
}

test('trim: a raise-and-hold gesture drops the static tail and returns to neutral', () => {
  const motion = waveMotion()
  const trimmed = trimStaticTailAndReturnToNeutral(motion)

  assert.notEqual(trimmed, motion)
  // The dead hold (frames 31-59) is gone; the return blend adds 10 frames back.
  assert.ok(trimmed.frames.length < 50, `frames ${trimmed.frames.length} should be trimmed below 50`)
  assert.ok(trimmed.frames.length >= 34, `frames ${trimmed.frames.length} should keep the raise`)
  // The raise itself is preserved: the wrist still reaches the held height.
  const peakZ = Math.max(...motion.frames.map(f => f.joints.right_wrist!.position[2]))
  const last = trimmed.frames[trimmed.frames.length - 1]!
  const startZ = motion.frames[0]!.joints.right_wrist!.position[2]
  assert.ok(peakZ > 0.68, `peak ${peakZ} should reach the held height`)
  // The blend descends back to the neutral start height instead of freezing.
  assert.ok(Math.abs(last.joints.right_wrist!.position[2] - startZ) < 1e-9,
    `wrist ${last.joints.right_wrist!.position[2]} should return exactly to start ${startZ}`)
  // The blend starts by coming down from the hold, not jerking further up.
  const holdZ = motion.frames[RAISE_HOLD_END]!.joints.right_wrist!.position[2]
  const firstBlendZ = trimmed.frames[trimmed.frames.length - BLEND_FRAMES]!.joints.right_wrist!.position[2]
  assert.ok(firstBlendZ < holdZ, `first blend frame ${firstBlendZ} should descend below hold ${holdZ}`)
  // Output stays a valid canonical motion (frames strictly increasing, exact keys).
  validateCanonicalMotion(trimmed)
})

test('trim: the root stays at the trimmed end instead of walking back', () => {
  // The gesture body translates forward 0.2m over the active frames, then freezes.
  const motion = makeMotion({
    frameCount: 60,
    wristZ: i => (i <= RAISE_HOLD_END ? 0.3 + (0.4 * i) / RAISE_HOLD_END : 0.7),
    rootX: i => (i <= RAISE_HOLD_END ? (0.2 * i) / RAISE_HOLD_END : 0.2),
  })
  const trimmed = trimStaticTailAndReturnToNeutral(motion)
  const last = trimmed.frames[trimmed.frames.length - 1]!
  // The blend keeps the end root: the body settles in place, no sliding back.
  assert.ok(last.rootPosition[0] > 0.15, `root x ${last.rootPosition[0]} should stay near the end`)
  assert.ok(trimmed.frames.length < 60)
  validateCanonicalMotion(trimmed)
})

test('trim: a motion that keeps moving until the end passes through untouched', () => {
  const motion = makeMotion({ frameCount: 60, wristZ: i => 0.3 + 0.004 * i })
  const result = trimStaticTailAndReturnToNeutral(motion)
  assert.equal(result, motion) // identical reference: no dead tail to trim
})

test('trim: a fully static motion passes through untouched', () => {
  const motion = makeMotion({ frameCount: 40, wristZ: () => 0.5 })
  const result = trimStaticTailAndReturnToNeutral(motion)
  assert.equal(result, motion)
})

test('trim: motions shorter than the trim window pass through untouched', () => {
  const motion = makeMotion({ frameCount: 10, wristZ: i => 0.3 + 0.01 * i })
  const result = trimStaticTailAndReturnToNeutral(motion)
  assert.equal(result, motion)
})

test('degenerate: near-static motions are flagged, real gestures are not', () => {
  // Fully static output: peak smoothed displacement ~0 → degenerate.
  assert.equal(isDegenerateMotion(makeMotion({ frameCount: 40, wristZ: () => 0.5 })), true)
  // Real wave: the wrist travels 0.4m over 30 frames (~13mm/frame peak) → healthy.
  assert.equal(isDegenerateMotion(waveMotion()), false)
  // Slow drift (the degraded bridge's profile: peak ≤ ~5mm/frame) still flags.
  assert.equal(isDegenerateMotion(makeMotion({ frameCount: 60, wristZ: i => 0.3 + (0.3 * i) / 60 })), true)
  // Motions too short to judge are never flagged.
  assert.equal(isDegenerateMotion(makeMotion({ frameCount: 10, wristZ: () => 0.5 })), false)
})
