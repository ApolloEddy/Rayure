import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import WebSocket from 'ws'

import {
  PROTOCOL_VERSION,
  createClientHello,
  createClientMotionGenerate,
  createClientMotionPlayback,
  parseServerMessage,
} from '@rayure/protocol'
import { createCompanionServer } from '../src/server.ts'
import { ARDY_CORE_JOINT_NAMES, convertArdyMotion } from '../src/ardy-motion-adapter.ts'

test('a new Live2D model advertises a calibration endpoint and saves outside the asset tree', async (t) => {
  const assetRoot = await mkdtemp(join(tmpdir(), 'rayure-calibration-assets-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'rayure-calibration-state-'))
  t.after(() => rm(assetRoot, { recursive: true, force: true }))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  await mkdir(join(assetRoot, 'tex'))
  const modelBytes = Buffer.from(JSON.stringify({ Version: 3, FileReferences: {} }))
  const mocBytes = Buffer.from([0x4d, 0x4f, 0x43, 0x33])
  const textureBytes = Buffer.from([137, 80, 78, 71])
  await writeFile(join(assetRoot, 'M.model3.json'), modelBytes)
  await writeFile(join(assetRoot, 'M.moc3'), mocBytes)
  await writeFile(join(assetRoot, 'tex', 'texture_00.png'), textureBytes)
  const calibrationFilePath = join(stateRoot, 'cal-debug.json')

  const server = createCompanionServer({
    port: 0,
    helloTimeoutMs: 500,
    createAssetToken: () => '0123456789abcdef0123456789abcdef',
    model: {
      id: 'cal-debug',
      displayName: 'Calibration debug',
      format: 'live2d',
      entryFilePath: join(assetRoot, 'M.model3.json'),
      calibrationFilePath,
    },
  })
  const address = await server.start()
  t.after(() => server.stop())

  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`, {
    origin: 'http://127.0.0.1:4173',
  })
  t.after(() => socket.close())
  await once(socket, 'open')
  const modelMessagePromise = new Promise<{ calibrationUrl?: string }>((resolveMessage) => {
    socket.on('message', (data) => {
      const message = parseServerMessage(Buffer.from(data as ArrayBuffer).toString())
      if (message.type === 'model.available') resolveMessage(message.payload.model)
    })
  })
  socket.send(JSON.stringify(createClientHello({ id: 'hello-calibration', build: 'test' })))

  const model = await modelMessagePromise
  assert.ok(model.calibrationUrl, 'expected a calibration URL')
  const calibrationUrl = model.calibrationUrl!

  const served = await fetch(calibrationUrl, { cache: 'no-store', credentials: 'omit' })
  assert.equal(served.status, 404)

  const updated = {
    profileId: 'test-calibration-profile',
    parameters: [{ parameterId: 'ParamAngleX', control: 'headYaw', min: -30, max: 30, neutral: 12 }],
    neutralPose: { ParamAngleX: 12 },
    skinHiddenPartIds: [],
  }
  const save = await fetch(calibrationUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(updated),
  })
  assert.equal(save.status, 204)

  const reloaded = await fetch(calibrationUrl, { cache: 'no-store', credentials: 'omit' })
  assert.equal(reloaded.status, 200)
  assert.deepEqual(JSON.parse(await reloaded.text()), updated)
  assert.deepEqual(JSON.parse(await readFile(calibrationFilePath, 'utf8')), updated)
  await assert.rejects(readFile(join(assetRoot, 'rayure.calibration.json'), 'utf8'), /ENOENT/u)

  const replacement = {
    ...updated,
    parameters: [{ ...updated.parameters[0], neutral: -6 }],
    neutralPose: { ParamAngleX: -6 },
  }
  const replace = await fetch(calibrationUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(replacement),
  })
  assert.equal(replace.status, 204)
  assert.deepEqual(JSON.parse(await readFile(calibrationFilePath, 'utf8')), replacement)
})

test('calibration POST rejects invalid payloads and non-Live2D assets', async (t) => {
  const assetRoot = await mkdtemp(join(tmpdir(), 'rayure-calibration-reject-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'rayure-calibration-reject-state-'))
  t.after(() => rm(assetRoot, { recursive: true, force: true }))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const modelBytes = Buffer.from(JSON.stringify({ Version: 3, FileReferences: {} }))
  const mocBytes = Buffer.from([0x4d, 0x4f, 0x43, 0x33])
  await writeFile(join(assetRoot, 'M.model3.json'), modelBytes)
  await writeFile(join(assetRoot, 'M.moc3'), mocBytes)

  const server = createCompanionServer({
    port: 0,
    helloTimeoutMs: 500,
    createAssetToken: () => '0123456789abcdef0123456789abcdef',
    model: {
      id: 'cal-reject',
      displayName: 'Calibration reject',
      format: 'live2d',
      entryFilePath: join(assetRoot, 'M.model3.json'),
      calibrationFilePath: join(stateRoot, 'cal-reject.json'),
    },
  })
  const address = await server.start()
  t.after(() => server.stop())

  const badSave = await fetch(`http://${address.host}:${address.port}/assets/0123456789abcdef0123456789abcdef/rayure.calibration.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileId: 'x', parameters: [] }),
  })
  assert.equal(badSave.status, 400)

  const wrongPath = await fetch(`http://${address.host}:${address.port}/assets/0123456789abcdef0123456789abcdef/other.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileId: 'x', parameters: [{ parameterId: 'A', control: 'headYaw', min: -1, max: 1, neutral: 0 }] }),
  })
  assert.equal(wrongPath.status, 404)
})

test('server binds only to loopback and completes a correlated handshake', async (t) => {
  const server = createCompanionServer({ port: 0, helloTimeoutMs: 500 })
  const address = await server.start()
  t.after(() => server.stop())

  assert.equal(address.host, '127.0.0.1')
  assert.ok(address.port > 0)

  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`)
  t.after(() => socket.close())
  await once(socket, 'open')
  socket.send(JSON.stringify(createClientHello({ id: 'hello-test', build: 'test' })))

  const [data] = await once(socket, 'message')
  const message = parseServerMessage(data.toString())
  assert.equal(message.type, 'server.welcome')
  assert.equal(message.protocolVersion, PROTOCOL_VERSION)
  assert.equal(message.replyTo, 'hello-test')
  assert.equal(server.snapshot().connectedClients, 1)
})

