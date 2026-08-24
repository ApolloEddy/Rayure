import type {
  CanonicalMotionFrame,
  CanonicalQuaternion,
  CanonicalVector3,
} from '@rayure/protocol'

export type Live2dControl =
  | 'headYaw'
  | 'headPitch'
  | 'headRoll'
  | 'bodyYaw'
  | 'bodyPitch'
  | 'bodyRoll'
  | 'leftArmAngle'
  | 'rightArmAngle'
  | 'leftElbowAngle'
  | 'rightElbowAngle'
  | 'leftThighAngle'
  | 'rightThighAngle'
  | 'leftKneeBend'
  | 'rightKneeBend'
  | 'leftFootAngle'
  | 'rightFootAngle'
  | 'leftThighDepth'
  | 'rightThighDepth'
  | 'leftKneeDepth'
  | 'rightKneeDepth'
  | 'leftFootDepth'
  | 'rightFootDepth'
  | 'squat'
  | 'legPhase'

export interface Live2dJointBindings {
  head: string
  leftShoulder: string
  leftElbow: string
  leftWrist: string
  rightShoulder: string
  rightElbow: string
  rightWrist: string
  leftHip?: string
  leftKnee?: string
  leftAnkle?: string
  rightHip?: string
  rightKnee?: string
  rightAnkle?: string
}

export interface Live2dParameterBinding {
  parameterId: string
  control: Live2dControl
  min: number
  max: number
  neutral: number
  scale?: number
  invert?: boolean
  mode?: 'offset' | 'absolute'
}

export interface Live2dRigProfile {
  id: string
  joints: Live2dJointBindings
  parameters: readonly Live2dParameterBinding[]
}

export interface Live2dParameterUpdate {
  parameterId: string
  control: Live2dControl
  value: number
}

export interface Live2dParameterSink {
  setParameterValue(parameterId: string, value: number): void
  /** Optional full-pose hook for renderers that also project root motion. */
  onMotionFrame?(frame: CanonicalMotionFrame): void
}

export const STANDARD_LIVE2D_RIG_PROFILE: Readonly<Live2dRigProfile> = {
  id: 'rayure-live2d-standard-v1',
  joints: {
    head: 'head',
    leftShoulder: 'left_shoulder',
    leftElbow: 'left_elbow',
    leftWrist: 'left_wrist',
    rightShoulder: 'right_shoulder',
    rightElbow: 'right_elbow',
    rightWrist: 'right_wrist',
    leftHip: 'left_hip',
    leftKnee: 'left_knee',
    leftAnkle: 'left_ankle',
    rightHip: 'right_hip',
    rightKnee: 'right_knee',
    rightAnkle: 'right_ankle',
  },
  parameters: [
    { parameterId: 'ParamAngleX', control: 'headYaw', min: -30, max: 30, neutral: 0 },
    { parameterId: 'ParamAngleY', control: 'headPitch', min: -30, max: 30, neutral: 0 },
    { parameterId: 'ParamAngleZ', control: 'headRoll', min: -30, max: 30, neutral: 0 },
    { parameterId: 'ParamBodyAngleX', control: 'bodyYaw', min: -10, max: 10, neutral: 0 },
    { parameterId: 'ParamBodyAngleY', control: 'bodyPitch', min: -10, max: 10, neutral: 0 },
    { parameterId: 'ParamBodyAngleZ', control: 'bodyRoll', min: -10, max: 10, neutral: 0 },
    { parameterId: 'ParamArmLA', control: 'leftArmAngle', min: -90, max: 90, neutral: 0 },
    { parameterId: 'ParamArmRA', control: 'rightArmAngle', min: -90, max: 90, neutral: 0 },
    { parameterId: 'ParamArmLB', control: 'leftElbowAngle', min: 0, max: 180, neutral: 90, mode: 'absolute' },
    { parameterId: 'ParamArmRB', control: 'rightElbowAngle', min: 0, max: 180, neutral: 90, mode: 'absolute' },
    // Some models expose one signed leg-cycle parameter. It cannot convey full
    // 3D locomotion, but it makes alternating ARDY gait visible instead of
    // dropping all lower-body information at the adapter boundary.
    { parameterId: 'ParamLeg', control: 'legPhase', min: -1, max: 1, neutral: 0 },
  ],
}

