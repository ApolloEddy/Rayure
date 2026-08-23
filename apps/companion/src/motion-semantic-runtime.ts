import { loadMotionSemanticFeatureCacheFile, writeMotionSemanticFeatureCacheFile } from './motion-semantic-cache-file.ts'
import {
  CachedMotionSemanticFeatureResolver,
  MemoryMotionSemanticFeatureCache,
} from './motion-semantic-cache.ts'
import type { RayureMotionSemanticConfig } from './local-config.ts'
import { TextEncoderApiClient } from './text-encoder-client.ts'
import { ArdyProcessClient } from './ardy-process-client.ts'
import { MotionGenerationService } from './motion-generation-service.ts'

export interface MotionSemanticRuntime {
  readonly cache: MemoryMotionSemanticFeatureCache
  readonly resolver: CachedMotionSemanticFeatureResolver | undefined
  readonly cachePath: string | undefined
  readonly ardy: ArdyProcessClient | undefined
  createGenerationService(): MotionGenerationService
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
  const initialFeatures = cachePath === undefined
    ? []
    : await readInitialFeatures(cachePath)
  const cache = new MemoryMotionSemanticFeatureCache(initialFeatures)

  const persist = async (): Promise<void> => {
    if (cachePath === undefined) return
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
  const ardy = config?.ardy === undefined
    ? undefined
    : new ArdyProcessClient({
      command: config.ardy.command,
      args: config.ardy.args,
      requestTimeoutMs: config.ardy.requestTimeoutMs,
      ...(config.ardy.cwd === undefined ? {} : { cwd: config.ardy.cwd }),
    })

  const createGenerationService = (): MotionGenerationService => {
    if (ardy === undefined) {
      throw new Error('Motion generation requires an ARDY backend')
    }
    return new MotionGenerationService({
      cache,
      ...(resolver === undefined ? {} : { resolver }),
      backend: ardy,
    })
  }

  const close = async (): Promise<void> => {
    await ardy?.close()
  }

  return { cache, resolver, cachePath, ardy, createGenerationService, persist, close }
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

function isNodeError(cause: unknown, code: string): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === code
}
