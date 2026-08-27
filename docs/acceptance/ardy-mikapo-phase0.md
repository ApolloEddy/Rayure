# ARDY → MediaPipe / MiKaPo → MMD Phase 0 记录

日期：2026-08-27
实施分支：`codex/ardy-mikapo-poc`
Rayure 基线：`94db6e2` (`main` 创建隔离分支时的 HEAD)

## 已锁定的外部 PoC 来源

MiKaPo 只作为本地隔离 GPL 工作区使用，路径为 `scratch/ardy-mikapo-poc/upstream/MiKaPo/`。该目录被 `.gitignore` 覆盖，不属于 Rayure tracked tree，也不进入 `public/`、`dist/` 或发布包。

| 项目 | 锁定值 | 证据 |
|---|---|---|
| MiKaPo repository | `3beba37925378820710c50e5e82e266396842680` | `git -C scratch/ardy-mikapo-poc/upstream/MiKaPo rev-parse HEAD` |
| MiKaPo package | `4.2.0`, `package-lock.json` lockfile v3 | 上游 `package.json` / `package-lock.json` |
| `@mediapipe/tasks-vision` | `0.10.32` | integrity `sha512-3tiAZnmKloYnRXYoO3dKltTUGnqeCwzC4lV03uY0vCsE+aveJTyEVQyZHOlQGQNsjK+gRHzkf9q08C99Qm2K0Q==` |
| `reze-engine` | `0.50.7` | integrity `sha512-Ujx880hLYR7QVfILrEUr8K3poeakuDXSkfn2wX1Rn/XOGviBko82gysFrno5ZGQH4Usa5ehunFuv2wLRZI7mdg==` |
| MiKaPo license | GPL-3.0 | 上游 `LICENSE` |
| Reze Engine license | MIT | npm registry metadata for `reze-engine@0.50.7` |

## 资产与读写边界

- CoreSkin fixture、ARDY 权重导出物、PMX、纹理、动作、视频、VMD 和截图继续放在仓库外部或已忽略的 `scratch/`；不复制到 Rayure 源码、`public/`、`dist/` 或 Git。
- Phase 1 只使用现有 `scratch/ardy3d/core-skin-data.json` 作为源渲染 fixture；不加载本地 PMX。PMX 留到 Phase 2，并且必须由用户选择外部只读来源。
- Rayure 继续使用现有的 tokenized loopback / Vite dev-only 资源路由；任何资源请求不得接受任意磁盘路径或目录遍历。
- MiKaPo solver 源码不得复制到 Apache-2.0 的 Rayure package。若后续需要 Workbench，继续在隔离 GPL 工作区通过最小输入协议调用。

## Phase 0 完成标准

- [x] 从当前 `main` 建立隔离实施分支。
- [x] 锁定 MiKaPo commit、版本、MediaPipe 版本、Reze 版本与完整性值。
- [x] 建立外部 GPL PoC 工作区，且未把第三方源码加入 Rayure tracked tree。
- [x] 写明私有资产、外部 fixture、证据和发布包边界。
- [x] 未启动浏览器、构建、真实模型或 Wallpaper Engine CEF 验收。

## 下一步

进入 Phase 1，只实现确定性 CoreSkin 帧源与 frame inspector；完成后先报告代码/定向测试证据，再决定是否进入 Phase 2 的 stock MiKaPo gold path。
