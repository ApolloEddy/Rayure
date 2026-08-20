import './style.css'

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
import type { WallpaperPropertyListener } from './wallpaper-api.ts'

const BUILD = '0.2.0-m1'
const stage = requireElement('stage')
const connectionLabel = requireElement('connection-label')
const endpointLabel = requireElement('endpoint-label')
const statusDot = requireElement('status-dot')
const connectionPanel = requireElement('connection')
const modelLabel = requireElement('model-label')
const live2dDebugEnabled = new URLSearchParams(window.location.search).get('live2dDebug') === '1'
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
  live2dDebug: live2dDebugEnabled,
  onLive2dDebug: renderLive2dDebug,
})
window.__rayure_scene__ = scene

const companion = new CompanionClient({
  port: companionPort,
  build: BUILD,
  onStatus: renderConnectionStatus,
  onModelAvailable: (model) => {
    void scene.loadModel(model)
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
  scene.dispose()
}, { once: true })

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

function applyAccent(color: typeof accent): void {
  document.documentElement.style.setProperty('--accent', toCssColor(color))
  document.documentElement.style.setProperty('--accent-soft', toCssColor(color, 0.16))
  document.documentElement.style.setProperty('--accent-faint', toCssColor(color, 0.055))
}

function createLive2dDebugPanel(): {
  root: HTMLElement
  values: HTMLElement
} {
  const root = document.createElement('aside')
  root.className = 'live2d-debug-panel'
  root.setAttribute('aria-live', 'polite')

  const title = document.createElement('strong')
  title.textContent = 'Live2D debug probe'
  const note = document.createElement('span')
  note.textContent = 'parameter path only · native Cubism model not loaded'
  const values = document.createElement('code')
  values.textContent = 'waiting for fixture'
  root.append(title, note, values)
  document.body.append(root)
  return { root, values }
}

function renderLive2dDebug(snapshot: Live2dDebugSnapshot): void {
  if (!live2dDebugPanel) return
  const entries = Object.entries(snapshot.parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 6)
  live2dDebugPanel.values.textContent = entries.length > 0
    ? entries.map(([id, value]) => `${id}=${value.toFixed(1)}`).join(' · ')
    : 'waiting for fixture'
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
