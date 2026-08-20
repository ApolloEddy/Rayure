# 更新日志

本项目的所有重要变更都会记录在此文件中。

## [0.5.2-dev] - 2026-08-20

### 新增

- 选定 Live2D 官方 Cubism Web Samples 的 Hiyori 作为本机调试模型，并放入 Git 忽略的 `scratch/live2d-samples/Hiyori/`；审计结果为 17 个资源、70 个参数、标准 RigProfile 全部匹配；
- 新增 `Live2dModelManifest` 校验器，拒绝模型资源绝对路径、目录穿越、重复资源和非法动作淡入淡出时间，并提供 MOC3 头校验和标准参数扫描；
- 新增 `scripts/audit-live2d-model.ps1`，生成仅位于 `scratch/` 的模型审计报告；
- 新增 `Live2dNativeDebugSurface`，通过显式 `live2dModelUrl` 查询参数加载真实 Cubism 模型，并将 Canonical Motion fixture 驱动到真实参数 sink；引入 `live2d-renderer@0.6.6` 作为开发适配层。
- 共享 `model.available` 协议新增 `live2d` 模型格式，继续复用令牌化回环 URL 和严格字段校验。
- Companion 本地配置现在接受绝对 `.model3.json` 入口，并在同一令牌根内提供 Live2D 的 JSON、MOC3、纹理和动作资源；磁盘路径与未允许扩展名仍不会进入协议或 HTTP 响应。
- Live2D 动作描述符现在携带 `group`/`index`，Companion 会从 `.model3.json` 的 `FileReferences.Motions` 自动生成动作目录，并继续通过同一令牌根发放 `.motion3.json` URL。
- Wallpaper 收到 `format: live2d` 的 `model.available` 后，会先校验 model3 清单，再创建原生 Cubism 画布；PMX 仍走原有 3D 主机，二者不会互相覆盖。
- 新增原生 Live2D 动作控制器：默认播放 Idle、显式停止、动作替换/打断和迟到异步结果隔离；调试栏会根据 Companion 目录动态生成原生动作按钮。
- 新增 Cubism Core 来源解析器：默认继续使用官方固定地址，可显式使用同源调试文件或回环 `.js` 地址；任意远程主机、危险协议、查询串和非脚本扩展名均拒绝。
- 原生调试表面现在会在创建 `live2d-renderer` 前显式加载已验证的 Cubism Core，并按 URL 复用加载 Promise，避免底层初始化吞掉脚本失败。

### 变更

- Vite 开发服务器只额外允许读取 `scratch/`，原生调试画布不改变默认 3D 回归页面或发布目录；
- README 与 Hiyori 调试文档补充模型审计、URL 生成和 Core 离线边界。

### 修复

- 对原生调试 URL 增加空值、长度、路径类型和回环地址校验，避免调试入口接收任意远程模型；
- 原生模型加载失败时显示明确诊断并释放画布、动作播放器和模型实例，不把失败状态冒充为已加载。
- 原生动作播放只接受当前 Live2D 目录中的 `group/index`，停止和替换会使旧 generation 失效；VMD 目录仍只进入冻结的 3D 主机。
- 修正不同 Live2D 动作组规范化后可能产生重复动作 ID 的边界情况，冲突时追加确定性后缀且保持 64 字符上限。
- 原生调试画布仅在 Cubism 模型完成异步加载后执行尺寸同步，避免布局观察器抢跑触发底层空模型错误。
- 浏览器版 `path` shim 保留远程 Companion URL 的协议分隔符，避免 Live2D 资源请求错误回落到 Wallpaper 自身；Cubism 未完成初始化时释放也不再产生未处理异常。
- Cubism Core 脚本加载失败现在会沿原生表面错误路径返回，并清理画布、模型和动作资源；调试栏不会把 Core 失败误报为模型已就绪。

### 架构影响

- Live2D 主线从参数探针推进到“模型清单校验 → 原生 Cubism 参数驱动”的开发切片；
- Companion 已完成“模型清单动作组 → 严格动作目录协议”，Wallpaper 已完成“目录 → 原生播放/停止/替换”的第二段；
- Core 来源先经过独立的安全契约，再进入原生表面；查询参数和 Companion 创建的表面共用同一受控来源；本地 Core 只作为调试输入，不改变正式构建的资源边界；
- Cubism Core 仍只通过调试时的官方托管地址加载，未复制到 Git、`dist` 或发布包；离线 Core 来源和 Wallpaper Engine CEF 验收仍是下一步工作。

