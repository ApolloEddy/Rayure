import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { MotionSemanticFeature } from '@rayure/protocol'

import { ARDY_CORE_JOINT_NAMES } from '../src/ardy-motion-adapter.ts'
import { ArdyProcessClient } from '../src/ardy-process-client.ts'

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

function makeBridgeScript(mode: 'result' | 'silent' | 'delay-first'): string {
  const jointNames = JSON.stringify(ARDY_CORE_JOINT_NAMES)
  return `
import readline from 'node:readline'
const jointNames = ${jointNames}
const input = readline.createInterface({ input: process.stdin })
let first = true
input.on('line', line => {
  const request = JSON.parse(line)
  if (${JSON.stringify(mode)} === 'silent') return
  const respond = () => {
    const joints = Object.fromEntries(jointNames.map(name => [name, { position: [0, 1, 0], rotation: [0, 0, 0, 1] }]))
    process.stdout.write(JSON.stringify({
      schema: 'rayure.ardy-process-result.v1',
      type: 'result',
      requestId: request.requestId,
      motion: {
        schema: 'rayure.ardy-motion.v1',
        backend: 'ardy-core',
        fps: 20,
        jointNames,
        frames: [{ timeMs: 0, rootPosition: [0, 0, 0], rootRotation: [0, 0, 0, 1], joints }],
      },
    }) + '\\n')
  }
  if (${JSON.stringify(mode)} === 'delay-first' && first) {
    first = false
    setTimeout(respond, 600)
    return
  }
  respond()
})
`
}

test('ARDY process client sends one request and returns a validated Canonical Motion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-ardy-process-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bridgePath = join(root, 'bridge.mjs')
  await writeFile(bridgePath, makeBridgeScript('result'), 'utf8')
  const client = new ArdyProcessClient({ command: process.execPath, args: [bridgePath] })
  t.after(() => client.close())

  const result = await client.generate({
    textFeature: makeFeature(),
    numFrames: 40,
    numDenoisingSteps: 4,
    cfgWeight: 2,
  })
  assert.equal(result.motion.jointSetId, 'ardy-core-27')
  assert.equal(result.motion.frames.length, 1)
})

test('ARDY process client times out a silent bridge and does not leave a pending request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-ardy-process-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bridgePath = join(root, 'bridge.mjs')
  await writeFile(bridgePath, makeBridgeScript('silent'), 'utf8')
  const client = new ArdyProcessClient({
    command: process.execPath,
    args: [bridgePath],
    requestTimeoutMs: 250,
  })
  t.after(() => client.close())

  await assert.rejects(
    client.generate({
      textFeature: makeFeature(),
      numFrames: 40,
      numDenoisingSteps: 4,
      cfgWeight: 2,
    }),
    /timeout|closed/i,
  )
})

test('ARDY process client abort abandons the wait but keeps the bridge usable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-ardy-process-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bridgePath = join(root, 'bridge.mjs')
  // The first request responds late (600ms): the abort abandons it, and the
  // late response line must be dropped as stale instead of rejecting the
  // follow-up request.
  await writeFile(bridgePath, makeBridgeScript('delay-first'), 'utf8')
  const client = new ArdyProcessClient({
    command: process.execPath,
    args: [bridgePath],
    requestTimeoutMs: 10_000,
  })
  t.after(() => client.close())
  const controller = new AbortController()
  const pending = client.generate({
    textFeature: makeFeature(),
    numFrames: 40,
    numDenoisingSteps: 4,
    cfgWeight: 2,
    signal: controller.signal,
  })
  controller.abort()

  await assert.rejects(pending, /abort/i)

  // The bridge is still alive: the next request resolves normally and the
  // abandoned step's late response arrives while it is pending.
  const result = await client.generate({
    textFeature: makeFeature(),
    numFrames: 40,
    numDenoisingSteps: 4,
    cfgWeight: 2,
  })
  assert.equal(result.motion.jointSetId, 'ardy-core-27')
  assert.equal(result.motion.frames.length, 1)
})
