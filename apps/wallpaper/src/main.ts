import './style.css'

import type { ModelDescriptor } from '@rayure/protocol'
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
void live2dQuerySurface?.start()

const companion = new CompanionClient({
  port: companionPort,
  build: BUILD,
  onStatus: renderConnectionStatus,
  onModelAvailable: (model) => {
    void handleModelAvailable(model)
  },
  onMotionCatalog: (motions) => {
    scene.updateMotionCatalog(motions)
  },
  onEmotePlay: (payload) => {
    void scene.playEmote(payload)
  },
  onMotionPlay: (motion) => {
    void scene.playMotion(motion)
  },
  onMotionStop: (motionId) => {
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
    void scene.loadModel(model)
    return
  }

  if (live2dQuerySurface !== undefined) return
  const generation = ++live2dCompanionGeneration
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
  const loaded = await surface.start()
  if (generation !== live2dCompanionGeneration) return
  if (!loaded) renderLive2dModelStatus('error', model, 'Live2D model unavailable')
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
    ? `native Cubism model · ${snapshot.parameterIds.length} parameters`
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
    }
  })
}
