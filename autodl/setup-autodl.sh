#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# AutoDL 一键环境配置脚本(Rayure 词向量生成)。
#
# 在 AutoDL 实例上配置 LLM2Vec 文本编码器环境,使 autodl/generate-embeddings.py
# 可以批量把提示词字典编译为 rayure.motion-semantic-cache.v1 缓存文件。
#
# 推荐的 AutoDL 镜像:PyTorch 2.5+ / Python 3.11 / CUDA 12.x(单卡 24GB,如 RTX 4090)。
# 显存需求:LLM2Vec + Llama-3-8B-Instruct bf16 约 14GB,24GB 卡绰绰有余。
#
# 用法(在 AutoDL 终端,建议在 /root/autodl-tmp 或 /root 下):
#   bash setup-autodl.sh [工作目录]
#
# 可选环境变量:
#   ARDY_REPO=https://github.com/nv-tlabs/ardy    # ARDY 源码仓库
#   HF_ENDPOINT=https://hf-mirror.com             # 国内镜像;留空则用官方 huggingface.co
#   SKIP_MODEL_DOWNLOAD=1                         # 跳过预下载 LLM2Vec 权重(首次运行生成脚本时再下)
#   EXTRA_PIP_INDEX=                              # 额外 pip 源(如 https://pypi.tuna.tsinghua.edu.cn/simple)

set -euo pipefail

WORKDIR="${1:-/root/rayure-autodl}"
ARDY_REPO="${ARDY_REPO:-https://github.com/nv-tlabs/ardy}"
ARDY_DIR="$WORKDIR/ardy"
TEXT_ENCODERS_DIR="$WORKDIR/text-encoders"
LOG_PREFIX="[rayure-autodl]"

say() { echo "$LOG_PREFIX $*"; }
die() { echo "$LOG_PREFIX ERROR: $*" >&2; exit 1; }

# 0. 环境预检 --------------------------------------------------------------
command -v python3 >/dev/null || die "python3 not found; 请选用带 Python 的 PyTorch 镜像"
PY_MAJOR=$(python3 -c 'import sys; print(sys.version_info[0])')
PY_MINOR=$(python3 -c 'import sys; print(sys.version_info[1])')
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
  die "需要 Python >= 3.10,当前 $PY_MAJOR.$PY_MINOR"
fi
say "Python $PY_MAJOR.$PY_MINOR OK"

if ! nvidia-smi >/dev/null 2>&1; then
  say "警告:未检测到 NVIDIA GPU(nvidia-smi 失败)。生成脚本仍可 CPU 运行但极慢,建议先在控制台切换 GPU 实例。"
else
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1 | sed 's/^/GPU: /'
fi

# 1. 系统依赖:编译 motion-correction C++ 扩展 ---------------------------------
if ! command -v cmake >/dev/null || ! command -v gcc >/dev/null; then
  say "安装 cmake / build-essential(motion-correction 编译需要)..."
  apt-get update -y
  apt-get install -y --no-install-recommends cmake build-essential
else
  say "cmake / gcc 已存在"
fi

# 2. 目录与 ARDY 源码 ----------------------------------------------------------
mkdir -p "$WORKDIR" "$TEXT_ENCODERS_DIR"
if [ -d "$ARDY_DIR/.git" ]; then
  say "ARDY 源码已存在,git pull 更新"
  git -C "$ARDY_DIR" pull --ff-only || say "git pull 失败(忽略,继续使用现有源码)"
elif [ -d "$ARDY_DIR" ]; then
  say "ARDY 目录已存在但非 git 仓库,直接复用"
else
  say "克隆 nv-tlabs/ardy ..."
  # GitHub 的 git 协议链路在国内机房常被掐断(HTTP/2 CANCEL / TLS 重置);
  # 强制 HTTP/1.1 重试 3 次,仍失败则降级为 codeload 源码包(一次性使用,
  # 不需要 .git 目录)。
  CLONE_OK=0
  for attempt in 1 2 3; do
    if git -c http.version=HTTP/1.1 clone --depth 1 "$ARDY_REPO" "$ARDY_DIR"; then
      CLONE_OK=1
      break
    fi
    say "git clone 第 $attempt/3 次失败,清理后 5 秒重试..."
    rm -rf "$ARDY_DIR"
    sleep 5
  done
  if [ "$CLONE_OK" != "1" ]; then
    say "git clone 失败,改用 codeload 源码包(codeload 域名通常可达)..."
    if curl -fsSL --retry 3 --retry-delay 3 -o "$WORKDIR/ardy.tar.gz" \
        "https://codeload.github.com/nv-tlabs/ardy/tar.gz/refs/heads/main"; then
      mkdir -p "$ARDY_DIR"
      tar -xzf "$WORKDIR/ardy.tar.gz" -C "$ARDY_DIR" --strip-components=1
      rm -f "$WORKDIR/ardy.tar.gz"
      say "ARDY 源码包就绪($ARDY_DIR,非 git 目录)"
    else
      die "克隆/下载 ARDY 全部失败;请检查网络"
    fi
  fi
fi

