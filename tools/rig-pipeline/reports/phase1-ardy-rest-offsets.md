# Phase 1 — ARDY cskel27 rest offsets 全精度证据（round-trip 锁定的 rest 骨架）

> Spec Phase 1：把 core-skeleton-27.v1 profile 里的 27 个 `restOffsetMeters` 与官方来源对账到浮点级，并给出为何**只用 `joints.p`、不用 `skin_standard.npz` 的 `bind_rig_transform`** 的数值证据。
> 日期 2026-08-26；证据全部本地复算。

## 1. 权威来源：`ardy/assets/skeletons/cskel27/joints.p`

- 文件 = torch.load 序列化的 `neutral_joints`，[27,3] float64；Hips 在原点，y 范围 −0.954(脚趾)…0.730(头)，身高 ≈1.684m（米制）。
- `ardy/skeleton/bvh.py:564-568` 注释：joints.p「is relative to the standard t_pose」。
- **OFFSET[j] = neutral_joints[j] − neutral_joints[parent[j]]**；根 OFFSET=[0,0,0]。
- 复算核对：27/27 关节与 profile `restOffsetMeters` 逐值一致（max|diff| = 0.0）。

## 2. 独立交叉验证：`skin_standard.npz` 的 `bind_rig_transform[27,4,4]`

`bind_rig_transform` 的平移列是蒙皮空间里的关节世界坐标。把它与 joints.p 对比：

- **根**：`bind_trans[0] = [0.000, 0.969623, 0.000]` vs `joints.p[0] = [0,0,0]` → 常量世界偏移 **+Y 0.9696m**（bind 帧原点在脚底，joints.p 帧原点在 Hips）。这是纯坐标原点差，不改变父相对量。
- **父相对差**：`(bind_trans[i] − bind_trans[parent])` vs `(joints.p[i] − joints.p[parent])`
  - **25/27 关节精确一致（0.0 mm）**。
  - **仅 `RightHandThumb1`、`LeftHandThumb1` 差 19.0 mm**（父相对）。其余关节（含两肩、脚、脊柱全部）无差异。
- 若差异是纯平移，非根父相对差应全部为 0；19mm 的 Thumb 残差证明 **bind 骨架的拇指 rest 摆放与 joints.p 不同**——蒙皮变体，非同一 rest pose。

## 3. 结论（为何 profile 只嵌入 joints.p）

| 来源 | 是否用于 BVH rest offsets | 理由 |
|---|---|---|
| `joints.p`（cskel27） | ✅ **唯一权威** | 官方标准 T-pose 定义；round-trip 已在 Blender 原生 importer 验证到 0.03°/µm 级 |
| `bind_rig_transform`（skin_standard） | ❌ 不用 | 原点在脚底（+Y 0.9696 常量）；Thumb 两关节父相对差 19mm——不是同一 rest pose |

- 若误用 bind 帧，RightArm/脚趾等会带常量偏移，Thumb 会偏 19mm → BVH 导入后姿态与 ARDY 世界几何不一致。
- profile `restOffsets.source` 精确记为 `ardy/assets/skeletons/cskel27/joints.p (neutral_joints, [27,3] float64; torch.load)`，`valuesMeters: true`。

## 4. 与 round-trip 的关系

round-trip 验证（`verify/roundtrip_verify.py`）用同一套 `restOffsetMeters` 在工具链 python 里做 FK 参考，与 Blender 原生 importer 重建的世界矩阵比对：最大旋转误差 0.0319°（容差 0.25°）、最大平移误差 1.04 µm（容差 1mm）、根平移误差 0.01 µm。→ rest offsets 数值正确性获得端到端证据。

## 5. 复算脚本（可重放）

```bash
/d/Dev/ardy-spike/.venv/Scripts/python.exe - <<'PY'
import numpy as np, torch, json
j = np.asarray(torch.load('D:/Dev/ardy-spike/ardy/ardy/assets/skeletons/cskel27/joints.p',
                          map_location='cpu', weights_only=False)).reshape(27,3)
prof = json.load(open('tools/rig-pipeline/schemas/core-skeleton-27.v1.json'))
par = [e['parent'] for e in prof['joints']]
bad = [i for i in range(27)
       if np.abs((j[i] - (j[par[i]] if par[i] is not None else 0.0)) -
                 np.array(prof['joints'][i]['restOffsetMeters'])).max() > 1e-12]
print('mismatches:', bad)   # -> []
PY
```
