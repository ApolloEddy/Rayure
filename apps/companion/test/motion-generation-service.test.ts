import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CanonicalMotion,
  MotionSemanticFeature,
} from '@rayure/protocol'

import { CANONICAL_ARDY_CORE_JOINT_NAMES } from '../src/ardy-motion-adapter.ts'
import type { ArdyMotionResult } from '../src/ardy-process-protocol.ts'
import type { ArdyProcessGenerationInput } from '../src/ardy-process-client.ts'
import {
  MotionGenerationService,
} from '../src/motion-generation-service.ts'
import { MemoryMotionSemanticFeatureCache } from '../src/motion-semantic-cache.ts'

function makeFeature(cacheKey = 'wave.casual', canonicalPrompt = 'casually wave'): MotionSemanticFeature {
  return {
    schema: 'rayure.motion-semantic-feature.v1',
    cacheKey,
    canonicalPrompt,
    encoderId: 'fixture-encoder',
    encoderVersion: 'fixture-v1',
    dtype: 'float16',
    tokenCount: 1,
    featureDimension: 4096,
    values: Array.from({ length: 4096 }, () => 0.25),
    textPadMask: [true],
    createdAtMs: 1,
  }
}

function makeMotion(): CanonicalMotion {
  const joints = Object.fromEntries(CANONICAL_ARDY_CORE_JOINT_NAMES.map(name => [name, {
    position: [0, 1, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
  }]))
  return {
    schema: 'rayure.motion.v1',
    backend: 'ardy-core',
    jointSetId: 'ardy-core-27',
    jointNames: CANONICAL_ARDY_CORE_JOINT_NAMES,
    fps: 20,
    frames: [{
      timeMs: 0,
      rootPosition: [0, 0, 0],
      rootRotation: [0, 0, 0, 1],
      joints,
    }],
  }
}

test('motion generation service resolves a cache hit and forwards ARDY input', async () => {
  const feature = makeFeature()
  const cache = new MemoryMotionSemanticFeatureCache([feature])
  const captured: ArdyProcessGenerationInput[] = []
  const backend = {
    generate: async (input: ArdyProcessGenerationInput): Promise<ArdyMotionResult> => {
      captured.push(input)
      return { requestId: 'request-1', motion: makeMotion() }
    },
  }
  const service = new MotionGenerationService({ cache, backend })
  const history = makeMotion()
  const constraints = [{
    timeMs: 500,
    joint: 'RightHand',
    position: [0.2, 1.2, 0] as const,
  }]

  const result = await service.generate({
    cacheKey: feature.cacheKey,
    canonicalPrompt: feature.canonicalPrompt,
    numFrames: 40,
    numDenoisingSteps: 4,
    cfgWeight: 2,
    history,
    constraints,
  })

  assert.equal(result.requestId, 'request-1')
  assert.equal(captured.length, 1)
  assert.equal(captured[0]?.textFeature, feature)
  assert.equal(captured[0]?.history, history)
  assert.deepEqual(captured[0]?.constraints, constraints)
})

test('motion generation service uses a resolver for a cache miss', async () => {
  const feature = makeFeature('new.motion', 'new motion')
  const cache = new MemoryMotionSemanticFeatureCache()
  const resolveCalls: string[] = []
  const backendFeatures: MotionSemanticFeature[] = []
  const service = new MotionGenerationService({
    cache,
    resolver: {
      resolve: async (input) => {
        resolveCalls.push(`${input.cacheKey}:${input.canonicalPrompt}`)
        cache.set(feature)
        return feature
      },
    },
    backend: {
      generate: async (input) => {
        backendFeatures.push(input.textFeature)
        return { requestId: 'request-2', motion: makeMotion() }
      },
    },
  })

  await service.generate({
    cacheKey: feature.cacheKey,
    canonicalPrompt: feature.canonicalPrompt,
    numFrames: 20,
    numDenoisingSteps: 2,
    cfgWeight: 1.5,
  })

  assert.deepEqual(resolveCalls, ['new.motion:new motion'])
  assert.deepEqual(backendFeatures, [feature])
})

test('motion generation service reports cache-only misses and rejects concurrent generation', async () => {
  const cache = new MemoryMotionSemanticFeatureCache()
  let releaseGate: ((result: ArdyMotionResult) => void) | undefined
  const gate = new Promise<ArdyMotionResult>(resolve => {
    releaseGate = resolve
  })
  const service = new MotionGenerationService({
    cache,
    backend: { generate: async () => gate },
  })

  const first = service.generate({
    cacheKey: 'missing.motion',
    canonicalPrompt: 'missing motion',
    numFrames: 20,
    numDenoisingSteps: 2,
    cfgWeight: 1,
  })
  await assert.rejects(first, /cache miss.*Text Encoder unavailable/i)

  cache.set(makeFeature())
  const active = service.generate({
    cacheKey: 'wave.casual',
    canonicalPrompt: 'casually wave',
    numFrames: 20,
    numDenoisingSteps: 2,
    cfgWeight: 1,
  })
  await assert.rejects(service.generate({
    cacheKey: 'wave.casual',
    canonicalPrompt: 'casually wave',
    numFrames: 20,
    numDenoisingSteps: 2,
    cfgWeight: 1,
  }), /already has an active generation/i)
  releaseGate?.({ requestId: 'request-3', motion: makeMotion() })
  await active
})

test('motion generation service forwards abort signals to the backend', async () => {
  const feature = makeFeature()
  const controller = new AbortController()
  let observedSignal: AbortSignal | undefined
  let backendStartedResolve: (() => void) | undefined
  const backendStarted = new Promise<void>(resolve => {
    backendStartedResolve = resolve
  })
  const service = new MotionGenerationService({
    cache: new MemoryMotionSemanticFeatureCache([feature]),
    backend: {
      generate: async (input) => {
        observedSignal = input.signal
        backendStartedResolve?.()
        await new Promise<void>((resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(new Error('backend aborted')), { once: true })
          if (input.signal?.aborted) reject(new Error('backend aborted'))
          else setTimeout(resolve, 100)
        })
        return { requestId: 'never', motion: makeMotion() }
      },
    },
  })

  const pending = service.generate({
    cacheKey: feature.cacheKey,
    canonicalPrompt: feature.canonicalPrompt,
    numFrames: 20,
    numDenoisingSteps: 2,
    cfgWeight: 1,
    signal: controller.signal,
  })
  await backendStarted
  controller.abort()

  await assert.rejects(pending, /abort/i)
  assert.equal(observedSignal, controller.signal)
})
