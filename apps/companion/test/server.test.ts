import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import WebSocket from 'ws'

import { PROTOCOL_VERSION, createClientHello, parseServerMessage } from '@rayure/protocol'
import { createCompanionServer } from '../src/server.ts'

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
  const modelBytes = Buffer.from('{"Version":3}')
  const mocBytes = Buffer.from([0x4d, 0x4f, 0x43, 0x33])
  const textureBytes = Buffer.from([137, 80, 78, 71])
  const motionBytes = Buffer.from('{"Version":3}')
  await writeFile(join(assetRoot, 'Hiyori.model3.json'), modelBytes)
  await writeFile(join(assetRoot, 'Hiyori.moc3'), mocBytes)
  await writeFile(join(assetRoot, 'Hiyori.2048', 'texture_00.png'), textureBytes)
  await writeFile(join(assetRoot, 'motions', 'Hiyori_m01.motion3.json'), motionBytes)
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
  const messages = new Promise<[Buffer, Buffer]>((resolveMessages) => {
    const received: Buffer[] = []
    socket.on('message', (data) => {
      received.push(Buffer.from(data as ArrayBuffer))
      if (received.length === 2) resolveMessages([received[0]!, received[1]!])
    })
  })
  socket.send(JSON.stringify(createClientHello({ id: 'hello-live2d-assets', build: 'test' })))

  const [, modelData] = await messages
  const modelMessage = parseServerMessage(modelData.toString())
  assert.equal(modelMessage.type, 'model.available')
  if (modelMessage.type !== 'model.available') assert.fail('expected model.available')
  assert.equal(modelMessage.payload.model.format, 'live2d')
  assert.equal(modelMessage.payload.model.url.includes(assetRoot), false)

  const modelResponse = await fetch(modelMessage.payload.model.url, { headers: { Origin: 'null' } })
  assert.equal(modelResponse.status, 200)
  assert.deepEqual(Buffer.from(await modelResponse.arrayBuffer()), modelBytes)
  assert.equal(modelResponse.headers.get('content-type'), 'application/json')

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

  const motionResponse = await fetch(new URL('motions/Hiyori_m01.motion3.json', modelMessage.payload.model.url), {
    headers: { Origin: 'null' },
  })
  assert.equal(motionResponse.status, 200)
  assert.deepEqual(Buffer.from(await motionResponse.arrayBuffer()), motionBytes)

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
