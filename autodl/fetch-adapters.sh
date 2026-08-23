#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# 下载 LLM2Vec 两个 adapter 仓库的全部必需文件,大文件走 sha256 验证循环。
# 官方 sha256 来自 huggingface.co API(?blobs=true) 的 LFS sha256 字段。
set -u

ROOT="/root/autodl-tmp/rayure-autodl/text-encoders/McGill-NLP"
HF="https://hf-mirror.com"

MNTP_DIR="$ROOT/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp"
SUP_DIR="$ROOT/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised"
mkdir -p "$MNTP_DIR" "$SUP_DIR"

# --- mntp: 大权重(sha256 验证) + 小文件(大小检查) ---
bash /root/autodl-tmp/rayure-autodl/download-verified.sh \
  "$HF/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp/resolve/main/adapter_model.safetensors" \
  "$MNTP_DIR/adapter_model.safetensors" \
  de9c8736618a13173c6a1623cdef1b75e86c69317f1073ae82cd516ac36a632d &
P1=$!

for f in "tokenizer.json:9085671" "tokenizer_config.json:51042" "special_tokens_map.json:335"; do
  name="${f%%:*}"; want="${f##*:}"
  ( for i in 1 2 3 4 5; do
      curl -fsSL --retry 2 -o "$MNTP_DIR/$name" "$HF/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp/resolve/main/$name" 2>/dev/null
      [ "$(stat -c%s "$MNTP_DIR/$name" 2>/dev/null || echo 0)" = "$want" ] && { echo "OK $name"; exit 0; }
      sleep 2
    done
    echo "FAIL $name" >&2 ) &
done

# --- supervised: 大权重(sha256 验证) ---
bash /root/autodl-tmp/rayure-autodl/download-verified.sh \
  "$HF/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised/resolve/main/adapter_model.safetensors" \
  "$SUP_DIR/adapter_model.safetensors" \
  53f8f94ebdf396667ba99dd96e78203edae27bbcdbd1cf5f12b611e1d916b225 &
P2=$!

wait $P1 $P2
echo "=== all adapter downloads done ==="
ls -la "$MNTP_DIR" "$SUP_DIR"