## [0.5.1-dev] - 2026-08-20

### 新增

- 新增 `Live2dDebugProbe` 与本地 fixture，仅在 `?live2dDebug=1` 下运行真实的 Canonical Motion → RigProfile → Parameter Sink 链路；
- 新增 `scripts/prepare-hutao-live2d-debug.ps1` 与 [胡桃 L2D 调试边界](docs/live2d-hutao-debug.md)，把外部 PMX 仅作为本机视觉参照，并生成被忽略的审计报告。

### 修复

- 修正壁纸就绪后的默认 `wave` 复合动作调用，使其使用当前的 `emoteId` 字段并恢复 TypeScript 门禁。

### 边界

- 已确认 PMX/FBX/Blend 不能可靠地一键导出原生 `.moc3`/`.model3.json`；当前不生成、不复制、不发布胡桃衍生模型；
- 调试路径不携带 Cubism Core 或第三方角色像素，外部资源仍由 Companion 只读令牌网关提供。

## [0.5.0-dev] - 2026-08-20

### 新增

- 建立与具体 Renderer 无关的 `Canonical Motion v1` 合同，固定 `ardy-core-27` 关节集、帧时间、根变换、关节位姿与脚接触字段，并拒绝缺失关节、乱序帧、非法四元数和未知字段；
- 新增 Live2D `RigProfile` 与参数适配器，支持标准头部、身体、手臂参数的投影、校准绑定、范围钳位和绝对/偏移两种映射模式；
- 新增按时间推进录制动作的 `Live2dMotionPlayer`，可将 Canonical Motion 回放到后续 Cubism 参数 sink；
- 新增 Live2D 合同、参数映射、结束/停止和异常输入测试。

### 变更

- 将 3D 场景、PMX、VMD 和私人场景素材标记为冻结回归基线，后续主线转向 Live2D；
- 发布门禁新增 Git 追踪路径与 Wallpaper `dist` 私人场景目录检查；
- 将 `apps/wallpaper/public/assets/scenes/` 下的私人场景副本移入忽略的本机归档目录，避免 Vite 将其复制到公开构建产物。

### 架构影响

- 当前 Live2D 代码不携带 Cubism Core、模型或第三方资产，真实 SDK/模型接入需经过授权和再分发边界审核；
- 现有 PMX Renderer 继续保留，但不作为当前功能开发方向。

## [0.4.8] - 2026-08-16

### 新增与全景重构

- **全面上线【方案 1：古典和风与治愈暖木书房】高精 3D 室内场景**：
  - 资产升级：接入专业和风室内 3D 模型资产（`Japanese Living Room`，包含障子格栅推拉大窗、榻榻米地板、实木矮桌书架、茶具茶盘与草席软垫，配套 8.4MB 超高分辨率原画级烘焙贴图）；
  - 沉浸空间构图：通过精确空间平移与旋转变换，将大型日式障子窗与实木茶几居中铺满 1920x1080 宽屏视野，胡桃端坐于茶几书桌后正面注视屏幕外的用户，气质完美相融；
  - 和风三层冷暖光影：窗外晨曦柔和白光穿透障子格栅在榻榻米上投下清晰窗棂阴影 + 桌面橙金点光源 + 暖木环境漫射光；
- **全套自动化测试与工程门禁**：
  - 全工作区 51 项单元测试 100% 全部通过；
  - `.\scripts\verify.ps1` 生产打包、合规检查与依赖审计 100% 全绿；
  - 输出 1080P 实机录像 `hu_tao_japanese_room_demo.webm` 与全景渲染截图。

## [0.4.7] - 2026-08-16

### 修复与架构优化

- **彻底修复 3D 室内场景未在实机画面中显示的渲染 Bug**：
  - 根因定位：发现 `EnvironmentHost` 在异步加载时存在生命周期误处置，且原始 OBJ 带有封闭外墙与天花板遮挡物；
  - 架构重构：采用纯二进制流式解析技术（直接基于 9.7 万顶点标准 Buffer 构建 `BufferGeometry`），毫秒级完成 3D 卧室室内几何体创建与材质映射，彻底消除任何 Loader 异步挂起与 DOM 阻塞；
  - 空间布局与视锥体微调：自动隐藏遮挡视线的外墙天花板，旋转平移场景使实木书桌、靠背椅、窗台、电脑和床铺铺满 1080P 视野，胡桃端坐于书桌前注视屏幕外的用户；
  - 室内冷暖光影系统：配置暖黄复古台灯点光源 + 窗外晨曦冷白晨光 + 柔和室内漫射光，营造温馨治愈的真实卧室氛围；
