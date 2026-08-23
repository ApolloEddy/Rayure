#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# LLM2Vec 加载冒烟测试(双路对账):
#   Way 1: ARDY 官方路径 load_text_encoder(mode="local")
#   Way 2: 手动显式链 base -> mntp(merge) -> supervised, 每个 adapter 恰好应用一次
# 两者对同一 prompt 的输出必须一致(bf16 精度内),否则说明官方链有双重应用
# 或权重错位问题,向量空间不可用。
# VRAM 注意: 4090 24GB 放不下两份 8B bf16 模型,所以 Way1 编码完立刻释放再进 Way2。
import json
import os

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TEXT_ENCODERS_DIR"] = "/root/autodl-tmp/rayure-autodl/text-encoders"

import torch

MNTP = "/root/autodl-tmp/rayure-autodl/text-encoders/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp"
SUP = "/root/autodl-tmp/rayure-autodl/text-encoders/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised"
BASE = "/root/autodl-tmp/rayure-autodl/base-model"

PROMPTS = ["casually wave", "walk forward"]

print("=== Way 1: official ARDY path ===", flush=True)
from ardy.model.load_model import load_text_encoder

enc = load_text_encoder(mode="local", device="cuda")
way1_name = enc.model.model.config._name_or_path
# 逐条 solo 编码: 官方运行时/cache 生成路径都是单条, 列表混编会让短句
# 的 left-pad position id 错位(批量伪影), 不是每条 prompt 的真实向量。
solo = [enc(p)[0] for p in PROMPTS]
t1 = torch.cat(solo, dim=0)
print(f"Way1 OK (solo): {t1.shape} {t1.dtype}", flush=True)
print(f"Way1 _name_or_path: {way1_name}", flush=True)

# 确定性:同一 prompt 编码两次(bf16 下预期 bit-exact)
t1b = torch.cat([enc(p)[0] for p in PROMPTS], dim=0)
same = torch.equal(t1, t1b)
print(f"determinism (same twice): {same}", flush=True)

# 值域 sanity(避免全零/爆炸)
# solo 调用返回 [1, 4096], 列表模式返回 [1, 1, 4096]; 统一成 [N, 4096]
v1 = (t1[:, 0, :] if t1.dim() == 3 else t1).float().cpu()
print(f"Way1[0] first 6: {v1[0][:6].tolist()}", flush=True)
print(f"Way1 mean abs: {v1.abs().mean().item():.5f}, std: {v1.std().item():.5f}", flush=True)

# 释放 Way1 模型再进 Way2,避免 24GB OOM
del enc
torch.cuda.empty_cache()
free_gib = torch.cuda.mem_get_info()[0] / 1024 ** 3
print(f"Way1 model released, free VRAM: {free_gib:.2f} GiB", flush=True)

print("=== Way 2: explicit manual chain ===", flush=True)
from transformers import AutoTokenizer, AutoConfig
from peft import PeftModel

from ardy.model.llm2vec.llm2vec import LLM2Vec
from ardy.model.llm2vec.models.bidirectional_llama import LlamaBiModel

tok = AutoTokenizer.from_pretrained(MNTP)
tok.pad_token = tok.eos_token
tok.padding_side = "left"
cfg = AutoConfig.from_pretrained(MNTP)
print(f"config class: {cfg.__class__.__name__}, name_or_path: {cfg._name_or_path}", flush=True)
m = LlamaBiModel.from_pretrained(BASE, torch_dtype=torch.bfloat16)
# 镜像 llm2vec.py 135-139: 本地目录加载会覆写 _name_or_path, 必须从 config.json 恢复,
# 否则 prepare_for_tokenization 不加 Llama-3 指令头, 向量空间整体偏移。
with open(f"{MNTP}/config.json", "r", encoding="utf-8") as handle:
    m.config._name_or_path = json.load(handle).get("_name_or_path")
print(f"Way2 _name_or_path restored to: {m.config._name_or_path}", flush=True)
m = PeftModel.from_pretrained(m, MNTP).merge_and_unload()
m = PeftModel.from_pretrained(m, SUP)
m2 = LLM2Vec(model=m, tokenizer=tok)
v2 = m2.encode(PROMPTS, batch_size=1, show_progress_bar=False, device="cuda")
print(f"Way2 OK: {v2.shape} {v2.dtype}", flush=True)

# --- 对账 ---
v2f = v2.float().cpu()
diff = (v1 - v2f).abs()
print(f"max abs diff: {diff.max().item():.6f}")
print(f"mean abs diff: {diff.mean().item():.8f}")
rel = diff / (v2f.abs() + 1e-6)
print(f"max rel diff: {rel.max().item():.6f}")

ok = diff.max().item() < 1e-2 and same
print("SMOKE_TEST", "PASS" if ok else "FAIL")
