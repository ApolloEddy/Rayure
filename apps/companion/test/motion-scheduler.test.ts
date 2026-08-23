import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalJointPose, CanonicalMotion } from '@rayure/protocol'

import { MotionScheduler } from '../src/motion-scheduler.ts'

const JOINT_NAMES = [
  'hips', 'spine', 'spine1', 'spine2', 'spine3', 'neck', 'head',
  'right_shoulder', 'right_upper_arm', 'right_elbow', 'right_wrist', 'right_hand_end', 'right_thumb',
  'left_shoulder', 'left_upper_arm', 'left_elbow', 'left_wrist', 'left_hand_end', 'left_thumb',
  'right_hip', 'right_knee', 'right_ankle', 'right_toe',
  'left_hip', 'left_knee', 'left_ankle', 'left_toe',
]

function joints(): Record<string, CanonicalJointPose> {
  return Object.fromEntries(JOINT_NAMES.map(name => [name, {
    position: [0, 1, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
  }]))
}

function makeMotion(frameCount: number, timeStepMs = 50): CanonicalMotion {
  return {
    schema: 'rayure.motion.v1',
    backend: 'test-backend',
    jointSetId: 'ardy-core-27',
    jointNames: JOINT_NAMES,
    fps: 20,
    frames: Array.from({ length: frameCount }, (_, index) => ({
      timeMs: index * timeStepMs,
      rootPosition: [0, 0, 0] as [number, number, number],
      rootRotation: [0, 0, 0, 1] as [number, number, number, number],
      joints: joints(),
    })),
  }
}

function makeIntent(id = 'wave.casual', prompt = 'casually wave') {
  return { id, prompt }
}

test('solicit generates a segment and installs a buffered motion', async () => {
  const scheduler = new MotionScheduler({
    generator: async () => makeMotion(3),
  })
  const segment = await scheduler.solicit(makeIntent())
  assert.equal(segment.intentId, 'wave.casual')
  assert.equal(scheduler.isBuffering, true)
  assert.equal(scheduler.buffer?.frames.length, 3)
})

test('advance consumes frames in time order through subscribers', async () => {
  const scheduler = new MotionScheduler({ generator: async () => makeMotion(3, 50) })
  await scheduler.solicit(makeIntent())
  const consumed: number[] = []
  scheduler.subscribe((frame) => consumed.push(frame.timeMs))

  const first = scheduler.advance(0.05)
  assert.equal(first.length, 1)
  assert.equal(first[0]?.timeMs, 0)
  const second = scheduler.advance(0.05)
  assert.equal(second.length, 1)
  assert.equal(second[0]?.timeMs, 50)
  assert.deepEqual(consumed, [0, 50])
})

test('advance does nothing without a buffer or with invalid deltas', async () => {
  const scheduler = new MotionScheduler({ generator: async () => makeMotion(2) })
  assert.deepEqual(scheduler.advance(0.1), [])
  assert.deepEqual(scheduler.advance(-1), [])
  await scheduler.solicit(makeIntent())
  assert.notEqual(scheduler.advance(0.1).length, 0)
})

test('a superseded in-flight result is discarded', async () => {
  let resolveFirst: ((motion: CanonicalMotion) => void) | undefined
  const firstGate = new Promise<CanonicalMotion>(resolve => { resolveFirst = resolve })
  const calls: string[] = []
  const scheduler = new MotionScheduler({
    generator: async (intent) => {
      calls.push(intent.id)
      if (intent.id === 'first') return firstGate
      return makeMotion(2)
    },
  })

  const first = scheduler.solicit({ id: 'first', prompt: 'first' })
  const second = scheduler.solicit({ id: 'second', prompt: 'second' })
  resolveFirst?.(makeMotion(1))

  const secondSegment = await second
  assert.equal(secondSegment.intentId, 'second')
  await assert.rejects(first, /superseded/i)
  assert.equal(scheduler.buffer?.frames.length, 2)
  assert.deepEqual(calls, ['first', 'second'])
})

test('history continuation passes a truncated consumed motion to the next intent', async () => {
  const seenHistory: Array<CanonicalMotion | undefined> = []
  const scheduler = new MotionScheduler({
    generator: async (_intent, history) => {
      seenHistory.push(history)
      return makeMotion(5, 50) // 5 frames: 0,50,100,150,200
    },
  })
  await scheduler.solicit({ id: 'a', prompt: 'a' })
  scheduler.advance(0.11) // consume frames up to 110ms -> includes 0,50,100
  await scheduler.solicit({ id: 'b', prompt: 'b' })

  assert.equal(seenHistory.length, 2)
  // The second solicitation must carry real consumed history (a truncated slice).
  const history = seenHistory[1]
  assert.ok(history)
  assert.ok(history.frames.length > 0)
  assert.ok(history.frames.length < 5)
  assert.equal(history.frames[history.frames.length - 1]?.timeMs, 100)
})

test('clear invalidates the buffer and pending history', async () => {
  const scheduler = new MotionScheduler({ generator: async () => makeMotion(3) })
  await scheduler.solicit(makeIntent())
  assert.equal(scheduler.isBuffering, true)
  scheduler.clear()
  assert.equal(scheduler.buffer, undefined)
  assert.equal(scheduler.isBuffering, false)
  assert.deepEqual(scheduler.advance(0.1), [])
})

test('solicit calls onSegmentReady after installing a segment', async () => {
  let ready: string | undefined
  const scheduler = new MotionScheduler({
    generator: async () => makeMotion(2),
    onSegmentReady: (segment) => { ready = segment.intentId },
  })
  await scheduler.solicit(makeIntent('idle', 'idle'))
  assert.equal(ready, 'idle')
})