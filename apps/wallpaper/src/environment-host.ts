import * as THREE from 'three'

export interface EnvironmentHostOptions {
  scale?: number
}

export class EnvironmentHost {
  private readonly scene: THREE.Scene
  private group: THREE.Group | undefined
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
      const roomTexture = await new Promise<THREE.Texture>((resolve) => {
        textureLoader.load('/assets/scenes/japanese_room.png', resolve)
      })
      roomTexture.colorSpace = THREE.SRGBColorSpace

      // 2. 创建无缝全景和风障子窗与书架幕墙 (16:9 宽屏无死角覆盖，Z = -2.2)
      const backWallGeo = new THREE.PlaneGeometry(14.0, 7.8)
      const backWallMat = new THREE.MeshStandardMaterial({
        map: roomTexture,
        roughness: 0.65,
        metalness: 0.02,
      })
      const backWall = new THREE.Mesh(backWallGeo, backWallMat)
      backWall.position.set(0, 0.2, -2.2)
      backWall.receiveShadow = true
      group.add(backWall)

      // 3. 榻榻米实木地板 (采用温润暖浅木色，Y = -1.15，彻底消除任何倒影杂质)
      const floorGeo = new THREE.PlaneGeometry(14.0, 7.0)
      const floorMat = new THREE.MeshStandardMaterial({
        color: 0xf5ebd7,
        roughness: 0.75,
        metalness: 0.05,
      })
      const floor = new THREE.Mesh(floorGeo, floorMat)
      floor.rotation.x = -Math.PI / 2
      floor.position.set(0, -1.15, 0.3)
      floor.receiveShadow = true
      group.add(floor)

      // 4. 室内冷暖光影系统
      // 基础环境暖色漫射光
      const ambientLight = new THREE.AmbientLight(0xffeedd, 2.1)
      group.add(ambientLight)

      // 窗外晨曦和风阳光 (穿透障子格栅窗的柔和白色主光)
      const sunLight = new THREE.DirectionalLight(0xfff6ea, 2.5)
      sunLight.position.set(4.0, 5.5, 3.5)
      sunLight.castShadow = true
      group.add(sunLight)

      // 胡桃面部与发丝高光补光 (柔粉暖白，凸显二次元通透眼眸与发丝反光)
      const faceLight = new THREE.DirectionalLight(0xfff0f5, 1.4)
      faceLight.position.set(-1.0, 2.0, 3.2)
      group.add(faceLight)

      this.group = group
      this.scene.add(this.group)

      console.log('[EnvironmentHost] SUCCESS: High-fidelity seamless Japanese Cozy Room mounted!')
      return true
    } catch (err) {
      console.error('[EnvironmentHost] Failed to setup Japanese Room stage:', err)
      return false
    }
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
