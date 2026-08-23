#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# 安装 torch 2.4.0+cu121 —— 最后一个 cu121 wheel(主机驱动 12.1, cu124+ 不可用)。
# transformers 5.8.1 运行时要求 torch>=2.4, 否则直接禁用 torch 后端。
# wheel 来自 aliyun pytorch-wheels 镜像(已验证可达), nvidia-* 依赖从 tsinghua PyPI 补。
set -u
cd /root/autodl-tmp/rayure-autodl || exit 1

WHEEL="torch-2.4.0+cu121-cp312-cp312-linux_x86_64.whl"
if [ ! -s "$WHEEL" ]; then
  curl -fsSL --retry 4 --retry-delay 3 -o "$WHEEL" \
    "https://mirrors.aliyun.com/pytorch-wheels/cu121/torch-2.4.0%2Bcu121-cp312-cp312-linux_x86_64.whl" \
    || { echo TORCH24_FAILED_dl; exit 1; }
fi
ls -la "$WHEEL"

python3 -m pip install --no-cache-dir "./$WHEEL" \
  --extra-index-url https://pypi.tuna.tsinghua.edu.cn/simple \
  || { echo TORCH24_FAILED_pip; exit 1; }

python3 -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())" \
  || { echo TORCH24_FAILED_import; exit 1; }
python3 -c "from transformers.generation import GenerationMixin; print('transformers-generation-ok')" \
  || { echo TORCH24_FAILED_tf; exit 1; }
echo torch24_done
