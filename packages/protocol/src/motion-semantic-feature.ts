export const MOTION_SEMANTIC_FEATURE_SCHEMA = 'rayure.motion-semantic-feature.v1' as const
export const ARDY_TEXT_FEATURE_DIMENSION = 4096 as const
export const MOTION_SEMANTIC_FEATURE_MAX_TOKENS = 256 as const

export type MotionSemanticFeatureDtype = 'float16' | 'float32'

/**
 * One prompt's cached ARDY text condition.
 *
 * `values` is row-major `[tokenCount, featureDimension]` data and
 * `textPadMask` follows ARDY's convention: `true` marks a real token.
 * This is a runtime contract, not a wire message; large values must never
 * be sent through the 16 KiB Companion WebSocket protocol.
 */
export interface MotionSemanticFeature {
  schema: typeof MOTION_SEMANTIC_FEATURE_SCHEMA
  cacheKey: string
  canonicalPrompt: string
  encoderId: string
  encoderVersion: string
  dtype: MotionSemanticFeatureDtype
  tokenCount: number
  featureDimension: typeof ARDY_TEXT_FEATURE_DIMENSION
  values: readonly number[]
  textPadMask: readonly boolean[]
  createdAtMs: number
}

export class MotionSemanticFeatureValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MotionSemanticFeatureValidationError'
  }
}

export function createMotionSemanticFeature(input: MotionSemanticFeature): MotionSemanticFeature {
  validateMotionSemanticFeature(input)
  return input
}

export function validateMotionSemanticFeature(value: unknown): asserts value is MotionSemanticFeature {
  const feature = requireRecord(value, 'motion semantic feature')
  requireExactKeys(
    feature,
    [
      'schema',
      'cacheKey',
      'canonicalPrompt',
      'encoderId',
      'encoderVersion',
      'dtype',
      'tokenCount',
      'featureDimension',
      'values',
      'textPadMask',
      'createdAtMs',
    ],
    'motion semantic feature',
  )
  if (feature.schema !== MOTION_SEMANTIC_FEATURE_SCHEMA) {
    throw new MotionSemanticFeatureValidationError('Unsupported motion semantic feature schema')
  }

  requirePattern(feature.cacheKey, 'cacheKey', /^[A-Za-z0-9._:-]{1,128}$/u)
  requireDisplayString(feature.canonicalPrompt, 'canonicalPrompt', 512)
  requireDisplayString(feature.encoderId, 'encoderId', 128)
  requireDisplayString(feature.encoderVersion, 'encoderVersion', 128)
  if (feature.dtype !== 'float16' && feature.dtype !== 'float32') {
    throw new MotionSemanticFeatureValidationError('dtype must be float16 or float32')
  }

  const tokenCount = requireInteger(feature.tokenCount, 'tokenCount', 1, MOTION_SEMANTIC_FEATURE_MAX_TOKENS)
  if (feature.featureDimension !== ARDY_TEXT_FEATURE_DIMENSION) {
    throw new MotionSemanticFeatureValidationError(
      `featureDimension must be ${ARDY_TEXT_FEATURE_DIMENSION} for ARDY text conditions`,
    )
  }

  const values = requireArray(feature.values, 'values')
  const expectedValueCount = tokenCount * ARDY_TEXT_FEATURE_DIMENSION
  if (values.length !== expectedValueCount) {
    throw new MotionSemanticFeatureValidationError(
      `values must contain exactly ${expectedValueCount} values for the declared shape`,
    )
  }
  for (const [index, valueEntry] of values.entries()) {
    if (typeof valueEntry !== 'number' || !Number.isFinite(valueEntry)) {
      throw new MotionSemanticFeatureValidationError(`values[${index}] must be finite`)
    }
  }

  const textPadMask = requireArray(feature.textPadMask, 'textPadMask')
  if (textPadMask.length !== tokenCount) {
    throw new MotionSemanticFeatureValidationError('textPadMask length must equal tokenCount')
  }
  if (!textPadMask.some(entry => entry === true)) {
    throw new MotionSemanticFeatureValidationError('textPadMask must contain at least one valid token')
  }
  for (const [index, entry] of textPadMask.entries()) {
    if (typeof entry !== 'boolean') {
      throw new MotionSemanticFeatureValidationError(`textPadMask[${index}] must be boolean`)
    }
  }

  requireInteger(feature.createdAtMs, 'createdAtMs', 0, Number.MAX_SAFE_INTEGER)
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MotionSemanticFeatureValidationError(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new MotionSemanticFeatureValidationError(`${name} contains missing or unknown fields`)
  }
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new MotionSemanticFeatureValidationError(`${name} must be an array`)
  return value
}

function requirePattern(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new MotionSemanticFeatureValidationError(`${name} has an invalid format`)
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
    throw new MotionSemanticFeatureValidationError(`${name} must be a trimmed printable string up to ${maxLength} characters`)
  }
  return value
}

function requireInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MotionSemanticFeatureValidationError(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}
