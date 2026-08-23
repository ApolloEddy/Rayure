# Rayure

Rayure 是一个面向 Wallpaper Engine 的本地优先桌面角色运行时。它不依赖 AIRI，由 Wallpaper Renderer 负责画面与角色表现，由只监听回环地址的 Companion 负责本地资源、协议和 AI 动作生成。

## 当前状态

**语义动作生成端到端闭环已打通并在真实硬件上验收**：文本意图 → 语义特征缓存 → ARDY 扩散模型（本地 GPU）→ Canonical Motion → 令牌化广播 → Live2D 角色实时播放。全程无云端推理依赖。

```text
Rayure Behavior（未来 ASR/LLM 意图层）
  -> 动作意图 / Prompt
  -> Motion Semantic Feature Cache（AutoDL 一次性预置，30k 条）
  -> ARDY Bridge（本地 Python 子进程，RTX 4060 实测）
  -> Canonical Motion（27 关节，renderer 无关）
  -> 令牌化 motion.published 广播
  -> Rig Adapter
       |- Live2D Adapter（当前主线，Hiyori 已验收）
       `- 3D Adapter（冻结回归基线）
```

已完成的里程碑：

- **ARDY Bridge**（`scripts/ardy-bridge.py`）：JSONL 协议子进程，在 RTX 4060 8GB 上以真实权重运行；支持 history 续写（连续动作不打断）、请求超时与取消、stdout 重定向防协议污染；首段实测修复了官方参考实现的 6 处缺陷（参数名、text_encoder 加载、foot_contacts 骨骼映射、numFrames 语义、history 重复计数等）。
- **云端词向量生产线**（`autodl/`）：DeepSeek 按 21 类动作 × 速度/幅度/情感/方向四维修饰批量展开意图字典，AutoDL 24GB 卡用 LLM2Vec（llama-3-8b）一次性编码为 30,011 条语义特征（fp16 / 4096 维 / 约 323 MB），本地 Companion 启动即缓存命中，**运行时完全不需要文本编码器**。
- **MotionScheduler 连续调度**：真实时间推进、抢占式打断在途生成、把已消费段作为 history 续写下一段——离散文生模型因此成为连续可打断的动作引擎。
- **Live2D 原生渲染**：Hiyori 官方示例模型在浏览器与 Wallpaper Engine 中正常显示；修复了画布拉伸变形、3D 占位装饰遮挡、私有场景贴图加载挂起等显示问题。

`CHANGELOG.md` 已记录到 `0.6.0-dev`（此前的 3D 记录为 0.4.8），根工作区 manifest 仍为 0.2.0。本仓库应视为开发快照。当前统一验证 136 项测试、TypeScript、生产构建与发布边界审计全部通过。

## 已实现

- Wallpaper Engine 官方 Web wallpaper 项目、用户属性、中英文本地化、FPS 与暂停生命周期；
- Three.js + `@yohawing/three-mmd-loader` 的外置 PMX、材质和中文纹理加载（冻结基线）；
- 仅绑定 `127.0.0.1`、固定使用 `/ws` 的 Local Companion；
- 严格版本化协议、16 KiB 消息上限、未知字段拒绝和握手状态校验；
- 随机会话令牌保护的只读模型/动作网关，以及 Origin、方法、扩展名、大小和 realpath 边界校验；
- 严格的 27 关节 `Canonical Motion v1` 合同与校验；
- Live2D：`.model3.json` 清单校验、标准参数 RigProfile、原生 Cubism 调试画布（Core 来源受控）、motion3 动作目录与播放、Canonical Motion 运行时播放；
- ARDY 动作生成：进程协议、语义特征缓存（内存/文件、fp16/fp32、token mask）、Text Encoder API 客户端（可选）、启动预设生成与实时意图入口 `globalThis.rayureMotionGeneration`；
- 模型和动作异步加载的 generation 隔离、失败保留、迟到结果释放与资源清理；
- `scripts/verify.ps1` 统一执行测试、TypeScript、生产构建、依赖审计和发布边界检查。

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
       |- MotionScheduler（打断/续写调度）
       `- ARDY Bridge 子进程（JSONL / stdio）
                 |
                 v
           本地 GPU 推理（RTX 4060 实测）
