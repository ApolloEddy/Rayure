# Rayure

Rayure 是一个面向 Wallpaper Engine 的本地优先桌面角色运行时。它不依赖 AIRI，由 Wallpaper Renderer 负责画面与角色表现，由只监听回环地址的 Companion 负责本地资源、协议和未来的 AI/传感器适配。

## 当前状态

仓库目前保留了一条已经可运行的 3D 基线：Wallpaper Engine Web wallpaper、外置 PMX、VMD 动作、Morph 表情、复合 Emote、鼠标注视、骨骼别名重映射和 Companion 只读资源网关均已有实现与测试。

项目下一阶段会**冻结但不删除 3D**，优先用 Live2D 验证完整的 AI 行为闭环。目标不是把 3D 骨骼直接压缩成 2D 骨骼，而是引入与具体模型无关的 Canonical Motion 和 Rig Adapter：

```text
Rayure Behavior
  -> 动作意图 / Prompt / 空间约束
  -> Motion Semantic Feature
  -> Motion Backend（ARDY 为首选候选，尚未接入）
  -> Canonical Motion
  -> Rig Adapter
       |- Live2D Adapter（当前主线）
       `- 3D Adapter（保留并后续回归）
```

`CHANGELOG.md` 已记录到 `0.5.2-dev`（此前的 3D 记录为 0.4.8），但根工作区和各 package manifest 仍标记为 0.2.0。本仓库因此应视为开发快照，而不是已经完成版本统一的正式发布版。

当前统一验证中 78 项测试通过，TypeScript 与生产构建均通过；原生 Cubism 画布和 Companion Live2D 模型/动作通道仍仅供本机调试，Core 来源和 CEF 离线验收尚未闭合。3D 继续作为冻结回归基线。

## 已实现

- Wallpaper Engine 官方 Web wallpaper 项目、用户属性、中英文本地化、FPS 与暂停生命周期；
- Three.js + `@yohawing/three-mmd-loader` 的外置 PMX、材质和中文纹理加载；
- 仅绑定 `127.0.0.1`、固定使用 `/ws` 的 Local Companion；
- 严格版本化协议、16 KiB 消息上限、未知字段拒绝和握手状态校验；
- 随机会话令牌保护的只读模型/动作网关，以及 Origin、方法、扩展名、大小和 realpath 边界校验；
- VMD 动作目录与播放、Morph 表情、自动眨眼、平滑复位和复合 Emote 调度；
- 模型和动作异步加载的 generation 隔离、失败保留、迟到结果释放与资源清理；
- 骨骼别名重映射、鼠标驱动的头部/视线反馈和调试动作面板；
- `scripts/verify.ps1` 统一执行测试、TypeScript、生产构建、依赖审计和发布边界检查。

现有 3D 能力是下一阶段的回归基线，不代表通用模型的动作重定向、Live2D、语音、视觉或 Agent 已经完成。

## 当前架构

```text
Wallpaper Engine / CEF
  `- Rayure Wallpaper Renderer
       |- Three.js + PMX/VMD/Morph
       |- Wallpaper Engine lifecycle/properties
       `- ws://127.0.0.1:32145/ws
                         |
                         v
                   Rayure Companion
       |- strict versioned protocol
       |- tokenized read-only asset gateway
       `- future ASR / LLM / TTS / Vision adapters
```

详细设计见 [目标架构](docs/architecture.md)，旧项目的保留、改造和淘汰项见 [迁移矩阵](docs/migration-matrix.md)，现有基础验收见 [M0](docs/acceptance/m0-foundation.md) 与 [M1](docs/acceptance/m1-wallpaper-engine-pmx.md)。

## 当前 Live2D 开发切片

第一批 Live2D 基础和一个仅供本机调试的原生 Cubism 入口已经落在仓库中；正式构建仍不打包 Cubism Core 或角色模型：

- `packages/protocol/src/canonical-motion.ts`：严格的 27 关节 `Canonical Motion v1` 合同；
- `apps/wallpaper/src/live2d/rig-profile.ts`：标准参数 `RigProfile`、身体/头部/手臂投影和范围钳位；
- `apps/wallpaper/src/live2d/motion-player.ts`：录制动作按时间推进到参数 sink 的回放器；
- `apps/wallpaper/test/live2d-*.test.ts`：覆盖完整性、异常输入、参数映射、停止和结束状态。
- `apps/wallpaper/src/live2d/debug-probe.ts`：仅在 `?live2dDebug=1` 下启用的参数链路探针；它不携带 Cubism Core 或角色像素。
- `apps/wallpaper/src/live2d/model-manifest.ts`：校验 `.model3.json` 的相对资源引用，并扫描模型参数与标准 RigProfile 的匹配情况；
- `apps/wallpaper/src/live2d/native-debug-surface.ts`：仅在显式 `?live2dModelUrl=...` 或 Companion 的 `live2d` 模型通知下动态加载原生 Cubism 调试画布；
- `apps/wallpaper/src/live2d/motion-controller.ts`：为原生 Cubism 动作提供目录校验、默认 Idle、停止、打断/替换和异步 generation 隔离；
- `scripts/audit-live2d-model.ps1` 与 [Hiyori 原生调试说明](docs/live2d-hiyori-debug.md)：审计官方 Hiyori 开发模型的 17 个资源和 70 个参数。
- `packages/protocol`、Companion 与 Wallpaper 已支持 `model.available` 的 `live2d` 格式；Companion 通过令牌化只读 URL 提供整个 `.model3.json` 资源根，Wallpaper 会先校验清单再加载原生模型。
- Companion 会从 Live2D `.model3.json` 的 `FileReferences.Motions` 自动生成带 `group`/`index` 的动作目录，并以令牌化 `.motion3.json` URL 暴露资源。

