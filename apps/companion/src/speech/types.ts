import type { SpeechAudioMimeType, MouthCue } from '@rayure/protocol'

import { validateBehaviorEvent, validateBehaviorPlan } from '../behavior/types.ts'
import type { BehaviorEvent, BehaviorPlan } from '../behavior/types.ts'

export const ASR_TRANSCRIPT_VERSION = 'rayure.asr-transcript.v1' as const
export type AsrTranscript = {
  version: typeof ASR_TRANSCRIPT_VERSION
  turnId: string
  text: string
  language?: string
  confidence: number
  observedAtMs: number
}

export interface AsrAdapter {
  transcribe(input: {
    turnId: string
    hintText?: string
    signal: AbortSignal
  }): Promise<AsrTranscript>
}

export interface AgentAdapter {
  plan(input: {
    event: BehaviorEvent
    transcript: AsrTranscript
    signal: AbortSignal
  }): Promise<BehaviorPlan>
}

export interface TtsSynthesis {
  mimeType: SpeechAudioMimeType
  audio: Uint8Array
  durationMs: number
  cues: readonly MouthCue[]
}

export interface TtsAdapter {
  synthesize(input: {
    speechId: string
    text: string
    signal: AbortSignal
  }): Promise<TtsSynthesis>
}

export function validateAsrTranscript(transcript: AsrTranscript): AsrTranscript {
  if (transcript.version !== ASR_TRANSCRIPT_VERSION) throw new Error('ASR transcript version is invalid')
  requireIdentifier(transcript.turnId, 'ASR turnId')
  requireDisplayString(transcript.text, 'ASR text', 4096)
  if (transcript.language !== undefined) requireLanguage(transcript.language)
  requireConfidence(transcript.confidence, 'ASR confidence')
  requireTimestamp(transcript.observedAtMs, 'ASR observedAtMs')
  return transcript
}

export function validateAgentOutput(event: BehaviorEvent, transcript: AsrTranscript, plan: BehaviorPlan): BehaviorPlan {
  validateBehaviorEvent(event)
  validateAsrTranscript(transcript)
  if (plan.correlationId !== event.correlationId) throw new Error('Agent plan correlationId does not match the behavior event')
  return validateBehaviorPlan(plan)
}

export function validateTtsSynthesis(synthesis: TtsSynthesis): TtsSynthesis {
  if (!synthesis || typeof synthesis !== 'object') throw new Error('TTS synthesis must be an object')
  if (synthesis.mimeType !== 'audio/wav' && synthesis.mimeType !== 'audio/ogg' && synthesis.mimeType !== 'audio/webm') {
    throw new Error('TTS mimeType is unsupported')
  }
  if (!(synthesis.audio instanceof Uint8Array) || synthesis.audio.byteLength < 1 || synthesis.audio.byteLength > 16 * 1024 * 1024) {
    throw new Error('TTS audio must be a non-empty Uint8Array up to 16 MiB')
  }
  requireInteger(synthesis.durationMs, 'TTS durationMs', 1, 600_000)
  if (!Array.isArray(synthesis.cues) || synthesis.cues.length > 2048) throw new Error('TTS cues must contain at most 2048 items')
  let previous = -1
  for (const cue of synthesis.cues) {
    if (!cue || typeof cue !== 'object') throw new Error('TTS cue must be an object')
    requireInteger(cue.timeMs, 'TTS cue timeMs', 0, synthesis.durationMs)
    if (cue.timeMs < previous) throw new Error('TTS cue times must be monotonic')
    if (typeof cue.value !== 'number' || !Number.isFinite(cue.value) || cue.value < 0 || cue.value > 1) {
      throw new Error('TTS cue value must be between 0 and 1')
    }
    previous = cue.timeMs
  }
  return synthesis
}

