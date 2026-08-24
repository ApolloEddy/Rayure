import * as THREE from 'three'

export interface EnvironmentHostOptions {
  scale?: number
}

export class EnvironmentHost {
  private readonly scene: THREE.Scene
  private group: THREE.Group | undefined
  private visible = true
  private isDisposed = false

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  async load(options: EnvironmentHostOptions = {}): Promise<boolean> {
    if (this.isDisposed) return false
    this.dispose()
    this.isDisposed = false

    try {
      const group = new THREE.Group()
      group.name = 'JapaneseRoomStage'

      // 1. 加载和风室内原画烘焙高精贴图
      const textureLoader = new THREE.TextureLoader()
      const roomTexture = await new Promise<THREE.Texture>((resolve, reject) => {
        textureLoader.load('/assets/scenes/japanese_room.png', resolve, undefined, reject)
      })
      roomTexture.colorSpace = THREE.SRGBColorSpace

      // Keep the source square and crop its edges instead of stretching it
      // into a fake 16:9 room. The plane is deliberately oversized so it
      // covers wide screens without leaving a second, overexposed floor slab.
      const backWallGeo = new THREE.PlaneGeometry(2.0, 2.0)
      const backWallMat = new THREE.MeshBasicMaterial({
        map: roomTexture,
      })
      const backWall = new THREE.Mesh(backWallGeo, backWallMat)
      backWall.position.set(0, 0, -2.2)
      backWall.scale.setScalar(2.2)
      group.add(backWall)

      // 3. 室内冷暖光影系统 for an optional PMX foreground.
      // 基础环境暖色漫射光
      const ambientLight = new THREE.AmbientLight(0xffeedd, 1.35)
      group.add(ambientLight)

      // 窗外晨曦和风阳光 (穿透障子格栅窗的柔和白色主光)
      const sunLight = new THREE.DirectionalLight(0xfff6ea, 1.6)
      sunLight.position.set(4.0, 5.5, 3.5)
      sunLight.castShadow = true
      group.add(sunLight)

      // 胡桃面部与发丝高光补光 (柔粉暖白，凸显二次元通透眼眸与发丝反光)
      const faceLight = new THREE.DirectionalLight(0xfff0f5, 0.9)
      faceLight.position.set(-1.0, 2.0, 3.2)
      group.add(faceLight)

      this.group = group
      this.group.visible = this.visible
      this.scene.add(this.group)

      console.log('[EnvironmentHost] Optional square-cropped room backdrop mounted.')
      return true
    } catch (err) {
      console.error('[EnvironmentHost] Failed to setup Japanese Room stage:', err)
      return false
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible === true
    if (this.group !== undefined) this.group.visible = this.visible
  }

  dispose(): void {
    this.isDisposed = true
    if (this.group) {
      this.scene.remove(this.group)
      this.group.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const m = child as THREE.Mesh
          m.geometry?.dispose()
          if (Array.isArray(m.material)) {
            m.material.forEach((mat) => mat.dispose())
          } else {
            m.material?.dispose()
          }
        }
      })
      this.group = undefined
    }
  }
}
