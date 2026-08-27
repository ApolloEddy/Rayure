# ARDY → MediaPipe / MiKaPo → MMD Phase 1 记录

日期：2026-08-27
实施分支：`codex/ardy-mikapo-poc`
基线提交：`a23f2ec`（Phase 0 边界记录）

## 交付内容

- `apps/wallpaper/src/ardy3d/core-skin-frame-source.ts`
  - `ArdyMotionSource`：校验 `rayure.motion.v1`，精确 `seek` / `step` / `reset`。
  - `CoreSkinInferenceRenderer`：固定 512×512、固定相机、固定像素比、无网格/文字/overlay；不启动内部 `requestAnimationFrame`。
  - `renderFrame()` 按原始 `timeMs` 渲染，`captureBitmap()` 输出 `ImageBitmap`，并提供可选 `CanvasWebmRecorder`。
  - `mediaTimeToVmdFrame()` 固化 20 FPS 时间戳到 VMD 30 FPS 的换算。
- `apps/wallpaper/src/ardy3d/frame-inspector.ts` 与 `apps/wallpaper/ardy-frame-inspector.html`
  - 开发态单页 inspector：加载 fixture/本地 JSON、播放/暂停、逐帧、复位、滑块定位、PNG/WebM 导出。
  - 文件名只显示清洗后的 basename，不记录本地绝对路径；快速点击通过单一 operation token 丢弃旧定时器结果。
- `apps/wallpaper/vite.config.ts`
  - 只在 dev server 增加两个固定 allowlist：现有 CoreSkin fixture 与根目录 `.walk-motion.json`；目录遍历返回 400，生产包不提供该路由。

## 验证证据

| 层级 | 命令/观察 | 结果 |
|---|---|---|
| 单元测试 | `pnpm --filter @rayure/wallpaper test` | 93/93 passed |
| TypeScript | `pnpm --filter @rayure/wallpaper typecheck` | passed |
| 构建 | `pnpm --filter @rayure/wallpaper build` | passed；正式入口仍为 `dist/index.html` |
| Edge 普通浏览器 | `http://127.0.0.1:4173/ardy-frame-inspector.html` | CoreSkin 512×512、首帧 38,046 非背景像素、60 帧/20 FPS |
| 逐帧 | 点击“下一帧” | `0 ms → 50 ms`，frame `0 → 1` |
| 播放 | 点击“播放” | 到达 frame `59/59`、`2950 ms`，状态 `Completed` |
| WebM | 点击“录制 WebM” | 下载成功，`.playwright-cli/rayure-ardy-source-1787828528858.webm`，231,484 bytes |
| PNG | 点击“下载当前帧 PNG” | 下载成功，`.playwright-cli/rayure-ardy-frame-59.png`，63,803 bytes |
| fixture 资源 | `GET /@rayure-assets/core-skin-data.json` | HTTP 200，1,306,162 bytes |
| motion 资源 | `GET /@rayure-assets/walk-motion.json` | HTTP 200，466,778 bytes |
| 路径边界 | `GET /@rayure-assets/..%2F.walk-motion.json` | HTTP 400 |

## 仍未关闭的门

- 未读取本地 PMX；Phase 1 只证明 CoreSkin source renderer。
- 未运行 MediaPipe、MiKaPo、VMD roundtrip 或任何真实动作转换。
- Edge/普通 Chromium 通过不代表 Wallpaper Engine CEF 通过。
- `.playwright-cli` 下的截图/下载物是本地验收证据，未加入 Git。

## 下一步

进入 Phase 2：把本阶段 WebM 交给未修改的、已锁定 commit 的原版 MiKaPo，加载一个用户本地 PMX，导出并重新载入 VMD；失败时先按 source / detection / calibration / model / export 分段定位。
