import assert from 'node:assert/strict'
import test from 'node:test'

import type { MotionSemanticFeature } from '@rayure/protocol'

import {
  TEXT_ENCODER_RESPONSE_SCHEMA,
  TextEncoderApiClient,
} from '../src/text-encoder-client.ts'
import { serializeMotionSemanticFeatureCache } from '../src/motion-semantic-cache-file.ts'

function makeFeature(): MotionSemanticFeature {
  return {
    schema: 'rayure.motion-semantic-feature.v1',
    cacheKey: 'wave.casual',
    canonicalPrompt: 'casually wave',
    encoderId: 'remote-llm2vec',
    encoderVersion: 'remote-v1',
    dtype: 'float16',
    tokenCount: 1,
    featureDimension: 4096,
    values: Array.from({ length: 4096 }, () => 0.125),
    textPadMask: [true],
    createdAtMs: 1_750_000_000_000,
  }
}

function responseFor(feature: MotionSemanticFeature, status = 200): Response {
  const cacheFile = JSON.parse(serializeMotionSemanticFeatureCache([feature])) as {
    entries: readonly [Record<string, unknown>]
  }
  return new Response(JSON.stringify({
    schema: TEXT_ENCODER_RESPONSE_SCHEMA,
    feature: cacheFile.entries[0],
  }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('Text Encoder API client posts the versioned prompt contract and decodes a feature', async () => {
  const feature = makeFeature()
  let requestUrl = ''
  let requestBody: Record<string, unknown> | undefined
  const client = new TextEncoderApiClient({
    endpoint: 'http://127.0.0.1:9550/encode',
    fetchImplementation: async (input, init) => {
      requestUrl = String(input)
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return responseFor(feature)
    },
  })

  const result = await client.encode({ cacheKey: 'wave.casual', canonicalPrompt: 'casually wave' })
  assert.equal(result.cacheKey, feature.cacheKey)
  assert.equal(requestUrl, 'http://127.0.0.1:9550/encode')
  assert.deepEqual(requestBody, {
    schema: 'rayure.text-encoder-request.v1',
    cacheKey: 'wave.casual',
    canonicalPrompt: 'casually wave',
  })
})

test('Text Encoder API client rejects unsafe endpoints and mismatched responses', async () => {
  assert.throws(() => new TextEncoderApiClient({ endpoint: 'http://encoder.example.test/encode' }), /HTTPS|endpoint/i)
  assert.throws(() => new TextEncoderApiClient({ endpoint: 'https://user:pass@encoder.example.test/encode' }), /credential|endpoint/i)
  assert.throws(() => new TextEncoderApiClient({ endpoint: 'https://encoder.example.test/encode?token=secret' }), /query|endpoint/i)

  const wrong = makeFeature()
  wrong.cacheKey = 'other.key'
  const client = new TextEncoderApiClient({
    endpoint: 'https://encoder.example.test/encode',
    fetchImplementation: async () => responseFor(wrong),
  })
  await assert.rejects(
    client.encode({ cacheKey: 'wave.casual', canonicalPrompt: 'casually wave' }),
    /identity|cacheKey|canonicalPrompt/i,
  )
})

test('Text Encoder API client reports HTTP failures and supports cancellation', async () => {
  const client = new TextEncoderApiClient({
    endpoint: 'http://localhost:9550/encode',
    fetchImplementation: async (_input, init) => {
      assert.ok(init?.signal)
      return responseFor(makeFeature(), 503)
    },
  })
  await assert.rejects(
    client.encode({ cacheKey: 'wave.casual', canonicalPrompt: 'casually wave' }),
    /status 503/i,
  )

  const controller = new AbortController()
  controller.abort()
  const cancelled = new TextEncoderApiClient({
    endpoint: 'http://[::1]:9550/encode',
    fetchImplementation: async (_input, init) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return responseFor(makeFeature())
    },
  })
  await assert.rejects(
    cancelled.encode({ cacheKey: 'wave.casual', canonicalPrompt: 'casually wave', signal: controller.signal }),
    /abort/i,
  )
})
