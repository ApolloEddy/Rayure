# 更新日志

本项目的所有重要变更都会记录在此文件中。

## [Unreleased] - 2026-08-26

### 离线骨架标准化与烘焙动作管线（用户增补：双原生映射与 MMD 贴图）

- 保留两条插件原生映射路线并按门禁择一：优先 MMD Tools 原始日文骨名 → Rig Bridge `MMD FK`；仅在该路线失败时尝试 MMD Tools `INTERNAL` → HRS 通用/Auto-Rig Pro 原生能力；不拼接结果、不新增 Rayure 字典或 alias；
- 在 Citrali PMX 上验证 Route A 核心 15/15、rest-pose gate 通过，并完成 100 帧 ARDY BVH → 目标模型原骨架 bake；Route B 的 HRS 通用识别为 13/15，保留为 fallback 证据但未选用；
- 使用 MMD Tools 自带 `convert_materials(use_principled=True, clean_nodes=True)` 迁移材质后，动作 GLB clean-import 验证到 7 张嵌入图片、24/24 材质 Base Color 与 Alpha 纹理连接和 1 个动画 armature；MMD toon/sphere 专有渲染语义不承诺逐项等价；详见 `tools/rig-pipeline/reports/citrali-mmd-native-route.md`。

### 离线骨架标准化与烘焙动作管线（Phase 2 — HRS-only PoC，`POC-FAIL`）

- 新增 `tools/rig-pipeline/blender/rig_bridge_driver.py`：以 Blender headless 为边界，按原始格式直接导入目标模型，执行严格世界姿态门、HRS `auto_guess` → 角色语义审计 → `execute_retarget`/bake、目标 rig 指纹检查、GLB 导出和无 addon clean import；driver 不包含 alias、猜骨、手工 slot 或第二套 retarget 算法；
- 修复 Blender glTF `ACTIONS` 导出会把目标 FBX 自带 Action 一并写入产物的问题：导出窗口只保留本次 `rayure__...` baked Action，clean import 回归确认每个通过样本只有目标 clip；
- 完成 4 槽位 × 3 类动作的 HRS-only 预检：VRM reference 与一个 FBX container 各 3/3 通过，MMD/复杂变形 rig 因 12/15 核心角色 off-by-one 失败，Rigify/custom `.blend` 因 HRS 自动执行门失败；两个通过样本实际均为 `VRM/VRoid` target profile，故未满足至少 3 个 rig 家族与 3/4 门禁；
- 新增脱敏证据 `tools/rig-pipeline/reports/phase2-poc-evidence.md`；Phase 2 停在证据门，未修改生产 runtime、协议或 `apps/`/`packages/`，未进入 Phase 3；Auto-Rig Pro 不在本项目路径中使用。
- 记录 Auto-Rig Pro 3.78.32 + Quick Rig 1.27.21 试用：复用现有 Blender 4.2.23 在隔离 profile 注册成功，并以显式映射在派蒙 16 骨核心夹具上生成 227 骨 ARP rig；其对完整 MMD 骨架的 fuzzy 映射仅 1/16 正确，故 ARP 暂列离线候选，不替换 HRS、不改生产 runtime；详见 `tools/rig-pipeline/reports/auto-rig-pro-trial.md`。

### 离线骨架标准化与烘焙动作管线（Phase 0 — 基线/工具链/审计）

- 新增 `docs/Rayure_RigBridge_BVH_BakedMotion_Development_Spec.md` 驱动的离线管线开发入口：把 3D 动作架构从「运行时识别骨架 + 适配动作」迁移为「Blender 离线识别 + 第三方工具（Rig Bridge / Humanoid Remap Studio）retarget + 烘焙后运行时纯播放」，分 Phase 0–8 推进，POC-PASS 门禁前不改生产代码 / `apps/` / `packages/`；
- 新增 `tools/rig-pipeline/` 工作区：`toolchain.lock.json`（Blender 4.2.23 LTS + Rig Bridge 0.1.66 + ARDY 本地 checkout 的版本/校验和/公开 API 全量锁定）、`schemas/core-skeleton-27.v1.json`（ARDY 官方 CoreSkeleton27 → BVH profile 草案）、四份 Phase 0 报告（toolchain / ardy-profile / baseline / poc-matrix）；
- 锁定 Blender 4.2.23 LTS 便携发行（SHA256 82e79147…，headless `--background` 可运行）与 Rig Bridge 0.1.66（SHA256 5f0b9c06…，`bpy.ops.hrs.auto_guess` / `execute_retarget` + 8 个场景门控字段 headless 启用验证通过）；`github.com` 源不可达，全部工具走 `download.blender.org` / `extensions.blender.org`；
- 记录便携 Blender headless 三个必需环境变量（`BLENDER_USER_CONFIG/SCRIPTS/EXTENSIONS`）与扩展目录坑：4.2 的 User Default repo 是 `extensions/user_default/`（下划线），`user/default/` 不会被扫描；
- 基线审计确认 spec §1.2 的 8 条运行时适配声明全部成立（`bone-remapper.ts` 自研 alias、`canonical-rig-adapter.ts` world→parent-local 硬适配、`core-bone-names.ts` 候选名表、`MotionController` VMD 专用播放器、网关扩展名白名单无 glb 等），并登记禁改符号清单（`STANDARD_BONE_ALIASES` / `CORE_BONE_CANDIDATES` / `remapModelBones` / `CanonicalMotionRigAdapter` / `resolveBone`）；
- 记录基线漂移：spec 基线 `94db6e2` → 当前 HEAD `8251c4b` 仅两个恢复性审计修复提交（`a48f2ac`、`8251c4b`），当前 HEAD 上重验后 8 条声明不变。

### 离线骨架标准化与烘焙动作管线（Phase 1 — ARDY→BVH 严格转换器 + schema + round-trip）

