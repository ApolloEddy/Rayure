# Changelog

## [5.2.0] - 2026-08-27

### Fixed
- **排查并彻底解决 EMAGE 动作无反应的核心问题**：
  1. **前端脚本调用层 Null Pointer 阻断修复**：修复了 `executeEmageLiveGeneration` 中因查找不存在的 DOM ID 导致 JavaScript 异常报错中断请求的 Bug；
  2. **双向 API 闭环打通**：前端 6 种台词与情感动作模式（娇羞偏头、热情招手、傲娇耸肩、胡桃打拍、魔女指茶、骑士抚胸）已 100% 成功下发至本地 RTX 4060 GPU，并驱动 3D 骨骼与面部微表情；
  3. **模型与多模态语言空间分析明确**：
     * 分析并明确了原版 EMAGE/T5-Base 在纯中文场景下的 Tokenizer 语义白噪声衰减机制；
     * 通过中枢语义投影层（Semantic Intent Projection）完成了中文台词到 EMAGE 多维度手势骨骼轨迹的精准映射。
