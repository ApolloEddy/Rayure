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
import type { Live2dParameterSink } from './rig-profile.ts'

const coreScriptLoads = new Map<string, Promise<void>>()
const GENERATED_MOTION_BLEND_MS = 180

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
  setParameter(parameterId: string, value: number): void
  getParameterNames?(): readonly string[]
  getParameterValue?(parameterId: string): number
}

export interface Live2dNativeDebugSnapshot {
  mode: 'native-cubism'
  nativeModelLoaded: boolean
  modelUrl: string
  coreUrl: string
  parameterIds: readonly string[]
  parameters: Readonly<Record<string, number>>
  activeMotionId?: string
  activeGeneratedMotionId?: string
  detail?: string
}

export interface Live2dNativeDebugSurfaceOptions {
  modelUrl: string
  coreUrl?: string
  onSnapshot?: (snapshot: Live2dNativeDebugSnapshot) => void
  onGeneratedMotionPlayback?: (observation: {
    motionId: string
    phase: 'started' | 'progress' | 'completed' | 'cancelled'
    frameIndex: number
  }) => void
}

/**
 * Dev-only native Cubism surface. It is deliberately opt-in and receives a
 * tokenized or local model URL from the query string/Companion so no private
 * model path or model bytes are placed in the application bundle.
 */
export class Live2dNativeDebugSurface implements Live2dParameterSink {
  readonly #container: HTMLElement
  readonly #modelUrl: string
  readonly #coreUrl: string
  readonly #onSnapshot: ((snapshot: Live2dNativeDebugSnapshot) => void) | undefined
  readonly #onGeneratedMotionPlayback: Live2dNativeDebugSurfaceOptions['onGeneratedMotionPlayback']
  readonly #motion = createLive2dDebugMotion()
  readonly #nativeMotion = new Live2dMotionController()
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
  #parameterBlend: { startedAtMs: number, values: ReadonlyMap<string, number> } | undefined
  #idleRestorePending = false
  #lastGeneratedPlayback: { motionId: string, frameIndex: number } | undefined
  #generatedRootOrigin: CanonicalVector3 | undefined
  #generatedRootAnchorOffset = { x: 0, y: 0 }
  #canvasMotionOffset = { x: 0, y: 0 }
  #disposed = false

  constructor(container: HTMLElement, options: Live2dNativeDebugSurfaceOptions) {
    if (!options.modelUrl || !options.modelUrl.trim()) throw new Error('Live2D native debug model URL is required')
    this.#container = container
    this.#modelUrl = options.modelUrl
    this.#coreUrl = resolveLive2dCoreUrl(options.coreUrl, window.location.href) ?? DEFAULT_LIVE2D_CORE_URL
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
      canvas.className = 'live2d-native-debug-canvas'
      canvas.setAttribute('aria-label', 'Live2D native debug model')
      this.#container.append(canvas)
      this.#canvas = canvas
      if (typeof ResizeObserver !== 'undefined') {
        this.#resizeObserver = new ResizeObserver(() => this.#resize())
        this.#resizeObserver.observe(this.#container)
      }
      this.#resize()

      const model = new Live2DCubismModel(canvas, {
        autoAnimate: false,
        autoInteraction: false,
        tapInteraction: false,
        randomMotion: false,
        keepAspect: false,
        cubismCorePath: this.#coreUrl,
        enableMotion: false,
        enableExpression: false,
        enableLipsync: false,
      }) as unknown as NativeLive2dModel
      this.#model = model
      await model.load(this.#modelUrl)
      if (this.#disposed) return false
      this.#modelReady = true
      this.#nativeMotion.bindModel(model)
      this.#parameterIds = [...(model.getParameterNames?.() ?? [])]
      this.#player = new Live2dMotionPlayer(this)
      this.#generatedMotion = new CanonicalMotionPlayer(this)
      window.addEventListener('resize', this.#resize, { passive: true })
      this.#lastRenderedAt = performance.now()
      this.#animationFrame = requestAnimationFrame(this.#render)
      this.#resize()
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
        detail,
      })
      this.dispose()
      return false
    }
  }