```

详细设计见 [目标架构](docs/architecture.md)，旧项目的保留、改造和淘汰项见 [迁移矩阵](docs/migration-matrix.md)，验收记录见 [M0](docs/acceptance/m0-foundation.md)、[M1](docs/acceptance/m1-wallpaper-engine-pmx.md)、[M2 Live2D](docs/acceptance/m2-live2d.md) 与 [ARDY Spike](docs/acceptance/ardy-spike.md)。

## 动作生成链路

1. **字典编译（一次性，云端）**：`autodl/generate-dictionary.py` 用 DeepSeek 展开意图种子；`autodl/generate-embeddings.py` 在 AutoDL 上用 LLM2Vec 批量编码，产出 `motion-features.json`（`rayure.motion-semantic-cache.v1`，上限 512 MiB / 10 万条）。详见 [autodl/README.md](autodl/README.md)。
2. **本地运行**：Companion 启动时加载缓存（30k 条约 40 秒），`startupGenerate` 预设直接缓存命中并生成；运行时可通过 `globalThis.rayureMotionGeneration.submitIntent(...)` 注入新意图。
3. **生成与发布**：ARDY Bridge 按请求生成新帧（numFrames 为新增帧数，内部多步自回归 + history 裁剪），转成 Canonical Motion 后由 Companion 以 `/assets/<token>/<motionId>.json` 提供并广播。
4. **播放**：Wallpaper 收到 `motion.published` 后经令牌化 URL 拉取、严格校验，交给 `CanonicalMotionPlayer` 驱动 Live2D 参数 sink；generation 隔离保证旧意图的迟到结果不会覆盖新动作。

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
    "id": "hiyori-live2d",
    "displayName": "Hiyori (Live2D)",
    "format": "live2d",
    "path": "D:\\...\\Hiyori.model3.json"
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
    ]
  }
}
```

- `model.format` 支持 `pmx`（3D 基线）与 `live2d`（当前主线）；
- `startupGenerate` 的 `id`/`prompt` 需与缓存条目的 `cacheKey`/`canonicalPrompt` 一致才会命中；
- 角色、动作、embedding 缓存、录制和场景素材均被 Git 排除；Renderer 只接收一次性回环 URL，不接收磁盘路径。

调试入口：`?live2dDebug=1`（参数探针）、`?live2dModelUrl=...`（手动指定模型）、`?live2dCoreUrl=...`（Core 来源）。

## 私有资产与发布边界

- 本仓库的 Apache-2.0 许可证只覆盖有权以该许可证发布的项目代码与文档；
- 购买或来自其他项目的角色、场景、动作、纹理和录屏不会进入 Git；
- `scratch/` 属于本机实验/素材位置，不是公开源码的一部分（日式房间贴图通过 dev-only Vite 中间件从 scratch 归档提供，构建产物不含私有场景）；
- 正式发布必须改用明确允许再分发的默认素材，或改为由用户从包外配置自己的素材。

3D 能力保持冻结回归基线，只做必要的安全修复；主要开发方向为 Live2D + 生成式动作。

## 下一阶段

1. **播放质量**：Canonical Motion 帧间插值（当前 20fps step 保持，60fps 渲染下有阶梯感）；待机回落从调试 fixture 切换为原生 Idle / ARDY 待机池；
2. **衔接与预取**：replan buffer 式提前生成（NVIDIA 交互 demo 同款策略），播放侧姿态快照 crossfade 兜底；
3. **约束交互**：Bridge 接入 ARDY constraints（Root2D / EndEffector / FullBody），语义 embedding 与空间约束正交复用，支撑接触类动作；
4. **行为层**：ASR/LLM 意图接入 `submitIntent`，TTS 口型与视觉派生事件；
5. Live2D 闭环稳定后，让现有 3D Renderer 作为第二个 Rig Adapter 回归。

## 尚未完成

- 帧间插值、待机池与动作间平滑过渡（当前已知：待机回落到调试 fixture、20fps 无插值）；
- ARDY constraints 管线（协议扩展 + Bridge 载荷 + 场景实体注册表）；
- 合规获取的离线 Cubism Core 文件与 Wallpaper Engine CEF 完整实机验收（DevTools、暂停恢复）；
- ASR、LLM、TTS、口型和音频播放；
- 摄像头、MediaPipe 与最小化派生视觉事件；
- 首次配对、设置界面、自动启动、升级、多显示器、睡眠唤醒和长时间稳定性验收；
- 可公开再分发的默认角色/场景与正式 Wallpaper Engine Workshop 包。

## License

项目代码与文档按 [Apache License 2.0](LICENSE) 发布。第三方素材遵循各自许可证，未明确授权再分发的素材不属于本仓库发布内容。
