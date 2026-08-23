#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Batch-compile a Rayure prompt dictionary into ARDY text conditions.

Turns a prompt dictionary (a JSON array of {"cacheKey", "prompt"} objects) into
a ``rayure.motion-semantic-cache.v1`` file that the Rayure Companion loads via
``motionSemantic.cachePath``. The text encoder (LLM2Vec + Llama-3-8B-Instruct,
~14 GB VRAM in bf16) is only needed to produce this file - the local machine
never runs it; ARDY itself is driven by the cached features only.

Byte-level contract (must match the TypeScript side exactly):

- apps/companion/src/motion-semantic-cache-file.ts is the authoritative reader:
  valuesBase64 is the row-major [tokenCount, 4096] tensor, little-endian
  float16/float32; textPadMaskBase64 is a bit map with bit i of byte i>>3 set
  for a real token, unused high bits zero; entries are sorted by cacheKey;
  the file must be valid JSON under the schema rayure.motion-semantic-cache.v1
  and stay under 512 MiB.
- packages/protocol/src/motion-semantic-feature.ts fixes featureDimension 4096,
  tokenCount 1..256, and cacheKey regex ^[A-Za-z0-9._:-]{1,128}$.

Two modes, both produce contract-valid entries:

- sentence (default): one mean-pooled 4096-d vector per prompt, tokenCount=1.
  This is exactly what ARDY's built-in LLM2VecEncoder returns for
  text_encoder=None models - bit-for-bit the official conditioning path, so it
  is the safest default.
- token: the per-token contextualized features (one row per real document
  token, instruction prefix and padding excluded, up to --max-tokens). Richer
  conditioning signal; contract and model accept it (the spike verified
  [1,N,4096] + mask drives generation), but it is not the official path.

Usage:
  python3 generate-embeddings.py --dictionary prompts.json --out motion-features.json
  python3 generate-embeddings.py --dictionary prompts.json --mode token --dtype float16