- 新增 `tools/rig-pipeline/ardy_to_bvh.py`（v1.0.0）：严格 ARDY CoreSkeleton27→BVH 格式桥。Hips 为唯一平移通道，其余 26 关节仅旋转；Euler 通道固定 `Zrotation Yrotation Xrotation`（scipy `as_euler('ZYX')` 反解 + ±360 unwrap）；确定性输出（相同 input bytes + profile + 工具版本 → 相同 BVH 字节）；拒绝 `--target-model/--bone-map/--guess-axis/--scale-to-character/--fix-feet`（CLI 级 exit 4）；失败路径非零退出 + `rayure.rig-pipeline-failure.v1` 报告 + 不产出部分 BVH；
- 新增 `schemas/pipeline-failure.v1.schema.json`：14 个稳定失败码（INPUT_INVALID / ARDY_REFERENCE_SKELETON_MISSING / IMPORT_FAILED / RIG_BRIDGE_NOT_INSTALLED / RIG_BRIDGE_API_MISMATCH / RIG_DETECTION_FAILED / REST_POSE_REJECTED / SOURCE_MAPPING_FAILED / RETARGET_FAILED / BAKE_VALIDATION_FAILED / EXPORT_FAILED / TOOL_CAPABILITY_MISMATCH / RUNTIME_LOAD_FAILED / BAKED_CLIP_NOT_FOUND），stage/input/toolchain/externalToolStatus 结构齐备；
- `core-skeleton-27.v1.json` 草案升级为全精度：27 个 `restOffsetMeters` 全部内联（源自 `joints.p`，经 `bind_rig_transform` 父相对差交叉验证，25/27 精确一致、Thumb 两关节差 19mm——故只用 joints.p），endSites 修正为 7 叶（含 Head）；
- 新增 `tests/test_ardy_to_bvh.py` + `tests/test_failure_schema.py`：31 个 unittest 全绿（工具链 venv 无 pytest/jsonschema，改用手写极简 validator）。覆盖确定性 hash、golden 字节匹配、非法 shape/缺字段/批量>1/0 帧/NaN/Inf/错 fps/超大输入（monkeypatch 上限）/截断文件/profile 缺失/CLI exit/禁止符号/14-code 枚举/失败报告 conform；
- 新增 golden fixtures：`golden_rest.npz`（sha256 `ba95faa4…`）/ `golden_rest.bvh`（sha256 `b9a737bb…`）/ `conversion.json`，构造器 `fixtures/build_fixtures.py` 确定性可重放；
- 新增 `verify/`：`blender_bvh_dump.py`（headless Blender 原生 `io_anim_bvh` importer 导入并 dump rest/pose 矩阵）+ `roundtrip_verify.py`（ARDY FK 参考比对）。round-trip **PASS**：最大旋转误差 0.0319°（容差 0.25°）、最大平移误差 1.04µm（容差 1mm）、根平移 0.01µm、scene fps=20、帧契约 BVH 帧 k→Blender 帧 k+1（importer 跳过内部 anim_data placeholder）；
- `toolchain.lock.json` 新增 `converter` 块（工具链 python 3.11.9 / numpy 1.26.4 / scipy 1.17.1）；报告新增 `phase1-verification.md` 与 `phase1-ardy-rest-offsets.md`；
- 记录 Euler 契约三方一致端到端确认：文件通道 `Z Y X` → importer `Euler((X,Y,Z),'XYZ')`=Rz@Ry@Rx == scipy 内置 'ZYX' == ARDY `load_bvh_animation` 重建。

### 恢复性审计与修复

#### 修复

- 修复恢复性审计把 `?3dDebug=1` 错误限制为 `import.meta.env.DEV`、导致 `vite preview`/构建调试页只剩巨大环境占位体而没有模型的问题；显式调试查询现在在构建页恢复独立懒加载，4174 preview 同样通过窄白名单路由读取本机 CoreSkin 夹具；
- 修复首次标定没有 `calibrationUrl`、实际上无法保存的问题：Companion 现在为已配置本地状态路径的 Live2D 模型始终发布固定的 tokenized 校准端点，文件不存在时 GET 返回 404，POST 成功后立即可读；
- 修复标定向导忽略 POST 状态却提前关闭并写入浏览器“已保存”标记的问题：只有 Companion 返回成功才关闭向导并重新加载模型，HTTP/网络失败会留在当前步骤显示错误，连击由保存状态隔离；
- 修复手工选择参数后把模型真实范围丢弃、统一写成 `-30..30 / neutral=0` 的问题；映射现在保留模型给出的 min/max/default，并拒绝非有限、倒置、重复或越界范围；
- 修复标定向导“场景部件”步骤没有进入协议、因而无法持久化的问题；`skinHiddenPartIds` 现在支持包括空列表在内的严格往返，并优先于自动识别/本地配置；
- 修复向导重绘后“收起”按钮仍引用旧 DOM、任何步骤切换后失效的问题，并加入“稍后”退出与会话级抑制，退出/保存都会重新创建干净的模型表面；
- 修复动作尾部回中混合只到 `10/11`、仍残留姿势的问题；最终帧现在精确到达相对中性姿势，同时保留动作结束时的根位置；
- 修复分片语义缓存把包含 `:` 或超长前缀的合法 wire cache key 直接用于 Windows 文件名的问题；不安全前缀统一进入 `misc` 分片。

#### 架构边界

- 校准数据从模型目录迁移到每用户 Rayure 状态目录（Windows 默认 `%LOCALAPPDATA%\Rayure\calibrations`）；模型旁旧 `rayure.calibration.json` 仅兼容读取，新保存不再修改私有/购买模型目录；写入采用同目录临时文件原子替换；
- ARDY 3D/CoreSkin/PMX 调试表面改为显式 `?3dDebug=1` 才加载的独立分块，不再静态进入普通 Wallpaper 入口；Vite `/@fs/` 不再开放整个 `scratch`，dev/preview 调试资产只允许固定单文件路由与 `.json`/`.pmx` 白名单；
- `scripts/verify.ps1` 新增 3D 调试代码必须保留在独立懒加载分块、不得进入普通入口的双向产物门禁。

#### 验证

- `scripts/verify.ps1 -SkipInstall` 通过：Protocol 26、Companion 148、Wallpaper 92，共 266 项测试全绿；TypeScript 检查、Python Bridge 编译、Wallpaper 生产构建、生产依赖审计和私有资源门禁均通过；
- 普通生产入口约 115.6 kB，冻结的 MMD 主机和显式 3D 调试表面保持独立懒加载分块；入口 JS 不包含 ARDY 3D/CoreSkin 调试故障文案；
- 本轮未运行真实私有 Live2D 模型或 Wallpaper Engine CEF，因此向导画面、可见步态、DevTools、暂停/恢复和页面重载仍是独立验收项。

### 未关闭的运行验收

- 原生 Cubism 模型加载、原生动作/表达式分流、Canonical Motion 播放和四步手工校准链路已经接线；自动化只覆盖合同与失败边界，不等于模型画面验收；
- 当前岛风 model3 的既有审计记录为 545 个参数，腿脚和部分手臂使用 `Param7/8/9/10/11/12/14/15/16/17/19/79/80/86/286` 等非标准 ID。代码已有显式 Shimakaze RigProfile 和保留模型真实范围的手工向导，但尚未从 DisplayInfo 自动理解任意新模型的参数语义；
- `walk.forward` 可以由 Companion 生成并发布，浏览器面板也能收到 `completed`，但本次停止前没有通过画面验收确认腿脚形成可见步态；根位移只是 2D 预览投影，不能替代模型参数映射；
- 下一次继续时应先用真实模型完成向导首次保存/失败恢复和可见动作复核，再在 Wallpaper Engine CEF 中验证画面、DevTools、暂停/恢复与重载；通用 DisplayInfo 语义导入仍是后续能力，不冒充本轮完成项；
- 私有模型、动作、临时 JSON 和调试截图继续留在工作区/忽略路径，未纳入 Git、`public/`、`dist/` 或发布包。

### 新增

