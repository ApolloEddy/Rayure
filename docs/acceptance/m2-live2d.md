# M2 Live2D 皮套与原生内容验收

状态：岛风 skin-only/原生内容切换已完成浏览器技术预检；模型专属参数映射和 ARDY 可见步态尚未验收；Wallpaper Engine CEF 的最终画面、DevTools、暂停/恢复和本轮生成动作仍是独立验收项。

## 范围

本验收覆盖包外 Live2D 模型的清单校验、皮套入口、场景部件隐藏、模型自带内容显式导入、Companion 动作目录和 Core 来源失败边界。模型、动作、纹理、物理、Core 和本机配置均不进入 Git、`public/`、`dist/` 或发布包。

## 当前参数映射状态（2026-08-25）

- 当前岛风 model3 实测 545 个参数；腿脚和部分手臂使用 `Param7/8/9/10/11/12/14/15/16/17/19/79/80/86/286` 等非标准 ID。
- 代码已加入显式 Shimakaze RigProfile，能够把 Canonical Motion 的相关控制计算成这些真实 ID 的写入值；标准 profile 仍保留给使用标准 Cubism 参数名的模型。
- 这还不是通用导入器：尚未从 model3/cdi3 的 DisplayInfo 自动生成或校准 RigProfile，也没有在调试页完整报告每个 Canonical 控制的已映射/缺失状态。
- `walk.forward` 的生成/发布/完成回执已能在普通浏览器链路中观察到，但本次记录不把它记为可见行走验收；需要下一次先完成映射诊断与逐模型校准，再在 Wallpaper Engine CEF 复核。

## 自动化门禁

```powershell
pnpm test
pnpm typecheck
pnpm build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify.ps1 -SkipInstall
```

同时确认：

```powershell
git ls-files -- 'scratch/**' 'apps/wallpaper/dist/**' '*.model3.json' '*.moc3' '*live2dcubismcore*.js'
```

该命令不应输出任何私有模型或 Cubism Core 文件。

## 浏览器技术预检

1. 使用被忽略的 `scratch/live2d-samples/Shimakaze/rayure.local.live2d-debug.json` 启动 Companion，并启动 Vite。
2. 打开 `http://127.0.0.1:4173/`。浏览器开发预览会加载原生动作入口但隐藏模型自带场景部件；角色应保持比例、点击头部/身体应触发 `touch_head`/`touch_body` 等动作，不应出现被拉伸的全屏房间贴图。
3. 追加 `?live2dDebug=1`，确认开发面板显示动作目录、原生内容开关、背景开关和表达式资源状态；当前 Shimakaze 无 `Expressions` 时表情按钮应禁用。追加 `?live2dNativeContent=0` 可验证 skin-only 入口和无动作状态。
4. 通过 Wallpaper Engine 的 `importnativecontent` 属性切换为 `true`。预期原生入口重新加载，模型自带场景层恢复，动作目录可由运行时消费；关闭后应回到 skin-only 入口并停止原生动作。
5. 显式打开 `?live2dDebug=1` 只能看到开发状态面板；它不会恢复桌面动作按钮，也不属于用户设置页。
6. 将 `live2dCoreUrl` 指向不存在的回环 `.js` 时，预期状态为 `Live2D model unavailable`，原生 canvas 被清理，Companion/冻结的 3D 页面不因此中断。

## 资源与 CEF 边界

- Core 只能使用受控的官方、同源或回环来源；离线 Core 必须是包外且已授权的本地文件。
- Chrome/普通浏览器通过只证明资源 URL、脚本加载和 DOM/Canvas 链路可用；必须把同一 `apps/wallpaper/dist/` 导入 Wallpaper Engine，在真实画面和 DevTools 中复核模型、场景切换、页面重载、暂停/恢复、动作替换和异常释放。
- 旧的 Hiyori 调试模型、旧动作按钮和旧样例包不再是当前验收输入；当前本机模型统一使用岛风目录，正式发布仍不携带任何角色资源。
