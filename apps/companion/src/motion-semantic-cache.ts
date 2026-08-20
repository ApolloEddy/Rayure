import type { MotionSemanticFeature } from '@rayure/protocol'
import { validateMotionSemanticFeature } from '@rayure/protocol'

export interface MotionSemanticFeatureCache {
  readonly size: number
  get(cacheKey: string): MotionSemanticFeature | undefined
  set(feature: MotionSemanticFeature): void
}

export class MemoryMotionSemanticFeatureCache implements MotionSemanticFeatureCache {
  readonly #entries = new Map<string, MotionSemanticFeature>()

  constructor(initial: readonly MotionSemanticFeature[] = []) {
    for (const feature of initial) this.set(feature)
  }

  get size(): number {
    return this.#entries.size
  }

  snapshot(): readonly MotionSemanticFeature[] {
    return [...this.#entries.values()]
  }

  get(cacheKey: string): MotionSemanticFeature | undefined {
    return this.#entries.get(requireCacheKey(cacheKey))
  }

  set(feature: MotionSemanticFeature): void {
    validateMotionSemanticFeature(feature)
    this.#entries.set(feature.cacheKey, feature)
  }
}

export interface MotionSemanticFeatureEncodeInput {
  cacheKey: string
  canonicalPrompt: string
  signal?: AbortSignal | undefined
}

export interface MotionSemanticFeatureEncoder {
  encode(input: MotionSemanticFeatureEncodeInput): Promise<MotionSemanticFeature>
}

export interface MotionSemanticFeatureResolveInput extends MotionSemanticFeatureEncodeInput {}

export interface CachedMotionSemanticFeatureResolverOptions {
  cache: MotionSemanticFeatureCache
  encoder: MotionSemanticFeatureEncoder
  afterEncode?: ((feature: MotionSemanticFeature) => Promise<void> | void) | undefined
}

/** Resolves a feature from the local cache first, then encodes and caches misses. */
export class CachedMotionSemanticFeatureResolver {
  readonly #cache: MotionSemanticFeatureCache
  readonly #encoder: MotionSemanticFeatureEncoder
  readonly #afterEncode: ((feature: MotionSemanticFeature) => Promise<void> | void) | undefined

  constructor(options: CachedMotionSemanticFeatureResolverOptions) {
    this.#cache = options.cache
    this.#encoder = options.encoder
    this.#afterEncode = options.afterEncode
  }

  async resolve(input: MotionSemanticFeatureResolveInput): Promise<MotionSemanticFeature> {
    const cacheKey = requireCacheKey(input.cacheKey)
    const canonicalPrompt = requireCanonicalPrompt(input.canonicalPrompt)
    const cached = this.#cache.get(cacheKey)
    if (cached !== undefined && cached.canonicalPrompt === canonicalPrompt) return cached

    const encoded = await this.#encoder.encode({
      cacheKey,
      canonicalPrompt,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    validateMotionSemanticFeature(encoded)
    if (encoded.cacheKey !== cacheKey || encoded.canonicalPrompt !== canonicalPrompt) {
      throw new Error('Text encoder returned a feature with a mismatched cache identity')
    }
    this.#cache.set(encoded)
    await this.#afterEncode?.(encoded)
    return encoded
  }
}

function requireCacheKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
    throw new Error('Motion semantic feature cacheKey is invalid')
  }
  return value
}

function requireCanonicalPrompt(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 512
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new Error('Motion semantic feature canonicalPrompt is invalid')
  }
  return value
}
