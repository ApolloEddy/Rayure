# Phase 0 — 基线审计报告（spec §1.2 核对 + 禁改符号 + 基线漂移）

> Spec: `docs/Rayure_RigBridge_BVH_BakedMotion_Development_Spec.md` Phase 0
> 日期: 2026-08-26 ｜ 分支: `feat/offline-rig-pipeline` ｜ 基线提交: `94db6e2` ｜ 当前 HEAD: `8251c4b`
> 方法: 只读审计 agent（grep/read 全仓库），未修改任何文件。

## 1. spec §1.2 声明核对表（8 条全部成立）

| # | 声明 | 结论 | 证据（文件:行号） |
|---|---|---|---|
| 1 | bone-remapper 存在自研 alias 重命名 | ✅ 成立 | `apps/wallpaper/src/bone-remapper.ts:7`（`STANDARD_BONE_ALIASES`）、`:25`（`remapModelBones`）；生产调用 `mmd-model-host.ts:283` |
| 2 | canonical-rig-adapter 运行时骨架适配 | ✅ 成立 | `canonical-rig-adapter.ts:28`（类）、`:53-94`（Pass1/Pass2 world→parent-local）、`core-bone-names.ts:50`（`CORE_BONE_CANDIDATES`）、`rig-scale.ts:19` |
| 3 | ModelDescriptor 只有 pmx\|live2d | ✅ 成立 | `packages/protocol/src/index.ts:134`；校验 `index.ts:968`（"model format must be pmx or live2d"） |
| 4 | MotionDescriptor 只有 vmd\|live2d\|canonical | ✅ 成立 | `packages/protocol/src/index.ts:183-202`；校验 `index.ts:1225`（"motion format must be vmd, live2d or canonical"） |
| 5 | 网关不允许 glb | ✅ 成立 | `apps/companion/src/server.ts:51-69`（`ALLOWED_ASSET_EXTENSIONS` 无 `.glb/.gltf/.bin`）；`contentTypeFor` `:1330-1347` 无对应类型 |
| 6 | mmd-model-host 调 BoneRemapper | ✅ 成立 | `apps/wallpaper/src/mmd-model-host.ts:18`（import）、`:283`（`#performLoad` 内调用） |
| 7 | motion-controller 是 VMD 播放器 | ✅ 成立 | `apps/wallpaper/src/motion-controller.ts:2`（`ThreeMmdAnimation`）、`:71`（`loadAnimation`）、`:76`（`setAnimation`） |
| 8 | three-js-debug-surface 是调试面 | ✅ 成立 | `three-js-debug-surface.ts:114-133`（注释自述 debug surface）；仅在 `?3dDebug=1` 下经 `main.ts:997-999` 动态 import 启用 |

**关键结构事实**：
- 三层 3D 运行时适配层全部存在且仍被调用：**BoneRemapper**（默认生产 PMX 加载路径 `mmd-model-host.ts:283`）、**CanonicalMotionRigAdapter + CORE_BONE_CANDIDATES + rig-scale**（由 `three-js-debug-surface.ts` 消费，仅 `?3dDebug=1` 懒 chunk 启用）、**MotionController**（VMD 专用播放器）。
- `ardy-bridge.py` 只输出 world/global 姿态 JSONL（`posed_joints`/`global_rot_mats`），**不读 .npz**；离线 `ardy_to_bvh.py` 尚未实现。
- 私有模型资产仅 `scratch/ardy3d/albedo.pmx`（未跟踪）；仓库内 0 个 `.vmd/.vrm/.fbx`。

## 2. 禁改符号清单（spec `:614-620`，3D runtime 范围）

POC-PASS 门禁通过前，以下符号**不得修改/删除/替换**：

| 符号 | 状态 | 当前位置 |
|---|---|---|
| `STANDARD_BONE_ALIASES` | 存在 | `apps/wallpaper/src/bone-remapper.ts:7` |
| `CORE_BONE_CANDIDATES` | 存在 | `apps/wallpaper/src/ardy3d/core-bone-names.ts:50` |
| `remapModelBones` | 存在 | `apps/wallpaper/src/bone-remapper.ts:25`；调用方 `mmd-model-host.ts:283` |
| `CanonicalMotionRigAdapter` | 存在 | `apps/wallpaper/src/ardy3d/canonical-rig-adapter.ts:28` |
| `resolveBone` | 存在（私有 `#resolveBone`） | `canonical-rig-adapter.ts:138`（另有公开 `resolve` `:118`） |
| `guessBone` | **不存在** | 全仓库无匹配（即当前无该符号，spec 作为禁止新增自研猜测的目标） |
| `inferAxis` | **不存在** | 全仓库无匹配（同上） |

## 3. 基线漂移记录（spec baseline `94db6e2` → HEAD `8251c4b`）

| 提交 | 标题 | 触碰的 3D runtime 表面 | 对本 Phase 基线的影响 |
|---|---|---|---|
| `a48f2ac` | fix(runtime): restore calibration and debug boundaries | `apps/wallpaper/src/main.ts`、`mmd-model-host.ts`、`three-js-debug-surface.ts`、`packages/protocol/src/index.ts`、`apps/companion/src/server.ts` 等 | 属恢复性审计修复（CHANGELOG [Unreleased]）；§1.2 核对基于当前 HEAD 全量重验，8 条声明仍全部成立 |
| `8251c4b` | fix(debug): restore built 3d preview model | `apps/wallpaper/src/main.ts`、vite 配置、构建门禁 | 恢复 `?3dDebug=1` 懒 chunk 与 3D 预览模型；不改变禁改符号集合 |

**核对方法说明**：审计在**当前 HEAD** 上运行，因此漂移提交已包含在证据内；结论独立于 `94db6e2` 快照，无需回退基线。

## 4. 结论

- 迁移目标成立：3 层运行时适配（alias 重命名 / world→parent-local 硬适配 / 候选名查表）正是 spec 要替换为「离线识别 + 第三方 retarget + 烘焙纯播放」的对象。
- 禁改符号 5 项存在、2 项不存在；POC-PASS 前任何修改这些符号的代码变更应被门禁拦截。
- `scripts/verify.ps1` 目前**尚无** remapper/retarget/骨轴符号 guard（spec Phase 7 `:609` 任务），Phase 0 不新增该 guard（POC 门禁前不改生产构建脚本）。
