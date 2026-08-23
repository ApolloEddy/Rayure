#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# 带 sha256 验证循环的下载器:下载后逐字节校验,失败自动重下(断点续传)。
# 用法: download-verified.sh <url> <目标文件> <期望sha256> [重试次数]
set -u

URL="$1"; DEST="$2"; EXPECT="$3"; MAX_TRIES="${4:-8}"

for i in $(seq 1 "$MAX_TRIES"); do
  curl -fSL -C - --retry 3 --retry-delay 2 -o "$DEST" "$URL" 2>/dev/null
  ACTUAL=$(sha256sum "$DEST" 2>/dev/null | awk '{print $1}')
  if [ "$ACTUAL" = "$EXPECT" ]; then
    echo "OK $(basename "$DEST") (try $i)"
    exit 0
  fi
  echo "try $i: sha mismatch ($(stat -c%s "$DEST" 2>/dev/null || echo 0) bytes), re-downloading..."
  sleep 2
done
echo "FAIL $DEST after $MAX_TRIES tries" >&2
exit 1
