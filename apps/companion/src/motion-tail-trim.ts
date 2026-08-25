import type {
  CanonicalJointPose,
  CanonicalMotion,
  CanonicalMotionFrame,
  CanonicalQuaternion,
  CanonicalVector3,
} from '@rayure/protocol'

/**
 * Post-processes a freshly generated ARDY Canonical Motion so gestures
 * "complete" cleanly. The autoregressive continuation keeps generating after
 * the actual action is over, holding the final pose static (hand raised
 * mid-wave) for as long as the requested frame count demands — a dead tail
 * that reads as "the motion stopped before finishing". This trims that tail
 * and appends a short blend back to the motion's neutral start pose, so a
 * wave becomes raise → lower and a walk becomes stride → settle instead of
 * raise → freeze.
 *
 * The trim only fires when the tail is genuinely static relative to the
 * motion's own activity (adaptive threshold), so slow-but-alive motions pass
 * through untouched. Positions blend in root-relative space and the root
 * stays at the trimmed end, so a forward-walking body settles in place rather
 * than sliding back to where it started.
 */

// Tuned against real ARDY Core-Skin output. Healthy gestures move major bones
// ~10-40mm/frame at the peak, while the autoregressive dead tail holds the
// whole body to a few mm/frame. The tail's residual jitter is dominated by the
// expressive tip joints (hand ends, thumbs, toes), so those are excluded from
// the activity signal — otherwise a single jittering finger cap inflates the
// peak and the adaptive threshold swallows the whole gesture.
const MIN_FRAMES = 16        // motions shorter than this are left untouched
const ACTIVITY_WINDOW = 5    // frames for smoothing the per-frame displacement
const ACTIVITY_RATIO = 0.25  // fraction of peak activity that still counts as motion
const NOISE_FLOOR = 0.003    // meters/frame of smoothed displacement below which a tail is dead
const TRIM_MIN_TAIL = 8      // only trim when the dead tail is at least this long
const TRIM_PAD = 3           // frames kept past the last active frame to avoid cutting mid-motion
const MIN_ACTIVE = 6         // motions with less real motion than this are not trimmed
const BLEND_FRAMES = 10      // ~0.5s @ 20fps return-to-neutral blend
// Peak smoothed tips-excluded displacement (meters) below which a whole motion
// is treated as degenerate near-static output. Real ARDY gestures clear
// ~10-40mm/frame at the peak; the degraded bridge decays to a few mm/frame.
const DEGENERATE_PEAK_FLOOR = 0.006

/** Canonical joints excluded from the activity signal (they jitter in place). */
const TIP_JOINTS = new Set([
  'right_hand_end',
  'left_hand_end',
  'right_thumb',
  'left_thumb',
  'right_toe',
  'left_toe',
])

export function trimStaticTailAndReturnToNeutral(motion: CanonicalMotion): CanonicalMotion {
  const frames = motion.frames
  if (frames.length < MIN_FRAMES) return motion

  const smoothed = smoothedActivity(frames)
  const peak = Math.max(...smoothed)
  const threshold = Math.max(NOISE_FLOOR, peak * ACTIVITY_RATIO)

  let lastActive = 0
  for (let i = 1; i < smoothed.length; i += 1) {
    if (smoothed[i]! > threshold) lastActive = i
  }

  const deadTail = frames.length - 1 - lastActive
  if (deadTail < TRIM_MIN_TAIL || lastActive < MIN_ACTIVE) return motion

  const end = Math.min(frames.length - 1, lastActive + TRIM_PAD)
  const trimmed = frames.slice(0, end + 1)
  const blend = returnToNeutralBlend(trimmed[trimmed.length - 1]!, frames[0]!, motion.fps)
  return { ...motion, frames: [...trimmed, ...blend] }
}

/**
 * Detects a degenerate ARDY generation: the whole motion barely moves at all,
 * so the peak smoothed tips-excluded displacement stays below a fixed floor.
 * The bridge occasionally drifts into a near-static regime (consecutive
 * generations decay toward neutral); restarting the process restores healthy
 * output. A small-but-real gesture (a squat, a subtle sway) still clears the
 * floor, so only genuinely dead output is flagged.
 */
export function isDegenerateMotion(motion: CanonicalMotion): boolean {
  if (motion.frames.length < MIN_FRAMES) return false
  const peak = Math.max(...smoothedActivity(motion.frames))
  return peak < DEGENERATE_PEAK_FLOOR
}

/** Smoothed per-frame peak joint displacement (meters) over a forward window. */
function smoothedActivity(frames: readonly CanonicalMotionFrame[]): number[] {
  const result: number[] = new Array(frames.length)
  for (let i = 0; i < frames.length; i += 1) {
    let sum = 0
    let count = 0
    for (let k = i; k < frames.length && k < i + ACTIVITY_WINDOW; k += 1) {
      if (k === 0) continue // the first frame has no predecessor
      sum += maxJointDisplacement(frames[k - 1]!, frames[k]!)
      count += 1
    }
    result[i] = count === 0 ? 0 : sum / count
  }
  return result
}

