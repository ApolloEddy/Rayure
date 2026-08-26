# Phase 1 — ARDY→BVH 严格转换器交付与验证报告

> Spec Phase 1 验收（spec §7.3 items 1-2）：确定性输出 + Blender 原生 BVH importer round-trip（旋转 ≤0.25°、根平移 ≤1mm）。
> 日期 2026-08-26。提交消息 `feat(poc): add strict ARDY to BVH format bridge`。

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `tools/rig-pipeline/ardy_to_bvh.py` | 严格 ARDY CoreSkeleton27→BVH 格式桥（v1.0.0）。纯格式桥，零目标模型知识。 |
| `tools/rig-pipeline/schemas/core-skeleton-27.v1.json` | 27 关节 rest offsets 全精度 profile（v0.1.0），endSites=7 叶。 |
| `tools/rig-pipeline/schemas/pipeline-failure.v1.schema.json` | 失败报告 schema `rayure.rig-pipeline-failure.v1`（14 个稳定 code）。 |
| `tools/rig-pipeline/tests/test_ardy_to_bvh.py` | 转换器测试（unittest，零第三方依赖）。 |
| `tools/rig-pipeline/tests/test_failure_schema.py` | 失败报告 schema 结构校验（手写极简 validator，jsonschema 不可用）。 |
| `tools/rig-pipeline/tests/fixtures/build_fixtures.py` | 确定性 golden fixture 构造器。 |
| `tools/rig-pipeline/tests/fixtures/golden_rest.{npz,bvh,conversion.json}` | golden 快照。 |
| `tools/rig-pipeline/verify/blender_bvh_dump.py` | Blender 原生 importer round-trip dump（headless）。 |
| `tools/rig-pipeline/verify/roundtrip_verify.py` | FK 参考 + 容差比对驱动。 |
| `tools/rig-pipeline/toolchain.lock.json` | 新增 `converter` 块（python 3.11.9 / numpy 1.26.4 / scipy 1.17.1）。 |
| `reports/phase1-ardy-rest-offsets.md` | rest offsets 全精度证据（joints.p vs skin_standard）。 |

## 2. 转换器硬约束落实（spec §3.2 / §6.1）

- 无 `--target-model/--bone-map/--guess-axis/--scale-to-character/--fix-feet`：CLI 级拒绝（exit 4），源码可执行区零出现（测试双保险）。
- 无自研 retarget / alias / axis 推断 / 目标模型知识。Hips 是唯一 translation 通道；其余关节仅旋转。
- 确定性：相同 input bytes + profile + 工具版本 → 相同 BVH 字节（测试锁定）。
- 失败路径：非零退出 + `rayure.rig-pipeline-failure.v1` 报告 + **不产出部分 BVH**。
- 输入校验：`[T,27,3,3]`/`[T,3]` shape、batch≤1、T≥1、T≤65536、fps==20、全有限（无 NaN/Inf）、文件非截断。

## 3. 测试（31 个，全部通过）

工具链 venv 无 pytest/jsonschema → 全部用 stdlib `unittest`。运行：
```bash
cd tools/rig-pipeline && /d/Dev/ardy-spike/.venv/Scripts/python.exe -m unittest discover -s tests
```
覆盖：确定性 hash、golden 字节级匹配、非法 shape / 缺字段 / 批量>1 / 帧数不一致 / 0 帧 / NaN/Inf / 错误 fps / 超大输入上限（monkeypatch）、截断文件、profile 缺失、CLI exit code、禁止符号只出现在守卫常量、14-code 枚举、schema required/type/enum/pattern、失败报告 conform、多余属性拒绝。

## 4. Golden fixtures（确定性快照）

| 文件 | sha256 |
|---|---|
| `golden_rest.npz` | `ba95faa470ef2783b55edcbe7715e80619e2183c8452e41026eea49993422893` |
| `golden_rest.bvh` | `b9a737bb50cdb9969cf4f4e3501d8241304dc90ce2f29ba824fc264d57803737` |

构造：T=3（frame 0 rest；frame 1 RightArm ZYX(30,15,0)+Head ZYX(5,-10,0)+Hips 平移 (0.10,0,0.05)；frame 2 RightArm ZYX(45,20,10)+Hips 平移 (0.20,0,0.10)）。

## 5. Round-trip 验证（spec §7.3 item 2）

方法：Blender 4.2.23 headless + 原生 `io_anim_bvh` importer（`axis_forward='Y', axis_up='Z'` → `global_matrix==identity`，经 `axis_conversion` probe 确认）导入 `golden_rest.bvh`；工具链 python 用同一 profile 的 rest offsets 做 ARDY FK 参考；逐骨逐帧比对世界旋转/平移。

| 指标 | 测得 | 容差 | 结论 |
|---|---|---|---|
| 最大旋转误差 | **0.0319°**（worst=RightFoot frame 1） | 0.25° | ✅ |
| 最大平移误差 | **1.04 µm**（worst=RightHandThumb1 frame 3） | 1 mm | ✅ |
| 根（Hips）平移误差 | **0.01 µm** | 1 mm | ✅ |
| fps 契约 | scene fps 20 == profile fps 20 | 20 | ✅ |
| 帧契约 | BVH 帧 0..2 → Blender 帧 1..3（importer 跳过其内部 anim_data placeholder） | T 帧全动画 | ✅ |
| armature.matrix_world | identity | — | ✅ |

复现：
```bash
# 1) Blender dump（headless，需工具链 env vars）
blender --background --factory-startup --python tools/rig-pipeline/verify/blender_bvh_dump.py -- \
  --bvh tools/rig-pipeline/tests/fixtures/golden_rest.bvh --out scratch/rig-pipeline-poc/fixtures/golden_rest.rt_dump.json
# 2) 比对驱动（工具链 python）
/d/Dev/ardy-spike/.venv/Scripts/python.exe tools/rig-pipeline/verify/roundtrip_verify.py \
  --npz tools/rig-pipeline/tests/fixtures/golden_rest.npz --profile core-skeleton-27.v1 \
  --dump scratch/rig-pipeline-poc/fixtures/golden_rest.rt_dump.json \
  --out scratch/rig-pipeline-poc/fixtures/golden_rest.rt_verify.json   # -> verdict=PASS
```

Euler 契约三方一致得到端到端确认：文件通道 `Z Y X` → importer `rot_order (2,1,0)`→`Euler((X,Y,Z),'XYZ')`=Rz@Ry@Rx == scipy 内置 'ZYX' == ARDY `load_bvh_animation` 重建。

## 6. Phase 1 遗留（不进本提交，Phase 2 处理）

- End Site stub（0.02m）对旋转重建无影响已由 round-trip 隐含确认；Blender 侧 leaf bone 长度即 stub。
- profile `status` 字段仍标 draft——按 spec 在 POC-PASS 后锁定时再改正式。

## 7. 失败码

转换器可发 2 个稳定 code：`INPUT_INVALID`、`ARDY_REFERENCE_SKELETON_MISSING`；其余 12 个（IMPORT_FAILED…BAKED_CLIP_NOT_FOUND）留给后续阶段，schema 已齐备。
