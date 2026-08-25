import { validateCanonicalMotion } from '@rayure/protocol'
import type {
  CanonicalMotion,
  CanonicalMotionFrame,
  MotionPlaybackPhase,
} from '@rayure/protocol'

import type { MotionEntityTarget } from './scene-entity-registry.ts'

export interface MotionScheduleIntent {
  id: string
  prompt: string
  numFrames?: number | undefined
  numDenoisingSteps?: number | undefined
  cfgWeight?: number | undefined
  target?: MotionEntityTarget | undefined
  signal?: AbortSignal | undefined
}

/** A rendered prefix and its opaque ARDY continuation, when one exists. */
export interface MotionScheduleHistory {
  motion: CanonicalMotion
  consumedFrameCount: number
  continuationId?: string | undefined
}

/** A generator can preserve an opaque backend continuation alongside frames. */
export interface MotionScheduleGeneration {
  motion: CanonicalMotion
  continuationId?: string | undefined
}

export interface MotionScheduleSegment {
  intentId: string
  prompt: string
  motion: CanonicalMotion
  continuationId?: string | undefined
}

export type MotionSegmentGenerator = (
  intent: MotionScheduleIntent,
  history: MotionScheduleHistory | undefined,
) => Promise<CanonicalMotion | MotionScheduleGeneration>

export interface MotionSchedulerOptions {
  generator: MotionSegmentGenerator
  onSegmentReady?: ((segment: MotionScheduleSegment) => void) | undefined
}

interface MotionSchedulerState {
  buffer: CanonicalMotion | undefined
  bufferSegment: MotionScheduleSegment | undefined
  publishedMotionId: string | undefined
  lastConsumedMs: number
  lastConsumedFrameCount: number
}

export interface MotionPlaybackObservation {
  motionId: string
  phase: MotionPlaybackPhase
  frameIndex: number
}

/**
 * Renderer-agnostic continuity scheduler. The Companion never advances a
 * segment by itself in production: only renderer-observed frame telemetry is
 * treated as real history. `advance()` remains a deterministic test/headless
 * hook and feeds the same consumed-frame state.
 */
export class MotionScheduler {
  readonly #generator: MotionSegmentGenerator
  readonly #onSegmentReady: ((segment: MotionScheduleSegment) => void) | undefined
  readonly #consumers = new Set<(frame: CanonicalMotionFrame, segment: MotionScheduleSegment) => void>()
  #buffer: CanonicalMotion | undefined
  #bufferSegment: MotionScheduleSegment | undefined
  #prefetchedSegment: MotionScheduleSegment | undefined
  #publishedMotionId: string | undefined
  #lastConsumedMs = -1
  #lastConsumedFrameCount = 0
  #activeController: AbortController | undefined
  #activePromise: Promise<MotionScheduleSegment> | undefined
  #activeKind: 'current' | 'prefetch' | undefined
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

  get currentSegment(): MotionScheduleSegment | undefined {
    return this.#bufferSegment
  }

  get hasPrefetchedSegment(): boolean {
    return this.#prefetchedSegment !== undefined
  }

  get prefetchedSegment(): MotionScheduleSegment | undefined {
    return this.#prefetchedSegment
  }

  /** Remaining source time based only on renderer-confirmed playback. */
  get remainingMs(): number | undefined {
    const buffer = this.#buffer
    if (buffer === undefined || buffer.frames.length === 0) return undefined
    const lastFrame = buffer.frames[buffer.frames.length - 1]
    if (lastFrame === undefined) return undefined
    const consumedMs = this.#lastConsumedFrameCount === 0 ? 0 : Math.max(0, this.#lastConsumedMs)
    return Math.max(0, lastFrame.timeMs - consumedMs)
  }

  get isGenerating(): boolean {
    return this.#active
  }

  subscribe(callback: (frame: CanonicalMotionFrame, segment: MotionScheduleSegment) => void): () => void {
    this.#consumers.add(callback)
    return () => this.#consumers.delete(callback)
  }

  /** Associates the installed segment with the unique renderer descriptor. */
  attachPublishedSegment(segment: MotionScheduleSegment, motionId: string): boolean {
    if (this.#bufferSegment !== segment || this.#buffer === undefined || !isWireIdentifier(motionId)) return false
    this.#publishedMotionId = motionId
    return true
  }

  /**
   * Accepts progress only for the segment currently published to the renderer.
   * Reports are monotonic, so delayed websocket packets cannot rewind history.
   */
  reportPlayback(observation: MotionPlaybackObservation): boolean {
    const buffer = this.#buffer
    if (
      buffer === undefined
      || this.#bufferSegment === undefined
      || this.#publishedMotionId !== observation.motionId
      || !isWireIdentifier(observation.motionId)
      || !isPlaybackPhase(observation.phase)
      || !Number.isSafeInteger(observation.frameIndex)
      || observation.frameIndex < 0
      || observation.frameIndex > buffer.frames.length
    ) return false

    if (observation.frameIndex < this.#lastConsumedFrameCount) return false
    this.#lastConsumedFrameCount = observation.frameIndex
    const frame = observation.frameIndex === 0 ? undefined : buffer.frames[observation.frameIndex - 1]
    if (frame !== undefined) this.#lastConsumedMs = Math.max(this.#lastConsumedMs, frame.timeMs)
    return true
  }

  /**
   * Requests a new segment. Preemption aborts the exact signal delivered to
   * the generator, including when the caller supplied an external signal.
   */
  solicit(intent: MotionScheduleIntent): Promise<MotionScheduleSegment> {
    this.#prefetchedSegment = undefined
    return this.#startGeneration(intent, 'current').then(segment => {
      this.#installAndPublish(segment)
      return segment
    })
  }

