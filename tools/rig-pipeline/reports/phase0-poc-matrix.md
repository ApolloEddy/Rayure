# Phase 0 — PoC 输入矩阵

> Spec §7.1：至少 1 个干净标准参考 rig（Mixamo/UE5/VRM）+ 1 个真实乱命名/不同层级/rest pose 第三方模型 + 3 类 ARDY 动作。

## 1. 模型输入

| 槽位 | 要求 | 候选 | 状态 |
|---|---|---|---|
| 参考 rig | Mixamo / UE5 / 有效 VRM 三选一，证明 source/profile 无基础错误 | **待定**。需一个标准 rig。本地无 Mixamo/UE5；VRM 候选见下 | ⚠️ 需选定 |
| 真实乱命名模型 | 不同层级/rest pose 的第三方模型；**优先当前本地验证过的 PMX** | **本地无 PMX**（`scratch/ardy3d/albedo.pmx` 已不在）；候选 VRM：`D:/CodingProjects/Mixed_Language/StereoModelPlugin/tmp/albedo-inspect.vrm`、`胡桃-fixed-*.vrm` | ⚠️ 属另一项目私有资产，需用户确认借用；保持 gitignored |

**备注**：
- spec 说"优先使用 PMX 但保持私有 gitignored"，是**偏好**非硬性；本地无 PMX 时用 VRM 真实模型，并在报告中说明替代。
- `albedo-inspect.vrm` 疑似与 Rayure 历史用过的 albedo 模型同源（`StereoModelPlugin/tmp/`），是理想"真实乱命名模型"候选。
- 参考 rig 若用 VRM：VRM 自带 humanoid 规范（`vrm.humanoid`），属于 spec 允许的"有效 VRM"。
- 两个模型必须**不同**（一个作参考、一个作真实测试）才能证明 Rig Bridge 泛化，不能只在一个 rig 上成功。

## 2. ARDY 动作输入（3 类）

| 类别 | 说明 | 候选 prompt（30011 缓存中逐字存在） | 是否带 Hips 位移 |
|---|---|---|---|
| A. idle / 轻微全身 | 站立微动，验证基础姿势 | `stand` / `idle` / `wave.casual`（上肢轻） | 否 |
| B. 明显上肢动作 | 手臂大幅运动，验证上肢 retarget 精度 | `wave.casual` / `wave` / `throw` | 否（或轻微） |
| C. 带 Hips 位移的 locomotion | 行走/跑步，验证 root motion + 下肢 | `walk.forward` / `run.armswing` / `walk` | **是** |

**生成方式**：Phase 1 用官方 ARDY 推理（复用 `D:\Dev\ardy-spike` venv 与 checkpoint
`ARDY-Core-RP-20FPS-Horizon40`）对每个 prompt 生成 motion，经 `scripts/generate.py save_motion_npz`
落盘为官方 `.npz`（含 `local_rot_mats`/`root_positions`/`fps`），再喂给转换器。
每个动作记录 `sourceMotionSha256`（manifest 契约）。

## 3. 验证矩阵（2 模型 × 3 动作）

| | A. idle | B. 上肢 | C. locomotion |
|---|---|---|---|
| 参考 rig（VRM） | retarget+bake → GLB | ✓ | ✓ |
| 真实模型（VRM） | ✓ | ✓ | ✓ |

每个单元格 = 独立 Action；GLB 导出后在不加载 Rig Bridge 的全新 Blender scene + Three.js harness 验证。

## 4. 已知约束

- **网络**：github.com 阻断；Blender/Rig Bridge 走官方平台已就绪。VRM 模型本地已有。
- **私有资产**：两个 VRM 均属其他项目/私有，仅拷入 `scratch/rig-pipeline-poc/`（gitignored）使用，不提交。
- **参考 rig 未定**：若用户不提供标准 rig，将评估以"一个干净的 VRM"充当参考 rig（VRM 符合 spec 的合格格式之一）。
