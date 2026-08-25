import './style.css'

import type { CanonicalMotion, Live2dMotionDescriptor, ModelDescriptor, MotionDescriptor, SpeechDescriptor } from '@rayure/protocol'
import { parseLive2dCalibration } from '@rayure/protocol'
import { CompanionClient } from './companion-client.ts'
import { loadCanonicalMotion } from './live2d/canonical-motion-client.ts'
import type { CompanionConnectionSnapshot } from './companion-client.ts'
import {
  DEFAULT_WALLPAPER_SETTINGS,
  parseAccentColor,
  parseBoolean,
  parseFps,
  parseModelScale,
  parsePort,
  toCssColor,
} from './config.ts'
import { RayureScene } from './scene.ts'
import type { MmdModelStatus } from './mmd-model-host.ts'
import type { Live2dDebugSnapshot } from './live2d/debug-probe.ts'
import {
  Live2dNativeSurface,
} from './live2d/native-surface.ts'
import type { Live2dNativeSnapshot } from './live2d/native-surface.ts'
import { resolveLive2dCoreUrl } from './live2d/core-source.ts'
import { buildCalibratedRigProfile, calibrationNeutralPose, resolveLive2dRigProfile } from './live2d/rig-profile.ts'
import { missingCalibrationControls } from './live2d/calibration-core.ts'
import { CalibrationWizard } from './live2d/calibration-wizard.ts'
import type { WallpaperPropertyListener } from './wallpaper-api.ts'
import { SpeechPlayer } from './speech-player.ts'

const BUILD = '0.2.0-m1'
const stage = requireElement('stage')
const brand = requireElement('brand')
const connectionLabel = requireElement('connection-label')
const endpointLabel = requireElement('endpoint-label')
const statusDot = requireElement('status-dot')
const connectionPanel = requireElement('connection')
const modelLabel = requireElement('model-label')
const debugQuery = new URLSearchParams(window.location.search)
const live2dParameterProbeEnabled = debugQuery.get('live2dDebug') === '1'
const live2dNativeModelUrl = parseLocalLive2dDebugUrl(debugQuery.get('live2dModelUrl'))
const live2dCoreUrl = resolveLive2dCoreUrl(debugQuery.get('live2dCoreUrl'), window.location.href)
// Native model content (bundled motions and scene layers) stays opt-in in
// every runtime: Wallpaper Engine users enable it through the property panel
// and browser/debug previews through ?live2dNativeContent=1. The developer
// preview must show the same skin-only default users see in production.
const nativeContentQuery = debugQuery.get('live2dNativeContent')
let live2dNativeContentEnabled = nativeContentQuery === '1'
let live2dNativeSceneVisible = debugQuery.get('live2dNativeScene') === '1'
let live2dDebugBackdropVisible = debugQuery.get('backdrop') === '1'
const live2dDiagnosticsPanel = createLive2dDiagnosticsPanel(live2dParameterProbeEnabled || live2dNativeModelUrl !== undefined)

declare global {
  interface Window {
    __rayure_scene__?: RayureScene
  }
}

const queryPort = parsePort(new URLSearchParams(window.location.search).get('port'))
let companionPort = queryPort ?? DEFAULT_WALLPAPER_SETTINGS.companionPort
let accent = { ...DEFAULT_WALLPAPER_SETTINGS.accent }
const scene = new RayureScene(stage, accent, {
  onModelStatus: renderModelStatus,
  live2dDebug: live2dParameterProbeEnabled,
  onLive2dDebug: renderLive2dDebug,
})
window.__rayure_scene__ = scene
// Live2D is a character surface, not a forced full-bleed room backdrop.
// The developer panel can opt the private backdrop back in when inspecting it.
scene.setEnvironmentVisible(live2dDebugBackdropVisible)

const live2dQuerySurface = live2dNativeModelUrl === undefined
  ? undefined
  : new Live2dNativeSurface(stage, {
    modelUrl: live2dNativeModelUrl,
    ...(live2dCoreUrl === undefined ? {} : { coreUrl: live2dCoreUrl }),
    debugFallback: live2dParameterProbeEnabled,
    showNativeParts: true,
    onSnapshot: renderLive2dSnapshot,
    onGeneratedMotionPlayback: observation => {
      companion.reportMotionPlayback(observation)
      renderLive2dGeneratedMotionPlayback(observation)
    },
  })
