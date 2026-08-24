import assert from 'node:assert/strict'
import test from 'node:test'

import { BehaviorOrchestrator } from '../src/behavior/behavior-orchestrator.ts'
import { SpeechRuntime } from '../src/speech/speech-runtime.ts'
import { createFixtureTtsAdapter, createRuleBasedAgent } from '../src/speech/types.ts'

test('speech runtime completes ASR text -> agent plan -> TTS publication', async () => {
  const behavior = new BehaviorOrchestrator({ now: () => 1_000 })
  const published: Array<{ id: string, durationMs: number, bytes: number }> = []
  const runtime = new SpeechRuntime({
    orchestrator: behavior,
    agent: createRuleBasedAgent(),
    tts: createFixtureTtsAdapter(),
    now: () => 1_000,
    createId: () => 'turn-1',
    publishSpeech: input => {
      published.push({ id: input.id, durationMs: input.synthesis.durationMs, bytes: input.synthesis.audio.byteLength })
      return {
        id: input.id,
        displayName: input.displayName,
        audioUrl: 'http://127.0.0.1:32145/assets/0123456789abcdef/reply.wav',
        cuesUrl: 'http://127.0.0.1:32145/assets/0123456789abcdef/reply.cues.json',
        mimeType: input.synthesis.mimeType,
        durationMs: input.synthesis.durationMs,
      }
    },
  })
  assert.equal(runtime.submitText('你好'), 'started')
  for (let index = 0; index < 20 && published.length === 0; index += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(published.length, 1)
  assert.equal(published[0]?.id, 'turn-1.reply')
  assert.ok((published[0]?.bytes ?? 0) > 44)
  behavior.close()
})

test('speech runtime cancels a stale agent turn before TTS publication', async () => {
  const behavior = new BehaviorOrchestrator()
  let calls = 0
  const published: string[] = []
  const agent = {
    async plan(input: { signal: AbortSignal, event: { correlationId: string }, transcript: { text: string } }) {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, input.transcript.text === 'slow' ? 30 : 1))
      return {
        version: 'rayure.behavior-plan.v1' as const,
        correlationId: input.event.correlationId,
        replyText: input.transcript.text,
        speak: true,
      }
    },
  }
  const runtime = new SpeechRuntime({
    orchestrator: behavior,
    agent,
    tts: createFixtureTtsAdapter(),
    createId: (() => {
      let count = 0
      return () => `turn-${++count}`
    })(),
    publishSpeech: input => {
      published.push(input.id)
      return {
        id: input.id,
        displayName: input.displayName,
        audioUrl: 'http://127.0.0.1:32145/assets/0123456789abcdef/reply.wav',
        cuesUrl: 'http://127.0.0.1:32145/assets/0123456789abcdef/reply.cues.json',
        mimeType: input.synthesis.mimeType,
        durationMs: input.synthesis.durationMs,
      }
    },
  })
  assert.equal(runtime.submitText('slow'), 'started')
  assert.equal(runtime.submitText('fast'), 'superseded')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(published, ['turn-2.reply'])
  assert.equal(calls, 2)
  behavior.close()
})
