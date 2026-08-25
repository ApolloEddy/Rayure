import type { CanonicalMotion, MotionDescriptor } from '@rayure/protocol'

import type { RayureMotionGeneratePreset } from './local-config.ts'
import { MotionScheduler } from './motion-scheduler.ts'
import type {
  MotionScheduleIntent,
  MotionScheduleGeneration,
  MotionScheduleHistory,
  MotionPlaybackObservation,
  MotionScheduleSegment,
} from './motion-scheduler.ts'
import { MotionIdlePool } from './motion-idle-pool.ts'
import type { MotionIdleAction } from './motion-idle-pool.ts'

export interface MotionGenerationControllerOptions {
  generate: (
    intent: MotionScheduleIntent,
    history: MotionScheduleHistory | undefined,
  ) => Promise<CanonicalMotion | MotionScheduleGeneration>
  publish: (input: { id: string, displayName: string, motion: CanonicalMotion }) => MotionDescriptor
  onStatus?: ((status: MotionGenerationStatus) => void) | undefined
  onError?: ((cause: unknown, intentId: string) => void) | undefined
  idlePool?: {
    actions: readonly MotionIdleAction[]
    lookaheadMs?: number | undefined
    handoffMs?: number | undefined
  } | undefined
}

export interface MotionGenerationStatus {
  intentId: string
  phase: 'generating' | 'ready' | 'superseded'
}

/**
 * Owns the MotionScheduler and the publish side-effect, exposing two paths:
 *
 * - submitIntent() is the live entry point a future ASR/LLM behavior layer
 *   calls whenever a new action intent arrives at runtime; it preempts any
 *   in-flight generation and publishes the winning segment.
 * - runStartup() replays configured startup presets through the same path so
 *   generation semantics are identical whether a segment comes from boot or
 *   from a live intent.
 *
 * The controller is decoupled from CompanionServer: publish is injected, which
 * keeps runtime intent handling unit-testable without a live socket.
 */
export class MotionGenerationController {
  readonly #scheduler: MotionScheduler
  readonly #publish: MotionGenerationControllerOptions['publish']
  readonly #onStatus: MotionGenerationControllerOptions['onStatus']
  readonly #onError: MotionGenerationControllerOptions['onError']
  readonly #idlePool: MotionIdlePool | undefined

  constructor(options: MotionGenerationControllerOptions) {
    this.#publish = options.publish
    this.#onStatus = options.onStatus
    this.#onError = options.onError
    this.#scheduler = new MotionScheduler({
      generator: options.generate,
      onSegmentReady: (segment) => {
        const descriptor = this.#publish({
          id: segment.intentId,
          displayName: segment.prompt,
          motion: segment.motion,
        })
        this.#scheduler.attachPublishedSegment(segment, descriptor.id)
      },
    })
    this.#idlePool = options.idlePool === undefined
      ? undefined
      : new MotionIdlePool({
        ...options.idlePool,
        prefetch: intent => this.#scheduler.prefetch(intent),
        commit: () => this.#scheduler.commitPrefetch(),
        discard: () => this.#scheduler.discardPrefetch(),
        onError: (cause, intentId) => this.#onError?.(cause, intentId),
      })
  }

  get isGenerating(): boolean {
    return this.#scheduler.isGenerating
  }

  get currentMotion(): CanonicalMotion | undefined {
    return this.#scheduler.buffer
  }

  /**
   * Tells the scheduler that the ARDY bridge restarted, so any continuation ids
   * it holds are invalid on the new process and must be forgotten. Called by
   * the auto-heal path before retrying a degenerate generation.
   */
  forgetBackendContinuation(): void {
    this.#scheduler.forgetContinuation()
  }

  /** Accepts a renderer-observed prefix for the currently published segment. */
  reportPlayback(observation: MotionPlaybackObservation): boolean {
    const accepted = this.#scheduler.reportPlayback(observation)
    if (accepted) {
      this.#idlePool?.observe({
        intentId: this.#scheduler.currentSegment?.intentId ?? '',
        phase: observation.phase,
        remainingMs: this.#scheduler.remainingMs,
      })
    }
    return accepted
  }

  /**
   * Signals a runtime action intent. Preempts any in-flight generation and
   * publishes the segment that wins. The returned promise resolves once the
   * winning segment is installed and published (or rejects if superseded).
   */
  submitIntent(intent: MotionScheduleIntent): Promise<MotionScheduleSegment> {
    this.#idlePool?.interrupt()
    this.#onStatus?.({ intentId: intent.id, phase: 'generating' })
    return this.#scheduler.solicit(intent).then((segment) => {
      this.#idlePool?.adoptCurrent(segment.intentId)
      this.#onStatus?.({ intentId: segment.intentId, phase: 'ready' })
      return segment
    }).catch((cause: unknown) => {
      this.#onStatus?.({ intentId: intent.id, phase: 'superseded' })
      throw cause
    })
  }

  /** Starts idle-pool planning after startup or after a direct action is done. */
  startIdlePool(): void {
    const currentIntentId = this.#scheduler.currentSegment?.intentId
    if (currentIntentId !== undefined && this.#idlePool?.adoptCurrent(currentIntentId)) return
    if (currentIntentId === undefined) this.#idlePool?.prime()
  }

  /**
   * Replays configured startup presets as intents. A failing preset is reported
   * through `onError` and skipped so one bad entry cannot take Companion down;
   * remaining presets still run.
   */
  async runStartup(presets: readonly RayureMotionGeneratePreset[]): Promise<void> {
    for (const preset of presets) {
      try {
        await this.submitIntent({
          id: preset.id,
          prompt: preset.prompt,
          ...(preset.numFrames === undefined ? {} : { numFrames: preset.numFrames }),
          ...(preset.numDenoisingSteps === undefined ? {} : { numDenoisingSteps: preset.numDenoisingSteps }),
          ...(preset.cfgWeight === undefined ? {} : { cfgWeight: preset.cfgWeight }),
        })
        // Startup has no renderer-observed playback yet. Do not fabricate a
        // consumed pose for a subsequent preset; live re-planning obtains its
        // prefix solely through reportPlayback().
      }
      catch (cause) {
        try {
          this.#onError?.(cause, preset.id)
        }
        catch {
          // An error reporter must not prevent startup from continuing.
        }
      }
    }
  }

  dispose(): void {
    this.#idlePool?.interrupt()
    this.#scheduler.dispose()
  }
}
