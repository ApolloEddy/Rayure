import { ThreeMmdLoader } from '@yohawing/three-mmd-loader'
import type { ModelDescriptor, MotionDescriptor } from '@rayure/protocol'
import {
  Bone,
  Box3,
  Group,
  Material,
  Mesh,
  SkinnedMesh,
  Texture,
  Vector3,
} from 'three'

import { ExpressionController } from './expression-controller.ts'
import type { ExpressionControllerOptions } from './expression-controller.ts'
import { MotionController } from './motion-controller.ts'
import type { MmdMotionLoaderLike } from './motion-controller.ts'
import { EmoteController } from './emote-controller.ts'
import type { PlayEmoteOptions } from './emote-controller.ts'
import { remapModelBones } from './bone-remapper.ts'

export interface LoadableMmdModel {
  readonly root: Group
  readonly mesh?: Mesh | SkinnedMesh
  readonly runtime: {
    dispose?(): void
    clearAnimation?(): void
  }
  setAnimation?(animation: any): void
  clearAnimation?(): void
  update(seconds: number): unknown
}

export interface MmdModelLoaderLike extends MmdMotionLoaderLike {
  loadModel(
    source: string,
    options?: {
      outline?: boolean
      materialRenderOrder?: boolean
      signal?: AbortSignal
    },
  ): Promise<LoadableMmdModel>
}

export type MmdModelLoadOutcome = 'committed' | 'failed' | 'superseded' | 'unchanged'

export interface MmdModelStatus {
  phase: 'placeholder' | 'loading' | 'ready' | 'error'
  modelId?: string
  displayName?: string
  detail?: string
}

export interface MmdModelHostOptions {
  loader?: MmdModelLoaderLike | undefined
  targetHeight?: number | undefined
  floorY?: number | undefined
  expressionOptions?: ExpressionControllerOptions | undefined
  onStatus?: ((status: MmdModelStatus) => void) | undefined
}

interface ModelBones {
  chest?: Bone | undefined
  head?: Bone | undefined
}

interface ActiveModel {
  key: string
  descriptor: ModelDescriptor
  model: LoadableMmdModel
  wrapper: Group
  bones: ModelBones
  expression?: ExpressionController | undefined
}

interface PendingLoad {
  key: string
  generation: number
  controller: AbortController
  promise: Promise<MmdModelLoadOutcome>
}

export class MmdModelHost {
  readonly #mount: Group
  readonly #loader: MmdModelLoaderLike
  readonly #targetHeight: number
  readonly #floorY: number
  readonly #expressionOptions: ExpressionControllerOptions | undefined
  readonly #motion: MotionController
  readonly #onStatus: ((status: MmdModelStatus) => void) | undefined
  #generation = 0
  #active: ActiveModel | undefined
  #pending: PendingLoad | undefined
  #emote: EmoteController | undefined
  #motionCatalog: readonly MotionDescriptor[] = []
  #elapsedSeconds = 0
  #runtimeFailed = false
  #disposed = false

  constructor(mount: Group, options: MmdModelHostOptions = {}) {
    this.#mount = mount
    this.#loader = options.loader ?? new ThreeMmdLoader()
    this.#targetHeight = requireFinitePositive(options.targetHeight ?? 3.4, 'targetHeight')
    this.#floorY = requireFinite(options.floorY ?? -1.7, 'floorY')
    this.#expressionOptions = options.expressionOptions
    this.#onStatus = options.onStatus
    this.#motion = new MotionController({ loader: this.#loader })
    this.#emit({ phase: 'placeholder' })
  }

  get activeModelId(): string | undefined {
    return this.#active?.descriptor.id
  }

  get hasActiveModel(): boolean {
    return this.#active !== undefined
  }

  get expression(): ExpressionController | undefined {
    return this.#active?.expression
  }

  get motion(): MotionController {
    return this.#motion
  }

  get emote(): EmoteController | undefined {
    return this.#emote
  }

  updateMotionCatalog(motions: readonly MotionDescriptor[]): void {
    this.#motionCatalog = motions
    this.#emote?.updateCatalog(motions)
  }

