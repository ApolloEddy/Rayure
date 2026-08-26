# Rayure 离线动作源标准化、目标骨架烘焙与纯播放管线开发 Spec

> 面向执行者：Rayure 后续执行代理
> 目标仓库：[ApolloEddy/Rayure](https://github.com/ApolloEddy/Rayure)  
> 基线分支：`main`  
> 基线提交：[`94db6e2592a31e6b9e85b22f750e993a297d204b`](https://github.com/ApolloEddy/Rayure/tree/94db6e2592a31e6b9e85b22f750e993a297d204b)  
> Spec 修订：`R2`（2026-08-26 午后 BrainStorm 锁定版）
> 修订时执行基线：`feat/offline-rig-pipeline@a7581b5`（Phase 0–1 已完成）
> 当前执行状态：**Phase 2 的 HRS-only 失败记录仍为历史证据；2026-08-26 用户增补已开启两条插件原生映射试验。Citrali PMX 的原始日文 → HRS `MMD FK` 路线已通过，整体 POC/生产门仍未宣称通过。**
> 规范词：**MUST / MUST NOT / SHOULD / MAY** 分别表示必须、禁止、应该、可选。

R2 的决策优先于本文早期段落和 Phase 0 历史报告中的旧措辞；已提交的 Phase 0–1 仍是有效证据，不改写历史。本文所称 **HRS** 专指开源第三方扩展 Humanoid Remap Studio 0.1.66（其当前市场名为“Rig Bridge”），**不是** Kajin 的付费产品 RigBridge，也不是 Blender Foundation 官方插件。

### R3 用户增补（2026-08-26）

以下条款由用户明确指定，覆盖本 Spec 中“失败后不得切换第二套 retarget 工具”的旧试验策略，但不放宽语义、姿态、覆盖率或纯播放门禁：

1. 保留两条**插件原生**映射路线，按顺序尝试：Route A 使用 MMD Tools 原始日文骨名并走 HRS 自带 `MMD FK` 预设；只有 A 的门禁失败时，才从干净 scene 重导并尝试 Route B（MMD Tools 自带 `INTERNAL` 字典，再调用 HRS 通用识别或 ARP 自带预设/识别能力）。
2. 两条路线不得拼接、互相填槽或由 Rayure 新增 alias、正则、几何猜骨或翻译字典；每条路线都必须独立完成完整 role→bone 语义审计、核心覆盖率、rest pose、bake 和 GLB clean-import 验证。
3. 某条路线通过后立即选定该路线；另一条仅保留为可复核的 fallback 证据。当前 Citrali PMX 为 Route A 通过，Route B 的 HRS 通用识别为 13/15 核心，未被选用。
4. MMD 贴图在直接导入后，允许调用 MMD Tools 自带 `convert_materials(use_principled=True, clean_nodes=True)` 迁移为 Blender 标准材质，再由 Blender glTF exporter 输出 GLB；不得写项目自有材质转换器。glTF 只承诺基础颜色/alpha 等标准通道，toon/sphere 等 MMD 专有语义不承诺逐项等价。

---

## 0. 给执行代理的首要指令

你要把 Rayure 的 3D 动作架构从“运行时识别骨架并适配动作”迁移为“Blender 离线导入、外部工具识别/重定向、动作烘焙到目标模型原骨架、运行时纯播放”。目标不是把任意模型物理改造成 ARDY 27 关节骨架。

开始任何编辑前，必须：

1. `git status --short --branch`，确认并保护用户已有改动；不得覆盖、重置或整理与本任务无关的变更。
2. 确认当前 HEAD 与本 Spec 基线的差异，并重新阅读本 Spec 列出的现有实现文件。若仓库已变化，先把差异写入 Phase 0 报告，再继续。
3. 新建功能分支，例如 `feat/offline-rig-pipeline`。不要改写、amend、rebase 或 squash 用户已有提交。
4. 按本文阶段执行；**每个阶段验证通过后立即单独提交**。不得把多个阶段压成一个提交。
5. **PoC Gate 未通过时，禁止进入生产重构阶段，禁止大面积修改 `apps/`、`packages/`。**
6. HRS 主自动路径、现成 BVH 工具或导入器无法处理模型时，先生成结构化失败报告；不得以新增 alias、手工猜骨、几何推断、骨轴推断或自研 retarget 补救。失败就停在当前模型，不切换到第二套 retarget 工具。

本任务不是做一个能跑一次的最小脚本。PoC 通过后，要完成离线构建、协议、资产网关、3D 播放器、目录/调度接入、旧逻辑退役、测试、文档和验收证据这一整条生产链路。

### 0.1 R2 锁定结论

1. **动作源统一，不统一目标骨架。** ARDY CoreSkeleton27 只定义 BVH 动作源；HRS 把动作烘焙到模型现有 rig，产物保留目标骨架。
2. **不先统一转 FBX。** 每种源格式由 Blender 原生能力或锁定的生态 importer 直接导入；如需构建缓存，中间产物使用 GLB，但它不承担骨架标准化。
3. **Blender 是完整的离线依赖。** `bpy` 不是可独立部署的 KB 级官方库；使用完整 Blender 的 `--background` 模式。Wallpaper/最终用户运行时不包含 Blender。
4. **HRS 是当前自动 PoC 工具，不是权威性背书。** 官方扩展平台上架只证明分发来源可核验，不证明 Blender Foundation 官方身份，也不证明对任意模型正确。
5. **HRS 状态门禁只是必要条件。** `hrs_can_execute_retarget=true` 仍可能语义错位；逐角色映射审计、动作结果和纯播放证据共同决定模型是否通过。
6. **多模型族而非只看 MMD。** PoC 使用四个目标槽位、至少三个不同常见 rig 家族；同一角色文件里的两个 armature 不得虚增为两个独立家族。
7. **无命名骨架单列能力标签。** `Param001…` 合成用例必须执行；失败会阻止“与骨名无关”的宣传，但不会被自研 fallback 掩盖。
8. **HRS 是 Route A 的 retarget/bake 工具。** 2026-08-26 的 R3 增补允许在 A 失败时尝试 ARP/HRS 已有原生能力作为 Route B；两条路线均不得引入 Rayure 自研补救，且必须独立通过语义审计与 GLB 门禁。

---

## 1. GitHub 现状回顾

### 1.1 当前已具备的能力

基线 HEAD 已包含：

- ARDY 子进程、生成服务、运动调度、语义缓存与 Canonical Motion 发布链路。
- Live2D 原生模型、校准、语音、视觉和行为编排能力。
- PMX/VMD 的 Three.js/MMD 运行时，以及用于 3D 调试的 ARDY Canonical Motion 驱动表面。
- `scripts/ardy-bridge.py`：把 ARDY 结果输出为 `rayure.ardy-motion.v1`；随后 companion 将其转为 `rayure.motion.v1`。

这些能力应被视为迁移基线，而不是新架构已经完成的证据。

### 1.2 与目标架构冲突的现状

当前 3D 路径恰好包含本任务禁止继续发展的两类自研适配层：

1. [`apps/wallpaper/src/bone-remapper.ts`](https://github.com/ApolloEddy/Rayure/blob/94db6e2592a31e6b9e85b22f750e993a297d204b/apps/wallpaper/src/bone-remapper.ts) 内含 `STANDARD_BONE_ALIASES`，在 PMX 加载后按别名重命名/猜测骨骼；[`bone-remapper.test.ts`](https://github.com/ApolloEddy/Rayure/blob/94db6e2592a31e6b9e85b22f750e993a297d204b/apps/wallpaper/test/bone-remapper.test.ts) 固化了这套行为。
2. [`apps/wallpaper/src/ardy3d/canonical-rig-adapter.ts`](https://github.com/ApolloEddy/Rayure/blob/94db6e2592a31e6b9e85b22f750e993a297d204b/apps/wallpaper/src/ardy3d/canonical-rig-adapter.ts) 配合 [`core-bone-names.ts`](https://github.com/ApolloEddy/Rayure/blob/94db6e2592a31e6b9e85b22f750e993a297d204b/apps/wallpaper/src/ardy3d/core-bone-names.ts) 和 [`rig-scale.ts`](https://github.com/ApolloEddy/Rayure/blob/94db6e2592a31e6b9e85b22f750e993a297d204b/apps/wallpaper/src/ardy3d/rig-scale.ts)，在运行时按候选名称、层级和比例把 Canonical Motion 写入任意 Three.js 骨架。这本质上是运行时骨架识别/适配/重定向。

此外：

- [`ModelDescriptor`](https://github.com/ApolloEddy/Rayure/blob/94db6e2592a31e6b9e85b22f750e993a297d204b/packages/protocol/src/index.ts#L131) 目前只有 `pmx | live2d`。
- `MotionDescriptor` 目前只有 `vmd | live2d | canonical`。
- companion 资产网关尚未允许 `.glb/.gltf/.bin`。
- [`mmd-model-host.ts`](https://github.com/ApolloEddy/Rayure/blob/94db6e2592a31e6b9e85b22f750e993a297d204b/apps/wallpaper/src/mmd-model-host.ts) 会在生产 PMX 加载路径调用 BoneRemapper；[`motion-controller.ts`](https://github.com/ApolloEddy/Rayure/blob/94db6e2592a31e6b9e85b22f750e993a297d204b/apps/wallpaper/src/motion-controller.ts) 是 VMD 专用播放器。
- [`three-js-debug-surface.ts`](https://github.com/ApolloEddy/Rayure/blob/94db6e2592a31e6b9e85b22f750e993a297d204b/apps/wallpaper/src/ardy3d/three-js-debug-surface.ts) 是调试验证面，不是目标生产架构。
- 仓库还没有 Blender 离线构建工具、烘焙 GLB 契约、动作 bundle manifest 或基于 `AnimationMixer` 的纯播放 host。

### 1.3 必须保护的现有边界

- Rayure 仍然拥有 Wallpaper Engine CEF 内的 Renderer、Three.js Scene 和 frame loop。
- Live2D 仍可消费 Canonical Motion；本任务只禁止 **3D 运行时**再用 Canonical Motion 做骨架适配。
- ARDY 生成、语义缓存、语音、视觉和 Live2D 不应在 PoC 阶段被改动。
- 本地第三方模型、付费模型、私有纹理和 ARDY 权重不得提交进 Git。

---

## 2. 工具能力校正与架构决策

### ADR-001：HRS 不等于“换骨架拓扑工具”

[Humanoid Remap Studio](https://extensions.blender.org/add-ons/humanoid-remap-studio/) 0.1.66（本文简称 HRS，当前市场名“Rig Bridge”）的公开能力是：识别人形 source/target rig、通过姿态和覆盖率门禁、重定向并把动作烘焙到目标 rig。它能尝试处理常见乱命名、不同层级和 rest pose 差异，但**不会把任意目标模型重新建骨、重命名并转换成标准 VRM/Mixamo/UE5 内部骨架**。

HRS 是第三方 GPL 扩展；“在 Blender 官方扩展平台上架”不等于“Blender Foundation 官方插件”。Kajin 的付费 **RigBridge** 是另一个产品，本 Spec 未选择它，也不得把两者的品牌、能力、价格或验证证据混用。

因此，“标准化”必须拆为两个可验证层次：

| 层次 | 本项目的定义 | 执行方式 |
|---|---|---|
| 运动源标准化 | 固定的 ARDY CoreSkeleton27 BVH 名称、层级、轴、单位、FPS 契约 | 纯格式转换器 |
| 运行资产标准化 | 固定的 `rayure.character-bundle.v1` manifest、GLB 格式、已烘焙 clip、播放语义 | Blender + HRS + glTF exporter |

默认且推荐的生产路径是 **Bake-in-place**：保留第三方模型原始内部 rig，由 HRS 把动作烘焙到它，再导出 GLB。Rayure 不需要知道其骨骼叫什么，因此也不需要把内部 rig 改成 Mixamo/VRM/UE5。

只有以下两种情况才可以宣称输出内部 rig 是 VRM/Mixamo/UE5：

1. 输入模型本来就是该标准且由对应现成工具验证通过；或
2. Phase 0 明确选定并验证了一个独立、现成、未修改的 rig conversion 工具来承担转换。

若产品要求“任意模型必须物理转换为 VRM/Mixamo/UE5 骨架”，但没有经验证的外部 converter，必须以 `TOOL_CAPABILITY_MISMATCH` 失败并停止。**不得把缺失能力偷偷补进 Rayure 或 Blender 脚本。**

### ADR-002：Rayure 只做播放器

目标 3D runtime 的允许职责只有：

- 从已有 tokenized loopback URL 加载 manifest 与 GLB；
- 验证协议、资源大小、hash/ID 和 clip 元数据；
- 使用 Three.js `GLTFLoader` 建立场景对象；
- 使用 `AnimationMixer` 按精确 clip 名称播放、停止、循环和 cross-fade；
- 管理事务隔离、旧请求取消、资源释放和错误 UI。

Three.js 按 glTF animation track 绑定已烘焙节点属于“播放”，不是 retarget。运行时不得遍历骨架做语义判断，也不得重写 track 名称。

### ADR-003：Blender 是离线/构建时依赖

Blender、HRS 和 BVH 工具不得进入 Wallpaper CEF，也不得在 `motion.play` 热路径启动。第三方模型与 ARDY 动作必须先离线构建成可发布 bundle。运行时遇到未烘焙 ARDY 动作时，只能命中已构建目录、回落到已烘焙 idle，或报告 `BAKED_CLIP_NOT_FOUND`；不得即时重定向。

`bpy` 是 Blender 进程内的 Python 绑定，不是可脱离 Blender 引擎单独安装的 KB 级官方依赖。本项目固定使用完整 Blender 的 headless 调用：

```text
blender.exe --background --factory-startup --python <driver.py> -- <args>
```

Blender 的体积属于离线构建机成本；最终 bundle、Companion、Wallpaper 和终端用户环境都不得依赖 Blender。

### ADR-004：按源格式直接导入，不建立“统一转 FBX”前置层

“统一成 FBX”只统一文件容器，不统一骨架拓扑、骨名、rest pose 或蒙皮；乱拓扑 MMD 转成 FBX 后仍是乱拓扑。FBX 的轴和单位约定还随 Blender/Maya/3ds Max/Mixamo 导出器而变，因此它不是本项目的 canonical 输入层。

本项目不设置通用“模型转换”步骤，而是让每种格式直接进入 Blender：

| 源格式 | 直接导入路径 | 使用门禁 |
|---|---|---|
| `.blend` | Blender 原生打开/链接 | 记录 Blender 版本；运行世界姿态门 |
| `.fbx/.glb/.gltf/.dae/.obj` | Blender 原生 importer | 锁定完整 importer options、单位与轴；运行世界姿态门 |
| `.pmx/.pmd` | 锁定版本与校验和的 `mmd_tools` | 完成许可/hash/headless importer gate；运行世界姿态门 |
| `.vrm` | 锁定版本与校验和的 VRM Add-on for Blender | 完成许可/hash/headless importer gate；运行世界姿态门 |
| 其他格式 | 已验证、未修改的生态 importer | 未锁定前必须 `IMPORTER_NOT_LOCKED` 失败，不得临时自写 converter |

这里的“直接导入”是指不先生成 FBX 中间文件；通过 `mmd_tools`/VRM Add-on 进入 Blender 也属于直接导入。若某来源在例外情况下必须经过外部 FBX exporter，必须锁定该成熟工具，并同时记录 exporter 与 Blender importer 的完整轴/单位选项；随后仍须通过同一个世界姿态门。

每个目标模型在进入 HRS 前必须运行现有 PoC 探针 `scratch/rig-pipeline-poc/scripts/phase2_target_posture_probe.py`，至少验证 `Head.z > Hips.z > LeftFoot.z/RightFoot.z`、坐标有限、armature 可唯一选择，并保存 `matrix_world`/骨位置报告。当前 scratch 探针只是 Phase 2 harness；Phase 2 必须使 unsupported format、无 armature、缺关键骨或关系不成立返回非零，Phase 3 再把等价严格门禁提升为 tracked builder 能力。

若生产 builder 需要 canonical 中间产物，只允许在“直接导入 + 轴/单位记录 + 世界姿态门”通过后由 Blender `import → export GLB` 生成。该 GLB 用于缓存和可复现构建，不代表目标骨架被改造成 ARDY 27 关节。

### ADR-005：HRS 自动主路径（R2 历史；R3 增补 fallback）

本节保留 R2 的 HRS-only 证据边界；当前执行以文首 R3 用户增补为准。也就是说，HRS 仍是 Route A 的主路径，Route B 只允许调用 ARP/HRS 已有原生能力，不得变成 Rayure 自研的第二套 retarget 或映射实现。

- **Route A 自动主路径**：Blender headless + HRS 公开 operator。历史 PoC 的 `3/4` 统计只计算此路径；不得手填 HRS slot 或插入自研算法。
- Route A 无法处理的模型可按 R3 从干净 scene 进入 Route B；两条路线必须独立出报告并通过同一语义门禁，不能改写失败记录或宣传为“任意模型全自动”。
- KBSBAUDRICE/Retarget 不作为 R2 主路径：其名字/profile 映射机制不能回答无命名骨架用例。Kajin RigBridge 也暂不进入锁定工具链，除非后续独立核验公开 API、headless 自动化、许可证与真实模型结果并由用户拍板替换。

---

## 3. 强制约束

### 3.1 绝对禁止

- 禁止自研或移植 retarget、IK、FK 重定向、约束求解、foot lock、root motion 修复算法。
- 禁止新增、扩展或维护 bone alias 表；禁止模糊匹配、正则猜骨、编辑距离猜骨、多语言名称映射。
- 禁止根据模型几何、骨长、左右位置、父子层级或朝向自行识别人形角色。
- 禁止推断骨轴、forward axis、roll、rest pose 或 target scale。
- 禁止修改、fork、monkey-patch HRS 或 BVH Retargeter 的算法和数据表。
- 禁止脚本静默写 HRS 的映射 slots 来绕过 `auto_guess` 失败。
- 禁止让 ARDY→BVH 转换器读取目标模型或 target skeleton。
- 禁止在 ARDY→BVH 中做平滑、去抖、补帧、重采样、动作修复、接地、去滑步或目标比例适配。
- 禁止继续给 `BoneRemapper`、`CanonicalMotionRigAdapter`、`CORE_BONE_CANDIDATES` 或 `rig-scale` 打补丁。
- 禁止 PoC 未通过就修改生产协议、生产 server、Wallpaper 主循环或删除旧实现。

### 3.2 允许的 ARDY→BVH 操作

仅允许：

- 读取 ARDY 官方 CoreSkeleton27 输出字段；优先直接读取官方 `.npz` 的 `local_rot_mats`、`root_positions`、`fps`。
- 使用固定、带版本号且可追溯到官方 ARDY 的 27 关节名称、父索引、rest offsets 和坐标系定义。
- 固定单位换算和固定坐标基变换。
- rotation matrix/quaternion 到固定 BVH Euler channel order 的等价表示转换；仅为保持同一旋转而做 ±360° 连续化是允许的。
- 把 root translation 写入 Hips channel，把 local rotations 写入对应关节 channel。
- 严格校验 shape、joint count、帧数、FPS、有限数值和输入版本。

若现有 `rayure.ardy-motion.v1` 只提供 world/global transform，PoC 不应反向扩展它。新 converter 应直接消费官方 ARDY `.npz`，现有 JSON bridge 保留给 Live2D。只有在官方输出不可取得 `local_rot_mats`，且 parent-world 到 local 的转换可证明是无损机械格式转换时，才允许提交一份 ADR 后采用；不得顺便加入姿态修复。

### 3.3 第三方工具使用约束

- HRS 固定使用可核验的发布包，并在 lock 文件记录准确产品名、扩展 ID、维护者、版本、下载来源和校验和；不得写成 Blender 官方插件或与 Kajin RigBridge 混称。
- 允许的自动主路径是调用公开 operator，例如 `bpy.ops.hrs.auto_guess()`、读取 `hrs_can_execute_retarget` 与诊断字段、再调用 `bpy.ops.hrs.execute_retarget()`。
- `hrs_can_execute_retarget=true` 只表示插件允许执行，不表示映射语义正确；报告必须保留每个 role→bone 结果，并经过独立审计。
- `mmd_tools`、VRM Add-on 或其他非内置 importer 在首次使用前必须锁定来源、版本、许可、兼容 Blender 版本、校验和与 headless 导入证据。
- 若使用 [BVH Motion Retargeter](https://github.com/BacteriaJun/BVH-Motion-Retargeter)，必须使用其内置的 Mixamo/UE5/VRM profile。ARDY BVH 的关节名应对齐它已有默认 profile；不得为本项目新增自定义 mapping JSON。
- 外部 addon API、版本或 operator 不匹配时必须失败；不得通过反射、内部模块 patch 或复制算法规避。
- 每次构建必须记录 Blender、HRS、BVH 工具、模型 importer、glTF exporter 和 ARDY 的版本。

---

## 4. 目标数据流

```mermaid
flowchart TD
    A["ARDY CoreSkeleton27 NPZ"] --> B["严格格式转换：BVH"]
    C["第三方 3D 模型"] --> D["Blender 官方/现成导入器"]
    D --> P["锁定轴/单位 + 世界 rest posture probe"]
    B --> E["HRS 自动 retarget/bake"]
    P --> E
    E --> F["目标 rig 上的 baked Actions"]
    F --> G["GLB + character bundle manifest"]
    G --> H["Rayure：加载、播放、cross-fade"]
```

管线边界：

1. **Source motion boundary**：ARDY NPZ → 固定 CoreSkeleton27 BVH。无目标模型知识。
2. **DCC import boundary**：Blender 按源格式直接导入目标模型，不先统一转 FBX；记录 importer、轴、单位并通过世界 rest posture probe。
3. **Retarget boundary**：ARDY BVH 已经是排好层级的 27 关节动作源；HRS 将这些 humanoid roles 映射到目标模型现有骨并 bake，目标骨架不被转换为 ARDY 骨架。HRS 是唯一 retarget/bake 工具，失败不走替代路径。
4. **Artifact boundary**：导出保留目标模型原骨架、带 baked Actions 的 GLB 与 manifest。之后所有骨架语义结束。
5. **Runtime boundary**：Rayure 根据 clip ID/精确名称播放 glTF 动画，不接触 humanoid 语义。

---

## 5. 文件与目录规划

PoC 必须与生产代码隔离：

```text
tools/rig-pipeline/
  README.md
  toolchain.lock.json
  ardy_to_bvh.py
  schemas/
    core-skeleton-27.v1.json
    character-bundle.v1.schema.json
    pipeline-failure.v1.schema.json
  blender/
    rig_bridge_driver.py
    build_character_bundle.py        # PoC 通过后才增加
  tests/
    test_ardy_to_bvh.py
    test_failure_schema.py
    fixtures/                         # 只放小型、可再分发、无私有资产 fixture
  reports/                            # 仅提交脱敏的 JSON/Markdown 证据

scratch/rig-pipeline-poc/             # gitignored；私有模型、blend、视频、GLB 中间物
```

PoC Gate 通过后再修改：

```text
packages/protocol/
apps/companion/
apps/wallpaper/
docs/
scripts/verify.ps1
```

`rig_bridge_driver.py`（保留历史文件名亦可）只能负责：安装状态检查、设置 source/target object 引用、调用 HRS 公开 operator、读取公开状态、导出诊断。文件中不得出现自建 alias、自动填 mapping slot 或姿态求解。

---

## 6. 契约定义

### 6.1 `core-skeleton-27.v1` BVH profile

profile 必须以 [ARDY 官方 skeleton definition](https://github.com/nv-tlabs/ardy/blob/main/ardy/skeleton/definitions.py) 为来源，固定以下内容：

- joint set：官方 CoreSkeleton27；名字保持 `Hips`、`Spine`、`Spine1`、`Spine2`、`Spine3`、`Neck`、`Head`、左右肩/臂/前臂/手/手端/拇指、左右大腿/小腿/脚/趾。
- hierarchy：与官方定义完全一致。
- rest offsets：来自固定版本 ARDY 官方中性骨架资源；不得从目标模型拟合。
- axis basis、单位倍率、Euler channel order：Phase 0 用官方 fixture 与 Blender round-trip 确认一次后写入 profile；以后不按模型或 clip 猜测。
- timing：保留输入 FPS 和帧数，不重采样。
- Hips：唯一 translation channel；其他 joint 只有 rotation channel。
- End Sites：按固定 profile 输出；不得从 target rig 补全。

转换器 CLI 建议：

```text
ardy_to_bvh.py \
  --input motion.npz \
  --output motion.bvh \
  --profile core-skeleton-27.v1 \
  --report motion.conversion.json
```

CLI 不得提供 `--target-model`、`--bone-map`、`--guess-axis`、`--scale-to-character`、`--fix-feet` 等参数。

输入校验失败时返回非零退出码，不产生“看似成功”的 BVH。输出应是确定性的：相同 input bytes、profile 和工具版本产生相同 BVH hash。

### 6.2 Blender/HRS 自动主路径契约

每次 target build 必须执行：

1. 新建干净 Blender scene。
2. 按 ADR-004 使用 Blender 原生 importer 或明确锁定的现成 importer 直接导入第三方模型；未锁定即 `IMPORTER_NOT_LOCKED`，执行失败即 `IMPORT_FAILED`。
3. 保存原始来源格式、import operator 与完整 canonicalized options；运行严格 target posture probe。必须确认关键坐标有限、`Head.z > Hips.z > LeftFoot.z/RightFoot.z`，并记录 target rig 的骨名、父索引和 rest matrices 指纹。失败即 `REST_POSE_REJECTED`，不得进入 HRS。
4. 导入 CoreSkeleton27 BVH 作为 source armature；该 27 关节层级已经在 Phase 1 固定，不再“重排”。
5. 明确设置 HRS source/target armature 引用；方向固定为 **ARDY source roles → target model existing bones**。
6. 仅调用 HRS 自动识别；保存 `hrs_auto_summary`、`hrs_auto_detail`、posture/coverage 与完整 role→bone 结果。
7. 若 `hrs_can_execute_retarget !== true`，输出失败报告并退出自动主路径；不得进入手工 HRS mapping。若布尔门禁为 true 但角色映射审计发现 off-by-one、左右互换、头发/附件骨误选或核心 role 缺失，该模型仍以 `RIG_MAPPING_SEMANTIC_MISMATCH` 失败。
8. 调用 HRS 的公开 retarget/bake operator。
9. 验证生成 Action 存在、frame range 正确、F-Curves 非空且数值有限，并保留 HRS 的结果 tag/metadata。
10. 将 Action 绑定到目标模型；保留模型材质、morph targets、secondary bones。重新计算 target rig 指纹并要求与第 3 步完全相同；骨名、父子层级或 rest matrices 被改变即 `TARGET_RIG_MUTATED`。不得推断或驱动未被工具处理的面部/辅助骨。
11. 使用 Blender glTF exporter 输出 GLB；输出统一为 glTF 2.0 右手系、米制、已烘焙 clip，目标模型仍使用自己的 rig。
12. 在另一个全新 Blender scene 中重新导入 GLB，不加载 HRS 或任何 retarget addon，确认 clip 可独立播放。

第 3、9、10、12 步是门禁/产物验证，不是 retarget 实现。严禁把“目标模型 → ARDY 27 骨架”作为任何步骤的输出。

### 6.3 Character bundle manifest

生产 manifest 使用严格 schema，例如：

```json
{
  "schema": "rayure.character-bundle.v1",
  "bundleId": "sample-character-v1",
  "characterId": "sample-character",
  "displayName": "Sample Character",
  "source": {
    "format": "vrm",
    "sha256": "<hex>",
    "importer": {
      "id": "vrm-addon",
      "version": "<pinned>",
      "operator": "<exact Blender operator>",
      "options": [
        { "name": "<option>", "value": "<canonical JSON scalar>" }
      ]
    },
    "axis": {
      "declaredUp": "+Y",
      "declaredForward": "+Z",
      "unitMeters": 1.0
    },
    "posture": {
      "schema": "rayure.target-posture.v1",
      "reportSha256": "<hex>",
      "headAboveHips": true,
      "leftFootBelowHips": true,
      "rightFootBelowHips": true
    }
  },
  "model": {
    "format": "glb",
    "file": "character.glb",
    "sha256": "<hex>",
    "bytes": 12345678,
    "artifactProfile": "gltf-2.0-rh-y-up-meters"
  },
  "rig": {
    "artifactProfile": "bake-in-place",
    "declaredStandard": null,
    "motionSourceProfile": "core-skeleton-27.v1",
    "targetRigFingerprintSha256": "<hex>"
  },
  "clips": [
    {
      "id": "idle-001",
      "displayName": "Idle 001",
      "embeddedClipName": "rayure__idle-001",
      "loop": true,
      "rootMotion": "in-place",
      "durationMs": 4200,
      "fps": 20,
      "sourceMotionSha256": "<hex>"
    }
  ],
  "build": {
    "pipelineVersion": "1.0.0",
    "blenderVersion": "<pinned>",
    "retargetTool": {
      "id": "humanoid-remap-studio",
      "version": "<pinned>",
      "mode": "auto"
    },
    "bvhTool": null,
    "ardyRevision": "<commit>",
    "builtAt": "<ISO-8601>"
  }
}
```

要求：

- `embeddedClipName` 在单一 GLB 内唯一，且只由离线 builder 生成。
- `rootMotion` 是离线构建选项；runtime 不做 root removal。
- `source.format` 必须是用户提供的原始格式，不能伪装成中间 GLB/FBX；manifest 不保存原始绝对路径或私人文件名。
- `source.importer` 必须保存精确工具/operator/options；options 按名称排序并 canonicalize，确保同一导入过程可复现。外部 FBX round-trip 若获准，exporter 与 importer 两端选项都必须进入 provenance。
- `source.posture` 必须引用通过的严格 probe 报告；缺关键骨、非有限坐标或 `Head.z > Hips.z > Feet.z` 不成立时不得发布 bundle。
- `motionSourceProfile=core-skeleton-27.v1` 只描述 ARDY 动作源；`artifactProfile=bake-in-place` 和 target rig 指纹证明输出保留目标模型骨架。
- `model.artifactProfile` 固定输出 GLB 的格式、坐标与单位约定；clip FPS/时长必须与烘焙结果一致，不得由 runtime 猜测。
- `declaredStandard` 只有外部工具已验证为 `vrm`、`mixamo` 或 `ue5` 时才可填写；不能根据骨名猜。
- manifest 不包含本地绝对路径、用户名、密钥或第三方资产原始文件名。
- 模型 hash、动作 hash、工具链版本必须可复现。
- v1 PoC 使用单一 self-contained GLB。大目录是否改为 animation shard，必须先做 100–500 动作的大小、加载、内存和 track-binding PoC；不得一开始就把全部语义库重复打包。

### 6.4 Protocol 契约

PoC 通过后，协议增加明确 union，而不是给旧 `canonical` 偷塞字段：

```ts
interface BakedGlbModelDescriptor {
  id: string
  displayName: string
  format: 'baked-glb'
  url: string
  manifestUrl: string
}

interface BakedClipMotionDescriptor {
  id: string
  displayName: string
  format: 'baked-clip'
  url: string              // tokenized manifest URL；或按最终协议设计为 bundle reference
  characterId: string
  clipName: string         // 与 embeddedClipName 精确相同
  loop?: boolean
  fadeMs?: number
}
```

最终字段名可按现有协议风格调整，但必须满足：

- descriptor 只指向 tokenized loopback URL，不暴露文件系统路径。
- clip descriptor 与 character/bundle 明确绑定；不得把某角色动作静默用于另一个角色。
- 协议 validator 拒绝未知字段、空 ID、非法 URL、超长 clipName、非有限 duration/fade。
- 旧 `canonical` descriptor 仅供 Live2D；Wallpaper 3D host 不接受它。
- 旧 `pmx`/`vmd` 配置迁移后应返回 `MODEL_REQUIRES_OFFLINE_BUILD`，不得再默认进入 BoneRemapper。

### 6.5 Runtime 播放契约

新增 `BakedGlbModelHost`（最终命名可按仓库风格调整）：

- `GLTFLoader.loadAsync(model.url)`；不得加载 `.blend`、BVH 或源模型。
- 读取 `gltf.animations`，按 manifest 中的 **精确** `embeddedClipName` 建索引。
- `AnimationMixer.clipAction(clip)` 执行 play/stop/loop/cross-fade。
- 不得访问 `SkinnedMesh.skeleton.bones` 来决定关节语义。
- 不得修改 `KeyframeTrack.name`、查找近似节点名或建立 alias。
- 缺 clip 时报告 `BAKED_CLIP_NOT_FOUND`，保持或回落到已声明的 baked idle；不得选择“最像”的 clip。
- generation/request id 必须隔离，晚到的旧 load 不得覆盖新模型。
- 模型切换、clip 切换和 host dispose 必须释放 mixer action、geometry、material、texture 和 object URL/loader 资源。
- cross-fade 只混合已烘焙 clips，不更改骨架或 rest pose。

### 6.6 3D 动作目录与调度契约

- 3D 模式只发布已存在于当前 bundle manifest 的 `baked-clip`。
- 现有 ARDY 语义生成可继续服务 Live2D，或在离线 batch 中生成待烘焙动作；不得把新生成 Canonical Motion 直接送给 3D host。
- 建立 `motionId/promptHash -> baked clip id` 的离线目录。此目录只做资产索引，不做骨骼映射。
- 目录 miss 时发布可观测错误并使用 bundle 明确声明的 baked idle；不得启动 Blender 或 runtime retarget。
- 首轮不要处理全部大规模动作库。先用 100–500 个代表性动作测量 bundle 体积、构建时间、峰值内存、启动时延和检索命中，再决定分片方案。

### 6.7 失败报告契约

所有离线阶段共用 `rayure.rig-pipeline-failure.v1`：

```json
{
  "schema": "rayure.rig-pipeline-failure.v1",
  "runId": "<uuid>",
  "stage": "rig-detection",
  "code": "RIG_DETECTION_FAILED",
  "message": "HRS automatic mapping did not satisfy the Rayure PoC gate.",
  "input": {
    "modelBasename": "character.pmx",
    "modelSha256": "<hex>",
    "motionSha256": "<hex>"
  },
  "toolchain": {
    "blenderVersion": "<version>",
    "retargetToolId": "humanoid-remap-studio",
    "retargetToolVersion": "<version>",
    "retargetMode": "auto",
    "modelImporterId": "<id>",
    "modelImporterVersion": "<version>",
    "bvhToolVersion": null
  },
  "externalToolStatus": {
    "autoSummary": "<verbatim short status>",
    "autoDetail": "<verbatim diagnostic>",
    "canExecuteRetarget": false
  },
  "fallbackAttempted": false,
  "createdAt": "<ISO-8601>"
}
```

允许的稳定错误码至少包括：

| 错误码 | 含义 |
|---|---|
| `INPUT_INVALID` | ARDY/manifest/模型输入缺字段、shape 错、非有限数值等 |
| `ARDY_REFERENCE_SKELETON_MISSING` | 固定官方 skeleton/profile 不可用 |
| `POC_MATRIX_INCOMPLETE` | 无法在合法资产边界内凑齐四槽位/至少三个 rig 家族 |
| `IMPORTER_NOT_LOCKED` | 目标格式所需 importer 尚未完成来源/版本/许可/hash/headless 门禁 |
| `IMPORT_FAILED` | 现成模型/BVH importer 失败 |
| `RIG_BRIDGE_NOT_INSTALLED` | 锁定的 HRS 第三方 addon 未安装或未启用（错误码为兼容历史命名保留） |
| `RIG_BRIDGE_API_MISMATCH` | HRS 锁定公开 API 与安装版本不符（错误码为兼容历史命名保留） |
| `RIG_DETECTION_FAILED` | auto guess/coverage gate 不通过 |
| `RIG_MAPPING_SEMANTIC_MISMATCH` | addon 允许执行，但 role→bone 映射出现语义错位或核心 role 错配 |
| `POSTURE_REFERENCE_UNAVAILABLE` | 无可信 fixture/humanoid metadata 可指定 Hips/Head/Feet，继续将需要自行猜骨 |
| `REST_POSE_REJECTED` | 严格世界姿态 probe 或外部工具姿态门禁拒绝 |
| `TARGET_RIG_MUTATED` | retarget/bake 前后目标骨名、父层级或 rest matrices 指纹发生变化 |
| `SOURCE_MAPPING_FAILED` | 现成 BVH profile 无法识别固定 source |
| `RETARGET_FAILED` | 外部 operator 执行失败 |
| `BAKE_VALIDATION_FAILED` | action/帧/曲线/重导入验证失败 |
| `EXPORT_FAILED` | GLB/manifest 导出失败 |
| `TOOL_CAPABILITY_MISMATCH` | 要求超出已验证外部工具能力 |
| `RUNTIME_LOAD_FAILED` | Rayure 无法加载已验证 bundle |
| `BAKED_CLIP_NOT_FOUND` | 目录或 GLB 中不存在精确 clip |

失败报告可以原样附带外部工具诊断，但不得自动生成 alias 建议或“可能是哪根骨”的猜测。

---

## 7. PoC 设计与硬门禁

### 7.1 PoC 输入矩阵

自动主矩阵固定为 **4 个目标槽位 × 3 类 ARDY 动作**，并覆盖至少三个不同常见 rig 家族：

| 槽位 | 要求 | 目的 |
|---|---|---|
| A | 有效 VRM 或其他干净标准参考 rig | 排除 source/profile 的基础错误 |
| B | MMD/PMX deform rig，经锁定的 `mmd_tools` 直接导入 | 验证日文/变形骨与复杂辅助骨 |
| C | Mixamo、UE mannequin 或同类标准 FBX rig | 验证非 MMD 的常见交换链路 |
| D | Rigify 或真实 custom production rig | 验证不同层级、控制/变形骨或 rest pose |

约束：

- 同一模型文件或同一角色的两个 armature 可作为诊断样本，但在“至少三个 rig 家族”统计中只算一个来源家族。
- 若没有合法可用的某个家族输入，不得用更多 MMD 样本凑数；应记录 `POC_MATRIX_INCOMPLETE` 并等待用户提供/授权。
- 每个槽位运行 3 类 ARDY 动作：idle/轻微全身、明显上肢动作、带 Hips 位移的 locomotion。
- 额外创建 1 个**合成无命名用例**：复制干净参考 rig，只把骨名确定性改为 `Param001…ParamNNN`，不改变层级、rest pose、蒙皮或几何。它不进入 4 个真实槽位的分母。
- 私有模型、模型名、绝对路径、纹理、导出 GLB 与截图仍只存在于外部只读位置或 `scratch/rig-pipeline-poc/`；Git 只保存脱敏 family 标签、hash、报告与许可状态。

四个真实槽位回答“常见多模型族能否覆盖”；`Param001` 用例单独回答“自动识别是否真的不依赖骨名”。只在标准 rig 或只在 MMD 上成功都不算本 Spec 的广泛兼容证据。

### 7.2 PoC 隔离

- PoC 输出到 `scratch/rig-pipeline-poc/`。
- 在 Phase 2 结束前，不修改 `apps/wallpaper/src/main.ts`、`RayureScene`、生产 protocol/server，也不删除旧文件。
- 可建立独立 Three.js harness 验证 GLB + `AnimationMixer`，但不得把 harness 接入生产入口；普通 Chromium harness 结果不得冒充 Wallpaper Engine CEF 验收。
- 私有模型、纹理、`.blend`、大体积 GLB、渲染视频不提交；提交脱敏报告、hash、截图索引和复现实验命令。

### 7.3 `POC-PASS` 全部条件

必须同时满足：

1. ARDY `.npz` → BVH 是确定性输出，严格输入校验通过。
2. Blender 重新导入 BVH 后，固定 reference rig 的根位移、帧数、FPS 和关节旋转与 ARDY source 在数值容差内一致；建议 rotation ≤ 0.25°、root translation ≤ 1 mm（换算到米后）。若官方单位/浮点精度证明需调整，必须先写证据再改阈值。
3. 四个目标槽位均按源格式直接导入，记录原始格式、importer/operator/options、轴与单位；使用预先声明的 fixture ground-truth bones 运行 `phase2_target_posture_probe.py`，确认世界姿态门通过。probe 只验证，不得猜骨；缺 ground truth 或关键 role 时该输入不计为通过。
4. 四个真实槽位中至少 3 个由 HRS **唯一自动路径**通过，且通过集合覆盖至少三个 rig 家族；没有手工 HRS slot、alias、代码 fallback 或第二套 retarget 工具混入分母。
5. 每个计入通过率的模型都同时满足插件布尔门禁和独立 role→bone 语义审计；off-by-one、左右互换、附件骨误选或核心 role 缺失均判该模型失败。
6. 三类动作在每个计入通过率的模型上均成功 retarget、bake，并产生独立 Action；target rig 指纹在 bake 前后完全一致。
7. GLB 在不加载任何 retarget addon 的全新 Blender scene 中可播放，且输出格式/坐标/单位和 clip FPS 与 manifest 一致。
8. 独立 Three.js harness 仅通过 `GLTFLoader + AnimationMixer` 可精确选择三条 clip、loop、stop、cross-fade。
9. 对每个模型完成人工视觉验收：无爆炸骨架、无整体翻转、无明显漂移/穿地到不可用程度。视觉验收只判定工具输出是否可接受，不允许随后自写修复算法。
10. 生成 success report、toolchain lock、输入/output hash、导入/姿态 provenance、许可状态和复现命令。

`Param001` 合成用例是必跑的能力分类门，不改变上述 `3/4` 核心判定：

- 自动通过且与原名 baseline 语义一致：标记 `anonymousBoneNames=auto-validated`，范围仅限该 fixture/工具版本。
- 自动失败：标记 `anonymousBoneNames=unsupported`，禁止宣称“无命名骨架自动兼容”；不得以第二套 retarget 工具或自研补救改写自动结果。
- 即使合成用例通过，也不得推导为“任意 Param 模型必过”；真实无命名模型仍需独立验收。

任一条件不满足即 `POC-FAIL`。失败时：

- 保存结构化失败报告和可公开的脱敏证据；
- 提交证据性 commit 后停止；
- 不进入 Phase 3；
- 向用户说明是哪个 importer/HRS/外部工具门禁失败，以及需要更换输入模型、工具版本或由用户明确授权哪个现成工具；
- 不提出“我可以补一个 alias/小算法”作为下一步。

---

## 8. 分阶段实施与提交协议

每个 Phase 的顺序固定为：检查工作区 → 实施 → 阶段测试 → 更新证据 → `git diff --check` → 单独提交 → 记录 commit SHA。下一 Phase 开始前工作区必须干净；用户原有未提交修改除外，此时必须避开并在报告中说明。

每个 Phase 内再拆成一次最多触碰 3 个逻辑节点的微步骤；每个微步骤在动手前写明完成标准和验证方法。若微步骤失败，停在当前 Phase，不把半成品串入下一子系统。

### 8.0 锁定的阶段地图、验收层与回滚点

| Phase | 产品边界 | 阶段验收 | 回滚/停止点 |
|---|---|---|---|
| 0（已完成） | 基线、工具能力与锁文件 | 只读审计、版本/hash/API 证据 | 不改生产代码；历史报告保留，R2 只做措辞/矩阵修订 |
| 1（已完成） | ARDY NPZ → CoreSkeleton27 BVH | golden、非法输入、确定性、Blender round-trip | converter 独立存在，不影响现有 runtime |
| 2（当前入口） | 自动识别、retarget/bake、GLB 纯播放技术赌注 | 4 槽位/3 家族、3 动作、语义审计、GLB 重导入、Three.js harness、视觉证据 | 失败只提交脱敏证据并停；`apps/`/`packages/` 仍未改变 |
| 3 | 生产级离线 builder | 单命令、确定性、原子输出、可恢复、失败报告 | builder 与 runtime 隔离；可回退 Phase 3 独立提交/丢弃 bundle |
| 4 | strict 协议、配置与只读资产网关 | validator/负例/安全/迁移测试 | baked 协议未成为默认；用明确 temporary legacy flag 或回退独立提交 |
| 5 | `BakedGlbModelHost` 纯播放器 | lifecycle、clip、cross-fade、dispose；真实 bundle 浏览器预检 | Phase 6 前不切默认路由；失败禁用新 host，旧路径仍在 |
| 6 | 目录、调度、Live2D/3D 分流 | 3D 只收 descriptor；Live2D 无回归；100–500 动作报告 | Phase 7 前保留显式 legacy 回退；不得静默双写两条 3D 路径 |
| 7 | 退役旧 3D 适配栈 | 依赖闭包、符号 guard、全量回归 | 只在 Phase 6 稳定后删除；回滚用 Phase 7 独立 commit 的 `git revert`，不手工拼回 |
| 8 | 完整验收与交付证据 | code/test、build/artifact、Wallpaper Engine CEF/视觉、文档四层分别结论 | 任一真实环境门未过，只能报告缺口，不得宣称完整迁移完成 |

Phase 3–8 不合并：它们分别拥有离线生产、协议/网络、Three.js 播放、调度、旧栈退役和真实环境验收六个不同故障域。Phase 7–8 看似收尾，但前者是回归风险最高的破坏性切换，后者包含不可由普通浏览器替代的 CEF 接受门。

### Phase 0 — 基线、工具锁定与能力审计

范围仅限文档、`tools/rig-pipeline/toolchain.lock.json` 和脱敏报告。

R2 状态：commit `b8ac47d` 已完成本阶段；现有报告中的“Rig Bridge 官方版”只能解释为“可核验的官方扩展平台发布包”，不能解释为 Blender Foundation 官方插件。新增源格式在 Phase 2 使用前补做 importer gate，不改写 Phase 0 历史证据。

任务：

- 重新核对本 Spec 第 1 节文件及当前调用图。
- 锁定 Blender、HRS 的准确身份、模型 importer、BVH Motion Retargeter（若使用）、glTF exporter、ARDY revision。
- 用官方文档/代码确认公开 operator 和状态字段。
- 验证当前产品所说“标准化骨架”选择 Bake-in-place，还是已经具备真正外部 converter。没有 converter 时不得承诺物理换骨架。
- 验证 ARDY 官方坐标系、单位、neutral skeleton 来源与 `.npz` shape；形成 `core-skeleton-27.v1` profile 草案。
- 建立禁改文件/禁用符号清单和 PoC 输入矩阵。

验收：能力表有证据、版本可安装、输入可合法使用、没有生产代码变更。

提交：

```text
docs(rig-pipeline): record baseline and tool capability gate
```

### Phase 1 — 隔离的 ARDY→BVH 格式转换 PoC

任务：

- 实现严格 converter、schema、golden fixture 与失败报告。
- converter 直接消费官方 ARDY `.npz`；不复用/扩大目标模型相关逻辑。
- 用 Blender 原生 BVH importer 做 round-trip 验证。
- 测试确定性 hash、非法 shape、缺 joint、NaN/Inf、错误 FPS、截断文件、超大输入限制。

验收：第 7.3 条第 1–2 项全部通过；代码中不存在 target/alias/guess/retarget 路径。

提交：

```text
feat(poc): add strict ARDY to BVH format bridge
```

### Phase 2 — HRS 自动 retarget/bake 与纯播放 PoC

任务：

- **2A 工具/输入预检（≤3 节点）**：为实际使用的 Blender 原生 importer、`mmd_tools`、VRM Add-on 锁来源/版本/许可/hash/options；把现有 scratch posture probe 收紧为严格非零失败与结构化报告；确认四槽位覆盖至少三个家族且资产均外置只读。
- **2B 自动映射门（≤3 节点）**：逐格式直接导入并先跑 posture probe；实现最薄 HRS driver；跑四个真实槽位与 `Param001` 合成用例，同时保存插件状态和独立 role→bone 语义审计。
- **2C 烘焙产物门（≤3 节点）**：对每个自动通过模型跑三类动作；验证 Action 和 target rig 前后指纹；导出并在无 addon 的全新 Blender scene 重导 GLB。
- **2D 纯播放/视觉门（≤3 节点）**：建立独立 Three.js harness；验证精确 clip/loop/stop/cross-fade；保存脱敏视觉证据并汇总 `POC-PASS`/`POC-FAIL`。

验收：第 7.3 的十项核心条件全部通过，产出明确 `POC-PASS` 报告，并单列 `anonymousBoneNames` 能力标签。普通浏览器 harness 不关闭 Wallpaper Engine CEF 门。

成功提交：

```text
test(poc): prove external retarget and baked GLB playback
```

失败提交（仅证据，不得夹带生产重构）：

```text
docs(poc): record external rig pipeline failure
```

失败后必须停止。

### Phase 3 — 生产级离线 bundle builder

仅在 `POC-PASS` 后开始。

任务：

- 把 PoC driver 提升为可批处理、可恢复、确定性的 CLI。
- 把 scratch posture probe 的等价严格逻辑纳入 tracked builder；模型按原始格式直接导入，未锁 importer 或 posture 不通过即失败。
- 实现 strict manifest schema、hash、版本 provenance、日志、临时目录、原子输出和失败清理。
- 若启用 canonical 中间 GLB，只能在直接导入和 posture gate 通过后生成，并把原始格式、导入选项和中间产物 hash 纳入 cache key。
- 支持 in-place/root-motion 两种**外部工具已有**选项；不得自写 root motion 修改。
- 支持多 Action 命名、去重与构建缓存；cache key 至少包含 target model hash、source motion hash、profile 与完整 toolchain versions。
- 失败时保留报告，不发布半成品 bundle。
- 文档化私有资产输入、许可与 gitignore 规则。

验收：从空目录用单条 documented command 可重建同 hash bundle；中断不会留下被当成成功产物的目录。

提交：

```text
feat(rig-pipeline): build deterministic baked character bundles
```

### Phase 4 — Protocol、配置与资产网关

任务：

- 增加 `baked-glb` model 与 `baked-clip` motion 的 strict union/validator。
- 增加本地配置入口：用户选择 bundle manifest，而不是裸 PMX/FBX/VRM 源文件。
- server 在启动时校验 manifest、文件边界、hash、大小和 clip 唯一性。
- 资产网关仅增加运行时所需 `.glb`（必要时 `.gltf/.bin`）与 manifest；不得暴露 `.blend/.fbx/.pmx/.bvh` 离线源文件。
- 保持 token、origin、path traversal、大小限制与 16 KiB websocket 边界。
- 旧 PMX 配置返回清晰迁移错误或进入明确的 temporary legacy flag；legacy 路径不得调用 BoneRemapper。

验收：协议 round-trip/负例、网关安全、配置迁移测试通过；Live2D 测试无回归。

提交：

```text
feat(protocol): add baked GLB character bundle descriptors
```

### Phase 5 — Wallpaper 纯播放 host

任务：

- 新增 `BakedGlbModelHost`，复用当前 Renderer/Scene ownership、事务与 dispose 风格。
- 接入 `GLTFLoader`、`AnimationMixer`，实现 load、精确 clip lookup、play、stop、loop、cross-fade。
- 增加错误 UI/日志：bundle invalid、clip missing、load failed。
- 增加切换模型、快速连续 play、过期 async load、WebGL context lifecycle、资源释放测试。
- 用 guard test 证明 host 不导入旧 adapter，不读 bone names，不改 tracks。

验收：真实 PoC bundle 在 Wallpaper/浏览器 harness 可播放；无 HRS、BVH、ARDY 或骨架语义运行时依赖。此处是代码/普通浏览器预检，Wallpaper Engine CEF 仍由 Phase 8 关闭。

提交：

```text
feat(wallpaper): play baked GLB animation clips
```

### Phase 6 — 3D 动作目录、调度与模式分流

任务：

- 加载 bundle motion catalog，并把 3D motion offer/play 指向 `baked-clip`。
- 将 Live2D 的 Canonical Motion 路径与 3D baked 路径显式分流，避免格式偶然混用。
- 为目录 miss、character mismatch、clip unavailable 增加可观测错误和 baked idle fallback。
- 保留现有 scheduler 的并发/取消语义；3D 分支不发布大帧数据。
- 用 100–500 个代表动作做体积、内存、启动时延、构建耗时报告，再决定是否需要后续 animation shard ADR。

验收：Live2D 仍运行；3D 不再消费 `canonical`；网络/IPC 只传 descriptor，不传骨骼帧。

提交：

```text
feat(companion): route 3D playback through baked clip catalogs
```

### Phase 7 — 退役运行时骨架适配与 PMX/VMD 热路径

任务：

- 删除或彻底旁路 `bone-remapper.ts` 及其 alias 测试。
- 删除 3D 专用 `canonical-rig-adapter.ts`、`core-bone-names.ts`、`rig-scale.ts`、`three-js-debug-surface.ts` 及相关测试/调试入口。
- 若没有其他合法调用者，删除 `mmd-model-host.ts`、VMD 3D `motion-controller.ts` 和 `@yohawing/three-mmd-loader` runtime 依赖。
- `CanonicalMotion` 和 ARDY adapter 只保留给 Live2D/离线生成；以模块边界和测试固化。
- 更新 `scripts/verify.ps1`：禁止 runtime 重新出现 alias/remapper/retarget/骨轴猜测符号或从退役模块 import。
- 更新 architecture/migration docs，不再把 PMX runtime 当作 3D 基线。

建议 guard 不只搜索一个类名，还覆盖以下概念：

```text
STANDARD_BONE_ALIASES
CORE_BONE_CANDIDATES
remapModelBones
CanonicalMotionRigAdapter
resolveBone / guessBone / inferAxis（3D runtime 范围）
```

不要仅靠字符串 guard；还要有架构测试证明 `BakedGlbModelHost` 的依赖闭包不包含这些模块。

验收：生产 3D 路径只剩 GLB load + baked animation playback；Live2D 不回归；仓库内不存在仍可被默认进入的 remapper。

提交：

```text
refactor(3d): remove runtime bone remapping and retargeting
```

### Phase 8 — 全量验收、操作文档与交付证据

任务：

- 运行仓库现有完整 verify、test、typecheck、build、audit。
- 在目标 Wallpaper Engine CEF 环境做 model load、idle、动作切换、cross-fade、重复切换和长时运行 smoke test。
- 记录性能：启动时间、首 clip 时间、P50/P95 frame time、峰值内存、bundle bytes；与当前可比基线相比不得出现未解释的 >10% 回归。
- 完成用户文档：如何准备模型、运行离线 build、识别失败如何读取报告、如何在配置中选择 bundle、如何回滚。
- 完成开发文档：架构边界、schema、版本升级、工具锁更新流程。
- 汇总每阶段 commit SHA 与 PoC 证据。

验收：第 9 节 Definition of Done 全部满足。

提交：

```text
docs(rig-pipeline): finalize operations and acceptance evidence
```

---

## 9. Definition of Done

### 9.1 功能

- 第三方模型只在 Blender 离线阶段被识别与 retarget。
- 模型按原始格式经 Blender/锁定生态 importer 直接导入；不存在默认“全部先转 FBX”的路径。
- 每个 bundle 都保存原始格式、importer/operator/options、轴/单位和 posture report hash；未验证的输入不能发布。
- HRS 自动门禁或语义审计失败会稳定产出失败报告，且没有隐式 fallback 算法或替代 retarget 路径。
- 四个目标槽位覆盖至少三个 rig 家族，至少 3/4 在三类动作上完成自动 PoC；`Param001` 能力标签单列。
- ARDY 动作通过固定 BVH profile 进入外部工具；转换器完全不知道 target rig。
- HRS 映射方向固定为 ARDY source roles → target existing bones；bake 前后 target rig 指纹不变。
- 产物是可独立播放的 GLB + strict manifest。
- Rayure 能加载、播放、停止、循环、cross-fade baked clips。
- 3D runtime 遇到 clip miss 不猜测、不 retarget，只报错/回落到 baked idle。

### 9.2 架构

- 3D runtime 中不存在 bone alias、humanoid recognition、axis inference、rest-pose solve 或 retarget。
- `BoneRemapper`、`CanonicalMotionRigAdapter` 已删除或不可达且不再被补丁维护。
- Live2D 与 baked 3D 的数据格式边界清晰。
- Blender/HRS 不属于 Wallpaper runtime dependency。
- “VRM/Mixamo/UE5”声明有外部工具验证；Bake-in-place 不伪称物理标准骨架。

### 9.3 测试与安全

- converter golden/round-trip/invalid-input/determinism tests 通过。
- manifest/protocol strict validation 与负例通过。
- 资产网关 traversal、token、extension、size 和 origin 测试通过。
- runtime lifecycle、并发、clip lookup、cross-fade、dispose 测试通过。
- Live2D、语音、视觉、companion 现有测试无回归。
- 完整 `scripts/verify.ps1`（或仓库当前等价入口）通过。
- 私有模型、权重、纹理、`.blend` 和大产物不在 Git history/staged files 中。

### 9.4 可运维与可复现

- 工具链版本与 hash 锁定。
- 每个 bundle 有 source/tool provenance 与 deterministic hash。
- 每个失败有 schema 化报告和非零退出码。
- 从干净环境可按 README 重建 sample bundle。
- 八个阶段均有独立 commit；若 PoC 失败，则只有 Phase 0、1 和失败证据 commit，生产代码未被大改。

---

## 10. 验收检查表

执行代理在最终答复中逐项给出 ✅ / ❌ / N/A 与证据路径：

- [ ] 当前 HEAD、工作区状态与基线差异已记录
- [ ] 工具版本/API/许可/校验和已锁定
- [ ] HRS 第三方身份、能力限制及与 Kajin RigBridge 的区别已记录
- [ ] ARDY→BVH 只做格式转换
- [ ] converter 不接收 target model 或 mapping
- [ ] 各源格式直接导入；不存在无理由的统一 FBX round-trip
- [ ] importer/operator/options、轴/单位与 posture probe 证据已记录
- [ ] HRS auto gate + role→bone 语义审计通过，无手工 slot/隐式 fallback
- [ ] 映射方向为 ARDY source → target existing bones，target rig 前后指纹一致
- [ ] 四槽位/至少三 rig 家族矩阵完成，自动主路径至少 3/4 通过
- [ ] `Param001` 合成用例已执行并给出 `anonymousBoneNames` 标签
- [ ] 全新 Blender scene 可播放导出 GLB
- [ ] Three.js harness 纯播放通过
- [ ] `POC-PASS` 后才开始生产改动
- [ ] bundle manifest/protocol strict validation 完成
- [ ] 资产网关只暴露运行产物
- [ ] 3D runtime 不读/猜 bone semantics
- [ ] BoneRemapper/CanonicalRigAdapter 已旁路或删除
- [ ] Live2D 无回归
- [ ] 完整 verify 通过
- [ ] 私有资产未提交
- [ ] 每阶段独立提交并列出 SHA

---

## 11. 执行中遇到歧义时的决策顺序

1. 先问：这一步是不是在识别骨骼、猜名称/轴/层级、修 rest pose 或把动作从一个 rig 映射到另一个 rig？
2. 若是，只能由已锁定外部工具完成。
3. 若外部工具没有公开、已验证的能力，返回失败；不能因为“代码不多”就自行实现。
4. 若只是序列化、固定坐标基/单位变换、hash、manifest、资产服务或精确 clip 播放，可在 Rayure/tooling 中实现。
5. 若不确定是格式转换还是 retarget，按 retarget 处理并停止，先写 ADR 让用户确认。

---

## 12. 最终交付答复模板

执行代理完成或停止时，最终答复必须包含：

1. **结论**：`POC-PASS`、`POC-FAIL` 或完整生产迁移完成。
2. **外部工具结论**：HRS 对每个目标模型的自动识别、姿态、覆盖率和语义映射结果。
3. **变更摘要**：按离线工具、协议/server、runtime、退役代码分组。
4. **验证证据**：实际运行的命令、测试结果、PoC report、bundle manifest、性能报告。
5. **约束审计**：明确说明没有自研 retarget、alias、骨轴推断或 HRS/外部工具修改。
6. **提交表**：Phase、commit SHA、commit subject、验证结果。
7. **失败时**：精确错误码、外部工具诊断、已停止在哪个 gate、确认未触碰哪些生产区域。

不得用“基本完成”“应该能跑”代替证据，也不得在 PoC 失败后提交一半生产重构。
