import {
  createLive2dDebugMotion,
} from './debug-probe.ts'
import type {
  CanonicalMotion,
  CanonicalMotionFrame,
  CanonicalVector3,
  Live2dMotionDescriptor,
  MotionDescriptor,
} from '@rayure/protocol'
import {
  DEFAULT_LIVE2D_CORE_URL,
  resolveLive2dCoreUrl,
} from './core-source.ts'
import { parseLive2dModel3 } from './model-manifest.ts'
import { CanonicalMotionPlayer } from './canonical-motion-client.ts'
import { Live2dMotionController } from './motion-controller.ts'
import type { Live2dMotionModelLike } from './motion-controller.ts'
import { Live2dMotionPlayer } from './motion-player.ts'
import type { Live2dNeutralPose, Live2dParameterSink, Live2dRigProfile } from './rig-profile.ts'
import { resolveLive2dRigProfile } from './rig-profile.ts'
import {
  Live2dExpressionController,
} from './expression-controller.ts'
import {
  createParameterCrossfade,
  sampleParameterCrossfade,
} from './parameter-crossfade.ts'
import type { ParameterCrossfade } from './parameter-crossfade.ts'

const coreScriptLoads = new Map<string, Promise<void>>()
const GENERATED_MOTION_BLEND_MS = 180
const POSE_RESTORE_FADE_MS = 320

interface NativePoseBlend {
  startedAtMs: number
  durationMs: number
  from: ReadonlyMap<string, number>
  target: ReadonlyMap<string, number>
}

interface NativeLive2dModel {
  load(link: string): Promise<void>
  update(): void
  resize(): void
  destroy(destroyCubism?: boolean): void
  startMotion(
    group: string,
    index: number,
    priority: number,
    onStartMotion?: () => void,
    onEndMotion?: () => void,
  ): Promise<unknown>
  stopMotions(): void
  getMotions?(): readonly string[]
  getExpressions?(): readonly string[]
  setExpression?(expression: string): void
  expressionManager?: { stopAllMotions(): void }
  setParameter(parameterId: string, value: number): void
  setPartOpacity?(partId: string, opacity: number): void
  getParameterNames?(): readonly string[]
  getParameterValue?(parameterId: string): number
}

export interface Live2dParameterRange {
  id: string
  min: number
  max: number
  defaultValue: number
}

export interface Live2dNativeSnapshot {
  mode: 'native-cubism'
  nativeModelLoaded: boolean
  modelUrl: string
  coreUrl: string
  parameterIds: readonly string[]
  parameters: Readonly<Record<string, number>>
  expressionIds: readonly string[]
  activeExpressionId?: string
  activeMotionId?: string
  activeGeneratedMotionId?: string
  detail?: string
}

export interface Live2dNativeSurfaceOptions {
  modelUrl: string
  coreUrl?: string
  /** Enable the synthetic Canonical Motion fixture only for explicit debug runs. */
  debugFallback?: boolean
  /** Parts belonging to a source scene/effect layer, hidden in skin-only mode. */
  skinHiddenPartIds?: readonly string[]
  /** Show source scene/effect parts for an explicit native-content import. */
  showNativeParts?: boolean
  /** Calibrated initial pose applied on load and restored after motions end. */
  neutralPose?: Live2dNeutralPose
  /** Calibrated ARDY rig bindings; overrides sentinel-based profile resolution. */
  rigProfile?: Live2dRigProfile
  onSnapshot?: (snapshot: Live2dNativeSnapshot) => void
  onGeneratedMotionPlayback?: (observation: {
    motionId: string
    phase: 'started' | 'progress' | 'completed' | 'cancelled'
    frameIndex: number
  }) => void
}

export function selectLive2dInteractionMotion(
  motions: readonly Live2dMotionDescriptor[],
  verticalRatio: number,
): Live2dMotionDescriptor | undefined {
  const preferredGroups = verticalRatio < 0.46
    ? ['touch_head', 'taphead', 'head']
    : ['touch_body', 'tapbody', 'body']
  for (const group of preferredGroups) {
    const match = motions.find(motion => motion.group.trim().toLocaleLowerCase() === group)
    if (match !== undefined) return match
  }
  return motions.find(motion => motion.group.trim().toLocaleLowerCase().startsWith(preferredGroups[0]!))
}

