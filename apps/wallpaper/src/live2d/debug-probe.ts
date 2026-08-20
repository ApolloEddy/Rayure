import type {
  CanonicalJointPose,
  CanonicalMotion,
  CanonicalMotionFrame,
} from '@rayure/protocol'

import { Live2dMotionPlayer } from './motion-player.ts'
import type { Live2dParameterSink } from './rig-profile.ts'

/**
 * A deliberately non-Cubism sink used only for local development.
 *
 * It exercises the real Canonical Motion -> RigProfile -> parameter path while
 * the repository does not carry a Cubism Core runtime or a distributable model.
 * It must never be presented as a native Live2D model.
 */
export interface Live2dDebugSnapshot {
  mode: 'parameter-probe'
  nativeModelLoaded: false
  parameters: Readonly<Record<string, number>>
}

export interface Live2dDebugProbeOptions {
  onSnapshot?: ((snapshot: Live2dDebugSnapshot) => void) | undefined
}

export class Live2dDebugProbe implements Live2dParameterSink {
  readonly #parameters = new Map<string, number>()
  readonly #player: Live2dMotionPlayer
  readonly #onSnapshot: ((snapshot: Live2dDebugSnapshot) => void) | undefined
  #disposed = false

  constructor(options: Live2dDebugProbeOptions = {}) {
    this.#onSnapshot = options.onSnapshot
    this.#player = new Live2dMotionPlayer(this)
  }

  get player(): Live2dMotionPlayer {
    return this.#player
  }

  bind(motion: CanonicalMotion): void {
    if (this.#disposed) return
    this.#player.bind(motion)
    this.#emit()
  }

  advance(deltaSeconds: number, loopMotion?: CanonicalMotion): boolean {
    if (this.#disposed) return false
    if (!this.#player.isPlaying && loopMotion !== undefined) this.#player.bind(loopMotion)
    const applied = this.#player.advance(deltaSeconds)
    if (applied) this.#emit()
    return applied
  }

  setParameterValue(parameterId: string, value: number): void {
    if (this.#disposed || !parameterId || !Number.isFinite(value)) return
    this.#parameters.set(parameterId, value)
  }

  snapshot(): Live2dDebugSnapshot {
    return {
      mode: 'parameter-probe',
      nativeModelLoaded: false,
      parameters: Object.fromEntries(this.#parameters),
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#player.dispose()
    this.#parameters.clear()
  }

  #emit(): void {
    try {
      this.#onSnapshot?.(this.snapshot())
    }
    catch {
      // A diagnostics callback cannot own the motion lifecycle.
    }
  }
}

const DEBUG_JOINT_NAMES = [
  'head', 'left_shoulder', 'left_elbow', 'left_wrist',
  'right_shoulder', 'right_elbow', 'right_wrist',
  ...Array.from({ length: 20 }, (_, index) => `joint-${index}`),
]

/**
 * A small local fixture for parameter-path checks. It contains no character
 * pixels or third-party assets and is safe to ship as test code.
 */
export function createLive2dDebugMotion(): CanonicalMotion {
  return {
    schema: 'rayure.motion.v1',
    backend: 'rayure-live2d-debug-fixture',
    jointSetId: 'ardy-core-27',
    jointNames: DEBUG_JOINT_NAMES,
    fps: 20,
    frames: [
      createFrame(0, 0, -0.8, 0.8),
      createFrame(700, 14, 0.0, 1.5),
      createFrame(1400, -12, -0.8, 0.8),
    ],
  }
}

function createFrame(
  timeMs: number,
  headYaw: number,
  leftWristX: number,
  rightWristY: number,
): CanonicalMotionFrame {
  const joints: Record<string, CanonicalJointPose> = {}
  for (const name of DEBUG_JOINT_NAMES) {
    joints[name] = {
      position: positionFor(name, leftWristX, rightWristY),
      rotation: name === 'head' ? quaternionFromYaw(headYaw) : [0, 0, 0, 1],
    }
  }
  return {
    timeMs,
    rootPosition: [0, 0, 0],
    rootRotation: [0, 0, 0, 1],
    joints,
  }
}

function positionFor(name: string, leftWristX: number, rightWristY: number): [number, number, number] {
  switch (name) {
    case 'head': return [0, 1.8, 0]
    case 'left_shoulder': return [-0.2, 1.4, 0]
    case 'left_elbow': return [-0.8, 1.4, 0]
    case 'left_wrist': return [leftWristX, leftWristX < -0.4 ? 0.8 : 1.8, 0]
    case 'right_shoulder': return [0.2, 1.4, 0]
    case 'right_elbow': return [0.8, 1.4, 0]
    case 'right_wrist': return [0.8, rightWristY, 0]
    default: return [0, 1, 0]
  }
}

function quaternionFromYaw(degrees: number): [number, number, number, number] {
  const radians = degrees / 2 * Math.PI / 180
  return [0, 0, Math.sin(radians), Math.cos(radians)]
}
