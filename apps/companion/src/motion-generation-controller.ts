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

export interface MotionGenerationControllerOptions {
  generate: (
    intent: MotionScheduleIntent,
    history: MotionScheduleHistory | undefined,
  ) => Promise<CanonicalMotion | MotionScheduleGeneration>
  publish: (input: { id: string, displayName: string, motion: CanonicalMotion }) => MotionDescriptor
  onStatus?: ((status: MotionGenerationStatus) => void) | undefined
  onError?: ((cause: unknown, intentId: string) => void) | undefined
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
  }

  get isGenerating(): boolean {
    return this.#scheduler.isGenerating
  }

  get currentMotion(): CanonicalMotion | undefined {
    return this.#scheduler.buffer
  }

  /** Accepts a renderer-observed prefix for the currently published segment. */
  reportPlayback(observation: MotionPlaybackObservation): boolean {
    return this.#scheduler.reportPlayback(observation)
  }

  /**
   * Signals a runtime action intent. Preempts any in-flight generation and
   * publishes the segment that wins. The returned promise resolves once the
   * winning segment is installed and published (or rejects if superseded).
   */
  submitIntent(intent: MotionScheduleIntent): Promise<MotionScheduleSegment> {
    this.#onStatus?.({ intentId: intent.id, phase: 'generating' })
    return this.#scheduler.solicit(intent).then((segment) => {
      this.#onStatus?.({ intentId: segment.intentId, phase: 'ready' })
      return segment
    }).catch((cause: unknown) => {
      this.#onStatus?.({ intentId: intent.id, phase: 'superseded' })
      throw cause
    })
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
    this.#scheduler.dispose()
  }
}
