import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ARDY_TEXT_FEATURE_DIMENSION,
  MotionSemanticFeatureValidationError,
  createMotionSemanticFeature,
  validateMotionSemanticFeature,
} from '../src/motion-semantic-feature.ts'

function makeFeature() {
  const tokenCount = 2
  return {
    schema: 'rayure.motion-semantic-feature.v1' as const,
    cacheKey: 'wave.casual',
    canonicalPrompt: 'casually wave',
    encoderId: 'llm2vec',
    encoderVersion: 'llm2vec-ardy-2026-01',
    dtype: 'float16' as const,
    tokenCount,
    featureDimension: ARDY_TEXT_FEATURE_DIMENSION,
    values: Array.from({ length: tokenCount * ARDY_TEXT_FEATURE_DIMENSION }, (_, index) => index % 7 / 7),
    textPadMask: [true, true],
    createdAtMs: 1_750_000_000_000,
  }
}

test('Motion Semantic Feature v1 accepts an ARDY-compatible feature sequence', () => {
  const feature = createMotionSemanticFeature(makeFeature())
  assert.equal(feature.featureDimension, 4096)
  assert.equal(feature.values.length, feature.tokenCount * feature.featureDimension)
  assert.deepEqual(feature.textPadMask, [true, true])
})

test('Motion Semantic Feature v1 rejects incompatible dimensions and shapes', () => {
  const wrongDimension = makeFeature() as Record<string, unknown>
  wrongDimension.featureDimension = 768
  assert.throws(() => validateMotionSemanticFeature(wrongDimension), /4096|dimension/i)

  const wrongValueCount = makeFeature()
  wrongValueCount.values = wrongValueCount.values.slice(0, -1)
  assert.throws(() => validateMotionSemanticFeature(wrongValueCount), /values|shape|length/i)

  const wrongMask = makeFeature()
  wrongMask.textPadMask = [true]
  assert.throws(() => validateMotionSemanticFeature(wrongMask), /mask|token/i)
})

test('Motion Semantic Feature v1 rejects invalid metadata and non-finite values', () => {
  const invalidKey = makeFeature()
  invalidKey.cacheKey = 'wave/../casual'
  assert.throws(() => validateMotionSemanticFeature(invalidKey), MotionSemanticFeatureValidationError)

  const invalidValue = makeFeature()
  invalidValue.values[0] = Number.NaN
  assert.throws(() => validateMotionSemanticFeature(invalidValue), /finite/i)

  const invalidMask = makeFeature()
  invalidMask.textPadMask = [false, false]
  assert.throws(() => validateMotionSemanticFeature(invalidMask), /valid token|mask/i)
})
