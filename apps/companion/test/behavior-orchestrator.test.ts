import assert from 'node:assert/strict'
import test from 'node:test'

import { BehaviorOrchestrator } from '../src/behavior/behavior-orchestrator.ts'
import type { BehaviorRequest } from '../src/behavior/types.ts'

function request(
  id: string,
  source: BehaviorRequest['source'],
  priority: number,
  execute: BehaviorRequest['execute'],
  expiresAtMs = 10_000,
): BehaviorRequest {
  return { id, source, priority, expiresAtMs, execute }
}

test('behavior orchestrator starts work and returns to idle', async () => {
  let resolve: (() => void) | undefined
  const orchestrator = new BehaviorOrchestrator({ now: () => 100 })
  const result = orchestrator.submit(request('turn-1', 'voice', 100, async ({ signal }) => {
    await new Promise<void>(complete => {
      resolve = complete
      signal.addEventListener('abort', () => complete(), { once: true })
    })
  }))
  assert.equal(result, 'started')
  assert.equal(orchestrator.snapshot().state, 'running')
  resolve?.()
  await new Promise<void>(resolveNext => setTimeout(resolveNext, 0))
  assert.equal(orchestrator.snapshot().state, 'idle')
})

test('lower-priority vision work cannot interrupt an active voice turn', () => {
  const orchestrator = new BehaviorOrchestrator({ now: () => 100 })
  let ran = false
  assert.equal(orchestrator.submit(request('voice-1', 'voice', 100, async () => { await new Promise(() => {}) })), 'started')
  assert.equal(orchestrator.submit(request('vision-1', 'vision', 50, async () => { ran = true })), 'ignored')
  assert.equal(ran, false)
  orchestrator.close()
})

test('new equal-priority work aborts the old generation and stale completion cannot clear the new one', async () => {
  let oldAborted = false
  let finishOld: (() => void) | undefined
  const orchestrator = new BehaviorOrchestrator({ now: () => 100 })
  assert.equal(orchestrator.submit(request('voice-1', 'voice', 100, async ({ signal }) => {
    await new Promise<void>(resolve => {
      finishOld = resolve
      signal.addEventListener('abort', () => { oldAborted = true }, { once: true })
    })
  })), 'started')
  assert.equal(orchestrator.submit(request('voice-2', 'voice', 100, async () => { await new Promise(() => {}) })), 'superseded')
  assert.equal(oldAborted, true)
  finishOld?.()
  await new Promise<void>(resolveNext => setTimeout(resolveNext, 0))
  assert.equal(orchestrator.snapshot().activeRequestId, 'voice-2')
  orchestrator.close()
})

test('duplicate and expired requests are rejected before execution', () => {
  let now = 100
  let calls = 0
  const orchestrator = new BehaviorOrchestrator({ now: () => now })
  const execute = async () => { calls += 1 }
  const first = request('same', 'direct', 80, execute, 200)
  assert.equal(orchestrator.submit(first), 'started')
  assert.equal(orchestrator.submit(first), 'ignored')
  now = 300
  assert.equal(orchestrator.submit(request('expired', 'vision', 50, execute, 200)), 'expired')
  assert.equal(calls, 1)
  orchestrator.close()
})

test('request errors are reported without poisoning the orchestrator', async () => {
  const errors: string[] = []
  const orchestrator = new BehaviorOrchestrator({
    now: () => 100,
    onError: (id, cause) => errors.push(`${id}:${String(cause)}`),
  })
  orchestrator.submit(request('bad', 'direct', 80, async () => { throw new Error('provider failed') }))
  await new Promise<void>(queueMicrotask)
  assert.deepEqual(errors, ['bad:Error: provider failed'])
  assert.equal(orchestrator.snapshot().state, 'idle')
})
