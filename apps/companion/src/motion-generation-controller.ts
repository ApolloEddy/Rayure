import type { CanonicalMotion } from '@rayure/protocol'

import type { RayureMotionGeneratePreset } from './local-config.ts'
import { MotionScheduler } from './motion-scheduler.ts'
import type {
  MotionScheduleIntent,
  MotionScheduleSegment,
} from './motion-scheduler.ts'

export interface MotionGenerationControllerOptions {
  generate: (intent: MotionScheduleIntent) => Promise<CanonicalMotion>
  publish: (input: { id: string, displayName: string, motion: CanonicalMotion }) => unknown
  onStatus?: ((status: MotionGenerationStatus) => void) | undefined
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

  constructor(options: MotionGenerationControllerOptions) {
    this.#publish = options.publish
    this.#onStatus = options.onStatus
    this.#scheduler = new MotionScheduler({
      generator: options.generate,
      onSegmentReady: (segment) => {
        this.#publish({
          id: segment.intentId,
          displayName: segment.prompt,
          motion: segment.motion,
        })
      },
    })
  }

  get isGenerating(): boolean {
    return this.#scheduler.isGenerating
  }

  get currentMotion(): CanonicalMotion | undefined {
    return this.#scheduler.buffer
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
    })
  }

  /**
   * Replays configured startup presets as intents. Failures are fatal so a
   * misconfigured preset fails loudly at boot instead of running silently.
   */
  async runStartup(presets: readonly RayureMotionGeneratePreset[]): Promise<void> {
    for (const preset of presets) {
      await this.submitIntent({
        id: preset.id,
        prompt: preset.prompt,
        ...(preset.numFrames === undefined ? {} : { numFrames: preset.numFrames }),
        ...(preset.numDenoisingSteps === undefined ? {} : { numDenoisingSteps: preset.numDenoisingSteps }),
        ...(preset.cfgWeight === undefined ? {} : { cfgWeight: preset.cfgWeight }),
      })
    }
  }

  dispose(): void {
    this.#scheduler.dispose()
  }
}