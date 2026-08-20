import './style.css'

import type { Live2dMotionDescriptor, ModelDescriptor } from '@rayure/protocol'
import { CompanionClient } from './companion-client.ts'
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
  Live2dNativeDebugSurface,
} from './live2d/native-debug-surface.ts'
import type { Live2dNativeDebugSnapshot } from './live2d/native-debug-surface.ts'
import type { WallpaperPropertyListener } from './wallpaper-api.ts'

const BUILD = '0.2.0-m1'
const stage = requireElement('stage')
const connectionLabel = requireElement('connection-label')
const endpointLabel = requireElement('endpoint-label')
const statusDot = requireElement('status-dot')
const connectionPanel = requireElement('connection')
const modelLabel = requireElement('model-label')
const debugQuery = new URLSearchParams(window.location.search)
const live2dParameterProbeEnabled = debugQuery.get('live2dDebug') === '1'
const live2dNativeModelUrl = parseLocalLive2dDebugUrl(debugQuery.get('live2dModelUrl'))
const live2dDebugEnabled = live2dParameterProbeEnabled || live2dNativeModelUrl !== undefined
const live2dDebugPanel = live2dDebugEnabled ? createLive2dDebugPanel() : undefined

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

const live2dQuerySurface = live2dNativeModelUrl === undefined
  ? undefined
  : new Live2dNativeDebugSurface(stage, {
    modelUrl: live2dNativeModelUrl,
    onSnapshot: renderLive2dNativeDebug,
  })
let live2dCompanionSurface: Live2dNativeDebugSurface | undefined
let live2dCompanionGeneration = 0
let live2dCompanionModel: ModelDescriptor | undefined
let live2dCompanionMotionCatalog: readonly Live2dMotionDescriptor[] = []
let pendingLive2dMotion: Live2dMotionDescriptor | undefined
void live2dQuerySurface?.start()

