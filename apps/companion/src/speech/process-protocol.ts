import type { AsrTranscript } from './types.ts'
import { ASR_TRANSCRIPT_VERSION, validateAsrTranscript } from './types.ts'

export function parseAsrTranscript(raw: string): AsrTranscript {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 16 * 1024) throw new Error('ASR transcript line must be a non-empty string up to 16 KiB')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    throw new Error('ASR transcript must be valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ASR transcript must be an object')
  const root = parsed as Record<string, unknown>
  const expected = ['version', 'turnId', 'text', 'confidence', 'observedAtMs']
  if (root.language !== undefined) expected.push('language')
  const actual = Object.keys(root).sort()
  const allowed = [...expected].sort()
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) throw new Error('ASR transcript contains missing or unknown fields')
  return validateAsrTranscript({
    version: root.version as typeof ASR_TRANSCRIPT_VERSION,
    turnId: root.turnId as string,
    text: root.text as string,
    ...(root.language === undefined ? {} : { language: root.language as string }),
    confidence: root.confidence as number,
    observedAtMs: root.observedAtMs as number,
  })
}

export function serializeAsrTranscript(transcript: AsrTranscript): string {
  return JSON.stringify(validateAsrTranscript(transcript))
}
