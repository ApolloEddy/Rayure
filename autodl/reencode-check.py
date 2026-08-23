#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# 全链路对账: 官方路径现场重编码 wave.casual / walk.forward 的 canonicalPrompt,
# 与 generate-embeddings.py 写入 sample-features.json 的 cache 值逐元素比较,
# 证明 编码 -> fp16 -> base64 打包 全程无错位(预期 bitwise 一致)。
import base64
import json
import os

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TEXT_ENCODERS_DIR"] = "/root/autodl-tmp/rayure-autodl/text-encoders"

import numpy as np
from ardy.model.load_model import load_text_encoder

FEAT = "/root/autodl-tmp/rayure-autodl/sample-features.json"
feat = json.load(open(FEAT, encoding="utf-8"))
entries = {entry["cacheKey"]: entry for entry in feat["entries"]}
print(f"cache entries: {len(entries)}", flush=True)

enc = load_text_encoder(mode="local", device="cuda")
ok = True
for key in ("wave.casual", "walk.forward"):
    entry = entries[key]
    prompt = entry["canonicalPrompt"]
    tensor, lengths = enc(prompt)
    assert lengths == 1, f"unexpected lengths {lengths}"
    ref = tensor[0].detach().cpu().float().numpy().astype("<f2")
    vals = np.frombuffer(base64.b64decode(entry["valuesBase64"]), dtype="<f2")
    diff = np.abs(vals.astype(np.float32) - ref.astype(np.float32)).max()
    print(f"{key}: prompt={prompt!r} cacheShape={vals.shape} maxDiff={diff:.8f}", flush=True)
    ok = ok and vals.shape == (4096,) and diff == 0
print("REENCODE_CHECK", "PASS" if ok else "FAIL", flush=True)
