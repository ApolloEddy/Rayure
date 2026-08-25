import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyCalibrationChannels,
  missingCalibrationControls,
  serializeCalibration,
} from '../src/live2d/calibration-core.ts'
import {
  LINGBO10_LIVE2D_RIG_PROFILE,
  STANDARD_LIVE2D_RIG_PROFILE,
} from '../src/live2d/rig-profile.ts'
import { groupParameters } from '../src/live2d/calibration-wizard.ts'

function range(id: string): { id: string, min: number, max: number, defaultValue: number } {
  return { id, min: -30, max: 30, defaultValue: 0 }
}

test('standard profile covers head, body and arms but not per-joint legs', () => {
  const missing = missingCalibrationControls(STANDARD_LIVE2D_RIG_PROFILE)
  assert.equal(missing.includes('headYaw'), false)
  assert.equal(missing.includes('leftArmAngle'), false)
  assert.equal(missing.includes('leftThighAngle'), true)
  assert.equal(missing.includes('legPhase'), false)
})

test('lingbo10 profile reports the channels its rig cannot map', () => {
  // The bilibili rig exposes no parameters for right-knee depth, squat or a
  // signed leg phase, so those stay unmapped next to the uncalibrated left arm.
  const missing = missingCalibrationControls(LINGBO10_LIVE2D_RIG_PROFILE)
  assert.deepEqual(missing, ['leftArmAngle', 'leftElbowAngle', 'rightKneeDepth', 'squat', 'legPhase'])
})

test('disabled controls are excluded from the missing set', () => {
  const missing = missingCalibrationControls(LINGBO10_LIVE2D_RIG_PROFILE, ['leftArmAngle'])
  assert.deepEqual(missing, ['leftElbowAngle', 'rightKneeDepth', 'squat', 'legPhase'])
})

test('classify marks mapped, unmapped and disabled channels', () => {
  const channels = classifyCalibrationChannels(LINGBO10_LIVE2D_RIG_PROFILE, ['leftArmAngle'])
  const leftArm = channels.find(channel => channel.control === 'leftArmAngle')
  const rightArm = channels.find(channel => channel.control === 'rightArmAngle')
  const leftElbow = channels.find(channel => channel.control === 'leftElbowAngle')
  assert.equal(leftArm?.mapped, false)
  assert.equal(leftArm?.disabled, true)
  assert.equal(rightArm?.mapped, true)
  assert.equal(rightArm?.disabled, false)
  assert.equal(leftElbow?.mapped, false)
  assert.equal(leftElbow?.disabled, false)
})

test('serializeCalibration round-trips bindings, disabled controls and pose', () => {
  const serialized = serializeCalibration(
    LINGBO10_LIVE2D_RIG_PROFILE,
    ['leftArmAngle'],
    { ParamAngleX: 5, Param7: 0 },
  )
  assert.equal(serialized.profileId, LINGBO10_LIVE2D_RIG_PROFILE.id)
  assert.deepEqual(serialized.disabledControls, ['leftArmAngle'])
  assert.deepEqual(serialized.neutralPose, { ParamAngleX: 5, Param7: 0 })
  const arm = serialized.parameters.find(binding => binding.control === 'rightArmAngle')
  assert.equal(arm?.parameterId, 'Param2')
  assert.equal(serialized.parameters.some(binding => binding.control === 'leftArmAngle'), false)
})

test('parameter grouping folds EyeL/EyeR variants into one readable group', () => {
  const groups = groupParameters([
    range('ParamEyeLOpen'),
    range('ParamEyeROpen'),
    range('ParamEyeBallX'),
    range('ParamBrowLY'),
    range('ParamMouthOpenY'),
  ])
  const labels = groups.map(group => group.label)
  assert.equal(labels.includes('眼睛'), true)
  assert.equal(labels.includes('眉毛'), true)
  assert.equal(labels.includes('嘴'), true)
  const eye = groups.find(group => group.label === '眼睛')
  assert.deepEqual(
    eye?.items.map(item => item.id).sort(),
    ['ParamEyeLOpen', 'ParamEyeROpen'],
  )
  // Eyeball is its own more specific group, not merged into 眼睛.
  assert.equal(labels.includes('眼球'), true)
  const eyeball = groups.find(group => group.label === '眼球')
  assert.deepEqual(eyeball?.items.map(item => item.id), ['ParamEyeBallX'])
})

test('parameter grouping keeps abbreviation families and does not drop S-prefixed ids', () => {
  const groups = groupParameters([
    range('ParamSDWL'),
    range('ParamSDWL2'),
    range('ParamSBQSQH'),
    range('ParamTKKS'),
    range('S'),
    range('Param2'),
  ])
  const labels = groups.map(group => group.label)
  // Every input appears exactly once across groups.
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)
  assert.equal(total, 6)
  // Same-prefix abbreviations stay together, with the guessed label.
  const sdwl = groups.find(group => group.label.includes('SDWL'))
  assert.deepEqual(sdwl?.items.map(item => item.id), ['ParamSDWL', 'ParamSDWL2'])
  // Numeric and single-letter ids fall into the fallback bucket instead of vanishing.
  assert.equal(labels.includes('其他'), true)
})

test('parameter grouping is stable for the same input', () => {
  const input = [range('ParamEyeLOpen'), range('ParamZKK'), range('ParamHairFront')]
  const first = groupParameters(input)
  const second = groupParameters(input)
  assert.deepEqual(first, second)
})

test('known pinyin abbreviations get their guessed Chinese label', () => {
  const groups = groupParameters([range('ParamTKKS'), range('ParamDTXZ'), range('ParamZS1'), range('ParamZS2')])
  const labels = groups.map(group => group.label)
  assert.equal(labels.includes('TKKS（瞳孔开闭？）'), true)
  assert.equal(labels.includes('DTXZ（低头旋转？）'), true)
  // Numbered family entries keep their own annotations instead of being
  // stripped down to an unannotated prefix group.
  assert.equal(labels.includes('ZS1（眨眼1？）'), true)
  assert.equal(labels.includes('ZS2（眨眼2？）'), true)
})

test('unknown abbreviations stay unannotated instead of wrong guesses', () => {
  const groups = groupParameters([range('ParamZZZZ')])
  const labels = groups.map(group => group.label)
  assert.deepEqual(labels, ['ZZZZ'])
})
