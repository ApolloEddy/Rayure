#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# 从 ModelScope 下载 Llama-3-8B-Instruct 权重(LLM2Vec base model)。
# LLM-Research/Meta-Llama-3-8B-Instruct 是 ModelScope 官方转存的 meta-llama 权重,
# 与 LLM2Vec adapter 的 base_model (meta-llama/Meta-Llama-3-8B-Instruct) 一致。
# 用法: bash download-base.sh <目标目录>
set -u

DEST="${1:-/root/autodl-tmp/rayure-autodl/base-model}"
mkdir -p "$DEST"
cd "$DEST" || exit 1

FILES="config.json generation_config.json model.safetensors.index.json special_tokens_map.json tokenizer.json tokenizer_config.json model-00001-of-00004.safetensors model-00002-of-00004.safetensors model-00003-of-00004.safetensors model-00004-of-00004.safetensors"
BASE_URL="https://modelscope.cn/models/LLM-Research/Meta-Llama-3-8B-Instruct/resolve/master"

for f in $FILES; do
  if [ -s "$f" ]; then
    echo "skip $f (已存在)"
    continue
  fi
  ( curl -fsSL --retry 4 --retry-delay 3 -o "$f" "$BASE_URL/$f" \
      || echo "FAIL $f" >> dl.errors ) &
done
wait

FAIL_COUNT=$(wc -l < dl.errors 2>/dev/null || echo 0)
echo "dl.errors: $FAIL_COUNT"
ls -la | grep -E 'safetensors|tokenizer|config'
