import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
  MeshStandardMaterial,
  Skeleton,
  SkinnedMesh,
} from 'three'

export const CORE_SKIN_DATA_SCHEMA = 'rayure.core-skin-data.v1' as const

export interface CoreSkinData {
  schema: typeof CORE_SKIN_DATA_SCHEMA
  jointNames: string[]
  bindVertices: number[][] // [V,3]
  faces: number[][] // [F,3]
  bindRigTransform: number[][][] // [R,4,4]
  lbsIndices: number[][] // [V,5]
  lbsWeights: number[][] // [V,5]
  rigJointConnections: number[][]
  restJointPositions: number[][]
}

export interface CoreSkinModel {
  root: Group
  mesh: SkinnedMesh
  skeleton: Skeleton
}

const MAX_GPU_INFLUENCES = 4

/**
 * Builds the official ARDY CoreSkin27 test mannequin from the exported JSON
 * fixture (`scratch/ardy3d/core-skin-data.json`, git-ignored).  Bones are
 * named exactly `CoreSkeleton27` and their `boneInverse` matrices are the
 * ARDY bind transforms, so a {@link CanonicalMotionRigAdapter} driven by the
 * same motion reproduces ARDY's own `CoreSkin.lbs()` output on the GPU.
 *
 * The mannequin is the numeric ground-truth target for the adapter, not an
 * appearance choice: it has no texture, so it only exists to verify rig
 * equivalence before switching to a real model (阿贝多.pmx).
 */
export function buildCoreSkinModel(data: CoreSkinData): CoreSkinModel {
  if (data.schema !== CORE_SKIN_DATA_SCHEMA) {
    throw new Error(`Unsupported core skin data schema: ${String(data.schema)}`)
  }
  const bones = buildBones(data)
  const geometry = buildGeometry(data)
  const material = new MeshStandardMaterial({ color: 0x9aa2ad, roughness: 0.9, metalness: 0.0 })
  const mesh = new SkinnedMesh(geometry, material)
  mesh.add(...bones)
  // Freeze every bone so the frame's matrixWorld walk never recompounds it
  // through an (identity) ancestor -- the adapter writes absolute world poses.
  for (const bone of bones) {
    bone.matrixAutoUpdate = false
    bone.matrixWorldNeedsUpdate = false
  }
  // The Skeleton constructor snapshots boneInverses = inv(bone.matrixWorld) from
  // the bind transforms set above.  Pass an explicit bindMatrix so bind() skips
  // its internal updateMatrixWorld(true) + calculateInverses(): with no argument
  // it would reset every bone.matrix to identity (Bone.matrixAutoUpdate defaults
  // to true) and then inverse the identity -- the mesh would lose its bind pose.
  const skeleton = new Skeleton(bones)
  mesh.bind(skeleton, mesh.matrixWorld)
  const root = new Group()
  root.name = 'rayure-core-skin'
  root.add(mesh)
  return { root, mesh, skeleton }
}

/** Fetches the JSON fixture through a URL (Vite `/@fs/` or a local asset). */
export async function loadCoreSkinModel(url: string): Promise<CoreSkinModel> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'omit' })
  if (!response.ok) throw new Error(`Core skin fetch failed with HTTP ${response.status}`)
  const data: unknown = await response.json()
  return buildCoreSkinModel(data as CoreSkinData)
}

function buildBones(data: CoreSkinData): Bone[] {
  return data.jointNames.map((name, index) => {
    const bone = new Bone()
    bone.name = name
    // bindRigTransform is stored row-major (numpy); THREE Matrix4 is
    // column-major, so transpose when importing.
    bone.matrix.fromArray(transpose4x4(data.bindRigTransform[index]?.flat() ?? identity4x4()))
    bone.matrixWorld.copy(bone.matrix)
    return bone
  })
}

function buildGeometry(data: CoreSkinData): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(flatten(data.bindVertices)), 3))
  geometry.setIndex(flatten(data.faces))

  // THREE's default skinning shader supports 4 bone influences per vertex;
  // ARDY stores 5 (the 5th weight is typically tiny).  Keep the top 4 and
  // renormalize so the GPU mesh matches the reference to visual precision.
  const indices = new Uint16Array(data.lbsIndices.length * MAX_GPU_INFLUENCES)
  const weights = new Float32Array(data.lbsWeights.length * MAX_GPU_INFLUENCES)
  for (let vertex = 0; vertex < data.lbsIndices.length; vertex += 1) {
    const influences = data.lbsIndices[vertex] ?? []
    const w = data.lbsWeights[vertex] ?? []
    const ranked = influences
      .map((joint, i) => ({ joint: joint ?? 0, weight: w[i] ?? 0 }))
      .sort((a, b) => b.weight - a.weight)
    let total = 0
    for (let slot = 0; slot < MAX_GPU_INFLUENCES; slot += 1) {
      const influence = ranked[slot]
      if (influence === undefined) break
      total += influence.weight
    }
    for (let slot = 0; slot < MAX_GPU_INFLUENCES; slot += 1) {
      const influence = ranked[slot]
      if (influence === undefined) {
        indices[vertex * MAX_GPU_INFLUENCES + slot] = 0
        weights[vertex * MAX_GPU_INFLUENCES + slot] = 0
        continue
      }
      indices[vertex * MAX_GPU_INFLUENCES + slot] = influence.joint
      weights[vertex * MAX_GPU_INFLUENCES + slot] = total > 1e-9 ? influence.weight / total : 0
    }
  }
  geometry.setAttribute('skinIndex', new BufferAttribute(indices, MAX_GPU_INFLUENCES))
  geometry.setAttribute('skinWeight', new BufferAttribute(weights, MAX_GPU_INFLUENCES))
  return geometry
}

function flatten(values: readonly number[][]): number[] {
  const out = new Array<number>(values.length * (values[0]?.length ?? 0))
  let offset = 0
  for (const row of values) {
    for (const value of row) out[offset++] = value
  }
  return out
}

function identity4x4(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

/** Row-major (numpy) to column-major (THREE Matrix4.elements). */
function transpose4x4(rowMajor: readonly number[]): number[] {
  if (rowMajor.length !== 16) return identity4x4()
  const out = new Array<number>(16)
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      out[row + column * 4] = rowMajor[row * 4 + column] ?? 0
    }
  }
  return out
}
