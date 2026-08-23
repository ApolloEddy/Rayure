import { validateCanonicalMotion } from '@rayure/protocol'
import type { CanonicalMotion, CanonicalMotionFrame } from '@rayure/protocol'

export interface MotionScheduleIntent {
  id: string
  prompt: string
  numFrames?: number | undefined
  numDenoisingSteps?: number | undefined
  cfgWeight?: number | undefined
  signal?: AbortSignal | undefined
}

export interface MotionScheduleSegment {
  intentId: string
  prompt: string
  motion: CanonicalMotion
}

export type MotionSegmentGenerator = (
  intent: MotionScheduleIntent,
  history: CanonicalMotion | undefined,
) => Promise<CanonicalMotion>

export interface MotionSchedulerOptions {
  generator: MotionSegmentGenerator
  onSegmentReady?: ((segment: MotionScheduleSegment) => void) | undefined
}

/**
 * A renderer-agnostic motion scheduler that turns discrete action intents
 * into a continuous, playable trajectory. It owns the "Motion Buffer":
 *
 * - solicit() interrupts any in-flight generation and, if a buffer is already
 *   playing, hands the consumed history to the generator so the next segment
 *   continues from the current pose instead of a fixed T-pose.
 * - advance() walks the buffered frames in real time and lets callers consume
 *   each frame (the renderer turns it into parameters).
 * - Late results from a superseded intent are discarded so a newer intent can
 *   never be overwritten by stale frames.
 *
 * This is the layer that distinguishes a paper demo from a desktop companion
 * engine: it is bounded, interruptible continuity over an otherwise
 * stateless text-to-motion model.
 */
export class MotionScheduler {
  readonly #generator: MotionSegmentGenerator
  readonly #onSegmentReady: ((segment: MotionScheduleSegment) => void) | undefined
  readonly #consumers = new Set<(frame: CanonicalMotionFrame, segment: MotionScheduleSegment) => void>()
  #buffer: CanonicalMotion | undefined
  #bufferSegment: MotionScheduleSegment | undefined
  #lastConsumedMs = -1
  #activeIntentId: string | undefined
  #active = false
  #segmentId = 0

  constructor(options: MotionSchedulerOptions) {
    this.#generator = options.generator
    this.#onSegmentReady = options.onSegmentReady
  }

  get isBuffering(): boolean {
    return this.#buffer !== undefined
  }

  get buffer(): CanonicalMotion | undefined {
    return this.#buffer
  }

  get isGenerating(): boolean {
    return this.#active
  }

  subscribe(callback: (frame: CanonicalMotionFrame, segment: MotionScheduleSegment) => void): () => void {
    this.#consumers.add(callback)
    return () => this.#consumers.delete(callback)
  }

  /**
   * Requests a new segment for the given intent. Any in-flight generation is
   * superseded: its segmentId is invalidated so a late result is discarded,
   * and the new intent's own generation owns the result. History continuation
   * uses whatever buffer frames have been consumed so far, so the next segment
   * continues from the current pose instead of a fixed T-pose.
   */
  solicit(intent: MotionScheduleIntent): Promise<MotionScheduleSegment> {
    const segmentId = ++this.#segmentId
    this.#active = true
    this.#activeIntentId = intent.id
    const history = this.#consumedHistory()
    return this.#generator(intent, history).then((motion) => {
      if (this.#segmentId !== segmentId) throw new Error('Motion scheduler segment was superseded')
      validateCanonicalMotion(motion)
      const segment: MotionScheduleSegment = {
        intentId: intent.id,
        prompt: intent.prompt,
        motion,
      }
      this.#installBuffer(motion, segment)
      this.#onSegmentReady?.(segment)
      return segment
    }).finally(() => {
      if (this.#activeIntentId === intent.id) this.#active = false
    })
  }

  advance(deltaSeconds: number): readonly CanonicalMotionFrame[] {
    if (this.#buffer === undefined || !Number.isFinite(deltaSeconds) || deltaSeconds < 0) return []
    const nextMs = this.#lastConsumedMs + deltaSeconds * 1000
    const frames = this.#buffer.frames.filter(frame => frame.timeMs > this.#lastConsumedMs && frame.timeMs <= nextMs)
    if (frames.length > 0) {
      this.#lastConsumedMs = Math.max(this.#lastConsumedMs, frames[frames.length - 1]?.timeMs ?? this.#lastConsumedMs)
      if (this.#consumers.size > 0 && this.#bufferSegment !== undefined) {
        const segment = this.#bufferSegment
        for (const consumer of this.#consumers) {
          for (const frame of frames) consumer(frame, segment)
        }
      }
    }
    return frames
  }

  clear(): void {
    this.#segmentId += 1
    this.#buffer = undefined
    this.#bufferSegment = undefined
    this.#lastConsumedMs = -1
  }

  dispose(): void {
    this.#buffer = undefined
    this.#consumers.clear()
    this.#segmentId += 1
  }

  #installBuffer(motion: CanonicalMotion, segment: MotionScheduleSegment): void {
    this.#buffer = motion
    this.#lastConsumedMs = -1
    this.#bufferSegment = segment
  }

  #consumedHistory(): CanonicalMotion | undefined {
    const buffer = this.#buffer
    if (buffer === undefined || buffer.frames.length === 0) return undefined
    const consumed = buffer.frames.filter(frame => frame.timeMs <= this.#lastConsumedMs)
    if (consumed.length === 0) return undefined
    return {
      ...buffer,
      frames: consumed,
    }
  }
}