# 3. Python 依赖 ----------------------------------------------------------------
# ARDY 要求 torch>=2.4.0a0 / transformers==5.8.1 / numpy<2。镜像自带 torch 若
# 低于 2.4,pip 会换成 PyPI 最新默认轮子(捆绑 CUDA 12.8+),旧驱动(如 12.1)
# 加载不了,GPU 直接不可用。因此:先按需补装 cu121 版 torch(2.4.x 是最后支持
# cu121 的版本,与主机驱动匹配),再装 ARDY;装 ARDY 时严禁 --upgrade,否则
# 已满足约束的 torch 也会被替换。
if [ "${SKIP_TORCH_FIX:-0}" = "1" ]; then
  say "SKIP_TORCH_FIX=1,跳过 torch 补装(镜像自带 torch 已 GPU 可用时配合改 pyproject 使用)"
elif ! python3 -c '
import sys
try:
    import torch
    major, minor = (int(p) for p in torch.__version__.split("+")[0].split(".")[:2])
    sys.exit(0 if (major, minor) >= (2, 4) else 1)
except ImportError:
    sys.exit(1)
'; then
  say "镜像 torch < 2.4,安装 cu121 兼容轮子(torch==2.4.*)..."
  python3 -m pip install "torch==2.4.*" --index-url https://download.pytorch.org/whl/cu121 \
    || die "torch cu121 安装失败;网络受限可先设置 EXTRA_PIP_INDEX 镜像源再重试"
else
  say "镜像 torch 满足 >=2.4,保持不变"
fi

say "安装 ARDY 核心依赖(不安装 demo/trt extras:viser 编译重、TensorRT 非必需)..."
PIP_ARGS=()
if [ -n "${EXTRA_PIP_INDEX:-}" ]; then
  PIP_ARGS+=("--index-url" "$EXTRA_PIP_INDEX")
fi
python3 -m pip install "${PIP_ARGS[@]}" -e "$ARDY_DIR" \
  || die "ARDY 依赖安装失败;若为网络问题请设置 EXTRA_PIP_INDEX 或 EXTRA_PIP_MIRROR"

say "确认关键版本(pyproject 固定 transformers==5.8.1,生成脚本依赖其 API):"
python3 -c '
import torch, transformers
print(f"  torch {torch.__version__} | cuda {torch.version.cuda}")
print(f"  transformers {transformers.__version__}")
print(f"  cuda available: {torch.cuda.is_available()}")
if not torch.cuda.is_available():
    print("ERROR: torch 看不到 GPU。可能原因:镜像 CUDA 版本高于主机驱动上限,",
          "或 pip 把 torch 换成了不兼容的默认轮子(cu12x+)。", file=__import__("sys").stderr)
    raise SystemExit(1)
'

# 4. 预下载 LLM2Vec 文本编码器权重(可选) ---------------------------------------
# 生成脚本经 ardy.model.load_model.load_text_encoder(mode="local") 加载;设置
# TEXT_ENCODERS_DIR 后 LLM2VecEncoder 会从该目录拼接模型名加载,便于离线复用。
if [ "${SKIP_MODEL_DOWNLOAD:-0}" != "1" ]; then
  if [ -n "${HF_ENDPOINT:-}" ]; then
    export HF_ENDPOINT
    say "使用 HF 镜像: $HF_ENDPOINT"
  fi
  say "预下载 LLM2Vec 权重(两个仓库,合计约 16GB,含 Llama-3-8B-Instruct 权重)..."
  HF_CLI=$(command -v hf || command -v huggingface-cli || true)
  if [ -z "$HF_CLI" ]; then
    say "未找到 hf/huggingface-cli,先安装 huggingface_hub ..."
    python3 -m pip install --upgrade huggingface_hub
    HF_CLI=$(command -v hf || command -v huggingface-cli || true)
  fi
  [ -n "$HF_CLI" ] || die "huggingface_hub 安装后仍未找到 hf/huggingface-cli"
  HF_CLI_NAME=$(basename "$HF_CLI")
  "$HF_CLI_NAME" download \
    --local-dir "$TEXT_ENCODERS_DIR/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp" \
    "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp"
  "$HF_CLI_NAME" download \
    --local-dir "$TEXT_ENCODERS_DIR/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised" \
    "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised"
  say "LLM2Vec 权重已就绪: $TEXT_ENCODERS_DIR"
else
  say "SKIP_MODEL_DOWNLOAD=1,跳过预下载(首次运行生成脚本时将在线下载)"
fi

# 5. 环境变量写入 bashrc,便于后续会话复用 ---------------------------------------
cat >> "$HOME/.bashrc" <<EOF
# Rayure AutoDL 环境(由 setup-autodl.sh 生成)
export TEXT_ENCODERS_DIR="$TEXT_ENCODERS_DIR"
${HF_ENDPOINT:+export HF_ENDPOINT="$HF_ENDPOINT"}
EOF

say "完成。下一步:"
say "  1. 把提示词字典上传到 $WORKDIR (如 prompts.json,模板见 autodl/prompts.example.json)"
say "  2. 运行: source \$HOME/.bashrc"
say "  3. 运行: python3 $WORKDIR/generate-embeddings.py --dictionary prompts.json --out motion-features.json"
say "  4. 把 motion-features.json 下载回本地,覆盖 rayure.local.json 中 motionSemantic.cachePath 指向的文件"
