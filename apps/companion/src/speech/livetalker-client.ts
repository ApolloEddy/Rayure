import type { MouthCue } from '@rayure/protocol'

import type { BehaviorEmotion, BehaviorEvent, BehaviorPlan } from '../behavior/types.ts'
import { validateAgentOutput, validateTtsSynthesis } from './types.ts'
import type { AgentAdapter, AsrTranscript, TtsAdapter, TtsSynthesis } from './types.ts'

export const DEFAULT_LIVETALKER_BASE_URL = 'http://127.0.0.1:8020'
export const DEFAULT_LIVETALKER_TIMEOUT_MS = 30_000
const MAX_LIVETALKER_RESPONSE_BYTES = 24 * 1024 * 1024
const DEFAULT_MOTION_BY_KEYWORD: Readonly<Record<string, string>> = {
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

export interface LiveTalkerClientOptions {
  baseUrl: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  language?: string
  motionByKeyword?: Readonly<Record<string, string>>
}

/**
 * Adapts LiveTalker's /api/chat response to Rayure's strict BehaviorPlan.
 * LiveTalker remains provider-owned; no API key crosses this boundary.
 */
export function createLiveTalkerAgentAdapter(options: LiveTalkerClientOptions): AgentAdapter {
  const baseUrl = validateLiveTalkerBaseUrl(options.baseUrl)
  const timeoutMs = validateLiveTalkerTimeout(options.timeoutMs ?? DEFAULT_LIVETALKER_TIMEOUT_MS)
  const fetchImpl = options.fetchImpl ?? fetch
  const motionByKeyword = normalizeMotionMap(options.motionByKeyword ?? DEFAULT_MOTION_BY_KEYWORD)
  const history: Array<{ role: 'user' | 'assistant', content: string }> = []

  return {
    async plan(input): Promise<BehaviorPlan> {
      if (input.signal.aborted) throw new Error('LiveTalker Agent request aborted')
      const controller = new AbortController()
      const unlink = linkAbortSignal(input.signal, controller)
      const timeout = setTimeout(() => controller.abort('livetalker-agent-timeout'), timeoutMs)
      try {
        const response = await fetchImpl(joinLiveTalkerUrl(baseUrl, '/api/chat'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            text: input.transcript.text,
            history: history.slice(-12),
          }),
          signal: controller.signal,
        })
        const body = await response.text()
        if (Buffer.byteLength(body, 'utf8') > 64 * 1024) throw new Error('LiveTalker Agent response exceeds 64 KiB')
        if (!response.ok) throw new Error(`LiveTalker Agent request failed with HTTP ${response.status}`)
        const reply = parseLiveTalkerChatResponse(body)
        if (input.signal.aborted) throw new Error('LiveTalker Agent request aborted')
        const plan = createBehaviorPlan(input.event, input.transcript, reply, motionByKeyword)
        history.push({ role: 'user', content: input.transcript.text }, { role: 'assistant', content: reply })
        if (history.length > 12) history.splice(0, history.length - 12)
        return validateAgentOutput(input.event, input.transcript, plan)
      }
      finally {
        clearTimeout(timeout)
        unlink()
      }
    },
  }
}

