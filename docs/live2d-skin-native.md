# Live2D 皮套与模型自带内容验收

当前的 Live2D 验收模型是包外的岛风资源 `scratch/live2d-samples/Shimakaze/`。它只用于本机测试，不进入 Git、`public/`、`dist/` 或发布包。

## 当前运行语义

Wallpaper Engine 默认读取 Companion 生成的 skin-only `.model3.json`：

- 模型本体、参数、物理、口型和 Rayure 自己的交互继续工作；
- 模型包内的 `Motions` 不会在默认加载阶段被拉取或自动播放；
- 模型包内的 `Expressions` 会保留并由 Cubism expression manager 按 Companion 的 `expression.set/reset` 及 `emote.play` 表情字段驱动；表达式文件名、路径和常见中英日语义名会做安全解析，找不到时不挑选其他资源；
- cdi3/配置识别出的背景、镜子、地板、粒子等场景部件按皮套规则隐藏；
- Wallpaper Engine 页面不再显示旧的动作/表情调试按钮。

当前本机 Shimakaze 资源的 `Expressions` 数组为空，因而没有可触发的 `.exp3` 表情；它提供的是 `touch_head`、`touch_body`、`idle` 等原生动作。浏览器开发预览默认仍是 skin-only；显式追加 `?live2dNativeContent=1` 后才启用这些原生动作，`?live2dDebug=1` 只负责显示动作目录、背景/场景层切换和表情资源诊断。

在 Wallpaper Engine 属性中勾选 **Import model-native content / 导入模型自带内容** 后，Renderer 会重新加载 Companion 提供的原生入口，恢复模型包内的场景层和动作目录。原生动作由 Companion/运行时交互驱动，不通过桌面调试栏暴露。

## 本机启动

```powershell
$env:RAYURE_LOCAL_CONFIG = (Resolve-Path .\scratch\live2d-samples\Shimakaze\rayure.local.live2d-debug.json).Path
pnpm dev:companion
```

另开终端启动 Wallpaper：

```powershell
pnpm dev:wallpaper
```

默认页面应只显示模型和 Rayure 的简洁舞台，不应出现被拉伸的全屏房间贴图或旧的“动作调试”“复合动作”“面部微表情”工具栏。浏览器预检可以使用 `?live2dDebug=1` 显示显式开发面板；该查询入口不属于 Wallpaper Engine 用户设置。

## 验收重点

1. 默认皮套模式：角色可加载，场景部件按配置隐藏，网络记录不应出现模型自带 `.motion3.json` 请求。
2. 勾选模型自带内容：模型重新加载到原生入口，场景层恢复，Companion 的动作目录可被运行时消费；Rayure 的 Canonical Motion、语音口型、鼠标和行为交互仍保持主控制权。
3. 关闭导入：再次回到 skin-only 入口，停止原生动作并释放旧表面，不残留旧模型的异步结果。
4. 发送 `expression.set`（正权重）应触发匹配的原生 `exp3`，发送零权重或 `expression.reset` 应停止当前表达式；具体淡入淡出仍以模型 `exp3` 的 Cubism 曲线为准。
5. 真实 Wallpaper Engine CEF 仍需独立复核画面、DevTools、暂停/恢复和页面重载；普通浏览器结果只算技术预检。

## 资源边界

岛风模型、动作、纹理和本地配置均保持在 `scratch/`。仓库只保留格式解析、皮套入口生成、原生内容切换和运行时适配代码；任何模型资源都不应复制到 `apps/wallpaper/public/` 或生产 `dist/`。

## 默认视图一致性（M0）

浏览器开发预览与 Wallpaper Engine 采用同一个默认值：**skin-only**，即默认不导入模型自带动作、不显示模型自带场景层。预览要看自带内容时显式加 `?live2dNativeContent=1`。

## 初始姿势（M1）

加载后所有 Live2D 模型默认应用**模型中性姿势**（参数默认值），动作结束后淡回该姿势；可通过模型专属校准状态的 `neutralPose` 覆盖为标定快照，ARDY 动作以该姿势为 offset 基准叠加。未配置时使用参数默认值（立绘姿势）。

## 标定向导（M2）

Live2D 模型加载后，若本机状态目录没有有效校准且当前会话未选择“稍后”，自动弹出**模型标定向导**（四步）：

1. **ARDY 通道标定**：未映射的通道列出候选参数，点击「试摆」实时驱动模型观察部位，确认后保留该参数真实的 min/max/default；可反转方向，可禁用模型不具备的部位。
2. **场景部件**：逐个 toggle 部件透明度，勾选生成 `skinHiddenPartIds`（替代自动识别缺失时的手工配置）。
3. **初始姿势**：滑杆微调映射参数摆出站立/放下姿势，捕获为 `neutralPose` 快照。
4. **保存**：POST 到 Companion 的 tokenized 校准端点；服务端校验并原子写入本机状态目录，成功后自动重新加载模型。HTTP/网络失败会保留向导并显示错误；手动进入用 `?calibrate=1`。

Windows 默认状态位置为 `%LOCALAPPDATA%\Rayure\calibrations\<model-id>-<path-hash>.json`；其他平台使用用户目录下的 `.rayure/calibrations`。模型旁旧 `rayure.calibration.json` 只做兼容读取，所有新保存都写入状态目录。`skinHiddenPartIds`（包括空列表）优先于自动识别/`rayure.local.json`；模型、纹理和动作目录始终只读且不进入仓库或发布包。
