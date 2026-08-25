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

/**
 * Builds a multi-frame motion whose every joint rides the z axis, so the whole
 * body's displacement is exactly `travel` over the frame count. `travel = 0`
 * yields fully static (degenerate) output; a real gesture travels ~0.4m.
 */
function makeRisingMotion(frameCount: number, travel: number): CanonicalMotion {
  const base = makeMotion()
  const frames = Array.from({ length: frameCount }, (_, i) => {
    const z = travel === 0 ? 0.5 : 0.5 + (travel * i) / (frameCount - 1)
    const joints = Object.fromEntries(CANONICAL_ARDY_CORE_JOINT_NAMES.map(name => [name, {
      position: [0, 1, z] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
    }]))
    return {
      timeMs: Math.round((i * 1000) / base.fps),
      rootPosition: [0, 0, 0] as [number, number, number],
      rootRotation: [0, 0, 0, 1] as [number, number, number, number],
      joints,
    }
  })
  return { ...base, frames }
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
  // The ARDY build refuses to rehydrate pose from JSON frames, so consumed
  // history is never forwarded; only constraints (and opaque continuation)
  // ride along.
  assert.equal(captured[0]?.history, undefined)
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

test('motion generation service reuses a generated motion for an identical prompt with a fresh cacheKey', async () => {
  const feature = makeFeature('wave.casual', 'A person waves their hand casually')
  const cache = new MemoryMotionSemanticFeatureCache([feature])
  let backendCalls = 0
  const service = new MotionGenerationService({
    cache,
    backend: {
      generate: async () => {
        backendCalls += 1
        return { requestId: 'request-wave', motion: makeMotion() }
      },
    },
  })

  const first = await service.generate({
    cacheKey: 'wave.casual',
    canonicalPrompt: 'A person waves their hand casually',
    numFrames: 60,
    numDenoisingSteps: 4,
    cfgWeight: 2,
  })
  // The wizard sends a fresh intent id for the same preset prompt; the
  // generated motion must be served from cache, not regenerated.
  const second = await service.generate({
    cacheKey: 'wizard-request-9f2b4c1d',
    canonicalPrompt: 'A person waves their hand casually',
    numFrames: 60,
    numDenoisingSteps: 4,
    cfgWeight: 2,
  })

  assert.equal(backendCalls, 1)
  assert.equal(first.motion, second.motion)
})

test('motion generation service regenerates when generation parameters differ', async () => {
  const feature = makeFeature('walk.forward', 'walk forward')
  const cache = new MemoryMotionSemanticFeatureCache([feature])
  let backendCalls = 0
  const service = new MotionGenerationService({
    cache,
    backend: {
      generate: async () => {
        backendCalls += 1
        return { requestId: 'request-walk', motion: makeMotion() }
      },
    },
  })
  const base = {
    cacheKey: 'walk.forward',
    canonicalPrompt: 'walk forward',
    numFrames: 60,
    numDenoisingSteps: 4,
    cfgWeight: 2,
  }

  await service.generate(base)
  await service.generate({ ...base, numFrames: 120 })
  await service.generate({ ...base, numDenoisingSteps: 6 })
  await service.generate({ ...base, cfgWeight: 3 })

  assert.equal(backendCalls, 4)
})

test('motion generation service never caches history, continuation or constrained generations', async () => {
  const feature = makeFeature('wave.casual', 'casually wave')
  const cache = new MemoryMotionSemanticFeatureCache([feature])
  let backendCalls = 0
  const service = new MotionGenerationService({
    cache,
    backend: {
      generate: async () => {
        backendCalls += 1
        return { requestId: 'request-n', motion: makeMotion() }
      },
    },
  })
  const base = {
    cacheKey: 'wave.casual',
    canonicalPrompt: 'casually wave',
    numFrames: 20,
    numDenoisingSteps: 2,
    cfgWeight: 1,
  }

  await service.generate(base)
  await service.generate({ ...base, history: makeMotion() })
  await service.generate({ ...base, continuation: { id: 'bridge-prior-1', consumedFrameCount: 5 } })
  await service.generate({
    ...base,
    constraints: [{ timeMs: 0, joint: 'RightHand', position: [0, 1, 0] as const }],
  })
  // The stateful variants must not have seeded the cache; only the first
  // unconstrained call did, so the final identical call is a cache hit.
  await service.generate(base)

  assert.equal(backendCalls, 4)
})

test('motion generation service evicts the oldest cached result at the cap', async () => {
  const features = Array.from({ length: 33 }, (_, i) => makeFeature(`prompt.${i}`, `prompt ${i}`))
  const cache = new MemoryMotionSemanticFeatureCache(features)
  let backendCalls = 0
  const service = new MotionGenerationService({
    cache,
    backend: {
      generate: async () => {
        backendCalls += 1
        return { requestId: 'request-x', motion: makeMotion() }
      },
    },
  })

  for (let i = 0; i < 33; i += 1) {
    await service.generate({
      cacheKey: `prompt.${i}`,
      canonicalPrompt: `prompt ${i}`,
      numFrames: 20,
      numDenoisingSteps: 2,
      cfgWeight: 1,
    })
  }
  // The 33rd insert evicted prompt.0; regenerating it re-inserts at the tail
  // and evicts prompt.1 (oldest insertion order, reads do not refresh it).
  await service.generate({
    cacheKey: 'prompt.0',
    canonicalPrompt: 'prompt 0',
    numFrames: 20,
    numDenoisingSteps: 2,
    cfgWeight: 1,
  })
  await service.generate({
    cacheKey: 'prompt.2',
    canonicalPrompt: 'prompt 2',
    numFrames: 20,
    numDenoisingSteps: 2,
    cfgWeight: 1,
  })

  assert.equal(backendCalls, 34)
})

test('motion generation service returns a cached result while another generation is active', async () => {
  const waveFeature = makeFeature('wave.casual', 'casually wave')
  const walkFeature = makeFeature('walk.forward', 'walk forward')
  const cache = new MemoryMotionSemanticFeatureCache([waveFeature, walkFeature])
  let releaseWalk: ((result: ArdyMotionResult) => void) | undefined
  const walkGate = new Promise<ArdyMotionResult>(resolve => {
    releaseWalk = resolve
  })
  let waveBackendCalls = 0
  const service = new MotionGenerationService({
    cache,
    backend: {
      generate: async (input) => {
        if (input.textFeature.cacheKey === 'wave.casual') {
          waveBackendCalls += 1
          return { requestId: 'request-wave', motion: makeMotion() }
        }
        return walkGate
      },
    },
  })

  await service.generate({
    cacheKey: 'wave.casual',
    canonicalPrompt: 'casually wave',
    numFrames: 20,
    numDenoisingSteps: 2,
    cfgWeight: 1,
  })
  assert.equal(waveBackendCalls, 1)

  const walking = service.generate({
    cacheKey: 'walk.forward',
    canonicalPrompt: 'walk forward',
    numFrames: 20,
    numDenoisingSteps: 2,
    cfgWeight: 1,
  })
  const cached = await service.generate({
    cacheKey: 'wave.casual',
    canonicalPrompt: 'casually wave',
    numFrames: 20,
    numDenoisingSteps: 2,
    cfgWeight: 1,
  })

  assert.equal(cached.requestId, 'request-wave')
  assert.equal(waveBackendCalls, 1)
  releaseWalk?.({ requestId: 'request-walk', motion: makeMotion() })
  await walking
})

test('motion generation service falls back to a prompt match when the cacheKey misses', async () => {
  const feature = makeFeature('wave.casual', 'A person waves their hand casually')
  const cache = new MemoryMotionSemanticFeatureCache([feature])
  let backendCalls = 0
  const service = new MotionGenerationService({
    cache,
    backend: {
      generate: async () => {
        backendCalls += 1
        return { requestId: 'request-wave', motion: makeMotion() }
      },
    },
  })

  const result = await service.generate({
    // The wizard's intent id is random; only the prompt identifies the cached feature.
    cacheKey: 'wizard-request-7e1a5c09',
    canonicalPrompt: 'A person waves their hand casually',
    numFrames: 60,
    numDenoisingSteps: 4,
    cfgWeight: 2,
  })

  assert.equal(result.requestId, 'request-wave')
  assert.equal(backendCalls, 1)
})

test('motion generation service rejects a prompt with no cached feature and no encoder', async () => {
  const cache = new MemoryMotionSemanticFeatureCache([makeFeature('wave.casual', 'casually wave')])
  const service = new MotionGenerationService({
    cache,
    backend: {
      generate: async () => {
        throw new Error('backend must not run')
      },
    },
  })

  await assert.rejects(service.generate({
    cacheKey: 'wizard-request-unknown',
    canonicalPrompt: 'A prompt never cached anywhere',
    numFrames: 20,
    numDenoisingSteps: 2,
    cfgWeight: 1,
  }), /cache miss.*Text Encoder unavailable/i)
})

test('motion generation service forwards opaque continuation state without reusing Canonical JSON history', async () => {
  const feature = makeFeature()
  let captured: ArdyProcessGenerationInput | undefined
  const service = new MotionGenerationService({
    cache: new MemoryMotionSemanticFeatureCache([feature]),
    backend: {
      generate: async (input) => {
        captured = input
        return { requestId: 'continued', motion: makeMotion(), continuationId: 'bridge-next-1' }
      },
    },
  })

  const result = await service.generate({
    cacheKey: feature.cacheKey,
    canonicalPrompt: feature.canonicalPrompt,
    numFrames: 20,
    numDenoisingSteps: 2,
    cfgWeight: 1,
    continuation: { id: 'bridge-prior-1', consumedFrameCount: 7 },
  })
  assert.deepEqual(captured?.continuation, { id: 'bridge-prior-1', consumedFrameCount: 7 })
  assert.equal(captured?.history, undefined)
  assert.equal(result.continuationId, 'bridge-next-1')
})

test('motion generation service restarts a degraded backend and retries once', async () => {
  const feature = makeFeature()
  const cache = new MemoryMotionSemanticFeatureCache([feature])
  const degenerate = makeRisingMotion(40, 0)
  const healthy = makeRisingMotion(40, 0.4)
  const restarts: string[] = []
  const service = new MotionGenerationService({
    cache,
    backend: {
      generate: async () => ({ requestId: 'degraded', motion: degenerate }),
    },
    onBackendDegraded: async () => {
      restarts.push('restart')
      return { generate: async () => ({ requestId: 'healthy', motion: healthy }) }
    },
  })

  const result = await service.generate({
    cacheKey: feature.cacheKey,
    canonicalPrompt: feature.canonicalPrompt,
    numFrames: 40,
    numDenoisingSteps: 4,
    cfgWeight: 2,
  })

  assert.equal(restarts.length, 1)
  assert.equal(result.requestId, 'healthy')
})

test('motion generation service keeps a degenerate result when the restart fails', async () => {
  const feature = makeFeature()
  const cache = new MemoryMotionSemanticFeatureCache([feature])
  const restarts: string[] = []
  const service = new MotionGenerationService({
    cache,
    backend: {
      generate: async () => ({ requestId: 'degraded', motion: makeRisingMotion(40, 0) }),
    },
    onBackendDegraded: async () => {
      restarts.push('restart')
      return undefined
    },
  })

  const result = await service.generate({
    cacheKey: feature.cacheKey,
    canonicalPrompt: feature.canonicalPrompt,
    numFrames: 40,
    numDenoisingSteps: 4,
    cfgWeight: 2,
  })

  assert.equal(restarts.length, 1)
  assert.equal(result.requestId, 'degraded')
})

test('motion generation service retries a degenerate generation that carried history', async () => {
  // A continued generation is never cacheable, so this one rides the generate
  // path even though its history is never forwarded to the bridge; the output
  // is still a fresh gesture and must be auto-healed like any other.
  const feature = makeFeature()
  const cache = new MemoryMotionSemanticFeatureCache([feature])
  const restarts: string[] = []
  const service = new MotionGenerationService({
    cache,
    backend: {
      generate: async () => ({ requestId: 'degraded-history', motion: makeRisingMotion(40, 0) }),
    },
    onBackendDegraded: async () => {
      restarts.push('restart')
      return { generate: async () => ({ requestId: 'healthy-history', motion: makeRisingMotion(40, 0.4) }) }
    },
  })

  const result = await service.generate({
    cacheKey: feature.cacheKey,
    canonicalPrompt: feature.canonicalPrompt,
    numFrames: 40,
    numDenoisingSteps: 4,
    cfgWeight: 2,
    history: makeMotion(),
  })

  assert.equal(restarts.length, 1)
  assert.equal(result.requestId, 'healthy-history')
})

test('motion generation service retries a degenerate continuation by dropping it for a fresh segment', async () => {
  // The scheduler chains generations through opaque continuation ids, so the
  // service sees a continuation on most calls. On a degenerate output the
  // continuation dies with the restarted bridge, and the ARDY build refuses to
  // rehydrate pose from JSON history, so the retry must be a pure fresh
  // generation: drop the dead id AND the consumed frames.
  const feature = makeFeature()
  const cache = new MemoryMotionSemanticFeatureCache([feature])
  const history = makeMotion()
  const restarts: string[] = []
  const sentInputs: ArdyProcessGenerationInput[] = []
  const service = new MotionGenerationService({
    cache,
    backend: {
      generate: async (input) => {
        sentInputs.push(input)
        return { requestId: `degraded-${sentInputs.length}`, motion: makeRisingMotion(40, 0) }
      },
    },
    onBackendDegraded: async () => {
      restarts.push('restart')
      return {
        generate: async (input) => {
          sentInputs.push(input)
          return { requestId: 'healed', motion: makeRisingMotion(40, 0.4) }
        },
      }
    },
  })

  const result = await service.generate({
    cacheKey: feature.cacheKey,
    canonicalPrompt: feature.canonicalPrompt,
    numFrames: 40,
    numDenoisingSteps: 4,
    cfgWeight: 2,
    history,
    continuation: { id: 'bridge-prior-1', consumedFrameCount: 7 },
  })

  assert.equal(restarts.length, 1)
  assert.equal(result.requestId, 'healed')
  // First attempt rode the opaque continuation; the retry dropped it and sent
  // neither the dead id nor JSON history — a fresh segment on the new bridge.
  assert.deepEqual(sentInputs[0]?.continuation, { id: 'bridge-prior-1', consumedFrameCount: 7 })
  assert.equal(sentInputs[0]?.history, undefined)
  assert.equal(sentInputs[1]?.continuation, undefined)
  assert.equal(sentInputs[1]?.history, undefined)
})

test('motion generation service never caches a degenerate result', async () => {
  const feature = makeFeature()
  const cache = new MemoryMotionSemanticFeatureCache([feature])
  let backendCalls = 0
  const service = new MotionGenerationService({
    cache,
    backend: {
      generate: async () => {
        backendCalls += 1
        return { requestId: `degenerate-${backendCalls}`, motion: makeRisingMotion(40, 0) }
      },
    },
  })
  const base = {
    cacheKey: feature.cacheKey,
    canonicalPrompt: feature.canonicalPrompt,
    numFrames: 40,
    numDenoisingSteps: 4,
    cfgWeight: 2,
  }

  const first = await service.generate(base)
  assert.equal(first.requestId, 'degenerate-1')
  // A second identical request must NOT be served from cache: a cached
  // near-static result would keep replaying the degraded motion forever.
  const second = await service.generate(base)
  assert.equal(second.requestId, 'degenerate-2')
  assert.equal(backendCalls, 2)
})

test('motion generation service never retries scene-constrained degenerate generations', async () => {
  const feature = makeFeature()
  const cache = new MemoryMotionSemanticFeatureCache([feature])
  const restarts: string[] = []
  const service = new MotionGenerationService({
    cache,
    backend: {
      generate: async () => ({ requestId: 'constrained', motion: makeRisingMotion(40, 0) }),
    },
    onBackendDegraded: async () => {
      restarts.push('restart')
      return undefined
    },
  })

  const result = await service.generate({
    cacheKey: feature.cacheKey,
    canonicalPrompt: feature.canonicalPrompt,
    numFrames: 40,
    numDenoisingSteps: 4,
    cfgWeight: 2,
    constraints: [{ timeMs: 0, joint: 'RightHand', position: [0, 1, 0] as const }],
  })

  assert.equal(restarts.length, 0)
  assert.equal(result.requestId, 'constrained')
})