const companion = new CompanionClient({
  port: companionPort,
  build: BUILD,
  onStatus: renderConnectionStatus,
  onModelAvailable: (model) => {
    void handleModelAvailable(model)
  },
  onMotionCatalog: (motions) => {
    live2dCompanionMotionCatalog = motions.filter((motion): motion is Live2dMotionDescriptor => motion.format === 'live2d')
    live2dCompanionSurface?.updateMotionCatalog(motions)
    scene.updateMotionCatalog(motions.filter(motion => motion.format === 'vmd'))
    renderLive2dMotionToolbar(live2dCompanionMotionCatalog)
  },
  onEmotePlay: (payload) => {
    if (live2dCompanionModel?.format === 'live2d') {
      const motion = payload.motionId === undefined
        ? undefined
        : live2dCompanionMotionCatalog.find(item => item.id === payload.motionId)
      if (motion !== undefined) requestLive2dMotion(motion)
      return
    }
    void scene.playEmote(payload)
  },
  onMotionPlay: (motion) => {
    if (motion.format === 'live2d' && live2dCompanionModel?.format === 'live2d') {
      requestLive2dMotion(motion)
      return
    }
    if (motion.format === 'vmd') void scene.playMotion(motion)
  },
  onMotionStop: (motionId) => {
    if (live2dCompanionModel?.format === 'live2d') {
      pendingLive2dMotion = undefined
      live2dCompanionSurface?.stopMotion(motionId)
      return
    }
    scene.stopMotion(motionId)
  },
  onExpressionSet: (payload) => {
    scene.setExpression(payload.name, payload.weight, payload.durationMs)
  },
  onExpressionReset: (payload) => {
    scene.resetExpression(payload?.durationMs)
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
scene.start()
companion.start()

window.addEventListener('beforeunload', () => {
  companion.stop()
  live2dCompanionGeneration += 1
  live2dQuerySurface?.dispose()
  live2dCompanionSurface?.dispose()
  scene.dispose()
}, { once: true })

async function handleModelAvailable(model: ModelDescriptor): Promise<void> {
  if (model.format === 'pmx') {
    live2dCompanionGeneration += 1
    live2dCompanionSurface?.dispose()
    live2dCompanionSurface = undefined
    live2dCompanionModel = undefined
    live2dCompanionMotionCatalog = []
    pendingLive2dMotion = undefined
    renderLive2dMotionToolbar([])
    void scene.loadModel(model)
    return
  }

  if (live2dQuerySurface !== undefined) return
  const generation = ++live2dCompanionGeneration
  live2dCompanionModel = model
  pendingLive2dMotion = undefined
  live2dCompanionSurface?.dispose()
  const surface = new Live2dNativeDebugSurface(stage, {
    modelUrl: model.url,
    onSnapshot: (snapshot) => {
      if (generation !== live2dCompanionGeneration) return
      renderLive2dNativeDebug(snapshot)
      renderLive2dModelStatus(
        snapshot.nativeModelLoaded ? 'ready' : snapshot.detail === 'Loading Cubism Core and model' ? 'loading' : 'error',
        model,
        snapshot.detail,
      )
    },
  })
  live2dCompanionSurface = surface
  surface.updateMotionCatalog(live2dCompanionMotionCatalog)
  const loaded = await surface.start()
  if (generation !== live2dCompanionGeneration) return
  if (!loaded) {
    renderLive2dModelStatus('error', model, 'Live2D model unavailable')
    return
  }
  const requestedMotion = pendingLive2dMotion
  pendingLive2dMotion = undefined
  if (requestedMotion !== undefined) void surface.playMotion(requestedMotion)
  else void surface.playDefaultMotion()
}

function requestLive2dMotion(motion: Live2dMotionDescriptor): void {
  if (live2dCompanionModel?.format !== 'live2d') return
  if (!live2dCompanionSurface?.isReady) {
    pendingLive2dMotion = motion
    return
  }
  pendingLive2dMotion = undefined
  void live2dCompanionSurface.playMotion(motion)
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

function applyAccent(color: typeof accent): void {
  document.documentElement.style.setProperty('--accent', toCssColor(color))
  document.documentElement.style.setProperty('--accent-soft', toCssColor(color, 0.16))
  document.documentElement.style.setProperty('--accent-faint', toCssColor(color, 0.055))
}

function createLive2dDebugPanel(): {
  root: HTMLElement
  note: HTMLElement
  values: HTMLElement
} {
  const root = document.createElement('aside')
  root.className = 'live2d-debug-panel'
  root.setAttribute('aria-live', 'polite')

  const title = document.createElement('strong')
  title.textContent = 'Live2D debug'
  const note = document.createElement('span')
  note.textContent = 'waiting for selected debug mode'
  const values = document.createElement('code')
  values.textContent = 'waiting for fixture'
  root.append(title, note, values)
  document.body.append(root)
  return { root, note, values }
}

function renderLive2dDebug(snapshot: Live2dDebugSnapshot): void {
  if (!live2dDebugPanel) return
  live2dDebugPanel.note.textContent = 'parameter path only · native Cubism model not loaded'
  const entries = Object.entries(snapshot.parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 6)
  live2dDebugPanel.values.textContent = entries.length > 0
    ? entries.map(([id, value]) => `${id}=${value.toFixed(1)}`).join(' · ')
    : 'waiting for fixture'
}

function renderLive2dNativeDebug(snapshot: Live2dNativeDebugSnapshot): void {
  if (!live2dDebugPanel) return
  live2dDebugPanel.note.textContent = snapshot.nativeModelLoaded
    ? `native Cubism model · ${snapshot.parameterIds.length} parameters${snapshot.activeMotionId === undefined ? '' : ` · ${snapshot.activeMotionId}`}`
    : `native Cubism model unavailable · ${snapshot.detail ?? 'loading'}`
  const entries = Object.entries(snapshot.parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 6)
  live2dDebugPanel.values.textContent = entries.length > 0
    ? entries.map(([id, value]) => `${id}=${value.toFixed(1)}`).join(' · ')
    : snapshot.detail ?? 'waiting for native model'
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

function renderLive2dMotionToolbar(motions: readonly Live2dMotionDescriptor[]): void {
  const panel = document.getElementById('debug-panel')
  if (!panel) return
  const previous = panel.querySelector('[data-live2d-motion-group]')
  previous?.remove()
  if (motions.length === 0) return

  const group = document.createElement('div')
  group.className = 'debug-toolbar__group'
  group.dataset.live2dMotionGroup = 'true'

  const label = document.createElement('span')
  label.className = 'debug-toolbar__label'
  label.textContent = 'Live2D 原生动作'
  const buttons = document.createElement('div')
  buttons.className = 'debug-toolbar__buttons'
  for (const motion of motions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.live2dMotion = motion.id
    button.textContent = `▶ ${motion.displayName}`
    buttons.append(button)
  }
  const stop = document.createElement('button')
  stop.type = 'button'
  stop.dataset.live2dStop = 'true'
  stop.textContent = '■ 停止 Live2D 动作'
  buttons.append(stop)
  group.append(label, buttons)
  panel.append(group)
}

setupDebugToolbar(scene)

function setupDebugToolbar(activeScene: RayureScene): void {
  const toggle = document.getElementById('debug-toggle')
  const panel = document.getElementById('debug-panel')
  if (!toggle || !panel) return

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden
  })

  panel.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement)?.closest('button')
    if (!target) return

    const emoteId = target.getAttribute('data-emote')
    if (emoteId) {
      void activeScene.playEmote({ emoteId })
      return
    }

    const expr = target.getAttribute('data-expr')
    if (expr) {
      if (expr === 'reset') {
        activeScene.resetExpression(200)
      }
      else {
        activeScene.setExpression(expr, 1.0, 150)
      }
      return
    }

    const live2dMotionId = target.getAttribute('data-live2d-motion')
    if (live2dMotionId) {
      const motion = live2dCompanionMotionCatalog.find(item => item.id === live2dMotionId)
      if (motion !== undefined) requestLive2dMotion(motion)
      return
    }

    if (target.getAttribute('data-live2d-stop') === 'true') {
      pendingLive2dMotion = undefined
      live2dCompanionSurface?.stopMotion()
    }
  })
}
