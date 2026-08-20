import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_WIRE_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  createClientHello,
  createServerModelAvailable,
  createServerWelcome,
  parseClientMessage,
  parseServerMessage,
} from '../src/index.ts'

test('client hello round-trips through the strict wire parser', () => {
  const hello = createClientHello({ id: 'hello-1', build: '0.1.0-dev' })
  assert.deepEqual(parseClientMessage(JSON.stringify(hello)), hello)
  assert.equal(hello.protocolVersion, PROTOCOL_VERSION)
})

test('server welcome must correlate to a valid client hello', () => {
  const welcome = createServerWelcome({
    id: 'welcome-1',
    replyTo: 'hello-1',
    connectionId: 'connection-1',
    serverTimeMs: 1_765_000_000_000,
  })
  assert.deepEqual(parseServerMessage(JSON.stringify(welcome)), welcome)
})

test('model availability accepts only a loopback HTTP asset URL', () => {
  const available = createServerModelAvailable({
    id: 'model-message-1',
    model: {
      id: 'local-test-model',
      displayName: 'Local test model',
      format: 'pmx',
      url: 'http://127.0.0.1:32145/assets/0123456789abcdef/model.pmx',
    },
  })
  assert.deepEqual(parseServerMessage(JSON.stringify(available)), available)

  for (const url of [
    'https://example.com/model.pmx',
    'file:///D:/private/model.pmx',
    'http://localhost:32145/model.pmx',
    'http://127.0.0.1:32145/model.pmx?token=secret',
  ]) {
    assert.throws(() => createServerModelAvailable({
      id: 'model-message-2',
      model: { id: 'local-test-model', displayName: 'Local test model', format: 'pmx', url },
    }), ProtocolValidationError, url)
  }
})

test('model availability supports a tokenized Live2D model3 entry', () => {
  const available = createServerModelAvailable({
    id: 'live2d-message-1',
    model: {
      id: 'hiyori-debug',
      displayName: 'Hiyori debug',
      format: 'live2d',
      url: 'http://127.0.0.1:32145/assets/0123456789abcdef/Hiyori.model3.json',
    },
  })
  const parsed = parseServerMessage(JSON.stringify(available))
  assert.deepEqual(parsed, available)
  if (parsed.type !== 'model.available') assert.fail('expected model.available')
  assert.equal(parsed.payload.model.format, 'live2d')
})

test('model availability rejects unsupported model formats', () => {
  assert.throws(() => createServerModelAvailable({
    id: 'model-message-3',
    model: {
      id: 'bad-model',
      displayName: 'Bad model',
      format: 'vrm' as never,
      url: 'http://127.0.0.1:32145/assets/0123456789abcdef/model.vrm',
    },
  }), ProtocolValidationError)
})

test('wire parser rejects non-objects, unknown fields and unsupported messages', () => {
  const invalidPayloads = [
    '',
    'null',
    '[]',
    '{}',
    JSON.stringify({ protocolVersion: 2, type: 'client.hello', id: 'x', payload: { client: 'wallpaper', build: 'dev' } }),
    JSON.stringify({ protocolVersion: 1, type: 'client.hello', id: 'x', payload: { client: 'wallpaper', build: 'dev' }, extra: true }),
    JSON.stringify({ protocolVersion: 1, type: 'client.hello', id: ' ', payload: { client: 'wallpaper', build: 'dev' } }),
    JSON.stringify({ protocolVersion: 1, type: 'client.hello', id: 'x', payload: { client: 'wallpaper', build: '' } }),
    JSON.stringify({ protocolVersion: 1, type: 'client.ping', id: 'x', payload: {} }),
  ]

  for (const payload of invalidPayloads) {
    assert.throws(() => parseClientMessage(payload), ProtocolValidationError, payload)
  }
})

test('wire parser measures UTF-8 bytes and rejects oversized messages', () => {
  const oversized = '界'.repeat(Math.ceil(MAX_WIRE_MESSAGE_BYTES / 3) + 1)
  assert.throws(() => parseClientMessage(oversized), /maximum wire size/i)
})

test('factories reject control characters and oversized identifiers', () => {
  assert.throws(() => createClientHello({ id: 'hello\n1', build: 'dev' }), /id/i)
  assert.throws(() => createClientHello({ id: 'x'.repeat(65), build: 'dev' }), /id/i)
  assert.throws(() => createClientHello({ id: 'hello-1', build: ' dev ' }), /build/i)
})

test('motion messages round-trip through parser and enforce safety constraints', () => {
  const play = parseServerMessage(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: 'motion.play',
    id: 'motion-play-1',
    payload: {
      motion: {
        id: 'idle-loop',
        displayName: 'Idle Loop',
        format: 'vmd',
        url: 'http://127.0.0.1:32145/assets/0123456789abcdef/idle.vmd',
        loop: true,
      },
    },
  }))
  assert.equal(play.type, 'motion.play')

  const stop = parseServerMessage(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: 'motion.stop',
    id: 'motion-stop-1',
    payload: {
      motionId: 'idle-loop',
    },
  }))
  assert.equal(stop.type, 'motion.stop')

  // Reject invalid format or unsafe URLs
  assert.throws(() => parseServerMessage(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: 'motion.play',
    id: 'motion-play-2',
    payload: {
      motion: {
        id: 'bad-motion',
        displayName: 'Bad',
        format: 'vmd',
        url: 'https://evil.com/motion.vmd',
      },
    },
  })), ProtocolValidationError)
})

test('expression messages round-trip through parser and validate weight bounds', () => {
  const setExpr = parseServerMessage(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: 'expression.set',
    id: 'expr-1',
    payload: {
      name: 'smile',
      weight: 0.8,
      durationMs: 300,
    },
  }))
  assert.equal(setExpr.type, 'expression.set')

  const resetExpr = parseServerMessage(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: 'expression.reset',
    id: 'expr-reset-1',
    payload: {
      durationMs: 200,
    },
  }))
  assert.equal(resetExpr.type, 'expression.reset')

  // Out of bound weight (< 0 or > 1)
  assert.throws(() => parseServerMessage(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: 'expression.set',
    id: 'expr-bad',
    payload: {
      name: 'smile',
      weight: 1.5,
    },
  })), ProtocolValidationError)
})

test('motion catalog and emote play messages round-trip through parser', () => {
  const catalog = parseServerMessage(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: 'motion.catalog',
    id: 'catalog-1',
    payload: {
      motions: [
        {
          id: 'wave',
          displayName: 'Wave',
          format: 'vmd',
          url: 'http://127.0.0.1:32145/assets/0123456789abcdef/wave.vmd',
        },
        {
          id: 'idle',
          displayName: 'Idle',
          format: 'vmd',
          url: 'http://127.0.0.1:32145/assets/0123456789abcdef/idle.vmd',
          loop: true,
        },
      ],
    },
  }))
  assert.equal(catalog.type, 'motion.catalog')

  const emote = parseServerMessage(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: 'emote.play',
    id: 'emote-1',
    payload: {
      emoteId: 'greet',
      motionId: 'wave',
      expressionName: 'smile',
      expressionWeight: 1.0,
      durationMs: 200,
    },
  }))
  assert.equal(emote.type, 'emote.play')
})

