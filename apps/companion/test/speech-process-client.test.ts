import assert from 'node:assert/strict'
import test from 'node:test'

import { SpeechProcessClient, validateSpeechProcessArgs } from '../src/speech/process-client.ts'

test('speech process client parses one final transcript and closes', async () => {
  const line = JSON.stringify({
    version: 'rayure.asr-transcript.v1',
    turnId: 'turn-1',
    text: 'wave',
    confidence: 0.96,
    observedAtMs: Date.now(),
  })
  const transcripts: string[] = []
  const client = new SpeechProcessClient({
    command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(`${line}\n`)})`],
    startupTimeoutMs: 1000,
    onTranscript: transcript => transcripts.push(transcript.text),
  })
  for (let index = 0; index < 20 && transcripts.length === 0; index += 1) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(transcripts, ['wave'])
  await client.close()
})

test('speech process client fails closed on malformed output and bounded settings', async () => {
  const errors: string[] = []
  const client = new SpeechProcessClient({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("{bad\\n")'],
    startupTimeoutMs: 1000,
    onTranscript: () => undefined,
    onError: cause => errors.push(cause.message),
  })
  for (let index = 0; index < 20 && errors.length === 0; index += 1) await new Promise(resolve => setTimeout(resolve, 10))
  assert.match(errors[0] ?? '', /ASR process failed/i)
  assert.throws(() => validateSpeechProcessArgs(['ok\n']), /arg/i)
  await client.close()
})

test('speech process client reports a non-zero bridge exit', async () => {
  const errors: string[] = []
  const client = new SpeechProcessClient({
    command: process.execPath,
    args: ['-e', 'process.exit(2)'],
    startupTimeoutMs: 1000,
    onTranscript: () => undefined,
    onError: cause => errors.push(cause.message),
  })
  for (let index = 0; index < 20 && errors.length === 0; index += 1) await new Promise(resolve => setTimeout(resolve, 10))
  assert.match(errors[0] ?? '', /exited with code 2/i)
  await client.close()
})
