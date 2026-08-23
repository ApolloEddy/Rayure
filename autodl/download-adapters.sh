#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# 从 hf-mirror 下载两个 LLM2Vec adapter 仓库(public, 不含 base 权重)。
# 目标布局与 LLM2VecEncoder 的 TEXT_ENCODERS_DIR 拼接逻辑一致:
#   $TEXT_ENCODERS_DIR/McGill-NLP/<repo>/
set -u

DEST="${1:-/root/autodl-tmp/rayure-autodl/text-encoders}"
REPOS="LLM2Vec-Meta-Llama-3-8B-Instruct-mntp LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised"

for repo in $REPOS; do
  dir="$DEST/McGill-NLP/$repo"
  mkdir -p "$dir"
  for f in adapter_config.json adapter_model.safetensors; do
    if [ -s "$dir/$f" ]; then
      echo "skip $repo/$f"
      continue
    fi
    ( curl -fsSL --retry 4 --retry-delay 3 -o "$dir/$f" \
        "https://hf-mirror.com/McGill-NLP/$repo/resolve/main/$f" \
        || echo "FAIL $repo/$f" >> adapter-dl.errors ) &
  done
done
wait
echo "adapter dl done"
ls -la "$DEST/McGill-NLP"/*/
cat adapter-dl.errors 2>/dev/null || true
