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
  ArdyMotionContinuation,
  ArdyMotionResult,
} from './ardy-process-protocol.ts'
import type { ArdyProcessGenerationInput } from './ardy-process-client.ts'
import type {
  MotionSemanticFeatureCache,
  MotionSemanticFeatureResolveInput,
} from './motion-semantic-cache.ts'
import { isDegenerateMotion, trimStaticTailAndReturnToNeutral } from './motion-tail-trim.ts'

export interface MotionGenerationInput {
  cacheKey: string
  canonicalPrompt: string
  numFrames: number
  numDenoisingSteps: number
  cfgWeight: number
  /**
   * Consumed frames of the previous motion. Kept for result-cache identity
   * (a continued generation is never cacheable) but never sent to the bridge:
   * the ARDY build refuses to rehydrate pose from JSON frames, so continuity
   * is carried exclusively by `continuation`.
   */
  history?: CanonicalMotion
  /** Opaque bridge continuation state; a fresh generation omits it. */
  continuation?: ArdyMotionContinuation
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
  /**
   * Restarts the ARDY process and returns a fresh backend for a retry.
   * Invoked when a fresh one-shot generation comes back degenerate (the bridge
   * drifts toward near-static output after repeated calls); returning undefined
   * keeps the degenerate result instead of failing the generation.
   */
  onBackendDegraded?: (() => Promise<ArdyMotionBackend | undefined>) | undefined
}

/**
 * Links the runtime pipeline without owning transport or renderer state:
 * prompt identity -> cached/native text feature -> external ARDY -> Canonical Motion.
 */
export class MotionGenerationService {
  readonly #cache: MotionSemanticFeatureCache
  readonly #resolver: MotionSemanticFeatureResolverLike | undefined
  #backend: ArdyMotionBackend
  readonly #onBackendDegraded: (() => Promise<ArdyMotionBackend | undefined>) | undefined
  readonly #resultCache = new Map<string, ArdyMotionResult>()
  #active = false

  constructor(options: MotionGenerationServiceOptions) {
    this.#cache = options.cache
    this.#resolver = options.resolver
    this.#backend = options.backend
    this.#onBackendDegraded = options.onBackendDegraded
  }

  async generate(input: MotionGenerationInput): Promise<ArdyMotionResult> {
    const cacheKey = requireCacheKey(input.cacheKey)
    const canonicalPrompt = requireCanonicalPrompt(input.canonicalPrompt)
    requireInteger(input.numFrames, 'Motion generation numFrames', 1, 600)
    requireInteger(input.numDenoisingSteps, 'Motion generation numDenoisingSteps', 1, 20)
    requireFiniteNumber(input.cfgWeight, 'Motion generation cfgWeight', 0, 20)
    if (input.history !== undefined) validateCanonicalMotion(input.history)
    if (input.signal?.aborted) throw new Error('Motion generation aborted')

    // A fresh, unconstrained generation is deterministic in its generation
    // parameters, so a repeated prompt can reuse the published motion instead
    // of re-running the full ARDY generation (tens of seconds on this
    // machine). History, continuation and scene constraints make the result
    // depend on runtime state, so those are never cached. The lookup precedes
    // the concurrency guard so a cached prompt is served even while another
    // generation is in flight.
    const resultKey = input.history === undefined && input.continuation === undefined && input.constraints === undefined
      ? motionResultCacheKey(canonicalPrompt, input.numFrames, input.numDenoisingSteps, input.cfgWeight)
      : undefined
    if (resultKey !== undefined) {
      const cached = this.#resultCache.get(resultKey)
      if (cached !== undefined) return cached
    }
    if (this.#active) throw new Error('Motion generation already has an active generation')

    this.#active = true
    try {
      const textFeature = await this.#resolveFeature({
        cacheKey,
        canonicalPrompt,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      if (input.signal?.aborted) throw new Error('Motion generation aborted')

      const runGeneration = (fresh: boolean): Promise<ArdyMotionResult> =>
        this.#backend.generate({
          textFeature,
          numFrames: input.numFrames,
          numDenoisingSteps: input.numDenoisingSteps,
          cfgWeight: input.cfgWeight,
          ...(fresh || input.continuation === undefined
            ? {}
            : { continuation: input.continuation }),
          ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
      let result = await runGeneration(false)
      validateArdyMotionResult(result)
      // Gesture generations occasionally come back near-static: the bridge
      // drifts toward neutral output after repeated calls. Detect that on the
      // raw result and restart the bridge once, then regenerate — a fresh model
      // state restores healthy output. The retry drops the continuation id (the
      // fresh bridge no longer owns that tensor) and generates a fresh segment;
      // the ARDY build deliberately refuses to rehydrate pose from JSON frames.
      // Scene-constrained requests are left alone: the constraint data belongs
      // to the generation it was solved for.
      const canRetryDegenerate = input.constraints === undefined
      if (canRetryDegenerate && this.#onBackendDegraded !== undefined && isDegenerateMotion(result.motion)) {
        const freshBackend = await this.#onBackendDegraded()
        if (freshBackend !== undefined) {
          console.warn('[motion] detected degenerate ARDY generation; restarted bridge and retrying once')
          this.#backend = freshBackend
          result = await runGeneration(true)
          validateArdyMotionResult(result)
        }
      }
      // Fresh one-shot generations get their static tail trimmed and a
      // return-to-neutral appended so gestures complete (wave = raise → lower)
      // instead of freezing mid-pose. Continuation segments are left alone:
      // the bridge's stored tensor must stay frame-consistent with what the
      // renderer consumed.
      const finalResult = resultKey === undefined
        ? result
        : { ...result, motion: trimStaticTailAndReturnToNeutral(result.motion) }
      validateArdyMotionResult(finalResult)
      if (resultKey !== undefined && !isDegenerateMotion(finalResult.motion)) {
        // A degenerate (near-static) result must never be cached: it would be
        // re-served to every later request for the same prompt. The retry path
        // re-runs a fresh generation instead.
        this.#resultCache.set(resultKey, finalResult)
        if (this.#resultCache.size > MOTION_RESULT_CACHE_MAX) {
          const oldest = this.#resultCache.keys().next()
          if (!oldest.done) this.#resultCache.delete(oldest.value)
        }
      }
      return finalResult
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
    if (cached !== undefined) {
      if (cached.canonicalPrompt !== input.canonicalPrompt) {
        throw new Error('Motion semantic cache entry prompt mismatch and Text Encoder unavailable')
      }
      return cached
    }
    // A caller may carry a fresh cacheKey (the calibration wizard sends a new
    // intent id per request) while the prompt was already cached under a
    // preset id; reuse that feature instead of failing without an encoder.
    const byPrompt = this.#cache.findByCanonicalPrompt(input.canonicalPrompt)
    if (byPrompt !== undefined) return byPrompt
    throw new Error('Motion semantic feature cache miss and Text Encoder unavailable')
  }
}

/** Bounds the generated-motion cache; oldest entry is evicted on overflow. */
const MOTION_RESULT_CACHE_MAX = 32

function motionResultCacheKey(
  prompt: string,
  numFrames: number,
  numDenoisingSteps: number,
  cfgWeight: number,
): string {
  // The cacheKey (intent id) is deliberately excluded: wizard and startup
  // requests carry fresh ids while sharing the same prompt. JSON keeps the
  // key unambiguous regardless of prompt contents (control characters are
  // rejected before this point).
  return JSON.stringify([prompt, numFrames, numDenoisingSteps, cfgWeight])
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
