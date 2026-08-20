# M2 Live2D 原生调试验收

状态：开发调试切片已完成，离线 Core 实际文件与 Wallpaper Engine CEF 实机验收未关闭

## 范围

本验收只覆盖 Hiyori 开发模型的原生 Cubism 调试表面、Companion 模型/动作目录和 Core 来源失败边界。Hiyori、动作、纹理、物理、Core 和本机配置均属于包外调试输入；它们不进入 Git、`public/`、`dist/` 或发布包。3D 只作为冻结回归基线，不在本切片扩展。

## 自动化门禁

- `pnpm test`：协议 15 项、Companion 17 项、Wallpaper 49 项，共 81 项；
- `pnpm typecheck`：所有工作区 TypeScript 检查通过；
- `pnpm build`：生成独立 Wallpaper Web wallpaper；
- `scripts/verify.ps1`：依赖审计、AIRI 边界、构建产物和 Git 私有资源边界检查；
- `git ls-files -- 'scratch/**' 'apps/wallpaper/dist/**' '*.model3.json' '*.moc3' '*live2dcubismcore*.js'`：不应输出任何私有模型或 Cubism Core 文件。

## 浏览器技术预检

1. 使用被忽略的 `scratch/live2d-samples/Hiyori/rayure.local.live2d-debug.json` 启动 Companion，并启动 Vite。
2. 打开 `http://127.0.0.1:4173/?live2dDebug=1`。预期 Companion 已连接、模型为 `Hiyori debug`、原生画布存在、参数数量为 70、默认动作是 `live2d-Idle-0`，调试栏有 10 个动作按钮。
3. 点击 `TapBody 1`，预期活动动作变成 `live2d-TapBody-0`；点击停止，预期活动动作清空。浏览器错误/警告日志应为空。
4. 指定 `live2dCoreUrl` 为不存在的回环 `.js`，预期模型状态为 `Live2D model unavailable`，诊断标题包含 `Cubism Core could not be loaded`，原生 canvas 数量为 0；不应出现“已就绪”状态或未处理异常。
5. 若机器有已授权的包外 Core，可使用 Vite `/@fs/` 形式传入 `live2dCoreUrl` 重做第 2、3 步；没有 Core 时离线失败是预期结果。

## CEF 未关闭项

普通 Chrome 的通过只能证明资源 URL、脚本加载和 DOM/Canvas 链路可用，不能替代 Wallpaper Engine CEF。以下项目必须在真实 Wallpaper Engine 导入同一 `dist/` 后复核：

- CEF 能否执行本地 bundle 并创建原生 Cubism 画布；
- Core、`.model3.json`、MOC3、纹理、物理和动作请求在 CEF 中是否都成功；
- 页面重载、Companion 重启、窗口暂停/恢复和动作替换后是否仍保持 generation 隔离与资源释放；
- CEF DevTools 无未处理异常，实际画面无黑屏、纹理丢失或比例错误。

在这些项目获得真实 CEF 证据前，M2 只能标记为“浏览器预检通过、CEF 待验收”，不能作为正式发布完成条件。
