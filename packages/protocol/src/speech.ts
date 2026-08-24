/**
 * Transport types for generated speech. Audio and cue bytes stay behind the
 * Companion loopback asset gateway; only this small descriptor crosses the
 * websocket.
 */
export const speechPlaybackPhases = [
  'started',
  'progress',
  'completed',
  'cancelled',
] as const
export type SpeechPlaybackPhase = typeof speechPlaybackPhases[number]

export const speechAudioMimeTypes = [
  'audio/wav',
  'audio/ogg',
  'audio/webm',
] as const
export type SpeechAudioMimeType = typeof speechAudioMimeTypes[number]

export interface MouthCue {
  timeMs: number
  value: number
}

export const MOUTH_CUES_VERSION = 'rayure.mouth-cues.v1' as const

export interface MouthCueTrack {
  version: typeof MOUTH_CUES_VERSION
  durationMs: number
  cues: readonly MouthCue[]
}

export interface SpeechDescriptor {
  id: string
  displayName: string
  audioUrl: string
  cuesUrl: string
  mimeType: SpeechAudioMimeType
  durationMs: number
}
