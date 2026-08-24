import assert from 'node:assert/strict'
import test from 'node:test'

import { VisionProcessClient } from '../src/vision-process-client.ts'
import type { VisionObservation } from '../src/vision-process-protocol.ts'

function line(id: string): string {
  return JSON.stringify({
    version: 'rayure.vision-observation.v1',
    id,
    observedAtMs: 1,
    presenceConfidence: 0.8,
    head: { yaw: 0, pitch: 0, confidence: 0.9 },
  })
}

function waitFor<T>(predicate: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const startedAt = Date.now()
    const tick = (): void => {
      const value = predicate()
      if (value !== undefined) {
        resolve(value)
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('timed out waiting for vision process'))
        return
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}

test('vision process client parses a valid child observation and closes cleanly', async () => {
  const observations: VisionObservation[] = []
  const errors: Error[] = []
  const script = `process.stdout.write(${JSON.stringify(`${line('frame-1')}\n`)}); setTimeout(() => {}, 1000)`
  const client = new VisionProcessClient({
    command: process.execPath,
    args: ['-e', script],
    onObservation: observation => observations.push(observation),
    onError: error => errors.push(error),
  })
  await waitFor(() => observations[0])
  assert.equal(observations[0]?.id, 'frame-1')
  assert.deepEqual(errors, [])
  await client.close()
  assert.equal(client.closed, true)
})

test('vision process client fails closed on malformed output and redacts multiline diagnostics', async () => {
  const errors: Error[] = []
  const script = `process.stderr.write('bad\\nline'); process.stdout.write('not-json\\n'); setTimeout(() => {}, 1000)`
  const client = new VisionProcessClient({
    command: process.execPath,
    args: ['-e', script],
    onObservation: () => {},
    onError: error => errors.push(error),
  })
  await waitFor(() => errors[0])
  assert.match(errors[0]!.message, /Vision process failed/i)
  assert.doesNotMatch(errors[0]!.message, /\r|\n/u)
  await client.close()
})

test('vision process client rejects unsafe launch settings', () => {
  assert.throws(() => new VisionProcessClient({ command: 'node\n', onObservation: () => {} }), /command/i)
  assert.throws(() => new VisionProcessClient({ command: 'node', args: ['bad\n'], onObservation: () => {} }), /arg/i)
  assert.throws(() => new VisionProcessClient({ command: 'node', cwd: 'relative', onObservation: () => {} }), /cwd/i)
})
