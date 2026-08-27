# Rayure

Rayure 是一个面向 Wallpaper Engine 的本地优先桌面角色运行时。它不依赖 AIRI，由 Wallpaper Renderer 负责画面与角色表现，由只监听回环地址的 Companion 负责本地资源、协议和 AI 动作生成。

## 当前状态

**视觉与语音的代码主链已经接通**：摄像头/MediaPipe 只在包外进程内派生低频观察，经过事件检测和行为调度进入动作生成；ASR 最终转录 → Agent 结构化行为计划 → 动作/TTS → 令牌化音频与口型曲线 → Wallpaper 播放。所有大数据仍走回环 token URL，不进入 16 KiB websocket，也不把原始摄像头/音频送进 Renderer。

2026-08-24 的连续性修复已完成：Renderer 会把实际播放帧回报给 Companion；下一段只续写该已确认前缀；Bridge 使用不透明 continuation 而非猜测 Canonical JSON；生成动作独占 Live2D 参数写入、插值并平滑回到原生 Idle。当前还加入了 ARDY idle action pool、预测式 replan buffer，以及在交接窗口提交的参数 crossfade。普通浏览器和自动化回归已通过；本轮新增播放逻辑仍需在 Wallpaper Engine CEF 中完成视觉/DevTools 门禁，不能把浏览器结果误报为该门禁已关闭。

```text
MediaPipe 派生观察 -> VisionEventDetector -> BehaviorOrchestrator
ASR 最终转录 -> Agent 结构化计划 -> BehaviorOrchestrator
  -> 动作意图 / Prompt -----------------------------+
  -> Motion Semantic Feature Cache（AutoDL 一次性预置，30k 条）
  -> ARDY Bridge（本地 Python 子进程，RTX 4060 实测）
  -> Canonical Motion（27 关节，renderer 无关）
  -> 令牌化 motion.published 广播 + motion.playback 回执
  -> Rig Adapter
       |- Live2D Adapter（当前主线；岛风皮套/原生内容完成浏览器预检，模型专属参数映射和 ARDY 行走视觉仍未验收）
       `- 3D Adapter（冻结回归基线）

Agent 计划中的 replyText -> LiveTalker TTS / fixture / 包外 JSONL 小模型
  -> speech.published（音频 URL + mouth-cues URL）
  -> SpeechPlayer -> Live2D mouth channel + speech.playback
