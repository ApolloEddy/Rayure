# Phase 0 — ARDY 官方坐标系/单位/rest offsets/.npz 输出审计 → core-skeleton-27.v1 草案

> Spec Phase 0 任务：验证 ARDY 官方坐标系、单位、neutral skeleton 来源与 `.npz` shape，形成 `core-skeleton-27.v1` profile 草案。
> 证据全部来自本地 ARDY checkout `D:/Dev/ardy-spike/ardy`（非 git 副本，指纹见 toolchain.lock.json）。

## 1. 坐标系（官方 docstring + 几何交叉验证）

- **右手系、Y-up、Z-forward**：`ardy/exports/mujoco.py:29-30` docstring 原文
  「In ardy, the coordinate system is y up and z forward, right handed」。
- 交叉验证：`cskel27/joints.p` 脚趾 z=+0.160（朝 +Z）、右手 x=-0.719（右在 -X）；
  `scripts/generate.py:240` 注释 `first_heading_angle=0 → facing +Z`；
  `ardy/tools.py:126 compute_heading_angle=atan2(dz,-dx)`。

## 2. 单位

- **米制**。`cskel27/joints.p`（[27,3] float64）：Hips 在原点，头 y=0.730、脚趾 y=-0.954 → 身高 ≈1.684m。
- `ardy/skeleton/bvh.py:560`：输入 BVH 时 `root_trans *= 0.01`（cm→m）反向印证官方输入是 cm、输出是米。
- **转换器输出即米**：无单位倍率。

## 3. rest offsets（唯一权威来源）

- `assets/skeletons/cskel27/joints.p` = `neutral_joints`（[27,3] float64），Hips=原点、标准 T-pose。
- `ardy/skeleton/bvh.py:564-568` 注释证实 joints.p「is relative to the standard t_pose」。
- `cskel27` 目录只有 `joints.p` 与 `skin_standard.npz` 两个文件；**无** `bvh_joints.p`、**无** `standard_t_pose_global_offsets_rots.p`。
- 因此 `to_standard_tpose/from_standard_tpose`（`transforms.py:78-109`）对 CoreSkeleton27 **不可用且不必要**——
  `local_rot_mats` 天然就是标准 T-pose 帧（父局部帧，identity=rest pose）。
- **OFFSET[j] = neutral_joints[j] − neutral_joints[parent[j]]**，根 OFFSET=[0,0,0]。可用 `skin_standard.npz` 的 `bind_rig_transform[27,4,4]` 父相对差交叉验证。

## 4. `.npz` 输出结构（converter 直接消费）

来自 `ardy/motion_rep/reps/ardy_motionrep.py:271-279 ArdyMotionRep.inverse()` + `scripts/generate.py save_motion_npz:159-164`：

| 字段 | shape | 语义 |
|---|---|---|
| `local_rot_mats` | [B,T,27,3,3] | 关节局部旋转（父局部帧，identity=rest） |
| `global_rot_mats` | [B,T,27,3,3] | FK 后全局旋转 |
| `posed_joints` | [B,T,27,3] | 世界系关节位置（米制） |
| `root_positions` | [B,T,3] | 世界系根（Hips）轨迹（米制） |
| `foot_contacts` | [B,T,4] | 左右脚跟/脚尖 (>0.5 布尔) |
| `smooth_root_pos` | [B,T,3] | 平滑根轨迹 |
| `global_root_heading` | [B,T,2] | 根朝向 2D 向量 |
| `fps` | 标量 | = 20（checkpoint config.yaml fps:20） |

- **fps=20** → BVH Frame Time = 1/20 = 0.05s，Frames=T，**不重采样**。
- **不做平滑/去抖/补帧/接地/去滑步/比例适配**（spec §3.2 允许清单内没有这些）。
- `root_positions` 已是世界系米制，直接写 Hips 位置通道。

## 5. BVH 现有工具状况

- ARDY 仓库**只有 BVH 导入**（`ardy/skeleton/bvh.py` 的 `parse_bvh_motion`/`load_bvh_animation`，及 `data_processing/bvh.py` 无人引用的旧副本），**无任何 BVH 导出代码** → 转换器从零实现。
- **round-trip 契约**（`bvh.py:518-534`）：`load_bvh_animation` 用 `scipy Rotation.from_euler(声明的通道字母序, intrinsic)` 重建矩阵，要求各关节旋转通道顺序一致。转换器的 `as_euler` 反解顺序必须与写出的通道顺序一致。

## 6. core-skeleton-27.v1 草案固定事实

见 `schemas/core-skeleton-27.v1.json`，要点：

- **关节集**：官方 27 关节、层级逐字（根 Hips → Spine/Spine1/Spine2/Spine3 → Neck/Head；肩→臂→前臂→手→手端/拇指；右/左腿链）。
- **units**：米，倍率 1.0。
- **axis basis**：ARDY 原生 Y-up / +Z-forward / 右手系。
- **Euler channel order**：固定 `Zrotation Yrotation Xrotation`（scipy `as_euler('ZYX', degrees=True)` 反解，按通道序写入）。
- **fps**：20（Frame Time 0.05s）。
- **Hips**：唯一 translation 通道（6 通道：X/Y/Z position + 三旋转）；其余关节只有旋转。
- **End Sites**：6 个叶关节保持 JOINT + 各自一个 End Site stub（stub 长度 0.02–0.05m 或显式 0，待 round-trip 定稿）。
- **rest offsets**：从官方 joints.p 计算，**不与目标模型拟合**。

## 7. 待 Phase 1 确认项（round-trip 数值验证）

- Euler 顺序 ZYX 是否在 ARDY `load_bvh_animation` + Blender 原生 BVH importer 双端一致重建（root ≤1mm、旋转 ≤0.25°）。
- End Site stub 长度对旋转重建无影响的确认。
- 若官方单位/浮点精度证明阈值需调整，先写证据再改。

## 8. 输入校验与失败码

- converter 校验：`local_rot_mats [T,27,3,3]`、`root_positions [T,3]`、fps==20、T≥1、数值有限；失败码 `INPUT_INVALID` / `ARDY_REFERENCE_SKELETON_MISSING`。
- CLI **禁止** `--target-model/--bone-map/--guess-axis/--scale-to-character/--fix-feet`（spec §6.1）。