  playEmote(options: PlayEmoteOptions): Promise<boolean> {
    if (this.#disposed || !this.#emote) return Promise.resolve(false)
    return this.#emote.playEmote(options)
  }

  playMotion(descriptor: MotionDescriptor): Promise<boolean> {
    if (this.#disposed || !this.#active) return Promise.resolve(false)
    return this.#motion.playMotion(descriptor)
  }

  stopMotion(motionId?: string): void {
    if (this.#disposed) return
    this.#motion.stopMotion(motionId)
  }

  setExpression(name: string, weight: number, durationMs?: number): void {
    if (this.#disposed || !this.#active?.expression) return
    this.#active.expression.setExpression(name, weight, durationMs)
  }

  resetExpression(durationMs?: number): void {
    if (this.#disposed || !this.#active?.expression) return
    this.#active.expression.reset(durationMs)
  }

  setAutoBlink(enabled: boolean): void {
    if (this.#disposed || !this.#active?.expression) return
    this.#active.expression.autoBlink = enabled
  }

  load(descriptor: ModelDescriptor): Promise<MmdModelLoadOutcome> {
    if (this.#disposed) return Promise.resolve('superseded')
    const key = modelKey(descriptor)
    if (this.#active?.key === key) return Promise.resolve('unchanged')
    if (this.#pending?.key === key) return this.#pending.promise

    this.#pending?.controller.abort()
    const generation = ++this.#generation
    const controller = new AbortController()
    this.#emit({
      phase: 'loading',
      modelId: descriptor.id,
      displayName: descriptor.displayName,
    })
    const promise = this.#performLoad(descriptor, key, generation, controller.signal)
    this.#pending = { key, generation, controller, promise }
    return promise
  }

  advance(deltaSeconds: number, pointerX?: number, pointerY?: number): void {
    if (
      this.#disposed
      || this.#runtimeFailed
      || !this.#active
      || !Number.isFinite(deltaSeconds)
      || deltaSeconds <= 0
    ) return

    // 限制单帧最大时间步长，避免大跨步导致物理发散
    const safeDelta = Math.min(deltaSeconds, 0.1)

    const motionTime = this.#motion.isPlaying
      ? this.#motion.advance(safeDelta)
      : (this.#elapsedSeconds += safeDelta)

    try {
      this.#active.model.update(motionTime)
    }
    catch {
      this.#runtimeFailed = true
      this.#emit({
        phase: 'error',
        modelId: this.#active.descriptor.id,
        displayName: this.#active.descriptor.displayName,
        detail: 'Model runtime update failed; the last rendered pose is preserved.',
      })
    }

    // 仅在完全未播放动作且处于空闲时进行非常轻柔的视线辅助，绝不与动画骨骼冲突
    if (!this.#motion.isPlaying && this.#active.bones.head && pointerX !== undefined && pointerY !== undefined) {
      const targetY = pointerX * 0.12
      const targetX = -pointerY * 0.08
      this.#active.bones.head.rotation.y = targetY * 0.5
      this.#active.bones.head.rotation.x = targetX * 0.5
    }

    try {
      this.#active.expression?.advance(safeDelta)
    }
    catch {
      // Expression failures never break the render frame.
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#generation += 1
    this.#pending?.controller.abort()
    this.#pending = undefined
    this.#motion.dispose()
    this.#emote?.dispose()
    this.#emote = undefined
    const active = this.#active
    this.#active = undefined
    if (active) disposeActiveModel(active)
  }

  async #performLoad(
    descriptor: ModelDescriptor,
    key: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<MmdModelLoadOutcome> {
    try {
      const model = await this.#loader.loadModel(descriptor.url, {
        outline: true,
        materialRenderOrder: true,
        signal,
      })
      if (!this.#isCurrent(generation)) {
        disposeMmdModel(model)
        return 'superseded'
      }

      let wrapper: Group
      try {
        wrapper = fitModel(model.root, this.#targetHeight, this.#floorY)
      }
      catch {
        disposeMmdModel(model)
        this.#emit({
          phase: 'error',
          modelId: descriptor.id,
          displayName: descriptor.displayName,
          detail: 'Model has no finite visible bounds.',
        })
        return 'failed'
      }

      const previous = this.#active
      this.#mount.add(wrapper)

      const morphMesh = model.mesh ?? findMorphMesh(model.root)
      const expression = morphMesh
        ? new ExpressionController(morphMesh, this.#expressionOptions)
        : undefined

      remapModelBones(model.root)
      const bones = findModelBones(model.root)

      this.#motion.bindModel(model)
      this.#emote?.dispose()
      if (expression) {
        this.#emote = new EmoteController(this.#motion, expression)
        if (this.#motionCatalog.length > 0) {
          this.#emote.updateCatalog(this.#motionCatalog)
        }
      }
      else {
        this.#emote = undefined
      }

      this.#active = { key, descriptor, model, wrapper, bones, expression }
      this.#elapsedSeconds = 0
      this.#runtimeFailed = false
      if (previous) disposeActiveModel(previous)
      this.#emit({
        phase: 'ready',
        modelId: descriptor.id,
        displayName: descriptor.displayName,
      })
      return 'committed'
    }
    catch {
      if (!this.#isCurrent(generation) || signal.aborted) return 'superseded'
      this.#emit({
        phase: 'error',
        modelId: descriptor.id,
        displayName: descriptor.displayName,
        detail: 'Model loading failed; the previous scene was preserved.',
      })
      return 'failed'
    }
    finally {
      if (this.#pending?.generation === generation) this.#pending = undefined
    }
  }

  #isCurrent(generation: number): boolean {
    return !this.#disposed && generation === this.#generation
  }

  #emit(status: MmdModelStatus): void {
    try {
      this.#onStatus?.(status)
    }
    catch {
      // Presentation callbacks never own model resources or load sequencing.
    }
  }
}

function findMorphMesh(root: Group): Mesh | SkinnedMesh | undefined {
  let found: Mesh | SkinnedMesh | undefined
  root.traverse((node) => {
    if (!found && node instanceof Mesh && node.morphTargetDictionary && Object.keys(node.morphTargetDictionary).length > 0) {
      found = node
    }
  })
  return found
}

function fitModel(root: Group, targetHeight: number, floorY: number): Group {
  root.updateMatrixWorld(true)
  const bounds = new Box3().setFromObject(root)
  const size = bounds.getSize(new Vector3())
  const center = bounds.getCenter(new Vector3())
  if (
    bounds.isEmpty()
    || !Number.isFinite(size.x)
    || !Number.isFinite(size.y)
    || !Number.isFinite(size.z)
    || size.y <= 1e-6
  ) {
    throw new Error('Model bounds are empty or invalid')
  }

  const scale = targetHeight / size.y
  const wrapper = new Group()
  wrapper.name = 'rayure-mmd-model'
  wrapper.scale.setScalar(scale)
  wrapper.position.set(
    -center.x * scale,
    floorY - bounds.min.y * scale,
    -center.z * scale,
  )
  wrapper.add(root)
  return wrapper
}

function disposeActiveModel(active: ActiveModel): void {
  active.wrapper.removeFromParent()
  disposeMmdModel(active.model)
}

export function disposeMmdModel(model: LoadableMmdModel): void {
  model.root.removeFromParent()
  try {
    if (typeof model.runtime.dispose === 'function') model.runtime.dispose()
    else model.runtime.clearAnimation?.()
  }
  catch {
    // Continue releasing GPU resources even if runtime disposal reports an error.
  }

  const geometries = new Set<{ dispose(): void }>()
  const materials = new Set<Material>()
  const textures = new Set<Texture>()
  const skeletons = new Set<{ dispose(): void }>()
  model.root.traverse((node) => {
    if (node instanceof Mesh) {
      geometries.add(node.geometry)
      const nodeMaterials = Array.isArray(node.material) ? node.material : [node.material]
      for (const material of nodeMaterials) {
        materials.add(material)
        for (const value of Object.values(material)) {
          if (value instanceof Texture && value.userData.mmdTextureOwnership === 'loader') {
            textures.add(value)
          }
        }
      }
    }
    if (node instanceof SkinnedMesh) skeletons.add(node.skeleton)
  })
  for (const skeleton of skeletons) skeleton.dispose()
  for (const geometry of geometries) geometry.dispose()
  for (const material of materials) material.dispose()
  for (const texture of textures) texture.dispose()
  model.root.clear()
}

function modelKey(descriptor: ModelDescriptor): string {
  return `${descriptor.id}\u0000${descriptor.url}`
}

function requireFinitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a finite positive number`)
  return value
}

function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`)
  return value
}

function findModelBones(root: Group): ModelBones {
  const bones: ModelBones = {}
  root.traverse((child) => {
    if (child instanceof Bone || (child as unknown as { isBone?: boolean }).isBone) {
      const name = child.name.toLowerCase()
      if (!bones.chest && (name.includes('上半身') || name.includes('spine') || name.includes('chest'))) {
        bones.chest = child as Bone
      }
      if (!bones.head && (name.includes('頭') || name.includes('head') || name.includes('首') || name.includes('neck'))) {
        bones.head = child as Bone
      }
    }
  })
  return bones
}
