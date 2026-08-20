# M1 Wallpaper Engine 与 PMX 角色验收

日期：2026-08-15  
范围：官方 Web 壁纸清单、外置 PMX、只读网关、属性热更新、重连和真实 CEF  
本机版本：Wallpaper Engine 2.8.42（64 位）

## 自动化门禁

| 门禁 | 标准 | 状态 |
|---|---|---|
| Protocol | 严格握手与 `model.available`；只接受令牌化的 `127.0.0.1` HTTP URL | 通过（6 项） |
| Companion | 回环绑定、WS `/ws`、Origin、令牌、GET/HEAD、扩展名、realpath、配置输入、会话失败隔离和停止语义 | 通过（11 项） |
| Wallpaper | 官方清单、本地化、属性边界、事务式模型加载、竞态、失败保留和所有权感知释放 | 通过（15 项） |
| TypeScript | 全工作区 `tsc` 无错误 | 通过 |
| Build | `dist/project.json`、`index.html`、本地 JS/CSS/WASM 完整 | 通过 |
| Supply chain | `pnpm audit --prod --audit-level high` | 通过 |
| AIRI | 运行源码无 AIRI 标识符或依赖 | 通过 |
| 私有资产 | `dist/` 无 PMX/FBX/Blend 等模型文件、私人路径/名称和本地配置 | 通过 |

总计 32 项自动化测试。

## 真实模型 Chromium 预检

- 使用 Git 忽略的本地配置引用一份获准用于开发测试的外置 PMX；
- PMX、BMP/PNG 中文纹理和 MMD 材质正常显示；
- 角色完成边界拟合，正面站姿未受占位体持续旋转影响；
- 页面状态显示 Companion 已连接与本地模型已就绪；
- 控制台 0 error / 0 warning；
- 资源 Origin 只有生产预览 `127.0.0.1:4174` 和 Companion `127.0.0.1:32145`；
- 测试截图只位于 Git 忽略的 `output/playwright/`，不进入发布目录。

## Wallpaper Engine CEF 实机

通过官方 `wallpaper64.exe -control openWallpaper -file <project.json> -playInWindow ...` 打开 `dist/project.json`，没有替换当前桌面壁纸。

验收结果：

- Wallpaper Engine 启动 `webwallpaper64.exe` CEF Renderer 并显示完整 PMX 与纹理；
- 1440×900 弹出窗口中布局、相机、模型拟合和状态面板正确；
- 官方 `applyProperties` 将 `modelscale` 从 100 改为 75 后模型即时缩放；
- `accentcolor` 改为红色后背景和 UI 即时更新；
- `showstatus=false` 后状态面板即时隐藏，恢复默认值后重新显示；
- `companionport` 临时改为 32146 后状态进入等待，已加载模型保持可见；
- 端口恢复 32145 后自动重连，重复模型通知没有造成闪烁或重载；
- 本机没有启用 Wallpaper Engine 的 CEF DevTools 端口，因此本轮没有声称完成 CEF 控制台审计；普通 Chromium 的零错误结果不能替代这一点。

## 许可与发布边界

测试模型及其纹理始终留在旧项目目录，只通过 Companion 只读访问。未复制到 Rayure、`public/`、`dist/`、Git 或 Wallpaper Engine 项目副本，也未上传或商用。

发布候选仅为 `apps/wallpaper/dist/`。正式发布前仍需使用可再分发或用户自备资产，并完成对应许可证检查。

## 未关闭项

- CEF DevTools 控制台审计；
- VMD/Idle、表情、口型和动作；
- 21:9、多显示器、睡眠唤醒和长时间运行；
- 首次配对、安装器、自动启动和正式 Workshop 打包；
- 2D、语音和视觉链路。
