import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { CanonicalMotion } from '@rayure/protocol'
import { Bone, Matrix4, Vector3 } from 'three'

import {
  CANONICAL_TO_CORE,
  CORE_BONE_CANDIDATES,
  CORE_JOINT_NAMES,
} from '../src/ardy3d/core-bone-names.ts'
import { CanonicalMotionRigAdapter } from '../src/ardy3d/canonical-rig-adapter.ts'
import type { CoreSkinData } from '../src/ardy3d/core-skin-loader.ts'

const MOTION_URL = new URL('../../../.walk-motion.json', import.meta.url)
const DATA_URL = new URL('../../../scratch/ardy3d/core-skin-data.json', import.meta.url)
const REFERENCE_URL = new URL('../../../scratch/ardy3d/core-skin-reference.json', import.meta.url)
const VERTEX_URL = new URL('../../../scratch/ardy3d/core-skin-vertex-reference.json', import.meta.url)

interface CoreSkinReference {
  schema: string
  jointNames: string[]
  fps: number
  frames: number[][][] // [T][27][16] row-major 4x4
}

interface CoreSkinVertexReference {
  schema: string
  vertexIndices: number[]
  bindVertices: number[][]
  frames: number[][][] // [T][sampledVertex][3]
}

/** Tolerance for cross-language float comparisons (numpy float64 vs JS float64). */
const BONE_TOLERANCE = 1e-9
const VERTEX_TOLERANCE = 1e-6

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, 'utf-8')) as T
}

/** numpy row-major 16 values -> THREE Matrix4 (row-major set()). */
function matrixFromRowMajor(values: readonly number[]): Matrix4 {
  return new Matrix4().set(...(values as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]))
}

function maxAbsDiff(a: Matrix4, b: Matrix4): number {
  const ae = a.elements
  const be = b.elements
  let worst = 0
  for (let i = 0; i < 16; i += 1) {
    worst = Math.max(worst, Math.abs((ae[i] ?? 0) - (be[i] ?? 0)))
  }
  return worst
}

/** Builds bones named exactly CoreSkeleton27 (the official mannequin naming). */
function buildCoreSkinBones(): Bone[] {
  return CORE_JOINT_NAMES.map((name) => {
    const bone = new Bone()
    bone.name = name
    return bone
  })
}

function sourceFrames(): CanonicalMotion {
  return readJson<CanonicalMotion>(MOTION_URL)
}

test('canonical frame -> bone world matrices equals the ARDY reference (numpy)', async (t) => {
  const reference = readJson<CoreSkinReference>(REFERENCE_URL)
  const motion = sourceFrames()
  assert.equal(reference.jointNames.length, CORE_JOINT_NAMES.length)
  assert.equal(motion.frames.length, reference.frames.length)

  // The reference jointNames are CoreSkeleton27 order; the motion frames are
  // keyed by canonical snake names.  They must be the same joint set.
  for (let index = 0; index < reference.jointNames.length; index += 1) {
    const coreName = reference.jointNames[index]
    const canonicalName = motion.jointNames[index]
    assert.equal(CANONICAL_TO_CORE[canonicalName!], coreName)
  }

  const adapter = new CanonicalMotionRigAdapter({ bones: buildCoreSkinBones() })
  assert.equal(adapter.resolvedJointCount, 0)

  for (let frameIndex = 0; frameIndex < motion.frames.length; frameIndex += 1) {
    const frame = motion.frames[frameIndex]
    assert.ok(frame !== undefined, `frame ${frameIndex} exists`)
    adapter.onMotionFrame(frame)
    assert.equal(adapter.resolvedJointCount, CORE_JOINT_NAMES.length, `frame ${frameIndex} resolves all 27 joints`)

    for (let jointIndex = 0; jointIndex < CORE_JOINT_NAMES.length; jointIndex += 1) {
      const driven = adapter.coreWorldMatrices[jointIndex]
      assert.ok(driven !== undefined, `joint ${CORE_JOINT_NAMES[jointIndex]} at frame ${frameIndex} is driven`)
      const expected = matrixFromRowMajor(reference.frames[frameIndex]?.[jointIndex] ?? [])
      const worst = maxAbsDiff(driven, expected)
      assert.ok(
        worst <= BONE_TOLERANCE,
        `frame ${frameIndex} ${CORE_JOINT_NAMES[jointIndex]} worst |Δ|=${worst} > ${BONE_TOLERANCE}`,
      )
    }
  }

  // The loop ends on the last source frame; Hips is the root carrying the
  // global translation, so its matrixWorld must carry a real world position.
  const drivenHips = adapter.worldMatrix('hips')
  assert.ok(drivenHips !== undefined)
  const last = reference.frames.length - 1
  assert.ok(Math.abs(drivenHips.elements[12] - reference.frames[last]![0]![3]!) < BONE_TOLERANCE)
  assert.ok(Math.abs(drivenHips.elements[13] - reference.frames[last]![0]![7]!) < BONE_TOLERANCE)
  assert.ok(Math.abs(drivenHips.elements[14] - reference.frames[last]![0]![11]!) < BONE_TOLERANCE)
})

