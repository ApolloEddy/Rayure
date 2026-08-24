import assert from 'node:assert/strict'
import test from 'node:test'

import type { SpeechDescriptor } from '@rayure/protocol'
import { SpeechPlayer, parseMouthCueTrack } from '../src/speech-player.ts'

const descriptor: SpeechDescriptor = {
  id: 'reply-1',
  displayName: 'Hello',
  audioUrl: 'http://127.0.0.1:32145/assets/0123456789abcdef/reply-1.wav',
  cuesUrl: 'http://127.0.0.1:32145/assets/0123456789abcdef/reply-1.cues.json',
  mimeType: 'audio/wav',
  durationMs: 400,
}

test('speech player validates cues, drives mouth values and reports completion', async () => {
  const audio = {
    currentTime: 0,
    onended: null as ((event: Event) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    play: async () => undefined,
    pause: () => undefined,
  }
  const mouths: number[] = []
  const reports: string[] = []
  const player = new SpeechPlayer({
    descriptor,
    fetchCues: async () => ({ version: 'rayure.mouth-cues.v1', durationMs: 400, cues: [{ timeMs: 0, value: 0.1 }, { timeMs: 200, value: 0.9 }] }),
    audioFactory: () => audio,
    onMouthValue: value => mouths.push(value),
    onPlayback: report => reports.push(`${report.phase}:${report.timeMs}`),
    tickMs: 20,
  })
  const start = player.start()
  assert.equal(await start, true)
  audio.currentTime = 0.25
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(mouths.at(-1), 0.9)
  audio.currentTime = 0.4
  audio.onended?.(new Event('ended'))
  assert.equal(player.isPlaying, false)
  assert.ok(reports.some(report => report.startsWith('completed:400')))
  player.dispose()
})

test('mouth cue parser rejects non-monotonic or unknown fields', () => {
  assert.deepEqual(parseMouthCueTrack({
    version: 'rayure.mouth-cues.v1',
    durationMs: 100,
    cues: [{ timeMs: 0, value: 0 }, { timeMs: 100, value: 1 }],
  }).cues.length, 2)
  assert.throws(() => parseMouthCueTrack({
    version: 'rayure.mouth-cues.v1',
    durationMs: 100,
    cues: [{ timeMs: 80, value: 0 }, { timeMs: 20, value: 1 }],
  }), /monotonic|range/i)
  assert.throws(() => parseMouthCueTrack({
    version: 'rayure.mouth-cues.v1',
    durationMs: 100,
    cues: [],
    extra: true,
  }), /unknown/i)
})