/** Adapts LiveTalker's PCM16 /api/synthesize output to Rayure speech playback. */
export function createLiveTalkerTtsAdapter(options: LiveTalkerClientOptions): TtsAdapter {
  const baseUrl = validateLiveTalkerBaseUrl(options.baseUrl)
  const timeoutMs = validateLiveTalkerTimeout(options.timeoutMs ?? DEFAULT_LIVETALKER_TIMEOUT_MS)
  const fetchImpl = options.fetchImpl ?? fetch
  const language = options.language ?? 'Chinese'

  return {
    async synthesize(input): Promise<TtsSynthesis> {
      if (input.signal.aborted) throw new Error('LiveTalker TTS request aborted')
      const controller = new AbortController()
      const unlink = linkAbortSignal(input.signal, controller)
      const timeout = setTimeout(() => controller.abort('livetalker-tts-timeout'), timeoutMs)
      try {
        const response = await fetchImpl(joinLiveTalkerUrl(baseUrl, '/api/synthesize'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
          body: JSON.stringify({
            text: input.text,
            language,
            ...(input.emotion === undefined ? {} : { instruct: liveTalkerEmotion(input.emotion) }),
          }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`LiveTalker TTS request failed with HTTP ${response.status}`)
        const audio = new Uint8Array(await response.arrayBuffer())
        if (audio.byteLength > MAX_LIVETALKER_RESPONSE_BYTES) throw new Error('LiveTalker TTS audio exceeds 24 MiB')
        const wav = parsePcm16Wav(audio)
        const synthesis = {
          mimeType: 'audio/wav' as const,
          audio,
          durationMs: wav.durationMs,
          cues: createMouthCues(audio, wav),
        }
        return validateTtsSynthesis(synthesis)
      }
      finally {
        clearTimeout(timeout)
        unlink()
      }
    },
  }
}

export function validateLiveTalkerBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || value.trim() !== value || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error('LiveTalker baseUrl must be a trimmed printable URL')
  }
  let url: URL
  try { url = new URL(value) } catch { throw new Error('LiveTalker baseUrl must be a valid URL') }
  if (url.username || url.password || url.search || url.hash) throw new Error('LiveTalker baseUrl must not contain credentials, query or hash')
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('LiveTalker baseUrl must be HTTPS or loopback HTTP')
  }
  return url.href.replace(/\/+$/u, '')
}

export function validateLiveTalkerTimeout(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 250 || (value as number) > 120_000) {
    throw new Error('LiveTalker timeoutMs must be an integer from 250 through 120000')
  }
  return value as number
}

export function validateLiveTalkerLanguage(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 32 || value.trim() !== value || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error('LiveTalker language must be a trimmed printable string up to 32 characters')
  }
  return value
}

export function validateLiveTalkerMotionByKeyword(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LiveTalker motionByKeyword must be an object')
  return normalizeMotionMap(value as Readonly<Record<string, string>>)
}

export function parseLiveTalkerChatResponse(raw: string): string {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('LiveTalker chat response must be valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LiveTalker chat response must be an object')
  const root = value as Record<string, unknown>
  if (typeof root.reply !== 'string' || root.reply.trim() !== root.reply || root.reply.length < 1 || root.reply.length > 4096) {
    throw new Error('LiveTalker chat response reply is invalid')
  }
  return root.reply
}

interface ParsedWav {
  sampleRate: number
  channels: number
  blockAlign: number
  bitsPerSample: number
  dataOffset: number
  dataLength: number
  durationMs: number
}

function createBehaviorPlan(event: BehaviorEvent, transcript: AsrTranscript, reply: string, motionByKeyword: Readonly<Record<string, string>>): BehaviorPlan {
  const emotionMatch = /^\s*[\[【]([^\]】\s]{1,32})[\]】]\s*/u.exec(reply)
  const emotion = emotionFromTag(emotionMatch?.[1])
  const explicitMotion = /[\[【](?:动作|motion)\s*[:：=]\s*([A-Za-z0-9._:-]{1,96})[\]】]/iu.exec(reply)?.[1]
  const textWithoutTags = reply
    .replace(/^\s*[\[【][^\]】\s]{1,32}[\]】]\s*/u, '')
    .replace(/[\[【](?:动作|motion)\s*[:：=]\s*[A-Za-z0-9._:-]{1,96}[\]】]/giu, '')
    .trim()
  const normalized = transcript.text.toLowerCase()
  const keywordMotion = explicitMotion ?? Object.entries(motionByKeyword).find(([keyword]) => normalized.includes(keyword.toLowerCase()))?.[1]
  return {
    version: 'rayure.behavior-plan.v1',
    correlationId: event.correlationId,
    ...(textWithoutTags.length === 0 ? {} : { replyText: textWithoutTags }),
    ...(emotion === undefined ? {} : { emotion }),
    ...(keywordMotion === undefined ? {} : { motionIntentId: keywordMotion }),
    speak: textWithoutTags.length > 0,
  }
}

function emotionFromTag(tag: string | undefined): BehaviorEmotion | undefined {
  if (tag === undefined) return undefined
  const normalized = tag.toLowerCase()
  if (['开心', '高兴', '快乐', 'happy'].includes(normalized)) return 'happy'
  if (['悲伤', '难过', 'sad'].includes(normalized)) return 'sad'
  if (['惊讶', '惊喜', 'surprised'].includes(normalized)) return 'surprised'
  if (['担心', '关心', 'concerned'].includes(normalized)) return 'concerned'
  if (['平静', '中性', 'neutral'].includes(normalized)) return 'neutral'
  return undefined
}

