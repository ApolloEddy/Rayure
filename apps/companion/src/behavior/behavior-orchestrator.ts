import {
  behaviorPriority,
  validateBehaviorEvent,
} from './types.ts'
import type {
  BehaviorEvent,
  BehaviorExecutionContext,
  BehaviorRequest,
  BehaviorRuntimeSnapshot,
  BehaviorRuntimeState,
} from './types.ts'

const MAX_DEDUPE_IDS = 256

export interface BehaviorOrchestratorOptions {
  now?: () => number
  onStateChange?: (snapshot: BehaviorRuntimeSnapshot) => void
  onError?: (requestId: string, cause: unknown) => void
}

export type BehaviorSubmitResult = 'started' | 'superseded' | 'ignored' | 'expired'

interface ActiveRequest {
  request: BehaviorRequest
  generation: number
  controller: AbortController
}

/**
 * Serializes high-level behavior work without owning any provider or renderer.
 * Every adapter gets an AbortSignal and a generation guard, so late ASR, LLM,
 * TTS or motion results cannot mutate a newer turn.
 */
export class BehaviorOrchestrator {
  readonly #now: () => number
  readonly #onStateChange: ((snapshot: BehaviorRuntimeSnapshot) => void) | undefined
  readonly #onError: ((requestId: string, cause: unknown) => void) | undefined
  readonly #seenIds = new Set<string>()
  #active: ActiveRequest | undefined
  #generation = 0
  #state: BehaviorRuntimeState = 'idle'

  constructor(options: BehaviorOrchestratorOptions = {}) {
    this.#now = options.now ?? (() => Date.now())
    this.#onStateChange = options.onStateChange
    this.#onError = options.onError
  }

  snapshot(): BehaviorRuntimeSnapshot {
    const active = this.#active
    return {
      state: this.#state,
      ...(active === undefined ? {} : {
        activeRequestId: active.request.id,
        activeSource: active.request.source,
        activePriority: active.request.priority,
      }),
      generation: this.#generation,
    }
  }

  submit(request: BehaviorRequest): BehaviorSubmitResult {
    validateRequest(request, this.#now())
    if (this.#seenIds.has(request.id)) return 'ignored'
    this.#remember(request.id)
    if (request.expiresAtMs <= this.#now()) return 'expired'

    const active = this.#active
    if (active !== undefined && request.priority < active.request.priority) return 'ignored'

    const result: BehaviorSubmitResult = active === undefined ? 'started' : 'superseded'
    if (active !== undefined) active.controller.abort('superseded')
    this.#start(request)
    return result
  }

  submitEvent(event: BehaviorEvent, execute: BehaviorRequest['execute']): BehaviorSubmitResult {
    const validated = validateBehaviorEvent(event)
    return this.submit({
      id: validated.id,
      source: validated.source,
      priority: behaviorPriority(validated.source),
      expiresAtMs: validated.expiresAtMs,
      execute,
    })
  }

  cancel(reason = 'cancelled'): boolean {
    const active = this.#active
    if (active === undefined) return false
    active.controller.abort(reason)
    this.#active = undefined
    this.#generation += 1
    this.#setState('idle')
    return true
  }

  close(): void {
    this.cancel('closed')
    this.#seenIds.clear()
  }

  #start(request: BehaviorRequest): void {
    const controller = new AbortController()
    const generation = ++this.#generation
    const active: ActiveRequest = { request, generation, controller }
    this.#active = active
    this.#setState('running')
    const context: BehaviorExecutionContext = {
      requestId: request.id,
      signal: controller.signal,
      isCurrent: () => this.#isCurrent(active),
    }

    void request.execute(context)
      .catch((cause: unknown) => {
        if (!isAbortLike(cause) && this.#isCurrent(active)) this.#onError?.(request.id, cause)
      })
      .finally(() => {
        if (!this.#isCurrent(active)) return
        this.#active = undefined
        this.#setState('idle')
      })
  }

  #isCurrent(active: ActiveRequest): boolean {
    return this.#active === active && active.generation === this.#generation && !active.controller.signal.aborted
  }

  #remember(id: string): void {
    this.#seenIds.add(id)
    while (this.#seenIds.size > MAX_DEDUPE_IDS) {
      const first = this.#seenIds.values().next().value as string | undefined
      if (first === undefined) break
      this.#seenIds.delete(first)
    }
  }

  #setState(state: BehaviorRuntimeState): void {
    if (state === this.#state) return
    this.#state = state
    try {
      this.#onStateChange?.(this.snapshot())
    }
    catch {
      // Observability must not own the behavior lifecycle.
    }
  }
}

function validateRequest(request: BehaviorRequest, now: number): void {
  if (!request || typeof request !== 'object') throw new Error('Behavior request must be an object')
  if (typeof request.id !== 'string' || !/^[A-Za-z0-9._:-]{1,96}$/u.test(request.id)) {
    throw new Error('Behavior request id is invalid')
  }
  if (request.source !== 'vision' && request.source !== 'voice' && request.source !== 'direct') {
    throw new Error('Behavior request source is invalid')
  }
  if (!Number.isInteger(request.priority) || request.priority < 0 || request.priority > 100) {
    throw new Error('Behavior request priority must be an integer from 0 through 100')
  }
  if (!Number.isSafeInteger(request.expiresAtMs) || request.expiresAtMs <= 0) {
    throw new Error('Behavior request expiry must be a positive safe integer')
  }
  if (typeof request.execute !== 'function') throw new Error('Behavior request execute must be a function')
}

function isAbortLike(cause: unknown): boolean {
  if (cause instanceof DOMException && cause.name === 'AbortError') return true
  if (cause instanceof Error && /aborted|cancelled|canceled|superseded|closed/u.test(cause.message)) return true
  return cause === 'superseded' || cause === 'cancelled' || cause === 'closed'
}
