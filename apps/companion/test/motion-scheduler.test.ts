import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalJointPose, CanonicalMotion } from '@rayure/protocol'

import { MotionScheduler } from '../src/motion-scheduler.ts'
import type { MotionScheduleHistory } from '../src/motion-scheduler.ts'

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
  await Promise.resolve() // let the first generator actually start (in-flight)
  const second = scheduler.solicit({ id: 'second', prompt: 'second' })
  resolveFirst?.(makeMotion(1))

  const secondSegment = await second
  assert.equal(secondSegment.intentId, 'second')
  await assert.rejects(first, /superseded/i)
  assert.equal(scheduler.buffer?.frames.length, 2)
  assert.deepEqual(calls, ['first', 'second'])
})

test('preempting aborts the previous intent via its cancellation signal', async () => {
  let firstSignal: AbortSignal | undefined
  const scheduler = new MotionScheduler({
    generator: async (intent) => {
      if (intent.id === 'first') {
        firstSignal = intent.signal
        // A cooperative generator honours the signal; it settles only when the
        // request is aborted (mirrors how MotionGenerationService observes it).
        return new Promise<CanonicalMotion>((_resolve, reject) => {
          const onAbort = (): void => reject(new Error('first aborted'))
          if (intent.signal?.aborted) onAbort()
          else intent.signal?.addEventListener('abort', onAbort, { once: true })
        })
      }
      return makeMotion(2)
    },
  })

  const first = scheduler.solicit({ id: 'first', prompt: 'first' })
  first.catch(() => { /* expected: preempted via abort */ })
  await Promise.resolve() // let the first generator start and capture its signal
  assert.ok(firstSignal, 'first generator should expose its signal')

  const second = scheduler.solicit({ id: 'second', prompt: 'second' })
  const segment = await second
  assert.equal(segment.intentId, 'second')
  assert.equal(firstSignal?.aborted, true)
  await assert.rejects(first, /superseded|aborted/i)
})

test('preemption aborts the signal seen by a generator even with an external caller signal', async () => {
  const external = new AbortController()
  let seenSignal: AbortSignal | undefined
  const scheduler = new MotionScheduler({
    generator: async (intent) => {
      if (intent.id !== 'first') return makeMotion(2)
      seenSignal = intent.signal
      return await new Promise<CanonicalMotion>((_resolve, reject) => {
        intent.signal?.addEventListener('abort', () => reject(new Error('first aborted')), { once: true })
      })
    },
  })

  const first = scheduler.solicit({ id: 'first', prompt: 'first', signal: external.signal })
  first.catch(() => { /* expected preemption */ })
  await Promise.resolve()
  const second = scheduler.solicit({ id: 'second', prompt: 'second' })
  await second

  assert.ok(seenSignal)
  assert.equal(seenSignal.aborted, true)
  // Scheduler preemption must not mutate the caller-owned AbortController.
  assert.equal(external.signal.aborted, false)
  await assert.rejects(first, /superseded|aborted/i)
})

test('history continuation passes a truncated consumed motion to the next intent', async () => {
  const seenHistory: Array<MotionScheduleHistory | undefined> = []
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
  assert.ok(history.motion.frames.length > 0)
  assert.ok(history.motion.frames.length < 5)
  assert.equal(history.consumedFrameCount, 3)
  assert.equal(history.motion.frames[history.motion.frames.length - 1]?.timeMs, 100)
})

test('renderer progress selects the exact continuation prefix and rejects stale descriptors', async () => {
  const seenHistory: Array<MotionScheduleHistory | undefined> = []
  const scheduler = new MotionScheduler({
    generator: async (intent, history) => {
      seenHistory.push(history)
      return {
        motion: makeMotion(5, 50),
        ...(intent.id === 'a' ? { continuationId: 'bridge-continuation-1' } : {}),
      }
    },
  })
  const first = await scheduler.solicit({ id: 'a', prompt: 'a' })
  assert.equal(scheduler.attachPublishedSegment(first, 'generated-a-1'), true)
  assert.equal(scheduler.reportPlayback({
    motionId: 'wrong-generated-a-1',
    phase: 'progress',
    frameIndex: 2,
  }), false)
  assert.equal(scheduler.reportPlayback({
    motionId: 'generated-a-1',
    phase: 'progress',
    frameIndex: 2,
  }), true)
  assert.equal(scheduler.reportPlayback({
    motionId: 'generated-a-1',
    phase: 'progress',
    frameIndex: 1,
  }), false)

  await scheduler.solicit({ id: 'b', prompt: 'b' })
  assert.equal(seenHistory[1]?.consumedFrameCount, 2)
  assert.equal(seenHistory[1]?.continuationId, 'bridge-continuation-1')
  assert.equal(seenHistory[1]?.motion.frames.length, 2)
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

test('a failed publication rolls back the unobservable segment buffer', async () => {
  const scheduler = new MotionScheduler({
    generator: async () => makeMotion(2),
    onSegmentReady: () => { throw new Error('publish failed') },
  })

  await assert.rejects(scheduler.solicit(makeIntent()), /publish failed/i)
  assert.equal(scheduler.buffer, undefined)
  assert.equal(scheduler.isBuffering, false)
  assert.equal(scheduler.isGenerating, false)
})
