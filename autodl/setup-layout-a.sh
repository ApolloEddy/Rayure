#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# 构造上游 Layout A ground truth 环境:
#   1. 预置 HF 离线缓存, 把已 sha256 验证的 base 模型以 meta-llama/Meta-Llama-3-8B-Instruct
#      身份硬链进去(离线模式不校验 sha, refs/main 指向快照即可)
#   2. text-encoders-a/: adapter-only 目录 —— 只有 adapter 文件 + tokenizer, 无 config.json
#      无 base shards, 与 HF 上游仓库布局一致
set -u
cd /root/autodl-tmp/rayure-autodl || exit 1

SNAP="0000000000000000000000000000000000000000"
CACHE="hf-home/hub/models--meta-llama--Meta-Llama-3-8B-Instruct"
mkdir -p "$CACHE/snapshots/$SNAP" "$CACHE/refs"
echo "$SNAP" > "$CACHE/refs/main"
cp -l base-model/* "$CACHE/snapshots/$SNAP/"
ls "$CACHE/snapshots/$SNAP/" | head -5

mkdir -p text-encoders-a/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp
cp -l text-encoders/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp/adapter_config.json \
      text-encoders/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp/adapter_model.safetensors \
      text-encoders/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp/tokenizer.json \
      text-encoders/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp/tokenizer_config.json \
      text-encoders/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp/special_tokens_map.json \
      text-encoders-a/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp/
cp -lr text-encoders/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised \
       text-encoders-a/McGill-NLP/
echo "=== layout A ready ==="
ls -la text-encoders-a/McGill-NLP/*/