function maxJointDisplacement(previous: CanonicalMotionFrame, current: CanonicalMotionFrame): number {
  let max = 0
  for (const name of Object.keys(previous.joints)) {
    if (TIP_JOINTS.has(name)) continue
    const distance = distance3(previous.joints[name]!.position, current.joints[name]!.position)
    if (distance > max) max = distance
  }
  return max
}

function returnToNeutralBlend(
  last: CanonicalMotionFrame,
  neutral: CanonicalMotionFrame,
  fps: number,
): CanonicalMotionFrame[] {
  const stepMs = Math.round(1000 / fps)
  const frames: CanonicalMotionFrame[] = []
  for (let b = 1; b <= BLEND_FRAMES; b += 1) {
    // The final frame must actually reach the neutral relative pose. Stopping
    // at BLEND_FRAMES/(BLEND_FRAMES+1) leaves a permanent residual bend.
    const t = b / BLEND_FRAMES
    frames.push(blendFrame(last, neutral, t, last.timeMs + b * stepMs))
  }
  return frames
}

/**
 * One return-to-neutral blend frame. Joint positions blend in root-relative
 * space and rotations blend relative to the root orientation, both re-anchored
 * onto the trimmed end's root — the body settles into its neutral stance while
 * the root stays put (no walking backward, no body spin).
 */
function blendFrame(
  from: CanonicalMotionFrame,
  to: CanonicalMotionFrame,
  t: number,
  timeMs: number,
): CanonicalMotionFrame {
  const fromRootInv = inverseQuaternion(from.rootRotation)
  const toRootInv = inverseQuaternion(to.rootRotation)
  const joints: Record<string, CanonicalJointPose> = {}
  for (const name of Object.keys(from.joints)) {
    const fromRelativePosition = subtract3(from.joints[name]!.position, from.rootPosition)
    const toRelativePosition = subtract3(to.joints[name]!.position, to.rootPosition)
    const fromRelativeRotation = multiplyQuaternion(fromRootInv, from.joints[name]!.rotation)
    const toRelativeRotation = multiplyQuaternion(toRootInv, to.joints[name]!.rotation)
    joints[name] = {
      position: add3(from.rootPosition, lerp3(fromRelativePosition, toRelativePosition, t)),
      rotation: normalizeQuaternion(multiplyQuaternion(
        from.rootRotation,
        slerp4(fromRelativeRotation, toRelativeRotation, t),
      )),
    }
  }
  return {
    timeMs,
    rootPosition: from.rootPosition,
    rootRotation: from.rootRotation,
    joints,
  }
}

function lerp3(a: CanonicalVector3, b: CanonicalVector3, t: number): CanonicalVector3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]
}

function add3(a: CanonicalVector3, b: CanonicalVector3): CanonicalVector3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function subtract3(a: CanonicalVector3, b: CanonicalVector3): CanonicalVector3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function distance3(a: CanonicalVector3, b: CanonicalVector3): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  const dz = a[2] - b[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** Shortest-arc spherical interpolation; falls back to nlerp near the poles. */
function slerp4(a: CanonicalQuaternion, b: CanonicalQuaternion, t: number): CanonicalQuaternion {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  let end = b
  if (dot < 0) {
    dot = -dot
    end = [-b[0], -b[1], -b[2], -b[3]] as CanonicalQuaternion
  }
  if (dot > 0.9995) {
    return normalizeQuaternion([
      a[0] + (end[0] - a[0]) * t,
      a[1] + (end[1] - a[1]) * t,
      a[2] + (end[2] - a[2]) * t,
      a[3] + (end[3] - a[3]) * t,
    ])
  }
  const theta = Math.acos(dot)
  const sinTheta = Math.sin(theta)
  const weightA = Math.sin((1 - t) * theta) / sinTheta
  const weightB = Math.sin(t * theta) / sinTheta
  return [
    weightA * a[0] + weightB * end[0],
    weightA * a[1] + weightB * end[1],
    weightA * a[2] + weightB * end[2],
    weightA * a[3] + weightB * end[3],
  ]
}

/** q⁻¹, assuming a unit quaternion. */
function inverseQuaternion(q: CanonicalQuaternion): CanonicalQuaternion {
  return [-q[0], -q[1], -q[2], q[3]]
}

function multiplyQuaternion(a: CanonicalQuaternion, b: CanonicalQuaternion): CanonicalQuaternion {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

function normalizeQuaternion(q: CanonicalQuaternion): CanonicalQuaternion {
  const magnitude = Math.hypot(q[0], q[1], q[2], q[3])
  if (magnitude <= 1e-12) return [0, 0, 0, 1] as CanonicalQuaternion
  const inv = 1 / magnitude
  return [q[0] * inv, q[1] * inv, q[2] * inv, q[3] * inv]
}
