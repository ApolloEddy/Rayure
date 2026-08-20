import {
  createLive2dDebugMotion,
} from './debug-probe.ts'
import type { Live2dMotionDescriptor, MotionDescriptor } from '@rayure/protocol'
import {
  DEFAULT_LIVE2D_CORE_URL,
  resolveLive2dCoreUrl,
} from './core-source.ts'
import { parseLive2dModel3 } from './model-manifest.ts'
import { Live2dMotionController } from './motion-controller.ts'
import { Live2dMotionPlayer } from './motion-player.ts'
import type { Live2dParameterSink } from './rig-profile.ts'

const coreScriptLoads = new Map<string, Promise<void>>()

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
  detail?: string
}

export interface Live2dNativeDebugSurfaceOptions {
  modelUrl: string
  coreUrl?: string
  onSnapshot?: (snapshot: Live2dNativeDebugSnapshot) => void
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
  readonly #motion = createLive2dDebugMotion()
  readonly #nativeMotion = new Live2dMotionController()
  #canvas: HTMLCanvasElement | undefined
  #model: NativeLive2dModel | undefined
  #modelReady = false
  #player: Live2dMotionPlayer | undefined
  #animationFrame: number | undefined
  #resizeObserver: ResizeObserver | undefined
  #lastRenderedAt = 0
  #lastSnapshotAt = 0
  #parameterIds: readonly string[] = []
  #parameters = new Map<string, number>()
  #motionCatalog: readonly Live2dMotionDescriptor[] = []
  #disposed = false

  constructor(container: HTMLElement, options: Live2dNativeDebugSurfaceOptions) {
    if (!options.modelUrl || !options.modelUrl.trim()) throw new Error('Live2D native debug model URL is required')
    this.#container = container
    this.#modelUrl = options.modelUrl
    this.#coreUrl = resolveLive2dCoreUrl(options.coreUrl, window.location.href) ?? DEFAULT_LIVE2D_CORE_URL
    this.#onSnapshot = options.onSnapshot
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
        keepAspect: true,
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
      this.#player.bind(this.#motion)
      this.#player.advance(0)
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
    this.#model.setParameter(parameterId, value)
    this.#parameters.set(parameterId, value)
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
    return this.#nativeMotion.playMotion(descriptor)
  }

  playDefaultMotion(): Promise<boolean> {
    const defaultMotion = this.#motionCatalog.find(motion => motion.group.toLowerCase() === 'idle')
      ?? this.#motionCatalog[0]
    return defaultMotion === undefined ? Promise.resolve(false) : this.playMotion(defaultMotion)
  }

  stopMotion(motionId?: string): void {
    this.#nativeMotion.stopMotion(motionId)
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
    if (!this.#player.isPlaying) this.#player.bind(this.#motion)
    this.#player.advance(deltaSeconds)
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