let live2dCompanionSurface: Live2dNativeSurface | undefined
let live2dCompanionGeneration = 0
let live2dCompanionModel: ModelDescriptor | undefined
let live2dCompanionMotionCatalog: readonly Live2dMotionDescriptor[] = []
let pendingLive2dMotion: Live2dMotionDescriptor | undefined
let pendingCanonicalMotion: MotionDescriptor | undefined
let latestGeneratedMotion: MotionDescriptor | undefined
let motionPublishedGeneration = 0
let live2dDebugMotionCacheKey: string | undefined
type PendingLive2dExpression =
  | { kind: 'set', name: string, weight: number, durationMs?: number }
  | { kind: 'reset', durationMs?: number }
let pendingLive2dExpression: PendingLive2dExpression | undefined
let speechPublishedGeneration = 0
let speechPlayer: SpeechPlayer | undefined
void live2dQuerySurface?.start().then((loaded) => {
  if (loaded && live2dQuerySurface !== undefined) applyPendingLive2dExpression(live2dQuerySurface)
})

const companion = new CompanionClient({
  port: companionPort,
  build: BUILD,
  onStatus: renderConnectionStatus,
  onModelAvailable: (model) => {
    void handleModelAvailable(model)
  },
  onMotionCatalog: (motions) => {
    live2dCompanionMotionCatalog = motions.filter((motion): motion is Live2dMotionDescriptor => motion.format === 'live2d')
    renderLive2dMotionCatalog(live2dCompanionMotionCatalog)
    applyLive2dNativeContentPolicy()
    scene.updateMotionCatalog(motions.filter(motion => motion.format === 'vmd'))
  },
  onMotionPublished: (motion) => {
    void handleMotionPublished(motion)
  },
  onMotionGenerateStatus: (status) => {
    live2dDiagnosticsPanel.generationStatus.textContent = status.phase === 'accepted'
      ? `request ${status.requestId} accepted · waiting for motion.published`
      : `request ${status.requestId} failed · ${status.message ?? 'unknown error'}`
  },
  onSpeechPublished: (speech) => {
    void handleSpeechPublished(speech)
  },
  onEmotePlay: (payload) => {
    if (live2dCompanionModel?.format === 'live2d') {
      if (payload.expressionName !== undefined) {
        requestLive2dExpression({
          kind: 'set',
          name: payload.expressionName,
          weight: payload.expressionWeight ?? 1,
          ...(payload.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
        })
      }
      if (!live2dNativeContentEnabled) return
      const motion = payload.motionId === undefined
        ? undefined
        : live2dCompanionMotionCatalog.find(item => item.id === payload.motionId)
      if (motion !== undefined) requestLive2dMotion(motion)
      return
    }
    void scene.playEmote(payload)
  },
  onMotionPlay: (motion) => {
    if (motion.format === 'live2d' && live2dCompanionModel?.format === 'live2d' && live2dNativeContentEnabled) {
      requestLive2dMotion(motion)
      return
    }
    if (motion.format === 'vmd') void scene.playMotion(motion)
  },
  onMotionStop: (motionId) => {
    if (live2dCompanionModel?.format === 'live2d') {
      if (!live2dNativeContentEnabled) return
      pendingLive2dMotion = undefined
      live2dCompanionSurface?.stopMotion(motionId)
      return
    }
    scene.stopMotion(motionId)
  },
  onExpressionSet: (payload) => {
    if (!requestLive2dExpression({
      kind: 'set',
      name: payload.name,
      weight: payload.weight,
      ...(payload.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
    })) {
      scene.setExpression(payload.name, payload.weight, payload.durationMs)
    }
  },
  onExpressionReset: (payload) => {
    if (!requestLive2dExpression({
      kind: 'reset',
      ...(payload?.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
    })) {
      scene.resetExpression(payload?.durationMs)
    }
  },
})

const wallpaperPropertyListener: WallpaperPropertyListener = {
  applyGeneralProperties(properties): void {
    const fps = parseFps(properties.fps)
    if (fps !== undefined) scene.setFps(fps)
  },
  applyUserProperties(properties): void {
    if (properties.companionport !== undefined) {
      const port = parsePort(properties.companionport.value)
      if (port !== undefined) {
        companionPort = port
        companion.setPort(port)
      }
    }
    if (properties.accentcolor !== undefined) {
      const nextAccent = parseAccentColor(properties.accentcolor.value)
      if (nextAccent !== undefined) {
        accent = nextAccent
        scene.setAccent(accent)
        applyAccent(accent)
      }
    }
    if (properties.modelscale !== undefined) {
      const modelScale = parseModelScale(properties.modelscale.value)
      if (modelScale !== undefined) scene.setModelScale(modelScale)
    }
    if (properties.showstatus !== undefined) {
      const showStatus = parseBoolean(properties.showstatus.value)
      if (showStatus !== undefined) connectionPanel.hidden = !showStatus
    }
    if (properties.showbranding !== undefined) {
      const showBranding = parseBoolean(properties.showbranding.value)
      if (showBranding !== undefined) setBrandingVisible(showBranding)
    }
    if (properties.importnativecontent !== undefined) {
      const importNativeContent = parseBoolean(properties.importnativecontent.value)
      if (importNativeContent !== undefined) setNativeContentEnabled(importNativeContent)
    }
  },
  setPaused(isPaused): void {
    scene.setPaused(isPaused === true)
  },
}

// Wallpaper Engine requires this listener to be assigned globally and early.
window.wallpaperPropertyListener = wallpaperPropertyListener

applyAccent(accent)
endpointLabel.textContent = `127.0.0.1:${companionPort}`
scene.setFps(DEFAULT_WALLPAPER_SETTINGS.fps)
scene.setModelScale(DEFAULT_WALLPAPER_SETTINGS.modelScale)
connectionPanel.hidden = !DEFAULT_WALLPAPER_SETTINGS.showStatus
setBrandingVisible(DEFAULT_WALLPAPER_SETTINGS.showBranding)
setNativeContentEnabled(live2dNativeContentEnabled)
scene.start()
companion.start()

window.addEventListener('beforeunload', () => {
  companion.stop()
  speechPublishedGeneration += 1
  speechPlayer?.dispose()
  speechPlayer = undefined
  live2dCompanionGeneration += 1
  live2dQuerySurface?.dispose()
  live2dCompanionSurface?.dispose()
  scene.dispose()
}, { once: true })

async function handleModelAvailable(model: ModelDescriptor): Promise<void> {
  if (model.format === 'pmx') {
    live2dCompanionGeneration += 1
    motionPublishedGeneration += 1
    live2dCompanionSurface?.dispose()
    live2dCompanionSurface = undefined
    live2dCompanionModel = undefined
    live2dCompanionMotionCatalog = []
    pendingLive2dMotion = undefined
    pendingCanonicalMotion = undefined
    pendingLive2dExpression = undefined
    scene.setEnvironmentVisible(true)
    scene.setDecorVisible(true)
    void scene.loadModel(model)
    return
  }

  if (live2dQuerySurface !== undefined) return
  scene.setEnvironmentVisible(live2dDebugBackdropVisible)
  scene.setDecorVisible(false)
  live2dCompanionModel = model
  pendingLive2dMotion = undefined
  await loadLive2dCompanionSurface(model)
}

async function loadLive2dCompanionSurface(model: ModelDescriptor): Promise<void> {
  const generation = ++live2dCompanionGeneration
  motionPublishedGeneration += 1
  pendingLive2dMotion = undefined
  live2dCompanionSurface?.dispose()
  let latestSnapshot: Live2dNativeSnapshot | undefined
  const calibration = model.calibrationUrl === undefined
    ? undefined
    : await fetchLive2dCalibration(model.calibrationUrl)
  const surface = new Live2dNativeSurface(stage, {
    modelUrl: resolveLive2dCompanionModelUrl(model),
    ...(live2dCoreUrl === undefined ? {} : { coreUrl: live2dCoreUrl }),
    debugFallback: false,
    ...(model.skinHiddenPartIds === undefined ? {} : { skinHiddenPartIds: model.skinHiddenPartIds }),
    ...(calibration === undefined
      ? {}
      : {
          rigProfile: buildCalibratedRigProfile(calibration),
          ...(calibrationNeutralPose(calibration) === undefined ? {} : { neutralPose: calibrationNeutralPose(calibration)! }),
        }),
    showNativeParts: live2dNativeContentEnabled && live2dNativeSceneVisible,
    onSnapshot: (snapshot) => {
      if (generation !== live2dCompanionGeneration) return
      latestSnapshot = snapshot
      renderLive2dSnapshot(snapshot)
      renderLive2dModelStatus(
        snapshot.nativeModelLoaded ? 'ready' : snapshot.detail === 'Loading Cubism Core and model' ? 'loading' : 'error',
        model,
        snapshot.detail,
      )
    },
    onGeneratedMotionPlayback: observation => {
      companion.reportMotionPlayback(observation)
      renderLive2dGeneratedMotionPlayback(observation)
    },
  })
  live2dCompanionSurface = surface
  applyLive2dNativeContentPolicy()
  const loaded = await surface.start()
  if (generation !== live2dCompanionGeneration) return
  if (!loaded) {
    renderLive2dModelStatus('error', model, latestSnapshot?.detail ?? 'Live2D model unavailable')
    return
  }
  const requestedMotion = pendingLive2dMotion
  const requestedCanonicalMotion = pendingCanonicalMotion
  pendingLive2dMotion = undefined
  pendingCanonicalMotion = undefined
  if (requestedCanonicalMotion?.format === 'canonical') {
    void handleMotionPublished(requestedCanonicalMotion)
  }
  else if (requestedMotion !== undefined && live2dNativeContentEnabled) {
    void surface.playMotion(requestedMotion)
  }
  else if (live2dNativeContentEnabled) {
    // A native idle slot keeps the character alive before the first click or
    // Companion-generated canonical motion arrives.
    void surface.playDefaultMotion()
  }
  applyPendingLive2dExpression(surface)
  maybeOpenCalibrationWizard(surface, model, calibration)
}

function maybeOpenCalibrationWizard(
  surface: Live2dNativeSurface,
  model: ModelDescriptor,
  calibration: import('@rayure/protocol').Live2dCalibrationDescriptor | undefined,
): void {
  if (model.format !== 'live2d') return
  const force = debugQuery.get('calibrate') === '1'
  if (!force && model.calibrationUrl !== undefined && calibration !== undefined) return
  if (!force && localStorage.getItem(`rayure-calibrated-${model.id}`) === '1') return
  const ranges = surface.getParameterRanges()
  if (ranges.length === 0) return
  const parameterIds = ranges.map(range => range.id)
  const baseProfile = calibration !== undefined
    ? buildCalibratedRigProfile(calibration)
    : resolveLive2dRigProfile(parameterIds)
  if (!force && missingCalibrationControls(baseProfile).length === 0) return
  const wizard = new CalibrationWizard({
    surface,
    baseProfile,
    ...(model.skinHiddenPartIds === undefined ? {} : { initialSkinHiddenPartIds: model.skinHiddenPartIds }),
    ...(calibration?.neutralPose === undefined ? {} : { initialNeutralPose: calibration.neutralPose }),
    ...(calibration?.disabledControls === undefined ? {} : { initialDisabledControls: calibration.disabledControls }),
    ...(model.calibrationUrl === undefined ? {} : { calibrationUrl: model.calibrationUrl }),
    modelId: model.id,
    onSaved: () => {
      localStorage.setItem(`rayure-calibrated-${model.id}`, '1')
    },
  })
  wizard.open()
}

function requestLive2dExpression(expression: PendingLive2dExpression): boolean {
  if (live2dCompanionModel?.format === 'live2d' && live2dCompanionSurface === undefined) {
    pendingLive2dExpression = expression
    return true
  }
  const surface = getLive2dExpressionSurface()
  if (surface === undefined) return false
  if (!surface.isReady) {
    pendingLive2dExpression = expression
    return true
  }
  pendingLive2dExpression = undefined
  if (expression.kind === 'set') {
    surface.setExpression(expression.name, expression.weight, expression.durationMs)
  }
  else {
    surface.resetExpression(expression.durationMs)
  }
  return true
}

function applyPendingLive2dExpression(surface: Live2dNativeSurface): void {
  const expression = pendingLive2dExpression
  if (expression === undefined || !surface.isReady) return
  pendingLive2dExpression = undefined
  if (expression.kind === 'set') {
    surface.setExpression(expression.name, expression.weight, expression.durationMs)
  }
  else {
    surface.resetExpression(expression.durationMs)
  }
}

function getLive2dExpressionSurface(): Live2dNativeSurface | undefined {
  if (live2dCompanionModel?.format === 'live2d') return live2dCompanionSurface
  return live2dQuerySurface
}

function requestLive2dMotion(motion: Live2dMotionDescriptor): void {
  if (live2dCompanionModel?.format !== 'live2d' || !live2dNativeContentEnabled) return
  if (!live2dCompanionSurface?.isReady) {
    pendingLive2dMotion = motion
    return
  }
  pendingLive2dMotion = undefined
  void live2dCompanionSurface.playMotion(motion)
}

/**
 * Handles a generated Canonical Motion announced by Companion. Only the
 * canonical format is consumed here; it is fetched over the tokenized loopback
 * gateway, validated, and played on the native surface as a runtime motion.
 * A generation guard drops late results so an older intent can never overwrite
 * a newer action that has already started playing. Failures surface silently
 * to the debug status; a healthy renderer skips them.
 */
async function handleMotionPublished(motion: MotionDescriptor): Promise<void> {
  if (motion.format !== 'canonical') return
  latestGeneratedMotion = motion
  renderLive2dGeneratedMotion(motion, 'announced')
  if (live2dCompanionModel?.format !== 'live2d') {
    pendingCanonicalMotion = motion
    renderLive2dGeneratedMotion(motion, 'waiting for Live2D model')
    return
  }
  const surface = live2dCompanionSurface
  if (surface === undefined || !surface.isReady) {
    pendingCanonicalMotion = motion
    renderLive2dGeneratedMotion(motion, 'queued until Live2D is ready')
    return
  }
  pendingCanonicalMotion = undefined
  const generation = ++motionPublishedGeneration
  renderLive2dGeneratedMotion(motion, 'loading canonical frames')
  let canonical: CanonicalMotion
  try {
    canonical = await loadCanonicalMotion(motion.url)
  }
  catch {
    if (generation === motionPublishedGeneration && surface === live2dCompanionSurface) {
      surface.stopGeneratedMotion()
      renderLive2dGeneratedMotion(motion, 'failed to load canonical frames')
    }
    return
  }
  if (generation !== motionPublishedGeneration || surface !== live2dCompanionSurface) return
  const started = surface.playGeneratedMotion(canonical, motion)
  renderLive2dGeneratedMotion(motion, started ? 'playing' : 'rejected by Live2D surface')
}

async function handleSpeechPublished(speech: SpeechDescriptor): Promise<void> {
  const generation = ++speechPublishedGeneration
  speechPlayer?.dispose()
  const player = new SpeechPlayer({
    descriptor: speech,
    onMouthValue: value => {
      live2dCompanionSurface?.setSpeechMouthValue(value)
      live2dQuerySurface?.setSpeechMouthValue(value)
    },
    onPlayback: report => companion.reportSpeechPlayback(report),
  })
  speechPlayer = player
  const started = await player.start()
  if (generation !== speechPublishedGeneration) {
    player.dispose()
    return
  }
  if (!started) speechPlayer = undefined
}

function renderConnectionStatus(snapshot: CompanionConnectionSnapshot): void {
  endpointLabel.textContent = `127.0.0.1:${snapshot.port}`
  statusDot.dataset.state = snapshot.phase
  const labels: Record<CompanionConnectionSnapshot['phase'], string> = {
    stopped: 'Companion stopped',
    connecting: 'Connecting to Companion',
    connected: 'Companion connected',
    retrying: 'Waiting for Companion',
    error: 'Companion unavailable',
  }
  connectionLabel.textContent = labels[snapshot.phase]
  connectionLabel.title = snapshot.detail ?? ''
  live2dDiagnosticsPanel.generationButton.disabled = snapshot.phase !== 'connected'
  if (snapshot.phase !== 'connected' && live2dDiagnosticsPanel.generationStatus.textContent?.startsWith('request ') !== true) {
    live2dDiagnosticsPanel.generationStatus.textContent = `request: ${labels[snapshot.phase]}`
  }
}

function renderModelStatus(status: MmdModelStatus): void {
  modelLabel.dataset.state = status.phase
  const displayName = status.displayName ?? 'Local model'
  const labels: Record<MmdModelStatus['phase'], string> = {
    placeholder: 'Waiting for a local model',
    loading: `Loading ${displayName}`,
    ready: displayName,
    error: 'Model unavailable',
  }
  modelLabel.textContent = labels[status.phase]
  modelLabel.title = status.detail ?? ''

  if (status.phase === 'ready') {
    setTimeout(() => {
      void scene.playEmote({ emoteId: 'wave' })
    }, 600)
  }
}

function renderLive2dModelStatus(
  phase: 'loading' | 'ready' | 'error',
  model: ModelDescriptor,
  detail?: string,
): void {
  modelLabel.dataset.state = phase
  modelLabel.textContent = phase === 'loading'
    ? `Loading ${model.displayName}`
    : phase === 'ready'
      ? model.displayName
      : 'Live2D model unavailable'
  modelLabel.title = detail ?? ''
}

function setBrandingVisible(visible: boolean): void {
  brand.hidden = visible !== true
}

function setNativeContentEnabled(enabled: boolean): void {
  const previous = live2dNativeContentEnabled
  live2dNativeContentEnabled = enabled === true
  applyLive2dNativeContentPolicy()
  const model = live2dCompanionModel
  if (
    previous !== live2dNativeContentEnabled
    && model?.format === 'live2d'
    && model.nativeUrl !== undefined
    && live2dCompanionSurface !== undefined
  ) {
    void loadLive2dCompanionSurface(model)
  }
}

function resolveLive2dCompanionModelUrl(model: ModelDescriptor): string {
  return live2dNativeContentEnabled && model.nativeUrl !== undefined
    ? model.nativeUrl
    : model.url
}

/**
 * Fetches the model's calibration descriptor from the tokenized loopback URL.
 * A missing or invalid calibration file is a soft failure: the model still
 * loads with the sentinel-based rig profile and its default pose.
 */
async function fetchLive2dCalibration(url: string): Promise<import('@rayure/protocol').Live2dCalibrationDescriptor | undefined> {
  if (!isLoopbackAssetUrl(url)) return undefined
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store', credentials: 'omit' })
  }
  catch {
    return undefined
  }
  if (!response.ok) return undefined
  try {
    return parseLive2dCalibration(await response.json())
  }
  catch {
    return undefined
  }
}

function isLoopbackAssetUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      && url.port.length > 0
      && /^\/assets\/[A-Za-z0-9_-]{16,128}\/.+/u.test(url.pathname)
  }
  catch {
    return false
  }
}

