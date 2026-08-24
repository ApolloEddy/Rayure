import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createLiveTalkerAgentAdapter,
  createLiveTalkerTtsAdapter,
  validateLiveTalkerBaseUrl,
} from '../src/speech/livetalker-client.ts'

const event = {
  version: 'rayure.behavior-event.v1' as const,
  id: 'voice:turn-1',
  source: 'voice' as const,
  type: 'voice.final' as const,
  correlationId: 'turn-1',
  observedAtMs: 1000,
  expiresAtMs: 2000,
  confidence: 0.95,
}

const transcript = {
  version: 'rayure.asr-transcript.v1' as const,
  turnId: 'turn-1',
  text: '请挥手',
  confidence: 0.95,
  observedAtMs: 1000,
}

test('LiveTalker Agent adapter maps tagged reply to a strict behavior plan', async () => {
  let requestUrl = ''
  let requestBody: Record<string, unknown> | undefined
  const adapter = createLiveTalkerAgentAdapter({
    baseUrl: 'http://127.0.0.1:8020/',
    fetchImpl: async (input, init) => {
      requestUrl = String(input)
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ ok: true, reply: '[开心][动作:wave] 好呀' }), { status: 200 })
    },
  })

  const plan = await adapter.plan({ event, transcript, signal: new AbortController().signal })
  assert.equal(requestUrl, 'http://127.0.0.1:8020/api/chat')
  assert.equal(requestBody?.text, '请挥手')
  assert.deepEqual(plan, {
    version: 'rayure.behavior-plan.v1',
    correlationId: 'turn-1',
    replyText: '好呀',
    emotion: 'happy',
    motionIntentId: 'wave',
    speak: true,
  })
})

test('LiveTalker TTS adapter parses PCM WAV and derives bounded mouth cues', async () => {
  let requestBody: Record<string, unknown> | undefined
  const adapter = createLiveTalkerTtsAdapter({
    baseUrl: 'http://127.0.0.1:8020',
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      const wav = createPcmWav(8_000, 1600)
      return new Response(wav.buffer as ArrayBuffer, { status: 200, headers: { 'Content-Type': 'audio/wav' } })
    },
  })

  const result = await adapter.synthesize({
    speechId: 'turn-1.reply',
    text: '你好',
    emotion: 'happy',
    signal: new AbortController().signal,
  })
  assert.equal(requestBody?.instruct, '开心')
  assert.equal(requestBody?.language, 'Chinese')
  assert.equal(result.mimeType, 'audio/wav')
  assert.equal(result.durationMs, 200)
  assert.ok(result.cues.length > 0)
  assert.ok(result.cues.some(cue => cue.value > 0))
})

test('LiveTalker URL validation keeps credentials and public HTTP out', () => {
  assert.equal(validateLiveTalkerBaseUrl('http://localhost:8020/'), 'http://localhost:8020')
  assert.throws(() => validateLiveTalkerBaseUrl('http://example.com:8020'), /loopback|HTTPS/i)
  assert.throws(() => validateLiveTalkerBaseUrl('http://127.0.0.1:8020?key=secret'), /query/i)
})

function createPcmWav(sampleRate: number, samples: number): Uint8Array {
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
    view.setInt16(44 + index * 2, Math.round(Math.sin(index / sampleRate * Math.PI * 2 * 220) * 12_000), true)
  }
  return new Uint8Array(buffer)
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
}
