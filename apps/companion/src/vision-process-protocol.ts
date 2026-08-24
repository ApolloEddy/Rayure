export const VISION_OBSERVATION_VERSION = 'rayure.vision-observation.v1' as const

export interface VisionHandObservation {
  wrist: readonly [number, number]
  shoulderY: number
  confidence: number
}

export interface VisionHeadObservation {
  yaw: number
  pitch: number
  confidence: number
}

export interface VisionObservation {
  version: typeof VISION_OBSERVATION_VERSION
  id: string
  observedAtMs: number
  presenceConfidence: number
  head?: VisionHeadObservation
  leftHand?: VisionHandObservation
  rightHand?: VisionHandObservation
}

export function parseVisionObservation(raw: string): VisionObservation {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 16 * 1024) {
    throw new Error('Vision observation line must be a non-empty string up to 16 KiB')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    throw new Error('Vision observation must be valid JSON')
  }
  const root = requireRecord(parsed, 'Vision observation')
  requireExactKeys(root, ['version', 'id', 'observedAtMs', 'presenceConfidence', 'head', 'leftHand', 'rightHand'].filter(key => root[key] !== undefined), 'Vision observation')
  if (root.version !== VISION_OBSERVATION_VERSION) throw new Error('Vision observation version is unsupported')
  const result: VisionObservation = {
    version: VISION_OBSERVATION_VERSION,
    id: requireIdentifier(root.id, 'Vision observation id'),
    observedAtMs: requireTimestamp(root.observedAtMs, 'Vision observation timestamp'),
    presenceConfidence: requireConfidence(root.presenceConfidence, 'Vision presence confidence'),
    ...(root.head === undefined ? {} : { head: parseHead(root.head) }),
    ...(root.leftHand === undefined ? {} : { leftHand: parseHand(root.leftHand, 'leftHand') }),
    ...(root.rightHand === undefined ? {} : { rightHand: parseHand(root.rightHand, 'rightHand') }),
  }
  if (result.head === undefined && result.leftHand === undefined && result.rightHand === undefined && result.presenceConfidence > 0) {
    throw new Error('Vision observation with presence must contain a derived pose field')
  }
  return result
}

export function serializeVisionObservation(observation: VisionObservation): string {
  return JSON.stringify(parseVisionObservation(JSON.stringify(observation)))
}

function parseHead(value: unknown): VisionHeadObservation {
  const root = requireRecord(value, 'Vision head observation')
  requireExactKeys(root, ['yaw', 'pitch', 'confidence'], 'Vision head observation')
  return {
    yaw: requireBoundedNumber(root.yaw, -180, 180, 'Vision head yaw'),
    pitch: requireBoundedNumber(root.pitch, -90, 90, 'Vision head pitch'),
    confidence: requireConfidence(root.confidence, 'Vision head confidence'),
  }
}

function parseHand(value: unknown, label: string): VisionHandObservation {
  const root = requireRecord(value, `Vision ${label} observation`)
  requireExactKeys(root, ['wrist', 'shoulderY', 'confidence'], `Vision ${label} observation`)
  if (!Array.isArray(root.wrist) || root.wrist.length !== 2) throw new Error(`Vision ${label} wrist must be an x/y pair`)
  return {
    wrist: [
      requireBoundedNumber(root.wrist[0], -1, 2, `Vision ${label} wrist x`),
      requireBoundedNumber(root.wrist[1], -1, 2, `Vision ${label} wrist y`),
    ],
    shoulderY: requireBoundedNumber(root.shoulderY, -1, 2, `Vision ${label} shoulder y`),
    confidence: requireConfidence(root.confidence, `Vision ${label} confidence`),
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const allowed = [...expected].sort()
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`${label} contains missing or unknown fields`)
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,96}$/u.test(value)) throw new Error(`${label} is invalid`)
  return value
}

function requireTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return value as number
}

function requireConfidence(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`)
  return value
}

function requireBoundedNumber(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} is out of range`)
  return value
}
