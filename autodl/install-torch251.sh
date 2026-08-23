#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# 安装 torch 2.5.1+cu121 + torchvision 0.20.1 —— cu121 系列的最终版本(主机驱动 12.1)。
# 原因: transformers 5.8.1 的 integrations/moe.py 在 import 期调用
# torch.library.custom_op, torch 2.4.0 的 infer_schema 不支持字符串注解直接
# ValueError, 需要 torch>=2.5。wheel 来自 aliyun pytorch-wheels(已验证可达),
# nvidia-* 依赖从 tsinghua PyPI 补。
set -u
cd /root/autodl-tmp/rayure-autodl || exit 1

WHEEL="torch-2.5.1+cu121-cp312-cp312-linux_x86_64.whl"
if [ ! -s "$WHEEL" ]; then
  curl -fsSL --retry 4 --retry-delay 3 -o "$WHEEL" \
    "https://mirrors.aliyun.com/pytorch-wheels/cu121/torch-2.5.1%2Bcu121-cp312-cp312-linux_x86_64.whl" \
    || { echo TORCH251_FAILED_dl; exit 1; }
fi
ls -la "$WHEEL"

python3 -m pip install --no-cache-dir "./$WHEEL" "torchvision==0.20.1" \
  --extra-index-url https://pypi.tuna.tsinghua.edu.cn/simple \
  || { echo TORCH251_FAILED_pip; exit 1; }

python3 -c "import torch, torchvision; print('torch', torch.__version__, 'tv', torchvision.__version__, 'cuda', torch.cuda.is_available())" \
  || { echo TORCH251_FAILED_import; exit 1; }
python3 -c "from transformers import BloomPreTrainedModel; print('bloom-import-ok')" \
  || { echo TORCH251_FAILED_tf_bloom; exit 1; }
python3 -c "from peft import PeftModel; print('peft-import-ok')" \
  || { echo TORCH251_FAILED_peft; exit 1; }
echo torch251_done
