import type { MotionPlaybackPhase } from '@rayure/protocol'

import type {
  MotionScheduleIntent,
  MotionScheduleSegment,
} from './motion-scheduler.ts'

export interface MotionIdleAction {
  id: string
  prompt: string
  numFrames?: number | undefined
  numDenoisingSteps?: number | undefined
  cfgWeight?: number | undefined
}

export interface MotionIdlePoolOptions {
  actions: readonly MotionIdleAction[]
  lookaheadMs?: number | undefined
  handoffMs?: number | undefined
  prefetch: (intent: MotionScheduleIntent) => Promise<MotionScheduleSegment>
  commit: () => boolean
  discard: () => void
  onError?: ((cause: unknown, intentId: string) => void) | undefined
}

export interface MotionIdlePlaybackObservation {
  intentId: string
  phase: MotionPlaybackPhase
  remainingMs?: number | undefined
}

const DEFAULT_LOOKAHEAD_MS = 1_200
const DEFAULT_HANDOFF_MS = 180

/**
 * Keeps an ARDY idle loop warm without publishing a segment before its handoff
 * window. It is intentionally renderer-agnostic: the controller feeds it
 * renderer-confirmed playback and owns the actual scheduler/publish side effect.
 */
export class MotionIdlePool {
  readonly #actions: readonly MotionIdleAction[]
  readonly #lookaheadMs: number
  readonly #handoffMs: number
  readonly #prefetch: MotionIdlePoolOptions['prefetch']
  readonly #commit: MotionIdlePoolOptions['commit']
  readonly #discard: MotionIdlePoolOptions['discard']
  readonly #onError: MotionIdlePoolOptions['onError']
  #cursor = 0
  #activeIntentId: string | undefined
  #prefetchedIntentId: string | undefined
  #prefetching = false
  #epoch = 0
  #lastPhase: MotionPlaybackPhase | undefined
  #lastRemainingMs: number | undefined

  constructor(options: MotionIdlePoolOptions) {
    this.#actions = validateActions(options.actions)
    this.#lookaheadMs = validateWindow(options.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS, 'lookaheadMs')
    this.#handoffMs = validateWindow(options.handoffMs ?? DEFAULT_HANDOFF_MS, 'handoffMs')
    if (this.#handoffMs > this.#lookaheadMs) {
      throw new Error('Motion idle pool handoffMs must not exceed lookaheadMs')
    }
    this.#prefetch = options.prefetch
    this.#commit = options.commit
    this.#discard = options.discard
    this.#onError = options.onError
  }

  get lookaheadMs(): number {
    return this.#lookaheadMs
  }

  get handoffMs(): number {
    return this.#handoffMs
  }

  get activeIntentId(): string | undefined {
    return this.#activeIntentId
  }

  get prefetchedIntentId(): string | undefined {
    return this.#prefetchedIntentId
  }

  get isPrefetching(): boolean {
    return this.#prefetching
  }

  /** Adopts a startup/current segment as the idle pool head when it is configured in the pool. */
  adoptCurrent(intentId: string): boolean {
    const index = this.#actions.findIndex(action => action.id === intentId)
    if (index < 0) return false
    this.#activeIntentId = intentId
    this.#cursor = index
    this.#lastPhase = undefined
    this.#lastRemainingMs = undefined
    return true
  }