function applyLive2dNativeContentPolicy(): void {
  const motions = live2dNativeContentEnabled ? live2dCompanionMotionCatalog : []
  live2dCompanionSurface?.updateMotionCatalog(motions)
  if (!live2dNativeContentEnabled) live2dCompanionSurface?.disableNativeMotion()
}

function applyAccent(color: typeof accent): void {
  document.documentElement.style.setProperty('--accent', toCssColor(color))
  document.documentElement.style.setProperty('--accent-soft', toCssColor(color, 0.16))
  document.documentElement.style.setProperty('--accent-faint', toCssColor(color, 0.055))
}

interface Live2dDiagnosticsPanel {
  root: HTMLElement
  note: HTMLElement
  values: HTMLElement
  expressions: HTMLElement
  expressionButtons: HTMLButtonElement[]
  motions: HTMLElement
  generated: HTMLElement
  replayGeneratedButton: HTMLButtonElement
  generationPrompt: HTMLInputElement
  generationButton: HTMLButtonElement
  generationStatus: HTMLElement
}

function createLive2dDiagnosticsPanel(visible: boolean): Live2dDiagnosticsPanel {
  const root = document.createElement('aside')
  root.className = 'live2d-diagnostics-panel'
  root.hidden = !visible
  root.setAttribute('aria-live', 'polite')

  const title = document.createElement('strong')
  title.textContent = 'Live2D diagnostics'
  const note = document.createElement('span')
  note.textContent = 'waiting for selected debug mode'
  const values = document.createElement('code')
  values.textContent = 'waiting for fixture'

  const toolbar = document.createElement('div')
  toolbar.className = 'live2d-diagnostics-toolbar'
  const backdropButton = createDiagnosticsButton('显示背景', () => {
    live2dDebugBackdropVisible = !live2dDebugBackdropVisible
    scene.setEnvironmentVisible(live2dDebugBackdropVisible)
    backdropButton.textContent = live2dDebugBackdropVisible ? '隐藏背景' : '显示背景'
  })
  const nativeButton = createDiagnosticsButton('启用原生动作', () => {
    setNativeContentEnabled(!live2dNativeContentEnabled)
    nativeButton.textContent = live2dNativeContentEnabled ? '关闭原生动作' : '启用原生动作'
    nativeSceneButton.disabled = !live2dNativeContentEnabled
  })
  nativeButton.textContent = live2dNativeContentEnabled ? '关闭原生动作' : '启用原生动作'
  const nativeSceneButton = createDiagnosticsButton('显示模型场景层', () => {
    live2dNativeSceneVisible = !live2dNativeSceneVisible
    nativeSceneButton.textContent = live2dNativeSceneVisible ? '隐藏模型场景层' : '显示模型场景层'
    if (live2dCompanionModel?.format === 'live2d') void loadLive2dCompanionSurface(live2dCompanionModel)
  })
  nativeSceneButton.disabled = !live2dNativeContentEnabled
  nativeSceneButton.textContent = live2dNativeSceneVisible ? '隐藏模型场景层' : '显示模型场景层'
  const resetButton = createDiagnosticsButton('表情复位', () => {
    requestLive2dExpression({ kind: 'reset' })
  })
  const stopButton = createDiagnosticsButton('停止动作', () => {
    live2dCompanionSurface?.stopMotion()
    live2dQuerySurface?.stopMotion()
  })
  toolbar.append(backdropButton, nativeButton, nativeSceneButton, resetButton, stopButton)

  const expressionLabel = document.createElement('span')
  expressionLabel.className = 'live2d-diagnostics-label'
  expressionLabel.textContent = '点击角色头部/身体触发动作；有 exp3 时可测试表情：'
  const expressionRow = document.createElement('div')
  expressionRow.className = 'live2d-diagnostics-expressions'
  const expressionButtons: HTMLButtonElement[] = []
  for (const [label, name] of [
    ['微笑', 'smile'],
    ['生气', 'angry'],
    ['惊讶', 'surprised'],
    ['眨眼', 'wink'],
    ['哭', 'cry'],
    ['撅嘴', 'pout'],
  ] as const) {
    const button = createDiagnosticsButton(label, () => {
      requestLive2dExpression({ kind: 'set', name, weight: 1 })
    })
    button.disabled = true
    expressionButtons.push(button)
    expressionRow.append(button)
  }
  const expressions = document.createElement('code')
  expressions.className = 'live2d-diagnostics-expressions-list'
  expressions.textContent = 'expressions: waiting for native model'
  const generationLabel = document.createElement('span')
  generationLabel.className = 'live2d-diagnostics-label'
  generationLabel.textContent = 'ARDY 调试生成（输入描述后发送到 Companion）：'
  const generationPrompt = document.createElement('input')
  generationPrompt.type = 'text'
  generationPrompt.className = 'live2d-diagnostics-input'
  generationPrompt.maxLength = 512
  generationPrompt.placeholder = '例如：A person waves their hand casually'
  generationPrompt.addEventListener('input', () => {
    live2dDebugMotionCacheKey = undefined
  })
  const generationPresets = document.createElement('div')
  generationPresets.className = 'live2d-diagnostics-expressions'
  const wavePreset = createDiagnosticsButton('填入挥手', () => {
    live2dDebugMotionCacheKey = 'wave.casual'
    generationPrompt.value = 'A person waves their hand casually'
    generationPrompt.focus()
  })
  const walkPreset = createDiagnosticsButton('填入走路', () => {
    live2dDebugMotionCacheKey = 'walk.forward'
    generationPrompt.value = 'A person walks forward slowly'
    generationPrompt.focus()
  })
  generationPresets.append(wavePreset, walkPreset)
  const generationButton = createDiagnosticsButton('让 ARDY 生成', () => {
    const prompt = generationPrompt.value.trim()
    if (prompt.length === 0) {
      generationStatus.textContent = 'request failed: prompt 不能为空'
      generationPrompt.focus()
      return
    }
    const requestId = companion.requestMotionGeneration({
      ...(live2dDebugMotionCacheKey === undefined ? {} : { id: live2dDebugMotionCacheKey }),
      prompt,
    })
    generationStatus.textContent = requestId === false
      ? 'request failed: Companion 未连接'
      : `request ${requestId} sent · waiting for ARDY`
  })
  generationButton.disabled = true
  const generationStatus = document.createElement('code')
  generationStatus.className = 'live2d-diagnostics-expressions-list'
  generationStatus.textContent = 'request: waiting for Companion'
  const generatedLabel = document.createElement('span')
  generatedLabel.className = 'live2d-diagnostics-label'
  generatedLabel.textContent = 'ARDY 生成动作（Canonical Motion）：'
  const generated = document.createElement('code')
  generated.className = 'live2d-diagnostics-expressions-list'
  generated.textContent = 'motion.published: waiting for ARDY'
  const replayGeneratedButton = createDiagnosticsButton('重播最近 ARDY 动作', () => {
    const motion = latestGeneratedMotion
    if (motion?.format === 'canonical') void handleMotionPublished(motion)
  })
  replayGeneratedButton.disabled = true
  const motionLabel = document.createElement('span')
  motionLabel.className = 'live2d-diagnostics-label'
  motionLabel.textContent = 'Live2D 原生动作（岛风 model3 内置）：'
  const motions = document.createElement('div')
  motions.className = 'live2d-diagnostics-expressions'
  motions.textContent = 'motions: waiting for Companion'

  root.append(
    title,
    note,
    values,
    toolbar,
    expressionLabel,
    expressionRow,
    expressions,
    generationLabel,
    generationPrompt,
    generationPresets,
    generationButton,
    generationStatus,
    generatedLabel,
    generated,
    replayGeneratedButton,
    motionLabel,
    motions,
  )
  document.body.append(root)
  return {
    root,
    note,
    values,
    expressions,
    expressionButtons,
    motions,
    generated,
    replayGeneratedButton,
    generationPrompt,
    generationButton,
    generationStatus,
  }
}

function createDiagnosticsButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}

function renderLive2dDebug(snapshot: Live2dDebugSnapshot): void {
  // The parameter probe runs alongside a native surface in debug mode. Once
  // the native surface exists, its snapshot is authoritative; otherwise the
  // fixture would overwrite the native status every render tick.
  if (!live2dDiagnosticsPanel || live2dNativeModelUrl !== undefined || live2dCompanionSurface !== undefined) return
  live2dDiagnosticsPanel.note.textContent = 'parameter path only · native Cubism model not loaded'
  const entries = Object.entries(snapshot.parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 6)
  live2dDiagnosticsPanel.values.textContent = entries.length > 0
    ? entries.map(([id, value]) => `${id}=${value.toFixed(1)}`).join(' · ')
    : 'waiting for fixture'
}

function renderLive2dSnapshot(snapshot: Live2dNativeSnapshot): void {
  live2dDiagnosticsPanel.note.textContent = snapshot.nativeModelLoaded
    ? `native Cubism model · ${snapshot.parameterIds.length} parameters${snapshot.activeMotionId === undefined ? '' : ` · ${snapshot.activeMotionId}`}`
    : `native Cubism model unavailable · ${snapshot.detail ?? 'loading'}`
  const entries = Object.entries(snapshot.parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 6)
  live2dDiagnosticsPanel.values.textContent = entries.length > 0
    ? entries.map(([id, value]) => `${id}=${value.toFixed(1)}`).join(' · ')
    : snapshot.detail ?? 'waiting for native model'
  live2dDiagnosticsPanel.expressions.textContent = snapshot.expressionIds.length > 0
    ? `expressions: ${snapshot.expressionIds.join(', ')}${snapshot.activeExpressionId === undefined ? '' : ` · active=${snapshot.activeExpressionId}`}`
    : 'expressions: none exposed by this model'
  for (const button of live2dDiagnosticsPanel.expressionButtons) button.disabled = snapshot.expressionIds.length === 0
}