Environment:
  TEXT_ENCODERS_DIR  - local dir holding the two McGill-NLP model folders
                       (set by setup-autodl.sh); otherwise downloaded from HF.
  HF_ENDPOINT        - mirror for downloads (e.g. https://hf-mirror.com).
  HF_TOKEN           - only needed if Hugging Face gates the repos (they are
                       public McGill-NLP repos; normally not required).
"""

import argparse
import base64
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import torch

FEATURE_DIMENSION = 4096
MAX_TOKENS = 256
MAX_CACHE_FILE_BYTES = 512 * 1024 * 1024  # matches the Companion reader
MAX_CACHE_ENTRIES = 100_000
CACHE_SCHEMA = "rayure.motion-semantic-cache.v1"

CACHE_KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
DEFAULT_ENCODER_ID = "llm2vec-meta-llama-3-8b-instruct"
DEFAULT_ENCODER_VERSION = "mntp-supervised-bf16-v1"


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def require_dictionary(entries: list) -> list:
    """Validate the prompt dictionary and normalize each entry."""
    if not isinstance(entries, list) or not entries:
        fail("dictionary must be a non-empty JSON array of {\"cacheKey\", \"prompt\"} objects")
    normalized = []
    seen = set()
    for index, raw in enumerate(entries):
        if not isinstance(raw, dict):
            fail(f"dictionary[{index}] must be an object")
        cache_key = raw.get("cacheKey")
        prompt = raw.get("prompt")
        if not isinstance(cache_key, str) or not CACHE_KEY_RE.match(cache_key):
            fail(f"dictionary[{index}].cacheKey must match {CACHE_KEY_RE.pattern!r}")
        if not isinstance(prompt, str) or len(prompt) < 1 or len(prompt) > 512:
            fail(f"dictionary[{index}].prompt must be a 1..512 character string")
        if prompt.strip() != prompt or any(ord(ch) < 32 or ord(ch) == 127 for ch in prompt):
            fail(f"dictionary[{index}].prompt must be a trimmed printable string")
        if cache_key in seen:
            fail(f"duplicate dictionary cacheKey: {cache_key}")
        seen.add(cache_key)
        normalized.append({"cacheKey": cache_key, "prompt": prompt})
    return normalized


def load_encoder(device: str):
    """Build the official ARDY LLM2Vec encoder (local mode, bf16 like training)."""
    try:
        from ardy.model.load_model import load_text_encoder
    except ImportError as cause:
        fail(
            "cannot import ardy.model.load_model - run autodl/setup-autodl.sh first "
            f"({cause})"
        )
    print("loading LLM2Vec + Llama-3-8B-Instruct (mntp-supervised, bf16)...", flush=True)
    encoder = load_text_encoder(mode="local", device=device)
    print(f"encoder ready on {encoder.get_device()} (llm_dim={encoder.llm_dim})", flush=True)
    return encoder


def encode_sentence(encoder, prompt: str) -> np.ndarray:
    """Official path: one mean-pooled 4096-d vector, tokenCount=1."""
    tensor, lengths = encoder(prompt)
    # 字符串输入时 __call__ 返回单个 int(见 llm2vec_wrapper.py:96-98), 不是列表
    assert lengths == 1, f"unexpected lengths {lengths}"
    return tensor[0].detach().cpu().float().numpy()  # [4096]


def encode_tokens(encoder, prompt: str, device: str, max_tokens: int) -> np.ndarray:
    """Per-token contextualized features for the document tokens only.

    Reuses LLM2Vec's own tokenization (instruction header split on
    '!@#$%^&*()', embed_mask marks the document span) and then takes
    last_hidden_state rows where embed_mask is set - the same rows the mean
    pooling averages, without collapsing them.
    """
    llm2vec = encoder.model
    prepared = llm2vec.prepare_for_tokenization(prompt)
    features = llm2vec.tokenize([prepared])
    embed_mask = features.pop("embed_mask").to(device)
    features = {key: value.to(device) for key, value in features.items()}
    with torch.no_grad():
        hidden = llm2vec.model(**features).last_hidden_state[0]  # [L, 4096]
    rows = hidden[embed_mask].float().cpu().numpy()  # [N, 4096]
    if rows.shape[0] < 1:
        fail(f"prompt tokenized to zero document tokens: {prompt!r}")
    if rows.shape[0] > max_tokens:
        print(f"note: truncating {rows.shape[0]} document tokens to {max_tokens} for {prompt!r}")
        rows = rows[:max_tokens]
    return rows


def encode_values(values: np.ndarray, dtype: str) -> str:
    """Row-major little-endian float16/float32, base64 - matches the TS reader."""
    arr = np.asarray(values, dtype=np.float32).reshape(-1)
    if dtype == "float16":
        arr = arr.astype("<f2")
    else:
        arr = arr.astype("<f4")
    return base64.b64encode(arr.tobytes(order="C")).decode("ascii")


def encode_mask(mask: np.ndarray) -> str:
    """Bit map, bit i of byte i>>3 set for a real token - matches the TS reader."""
    mask = np.asarray(mask, dtype=bool)
    buf = bytearray((len(mask) + 7) // 8)
    for index, value in enumerate(mask):
        if value:
            buf[index >> 3] |= 1 << (index & 7)
    return base64.b64encode(bytes(buf)).decode("ascii")


def build_entry(cache_key: str, prompt: str, values: np.ndarray, dtype: str,
                encoder_id: str, encoder_version: str) -> dict:
    token_count = int(values.shape[0])
    assert values.shape[1] == FEATURE_DIMENSION
    mask = np.ones(token_count, dtype=bool)
    return {
        "cacheKey": cache_key,
        "canonicalPrompt": prompt,
        "encoderId": encoder_id,
        "encoderVersion": encoder_version,
        "dtype": dtype,
        "tokenCount": token_count,
        "featureDimension": FEATURE_DIMENSION,
        "valuesBase64": encode_values(values, dtype),
        "textPadMaskBase64": encode_mask(mask),
        "createdAtMs": int(time.time() * 1000),
    }


def load_existing(out_path: Path):
    """Load a previous output for --resume; returns {cacheKey: entry}."""
    if not out_path.exists():
        return {}
    try:
        raw = json.loads(out_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as cause:
        fail(f"cannot parse existing output {out_path}: {cause}")
    if raw.get("schema") != CACHE_SCHEMA:
        fail(f"existing output {out_path} has unexpected schema {raw.get('schema')!r}")
    entries = raw.get("entries")
    if not isinstance(entries, list):
        fail(f"existing output {out_path} has no entries array")
    return {entry["cacheKey"]: entry for entry in entries if isinstance(entry, dict)}


def write_atomic(out_path: Path, entries: list) -> None:
    entries = sorted(entries, key=lambda entry: entry["cacheKey"])
    payload = json.dumps({"schema": CACHE_SCHEMA, "entries": entries}, separators=(",", ":"))
    if len(payload.encode("utf-8")) > MAX_CACHE_FILE_BYTES:
        fail(f"output exceeds the {MAX_CACHE_FILE_BYTES // 1024 // 1024} MiB Companion reader limit "
             f"({len(payload) / 1e6:.0f} MiB); reduce the dictionary or use --dtype float16")
    if len(entries) > MAX_CACHE_ENTRIES:
        fail(f"output exceeds {MAX_CACHE_ENTRIES} entries")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=out_path.parent, prefix=f".{out_path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
        os.replace(temporary, out_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compile a Rayure prompt dictionary into motion-semantic-cache.v1",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--dictionary", required=True, type=Path,
                        help="JSON array of {\"cacheKey\", \"prompt\"} objects")
    parser.add_argument("--out", type=Path, default=Path("motion-features.json"),
                        help="output rayure.motion-semantic-cache.v1 file")
    parser.add_argument("--mode", choices=("sentence", "token"), default="sentence",
                        help="sentence = official mean-pooled vector (tokenCount=1); "
                             "token = per-token contextualized features")
    parser.add_argument("--dtype", choices=("float16", "float32"), default="float32",
                        help="valuesBase64 precision; float16 halves the file size")
    parser.add_argument("--max-tokens", type=int, default=MAX_TOKENS, metavar="N",
                        help="token mode: cap document tokens per prompt (1..256)")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--encoder-id", default=DEFAULT_ENCODER_ID)
    parser.add_argument("--encoder-version", default=DEFAULT_ENCODER_VERSION)
    parser.add_argument("--resume", action="store_true",
                        help="skip dictionary entries already present in --out")
    args = parser.parse_args()

    if args.max_tokens < 1 or args.max_tokens > MAX_TOKENS:
        fail(f"--max-tokens must be 1..{MAX_TOKENS}")
    if not args.dictionary.exists():
        fail(f"dictionary not found: {args.dictionary}")

    try:
        entries = require_dictionary(json.loads(args.dictionary.read_text(encoding="utf-8")))
    except json.JSONDecodeError as cause:
        fail(f"cannot parse dictionary {args.dictionary}: {cause}")
    print(f"dictionary: {len(entries)} prompts (mode={args.mode}, dtype={args.dtype})")

    existing = load_existing(args.out) if args.resume else {}
    pending = [entry for entry in entries if entry["cacheKey"] not in existing]
    skipped = len(entries) - len(pending)
    if skipped:
        print(f"resume: {skipped} cacheKeys already in {args.out}, skipping")
    if not pending:
        print("nothing to do")
        return

    encoder = load_encoder(args.device)
    built = []
    for index, entry in enumerate(pending, start=1):
        cache_key, prompt = entry["cacheKey"], entry["prompt"]
        print(f"[{index}/{len(pending)}] {cache_key}: {prompt[:64]!r}", flush=True)
        if args.mode == "sentence":
            values = encode_sentence(encoder, prompt)
            values = values.reshape(1, FEATURE_DIMENSION)
        else:
            values = encode_tokens(encoder, prompt, args.device, args.max_tokens)
        built.append(build_entry(
            cache_key, prompt, values, args.dtype,
            args.encoder_id, args.encoder_version,
        ))

    merged = sorted(list(existing.values()) + built, key=lambda entry: entry["cacheKey"])
    write_atomic(args.out, merged)
    token_counts = [entry["tokenCount"] for entry in built]
    size_mib = args.out.stat().st_size / 1024 / 1024
    print(f"wrote {args.out} ({len(merged)} entries total, "
          f"{len(built)} new; tokens {min(token_counts)}..{max(token_counts)}; "
          f"{size_mib:.2f} MiB)")
    print("next: copy this file back and point rayure.local.json motionSemantic.cachePath at it")


if __name__ == "__main__":
    main()
