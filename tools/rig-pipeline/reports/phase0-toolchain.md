# Phase 0 — 工具链锁定与能力审计报告

> Spec: `docs/Rayure_RigBridge_BVH_BakedMotion_Development_Spec.md` Phase 0
> 日期: 2026-08-26
> 分支: `feat/offline-rig-pipeline`（自 `codex/recover-rayure-boundaries` HEAD=8251c4b 创建）

## 1. 工具链版本锁定表

| 组件 | 版本 | 来源 | sha256 | 状态 |
|---|---|---|---|---|
| Blender | 4.2.23 LTS | download.blender.org（可达） | `82e791475779a7342424a480bdde9a20b43710da9264c60346125aa16cd910cb` | ✅ 已下载 383,193,007 B，已解压可运行 |
| Rig Bridge (Humanoid Remap Studio) | 0.1.66 | extensions.blender.org（可达） | `5f0b9c06b10927b984448371f918681e6efb7eb607482842d6343854c686fd71` | ✅ 已下载 86,851 B，已放入便携 Blender 扩展目录 `4.2/extensions/user_default/`，headless 启用验证通过 |
| glTF exporter | 内置 `io_scene_gltf2` | Blender zip 内 `4.2/scripts/addons_core/io_scene_gltf2/` | 随 Blender 分发，无独立版本 | ✅ |
| Blender 扩展管理器 | `bl_pkg` | 内置 | — | ✅ |
| ARDY | pyproject 0.2.0；本地 checkout（非 git 副本） | D:/Dev/ardy-spike/ardy | 关键文件指纹见 `toolchain.lock.json` | ✅ 已固定 |
| ARDY checkpoint | ARDY-Core-RP-20FPS-Horizon40 | D:/Dev/ardy-spike/checkpoints | — | ✅ fps=20 |
| BVH Motion Retargeter (BacteriaJun) | 未锁定 | github.com（**被阻断**） | — | ⚠️ 不可核验，仅备选 |

**锁定来源（`tools/rig-pipeline/toolchain.lock.json`）**：Blender/Rig Bridge 的校验和与 URL 均已逐字节验证；
Rig Bridge 的公开 API 逐字核验自解压的 addon 源码（`scratch/rig-pipeline-poc/tools/hrs_extracted/`）。

## 2. Rig Bridge 公开 API 逐字确认（来自 addon 源码）

- `bpy.ops.hrs.auto_guess()` — `operators.py:212 class HRS_OT_auto_guess`，可选 `overwrite_manual`
- `bpy.ops.hrs.execute_retarget()` — `operators.py:123 class HRS_OT_execute_retarget`，单臂/批量两路径，调 `bake_retarget_action`
- 其余公开 operator（前缀全部 `hrs.`）：`hrs.init_slots`、`hrs.assign_selected_bone`、`hrs.pick_armature`、`hrs.clear_retarget_result`、`hrs.open_humanoid_canvas`
- 场景/门禁字段逐字存在：`hrs_source_armature`、`hrs_target_armature`（PointerProperty, poll=armature_poll）、`hrs_can_execute_retarget`(Bool)、`hrs_auto_summary`、`hrs_auto_detail`、`hrs_retarget_status`、`hrs_source_profile`/`hrs_target_profile`、批量模式 `hrs_source_mode`+`hrs_source_collection`
- **执行门禁**（`core.py:1041-1046`）：`hrs_can_execute_retarget = source && target && mapping_coverage.ready && posture_gate.passed`
- **烘焙行为**（`retarget.py:426-490`）：在 target 上新建 Action `Retarget_<source_action>_to_<target.name>`，写 `hrs_retarget_result` 等自定义属性，逐帧烘焙，**不改 target 骨架拓扑/骨名**

## 3. ADR-001 结论（bake-in-place 确认）

Rig Bridge 是「识别 + 重定向 + 烘焙到目标 rig 现有骨架」的工具，**不做**把任意模型物理转换为 VRM/Mixamo/UE5 内部骨架。
官方原文证据：