test('invalid JSON fails closed with a policy close', async (t) => {
  const server = createCompanionServer({ port: 0, helloTimeoutMs: 500 })
  const address = await server.start()
  t.after(() => server.stop())

  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`)
  await once(socket, 'open')
  socket.send('{')
  const [code] = await once(socket, 'close')
  assert.equal(code, 1008)
})

test('binary messages are rejected before parsing', async (t) => {
  const server = createCompanionServer({ port: 0, helloTimeoutMs: 500 })
  const address = await server.start()
  t.after(() => server.stop())

  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`)
  await once(socket, 'open')
  socket.send(Buffer.from([1, 2, 3]))
  const [code] = await once(socket, 'close')
  assert.equal(code, 1003)
})

test('silent and duplicate handshakes cannot leave ambiguous sessions', async (t) => {
  const server = createCompanionServer({ port: 0, helloTimeoutMs: 40 })
  const address = await server.start()
  t.after(() => server.stop())

  const silent = new WebSocket(`ws://${address.host}:${address.port}/ws`)
  await once(silent, 'open')
  const [silentCode] = await once(silent, 'close')
  assert.equal(silentCode, 1008)

  const duplicate = new WebSocket(`ws://${address.host}:${address.port}/ws`)
  await once(duplicate, 'open')
  const hello = JSON.stringify(createClientHello({ id: 'duplicate-1', build: 'test' }))
  duplicate.send(hello)
  await once(duplicate, 'message')
  duplicate.send(hello)
  const [duplicateCode] = await once(duplicate, 'close')
  assert.equal(duplicateCode, 1008)
})