test('adapter world matrices reproduce ARDY CoreSkin.lbs() vertex positions', async (t) => {
  const data = readJson<CoreSkinData>(DATA_URL)
  const reference = readJson<CoreSkinReference>(REFERENCE_URL)
  const vertices = readJson<CoreSkinVertexReference>(VERTEX_URL)
  const motion = sourceFrames()

  const adapter = new CanonicalMotionRigAdapter({ bones: buildCoreSkinBones() })

  // Precompute bind inverse matrices once (ARDY bind_rig_transform_inv).
  const bindInverse = data.bindRigTransform.map((nested4x4) => {
    const bind = matrixFromRowMajor(nested4x4.flat())
    return bind.clone().invert()
  })

  const offset = new Matrix4()
  const point = new Vector3()
  const out = new Vector3()
  for (let frameIndex = 0; frameIndex < motion.frames.length; frameIndex += 1) {
    assert.ok(motion.frames[frameIndex] !== undefined, `frame ${frameIndex} exists`)
    adapter.onMotionFrame(motion.frames[frameIndex]!)
    const worlds = adapter.coreWorldMatrices
    for (let sampled = 0; sampled < vertices.vertexIndices.length; sampled += 1) {
      const vertexIndex = vertices.vertexIndices[sampled]
      assert.ok(vertexIndex !== undefined, `sampled vertex ${sampled}`)
      const bindVertex = data.bindVertices[vertexIndex]!
      point.set(bindVertex[0]!, bindVertex[1]!, bindVertex[2]!)
      out.set(0, 0, 0)
      for (let influence = 0; influence < 5; influence += 1) {
        const joint = data.lbsIndices[vertexIndex]?.[influence]
        const weight = data.lbsWeights[vertexIndex]?.[influence] ?? 0
        if (joint === undefined || joint < 0 || weight === 0) continue
        const world = worlds[joint]
        assert.ok(world !== undefined, `vertex ${vertexIndex} influence joint ${joint} is driven`)
        offset.multiplyMatrices(world, bindInverse[joint] ?? new Matrix4())
        out.addScaledVector(point.clone().applyMatrix4(offset), weight)
      }
      const expected = vertices.frames[frameIndex]?.[sampled]
      assert.ok(expected !== undefined, `vertex reference frame ${frameIndex} sample ${sampled}`)
      for (let axis = 0; axis < 3; axis += 1) {
        const delta = Math.abs(out.getComponent(axis) - (expected[axis] ?? 0))
        assert.ok(
          delta <= VERTEX_TOLERANCE,
          `frame ${frameIndex} vertex[${vertexIndex}] axis ${axis} |Δ|=${delta} > ${VERTEX_TOLERANCE}`,
        )
      }
    }
  }
})