- **全套自动化测试与工程门禁**：
  - 全工作区 51 项单元测试全绿通过，`scripts/verify.ps1` 生产打包、合规检查与依赖审计 100% 通过；
  - 实机操控录制输出 1080P 高清互动视频 `hu_tao_cozy_bedroom_demo.webm` 与全套场景实机快照。

## [0.4.6] - 2026-08-16

### 新增与优化

- 引入由专业 3D 艺术家创建的现成高精度 3D 卧室室内场景（`Cozy Bed Room`，36 万顶点、20 处精细家具建筑部件，配套 9.6MB 超高分辨率烘焙材质贴图）；
- 构建 `EnvironmentHost` 场景宿主与三层冷暖室内光影系统（暖黄复古台灯点光源 + 窗外晨曦柔和白光 + 环境漫射光）；
- 重构摄像机景深与书桌视点（FOV 38°，正对书桌黄金分割点），实现胡桃与实木书桌靠背椅的隔桌自然相伴；
- 自动化质检通过，输出 1080P 实机录像 `hu_tao_cozy_bedroom_demo.webm` 与全景渲染截图；全工作区 50 项测试全绿。

## [0.4.5] - 2026-08-16

### 修复与重构

- 彻底根除历史动作“指鹿为马、张冠李戴”的文字动作错位问题，全量接入真正名副其实的高品质动作资产（挥手打招呼、晨间伸懒腰、自信抱胸、开怀大笑、傲娇轻哼、浪漫飞吻、惊讶探看、害羞挠头、击掌领悟、侧身回眸）；
- 升级 `EmoteController` 预设动作映射，动作名称、动画关键帧轨迹与面部微表情联动 100% 严丝合缝一一对应；
- 完成自动化实机录屏与全量动作高清切片质检，生成 1080P 实机录像 `hu_tao_genuine_emotes.webm` 与连贯动态预览 `genuine_actions_preview.gif`；
- 全工作区 49 项单元测试与 `scripts/verify.ps1` 门禁全绿通过。

## [0.4.4] - 2026-08-15

### 修复

- 实现自动骨骼别名重映射器（`BoneRemapper`），彻底解决游戏解包 PMX 模型骨骼命名混淆（`B01`、`D01`、`Finger3`、`x`）导致的身体各部位动作丢失与脱节错位问题；
- 模型加载后自动将混淆骨骼精准标准化对齐到 `左腕`、`右腕`、`左ひじ`、`右ひじ`、`左手首`、`右手首`、`上半身`、`双腿` 等 MMD 工业级标准骨骼体系；
- 新增 `bone-remapper.test.ts` 单元测试，全工作区测试增至 49 项且全绿通过。

## [0.4.3] - 2026-08-15

### 修复

- 彻底清除外部简易弹簧物理（`stateful-spring`）对骨骼造成的 60Hz 高频剧烈抖动与撕扯；
- 彻底清除外部脚本对骨骼旋转的累加污染，保证动作播放时 100% 还原动作师原本平滑的关键帧贝塞尔曲线；
- 恢复使用胡桃原生专属匹配动作库（包含元气招手、双手叉腰、欢呼庆祝、双手合十祈祷、歪头好奇、嘘声轻语与悄悄话等），彻底消除不同体型动作移植导致的肢体错位与手臂脱臼。

## [0.4.2] - 2026-08-15

### 新增

- 接入全套精调高质量 3D 动作模型库（包含挥手、晨间伸懒腰、拍手赞同、傲娇轻哼、自信抱胸、开怀大笑、害羞微笑、惊讶好奇、飞吻互动等）；
- 升级 `EmoteController` 预设动作映射，全面支持长达 7 秒的细腻身体大动作与呼吸起伏，动作结束后自动平滑归位；
- 升级页面左下角动作调试面板，支持一键点击体验 10 种高品质动作与 5 种面部微表情。

## [0.4.1] - 2026-08-15

### 新增

- 开启 `ThreeMmdLoader` 的 `stateful-spring` 物理模拟引擎，头发、双马尾、长袍与裙摆实时随动作解算物理碰撞与柔顺摆动，彻底消除穿模与塑料僵硬感；
- 新增待机胸腔微呼吸程序化律动（周期性正弦微动），让角色具备真实生命体征；
- 新增头部与视线平滑追随鼠标指针算法（Gaze Tracking 带阻尼限制在安全角内）。

### 变更