- 新增外部忽略的 Live2D 岛风（Azur Lane `daofeng_5`）本地测试夹具登记：固定源仓库 commit、22 个被引用资源、Rayure 适配入口和技术评估均保存在 `scratch/live2d-samples/Shimakaze/`，不进入 Git、构建产物或发布资产；
- 新增 Companion 内部 `BehaviorOrchestrator` 与 `rayure.behavior-event.v1` / `rayure.behavior-plan.v1` 基础类型，统一视觉、语音和直接指令的优先级、过期、去重、抢占取消与 generation 隔离；
- 新增 `rayure.vision-observation.v1` 派生观察合同与 `VisionEventDetector`：在 Companion 内以迟滞、连续帧和冷却窗口识别 presence、头部方向、举手和挥手，不接收原始摄像头帧；
- 新增 `VisionProcessClient` 与 `scripts/mediapipe-vision-bridge.py`：Bridge 使用 `shell:false`、16 KiB 行上限、受限诊断和失败关闭；Python 侧提供无依赖 `--simulate` 回归模式，并以 MediaPipe LIVE_STREAM 读取包外模型和摄像头后只输出派生观察；
- 新增视觉运行时配置、`VisionBehaviorPolicy` 与 `VisionRuntime`：将受 allowlist 约束的视觉事件接入 BehaviorOrchestrator 和 MotionGenerationController，支持独立模拟 Bridge 启动/关闭与模型、摄像头、帧率参数校验；
- 新增 `rayure.speech` 传输合同：ASR 最终转录、Agent 结构化计划、token 化 `speech.published` 音频/口型曲线和 Renderer `speech.playback` 回执均严格校验，原始音频不进入 websocket；
- 新增 Companion `SpeechRuntime`：把 ASR → Agent → BehaviorOrchestrator → MotionGenerationController 与 TTS 发布串成可取消、可抢占、可替换的运行时链路；提供 loopback/HTTPS Agent 适配器、包外 ASR/TTS JSONL 进程适配器和无依赖 fixture；
- 新增 Wallpaper `SpeechPlayer` 与 Live2D speech mouth channel：按 token 化口型曲线驱动音频、`ParamMouthOpenY` 类参数并上报有界播放进度；
- 新增 `scripts/speech-bridge.py`、`scripts/tts-bridge.py` 的无依赖模拟模式，供 CI 和切换本地小模型时复用同一 JSONL 边界；
- 新增 `LiveTalker` HTTP 兼容适配器：将 `/api/chat` 的回复转换为 Rayure `BehaviorPlan`，将 `/api/synthesize` 的 PCM16 WAV 转换为带 RMS 口型曲线的 `TtsSynthesis`，并保持回环地址、超时和响应大小校验；
- 新增 `speech.liveTalker` 本地配置与 Companion 接线：配置后由 LiveTalker 提供 Agent/TTS，仍可独立配置 ASR JSONL Bridge；LiveTalker 与旧的 Agent/TTS provider 配置互斥，避免运行时选路歧义；
- 新增 `scripts/livetalker-asr-bridge.py`：复用包外 LiveTalker 的 SenseVoice 与麦克风/VAD，只把最终 `rayure.asr-transcript.v1` 输出给 Companion，并提供无依赖 `--simulate` 模式；
- 新增 Renderer → Companion 的 `motion.playback` 协议回执：仅当前已发布的动作描述符可上报有界、单调的 source-frame 进度；
- 新增 Bridge 续写令牌合同和 `SceneEntityRegistry`：场景实体坐标经显式原点/比例变换后，可作为 `Hips`、双手、双脚的 ARDY 运动学目标，而语义 cache key 保持不变；
- Bridge 结果现在携带不透明 continuation id；真实 ARDY Core 已验证带右手约束的 8 帧生成及使用同一语义特征的连续续写；
- 新增生成动作根位移的 2D 画布投影、Live2D `ParamLeg` 步态映射，以及 20 fps Canonical Motion 的帧间 lerp/slerp；
- 新增 `MotionIdlePool` 与 `motionSemantic.idlePool` 配置：按 round-robin 选择待机动作，在 lookahead 窗口预取下一段，并在 handoff 窗口提交；直接语音/视觉动作会取消过期预取；
- 新增 `MotionScheduler.prefetch()` / `commitPrefetch()` / `discardPrefetch()`：预取段不覆盖当前播放 buffer，发布失败时恢复已确认的当前段；晚加入的 Wallpaper 客户端会收到最近一次 `motion.published`；
- 新增 Renderer `parameter-crossfade` 工具及测试：生成 Canonical Motion 交接从当前真实参数姿态平滑过渡，默认 180 ms；
- 新增 Live2D skin-only 入口：Companion 为模型生成不含 `Motions` 的默认入口，并保留仅在显式导入时使用的原生入口；原生动作文件不会在默认加载阶段被渲染器批量拉取；
- 新增 Live2D 原生 `Expressions` 接入：skin-only 入口保留表达式资源并启用 Cubism expression manager，支持文件名/路径及中英日语义别名解析；`expression.set/reset` 与带表达式的 `emote.play` 会分流到原生表面，未知表情安全降级；协议的零权重表示重置，正权重触发原生 exp3，具体权重与过渡时序由模型自带 Cubism fade 控制；
- 新增 Live2D `skinHiddenPartIds` 配置与 `cdi3.json` 场景部件保守识别：可隐藏背景、镜子、地板、粒子等 drawable/part，同时把模型本体保留为 Rayure 的伴侣皮套；
- 新增 Wallpaper Engine 属性：默认隐藏品牌和连接状态，可在属性面板导入模型自带动作/场景层；
- 新增浏览器 Live2D 预览交互：回环开发页与 Wallpaper Engine 默认均为 skin-only；显式 `?live2dNativeContent=1` 后，点击角色头部/身体可按模型动作组触发 `touch_head`/`touch_body`，`?live2dDebug=1` 提供背景、原生动作、场景层、表情和动作目录控制；
- 新增仅在 `?live2dDebug=1` 显示的 ARDY 生成控制：支持输入动作描述、挥手/走路缓存预设、通过回环 WebSocket 请求 `MotionGenerationController`，并展示接受、失败、发布和播放状态；

### 变更

- Live2D 调试页在原生 Cubism 模型与参数探针并行运行时，以原生模型快照为准，避免测试夹具每帧覆盖“模型已加载”和当前原生动作状态；
- `MotionScheduler` 生产路径不再自行伪造时钟：下一段只使用 Renderer 已确认的前缀；抢占会取消生成器实际收到的 signal，发布回调失败会回滚未观察 buffer；
- `MotionScheduler` 现在把预测生成和交接提交分离；待机池只在剩余时间进入 lookahead/handoff 窗口后生成/发布，避免预取结果提前打断当前动作；
- Live2D 的 native motion、generated Canonical Motion 和 debug fixture 改为互斥参数写入者。生成开始从当前参数 180 ms 混合，结束/取消后优先恢复原生 Idle；一次性 Idle 结束时会经防抖保护重新进入默认待机；
- Bridge 使用 ARDY 官方 `Root2DConstraintSet` / `EndEffectorConstraintSet` 生成 `observed_motion` 与 `motion_mask`，并为 EndEffector 条件补齐必需的 `Hips` 行；
- 冻结的 PMX/MMD 主机按需加载；`three-mmd-loader` 的 Node-only 可选分支改为显式浏览器诊断 stub，生产构建不再出现 browser-external 告警，最大 JS 分块降至 380 kB；
- Live2D 原生动作不再自动播放；默认模型入口只负责皮套、参数、物理和 Rayure 自己的交互，勾选原生内容后才以新入口重新加载动作与模型场景部件；
- Wallpaper Engine 的用户设置继续由 `project.json` 属性承载；旧的桌面动作/表情调试栏及 `debugui` 属性已移除，显式查询参数只保留给开发预检，桌面默认不再嵌入 Rayure 品牌、连接状态和调试按钮；
- 清理未被当前运行链路引用的 Hiyori 样例、旧 `live2d-renderer` 调试包和归档压缩包，并将其移入被忽略的 `scratch/_retired-live2d/` 隔离目录；当前本机验收资源统一使用岛风；
- 将实际运行的 `Live2dNativeDebugSurface` 重命名为 `Live2dNativeSurface`，并把诊断面板、Canvas 类名和快照类型从生产“调试表面”命名中剥离；显式 `live2dDebug` 查询和参数探针仍保持开发专用边界；
- Live2D 可选房间背景改为保持方形贴图比例的裁切平面，移除会产生底部白块的独立地板，并在默认 Live2D 皮套视图中隐藏环境层；

