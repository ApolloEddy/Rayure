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
  #activeController: AbortController | undefined
  #tail: Promise<unknown> = Promise.resolve()
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
   * cancelled via its AbortController so the backend can release the single
   * ARDY process slot, and history continuation feeds whatever buffer frames
   * have been consumed so the next segment continues from the current pose
   * instead of a fixed T-pose.
   *
   * A caller-provided `intent.signal` is chained into our controller so both
   * external cancellation and preemption abort the same work.
   */
  solicit(intent: MotionScheduleIntent): Promise<MotionScheduleSegment> {
    const segmentId = ++this.#segmentId
    const controller = new AbortController()
    // Cancel any prior in-flight generation to free the single backend slot.
    this.#activeController?.abort()
    this.#activeController = controller
    this.#active = true
    const signal = linkSignals(controller.signal, intent.signal)
    const history = this.#consumedHistory()

    // Serialize against the single backend: a new intent waits until the prior
    // request has fully settled (released the slot) before invoking the
    // generator, so a single-flight backend is never double-occupied.
    const task = this.#tail.then(() => {
      if (signal.aborted) throw new Error('Motion scheduler segment was superseded')
      return this.#generator({ ...intent, signal }, history)
    })
    this.#tail = task.catch(() => { /* tail is only a sequencing barrier */ })

    return task.then((motion) => {
      if (this.#segmentId !== segmentId || signal.aborted) {
        throw new Error('Motion scheduler segment was superseded')
      }
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
      if (this.#segmentId === segmentId) {
        this.#active = false
      }
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

  /**
   * Treats the entire current buffer as consumed and returns it as history.
   * Used by sequential composition (e.g. startup presets) where each next
   * segment should continue from the prior one rather than a fixed T-pose.
   */
  skipToEnd(): CanonicalMotion | undefined {
    const buffer = this.#buffer
    if (buffer === undefined || buffer.frames.length === 0) return undefined
    this.#lastConsumedMs = buffer.frames[buffer.frames.length - 1]?.timeMs ?? this.#lastConsumedMs
    return buffer
  }

  clear(): void {
    this.#segmentId += 1
    this.#activeController?.abort()
    this.#activeController = undefined
    this.#buffer = undefined
    this.#bufferSegment = undefined
    this.#lastConsumedMs = -1
  }

  dispose(): void {
    this.#activeController?.abort()
    this.#activeController = undefined
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

/**
 * Returns a signal that aborts when the scheduler's own controller OR the
 * caller-provided signal aborts. A missing caller signal degrades to the
 * scheduler controller alone.
 */
function linkSignals(primary: AbortSignal, external: AbortSignal | undefined): AbortSignal {
  if (external === undefined) return primary
  if (primary.aborted || external.aborted) {
    if (!primary.aborted) primary.dispatchEvent(new Event('abort'))
    return external
  }
  external.addEventListener('abort', () => primary.dispatchEvent(new Event('abort')), { once: true })
  return external
}