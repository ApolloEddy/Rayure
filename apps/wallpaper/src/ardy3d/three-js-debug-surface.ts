import type { CanonicalMotion, CanonicalMotionFrame, MotionDescriptor } from '@rayure/protocol'
import { ThreeMmdLoader } from '@yohawing/three-mmd-loader/three'
import {
  AmbientLight,
  Bone,
  Box3,
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  Material,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Skeleton,
  SkinnedMesh,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import { CanonicalMotionPlayer } from '../live2d/canonical-motion-client.ts'
import type { Live2dParameterSink } from '../live2d/rig-profile.ts'
import { disposeThreeObjectResources } from '../three-resource-disposal.ts'
import { CanonicalMotionRigAdapter } from './canonical-rig-adapter.ts'
import { loadCoreSkinModel } from './core-skin-loader.ts'
import type { CoreSkinModel } from './core-skin-loader.ts'
import { detectRigPositionScale, scaleCanonicalFrame } from './rig-scale.ts'

/**
 * Local debug route served by the Vite dev/preview plugin; see vite.config.ts.
 * Kept machine-independent so the debug surface and visual preflight never
 * embed an absolute path into source or the production entry chunk.
 */
export const DEFAULT_CORE_SKIN_URL = '/@rayure-assets/core-skin-data.json'

export type Ardy3dModelKind = 'core-skin' | 'pmx'

export interface Ardy3dDebugSurfaceOptions {
  /** PMX URL (tokenized loopback asset or `/@fs/` in dev). Absent → CoreSkin mannequin. */
  modelUrl?: string
  /** CoreSkin JSON fixture URL; defaults to the Vite dev asset route. */
  coreSkinUrl?: string
  /** Explicit scale override; auto-detected (meters vs MMD centimeters) otherwise. */
  positionScaleOverride?: number
  onSnapshot?: (snapshot: Ardy3dDebugSnapshot) => void
  onGeneratedMotionPlayback?: (observation: {
    motionId: string
    phase: 'started' | 'progress' | 'completed' | 'cancelled'
    frameIndex: number
  }) => void
}

export interface Ardy3dDebugSnapshot {
  mode: 'ardy-3d'
  modelLoaded: boolean
  modelKind: Ardy3dModelKind
  modelName: string
  boneCount: number
  resolvedJointCount: number
  positionScale: number
  activeGeneratedMotionId?: string
  frameIndex?: number
  detail?: string
}

interface GeneratedPlaybackObservation {
  motionId: string
  phase: 'started' | 'progress' | 'completed' | 'cancelled'
  frameIndex: number
}

/**
 * Whether a mesh material references a texture that actually loaded.  A PMX
 * whose .png files were not shipped still loads — the loader tolerates the
 * failures — but the mesh ends up sampling an empty texture, i.e. black.
 * Untextured materials are usable (they render their color); only a broken
 * texture map forces the flat-material fallback.
 */
function hasUsableTexture(material: unknown): boolean {
  if (Array.isArray(material)) return material.every(hasUsableTexture)
  const map = (material as { map?: { image?: unknown } | null } | null | undefined)?.map
  if (map === null || map === undefined) return true
  const image = map.image
  if (image === null || image === undefined) return false
  if (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) {
    return image.complete && image.naturalWidth > 0
  }
  return true
}

/** True for the loader's black backface-outline materials (kept for silhouette). */
function isBlackOutline(material: unknown): boolean {
  if (Array.isArray(material)) return material.every(isBlackOutline)
  const m = material as { type?: string; color?: Color } | null | undefined
  return m?.type === 'MeshBasicMaterial' && (m.color?.getHex() ?? 0xffffff) <= 0x0a0a0a
}

/**
 * Debug-mannequin policy: a PMX export whose textures failed to load (or were
 * never shipped) reads as an empty scene — its flat materials are the model's
 * own dark colors, and its single-sided shell shows only front faces.  Swap
 * every material that does not carry a genuinely usable texture (keeping only
 * the black silhouette outlines) to a bright double-sided mannequin gray so
 * the rig is legible.  This surface verifies the motion, not the texture art.
 */
function isDebugMannequinReplacement(material: Material): boolean {
  if (isBlackOutline(material)) return false
  const map = (material as { map?: unknown | null }).map
  return map === null || map === undefined || !hasUsableTexture(material)
}

/**
 * Parallel debug surface that plays the same runtime-generated Canonical
 * Motion as the Live2D surface, but on a 3D humanoid rig (ARDY's CoreSkeleton27
 * mapping).  It owns an isolated WebGLRenderer + scene so it never touches the
 * frozen PMX/VMD baseline (`MmdModelHost`/`scene.ts`).
 *
 * Two model sources:
 * - **CoreSkin mannequin** (default): the official ARDY test mesh built from
 *   the exported fixture.  Numeric ground truth — the same LBS math ARDY
 *   computes, verified in canonical-rig-adapter.test.ts.
 * - **PMX model** (阿贝多.pmx in dev, or any CoreSkeleton27-mappable MMD
 *   model): loaded with the frozen baseline's `ThreeMmdLoader`, then every
 *   bone is frozen and driven with absolute ARDY world poses.
 *
 * Driving model: the {@link CanonicalMotionRigAdapter} writes each resolved
 * bone's `matrixWorld` as an absolute world pose (`T(pos)·R(rot)`), which is
 * exactly ARDY's `CoreSkin.lbs()` reference math; the renderer's skinning
 * shader then evaluates `matrixWorld ⊗ boneInverse`.  Position scaling converts
 * ARDY meters to the model's native unit (MMD centimeters) when needed.
 */
export class Ardy3dDebugSurface implements Live2dParameterSink {
  readonly #container: HTMLElement
  readonly #modelUrl: string | undefined
  readonly #coreSkinUrl: string
  readonly #positionScaleOverride: number | undefined
  readonly #onSnapshot: ((snapshot: Ardy3dDebugSnapshot) => void) | undefined
  readonly #onGeneratedMotionPlayback: Ardy3dDebugSurfaceOptions['onGeneratedMotionPlayback']
  readonly #loader = new ThreeMmdLoader()

  #renderer: WebGLRenderer | undefined
  #scene: Scene | undefined
  #camera: PerspectiveCamera | undefined
  #controls: OrbitControls | undefined
  #wrapper: HTMLDivElement | undefined
  #modelRoot: Group | undefined
  #skeletons: Skeleton[] = []
  #adapter: CanonicalMotionRigAdapter | undefined
  #generated: CanonicalMotionPlayer | undefined
  #modelKind: Ardy3dModelKind = 'core-skin'
  #modelName = 'CoreSkin27 (ARDY mannequin)'
  #boneCount = 0
  #positionScale = 1
  #modelLoaded = false
  #modelError: string | undefined
  #animationFrame: number | undefined
  #resizeObserver: ResizeObserver | undefined
  #lastRenderedAt = 0
  #lastSnapshotAt = 0
  #lastResizeW = 0
  #lastResizeH = 0
  #lastPlayback: GeneratedPlaybackObservation | undefined
  #reframeOnPose = false
  #disposed = false

  constructor(container: HTMLElement, options: Ardy3dDebugSurfaceOptions) {
    this.#container = container
    this.#modelUrl = options.modelUrl
    this.#coreSkinUrl = options.coreSkinUrl ?? DEFAULT_CORE_SKIN_URL
    this.#positionScaleOverride = options.positionScaleOverride
    this.#onSnapshot = options.onSnapshot
    this.#onGeneratedMotionPlayback = options.onGeneratedMotionPlayback
  }

  async start(): Promise<boolean> {
    if (this.#disposed) return false
    this.#emit({
      mode: 'ardy-3d',
      modelLoaded: false,
      modelKind: this.#modelKind,
      modelName: this.#modelName,
      boneCount: 0,
      resolvedJointCount: 0,
      positionScale: this.#positionScale,
      detail: 'Initializing WebGL renderer',
    })
    try {
      const renderer = new WebGLRenderer({ antialias: true, alpha: false })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.setClearColor(0x0d0f14, 1)

      const wrapper = document.createElement('div')
      wrapper.className = 'ardy-3d-surface'
      wrapper.append(renderer.domElement)
      this.#container.append(wrapper)
      this.#wrapper = wrapper
      this.#renderer = renderer

      const scene = new Scene()
      scene.name = 'rayure-ardy-3d'
      scene.add(new AmbientLight(0xffffff, 0.8))
      const key = new DirectionalLight(0xffffff, 2.4)
      key.position.set(1.5, 2.5, 1.8)
      scene.add(key)
      this.#scene = scene

      const camera = new PerspectiveCamera(50, 1, 0.01, 1000)
      this.#camera = camera

      const controls = new OrbitControls(camera, renderer.domElement)
      controls.enableDamping = true
      controls.dampingFactor = 0.08
      controls.rotateSpeed = 0.9
      this.#controls = controls

      this.#resize()
      if (typeof ResizeObserver !== 'undefined') {
        this.#resizeObserver = new ResizeObserver(() => this.#resize())
        this.#resizeObserver.observe(wrapper)
      }

      if (this.#modelUrl !== undefined) {
        await this.#loadPmx(this.#modelUrl)
      }
      else {
        await this.#loadCoreSkin()
      }
      if (this.#disposed) return false

      this.#frameCamera()
      this.#addGroundGrid()
      // Settle the world-matrix walk once.  The first scene render propagates a
      // forced recompute to every bone (identity-pose × local); after this pass
      // the walk stops forcing, so the frozen absolute `matrixWorld` poses the
      // adapter writes are never recompounded through an ancestor.
      renderer.render(scene, camera)

      this.#generated = new CanonicalMotionPlayer(this)
      this.#lastRenderedAt = performance.now()
      this.#animationFrame = requestAnimationFrame(this.#render)
      // Re-frame to the driven pose on the first applied frame (see
      // {@link onMotionFrame}); until then the bind framing above stands in.
      this.#reframeOnPose = true
      this.#emit(this.#snapshot())
      return true
    }
    catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      this.#modelError = detail
      this.#emit({
        mode: 'ardy-3d',
        modelLoaded: false,
        modelKind: this.#modelKind,
        modelName: this.#modelName,
        boneCount: this.#boneCount,
        resolvedJointCount: 0,
        positionScale: this.#positionScale,
        detail,
      })
      this.dispose()
      return false
    }
  }

  /** No-op: the 3D rig is driven exclusively through {@link onMotionFrame}. */
  setParameterValue(_parameterId: string, _value: number): void {}

  /** Applies one interpolated canonical frame to the rig (scale-adjusted). */
  onMotionFrame(frame: CanonicalMotionFrame): void {
    if (this.#disposed) return
    this.#adapter?.onMotionFrame(scaleCanonicalFrame(frame, this.#positionScale))
    // The first applied frame is the first moment the driven pose exists: frame
    // the camera to it (the pre-pose framing uses the bind `Box3`, whose extent
    // differs from the driven pose).  One-shot so the camera stays put while
    // the motion plays; `playGeneratedMotion` re-arms it per new motion.
    if (this.#reframeOnPose) {
      this.#reframeOnPose = false
      this.#frameCameraToDrivenPose()
    }
  }

  get isReady(): boolean {
    return !this.#disposed && this.#modelLoaded && this.#adapter !== undefined
  }

  get modelKind(): Ardy3dModelKind {
    return this.#modelKind
  }

  get positionScale(): number {
    return this.#positionScale
  }

  get resolvedJointCount(): number {
    return this.#adapter?.resolvedJointCount ?? 0
  }

  get isPlaying(): boolean {
    return this.#generated?.isPlaying === true
  }

  get activeMotionId(): string | undefined {
    return this.#generated?.activeDescriptor?.id
  }

  get frameIndex(): number {
    return this.#generated?.consumedFrameCount ?? 0
  }

  /** Current world pose of a canonical joint (ARDY units), or `undefined`. */
  worldMatrix(jointName: string) {
    return this.#adapter?.worldMatrix(jointName)
  }

  /** All loaded bone names, for rig-mapping diagnostics. */
  get boneNames(): readonly string[] {
    return this.#adapter?.boneNames ?? []
  }

  /** World pose of any loaded bone by exact name (rig-mapping diagnostics). */
  boneWorldMatrix(boneName: string) {
    return this.#adapter?.boneWorldMatrix(boneName)
  }

  /** Plays a fetched Canonical Motion onto the 3D rig. */
  playGeneratedMotion(motion: CanonicalMotion, descriptor: MotionDescriptor): boolean {
    if (this.#disposed || !this.#generated || descriptor.format !== 'canonical') return false
    this.#generated.stop()
    const started = this.#generated.play(motion, descriptor)
    if (started) {
      this.#reframeOnPose = true
      this.#emitGeneratedPlayback(descriptor.id, 'started', 0, true)
    }
    return started
  }

  stopGeneratedMotion(): void {
    const generated = this.#generated
    const descriptor = generated?.activeDescriptor
    if (generated === undefined || descriptor === undefined) return
    const frameIndex = generated.consumedFrameCount
    generated.stop()
    this.#emitGeneratedPlayback(descriptor.id, 'cancelled', frameIndex, true)
  }

  snapshot(): Ardy3dDebugSnapshot {
    return this.#snapshot()
  }

  /**
   * The live three.js scene (undefined before start / after dispose).  Exposed
   * so external diagnostics can inspect model meshes and materials in place.
   */
  get debugScene(): Scene | undefined {
    return this.#scene ?? undefined
  }

  /**
   * The active perspective camera (undefined before start / after dispose), for
   * diagnostic framing checks.
   */
  get debugCamera(): PerspectiveCamera | undefined {
    return this.#camera ?? undefined
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#animationFrame !== undefined) cancelAnimationFrame(this.#animationFrame)
    this.#animationFrame = undefined
    this.#resizeObserver?.disconnect()
    this.#resizeObserver = undefined
    this.#controls?.dispose()
    this.#controls = undefined
    this.#generated?.dispose()
    this.#generated = undefined
    this.#adapter?.dispose()
    this.#adapter = undefined
    const renderer = this.#renderer
    if (renderer !== undefined) {
      renderer.dispose()
      renderer.domElement.remove()
    }
    this.#renderer = undefined
    if (this.#modelRoot !== undefined) {
      try {
        disposeThreeObjectResources(this.#modelRoot)
      }
      catch {
        // A partially-loaded model may not expose all GPU resources yet.
      }
    }
    this.#modelRoot = undefined
    this.#skeletons = []
    this.#wrapper?.remove()
    this.#wrapper = undefined
    this.#modelLoaded = false
    this.#scene = undefined
    this.#camera = undefined
  }

  async #loadCoreSkin(): Promise<void> {
    const model: CoreSkinModel = await loadCoreSkinModel(this.#coreSkinUrl)
    this.#modelRoot = model.root
    this.#skeletons = [model.skeleton]
    this.#adapter = new CanonicalMotionRigAdapter({ bones: model.skeleton.bones })
    this.#modelKind = 'core-skin'
    this.#modelName = 'CoreSkin27 (ARDY mannequin)'
    this.#boneCount = model.skeleton.bones.length
    this.#positionScale = 1
    this.#modelLoaded = true
    this.#scene?.add(model.root)
  }

  async #loadPmx(url: string): Promise<void> {
    const model = await this.#loader.loadModel(url, { outline: true, materialRenderOrder: true })
    const root = model.root
    const bones: Bone[] = []
    const seen = new Set<string>()
    const skeletons = new Set<Skeleton>()
    root.traverse((node) => {
      if (node instanceof SkinnedMesh) {
        skeletons.add(node.skeleton)
        for (const bone of node.skeleton.bones) {
          if (!seen.has(bone.name)) {
            seen.add(bone.name)
            bones.push(bone)
          }
        }
      }
    })
    if (bones.length === 0) throw new Error('PMX model exposes no skinned mesh to drive')
    // Freeze every bone so the scene walk never recomposes the absolute world
    // poses the adapter writes (undriven bones stay in their bind pose).
    for (const bone of bones) {
      bone.matrixAutoUpdate = false
      bone.matrixWorldNeedsUpdate = false
    }
    this.#modelRoot = root
    this.#skeletons = [...skeletons]
    // Game-extracted PMX exports frequently reference textures that are not
    // shipped next to the model (albedo.pmx loads without its .png files), so
    // every material ends up a flat dark color that reads as an empty scene.
    // Render the rig as a bright double-sided mannequin instead — keep only
    // genuinely-textured materials and the black silhouette outlines — since
    // this surface exists to verify the motion, not the texture art.
    let replacedMaterials = 0
    root.traverse((node) => {
      if (!(node instanceof SkinnedMesh)) return
      const isArray = Array.isArray(node.material)
      const materials = isArray ? node.material : [node.material]
      let changed = false
      for (let i = 0; i < materials.length; i += 1) {
        if (!isDebugMannequinReplacement(materials[i])) continue
        materials[i] = new MeshStandardMaterial({
          color: 0xb8c0c8,
          emissive: 0x2a333c,
          roughness: 0.85,
          metalness: 0,
          side: DoubleSide,
        })
        replacedMaterials += 1
        changed = true
      }
      if (changed && !isArray) node.material = materials[0]
    })
    this.#adapter = new CanonicalMotionRigAdapter({ bones })
    this.#modelKind = 'pmx'
    this.#modelName = replacedMaterials > 0
      ? `PMX model · ${replacedMaterials} material(s) → mannequin (textures missing)`
      : 'PMX model (CoreSkeleton27 mapping)'
    this.#boneCount = bones.length
    // ARDY world poses are meters; MMD PMX models are authored in centimeters.
    // Detect the native unit from the hips bind height before any driving.
    const hips = this.#adapter.resolve('hips')
    const hipsBindHeight = hips?.matrixWorld.elements[13] ?? Number.NaN
    this.#positionScale = this.#positionScaleOverride ?? detectRigPositionScale(hipsBindHeight)
    this.#modelLoaded = true
    this.#scene?.add(root)
  }

  /** Frames the stage around `center` with the rig filling ~96% of the view. */
  #frameCameraAround(center: Vector3, radius: number): void {
    const camera = this.#camera
    if (camera === undefined) return
    // Fill the stage: at fov 50 a distance of 2.2r leaves ~2% headroom, so the
    // whole rig stays in frame without looking lost in a dark void.
    const distance = Math.max(radius * 2.2, 0.1)
    camera.near = Math.max(distance / 1000, 0.001)
    camera.far = distance * 100
    camera.position.set(
      center.x + distance * 0.6,
      center.y + distance * 0.35,
      center.z + distance,
    )
    camera.lookAt(center)
    camera.updateProjectionMatrix()
    this.#controls?.target.copy(center)
  }

  #frameCamera(): void {
    const root = this.#modelRoot
    if (root === undefined) return
    const bounds = new Box3().setFromObject(root)
    const center = bounds.getCenter(new Vector3())
    const size = bounds.getSize(new Vector3())
    this.#frameCameraAround(center, Math.max(size.x, size.y, size.z) * 0.5)
  }

  /**
   * Frames the camera to the current *driven* pose — the world positions of the
   * resolved CoreSkeleton27 joints — instead of the bind `Box3`.  A model whose
   * bind pose differs from the driven ARDY stance (arms spread, or a small
   * non-MMD rig) would otherwise leave the figure tiny or off-frame.  Falls back
   * to the bind framing before any frame has been applied.
   */
  #frameCameraToDrivenPose(): void {
    const adapter = this.#adapter
    if (adapter === undefined) { this.#frameCamera(); return }
    const min = new Vector3(Infinity, Infinity, Infinity)
    const max = new Vector3(-Infinity, -Infinity, -Infinity)
    let resolved = 0
    for (const matrix of adapter.coreWorldMatrices) {
      if (matrix === undefined) continue
      const e = matrix.elements
      const x = e[12], y = e[13], z = e[14]
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      min.x = Math.min(min.x, x); min.y = Math.min(min.y, y); min.z = Math.min(min.z, z)
      max.x = Math.max(max.x, x); max.y = Math.max(max.y, y); max.z = Math.max(max.z, z)
      resolved += 1
    }
    if (resolved === 0) { this.#frameCamera(); return }
    const center = min.clone().add(max).multiplyScalar(0.5)
    const halfSize = max.clone().sub(min).multiplyScalar(0.5)
    // Joints only bound the skeleton; pad so mesh that hangs off the driven
    // bones (hair, skirt, hands) stays inside the frame.
    const radius = Math.max(halfSize.x, halfSize.y, halfSize.z) * 1.25 + 0.3
    this.#frameCameraAround(center, radius)
  }

  #addGroundGrid(): void {
    const root = this.#modelRoot
    const scene = this.#scene
    if (root === undefined || scene === undefined) return
    const bounds = new Box3().setFromObject(root)
    const size = bounds.getSize(new Vector3())
    const span = Math.max(size.x, size.z, 1)
    const grid = new GridHelper(span * 2.4, 12, 0x3c4352, 0x232a36)
    grid.position.y = bounds.min.y
    grid.position.x = bounds.getCenter(new Vector3()).x
    scene.add(grid)
  }

  readonly #resize = (): void => {
    const renderer = this.#renderer
    const wrapper = this.#wrapper
    const camera = this.#camera
    if (renderer === undefined || wrapper === undefined) return
    const width = Math.max(1, wrapper.clientWidth)
    const height = Math.max(1, wrapper.clientHeight)
    if (width === this.#lastResizeW && height === this.#lastResizeH) return
    this.#lastResizeW = width
    this.#lastResizeH = height
    renderer.setSize(width, height)
    if (camera !== undefined) {
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    // Reframe on window resize so the rig stays centered and fills the stage
    // instead of drifting out of view; `start()` frames once the model loads.
    if (this.#modelLoaded) this.#frameCameraToDrivenPose()
  }

  readonly #render = (timestamp: number): void => {
    if (this.#disposed || this.#renderer === undefined) return
    this.#animationFrame = requestAnimationFrame(this.#render)
    const deltaSeconds = Math.min(Math.max(0, timestamp - this.#lastRenderedAt) / 1000, 0.1)
    this.#lastRenderedAt = timestamp

    const generated = this.#generated
    if (generated?.isPlaying === true) {
      const descriptor = generated.activeDescriptor
      generated.advance(deltaSeconds)
      if (descriptor !== undefined) {
        const frameIndex = generated.consumedFrameCount
        if (generated.isPlaying) {
          this.#emitGeneratedPlayback(descriptor.id, 'progress', frameIndex)
        }
        else {
          this.#emitGeneratedPlayback(descriptor.id, 'completed', frameIndex, true)
        }
      }
    }

    // THREE's Skeleton.update() is what recomposes `boneMatrices = matrixWorld ⊗
    // boneInverse` from the adapter-written poses; the renderer only uploads the
    // buffer, it never computes it.  Skip this and the mesh stays in bind pose.
    for (const skeleton of this.#skeletons) skeleton.update()
    this.#controls?.update()
    this.#renderer.render(this.#scene ?? new Scene(), this.#camera ?? new PerspectiveCamera())

    if (timestamp - this.#lastSnapshotAt >= 100) {
      this.#lastSnapshotAt = timestamp
      this.#emit(this.#snapshot())
    }
  }

  #emitGeneratedPlayback(
    motionId: string,
    phase: 'started' | 'progress' | 'completed' | 'cancelled',
    frameIndex: number,
    force = false,
  ): void {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) return
    const last = this.#lastPlayback
    if (!force && last?.motionId === motionId && last.frameIndex === frameIndex) return
    this.#lastPlayback = { motionId, phase, frameIndex }
    try {
      this.#onGeneratedMotionPlayback?.({ motionId, phase, frameIndex })
    }
    catch {
      // Diagnostics telemetry never owns the render loop.
    }
  }

  #snapshot(): Ardy3dDebugSnapshot {
    const active = this.#generated?.activeDescriptor
    const snapshot: Ardy3dDebugSnapshot = {
      mode: 'ardy-3d',
      modelLoaded: this.#modelLoaded,
      modelKind: this.#modelKind,
      modelName: this.#modelName,
      boneCount: this.#boneCount,
      resolvedJointCount: this.#adapter?.resolvedJointCount ?? 0,
      positionScale: this.#positionScale,
    }
    if (active !== undefined) snapshot.activeGeneratedMotionId = active.id
    const frameIndex = this.#generated?.consumedFrameCount
    if (frameIndex !== undefined && frameIndex > 0) snapshot.frameIndex = frameIndex
    if (this.#modelError !== undefined) snapshot.detail = this.#modelError
    return snapshot
  }

  #emit(snapshot: Ardy3dDebugSnapshot): void {
    try {
      this.#onSnapshot?.(snapshot)
    }
    catch {
      // Diagnostics callbacks cannot own the surface lifecycle.
    }
  }
}
