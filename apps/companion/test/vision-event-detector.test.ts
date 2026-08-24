import assert from 'node:assert/strict'
import test from 'node:test'

import { VisionEventDetector } from '../src/vision-event-detector.ts'
import { parseVisionObservation } from '../src/vision-process-protocol.ts'
import type { VisionObservation } from '../src/vision-process-protocol.ts'

function observation(
  id: string,
  observedAtMs: number,
  overrides: {
    presenceConfidence?: number
    head?: VisionObservation['head'] | undefined
    leftHand?: VisionObservation['leftHand'] | undefined
    rightHand?: VisionObservation['rightHand'] | undefined
  } = {},
): VisionObservation {
  const head = 'head' in overrides ? overrides.head : { yaw: 0, pitch: 0, confidence: 0.9 }
  return {
    version: 'rayure.vision-observation.v1',
    id,
    observedAtMs,
    presenceConfidence: overrides.presenceConfidence ?? 0.9,
    ...(head === undefined ? {} : { head }),
    ...('leftHand' in overrides && overrides.leftHand !== undefined ? { leftHand: overrides.leftHand } : {}),
    ...('rightHand' in overrides && overrides.rightHand !== undefined ? { rightHand: overrides.rightHand } : {}),
  }
}

function hand(x: number, y = 0.3) {
  return { wrist: [x, y] as [number, number], shoulderY: 0.55, confidence: 0.9 }
}

test('vision observation parser rejects unknown fields and unsafe coordinates', () => {
  assert.throws(() => parseVisionObservation(JSON.stringify({
    version: 'rayure.vision-observation.v1', id: '1', observedAtMs: 1, presenceConfidence: 1, extra: true,
  })), /unknown fields/i)
  assert.throws(() => parseVisionObservation(JSON.stringify({
    version: 'rayure.vision-observation.v1', id: '1', observedAtMs: 1, presenceConfidence: 1,
    head: { yaw: 0, pitch: 0, confidence: 1 },
    leftHand: { wrist: [3, 0], shoulderY: 0.5, confidence: 1 },
  })), /out of range/i)
})

test('presence enters after three confident observations and leaves after five absent observations', () => {
  const detector = new VisionEventDetector()
  assert.deepEqual(detector.observe(observation('a', 1, { head: undefined })), [])
  assert.deepEqual(detector.observe(observation('b', 2, { head: undefined })), [])
  assert.equal(detector.observe(observation('c', 3, { head: undefined }))[0]?.type, 'presence.enter')
  for (let index = 0; index < 4; index += 1) {
    assert.deepEqual(detector.observe(observation(`l${index}`, 10 + index, { presenceConfidence: 0.1, head: undefined })), [])
  }
  assert.equal(detector.observe(observation('l4', 20, { presenceConfidence: 0.1, head: undefined }))[0]?.type, 'presence.leave')
})

test('head direction uses thresholds and emits only on state changes', () => {
  const detector = new VisionEventDetector()
  detector.observe(observation('p1', 1, { head: undefined }))
  assert.equal(detector.observe(observation('p2', 2, { head: { yaw: -40, pitch: 2, confidence: 0.9 } }))[0]?.type, 'head.left')
  assert.deepEqual(detector.observe(observation('p3', 3, { head: { yaw: -30, pitch: 2, confidence: 0.9 } })).filter(event => event.type.startsWith('head.')), [])
  assert.equal(detector.observe(observation('p4', 4, { head: { yaw: 0, pitch: 0, confidence: 0.9 } }))[0]?.type, 'head.center')
})

test('hand raise requires a hold and is reset after lowering', () => {
  const detector = new VisionEventDetector()
  detector.observe(observation('p0', 0, { head: undefined }))
  for (let index = 1; index < 4; index += 1) {
    assert.deepEqual(detector.observe(observation(`p${index}`, index, { leftHand: hand(0.4), head: undefined })).filter(event => event.type === 'gesture.hand_raise'), [])
  }
  assert.equal(detector.observe(observation('p4', 4, { leftHand: hand(0.4) })).some(event => event.type === 'gesture.hand_raise'), true)
  assert.deepEqual(detector.observe(observation('p5', 5, { leftHand: hand(0.4, 0.7) })).filter(event => event.type === 'gesture.hand_raise'), [])
  assert.equal(detector.observe(observation('p6', 6, { leftHand: hand(0.4) })).some(event => event.type === 'gesture.hand_raise'), false)
})

test('alternating wrist movement emits a cooled wave event', () => {
  const detector = new VisionEventDetector()
  const points = [0.2, 0.35, 0.2, 0.35, 0.2, 0.35]
  let waveCount = 0
  for (let index = 0; index < points.length; index += 1) {
    const events = detector.observe(observation(`w${index}`, 100 + index * 100, { leftHand: hand(points[index]!) }))
    waveCount += events.filter(event => event.type === 'gesture.wave').length
  }
  assert.equal(waveCount, 1)
  const cooled = detector.observe(observation('w7', 800, { leftHand: hand(0.2) }))
  assert.equal(cooled.some(event => event.type === 'gesture.wave'), false)
  const afterCooldown = detector.observe(observation('w8', 6_000, { leftHand: hand(0.35) }))
  assert.equal(afterCooldown.some(event => event.type === 'gesture.wave'), false)
})

test('stale observations are ignored', () => {
  const detector = new VisionEventDetector()
  detector.observe(observation('new', 100))
  assert.deepEqual(detector.observe(observation('old', 99, { presenceConfidence: 0.1 })), [])
})
