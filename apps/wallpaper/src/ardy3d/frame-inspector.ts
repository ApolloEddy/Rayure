import type { CanonicalMotion } from '@rayure/protocol'

import {
  ArdyMotionSource,
  CanvasWebmRecorder,
  CoreSkinFrameError,
  CoreSkinInferenceRenderer,
  DEFAULT_CORE_SKIN_MOTION_URL,
  loadCanonicalMotionFixture,
} from './core-skin-frame-source.ts'

const MAX_MOTION_FILE_BYTES = 256 * 1024 * 1024

const canvas = requireElement<HTMLCanvasElement>('source-canvas')
const slider = requireElement<HTMLInputElement>('frame-slider')
const statusTitle = requireElement<HTMLElement>('status-title')
const statusDetail = requireElement<HTMLElement>('status-detail')
const timelineLabel = requireElement<HTMLElement>('timeline-label')
const motionNameLabel = requireElement<HTMLElement>('motion-name')
const frameLabel = requireElement<HTMLElement>('frame-value')
const timeLabel = requireElement<HTMLElement>('time-value')
const fpsLabel = requireElement<HTMLElement>('fps-value')
const pixelsLabel = requireElement<HTMLElement>('pixels-value')
const loadDefaultButton = requireElement<HTMLButtonElement>('load-default')
const motionFile = requireElement<HTMLInputElement>('motion-file')
const playButton = requireElement<HTMLButtonElement>('play')
const pauseButton = requireElement<HTMLButtonElement>('pause')
const previousButton = requireElement<HTMLButtonElement>('previous')
const nextButton = requireElement<HTMLButtonElement>('next')
const resetButton = requireElement<HTMLButtonElement>('reset')
const recordButton = requireElement<HTMLButtonElement>('record')
const downloadFrameButton = requireElement<HTMLButtonElement>('download-frame')

const source = new ArdyMotionSource()
const renderer = new CoreSkinInferenceRenderer({ canvas })
const recorder = new CanvasWebmRecorder(canvas)

let motionLabel = '—'
let timer: ReturnType<typeof setTimeout> | undefined
let operation = 0
let playing = false
let recording = false

loadDefaultButton.addEventListener('click', () => {
  void loadDefaultMotion()
})
motionFile.addEventListener('change', () => {
  const file = motionFile.files?.[0]
  // Reset the input so selecting the same file twice still fires `change`.
  motionFile.value = ''
  if (file !== undefined) void loadMotionFile(file)
})
playButton.addEventListener('click', play)
pauseButton.addEventListener('click', pause)
previousButton.addEventListener('click', () => stepBy(-1))
nextButton.addEventListener('click', () => stepBy(1))
resetButton.addEventListener('click', reset)
slider.addEventListener('input', () => {
  if (recording) return
  const index = Number(slider.value)
  if (Number.isSafeInteger(index)) seekAndRender(index)
})
recordButton.addEventListener('click', () => {
  void recordWebm()
})
downloadFrameButton.addEventListener('click', () => {
  void downloadCurrentFrame()
})
window.addEventListener('beforeunload', () => {
  stopTimer()
  recorder.cancel()
  renderer.dispose()
})

void initialize()

async function initialize(): Promise<void> {
  setStatus('初始化 CoreSkin', 'creating fixed 512 × 512 inference renderer')
  try {
    await renderer.start()
    loadDefaultButton.disabled = false
    setStatus('CoreSkin ready', '选择 fixture 或本地 Canonical Motion JSON')
    await loadDefaultMotion()
  }
  catch (cause) {
    setFailure(cause)
  }
  updateControls()
}

async function loadDefaultMotion(): Promise<void> {
  if (!renderer.isReady || recording) return
  stopTimer()
  setStatus('加载 fixture', '读取开发态 /@rayure-assets/walk-motion.json')
  try {
    const motion = await loadCanonicalMotionFixture(DEFAULT_CORE_SKIN_MOTION_URL)
    loadMotion(motion, 'development fixture')
    setStatus('Source ready', `${motion.frames.length} frames · ${motion.fps} FPS · exact source timestamps`)
  }
  catch (cause) {
    setFailure(cause)
  }
  updateControls()
}

