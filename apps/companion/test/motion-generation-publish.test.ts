import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import WebSocket from 'ws'

import type { MotionSemanticFeature } from '@rayure/protocol'
import { parseServerMessage } from '@rayure/protocol'

import { ARDY_CORE_JOINT_NAMES } from '../src/ardy-motion-adapter.ts'
import { serializeMotionSemanticFeatureCache } from '../src/motion-semantic-cache-file.ts'
import { createMotionSemanticRuntime } from '../src/motion-semantic-runtime.ts'
import { createCompanionServer } from '../src/server.ts'

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

function makeBridgeScript(): string {
  const jointNames = JSON.stringify(ARDY_CORE_JOINT_NAMES)
  return `
import readline from 'node:readline'
const jointNames = ${jointNames}
const input = readline.createInterface({ input: process.stdin })
input.on('line', line => {
  const request = JSON.parse(line)
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
})
`
}

test('generated motion is published and served over the loopback gateway', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rayure-publish-e2e-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const feature = makeFeature()
  const cachePath = join(root, 'motion-features.json')
  await writeFile(cachePath, serializeMotionSemanticFeatureCache([feature]))

  const bridgePath = join(root, 'bridge.mjs')
  await writeFile(bridgePath, makeBridgeScript(), 'utf8')

  const runtime = await createMotionSemanticRuntime({
    cachePath,
    ardy: {
      command: process.execPath,
      args: [bridgePath],
      requestTimeoutMs: 5_000,
    },
  })
  t.after(() => runtime.close())

  const server = createCompanionServer({ port: 0, helloTimeoutMs: 1_000 })
  const address = await server.start()
  t.after(() => server.stop())

  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`)
  t.after(() => socket.close())
  await once(socket, 'open')

  const received = new Promise<ReturnType<typeof parseServerMessage>>(resolve => {
    socket.on('message', (data) => {
      const message = parseServerMessage((data as ArrayBuffer).toString())
      if (message.type === 'motion.published') resolve(message)
    })
  })
  socket.send(JSON.stringify({ protocolVersion: 1, type: 'client.hello', id: 'hello-e2e', payload: { client: 'wallpaper', build: 'test' } }))

  // Warm up the generation backend and publish once a client is connected.
  await new Promise(resolve => once(socket, 'message').then(resolve))
  const service = runtime.createGenerationService()
  const result = await service.generate({
    cacheKey: feature.cacheKey,
    canonicalPrompt: feature.canonicalPrompt,
    numFrames: 40,
    numDenoisingSteps: 4,
    cfgWeight: 2,
  })
  server.publishMotion({
    id: feature.cacheKey,
    displayName: feature.canonicalPrompt,
    motion: result.motion,
  })

  const published = await received
  assert.equal(published.type, 'motion.published')
  if (published.type !== 'motion.published') assert.fail('expected motion.published')
  assert.equal(published.payload.motion.format, 'canonical')
  assert.equal(published.payload.motion.id, 'wave.casual-1')

  const body = await (await fetch(published.payload.motion.url, { headers: { Origin: 'null' } })).json()
  assert.equal(body.schema, 'rayure.motion.v1')
  assert.equal(body.frames.length, 1)
})