  /**
   * Generates a segment against the currently consumed history without
   * replacing the renderer's current buffer. A later commitPrefetch() performs
   * the publish/install handoff. A direct solicit() cancels this work.
   */
  prefetch(intent: MotionScheduleIntent): Promise<MotionScheduleSegment> {
    if (this.#activeKind === 'current') {
      return Promise.reject(new Error('Motion scheduler is busy with a current segment'))
    }
    if (this.#activeKind === 'prefetch' && this.#activePromise !== undefined) {
      return this.#activePromise
    }
    const task = this.#startGeneration(intent, 'prefetch').then(segment => {
      if (this.#prefetchedSegment === undefined) this.#prefetchedSegment = segment
      return segment
    })
    this.#activePromise = task
    return task
  }

  /** Installs and publishes the prepared segment, preserving the old state on publication failure. */
  commitPrefetch(): boolean {
    const segment = this.#prefetchedSegment
    if (segment === undefined) return false
    const previous = this.#captureState()
    this.#prefetchedSegment = undefined
    this.#installBuffer(segment.motion, segment)
    try {
      this.#onSegmentReady?.(segment)
      return true
    }
    catch (cause) {
      this.#restoreState(previous)
      this.#prefetchedSegment = segment
      throw cause
    }
  }

  /** Cancels any pending prefetch without touching the current rendered segment. */
  discardPrefetch(): void {
    if (this.#activeKind === 'prefetch') {
      this.#segmentId += 1
      this.#activeController?.abort()
      this.#active = false
      this.#activeController = undefined
      this.#activePromise = undefined
      this.#activeKind = undefined
    }
    this.#prefetchedSegment = undefined
  }

  #startGeneration(
    intent: MotionScheduleIntent,
    kind: 'current' | 'prefetch',
  ): Promise<MotionScheduleSegment> {
    const segmentId = ++this.#segmentId
    const controller = new AbortController()
    this.#activeController?.abort()
    this.#activeController = controller
    this.#activeKind = kind
    this.#active = true
    const linked = linkSignals(controller.signal, intent.signal)
    const history = this.#consumedHistory()

    const task = this.#tail.then(() => {
      if (linked.signal.aborted) throw new Error('Motion scheduler segment was superseded')
      return this.#generator({ ...intent, signal: linked.signal }, history)
    })
    this.#tail = task.catch(() => { /* tail is only a sequencing barrier */ })

    const result = task.then((output) => {
      if (this.#segmentId !== segmentId || linked.signal.aborted) {
        throw new Error('Motion scheduler segment was superseded')
      }
      const generated = normalizeGeneration(output)
      return {
        intentId: intent.id,
        prompt: intent.prompt,
        motion: generated.motion,
        ...(generated.continuationId === undefined ? {} : { continuationId: generated.continuationId }),
      }
    }).finally(() => {
      linked.dispose()
      if (this.#segmentId === segmentId) {
        this.#active = false
        this.#activeController = undefined
        this.#activePromise = undefined
        this.#activeKind = undefined
      }
    })
    this.#activePromise = result
    return result
  }

  /**
   * Headless/test-only clock advancement. Production uses `reportPlayback()`
   * from the renderer, but both paths update the same consumed-frame state.
   */
  advance(deltaSeconds: number): readonly CanonicalMotionFrame[] {
    if (this.#buffer === undefined || !Number.isFinite(deltaSeconds) || deltaSeconds < 0) return []
    const nextMs = this.#lastConsumedMs + deltaSeconds * 1000
    const frames = this.#buffer.frames.filter(frame => frame.timeMs > this.#lastConsumedMs && frame.timeMs <= nextMs)
    if (frames.length > 0) {
      const lastFrame = frames[frames.length - 1]
      this.#lastConsumedMs = Math.max(this.#lastConsumedMs, lastFrame?.timeMs ?? this.#lastConsumedMs)
      const index = lastFrame === undefined ? -1 : this.#buffer.frames.indexOf(lastFrame)
      this.#lastConsumedFrameCount = Math.max(this.#lastConsumedFrameCount, index + 1)
      if (this.#consumers.size > 0 && this.#bufferSegment !== undefined) {
        const segment = this.#bufferSegment
        for (const consumer of this.#consumers) {
          for (const frame of frames) consumer(frame, segment)
        }
      }
    }
    return frames
  }

  /** Test/startup helper; live continuation must use renderer telemetry. */
  skipToEnd(): MotionScheduleHistory | undefined {
    const buffer = this.#buffer
    if (buffer === undefined || buffer.frames.length === 0) return undefined
    this.#lastConsumedFrameCount = buffer.frames.length
    this.#lastConsumedMs = buffer.frames[buffer.frames.length - 1]?.timeMs ?? this.#lastConsumedMs
    return this.#consumedHistory()
  }

  clear(): void {
    this.#segmentId += 1
    this.#activeController?.abort()
    this.#activeController = undefined
    this.#activePromise = undefined
    this.#activeKind = undefined
    this.#buffer = undefined
    this.#bufferSegment = undefined
    this.#prefetchedSegment = undefined
    this.#publishedMotionId = undefined
    this.#lastConsumedMs = -1
    this.#lastConsumedFrameCount = 0
  }

  /**
   * Drops any held opaque continuation ids after the ARDY bridge restarted:
   * ids minted by the old process are invalid on the new one. The consumed
   * frames stay, but the bridge refuses to rehydrate pose from JSON frames, so
   * the next generation after a restart is a fresh segment rather than a
   * continuation (the auto-heal retry re-establishes the chain).
   */
  forgetContinuation(): void {
    if (this.#bufferSegment !== undefined) {
      this.#bufferSegment.continuationId = undefined
    }
    if (this.#prefetchedSegment !== undefined) {
      this.#prefetchedSegment.continuationId = undefined
    }
  }

  dispose(): void {
    this.clear()
    this.#consumers.clear()
  }

  #installBuffer(motion: CanonicalMotion, segment: MotionScheduleSegment): void {
    this.#buffer = motion
    this.#bufferSegment = segment
    this.#publishedMotionId = undefined
    this.#lastConsumedMs = -1
    this.#lastConsumedFrameCount = 0
  }

  #installAndPublish(segment: MotionScheduleSegment): void {
    const previous = this.#captureState()
    this.#installBuffer(segment.motion, segment)
    try {
      this.#onSegmentReady?.(segment)
    }
    catch (cause) {
      this.#restoreState(previous)
      throw cause
    }
  }

  #captureState(): MotionSchedulerState {
    return {
      buffer: this.#buffer,
      bufferSegment: this.#bufferSegment,
      publishedMotionId: this.#publishedMotionId,
      lastConsumedMs: this.#lastConsumedMs,
      lastConsumedFrameCount: this.#lastConsumedFrameCount,
    }
  }

  #restoreState(state: MotionSchedulerState): void {
    this.#buffer = state.buffer
    this.#bufferSegment = state.bufferSegment
    this.#publishedMotionId = state.publishedMotionId
    this.#lastConsumedMs = state.lastConsumedMs
    this.#lastConsumedFrameCount = state.lastConsumedFrameCount
  }

  #consumedHistory(): MotionScheduleHistory | undefined {
    const buffer = this.#buffer
    const segment = this.#bufferSegment
    if (buffer === undefined || segment === undefined || this.#lastConsumedFrameCount === 0) return undefined
    const consumedFrameCount = Math.min(this.#lastConsumedFrameCount, buffer.frames.length)
    return {
      motion: {
        ...buffer,
        frames: buffer.frames.slice(0, consumedFrameCount),
      },
      consumedFrameCount,
      ...(segment.continuationId === undefined ? {} : { continuationId: segment.continuationId }),
    }
  }
}

