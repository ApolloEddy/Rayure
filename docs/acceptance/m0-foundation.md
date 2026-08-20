# M0 独立运行基础验收

日期：2026-08-15  
范围：协议、Companion、Web 壁纸壳  
不包含：角色模型、语音、视觉、Wallpaper Engine CEF 实机

## 自动化门禁

| 门禁 | 标准 | 当前状态 |
|---|---|---|
| 协议测试 | 严格往返；拒绝非对象、未知字段、超长、控制字符 | 通过（5 项） |
| Companion 测试 | 回环绑定、握手、非法 JSON、二进制、超时、重复握手、幂等停止 | 通过（5 项） |
| 壁纸配置测试 | 端口、FPS、颜色和默认值边界 | 通过（5 项） |
| TypeScript | 全工作区 `tsc` 无错误 | 通过 |
| 构建 | Vite 生成本地 `dist/index.html` 与静态资源 | 通过 |
| AIRI 禁入 | `apps/**/src`、`packages/**/src` 无 AIRI 标识符 | 通过 |
| 私有资源 | 构建产物无 VRM/PMX/FBX/VRMA/Blend 文件 | 通过 |

## 浏览器预检

完成标准：

- 页面无脚本错误；
- Three.js 占位场景可见；
- Companion 未启动时显示等待且持续渲染；
- Companion 启动后无需刷新即变为已连接；
- Companion 重启后自动恢复连接；
- 页面没有远程资源请求。

当前状态：通过。

- 使用 Microsoft Edge 的 Playwright 会话验证开发预览和生产 `dist/` 预览；
- Companion 未启动时保持渲染并显示等待，启动后不刷新自动连接；
- Companion 停止后进入指数退避，重新启动后自动恢复连接；
- 生产预览控制台为 0 error / 0 warning；
- 生产预览网络记录只有 `127.0.0.1:4174` 的 HTML、JS 和 CSS；
- 已检查 1920×1080、3440×1440 和 720×1280；
- 刻意停止 Companion 时 Chromium 会记录预期的 `ERR_CONNECTION_REFUSED`，该负向证据不属于脚本异常；
- 本地截图位于忽略目录 `output/playwright/`，不会进入发布包。

## Wallpaper Engine CEF 实机验收

完成标准：

- `dist/index.html` 可作为 Web wallpaper 导入；
- 占位场景在桌面真实显示；
- `wallpaperPropertyListener` 收到 FPS 与暂停事件；
- 本地 WebSocket 可完成握手；
- 壁纸重载和切换后可以恢复；
- CEF 控制台无错误；
- 16:9、21:9 和双屏至少完成布局检查。

当前状态：M0 占位体本身不再单独追验；其真实 CEF 项目加载、属性与重连链路已由 [M1 验收](m1-wallpaper-engine-pmx.md)覆盖。CEF DevTools 控制台仍是明确未关闭项，普通 Chrome/Playwright 结果不得替代该项。
