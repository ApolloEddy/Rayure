import assert from 'node:assert/strict'
import test from 'node:test'

import { createHttpAgentAdapter, parseAgentResponse, validateAgentEndpoint } from '../src/speech/agent-client.ts'

const event = {
  version: 'rayure.behavior-event.v1' as const,
  id: 'voice:turn-1',
  source: 'voice' as const,
  type: 'voice.final' as const,
  correlationId: 'turn-1',
  observedAtMs: 1000,
  expiresAtMs: 2000,
  confidence: 1,
}
const transcript = {
  version: 'rayure.asr-transcript.v1' as const,
  turnId: 'turn-1',
  text: 'wave',
  confidence: 1,
  observedAtMs: 1000,
}

test('HTTP Agent adapter posts a strict request and validates the structured plan', async () => {
  let requestBody = ''
  const adapter = createHttpAgentAdapter({
    endpoint: 'http://127.0.0.1:8123/agent',
    fetchImpl: async (_input, init) => {
      requestBody = String(init?.body)
      return new Response(JSON.stringify({
        version: 'rayure.agent-response.v1',
        plan: { version: 'rayure.behavior-plan.v1', correlationId: 'turn-1', replyText: 'ok', speak: true },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const plan = await adapter.plan({ event, transcript, signal: new AbortController().signal })
  assert.equal(plan.replyText, 'ok')
  assert.equal(JSON.parse(requestBody).version, 'rayure.agent-request.v1')
})

test('Agent adapter rejects mismatched response and unsafe endpoint', async () => {
  assert.throws(() => validateAgentEndpoint('https://example.com/agent?token=secret'), /endpoint/i)
  assert.throws(() => parseAgentResponse(JSON.stringify({ version: 'bad', plan: {} })), /response/i)
  const adapter = createHttpAgentAdapter({
    endpoint: 'http://127.0.0.1:8123/agent',
    fetchImpl: async () => new Response(JSON.stringify({
      version: 'rayure.agent-response.v1',
      plan: { version: 'rayure.behavior-plan.v1', correlationId: 'other' },
    }), { status: 200 }),
  })
  await assert.rejects(adapter.plan({ event, transcript, signal: new AbortController().signal }), /correlation/i)
})
