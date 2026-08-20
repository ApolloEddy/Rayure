# Hiyori 原生 Live2D 调试

## 选型

本机调试模型选择 Live2D 官方 `CubismWebSamples` 的 Hiyori。它提供完整的 `.model3.json`、`.moc3`、两张纹理、物理、姿态、70 个参数和 10 个动作（`Idle` 9 个、`TapBody` 1 个），适合先验证参数映射、物理和动作回放。模型文件来自官方样例仓库的 `Samples/Resources/Hiyori`，只放在 Git 忽略的 `scratch/live2d-samples/Hiyori/`，不进入 `public/`、`dist/`、Git 或发布包。

模型结构遵循官方 Cubism Web 的 `model3.json → moc3/纹理/物理/动作` 引用关系。Rayure 的 `model-manifest.ts` 会拒绝绝对路径、目录穿越、重复纹理、非法动作淡入淡出时间和不完整参数定义；`audit-live2d-model.ps1` 会在本机检查文件存在性、MOC3 头和标准 RigProfile 参数。

## 本机审计

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\audit-live2d-model.ps1 `
  -ModelRoot .\scratch\live2d-samples\Hiyori
```

成功后会生成被忽略的 `scratch/live2d-samples/Hiyori/audit.json`。当前审计结果为 17 个资源、70 个参数、标准 RigProfile 全部匹配。

## 原生调试画布

壁纸默认仍保留现有 3D 回归基线；显式提供 `live2dModelUrl`，或让 Companion 通知 `format: live2d` 模型时，才会动态加载 `live2d-renderer`，创建原生 Cubism 调试画布，并用现有 Canonical Motion fixture 驱动 `ParamAngleX`、身体和手臂参数。

先启动开发服务器：

```powershell
pnpm dev:wallpaper
```

在另一个 PowerShell 中生成当前机器可用的 URL：

```powershell
$modelPath = (Resolve-Path .\scratch\live2d-samples\Hiyori\Hiyori.model3.json).Path -replace '\\', '/'
$modelUrl = "/@fs/$modelPath"
$encoded = [Uri]::EscapeDataString($modelUrl)
Start-Process "http://127.0.0.1:4173/?live2dModelUrl=$encoded"
```

## Companion 端到端调试

当前 Companion 已支持 `format: live2d`。本机可直接使用被忽略的临时配置启动：

```powershell
$env:RAYURE_LOCAL_CONFIG = (Resolve-Path .\scratch\live2d-samples\Hiyori\rayure.local.live2d-debug.json).Path
pnpm dev:companion
```

再启动 `pnpm dev:wallpaper`，Wallpaper 会在握手后收到令牌化 `model.available`，先重新校验 `model3.json`，再从 Companion 读取 MOC3、物理、动作和纹理并创建原生 Cubism 画布。Companion 同时从 `FileReferences.Motions` 发出带 `group/index` 的动作目录；画布就绪后默认播放 `Idle`，调试栏会出现每个动作的播放按钮和停止按钮，可直接验证替换与中断。PMX 仍由原有 3D 主机处理。

## Cubism Core 来源

调试入口默认使用 Live2D 官方托管的固定 Cubism Core 地址。`live2dCoreUrl` 只接受三类来源：精确官方地址、当前 Vite 源的同源 `.js` 路径、或 `127.0.0.1`/`localhost`/`::1` 的回环 `.js` 地址；任意其他远程主机、查询串、危险协议和非脚本扩展名都会回退到安全默认值。Wallpaper 会在创建 `live2d-renderer` 之前显式加载 Core，因此脚本失败能进入统一的模型错误状态。

如果机器上已有你有权使用的 Cubism Core 文件，可把它放在仓库外的忽略目录（例如 `scratch/live2d-core/live2dcubismcore.min.js`）仅用于本机调试。下面的命令不会下载、复制或提交 Core：

```powershell
$modelPath = (Resolve-Path .\scratch\live2d-samples\Hiyori\Hiyori.model3.json).Path -replace '\\', '/'
$corePath = (Resolve-Path .\scratch\live2d-core\live2dcubismcore.min.js).Path -replace '\\', '/'
$modelUrl = "/@fs/$modelPath"
$coreUrl = "/@fs/$corePath"
$encodedModel = [Uri]::EscapeDataString($modelUrl)
$encodedCore = [Uri]::EscapeDataString($coreUrl)
Start-Process "http://127.0.0.1:4173/?live2dModelUrl=$encodedModel&live2dCoreUrl=$encodedCore"
```

在 Companion 端到端调试中，只需要把 `live2dCoreUrl` 加到同一个壁纸地址；模型仍由 Companion 通过令牌化回环 URL 提供。Core、模型和动作都不会进入 `public/`、`dist/`、Git 或发布包。

## 在线/离线验收

1. 在线预检：启动 Companion 和 Vite，打开 `?live2dDebug=1`，应看到 Hiyori、70 个参数、默认 `live2d-Idle-0` 以及 10 个原生动作按钮；点击 `TapBody 1` 后活动动作应变为 `live2d-TapBody-0`，停止按钮应清空活动动作。
2. Core 失败边界：把 `live2dCoreUrl` 指向不存在的回环 `.js`，页面应显示 `Live2D model unavailable`，模型标签的诊断标题应包含 `Cubism Core could not be loaded`，且不应残留原生 Live2D canvas；Companion 连接和冻结的 3D 页面不应因此中断。
3. 离线预检：断网时只能使用包外、已授权的本地 Core 文件；若没有该文件，失败是预期结果，不得把远程地址偷偷改成任意 CDN。
4. CEF 最终门禁：Chrome/普通浏览器只算技术预检；必须把同一 `dist/` 导入 Wallpaper Engine，并在 CEF DevTools/实际画面中复核 Core、模型、动作和页面重载。该验收未完成前，不宣称 M2 Live2D 发布就绪。

## 当前边界

- Hiyori 是开发测试模型，不是 Rayure 的发布默认角色；
- 当前原生调试画布已经能加载 `.model3.json` 并把 Canonical Motion 推到真实 Cubism 参数 sink，Companion 的 Live2D 模型、动作目录、默认 Idle、动作替换与停止端到端加载也已打通；
- 离线 Core 文件的实际可用性和 Wallpaper Engine CEF 验收仍未闭合；
- `Live2dNativeDebugSurface` 只在查询参数或 Companion Live2D 模型通知存在时创建，关闭页面或替换模型会释放模型、动作控制器和画布；
- 3D 代码继续冻结为回归基线，不扩展新的 3D 场景、模型或动作能力。
