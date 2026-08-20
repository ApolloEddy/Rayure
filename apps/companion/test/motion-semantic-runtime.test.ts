import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { MotionSemanticFeature } from '@rayure/protocol'

import { serializeMotionSemanticFeatureCache } from '../src/motion-semantic-cache-file.ts'
import { createMotionSemanticRuntime } from '../src/motion-semantic-runtime.ts'
import { TEXT_ENCODER_RESPONSE_SCHEMA } from '../src/text-encoder-client.ts'

function makeFeature(cacheKey: string, prompt: string): MotionSemanticFeature {
  return {
    schema: 'rayure.motion-semantic-feature.v1',
    cacheKey,
    canonicalPrompt: prompt,
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

function responseFor(feature: MotionSemanticFeature): Response {
  const root = JSON.parse(serializeMotionSemanticFeatureCache([feature])) as {
    entries: readonly [Record<string, unknown>]
  }
  return new Response(JSON.stringify({
    schema: TEXT_ENCODER_RESPONSE_SCHEMA,
    feature: root.entries[0],
  }))
}

test('motion semantic runtime loads a prebuilt cache and persists API misses', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-motion-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cachePath = join(root, 'motion-features.json')
  await writeFile(cachePath, serializeMotionSemanticFeatureCache([
    makeFeature('wave.casual', 'casually wave'),
  ]))

  const generated = makeFeature('scratch.head', 'awkwardly scratch head')
  let fetchCalls = 0
  const runtime = await createMotionSemanticRuntime({
    cachePath,
    textEncoder: {
      endpoint: 'http://127.0.0.1:9550/encode',
      timeoutMs: 1_000,
    },
  }, {
    fetchImplementation: async () => {
      fetchCalls += 1
      return responseFor(generated)
    },
  })

  assert.ok(runtime.resolver)
  await runtime.resolver.resolve({ cacheKey: 'wave.casual', canonicalPrompt: 'casually wave' })
  assert.equal(fetchCalls, 0)
  await runtime.resolver.resolve({ cacheKey: 'scratch.head', canonicalPrompt: 'awkwardly scratch head' })
  assert.equal(fetchCalls, 1)
  assert.equal(runtime.cache.size, 2)

  const persisted = JSON.parse(await readFile(cachePath, 'utf8')) as { entries: readonly unknown[] }
  assert.equal(persisted.entries.length, 2)
})

test('motion semantic runtime can run cache-only without an encoder', async () => {
  const runtime = await createMotionSemanticRuntime({})
  assert.equal(runtime.resolver, undefined)
  assert.equal(runtime.cache.size, 0)
  await assert.doesNotReject(runtime.persist())
})
