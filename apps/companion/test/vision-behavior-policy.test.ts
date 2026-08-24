import assert from 'node:assert/strict'
import test from 'node:test'

import { BehaviorOrchestrator } from '../src/behavior/behavior-orchestrator.ts'
import { VisionBehaviorPolicy } from '../src/vision-behavior-policy.ts'
import type { MotionGenerationController } from '../src/motion-generation-controller.ts'
import type { BehaviorEvent } from '../src/behavior/types.ts'

const event: BehaviorEvent = {
  version: 'rayure.behavior-event.v1',
  id: 'vision:wave-1:gesture.wave',
  source: 'vision',
  type: 'gesture.wave',
  correlationId: 'vision-wave-1',
  observedAtMs: Date.now(),
  expiresAtMs: Date.now() + 1_000,
  confidence: 0.9,
  data: { hand: 'left' },
}

test('vision policy maps an allowlisted event to MotionGenerationController', async () => {
  const calls: unknown[] = []
  const controller = { submitIntent: async (input: unknown) => { calls.push(input) } } as unknown as MotionGenerationController
  const policy = new VisionBehaviorPolicy({
    orchestrator: new BehaviorOrchestrator(),
    controller,
    presets: [{ id: 'wave.casual', prompt: 'A person waves casually', numFrames: 8 }],
    actions: { 'gesture.wave': 'wave.casual' },
  })
  assert.equal(policy.handle(event), 'started')
  await new Promise<void>(resolveNext => setTimeout(resolveNext, 0))
  assert.deepEqual(calls, [{ id: 'wave.casual', prompt: 'A person waves casually', numFrames: 8, signal: calls[0] && (calls[0] as { signal: AbortSignal }).signal }])
})

test('vision policy rejects unmapped events without invoking the controller', () => {
  let calls = 0
  const controller = { submitIntent: async () => { calls += 1 } } as unknown as MotionGenerationController
  const policy = new VisionBehaviorPolicy({
    orchestrator: new BehaviorOrchestrator(),
    controller,
    presets: [{ id: 'wave.casual', prompt: 'A person waves casually' }],
    actions: {},
  })
  assert.equal(policy.handle(event), 'unmapped')
  assert.equal(calls, 0)
})

test('vision policy passes cancellation to the motion controller', async () => {
  let receivedSignal: AbortSignal | undefined
  let resolve: (() => void) | undefined
  const controller = {
    submitIntent: async (input: { signal?: AbortSignal }) => {
      receivedSignal = input.signal
      await new Promise<void>(done => { resolve = done })
    },
  } as unknown as MotionGenerationController
  const orchestrator = new BehaviorOrchestrator()
  const policy = new VisionBehaviorPolicy({
    orchestrator,
    controller,
    presets: [{ id: 'wave.casual', prompt: 'A person waves casually' }],
    actions: { 'gesture.wave': 'wave.casual' },
  })
  assert.equal(policy.handle(event), 'started')
  await new Promise<void>(queueMicrotask)
  assert.ok(receivedSignal)
  orchestrator.cancel()
  assert.equal(receivedSignal!.aborted, true)
  resolve?.()
})
