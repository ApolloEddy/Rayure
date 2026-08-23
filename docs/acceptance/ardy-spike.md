# ARDY Spike 实机验收

状态：**2026-08-23 Windows 实机通过，端到端闭环打通**（4060 Laptop 8GB，ComfyUI venv junction 复用 torch 2.8.0+cu126，checkpoint 走 hf-mirror）

## 端到端实测（2026-08-23，真 bridge + 真权重）

配置 `rayure.local.json`（机器本地，不入 Git）指向 `D:\Dev\ardy-spike`（venv / ardy 源码 / checkpoints / 假 feature 缓存），启动 Companion：

```
{"event":"companion.ready",...,"motionSemanticCacheEntries":2,"ardyAvailable":true}
published: id=wave.casual   format=canonical frames=60 schema=rayure.motion.v1
published: id=walk.forward  format=canonical frames=60 schema=rayure.motion.v1
E2E PASS
```

- startupGenerate 两条意图（各 60 帧 = ARDY 两步生成后裁剪，第二条从前一条的内部 history 续写）经真实子进程、真权重生成，`motion.published` 广播给壁纸客户端，生成的 Canonical Motion 可经回环 tokenized URL 拉取校验；
- Companion 63/63 测试与 typecheck 通过；
- 待真实词向量落地：只需把 AutoDL 产出的 embedding 按 `rayure.motion-semantic-cache.v1` 写入 `cachePath` 指向的 JSON（或换 `cachePath`），链路即产出真实语义驱动的动作——无需再改任何代码。

### Bridge 参考实现实测修正（scripts/ardy-bridge.py）

首跑暴露并修复了四个参考实现缺陷，均已落库：

1. `load_model` 关键字为 `modelname`（非 `checkpoint`），且 `text_encoder` 必须显式传 `False`（默认 `None` 会去构建 Llama 编码器）；
2. ARDY 加载与三方库会把诊断信息（模型 config 等）打到 stdout，污染 JSONL 协议流——`ProtocolWriter` 在 fd 级别把 stdout 永久重定向到 stderr，协议输出走保留的原 stdout fd；
3. `foot_contacts` 是 4 通道（左/右脚跟+脚尖，来自 `skeleton.{left,right}_foot_joint_idx`），不是 27 关节按位对应——按 skeleton 索引映射到关节名；
4. `numFrames` 语义按"新增帧数"实现：ARDY 每步固定生成 `gen_horizon_len`（40）帧且窗口须为 `num_frames_per_token` 倍数，bridge 内部循环多步（window = history + horizon，history 超 `10s×fps − horizon` 时按 nfp 对齐裁尾）、逐步解码取新增尾部、拼接送回前 `numFrames` 帧；返回值含 history 部分必须切掉（spike 脚本的 `torch.cat` 曾双重计入）。

`ArdyProcessClient` 同步修正两点：abort 只放弃等待不再杀子进程（抢占是常态调度事件，杀进程会让后续所有生成失败；迟到响应行按 requestId 丢弃）；stdin 管道异步 error（EPIPE/EOF）接入失败路径而不是击穿 Companion 进程。

## 实测结果（RTX 4060 Laptop 8GB，无文本编码器）

| 指标 | 实测值 |
|---|---|
| 模型加载 | 1.1 s |
| 显存占用（含桌面已占约 7.5 GB 的运行环境） | **约 2.0 GB** |
| 首段延迟（40 帧 / 2.0s 动作，4 步去噪） | **0.28 s**（约 7x 实时） |
| 续写步进（80/160/200 帧窗口） | **0.08–0.09 s / 步** |
| 解码（unnormalize + inverse） | 0.07 s |
| 输出 | `posed_joints [1,200,27,3]`、`foot_contacts [1,200,4]` |

结论：本地只跑动作模型 + embedding 外置缓存的方案在 8GB 显存上**充分可行**——占用仅约 1/4，生成速度约为实时播放的 7 倍以上，续写步进随窗口增长仍稳定在 0.1s 内。

