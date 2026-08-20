import {
  validateCanonicalMotion,
  validateMotionSemanticFeature,
} from '@rayure/protocol'
import type {
  CanonicalMotion,
  MotionSemanticFeature,
} from '@rayure/protocol'

import type {
  ArdyKinematicConstraint,
  ArdyMotionResult,
} from './ardy-process-protocol.ts'
import type { ArdyProcessGenerationInput } from './ardy-process-client.ts'
import type {
  MotionSemanticFeatureCache,
  MotionSemanticFeatureResolveInput,
} from './motion-semantic-cache.ts'

export interface MotionGenerationInput {
  cacheKey: string
  canonicalPrompt: string
  numFrames: number
  numDenoisingSteps: number
  cfgWeight: number
  history?: CanonicalMotion
  constraints?: readonly ArdyKinematicConstraint[]
  signal?: AbortSignal | undefined
}

export interface MotionSemanticFeatureResolverLike {
  resolve(input: MotionSemanticFeatureResolveInput): Promise<MotionSemanticFeature>
}

export interface ArdyMotionBackend {
  generate(input: ArdyProcessGenerationInput): Promise<ArdyMotionResult>
}

export interface MotionGenerationServiceOptions {
  cache: MotionSemanticFeatureCache
  resolver?: MotionSemanticFeatureResolverLike | undefined
  backend: ArdyMotionBackend
}

/**
 * Links the runtime pipeline without owning transport or renderer state:
 * prompt identity -> cached/native text feature -> external ARDY -> Canonical Motion.
 */
export class MotionGenerationService {
  readonly #cache: MotionSemanticFeatureCache
  readonly #resolver: MotionSemanticFeatureResolverLike | undefined
  readonly #backend: ArdyMotionBackend
  #active = false

  constructor(options: MotionGenerationServiceOptions) {
    this.#cache = options.cache
    this.#resolver = options.resolver
    this.#backend = options.backend
  }

  async generate(input: MotionGenerationInput): Promise<ArdyMotionResult> {
    if (this.#active) throw new Error('Motion generation already has an active generation')
    const cacheKey = requireCacheKey(input.cacheKey)
    const canonicalPrompt = requireCanonicalPrompt(input.canonicalPrompt)
    requireInteger(input.numFrames, 'Motion generation numFrames', 1, 600)
    requireInteger(input.numDenoisingSteps, 'Motion generation numDenoisingSteps', 1, 20)
    requireFiniteNumber(input.cfgWeight, 'Motion generation cfgWeight', 0, 20)
    if (input.history !== undefined) validateCanonicalMotion(input.history)
    if (input.signal?.aborted) throw new Error('Motion generation aborted')

    this.#active = true
    try {
      const textFeature = await this.#resolveFeature({
        cacheKey,
        canonicalPrompt,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      if (input.signal?.aborted) throw new Error('Motion generation aborted')

      const result = await this.#backend.generate({
        textFeature,
        numFrames: input.numFrames,
        numDenoisingSteps: input.numDenoisingSteps,
        cfgWeight: input.cfgWeight,
        ...(input.history === undefined ? {} : { history: input.history }),
        ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      validateArdyMotionResult(result)
      return result
    }
    finally {
      this.#active = false
    }
  }

  async #resolveFeature(input: MotionSemanticFeatureResolveInput): Promise<MotionSemanticFeature> {
    if (this.#resolver !== undefined) {
      const feature = await this.#resolver.resolve(input)
      validateMotionSemanticFeature(feature)
      if (feature.cacheKey !== input.cacheKey || feature.canonicalPrompt !== input.canonicalPrompt) {
        throw new Error('Motion semantic resolver returned a mismatched cache identity')
      }
      return feature
    }

    const cached = this.#cache.get(input.cacheKey)
    if (cached === undefined) {
      throw new Error('Motion semantic feature cache miss and Text Encoder unavailable')
    }
    if (cached.canonicalPrompt !== input.canonicalPrompt) {
      throw new Error('Motion semantic cache entry prompt mismatch and Text Encoder unavailable')
    }
    return cached
  }
}

function validateArdyMotionResult(value: ArdyMotionResult): void {
  if (value === null || typeof value !== 'object') throw new Error('ARDY backend result must be an object')
  requireIdentifier(value.requestId, 'ARDY backend requestId')
  validateCanonicalMotion(value.motion)
}

function requireCacheKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
    throw new Error('Motion generation cacheKey is invalid')
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
    throw new Error('Motion generation canonicalPrompt is invalid')
  }
  return value
}

function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

function requireFiniteNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a finite number from ${minimum} through ${maximum}`)
  }
  return value
}
