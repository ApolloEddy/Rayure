# Auto-Rig Pro 试用证据与计划调整

日期：2026-08-26
状态：`TRIAL-PASS / PRODUCTION-UNDECIDED`
分支：`feat/offline-rig-pipeline`

## 结论

现有 Blender 4.2.23 LTS 可以加载并运行 Auto-Rig Pro 3.78.32 与 Quick Rig 1.27.21；不需要部署新的 Blender。Quick Rig 在一个从真实派蒙 MMD 骨架抽出的 16 骨核心夹具上完成了 `Quick Rig → Match to Rig`，生成 227 骨 ARP 控制 rig。

这不等于 ARP 能自动解决 MMD 骨名识别：Quick Rig 的内置 `mixamo` fuzzy 映射在派蒙原始 219 骨上只有 **1/16 个必需字段正确**，另外 12 个错误、3 个缺失。该自动映射不能进入生产，也不能被当作 HRS 失败的修复方案。

因此本报告只把 ARP 记为离线目标 rig 准备/重定向候选，不改变原有运行时纯播放边界，也不宣称 ARP 已完成 ARDY→目标骨架 bake。

## 本次环境

| 项目 | 结果 |
|---|---|
| Blender | 复用仓库已有 `scratch/rig-pipeline-poc/tools/blender-4.2.23-windows-x64/blender.exe`，4.2.23 LTS |
| ARP 主包 | `D:\Dev\Auto-Rig-Pro\packages\auto_rig_pro_3.78.32.zip`，SHA-256 `2BCEEB869E538D1ADFA307D83DF296452029DD147B0CC15E162D16D9CAFA04E1` |
| Quick Rig | `D:\Dev\Auto-Rig-Pro\packages\auto_rig_pro_quick_rig_1.27.21.zip`，SHA-256 `9DCFCCF3E1E3E7239F4DB66C5D595CAB0EC298C701871F065644251B0C0420BB` |
| HRS/Rig Bridge | 同一隔离 profile 内保留并启用 0.1.66，未删除、未改写 |
| 隔离 profile | `D:\Dev\Auto-Rig-Pro\blender-4.2-profile\4.2\` |
| 新 Blender | **未部署**；中止时生成的 4.5.12/5.2.0 下载临时文件已清理 |

独立配置同时通过 Blender headless 启动检查：ARP、Quick Rig、HRS 三个扩展均为 `(True, True)`，ARP 操作组和 HRS 操作组都已注册。

## 可复核试验

### 1. ARP/Quick Rig 注册

在 Blender 4.2.23 的隔离用户配置中安装两个 zip，并保存用户偏好后重新启动；三个扩展均能启用。ARP 主操作组包含 `arp.quick_make_rig`、`arp.retarget`、`arp.arp_export_gltf_panel` 等公开操作，HRS 的 `hrs.auto_guess` / `hrs.execute_retarget` 仍可见。

### 2. 真实 MMD 核心骨建 rig

从私有派蒙 `.blend` 通过 Blender library reader 读取原始 `派蒙_arm`，仅抽取以下 16 根骨，避免原文件中既有 Rigify 控制 rig 的依赖循环和坏 shape key 影响试验：

`Waist, UpperBody, UpperBody2, Head, Arm_L/Elbow_L/Wrist_L, Arm_R/Elbow_R/Wrist_R, Leg_L/Knee_L/Ankle_L, Leg_R/Knee_R/Ankle_R`

使用显式、已核验的六个 ARP limb 映射，在正常 `VIEW_3D` UI 上执行 Quick Rig builder 与 Match to Rig。结果：

- 输入骨架：16 骨；
- 输出：`Paimon_ARP_Test`（原骨架保留）+ `rig`（227 骨 ARP 控制 rig）；
- operator 结果：`FINISHED` + `MATCHED`；
- operator error：无；
- 原始 `.blend`：只读加载，未保存。

证据文件：

- `D:\Dev\Auto-Rig-Pro\artifacts\arp_paimon_core_skeleton_test.json`
  - SHA-256 `D0C7104C583AD8FA12B1DF9139ADC8093AA76F666F6262358CFC50F139050365`

注意：ARP 的 append/transform 内部需要真实 `VIEW_3D` 上下文；在 `--background` 里会出现 `space_data` 缺失或 Blender 访问冲突。因此“headless 进程可注册”与“ARP 建 rig 可运行”是两个独立证据门，生产 builder 不能直接假定 ARP 全流程支持无 UI。

### 3. MMD 自动映射负例

对同一私有派蒙 `派蒙_arm`（219 骨）调用 Quick Rig 内置 `mixamo` preset，并启用其 fuzzy match：

| 指标 | 数值 |
|---|---:|
| ARP 必需字段 | 16 |
| 正确 | 1 |
| 错误 | 12 |
| 缺失 | 3 |

错误示例包括把 ARP 手臂字段映射到 `WaistPartParent`、把腿字段映射到 `_dummy_LegD_R`；这是不可接受的语义错配。

证据文件：

- `D:\Dev\Auto-Rig-Pro\artifacts\arp_paimon_auto_mapping_test.json`
  - SHA-256 `3091A09B7F09B9350B9D06E5D7A9A54B3E6A20C2DEB7532DA8030947E01266CF`

## 对开发计划的调整

1. **Blender 版本不变。** 继续固定现有 4.2.23 LTS；取消 4.5/5.2 新版本部署和切换工作。
2. **增加 ARP 离线候选阶段。** 在导入后增加“ARP Quick Rig/ARP Remap 试验”节点，职责是目标 rig 准备和可能的离线 retarget/bake；不进入 Wallpaper/Companion 运行时。
3. **取消 fuzzy 自动映射作为方案。** 不使用 Quick Rig 内置 fuzzy 结果，不新增 Rayure alias/几何猜骨/正则映射；若继续 ARP，必须采用 ARP 自身的显式映射界面、可复核的用户映射，或另行验证其官方 AI marker 包。
4. **ARDY→BVH 转换器不变。** ARDY CoreSkeleton27、20 FPS、固定坐标与 round-trip 证据不因换工具而重写。
5. **HRS 保留为基准，不并行偷偷拼接。** 现有 HRS 0.1.66 安装和 Phase 2 HRS-only 失败报告保持历史有效；是否正式替换主 retarget 工具，要等 ARP 的真实 ARDY BVH→目标 rig bake 与 GLB clean-import 证据后再决定。
6. **生产改造继续冻结。** 在 ARP 完成真实动作重定向、烘焙、GLB 导出/无插件导入和至少一个完整授权模型验证前，不修改 `apps/`、`packages/` 或运行时协议。

## 尚未关闭的验收门

- 尚未用 ARDY BVH 在 ARP 上完成真实 `retarget → bake`；
- 尚未证明 ARP 输出保留目标模型可播放的骨架/蒙皮并通过 GLB clean import；
- 尚未在完整私有派蒙 `.blend` 上完成一次稳定、可复现的 ARP 全流程。该文件在 Blender 4.2 打开时报告坏 shape key，且含已有 Rigify 依赖循环；本轮只用抽取的核心骨夹具隔离验证；
- ARP 的 AI marker 功能需要另外的 Windows AI 1.21 包（约 524 MB），本轮未复制/安装；
- 正常 UI 上的 ARP 证据不等于生产 headless builder 证据，需单独设计受控 UI/构建机门禁。

## 私有资产边界

私有模型、纹理、动作和 ARP/AI 付费或用户提供包均保留在 `D:\Dev\Auto-Rig-Pro` 或原始资产目录，不进入 Git、`public/`、`dist/` 或发布物。仓库只提交本脱敏报告，不提交 `.blend`、GLB 或 ARP zip。
