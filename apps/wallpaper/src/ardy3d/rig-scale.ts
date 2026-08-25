import type { CanonicalMotionFrame } from '@rayure/protocol'

/**
 * ARDY CoreSkeleton27 world poses are in meters; the official CoreSkin
 * mannequin fixture is already in that space (hips ≈ 0.97m).  MMD/PMX models
 * are authored in their own unit (usually centimeters — a 1.6m character is
 * ~160 units, hips ≈ 97), so driving their bones directly with meter poses
 * collapses the character to 1/100 scale.  The debug surface converts
 * positions by the factor that maps the ARDY reference hips height onto the
 * model's own bind hips height.
 *
 * Bucketing strictly into {1, 100} only fits full-size MMD rigs: a small or
 * game-extracted model (e.g. albedo.pmx, ~22 units tall, bind hips ≈ 12) is
 * misclassified as "centimeters" and driven 8× too large, pushing the whole
 * figure out of the camera's bind-pose frame.  The continuous ratio keeps the
 * driven pose anchored on the bind pose for any rig, so the camera framing in
 * `#frameCamera` (computed from the bind `Box3`) stays valid.
 */
export function detectRigPositionScale(hipsBindHeight: number): number {
  if (!Number.isFinite(hipsBindHeight)) return 1
  const h = Math.abs(hipsBindHeight)
  // A hips bind height of ~0 means the bind world matrix was never composed
  // (or the rig truly anchors hips at the origin): fall back to no scaling
  // rather than collapsing every position to zero.
  if (h < 0.001) return 1
  // ARDY reference hips ≈ 0.97m.  Round to the nearest integer so full-size
  // MMD models still yield exactly 100 (and CoreSkin exactly 1).
  return Math.round(h / ARDY_HIPS_REFERENCE_METERS)
}

/** ARDY standing hips height in meters (see {@link detectRigPositionScale}). */
export const ARDY_HIPS_REFERENCE_METERS = 0.97

/**
 * Returns a frame whose joint positions are multiplied by `scale` (rotations
 * are scale-invariant).  The original frame is returned untouched when no
 * scaling is needed so the hot path stays allocation-free.
 */
export function scaleCanonicalFrame(frame: CanonicalMotionFrame, scale: number): CanonicalMotionFrame {
  if (scale === 1) return frame
  const joints: Record<string, { position: readonly [number, number, number], rotation: readonly [number, number, number, number] }> = {}
  for (const [jointName, pose] of Object.entries(frame.joints)) {
    joints[jointName] = {
      position: [
        pose.position[0] * scale,
        pose.position[1] * scale,
        pose.position[2] * scale,
      ],
      rotation: pose.rotation,
    }
  }
  return {
    ...frame,
    joints,
  }
}
