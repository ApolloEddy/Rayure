# StereoModelPlugin → Rayure 迁移矩阵

审计源：`D:\CodingProjects\Mixed_Language\StereoModelPlugin` 当前本地 `main`（`57a8d5f`，比 `origin/main` 多 33 个提交）  
审计日期：2026-08-15  
旧仓库基线：95/95 TypeScript 测试通过，工作树在测试前无源码修改

## 结论

不能整体复制旧仓库。旧项目 0.7.1 已围绕 AIRI 0.11.3 重写，并通过架构守卫主动删除独立 Renderer、模型加载器和旧 .NET Host。Rayure 的宿主关系正好相反：它必须拥有 Wallpaper Renderer，并把 AIRI 降为未来可能存在的普通 Adapter。

迁移采用“先复制测试与纯算法，再更换宿主适配器”的绞杀式路线。每个模块必须先在旧仓库确认基线，再在 Rayure 用相同输入输出测试证明等价。

## 模块决策

| 旧模块 | 决策 | Rayure 目标 | 首个验证 |
|---|---|---|---|
| `stereo-plugin/src/motion/*` | 保留算法，重命名并迁移 | `packages/runtime-core/motion` | Idle、优先级、打断、冷却、A→B→C 混合测试等价 |
| `stereo-plugin/src/gesture/*` | 保留纯算法 | `packages/runtime-core/perception` | 静态举手、单向挥动、低置信度和冷却边界测试等价 |
| `stereo-plugin/src/reaction/*` | 保留策略思想，移除 Stereo/AIRI 命名 | `packages/runtime-core/reaction` | 仅白名单事件触发本地动作 |
| `stereo-plugin/src/parallax/*` | 保留纯算法 | `packages/runtime-core/parallax` | 校准、死区、丢失回中、非对称视锥测试等价 |
| `stereo-plugin/src/scene/*` | 保留事务状态机 | `packages/runtime-core/scene` | 替换失败保留旧场景、迟到结果释放 |
| `stage-binding/src/three-motion-backend.ts` | 改造 | `apps/wallpaper/src/render/three` | 由 Rayure 自有 Mixer 驱动，不依赖 AIRI Stage |
| `stage-binding/src/three-scene-asset-host.ts` | 改造 | `apps/wallpaper/src/render/three` | 使用 Rayure GLTFLoader，保持纹理/材质去重释放 |
| `stage-binding/src/three-off-axis-parallax-camera.ts` | 小改迁移 | `apps/wallpaper/src/render/three` | 普通 Chrome 与 Wallpaper Engine CEF 都通过视觉验收 |
| `stage-binding/src/contracts.ts` | 重写 | `packages/render-contracts` | Renderer 明确拥有 Scene、Camera、Mixer 和帧循环 |
| `stage-binding/src/current-airi-stage-binding.ts` | 淘汰 | 无 | 禁止出现在 Rayure 运行源码 |
| `airi-integration/**` | 淘汰运行耦合，仅参考生命周期测试 | 可选的未来 `adapters/airi`，默认不存在 | 核心构建、测试、运行均不解析 AIRI 包 |
| `asset-importer/**` | 已实现最小替代，后续扩展 | `apps/companion` 的受限资产服务 | M1 已覆盖随机令牌、Origin、扩展名、大小和 realpath；哈希/缓存留待正式资产库 |
| `tools/blender/**` | 后续迁移工具链 | `tools/avatar-converter` | T-pose、Humanoid、Metadata、License 门禁 |
| 旧 PMX/FBX/MMD Runtime | 不恢复手写解析器 | `@yohawing/three-mmd-loader` PMX Adapter；其他格式后续独立 Adapter | PMX 已通过资源释放、Chromium 和 Wallpaper Engine CEF 视觉验收 |
| `wallpaper-host/README.md` 的 WorkerW AIRI Electron 方案 | 淘汰 | Wallpaper Engine Web wallpaper | CEF 真机加载、暂停、FPS、重载恢复 |
| 私有 `assets/`、模型、动作、截图 | 不迁移 | 用户外置只读目录 | Git、构建产物与发布包均无私有文件 |

## AIRI 硬耦合清单

以下内容不得进入 Rayure 核心：

- `@proj-airi/*` 类型或包；
- `CurrentAiriStageBinding`；
- AIRI 固定 commit patcher 与 source fetcher；
- AIRI Electron/Eventa IPC；
- AIRI Model Library / Pinia Store；
- AIRI MediaPipe state adapter；
- AIRI VRMA helper；
- `StereoAiriStageRuntime` 和 AIRI renderer capability registry。

可以借鉴但必须重新命名、重测的内容：

- `StereoRendererRuntimeHost` 的单实例生命周期、替换前释放和 generation 思路；
- Motion、Scene、Head Parallax、Wave Recognition 的纯状态机；
- Blender 隔离运行、文件令牌、哈希校验与取消语义；
- 旧 Host 中的关联 ID、超时、边界消息和故障恢复原则。

## 安全迁移顺序

1. M0 建立无 AIRI 的仓库、协议、Companion 与 Wallpaper 壳；
2. 复制 Motion/Scene/Parallax/Wave 的测试，不复制实现；
3. 逐模块迁移纯算法，确认与旧测试等价；
4. 在 Rayure Renderer 中建立格式独立的 3D Stage；M1 已先完成 PMX Adapter，VRM/FBX 后续独立加入；
5. 扩展当前 Companion 只读网关为带授权、哈希与缓存的正式资产库；
6. 最后加入语音、视觉和可选上游 Agent Adapter。

任何一步失败都只回退当前模块，不修改或回滚旧仓库。