### 修复

- 修复 idle 时原生动作、debug fixture 与生成动作同时写 Live2D 参数造成的抖动；
- 修复 ARDY continuation 错误取“全局最近状态”及 Canonical Motion 不可逆地重建内部 tensor 的问题；
- 修复约束 index tensor 的 CPU/CUDA 设备错配、EndEffector 缺少 Hips 条件导致的断言失败，以及多行 Bridge 错误无法通过 JSONL 合同的问题；
- 修复 Vite 将 `node:fs/promises` 与 `node:url` 外置到浏览器 bundle 的构建告警。
- 修复 `speech.liveTalker.motionByKeyword` 对非字符串动作意图的校验漏洞，避免数字等可强制转换值绕过配置边界。
- 修复模型自带背景与角色同属一个 Live2D MOC 时无法仅导入皮套的问题：默认按 part opacity 隐藏已识别/配置的源场景层，显式导入后恢复；
- 修复 Live2D 调试页只列出 `motion.catalog` 原生动作、且在模型加载期间丢弃 `motion.published` ARDY 动作的问题：现在显示最近一次 Canonical Motion，并在画布就绪后排队播放；

### 验证

- 已用本地 Chromium 实际加载岛风模型：Wallpaper Engine skin-only 属性路径只保留角色并隐藏源场景层，网络记录无 `.motion3.json` 请求；开发预览路径可恢复原生动作目录，`touch_head` 原生动作可见，控制台无错误；
- 已用本地 Edge/Chromium 预检验证：普通回环预览角色可见、无拉伸房间背景，鼠标点击头部/身体分别触发 `touch_head`/`touch_body`；`?live2dDebug=1` 面板显示 17 个原生动作，当前模型无 `Expressions` 时表情按钮安全禁用；
- 已用本地 Edge 实际验证 `?live2dDebug=1`：ARDY 的 `walk.forward-2` 先显示为 queued，Live2D 就绪后完成播放，面板提供最近动作重播且控制台无错误；
- 已用本地 Edge 在调试页点击“填入挥手”→“让 ARDY 生成”：请求 `wave.casual` 被 Companion 接受，`wave.casual-5` 进入播放并完成，参数快照发生变化；
- 相关协议、Companion、Wallpaper 测试与 TypeScript 检查通过；完整 `verify.ps1`、生产构建、依赖审计和发布边界检查仍作为最终交付门禁；
- 发布边界仍保持：私有模型、动作、场景、缓存和本地配置不会进入 Git 或 Wallpaper `dist`。Wallpaper Engine CEF 的新生成播放视觉/DevTools 门禁仍单独保留。

## [0.6.0-dev] - 2026-08-23

### 新增

- 新增 `motion.published` 协议消息，只携带令牌化回环 URL 的 Canonical Motion 描述符，大帧数据不进入 16 KiB Companion WebSocket；
- 新增 `format: canonical` 的 `MotionDescriptor`，用于标识运行时生成的 `rayure.motion.v1` 动作资源；
- Companion `createCompanionServer` 新增 `publishMotion()`：校验 Canonical Motion 合同、序列化为内存资源、生成令牌化 `/assets/<token>/<motionId>.json` URL，并向已连接客户端广播 `motion.published`；
- Wallpaper 新建 `canonical-motion-client.ts`：`loadCanonicalMotion` 只接受回环令牌化 URL 并校验完整动作合同，`CanonicalMotionPlayer` 以同步打断语义将生成动作驱动到参数 sink（generation 隔离、迟到结果释放）；
- `Live2dNativeDebugSurface` 新增生成动作槽位，运行时动作优先于固定 debug idle fixture 播放，快照暴露 `activeGeneratedMotionId`；
- Wallpaper `CompanionClient` 新增 `onMotionPublished` 回调，`main.ts` 收到 canonical 动作后经令牌化 URL 拉取、校验并交给原生画布播放；
- Companion `rayure.local.json` 新增 `motionSemantic.startupGenerate` 预设（id/prompt/numFrames/numDenoisingSteps/cfgWeight），启动时经 `MotionGenerationService → publishMotion` 逐个发布，打通“生成 → 发布 → 播放”链路；
- `createMotionSemanticRuntime` 新增 `createGenerationService()`，把缓存优先解析器与 ARDY 后端组合成生成服务；
- 新增 Wallpaper `canonical-motion-client.test.ts`（加载校验、打断、非法输入）与 Companion `motion-generation-publish.test.ts`（真实子进程 fake bridge 的 generate → publish → 令牌化 URL fetch 端到端）；
- 新增 renderer 无关的 `MotionScheduler`（Companion）：持有剪辑 Buffer、按真实时间推进并派发帧、以 segmentId 抢占式打断在途生成、并给下一意图续写已消费的历史动作，把离散意图变成连续可打断轨迹；
- 新增 `MotionGenerationController`（Companion）：把 Scheduler 与发布副作用组合成运行时入口——`submitIntent()` 供未来的 ASR/LLM 行为层在运行中实时提交动作意图，`runStartup()` 让启动预设与实时意图共享同一套打断/发布语义，并通过注入的发布回调保持可单测；
- `rayure.local.json` 的 `startupGenerate` 预设现在经由 `MotionScheduler` 逐个发布，首个片段完成后即可提供后续续写能力；未配置 ARDY 后端时不实例化生成控制器；
- 新增 `motion-scheduler.test.ts`（首段、帧推进、抢占打断、迟到结果丢弃、历史续写截断、onSegmentReady）与 `motion-generation-controller.test.ts`（实时生成转发布、启动预设、抢占、isGenerating）。

### 变更

- `motion.published` 与 `format: canonical` 保持与既有一致的安全边界：URL 必须命中回环令牌化端点，动作体必须通过严格 schema 校验。

### 修复

