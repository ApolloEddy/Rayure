import type { Group, SkinnedMesh } from 'three'

/**
 * 常见非标准/游戏解包 PMX 模型骨骼别名重映射表
 * 将各种混淆名（B01, Finger3, x 等）无缝对齐到 MMD 工业级标准骨骼名
 */
export const STANDARD_BONE_ALIASES: Record<string, readonly string[]> = {
  '左腕': ['B01', 'arm twist_L', 'UpperArm_L', 'LeftArm', '左腕捩1'],
  '左ひじ': ['D01', 'Forearm_L', 'LeftForeArm', '左ひじ捩1'],
  '左手首': [' R A02', 'R A02', 'dummy_L', 'Hand_L', 'LeftHand'],
  '右腕': [' Finger3', 'Finger3', 'arm twist_R', 'UpperArm_R', 'RightArm', '右腕捩1'],
  '右ひじ': [' Finger4', 'Finger4', 'Forearm_R', 'RightForeArm', '右ひじ捩1'],
  '右手首': [' Finger02', 'Finger02', 'dummy_R', 'Hand_R', 'RightHand'],
  '上半身': ['x', 'Spine', 'Chest', '上半身1'],
  '上半身2': ['・', 'Spine1', 'Chest2'],
  '左ひざ': ['D02', 'LeftLeg', '左ひざ1'],
  '左足首': ['D03', 'LeftFoot', '左足首1'],
  '右ひざ': ['D06', 'RightLeg', '右ひざ1'],
  '右足首': ['G02', 'RightFoot', '右足首1'],
}

/**
 * 为模型的骨骼进行标准化重命名对齐，确保 VMD 动作轨道能 100% 精准绑定到角色骨骼上
 */
export function remapModelBones(root: Group): number {
  let remappedCount = 0
  root.traverse((child) => {
    const mesh = child as SkinnedMesh
    if (mesh.isSkinnedMesh && mesh.skeleton?.bones) {
      const existingNames = new Set(mesh.skeleton.bones.map(b => b.name))
      for (const bone of mesh.skeleton.bones) {
        for (const [standardName, aliases] of Object.entries(STANDARD_BONE_ALIASES)) {
          if (!existingNames.has(standardName)) {
            const rawName = bone.name
            const trimmed = rawName.trim()
            if (aliases.includes(rawName) || aliases.includes(trimmed)) {
              bone.name = standardName
              existingNames.add(standardName)
              remappedCount += 1
              break
            }
          }
        }
      }
    }
  })
  return remappedCount
}
