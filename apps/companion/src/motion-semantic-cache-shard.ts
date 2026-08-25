import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { MotionSemanticFeature } from '@rayure/protocol'

import {
  loadMotionSemanticFeatureCacheFileSync,
  writeMotionSemanticFeatureCacheFile,
} from './motion-semantic-cache-file.ts'
import {
  MemoryMotionSemanticFeatureCache,
  requireCacheKey,
  requireCanonicalPrompt,
} from './motion-semantic-cache.ts'
import type { MotionSemanticFeatureCache } from './motion-semantic-cache.ts'

export const MOTION_SEMANTIC_INDEX_SCHEMA = 'rayure.motion-semantic-index.v1' as const

export interface MotionSemanticIndexEntry {
  cacheKey: string
  canonicalPrompt: string
  group: string
}

export interface MotionSemanticIndex {
  schema: typeof MOTION_SEMANTIC_INDEX_SCHEMA
  entries: readonly MotionSemanticIndexEntry[]
  shards: Readonly<Record<string, string>>
}

/**
 * Shard key of a cache entry. Must stay in lockstep with the offline split tool
 * `D:\Dev\ardy-spike\split_motion_cache.py`: the cacheKey prefix before the
 * first '.', else the fallback group `misc`.
 */
export function groupOfCacheKey(cacheKey: string): string {
  const key = requireCacheKey(cacheKey)
  const dot = key.indexOf('.')
  if (dot > 0) {
    const prefix = key.slice(0, dot)
    // Cache keys allow ':' for wire identity, but Windows filenames do not.
    // Unsafe/overlong prefixes share the bounded misc shard.
    if (/^[A-Za-z0-9_-]{1,64}$/u.test(prefix)) return prefix
  }
  return 'misc'
}

export function parseMotionSemanticIndex(raw: string): MotionSemanticIndex {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    throw new Error('Motion semantic feature index must contain valid JSON')
  }
  const root = requireRecord(parsed, 'motion semantic feature index')
  requireExactKeys(root, ['schema', 'entries', 'shards'], 'motion semantic feature index')
  if (root.schema !== MOTION_SEMANTIC_INDEX_SCHEMA) {
    throw new Error('Unsupported motion semantic feature index schema')
  }
  const rawEntries = requireArray(root.entries, 'motion semantic feature index entries')
  const rawShards = requireRecord(root.shards, 'motion semantic feature index shards')
  const shards: Record<string, string> = {}
  for (const [group, fileName] of Object.entries(rawShards)) {
    shards[group] = requireShardFileName(fileName, group)
  }
  const entries: MotionSemanticIndexEntry[] = []
  const seen = new Set<string>()
  for (const [index, rawEntry] of rawEntries.entries()) {
    const entry = requireRecord(rawEntry, `motion semantic feature index entry ${index}`)
    requireExactKeys(entry, ['cacheKey', 'canonicalPrompt', 'group'], `entry ${index}`)
    const cacheKey = requireCacheKey(entry.cacheKey)
    if (seen.has(cacheKey)) throw new Error(`Duplicate motion feature cacheKey: ${cacheKey}`)
    seen.add(cacheKey)
    const group = requireGroup(entry.group, index)
    if (shards[group] === undefined) {
      throw new Error(`Motion feature index entry ${index} references unknown group: ${group}`)
    }
    entries.push({ cacheKey, canonicalPrompt: requireDisplayString(entry.canonicalPrompt, `entry ${index}.canonicalPrompt`, 512), group })
  }
  return { schema: MOTION_SEMANTIC_INDEX_SCHEMA, entries, shards }
}

export async function loadMotionSemanticIndexFile(filePath: string): Promise<MotionSemanticIndex> {
  return parseMotionSemanticIndex(await readFile(filePath, 'utf8'))
}

export async function createShardedMotionSemanticFeatureCache(
  indexPath: string,
): Promise<ShardedMotionSemanticFeatureCache> {
  return ShardedMotionSemanticFeatureCache.open(indexPath)
}

/**
 * Cache that keeps only a lightweight index in memory at startup and loads a
 * shard's full feature payload only when one of its keys is first requested.
 * New entries from encoder misses are merged into their group shard and
 * persisted only for dirty shards, instead of rewriting the whole dataset.
 */
export class ShardedMotionSemanticFeatureCache implements MotionSemanticFeatureCache {
  readonly #indexPath: string
  readonly #shardDir: string
  readonly #keyMeta = new Map<string, { canonicalPrompt: string; group: string }>()
  readonly #shardFiles = new Map<string, string>()
  readonly #shardCaches = new Map<string, MemoryMotionSemanticFeatureCache>()
  readonly #dirtyShards = new Set<string>()
  #indexDirty = false