/**
 * Calibrated bindings for the external Shimakaze/Daofeng model used by the
 * local Rayure preview.  This model does not expose the generic ParamArmLA /
 * ParamLeg ids, so silently applying the standard profile would make ARDY
 * playback appear to complete while only head/body channels moved.
 */
export const SHIMAKAZE_LIVE2D_RIG_PROFILE: Readonly<Live2dRigProfile> = {
  id: 'rayure-live2d-shimakaze-v1',
  joints: STANDARD_LIVE2D_RIG_PROFILE.joints,
  parameters: [
    { parameterId: 'ParamAngleX', control: 'headYaw', min: -30, max: 30, neutral: 0 },
    { parameterId: 'ParamAngleY', control: 'headPitch', min: -30, max: 30, neutral: 0 },
    { parameterId: 'ParamAngleZ', control: 'headRoll', min: -30, max: 30, neutral: 0 },
    { parameterId: 'ParamBodyAngleX', control: 'bodyYaw', min: -10, max: 10, neutral: 0 },
    { parameterId: 'ParamBodyAngleY', control: 'bodyPitch', min: -10, max: 10, neutral: 0 },
    { parameterId: 'ParamBodyAngleZ', control: 'bodyRoll', min: -10, max: 10, neutral: 0 },
    // Shimakaze's arm controls are split into upper/lower arm ids.
    { parameterId: 'Param79', control: 'leftArmAngle', min: -90, max: 90, neutral: 0 },
    { parameterId: 'Param2', control: 'rightArmAngle', min: -90, max: 90, neutral: 0 },
    { parameterId: 'Param80', control: 'leftElbowAngle', min: -20, max: 20, neutral: 0, scale: 0.8 },
    { parameterId: 'Param4', control: 'rightElbowAngle', min: -20, max: 20, neutral: 0, scale: 0.8 },
    // The lower body is a six-channel 2D rig.  Use both the projected joint
    // angle and depth angle so a walk is visible even though Live2D has no
    // 3D root/foot bones.
    { parameterId: 'Param7', control: 'leftThighAngle', min: -20, max: 20, neutral: 0, scale: 4 },
    { parameterId: 'Param8', control: 'leftKneeBend', min: -12, max: 12, neutral: 0, scale: 0.65 },
    { parameterId: 'Param9', control: 'leftFootAngle', min: -20, max: 20, neutral: 0, scale: 4 },
    { parameterId: 'Param10', control: 'leftThighDepth', min: -20, max: 20, neutral: 0, scale: 4 },
    { parameterId: 'Param11', control: 'leftKneeDepth', min: -20, max: 20, neutral: 0, scale: 4 },
    { parameterId: 'Param12', control: 'leftFootDepth', min: -20, max: 20, neutral: 0, scale: 4 },
    { parameterId: 'Param14', control: 'rightThighAngle', min: -20, max: 20, neutral: 0, scale: 4 },
    { parameterId: 'Param15', control: 'rightKneeBend', min: -12, max: 12, neutral: 0, scale: 0.65 },
    { parameterId: 'Param16', control: 'rightFootAngle', min: -20, max: 20, neutral: 0, scale: 4 },
    { parameterId: 'Param17', control: 'rightThighDepth', min: -20, max: 20, neutral: 0, scale: 4 },
    { parameterId: 'Param86', control: 'rightKneeDepth', min: -20, max: 20, neutral: 0, scale: 4 },
    { parameterId: 'Param19', control: 'rightFootDepth', min: -20, max: 20, neutral: 0, scale: 4 },
    { parameterId: 'Param286', control: 'squat', min: -10, max: 10, neutral: 0, scale: 0.45 },
  ],
}

