# ARDY → MediaPipe / MiKaPo → MMD Phase 2 记录

日期：2026-08-27  
实施分支：`codex/ardy-mikapo-poc`  
Phase 1 基线：`7f42183`

## 运行边界

本阶段只在锁定的 MiKaPo GPL 工作区运行普通 Edge（WebGPU/WebGL），没有把 MiKaPo 源码、模型、贴图或导出物加入 Rayure tracked tree。目标 PMX 从仓库外的 `assets/胡桃_by_原神` 目录只读选择；模型与相对贴图一起加载，不做复制或修补。

| 项目 | 观测值 |
|---|---|
| MiKaPo commit | `3beba37925378820710c50e5e82e266396842680` |
| MediaPipe | `@mediapipe/tasks-vision` `0.10.32` |
| Reze Engine | `0.50.7` |
| 输入视频 | Phase 1 WebM，`231,484` bytes，媒体时长约 `3.612632 s` |
| 本地目标 | 外部 `胡桃_by_原神/胡桃.pmx`；目录输入成功，完整贴图模型可见 |

## Gold path 结果

1. 将 Phase 1 WebM 上传到**未修改的原版 MiKaPo**；页面从 20 FPS source WebM 按 30 FPS 时间步执行 HolisticLandmarker。
2. 通过 `Use Your Model` 目录选择器上传本地 PMX 目录。Reze Engine 完成 PMX 解析、rest-pose 读取和模型渲染；胡桃模型的颜色、头发、服装和饰品均可见，未出现缺贴图 fallback。
3. 导出按钮完成离线检测/解算，页面状态显示 `109f · 3.6s saved`，Edge 下载 `mikapo-2026-08-27-11-18-23.vmd`（`629,751` bytes）。
4. 目标模型在转换过程中接受 BoneState；转换前 0 秒画面为双臂下垂，转换末帧画面为双臂展开，说明不是只生成空 VMD 或只加载静态 PMX。

## VMD 结构与时长复核

对下载文件做只读二进制复核：

```text
header       = Vocaloid Motion Data 0002
bone frames  = 5559
unique bones = 51
first frame  = 0
last frame   = 108
duration     = 108 / 30 = 3.6 s
morph frames = 545
```

因此 VMD 时长与页面导出摘要一致，误差小于 1 个 30 FPS 帧；骨骼帧、morph 帧和尾部 section count 均可读。MiKaPo 页面本身没有 VMD 文件选择控件，本阶段的“重新载入”由 Reze Engine 的 `VMDLoader`/`Model.loadVmd` 代码路径和上述格式复核覆盖；实际可视化重载控件留到 Phase 3 Workbench，一并做浏览器播放验收。

## 已发现的可复现操作注意事项

原版页面在同一页面连续第二次转换时，若上一轮视频停在末尾，实时 loop 仍可能有一帧在 worker 中，导致 MediaPipe 报 `Packet timestamp mismatch`。按“重新载入页面 → 先选 PMX → 再上传 WebM → 等待 ready → 导出”顺序可稳定完成本阶段导出；这属于上游 UI/worker 生命周期问题，不是 solver 或 PMX 校准失败。Phase 3 会在隔离 PoC 中增加显式 run/reset/backpressure 处理，保持 solver 数学不变。

## 阶段结论

- [x] Phase 1 CoreSkin WebM 可被原版 MiKaPo 识别并产生 Pose33 结果。
- [x] 一个外部本地 PMX 成功加载、校准并被 BoneState 驱动。
- [x] VMD 导出文件结构有效，时长为 `3.6 s`，未观察到整体镜像或持续反折。
- [ ] 同页 VMD 文件选择、重载并播放：转入 Phase 3 Workbench 补齐可操作证据。
- [ ] 普通 Edge 结果不外推 Wallpaper Engine CEF；许可与资产公开门仍保持关闭。
