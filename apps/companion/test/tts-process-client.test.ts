import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

import { TtsProcessClient, validateTtsProcessArgs } from '../src/speech/tts-process-client.ts'
import { parseTtsProcessResponse } from '../src/speech/tts-process-protocol.ts'

test('TTS process client sends a request and returns audio plus cues', async () => {
  const audioBase64 = Buffer.from([1, 2, 3, 4]).toString('base64')
  const response = JSON.stringify({ version: 'rayure.tts-response.v1', requestId: '__REQUEST_ID__', mimeType: 'audio/wav', audioBase64, durationMs: 100, cues: [{ timeMs: 0, value: 0.2 }] })
  const script = `process.stdin.on('data',b=>{const r=JSON.parse(b);process.stdout.write(${JSON.stringify(`${response}\n`)}.replace('__REQUEST_ID__',r.requestId))})`
  const client = new TtsProcessClient({ command: process.execPath, args: ['-e', script], requestTimeoutMs: 1000 })
  const result = await client.synthesize({ speechId: 'reply', text: 'hello', signal: new AbortController().signal })
  assert.deepEqual([...result.audio], [1, 2, 3, 4])
  assert.equal(result.cues[0]?.value, 0.2)
  await client.close()
})

test('TTS process protocol rejects mismatched identity and unsafe args', () => {
  assert.throws(() => parseTtsProcessResponse(JSON.stringify({ version: 'rayure.tts-response.v1', requestId: 'other', mimeType: 'audio/wav', audioBase64: 'AQ==', durationMs: 100, cues: [] }), 'expected'), /identity/i)
  assert.throws(() => validateTtsProcessArgs(['bad\n']), /arg/i)
})
