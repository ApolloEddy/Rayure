import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { MotionSemanticFeature } from '@rayure/protocol'

import { serializeMotionSemanticFeatureCache, writeMotionSemanticFeatureCacheFile } from '../src/motion-semantic-cache-file.ts'
import { groupOfCacheKey, MOTION_SEMANTIC_INDEX_SCHEMA } from '../src/motion-semantic-cache-shard.ts'
import { createShardedMotionSemanticFeatureCache } from '../src/motion-semantic-cache-shard.ts'
import { createMotionSemanticRuntime } from '../src/motion-semantic-runtime.ts'
import { ShardedMotionSemanticFeatureCache } from '../src/motion-semantic-cache-shard.ts'
import { MemoryMotionSemanticFeatureCache } from '../src/motion-semantic-cache.ts'

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

function indexFor(entries: readonly { cacheKey: string; canonicalPrompt: string; group: string }[]): string {
  const shards = new Map<string, string>()
  for (const entry of entries) shards.set(entry.group, `motion-features.${entry.group}.json`)
  return JSON.stringify({
    schema: MOTION_SEMANTIC_INDEX_SCHEMA,
    entries,
    shards: Object.fromEntries(shards),
  })
}

test('groupOfCacheKey matches the offline split tool rule', () => {
  assert.equal(groupOfCacheKey('wave.casual'), 'wave')
  assert.equal(groupOfCacheKey('wave.casual.loop'), 'wave')
  assert.equal(groupOfCacheKey('run'), 'misc')
  assert.equal(groupOfCacheKey('daily.walk'), 'daily')
  assert.equal(groupOfCacheKey('windows:unsafe.walk'), 'misc')
  assert.equal(groupOfCacheKey(`${'a'.repeat(65)}.walk`), 'misc')
})

test('sharded cache loads a shard lazily and serves hits and misses', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-shard-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const indexPath = join(root, 'motion-features.index.json')
  const wave = makeFeature('wave.casual', 'casually wave')
  await writeMotionSemanticFeatureCacheFile(join(root, 'motion-features.wave.json'), [wave])
  await writeFile(indexPath, indexFor([
    { cacheKey: 'wave.casual', canonicalPrompt: 'casually wave', group: 'wave' },
    { cacheKey: 'walk.brisk', canonicalPrompt: 'walk briskly', group: 'walk' },
  ]))

  const cache = await createShardedMotionSemanticFeatureCache(indexPath)
  assert.equal(cache.size, 2)
  assert.deepEqual(cache.get('wave.casual'), wave)
  assert.equal(cache.get('wave.casual')?.canonicalPrompt, 'casually wave')
  assert.equal(cache.get('run.sprint'), undefined)
  assert.deepEqual(cache.findByCanonicalPrompt('casually wave'), wave)
  assert.equal(cache.findByCanonicalPrompt('nope'), undefined)
})

test('sharded cache persists only dirty shards and rewrites the index on new keys', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-shard-persist-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const indexPath = join(root, 'motion-features.index.json')
  const wavePath = join(root, 'motion-features.wave.json')
  await writeMotionSemanticFeatureCacheFile(wavePath, [makeFeature('wave.casual', 'casually wave')])
  await writeFile(indexPath, indexFor([
    { cacheKey: 'wave.casual', canonicalPrompt: 'casually wave', group: 'wave' },
  ]))

  const cache = await createShardedMotionSemanticFeatureCache(indexPath)
  cache.set(makeFeature('wave.bye', 'wave goodbye'))
  cache.set(makeFeature('sit.down', 'sit down'))
  await cache.persist()

  const persistedIndex = JSON.parse(await readFile(indexPath, 'utf8')) as {
    entries: readonly { cacheKey: string; group: string }[]
    shards: Record<string, string>
  }
  assert.deepEqual(
    persistedIndex.entries.map((entry) => entry.cacheKey).sort(),
    ['sit.down', 'wave.bye', 'wave.casual'],
  )
  assert.deepEqual(Object.keys(persistedIndex.shards).sort(), ['sit', 'wave'])

  const waveShard = JSON.parse(await readFile(wavePath, 'utf8')) as { entries: readonly { cacheKey: string }[] }
  assert.deepEqual(waveShard.entries.map((entry) => entry.cacheKey).sort(), ['wave.bye', 'wave.casual'])
  const sitShard = JSON.parse(await readFile(join(root, 'motion-features.sit.json'), 'utf8')) as {
    entries: readonly { cacheKey: string }[]
  }
  assert.deepEqual(sitShard.entries.map((entry) => entry.cacheKey), ['sit.down'])

  // A reload sees everything from the rewritten index + shards.
  const reloaded = await createShardedMotionSemanticFeatureCache(indexPath)
  assert.equal(reloaded.size, 3)
  assert.equal(reloaded.get('sit.down')?.canonicalPrompt, 'sit down')
})

test('runtime picks the sharded cache for an index layout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-runtime-shard-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cachePath = join(root, 'motion-features.index.json')
  await writeMotionSemanticFeatureCacheFile(join(root, 'motion-features.wave.json'), [makeFeature('wave.casual', 'casually wave')])
  await writeFile(cachePath, indexFor([
    { cacheKey: 'wave.casual', canonicalPrompt: 'casually wave', group: 'wave' },
  ]))

  const runtime = await createMotionSemanticRuntime({ cachePath })
  assert.ok(runtime.cache instanceof ShardedMotionSemanticFeatureCache)
  assert.equal(runtime.cache.size, 1)
  assert.equal(runtime.cache.get('wave.casual')?.canonicalPrompt, 'casually wave')
  await runtime.persist()
})

test('runtime keeps the legacy single-file layout working', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-runtime-legacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cachePath = join(root, 'motion-features.json')
  await writeFile(cachePath, serializeMotionSemanticFeatureCache([makeFeature('wave.casual', 'casually wave')]))

  const runtime = await createMotionSemanticRuntime({ cachePath })
  assert.ok(runtime.cache instanceof MemoryMotionSemanticFeatureCache)
  assert.equal(runtime.cache.size, 1)
  runtime.cache.set(makeFeature('run.sprint', 'sprint'))
  await runtime.persist()
  const persisted = JSON.parse(await readFile(cachePath, 'utf8')) as { entries: readonly unknown[] }
  assert.equal(persisted.entries.length, 2)
})
