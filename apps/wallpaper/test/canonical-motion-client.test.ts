import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalMotion, MotionDescriptor } from '@rayure/protocol'
import {
  CanonicalMotionPlayer,
  loadCanonicalMotion,
} from '../src/live2d/canonical-motion-client.ts'
import type { Live2dParameterSink } from '../src/live2d/rig-profile.ts'

const CANONICAL_JOINT_NAMES = [
  'hips', 'spine', 'spine1', 'spine2', 'spine3', 'neck', 'head',
  'right_shoulder', 'right_upper_arm', 'right_elbow', 'right_wrist', 'right_hand_end', 'right_thumb',
  'left_shoulder', 'left_upper_arm', 'left_elbow', 'left_wrist', 'left_hand_end', 'left_thumb',
  'right_hip', 'right_knee', 'right_ankle', 'right_toe',
  'left_hip', 'left_knee', 'left_ankle', 'left_toe',
]

function makeMotion(extraFrames = 1): CanonicalMotion {
  const joints = Object.fromEntries(CANONICAL_JOINT_NAMES.map(name => [name, {
    position: [0, 1, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
  }]))
  joints.head = { position: [0, 1.8, 0], rotation: [0, 0, 0, 1] }
  joints.right_shoulder = { position: [0.2, 1.4, 0], rotation: [0, 0, 0, 1] }
  joints.right_elbow = { position: [0.8, 1.4, 0], rotation: [0, 0, 0, 1] }
  joints.right_wrist = { position: [0.8, 0.9, 0], rotation: [0, 0, 0, 1] }
  const frames = [{ timeMs: 0 }, { timeMs: 50 }].slice(0, extraFrames + 1).map(frame => ({
    timeMs: frame.timeMs,
    rootPosition: [0, 0, 0] as [number, number, number],
    rootRotation: [0, 0, 0, 1] as [number, number, number, number],
    joints,
  }))
  return {
    schema: 'rayure.motion.v1',
    backend: 'test-backend',
    jointSetId: 'ardy-core-27',
    jointNames: CANONICAL_JOINT_NAMES,
    fps: 20,
    frames,
  }
}

function makeDescriptor(motionId = 'generated-wave'): MotionDescriptor {
  return {
    id: motionId,
    displayName: 'Generated Wave',
    format: 'canonical',
    url: `http://127.0.0.1:32145/assets/0123456789abcdef/${motionId}.json`,
  }
}

interface RecordingSink extends Live2dParameterSink {
  writes: Array<[string, number]>
}

function makeSink(): RecordingSink {
  return {
    writes: [],
    setParameterValue(parameterId: string, value: number): void {
      this.writes.push([parameterId, value])
    },
  }
}

test('loadCanonicalMotion fetches and validates a valid motion', async () => {
  const motion = makeMotion(1)
  const fetcher = async (): Promise<Response> => new Response(JSON.stringify(motion), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  const loaded = await loadCanonicalMotion(
    'http://127.0.0.1:32145/assets/0123456789abcdef/x.json',
    { fetchImplementation: fetcher },
  )
  assert.deepEqual(loaded, motion)
})

test('loadCanonicalMotion rejects non-OK responses and invalid bodies', async () => {
  await assert.rejects(
    loadCanonicalMotion('http://127.0.0.1:32145/assets/0123456789abcdef/x.json', {
      fetchImplementation: async () => new Response('nope', { status: 404 }),
    }),
    /HTTP 404/,
  )
  const invalid = makeMotion(1) as unknown as { schema: string }
  invalid.schema = 'nope'
  await assert.rejects(
    loadCanonicalMotion('http://127.0.0.1:32145/assets/0123456789abcdef/x.json', {
      fetchImplementation: async () => new Response(JSON.stringify(invalid), { status: 200 }),
    }),
    /schema|Unsupported/i,
  )
  await assert.rejects(
    loadCanonicalMotion('https://evil.example/x.json', {
      fetchImplementation: async () => new Response('{}', { status: 200 }),
    }),
    /loopback/i,
  )
  await assert.rejects(
    loadCanonicalMotion('http://example.com:32145/assets/0123456789abcdef/x.json', {
      fetchImplementation: async () => new Response('{}', { status: 200 }),
    }),
    /loopback/i,
  )
  await assert.rejects(
    loadCanonicalMotion('http://127.0.0.1:32145/assets/bad/x.json', {
      fetchImplementation: async () => new Response('{}', { status: 200 }),
    }),
    /loopback/i,
  )
})

test('CanonicalMotionPlayer drives frames into the sink and stops', () => {
  const sink = makeSink()
  const player = new CanonicalMotionPlayer(sink)
  const motion = makeMotion(1)
  const descriptor = makeDescriptor()

  player.play(motion, descriptor)
  assert.equal(player.isPlaying, true)
  assert.equal(player.activeDescriptor?.id, 'generated-wave')

  // First frame at t=0 applies immediately; second frame needs 50ms.
  player.advance(0)
  assert.ok(sink.writes.length > 0)
  player.advance(0.1)
  assert.ok(player.activeDescriptor === undefined || !player.isPlaying)
})

test('CanonicalMotionPlayer interruption releases a superseded action', () => {
  const sink = makeSink()
  const player = new CanonicalMotionPlayer(sink)
  player.play(makeMotion(1), makeDescriptor('first'))
  assert.equal(player.activeDescriptor?.id, 'first')
  player.play(makeMotion(1), makeDescriptor('second'))
  assert.equal(player.activeDescriptor?.id, 'second')
  player.stop()
  assert.equal(player.isPlaying, false)
  assert.equal(player.activeDescriptor, undefined)
})

test('CanonicalMotionPlayer rejects invalid motion on bind', () => {
  const player = new CanonicalMotionPlayer(makeSink())
  const invalid = makeMotion(1) as unknown as CanonicalMotion
  ;(invalid as unknown as { jointSetId: string }).jointSetId = 'wrong-set'
  assert.throws(() => player.bind(invalid, makeDescriptor()), /joint set/i)
  assert.equal(player.isPlaying, false)
})