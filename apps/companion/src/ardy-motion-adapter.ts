import {
  createCanonicalMotion,
} from '@rayure/protocol'
import type {
  CanonicalJointPose,
  CanonicalMotion,
  CanonicalMotionFrame,
  CanonicalQuaternion,
  CanonicalVector3,
} from '@rayure/protocol'

export const ARDY_MOTION_SCHEMA = 'rayure.ardy-motion.v1' as const

/** Official ARDY CoreSkeleton27 order, kept explicit to prevent silent retargeting. */
export const ARDY_CORE_JOINT_NAMES = [
  'Hips',
  'Spine',
  'Spine1',
  'Spine2',
  'Spine3',
  'Neck',
  'Head',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand',
  'RightHandEnd',
  'RightHandThumb1',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'LeftHandEnd',
  'LeftHandThumb1',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
  'RightToeBase',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'LeftToeBase',
] as const

export type ArdyCoreJointName = typeof ARDY_CORE_JOINT_NAMES[number]

const ARDY_TO_CANONICAL = {
  Hips: 'hips',
  Spine: 'spine',
  Spine1: 'spine1',
  Spine2: 'spine2',
  Spine3: 'spine3',
  Neck: 'neck',
  Head: 'head',
  RightShoulder: 'right_shoulder',
  RightArm: 'right_upper_arm',
  RightForeArm: 'right_elbow',
  RightHand: 'right_wrist',
  RightHandEnd: 'right_hand_end',
  RightHandThumb1: 'right_thumb',
  LeftShoulder: 'left_shoulder',
  LeftArm: 'left_upper_arm',
  LeftForeArm: 'left_elbow',
  LeftHand: 'left_wrist',
  LeftHandEnd: 'left_hand_end',
  LeftHandThumb1: 'left_thumb',
  RightUpLeg: 'right_hip',
  RightLeg: 'right_knee',
  RightFoot: 'right_ankle',
  RightToeBase: 'right_toe',
  LeftUpLeg: 'left_hip',
  LeftLeg: 'left_knee',
  LeftFoot: 'left_ankle',
  LeftToeBase: 'left_toe',
} as const satisfies Record<ArdyCoreJointName, string>

export const CANONICAL_ARDY_CORE_JOINT_NAMES = ARDY_CORE_JOINT_NAMES.map(
  name => ARDY_TO_CANONICAL[name],
) as readonly string[]

export interface ArdyMotionSource {
  schema: typeof ARDY_MOTION_SCHEMA
  backend: string
  fps: number
  jointNames: readonly string[]
  frames: readonly ArdyMotionSourceFrame[]
}

export interface ArdyMotionSourceFrame {
  timeMs: number
  rootPosition: CanonicalVector3
  rootRotation: CanonicalQuaternion
  joints: Readonly<Record<string, ArdyJointPose>>
  footContacts?: readonly string[]
}

export interface ArdyJointPose {
  position: CanonicalVector3
  rotation: CanonicalQuaternion
}

export function convertArdyMotion(value: unknown): CanonicalMotion {
  const source = requireRecord(value, 'ARDY motion')
  requireExactKeys(source, ['schema', 'backend', 'fps', 'jointNames', 'frames'], 'ARDY motion')
  if (source.schema !== ARDY_MOTION_SCHEMA) throw new Error('Unsupported ARDY motion schema')
  const backend = requireDisplayString(source.backend, 'ARDY backend', 64)
  if (backend !== 'ardy-core') throw new Error('ARDY motion backend must be ardy-core')
  const fps = requireInteger(source.fps, 'ARDY fps', 1, 120)
  requireOfficialJointNames(source.jointNames)

  const rawFrames = requireArray(source.frames, 'ARDY frames')
  if (rawFrames.length === 0) throw new Error('ARDY frames must not be empty')
  const frames: CanonicalMotionFrame[] = []
  let previousTimeMs = -1
  for (const [index, rawFrame] of rawFrames.entries()) {
    const frame = requireRecord(rawFrame, `ARDY frame ${index}`)
    const expectedKeys = frame.footContacts === undefined
      ? ['timeMs', 'rootPosition', 'rootRotation', 'joints']
      : ['timeMs', 'rootPosition', 'rootRotation', 'joints', 'footContacts']
    requireExactKeys(frame, expectedKeys, `ARDY frame ${index}`)
    const timeMs = requireInteger(frame.timeMs, `ARDY frame ${index}.timeMs`, 0, Number.MAX_SAFE_INTEGER)
    if (timeMs <= previousTimeMs) throw new Error('ARDY frame timeMs values must be strictly increasing')
    previousTimeMs = timeMs

    const rawJoints = requireRecord(frame.joints, `ARDY frame ${index}.joints`)
    requireExactKeys(rawJoints, ARDY_CORE_JOINT_NAMES, `ARDY frame ${index}.joints`)
    const joints: Record<string, CanonicalJointPose> = {}
    for (const ardyName of ARDY_CORE_JOINT_NAMES) {
      const pose = requireRecord(rawJoints[ardyName], `ARDY frame ${index}.joints.${ardyName}`)
      requireExactKeys(pose, ['position', 'rotation'], `ARDY frame ${index}.joints.${ardyName}`)
      joints[ARDY_TO_CANONICAL[ardyName]] = {
        position: requireVector3(pose.position, `ARDY frame ${index}.joints.${ardyName}.position`),
        rotation: requireQuaternion(pose.rotation, `ARDY frame ${index}.joints.${ardyName}.rotation`),
      }
    }

    const footContacts = frame.footContacts === undefined
      ? undefined
      : requireFootContacts(frame.footContacts, index)
    frames.push({
      timeMs,
      rootPosition: requireVector3(frame.rootPosition, `ARDY frame ${index}.rootPosition`),
      rootRotation: requireQuaternion(frame.rootRotation, `ARDY frame ${index}.rootRotation`),
      joints,
      ...(footContacts === undefined ? {} : { footContacts }),
    })
  }

  return createCanonicalMotion({
    schema: 'rayure.motion.v1',
    backend,
    jointSetId: 'ardy-core-27',
    jointNames: CANONICAL_ARDY_CORE_JOINT_NAMES,
    fps,
    frames,
  })
}

function requireOfficialJointNames(value: unknown): void {
  const names = requireArray(value, 'ARDY jointNames')
  if (names.length !== ARDY_CORE_JOINT_NAMES.length) {
    throw new Error('ARDY jointNames must contain the official CoreSkeleton27 joints')
  }
  for (const [index, expected] of ARDY_CORE_JOINT_NAMES.entries()) {
    if (names[index] !== expected) {
      throw new Error(`ARDY jointNames[${index}] must be ${expected}`)
    }
  }
}

function requireFootContacts(value: unknown, frameIndex: number): readonly string[] {
  const contacts = requireArray(value, `ARDY frame ${frameIndex}.footContacts`)
  return contacts.map((contact, contactIndex) => {
    if (typeof contact !== 'string' || !(contact in ARDY_TO_CANONICAL)) {
      throw new Error(`ARDY frame ${frameIndex} foot contact [${contactIndex}] is unknown`)
    }
    return ARDY_TO_CANONICAL[contact as ArdyCoreJointName]
  })
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

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
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
