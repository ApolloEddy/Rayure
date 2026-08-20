import assert from 'node:assert/strict'
import test from 'node:test'

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MotionSemanticFeature } from '@rayure/protocol'

import {
  loadMotionSemanticFeatureCacheFile,
  serializeMotionSemanticFeatureCache,
  writeMotionSemanticFeatureCacheFile,
} from '../src/motion-semantic-cache-file.ts'

function makeFeature(
  cacheKey: string,
  dtype: MotionSemanticFeature['dtype'],
): MotionSemanticFeature {
  const tokenCount = 3
  return {
    schema: 'rayure.motion-semantic-feature.v1',
    cacheKey,
    canonicalPrompt: `prompt for ${cacheKey}`,
    encoderId: 'fixture-encoder',
    encoderVersion: 'fixture-v1',
    dtype,
    tokenCount,
    featureDimension: 4096,
    values: Array.from({ length: tokenCount * 4096 }, (_, index) => (index % 17 - 8) / 8),
    textPadMask: [true, true, false],
    createdAtMs: 1_750_000_000_000,
  }
}

test('feature cache file round-trips FP16 values and a packed token mask', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-feature-cache-'))
  const filePath = join(root, 'motion-features.json')
  const source = makeFeature('wave.casual', 'float16')

  await writeMotionSemanticFeatureCacheFile(filePath, [source])
  const loaded = await loadMotionSemanticFeatureCacheFile(filePath)
  const result = loaded[0]!

  assert.equal(result.cacheKey, source.cacheKey)
  assert.equal(result.textPadMask.join(','), 'true,true,false')
  assert.equal(result.values.length, source.values.length)
  assert.ok(Math.abs(result.values[0]! - source.values[0]!) < 0.01)
  assert.ok(Math.abs(result.values[100]! - source.values[100]!) < 0.01)

  const raw = await readFile(filePath, 'utf8')
  assert.match(raw, /valuesBase64/)
  assert.doesNotMatch(raw, /0\.25,0\.375/)
})

test('feature cache file round-trips FP32 values without precision loss', async () => {
  const source = makeFeature('scratch.head', 'float32')
  const serialized = serializeMotionSemanticFeatureCache([source])
  const root = await mkdtemp(join(tmpdir(), 'rayure-feature-cache-'))
  const filePath = join(root, 'motion-features.json')
  await writeMotionSemanticFeatureCacheFile(filePath, [source])
  const loaded = await loadMotionSemanticFeatureCacheFile(filePath)

  assert.equal(loaded[0]!.values[123], source.values[123])
  assert.match(serialized, /rayure\.motion-semantic-cache\.v1/)
})

test('feature cache file rejects duplicate keys, unknown fields and malformed payloads', async () => {
  const source = makeFeature('wave.casual', 'float32')
  const serialized = JSON.parse(serializeMotionSemanticFeatureCache([source])) as Record<string, unknown>
  const entries = serialized.entries as Array<Record<string, unknown>>
  entries.push({ ...entries[0] })
  const root = await mkdtemp(join(tmpdir(), 'rayure-feature-cache-'))
  const filePath = join(root, 'invalid.json')
  await writeMotionSemanticFeatureCacheFile(filePath, [])

  await writeFile(filePath, JSON.stringify(serialized), 'utf8')
  await assert.rejects(loadMotionSemanticFeatureCacheFile(filePath), /duplicate/i)

  const unknown = JSON.parse(serializeMotionSemanticFeatureCache([source])) as Record<string, unknown>
  unknown.extra = true
  await writeFile(filePath, JSON.stringify(unknown), 'utf8')
  await assert.rejects(loadMotionSemanticFeatureCacheFile(filePath), /unknown/i)

  const malformed = JSON.parse(serializeMotionSemanticFeatureCache([source])) as Record<string, unknown>
  const malformedEntries = malformed.entries as Array<Record<string, unknown>>
  malformedEntries[0]!.valuesBase64 = 'not-base64'
  await writeFile(filePath, JSON.stringify(malformed), 'utf8')
  await assert.rejects(loadMotionSemanticFeatureCacheFile(filePath), /base64|payload|values/i)
})