/**
 * Native Cubism surface. It receives a tokenized or local model URL from
 * Companion or an explicit developer query, so no private model path or model
 * bytes are placed in the application bundle.
 */
export class Live2dNativeSurface implements Live2dParameterSink {
  readonly #container: HTMLElement
  readonly #modelUrl: string
  readonly #coreUrl: string
  readonly #debugFallbackEnabled: boolean
  readonly #skinHiddenPartIds: readonly string[]
  readonly #showNativeParts: boolean
  readonly #neutralPose: Live2dNeutralPose | undefined
  readonly #rigProfile: Live2dRigProfile | undefined
  readonly #onSnapshot: ((snapshot: Live2dNativeSnapshot) => void) | undefined
  readonly #onGeneratedMotionPlayback: Live2dNativeSurfaceOptions['onGeneratedMotionPlayback']
  readonly #motion = createLive2dDebugMotion()
  readonly #nativeMotion = new Live2dMotionController()
  readonly #expression = new Live2dExpressionController()
  #canvas: HTMLCanvasElement | undefined
  #model: NativeLive2dModel | undefined
  #modelReady = false
  #player: Live2dMotionPlayer | undefined
  #generatedMotion: CanonicalMotionPlayer | undefined
  #animationFrame: number | undefined
  #resizeObserver: ResizeObserver | undefined
  #lastRenderedAt = 0
  #lastSnapshotAt = 0
  #parameterIds: readonly string[] = []
  #parameters = new Map<string, number>()
  #motionCatalog: readonly Live2dMotionDescriptor[] = []
  #parameterOwner: 'none' | 'native' | 'generated' | 'debug' = 'none'
  #parameterBlend: ParameterCrossfade | undefined
  #poseBlend: NativePoseBlend | undefined
  #idleRestorePending = false
  #lastGeneratedPlayback: { motionId: string, frameIndex: number } | undefined
  #generatedRootOrigin: CanonicalVector3 | undefined
  #generatedRootAnchorOffset = { x: 0, y: 0 }
  #canvasMotionOffset = { x: 0, y: 0 }
  #speechMouthValue = 0
  #speechMouthParameterId: string | undefined
  #pointerDownAt: { x: number, y: number } | undefined
  #disposed = false

  constructor(container: HTMLElement, options: Live2dNativeSurfaceOptions) {
    if (!options.modelUrl || !options.modelUrl.trim()) throw new Error('Live2D native model URL is required')
    this.#container = container
    this.#modelUrl = options.modelUrl
    this.#coreUrl = resolveLive2dCoreUrl(options.coreUrl, window.location.href) ?? DEFAULT_LIVE2D_CORE_URL
    this.#debugFallbackEnabled = options.debugFallback === true
    this.#skinHiddenPartIds = [...new Set(options.skinHiddenPartIds ?? [])]
    this.#showNativeParts = options.showNativeParts === true
    this.#neutralPose = options.neutralPose
    this.#rigProfile = options.rigProfile
    this.#onSnapshot = options.onSnapshot
    this.#onGeneratedMotionPlayback = options.onGeneratedMotionPlayback
  }

