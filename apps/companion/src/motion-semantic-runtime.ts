import { open } from 'node:fs/promises'

import { loadMotionSemanticFeatureCacheFile, writeMotionSemanticFeatureCacheFile } from './motion-semantic-cache-file.ts'
import {
  CachedMotionSemanticFeatureResolver,
  MemoryMotionSemanticFeatureCache,
} from './motion-semantic-cache.ts'
import type { MotionSemanticFeatureCache } from './motion-semantic-cache.ts'
import {
  createShardedMotionSemanticFeatureCache,
  MOTION_SEMANTIC_INDEX_SCHEMA,
  ShardedMotionSemanticFeatureCache,
} from './motion-semantic-cache-shard.ts'
import type { RayureMotionSemanticConfig } from './local-config.ts'
import { TextEncoderApiClient } from './text-encoder-client.ts'
import { ArdyProcessClient } from './ardy-process-client.ts'
import { MotionGenerationService } from './motion-generation-service.ts'

export interface MotionSemanticRuntime {
  readonly cache: MemoryMotionSemanticFeatureCache | ShardedMotionSemanticFeatureCache
  readonly resolver: CachedMotionSemanticFeatureResolver | undefined
  readonly cachePath: string | undefined
  readonly ardy: ArdyProcessClient | undefined
  createGenerationService(): MotionGenerationService
  /** Subscribes to ARDY bridge restarts (the auto-heal path). */
  onArdyRestart(listener: () => void): void
  persist(): Promise<void>
  close(): Promise<void>
}

export interface CreateMotionSemanticRuntimeOptions {
  fetchImplementation?: typeof fetch
}

export async function createMotionSemanticRuntime(
  config: RayureMotionSemanticConfig | undefined,
  options: CreateMotionSemanticRuntimeOptions = {},
): Promise<MotionSemanticRuntime> {
  const cachePath = config?.cachePath
  let cache: MemoryMotionSemanticFeatureCache | ShardedMotionSemanticFeatureCache
  if (cachePath === undefined) {
    cache = new MemoryMotionSemanticFeatureCache()
  }
  else if (await isIndexLayout(cachePath)) {
    cache = await createShardedMotionSemanticFeatureCache(cachePath)
  }
  else {
    cache = new MemoryMotionSemanticFeatureCache(await readInitialFeatures(cachePath))
  }

  const persist = async (): Promise<void> => {
    if (cachePath === undefined) return
    if (cache instanceof ShardedMotionSemanticFeatureCache) {
      await cache.persist()
      return
    }
    await writeMotionSemanticFeatureCacheFile(cachePath, cache.snapshot())
  }

  const resolver = config?.textEncoder === undefined
    ? undefined
    : new CachedMotionSemanticFeatureResolver({
      cache,
      encoder: new TextEncoderApiClient({
        endpoint: config.textEncoder.endpoint,
        timeoutMs: config.textEncoder.timeoutMs,
        ...(options.fetchImplementation === undefined ? {} : { fetchImplementation: options.fetchImplementation }),
      }),
      afterEncode: persist,
    })
  const ardyOptions = config?.ardy
  const spawnedArdyClients: ArdyProcessClient[] = []
  const ardyRestartListeners: Array<() => void> = []
  let ardy: ArdyProcessClient | undefined
  if (ardyOptions !== undefined) {
    ardy = new ArdyProcessClient({
      command: ardyOptions.command,
      args: ardyOptions.args,
      requestTimeoutMs: ardyOptions.requestTimeoutMs,
      ...(ardyOptions.cwd === undefined ? {} : { cwd: ardyOptions.cwd }),
    })
    spawnedArdyClients.push(ardy)
  }

  /**
   * Restarts the ARDY bridge after a degenerate (near-static) generation.
   * Closes the old process, spawns a fresh one, and hands it back so the
   * generation service can retry once. Returns undefined when the bridge is
   * absent or the restart failed, in which case the caller keeps the previous
   * result rather than failing the generation outright.
   */
  const restartArdy = async (): Promise<ArdyProcessClient | undefined> => {
    const current = ardy
    if (current === undefined || ardyOptions === undefined) return undefined
    try {
      await current.close()
    }
    catch (cause) {
      console.warn('[motion] ARDY bridge close during restart failed:', cause)
    }
    const fresh = new ArdyProcessClient({
      command: ardyOptions.command,
      args: ardyOptions.args,
      requestTimeoutMs: ardyOptions.requestTimeoutMs,
      ...(ardyOptions.cwd === undefined ? {} : { cwd: ardyOptions.cwd }),
    })
    spawnedArdyClients.push(fresh)
    ardy = fresh
    // Continuation ids minted by the old process are invalid on this one; the
    // scheduler must forget them so the next generation re-encodes the consumed
    // frames as JSON history instead of referencing a dead tensor.
    for (const listener of ardyRestartListeners) {
      try {
        listener()
      }
      catch (cause) {
        console.warn('[motion] ARDY restart listener failed:', cause)
      }
    }
    return fresh
  }

  const onArdyRestart = (listener: () => void): void => {
    ardyRestartListeners.push(listener)
  }

  const createGenerationService = (): MotionGenerationService => {
    if (ardy === undefined) {
      throw new Error('Motion generation requires an ARDY backend')
    }
    return new MotionGenerationService({
      cache,
      ...(resolver === undefined ? {} : { resolver }),
      backend: ardy,
      onBackendDegraded: restartArdy,
    })
  }

  const close = async (): Promise<void> => {
    await Promise.allSettled(spawnedArdyClients.map(client => client.close()))
  }

  return { cache, resolver, cachePath, ardy, createGenerationService, onArdyRestart, persist, close }
}

async function readInitialFeatures(filePath: string) {
  try {
    return await loadMotionSemanticFeatureCacheFile(filePath)
  }
  catch (cause) {
    if (isNodeError(cause, 'ENOENT')) return []
    throw cause
  }
}

/**
 * Detects whether cachePath points at a sharded index
 * (`rayure.motion-semantic-index.v1`) or a legacy single-file cache
 * (`rayure.motion-semantic-cache.v1`) by peeking the file header, without
 * loading a multi-hundred-MB legacy file just to classify it.
 */
async function isIndexLayout(filePath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(96)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return bytesRead > 0 && buffer.subarray(0, bytesRead).toString('utf8').includes(MOTION_SEMANTIC_INDEX_SCHEMA)
  }
  catch (cause) {
    if (isNodeError(cause, 'ENOENT')) return false
    throw cause
  }
  finally {
    await handle?.close()
  }
}

function isNodeError(cause: unknown, code: string): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === code
}
