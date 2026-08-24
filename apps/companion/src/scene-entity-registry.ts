import type { CanonicalQuaternion, CanonicalVector3 } from '@rayure/protocol'

import type { ArdyKinematicConstraint } from './ardy-process-protocol.ts'

export const ARDY_TARGET_JOINTS = [
  'Hips',
  'LeftHand',
  'RightHand',
  'LeftFoot',
  'RightFoot',
] as const
export type ArdyTargetJoint = typeof ARDY_TARGET_JOINTS[number]

export interface SceneEntity {
  id: string
  /** Position in the source scene's world coordinate system. */
  position: CanonicalVector3
  /** Optional facing direction around the world-up axis, in radians. */
  headingRadians?: number | undefined
}

export interface SceneCoordinateTransform {
  /** Source-world origin corresponding to ARDY world [0, 0, 0]. */
  origin?: CanonicalVector3 | undefined
  /** Uniform source-world-unit to ARDY-meter conversion. Defaults to 1. */
  scale?: number | undefined
}

export interface MotionEntityTarget {
  entityId: string
  timeMs: number
  joint?: ArdyTargetJoint | undefined
  /** Source-world offset from the target entity, e.g. hand-to-surface. */
  offset?: CanonicalVector3 | undefined
}

export interface SceneEntityRegistryOptions {
  entities?: readonly SceneEntity[] | undefined
  transform?: SceneCoordinateTransform | undefined
}

/**
 * Owns live scene entities separately from semantic embeddings. Moving a known
 * target changes only the kinematic constraint; the action prompt/cache key is
 * intentionally untouched, so the same embedding can guide a new target pose.
 */
export class SceneEntityRegistry {
  readonly #entities = new Map<string, SceneEntity>()
  readonly #origin: CanonicalVector3
  readonly #scale: number

  constructor(options: SceneEntityRegistryOptions = {}) {
    const transform = validateTransform(options.transform)
    this.#origin = transform.origin
    this.#scale = transform.scale
    for (const entity of options.entities ?? []) this.upsert(entity)
  }

  upsert(input: SceneEntity): SceneEntity {
    const entity = validateEntity(input)
    this.#entities.set(entity.id, entity)
    return cloneEntity(entity)
  }

  remove(id: string): boolean {
    return this.#entities.delete(requireIdentifier(id, 'scene entity id'))
  }

  get(id: string): SceneEntity | undefined {
    const entity = this.#entities.get(requireIdentifier(id, 'scene entity id'))
    return entity === undefined ? undefined : cloneEntity(entity)
  }

  snapshot(): readonly SceneEntity[] {
    return [...this.#entities.values()].map(cloneEntity)
  }

  resolveTarget(input: MotionEntityTarget): ArdyKinematicConstraint {
    const target = validateTarget(input)
    const entity = this.#entities.get(target.entityId)
    if (entity === undefined) throw new Error(`Scene target is not registered: ${target.entityId}`)
    const offset = target.offset ?? [0, 0, 0]
    const sourcePosition: CanonicalVector3 = [
      entity.position[0] + offset[0],
      entity.position[1] + offset[1],
      entity.position[2] + offset[2],
    ]
    const result: ArdyKinematicConstraint = {
      timeMs: target.timeMs,
      joint: target.joint,
      position: this.#toArdyPosition(sourcePosition),
    }
    if (target.joint === 'Hips' && entity.headingRadians !== undefined) {
      result.rotation = headingToQuaternion(entity.headingRadians)
    }
    return result
  }

  #toArdyPosition(position: CanonicalVector3): CanonicalVector3 {
    return [
      (position[0] - this.#origin[0]) * this.#scale,
      (position[1] - this.#origin[1]) * this.#scale,
      (position[2] - this.#origin[2]) * this.#scale,
    ]
  }
}

function validateTransform(value: SceneCoordinateTransform | undefined): {
  origin: CanonicalVector3
  scale: number
} {
  if (value === undefined) return { origin: [0, 0, 0], scale: 1 }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Scene coordinate transform must be an object')
  }
  const keys = Object.keys(value).sort()
  const expected = [
    ...(value.origin === undefined ? [] : ['origin']),
    ...(value.scale === undefined ? [] : ['scale']),
  ].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('Scene coordinate transform contains unknown fields')
  }
  const origin = value.origin === undefined ? [0, 0, 0] as CanonicalVector3 : requireVector(value.origin, 'scene transform origin')
  const scale = value.scale === undefined ? 1 : value.scale
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0 || scale > 1_000) {
    throw new Error('Scene transform scale must be a finite number from 0 through 1000')
  }
  return { origin, scale }
}

function validateEntity(value: SceneEntity): SceneEntity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Scene entity must be an object')
  const keys = Object.keys(value).sort()
  const expected = [
    'id',
    'position',
    ...(value.headingRadians === undefined ? [] : ['headingRadians']),
  ].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('Scene entity contains unknown fields')
  }
  const headingRadians = value.headingRadians
  if (headingRadians !== undefined && (!Number.isFinite(headingRadians) || Math.abs(headingRadians) > Math.PI * 8)) {
    throw new Error('Scene entity headingRadians must be a finite reasonable angle')
  }
  return {
    id: requireIdentifier(value.id, 'scene entity id'),
    position: requireVector(value.position, 'scene entity position'),
    ...(headingRadians === undefined ? {} : { headingRadians }),
  }
}

interface ValidatedMotionEntityTarget {
  entityId: string
  timeMs: number
  joint: ArdyTargetJoint
  offset?: CanonicalVector3 | undefined
}

function validateTarget(value: MotionEntityTarget): ValidatedMotionEntityTarget {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Motion entity target must be an object')
  const keys = Object.keys(value).sort()
  const expected = [
    'entityId',
    'timeMs',
    ...(value.joint === undefined ? [] : ['joint']),
    ...(value.offset === undefined ? [] : ['offset']),
  ].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('Motion entity target contains unknown fields')
  }
  const joint = value.joint ?? 'RightHand'
  if (!ARDY_TARGET_JOINTS.includes(joint)) throw new Error('Motion entity target joint is unsupported')
  if (!Number.isSafeInteger(value.timeMs) || value.timeMs < 0 || value.timeMs > 30_000) {
    throw new Error('Motion entity target timeMs must be an integer from 0 through 30000')
  }
  return {
    entityId: requireIdentifier(value.entityId, 'motion entity target id'),
    timeMs: value.timeMs,
    joint,
    ...(value.offset === undefined ? {} : { offset: requireVector(value.offset, 'motion entity target offset') }),
  }
}

function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/u.test(value)) {
    throw new Error(`${name} must be a safe identifier`)
  }
  return value
}

function requireVector(value: unknown, name: string): CanonicalVector3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
    throw new Error(`${name} must be a finite 3D vector`)
  }
  return [value[0], value[1], value[2]]
}

function headingToQuaternion(headingRadians: number): CanonicalQuaternion {
  const half = headingRadians / 2
  return [0, Math.sin(half), 0, Math.cos(half)]
}

function cloneEntity(entity: SceneEntity): SceneEntity {
  return {
    id: entity.id,
    position: [...entity.position] as CanonicalVector3,
    ...(entity.headingRadians === undefined ? {} : { headingRadians: entity.headingRadians }),
  }
}
