import assert from 'node:assert/strict'
import test from 'node:test'

import type { MotionSemanticFeature } from '@rayure/protocol'

import {
  CachedMotionSemanticFeatureResolver,
  MemoryMotionSemanticFeatureCache,
} from '../src/motion-semantic-cache.ts'

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

test('memory feature cache returns validated entries by cache key', () => {
  const feature = makeFeature()
  const cache = new MemoryMotionSemanticFeatureCache([feature])

  assert.equal(cache.get('wave.casual'), feature)
  assert.equal(cache.get('missing'), undefined)
  assert.equal(cache.size, 1)
})

test('resolver uses a matching cache entry without calling the encoder', async () => {
  const feature = makeFeature()
  const cache = new MemoryMotionSemanticFeatureCache([feature])
  let encodeCalls = 0
  const resolver = new CachedMotionSemanticFeatureResolver({
    cache,
    encoder: {
      async encode() {
        encodeCalls += 1
        return feature
      },
    },
  })

  const resolved = await resolver.resolve({ cacheKey: 'wave.casual', canonicalPrompt: 'casually wave' })
  assert.equal(resolved, feature)
  assert.equal(encodeCalls, 0)
})

test('resolver encodes a cache miss and stores the returned feature', async () => {
  const feature = makeFeature('scratch.head', 'awkwardly scratch head')
  const cache = new MemoryMotionSemanticFeatureCache()
  let receivedSignal: AbortSignal | undefined
  const resolver = new CachedMotionSemanticFeatureResolver({
    cache,
    encoder: {
      async encode(input) {
        receivedSignal = input.signal
        return feature
      },
    },
  })
  const controller = new AbortController()

  const resolved = await resolver.resolve({
    cacheKey: 'scratch.head',
    canonicalPrompt: 'awkwardly scratch head',
    signal: controller.signal,
  })
  assert.equal(resolved, feature)
  assert.equal(receivedSignal, controller.signal)
  assert.equal(cache.get('scratch.head'), feature)
})

test('resolver rejects encoder results that do not match the requested identity', async () => {
  const cache = new MemoryMotionSemanticFeatureCache()
  const resolver = new CachedMotionSemanticFeatureResolver({
    cache,
    encoder: {
      async encode() {
        return makeFeature('other.key', 'different prompt')
      },
    },
  })

  await assert.rejects(
    resolver.resolve({ cacheKey: 'wave.casual', canonicalPrompt: 'casually wave' }),
    /identity|cacheKey|canonicalPrompt/i,
  )
  assert.equal(cache.size, 0)
})
