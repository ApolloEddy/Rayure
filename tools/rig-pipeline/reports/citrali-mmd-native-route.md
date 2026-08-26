# Citrali PMX 原生导入、双映射路线与贴图证据

日期：2026-08-26
状态：`ROUTE-A-PASS / ROUTE-B-RETAINED / TEXTURE-PASS`

本报告只记录外部模型的脱敏验证结果。PMX、纹理、GLB 和渲染图均保留在仓库外的本机目录，未加入 Git。

## 路线选择

两条路线都保留，但每条路线都必须独立从干净 Blender scene 开始，并通过同一组门禁后才能进入 bake；不合并两个插件的局部结果，也不新增 Rayure alias、正则或字典。

1. **Route A（当前优先）**：MMD Tools 原始日文骨名（`rename_bones=false`、`dictionary=DISABLED`）→ Rig Bridge/HRS 自带 `MMD FK` 识别。
2. **Route B（fallback）**：MMD Tools 自带 `INTERNAL` 字典→插件自己的通用识别/ARP 原生预设能力。它只在 Route A 的覆盖率、姿态或语义门禁失败时尝试；结果仍需完整审计。

对本次官方公开 PMX 的结果：

| 路线 | 目标 profile | 核心覆盖 | 姿态门 | 结果 |
|---|---|---:|---:|---|
| A：原始日文 → HRS MMD FK | `MMD FK` | 15/15 | PASS | **可 bake** |
| B：INTERNAL 英文 → HRS Generic | `Generic Humanoid` | 13/15 | PASS | 不通过，保留为 fallback 证据 |

Route A 的 15 个核心角色均为正确的日文 MMD 骨（置信度 0.96），随后完成 100 帧 ARDY BVH → 目标模型原骨架 bake。输出仍是目标模型自己的 495 骨 armature，并非 ARDY 27 骨架。

ARP Quick Rig 的内置 `mixamo` fuzzy preset 在该 MMD 骨架上返回 `FINISHED` 但语义错配，不能把“非空映射”当作成功；本轮未启用 ARP AI marker 包。

## 贴图/材质

PMX 原生导入后，MMD Tools 读取到 24 个模型材质、11 个图像 datablock 和 44 个 MMD 图像节点。导出前调用的是 MMD Tools 自带的：

```text
mmd_tools.convert_materials(
    use_principled=True,
    clean_nodes=True,
    subsurface=0.001,
)
```

这一步把 MMD shader 迁移成 Blender Principled + 图像纹理节点，没有项目自写材质转换器。迁移后 24/24 模型材质均有 Principled 节点和基础图像节点。

Rig Bridge bake 后导出的 GLB 在全新 Blender scene 回读验证：

- 7 张嵌入图片（被 24 个材质共享）；
- 24/24 材质有图像节点；
- 24/24 材质的 Principled Base Color 有纹理连接；
- 24/24 材质的标准 Alpha 也有图像连接；
- 1 个动画 armature，动作曲线存在且帧 1/50/100 的骨骼旋转不同；
- Eevee 带光渲染可见头发、皮肤、服装等纹理。

因此**基础颜色贴图和标准 Alpha 转换正常**。MMD 专有的 toon/sphere 渲染语义不会原样变成 glTF 的独立材质通道；当前结论是“可发布 GLB 的基础贴图 + alpha 路线通过”，不是“所有 MMD 特效完全等价”。

## 脱敏证据位置

- HRS 映射、姿态、bake、导出：[citrali_mmd_hrs_native_bake_materials.json](D:/Dev/Auto-Rig-Pro/artifacts/citrali_mmd_hrs_native_bake_materials.json)
- GLB 材质/动画 clean-import：[citrali_ardy_walk_native_baked_materials_glb_validation.json](D:/Dev/Auto-Rig-Pro/artifacts/citrali_ardy_walk_native_baked_materials_glb_validation.json)
- 带动作和贴图的 GLB：[citrali_ardy_walk_native_baked_materials.glb](D:/Dev/Auto-Rig-Pro/artifacts/citrali_ardy_walk_native_baked_materials.glb)
- 纹理渲染 smoke check：[citrali_ardy_walk_native_baked_materials_frame100.png](D:/Dev/Auto-Rig-Pro/artifacts/citrali_ardy_walk_native_baked_materials_frame100.png)