function normalizeGeneration(output: CanonicalMotion | MotionScheduleGeneration): MotionScheduleGeneration {
  const candidate = output as MotionScheduleGeneration
  const motion = 'motion' in candidate ? candidate.motion : output as CanonicalMotion
  validateCanonicalMotion(motion)
  const continuationId = 'motion' in candidate ? candidate.continuationId : undefined
  if (continuationId !== undefined && !isWireIdentifier(continuationId)) {
    throw new Error('Motion scheduler continuation id is invalid')
  }
  return {
    motion,
    ...(continuationId === undefined ? {} : { continuationId }),
  }
}

function isWireIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(value)
}

function isPlaybackPhase(value: unknown): value is MotionPlaybackPhase {
  return value === 'started'
    || value === 'progress'
    || value === 'completed'
    || value === 'cancelled'
}

interface LinkedSignal {
  signal: AbortSignal
  dispose(): void
}

/** Links both cancellation sources without mutating either source signal. */
function linkSignals(primary: AbortSignal, external: AbortSignal | undefined): LinkedSignal {
  if (external === undefined) return { signal: primary, dispose: () => undefined }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  primary.addEventListener('abort', abort, { once: true })
  external.addEventListener('abort', abort, { once: true })
  if (primary.aborted || external.aborted) controller.abort()
  return {
    signal: controller.signal,
    dispose: () => {
      primary.removeEventListener('abort', abort)
      external.removeEventListener('abort', abort)
    },
  }
}
