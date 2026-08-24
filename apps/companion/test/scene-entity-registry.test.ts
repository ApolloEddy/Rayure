import assert from 'node:assert/strict'
import test from 'node:test'

import { SceneEntityRegistry } from '../src/scene-entity-registry.ts'

test('scene entity targets become ARDY end-effector constraints without changing action semantics', () => {
  const registry = new SceneEntityRegistry({
    entities: [{ id: 'cup', position: [1, 0.8, -2] }],
  })

  assert.deepEqual(registry.resolveTarget({
    entityId: 'cup',
    timeMs: 500,
    offset: [0, 0.1, 0],
  }), {
    timeMs: 500,
    joint: 'RightHand',
    position: [1, 0.9, -2],
  })

  // Updating a target changes the constraint only; callers keep their same
  // prompt/cache key and therefore reuse the existing semantic embedding.
  registry.upsert({ id: 'cup', position: [2, 0.8, -1] })
  assert.deepEqual(registry.resolveTarget({ entityId: 'cup', timeMs: 500 }), {
    timeMs: 500,
    joint: 'RightHand',
    position: [2, 0.8, -1],
  })
})

test('scene registry applies the declared coordinate transform and root heading', () => {
  const registry = new SceneEntityRegistry({
    transform: { origin: [10, 0, 10], scale: 0.5 },
    entities: [{ id: 'marker', position: [14, 2, 6], headingRadians: Math.PI / 2 }],
  })
  const constraint = registry.resolveTarget({
    entityId: 'marker',
    joint: 'Hips',
    timeMs: 0,
  })
  assert.deepEqual(constraint.position, [2, 1, -2])
  assert.ok(constraint.rotation)
  assert.ok(Math.abs((constraint.rotation?.[1] ?? 0) - Math.SQRT1_2) < 1e-9)
  assert.ok(Math.abs((constraint.rotation?.[3] ?? 0) - Math.SQRT1_2) < 1e-9)
})

test('scene registry rejects unknown entities and unsupported target input', () => {
  const registry = new SceneEntityRegistry()
  assert.throws(() => registry.resolveTarget({ entityId: 'missing', timeMs: 0 }), /not registered/i)
  assert.throws(() => registry.upsert({ id: 'bad', position: [0, Number.NaN, 0] }), /finite/i)
  assert.throws(() => registry.resolveTarget({
    entityId: 'missing',
    timeMs: 0,
    joint: 'Head' as never,
  }), /unsupported/i)
})
