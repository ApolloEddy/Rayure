import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { BufferAttribute, Matrix4, Skeleton, SkinnedMesh } from 'three'

import { CORE_JOINT_NAMES } from '../src/ardy3d/core-bone-names.ts'
import { buildCoreSkinModel } from '../src/ardy3d/core-skin-loader.ts'
import type { CoreSkinData } from '../src/ardy3d/core-skin-loader.ts'

const DATA_URL = new URL('../../../scratch/ardy3d/core-skin-data.json', import.meta.url)

/** numpy row-major 16 values -> THREE Matrix4 (row-major set()). */
function matrixFromRowMajor(values: readonly number[]): Matrix4 {
  return new Matrix4().set(...(values as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]))
}

test('buildCoreSkinModel assembles the ARDY mannequin skeleton and skin attributes', () => {
  const data = JSON.parse(readFileSync(DATA_URL, 'utf-8')) as CoreSkinData
  const model = buildCoreSkinModel(data)

  assert.ok(model.mesh instanceof SkinnedMesh)
  assert.equal(model.skeleton instanceof Skeleton, true)
  assert.equal(model.skeleton.bones.length, CORE_JOINT_NAMES.length)
  assert.deepEqual(model.skeleton.bones.map(bone => bone.name), CORE_JOINT_NAMES)

  const position = model.mesh.geometry.getAttribute('position')
  assert.ok(position instanceof BufferAttribute)
  assert.equal(position.count, data.bindVertices.length)
  assert.equal(position.itemSize, 3)

  const skinIndex = model.mesh.geometry.getAttribute('skinIndex')
  const skinWeight = model.mesh.geometry.getAttribute('skinWeight')
  assert.ok(skinIndex instanceof BufferAttribute)
  assert.ok(skinWeight instanceof BufferAttribute)
  assert.equal(skinIndex.itemSize, 4) // capped to THREE's default 4-influence shader
  assert.equal(skinIndex.count, data.bindVertices.length)

  // boneInverse must be the ARDY bind transform inverse (what the adapter's
  // absolute world pose is multiplied by).
  for (let joint = 0; joint < CORE_JOINT_NAMES.length; joint += 1) {
    const bind = matrixFromRowMajor(data.bindRigTransform[joint]?.flat() ?? [])
    const expectedInverse = bind.clone().invert()
    const actualInverse = model.skeleton.boneInverses[joint]
    assert.ok(actualInverse !== undefined)
    for (let i = 0; i < 16; i += 1) {
      assert.ok(Math.abs(actualInverse.elements[i]! - (expectedInverse.elements[i] ?? 0)) < 1e-9,
        `joint ${joint} inverse element ${i}`)
    }
  }
})