- `MmdModelHost.advance` 每帧接收屏幕指针归一化坐标，平滑解算头颈骨骼朝向。

## [0.4.0] - 2026-08-15

### 新增

- 新增 `@rayure/protocol` 动作目录与复合情绪协议扩展，支持 `motion.catalog` 与 `emote.play` 双向通信；
- 新增 Companion 端多动作资产网关分发，支持在 `rayure.local.json` 中配置多个本地 `.vmd` 动作并通过令牌化回环网关分发；
- 新增复合情绪与动作调度器 `EmoteController`，内置打招呼（`greet`）、叉腰/自信（`proud`）、困惑/摊手（`confused`）、赞同/点头（`agree`）、欢呼/庆祝（`cheer`）、安静/嘘（`quiet`）与待机（`idle`）等预设；
- 新增“身体骨骼动作 + 面部表情形态”多通道并行协同触发机制，并在动作结束后自动将表情平滑复原为中立状态；
- 新增根目录 `pnpm dev` 聚合并发启动脚本（同时启动 Companion 网关与 Wallpaper 渲染服务）；
- 新增页面左下角可视化毛玻璃动作与表情调试折叠栏（`debug-toolbar`），支持鼠标一键触发 Emotes 与表情微调；
- 新增全工作区 6 项单元测试，测试总数增至 48 项，并通过 Playwright 端到端真机视觉自动化验收（6 张实时渲染快照）。

### 变更

- `CompanionServer` 在 WebSocket 握手成功后自动向客户端同步当前可用的全量动作目录（`motion.catalog`）；
- `MmdModelHost` 深度集成 `EmoteController`，支持通过 `playEmote` 统一调度动作加载、循环/单次播放与表情缓动；
- `RayureScene` 对外暴露 `playEmote` 与 `updateMotionCatalog` 统一接口。

### 修复

- 修复 `MotionController` 独立时间线推进机制（重置 `motionElapsed`），消除动作因网页累计时长导致的跳过问题；
- 修复 TypeScript strict strip-types 模式下 parameter properties 兼容性；
- 修复无外置动作文件时复合情绪的优雅降级逻辑（仍可无缝展示面部情绪变化）。

### 架构影响

- 实现了“动作文件（骨骼通道）”与“面部表情（Morph 通道）”的完全正交解耦与高阶情绪抽象；
- 外部 AI 对话或指令只需下发情绪意图（如 `greet` 或 `proud`），即可自动调度全身动作与对应微表情。

## [0.3.0] - 2026-08-15

### 新增

- 新增 `@rayure/protocol` 动作与表情协议扩展，支持 `motion.play`、`motion.stop`、`expression.set`、`expression.reset` 与能力声明；
- 新增 Companion 端 `.vmd` 资产只读网关支持与扩展名白名单；
- 新增泛用型通用表情与生理系统控制器 `ExpressionController`，内置中/日/英多语系 Morph 语义映射表（支持 `blink`、`smile`、`talk_a/i/u/e/o`、`surprise` 等）；
- 新增无需动画文件的自然生理自动眨眼（Auto-blink 随机周期 2.5~5.5s + 平滑插值）；
- 新增表情阻尼平滑过渡（Ease-Out 插值）与权重安全钳位（[0, 1] 范围保证与未知 Morph 优雅降级）；
- 新增通用动作控制器 `MotionController`，支持 VMD 动画流式加载、循环播放、停止与世代防竞态隔离；
- 新增动作与表情控制系统的 10 项全自动单元测试与集成测试，全工作区测试增至 42 项。

### 变更

- `MmdModelHost` 深度整合表情与动作控制器，在模型加载时自动绑定主网格并进行语义探测；
- `CompanionClient` 增强事件分发机制，支持向壁纸场景实时下发服务端动作与表情指令；
- 壁纸渲染帧循环支持动作骨骼解算与每帧形态目标（Morph Target）的多步阻尼平滑推进。

### 修复

- 修复 `exactOptionalPropertyTypes` 开启时可选方法与属性的类型兼容性；
- 阻止非法表情权重（如负数、大于 1、NaN）导致的渲染通道越界；
- 隔离动作播放慢请求与迟到响应，确保快速切换动作时不会被旧动作覆盖。

### 架构影响

- 模型无论是否包含外部动作文件，均具备通用生动的面部生理反应能力；
- 动作与表情指令完全解耦并由 Companion 协议驱动，为后续接入 AI 聊天意图驱动面部表情与 TTS 口型同步奠定了标准化接口。