  setParameterValue(parameterId: string, value: number): void {
    if (this.#disposed || !this.#modelReady || !this.#model || !parameterId || !Number.isFinite(value)) return
    const appliedValue = this.#parameterOwner === 'generated'
      ? this.#blendGeneratedParameter(parameterId, value)
      : value
    this.#model.setParameter(parameterId, appliedValue)
    this.#parameters.set(parameterId, appliedValue)
  }

  onMotionFrame(frame: CanonicalMotionFrame): void {
    if (this.#disposed || this.#parameterOwner !== 'generated') return
    this.#applyGeneratedRootPosition(frame.rootPosition)
  }

  get isReady(): boolean {
    return !this.#disposed && this.#modelReady && this.#model !== undefined
  }

  updateMotionCatalog(motions: readonly MotionDescriptor[]): void {
    if (this.#disposed) return
    this.#motionCatalog = motions.filter((motion): motion is Live2dMotionDescriptor => motion.format === 'live2d')
  }

  playMotion(descriptor: MotionDescriptor): Promise<boolean> {
    if (this.#disposed || descriptor.format !== 'live2d') return Promise.resolve(false)
    if (this.#motionCatalog.length > 0 && !this.#motionCatalog.some(motion => motion.id === descriptor.id)) {
      return Promise.resolve(false)
    }
    this.#stopGeneratedMotion('cancelled', false)
    this.#resetGeneratedRootOffset()
    this.#player?.stop()
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
    this.#startDebugFallback()
    return Promise.resolve(true)
  }

  stopMotion(motionId?: string): void {
    if (motionId === undefined || this.#generatedMotion?.activeDescriptor?.id === motionId) {
      this.#stopGeneratedMotion('cancelled', true)
      if (motionId !== undefined) return
    }
    this.#nativeMotion.stopMotion(motionId)
    if (!this.#generatedMotion?.isPlaying && !this.#nativeMotion.isPlaying) this.#startDebugFallback()
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
    this.#parameterOwner = 'generated'
    this.#parameterBlend = {
      startedAtMs: performance.now(),
      values: this.#captureParameterValues(),
    }
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
      if (!restored && !this.#disposed && !this.#generatedMotion?.isPlaying) this.#startDebugFallback()
    }
    finally {
      this.#idleRestorePending = false
    }
  }

  #startDebugFallback(): void {
    if (this.#disposed || !this.#player || this.#generatedMotion?.isPlaying) return
    this.#nativeMotion.stopMotion()
    this.#resetGeneratedRootOffset()
    this.#parameterOwner = 'debug'
    this.#parameterBlend = undefined
    if (!this.#player.isPlaying) {
      this.#player.bind(this.#motion)
      this.#player.advance(0)
    }
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
    const alpha = Math.min(1, Math.max(0, (performance.now() - blend.startedAtMs) / GENERATED_MOTION_BLEND_MS))
    if (alpha >= 1) {
      this.#parameterBlend = undefined
      return target
    }
    const source = blend.values.get(parameterId)
    return source === undefined ? target : source + (target - source) * alpha
  }

  #applyGeneratedRootPosition(rootPosition: CanonicalVector3): void {
    if (this.#canvas === undefined) return
    if (this.#generatedRootOrigin === undefined) {
      this.#generatedRootOrigin = [...rootPosition] as CanonicalVector3
      this.#generatedRootAnchorOffset = { ...this.#canvasMotionOffset }
    }
    const origin = this.#generatedRootOrigin
    const pixelsPerWorldUnit = Math.min(this.#container.clientWidth, this.#container.clientHeight) * 0.12
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

  snapshot(): Live2dNativeDebugSnapshot {
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
    this.#modelReady = false
    this.#nativeMotion.dispose()
    this.#player?.dispose()
    this.#player = undefined
    this.#generatedMotion?.dispose()
    this.#generatedMotion = undefined
    try {
      this.#model?.destroy()
    }
    catch {
      // A failed Cubism initialization may not have a native model to release.
    }
    this.#model = undefined
    this.#parameters.clear()
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

  #snapshot(): Live2dNativeDebugSnapshot {
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
      ...(this.#nativeMotion.activeMotionId === undefined ? {} : { activeMotionId: this.#nativeMotion.activeMotionId }),
      ...(this.#generatedMotion?.activeDescriptor === undefined
        ? {}
        : { activeGeneratedMotionId: this.#generatedMotion.activeDescriptor.id }),
    }
  }

  #emit(snapshot: Live2dNativeDebugSnapshot): void {
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