当前入口已经把 Canonical Motion fixture 接到真实 Cubism 参数 sink，并完成 Companion → Wallpaper 的 Hiyori 模型、动作目录、默认 Idle、动作替换与停止端到端加载；下一步是处理可配置的 Core 来源与 CEF/离线验收。

现有外部 PMX 角色不能可靠地一键转换为原生 Live2D；官方 Cubism 工作流要求分层 PSD、ArtMesh 和变形器。若只需要本机调试，可运行 [`scripts/prepare-hutao-live2d-debug.ps1`](scripts/prepare-hutao-live2d-debug.ps1)，让外部 PMX 作为视觉参照，同时打开 `?live2dDebug=1` 验证参数链路。调试资源、配置和审计报告均不进入 Git、`dist` 或发布包，详见 [胡桃 L2D 调试边界](docs/live2d-hutao-debug.md)。

## 环境

- Windows 10/11；
- Node.js `>= 24.12.0`；
- pnpm `11.19.0`；
- Wallpaper Engine（真实壁纸验收需要；已有记录使用 2.8.42）。

## 安装与验证

```powershell
pnpm install --frozen-lockfile
pnpm verify
```

也可以直接调用统一验证脚本：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1
```

分别启动 Companion 与壁纸开发服务器：

```powershell
pnpm dev:companion
pnpm dev:wallpaper
```

或者并行启动整个工作区：

```powershell
pnpm dev
```

浏览器预览地址为 `http://127.0.0.1:4173`。

## 本地角色与动作配置

复制示例配置，并把绝对路径改成你有权在本机使用的 PMX/VMD 文件：

```powershell
Copy-Item .\rayure.local.example.json .\rayure.local.json
```

`rayure.local.json`、角色、动作、录音、实验输出和购买的场景素材均被 Git 排除。Renderer 只接收一次性回环 URL，不接收磁盘路径。

## 私有资产与发布边界

- 本仓库的 Apache-2.0 许可证只覆盖有权以该许可证发布的项目代码与文档；
- 购买或来自其他项目的角色、场景、动作、纹理和录屏不会进入 Git；
- `scratch/` 与 `apps/wallpaper/public/assets/scenes/` 属于本机实验/素材位置，不是公开源码的一部分；
- Vite 会复制 `public/` 内容，因此本机含私有素材时生成的 `dist/` 也不得直接上传或分发；
- 正式发布必须改用明确允许再分发的默认素材，或改为由用户从包外配置自己的素材。

P0 只做两件事：确认私人资源不会进入 Git、`dist` 或发布目录；冻结现有 3D 能力，不继续增加 3D 场景、模型和动作功能。3D 代码保留为回归基线，后续只做必要的安全修复。主要开发方向转为 Live2D。

## 下一阶段

1. 完成资源边界门禁并把现有 3D 标记为冻结回归基线；
2. 建立不依赖具体 Renderer 的 Canonical Motion 数据契约与回放测试夹具；
3. 接入许可清晰、参数完整的 Live2D 开发模型，并实现标准参数扫描与 `RigProfile`；
4. 将 Canonical Motion 映射到 Live2D Controller，先用录制夹具验证 idle、注视、挥手、打断和过渡；
5. 做 ARDY 的独立推理 Spike，实测 RTX 4060 8GB 的显存、首段延迟、连续生成和打断恢复；
6. 定义 Motion Semantic Feature Cache 与可配置 Text Encoder API，再接入 TTS/口型、ASR 和视觉派生事件；
7. Live2D 闭环稳定后，让现有 3D Renderer 作为第二个 Rig Adapter 回归。

## 尚未完成

- Cubism Web SDK、Live2D 模型导入、ArtMesh/Deformer 绑定与一次性 RigProfile 标定；
- ARDY/DiP 等生成式动作后端的本机实测与选型；
- Canonical Motion Buffer、跨后端动作约束与执行回执；
- Motion Semantic Feature 预置库、动态缓存和 Text Encoder API；
- ASR、LLM、TTS、口型和音频播放；
- 摄像头、MediaPipe 与最小化派生视觉事件；
- 首次配对、设置界面、自动启动、升级、多显示器、睡眠唤醒和长时间稳定性验收；
- 可公开再分发的默认角色/场景与正式 Wallpaper Engine Workshop 包。

## License

项目代码与文档按 [Apache License 2.0](LICENSE) 发布。第三方素材遵循各自许可证，未明确授权再分发的素材不属于本仓库发布内容。