async function loadMotionFile(file: File): Promise<void> {
  if (!renderer.isReady || recording) return
  stopTimer()
  if (file.size <= 0 || file.size > MAX_MOTION_FILE_BYTES) {
    setFailure(new CoreSkinFrameError('SOURCE_MOTION_INVALID', 'Selected motion file is empty or exceeds the size bound'))
    return
  }
  const displayName = sanitizeFileName(file.name)
  setStatus('读取本地 motion', displayName)
  try {
    const parsed: unknown = JSON.parse(await file.text())
    loadMotion(parsed as CanonicalMotion, displayName)
    setStatus('Source ready', `${source.frameCount} frames · ${source.sourceFps ?? 0} FPS · local file`)
  }
  catch (cause) {
    setFailure(cause)
  }
  updateControls()
}

function loadMotion(motion: CanonicalMotion, displayName: string): void {
  source.load(motion)
  renderer.prepareMotion(motion)
  motionLabel = displayName
  source.reset()
  const first = source.step()
  if (first === undefined) throw new CoreSkinFrameError('SOURCE_MOTION_INVALID', 'Motion has no first frame')
  renderCurrent(first)
  slider.max = String(Math.max(0, source.frameCount - 1))
  slider.value = '0'
}

function play(): void {
  if (playing || recording || source.motion === undefined) return
  if (source.frameIndex >= source.frameCount - 1) {
    source.reset()
    const first = source.step()
    if (first !== undefined) renderCurrent(first)
  }
  playing = true
  const token = ++operation
  setStatus('Playing', `${motionLabel} · source timestamps`)
  scheduleNext(token)
  updateControls()
}

function pause(): void {
  if (!playing) return
  playing = false
  stopTimer()
  setStatus('Paused', `frame ${Math.max(0, source.frameIndex)} · ${source.currentFrame?.timeMs ?? 0} ms`)
  updateControls()
}

function reset(): void {
  if (recording || source.motion === undefined) return
  stopTimer()
  source.reset()
  const first = source.step()
  if (first !== undefined) {
    try {
      renderCurrent(first)
      setStatus('Reset', 'showing source frame 0')
    }
    catch (cause) {
      setFailure(cause)
    }
  }
  updateControls()
}

function stepBy(delta: -1 | 1): void {
  if (recording || source.motion === undefined) return
  stopTimer()
  const nextIndex = Math.min(source.frameCount - 1, Math.max(0, source.frameIndex + delta))
  try {
    const frame = source.seek(nextIndex)
    renderCurrent(frame)
    setStatus('Stepped', `frame ${nextIndex} · ${frame.timeMs} ms`)
  }
  catch (cause) {
    setFailure(cause)
  }
  updateControls()
}

function seekAndRender(frameIndex: number): void {
  const motion = source.motion
  if (recording || motion === undefined) return
  stopTimer()
  try {
    const frame = source.seek(frameIndex)
    renderCurrent(frame)
    setStatus('Source frame', `frame ${frameIndex} · ${frame.timeMs} ms`)
  }
  catch (cause) {
    setFailure(cause)
  }
  updateControls()
}

function scheduleNext(token: number): void {
  if (!playing || token !== operation) return
  const motion = source.motion
  const nextIndex = source.frameIndex + 1
  const nextFrame = motion?.frames[nextIndex]
  if (motion === undefined || nextFrame === undefined) {
    playing = false
    setStatus('Completed', `${motionLabel} · ${source.frameCount} source frames`)
    updateControls()
    return
  }
  const previousTime = source.currentFrame?.timeMs ?? nextFrame.timeMs
  const delay = Math.max(0, nextFrame.timeMs - previousTime)
  timer = setTimeout(() => {
    timer = undefined
    if (!playing || token !== operation) return
    try {
      const frame = source.seek(nextIndex)
      renderCurrent(frame)
      scheduleNext(token)
    }
    catch (cause) {
      playing = false
      setFailure(cause)
      updateControls()
    }
  }, delay)
}

