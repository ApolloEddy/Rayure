import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalMotion } from '@rayure/protocol'

import { MotionIdlePool } from '../src/motion-idle-pool.ts'
import type { MotionScheduleSegment } from '../src/motion-scheduler.ts'

function segment(intentId: string): MotionScheduleSegment {
  return {
    intentId,
    prompt: intentId,
    motion: {} as CanonicalMotion,
  }
}

test('idle pool prefetches the next action in the lookahead window and commits at handoff', async () => {
  const requested: string[] = []
  const committed: string[] = []
  let prepared: MotionScheduleSegment | undefined
  const pool = new MotionIdlePool({
    actions: [
      { id: 'idle-a', prompt: 'breathe calmly' },
      { id: 'idle-b', prompt: 'shift weight' },
    ],
    lookaheadMs: 1_000,
    handoffMs: 200,
    prefetch: async intent => {
      requested.push(intent.id)
      prepared = segment(intent.id)
      return prepared
    },
    commit: () => {
      if (prepared === undefined) return false
      committed.push(prepared.intentId)
      return true
    },
    discard: () => undefined,
  })

  assert.equal(pool.adoptCurrent('idle-a'), true)
  pool.observe({ intentId: 'idle-a', phase: 'progress', remainingMs: 900 })
  await Promise.resolve()
  assert.deepEqual(requested, ['idle-b'])
  assert.equal(pool.prefetchedIntentId, 'idle-b')
  assert.deepEqual(committed, [])

  pool.observe({ intentId: 'idle-a', phase: 'progress', remainingMs: 150 })
  assert.deepEqual(committed, ['idle-b'])
  assert.equal(pool.activeIntentId, 'idle-b')
  assert.equal(pool.prefetchedIntentId, undefined)
})

test('idle pool primes a single-action loop and commits after prefetch resolves', async () => {
  let prepared: MotionScheduleSegment | undefined
  let commits = 0
  const pool = new MotionIdlePool({
    actions: [{ id: 'idle-loop', prompt: 'stand naturally' }],
    prefetch: async intent => {
      prepared = segment(intent.id)
      return prepared
    },
    commit: () => {
      commits += 1
      return prepared !== undefined
    },
    discard: () => undefined,
  })

  pool.prime()
  await Promise.resolve()
  assert.equal(commits, 1)
  assert.equal(pool.activeIntentId, 'idle-loop')
})

test('idle pool prime starts with the first configured action', async () => {
  const requested: string[] = []
  let commits = 0
  const pool = new MotionIdlePool({
    actions: [
      { id: 'idle-first', prompt: 'first' },
      { id: 'idle-second', prompt: 'second' },
    ],
    prefetch: async intent => {
      requested.push(intent.id)
      return segment(intent.id)
    },
    commit: () => {
      commits += 1
      return true
    },
    discard: () => undefined,
  })

  pool.prime()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(requested, ['idle-first'])
  assert.equal(commits, 1)
  assert.equal(pool.activeIntentId, 'idle-first')
})

test('interrupt cancels stale idle work and prevents a late prefetch from becoming active', async () => {
  let resolve!: (value: MotionScheduleSegment) => void
  let discarded = 0
  let commits = 0
  const pool = new MotionIdlePool({
    actions: [
      { id: 'idle-a', prompt: 'breathe calmly' },
      { id: 'idle-b', prompt: 'shift weight' },
    ],
    prefetch: () => new Promise<MotionScheduleSegment>(done => { resolve = done }),
    commit: () => { commits += 1; return true },
    discard: () => { discarded += 1 },
  })

  pool.adoptCurrent('idle-a')
  pool.observe({ intentId: 'idle-a', phase: 'progress', remainingMs: 100 })
  pool.interrupt()
  resolve(segment('idle-b'))
  await Promise.resolve()

  assert.equal(discarded, 1)
  assert.equal(commits, 0)
  assert.equal(pool.activeIntentId, undefined)
  assert.equal(pool.prefetchedIntentId, undefined)
})
