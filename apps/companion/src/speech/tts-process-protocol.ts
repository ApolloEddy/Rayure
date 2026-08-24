import { Buffer } from 'node:buffer'

import { validateTtsSynthesis } from './types.ts'
import type { TtsSynthesis } from './types.ts'

export const TTS_REQUEST_VERSION = 'rayure.tts-request.v1' as const
export const TTS_RESPONSE_VERSION = 'rayure.tts-response.v1' as const

export interface TtsProcessRequest {
  version: typeof TTS_REQUEST_VERSION
  requestId: string
  speechId: string
  text: string
}

export function createTtsProcessRequest(input: { requestId: string, speechId: string, text: string }): TtsProcessRequest {
  requireIdentifier(input.requestId, 'TTS requestId')
  requireIdentifier(input.speechId, 'TTS speechId')
  requireText(input.text)
  return { version: TTS_REQUEST_VERSION, requestId: input.requestId, speechId: input.speechId, text: input.text }
}

export function serializeTtsProcessRequest(request: TtsProcessRequest): string {
  return JSON.stringify(createTtsProcessRequest(request))
}

export function parseTtsProcessResponse(raw: string, expectedRequestId: string): TtsSynthesis {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 24 * 1024 * 1024) throw new Error('TTS response line is out of range')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('TTS response must be valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TTS response must be an object')
  const root = value as Record<string, unknown>
  const expected = ['version', 'requestId', 'mimeType', 'audioBase64', 'durationMs', 'cues']
  if (Object.keys(root).sort().join('|') !== expected.slice().sort().join('|')) throw new Error('TTS response contains missing or unknown fields')
  if (root.version !== TTS_RESPONSE_VERSION || root.requestId !== expectedRequestId || typeof root.audioBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(root.audioBase64) || root.audioBase64.length % 4 !== 0) throw new Error('TTS response identity or audio is invalid')
  const audio = Uint8Array.from(Buffer.from(root.audioBase64, 'base64'))
  if (audio.byteLength === 0) throw new Error('TTS response audio is empty')
  return validateTtsSynthesis({
    mimeType: root.mimeType as TtsSynthesis['mimeType'],
    audio,
    durationMs: root.durationMs as number,
    cues: root.cues as TtsSynthesis['cues'],
  })
}

function requireIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,96}$/u.test(value)) throw new Error(`${label} is invalid`)
}

function requireText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 4096 || /[\u0000-\u001F\u007F]/u.test(value)) throw new Error('TTS text is invalid')
}
