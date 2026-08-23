import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalJointPose, CanonicalMotion } from '@rayure/protocol'

import { MotionGenerationController } from '../src/motion-generation-controller.ts'

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

function makeMotion(): CanonicalMotion {
  return {
    schema: 'rayure.motion.v1',
    backend: 'test-backend',
    jointSetId: 'ardy-core-27',
    jointNames: JOINT_NAMES,
    fps: 20,
    frames: [
      {
        timeMs: 0,
        rootPosition: [0, 0, 0],
        rootRotation: [0, 0, 0, 1],
        joints: joints(),
      },
      {
        timeMs: 50,
        rootPosition: [0, 0, 0],
        rootRotation: [0, 0, 0, 1],
        joints: joints(),
      },
    ],
  }
}

interface Harness {
  controller: MotionGenerationController
  published: Array<{ id: string, displayName: string, frames: number }>
  statuses: Array<{ phase: string, intentId: string }>
}

function makeHarness(generateOverride?: (intentId: string) => Promise<CanonicalMotion>): Harness {
  const published: Array<{ id: string, displayName: string, frames: number }> = []
  const statuses: Array<{ phase: string, intentId: string }> = []
  const controller = new MotionGenerationController({
    generate: async intent => generateOverride ? generateOverride(intent.id) : makeMotion(),
    publish: (input) => {
      published.push({ id: input.id, displayName: input.displayName, frames: input.motion.frames.length })
      return undefined
    },
    onStatus: (status) => statuses.push({ phase: status.phase, intentId: status.intentId }),
  })
  return { controller, published, statuses }
}

test('submitIntent generates, publishes and reports status', async () => {
  const { controller, published, statuses } = makeHarness()
  const segment = await controller.submitIntent({ id: 'wave.casual', prompt: 'casually wave' })
  assert.equal(segment.intentId, 'wave.casual')
  assert.equal(published.length, 1)
  assert.equal(published[0]?.id, 'wave.casual')
  assert.equal(published[0]?.frames, 2)
  assert.deepEqual(statuses, [
    { phase: 'generating', intentId: 'wave.casual' },
    { phase: 'ready', intentId: 'wave.casual' },
  ])
})

test('runStartup publishes every preset in order', async () => {
  const { controller, published } = makeHarness()
  await controller.runStartup([
    { id: 'idle', prompt: 'stand calm' },
    { id: 'wave', prompt: 'friendly wave' },
  ])
  assert.deepEqual(published.map(p => p.id), ['idle', 'wave'])
})

test('a preempted running intent rejects with superseded and the newer wins', async () => {
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  let callCount = 0
  let releaseSecond!: () => void
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
  const { controller, published } = makeHarness(async () => {
    callCount += 1
    if (callCount === 1) await firstGate
    else if (callCount === 2) await secondGate
    return makeMotion()
  })

  const first = controller.submitIntent({ id: 'a', prompt: 'a' })
  const second = controller.submitIntent({ id: 'b', prompt: 'b' })
  releaseFirst()
  releaseSecond()

  await second
  await assert.rejects(first, /superseded/i)
  assert.deepEqual(published.map(p => p.id), ['b'])
})

test('isGenerating tracks an in-flight intent', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const { controller } = makeHarness(async () => {
    await gate
    return makeMotion()
  })
  const pending = controller.submitIntent({ id: 'a', prompt: 'a' })
  assert.equal(controller.isGenerating, true)
  release()
  await pending
  assert.equal(controller.isGenerating, false)
})