  async start(): Promise<boolean> {
    if (this.#disposed) return false
    this.#emit({
      mode: 'native-cubism',
      nativeModelLoaded: false,
      modelUrl: this.#modelUrl,
      coreUrl: this.#coreUrl,
      parameterIds: [],
      parameters: {},
      expressionIds: [],
      detail: 'Loading Cubism Core and model',
    })
    try {
      const modelResponse = await fetch(this.#modelUrl, {
        cache: 'no-store',
        credentials: 'omit',
      })
      if (!modelResponse.ok) {
        throw new Error(`Live2D model3 request failed with HTTP ${modelResponse.status}`)
      }
      parseLive2dModel3(await modelResponse.json())
      await ensureCoreScript(this.#coreUrl)

      const { Live2DCubismModel } = await import('live2d-renderer')
      const canvas = document.createElement('canvas')
      canvas.className = 'live2d-native-canvas'
      canvas.setAttribute('aria-label', 'Live2D native model')
      this.#container.append(canvas)
      this.#canvas = canvas
      canvas.addEventListener('pointerdown', this.#onPointerDown, { passive: true })
      canvas.addEventListener('pointerup', this.#onPointerUp, { passive: true })
      if (typeof ResizeObserver !== 'undefined') {
        this.#resizeObserver = new ResizeObserver(() => this.#resize())
        this.#resizeObserver.observe(this.#container)
      }
      this.#resize()

      const model = new Live2DCubismModel(canvas, {
        autoAnimate: false,
        autoInteraction: true,
        tapInteraction: true,
        randomMotion: false,
        // The library's keepAspect mode crops this full-viewport canvas and
        // shifts the model on wide windows. Its projection already handles
        // the viewport aspect when keepAspect is disabled.
        keepAspect: false,
        zoomEnabled: true,
        enablePan: true,
        cubismCorePath: this.#coreUrl,
        enableMotion: false,
        enableExpression: true,
        enableLipsync: false,
      }) as unknown as NativeLive2dModel
      this.#model = model
      await model.load(this.#modelUrl)
      if (this.#disposed) return false
      this.#expression.bindModel({
        getExpressions: () => model.getExpressions?.() ?? [],
        setExpression: (expression) => {
          if (model.setExpression === undefined) throw new Error('Live2D expression API is unavailable')
          model.setExpression(expression)
        },
        stopExpressions: () => {
          if (model.expressionManager === undefined) throw new Error('Live2D expression manager is unavailable')
          model.expressionManager.stopAllMotions()
        },
      })
      this.#modelReady = true
      this.#applySkinPartVisibility(model)
      this.#nativeMotion.bindModel(model)
      this.#parameterIds = [...(model.getParameterNames?.() ?? [])]
      this.#speechMouthParameterId = this.#parameterIds.find(parameterId => /mouth.*open|open.*mouth|mouthopeny/iu.test(parameterId))
      const rigProfile = this.#rigProfile ?? resolveLive2dRigProfile(this.#parameterIds)
      this.#player = new Live2dMotionPlayer(this, rigProfile, this.#neutralPose)
      this.#generatedMotion = new CanonicalMotionPlayer(this, rigProfile, this.#neutralPose)
      window.addEventListener('resize', this.#resize, { passive: true })
      this.#lastRenderedAt = performance.now()
      this.#animationFrame = requestAnimationFrame(this.#render)
      this.#resize()
      this.#applyNeutralPose(0)
      this.#emit(this.#snapshot())
      return true
    }
    catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      this.#emit({
        mode: 'native-cubism',
        nativeModelLoaded: false,
        modelUrl: this.#modelUrl,
        coreUrl: this.#coreUrl,
        parameterIds: [],
        parameters: {},
        expressionIds: [],
        detail,
      })
      this.dispose()
      return false
    }
  }

  setParameterValue(parameterId: string, value: number): void {
    if (
      this.#disposed
      || !this.#modelReady
      || !this.#model
      || !parameterId
      || !Number.isFinite(value)
      || !this.#parameterIds.includes(parameterId)
    ) return
    const appliedValue = this.#parameterOwner === 'generated'
      ? this.#blendGeneratedParameter(parameterId, value)
      : value
    this.#model.setParameter(parameterId, appliedValue)
    this.#parameters.set(parameterId, appliedValue)
  }

  setExpression(name: string, weight: number, durationMs?: number): boolean {
    if (this.#disposed || !this.#modelReady || !this.#model) return false
    return this.#expression.setExpression(name, weight, durationMs)
  }

  resetExpression(durationMs?: number): boolean {
    if (this.#disposed || !this.#modelReady || !this.#model) return false
    return this.#expression.reset(durationMs)
  }

  onMotionFrame(frame: CanonicalMotionFrame): void {
    if (this.#disposed || this.#parameterOwner !== 'generated') return
    this.#applyGeneratedRootPosition(frame.rootPosition)
  }

  get isReady(): boolean {
    return !this.#disposed && this.#modelReady && this.#model !== undefined
  }

  /** Sets the renderer-owned speech mouth channel; motion parameter writes stay separate. */
  setSpeechMouthValue(value: number): void {
    if (!Number.isFinite(value)) return
    this.#speechMouthValue = Math.min(1, Math.max(0, value))
  }

  /** Calibration: write a parameter directly for visual trial, bypassing the motion adapter. */
  previewParameter(parameterId: string, value: number): boolean {
    if (!this.#modelReady || !this.#model || !this.#parameterIds.includes(parameterId) || !Number.isFinite(value)) {
      return false
    }
    this.#model.setParameter(parameterId, value)
    this.#parameters.set(parameterId, value)
    return true
  }

  getParameterRanges(): readonly Live2dParameterRange[] {
    if (!this.#modelReady) return []
    const model = this.#model as unknown as {
      parameters?: {
        ids?: readonly string[]
        defaultValues?: readonly number[]
        minimumValues?: readonly number[]
        maximumValues?: readonly number[]
      }
    } | undefined
    const parameters = model?.parameters
    if (parameters?.ids === undefined) return []
    const ranges: Live2dParameterRange[] = []
    const seen = new Set<string>()
    for (const [index, id] of parameters.ids.entries()) {
      const min = parameters.minimumValues?.[index] ?? -1
      const max = parameters.maximumValues?.[index] ?? 1
      const defaultValue = parameters.defaultValues?.[index] ?? 0
      if (
        typeof id !== 'string'
        || id.length < 1
        || id.length > 128
        || id.trim() !== id
        || /[\u0000-\u001F\u007F]/u.test(id)
        || seen.has(id)
        || !Number.isFinite(min)
        || !Number.isFinite(max)
        || !Number.isFinite(defaultValue)
        || min >= max
        || defaultValue < min
        || defaultValue > max
      ) continue
      seen.add(id)
      ranges.push({ id, min, max, defaultValue })
    }
    return ranges
  }

  getPartIds(): readonly string[] {
    if (!this.#modelReady) return []
    const model = this.#model as unknown as { parts?: { ids?: readonly string[] } } | undefined
    return [...new Set((model?.parts?.ids ?? []).filter(id => (
      typeof id === 'string'
      && id.length > 0
      && id.length <= 128
      && id.trim() === id
      && !/[\u0000-\u001F\u007F]/u.test(id)
    )))]
  }

  setPartOpacity(partId: string, opacity: number): boolean {
    if (
      !this.#modelReady
      || !this.#model?.setPartOpacity
      || !this.getPartIds().includes(partId)
      || !Number.isFinite(opacity)
      || opacity < 0
      || opacity > 1
    ) return false
    this.#model.setPartOpacity(partId, opacity)
    return true
  }

  resetParameterDefaults(): void {
    if (!this.#modelReady || !this.#model) return
    const model = this.#model as unknown as { resetParameters?: () => void } | undefined
    model?.resetParameters?.()
    this.#parameters.clear()
  }

  getParameterValue(parameterId: string): number | undefined {
    if (!this.#modelReady || !this.#model) return undefined
    return this.#model.getParameterValue?.(parameterId) ?? this.#parameters.get(parameterId)
  }

  updateMotionCatalog(motions: readonly MotionDescriptor[]): void {
    if (this.#disposed) return
    const nextCatalog = motions.filter((motion): motion is Live2dMotionDescriptor => motion.format === 'live2d')
    this.#motionCatalog = nextCatalog
    if (nextCatalog.length === 0 && this.#nativeMotion.isPlaying) this.disableNativeMotion()
  }

  /** Stop source motions without starting the development-only fixture. */
  disableNativeMotion(): void {
    if (this.#disposed) return
    this.#nativeMotion.stopMotion()
    if (this.#parameterOwner === 'native') {
      this.#parameterOwner = 'none'
      this.#parameterBlend = undefined
      this.#applyNeutralPose(POSE_RESTORE_FADE_MS)
    }
  }

  playMotion(descriptor: MotionDescriptor): Promise<boolean> {
    if (this.#disposed || descriptor.format !== 'live2d') return Promise.resolve(false)
    if (this.#motionCatalog.length > 0 && !this.#motionCatalog.some(motion => motion.id === descriptor.id)) {
      return Promise.resolve(false)
    }
    this.#stopGeneratedMotion('cancelled', false)
    this.#resetGeneratedRootOffset()
    this.#player?.stop()
    this.#poseBlend = undefined
    this.#parameterOwner = 'native'
    this.#parameterBlend = undefined
    return this.#nativeMotion.playMotion(descriptor).then((started) => {
      if (!started && this.#parameterOwner === 'native') this.#startDebugFallback()
      return started
    })
  }

  playDefaultMotion(): Promise<boolean> {
    const defaultMotion = this.#motionCatalog.find(motion => motion.group.toLowerCase() === 'idle')
      ?? this.#motionCatalog[0]
    if (defaultMotion !== undefined) return this.playMotion(defaultMotion)
    if (!this.#debugFallbackEnabled) return Promise.resolve(false)
    this.#startDebugFallback()
    return Promise.resolve(true)
  }

  stopMotion(motionId?: string): void {
    if (motionId === undefined || this.#generatedMotion?.activeDescriptor?.id === motionId) {
      this.#stopGeneratedMotion('cancelled', true)
      if (motionId !== undefined) return
    }
    this.#nativeMotion.stopMotion(motionId)
    if (this.#debugFallbackEnabled && !this.#generatedMotion?.isPlaying && !this.#nativeMotion.isPlaying) {
      this.#startDebugFallback()
    }
  }

  /**
   * Plays a runtime-generated Canonical Motion fetched from the tokenized
   * loopback URL described by a `motion.published` message. Generated frames
   * take exclusive parameter ownership. Native and debug queues are stopped
   * first so a generated pose never has two parameter writers fighting it.
   */
  playGeneratedMotion(motion: CanonicalMotion, descriptor: MotionDescriptor): boolean {
    if (this.#disposed || !this.#generatedMotion || descriptor.format !== 'canonical') return false
    this.#stopGeneratedMotion('cancelled', false)
    this.#nativeMotion.stopMotion()
    this.#player?.stop()
    this.#poseBlend = undefined
    this.#parameterOwner = 'generated'
    this.#parameterBlend = createParameterCrossfade(
      this.#captureParameterValues(),
      performance.now(),
      GENERATED_MOTION_BLEND_MS,
    )
    this.#lastGeneratedPlayback = undefined
    this.#generatedRootOrigin = undefined
    this.#generatedRootAnchorOffset = { ...this.#canvasMotionOffset }
    const started = this.#generatedMotion.play(motion, descriptor)
    if (!started) {
      this.#parameterOwner = 'none'
      this.#parameterBlend = undefined
      void this.#restoreIdleMotion()
      return false
    }
    this.#emitGeneratedPlayback(descriptor.id, 'started', 0, true)
    return true
  }

  stopGeneratedMotion(): void {
    this.#stopGeneratedMotion('cancelled', true)
  }

  #stopGeneratedMotion(
    phase: 'cancelled',
    restoreIdle: boolean,
  ): void {
    const generated = this.#generatedMotion
    const descriptor = generated?.activeDescriptor
    if (generated === undefined || descriptor === undefined) return
    const frameIndex = generated.consumedFrameCount
    generated.stop()
    this.#emitGeneratedPlayback(descriptor.id, phase, frameIndex, true)
    this.#parameterOwner = 'none'
    this.#parameterBlend = undefined
    if (restoreIdle) void this.#restoreIdleMotion()
  }

  async #restoreIdleMotion(): Promise<void> {
    if (this.#disposed || this.#generatedMotion?.isPlaying || this.#idleRestorePending) return
    this.#idleRestorePending = true
    try {
      this.#resetGeneratedRootOffset()
      const restored = await this.playDefaultMotion()
      if (!restored && this.#debugFallbackEnabled && !this.#disposed && !this.#generatedMotion?.isPlaying) {
        this.#startDebugFallback()
      }
      // Skin-only mode has no native idle and no debug fixture: fade back to
      // the calibrated initial pose instead of freezing on the last frame.
      if (!restored && this.#parameterOwner === 'none') {
        this.#applyNeutralPose(POSE_RESTORE_FADE_MS)
      }
    }
    finally {
      this.#idleRestorePending = false
    }
  }

  #startDebugFallback(): void {
    if (!this.#debugFallbackEnabled || this.#disposed || !this.#player || this.#generatedMotion?.isPlaying) return
    this.#nativeMotion.stopMotion()
    this.#resetGeneratedRootOffset()
    this.#poseBlend = undefined
    this.#parameterOwner = 'debug'
    this.#parameterBlend = undefined
    if (!this.#player.isPlaying) {
      this.#player.bind(this.#motion)
      this.#player.advance(0)
    }
  }

  /**
   * Applies the calibrated initial pose. `fadeMs === 0` snaps the model into
   * the pose (used right after load); a positive duration crossfades from the
   * live values so returning to the pose after a motion reads as one move.
   * Without a calibration pose the model returns to its authored default
   * parameters instead of freezing on the last generated frame.
   */
  #applyNeutralPose(fadeMs: number): void {
    if (this.#disposed || !this.#modelReady || !this.#model) return
    const target = new Map<string, number>()
    for (const [parameterId, value] of Object.entries(this.#neutralPose ?? {})) {
      if (this.#parameterIds.includes(parameterId) && Number.isFinite(value)) {
        target.set(parameterId, value)
      }
    }
    if (target.size === 0) {
      this.resetParameterDefaults()
      return
    }
    if (fadeMs > 0) {
      this.#poseBlend = {
        startedAtMs: performance.now(),
        durationMs: fadeMs,
        from: this.#captureParameterValues(),
        target,
      }
      return
    }
    this.#poseBlend = undefined
    for (const [parameterId, value] of target) {
      this.#model.setParameter(parameterId, value)
      this.#parameters.set(parameterId, value)
    }
  }

  #tickPoseBlend(timestampMs: number): void {
    const blend = this.#poseBlend
    const model = this.#model
    if (blend === undefined || model === undefined) return
    const alpha = Math.min(1, Math.max(0, (timestampMs - blend.startedAtMs) / blend.durationMs))
    for (const [parameterId, target] of blend.target) {
      const source = blend.from.get(parameterId)
      const base = source !== undefined && Number.isFinite(source) ? source : target
      const value = base + (target - base) * alpha
      model.setParameter(parameterId, value)
      this.#parameters.set(parameterId, value)
    }
    if (alpha >= 1) this.#poseBlend = undefined
  }

  #applySkinPartVisibility(model: NativeLive2dModel): void {
    if (this.#showNativeParts || this.#skinHiddenPartIds.length === 0 || model.setPartOpacity === undefined) return
    const partIds = (model as unknown as { parts?: { ids?: readonly string[] } }).parts?.ids
    for (const partId of this.#skinHiddenPartIds) {
      if (partIds !== undefined && !partIds.includes(partId)) continue
      try {
        model.setPartOpacity(partId, 0)
      }
      catch {
        // A model-specific part may be absent in a later revision; keep the skin usable.
      }
    }
    model.update()
  }

  #captureParameterValues(): ReadonlyMap<string, number> {
    const values = new Map(this.#parameters)
    for (const parameterId of this.#parameterIds) {
      const value = this.#model?.getParameterValue?.(parameterId)
      if (value !== undefined && Number.isFinite(value)) values.set(parameterId, value)
    }
    return values
  }

  #blendGeneratedParameter(parameterId: string, target: number): number {
    const blend = this.#parameterBlend
    if (blend === undefined) return target
    const sample = sampleParameterCrossfade(blend, parameterId, target, performance.now())
    if (sample.done) {
      this.#parameterBlend = undefined
    }
    return sample.value
  }

  #applyGeneratedRootPosition(rootPosition: CanonicalVector3): void {
    if (this.#canvas === undefined) return
    if (this.#generatedRootOrigin === undefined) {
      this.#generatedRootOrigin = [...rootPosition] as CanonicalVector3
      this.#generatedRootAnchorOffset = { ...this.#canvasMotionOffset }
    }
    const origin = this.#generatedRootOrigin
    // ARDY world-space root deltas are centimetre-scale.  The old 0.12
    // multiplier turned a normal walk into a 1–2 px nudge on a 720 px stage;
    // this projection is deliberately calibrated for a 2D Live2D preview so
    // the generated forward/bob cue is visible without treating the canvas as
    // a 3D renderer.
    const pixelsPerWorldUnit = Math.min(this.#container.clientWidth, this.#container.clientHeight) * 1.8
    const maxX = this.#container.clientWidth * 0.3
    const maxY = this.#container.clientHeight * 0.22
    const x = clampCanvasOffset(this.#generatedRootAnchorOffset.x + (rootPosition[0] - origin[0]) * pixelsPerWorldUnit, maxX)
    // ARDY's forward axis is projected upward in the 2D stage, giving a
    // readable walk-forward cue without pretending the Cubism canvas is 3D.
    const y = clampCanvasOffset(this.#generatedRootAnchorOffset.y - (rootPosition[2] - origin[2]) * pixelsPerWorldUnit, maxY)
    this.#canvasMotionOffset = { x, y }
    this.#canvas.style.transition = 'none'
    this.#canvas.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`
  }

  #resetGeneratedRootOffset(): void {
    this.#generatedRootOrigin = undefined
    this.#generatedRootAnchorOffset = { x: 0, y: 0 }
    this.#canvasMotionOffset = { x: 0, y: 0 }
    const canvas = this.#canvas
    if (canvas === undefined) return
    canvas.style.transition = 'transform 180ms ease-out'
    canvas.style.transform = 'translate3d(0, 0, 0)'
    window.setTimeout(() => {
      if (!this.#disposed && this.#canvas === canvas) canvas.style.transition = ''
    }, 200)
  }

  #emitGeneratedPlayback(
    motionId: string,
    phase: 'started' | 'progress' | 'completed' | 'cancelled',
    frameIndex: number,
    force = false,
  ): void {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) return
    const last = this.#lastGeneratedPlayback
    if (!force && last?.motionId === motionId && last.frameIndex === frameIndex) return
    this.#lastGeneratedPlayback = { motionId, frameIndex }
    try {
      this.#onGeneratedMotionPlayback?.({ motionId, phase, frameIndex })
    }
    catch {
      // Renderer telemetry is diagnostic/continuity input, never a render-loop owner.
    }
  }

  snapshot(): Live2dNativeSnapshot {
    return this.#snapshot()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#animationFrame !== undefined) cancelAnimationFrame(this.#animationFrame)
    this.#animationFrame = undefined
    window.removeEventListener('resize', this.#resize)
    this.#resizeObserver?.disconnect()
    this.#resizeObserver = undefined
    this.#canvas?.removeEventListener('pointerdown', this.#onPointerDown)
    this.#canvas?.removeEventListener('pointerup', this.#onPointerUp)
    this.#modelReady = false
    this.#nativeMotion.dispose()
    this.#expression.dispose()
    this.#player?.dispose()
    this.#player = undefined
    this.#generatedMotion?.dispose()
    this.#generatedMotion = undefined
    this.#poseBlend = undefined
    try {
      this.#model?.destroy()
    }
    catch {
      // A failed Cubism initialization may not have a native model to release.
    }
    this.#model = undefined
    this.#parameters.clear()
    this.#speechMouthValue = 0
    this.#speechMouthParameterId = undefined
    this.#canvas?.remove()
    this.#canvas = undefined
  }

  readonly #render = (timestamp: number): void => {
    if (this.#disposed || !this.#modelReady || !this.#model || !this.#player) return
    this.#animationFrame = requestAnimationFrame(this.#render)
    const deltaSeconds = Math.min(Math.max(0, timestamp - this.#lastRenderedAt) / 1000, 0.1)
    this.#lastRenderedAt = timestamp
    const generated = this.#generatedMotion
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
          this.#parameterOwner = 'none'
          this.#parameterBlend = undefined
          void this.#restoreIdleMotion()
        }
      }
    }
    else if (this.#parameterOwner === 'native' && !this.#nativeMotion.isPlaying) {
      // Cubism motions can be one-shot even when their group is named Idle.
      // Re-enter the default slot once, guarded by #idleRestorePending, rather
      // than leaving a frozen final pose or restarting it every render frame.
      void this.#restoreIdleMotion()
    }
    else if (this.#player.isPlaying) {
      this.#parameterOwner = 'debug'
      this.#player.advance(deltaSeconds)
    }
    if (this.#parameterOwner === 'none') this.#tickPoseBlend(timestamp)
    const mouthParameterId = this.#speechMouthParameterId
    if (mouthParameterId !== undefined) {
      this.#model.setParameter(mouthParameterId, this.#speechMouthValue)
      this.#parameters.set(mouthParameterId, this.#speechMouthValue)
    }
    this.#model.update()
    if (timestamp - this.#lastSnapshotAt >= 100) {
      this.#lastSnapshotAt = timestamp
      this.#emit(this.#snapshot())
    }
  }

  readonly #resize = (): void => {
    if (this.#disposed || !this.#canvas || !this.#model || !this.#modelReady) return
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    this.#canvas.width = Math.max(1, Math.round(this.#container.clientWidth * ratio))
    this.#canvas.height = Math.max(1, Math.round(this.#container.clientHeight * ratio))
    this.#model.resize()
  }

  readonly #onPointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || this.#disposed) return
    this.#pointerDownAt = { x: event.clientX, y: event.clientY }
  }

  readonly #onPointerUp = (event: PointerEvent): void => {
    const start = this.#pointerDownAt
    this.#pointerDownAt = undefined
    if (!event.isPrimary || start === undefined || this.#disposed || !this.isReady) return
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y)
    if (moved > 18) return
    const canvas = this.#canvas
    if (canvas === undefined) return
    const rect = canvas.getBoundingClientRect()
    const verticalRatio = (event.clientY - rect.top) / Math.max(1, rect.height)
    const motion = selectLive2dInteractionMotion(this.#motionCatalog, verticalRatio)
    if (motion !== undefined) void this.playMotion(motion)
  }

  #snapshot(): Live2dNativeSnapshot {
    const parameters: Record<string, number> = {}
    for (const parameterId of this.#parameterIds.slice(0, 24)) {
      const value = this.#model?.getParameterValue?.(parameterId) ?? this.#parameters.get(parameterId)
      if (value !== undefined && Number.isFinite(value)) parameters[parameterId] = value
    }
    return {
      mode: 'native-cubism',
      nativeModelLoaded: this.#modelReady,
      modelUrl: this.#modelUrl,
      coreUrl: this.#coreUrl,
      parameterIds: this.#parameterIds,
      parameters,
      expressionIds: [...(this.#model?.getExpressions?.() ?? [])],
      ...(this.#expression.activeExpressionId === undefined ? {} : { activeExpressionId: this.#expression.activeExpressionId }),
      ...(this.#nativeMotion.activeMotionId === undefined ? {} : { activeMotionId: this.#nativeMotion.activeMotionId }),
      ...(this.#generatedMotion?.activeDescriptor === undefined
        ? {}
        : { activeGeneratedMotionId: this.#generatedMotion.activeDescriptor.id }),
    }
  }

  #emit(snapshot: Live2dNativeSnapshot): void {
    try {
      this.#onSnapshot?.(snapshot)
    }
    catch {
      // Diagnostics callbacks cannot own the model lifecycle.
    }
  }
}

function ensureCoreScript(url: string): Promise<void> {
  const existing = coreScriptLoads.get(url)
  if (existing) return existing

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.async = false
    script.src = url
    script.dataset.rayureCubismCore = 'true'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Cubism Core could not be loaded from ${url}`))
    ;(document.head ?? document.body).append(script)
  })
  coreScriptLoads.set(url, promise)
  promise.catch(() => {
    if (coreScriptLoads.get(url) === promise) coreScriptLoads.delete(url)
  })
  return promise
}

function clampCanvasOffset(value: number, maximum: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(maximum) || maximum <= 0) return 0
  return Math.min(maximum, Math.max(-maximum, value))
}
