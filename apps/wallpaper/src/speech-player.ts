import type { MouthCue, MouthCueTrack, SpeechDescriptor } from '@rayure/protocol'
import { MOUTH_CUES_VERSION } from '@rayure/protocol'

export interface SpeechAudioLike {
  currentTime: number
  onended: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  play(): Promise<void> | void
  pause(): void
}

export interface SpeechPlayerOptions {
  descriptor: SpeechDescriptor
  fetchCues?: (url: string) => Promise<unknown>
  audioFactory?: (url: string, mimeType: string) => SpeechAudioLike
  onMouthValue?: (value: number) => void
  onPlayback?: (report: {
    speechId: string
    phase: 'started' | 'progress' | 'completed' | 'cancelled'
    timeMs: number
  }) => void
  tickMs?: number
}

/** Renderer-only audio playback with strict cue validation and mouth output. */
export class SpeechPlayer {
  readonly #descriptor: SpeechDescriptor
  readonly #fetchCues: (url: string) => Promise<unknown>
  readonly #audioFactory: (url: string, mimeType: string) => SpeechAudioLike
  readonly #onMouthValue: ((value: number) => void) | undefined
  readonly #onPlayback: SpeechPlayerOptions['onPlayback']
  readonly #tickMs: number
  #audio: SpeechAudioLike | undefined
  #cues: readonly MouthCue[] = []
  #timer: ReturnType<typeof setInterval> | undefined
  #started = false
  #disposed = false

  constructor(options: SpeechPlayerOptions) {
    this.#descriptor = options.descriptor
    this.#fetchCues = options.fetchCues ?? (async url => {
      const response = await fetch(url, { cache: 'no-store', credentials: 'omit' })
      if (!response.ok) throw new Error(`Mouth cue request failed with HTTP ${response.status}`)
      return response.json()
    })
    this.#audioFactory = options.audioFactory ?? ((url, mimeType) => {
      const audio = new Audio()
      audio.src = url
      audio.preload = 'auto'
      audio.setAttribute('type', mimeType)
      return audio
    })
    this.#onMouthValue = options.onMouthValue
    this.#onPlayback = options.onPlayback
    this.#tickMs = requireTickMs(options.tickMs ?? 40)
  }

  get isPlaying(): boolean {
    return this.#started && !this.#disposed
  }

  async start(): Promise<boolean> {
    if (this.#disposed || this.#started) return false
    try {
      this.#cues = parseMouthCueTrack(await this.#fetchCues(this.#descriptor.cuesUrl)).cues
      const audio = this.#audioFactory(this.#descriptor.audioUrl, this.#descriptor.mimeType)
      this.#audio = audio
      audio.onended = () => this.#complete()
      audio.onerror = () => this.stop()
      this.#started = true
      this.#emitPlayback('started', 0)
      this.#tick()
      this.#timer = setInterval(() => this.#tick(), this.#tickMs)
      await audio.play()
      return true
    }
    catch {
      this.stop()
      return false
    }
  }

  stop(): void {
    if (!this.#started) return
    const audio = this.#audio
    this.#started = false
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    try { audio?.pause() } catch { /* ignore audio teardown failures */ }
    this.#onMouthValue?.(0)
    this.#emitPlayback('cancelled', this.currentTimeMs)
  }

  dispose(): void {
    if (this.#disposed) return
    this.stop()
    this.#disposed = true
    const audio = this.#audio
    if (audio) {
      audio.onended = null
      audio.onerror = null
    }
    this.#audio = undefined
    this.#cues = []
  }

  get currentTimeMs(): number {
    const current = this.#audio?.currentTime ?? 0
    return clamp(Math.round((Number.isFinite(current) ? current : 0) * 1000), 0, this.#descriptor.durationMs)
  }

  #tick(): void {
    if (!this.#started || this.#disposed) return
    const timeMs = this.currentTimeMs
    this.#onMouthValue?.(mouthValueAt(this.#cues, timeMs))
    this.#emitPlayback('progress', timeMs)
  }

  #complete(): void {
    if (!this.#started) return
    this.#started = false
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    this.#onMouthValue?.(0)
    this.#emitPlayback('completed', this.#descriptor.durationMs)
  }

  #emitPlayback(phase: 'started' | 'progress' | 'completed' | 'cancelled', timeMs: number): void {
    try {
      this.#onPlayback?.({ speechId: this.#descriptor.id, phase, timeMs: clamp(timeMs, 0, this.#descriptor.durationMs) })
    }
    catch {
      // Telemetry is best-effort and cannot own audio lifecycle.
    }
  }
}

export function parseMouthCueTrack(value: unknown): MouthCueTrack {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Mouth cue track must be an object')
  const root = value as Record<string, unknown>
  const expected = ['version', 'durationMs', 'cues']
  if (Object.keys(root).sort().join('|') !== expected.slice().sort().join('|')) throw new Error('Mouth cue track contains missing or unknown fields')
  if (root.version !== MOUTH_CUES_VERSION || !Number.isSafeInteger(root.durationMs) || (root.durationMs as number) < 1 || (root.durationMs as number) > 600_000 || !Array.isArray(root.cues) || root.cues.length > 2048) throw new Error('Mouth cue track metadata is invalid')
  const durationMs = root.durationMs as number
  let previous = -1
  const cues: MouthCue[] = []
  for (const cue of root.cues) {
    if (!cue || typeof cue !== 'object' || Array.isArray(cue)) throw new Error('Mouth cue is invalid')
    const item = cue as Record<string, unknown>
    if (Object.keys(item).sort().join('|') !== 'timeMs|value' || !Number.isSafeInteger(item.timeMs) || (item.timeMs as number) < 0 || (item.timeMs as number) > durationMs || (item.timeMs as number) < previous || typeof item.value !== 'number' || !Number.isFinite(item.value) || (item.value as number) < 0 || (item.value as number) > 1) throw new Error('Mouth cue is out of range')
    cues.push({ timeMs: item.timeMs as number, value: item.value as number })
    previous = item.timeMs as number
  }
  return { version: MOUTH_CUES_VERSION, durationMs, cues }
}

function mouthValueAt(cues: readonly MouthCue[], timeMs: number): number {
  let value = 0
  for (const cue of cues) {
    if (cue.timeMs > timeMs) break
    value = cue.value
  }
  return value
}

function requireTickMs(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 16 || (value as number) > 250) throw new Error('Speech player tickMs must be an integer from 16 through 250')
  return value as number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