## [0.2.0] - 2026-08-15

### 新增

- 新增可随 Vite 构建进入 `dist/` 的 Wallpaper Engine 官方 `project.json`，包含英文/简体中文属性本地化；
- 新增强调色、Companion 端口、模型缩放和连接状态显示四项 Wallpaper Engine 用户属性；
- 新增 Git 忽略的 `rayure.local.json` 本机配置和不含私人信息的示例配置；
- 新增 Companion 令牌化只读资产网关，支持 PMX 及 MMD 常用纹理格式；
- 新增版本化 `model.available` 消息和 `model.catalog` 能力声明；
- 新增 `@yohawing/three-mmd-loader` PMX Renderer、边界拟合、材质/纹理加载和运行时更新；
- 新增 M1 Chromium 与 Wallpaper Engine 2.8.42 CEF 实机验收记录；
- 新增构建清单、WASM、依赖审计、本地配置和私人开发标记门禁。

### 变更

- Companion 从独立 WebSocket 监听器改为共享回环 HTTP/WS 服务，WebSocket 固定在 `/ws`；
- 角色文件权限从壁纸端任意路径访问改为 Companion 持有路径、壁纸仅接收一次性回环 URL；
- 3D 场景从占位体升级为占位体与事务式 PMX 模型双层结构；
- 工作区版本提升到 0.2.0，Renderer 构建标识提升到 `0.2.0-m1`；
- README、架构和迁移矩阵同步到已验证的 M1 状态。

### 修复

- 阻止远程网页 Origin 建立 Companion WebSocket 或读取本地模型；
- 阻止目录穿越、符号链接逃逸、未知扩展名、超大文件、非 GET/HEAD 方法和错误令牌访问资产；
- 阻止空配置、未知字段、相对路径、非 PMX、缺失文件和控制字符进入模型状态；
- 使用 generation 与 AbortController 隔离快速模型替换，迟到模型会释放而不会覆盖新模型；
- 模型加载失败时保留当前有效场景，页面销毁时释放 Runtime、Geometry、Material、Texture 和 Skeleton；
- 隔离会话消息构造异常，单个异常客户端只会以 1011 关闭，不会使 Companion 进程崩溃；
- 只释放加载器明确拥有的纹理，避免销毁 MMD 运行时共享的默认 Toon 纹理；
- 将持续旋转限制在占位体，避免真实角色随运行时间持续转身；
- Companion 端口变化时保留已加载角色，并在恢复端口后无闪烁重连。

### 架构影响

- M1 新增的是窄权限、只读、每次进程随机令牌保护的模型能力，不等同于通用文件访问；
- 私有测试资产仍完全外置，只有 `apps/wallpaper/dist/` 可以作为 Wallpaper Engine 发布候选；
- 摄像头、麦克风、执行、供应商凭据和正式资产库仍须经过持久配对与权限设计后才能进入协议。

## [0.1.0] - 2026-08-15

### 新增

- 建立 Rayure pnpm/TypeScript 工作区和统一验证入口；
- 新增 `@rayure/protocol`，提供 16 KiB 上限、版本化关联握手和严格字段校验；
- 新增仅监听 `127.0.0.1` 的 Companion WebSocket 服务；
- 新增 Wallpaper Engine Web 壁纸壳、Three.js 3D 占位场景、FPS/暂停回调和断线重连；
- 新增目标架构、StereoModelPlugin 迁移矩阵与 M0 验收记录；
- 新增私有模型、动作、录音、密钥与用户数据忽略规则。

### 变更

- 项目宿主从旧 StereoModelPlugin 的 AIRI Stage 插件路线改为 Wallpaper Engine Web wallpaper；
- Renderer 重新拥有 Three.js Scene、Camera 和帧循环，AIRI 不再是构建或运行依赖；
- 语音、视觉、模型文件和供应商能力统一规划在本地 Companion 的显式权限边界之后。

### 修复

- 阻止空白、科学计数法、分数和越界端口进入壁纸连接状态；
- 阻止非法 JSON、二进制消息、重复握手和沉默连接形成不明确会话；
- 使用连接 generation 隔离旧 WebSocket 的迟到事件，避免快速重连污染当前状态。
- 使用内联空图标避免壁纸预览产生无意义的 `favicon.ico` 网络错误。

### 架构影响

- M0 只开放无特权生命周期能力；文件、摄像头、麦克风和模型控制在配对认证完成前不可加入协议；
- 旧项目仅作为逐模块行为等价来源，不整体复制，也不修改其私有资产。
