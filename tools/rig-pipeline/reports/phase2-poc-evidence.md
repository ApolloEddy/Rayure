# Phase 2 — HRS-only retarget/bake PoC 证据

日期：2026-08-26
工具：Blender 4.2.23 LTS、Humanoid Remap Studio（当前市场名 Rig Bridge）0.1.66、ARDY CoreSkeleton27 20 FPS BVH。

## 结论

**`POC-FAIL`。** HRS-only driver 已完成并能稳定产出成功/失败报告，但当前四槽位只有 2 个通过，且通过样本的 HRS target profile 都是 `VRM/VRoid`，没有覆盖 Spec 要求的至少三个独立 rig 家族。因此没有进入 Phase 3，也没有改动 `apps/`、`packages/` 或 Wallpaper runtime。

本轮没有使用 Auto-Rig Pro、第二套 retarget 工具、手工 HRS slot、alias、几何猜骨或自研修复逻辑。`Auto-Rig Pro` 出现在 HRS 的输入识别标签中时，仅作为插件诊断，不代表本项目调用了该工具。

## 四槽位结果

| 槽位 | 输入边界 | 严格 posture | HRS 自动门 | 15 角色语义审计 | 三类动作 + GLB clean import | 结果 |
|---|---|---:|---:|---:|---:|---|
| A | VRM reference | PASS | PASS | 15/15 | idle / upper-body / locomotion 均 PASS | 通过 |
| B | MMD/复杂变形 rig | PASS | PASS | **FAIL：12/15 off-by-one** | 未执行 bake | 失败 |
| C | FBX container | PASS | PASS | 15/15 | idle / upper-body / locomotion 均 PASS | 通过 |
| D | Rigify/custom `.blend` | PASS | **FAIL** | 未进入 | 未执行 bake | 失败 |

槽位 C 的 FBX 文件导入后被 HRS 识别为 `VRM/VRoid` target profile，骨架仍是同一类 J_Bip/VRM 风格 rig；文件扩展名不能计作 Mixamo/UE mannequin 独立家族。槽位 D 的 profile 文本出现 `Auto-Rig Pro` 只属于 HRS 识别结果，项目没有安装或调用 Auto-Rig Pro。

### 失败样本的可复核诊断

- 槽位 B：`hrs_can_execute_retarget=true`，但 HRS 把 upper-arm / forearm / hand 和 thigh / shin / foot 系列整体错移一节；独立语义审计返回 `RIG_MAPPING_SEMANTIC_MISMATCH`。这证明布尔执行门不是正确性证明。
- 槽位 D：姿态门通过，但 HRS 自动执行门为 false，左右 upper-arm 为空，返回 `RIG_DETECTION_FAILED`。按约定不手工补 slot、不切换工具。

## 通过样本的产物门

槽位 A、C 各跑完三类 ARDY 动作，共 6 个独立 Action。每次均满足：

- Action 帧范围 1–100、FPS 20、F-Curve 非空且有限；
- bake 前后目标 rig 指纹不变（A：91 bones；C：182 bones）；
- GLB 在不加载 HRS 的全新 Blender scene 中导入成功，且只暴露本次 `rayure__...` baked clip；
- FBX 自带的原始动作在导出前被移除，未泄漏进 baked GLB。

严格姿态探针另以缺失骨名负例复核：返回非零 `POSTURE_REFERENCE_UNAVAILABLE`，不会猜测替代骨。

产物位于 gitignored 的 `scratch/rig-pipeline-poc/`，这里只登记 hash，不提交模型、纹理或 GLB：

| 槽位/动作 | GLB SHA-256 |
|---|---|
| A / idle | `add0fa0ca115882e6b6b9d2a0cc4f6f13eb8037c3b0bf34a6e3d6235c4dfcdaf` |
| A / upper-body | `4ecfc4e64aa5e270ebfff65efd7ca13f89079db423e08418db5f24bddab20725` |
| A / locomotion | `77d99e41519c45268580b5e2438e304b8e2a2c935af09b8169a2682964860567` |
| C / idle | `0c45475fa554cf9e8d23163d2b386352c2117953d24f5ca9b8cc98a7bdc90901` |
| C / upper-body | `87d1258ed0bfa7e951e3fb2b1546988f5ca0139802f40c8c9704f1a5eaa9d78a` |
| C / locomotion | `780a13c853be5d53efc3c20d1fffb08b73a9ee504b4fab0ff1014f36bf67d1a8` |

## 未关闭的门

- `Param001…ParamNNN` 合成用例：本轮标记 `anonymousBoneNames=unexecuted`；由于四槽位/三家族硬门已失败，没有用它掩盖真实失败。
- Three.js `GLTFLoader + AnimationMixer` 播放、loop/stop/cross-fade 与人工视觉验收：未执行，属于 `POC-FAIL` 后停止的后续门。
- 要达到 `POC-PASS`，需要一个真实、可授权且与 VRM/VRoid 不同的标准 FBX/UE 或 custom rig 输入；不能用更多同族 MMD/VRM 文件凑数。

复现入口：`tools/rig-pipeline/blender/rig_bridge_driver.py`。该 driver 只调用 Blender importer、HRS `auto_guess` / `execute_retarget` 和 glTF exporter，并输出 `rayure.rig-pipeline-phase2-report.v1` 报告。