- 扩展页 tagline: "Move animation between humanoid rigs automatically."
- README: "Rig Bridge performs recognition and retargeting with its own code. It does not call operators or runtime properties from other add-ons."
- README: "Rig Bridge checks known rig presets first and falls back to semantic bone names, hierarchy, body geometry, left/right structure, rest-pose checks, and forward-axis analysis."
- `core.py:830-898 detect_armature_profile`：Mixamo/VRM/VRoid/Unreal/MetaHuman/Rigify/Auto-Rig Pro/Generic 仅是**输入识别标签**；全代码库无改写 target 骨名为标准骨架或输出 VRM/Mixamo/UE5 文件的逻辑。

**结论**：本项目采用 **Bake-in-place**（保留第三方模型原始内部 rig，Rig Bridge 烘焙动作到它）。Rayure 无需知道骨骼名。
无任何已验证的外部 rig-conversion converter；`declaredStandard` 只能由外部工具验证后填写，否则为 null（spec §6.3）。

## 4. 能力表（Capability Gate）

| 能力 | 已验证 | 证据 |
|---|---|---|
| Blender 4.2.23 可运行（headless/background） | ✅ | `blender.exe --version` → "Blender 4.2.23 LTS, build 2026-07-21" |
| Rig Bridge 可安装（便携扩展目录） | ✅ | 已放入 `blender-4.2.23-windows-x64/4.2/extensions/user_default/humanoid_remap_studio/`（**注意：`user_default` 下划线**，见下 §5 坑） |
| Rig Bridge headless 发现 + 启用 | ✅ | 便携 env vars + `bpy.ops.preferences.addon_enable(module='bl_ext.user_default.humanoid_remap_studio')` 后，5 个 operator + 8 个 gate 字段全部注册（2026-08-26 实测） |
| Rig Bridge 自动识别 + 执行门禁 | ✅（API 层面） | `hrs.auto_guess` → `update_auto_summary` → `hrs_can_execute_retarget`；真模型 gate 通过与否 = Phase 2 验证 |
| glTF 导出 | ✅（随 Blender） | `io_scene_gltf2` 内置 |
| ARDY 官方 .npz 输出 | ✅ | `ArdyMotionRep.inverse()` → local_rot_mats/root_positions/fps；见 phase0-ardy-profile.md |
| github.com 源 | ❌ 被阻断 | 单次 curl `Connection timed out`；不依赖 GitHub 源，全部走 extensions.blender.org / download.blender.org |

## 5. 安装方式（可复现）

1. 解压 `blender-4.2.23-windows-x64.zip` → `scratch/rig-pipeline-poc/tools/`（便携，无系统安装）。
2. 将 `add-on-humanoid-remap-studio-v0.1.66.zip` 解压后的 `humanoid_remap_studio/` 放入便携 Blender 的 **`4.2/extensions/user_default/`**。
3. headless 运行必须设置便携环境变量（否则解析到 `%APPDATA%\Blender Foundation\Blender\4.2`）：
   - `BLENDER_USER_CONFIG`、`BLENDER_USER_SCRIPTS`、`BLENDER_USER_EXTENSIONS` → 指向便携目录对应 `4.2/{config,scripts,extensions}`。
4. 脚本内先 `bpy.ops.preferences.addon_enable(module='bl_ext.user_default.humanoid_remap_studio')`，再调 `bpy.ops.hrs.auto_guess()` 等公开 API。

**坑记录**：Blender 4.2 的 User Default repo 目录是 `extensions/user_default/`（下划线）。按早期文档放成 `user/default/`（斜杠）不会被扫描——首版检查脚本因此 FAIL，改到 `user_default/` 后 PASS（2026-08-26 实测）。另：`bpy.utils.extension_repos` 并不存在（4.2 的 API 在 `bpy.context.preferences.extensions.repos`）；operator 是否注册要用 `bpy.types.Operator.__subclasses__()` 按 `bl_idname` 判断，`bpy.ops` 是惰性代理，`hasattr` 永远 True。

## 6. 未决项

- **真实模型 PoC 输入**：本地无 PMX；候选为 `D:/CodingProjects/Mixed_Language/StereoModelPlugin/tmp/albedo-inspect.vrm` 与 `胡桃-fixed-*.vrm`（属另一项目私有资产，用前需用户确认；保持 gitignored）。参考 rig 待定。
