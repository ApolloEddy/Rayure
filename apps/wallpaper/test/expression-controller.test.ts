import assert from 'node:assert/strict'
import test from 'node:test'
import { BufferGeometry, Mesh, MeshBasicMaterial } from 'three'

import { ExpressionController } from '../src/expression-controller.ts'

function createMockMesh(morphDict: Record<string, number>): Mesh {
  const geometry = new BufferGeometry()
  const material = new MeshBasicMaterial()
  const mesh = new Mesh(geometry, material)
  mesh.morphTargetDictionary = { ...morphDict }
  mesh.morphTargetInfluences = new Array(Object.keys(morphDict).length).fill(0)
  return mesh
}

test('ExpressionController maps semantic aliases across languages', () => {
  const mesh = createMockMesh({
    まばたき: 0,
    笑い: 1,
    あ: 2,
    お: 3,
    ウィンク: 4,
  })

  const controller = new ExpressionController(mesh)
  assert.equal(controller.hasMorph('blink'), true)
  assert.equal(controller.hasMorph('smile'), true)
  assert.equal(controller.hasMorph('talk_a'), true)
  assert.equal(controller.hasMorph('talk_o'), true)
  assert.equal(controller.hasMorph('blink_right'), true)
  assert.equal(controller.hasMorph('non_existent'), false)
})

test('ExpressionController clamps weights and gracefully ignores missing morphs', () => {
  const mesh = createMockMesh({
    smile: 0,
  })

  const controller = new ExpressionController(mesh)
  controller.setExpression('smile', 1.8, 0) // durationMs 0 即时更新
  controller.advance(0.1)
  assert.equal(controller.getMorphWeight('smile'), 1.0)

  controller.setExpression('smile', -0.5, 0)
  controller.advance(0.1)
  assert.equal(controller.getMorphWeight('smile'), 0.0)

  // Non-existent morph should not throw or mutate other influences
  controller.setExpression('missing_morph', 0.9, 0)
  controller.advance(0.1)
  assert.equal(mesh.morphTargetInfluences?.[0], 0.0)
})

test('ExpressionController performs smooth interpolation transitions', () => {
  const mesh = createMockMesh({
    smile: 0,
  })

  const controller = new ExpressionController(mesh)
  // 过渡到 1.0，用时 1000ms (1秒)
  controller.setExpression('smile', 1.0, 1000)

  // 步进 0.5 秒，权重应大约在 0.5 左右
  controller.advance(0.5)
  const midWeight = controller.getMorphWeight('smile')
  assert.ok(midWeight >= 0.49 && midWeight <= 0.51, `Expected ~0.5, got ${midWeight}`)

  // 再步进 0.6 秒，应到达 1.0
  controller.advance(0.6)
  assert.equal(controller.getMorphWeight('smile'), 1.0)
})

test('ExpressionController auto-blink updates blink channel smoothly', () => {
  const mesh = createMockMesh({
    まばたき: 0,
  })

  let fixedRandom = 0.5
  const controller = new ExpressionController(mesh, {
    autoBlink: true,
    blinkMinInterval: 1.0,
    blinkMaxInterval: 1.0, // 固定 1.0 秒间隔
    random: () => fixedRandom,
  })

  // 0.5s 仍在待机
  controller.advance(0.5)
  assert.equal(controller.getMorphWeight('blink'), 0)

  // 0.6s 进入闭眼阶段 (1.0s 触发)
  controller.advance(0.6)
  const closingWeight = controller.getMorphWeight('blink')
  assert.ok(closingWeight > 0, `Expected blink in progress, got ${closingWeight}`)

  // 步进完闭眼和睁眼过程 (0.06s + 0.09s = 0.15s)
  controller.advance(0.2)
  assert.equal(controller.getMorphWeight('blink'), 0)
})

test('ExpressionController disposal terminates all updates and clears targets', () => {
  const mesh = createMockMesh({
    smile: 0,
  })

  const controller = new ExpressionController(mesh)
  controller.setExpression('smile', 1.0, 100)
  controller.dispose()

  controller.advance(0.2)
  assert.equal(controller.hasMorph('smile'), false)
  assert.equal(controller.getMorphWeight('smile'), 0)
})