/** Select a model-specific profile only when its defining parameter ids exist. */
export function resolveLive2dRigProfile(parameterIds: readonly string[]): Live2dRigProfile {
  const available = new Set(parameterIds)
  if (available.has('Param286') && available.has('Param7') && available.has('Param14')) {
    return SHIMAKAZE_LIVE2D_RIG_PROFILE
  }
  return STANDARD_LIVE2D_RIG_PROFILE
}

export class Live2dParameterAdapter {
  readonly #profile: Live2dRigProfile

  constructor(profile: Live2dRigProfile = STANDARD_LIVE2D_RIG_PROFILE) {
    validateLive2dRigProfile(profile)
    this.#profile = profile
  }

  get profile(): Live2dRigProfile {
    return this.#profile
  }

  mapFrame(frame: CanonicalMotionFrame): readonly Live2dParameterUpdate[] {
    const updates: Live2dParameterUpdate[] = []
    for (const binding of this.#profile.parameters) {
      const rawValue = readControl(frame, this.#profile.joints, binding.control)
      if (rawValue === undefined) continue
      const scale = binding.scale ?? 1
      const scaled = binding.invert === true ? -rawValue * scale : rawValue * scale
      updates.push({
        parameterId: binding.parameterId,
        control: binding.control,
        value: clamp(binding.mode === 'absolute' ? scaled : binding.neutral + scaled, binding.min, binding.max),
      })
    }
    return updates
  }

  applyFrame(frame: CanonicalMotionFrame, sink: Live2dParameterSink): void {
    for (const update of this.mapFrame(frame)) {
      sink.setParameterValue(update.parameterId, update.value)
    }
  }
}

export function validateLive2dRigProfile(profile: Live2dRigProfile): void {
  if (!profile || typeof profile !== 'object') throw new Error('Live2D rig profile must be an object')
  if (typeof profile.id !== 'string' || profile.id.trim() !== profile.id || profile.id.length === 0 || profile.id.length > 64) {
    throw new Error('Live2D rig profile id must be a trimmed string up to 64 characters')
  }
  const jointKeys: readonly (keyof Live2dJointBindings)[] = [
    'head', 'leftShoulder', 'leftElbow', 'leftWrist', 'rightShoulder', 'rightElbow', 'rightWrist',
  ]
  for (const key of jointKeys) {
    const jointName = profile.joints?.[key]
    if (typeof jointName !== 'string' || jointName.trim() !== jointName || jointName.length === 0 || jointName.length > 64) {
      throw new Error(`Live2D rig profile joint binding is invalid: ${key}`)
    }
  }
  if (!Array.isArray(profile.parameters) || profile.parameters.length === 0) {
    throw new Error('Live2D rig profile must define at least one parameter')
  }
  const needsLegBindings = profile.parameters.some(binding => binding.control === 'legPhase')
  if (needsLegBindings) {
    const legKeys: readonly (keyof Live2dJointBindings)[] = [
      'leftHip', 'leftKnee', 'leftAnkle', 'rightHip', 'rightKnee', 'rightAnkle',
    ]
    for (const key of legKeys) {
      const jointName = profile.joints?.[key]
      if (typeof jointName !== 'string' || jointName.trim() !== jointName || jointName.length === 0 || jointName.length > 64) {
        throw new Error(`Live2D rig profile leg joint binding is invalid: ${key}`)
      }
    }
  }
  const parameterIds = new Set<string>()
  for (const binding of profile.parameters) {
    if (typeof binding.parameterId !== 'string' || binding.parameterId.trim() !== binding.parameterId || binding.parameterId.length === 0) {
      throw new Error('Live2D parameter id must be a trimmed non-empty string')
    }
    if (parameterIds.has(binding.parameterId)) throw new Error(`Duplicate Live2D parameter id: ${binding.parameterId}`)
    parameterIds.add(binding.parameterId)
    if (!Number.isFinite(binding.min) || !Number.isFinite(binding.max) || binding.min >= binding.max) {
      throw new Error(`Invalid Live2D parameter range: ${binding.parameterId}`)
    }
    if (!Number.isFinite(binding.neutral) || binding.neutral < binding.min || binding.neutral > binding.max) {
      throw new Error(`Invalid Live2D parameter neutral value: ${binding.parameterId}`)
    }
    if (binding.scale !== undefined && (!Number.isFinite(binding.scale) || binding.scale === 0)) {
      throw new Error(`Invalid Live2D parameter scale: ${binding.parameterId}`)
    }
    if (binding.mode !== undefined && binding.mode !== 'offset' && binding.mode !== 'absolute') {
      throw new Error(`Invalid Live2D parameter mode: ${binding.parameterId}`)
    }
  }
}

function readControl(
  frame: CanonicalMotionFrame,
  joints: Live2dJointBindings,
  control: Live2dControl,
): number | undefined {
  switch (control) {
    case 'headYaw': return readJointEuler(frame, joints.head, 'yaw')
    case 'headPitch': return readJointEuler(frame, joints.head, 'pitch')
    case 'headRoll': return readJointEuler(frame, joints.head, 'roll')
    case 'bodyYaw': return quaternionToEuler(frame.rootRotation).yaw
    case 'bodyPitch': return quaternionToEuler(frame.rootRotation).pitch
    case 'bodyRoll': return quaternionToEuler(frame.rootRotation).roll
    case 'leftArmAngle': return readPlanarAngle(frame, joints.leftShoulder, joints.leftElbow)
    case 'rightArmAngle': return readPlanarAngle(frame, joints.rightShoulder, joints.rightElbow)
    case 'leftElbowAngle': return readElbowAngle(frame, joints.leftShoulder, joints.leftElbow, joints.leftWrist)
    case 'rightElbowAngle': return readElbowAngle(frame, joints.rightShoulder, joints.rightElbow, joints.rightWrist)
    case 'leftThighAngle': return readLegAngle(frame, joints.leftHip, joints.leftKnee)
    case 'rightThighAngle': return readLegAngle(frame, joints.rightHip, joints.rightKnee)
    case 'leftKneeBend': return readKneeBend(frame, joints.leftHip, joints.leftKnee, joints.leftAnkle)
    case 'rightKneeBend': return readKneeBend(frame, joints.rightHip, joints.rightKnee, joints.rightAnkle)
    case 'leftFootAngle': return readLegAngle(frame, joints.leftKnee, joints.leftAnkle)
    case 'rightFootAngle': return readLegAngle(frame, joints.rightKnee, joints.rightAnkle)
    case 'leftThighDepth': return readDepthAngle(frame, joints.leftHip, joints.leftKnee)
    case 'rightThighDepth': return readDepthAngle(frame, joints.rightHip, joints.rightKnee)
    case 'leftKneeDepth': return readDepthAngle(frame, joints.leftKnee, joints.leftAnkle)
    case 'rightKneeDepth': return readDepthAngle(frame, joints.rightKnee, joints.rightAnkle)
    case 'leftFootDepth': return readDepthAngle(frame, joints.leftAnkle, 'left_toe')
    case 'rightFootDepth': return readDepthAngle(frame, joints.rightAnkle, 'right_toe')
    case 'squat': return readSquat(frame, joints)
    case 'legPhase': return readLegPhase(frame, joints)
  }
}

function readJointEuler(
  frame: CanonicalMotionFrame,
  jointName: string,
  axis: 'yaw' | 'pitch' | 'roll',
): number | undefined {
  const joint = frame.joints[jointName]
  if (!joint) return undefined
  return quaternionToEuler(joint.rotation)[axis]
}

function readPlanarAngle(frame: CanonicalMotionFrame, fromName: string, toName: string): number | undefined {
  const from = frame.joints[fromName]?.position
  const to = frame.joints[toName]?.position
  if (!from || !to) return undefined
  return Math.atan2(to[1] - from[1], to[0] - from[0]) * 180 / Math.PI
}

function readElbowAngle(
  frame: CanonicalMotionFrame,
  shoulderName: string,
  elbowName: string,
  wristName: string,
): number | undefined {
  const shoulder = frame.joints[shoulderName]?.position
  const elbow = frame.joints[elbowName]?.position
  const wrist = frame.joints[wristName]?.position
  if (!shoulder || !elbow || !wrist) return undefined
  const first = vectorSubtract(shoulder, elbow)
  const second = vectorSubtract(wrist, elbow)
  const denominator = vectorLength(first) * vectorLength(second)
  if (denominator <= 1e-6) return undefined
  const cosine = clamp(dot(first, second) / denominator, -1, 1)
  return Math.acos(cosine) * 180 / Math.PI
}

/** Angle away from the model's neutral, downward leg direction. */
function readLegAngle(frame: CanonicalMotionFrame, fromName: string | undefined, toName: string | undefined): number | undefined {
  if (fromName === undefined || toName === undefined) return undefined
  const from = frame.joints[fromName]?.position
  const to = frame.joints[toName]?.position
  if (!from || !to) return undefined
  return Math.atan2(to[0] - from[0], from[1] - to[1]) * 180 / Math.PI
}

/** Forward/backward angle in the canonical XZ plane. */
function readDepthAngle(frame: CanonicalMotionFrame, fromName: string | undefined, toName: string | undefined): number | undefined {
  if (fromName === undefined || toName === undefined) return undefined
  const from = frame.joints[fromName]?.position
  const to = frame.joints[toName]?.position
  if (!from || !to) return undefined
  return Math.atan2(to[2] - from[2], from[1] - to[1]) * 180 / Math.PI
}

function readKneeBend(
  frame: CanonicalMotionFrame,
  hipName: string | undefined,
  kneeName: string | undefined,
  ankleName: string | undefined,
): number | undefined {
  if (hipName === undefined || kneeName === undefined || ankleName === undefined) return undefined
  const angle = readElbowAngle(frame, hipName, kneeName, ankleName)
  return angle === undefined ? undefined : 180 - angle
}

function readSquat(frame: CanonicalMotionFrame, joints: Live2dJointBindings): number | undefined {
  const left = readKneeBend(frame, joints.leftHip, joints.leftKnee, joints.leftAnkle)
  const right = readKneeBend(frame, joints.rightHip, joints.rightKnee, joints.rightAnkle)
  if (left === undefined || right === undefined) return undefined
  return Math.max(0, (left + right) / 2 - 15)
}

function readLegPhase(frame: CanonicalMotionFrame, joints: Live2dJointBindings): number | undefined {
  const keys = [
    joints.leftHip,
    joints.leftKnee,
    joints.leftAnkle,
    joints.rightHip,
    joints.rightKnee,
    joints.rightAnkle,
  ]
  if (keys.some(key => key === undefined)) return undefined
  const left = readElbowAngle(frame, joints.leftHip!, joints.leftKnee!, joints.leftAnkle!)
  const right = readElbowAngle(frame, joints.rightHip!, joints.rightKnee!, joints.rightAnkle!)
  if (left === undefined || right === undefined) return undefined
  return clamp((left - right) / 90, -1, 1)
}

function quaternionToEuler(quaternion: CanonicalQuaternion): { yaw: number, pitch: number, roll: number } {
  const magnitude = Math.hypot(quaternion[0], quaternion[1], quaternion[2], quaternion[3])
  if (!Number.isFinite(magnitude) || magnitude <= 1e-6) {
    return { yaw: 0, pitch: 0, roll: 0 }
  }
  const [x, y, z, w] = quaternion.map(component => component / magnitude) as unknown as CanonicalQuaternion
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
  const pitchSin = clamp(2 * (w * y - z * x), -1, 1)
  const pitch = Math.asin(pitchSin)
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
  return {
    yaw: yaw * 180 / Math.PI,
    pitch: pitch * 180 / Math.PI,
    roll: roll * 180 / Math.PI,
  }
}

function vectorSubtract(a: CanonicalVector3, b: CanonicalVector3): CanonicalVector3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function vectorLength(value: CanonicalVector3): number {
  return Math.hypot(value[0], value[1], value[2])
}

function dot(a: CanonicalVector3, b: CanonicalVector3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
