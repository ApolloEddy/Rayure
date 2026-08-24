import {
  validateCanonicalMotion,
  validateMotionSemanticFeature,
} from '@rayure/protocol'
import type {
  CanonicalMotion,
  CanonicalQuaternion,
  CanonicalVector3,
  MotionSemanticFeature,
} from '@rayure/protocol'

import { convertArdyMotion } from './ardy-motion-adapter.ts'

/** Official ARDY condition-set endpoint names exposed by the bridge. */
export const ARDY_CONSTRAINABLE_JOINT_NAMES = [
  'Hips',
  'LeftHand',
  'RightHand',
  'LeftFoot',
  'RightFoot',
] as const

export const ARDY_PROCESS_REQUEST_SCHEMA = 'rayure.ardy-process-request.v1' as const
export const ARDY_PROCESS_RESULT_SCHEMA = 'rayure.ardy-process-result.v1' as const
export const ARDY_PROCESS_ERROR_SCHEMA = 'rayure.ardy-process-error.v1' as const

export interface ArdyKinematicConstraint {
  timeMs: number
  joint: string
  position?: CanonicalVector3
  rotation?: CanonicalQuaternion
}

/** Opaque bridge-owned tensor state for an already renderer-confirmed prefix. */
export interface ArdyMotionContinuation {
  id: string
  consumedFrameCount: number
}

export interface ArdyMotionGenerationRequest {
  schema: typeof ARDY_PROCESS_REQUEST_SCHEMA
  type: 'generate'
  requestId: string
  model: 'core'
  textFeature: MotionSemanticFeature
  numFrames: number
  numDenoisingSteps: number
  cfgWeight: number
  history?: CanonicalMotion
  continuation?: ArdyMotionContinuation
  constraints?: readonly ArdyKinematicConstraint[]
}

export interface ArdyMotionCancelMessage {
  schema: typeof ARDY_PROCESS_REQUEST_SCHEMA
  type: 'cancel'
  requestId: string
}

export type ArdyProcessRequest = ArdyMotionGenerationRequest | ArdyMotionCancelMessage

export interface ArdyMotionResult {
  requestId: string
  motion: CanonicalMotion
  continuationId?: string | undefined
}

export function createArdyMotionRequest(input: {
  requestId: string
  textFeature: MotionSemanticFeature
  numFrames: number
  numDenoisingSteps: number
  cfgWeight: number
  history?: CanonicalMotion
  continuation?: ArdyMotionContinuation
  constraints?: readonly ArdyKinematicConstraint[]
}): ArdyMotionGenerationRequest {
  const requestId = requireIdentifier(input.requestId, 'ARDY requestId')
  validateMotionSemanticFeature(input.textFeature)
  const numFrames = requireInteger(input.numFrames, 'ARDY numFrames', 1, 600)
  const numDenoisingSteps = requireInteger(input.numDenoisingSteps, 'ARDY numDenoisingSteps', 1, 20)
  const cfgWeight = requireFiniteNumber(input.cfgWeight, 'ARDY cfgWeight', 0, 20)
  if (input.history !== undefined) validateCanonicalMotion(input.history)
  const continuation = input.continuation === undefined ? undefined : validateContinuation(input.continuation)
  if (input.history !== undefined && continuation !== undefined) {
    throw new Error('ARDY history and continuation cannot both be supplied')
  }
  const constraints = input.constraints === undefined
    ? undefined
    : validateConstraints(input.constraints)
  return {
    schema: ARDY_PROCESS_REQUEST_SCHEMA,
    type: 'generate',
    requestId,
    model: 'core',
    textFeature: input.textFeature,
    numFrames,
    numDenoisingSteps,
    cfgWeight,
    ...(input.history === undefined ? {} : { history: input.history }),
    ...(continuation === undefined ? {} : { continuation }),
    ...(constraints === undefined ? {} : { constraints }),
  }
}

export function createArdyMotionCancel(requestId: string): ArdyMotionCancelMessage {
  return {
    schema: ARDY_PROCESS_REQUEST_SCHEMA,
    type: 'cancel',
    requestId: requireIdentifier(requestId, 'ARDY requestId'),
  }
}

export function serializeArdyProcessMessage(message: ArdyProcessRequest): string {
  return JSON.stringify(message)
}

