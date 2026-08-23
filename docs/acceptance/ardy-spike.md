# ARDY Spike 实机验收

状态：前置事实已核实，实机 Spike 待执行（需 WSL2 + 权重 + 授权）

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
- `load_model(text_encoder=None)` 显式不加载文本编码器，`text_feat`/`text_pad_mask` 直接来自 Rayure 的 `Motion Semantic Feature Cache`（`values` 按行主序 `[tokenCount, 4096]` 重排）；
- 调用 `autoregressive_step(num_frames, num_denoising_steps, motion_mask=None, observed_motion=None, cfg_weight=(w, w), texts=None, text_feat, text_pad_mask, init_history_sequence, init_global_translation, init_first_heading_angle)`，输出经 `motion_rep.unnormalize` → `motion_rep.inverse` 取 `posed_joints`/`global_rot_mats`/`foot_contacts`；
- 旋转矩阵转 `[x, y, z, w]` 四元数，帧时间按 `fps` 步进，脚接触只保留 `LeftFoot`/`RightFoot`；
- **续写策略（Spike 简化）**：Bridge 进程内有状态——保留上一步归一化 motion tensor 作为下一次的 `init_history_sequence`（ARDY 的 history 是其自身 hybrid 表示，posed_joints 无法直接回喂）；请求里的 Canonical `history` 字段在 Bridge 无内部状态时经 `motion_rep.forward` 转换，装到的版本不含该 API 则明确报错；
- 启动失败（`checkpoints_dir` 缺失/模型加载失败）以 `startup` requestId 输出结构化错误退出。

对接 `ArdyProcessClient` 的 `rayure.local.json` 示例：

```json
{
  "motionSemantic": {
    "cachePath": "D:/Dev/ardy-spike/motion-features.json",
    "ardy": {
      "command": "D:/Dev/ardy-spike/.venv/Scripts/python.exe",
      "args": ["D:/CodingProjects/Mixed_Language/Rayure/scripts/ardy-bridge.py", "--checkpoints_dir", "D:/Dev/ardy-spike/checkpoints", "--model", "core"],
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