test('a welcomed renderer can report bounded generated-motion progress without reopening its handshake', async (t) => {
  let resolveObserved: ((payload: { motionId: string, phase: string, frameIndex: number }) => void) | undefined
  const observed = new Promise<{ motionId: string, phase: string, frameIndex: number }>(resolve => {
    resolveObserved = resolve
  })
  const server = createCompanionServer({
    port: 0,
    helloTimeoutMs: 500,
    onMotionPlayback: payload => resolveObserved?.(payload),
  })
  const address = await server.start()
  t.after(() => server.stop())

  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`)
  t.after(() => socket.close())
  await once(socket, 'open')
  socket.send(JSON.stringify(createClientHello({ id: 'hello-playback', build: 'test' })))
  await once(socket, 'message')

  socket.send(JSON.stringify(createClientMotionPlayback({
    id: 'playback-1',
    motionId: 'generated-wave-1',
    phase: 'progress',
    frameIndex: 7,
  })))
  assert.deepEqual(await observed, {
    motionId: 'generated-wave-1',
    phase: 'progress',
    frameIndex: 7,
  })
  assert.equal(socket.readyState, WebSocket.OPEN)
})

test('a welcomed renderer can request one debug ARDY generation and receive acceptance', async (t) => {
  let observed: { id: string, prompt: string } | undefined
  const server = createCompanionServer({
    port: 0,
    helloTimeoutMs: 500,
    onMotionGenerate: input => {
      observed = { id: input.id, prompt: input.prompt }
    },
  })
  const address = await server.start()
  t.after(() => server.stop())

  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`)
  t.after(() => socket.close())
  await once(socket, 'open')
  socket.send(JSON.stringify(createClientHello({ id: 'hello-generate', build: 'test' })))
  await once(socket, 'message')

  const request = createClientMotionGenerate({ id: 'generate-1', prompt: 'A person waves their hand casually' })
  socket.send(JSON.stringify(request))
  const [data] = await once(socket, 'message')
  const status = parseServerMessage(data.toString())
  assert.equal(status.type, 'motion.generate.status')
  if (status.type !== 'motion.generate.status') assert.fail('expected motion generation status')
  assert.equal(status.replyTo, request.id)
  assert.equal(status.payload.phase, 'accepted')
  assert.deepEqual(observed, { id: request.id, prompt: request.payload.prompt })
  assert.equal(socket.readyState, WebSocket.OPEN)
})

test('start and stop are idempotent and terminal state is observable', async () => {
  const server = createCompanionServer({ port: 0 })
  const first = await server.start()
  const second = await server.start()
  assert.deepEqual(second, first)
  await server.stop()
  await server.stop()
  assert.equal(server.snapshot().phase, 'stopped')
})