复现实测的脚手架（包外，不入 Git）：`D:\Dev\ardy-spike\spike_run.py`（环境 `D:\Dev\ardy-spike\.venv`，`PYTHONPATH=D:\Dev\ardy-spike\ardy`，checkpoint 在 `D:\Dev\ardy-spike\checkpoints\ARDY-Core-RP-20FPS-Horizon40`，约 730 MB：denoiser 594 MB + tokenizer 135 MB）。

### 实测中的关键 API 语义（写入 Bridge 的依据）

- `load_model(modelname, device='cuda', text_encoder=False, checkpoints_dir=...)`：官方原生支持无文本编码器加载；
- `autoregressive_step` 的 **`num_frames` 是整个窗口（history + generation）的帧数**，不是新生成帧数；续写时必须传 `history_len + gen_horizon_len`；
- history 累计超出训练窗口（10s×fps）时按 `num_frames_per_token` 对齐裁剪尾部；
- `autoregressive_step` 返回值是**本步生成窗口**（不含输入 history），续写需自行 `torch.cat` 累积；
- 假 feature（全零 `text_feat [1,N,4096]` + pad mask）即可驱动完整推理，验证了缓存特征方案的可行性。

## 范围

本验收只桥接 ARDY 官方模型输出与 Rayure 的 `rayure.ardy-motion.v1 → Canonical Motion` 链路，实测 4060 8GB 上的显存、首段延迟、连续生成与打断恢复。真实权重、检查点、Hugging Face 授权与 Python 环境均属包外，不进入 Git 或发布包。

## 已核实的前置事实（2026-08-23）

### 关节定义完全对齐

官方 `CoreSkeleton27`（`ardy/skeleton/definitions.py`）的 27 关节名与顺序，与 `apps/companion/src/ardy-motion-adapter.ts` 的 `ARDY_CORE_JOINT_NAMES` 完全一致：

```
Hips, Spine, Spine1, Spine2, Spine3, Neck, Head,
RightShoulder, RightArm, RightForeArm, RightHand, RightHandEnd, RightHandThumb1,
LeftShoulder, LeftArm, LeftForeArm, LeftHand, LeftHandEnd, LeftHandThumb1,
RightUpLeg, RightLeg, RightFoot, RightToeBase,
LeftUpLeg, LeftLeg, LeftFoot, LeftToeBase
```

上层 `Canonical Motion v1`（`ardy-core-27`）与 RigProfile 映射无需改动。

### 模型与许可证

| 模型 | 骨架 | FPS | Horizon | HF | 许可 |
|---|---|---|---|---|---|
| ARDY-Core-RP-20FPS-Horizon40 | Core | 20 | 40 | nvidia/ARDY-Core-RP-20FPS-Horizon40 | NVIDIA Open Model |
| ARDY-Core-RP-20FPS-Horizon8 | Core | 20 | 8 | nvidia/ARDY-Core-RP-20FPS-Horizon8 | NVIDIA Open Model |

### 环境依赖

- 官方主要在 Ubuntu 22.04 + RTX 4090 + nvidia-driver-575 + Python 3.11 测试；
- PyTorch >= 2.4（先按本机 CUDA 装，再 `pip install -e ".[all]"`）；
- 安装需编译 motion-correction C++ 扩展：CMake >= 3.15 + C++17（`sudo apt install cmake build-essential`）；
- 文本编码器依赖 **gated** `meta-llama/Meta-Llama-3-8B-Instruct`，需 Hugging Face 授权 + 运行时 token。

### 文本编码器（与 Rayure 设计对齐）

ARDY 文本条件用 LLM2Vec + Llama-3-8B-Instruct，默认 `cuda / bfloat16` 约 14GB VRAM；可切 `cpu` 降显存。官方另有独立的
`scripts/run_text_encoder_server.py` 以常驻服务复用编码器——这与 Rayure 的 `MotionSemanticFeatureCache` + `TextEncoderApiClient`
（AutoDL 批量预编码 → 本地缓存 → miss 才调 API）方案天然对应，不需要在本机常驻 Llama。

## 输出契约

`scripts/generate.py` 产出 `.npz`：`posed_joints`（world-space 关节位置 `[T, J, 3]`）、local/global rotations、root positions、foot contacts、`fps`、`text`。交互式入口为 `load_model()` + `Ardy.autoregressive_step()`（text embedding + 可选约束 → motion frames）。

