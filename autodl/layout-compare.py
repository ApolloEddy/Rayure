#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# 终极对账: 三种构建链对同一 prompt 的编码结果
#   layoutB: 当前内嵌布局(text-encoders/)官方路径 load_text_encoder
#   manual : 手动显式链 base -> mntp(merge) -> supervised(不 merge)
#   layoutA: 上游 adapter-only 布局(text-encoders-a/)官方路径, base 从预置 HF 缓存解析
# 上游 Layout A 是 ground truth; 与它一致的链才是正确的向量空间。
import json
import os

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HOME"] = "/root/autodl-tmp/rayure-autodl/hf-home"

import torch

BASE = "/root/autodl-tmp/rayure-autodl/base-model"
MNTP_B = "/root/autodl-tmp/rayure-autodl/text-encoders/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp"
SUP_B = "/root/autodl-tmp/rayure-autodl/text-encoders/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised"
OUT = "/root/autodl-tmp/rayure-autodl/vectors"
PROMPTS = ["casually wave", "walk forward"]


def release() -> None:
    torch.cuda.empty_cache()


def official(encoders_dir: str, label: str) -> None:
    os.environ["TEXT_ENCODERS_DIR"] = encoders_dir
    from ardy.model.load_model import load_text_encoder

    enc = load_text_encoder(mode="local", device="cuda")
    name = enc.model.model.config._name_or_path
    solo = [enc(p)[0] for p in PROMPTS]
    t = torch.cat(solo, dim=0)
    v = (t[:, 0, :] if t.dim() == 3 else t).float().cpu()
    torch.save(v, f"{OUT}-{label}.pt")
    print(f"{label}: OK {tuple(v.shape)}, _name_or_path={name}, first6={v[0][:6].tolist()}", flush=True)
    del enc, solo, t, v
    release()


def manual(label: str) -> None:
    from transformers import AutoTokenizer
    from peft import PeftModel

    from ardy.model.llm2vec.llm2vec import LLM2Vec
    from ardy.model.llm2vec.models.bidirectional_llama import LlamaBiModel

    tok = AutoTokenizer.from_pretrained(MNTP_B)
    tok.pad_token = tok.eos_token
    tok.padding_side = "left"
    m = LlamaBiModel.from_pretrained(BASE, torch_dtype=torch.bfloat16)
    with open(f"{MNTP_B}/config.json", "r", encoding="utf-8") as handle:
        m.config._name_or_path = json.load(handle).get("_name_or_path")
    m = PeftModel.from_pretrained(m, MNTP_B).merge_and_unload()
    m = PeftModel.from_pretrained(m, SUP_B)
    m2 = LLM2Vec(model=m, tokenizer=tok)
    v = m2.encode(PROMPTS, batch_size=1, show_progress_bar=False, device="cuda").float().cpu()
    torch.save(v, f"{OUT}-{label}.pt")
    print(f"{label}: OK {tuple(v.shape)}, first6={v[0][:6].tolist()}", flush=True)
    del m2, v
    release()


official("/root/autodl-tmp/rayure-autodl/text-encoders", "layoutB")
manual("manual")
official("/root/autodl-tmp/rayure-autodl/text-encoders-a", "layoutA")

vecs = {
    label: torch.load(f"{OUT}-{label}.pt", weights_only=True)
    for label in ("layoutB", "manual", "layoutA")
}
for x_label, y_label in (("layoutB", "layoutA"), ("manual", "layoutA"), ("layoutB", "manual")):
    diff = (vecs[x_label] - vecs[y_label]).abs()
    print(f"diff {x_label} vs {y_label}: max={diff.max().item():.6f} mean={diff.mean().item():.8f}")

# 判定: 当前布局 layoutB 必须与上游 layoutA 一致(bf16 精度内)
ok = (vecs["layoutB"] - vecs["layoutA"]).abs().max().item() < 1e-2
print("LAYOUT_COMPARE", "PASS" if ok else "FAIL")