test('authorized clients receive a tokenized model URL and only allowlisted files are served', async (t) => {
  const assetRoot = await mkdtemp(join(tmpdir(), 'rayure-assets-'))
  t.after(() => rm(assetRoot, { recursive: true, force: true }))
  await mkdir(join(assetRoot, 'tex'))
  const modelBytes = Buffer.from('test-pmx-payload')
  const textureBytes = Buffer.from([137, 80, 78, 71])
  await writeFile(join(assetRoot, 'model.pmx'), modelBytes)
  await writeFile(join(assetRoot, 'tex', 'face.png'), textureBytes)
  await writeFile(join(assetRoot, 'source.blend'), 'private source')

  const server = createCompanionServer({
    port: 0,
    helloTimeoutMs: 500,
    createAssetToken: () => '0123456789abcdef0123456789abcdef',
    model: {
      id: 'local-test-model',
      displayName: 'Local test model',
      format: 'pmx',
      entryFilePath: join(assetRoot, 'model.pmx'),
    },
  })
  const address = await server.start()
  t.after(() => server.stop())

  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`, {
    origin: 'http://127.0.0.1:4173',
  })
  t.after(() => socket.close())
  await once(socket, 'open')
  const messages = new Promise<[Buffer, Buffer]>((resolveMessages) => {
    const received: Buffer[] = []
    socket.on('message', (data) => {
      received.push(Buffer.from(data as ArrayBuffer))
      if (received.length === 2) resolveMessages([received[0]!, received[1]!])
    })
  })
  socket.send(JSON.stringify(createClientHello({ id: 'hello-assets', build: 'test' })))

  const [welcomeData, modelData] = await messages
  assert.equal(parseServerMessage(welcomeData.toString()).type, 'server.welcome')
  const modelMessage = parseServerMessage(modelData.toString())
  assert.equal(modelMessage.type, 'model.available')
  if (modelMessage.type !== 'model.available') assert.fail('expected model.available')
  assert.equal(modelMessage.payload.model.url.includes(assetRoot), false)

  const modelResponse = await fetch(modelMessage.payload.model.url, { headers: { Origin: 'null' } })
  assert.equal(modelResponse.status, 200)
  assert.deepEqual(Buffer.from(await modelResponse.arrayBuffer()), modelBytes)
  assert.equal(modelResponse.headers.get('access-control-allow-origin'), 'null')
  assert.equal(modelResponse.headers.get('x-content-type-options'), 'nosniff')

  const textureUrl = new URL('tex/face.png', modelMessage.payload.model.url)
  const textureResponse = await fetch(textureUrl, { method: 'HEAD', headers: { Origin: 'null' } })
  assert.equal(textureResponse.status, 200)
  assert.equal(textureResponse.headers.get('content-length'), String(textureBytes.byteLength))

  const deniedExtension = new URL('source.blend', modelMessage.payload.model.url)
  assert.equal((await fetch(deniedExtension, { headers: { Origin: 'null' } })).status, 403)
  assert.equal((await fetch(modelMessage.payload.model.url, {
    headers: { Origin: 'https://hostile.example' },
  })).status, 403)
  assert.equal((await fetch(modelMessage.payload.model.url.replace('/assets/', '/assets/wrong-token/'), {
    headers: { Origin: 'null' },
  })).status, 404)
})

test('authorized clients receive a tokenized Live2D model3 package', async (t) => {
  const assetRoot = await mkdtemp(join(tmpdir(), 'rayure-live2d-assets-'))
  t.after(() => rm(assetRoot, { recursive: true, force: true }))
  await mkdir(join(assetRoot, 'Hiyori.2048'))
  await mkdir(join(assetRoot, 'motions'))
  await mkdir(join(assetRoot, 'expressions'))
  const modelBytes = Buffer.from(JSON.stringify({
    Version: 3,
    FileReferences: {
      Expressions: [
        { Name: 'Smile', File: 'expressions/smile.exp3.json' },
      ],
      Motions: {
        Idle: [{ File: 'motions/Hiyori_m01.motion3.json' }],
      },
    },
  }))
  const mocBytes = Buffer.from([0x4d, 0x4f, 0x43, 0x33])
  const textureBytes = Buffer.from([137, 80, 78, 71])
  const motionBytes = Buffer.from('{"Version":3}')
  const expressionBytes = Buffer.from('{"FadeInTime":0.2,"Parameters":[]}')
  await writeFile(join(assetRoot, 'Hiyori.model3.json'), modelBytes)
  await writeFile(join(assetRoot, 'Hiyori.moc3'), mocBytes)
  await writeFile(join(assetRoot, 'Hiyori.2048', 'texture_00.png'), textureBytes)
  await writeFile(join(assetRoot, 'motions', 'Hiyori_m01.motion3.json'), motionBytes)
  await writeFile(join(assetRoot, 'expressions', 'smile.exp3.json'), expressionBytes)
  await writeFile(join(assetRoot, 'source.blend'), 'private source')

  const server = createCompanionServer({
    port: 0,
    helloTimeoutMs: 500,
    createAssetToken: () => '0123456789abcdef0123456789abcdef',
    model: {
      id: 'hiyori-debug',
      displayName: 'Hiyori debug',
      format: 'live2d',
      entryFilePath: join(assetRoot, 'Hiyori.model3.json'),
    },
  })
  const address = await server.start()
  t.after(() => server.stop())

  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`, {
    origin: 'http://127.0.0.1:4173',
  })
  t.after(() => socket.close())
  await once(socket, 'open')
  const messages = new Promise<[Buffer, Buffer, Buffer]>((resolveMessages) => {
    const received: Buffer[] = []
    socket.on('message', (data) => {
      received.push(Buffer.from(data as ArrayBuffer))
      if (received.length === 3) resolveMessages([received[0]!, received[1]!, received[2]!])
    })
  })
  socket.send(JSON.stringify(createClientHello({ id: 'hello-live2d-assets', build: 'test' })))

  const [, modelData, catalogData] = await messages
  const modelMessage = parseServerMessage(modelData.toString())
  assert.equal(modelMessage.type, 'model.available')
  if (modelMessage.type !== 'model.available') assert.fail('expected model.available')
  assert.equal(modelMessage.payload.model.format, 'live2d')
  assert.equal(modelMessage.payload.model.url.includes(assetRoot), false)
  assert.ok(modelMessage.payload.model.nativeUrl)
  assert.equal(modelMessage.payload.model.nativeUrl?.includes(assetRoot), false)

  const catalogMessage = parseServerMessage(catalogData.toString())
  assert.equal(catalogMessage.type, 'motion.catalog')
  if (catalogMessage.type !== 'motion.catalog') assert.fail('expected motion.catalog')
  assert.deepEqual(catalogMessage.payload.motions, [{
    id: 'live2d-Idle-0',
    displayName: 'Idle 1',
    format: 'live2d',
    url: new URL('motions/Hiyori_m01.motion3.json', modelMessage.payload.model.url).toString(),
    group: 'Idle',
    index: 0,
  }])

  const modelResponse = await fetch(modelMessage.payload.model.url, { headers: { Origin: 'null' } })
  assert.equal(modelResponse.status, 200)
  const skinManifest = await modelResponse.json() as {
    FileReferences?: { Motions?: unknown, Expressions?: unknown }
  }
  assert.equal(skinManifest.FileReferences?.Motions, undefined)
  assert.deepEqual(skinManifest.FileReferences?.Expressions, [
    { Name: 'Smile', File: 'expressions/smile.exp3.json' },
  ])
  assert.equal(modelResponse.headers.get('content-type'), 'application/json')

  const nativeUrl = modelMessage.payload.model.nativeUrl
  assert.ok(nativeUrl)
  const nativeResponse = await fetch(nativeUrl, { headers: { Origin: 'null' } })
  assert.equal(nativeResponse.status, 200)
  assert.deepEqual(await nativeResponse.json(), JSON.parse(modelBytes.toString('utf8')))

  const mocResponse = await fetch(new URL('Hiyori.moc3', modelMessage.payload.model.url), {
    headers: { Origin: 'null' },
  })
  assert.equal(mocResponse.status, 200)
  assert.deepEqual(Buffer.from(await mocResponse.arrayBuffer()), mocBytes)

  const textureResponse = await fetch(new URL('Hiyori.2048/texture_00.png', modelMessage.payload.model.url), {
    method: 'HEAD',
    headers: { Origin: 'null' },
  })
  assert.equal(textureResponse.status, 200)
  assert.equal(textureResponse.headers.get('content-length'), String(textureBytes.byteLength))

  const motionResponse = await fetch(catalogMessage.payload.motions[0]!.url, {
    headers: { Origin: 'null' },
  })
  assert.equal(motionResponse.status, 200)
  assert.deepEqual(Buffer.from(await motionResponse.arrayBuffer()), motionBytes)

  const expressionResponse = await fetch(new URL('expressions/smile.exp3.json', modelMessage.payload.model.url), {
    headers: { Origin: 'null' },
  })
  assert.equal(expressionResponse.status, 200)
  assert.deepEqual(Buffer.from(await expressionResponse.arrayBuffer()), expressionBytes)

  assert.equal((await fetch(new URL('source.blend', modelMessage.payload.model.url), {
    headers: { Origin: 'null' },
  })).status, 403)
})