```

2026-08-25 收尾边界：当前岛风模型的真实 parameter id 已确认，代码中有一个显式 Shimakaze RigProfile，用于把 ARDY 的头、身、手臂、腿、膝、脚和蹲起控制投影到该模型的非标准参数。这个 profile 仍是模型专属的手工校准，通用的 model3/DisplayInfo 导入、映射结果/缺失参数诊断和“任意新模型自动适配”尚未完成；本地浏览器看到生成请求 `completed` 也不等于已经通过可见步态或 Wallpaper Engine CEF 验收。

已完成的里程碑：

- **ARDY Bridge**（`scripts/ardy-bridge.py`）：JSONL 协议子进程，在 RTX 4060 8GB 上以真实权重运行；续写令牌与具体生成段一一对应，Renderer 确认的帧数决定其按 ARDY token 对齐的裁剪位置，绝不回退到“最近一次”全局状态或不可靠的 Canonical JSON 反推。`Hips`、双手和双脚的 Root2D/EndEffector 约束已经过真实短段与连续续写验证。
- **云端词向量生产线**（`autodl/`）：DeepSeek 按 21 类动作 × 速度/幅度/情感/方向四维修饰批量展开意图字典，AutoDL 24GB 卡用 LLM2Vec（llama-3-8b）一次性编码为 30,011 条语义特征（fp16 / 4096 维 / 约 323 MB），本地 Companion 启动即缓存命中，**运行时完全不需要文本编码器**。
- **MotionScheduler 连续调度**：`advance()` 仅保留给 headless 测试；生产续写只采用 Renderer 的 `motion.playback` 回执。抢占会取消生成器实际收到的 signal，发布失败的未观察 buffer 会回滚；预测 replan 生成的下一段先留在独立 buffer，只有进入 handoff 窗口才提交。
- **ARDY 待机连续动作**：`motionSemantic.idlePool` 以 round-robin 选择待机 prompt，在当前动作剩余时间进入 lookahead 窗口后提前生成，并在 handoff 窗口发布；语音/视觉直接动作会取消过期预取。Renderer 新加入可单测的参数 crossfade，默认从当前真实参数姿态平滑过渡 180 ms。
- **Live2D 原生渲染**：生成动作、原生动作和 debug fixture 现在是互斥的单一参数写入者；20 fps Canonical Motion 在渲染帧间做位置线性插值和四元数 slerp，生成开始采用 crossfade，根位移投影到画布并由 RigProfile 适配模型参数。
- **浏览器构建**：冻结的 PMX/MMD 主机按需加载；第三方依赖的 Node-only 可选分支有明确浏览器 stub，不再产生 Vite browser-external 告警，最大 JS 分块为 380 kB。
- **视觉事件**：`VisionProcessClient` + `scripts/mediapipe-vision-bridge.py` 只接受严格的派生观察；presence、头向、举手、挥手采用迟滞/连续帧/冷却窗口，事件 action 通过 allowlist 接入动作策略。`--simulate` 可在无摄像头/模型环境回归。
- **语音事件**：`SpeechRuntime` 支持 `globalThis.rayureSpeech.submitText(...)` 和包外 ASR JSONL；已提供 LiveTalker `/api/chat` 与 `/api/synthesize` 兼容适配器，Agent 输出会转换为结构化 `BehaviorPlan`，TTS WAV 会转换为口型曲线；所有 provider 调用具备 signal/generation 抢占边界。
- **音频与口型**：Companion 只发布 token 化音频和 `rayure.mouth-cues.v1` 曲线；Wallpaper `SpeechPlayer` 驱动 `ParamMouthOpenY` 类参数并回报 `speech.playback`。

`CHANGELOG.md` 已记录 2026-08-25 的未发布变更（最新开发基线为 `0.6.0-dev`，此前的 3D 记录为 0.4.8），根工作区 manifest 仍为 0.2.0。本仓库应视为开发快照。本次本地测试通过 211 项（协议 23、Companion 120、Wallpaper 68）；TypeScript、生产构建、四条 Python bridge 编译与发布边界审计仍按独立门禁记录，Live2D 模型专属参数映射和 Wallpaper Engine CEF 可见步态尚未关闭。

## 已实现

- Wallpaper Engine 官方 Web wallpaper 项目、用户属性、中英文本地化、FPS 与暂停生命周期；
- Three.js + `@yohawing/three-mmd-loader` 的外置 PMX、材质和中文纹理加载（冻结基线，主机按需分块加载）；
- ARDY 3D 调试工作台（`?3dDebug=1`）：确定性 CoreSkin 帧渲染与帧检查器、语义预设/本地夹具直放、本机 PMX 上传、播完回静止与循环播放、WebGL 上下文丢失自恢复；
- 仅绑定 `127.0.0.1`、固定使用 `/ws` 的 Local Companion；
- 严格版本化协议、16 KiB 消息上限、未知字段拒绝、握手状态校验，以及仅对当前已发布动作生效的 `motion.playback` 播放回执；
- 随机会话令牌保护的只读模型/动作网关，以及 Origin、方法、扩展名、大小和 realpath 边界校验；
- 严格的 27 关节 `Canonical Motion v1` 合同与校验；
- Live2D：`.model3.json` 清单校验、标准参数 RigProfile、原生 Cubism 画布（Core 来源受控）、motion3 动作目录、互斥播放槽、Canonical Motion 插值/根位移/步态映射；
- ARDY 动作生成：进程协议、语义特征缓存（内存/文件、fp16/fp32、token mask）、Text Encoder API 客户端（可选）、启动预设生成、idle action pool、预测式 replan buffer、实体坐标约束与实时意图入口 `globalThis.rayureMotionGeneration`；
- BehaviorOrchestrator：统一视觉、语音和直接行为的优先级、去重、过期、抢占取消与 generation 隔离；
- 摄像头/MediaPipe：包外 Python Bridge、派生观察合同、低频事件检测和 allowlist 动作策略；
- ASR → Agent → TTS/口型：ASR/Agent/TTS 的 provider-neutral 合同、LiveTalker HTTP 兼容适配器、包外 JSONL adapters、tokenized speech gateway、Wallpaper `SpeechPlayer` 和 playback telemetry；
- 模型和动作异步加载的 generation 隔离、失败保留、迟到结果释放与资源清理；
- `scripts/verify.ps1` 统一执行测试、TypeScript、生产构建、依赖审计和发布边界检查。

### Live2D 皮套与 Wallpaper Engine 设置

Live2D 在 Wallpaper Engine 中默认按“皮套”接入：Companion 会把 `.model3.json` 的默认入口生成为不含 `Motions` 的 skin-only 入口，避免把模型自带场景和动作无条件带进壁纸；Rayure 自己的 Canonical Motion、口型、鼠标和行为交互仍由现有运行时负责。模型原生动作/场景层只有在 Wallpaper Engine 属性中勾选 **Import model-native content / 导入模型自带内容** 后，才会重新加载原生入口。

本地 `http://127.0.0.1:4173/` 浏览器预览是开发例外：为了能立即验证动作和点击交互，它会自动加载原生动作但仍隐藏模型自带场景层；追加 `?live2dDebug=1` 可打开开发面板，追加 `?live2dNativeContent=0` 可强制回到 skin-only，追加 `?live2dNativeScene=1` 才显示模型包内场景层。当前 Shimakaze 资源没有 `Expressions`/`.exp3`，因此开发面板会禁用表情按钮并展示可用的原生动作目录；调试面板中的 ARDY 区域可输入描述并直接请求生成，挥手/走路快捷预设使用本地语义缓存，任意新 Prompt 需要配置 Text Encoder 才能命中语义特征。