  private constructor(indexPath: string, index: MotionSemanticIndex) {
    this.#indexPath = indexPath
    this.#shardDir = dirname(indexPath)
    for (const [group, fileName] of Object.entries(index.shards)) this.#shardFiles.set(group, fileName)
    for (const entry of index.entries) {
      this.#keyMeta.set(entry.cacheKey, { canonicalPrompt: entry.canonicalPrompt, group: entry.group })
    }
  }

  static async open(indexPath: string): Promise<ShardedMotionSemanticFeatureCache> {
    return new ShardedMotionSemanticFeatureCache(indexPath, await loadMotionSemanticIndexFile(indexPath))
  }

  get size(): number {
    return this.#keyMeta.size
  }

  get(cacheKey: string): MotionSemanticFeature | undefined {
    const key = requireCacheKey(cacheKey)
    const meta = this.#keyMeta.get(key)
    if (meta === undefined) return undefined
    return this.#ensureShard(meta.group).get(key)
  }

  findByCanonicalPrompt(prompt: string): MotionSemanticFeature | undefined {
    const canonicalPrompt = requireCanonicalPrompt(prompt)
    for (const [cacheKey, meta] of this.#keyMeta) {
      if (meta.canonicalPrompt === canonicalPrompt) return this.get(cacheKey)
    }
    return undefined
  }

  set(feature: MotionSemanticFeature): void {
    const key = feature.cacheKey
    const group = groupOfCacheKey(key)
    const isNewKey = !this.#keyMeta.has(key)
    const isNewGroup = !this.#shardFiles.has(group)
    if (isNewGroup) {
      this.#shardFiles.set(group, `motion-features.${group}.json`)
      // Register the in-memory shard first so #ensureShard does not try to
      // load a shard file that does not exist yet.
      this.#shardCaches.set(group, new MemoryMotionSemanticFeatureCache())
    }
    this.#keyMeta.set(key, { canonicalPrompt: feature.canonicalPrompt, group })
    this.#ensureShard(group).set(feature)
    this.#dirtyShards.add(group)
    if (isNewKey || isNewGroup) this.#indexDirty = true
  }

  async persist(): Promise<void> {
    for (const group of this.#dirtyShards) {
      const shard = this.#shardCaches.get(group)
      const fileName = this.#shardFiles.get(group)
      if (shard === undefined || fileName === undefined) continue
      await writeMotionSemanticFeatureCacheFile(join(this.#shardDir, fileName), shard.snapshot())
    }
    this.#dirtyShards.clear()
    if (this.#indexDirty) {
      await writeMotionSemanticIndexFile(this.#indexPath, this.#keyMeta, this.#shardFiles)
      this.#indexDirty = false
    }
  }

  #ensureShard(group: string): MemoryMotionSemanticFeatureCache {
    let shard = this.#shardCaches.get(group)
    if (shard !== undefined) return shard
    const fileName = this.#shardFiles.get(group)
    shard = fileName === undefined
      ? new MemoryMotionSemanticFeatureCache()
      : new MemoryMotionSemanticFeatureCache(
        loadMotionSemanticFeatureCacheFileSync(join(this.#shardDir, fileName)),
      )
    this.#shardCaches.set(group, shard)
    return shard
  }
}

async function writeMotionSemanticIndexFile(
  indexPath: string,
  keyMeta: ReadonlyMap<string, { canonicalPrompt: string; group: string }>,
  shardFiles: ReadonlyMap<string, string>,
): Promise<void> {
  const entries = [...keyMeta.entries()]
    .map(([cacheKey, meta]) => ({ cacheKey, canonicalPrompt: meta.canonicalPrompt, group: meta.group }))
    .sort((left, right) => left.cacheKey.localeCompare(right.cacheKey))
  const shards: Record<string, string> = {}
  for (const [group, fileName] of shardFiles) shards[group] = fileName
  const raw = JSON.stringify({ schema: MOTION_SEMANTIC_INDEX_SCHEMA, entries, shards })

  await mkdir(dirname(indexPath), { recursive: true })
  const temporaryPath = join(dirname(indexPath), `.${basename(indexPath)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, raw, 'utf8')
    await rename(temporaryPath, indexPath)
  }
  finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

function requireGroup(value: unknown, index: number): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 64
    || !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error(`entry ${index}.group is invalid`)
  }
  return value
}

function requireShardFileName(value: unknown, group: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+\.json$/u.test(value)) {
    throw new Error(`shard file name for group ${group} is invalid`)
  }
  return value
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${name} contains missing or unknown fields`)
  }
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function requireDisplayString(value: unknown, name: string, maximumLength: number): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new Error(`${name} must be a trimmed printable string up to ${maximumLength} characters`)
  }
  return value
}
