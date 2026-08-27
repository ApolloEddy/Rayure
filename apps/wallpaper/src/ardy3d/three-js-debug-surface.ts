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
  Matrix4,
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
import { disposeMmdModel } from '../mmd-model-host.ts'
import { CanonicalMotionRigAdapter } from './canonical-rig-adapter.ts'
import { loadCoreSkinModel } from './core-skin-loader.ts'
import type { CoreSkinModel } from './core-skin-loader.ts'
import { detectRigPositionScale, scaleCanonicalFrame } from './rig-scale.ts'

/**
 * Dev-only route served by the Vite config plugin; see vite.config.ts
 * `rayureLocalAssetPlugin()`.  Kept machine-independent so the debug surface
 * and the Playwright E2E never embed an absolute path into source.
 */
export const DEFAULT_CORE_SKIN_URL = '/@rayure-assets/core-skin-data.json'

/**
 * Uploaded local PMX files above this size are rejected before parsing.  Game
 * exports land well under this (tens of MiB); the guard exists so a mis-chosen
 * multi-hundred-MB file cannot spike the renderer process into a GPU/tab crash
 * that blanks the whole debug page (the "white screen" symptom).
 */
export const ARDY_PMX_MAX_BYTES = 512 * 1024 * 1024

/** 1×1 transparent PNG — placeholder returned by the blob-URL texture resolver. */
const TRANSPARENT_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

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

/** Bind (rest) pose of a driven bone, captured before any motion frame writes. */
interface BindPose {
  matrix: Matrix4
  matrixWorld: Matrix4
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
  /** Bind (rest) pose per driven bone, so playback can return to a static pose. */
  #bindPoses = new Map<Bone, BindPose>()
  #loopEnabled = false
  #loopMotion: CanonicalMotion | undefined
  #loopDescriptor: MotionDescriptor | undefined
  /** Guards async model swaps; a superseded load result is dropped. */
  #swapGeneration = 0
  /**
   * Set while the WebGL context is lost (GPU process crash/driver reset).
   * Rendering pauses; on restore the loop resumes.  Without `preventDefault()`
   * on the lost event the browser would never fire the restored event, so a
   * failed GPU turns into a permanently blank canvas — the "white screen".
   */
  #contextLost = false

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
      // No antialias: MSAA multiplies the fill rate on top of the DPR scaling,
      // and the first full-res render of a heavy uploaded PMX is what crashed
      // the user's Edge GPU process (whole page white, browser restart needed).
      // A diagnostic rig reads fine aliased; a dead GPU reads worse.
      const renderer = new WebGLRenderer({ antialias: false, alpha: false })
      // Cap the pixel ratio at 1 for the debug surface: heavy game-export PMX
      // meshes (many bones/skinning) rendered at a 4K DPR multiply the GPU
      // fill-rate cost, and on a fragile GPU service that first full-res render
      // after an upload is exactly what crashed it into the white screen.  A
      // diagnostic surface does not need retina sharpness.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1))
      renderer.setClearColor(0x0d0f14, 1)