模型把背景、镜子、粒子等做进 drawable/part 层时，不能只靠删除动作文件。可在包外的 `rayure.local.json` 为 Live2D 模型声明要隐藏的部件：

```json
{
  "model": {
    "id": "shimakaze",
    "displayName": "Shimakaze",
    "format": "live2d",
    "path": "D:\\Models\\Shimakaze\\daofeng_5.model3.json",
    "skinHiddenPartIds": ["Part45", "Part46", "Part53", "Part54"]
  }
}
```

Companion 也会根据可选 `cdi3.json` 中的背景/地板/镜子/粒子等名称做保守的自动识别；显式 `skinHiddenPartIds` 用于模型专属场景层。这里的“原生内容”指模型包内的动作和场景层，Rayure 自己的桌面场景仍由 Rayure 管理。

Wallpaper Engine 的 `project.json` 属性承担当前设置入口：连接端口、强调色、模型缩放、连接状态、Rayure 品牌信息和模型自带内容导入。旧的桌面动作/表情调试栏及 `debugui` 属性已移除，不把开发按钮嵌入正式壁纸；`live2dDebug=1`、`live2dModelUrl`、`live2dNativeScene=1` 仅保留给开发预检使用。

### ARDY 3D 调试工作台（`?3dDebug=1`）

`?3dDebug=1` 打开独立的 3D 调试工作台：左侧停靠一个可折叠的「ARDY 3D 调试台」控制面板（`motion-debug-panel.ts`），用于在浏览器里直接验证动作视觉，不需要 Wallpaper Engine：

- **模型**：内置 CoreSkin27 官方人偶（默认）、`albedo.pmx` 开发夹具，或从本机选择任意 `.pmx` 文件上传；上传超过 512 MiB 会在解析前拒绝，防止渲染进程崩溃白屏；
- **预设**：14 个动作预设 —— 13 个走 LLM2Vec 语义缓存 + ARDY 生成（`wave.casual`、`walk.forward`、`sit.chair`、`jump.air-turn` 等，prompt 与 AutoDL 批量编码条目逐字一致，直接命中缓存），1 个「本地夹具 · 步行」直接播放，无需 Companion 和 GPU 进程，离线也能看画面；
- **播放控制**：开始/中断/中止、循环播放、播完回静止（恢复绑定姿态，不冻结在最后一帧）；
- **韧性**：WebGL 上下文丢失（GPU 进程崩溃/驱动重置）时暂停渲染并上报状态，浏览器恢复后自动续跑；调试表面关闭抗锯齿并把像素比封顶为 1，降低重型 PMX 的填充率开销。

语义预设需要 Companion 与 ARDY Bridge；夹具直放路径完全离线。确定性 CoreSkin 帧检查器（`ardy-frame-inspector.html`）和 ARDY→MediaPipe/MiKaPo PoC 边界见 `docs/Rayure_ARDY_Render_MediaPipe_MiKaPo_MMD_Development_Spec.md` 与 `docs/acceptance/ardy-mikapo-phase{0,1,2}.md`。

