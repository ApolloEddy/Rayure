import type { CanonicalMotionFrame } from '@rayure/protocol'
import { Bone, Matrix4, Quaternion, Vector3 } from 'three'

import type { Live2dParameterSink } from '../live2d/rig-profile.ts'
import { CANONICAL_TO_CORE, CORE_BONE_CANDIDATES, CORE_JOINT_NAMES } from './core-bone-names.ts'

export interface CanonicalMotionRigAdapterOptions {
  /** Bones to drive, usually `skinnedMesh.skeleton.bones`. */
  readonly bones: readonly Bone[]
}

/**
 * Drives a THREE.js skeleton with ARDY CoreSkeleton27 world poses.
 *
 * Each interpolated `rayure.motion.v1` frame carries world position + world
 * rotation per joint; the adapter writes those poses directly onto the
 * matching bones as absolute `matrixWorld` matrices (which is exactly what
 * the ARDY reference skin computes: `T(position) * R(rotation)`), leaving the
 * bind-pose inverse matrices untouched.  The renderer's skinning shader then
 * evaluates `matrixWorld ⊗ boneInverse`, the same LBS formula as ARDY's
 * CoreSkin.  See core-skin-loader.ts for the mannequin counterpart.
 *
 * Bone resolution goes through {@link CORE_BONE_CANDIDATES}, so the same
 * adapter drives the official CoreSkin mannequin (bones named `Hips`,
 * `Spine`, ...) and game-converted PMX models (阿贝多.pmx's `001 R UpperArm` /
 * `右ひじ` names) without a per-model rig.
 */
export class CanonicalMotionRigAdapter implements Live2dParameterSink {
  readonly #bones: readonly Bone[]
  readonly #byName: ReadonlyMap<string, Bone>
  readonly #resolved = new Map<string, Bone>()
  readonly #pos = new Vector3()
  readonly #quat = new Quaternion()
  readonly #scale = new Vector3(1, 1, 1)
  readonly #matrix = new Matrix4()
  readonly #tmp = new Matrix4()
  #resolvedJointCount = 0
  #disposed = false

  constructor(options: CanonicalMotionRigAdapterOptions) {
    this.#bones = options.bones
    const byName = new Map<string, Bone>()
    for (const bone of options.bones) {
      if (!byName.has(bone.name)) byName.set(bone.name, bone)
    }
    this.#byName = byName
  }

  /** No-op: the 3D rig is driven entirely through {@link onMotionFrame}. */
  setParameterValue(_parameterId: string, _value: number): void {}

  /** Applies a full interpolated frame to the driven bones. */
  onMotionFrame(frame: CanonicalMotionFrame): void {
    if (this.#disposed) return
    // Pass 1: write absolute world poses (what skinning consumes).  Iterating
    // the canonical frame joints directly keeps resolution lazy; the exact
    // hierarchy order of the writes does not matter here.
    for (const [jointName, pose] of Object.entries(frame.joints)) {
      const bone = this.#resolveBone(jointName)
      if (bone === undefined) continue
      this.#pos.set(pose.position[0], pose.position[1], pose.position[2])
      this.#quat.set(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3])
      this.#matrix.compose(this.#pos, this.#quat, this.#scale)
      bone.matrixWorld.copy(this.#matrix)
    }
    // Pass 2: recompute each driven bone's LOCAL matrix so that *any* forced
    // world-matrix walk reproduces the exact absolute pose.  If the scene graph
    // ever recompounds matrixWorld = parent.matrixWorld ⊗ matrix (e.g. a
    // non-identity ancestor like MMD センター/グルーブ, or a renderer that
    // forces a world update), an absolute-valued `matrix` would be compounded
    // on top of the parent again and the rig would drift/explode.  With
    // matrix = parent⁻¹ ⊗ world the walk becomes an identity operation.
    //
    // Parents are always composed before their children because the resolved
    // bones are iterated in CORE_JOINT_NAMES order (hierarchical for standard
    // MMD/Genshin rigs): by the time a child converts, its parent's matrixWorld
    // already holds this frame's absolute pose.
    for (const coreName of CORE_JOINT_NAMES) {
      const bone = this.#resolved.get(coreName)
      if (bone === undefined) continue
      this.#matrix.copy(bone.matrixWorld)
      const parent = bone.parent
      if (parent !== null) {
        this.#tmp.copy(parent.matrixWorld).invert().multiply(this.#matrix)
      }
      else {
        this.#tmp.copy(this.#matrix)
      }
      bone.matrix.copy(this.#tmp)
      // Freeze the pose so the scene walk never touches it again.
      bone.matrixAutoUpdate = false
      bone.matrixWorldNeedsUpdate = false
    }
  }

  /**
   * World pose currently written on the bone for a canonical joint name, or
   * `undefined` when the joint never resolved to a bone.
   */
  worldMatrix(jointName: string): Matrix4 | undefined {
    return this.#resolved.get(jointName)?.matrixWorld
  }

  /**
   * World poses in CoreSkeleton27 order (index == {@link CORE_JOINT_NAMES}),
   * for numeric verification against an ARDY reference.  Undriven joints are
   * `undefined`.
   */
  get coreWorldMatrices(): readonly (Matrix4 | undefined)[] {
    return CORE_JOINT_NAMES.map((coreName) => this.#resolved.get(coreName)?.matrixWorld)
  }

  /** Number of canonical joints that successfully resolved to a bone. */
  get resolvedJointCount(): number {
    return this.#resolvedJointCount
  }

  resolve(jointName: string): Bone | undefined {
    return this.#resolveBone(jointName)
  }

  /** All loaded bone names, for rig-mapping diagnostics. */
  get boneNames(): readonly string[] {
    return this.#bones.map(bone => bone.name)
  }

  /** World pose of any loaded bone by exact name (rig-mapping diagnostics). */
  boneWorldMatrix(boneName: string): Matrix4 | undefined {
    return this.#byName.get(boneName)?.matrixWorld
  }

  dispose(): void {
    this.#disposed = true
    this.#resolved.clear()
    this.#resolvedJointCount = 0
  }

  #resolveBone(jointName: string): Bone | undefined {
    const cached = this.#resolved.get(jointName)
    if (cached !== undefined) return cached
    const coreName = CANONICAL_TO_CORE[jointName]
    // The core name may have been resolved through another canonical alias
    // (e.g. the mannequin drives `hips` and `Hips` interchangeably).
    if (coreName !== undefined) {
      const byCore = this.#resolved.get(coreName)
      if (byCore !== undefined) {
        this.#resolved.set(jointName, byCore)
        return byCore
      }
    }
    const direct = this.#byName.get(jointName)
    if (direct !== undefined) {
      this.#cache(jointName, coreName, direct)
      return direct
    }
    if (coreName === undefined) return undefined
    const candidates = CORE_BONE_CANDIDATES[coreName]
    if (candidates === undefined) return undefined
    for (const candidate of candidates) {
      const bone = this.#byName.get(candidate)
      if (bone !== undefined) {
        this.#cache(jointName, coreName, bone)
        return bone
      }
    }
    return undefined
  }

  #cache(jointName: string, coreName: string | undefined, bone: Bone): void {
    this.#resolved.set(jointName, bone)
    if (coreName !== undefined) this.#resolved.set(coreName, bone)
    this.#resolvedJointCount += 1
  }
}
