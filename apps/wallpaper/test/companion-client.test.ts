import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createServerSpeechPublished,
  createServerWelcome,
  parseClientMessage,
  serializeWireMessage,
} from '@rayure/protocol'
import { CompanionClient } from '../src/companion-client.ts'

class FakeSocket {
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  readyState = FakeSocket.CONNECTING
  readonly sent: string[] = []
  readonly #listeners = new Map<string, Array<(event: { data?: unknown }) => void>>()

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.#listeners.get(type) ?? []
    listeners.push(listener)
    this.#listeners.set(type, listeners)
  }

  send(data: string): void { this.sent.push(data) }
  close(): void { this.readyState = 3 }
  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }
}

test('CompanionClient receives speech.published and reports playback telemetry', () => {
  const socket = new FakeSocket()
  let received = ''
  const client = new CompanionClient({
    port: 32145,
    build: 'test',
    webSocketFactory: () => socket as unknown as WebSocket,
    createId: (() => {
      let count = 0
      return () => `id-${++count}`
    })(),
    onSpeechPublished: speech => { received = speech.id },
  })
  client.start()
  socket.readyState = FakeSocket.OPEN
  socket.emit('open')
  const hello = parseClientMessage(socket.sent[0] ?? '')
  assert.equal(hello.type, 'client.hello')
  socket.emit('message', { data: serializeWireMessage(createServerWelcome({ id: 'welcome', replyTo: hello.id, connectionId: 'conn', serverTimeMs: Date.now() })) })
  const published = createServerSpeechPublished({
    id: 'speech-message',
    speech: {
      id: 'reply-1',
      displayName: 'Hello',
      audioUrl: 'http://127.0.0.1:32145/assets/0123456789abcdef/reply.wav',
      cuesUrl: 'http://127.0.0.1:32145/assets/0123456789abcdef/reply.cues.json',
      mimeType: 'audio/wav',
      durationMs: 400,
    },
  })
  socket.emit('message', { data: serializeWireMessage(published) })
  assert.equal(received, 'reply-1')
  assert.equal(client.reportSpeechPlayback({ speechId: 'reply-1', phase: 'progress', timeMs: 120 }), true)
  const telemetry = parseClientMessage(socket.sent.at(-1) ?? '')
  assert.equal(telemetry.type, 'speech.playback')
  if (telemetry.type === 'speech.playback') assert.equal(telemetry.payload.timeMs, 120)
  client.stop()
})
