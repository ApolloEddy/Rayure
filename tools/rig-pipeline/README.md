# Rayure 离线骨架标准化与烘焙动作管线（rig-pipeline）

把 Rayure 的 3D 动作架构从"运行时识别骨架并适配动作"迁移为
"Blender 离线识别 → 第三方工具重定向 → 烘焙后运行时纯播放"。

> 由 `docs/Rayure_RigBridge_BVH_BakedMotion_Development_Spec.md` 驱动（Phase 0–8）。

## 目录

```
tools/rig-pipeline/
  README.md
  toolchain.lock.json          # 工具链版本/校验和/公开 API 锁定（Phase 0）
  schemas/
    core-skeleton-27.v1.json   # ARDY 官方 CoreSkeleton27 → BVH profile（Phase 0 草案）
    character-bundle.v1.schema.json   # Phase 3
    pipeline-failure.v1.schema.json   # Phase 1
  blender/
    rig_bridge_driver.py       # Phase 2：最薄 Blender driver，只调公开 API
    poc_retarget_and_bake.py   # Phase 2
    build_character_bundle.py  # Phase 3（POC-PASS 后）
  verify/
    blender_bvh_dump.py        # Phase 1：Blender 原生 importer round-trip dump
    roundtrip_verify.py        # Phase 1：FK 参考比对驱动（PASS/FAIL）
  tests/
    test_ardy_to_bvh.py        # Phase 1
    test_failure_schema.py     # Phase 1
    fixtures/                  # 只放小型、可再分发、无私有资产 fixture
  reports/                     # 仅提交脱敏 JSON/Markdown 证据
```

## 工具链（锁定）

| 组件 | 版本 | 位置 |
|---|---|---|
| Blender | 4.2.23 LTS（便携） | `scratch/rig-pipeline-poc/tools/blender-4.2.23-windows-x64/` |
| Rig Bridge (Humanoid Remap Studio) | 0.1.66 | 同上 `4.2/extensions/user_default/humanoid_remap_studio/` |
| glTF exporter | 内置 io_scene_gltf2 | 随 Blender |
| ARDY | 本地 checkout `D:/Dev/ardy-spike/ardy` + checkpoint `ARDY-Core-RP-20FPS-Horizon40` | 指纹见 toolchain.lock.json |

版本/校验和/公开 API 全部锁定于 `toolchain.lock.json`（Phase 0 实测证据）。

## 数据流

```
ARDY CoreSkeleton27 .npz → ardy_to_bvh.py → CoreSkeleton27 BVH
第三方 3D 模型 ──→ Blender 官方 importer ──┐
                                          ├─→ Rig Bridge（auto_guess → execute_retarget）→ baked Actions
CoreSkeleton27 BVH ──→ 作为 source armature ─┘
baked Actions → GLB + character bundle manifest → Rayure 纯播放（GLTFLoader + AnimationMixer）
```

## 进度

- **Phase 0（✅ 完成）**：工具链锁定 ✅、ARDY profile 草案 ✅、基线审计 ✅（8 条 §1.2 声明全部验证）、Rig Bridge headless 启用验证 ✅、PoC 输入矩阵 ✅。
- **Phase 1（✅ 完成）**：`ardy_to_bvh.py` 严格转换器（零目标模型知识）+ `pipeline-failure.v1` schema（14 code）+ 31 个 unittest 通过 + golden fixture + Blender 原生 importer round-trip **PASS**（旋转 0.0319°≤0.25°、根平移 0.01µm≤1mm、fps=20）。详见 `reports/phase1-verification.md`。
- **Phase 2（待开始）**：Rig Bridge retarget/bake PoC → `POC-PASS`/`POC-FAIL`。
- **Phase 3–8**：`POC-PASS` 门禁通过后才进入生产重构。

## 约束速查（spec §3）

- ❌ 自研 retarget / alias / 骨轴推断 / rest pose 求解。
- ❌ converter 读取目标模型或 mapping。
- ❌ 运行时即时重定向；runtime 只做 GLB load + baked animation playback。
- ✅ 所有骨架语义止于离线 builder；运行时只按精确 clip 名播放。
