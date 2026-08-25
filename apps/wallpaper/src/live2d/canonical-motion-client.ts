import { validateCanonicalMotion } from '@rayure/protocol'
import type { CanonicalMotion, MotionDescriptor } from '@rayure/protocol'

import { Live2dMotionPlayer } from './motion-player.ts'
import type { Live2dNeutralPose, Live2dParameterSink, Live2dRigProfile } from './rig-profile.ts'

const MAX_GENERATED_MOTION_BYTES = 256 * 1024 * 1024

export interface LoadCanonicalMotionOptions {
  fetchImplementation?: typeof fetch
}

/**
 * Fetches a tokenized Canonical Motion and validates it against the strict
 * wire contract. It never trusts the local asset origin: only valid loopback
 * URLs validated upstream reach this point, and the parsed body must satisfy
 * the full `rayure.motion.v1` schema before it can drive a player.
 */
export async function loadCanonicalMotion(
  url: string,
  options: LoadCanonicalMotionOptions = {},
): Promise<CanonicalMotion> {
  requireLoopbackAssetUrl(url)
  const fetcher = options.fetchImplementation ?? fetch
  let response: Response
  try {
    response = await fetcher(url, {
      cache: 'no-store',
      credentials: 'omit',
    })
  }
  catch (cause) {
    throw new Error(`Canonical Motion request failed: ${toErrorMessage(cause)}`)
  }
  if (!response.ok) throw new Error(`Canonical Motion request failed with HTTP ${response.status}`)
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_GENERATED_MOTION_BYTES) {
    throw new Error('Canonical Motion exceeds the size bound')
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  }
  catch {
    throw new Error('Canonical Motion body must contain valid JSON')
  }
  validateCanonicalMotion(parsed)
  return parsed
}

function requireLoopbackAssetUrl(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error('Canonical Motion URL is invalid')
  }
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw new Error('Canonical Motion URL must be valid')
  }
  if (
    url.protocol !== 'http:'
    || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    || url.port.length === 0
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
    || !/^\/assets\/[A-Za-z0-9_-]{16,128}\/.+/u.test(url.pathname)
  ) {
    throw new Error('Canonical Motion URL must use the tokenized loopback asset endpoint')
  }
}

/**
 * Drives a generated Canonical Motion onto a parameter sink with deterministic
 * interruption, exactly like the native motion controller but for runtime
 * generated frames instead of prebuilt `.motion3.json` assets.
 */
export class CanonicalMotionPlayer {
  readonly #player: Live2dMotionPlayer
  #activeDescriptor: MotionDescriptor | undefined
  #generation = 0
  #disposed = false

  constructor(sink: Live2dParameterSink, profile?: Live2dRigProfile, neutralPose?: Live2dNeutralPose) {
    this.#player = new Live2dMotionPlayer(sink, profile, neutralPose)
  }

  get isPlaying(): boolean {
    return !this.#disposed && this.#activeDescriptor !== undefined
  }

  get activeDescriptor(): MotionDescriptor | undefined {
    return this.#activeDescriptor
  }

  /** Number of source frames that have actually been driven onto the sink. */
  get consumedFrameCount(): number {
    return this.#player.consumedFrameCount
  }

  bind(motion: CanonicalMotion, descriptor: MotionDescriptor): void {
    if (this.#disposed) return
    validateCanonicalMotion(motion)
    this.#generation += 1
    this.#activeDescriptor = descriptor
    this.#player.bind(motion)
  }

  stop(): void {
    if (this.#disposed) return
    this.#generation += 1
    this.#activeDescriptor = undefined
    this.#player.stop()
  }

  advance(deltaSeconds: number): boolean {
    if (this.#disposed || this.#activeDescriptor === undefined) return false
    const applied = this.#player.advance(deltaSeconds)
    if (!this.#player.isPlaying) this.#activeDescriptor = undefined
    return applied
  }

  /**
   * Interrupts any current generated motion and drives the fetched frames to
   * the sink in the active slot. Binding is synchronous so the call site can
   * immediately observe `activeDescriptor`; frame delivery proceeds in the
   * render loop via {@link advance}.
   */
  play(motion: CanonicalMotion, descriptor: MotionDescriptor): boolean {
    if (this.#disposed) return false
    validateCanonicalMotion(motion)
    const generation = ++this.#generation
    this.#activeDescriptor = descriptor
    this.#player.bind(motion)
    return generation === this.#generation
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#generation += 1
    this.#activeDescriptor = undefined
    this.#player.dispose()
  }
}

function toErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
