import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bone, BufferGeometry, Group, Skeleton, SkinnedMesh } from 'three'
import { remapModelBones } from '../src/bone-remapper.ts'

test('remapModelBones standardizes game engine extracted bone names', () => {
  const root = new Group()
  const geometry = new BufferGeometry()
  const mesh = new SkinnedMesh(geometry)
  
  const bone1 = new Bone(); bone1.name = 'B01'
  const bone2 = new Bone(); bone2.name = 'D01'
  const bone3 = new Bone(); bone3.name = ' Finger3'
  const bone4 = new Bone(); bone4.name = 'x'
  const bone5 = new Bone(); bone5.name = '頭' // already standard
  
  mesh.bind(new Skeleton([bone1, bone2, bone3, bone4, bone5]))
  root.add(mesh)

  const remapped = remapModelBones(root)
  assert.strictEqual(remapped, 4)
  assert.strictEqual(bone1.name, '左腕')
  assert.strictEqual(bone2.name, '左ひじ')
  assert.strictEqual(bone3.name, '右腕')
  assert.strictEqual(bone4.name, '上半身')
  assert.strictEqual(bone5.name, '頭')
})
