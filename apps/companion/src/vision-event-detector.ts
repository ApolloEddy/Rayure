import type { BehaviorEvent } from './behavior/types.ts'
import { parseVisionObservation } from './vision-process-protocol.ts'
import type { VisionHandObservation, VisionObservation } from './vision-process-protocol.ts'

const PRESENCE_ENTER_THRESHOLD = 0.65
const PRESENCE_LEAVE_THRESHOLD = 0.35
const HEAD_LEFT_THRESHOLD = -25
const HEAD_RIGHT_THRESHOLD = 25
const HEAD_CENTER_THRESHOLD = 12
const WAVE_WINDOW_MS = 1_500
const WAVE_COOLDOWN_MS = 5_000
const HAND_RAISE_HOLD_COUNT = 4

type PresenceState = 'absent' | 'present'
type HeadDirection = 'left' | 'right' | 'center' | undefined
type HandName = 'left' | 'right'

interface HandTrack {
  lastX: number | undefined
  lastAtMs: number | undefined
  directions: Array<'left' | 'right'>
  directionChanges: number
  aboveShoulderCount: number
  raised: boolean
  lastWaveAtMs: number
}

export interface VisionEventDetectorOptions {
  eventTtlMs?: number
}

export class VisionEventDetector {
  readonly #eventTtlMs: number
  readonly #hands: Record<HandName, HandTrack> = {
    left: createHandTrack(),
    right: createHandTrack(),
  }
  #presence: PresenceState = 'absent'
  #presenceEnterCount = 0
  #presenceLeaveCount = 0
  #headDirection: HeadDirection
  #lastObservedAtMs = -1

  constructor(options: VisionEventDetectorOptions = {}) {
    this.#eventTtlMs = Math.max(100, Math.min(10_000, Math.trunc(options.eventTtlMs ?? 1_000)))
  }

  observe(raw: VisionObservation | string): readonly BehaviorEvent[] {
    const observation = typeof raw === 'string' ? parseVisionObservation(raw) : raw
    if (observation.observedAtMs <= this.#lastObservedAtMs) return []
    this.#lastObservedAtMs = observation.observedAtMs
    const events: BehaviorEvent[] = []
    const correlationId = `vision-${observation.id}`

    this.#updatePresence(observation, correlationId, events)
    this.#updateHead(observation, correlationId, events)
    this.#updateHand('left', observation.leftHand, observation, correlationId, events)
    this.#updateHand('right', observation.rightHand, observation, correlationId, events)
    return events
  }

  reset(): void {
    this.#presence = 'absent'
    this.#presenceEnterCount = 0
    this.#presenceLeaveCount = 0
    this.#headDirection = undefined
    this.#lastObservedAtMs = -1
    this.#hands.left = createHandTrack()
    this.#hands.right = createHandTrack()
  }

  #updatePresence(observation: VisionObservation, correlationId: string, events: BehaviorEvent[]): void {
    if (observation.presenceConfidence >= PRESENCE_ENTER_THRESHOLD) {
      this.#presenceEnterCount += 1
      this.#presenceLeaveCount = 0
    }
    else if (observation.presenceConfidence <= PRESENCE_LEAVE_THRESHOLD) {
      this.#presenceLeaveCount += 1
      this.#presenceEnterCount = 0
    }
    else {
      this.#presenceEnterCount = 0
      this.#presenceLeaveCount = 0
    }

    if (this.#presence === 'absent' && this.#presenceEnterCount >= 3) {
      this.#presence = 'present'
      events.push(this.#event(observation, correlationId, 'presence.enter', observation.presenceConfidence))
    }
    else if (this.#presence === 'present' && this.#presenceLeaveCount >= 5) {
      this.#presence = 'absent'
      events.push(this.#event(observation, correlationId, 'presence.leave', 1 - observation.presenceConfidence))
    }
  }

  #updateHead(observation: VisionObservation, correlationId: string, events: BehaviorEvent[]): void {
    const head = observation.head
    if (head === undefined || head.confidence < 0.5) return
    const next = head.yaw <= HEAD_LEFT_THRESHOLD
      ? 'left'
      : head.yaw >= HEAD_RIGHT_THRESHOLD
        ? 'right'
        : Math.abs(head.yaw) <= HEAD_CENTER_THRESHOLD ? 'center' : this.#headDirection
    if (next === undefined || next === this.#headDirection) return
    this.#headDirection = next
    events.push(this.#event(observation, correlationId, `head.${next}`, head.confidence, { yaw: head.yaw, pitch: head.pitch }))
  }

  #updateHand(
    handName: HandName,
    observation: VisionHandObservation | undefined,
    source: VisionObservation,
    correlationId: string,
    events: BehaviorEvent[],
  ): void {
    const track = this.#hands[handName]
    if (observation === undefined || observation.confidence < 0.45) {
      track.lastX = undefined
      track.lastAtMs = undefined
      track.directions = []
      track.directionChanges = 0
      track.aboveShoulderCount = 0
      track.raised = false
      return
    }

    const [x, y] = observation.wrist
    const aboveShoulder = y < observation.shoulderY - 0.05
    track.aboveShoulderCount = aboveShoulder ? track.aboveShoulderCount + 1 : 0
    if (track.aboveShoulderCount >= HAND_RAISE_HOLD_COUNT && !track.raised) {
      track.raised = true
      events.push(this.#event(source, correlationId, 'gesture.hand_raise', observation.confidence, { hand: handName }))
    }
    if (!aboveShoulder) track.raised = false

    const previousX = track.lastX
    const previousAtMs = track.lastAtMs
    track.lastX = x
    track.lastAtMs = source.observedAtMs
    if (previousX === undefined || previousAtMs === undefined || source.observedAtMs - previousAtMs > WAVE_WINDOW_MS) {
      track.directions = []
      track.directionChanges = 0
      return
    }
    const delta = x - previousX
    if (Math.abs(delta) < 0.035 || !aboveShoulder) return
    const direction = delta > 0 ? 'right' : 'left'
    const lastDirection = track.directions.at(-1)
    if (lastDirection !== direction) {
      track.directions.push(direction)
      if (lastDirection !== undefined) track.directionChanges += 1
    }
    while (track.directions.length > 8) track.directions.shift()
    if (track.directionChanges >= 3 && source.observedAtMs - track.lastWaveAtMs >= WAVE_COOLDOWN_MS) {
      track.lastWaveAtMs = source.observedAtMs
      track.directionChanges = 0
      track.directions = []
      events.push(this.#event(source, correlationId, 'gesture.wave', observation.confidence, { hand: handName }))
    }
  }

  #event(
    observation: VisionObservation,
    correlationId: string,
    type: BehaviorEvent['type'],
    confidence: number,
    data?: Readonly<Record<string, string | number | boolean>>,
  ): BehaviorEvent {
    return {
      version: 'rayure.behavior-event.v1',
      id: `vision:${observation.id}:${type}`,
      source: 'vision',
      type,
      correlationId,
      observedAtMs: observation.observedAtMs,
      expiresAtMs: observation.observedAtMs + this.#eventTtlMs,
      confidence: Math.max(0, Math.min(1, confidence)),
      ...(data === undefined ? {} : { data }),
    }
  }
}

function createHandTrack(): HandTrack {
  return {
    lastX: undefined,
    lastAtMs: undefined,
    directions: [],
    directionChanges: 0,
    aboveShoulderCount: 0,
    raised: false,
    lastWaveAtMs: -Infinity,
  }
}