## 当前架构

```text
Wallpaper Engine / CEF
  `- Rayure Wallpaper Renderer
       |- Three.js + PMX/VMD/Morph（冻结基线）
       |- Live2D 原生 Cubism 画布（当前主线）
       |- Wallpaper Engine lifecycle/properties
       `- ws://127.0.0.1:32145/ws
                         |
                         v
                   Rayure Companion
       |- strict versioned protocol
       |- tokenized read-only asset gateway
       |- Motion Semantic Feature Cache
       |- MotionScheduler + IdleMotionPool（Renderer 回执、预测预取、打断/续写调度）
       |- SceneEntityRegistry（坐标变换/目标约束）
       |- BehaviorOrchestrator
       |- VisionProcessClient -> MediaPipe Bridge（仅派生观察）
       |- SpeechRuntime -> ASR/Agent/TTS adapters
       `- ARDY / ASR / TTS Bridge 子进程（JSONL / stdio）
                 |
                 v
           本地 GPU 推理（RTX 4060 实测）
```

详细设计见 [目标架构](docs/architecture.md)，旧项目的保留、改造和淘汰项见 [迁移矩阵](docs/migration-matrix.md)，验收记录见 [M0](docs/acceptance/m0-foundation.md)、[M1](docs/acceptance/m1-wallpaper-engine-pmx.md)、[M2 Live2D](docs/acceptance/m2-live2d.md) 与 [ARDY Spike](docs/acceptance/ardy-spike.md)。

## 动作生成链路

1. **字典编译（一次性，云端）**：`autodl/generate-dictionary.py` 用 DeepSeek 展开意图种子；`autodl/generate-embeddings.py` 在 AutoDL 上用 LLM2Vec 批量编码，产出 `motion-features.json`（`rayure.motion-semantic-cache.v1`，上限 512 MiB / 10 万条）。详见 [autodl/README.md](autodl/README.md)。
2. **本地运行**：Companion 启动时加载缓存（30k 条约 40 秒），`startupGenerate` 预设直接缓存命中并生成；配置 `motionSemantic.idlePool` 后，待机动作会按 lookahead/handoff 窗口提前生成。运行时可通过 `globalThis.rayureMotionGeneration.submitIntent(...)` 注入新意图，也可指定已注册实体目标。
3. **生成与发布**：ARDY Bridge 按请求生成新帧（numFrames 为新增帧数，内部多步自回归 + history 裁剪），转成 Canonical Motion 后以 `/assets/<token>/<motionId>.json` 提供并广播。每个结果携带仅供 Companion/Bridge 使用的不透明 continuation id。
4. **播放与续写**：Wallpaper 收到 `motion.published` 后经令牌化 URL 拉取、严格校验，交给 `CanonicalMotionPlayer` 插值驱动 Live2D；每个实际消费的 source frame 经 `motion.playback` 回报，下一意图只使用当前描述符和该确认帧数的 continuation。预取段不会立即覆盖当前动作，进入 handoff 窗口后才发布，并由 Renderer 以当前参数姿态做 crossfade。

## 视觉与语音链路

视觉是显式 opt-in 的 Companion 子进程能力。Python Bridge 在自己拥有摄像头和 MediaPipe 生命周期，输出 `rayure.vision-observation.v1` 的 presence、头向、手部坐标等派生字段；事件检测器只以低频、迟滞后的 `BehaviorEvent` 进入动作策略。没有 `modelPath` 或 `--simulate` 时，配置不会启动视觉进程。

语音默认也不启动。启用后可以：

- 用 `speech.asr` 指向包外 ASR JSONL 进程；进程只输出 `rayure.asr-transcript.v1` 最终转录；
- 用 `speech.agent.endpoint` 指向 loopback/HTTPS Agent，响应必须是 `rayure.agent-response.v1` 的 `BehaviorPlan`；未配置时使用可替换的规则 fixture；
- 用 `speech.tts` 指向包外 TTS JSONL 进程，或先用 fixture；TTS 输出 WAV/OGG/WebM 与 `rayure.mouth-cues.v1`；
- 用 `speech.liveTalker` 对接本机 `D:\CodingProjects\BigModel\LiveTalker`：`/api/chat` 提供 DeepSeek V4 Flash 非思考回复，`/api/synthesize` 提供 Qwen3-TTS WAV；`scripts/livetalker-asr-bridge.py` 复用 LiveTalker 的 SenseVoice 和麦克风/VAD；
- 通过 `globalThis.rayureSpeech.submitText('挥手')` 做不依赖麦克风的本地 smoke test。

示例配置（所有路径只存在于未跟踪的 `rayure.local.json`）：

```json
{
  "vision": {
    "enabled": true,
    "command": "python",
    "args": ["D:/.../scripts/mediapipe-vision-bridge.py", "--simulate"],
    "actions": { "gesture.wave": "wave.casual" }
  },
  "speech": {
    "enabled": true,
    "asr": {
      "command": "python",
      "args": ["D:/.../scripts/speech-bridge.py", "--simulate", "--text", "挥手"]
    },
    "agent": { "endpoint": "http://127.0.0.1:8123/agent" },
    "tts": {
      "command": "python",
      "args": ["D:/.../scripts/tts-bridge.py", "--simulate"]
    }
  }
}
```

### LiveTalker 实战配置

`speech.liveTalker` 会同时接管 Rayure 的 Agent 和 TTS；它不能与同一 `speech` 节点下的 `agent` 或 `tts` 并存。ASR 仍通过独立进程输出最终转录：

```json
{
  "speech": {
    "enabled": true,
    "liveTalker": {
      "baseUrl": "http://127.0.0.1:8020",
      "timeoutMs": 30000,
      "language": "Chinese",
      "motionByKeyword": {
        "挥手": "wave",
        "举手": "hand_raise",
        "左边": "head_left",
        "右边": "head_right"
      }
    },
    "asr": {
      "command": "python",
      "args": [
        "D:/CodingProjects/Mixed_Language/Rayure/scripts/livetalker-asr-bridge.py",
        "--livetalker-root",
        "D:/CodingProjects/BigModel/LiveTalker",
        "--config",
        "D:/CodingProjects/BigModel/LiveTalker/config.yaml"
      ],
      "cwd": "D:/CodingProjects/BigModel/LiveTalker",
      "startupTimeoutMs": 60000
    }
  }
}
```

启动顺序：

1. 在 `D:\CodingProjects\BigModel\LiveTalker` 中启动 `python main.py --server`，确认本机 `http://127.0.0.1:8020/health` 返回正常；API Key 继续由 LiveTalker 的受保护环境变量读取，不写入此配置。
2. 在 Rayure 根目录启动 `pnpm dev:companion`。
3. Wallpaper Engine 或 `pnpm dev:wallpaper` 连接 `127.0.0.1:32145` 后，使用 `globalThis.rayureSpeech.submitText('挥手')` 做首轮 Agent/TTS/口型 smoke test，再打开麦克风验收 ASR。