export function parseArdyMotionResponse(raw: string, expectedRequestId: string): ArdyMotionResult {
  const root = parseJsonObject(raw, 'ARDY process response')
  const requestId = requireIdentifier(expectedRequestId, 'ARDY expected requestId')
  if (root.requestId !== requestId) throw new Error('ARDY process response requestId does not match the active request')

  if (root.schema === ARDY_PROCESS_ERROR_SCHEMA) {
    requireExactKeys(root, ['schema', 'type', 'requestId', 'code', 'message'], 'ARDY process error')
    if (root.type !== 'error') throw new Error('ARDY process error type is invalid')
    const code = requireIdentifier(root.code, 'ARDY process error code')
    const message = requireDisplayString(root.message, 'ARDY process error message', 512)
    throw new Error(`ARDY process error ${code}: ${message}`)
  }

  if (root.schema !== ARDY_PROCESS_RESULT_SCHEMA) throw new Error('Unsupported ARDY process response schema')
  const resultKeys = ['schema', 'type', 'requestId', 'motion']
  if (root.continuationId !== undefined) resultKeys.push('continuationId')
  requireExactKeys(root, resultKeys, 'ARDY process result')
  if (root.type !== 'result') throw new Error('ARDY process result type is invalid')
  return {
    requestId,
    motion: convertArdyMotion(root.motion),
    ...(root.continuationId === undefined
      ? {}
      : { continuationId: requireIdentifier(root.continuationId, 'ARDY continuationId') }),
  }
}

function validateContinuation(value: ArdyMotionContinuation): ArdyMotionContinuation {
  const root = requireRecord(value, 'ARDY continuation')
  requireExactKeys(root, ['id', 'consumedFrameCount'], 'ARDY continuation')
  return {
    id: requireIdentifier(root.id, 'ARDY continuation id'),
    consumedFrameCount: requireInteger(root.consumedFrameCount, 'ARDY continuation consumedFrameCount', 1, 600),
  }
}

function validateConstraints(value: readonly ArdyKinematicConstraint[]): readonly ArdyKinematicConstraint[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('ARDY constraints must contain 0 through 256 items')
  return value.map((constraint, index) => {
    const root = requireRecord(constraint, `ARDY constraint ${index}`)
    const expectedKeys = ['timeMs', 'joint']
    if (root.position !== undefined) expectedKeys.push('position')
    if (root.rotation !== undefined) expectedKeys.push('rotation')
    requireExactKeys(root, expectedKeys, `ARDY constraint ${index}`)
    const timeMs = requireInteger(root.timeMs, `ARDY constraint ${index}.timeMs`, 0, Number.MAX_SAFE_INTEGER)
    const joint = requireDisplayString(root.joint, `ARDY constraint ${index}.joint`, 64)
    if (!ARDY_CONSTRAINABLE_JOINT_NAMES.includes(joint as typeof ARDY_CONSTRAINABLE_JOINT_NAMES[number])) {
      throw new Error(`ARDY constraint ${index}.joint is not supported by the ARDY condition set`)
    }
    if (root.position === undefined && root.rotation === undefined) {
      throw new Error(`ARDY constraint ${index} must contain position or rotation`)
    }
    return {
      timeMs,
      joint,
      ...(root.position === undefined ? {} : { position: requireVector3(root.position, `ARDY constraint ${index}.position`) }),
      ...(root.rotation === undefined ? {} : { rotation: requireQuaternion(root.rotation, `ARDY constraint ${index}.rotation`) }),
    }
  })
}

function parseJsonObject(raw: string, name: string): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64 * 1024 * 1024) {
    throw new Error(`${name} must be a non-empty string up to 64 MiB`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    throw new Error(`${name} must contain valid JSON`)
  }
  return requireRecord(parsed, name)
}

function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
    throw new Error(`${name} must be a safe identifier`)
  }
  return value
}

function requireDisplayString(value: unknown, name: string, maximumLength: number): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new Error(`${name} must be a trimmed printable string up to ${maximumLength} characters`)
  }
  return value
}

function requireInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

function requireFiniteNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a finite number from ${minimum} through ${maximum}`)
  }
  return value
}

function requireVector3(value: unknown, name: string): CanonicalVector3 {
  const vector = requireArray(value, name)
  if (vector.length !== 3 || vector.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
    throw new Error(`${name} must be a finite 3D vector`)
  }
  return vector as unknown as CanonicalVector3
}

function requireQuaternion(value: unknown, name: string): CanonicalQuaternion {
  const quaternion = requireArray(value, name)
  if (quaternion.length !== 4 || quaternion.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
    throw new Error(`${name} must be a finite quaternion`)
  }
  const result = quaternion as unknown as CanonicalQuaternion
  if (Math.hypot(...result) <= 1e-6) throw new Error(`${name} must not be a zero quaternion`)
  return result
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${name} contains missing or unknown fields`)
  }
}