test('websocket upgrades reject non-loopback browser origins', async (t) => {
  const server = createCompanionServer({ port: 0, helloTimeoutMs: 500 })
  const address = await server.start()
  t.after(() => server.stop())

  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`, {
    origin: 'https://hostile.example',
  })
  socket.on('error', () => undefined)
  const [, response] = await once(socket, 'unexpected-response')
  assert.equal(response.statusCode, 403)
  socket.terminate()
})

test('session construction failures close one client without crashing the server', async (t) => {
  const server = createCompanionServer({
    port: 0,
    helloTimeoutMs: 500,
    createId: () => 'invalid id',
  })
  const address = await server.start()
  t.after(() => server.stop())

  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`)
  await once(socket, 'open')
  socket.send(JSON.stringify(createClientHello({ id: 'hello-failure', build: 'test' })))
  const [code] = await once(socket, 'close')
  assert.equal(code, 1011)
  assert.equal(server.snapshot().phase, 'running')
  assert.equal(server.snapshot().connectedClients, 0)
})

test('authorized clients receive motion catalog with tokenized URLs', async (t) => {
  const assetRoot = await mkdtemp(join(tmpdir(), 'rayure-motion-assets-'))
  t.after(() => rm(assetRoot, { recursive: true, force: true }))
  const motionFile = join(assetRoot, 'wave.vmd')
  const vmdBytes = Buffer.from('vmd-test-content')
  await writeFile(motionFile, vmdBytes)

  const server = createCompanionServer({
    port: 0,
    helloTimeoutMs: 1000,
    motions: [
      {
        id: 'wave',
        displayName: 'Wave',
        format: 'vmd',
        entryFilePath: motionFile,
        loop: false,
      },
    ],
  })
  const address = await server.start()
  t.after(() => server.stop())

  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`)
  await once(socket, 'open')

  const messages = new Promise<Buffer[]>((resolveMessages) => {
    const received: Buffer[] = []
    socket.on('message', (data) => {
      received.push(Buffer.from(data as ArrayBuffer))
      if (received.length === 2) resolveMessages(received)
    })
  })
  socket.send(JSON.stringify(createClientHello({ id: 'hello-motion', build: 'test' })))

  const [, catalogData] = await messages
  const catalogMessage = parseServerMessage(catalogData!.toString())
  assert.equal(catalogMessage.type, 'motion.catalog')
  if (catalogMessage.type !== 'motion.catalog') assert.fail('expected motion.catalog')
  assert.equal(catalogMessage.payload.motions.length, 1)
  assert.equal(catalogMessage.payload.motions[0]?.id, 'wave')

  const response = await fetch(catalogMessage.payload.motions[0]!.url, { headers: { Origin: 'null' } })
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), vmdBytes)
})

function makeGeneratedMotion() {
  const joints = Object.fromEntries(ARDY_CORE_JOINT_NAMES.map((name, index) => [name, {
    position: [index / 10, 1, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
  }]))
  return convertArdyMotion({
    schema: 'rayure.ardy-motion.v1',
    backend: 'ardy-core',
    fps: 20,
    jointNames: [...ARDY_CORE_JOINT_NAMES],
    frames: [
      {
        timeMs: 0,
        rootPosition: [0, 0, 0],
        rootRotation: [0, 0, 0, 1],
        joints,
      },
      {
        timeMs: 50,
        rootPosition: [0, 0, 0],
        rootRotation: [0, 0, 0, 1],
        joints,
      },
    ],
  })
}

test('publishMotion announces the descriptor and serves the generated frame memory resource', async (t) => {
  const server = createCompanionServer({ port: 0, helloTimeoutMs: 1000 })
  const address = await server.start()
  t.after(() => server.stop())

  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`)
  t.after(() => socket.close())
  await once(socket, 'open')
  socket.send(JSON.stringify(createClientHello({ id: 'hello-publish', build: 'test' })))
  await once(socket, 'message') // welcome

  const published = server.publishMotion({
    id: 'generated-wave',
    displayName: 'Generated Wave',
    motion: makeGeneratedMotion(),
  })
  assert.equal(published.id, 'generated-wave-1')
  assert.equal(published.format, 'canonical')

  const [publishedData] = await once(socket, 'message')
  const publishedMessage = parseServerMessage(publishedData!.toString())
  assert.equal(publishedMessage.type, 'motion.published')
  if (publishedMessage.type !== 'motion.published') assert.fail('expected motion.published')
  assert.equal(publishedMessage.payload.motion.url, published.url)

  const response = await fetch(published.url, { headers: { Origin: 'null' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json')
  const body = await response.json()
  assert.deepEqual(body, makeGeneratedMotion())

  // Unknown token and mismatched file name remain forbidden.
  assert.equal((await fetch(published.url.replace('/assets/', '/assets/wrong-token/'), {
    headers: { Origin: 'null' },
  })).status, 404)
  const wrongPath = new URL('other.json', published.url)
  assert.equal((await fetch(wrongPath, { headers: { Origin: 'null' } })).status, 404)
})

test('a renderer joining after startup receives the latest generated motion', async (t) => {
  const server = createCompanionServer({ port: 0, helloTimeoutMs: 1000 })
  const address = await server.start()
  t.after(() => server.stop())
  const published = server.publishMotion({
    id: 'startup-idle',
    displayName: 'Startup Idle',
    motion: makeGeneratedMotion(),
  })

  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`)
  t.after(() => socket.close())
  await once(socket, 'open')
  const received: string[] = []
  const messages = new Promise<void>(resolve => {
    socket.on('message', data => {
      received.push(data.toString())
      if (received.length === 2) resolve()
    })
  })
  socket.send(JSON.stringify(createClientHello({ id: 'hello-late', build: 'test' })))
  await messages
  assert.equal(parseServerMessage(received[0]!).type, 'server.welcome')
  const replay = parseServerMessage(received[1]!)
  assert.equal(replay.type, 'motion.published')
  if (replay.type !== 'motion.published') assert.fail('expected replayed motion.published')
  assert.equal(replay.payload.motion.url, published.url)
})

test('publishMotion requires a running server and rejects invalid motion ids', async (t) => {
  const server = createCompanionServer({ port: 0 })
  assert.throws(() => server.publishMotion({
    id: 'generated-wave',
    displayName: 'Bad',
    motion: makeGeneratedMotion(),
  }), /running/i)

  await server.start()
  t.after(() => server.stop())
  assert.throws(() => server.publishMotion({
    id: 'bad id!',
    displayName: 'Bad',
    motion: makeGeneratedMotion(),
  }), /identifier/i)
})

test('publishSpeech announces tokenized audio and mouth cues', async (t) => {
  const server = createCompanionServer({ port: 0, helloTimeoutMs: 1000 })
  const address = await server.start()
  t.after(() => server.stop())

  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws`)
  t.after(() => socket.close())
  await once(socket, 'open')
  socket.send(JSON.stringify(createClientHello({ id: 'hello-speech', build: 'test' })))
  await once(socket, 'message')

  const published = server.publishSpeech({
    id: 'reply',
    displayName: 'Hello',
    mimeType: 'audio/wav',
    audio: new Uint8Array([82, 73, 70, 70]),
    durationMs: 400,
    cues: [{ timeMs: 0, value: 0.2 }, { timeMs: 200, value: 0.8 }],
  })
  assert.equal(published.id, 'reply-1')
  const [data] = await once(socket, 'message')
  const message = parseServerMessage(data!.toString())
  assert.equal(message.type, 'speech.published')
  if (message.type !== 'speech.published') assert.fail('expected speech.published')
  assert.equal(message.payload.speech.audioUrl, published.audioUrl)

  const audio = await fetch(published.audioUrl, { headers: { Origin: 'null' } })
  assert.equal(audio.status, 200)
  assert.equal(audio.headers.get('content-type'), 'audio/wav')
  assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [82, 73, 70, 70])
  const cues = await fetch(published.cuesUrl, { headers: { Origin: 'null' } })
  assert.equal(cues.status, 200)
  assert.deepEqual(await cues.json(), {
    version: 'rayure.mouth-cues.v1',
    durationMs: 400,
    cues: [{ timeMs: 0, value: 0.2 }, { timeMs: 200, value: 0.8 }],
  })
})