`--simulate` 只验证 Rayure ASR JSONL 合同，不会加载 LiveTalker 模型：

```powershell
python scripts/livetalker-asr-bridge.py --simulate --text 挥手
```

`speech.agent.endpoint` 不承载密钥；凭据若由实际 Agent 需要，应由包外进程/受保护存储管理，不写入配置、命令行或日志。

## 环境

- Windows 10/11；
- Node.js `>= 24.12.0`；
- pnpm `11.19.0`；
- ARDY 推理需 NVIDIA GPU（RTX 4060 8GB 实测通过）+ Python 3.11 环境（权重与运行时为本机外部资源，不入库）；
- Wallpaper Engine（真实壁纸验收需要；已有记录使用 2.8.42）。

## 安装与验证

```powershell
pnpm install --frozen-lockfile
pnpm verify
```

分别启动 Companion 与壁纸开发服务器：

```powershell
pnpm dev:companion   # 端口 32145，启动时自动拉起 ARDY Bridge 子进程
pnpm dev:wallpaper   # 端口 4173
```

浏览器打开 `http://127.0.0.1:4173` 即可预览。

## 本地角色与动作配置

`rayure.local.json`（Git 排除）配置本机资源绝对路径：

```json
{
  "model": {
    "id": "shimakaze-live2d",
    "displayName": "Shimakaze (Live2D)",
    "format": "live2d",
    "path": "D:\\...\\daofeng_5.model3.json"
  },
  "motionSemantic": {
    "cachePath": "D:/.../motion-features.json",
    "ardy": {
      "command": "D:/.../python.exe",
      "args": ["D:/.../ardy-bridge.py", "--ardy_path", "...", "--checkpoints_dir", "...", "--model", "core"],
      "requestTimeoutMs": 60000
    },
    "startupGenerate": [
      { "id": "wave.casual", "prompt": "A person waves their hand casually", "numFrames": 60 }
    ],
    "idlePool": {
      "lookaheadMs": 1200,
      "handoffMs": 180,
      "actions": [
        { "id": "idle.breathe", "prompt": "stand naturally and breathe calmly", "numFrames": 120 },
        { "id": "idle.shift", "prompt": "subtly shift weight while waiting", "numFrames": 120 }
      ]
    },
    "scene": {
      "transform": { "origin": [0, 0, 0], "scale": 1 },
      "entities": [
        { "id": "tea-cup", "position": [0.3, 0.8, 0.4] }
      ]
    }
  }
}
```