- Wallpaper 生成动作拉取改用 generation 隔离：`motion.published` 的迟到 fetch 结果不再覆盖已开始播放的更新动作；
- `MotionScheduler` 抢占由「segmentId 静默丢弃」改为「取消式抢占」：新意图会通过 AbortSignal 真正取消在途生成，并把 request 串行化为单飞后端顺序执行，避免与单请求的 ARDY 服务冲突；
- `startupGenerate` 逐项续写：上一个完成片段经 `skipToEnd` 作为 history 传给下一意图（此前 history 恒为空）；
- 生成失败降级而非崩溃：单个 startup 预设失败经 `onError` 记录并继续后续预置，不再使整个 Companion 退出；
- `generatedTokenMap` 加入 64 条上限并按 FIFO 淘汰，避免长跑内存无上限增长；
- 移除 `MotionScheduler` 中失效的字段，`superseded` 状态现在真实上报；
- 补充调度器/控制器测试：真实 signal 抢占、history 续写传参、失败降级继续。

## [0.5.2-dev] - 2026-08-20

### 新增

- 新增 `Motion Semantic Feature v1` 协议合同，固定 ARDY 文本条件的缓存键、规范化 Prompt、编码器版本、4096 维 token 特征、有效 token mask 与生成时间，并覆盖不兼容维度、形状、元数据和非有限值拒绝测试；
- 新增 Companion 缓存优先的 `CachedMotionSemanticFeatureResolver`：命中本地特征时不调用编码器，未命中时传递可取消信号给 Text Encoder，并仅在返回特征的缓存键与规范化 Prompt 完全匹配后写回缓存；
- 新增版本化的 `rayure.motion-semantic-cache.v1` 文件读写器，使用 Base64 二进制块保存 FP16/FP32 特征并按位保存 token mask，写入采用临时文件替换，损坏 JSON、重复键、未知字段和错误字节长度均拒绝；
- 新增统一 `TextEncoderApiClient`，以 `rayure.text-encoder-request.v1/response.v1` 交换缓存键、Prompt 和紧凑特征块，支持超时/取消，并只接受 HTTPS 或回环 HTTP 端点；
- 新增 ARDY CoreSkeleton27 适配器，严格要求官方 27 关节顺序，将 `Head`、`LeftForeArm`、`RightHand` 等输出映射到 Live2D RigProfile 可消费的 Canonical Motion 名称，并校验帧顺序、四元数、脚接触和缺失关节；
- 新增 Companion Motion Semantic Runtime：启动时加载包外预置缓存，API miss 成功后以原子替换写回同一缓存文件；无 Text Encoder 配置时保持明确的 cache-only 模式；
- 新增 ARDY JSONL 进程协议：生成请求携带缓存特征、历史动作和 27 关节运动学约束，结果必须回传同一 requestId 后才进入 CoreSkeleton27 转换器，取消和结构化错误均有独立消息形态；
- 新增 `ArdyProcessClient`：以 `shell:false` 启动包外 Bridge，串行发送 JSONL 请求，限制命令/参数、捕获有限 stderr 诊断，支持超时、取消、关闭和迟到结果隔离；
- Companion 启动配置现在可声明包外 ARDY Bridge 的命令、参数、工作目录和超时；运行时创建/关闭该进程，并在 `companion.ready` 中只报告缓存条数与能力是否配置，不暴露模型路径或凭据；
- 新增 `MotionGenerationService`，在 Companion 内将规范化 Prompt 解析为缓存/外部编码特征，再串行交给 ARDY Bridge，并校验返回的 requestId 与 Canonical Motion；缓存缺失且未配置 Text Encoder 时会明确失败，取消信号会透传到 Bridge；
- 选定 Live2D 官方 Cubism Web Samples 的 Hiyori 作为本机调试模型，并放入 Git 忽略的 `scratch/live2d-samples/Hiyori/`；审计结果为 17 个资源、70 个参数、标准 RigProfile 全部匹配；
- 新增 `Live2dModelManifest` 校验器，拒绝模型资源绝对路径、目录穿越、重复资源和非法动作淡入淡出时间，并提供 MOC3 头校验和标准参数扫描；
- 新增 `scripts/audit-live2d-model.ps1`，生成仅位于 `scratch/` 的模型审计报告；
- 新增 `Live2dNativeDebugSurface`，通过显式 `live2dModelUrl` 查询参数加载真实 Cubism 模型，并将 Canonical Motion fixture 驱动到真实参数 sink；引入 `live2d-renderer@0.6.6` 作为开发适配层。
- 共享 `model.available` 协议新增 `live2d` 模型格式，继续复用令牌化回环 URL 和严格字段校验。
- Companion 本地配置现在接受绝对 `.model3.json` 入口，并在同一令牌根内提供 Live2D 的 JSON、MOC3、纹理和动作资源；磁盘路径与未允许扩展名仍不会进入协议或 HTTP 响应。
- Live2D 动作描述符现在携带 `group`/`index`，Companion 会从 `.model3.json` 的 `FileReferences.Motions` 自动生成动作目录，并继续通过同一令牌根发放 `.motion3.json` URL。
- Wallpaper 收到 `format: live2d` 的 `model.available` 后，会先校验 model3 清单，再创建原生 Cubism 画布；PMX 仍走原有 3D 主机，二者不会互相覆盖。
- 新增原生 Live2D 动作控制器：默认播放 Idle、显式停止、动作替换/打断和迟到异步结果隔离；调试栏会根据 Companion 目录动态生成原生动作按钮。
- 新增 Cubism Core 来源解析器：默认继续使用官方固定地址，可显式使用同源调试文件或回环 `.js` 地址；任意远程主机、危险协议、查询串和非脚本扩展名均拒绝。
- 原生调试表面现在会在创建 `live2d-renderer` 前显式加载已验证的 Cubism Core，并按 URL 复用加载 Promise，避免底层初始化吞掉脚本失败。

### 变更

- Vite 开发服务器只额外允许读取 `scratch/`，原生调试画布不改变默认 3D 回归页面或发布目录；
- README、Hiyori 调试文档和 M2 验收单补充模型审计、Core 来源、在线/离线失败边界及 CEF 未关闭项。
- `scripts/verify.ps1` 增加 `.model3.json`、`.moc3`、`.motion3.json` 和 Cubism Core 文件名的构建产物拦截。
- Wallpaper Engine 2.8.42 CEF 已完成一轮真实运行复核：本地 `dist` bundle 执行、Companion 重连，以及 Hiyori 的 model3/MOC3/物理/姿态/用户数据、10 个动作和两张纹理请求均有回环资源证据；原生画布视觉、DevTools、暂停恢复和离线 Core 仍明确保持未关闭。

### 修复

- 对原生调试 URL 增加空值、长度、路径类型和回环地址校验，避免调试入口接收任意远程模型；
- 原生模型加载失败时显示明确诊断并释放画布、动作播放器和模型实例，不把失败状态冒充为已加载。
- 原生动作播放只接受当前 Live2D 目录中的 `group/index`，停止和替换会使旧 generation 失效；VMD 目录仍只进入冻结的 3D 主机。
- 修正不同 Live2D 动作组规范化后可能产生重复动作 ID 的边界情况，冲突时追加确定性后缀且保持 64 字符上限。
- 原生调试画布仅在 Cubism 模型完成异步加载后执行尺寸同步，避免布局观察器抢跑触发底层空模型错误。
- 浏览器版 `path` shim 保留远程 Companion URL 的协议分隔符，避免 Live2D 资源请求错误回落到 Wallpaper 自身；Cubism 未完成初始化时释放也不再产生未处理异常。
- Cubism Core 脚本加载失败现在会沿原生表面错误路径返回，并清理画布、模型和动作资源；调试栏不会把 Core 失败误报为模型已就绪。
- Companion 驱动的失败状态会保留原生表面诊断（包括 Core 来源），避免最终状态标题覆盖实际错误原因。

