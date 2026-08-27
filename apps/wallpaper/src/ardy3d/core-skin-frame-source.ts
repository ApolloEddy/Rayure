import type { CanonicalMotion, CanonicalMotionFrame } from '@rayure/protocol'
import { validateCanonicalMotion } from '@rayure/protocol'
import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  Skeleton,
  Vector3,
  WebGLRenderer,
} from 'three'

import { disposeMmdModel } from '../mmd-model-host.ts'
import { CanonicalMotionRigAdapter } from './canonical-rig-adapter.ts'
import { loadCoreSkinModel } from './core-skin-loader.ts'
import type { CoreSkinModel } from './core-skin-loader.ts'

export const DEFAULT_CORE_SKIN_FRAME_SIZE = 512
export const SYNTHETIC_FRAME_PACKET_SCHEMA = 'rayure.synthetic-human-frame.v1' as const
export const CORE_SKIN_BACKGROUND = 0x101820
export const DEFAULT_CORE_SKIN_MOTION_URL = '/@rayure-assets/walk-motion.json'

const MAX_CANONICAL_MOTION_BYTES = 256 * 1024 * 1024
const MIN_VISIBLE_PIXELS = 64

export interface SyntheticFramePacket {
  schema: typeof SYNTHETIC_FRAME_PACKET_SCHEMA
  runId: string
  frameIndex: number
  mediaTimeMs: number
  sourceFps: number
  width: number
  height: number
  bitmap: ImageBitmap
}

export interface FrameVisualStats {
  width: number
  height: number
  nonBackgroundPixels: number
  visibleRatio: number
}

export interface RenderedCoreSkinFrame {
  frameIndex: number
  mediaTimeMs: number
  sourceFps: number
  width: number
  height: number
  stats?: FrameVisualStats
}

export type CoreSkinFrameErrorCode =
  | 'SOURCE_MOTION_INVALID'
  | 'CORE_SKIN_UNAVAILABLE'
  | 'SOURCE_RENDER_INVALID'
  | 'IMAGEBITMAP_UNAVAILABLE'
  | 'WEBM_UNAVAILABLE'

export class CoreSkinFrameError extends Error {
  readonly code: CoreSkinFrameErrorCode

  constructor(code: CoreSkinFrameErrorCode, message: string) {
    super(message)
    this.name = 'CoreSkinFrameError'
    this.code = code
  }
}

/**
 * Validated, frame-addressable source for `rayure.motion.v1`.
 *
 * The cursor is deliberately independent of wall-clock time.  Interactive
 * playback may schedule calls to `seek()` later, but the source always
 * returns the exact ARDY frame selected by index and its original `timeMs`.
 */
export class ArdyMotionSource {
  #motion: CanonicalMotion | undefined
  #frameIndex = -1

  load(motion: CanonicalMotion): void {
    try {
      validateCanonicalMotion(motion)
    }
    catch (cause) {
      throw new CoreSkinFrameError('SOURCE_MOTION_INVALID', toErrorMessage(cause))
    }
    this.#motion = motion
    this.#frameIndex = -1
  }

  get motion(): CanonicalMotion | undefined {
    return this.#motion
  }

  get frameCount(): number {
    return this.#motion?.frames.length ?? 0
  }

  get sourceFps(): number | undefined {
    return this.#motion?.fps
  }

  get frameIndex(): number {
    return this.#frameIndex
  }

  get currentFrame(): CanonicalMotionFrame | undefined {
    return this.#motion?.frames[this.#frameIndex]
  }

  get durationMs(): number {
    const frames = this.#motion?.frames
    if (frames === undefined || frames.length < 2) return frames?.[0]?.timeMs ?? 0
    return frames[frames.length - 1]!.timeMs - frames[0]!.timeMs
  }

  reset(): void {
    this.#frameIndex = -1
  }

  seek(frameIndex: number): CanonicalMotionFrame {
    const motion = this.#motion
    if (motion === undefined) throw new CoreSkinFrameError('SOURCE_MOTION_INVALID', 'No Canonical Motion is loaded')
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= motion.frames.length) {
      throw new RangeError(`Frame index is outside the loaded motion: ${String(frameIndex)}`)
    }
    const frame = motion.frames[frameIndex]
    if (frame === undefined) throw new RangeError(`Frame index is missing: ${frameIndex}`)
    this.#frameIndex = frameIndex
    return frame
  }

  step(): CanonicalMotionFrame | undefined {
    const nextIndex = this.#frameIndex + 1
    if (nextIndex >= this.frameCount) return undefined
    return this.seek(nextIndex)
  }
}