- `model.format` 支持 `pmx`（3D 基线）与 `live2d`（当前主线）；
- `startupGenerate` 的 `id`/`prompt` 需与缓存条目的 `cacheKey`/`canonicalPrompt` 一致才会命中；
- `idlePool.actions` 使用同样的 `id`/`prompt` 语义缓存键；`lookaheadMs` 控制提前生成窗口，`handoffMs` 控制跨段交接窗口，且 handoff 不得大于 lookahead；
- 如果没有 `startupGenerate`，配置 idle pool 后 Companion 会从 actions 的第一项开始待机；若存在启动预设，最后一个预设只有在其 id 位于 idle pool 时才会被自动接管为待机头段；
- 可由行为层调用 `submitIntent({ ..., target: { entityId: 'tea-cup', joint: 'RightHand', timeMs: 200 } })`；坐标仅形成空间约束，不改变语义 cache key。当前 Bridge 支持 `Hips`、双手和双脚目标，FullBody 约束仍是后续能力；
- 角色、动作、embedding 缓存、录制和场景素材均被 Git 排除；Renderer 只接收一次性回环 URL，不接收磁盘路径。

调试入口：`?3dDebug=1`（3D 调试工作台，见上文）、`?live2dDebug=1`（参数探针、原生动作和 ARDY 生成控件）、`?live2dModelUrl=...`（手动指定模型）、`?live2dCoreUrl=...`（Core 来源）。

## 私有资产与发布边界

- 本仓库的 Apache-2.0 许可证只覆盖有权以该许可证发布的项目代码与文档；
- 购买或来自其他项目的角色、场景、动作、纹理和录屏不会进入 Git；
- `scratch/` 属于本机实验/素材位置，不是公开源码的一部分（日式房间贴图通过 dev-only Vite 中间件从 scratch 归档提供，构建产物不含私有场景）；
- 正式发布必须改用明确允许再分发的默认素材，或改为由用户从包外配置自己的素材。

3D 能力保持冻结回归基线，只做必要的安全修复；主要开发方向为 Live2D + 生成式动作。

## 下一阶段

1. **约束交互**：把目前的 Hips/手/脚 Root2D/EndEffector 扩展到经实测的 FullBody 约束和动态场景采样；
2. **真实 provider 与实机验收**：用实际 ASR/Agent/TTS/MediaPipe 模型替换 fixture，完成真实麦克风、摄像头、Wallpaper Engine CEF 和长时间运行验收；
3. **产品化**：完善首次配对、设置、自启动、多显示器、睡眠唤醒、更新与 Workshop 发布边界；
4. Live2D 闭环稳定后，让现有 3D Renderer 作为第二个 Rig Adapter 回归。

## 尚未完成

- 经过实机验证的 FullBody ARDY constraints（当前只开放 Hips、双手、双脚）；
- 合规获取的离线 Cubism Core 文件，以及本轮生成播放在 Wallpaper Engine CEF 中的画面、DevTools、暂停/恢复实机验收；
- LiveTalker 实际 SenseVoice/DeepSeek/Qwen3-TTS 的模型质量、API Key、麦克风权限和长时间运行验收（兼容接口与无依赖模拟已完成）；
- 首次配对、设置界面、自动启动、升级、多显示器、睡眠唤醒和长时间稳定性验收；
- 可公开再分发的默认角色/场景与正式 Wallpaper Engine Workshop 包。

## License

项目代码与文档按 [Apache License 2.0](LICENSE) 发布。第三方素材遵循各自许可证，未明确授权再分发的素材不属于本仓库发布内容。
