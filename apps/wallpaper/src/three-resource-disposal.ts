import {
  Material,
  Mesh,
  Object3D,
  SkinnedMesh,
  Texture,
} from 'three'

/**
 * Releases one detached model tree without importing the full MMD host.
 * Textures are disposed only when the loader explicitly marked ownership, so
 * shared Toon/environment textures remain available to the surrounding scene.
 */
export function disposeThreeObjectResources(root: Object3D): void {
  root.removeFromParent()
  const geometries = new Set<{ dispose(): void }>()
  const materials = new Set<Material>()
  const textures = new Set<Texture>()
  const skeletons = new Set<{ dispose(): void }>()
  root.traverse((node) => {
    if (node instanceof Mesh) {
      geometries.add(node.geometry)
      const nodeMaterials = Array.isArray(node.material) ? node.material : [node.material]
      for (const material of nodeMaterials) {
        materials.add(material)
        for (const value of Object.values(material)) {
          if (value instanceof Texture && value.userData.mmdTextureOwnership === 'loader') {
            textures.add(value)
          }
        }
      }
    }
    if (node instanceof SkinnedMesh) skeletons.add(node.skeleton)
  })
  for (const skeleton of skeletons) skeleton.dispose()
  for (const geometry of geometries) geometry.dispose()
  for (const material of materials) material.dispose()
  for (const texture of textures) texture.dispose()
  root.clear()
}
