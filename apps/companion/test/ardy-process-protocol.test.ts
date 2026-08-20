import assert from 'node:assert/strict'
import test from 'node:test'

import type { MotionSemanticFeature } from '@rayure/protocol'

import {
  ARDY_PROCESS_ERROR_SCHEMA,
  ARDY_PROCESS_REQUEST_SCHEMA,
  ARDY_PROCESS_RESULT_SCHEMA,
  createArdyMotionCancel,
  createArdyMotionRequest,
  parseArdyMotionResponse,
  serializeArdyProcessMessage,
} from '../src/ardy-process-protocol.ts'
import { ARDY_CORE_JOINT_NAMES } from '../src/ardy-motion-adapter.ts'

function makeFeature(): MotionSemanticFeature {
  return {
    schema: 'rayure.motion-semantic-feature.v1',
    cacheKey: 'wave.casual',
    canonicalPrompt: 'casually wave',
    encoderId: 'fixture-encoder',
    encoderVersion: 'fixture-v1',
    dtype: 'float16',
    tokenCount: 1,
    featureDimension: 4096,
    values: Array.from({ length: 4096 }, () => 0.25),
    textPadMask: [true],
    createdAtMs: 1,
  }
}

function makeRawMotion() {
  const joints = Object.fromEntries(ARDY_CORE_JOINT_NAMES.map(name => [name, {
    position: [0, 1, 0],
    rotation: [0, 0, 0, 1],
  }]))
  return {
    schema: 'rayure.ardy-motion.v1',
    backend: 'ardy-core',
    fps: 20,
    jointNames: [...ARDY_CORE_JOINT_NAMES],
    frames: [{
      timeMs: 0,
      rootPosition: [0, 0, 0],
      rootRotation: [0, 0, 0, 1],
      joints,
    }],
  }
}

test('ARDY process protocol validates generation requests and result responses', () => {
  const request = createArdyMotionRequest({
    requestId: 'request-1',
    textFeature: makeFeature(),
    numFrames: 40,
    numDenoisingSteps: 4,
    cfgWeight: 2,
    constraints: [{
      timeMs: 500,
      joint: 'RightHand',
      position: [0.2, 1.4, 0.1],
    }],
  })
  const rawRequest = serializeArdyProcessMessage(request)
  assert.match(rawRequest, new RegExp(ARDY_PROCESS_REQUEST_SCHEMA))

  const result = parseArdyMotionResponse(JSON.stringify({
    schema: ARDY_PROCESS_RESULT_SCHEMA,
    type: 'result',
    requestId: 'request-1',
    motion: makeRawMotion(),
  }), 'request-1')
  assert.equal(result.requestId, 'request-1')
  assert.equal(result.motion.jointSetId, 'ardy-core-27')
  assert.equal(result.motion.frames.length, 1)
})

test('ARDY process protocol supports cancellation and structured errors', () => {
  const cancel = createArdyMotionCancel('request-1')
  assert.equal(cancel.schema, ARDY_PROCESS_REQUEST_SCHEMA)
  assert.equal(cancel.type, 'cancel')
  assert.match(serializeArdyProcessMessage(cancel), /"type":"cancel"/)

  assert.throws(() => parseArdyMotionResponse(JSON.stringify({
    schema: ARDY_PROCESS_ERROR_SCHEMA,
    type: 'error',
    requestId: 'request-1',
    code: 'inference_failed',
    message: 'model failed',
  }), 'request-1'), /inference_failed|model failed/i)
})

test('ARDY process protocol rejects request/response identity and shape mismatches', () => {
  assert.throws(() => createArdyMotionRequest({
    requestId: 'request-1',
    textFeature: makeFeature(),
    numFrames: 40,
    numDenoisingSteps: 4,
    cfgWeight: 2,
    constraints: [{ timeMs: 0, joint: 'Unknown', position: [0, 0, 0] }],
  }), /constraint|joint/i)

  assert.throws(() => parseArdyMotionResponse(JSON.stringify({
    schema: ARDY_PROCESS_RESULT_SCHEMA,
    type: 'result',
    requestId: 'other-request',
    motion: makeRawMotion(),
  }), 'request-1'), /requestId|identity/i)

  assert.throws(() => parseArdyMotionResponse(JSON.stringify({
    schema: ARDY_PROCESS_RESULT_SCHEMA,
    type: 'result',
    requestId: 'request-1',
    motion: makeRawMotion(),
    extra: true,
  }), 'request-1'), /unknown|missing|shape/i)
})
