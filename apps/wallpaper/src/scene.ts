import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  Mesh,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  TorusGeometry,
  WebGLRenderer,
} from 'three'

import type { AccentColor } from './config.ts'
import { MmdModelHost } from './mmd-model-host.ts'
import type { MmdModelLoadOutcome, MmdModelStatus } from './mmd-model-host.ts'
import { EnvironmentHost } from './environment-host.ts'
import type { ModelDescriptor, MotionDescriptor } from '@rayure/protocol'
import {
  createLive2dDebugMotion,
  Live2dDebugProbe,
} from './live2d/debug-probe.ts'
import type { Live2dDebugSnapshot } from './live2d/debug-probe.ts'

export interface RayureSceneOptions {
  onModelStatus?: (status: MmdModelStatus) => void
  live2dDebug?: boolean | undefined
  onLive2dDebug?: ((snapshot: Live2dDebugSnapshot) => void) | undefined
}

export class RayureScene {
  readonly #container: HTMLElement
  readonly #renderer: WebGLRenderer
  readonly #scene = new Scene()
  readonly #camera = new PerspectiveCamera(38, 1, 0.1, 100)
  readonly #avatar = new Group()
  readonly #placeholder = new Group()
  readonly #modelMount = new Group()
  readonly #modelHost: MmdModelHost
  readonly #environment: EnvironmentHost
  readonly #live2dDebugProbe: Live2dDebugProbe | undefined
  readonly #live2dDebugMotion = createLive2dDebugMotion()
  readonly #coreMaterial: MeshPhysicalMaterial
  readonly #ringMaterials: MeshPhysicalMaterial[]
  readonly #particlesMaterial: PointsMaterial
  readonly #particles: Points
  #fps = 30
  #paused = false
  #disposed = false
  #animationFrame: number | undefined
  #lastRenderedAt = 0
  #pointerX = 0
  #pointerY = 0

