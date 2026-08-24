import { validateCanonicalMotion } from '@rayure/protocol'
import type {
  CanonicalJointPose,
  CanonicalMotion,
  CanonicalMotionFrame,
  CanonicalQuaternion,
  CanonicalVector3,
} from '@rayure/protocol'

import {
  Live2dParameterAdapter,
} from './rig-profile.ts'
import type {
  Live2dParameterSink,
  Live2dRigProfile,
} from './rig-profile.ts'

/**
 * Time-continuous Canonical Motion player. ARDY emits sparse 20 fps samples
 * while a display normally renders at 30-144 fps; applying only whole samples
 * causes visible snapping, so every render tick receives an interpolated pose.
 */
export class Live2dMotionPlayer {
  readonly #adapter: Live2dParameterAdapter
  readonly #sink: Live2dParameterSink
  #motion: CanonicalMotion | undefined
  #frameIndex = 0
  #elapsedMs = 0
  #lastAppliedElapsedMs = -1
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

  /** Number of complete source frames that have become visible. */
  get consumedFrameCount(): number {
    return this.#frameIndex
  }

  bind(motion: CanonicalMotion): void {
    if (this.#disposed) return
    validateCanonicalMotion(motion)
    this.#motion = motion
    this.#frameIndex = 0
    this.#elapsedMs = 0
    this.#lastAppliedElapsedMs = -1
  }

  stop(): void {
    this.#motion = undefined
    this.#frameIndex = 0
    this.#elapsedMs = 0
    this.#lastAppliedElapsedMs = -1
  }

  advance(deltaSeconds: number): boolean {
    const motion = this.#motion
    if (
      this.#disposed
      || motion === undefined
      || this.#frameIndex >= motion.frames.length
      || !Number.isFinite(deltaSeconds)
      || deltaSeconds < 0
    ) return false

    this.#elapsedMs += deltaSeconds * 1000
    const lowerIndex = findLowerFrameIndex(motion.frames, this.#elapsedMs)
    if (lowerIndex < 0 || this.#lastAppliedElapsedMs === this.#elapsedMs) return false

    const lower = motion.frames[lowerIndex]
    const upper = motion.frames[lowerIndex + 1]
    const frame = lower === undefined
      ? undefined
      : upper === undefined || upper.timeMs <= lower.timeMs
        ? lower
        : interpolateFrame(lower, upper, (this.#elapsedMs - lower.timeMs) / (upper.timeMs - lower.timeMs))
    if (frame === undefined) return false

    this.#apply(frame)
    this.#lastAppliedElapsedMs = this.#elapsedMs
    this.#frameIndex = lowerIndex + 1
    return true
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.stop()
  }

  #apply(frame: CanonicalMotionFrame): void {
    this.#adapter.applyFrame(frame, this.#sink)
    this.#sink.onMotionFrame?.(frame)
  }
}

function findLowerFrameIndex(frames: readonly CanonicalMotionFrame[], elapsedMs: number): number {
  let lower = -1
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]
    if (frame === undefined || frame.timeMs > elapsedMs) break
    lower = index
  }
  return lower
}

function interpolateFrame(
  lower: CanonicalMotionFrame,
  upper: CanonicalMotionFrame,
  rawAlpha: number,
): CanonicalMotionFrame {
  const alpha = Math.min(1, Math.max(0, rawAlpha))
  const joints: Record<string, CanonicalJointPose> = {}
  for (const [name, lowerPose] of Object.entries(lower.joints)) {
    const upperPose = upper.joints[name]
    if (upperPose === undefined) {
      joints[name] = lowerPose
      continue
    }
    joints[name] = {
      position: lerpVector(lowerPose.position, upperPose.position, alpha),
      rotation: slerpQuaternion(lowerPose.rotation, upperPose.rotation, alpha),
    }
  }
  return {
    timeMs: lower.timeMs + (upper.timeMs - lower.timeMs) * alpha,
    rootPosition: lerpVector(lower.rootPosition, upper.rootPosition, alpha),
    rootRotation: slerpQuaternion(lower.rootRotation, upper.rootRotation, alpha),
    joints,
  }
}

function lerpVector(a: CanonicalVector3, b: CanonicalVector3, alpha: number): CanonicalVector3 {
  return [
    a[0] + (b[0] - a[0]) * alpha,
    a[1] + (b[1] - a[1]) * alpha,
    a[2] + (b[2] - a[2]) * alpha,
  ]
}

function slerpQuaternion(a: CanonicalQuaternion, b: CanonicalQuaternion, alpha: number): CanonicalQuaternion {
  let bx = b[0]
  let by = b[1]
  let bz = b[2]
  let bw = b[3]
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw
  if (dot < 0) {
    dot = -dot
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  if (dot > 0.9995) {
    return normalizeQuaternion([
      a[0] + (bx - a[0]) * alpha,
      a[1] + (by - a[1]) * alpha,
      a[2] + (bz - a[2]) * alpha,
      a[3] + (bw - a[3]) * alpha,
    ])
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, dot)))
  const sinTheta = Math.sin(theta)
  if (Math.abs(sinTheta) < 1e-6) return a
  const left = Math.sin((1 - alpha) * theta) / sinTheta
  const right = Math.sin(alpha * theta) / sinTheta
  return normalizeQuaternion([
    a[0] * left + bx * right,
    a[1] * left + by * right,
    a[2] * left + bz * right,
    a[3] * left + bw * right,
  ])
}

function normalizeQuaternion(value: CanonicalQuaternion): CanonicalQuaternion {
  const length = Math.hypot(...value)
  if (length <= 1e-6) return [0, 0, 0, 1]
  return [value[0] / length, value[1] / length, value[2] / length, value[3] / length]
}