function renderCurrent(frame: { timeMs: number }): void {
  const motion = source.motion
  if (motion === undefined) throw new CoreSkinFrameError('SOURCE_MOTION_INVALID', 'No motion is loaded')
  const result = renderer.renderFrame(frame as CanonicalMotion['frames'][number], source.frameIndex, motion.fps)
  frameLabel.textContent = `${result.frameIndex} / ${Math.max(0, source.frameCount - 1)}`
  timeLabel.textContent = `${result.mediaTimeMs} ms`
  fpsLabel.textContent = `${result.sourceFps}`
  pixelsLabel.textContent = result.stats === undefined
    ? 'validation disabled'
    : `${result.stats.nonBackgroundPixels.toLocaleString()} (${(result.stats.visibleRatio * 100).toFixed(2)}%)`
  slider.value = String(result.frameIndex)
  timelineLabel.textContent = `frame ${result.frameIndex} / ${Math.max(0, source.frameCount - 1)} · ${result.mediaTimeMs} ms`
  motionNameLabel.textContent = motionLabel
}

async function recordWebm(): Promise<void> {
  const motion = source.motion
  if (recording || motion === undefined || !renderer.isReady) return
  stopTimer()
  playing = false
  recording = true
  const token = ++operation
  updateControls()
  try {
    recorder.start(motion.fps)
    renderer.prepareMotion(motion)
    for (const [frameIndex, frame] of motion.frames.entries()) {
      if (token !== operation) throw new CoreSkinFrameError('WEBM_UNAVAILABLE', 'WebM recording was cancelled')
      source.seek(frameIndex)
      renderCurrent(frame)
      await nextPaint()
      const next = motion.frames[frameIndex + 1]
      if (next !== undefined) await delay(Math.max(0, next.timeMs - frame.timeMs))
    }
    const blob = await recorder.stop()
    downloadBlob(blob, `rayure-ardy-source-${Date.now()}.webm`)
    setStatus('WebM ready', `${motion.frames.length} frames · local download started`)
  }
  catch (cause) {
    recorder.cancel()
    setFailure(cause)
  }
  finally {
    recording = false
    updateControls()
  }
}

async function downloadCurrentFrame(): Promise<void> {
  if (!renderer.isReady || source.currentFrame === undefined || recording) return
  try {
    const blob = await canvasToBlob(canvas)
    downloadBlob(blob, `rayure-ardy-frame-${source.frameIndex}.png`)
    setStatus('Frame PNG ready', `frame ${source.frameIndex} · local download started`)
  }
  catch (cause) {
    setFailure(cause)
  }
}

function stopTimer(): void {
  operation += 1
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  playing = false
}

function updateControls(): void {
  const hasMotion = source.motion !== undefined
  const hasFrame = source.currentFrame !== undefined
  const busy = recording
  loadDefaultButton.disabled = !renderer.isReady || busy
  motionFile.disabled = !renderer.isReady || busy
  playButton.disabled = !hasMotion || !hasFrame || playing || busy
  pauseButton.disabled = !playing || busy
  previousButton.disabled = !hasMotion || !hasFrame || source.frameIndex <= 0 || busy
  nextButton.disabled = !hasMotion || !hasFrame || source.frameIndex >= source.frameCount - 1 || busy
  resetButton.disabled = !hasMotion || busy
  recordButton.disabled = !hasMotion || !hasFrame || busy
  downloadFrameButton.disabled = !hasFrame || busy
  slider.disabled = !hasMotion || busy
}

function setStatus(title: string, detail: string): void {
  statusTitle.textContent = title
  statusDetail.textContent = detail
}

function setFailure(cause: unknown): void {
  const code = cause instanceof CoreSkinFrameError ? cause.code : 'SOURCE_RENDER_INVALID'
  const message = cause instanceof Error ? cause.message : String(cause)
  setStatus(`失败 · ${code}`, message)
}

function sanitizeFileName(name: string): string {
  const safe = name.replace(/[\u0000-\u001F\u007F\\/]/gu, '').trim().slice(0, 96)
  return safe.length > 0 ? safe : 'selected motion'
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`Missing frame inspector element: ${id}`)
  return element as T
}

function nextPaint(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function canvasToBlob(sourceCanvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    sourceCanvas.toBlob((blob) => {
      if (blob === null) reject(new CoreSkinFrameError('SOURCE_RENDER_INVALID', 'Canvas PNG encoding returned no data'))
      else resolve(blob)
    }, 'image/png')
  })
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