  constructor(container: HTMLElement, accent: AccentColor, options: RayureSceneOptions = {}) {
    this.#container = container
    this.#renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    this.#renderer.outputColorSpace = 'srgb'
    this.#renderer.domElement.setAttribute('aria-label', 'Rayure 3D wallpaper stage')
    this.#container.append(this.#renderer.domElement)

    this.#camera.position.set(0, 0.05, 3.1)

    this.#environment = new EnvironmentHost(this.#scene)
    void this.#environment.load()
    ;(window as any).__three_scene__ = this.#scene
    ;(window as any).__three_camera__ = this.#camera

    const color = toThreeColor(accent)
    this.#coreMaterial = new MeshPhysicalMaterial({
      color,
      emissive: color.clone().multiplyScalar(0.16),
      roughness: 0.23,
      metalness: 0.38,
      transmission: 0.12,
      clearcoat: 1,
      clearcoatRoughness: 0.18,
    })
    const core = new Mesh(new IcosahedronGeometry(1.05, 4), this.#coreMaterial)
    this.#placeholder.add(core)

    this.#ringMaterials = [0.9, 0.42].map(opacity => new MeshPhysicalMaterial({
      color,
      emissive: color.clone().multiplyScalar(0.3),
      metalness: 0.72,
      roughness: 0.25,
      transparent: true,
      opacity,
    }))
    const outerRing = new Mesh(new TorusGeometry(1.62, 0.018, 12, 180), this.#ringMaterials[0])
    outerRing.rotation.set(Math.PI * 0.56, Math.PI * 0.08, 0)
    const innerRing = new Mesh(new TorusGeometry(1.35, 0.012, 10, 160), this.#ringMaterials[1])
    innerRing.rotation.set(Math.PI * 0.14, Math.PI * 0.62, Math.PI * 0.08)
    this.#placeholder.add(outerRing, innerRing)
    this.#avatar.add(this.#placeholder, this.#modelMount)
    this.#scene.add(this.#avatar)

    this.#modelHost = new MmdModelHost(this.#modelMount, {
      targetHeight: 2.05,
      floorY: -1.15,
      onStatus: (status) => {
        if (status.phase === 'ready') this.#placeholder.visible = false
        options.onModelStatus?.(status)
      },
    })

    this.#live2dDebugProbe = options.live2dDebug === true
      ? new Live2dDebugProbe({ onSnapshot: options.onLive2dDebug })
      : undefined
    this.#live2dDebugProbe?.bind(this.#live2dDebugMotion)

    this.#particlesMaterial = new PointsMaterial({
      color: 0xffe6cc,
      size: 0.022,
      transparent: true,
      opacity: 0.55,
      blending: AdditiveBlending,
      depthWrite: false,
    })
    this.#particles = createParticleField(this.#particlesMaterial)
    this.#scene.add(this.#particles)

    window.addEventListener('resize', this.#resize)
    window.addEventListener('pointermove', this.#onPointerMove, { passive: true })
    this.#resize()
  }

  start(): void {
    if (this.#disposed || this.#animationFrame !== undefined) return
    this.#lastRenderedAt = performance.now()
    this.#animationFrame = requestAnimationFrame(this.#render)
  }

  setFps(fps: number): void {
    this.#fps = fps
  }

  setPaused(paused: boolean): void {
    this.#paused = paused
    if (!paused) this.#lastRenderedAt = performance.now()
  }

  setAccent(accent: AccentColor): void {
    const color = toThreeColor(accent)
    this.#coreMaterial.color.copy(color)
    this.#coreMaterial.emissive.copy(color).multiplyScalar(0.16)
    for (const material of this.#ringMaterials) {
      material.color.copy(color)
      material.emissive.copy(color).multiplyScalar(0.3)
    }
    this.#particlesMaterial.color.copy(color)
  }

  setModelScale(scale: number): void {
    this.#avatar.scale.setScalar(scale)
  }

  /**
   * Toggles the 3D placeholder decoration (core orb, rings, particles).
   * Live2D playback draws on its own canvas, so the placeholder must be
   * hidden to keep it from sitting behind the character.
   */
  setDecorVisible(visible: boolean): void {
    this.#placeholder.visible = visible
    this.#particles.visible = visible
  }

  loadModel(descriptor: ModelDescriptor): Promise<MmdModelLoadOutcome> {
    return this.#modelHost.load(descriptor)
  }

  updateMotionCatalog(motions: readonly MotionDescriptor[]): void {
    this.#modelHost.updateMotionCatalog(motions)
  }

  playEmote(options: { emoteId: string, motionId?: string, expressionName?: string, expressionWeight?: number, durationMs?: number }): Promise<boolean> {
    return this.#modelHost.playEmote(options)
  }

  playMotion(descriptor: MotionDescriptor): Promise<boolean> {
    return this.#modelHost.playMotion(descriptor)
  }

  stopMotion(motionId?: string): void {
    this.#modelHost.stopMotion(motionId)
  }

  setExpression(name: string, weight: number, durationMs?: number): void {
    this.#modelHost.setExpression(name, weight, durationMs)
  }

  resetExpression(durationMs?: number): void {
    this.#modelHost.resetExpression(durationMs)
  }

  setAutoBlink(enabled: boolean): void {
    this.#modelHost.setAutoBlink(enabled)
  }

  get modelHost(): MmdModelHost {
    return this.#modelHost
  }

  get live2dDebugProbe(): Live2dDebugProbe | undefined {
    return this.#live2dDebugProbe
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#animationFrame !== undefined) cancelAnimationFrame(this.#animationFrame)
    this.#animationFrame = undefined
    window.removeEventListener('resize', this.#resize)
    window.removeEventListener('pointermove', this.#onPointerMove)
    this.#live2dDebugProbe?.dispose()
    this.#modelHost.dispose()
    this.#environment.dispose()
    this.#scene.traverse((node) => {
      if (node instanceof Mesh || node instanceof Points) {
        node.geometry.dispose()
        const materials = Array.isArray(node.material) ? node.material : [node.material]
        for (const material of materials) material.dispose()
      }
    })
    this.#renderer.dispose()
    this.#renderer.domElement.remove()
  }

  readonly #render = (timestamp: number): void => {
    if (this.#disposed) return
    this.#animationFrame = requestAnimationFrame(this.#render)
    if (this.#paused || timestamp - this.#lastRenderedAt < 1000 / this.#fps) return
    const deltaSeconds = Math.min((timestamp - this.#lastRenderedAt) / 1000, 0.1)
    this.#lastRenderedAt = timestamp

    this.#modelHost.advance(deltaSeconds, this.#pointerX, this.#pointerY)
    this.#live2dDebugProbe?.advance(deltaSeconds, this.#live2dDebugMotion)

    this.#avatar.rotation.x += (this.#pointerY * 0.03 - this.#avatar.rotation.x) * Math.min(1, deltaSeconds * 1.5)
    this.#avatar.rotation.y += (this.#pointerX * 0.04 - this.#avatar.rotation.y) * Math.min(1, deltaSeconds * 1.5)
    this.#avatar.rotation.z = 0
    this.#camera.position.x += (this.#pointerX * 0.08 - this.#camera.position.x) * Math.min(1, deltaSeconds * 1.5)
    this.#camera.position.y += (0.15 - this.#pointerY * 0.05 - this.#camera.position.y) * Math.min(1, deltaSeconds * 1.5)
    this.#camera.lookAt(0, 0, 0)
    this.#renderer.render(this.#scene, this.#camera)
  }

  readonly #resize = (): void => {
    const width = Math.max(1, this.#container.clientWidth)
    const height = Math.max(1, this.#container.clientHeight)
    this.#camera.aspect = width / height
    this.#camera.updateProjectionMatrix()
    this.#renderer.setSize(width, height, false)
  }

  readonly #onPointerMove = (event: PointerEvent): void => {
    this.#pointerX = event.clientX / Math.max(1, window.innerWidth) * 2 - 1
    this.#pointerY = event.clientY / Math.max(1, window.innerHeight) * 2 - 1
  }
}

function createParticleField(material: PointsMaterial): Points {
  const positions: number[] = []
  for (let index = 0; index < 420; index += 1) {
    const radius = 4 + (index % 29) * 0.17
    const angle = index * 2.399963229728653
    positions.push(
      Math.cos(angle) * radius,
      ((index * 37) % 101) / 10 - 5,
      Math.sin(angle) * radius - 3,
    )
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  return new Points(geometry, material)
}

function toThreeColor(color: AccentColor): Color {
  return new Color(color.r / 255, color.g / 255, color.b / 255)
}