  /** Starts the first idle action when no generated segment is currently playing. */
  prime(): void {
    if (this.#activeIntentId !== undefined || this.#actions.length === 0) return
    this.#activeIntentId = this.#actions[0]?.id
    // No segment is installed yet, so the first prefetch must produce the
    // first action rather than skipping directly to the second pool entry.
    this.#cursor = this.#actions.length - 1
    this.#lastPhase = 'completed'
    this.#lastRemainingMs = 0
    this.#ensurePrefetch()
  }

  /** Direct voice/vision actions clear stale idle work but do not cancel the current renderer pose. */
  interrupt(): void {
    this.#epoch += 1
    this.#activeIntentId = undefined
    this.#prefetchedIntentId = undefined
    this.#prefetching = false
    this.#lastPhase = undefined
    this.#lastRemainingMs = undefined
    this.#discard()
  }

  observe(observation: MotionIdlePlaybackObservation): void {
    if (this.#activeIntentId === undefined) {
      if (observation.phase === 'completed') this.prime()
      return
    }
    if (observation.intentId !== this.#activeIntentId) return

    this.#lastPhase = observation.phase
    this.#lastRemainingMs = observation.remainingMs
    if (observation.phase === 'cancelled') {
      this.#activeIntentId = undefined
      this.#prefetchedIntentId = undefined
      this.#prefetching = false
      this.#discard()
      return
    }

    if (
      observation.phase === 'started'
      || observation.phase === 'progress'
      || observation.phase === 'completed'
    ) {
      if (observation.phase === 'completed' || (observation.remainingMs !== undefined && observation.remainingMs <= this.#lookaheadMs)) {
        this.#ensurePrefetch()
      }
      if (this.#prefetchedIntentId !== undefined && (
        observation.phase === 'completed'
        || (observation.remainingMs !== undefined && observation.remainingMs <= this.#handoffMs)
      )) {
        this.#commitPrefetched()
      }
    }
  }

  #ensurePrefetch(): void {
    if (this.#prefetching || this.#prefetchedIntentId !== undefined || this.#activeIntentId === undefined) return
    const action = this.#nextAction()
    if (action === undefined) return
    const epoch = ++this.#epoch
    this.#prefetching = true
    void this.#prefetch(toIntent(action)).then(segment => {
      if (epoch !== this.#epoch) return
      this.#prefetching = false
      this.#prefetchedIntentId = segment.intentId
      if (
        this.#lastPhase === 'completed'
        || (this.#lastRemainingMs !== undefined && this.#lastRemainingMs <= this.#handoffMs)
      ) {
        this.#commitPrefetched()
      }
    }).catch(cause => {
      if (epoch !== this.#epoch) return
      this.#prefetching = false
      try {
        this.#onError?.(cause, action.id)
      }
      catch {
        // Diagnostics cannot own the idle lifecycle.
      }
    })
  }

  #commitPrefetched(): void {
    const intentId = this.#prefetchedIntentId
    if (intentId === undefined) return
    try {
      if (!this.#commit()) return
    }
    catch (cause) {
      try {
        this.#onError?.(cause, intentId)
      }
      catch {
        // Diagnostics cannot own the idle lifecycle.
      }
      return
    }
    const index = this.#actions.findIndex(action => action.id === intentId)
    if (index >= 0) this.#cursor = index
    this.#activeIntentId = intentId
    this.#prefetchedIntentId = undefined
    this.#lastPhase = 'started'
    this.#lastRemainingMs = undefined
  }

  #nextAction(): MotionIdleAction | undefined {
    if (this.#actions.length === 0) return undefined
    const current = this.#actions[this.#cursor]
    if (this.#actions.length === 1) return current
    const nextIndex = (this.#cursor + 1) % this.#actions.length
    return this.#actions[nextIndex]
  }
}

function toIntent(action: MotionIdleAction): MotionScheduleIntent {
  return {
    id: action.id,
    prompt: action.prompt,
    ...(action.numFrames === undefined ? {} : { numFrames: action.numFrames }),
    ...(action.numDenoisingSteps === undefined ? {} : { numDenoisingSteps: action.numDenoisingSteps }),
    ...(action.cfgWeight === undefined ? {} : { cfgWeight: action.cfgWeight }),
  }
}

function validateActions(actions: readonly MotionIdleAction[]): readonly MotionIdleAction[] {
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > 32) {
    throw new Error('Motion idle pool actions must contain 1 through 32 items')
  }
  const ids = new Set<string>()
  return actions.map((action, index) => {
    if (!action || typeof action !== 'object') throw new Error(`Motion idle pool action ${index} must be an object`)
    if (typeof action.id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/u.test(action.id)) {
      throw new Error(`Motion idle pool action ${index} id is invalid`)
    }
    if (ids.has(action.id)) throw new Error(`Motion idle pool action id is duplicated: ${action.id}`)
    ids.add(action.id)
    if (typeof action.prompt !== 'string' || action.prompt.length < 1 || action.prompt.length > 512 || action.prompt.trim() !== action.prompt) {
      throw new Error(`Motion idle pool action ${action.id} prompt is invalid`)
    }
    return { ...action }
  })
}

function validateWindow(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new Error(`Motion idle pool ${name} must be an integer from 0 through 60000`)
  }
  return value
}
