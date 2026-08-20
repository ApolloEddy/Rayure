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

壁纸默认仍只显示现有 3D 回归基线。只有显式提供 `live2dModelUrl` 查询参数时，才会动态加载 `live2d-renderer`，创建原生 Cubism 调试画布，并用现有 Canonical Motion fixture 驱动 `ParamAngleX`、身体和手臂参数。

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

再启动 `pnpm dev:wallpaper`，Wallpaper 会在握手后收到令牌化 `model.available`，先重新校验 `model3.json`，再从 Companion 读取 MOC3、物理、动作和纹理并创建原生 Cubism 画布。PMX 仍由原有 3D 主机处理。

调试入口默认使用 Live2D 官方托管的 Cubism Core 地址；它不会被复制到仓库或构建产物。若浏览器或 Wallpaper Engine 环境离线，原生模型会显示明确的 Core 加载失败状态，而不会伪装成已加载模型。正式发布前仍需决定 Core 的合规获取、离线分发和 CEF 验收方式。

## 当前边界

- Hiyori 是开发测试模型，不是 Rayure 的发布默认角色；
- 当前原生调试画布已经能加载 `.model3.json` 并把 Canonical Motion 推到真实 Cubism 参数 sink，Companion 的 Live2D `model.available` 端到端加载也已打通；
- Live2D 动作目录、动作打断/替换、离线 Core 来源和 Wallpaper Engine CEF 验收仍未闭合；
- `Live2dNativeDebugSurface` 只在查询参数存在时创建，关闭页面或离开调试模式会释放模型、动作播放器和画布；
- 3D 代码继续冻结为回归基线，不扩展新的 3D 场景、模型或动作能力。