## Bridge 待实现（包外）

**参考实现已落仓库：[`scripts/ardy-bridge.py`](../../scripts/ardy-bridge.py)**（仓库内作为参考，运行时在 ARDY Python 环境内执行）：

- 请求/结果/错误/取消四种消息形态，与 `apps/companion/src/ardy-process-protocol.ts` 冻结协议一一对应；
- `load_model(text_encoder=False)` 显式不加载文本编码器，`text_feat`/`text_pad_mask` 直接来自 Rayure 的 `Motion Semantic Feature Cache`（`values` 按行主序 `[tokenCount, 4096]` 重排）；
- 调用 `autoregressive_step(num_frames, num_denoising_steps, motion_mask=None, observed_motion=None, cfg_weight=(w, w), texts=None, text_feat, text_pad_mask, init_history_sequence, init_global_translation, init_first_heading_angle)`，输出经 `motion_rep.unnormalize` → `motion_rep.inverse` 取 `posed_joints`/`global_rot_mats`/`foot_contacts`；
- 旋转矩阵转 `[x, y, z, w]` 四元数，帧时间按 `fps` 步进，脚接触按 skeleton 索引把 4 通道（左/右脚跟+脚尖）映射为关节名；
- **续写策略（Spike 简化）**：Bridge 进程内有状态——保留上一步归一化 motion tensor 作为下一次的 `init_history_sequence`（ARDY 的 history 是其自身 hybrid 表示，posed_joints 无法直接回喂）；请求里的 Canonical `history` 字段在 Bridge 无内部状态时经 `motion_rep.forward` 转换，装到的版本不含该 API 则明确报错；
- 启动失败（`checkpoints_dir` 缺失/模型加载失败）以 `startup` requestId 输出结构化错误退出。

对接 `ArdyProcessClient` 的 `rayure.local.json` 示例（实测在用，`--ardy_path` 在 ardy 未 pip 安装时必需）：

```json
{
  "motionSemantic": {
    "cachePath": "D:/Dev/ardy-spike/motion-features.json",
    "ardy": {
      "command": "D:/Dev/ardy-spike/.venv/Scripts/python.exe",
      "args": [
        "D:/CodingProjects/Mixed_Language/Rayure/scripts/ardy-bridge.py",
        "--ardy_path", "D:/Dev/ardy-spike/ardy",
        "--checkpoints_dir", "D:/Dev/ardy-spike/checkpoints",
        "--model", "core"
      ],
      "requestTimeoutMs": 60000
    },
    "startupGenerate": [{ "id": "wave.casual", "prompt": "casually wave" }]
  }
}
```

## Spike 验收项

1. **跑通**：Windows 直跑（不依赖 WSL2）——Python 3.11 venv + CUDA 版 PyTorch + `pip install -e .`（可选 C++ postprocess 扩展允许编译失败，`--no-postprocess` 规避），加载 Core-Horizon40 检查点出 `.npz`；
2. **显存**：4060 8GB 上「动作模型 only + 文本编码器 CPU/缓存」是否放得下；记录峰值显存与 OOM 边界；
3. **首段延迟**：text 命中缓存后，`autoregressive_step` 到首段 motion 的延迟（是否 < 播放时长的 replan buffer）；
4. **连续生成**：多步 autoregressive 是否稳定、不含历史裁剪地流式产出；
5. **打断恢复**：`cancel` 能否中断当前 step，之后用当前姿态 history 续写下一段（对应 `MotionScheduler` 的抢占/续写语义）；
6. **Bridge 对接**：以上流程经 Python Bridge 走通 JSONL 协议，`convertArdyMotion` 无拒绝、`validateCanonicalMotion` 通过。

## 未关闭项

- 真实 ARDY 权重、WSL2/Ubuntu 环境、Hugging Face 授权 token 均为包外，未在本仓库完成；
- `scripts/run_text_encoder_server.py` 与 `TextEncoderApiClient` 的端点契约尚未实测对接；
- 4060 8GB 若放不下动作模型，需回落到 Horizon8 或降低 `numFrames`，仍需实测定论。