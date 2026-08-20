import assert from 'node:assert/strict'
import test from 'node:test'

import type { Live2dMotionDescriptor } from '@rayure/protocol'
import { Live2dMotionController } from '../src/live2d/motion-controller.ts'

function motion(id: string, group: string, index: number): Live2dMotionDescriptor {
  return {
    id,
    displayName: id,
    format: 'live2d',
    url: `http://127.0.0.1:32145/assets/0123456789abcdef/${id}.motion3.json`,
    group,
    index,
  }
}

test('Live2D motion controller starts, replaces and ignores stale completion callbacks', async () => {
  const callbacks: Array<{ onStart: () => void, onEnd: () => void }> = []
  const starts: string[] = []
  let stops = 0
  const model = {
    getMotions: () => ['Idle_0', 'TapBody_0'],
    startMotion: async (group: string, index: number, _priority: number, onStart?: () => void, onEnd?: () => void) => {
      starts.push(`${group}_${index}`)
      callbacks.push({ onStart: onStart ?? (() => undefined), onEnd: onEnd ?? (() => undefined) })
      onStart?.()
      return 1
    },
    stopMotions: () => { stops += 1 },
  }
  const controller = new Live2dMotionController()
  controller.bindModel(model)

  const idle = motion('idle', 'Idle', 0)
  const tap = motion('tap', 'TapBody', 0)
  assert.equal(await controller.playMotion(idle), true)
  assert.equal(controller.activeMotionId, 'idle')
  assert.equal(await controller.playMotion(tap), true)
  assert.equal(controller.activeMotionId, 'tap')
  assert.deepEqual(starts, ['Idle_0', 'TapBody_0'])
  assert.equal(stops, 2)

  callbacks[0]!.onEnd()
  assert.equal(controller.activeMotionId, 'tap')
  callbacks[1]!.onEnd()
  assert.equal(controller.isPlaying, false)
})

test('Live2D motion controller stops only the requested active motion and rejects unavailable entries', async () => {
  let stops = 0
  const model = {
    getMotions: () => ['Idle_0'],
    startMotion: async (_group: string, _index: number, _priority: number, onStart?: () => void) => {
      onStart?.()
      return 1
    },
    stopMotions: () => { stops += 1 },
  }
  const controller = new Live2dMotionController()
  controller.bindModel(model)
  const idle = motion('idle', 'Idle', 0)
  const tap = motion('tap', 'TapBody', 0)

  assert.equal(await controller.playMotion(tap), false)
  assert.equal(await controller.playMotion(idle), true)
  controller.stopMotion('other')
  assert.equal(controller.activeMotionId, 'idle')
  controller.stopMotion('idle')
  assert.equal(controller.activeMotionId, undefined)
  assert.equal(stops, 2)
})

test('Live2D motion controller drops a superseded asynchronous start', async () => {
  const resolvers: Array<(value: unknown) => void> = []
  const model = {
    startMotion: () => new Promise<unknown>(resolve => { resolvers.push(resolve) }),
    stopMotions: () => undefined,
  }
  const controller = new Live2dMotionController()
  controller.bindModel(model)
  const idle = motion('idle', 'Idle', 0)
  const tap = motion('tap', 'TapBody', 0)

  const first = controller.playMotion(idle)
  const second = controller.playMotion(tap)
  resolvers[0]?.(1)
  resolvers[1]?.(1)
  assert.equal(await first, false)
  assert.equal(await second, true)
  assert.equal(controller.activeMotionId, 'tap')
})
