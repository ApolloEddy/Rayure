# ARDY → MediaPipe / MiKaPo → MMD Phase 3 记录

日期：2026-08-29
实施分支：`codex/ardy-mikapo-poc`
前置记录：`docs/acceptance/ardy-mikapo-phase2.md`

## 本阶段目标

只验证一条演示通路：页面候选动作 → 回环 Companion → 真实 ARDY 推理 → `motion.published` Canonical Motion → CoreSkin27 源帧 → MediaPipe Holistic 33 → MiKaPo Solver → MMD 模型自动播放。演示页不再把静态 Canonical Motion 夹具当作正常候选动作。

## 运行边界

演示页运行在本机隔离的 MiKaPo GPL Workbench（`scratch/ardy-mikapo-poc/upstream/MiKaPo/`）。该目录被 `.gitignore` 排除；上游源码、用户模型/贴图、ARDY 权重、语义缓存和生成动作文件均保持外部只读或本地临时状态，不进入 Rayure tracked tree、`public/`、`dist/` 或发布包。

## 真实生成证据

| 项目 | 观测值 |
|---|---|
| Companion | `127.0.0.1:32145`，`modelAvailable=true`、`ardyAvailable=true` |
| Motion Semantic Cache | `30,011` 条；当前运行不依赖 Text Encoder |
| 默认候选 | `A person walks forward slowly`，`60` 帧、`20` FPS、`27` 关节 |
| 第二候选 | `A person jumps up and down`，现场返回 `39` 帧、`20` FPS、`27` 关节 |
| 生成来源 | `live-companion-ardy`，不是静态 fixture |

通过独立 WebSocket probe 观察到 Companion 接受 `motion.generate`，并返回可校验的 `rayure.motion.v1` / `ardy-core-27` Canonical Motion。页面只接受回环地址的 tokenized motion URL，下载后再次执行 Canonical Motion 结构校验。

## 页面验收

在 `http://127.0.0.1:4000/pipeline` 的可见 Chromium 页面中：

- 下拉框显示 8 个真实 ARDY 候选：缓慢向前走、单手挥手问候、双臂热情挥舞、连续拍手、原地跳跃、向前鞠躬、单腿前踢、抱臂原地转身；
- 首次加载自动请求“缓慢向前走”，按钮进入“暂停”状态，帧进度持续变化；
- 切换到“原地跳跃”并点击“实时生成并播放”后，遥测显示 `实时 · 原地跳跃`、`20 fps / 27 关节`、`33 Landmarks`、`51 骨骼驱动`；
- 观察到 `29 / 39 → 39 / 39 → 1 / 39`，证明动作完成后按循环设置重新从首帧播放，而不是停在静态页面或最后一帧；
- 可见模型画面、Pose33 监视器和骨骼 Euler 探针同步更新。

## Rayure 外层门禁

| 门禁 | 结果 |
|---|---|
| `pnpm --filter @rayure/wallpaper test` | 93/93 passed |
| `pnpm --filter @rayure/wallpaper typecheck` | passed |
| `pnpm --filter @rayure/wallpaper build` | passed |
| MiKaPo Workbench `npx tsc --noEmit` | passed |
| Wallpaper Engine CEF | 未执行 |

普通 Chromium/WebGPU 的可见验证不等于 Wallpaper Engine CEF 验收；本阶段只关闭演示页和本地实时生成链路门禁。

## 阶段结论

- [x] 多候选入口已恢复为真实 ARDY 生成，不再默认展示单个静态动作。
- [x] 生成结果自动进入播放状态，并通过 MediaPipe 33 点与 MiKaPo 51 骨骼驱动到当前 MMD 模型。
- [x] 外层 Rayure 代码、类型检查、测试和生产构建门禁通过。
- [ ] Wallpaper Engine CEF 中的实际可视播放仍需单独验收。
- [ ] 相机视角同步、抖动滤波和服饰碰撞属于后续能力，不把本阶段动作通路通过误报为这些能力已完成。
