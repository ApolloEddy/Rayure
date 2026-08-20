export const CANONICAL_MOTION_SCHEMA = 'rayure.motion.v1' as const
export const CANONICAL_MOTION_JOINT_SET = 'ardy-core-27' as const
export const CANONICAL_MOTION_JOINT_COUNT = 27 as const

export type CanonicalVector3 = readonly [number, number, number]
export type CanonicalQuaternion = readonly [number, number, number, number]

export interface CanonicalJointPose {
  position: CanonicalVector3
  rotation: CanonicalQuaternion
}

export interface CanonicalMotionFrame {
  timeMs: number
  rootPosition: CanonicalVector3
  rootRotation: CanonicalQuaternion
  joints: Readonly<Record<string, CanonicalJointPose>>
  footContacts?: readonly string[]
}

export interface CanonicalMotion {
  schema: typeof CANONICAL_MOTION_SCHEMA
  backend: string
  jointSetId: typeof CANONICAL_MOTION_JOINT_SET
  jointNames: readonly string[]
  fps: number
  frames: readonly CanonicalMotionFrame[]
}

export class CanonicalMotionValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalMotionValidationError'
  }
}

export function validateCanonicalMotion(value: unknown): asserts value is CanonicalMotion {
  const motion = requireRecord(value, 'canonical motion')
  requireExactKeys(motion, ['schema', 'backend', 'jointSetId', 'jointNames', 'fps', 'frames'], 'canonical motion')
  if (motion.schema !== CANONICAL_MOTION_SCHEMA) {
    throw new CanonicalMotionValidationError('Unsupported canonical motion schema')
  }
  if (motion.jointSetId !== CANONICAL_MOTION_JOINT_SET) {
    throw new CanonicalMotionValidationError('Unsupported canonical motion joint set')
  }
  requireDisplayString(motion.backend, 'backend', 64)
  const jointNames = requireJointNames(motion.jointNames)
  requireFiniteInteger(motion.fps, 'fps', 1, 120)
  const frames = requireArray(motion.frames, 'frames')
  if (frames.length === 0) throw new CanonicalMotionValidationError('frames must not be empty')

  let previousTimeMs = -1
  for (const [index, rawFrame] of frames.entries()) {
    const frame = requireRecord(rawFrame, `frame ${index}`)
    const expectedKeys = frame.footContacts === undefined
      ? ['timeMs', 'rootPosition', 'rootRotation', 'joints']
      : ['timeMs', 'rootPosition', 'rootRotation', 'joints', 'footContacts']
    requireExactKeys(frame, expectedKeys, `frame ${index}`)
    const timeMs = requireFiniteInteger(frame.timeMs, `frame ${index}.timeMs`, 0, Number.MAX_SAFE_INTEGER)
    if (timeMs <= previousTimeMs) {
      throw new CanonicalMotionValidationError('frame timeMs values must be strictly increasing')
    }
    previousTimeMs = timeMs
    requireVector3(frame.rootPosition, `frame ${index}.rootPosition`)
    requireQuaternion(frame.rootRotation, `frame ${index}.rootRotation`)
    const joints = requireRecord(frame.joints, `frame ${index}.joints`)
    requireExactKeys(joints, jointNames, `frame ${index}.joints`)
    for (const jointName of jointNames) {
      const joint = requireRecord(joints[jointName], `frame ${index}.joints.${jointName}`)
      requireExactKeys(joint, ['position', 'rotation'], `frame ${index}.joints.${jointName}`)
      requireVector3(joint.position, `frame ${index}.joints.${jointName}.position`)
      requireQuaternion(joint.rotation, `frame ${index}.joints.${jointName}.rotation`)
    }
    if (frame.footContacts !== undefined) requireFootContacts(frame.footContacts, jointNames, index)
  }
}

export function createCanonicalMotion(input: CanonicalMotion): CanonicalMotion {
  validateCanonicalMotion(input)
  return input
}

function requireJointNames(value: unknown): readonly string[] {
  const names = requireArray(value, 'jointNames')
  if (names.length !== CANONICAL_MOTION_JOINT_COUNT) {
    throw new CanonicalMotionValidationError(`jointNames must contain exactly ${CANONICAL_MOTION_JOINT_COUNT} joints`)
  }
  const result: string[] = []
  for (const [index, name] of names.entries()) {
    const safeName = requireDisplayString(name, `jointNames[${index}]`, 64)
    if (result.includes(safeName)) {
      throw new CanonicalMotionValidationError('jointNames must not contain duplicates')
    }
    result.push(safeName)
  }
  return result
}

function requireFootContacts(value: unknown, jointNames: readonly string[], frameIndex: number): void {
  const contacts = requireArray(value, `frame ${frameIndex}.footContacts`)
  const seen = new Set<string>()
  for (const contact of contacts) {
    const name = requireDisplayString(contact, `frame ${frameIndex}.footContacts[]`, 64)
    if (!jointNames.includes(name)) {
      throw new CanonicalMotionValidationError(`Unknown foot contact joint: ${name}`)
    }
    if (seen.has(name)) throw new CanonicalMotionValidationError('footContacts must not contain duplicates')
    seen.add(name)
  }
}

function requireVector3(value: unknown, name: string): asserts value is CanonicalVector3 {
  const vector = requireArray(value, name)
  if (vector.length !== 3 || vector.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
    throw new CanonicalMotionValidationError(`${name} must be a finite 3D vector`)
  }
}

function requireQuaternion(value: unknown, name: string): asserts value is CanonicalQuaternion {
  const quaternion = requireArray(value, name)
  if (quaternion.length !== 4 || quaternion.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
    throw new CanonicalMotionValidationError(`${name} must be a finite quaternion`)
  }
  const magnitude = Math.hypot(...(quaternion as number[]))
  if (magnitude <= 1e-6) throw new CanonicalMotionValidationError(`${name} must not be a zero quaternion`)
}

function requireFiniteInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new CanonicalMotionValidationError(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function requireDisplayString(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new CanonicalMotionValidationError(`${name} must be a trimmed printable string up to ${maxLength} characters`)
  }
  return value
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new CanonicalMotionValidationError(`${name} must be an array`)
  return value
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CanonicalMotionValidationError(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new CanonicalMotionValidationError(`${name} contains missing or unknown fields`)
  }
}
