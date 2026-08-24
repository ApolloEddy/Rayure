import type { SpeechDescriptor } from '@rayure/protocol'

import { BehaviorOrchestrator } from '../behavior/behavior-orchestrator.ts'
import type { BehaviorSubmitResult } from '../behavior/behavior-orchestrator.ts'
import { validateBehaviorEvent } from '../behavior/types.ts'
import type { BehaviorEvent, BehaviorPlan } from '../behavior/types.ts'
import type { RayureMotionGeneratePreset } from '../local-config.ts'
import type { MotionGenerationController } from '../motion-generation-controller.ts'
import {
  createTextAsrAdapter,
  validateAgentOutput,
  validateAsrTranscript,
  validateTtsSynthesis,
} from './types.ts'
import type { AgentAdapter, AsrAdapter, AsrTranscript, TtsAdapter } from './types.ts'

const DEFAULT_TURN_TTL_MS = 120_000

export interface SpeechRuntimeOptions {
  orchestrator: BehaviorOrchestrator
  agent: AgentAdapter
  asr?: AsrAdapter
  tts?: TtsAdapter
  controller?: MotionGenerationController
  presets?: readonly RayureMotionGeneratePreset[]
  publishSpeech?: (input: {
    id: string
    displayName: string
    synthesis: ReturnType<typeof validateTtsSynthesis>
  }) => SpeechDescriptor
  now?: () => number
  createId?: () => string
  turnTtlMs?: number
  onTranscript?: (transcript: AsrTranscript) => void
  onPlan?: (plan: BehaviorPlan) => void
  onSpeechPublished?: (speech: SpeechDescriptor) => void
  onError?: (cause: Error) => void
}

/**
 * Coordinates the voice turn without exposing provider credentials or raw
 * audio to the renderer. Every provider call is generation/cancellation aware.
 */
export class SpeechRuntime {
  readonly #orchestrator: BehaviorOrchestrator
  readonly #agent: AgentAdapter
  readonly #asr: AsrAdapter
  readonly #tts: TtsAdapter | undefined
  readonly #controller: MotionGenerationController | undefined
  readonly #presets: ReadonlyMap<string, RayureMotionGeneratePreset>
  readonly #publishSpeech: SpeechRuntimeOptions['publishSpeech']
  readonly #now: () => number
  readonly #createId: () => string
  readonly #turnTtlMs: number
  readonly #onTranscript: SpeechRuntimeOptions['onTranscript']
  readonly #onPlan: SpeechRuntimeOptions['onPlan']
  readonly #onSpeechPublished: SpeechRuntimeOptions['onSpeechPublished']
  readonly #onError: ((cause: Error) => void) | undefined

  constructor(options: SpeechRuntimeOptions) {
    this.#orchestrator = options.orchestrator
    this.#agent = options.agent
    this.#asr = options.asr ?? createTextAsrAdapter(options.now ?? Date.now)
    this.#tts = options.tts
    this.#controller = options.controller
    this.#presets = new Map((options.presets ?? []).map(preset => [preset.id, preset]))
    this.#publishSpeech = options.publishSpeech
    this.#now = options.now ?? Date.now
    this.#createId = options.createId ?? (() => `voice-${this.#now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
    this.#turnTtlMs = requireTurnTtl(options.turnTtlMs ?? DEFAULT_TURN_TTL_MS)
    this.#onTranscript = options.onTranscript
    this.#onPlan = options.onPlan
    this.#onSpeechPublished = options.onSpeechPublished
    this.#onError = options.onError
  }

  /** Starts a turn from an explicit text hint or an ASR process adapter. */
  submitText(text: string): BehaviorSubmitResult {
    requireText(text)
    const turnId = this.#createId()
    const event = this.#createEvent(turnId)
    return this.#orchestrator.submitEvent(event, async context => {
      const transcript = await this.#asr.transcribe({ turnId, hintText: text, signal: context.signal })
      await this.#runTurn(event, transcript, context.signal, context.isCurrent)
    })
  }

  /** Starts a turn from a validated final transcript emitted by ASR. */
  submitTranscript(transcript: AsrTranscript): BehaviorSubmitResult {
    const validated = validateAsrTranscript(transcript)
    const event = this.#createEvent(validated.turnId, validated.observedAtMs, validated.confidence)
    return this.#orchestrator.submitEvent(event, async context => {
      await this.#runTurn(event, validated, context.signal, context.isCurrent)
    })
  }

  #createEvent(turnId: string, observedAtMs = this.#now(), confidence = 1): BehaviorEvent {
    const event: BehaviorEvent = {
      version: 'rayure.behavior-event.v1',
      id: `voice:${turnId}`,
      source: 'voice',
      type: 'voice.final',
      correlationId: turnId,
      observedAtMs,
      expiresAtMs: observedAtMs + this.#turnTtlMs,
      confidence,
    }
    return validateBehaviorEvent(event)
  }

  async #runTurn(
    event: BehaviorEvent,
    transcript: AsrTranscript,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<void> {
    const validatedTranscript = validateAsrTranscript(transcript)
    this.#onTranscript?.(validatedTranscript)
    const plan = validateAgentOutput(event, validatedTranscript, await this.#agent.plan({ event, transcript: validatedTranscript, signal }))
    if (signal.aborted || !isCurrent()) return
    this.#onPlan?.(plan)

    if (plan.motionIntentId !== undefined && this.#controller !== undefined) {
      const preset = this.#presets.get(plan.motionIntentId)
      if (preset === undefined) throw new Error(`Agent motion intent is not allowlisted: ${plan.motionIntentId}`)
      await this.#controller.submitIntent({
        id: preset.id,
        prompt: preset.prompt,
        ...(preset.numFrames === undefined ? {} : { numFrames: preset.numFrames }),
        ...(preset.numDenoisingSteps === undefined ? {} : { numDenoisingSteps: preset.numDenoisingSteps }),
        ...(preset.cfgWeight === undefined ? {} : { cfgWeight: preset.cfgWeight }),
        signal,
      })
    }
    if (signal.aborted || !isCurrent() || plan.speak === false || plan.replyText === undefined || this.#tts === undefined || this.#publishSpeech === undefined) return

    const speechId = `${event.correlationId}.reply`
    const synthesis = validateTtsSynthesis(await this.#tts.synthesize({
      speechId,
      text: plan.replyText,
      ...(plan.emotion === undefined ? {} : { emotion: plan.emotion }),
      signal,
    }))
    if (signal.aborted || !isCurrent()) return
    const speech = this.#publishSpeech({ id: speechId, displayName: plan.replyText, synthesis })
    this.#onSpeechPublished?.(speech)
  }

  reportError(cause: unknown): void {
    this.#onError?.(cause instanceof Error ? cause : new Error(String(cause)))
  }
}

function requireText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 4096 || /[\u0000-\u001F\u007F]/u.test(value)) throw new Error('Voice text must be a trimmed printable string up to 4096 characters')
}

function requireTurnTtl(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1_000 || (value as number) > 300_000) throw new Error('Voice turn TTL must be an integer from 1000 through 300000')
  return value as number
}