export interface CoreSkinInferenceRendererOptions {
  canvas: HTMLCanvasElement
  coreSkinUrl?: string
  width?: number
  height?: number
  /** Pixel readback is enabled by default for the Phase 1 blank-frame gate. */
  validateFrames?: boolean
}

/**
 * Deterministic ARDY CoreSkin renderer for inference frames.
 *
 * This renderer owns a fixed-size, overlay-free WebGL canvas.  It never starts
 * a requestAnimationFrame loop: callers explicitly select a Canonical Motion
 * frame and then receive a rendered frame at that frame's original timestamp.
 */
export class CoreSkinInferenceRenderer {
  readonly #canvas: HTMLCanvasElement
  readonly #coreSkinUrl: string
  readonly #width: number
  readonly #height: number
  readonly #validateFrames: boolean

  #renderer: WebGLRenderer | undefined
  #scene: Scene | undefined
  #camera: PerspectiveCamera | undefined
  #model: CoreSkinModel | undefined
  #skeletons: Skeleton[] = []
  #adapter: CanonicalMotionRigAdapter | undefined
  #bindTarget = new Vector3()
  #bindCameraPosition = new Vector3()
  #currentTarget = new Vector3()
  #rootAnchor: readonly [number, number, number] | undefined
  #lastFrame: RenderedCoreSkinFrame | undefined
  #disposed = false

  constructor(options: CoreSkinInferenceRendererOptions) {
    this.#canvas = options.canvas
    this.#coreSkinUrl = options.coreSkinUrl ?? '/@rayure-assets/core-skin-data.json'
    this.#width = requireCanvasDimension(options.width ?? DEFAULT_CORE_SKIN_FRAME_SIZE, 'width')
    this.#height = requireCanvasDimension(options.height ?? DEFAULT_CORE_SKIN_FRAME_SIZE, 'height')
    this.#validateFrames = options.validateFrames !== false
  }

  get canvas(): HTMLCanvasElement {
    return this.#canvas
  }

  get width(): number {
    return this.#width
  }

  get height(): number {
    return this.#height
  }

  get isReady(): boolean {
    return !this.#disposed && this.#renderer !== undefined && this.#adapter !== undefined
  }

  get lastFrame(): RenderedCoreSkinFrame | undefined {
    return this.#lastFrame
  }

