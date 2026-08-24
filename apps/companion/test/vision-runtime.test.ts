import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { BehaviorOrchestrator } from '../src/behavior/behavior-orchestrator.ts'
import { VisionRuntime } from '../src/vision-runtime.ts'
import type { MotionGenerationController } from '../src/motion-generation-controller.ts'

test('vision runtime simulation reaches the allowlisted motion policy', async () => {
  const calls: unknown[] = []
  const controller = {
    submitIntent: async (input: unknown) => { calls.push(input) },
  } as unknown as MotionGenerationController
  const runtime = new VisionRuntime({
    config: {
      enabled: true,
      command: 'python',
      args: [
        fileURLToPath(new URL('../../../scripts/mediapipe-vision-bridge.py', import.meta.url)),
        '--simulate', '--frames', '6', '--interval-ms', '10',
      ],
      cameraIndex: 0,
      fps: 8,
      width: 640,
      height: 360,
      actions: { 'gesture.wave': 'wave.casual' },
    },
    orchestrator: new BehaviorOrchestrator(),
    controller,
    presets: [{ id: 'wave.casual', prompt: 'A person waves casually' }],
  })
  assert.equal(runtime.enabled, true)
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 2_000
    const poll = (): void => {
      if (calls.length > 0) {
        resolve()
      }
      else if (Date.now() >= deadline) {
        reject(new Error('vision simulation did not produce a mapped action'))
      }
      else {
        setTimeout(poll, 10)
      }
    }
    poll()
  })
  assert.equal((calls[0] as { id: string }).id, 'wave.casual')
  await runtime.close()
})

test('disabled vision runtime does not spawn a process', async () => {
  const runtime = new VisionRuntime({
    config: {
      enabled: false,
      command: process.execPath,
      args: [],
      cameraIndex: 0,
      fps: 8,
      width: 640,
      height: 360,
    },
    orchestrator: new BehaviorOrchestrator(),
  })
  assert.equal(runtime.enabled, false)
  await runtime.close()
})