### 架构影响

- 文本特征合同明确属于运行时数据而非 16 KiB Companion WebSocket 消息；后续可由包外 Text Encoder API 生成并写入本地缓存，正式运行不需要常驻 LLaMA/LLM2Vec；
- Companion 的特征解析状态现在闭合为“cache hit → 直接返回 / cache miss → 外部编码 → 身份校验 → 内存缓存”，尚未引入磁盘写入或 ARDY 进程，避免把实验模型耦合进壁纸生命周期；
- 预置特征现在有独立的包外文件边界；文件数据不会进入 Companion WebSocket 或 Wallpaper `dist`，后续 Text Encoder fallback 可在完成路径配置后增量写回该缓存；
- 外部编码器只作为低频 fallback，API 凭据不进入请求合同或代码；远程明文 HTTP、URL 凭据、查询串和跨身份响应均在客户端边界拒绝；
- ARDY 适配目前只接收规范化动作帧并输出 `rayure.motion.v1`，不启动 Python、下载 checkpoint 或把 ARDY/角色资产写入仓库；
- `rayure.local.json` 现在可声明包外 `motionSemantic.cachePath` 与可选 Text Encoder endpoint；配置只保存路径/端点/超时，不保存 API Key，也不把特征数据放进 Wallpaper 构建产物；
- ARDY 进程协议仍是纯合同，尚未启动外部命令或下载权重；它把模型生命周期留在 Companion 侧，Renderer 只会接收经过验证的 Canonical Motion；
- ARDY 进程客户端的取消路径会终止当前 Bridge，避免旧生成结果进入下一次动作替换；实际 Bridge/权重仍保持仓库外，当前夹具使用临时 Node 子进程替代；
- ARDY Bridge 生命周期已经纳入 Companion 的失败清理和 SIGINT/SIGTERM 关闭路径；当前仍未把生成动作自动广播到 Wallpaper，下一小步是接入动作意图/回执通道；
- `MotionGenerationService` 已闭合 Companion 内部的“Prompt → text_feat → ARDY → Canonical Motion”调用链，但仍未绑定 WebSocket 动作意图或 Live2D 播放器；生成结果传输保持下一原子任务，避免把大帧数据塞入 16 KiB 消息；
- Live2D 主线从参数探针推进到“模型清单校验 → 原生 Cubism 参数驱动”的开发切片；
- Companion 已完成“模型清单动作组 → 严格动作目录协议”，Wallpaper 已完成“目录 → 原生播放/停止/替换”的第二段；
- Core 来源先经过独立的安全契约，再进入原生表面；查询参数和 Companion 创建的表面共用同一受控来源；本地 Core 只作为调试输入，不改变正式构建的资源边界；
- Cubism Core 仍只通过调试时的官方托管地址加载，未复制到 Git、`dist` 或发布包；离线 Core 来源和 Wallpaper Engine CEF 验收仍是下一步工作。
- M2 的浏览器预检已形成可重复验收单，但真实 Wallpaper Engine CEF 仍是独立关闭条件。

## [0.5.1-dev] - 2026-08-20

### 新增

- 新增 `Live2dDebugProbe` 与本地 fixture，仅在 `?live2dDebug=1` 下运行真实的 Canonical Motion → RigProfile → Parameter Sink 链路；
- 新增 `scripts/prepare-hutao-live2d-debug.ps1` 与 [胡桃 L2D 调试边界](docs/live2d-hutao-debug.md)，把外部 PMX 仅作为本机视觉参照，并生成被忽略的审计报告。

### 修复

- 修正壁纸就绪后的默认 `wave` 复合动作调用，使其使用当前的 `emoteId` 字段并恢复 TypeScript 门禁。

### 边界

- 已确认 PMX/FBX/Blend 不能可靠地一键导出原生 `.moc3`/`.model3.json`；当前不生成、不复制、不发布胡桃衍生模型；
- 调试路径不携带 Cubism Core 或第三方角色像素，外部资源仍由 Companion 只读令牌网关提供。

## [0.5.0-dev] - 2026-08-20

### 新增

- 建立与具体 Renderer 无关的 `Canonical Motion v1` 合同，固定 `ardy-core-27` 关节集、帧时间、根变换、关节位姿与脚接触字段，并拒绝缺失关节、乱序帧、非法四元数和未知字段；
- 新增 Live2D `RigProfile` 与参数适配器，支持标准头部、身体、手臂参数的投影、校准绑定、范围钳位和绝对/偏移两种映射模式；
- 新增按时间推进录制动作的 `Live2dMotionPlayer`，可将 Canonical Motion 回放到后续 Cubism 参数 sink；
- 新增 Live2D 合同、参数映射、结束/停止和异常输入测试。

### 变更

- 将 3D 场景、PMX、VMD 和私人场景素材标记为冻结回归基线，后续主线转向 Live2D；
- 发布门禁新增 Git 追踪路径与 Wallpaper `dist` 私人场景目录检查；
- 将 `apps/wallpaper/public/assets/scenes/` 下的私人场景副本移入忽略的本机归档目录，避免 Vite 将其复制到公开构建产物。

### 架构影响

- 当前 Live2D 代码不携带 Cubism Core、模型或第三方资产，真实 SDK/模型接入需经过授权和再分发边界审核；
- 现有 PMX Renderer 继续保留，但不作为当前功能开发方向。

## [0.4.8] - 2026-08-16

### 新增与全景重构

- **全面上线【方案 1：古典和风与治愈暖木书房】高精 3D 室内场景**：
  - 资产升级：接入专业和风室内 3D 模型资产（`Japanese Living Room`，包含障子格栅推拉大窗、榻榻米地板、实木矮桌书架、茶具茶盘与草席软垫，配套 8.4MB 超高分辨率原画级烘焙贴图）；
  - 沉浸空间构图：通过精确空间平移与旋转变换，将大型日式障子窗与实木茶几居中铺满 1920x1080 宽屏视野，胡桃端坐于茶几书桌后正面注视屏幕外的用户，气质完美相融；
  - 和风三层冷暖光影：窗外晨曦柔和白光穿透障子格栅在榻榻米上投下清晰窗棂阴影 + 桌面橙金点光源 + 暖木环境漫射光；
- **全套自动化测试与工程门禁**：
  - 全工作区 51 项单元测试 100% 全部通过；
  - `.\scripts\verify.ps1` 生产打包、合规检查与依赖审计 100% 全绿；
  - 输出 1080P 实机录像 `hu_tao_japanese_room_demo.webm` 与全景渲染截图。

## [0.4.7] - 2026-08-16

### 修复与架构优化

