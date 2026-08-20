import { validateCanonicalMotion } from '@rayure/protocol'
import type { CanonicalMotion, CanonicalMotionFrame } from '@rayure/protocol'

import {
  Live2dParameterAdapter,
} from './rig-profile.ts'
import type {
  Live2dParameterSink,
  Live2dRigProfile,
} from './rig-profile.ts'

export class Live2dMotionPlayer {
  readonly #adapter: Live2dParameterAdapter
  readonly #sink: Live2dParameterSink
  #motion: CanonicalMotion | undefined
  #frameIndex = 0
  #elapsedMs = 0
  #disposed = false

  constructor(sink: Live2dParameterSink, profile?: Live2dRigProfile) {
    this.#sink = sink
    this.#adapter = new Live2dParameterAdapter(profile)
  }

  get isPlaying(): boolean {
    return !this.#disposed && this.#motion !== undefined && this.#frameIndex < this.#motion.frames.length
  }

  get elapsedMs(): number {
    return this.#elapsedMs
  }

  bind(motion: CanonicalMotion): void {
    if (this.#disposed) return
    validateCanonicalMotion(motion)
    this.#motion = motion
    this.#frameIndex = 0
    this.#elapsedMs = 0
  }

  stop(): void {
    this.#motion = undefined
    this.#frameIndex = 0
    this.#elapsedMs = 0
  }

  advance(deltaSeconds: number): boolean {
    if (this.#disposed || !this.#motion || !Number.isFinite(deltaSeconds) || deltaSeconds < 0) return false
    this.#elapsedMs += deltaSeconds * 1000
    let applied = false
    while (this.#frameIndex < this.#motion.frames.length) {
      const frame = this.#motion.frames[this.#frameIndex]
      if (!frame || frame.timeMs > this.#elapsedMs) break
      this.#apply(frame)
      this.#frameIndex += 1
      applied = true
    }
    return applied
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.stop()
  }

  #apply(frame: CanonicalMotionFrame): void {
    this.#adapter.applyFrame(frame, this.#sink)
  }
}