/** Deterministic text input adapter used by tests and local smoke runs. */
export function createTextAsrAdapter(now: () => number = Date.now): AsrAdapter {
  return {
    async transcribe(input): Promise<AsrTranscript> {
      if (input.signal.aborted) throw new Error('ASR transcription aborted')
      const text = input.hintText
      if (text === undefined) throw new Error('Text ASR adapter requires hintText')
      return validateAsrTranscript({
        version: ASR_TRANSCRIPT_VERSION,
        turnId: input.turnId,
        text,
        confidence: 1,
        observedAtMs: now(),
      })
    },
  }
}

/**
 * A provider-neutral deterministic Agent. Replace this adapter with a local
 * LLM client without changing behavior orchestration or renderer contracts.
 */
export function createRuleBasedAgent(options: {
  motionByKeyword?: Readonly<Record<string, string>>
  reply?: (text: string) => string
} = {}): AgentAdapter {
  const motionByKeyword = options.motionByKeyword ?? {
    '挥手': 'wave',
    '招手': 'wave',
    wave: 'wave',
    '举手': 'hand_raise',
    '抬手': 'hand_raise',
    '左边': 'head_left',
    left: 'head_left',
    '右边': 'head_right',
    right: 'head_right',
  }
  return {
    async plan(input): Promise<BehaviorPlan> {
      if (input.signal.aborted) throw new Error('Agent planning aborted')
      const normalized = input.transcript.text.toLowerCase()
      let motionIntentId: string | undefined
      for (const [keyword, intentId] of Object.entries(motionByKeyword)) {
        if (normalized.includes(keyword.toLowerCase())) {
          motionIntentId = intentId
          break
        }
      }
      const replyText = options.reply?.(input.transcript.text) ?? `已收到：${input.transcript.text}`
      return validateAgentOutput(input.event, input.transcript, {
        version: 'rayure.behavior-plan.v1',
        correlationId: input.event.correlationId,
        ...(motionIntentId === undefined ? {} : { motionIntentId }),
        replyText,
        speak: true,
        emotion: motionIntentId === 'wave' ? 'happy' : 'neutral',
      })
    },
  }
}

/** Small PCM fixture that exercises the browser audio/cue path without a model. */
export function createFixtureTtsAdapter(now: () => number = Date.now): TtsAdapter {
  void now
  return {
    async synthesize(input): Promise<TtsSynthesis> {
      if (input.signal.aborted) throw new Error('TTS synthesis aborted')
      const durationMs = Math.min(1800, Math.max(240, input.text.length * 65))
      const sampleRate = 8_000
      const samples = Math.max(1, Math.round(sampleRate * durationMs / 1000))
      const audio = createSineWaveWav(samples, sampleRate)
      const cues: MouthCue[] = []
      const cueCount = Math.min(32, Math.max(2, Math.ceil(input.text.length / 2)))
      for (let index = 0; index < cueCount; index += 1) {
        cues.push({
          timeMs: Math.round(index * durationMs / cueCount),
          value: index % 3 === 1 ? 0.85 : 0.25,
        })
      }
      return validateTtsSynthesis({ mimeType: 'audio/wav', audio, durationMs, cues })
    },
  }
}

function createSineWaveWav(samples: number, sampleRate: number): Uint8Array {
  const dataLength = samples * 2
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataLength, true)
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.min(1, index / (sampleRate * 0.02), (samples - index) / (sampleRate * 0.02))
    const value = Math.sin(index / sampleRate * Math.PI * 2 * 440) * 0.12 * Math.max(0, envelope)
    view.setInt16(44 + index * 2, Math.round(value * 32767), true)
  }
  return new Uint8Array(buffer)
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
}

function requireIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,96}$/u.test(value)) throw new Error(`${label} is invalid`)
}

function requireDisplayString(value: unknown, label: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > maxLength || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error(`${label} must be a bounded printable string`)
  }
}

function requireLanguage(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z]{2,16}(?:-[A-Za-z0-9]{2,16})?$/u.test(value)) throw new Error('ASR language is invalid')
}

function requireConfidence(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`)
}

function requireTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`)
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${label} is out of range`)
}