function liveTalkerEmotion(emotion: BehaviorEmotion): string {
  switch (emotion) {
    case 'happy': return '开心'
    case 'sad': return '悲伤'
    case 'surprised': return '惊讶'
    case 'concerned': return '关心'
    case 'neutral': return '平静'
  }
}

function normalizeMotionMap(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const entries = Object.entries(value)
  if (entries.length > 64) throw new Error('LiveTalker motionByKeyword must contain at most 64 items')
  const normalized: Record<string, string> = {}
  for (const [keyword, intent] of entries) {
    if (keyword.length < 1 || keyword.length > 96 || /[\u0000-\u001F\u007F]/u.test(keyword)) throw new Error('LiveTalker motion keyword is invalid')
    if (!/^[A-Za-z0-9._:-]{1,96}$/u.test(intent)) throw new Error('LiveTalker motion intent is invalid')
    normalized[keyword.toLowerCase()] = intent
  }
  return normalized
}

function parsePcm16Wav(audio: Uint8Array): ParsedWav {
  if (audio.byteLength < 44 || ascii(audio, 0, 4) !== 'RIFF' || ascii(audio, 8, 4) !== 'WAVE') throw new Error('LiveTalker TTS response is not a RIFF WAV')
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  let offset = 12
  let sampleRate = 0
  let channels = 0
  let blockAlign = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataLength = 0
  while (offset + 8 <= audio.byteLength) {
    const id = ascii(audio, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (body + size > audio.byteLength) throw new Error('LiveTalker TTS WAV chunk exceeds response')
    if (id === 'fmt ') {
      if (size < 16) throw new Error('LiveTalker TTS WAV fmt chunk is incomplete')
      if (view.getUint16(body, true) !== 1) throw new Error('LiveTalker TTS WAV must use PCM encoding')
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      blockAlign = view.getUint16(body + 12, true)
      bitsPerSample = view.getUint16(body + 14, true)
    }
    else if (id === 'data') {
      dataOffset = body
      dataLength = size
    }
    offset = body + size + (size % 2)
  }
  if (sampleRate < 1 || channels < 1 || channels > 2 || bitsPerSample !== 16 || blockAlign !== channels * 2 || dataOffset < 0 || dataLength < blockAlign) {
    throw new Error('LiveTalker TTS WAV format is unsupported')
  }
  const frameCount = Math.floor(dataLength / blockAlign)
  return { sampleRate, channels, blockAlign, bitsPerSample, dataOffset, dataLength, durationMs: Math.max(1, Math.round(frameCount / sampleRate * 1000)) }
}

function createMouthCues(audio: Uint8Array, wav: ParsedWav): readonly MouthCue[] {
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  const bytesPerFrame = wav.blockAlign
  const windowFrames = Math.max(1, Math.round(wav.sampleRate * 0.04))
  const frameCount = Math.floor(wav.dataLength / bytesPerFrame)
  const cues: MouthCue[] = []
  for (let frame = 0; frame < frameCount; frame += windowFrames) {
    const end = Math.min(frameCount, frame + windowFrames)
    let sum = 0
    let samples = 0
    for (let current = frame; current < end; current += 1) {
      const frameOffset = wav.dataOffset + current * bytesPerFrame
      for (let channel = 0; channel < wav.channels; channel += 1) {
        const sample = view.getInt16(frameOffset + channel * 2, true) / 32768
        sum += sample * sample
        samples += 1
      }
    }
    const rms = samples === 0 ? 0 : Math.sqrt(sum / samples)
    const value = Math.max(0, Math.min(1, Math.round(rms * 5 * 1000) / 1000))
    cues.push({ timeMs: Math.min(wav.durationMs, Math.round(frame / wav.sampleRate * 1000)), value })
  }
  return cues
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function joinLiveTalkerUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`
}

function linkAbortSignal(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort(source.reason ?? 'aborted')
  if (source.aborted) abort()
  else source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}
