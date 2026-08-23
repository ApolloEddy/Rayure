# Rayure AutoDL 词向量生成

在云端一次性把「提示词字典」编译成本地可消费的 ARDY 文本条件缓存
（`rayure.motion-semantic-cache.v1`）。本地 4060 只跑动作模型、不跑文本编码器
（Llama-3-8B-Instruct 约 14GB 显存），字典在 AutoDL 批量编码后**下载回本地文件**，
Companion 每次启动读缓存即用，链路不再需要任何 LLM。

## 流程总览

```text
AutoDL(24GB 卡, 一次性)
  setup-autodl.sh            # 一键装环境(ARDY 依赖 + LLM2Vec 权重)
  generate-embeddings.py     # 把 prompts.json 编码为 motion-features.json
        |
        | 下载回本地
        v
本地 rayure.local.json 的 motionSemantic.cachePath 指向该文件
        |
        v
Companion 启动 → 缓存命中 → ARDY Bridge(本地 4060)按语义生成动作 → motion.published
```

## 批量字典生成(可选,DeepSeek)

`generate-dictionary.py` 用 DeepSeek(OpenAI 兼容 API)生成意图种子,再在本地
按「速度/幅度/情感/方向/时长」修饰维度模板展开成大批量,避免让 LLM 逐条吐几万
条(那要数小时)。**该步只在本机跑,不占服务器。**

```powershell
$env:DEEPSEEK_API_KEY = "sk-..."      # DeepSeek Platform 申请
python autodl/generate-dictionary.py --target 30000 --out dictionary.json
```

- 覆盖网格:21 个动作类别 × 5 种粒度(字/词/短句/长句/组合),默认每格 120 条种子;
- 3000 条种子 × 10 变体 ≈ 3 万条目;DeepSeek 约 30–60 分钟,成本 < ¥1;
- 种子按格缓存(`dictionary.seed-state.json`),`--resume` 可断点续跑;
- 输出 JSON 数组 `{"cacheKey", "prompt", "category", "granularity"}`,
  可直接喂给 `generate-embeddings.py`(额外字段会被忽略);
- 容量参考:`rayure.motion-semantic-cache.v1` 上限 512 MiB / 10 万条;
  **sentence + fp16 模式(8 KiB/条)第一批最多 ≈ 3.2 万条**,对应 4090 编码约 3 小时。

## 第一步:创建 AutoDL 实例(一次性)

- 镜像选择 **PyTorch 2.5+ / Python 3.11 / CUDA 12.x**(PyTorch 镜像已自带 torch,
  避免 pip 重装 CUDA 轮子);
- 显卡建议 **单卡 24GB**(RTX 4090 / A5000 / A6000);LLM2Vec bf16 约 14GB;
- 硬盘默认即可(模型约 16GB + venv)。

## 第二步:一键配置环境

把 `autodl/` 目录上传到实例(或用任意方式拷贝),然后:

```bash
cd /root/rayure-autodl        # 或你选的工作目录
bash setup-autodl.sh          # 网络不顺畅时: HF_ENDPOINT=https://hf-mirror.com bash setup-autodl.sh
```

脚本完成:系统依赖(cmake/build-essential,编译 motion-correction C++ 扩展)、
clone `nv-tlabs/ardy`、`pip install -e`(仅核心依赖,跳过 viser/TensorRT 重依赖)、
预下载两个 McGill-NLP LLM2Vec 权重仓库(约 16GB,可 `SKIP_MODEL_DOWNLOAD=1` 跳过)。

## 第三步:编译字典

准备提示词字典(复制 `prompts.example.json` 改名为 `prompts.json` 后编辑):

```json
[
  { "cacheKey": "wave.casual", "prompt": "A person waves their hand casually" },
  { "cacheKey": "walk.forward", "prompt": "A person walks forward slowly" }
]
```

运行:

```bash
source ~/.bashrc   # 载入 TEXT_ENCODERS_DIR
python3 generate-embeddings.py --dictionary prompts.json --out motion-features.json
# 常用选项:
#   --mode token    每个文档 token 一条 4096 维特征(默认 sentence=官方 mean-pooled 单向量)
#   --dtype float16 特征用 FP16 存储,文件减半
#   --resume        跳过输出文件中已存在的 cacheKey(断点续传)
#   --device cuda   bf16 模型 + 逐条编码,显存 ~14GB 稳定
```

产出约:每条 `tokenCount=1` 时 FP32 16 KiB / FP16 8 KiB。几千条为几十 MB。

## 第四步:回传本地并验证

1. 把 `motion-features.json` 下载回本机;
2. 修改 `rayure.local.json` 的 `motionSemantic.cachePath` 指向该文件
   (或者直接覆盖原来的文件,推荐前者,便于回滚);
3. 启动 Companion(`pnpm dev:companion`),观察日志:
   - `companion.ready` 中 `motionSemanticCacheEntries` 应为字典条数;
   - `startupGenerate` 若使用字典中的 cacheKey/prompt,将直接缓存命中并发布动作;
4. `pnpm verify` 全量回归。

## 字典设计建议(可以之后再细讨论批量扩充)

- **cacheKey** 是行为层(未来的 ASR/LLM 意图)查找条件的键,建议
  `动作.风格` 命名(`wave.casual`),只允许 `[A-Za-z0-9._:-]`、≤128 字符;
- **prompt** 用英文描述句,风格对齐官方训练分布:「A person …」开头;
  中文 tokenizer 能编但生成质量通常明显更差;
- 同义意图可以共用一个 cacheKey(缓存命中即省一次编码),例如把
  「挥手」「hello」「打招呼」都映射到 `wave.casual`;
- `startupGenerate` 的 `id`/`prompt` 与字典条目一致时,启动即演示真实语义动作。

## sentence 与 token 模式

| 模式 | 内容 | 与官方一致性 |
|---|---|---|
| `sentence`(默认) | 每个 prompt 一条 mean-pooled 4096 维向量(`tokenCount=1`) | 与 ARDY 内建 `LLM2VecEncoder` 输出逐位一致,推荐默认 |
| `token` | 文档 token 的逐位上下文特征(`tokenCount=N≤256`) | 合同允许、模型可消费(Spike 已用 `[1,N,4096]` 验证),但非官方推理路径 |

## 常见问题

- **HF 下载慢/失败**:`HF_ENDPOINT=https://hf-mirror.com` 重跑 setup 或生成脚本;
  McGill-NLP 两个仓库公开,一般不需要 `HF_TOKEN`;
- **pip 装 ardy 时重装 torch**:AutoDL PyTorch 镜像自带 torch,满足
  `torch>=2.4.0a0` 时 pip 不会替换;若被替换,重新选带 CUDA 的 PyTorch 镜像最省事;
- **transformers 固定 5.8.1**:pyproject 已锁定,LLM2Vec 内嵌实现按该版本测试;
- **生成条目与本地缓存合并**:缓存是「按 cacheKey 键值合并」,用 `--resume`
  或直接替换文件都行;重复 cacheKey 会在 Companion 加载时报错。