  async start(): Promise<void> {
    if (this.#disposed) throw new CoreSkinFrameError('CORE_SKIN_UNAVAILABLE', 'CoreSkin renderer is disposed')
    if (this.isReady) return

    try {
      const renderer = new WebGLRenderer({
        canvas: this.#canvas,
        antialias: true,
        alpha: false,
        preserveDrawingBuffer: true,
      })
      renderer.setPixelRatio(1)
      renderer.setSize(this.#width, this.#height, false)
      renderer.setClearColor(CORE_SKIN_BACKGROUND, 1)

      const scene = new Scene()
      scene.name = 'rayure-ardy-core-skin-inference'
      scene.background = new Color(CORE_SKIN_BACKGROUND)
      scene.add(new AmbientLight(0xffffff, 1.05))
      const key = new DirectionalLight(0xffffff, 2.2)
      key.position.set(1.2, 2.4, 2.6)
      scene.add(key)
      this.#renderer = renderer
      this.#scene = scene

      const model = await loadCoreSkinModel(this.#coreSkinUrl)
      scene.add(model.root)
      model.root.updateMatrixWorld(true)
      this.#model = model
      this.#skeletons = [model.skeleton]
      this.#adapter = new CanonicalMotionRigAdapter({ bones: model.skeleton.bones })
      this.#configureCamera(scene, model)
      this.#renderBindPose()
    }
    catch (cause) {
      this.dispose()
      if (cause instanceof CoreSkinFrameError) throw cause
      throw new CoreSkinFrameError('CORE_SKIN_UNAVAILABLE', toErrorMessage(cause))
    }
  }

  /** Resets root-follow state before rendering a new motion. */
  prepareMotion(motion: CanonicalMotion): void {
    try {
      validateCanonicalMotion(motion)
    }
    catch (cause) {
      throw new CoreSkinFrameError('SOURCE_MOTION_INVALID', toErrorMessage(cause))
    }
    this.#rootAnchor = motion.frames[0]?.rootPosition
    this.#lastFrame = undefined
  }

  /** Renders one exact source frame without interpolation. */
  renderFrame(frame: CanonicalMotionFrame, frameIndex: number, sourceFps: number): RenderedCoreSkinFrame {
    const renderer = this.#renderer
    const scene = this.#scene
    const camera = this.#camera
    const adapter = this.#adapter
    if (renderer === undefined || scene === undefined || camera === undefined || adapter === undefined) {
      throw new CoreSkinFrameError('CORE_SKIN_UNAVAILABLE', 'CoreSkin renderer has not started')
    }
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
      throw new RangeError(`Frame index must be a non-negative integer: ${String(frameIndex)}`)
    }
    if (!Number.isFinite(sourceFps) || sourceFps <= 0) {
      throw new RangeError(`Source FPS must be positive and finite: ${String(sourceFps)}`)
    }
    if (!Number.isFinite(frame.timeMs) || frame.timeMs < 0) {
      throw new CoreSkinFrameError('SOURCE_MOTION_INVALID', `Frame timeMs is invalid: ${String(frame.timeMs)}`)
    }
    if (this.#rootAnchor === undefined) this.#rootAnchor = frame.rootPosition

    adapter.onMotionFrame(frame)
    this.#followRoot(frame)
    for (const skeleton of this.#skeletons) skeleton.update()
    renderer.render(scene, camera)

    const stats = this.#validateFrames ? this.inspectFrame() : undefined
    if (stats !== undefined && stats.nonBackgroundPixels < MIN_VISIBLE_PIXELS) {
      throw new CoreSkinFrameError(
        'SOURCE_RENDER_INVALID',
        `Rendered frame is blank or out of frame (${stats.nonBackgroundPixels} visible pixels)`,
      )
    }
    const rendered: RenderedCoreSkinFrame = {
      frameIndex,
      mediaTimeMs: frame.timeMs,
      sourceFps,
      width: this.#width,
      height: this.#height,
      ...(stats === undefined ? {} : { stats }),
    }
    this.#lastFrame = rendered
    return rendered
  }

  /** Renders all frames in source order, preserving each original `timeMs`. */
  renderMotion(
    motion: CanonicalMotion,
    onFrame?: (frame: RenderedCoreSkinFrame) => void,
  ): readonly RenderedCoreSkinFrame[] {
    this.prepareMotion(motion)
    const rendered: RenderedCoreSkinFrame[] = []
    for (const [frameIndex, frame] of motion.frames.entries()) {
      const result = this.renderFrame(frame, frameIndex, motion.fps)
      rendered.push(result)
      onFrame?.(result)
    }
    return rendered
  }

  async captureBitmap(): Promise<ImageBitmap> {
    if (this.#renderer === undefined) {
      throw new CoreSkinFrameError('CORE_SKIN_UNAVAILABLE', 'CoreSkin renderer has not started')
    }
    if (typeof createImageBitmap !== 'function') {
      throw new CoreSkinFrameError('IMAGEBITMAP_UNAVAILABLE', 'createImageBitmap is unavailable')
    }
    return createImageBitmap(this.#renderer.domElement)
  }

  async renderPacket(runId: string, frame: CanonicalMotionFrame, frameIndex: number, sourceFps: number): Promise<SyntheticFramePacket> {
    const rendered = this.renderFrame(frame, frameIndex, sourceFps)
    const bitmap = await this.captureBitmap()
    return {
      schema: SYNTHETIC_FRAME_PACKET_SCHEMA,
      runId: requireRunId(runId),
      frameIndex: rendered.frameIndex,
      mediaTimeMs: rendered.mediaTimeMs,
      sourceFps: rendered.sourceFps,
      width: rendered.width,
      height: rendered.height,
      bitmap,
    }
  }

  inspectFrame(): FrameVisualStats {
    const renderer = this.#renderer
    if (renderer === undefined) {
      throw new CoreSkinFrameError('CORE_SKIN_UNAVAILABLE', 'CoreSkin renderer has not started')
    }
    const gl = renderer.getContext()
    const pixels = new Uint8Array(this.#width * this.#height * 4)
    gl.readPixels(0, 0, this.#width, this.#height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    const error = gl.getError()
    if (error !== gl.NO_ERROR) {
      throw new CoreSkinFrameError('SOURCE_RENDER_INVALID', `WebGL pixel readback failed with error ${String(error)}`)
    }
    let nonBackgroundPixels = 0
    for (let index = 0; index < pixels.length; index += 4) {
      const difference = Math.abs((pixels[index] ?? 0) - 16)
        + Math.abs((pixels[index + 1] ?? 0) - 24)
        + Math.abs((pixels[index + 2] ?? 0) - 32)
      if (difference > 18 && (pixels[index + 3] ?? 0) > 0) nonBackgroundPixels += 1
    }
    return {
      width: this.#width,
      height: this.#height,
      nonBackgroundPixels,
      visibleRatio: nonBackgroundPixels / (this.#width * this.#height),
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#adapter?.dispose()
    this.#adapter = undefined
    this.#skeletons = []
    if (this.#model !== undefined) {
      try {
        disposeMmdModel({ root: this.#model.root, runtime: {}, update: () => undefined })
      }
      catch {
        // Continue releasing the renderer even when a partial fixture fails.
      }
    }
    this.#model = undefined
    this.#renderer?.dispose()
    this.#renderer = undefined
    this.#scene = undefined
    this.#camera = undefined
    this.#lastFrame = undefined
    this.#rootAnchor = undefined
  }

  #configureCamera(scene: Scene, model: CoreSkinModel): void {
    const bounds = new Box3().setFromObject(model.root)
    if (bounds.isEmpty()) throw new Error('CoreSkin bounds are empty')
    const size = bounds.getSize(new Vector3())
    const center = bounds.getCenter(new Vector3())
    const radius = Math.max(size.x, size.y, size.z) * 0.5
    if (!Number.isFinite(radius) || radius <= 1e-6) throw new Error('CoreSkin bounds are invalid')

    const camera = new PerspectiveCamera(38, this.#width / this.#height, 0.001, 100)
    const distance = Math.max(radius / Math.tan((camera.fov * Math.PI) / 360) * 1.18, 0.5)
    this.#bindTarget.copy(center)
    this.#bindCameraPosition.set(center.x, center.y + radius * 0.03, center.z + distance)
    camera.position.copy(this.#bindCameraPosition)
    camera.lookAt(this.#bindTarget)
    camera.updateProjectionMatrix()
    scene.add(camera)
    this.#camera = camera
  }

  #renderBindPose(): void {
    if (this.#renderer === undefined || this.#scene === undefined || this.#camera === undefined) return
    for (const skeleton of this.#skeletons) skeleton.update()
    this.#renderer.render(this.#scene, this.#camera)
  }

  #followRoot(frame: CanonicalMotionFrame): void {
    const camera = this.#camera
    if (camera === undefined || this.#rootAnchor === undefined) return
    const deltaX = frame.rootPosition[0] - this.#rootAnchor[0]
    const deltaZ = frame.rootPosition[2] - this.#rootAnchor[2]
    camera.position.set(
      this.#bindCameraPosition.x + deltaX,
      this.#bindCameraPosition.y,
      this.#bindCameraPosition.z + deltaZ,
    )
    // Keep the target derived from the fixed bind target and current root
    // offset.  The camera follows translation but never follows root rotation.
    this.#currentTarget.set(this.#bindTarget.x + deltaX, this.#bindTarget.y, this.#bindTarget.z + deltaZ)
    camera.lookAt(this.#currentTarget)
  }
}

/** Minimal local fixture loader used by the dev-only frame inspector. */
export async function loadCanonicalMotionFixture(
  url: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<CanonicalMotion> {
  requireFixtureUrl(url)
  let response: Response
  try {
    response = await fetchImplementation(url, { cache: 'no-store', credentials: 'omit' })
  }
  catch (cause) {
    throw new CoreSkinFrameError('SOURCE_MOTION_INVALID', `Fixture request failed: ${toErrorMessage(cause)}`)
  }
  if (!response.ok) throw new CoreSkinFrameError('SOURCE_MOTION_INVALID', `Fixture request failed with HTTP ${response.status}`)
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_CANONICAL_MOTION_BYTES) {
    throw new CoreSkinFrameError('SOURCE_MOTION_INVALID', 'Canonical Motion fixture exceeds the size bound')
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  }
  catch {
    throw new CoreSkinFrameError('SOURCE_MOTION_INVALID', 'Canonical Motion fixture must contain valid JSON')
  }
  try {
    validateCanonicalMotion(parsed)
  }
  catch (cause) {
    throw new CoreSkinFrameError('SOURCE_MOTION_INVALID', toErrorMessage(cause))
  }
  return parsed
}

/** Converts an ARDY media timestamp to MiKaPo/VMD's fixed 30 FPS frame index. */
export function mediaTimeToVmdFrame(timeMs: number, originMs = 0): number {
  if (!Number.isFinite(timeMs) || !Number.isFinite(originMs)) {
    throw new RangeError('Media and origin timestamps must be finite')
  }
  return Math.round(((timeMs - originMs) / 1000) * 30)
}

export function chooseWebmMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  for (const mimeType of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(mimeType)) return mimeType
  }
  return undefined
}

/** Optional, explicitly paced canvas recorder for the Phase 1 gold video. */
export class CanvasWebmRecorder {
  readonly #canvas: HTMLCanvasElement
  #recorder: MediaRecorder | undefined
  #stream: MediaStream | undefined
  #chunks: Blob[] = []
  #mimeType: string | undefined

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas
  }

  get isRecording(): boolean {
    return this.#recorder?.state === 'recording'
  }

  get mimeType(): string | undefined {
    return this.#mimeType
  }

  start(fps: number): void {
    if (this.isRecording) throw new CoreSkinFrameError('WEBM_UNAVAILABLE', 'A WebM recording is already active')
    if (!Number.isFinite(fps) || fps <= 0 || fps > 120) throw new RangeError(`Invalid recording FPS: ${String(fps)}`)
    if (typeof MediaRecorder === 'undefined' || typeof this.#canvas.captureStream !== 'function') {
      throw new CoreSkinFrameError('WEBM_UNAVAILABLE', 'Canvas WebM recording is unavailable')
    }
    const mimeType = chooseWebmMimeType()
    if (mimeType === undefined) throw new CoreSkinFrameError('WEBM_UNAVAILABLE', 'No supported WebM MediaRecorder MIME type')
    this.#stream = this.#canvas.captureStream(fps)
    this.#mimeType = mimeType
    this.#chunks = []
    const recorder = new MediaRecorder(this.#stream, { mimeType })
    recorder.ondataavailable = event => {
      if (event.data.size > 0) this.#chunks.push(event.data)
    }
    recorder.start()
    this.#recorder = recorder
  }

  stop(): Promise<Blob> {
    const recorder = this.#recorder
    if (recorder === undefined) return Promise.reject(new CoreSkinFrameError('WEBM_UNAVAILABLE', 'No WebM recording is active'))
    return new Promise((resolve, reject) => {
      recorder.onerror = () => {
        this.#cleanupRecording()
        reject(new CoreSkinFrameError('WEBM_UNAVAILABLE', 'MediaRecorder failed while writing WebM'))
      }
      recorder.onstop = () => {
        const blob = new Blob(this.#chunks, { type: this.#mimeType ?? 'video/webm' })
        this.#cleanupRecording()
        resolve(blob)
      }
      recorder.stop()
    })
  }

  cancel(): void {
    const recorder = this.#recorder
    if (recorder !== undefined && recorder.state !== 'inactive') recorder.stop()
    this.#cleanupRecording()
  }

  #cleanupRecording(): void {
    this.#recorder = undefined
    for (const track of this.#stream?.getTracks() ?? []) track.stop()
    this.#stream = undefined
    this.#chunks = []
  }
}

function requireCanvasDimension(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 128 || value > 2048) {
    throw new RangeError(`${name} must be an integer between 128 and 2048`)
  }
  return value
}

function requireRunId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new CoreSkinFrameError('SOURCE_MOTION_INVALID', 'runId must be a short opaque identifier')
  }
  return value
}

function requireFixtureUrl(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new CoreSkinFrameError('SOURCE_MOTION_INVALID', 'Fixture URL is invalid')
  }
  let url: URL
  try {
    url = new URL(value, 'http://127.0.0.1')
  }
  catch {
    throw new CoreSkinFrameError('SOURCE_MOTION_INVALID', 'Fixture URL must be valid')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
    || !/^\/@rayure-assets\/[A-Za-z0-9_.-]{1,128}$/u.test(url.pathname)
  ) {
    throw new CoreSkinFrameError('SOURCE_MOTION_INVALID', 'Fixture URL must use the local ARDY asset endpoint')
  }
}

function toErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