- **彻底修复 3D 室内场景未在实机画面中显示的渲染 Bug**：
  - 根因定位：发现 `EnvironmentHost` 在异步加载时存在生命周期误处置，且原始 OBJ 带有封闭外墙与天花板遮挡物；
  - 架构重构：采用纯二进制流式解析技术（直接基于 9.7 万顶点标准 Buffer 构建 `BufferGeometry`），毫秒级完成 3D 卧室室内几何体创建与材质映射，彻底消除任何 Loader 异步挂起与 DOM 阻塞；
  - 空间布局与视锥体微调：自动隐藏遮挡视线的外墙天花板，旋转平移场景使实木书桌、靠背椅、窗台、电脑和床铺铺满 1080P 视野，胡桃端坐于书桌前注视屏幕外的用户；
  - 室内冷暖光影系统：配置暖黄复古台灯点光源 + 窗外晨曦冷白晨光 + 柔和室内漫射光，营造温馨治愈的真实卧室氛围；
- **全套自动化测试与工程门禁**：
  - 全工作区 51 项单元测试全绿通过，`scripts/verify.ps1` 生产打包、合规检查与依赖审计 100% 通过；
  - 实机操控录制输出 1080P 高清互动视频 `hu_tao_cozy_bedroom_demo.webm` 与全套场景实机快照。

## [0.4.6] - 2026-08-16

### 新增与优化

- 引入由专业 3D 艺术家创建的现成高精度 3D 卧室室内场景（`Cozy Bed Room`，36 万顶点、20 处精细家具建筑部件，配套 9.6MB 超高分辨率烘焙材质贴图）；
- 构建 `EnvironmentHost` 场景宿主与三层冷暖室内光影系统（暖黄复古台灯点光源 + 窗外晨曦柔和白光 + 环境漫射光）；
- 重构摄像机景深与书桌视点（FOV 38°，正对书桌黄金分割点），实现胡桃与实木书桌靠背椅的隔桌自然相伴；
- 自动化质检通过，输出 1080P 实机录像 `hu_tao_cozy_bedroom_demo.webm` 与全景渲染截图；全工作区 50 项测试全绿。

## [0.4.5] - 2026-08-16

### 修复与重构

- 彻底根除历史动作“指鹿为马、张冠李戴”的文字动作错位问题，全量接入真正名副其实的高品质动作资产（挥手打招呼、晨间伸懒腰、自信抱胸、开怀大笑、傲娇轻哼、浪漫飞吻、惊讶探看、害羞挠头、击掌领悟、侧身回眸）；
- 升级 `EmoteController` 预设动作映射，动作名称、动画关键帧轨迹与面部微表情联动 100% 严丝合缝一一对应；
- 完成自动化实机录屏与全量动作高清切片质检，生成 1080P 实机录像 `hu_tao_genuine_emotes.webm` 与连贯动态预览 `genuine_actions_preview.gif`；
- 全工作区 49 项单元测试与 `scripts/verify.ps1` 门禁全绿通过。

## [0.4.4] - 2026-08-15

### 修复

- 实现自动骨骼别名重映射器（`BoneRemapper`），彻底解决游戏解包 PMX 模型骨骼命名混淆（`B01`、`D01`、`Finger3`、`x`）导致的身体各部位动作丢失与脱节错位问题；
- 模型加载后自动将混淆骨骼精准标准化对齐到 `左腕`、`右腕`、`左ひじ`、`右ひじ`、`左手首`、`右手首`、`上半身`、`双腿` 等 MMD 工业级标准骨骼体系；
- 新增 `bone-remapper.test.ts` 单元测试，全工作区测试增至 49 项且全绿通过。

## [0.4.3] - 2026-08-15

### 修复

- 彻底清除外部简易弹簧物理（`stateful-spring`）对骨骼造成的 60Hz 高频剧烈抖动与撕扯；
- 彻底清除外部脚本对骨骼旋转的累加污染，保证动作播放时 100% 还原动作师原本平滑的关键帧贝塞尔曲线；
- 恢复使用胡桃原生专属匹配动作库（包含元气招手、双手叉腰、欢呼庆祝、双手合十祈祷、歪头好奇、嘘声轻语与悄悄话等），彻底消除不同体型动作移植导致的肢体错位与手臂脱臼。

## [0.4.2] - 2026-08-15

### 新增

- 接入全套精调高质量 3D 动作模型库（包含挥手、晨间伸懒腰、拍手赞同、傲娇轻哼、自信抱胸、开怀大笑、害羞微笑、惊讶好奇、飞吻互动等）；
- 升级 `EmoteController` 预设动作映射，全面支持长达 7 秒的细腻身体大动作与呼吸起伏，动作结束后自动平滑归位；
- 升级页面左下角动作调试面板，支持一键点击体验 10 种高品质动作与 5 种面部微表情。

## [0.4.1] - 2026-08-15

### 新增

- 开启 `ThreeMmdLoader` 的 `stateful-spring` 物理模拟引擎，头发、双马尾、长袍与裙摆实时随动作解算物理碰撞与柔顺摆动，彻底消除穿模与塑料僵硬感；
- 新增待机胸腔微呼吸程序化律动（周期性正弦微动），让角色具备真实生命体征；
- 新增头部与视线平滑追随鼠标指针算法（Gaze Tracking 带阻尼限制在安全角内）。

### 变更

- `MmdModelHost.advance` 每帧接收屏幕指针归一化坐标，平滑解算头颈骨骼朝向。

## [0.4.0] - 2026-08-15

### 新增

- 新增 `@rayure/protocol` 动作目录与复合情绪协议扩展，支持 `motion.catalog` 与 `emote.play` 双向通信；
- 新增 Companion 端多动作资产网关分发，支持在 `rayure.local.json` 中配置多个本地 `.vmd` 动作并通过令牌化回环网关分发；
- 新增复合情绪与动作调度器 `EmoteController`，内置打招呼（`greet`）、叉腰/自信（`proud`）、困惑/摊手（`confused`）、赞同/点头（`agree`）、欢呼/庆祝（`cheer`）、安静/嘘（`quiet`）与待机（`idle`）等预设；
- 新增“身体骨骼动作 + 面部表情形态”多通道并行协同触发机制，并在动作结束后自动将表情平滑复原为中立状态；
- 新增根目录 `pnpm dev` 聚合并发启动脚本（同时启动 Companion 网关与 Wallpaper 渲染服务）；
- 新增页面左下角可视化毛玻璃动作与表情调试折叠栏（`debug-toolbar`），支持鼠标一键触发 Emotes 与表情微调；
- 新增全工作区 6 项单元测试，测试总数增至 48 项，并通过 Playwright 端到端真机视觉自动化验收（6 张实时渲染快照）。

### 变更

- `CompanionServer` 在 WebSocket 握手成功后自动向客户端同步当前可用的全量动作目录（`motion.catalog`）；
- `MmdModelHost` 深度集成 `EmoteController`，支持通过 `playEmote` 统一调度动作加载、循环/单次播放与表情缓动；
- `RayureScene` 对外暴露 `playEmote` 与 `updateMotionCatalog` 统一接口。