test('bone resolution handles game-converted PMX naming (阿贝多-style)', () => {
  const names = [
    'センター', 'グルーブ', '下半身', '腰', '上半身', '上半身2', '上半身3', '首', '頭',
    '右肩', '001 R UpperArm', '001 R Forearm', '001 R Hand', '右腕捩1', '右手',
    '左肩', '001 L UpperArm', '001 L Forearm', '001 L Hand', '左手',
    '右足', '右ひざ', '右足首', '右つま先',
    '左足', '左ひざ', '左足首', '左つま先',
    '両目', 'Skirt_0_0',
  ]
  const bones = names.map((name) => {
    const bone = new Bone()
    bone.name = name
    return bone
  })
  const adapter = new CanonicalMotionRigAdapter({ bones })

  const expectations: Readonly<Record<string, string>> = {
    hips: '腰',
    spine: '上半身',
    spine1: '上半身2',
    spine2: '上半身3',
    spine3: '上半身3', // falls back to the last MMD spine segment
    neck: '首',
    head: '頭',
    right_shoulder: '右肩',
    right_upper_arm: '001 R UpperArm',
    right_elbow: '001 R Forearm',
    right_wrist: '001 R Hand',
    right_hand_end: '右手',
    left_shoulder: '左肩',
    left_upper_arm: '001 L UpperArm',
    left_elbow: '001 L Forearm',
    left_wrist: '001 L Hand',
    left_hand_end: '左手',
    right_hip: '右足',
    right_knee: '右ひざ',
    right_ankle: '右足首',
    right_toe: '右つま先',
    left_hip: '左足',
    left_knee: '左ひざ',
    left_ankle: '左足首',
    left_toe: '左つま先',
  }

  for (const [jointName, expectedBone] of Object.entries(expectations)) {
    assert.equal(adapter.resolve(jointName)?.name, expectedBone, `joint ${jointName}`)
  }
  // Unknown joints and missing bones are tolerated, never fatal.
  assert.equal(adapter.resolve('left_thumb'), undefined)
  assert.equal(adapter.resolve('not_a_joint'), undefined)
  // Every CoreSkeleton27 joint has a candidate list.
  for (const coreName of CORE_JOINT_NAMES) {
    const candidates = CORE_BONE_CANDIDATES[coreName!]
    assert.ok(candidates !== undefined && candidates.length > 0, `candidates for ${coreName}`)
  }
})

test('CanonicalMotionPlayer drives the rig through the production pipeline', async () => {
  // The real path used by the surface: a CanonicalMotionPlayer interpolates
  // 20 fps samples and pushes each interpolated frame into the adapter.
  const motion = sourceFrames()
  const adapter = new CanonicalMotionRigAdapter({ bones: buildCoreSkinBones() })
  const { CanonicalMotionPlayer } = await import('../src/live2d/canonical-motion-client.ts')
  const player = new CanonicalMotionPlayer(adapter)
  player.play(motion, {
    id: 'walk',
    displayName: 'Walk Forward',
    format: 'canonical',
    url: 'http://127.0.0.1:32145/assets/0123456789abcdef/walk.motion.json',
  })

  assert.equal(player.isPlaying, true)

  // Advance well past the first sample so interpolation has produced a pose
  // and the adapter has resolved its bones (resolution is lazy on first frame).
  for (let i = 0; i < 8; i += 1) player.advance(0.05)
  assert.ok(player.consumedFrameCount >= 1)

  const hipsBefore = adapter.worldMatrix('hips')!.clone()
  const headBefore = adapter.worldMatrix('head')!.clone()

  for (let i = 0; i < 8; i += 1) player.advance(0.05)
  const hipsAfter = adapter.worldMatrix('hips')!
  const headAfter = adapter.worldMatrix('head')!
  assert.ok(maxAbsDiff(hipsAfter, hipsBefore) > 0, 'hips moved as the walk progressed')
  assert.ok(maxAbsDiff(headAfter, headBefore) > 0, 'head moved as the walk progressed')

  player.stop()
  assert.equal(player.isPlaying, false)
  player.dispose()
})