function renderLive2dMotionCatalog(motions: readonly Live2dMotionDescriptor[]): void {
  live2dDiagnosticsPanel.motions.replaceChildren()
  if (motions.length === 0) {
    live2dDiagnosticsPanel.motions.textContent = 'motions: none exposed by this model'
    return
  }
  for (const motion of motions) {
    live2dDiagnosticsPanel.motions.append(createDiagnosticsButton(motion.displayName, () => {
      requestLive2dMotion(motion)
    }))
  }
}

function renderLive2dGeneratedMotion(
  motion: MotionDescriptor | undefined,
  state: string,
): void {
  if (motion === undefined || motion.format !== 'canonical') {
    live2dDiagnosticsPanel.generated.textContent = 'motion.published: waiting for ARDY'
    live2dDiagnosticsPanel.replayGeneratedButton.disabled = true
    return
  }
  live2dDiagnosticsPanel.generated.textContent = `ARDY canonical · ${motion.displayName} · ${motion.id} · ${state}`
  live2dDiagnosticsPanel.generationStatus.textContent = `motion ${motion.id} · ${state}`
  live2dDiagnosticsPanel.replayGeneratedButton.disabled = false
}

function renderLive2dGeneratedMotionPlayback(observation: {
  motionId: string
  phase: 'started' | 'progress' | 'completed' | 'cancelled'
  frameIndex: number
}): void {
  if (latestGeneratedMotion?.format !== 'canonical' || latestGeneratedMotion.id !== observation.motionId) return
  const state = observation.phase === 'started'
    ? 'playing'
    : observation.phase === 'progress'
      ? `playing frame ${observation.frameIndex}`
      : observation.phase
  renderLive2dGeneratedMotion(latestGeneratedMotion, state)
}

function parseLocalLive2dDebugUrl(value: string | null): string | undefined {
  if (value === null || value.trim() !== value || value.length === 0 || value.length > 2048) return undefined
  if (value.startsWith('/@fs/') || /^https?:\/\/127\.0\.0\.1(?::\d{1,5})?\//u.test(value)) return value
  return undefined
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Required wallpaper element is missing: ${id}`)
  return element
}