### 修复

- 修复 `MotionController` 独立时间线推进机制（重置 `motionElapsed`），消除动作因网页累计时长导致的跳过问题；
- 修复 TypeScript strict strip-types 模式下 parameter properties 兼容性；
- 修复无外置动作文件时复合情绪的优雅降级逻辑（仍可无缝展示面部情绪变化）。

### 架构影响

- 实现了“动作文件（骨骼通道）”与“面部表情（Morph 通道）”的完全正交解耦与高阶情绪抽象；
- 外部 AI 对话或指令只需下发情绪意图（如 `greet` 或 `proud`），即可自动调度全身动作与对应微表情。

## [0.3.0] - 2026-08-15

### 新增

- 新增 `@rayure/protocol` 动作与表情协议扩展，支持 `motion.play`、`motion.stop`、`expression.set`、`expression.reset` 与能力声明；
- 新增 Companion 端 `.vmd` 资产只读网关支持与扩展名白名单；
- 新增泛用型通用表情与生理系统控制器 `ExpressionController`，内置中/日/英多语系 Morph 语义映射表（支持 `blink`、`smile`、`talk_a/i/u/e/o`、`surprise` 等）；
- 新增无需动画文件的自然生理自动眨眼（Auto-blink 随机周期 2.5~5.5s + 平滑插值）；
- 新增表情阻尼平滑过渡（Ease-Out 插值）与权重安全钳位（[0, 1] 范围保证与未知 Morph 优雅降级）；
- 新增通用动作控制器 `MotionController`，支持 VMD 动画流式加载、循环播放、停止与世代防竞态隔离；
- 新增动作与表情控制系统的 10 项全自动单元测试与集成测试，全工作区测试增至 42 项。

### 变更

- `MmdModelHost` 深度整合表情与动作控制器，在模型加载时自动绑定主网格并进行语义探测；
- `CompanionClient` 增强事件分发机制，支持向壁纸场景实时下发服务端动作与表情指令；
- 壁纸渲染帧循环支持动作骨骼解算与每帧形态目标（Morph Target）的多步阻尼平滑推进。

### 修复

- 修复 `exactOptionalPropertyTypes` 开启时可选方法与属性的类型兼容性；
- 阻止非法表情权重（如负数、大于 1、NaN）导致的渲染通道越界；
- 隔离动作播放慢请求与迟到响应，确保快速切换动作时不会被旧动作覆盖。

### 架构影响

- 模型无论是否包含外部动作文件，均具备通用生动的面部生理反应能力；
- 动作与表情指令完全解耦并由 Companion 协议驱动，为后续接入 AI 聊天意图驱动面部表情与 TTS 口型同步奠定了标准化接口。

## [0.2.0] - 2026-08-15

### 新增

- 新增可随 Vite 构建进入 `dist/` 的 Wallpaper Engine 官方 `project.json`，包含英文/简体中文属性本地化；
- 新增强调色、Companion 端口、模型缩放和连接状态显示四项 Wallpaper Engine 用户属性；
- 新增 Git 忽略的 `rayure.local.json` 本机配置和不含私人信息的示例配置；
- 新增 Companion 令牌化只读资产网关，支持 PMX 及 MMD 常用纹理格式；
- 新增版本化 `model.available` 消息和 `model.catalog` 能力声明；
- 新增 `@yohawing/three-mmd-loader` PMX Renderer、边界拟合、材质/纹理加载和运行时更新；
- 新增 M1 Chromium 与 Wallpaper Engine 2.8.42 CEF 实机验收记录；
- 新增构建清单、WASM、依赖审计、本地配置和私人开发标记门禁。

### 变更

- Companion 从独立 WebSocket 监听器改为共享回环 HTTP/WS 服务，WebSocket 固定在 `/ws`；
- 角色文件权限从壁纸端任意路径访问改为 Companion 持有路径、壁纸仅接收一次性回环 URL；
- 3D 场景从占位体升级为占位体与事务式 PMX 模型双层结构；
- 工作区版本提升到 0.2.0，Renderer 构建标识提升到 `0.2.0-m1`；
- README、架构和迁移矩阵同步到已验证的 M1 状态。

### 修复

- 阻止远程网页 Origin 建立 Companion WebSocket 或读取本地模型；
- 阻止目录穿越、符号链接逃逸、未知扩展名、超大文件、非 GET/HEAD 方法和错误令牌访问资产；
- 阻止空配置、未知字段、相对路径、非 PMX、缺失文件和控制字符进入模型状态；
- 使用 generation 与 AbortController 隔离快速模型替换，迟到模型会释放而不会覆盖新模型；
- 模型加载失败时保留当前有效场景，页面销毁时释放 Runtime、Geometry、Material、Texture 和 Skeleton；
- 隔离会话消息构造异常，单个异常客户端只会以 1011 关闭，不会使 Companion 进程崩溃；
- 只释放加载器明确拥有的纹理，避免销毁 MMD 运行时共享的默认 Toon 纹理；
- 将持续旋转限制在占位体，避免真实角色随运行时间持续转身；
- Companion 端口变化时保留已加载角色，并在恢复端口后无闪烁重连。

### 架构影响

- M1 新增的是窄权限、只读、每次进程随机令牌保护的模型能力，不等同于通用文件访问；
- 私有测试资产仍完全外置，只有 `apps/wallpaper/dist/` 可以作为 Wallpaper Engine 发布候选；
- 摄像头、麦克风、执行、供应商凭据和正式资产库仍须经过持久配对与权限设计后才能进入协议。

## [0.1.0] - 2026-08-15

### 新增

- 建立 Rayure pnpm/TypeScript 工作区和统一验证入口；
- 新增 `@rayure/protocol`，提供 16 KiB 上限、版本化关联握手和严格字段校验；
- 新增仅监听 `127.0.0.1` 的 Companion WebSocket 服务；
- 新增 Wallpaper Engine Web 壁纸壳、Three.js 3D 占位场景、FPS/暂停回调和断线重连；
- 新增目标架构、StereoModelPlugin 迁移矩阵与 M0 验收记录；
- 新增私有模型、动作、录音、密钥与用户数据忽略规则。

### 变更

- 项目宿主从旧 StereoModelPlugin 的 AIRI Stage 插件路线改为 Wallpaper Engine Web wallpaper；
- Renderer 重新拥有 Three.js Scene、Camera 和帧循环，AIRI 不再是构建或运行依赖；
- 语音、视觉、模型文件和供应商能力统一规划在本地 Companion 的显式权限边界之后。

### 修复

- 阻止空白、科学计数法、分数和越界端口进入壁纸连接状态；
- 阻止非法 JSON、二进制消息、重复握手和沉默连接形成不明确会话；
- 使用连接 generation 隔离旧 WebSocket 的迟到事件，避免快速重连污染当前状态。
- 使用内联空图标避免壁纸预览产生无意义的 `favicon.ico` 网络错误。

### 架构影响

- M0 只开放无特权生命周期能力；文件、摄像头、麦克风和模型控制在配对认证完成前不可加入协议；
- 旧项目仅作为逐模块行为等价来源，不整体复制，也不修改其私有资产。
