export const behaviorSources = ['vision', 'voice', 'direct'] as const
export type BehaviorSource = typeof behaviorSources[number]

export const behaviorEventTypes = [
  'presence.enter',
  'presence.leave',
  'gesture.wave',
  'gesture.hand_raise',
  'head.left',
  'head.right',
  'head.center',
  'voice.final',
] as const
export type BehaviorEventType = typeof behaviorEventTypes[number]

export const behaviorEmotions = ['neutral', 'happy', 'sad', 'surprised', 'concerned'] as const
export type BehaviorEmotion = typeof behaviorEmotions[number]

export interface BehaviorEvent {
  version: 'rayure.behavior-event.v1'
  id: string
  source: BehaviorSource
  type: BehaviorEventType
  correlationId: string
  observedAtMs: number
  expiresAtMs: number
  confidence: number
  data?: Readonly<Record<string, string | number | boolean>>
}

export interface BehaviorPlan {
  version: 'rayure.behavior-plan.v1'
  correlationId: string
  replyText?: string
  emotion?: BehaviorEmotion
  motionIntentId?: string
  targetEntityId?: string
  speak?: boolean
}

export interface BehaviorRequest {
  id: string
  source: BehaviorSource
  priority: number
  expiresAtMs: number
  execute: (context: BehaviorExecutionContext) => Promise<void>
}

export interface BehaviorExecutionContext {
  requestId: string
  signal: AbortSignal
  isCurrent(): boolean
}

export type BehaviorRuntimeState = 'idle' | 'running'

export interface BehaviorRuntimeSnapshot {
  state: BehaviorRuntimeState
  activeRequestId?: string
  activeSource?: BehaviorSource
  activePriority?: number
  generation: number
}

export function behaviorPriority(source: BehaviorSource): number {
  switch (source) {
    case 'voice': return 100
    case 'direct': return 80
    case 'vision': return 50
  }
}

export function validateBehaviorEvent(event: BehaviorEvent): BehaviorEvent {
  if (event.version !== 'rayure.behavior-event.v1') throw new Error('Behavior event version is invalid')
  requireIdentifier(event.id, 'Behavior event id')
  requireIdentifier(event.correlationId, 'Behavior event correlationId')
  if (!behaviorSources.includes(event.source)) throw new Error('Behavior event source is invalid')
  if (!behaviorEventTypes.includes(event.type)) throw new Error('Behavior event type is invalid')
  requireTimestamp(event.observedAtMs, 'Behavior event observedAtMs')
  requireTimestamp(event.expiresAtMs, 'Behavior event expiresAtMs')
  if (event.expiresAtMs <= event.observedAtMs) throw new Error('Behavior event expiry must follow observation')
  requireConfidence(event.confidence)
  if (event.data !== undefined) {
    if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
      throw new Error('Behavior event data must be an object')
    }
    if (Object.keys(event.data).length > 32) throw new Error('Behavior event data has too many fields')
  }
  return event
}

export function validateBehaviorPlan(plan: BehaviorPlan): BehaviorPlan {
  if (plan.version !== 'rayure.behavior-plan.v1') throw new Error('Behavior plan version is invalid')
  requireIdentifier(plan.correlationId, 'Behavior plan correlationId')
  if (plan.replyText !== undefined) requireDisplayString(plan.replyText, 'Behavior plan replyText', 4096)
  if (plan.emotion !== undefined && !behaviorEmotions.includes(plan.emotion)) {
    throw new Error('Behavior plan emotion is invalid')
  }
  if (plan.motionIntentId !== undefined) requireIdentifier(plan.motionIntentId, 'Behavior plan motionIntentId')
  if (plan.targetEntityId !== undefined) requireIdentifier(plan.targetEntityId, 'Behavior plan targetEntityId')
  if (plan.speak !== undefined && typeof plan.speak !== 'boolean') throw new Error('Behavior plan speak must be boolean')
  return plan
}

function requireIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,96}$/u.test(value)) {
    throw new Error(`${label} must be a safe identifier`)
  }
}

function requireDisplayString(value: unknown, label: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw new Error(`${label} must be a bounded printable string`)
  }
}

function requireTimestamp(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
}

function requireConfidence(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Behavior confidence must be between 0 and 1')
  }
}
