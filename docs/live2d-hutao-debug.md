# 胡桃 L2D 调试边界

## 结论

现有资源包不能通过可靠的一键方式直接变成原生 Live2D/Cubism 模型。

它提供的是 PMX/FBX/Blend 的 3D 网格、骨骼和贴图，而 Cubism 的正式工作流从分层 PSD 导入开始，再在 Modeler 中建立 ArtMesh、变形器和参数，最后导出 `.moc3` 与 `.model3.json`。官方文档没有提供 PMX/FBX → Cubism 的导入路径：

- [PSD 导入](https://docs.live2d.com/en/cubism-editor-manual/psd-import/)
- [PSD 素材准备](https://docs.live2d.com/en/cubism-editor-manual/precautions-for-psd-data/)
- [Web 模型文件结构](https://docs.live2d.com/en/cubism-sdk-manual/model-web/)
- [Cubism 文件类型](https://docs.live2d.com/en/cubism-editor-manual/file-type-and-extension/)

所以“把 PMX 渲染成一张 PNG”只能得到扁平的 2D 预览，不能得到可绑定参数的 `.moc3`。要做真正的 L2D，需要人工完成多层绘制、遮挡补全、网格、变形器和参数标定。

## 当前实现

Rayure 已提供一个安全的本地调试路径，但它明确不是原生 L2D：

1. `scripts/prepare-hutao-live2d-debug.ps1` 只读取外部资源包，不复制、不改写、不打包资源；它会生成被 Git 忽略的 `rayure.local.json` 和 `scratch/live2d-hutao-debug/asset-audit.json`。
2. Companion 继续通过一次性回环 URL 只读提供外部 `胡桃.pmx`，现有 PMX Renderer 作为视觉参照。
3. 访问壁纸地址时附加 `?live2dDebug=1`，会启动 `Live2dDebugProbe`。它运行真实的 `Canonical Motion → RigProfile → Parameter Sink` 路径，并在右上角显示参数值，但不加载 Cubism Core，也不声称已经完成 L2D 转换。

准备本机调试配置：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepare-hutao-live2d-debug.ps1 `
  -AssetRoot 'D:\path\to\18 胡桃'
```

然后分别启动：

```powershell
pnpm dev:companion
pnpm dev:wallpaper
```

打开 `http://127.0.0.1:4173/?live2dDebug=1`。PMX 角色只用于本机视觉参照；调试报告、配置和资源均不进入 Git、`dist` 或发布包。

## 进入原生 L2D 的下一步

如果后续要把它做成真正的 Live2D 模型，需要在资源许可允许的前提下，先制作分层 PSD，再使用 Cubism Editor 完成网格/变形器和参数绑定。完成后只把授权明确的 `.model3.json`、`.moc3`、纹理和物理文件接入新的 Cubism Web SDK Adapter；当前 PMX 调试路径不应被误当作发布模型。
