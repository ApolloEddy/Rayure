import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalMotion } from '@rayure/protocol'

import { Live2dMotionPlayer } from '../src/live2d/motion-player.ts'

const jointNames = [
  'head', 'left_shoulder', 'left_elbow', 'left_wrist',
  'right_shoulder', 'right_elbow', 'right_wrist',
  ...Array.from({ length: 20 }, (_, index) => `joint-${index}`),
]

function makeMotion(): CanonicalMotion {
  const makeJoints = (headYaw: number) => Object.fromEntries(jointNames.map(name => [name, {
    position: [0, name === 'head' ? 1.8 : 1, 0] as [number, number, number],
    rotation: name === 'head'
      ? [0, 0, Math.sin(headYaw / 2 * Math.PI / 180), Math.cos(headYaw / 2 * Math.PI / 180)] as [number, number, number, number]
      : [0, 0, 0, 1] as [number, number, number, number],
  }]))
  return {
    schema: 'rayure.motion.v1',
    backend: 'fixture',
    jointSetId: 'ardy-core-27',
    jointNames,
    fps: 20,
    frames: [
      {
        timeMs: 0,
        rootPosition: [0, 0, 0],
        rootRotation: [0, 0, 0, 1],
        joints: makeJoints(0),
      },
      {
        timeMs: 100,
        rootPosition: [0, 0, 0],
        rootRotation: [0, 0, 0, 1],
        joints: makeJoints(20),
      },
    ],
  }
}

test('Live2D motion player applies recorded frames in timestamp order', () => {
  const received: Array<[string, number]> = []
  const player = new Live2dMotionPlayer({
    setParameterValue: (id, value) => received.push([id, value]),
  })
  player.bind(makeMotion())

  assert.equal(player.advance(0), true)
  assert.equal(player.isPlaying, true)
  assert.equal(received.find(([id]) => id === 'ParamAngleX')?.[1], 0)

  assert.equal(player.advance(0.1), true)
  const angleUpdates = received.filter(([id]) => id === 'ParamAngleX')
  assert.equal(angleUpdates.length, 2)
  assert.ok(Math.abs((angleUpdates.at(-1)?.[1] ?? 0) - 20) < 1e-9)
  assert.equal(player.isPlaying, false)
})

test('Live2D motion player interpolates sparse Canonical Motion between source frames', () => {
  const received: Array<[string, number]> = []
  const player = new Live2dMotionPlayer({
    setParameterValue: (id, value) => received.push([id, value]),
  })
  player.bind(makeMotion())

  player.advance(0)
  player.advance(0.05)
  const angle = received.filter(([id]) => id === 'ParamAngleX').at(-1)?.[1]
  assert.ok(angle !== undefined)
  assert.ok(Math.abs(angle - 10) < 0.001, `expected midpoint yaw, got ${angle}`)
  assert.equal(player.consumedFrameCount, 1)
})

test('Live2D motion player exposes the interpolated root pose to a projection sink', () => {
  const motion = makeMotion()
  const movingMotion: CanonicalMotion = {
    ...motion,
    frames: motion.frames.map((frame, index) => index === 1
      ? { ...frame, rootPosition: [10, 0, 0] }
      : frame),
  }
  const roots: number[] = []
  const player = new Live2dMotionPlayer({
    setParameterValue: () => undefined,
    onMotionFrame: frame => roots.push(frame.rootPosition[0]),
  })
  player.bind(movingMotion)
  player.advance(0)
  player.advance(0.05)
  assert.equal(roots.at(-1), 5)
})

test('Live2D motion player stops and ignores invalid time deltas', () => {
  const received: Array<[string, number]> = []
  const player = new Live2dMotionPlayer({
    setParameterValue: (id, value) => received.push([id, value]),
  })
  player.bind(makeMotion())
  assert.equal(player.advance(-0.1), false)
  player.stop()
  assert.equal(player.advance(1), false)
  assert.equal(received.length, 0)
})