      const wrapper = document.createElement('div')
      wrapper.className = 'ardy-3d-surface'
      wrapper.append(renderer.domElement)
      this.#container.append(wrapper)
      this.#wrapper = wrapper
      this.#renderer = renderer
      // A lost WebGL context renders a dead canvas with no feedback.  Pause the
      // render loop, surface the failure, and restore when the browser recovers.
      // `preventDefault()` is what makes the restored event fire at all.
      renderer.domElement.addEventListener('webglcontextlost', this.#onContextLost, false)
      renderer.domElement.addEventListener('webglcontextrestored', this.#onContextRestored, false)

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
      // Bind world matrices are settled now; capture them as the rest pose so
      // `resetToIdle` can return the rig to a static stance after playback.
      this.#captureBindPoses()
      // Lock the composed bind world matrices so the per-render scene walk can
      // never recompound the adapter's absolute poses during playback.
      this.#freezeModelWorldMatrices()

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
    return !this.#disposed && !this.#contextLost && this.#modelLoaded && this.#adapter !== undefined
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
      // Remember the last successfully-bound motion so loop playback can rebind
      // it from the start on completion without re-fetching.
      this.#loopMotion = motion
      this.#loopDescriptor = descriptor
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

  /**
   * Loop playback: when the current (or most recently played) motion finishes,
   * it is rebound from frame 0 instead of stopping.  Toggling off mid-playback
   * lets the current pass run to completion, then stops as usual.
   */
  setLoop(enabled: boolean): void {
    this.#loopEnabled = enabled
  }

  get loopEnabled(): boolean {
    return this.#loopEnabled
  }

  /**
   * Returns the rig to its bind (rest) pose — the character's static stance.
   * Restores the captured bind matrices on every driven bone and re-skins so
   * the mesh reads as a motionless figure instead of freezing on the last
   * driven frame.
   */
  resetToIdle(): void {
    const generated = this.#generated
    if (generated !== undefined) generated.stop()
    if (this.#bindPoses.size === 0) return
    for (const [bone, pose] of this.#bindPoses) {
      bone.matrix.copy(pose.matrix)
      bone.matrixWorld.copy(pose.matrixWorld)
      bone.matrixAutoUpdate = false
      bone.matrixWorldNeedsUpdate = false
    }
    for (const skeleton of this.#skeletons) skeleton.update()
  }

  /** Swaps the debug model: `'core-skin'` reloads the mannequin, any other URL loads that PMX. */
  async loadModelFromUrl(url: string): Promise<boolean> {
    if (this.#disposed) return false
    const generation = ++this.#swapGeneration
    this.#disposeModel()
    try {
      if (url === 'core-skin' || url === '') {
        await this.#loadCoreSkin()
      }
      else {
        await this.#loadPmx(url)
      }
      if (this.#disposed || generation !== this.#swapGeneration) return false
      this.#frameCamera()
      this.#addGroundGrid()
      this.#renderer?.render(this.#scene ?? new Scene(), this.#camera ?? new PerspectiveCamera())
      this.#captureBindPoses()
      this.#freezeModelWorldMatrices()
      this.#reframeOnPose = true
      this.#emit(this.#snapshot())
      return true
    }
    catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      this.#modelError = detail
      this.#modelLoaded = false
      this.#emit({
        mode: 'ardy-3d',
        modelLoaded: false,
        modelKind: this.#modelKind,
        modelName: this.#modelName,
        boneCount: 0,
        resolvedJointCount: 0,
        positionScale: this.#positionScale,
        detail,
      })
      return false
    }
  }

  /** Loads a local PMX from an uploaded ArrayBuffer (debug model picker). */
  async loadModelFromArrayBuffer(buffer: ArrayBuffer, name: string): Promise<boolean> {
    if (this.#disposed) return false
    if (buffer.byteLength > ARDY_PMX_MAX_BYTES) {
      this.#modelError = `PMX 文件过大（${(buffer.byteLength / 1048576).toFixed(1)} MiB > ${ARDY_PMX_MAX_BYTES / 1048576} MiB 上限）— 已拒绝，防止渲染进程崩溃`
      this.#emit(this.#snapshot())
      return false
    }
    let url = ''
    try {
      const blob = new Blob([buffer], { type: 'application/octet-stream' })
      url = URL.createObjectURL(blob)
      const ok = await this.loadModelFromUrl(url)
      if (ok) this.#modelName = `PMX file · ${name}`
      return ok
    }
    finally {
      if (url.length > 0) URL.revokeObjectURL(url)
    }
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
    this.#swapGeneration += 1
    if (this.#animationFrame !== undefined) cancelAnimationFrame(this.#animationFrame)
    this.#animationFrame = undefined
    this.#resizeObserver?.disconnect()
    this.#resizeObserver = undefined
    this.#controls?.dispose()
    this.#controls = undefined
    this.#generated?.dispose()
    this.#generated = undefined
    this.#disposeModel()
    const renderer = this.#renderer
    if (renderer !== undefined) {
      renderer.dispose()
      renderer.domElement.remove()
    }
    this.#renderer = undefined
    this.#wrapper?.remove()
    this.#wrapper = undefined
    this.#scene = undefined
    this.#camera = undefined
  }

  /** Tears down the current model so another can take its place (also on dispose). */
  #disposeModel(): void {
    this.#generated?.stop()
    this.#adapter?.dispose()
    this.#adapter = undefined
    this.#skeletons = []
    this.#bindPoses.clear()
    this.#loopMotion = undefined
    this.#loopDescriptor = undefined
    const root = this.#modelRoot
    if (root !== undefined) {
      this.#scene?.remove(root)
      try {
        // disposeMmdModel only reads `root` and `runtime`; the loader's runtime
        // is never started on this surface, so an empty runtime is a no-op.
        disposeMmdModel({ root, runtime: {} } as unknown as import('../mmd-model-host.ts').LoadableMmdModel)
      }
      catch {
        // A partially-loaded model may not expose all GPU resources yet.
      }
    }
    this.#modelRoot = undefined
    this.#modelLoaded = false
  }

  /**
   * Records every bone's current matrix/matrixWorld as the static rest pose.
   * Called once the model is loaded and world matrices are settled but before
   * any motion frame has been applied, so `resetToIdle` can restore it.  All
   * bones are captured (not just the resolved subset) because undriven bones
   * never change and restoring them is a harmless no-op.
   */
  #captureBindPoses(): void {
    this.#bindPoses.clear()
    for (const skeleton of this.#skeletons) {
      for (const bone of skeleton.bones) {
        this.#bindPoses.set(bone, {
          matrix: bone.matrix.clone(),
          matrixWorld: bone.matrixWorld.clone(),
        })
      }
    }
  }

  /**
   * Locks every node in the model subtree so three.js never recomposes world
   * matrices from local transforms.  The rig is driven by absolute `matrixWorld`
   * poses that {@link CanonicalMotionRigAdapter} writes; the per-render scene
   * walk otherwise recompounds every bone through its (possibly non-driven)
   * intermediate ancestors — `Object3D.updateMatrixWorld` checks
   * `matrixWorldAutoUpdate` before multiplying `parent.matrixWorld × matrix`,
   * so a single flagged node forces that compose across the whole hierarchy and
   * the driven poses get clobbered until the local matrices converge.  Must run
   * after the bind-settle render and {@link #captureBindPoses} — the one pass
   * that is allowed to compose the bind pose.
   */
  #freezeModelWorldMatrices(): void {
    const root = this.#modelRoot
    if (root === undefined) return
    root.traverse((node) => {
      node.matrixAutoUpdate = false
      node.matrixWorldAutoUpdate = false
      node.matrixWorldNeedsUpdate = false
    })
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
    // A PMX uploaded through the debug model picker is materialized as a blob
    // URL, whose opaque origin makes the loader's adjacent-texture resolution
    // (`new URL('skin.bmp', 'blob:…')`) throw `Invalid URL`.  Game-exported
    // PMX reference textures we do not ship anyway, so resolve every texture to
    // a transparent placeholder and let the mannequin material fallback below
    // carry the rig — HTTP-served models keep their normal adjacent-texture
    // resolution.  NOTE: the loader wraps this resolver in createTextureResolver,
    // whose `?? resolveAdjacentTexture` fallback makes `undefined` a trap (it
    // falls through and re-throws on the blob URL), so a truthy value is required.
    const loader = url.startsWith('blob:')
      ? new ThreeMmdLoader({
          textureResolver: { resolve: async () => TRANSPARENT_PNG_DATA_URL },
        })
      : this.#loader
    const model = await loader.loadModel(url, { outline: true, materialRenderOrder: true })
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
          // Bright emissive so the rig reads clearly against the dark stage —
          // this surface exists to verify the motion, not the texture art, and a
          // silhouette that washes into the background is useless for that.
          emissive: 0x68747e,
          roughness: 0.7,
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

  /**
   * WebGL context lost (GPU process crash / driver reset): pause the loop and
   * surface the failure on the snapshot so the debug panel stops claiming the
   * model is alive behind a blank canvas.  The canvas's own `oncontextlost`
   * default (context never restored) is suppressed so recovery can happen.
   */
  readonly #onContextLost = (event: Event): void => {
    event.preventDefault()
    if (this.#disposed || this.#contextLost) return
    this.#contextLost = true
    if (this.#animationFrame !== undefined) {
      cancelAnimationFrame(this.#animationFrame)
      this.#animationFrame = undefined
    }
    this.#modelError = 'WebGL 上下文丢失（GPU 进程可能崩溃）— 渲染已暂停，等待浏览器恢复…'
    this.#emit(this.#snapshot())
  }

  readonly #onContextRestored = (): void => {
    if (this.#disposed || !this.#contextLost) return
    this.#contextLost = false
    if (this.#modelError?.includes('WebGL 上下文丢失')) this.#modelError = undefined
    const renderer = this.#renderer
    if (renderer !== undefined) {
      // Re-upload the scene's GPU buffers (wiped by the context loss).
      renderer.render(this.#scene ?? new Scene(), this.#camera ?? new PerspectiveCamera())
    }
    this.#lastRenderedAt = performance.now()
    this.#animationFrame = requestAnimationFrame(this.#render)
    this.#emit(this.#snapshot())
  }

  readonly #render = (timestamp: number): void => {
    if (this.#disposed || this.#contextLost || this.#renderer === undefined) return
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
        else if (this.#loopEnabled && this.#loopMotion !== undefined && this.#loopDescriptor !== undefined) {
          // Loop playback: rebind the same motion from frame 0 instead of
          // stopping.  The player has just finished, so this is a clean restart.
          generated.play(this.#loopMotion, this.#loopDescriptor)
          this.#reframeOnPose = true
          this.#emitGeneratedPlayback(this.#loopDescriptor.id, 'started', 0, true)
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
