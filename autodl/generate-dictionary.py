#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Batch-generate a large Rayure prompt dictionary with DeepSeek + local expansion.

Two-stage generation:

1. Seed stage (DeepSeek, OpenAI-compatible API): for each category x
   granularity cell, the model writes intent seeds - {"intentZh", "prompt",
   "cacheKeyBase"} objects. Seeds cover Chinese intent + an English ARDY-style
   prompt ("A person ...") + a base cache key (e.g. "walk.forward").
2. Expansion stage (local, instant): every seed is expanded by composing
   modifier dimensions (speed / magnitude / emotion / direction / duration),
   ~10 variants per seed on average. A 3000-seed run yields ~30k dictionary
   entries that generate-embeddings.py can consume directly.

The output dictionary is a JSON array of {"cacheKey", "prompt"} (with optional
category/granularity metadata that generate-embeddings.py ignores). It is
already deduplicated on cacheKey and prompt.

Capacity math (motion-semantic-cache.v1 contract): the cache file is capped at
512 MiB / 100k entries by the Companion reader. With sentence mode + float16
(8 KiB per entry) a first batch holds ~45k entries - that is the recommended
full-size first batch. Use --target to size the dictionary accordingly.

Cost/speed (deepseek-chat): ~30-40 output tokens/s; a 3000-seed run is ~15-30
API calls of 3-8k output tokens each, roughly 30-60 minutes and < 1 CNY.
Expansion is local and instant.

Usage:
  export DEEPSEEK_API_KEY=sk-...            # or pass --api-key
  python3 generate-dictionary.py --target 30000 --out dictionary.json
  python3 generate-dictionary.py --target 30000 --categories walk,gesture   # subset
  python3 generate-dictionary.py --resume    # continue a previous run

Environment:
  DEEPSEEK_API_KEY   - required (or --api-key)
  DEEPSEEK_BASE_URL  - optional; defaults to https://api.deepseek.com
  DEEPSEEK_MODEL     - optional; defaults to deepseek-chat
"""

import argparse
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# --------------------------------------------------------------------------
# Category grid: intent coverage dimensions. Each category has a Chinese label
# (for the LLM prompt) and a slot name (used in cache keys only for clarity).
# --------------------------------------------------------------------------
CATEGORIES = [
    ("walk", "行走与步态"),
    ("run", "跑步与冲刺"),
    ("stand", "站立与姿态"),
    ("sit", "坐下与起身"),
    ("lie", "躺卧"),
    ("jump", "跳跃"),
    ("crouch", "蹲伏与下跪"),
    ("wave", "挥手与问候"),
    ("greet", "行礼与社交礼仪"),
    ("hand", "手势表达(指点、比划、点赞等)"),
    ("arm", "手臂动作(抱臂、叉腰、伸懒腰等)"),
    ("head", "头部动作(点头、摇头、转头等)"),
    ("face", "面部神态(微笑、皱眉、惊讶、眨眼等)"),
    ("emotion", "情绪化动作(开心蹦跳、沮丧垂头、紧张搓手等)"),
    ("object", "物件交互(抓取、投掷、放置、拿杯等)"),
    ("daily", "日常活动(穿衣、喝水、看手机、打字等)"),
    ("dance", "舞蹈与律动"),
    ("sport", "运动(踢球、挥拍、投篮、拳击等)"),
    ("idle", "空闲小动作(发呆、摸头发、摆弄手指等)"),
    ("turn", "转身与方向移动"),
    ("composite", "组合动作(先做A再做B、边A边B)"),
]

GRANULARITIES = [
    ("word", "单个字或词(如:挥手、点头、鞠躬)"),
    ("phrase", "二字或三字短语(如:轻轻挥手、缓缓摇头)"),
    ("sentence", "短句(如:他举起手轻轻挥了挥)"),
    ("long", "长句或场景描述(如:他听到呼喊后转过身,挥手回应,然后继续向前走)"),
    ("composite", "组合动作(含先后顺序或同时进行的多个动作)"),
]

CACHE_KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

# Modifier dimensions for local expansion. Each variant combines 1-2
# dimensions; prompts stay English and ARDY-style ("A person ...").
EXPANSION_DIMS = {
    "speed": ["slowly", "quickly", "briskly", "gently", "hurriedly", "at a leisurely pace"],
    "magnitude": ["slightly", "subtly", "strongly", "emphatically", "barely", "exaggeratedly"],
    "emotion": ["happily", "sadly", "nervously", "confidently", "cheerfully", "tiredly",
                "excitedly", "calmly", "anxiously", "lazily"],
    "direction": ["forward", "backward", "to the left", "to the right", "in a circle",
                  "sideways", "toward something in front"],
    "duration": ["briefly", "for a long moment", "continuously", "in one smooth motion"],
}

MODIFIER_ADVERB_FORMS = {
    "speed": lambda w: w,
    "magnitude": lambda w: w,
    "emotion": lambda w: w,
    "direction": lambda w: w,
    "duration": lambda w: w,
}


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_seed_state(state_path: Path) -> dict:
    if state_path.exists():
        try:
            return json.loads(state_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def save_seed_state(state_path: Path, state: dict) -> None:
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


def call_deepseek(api_key: str, base_url: str, model: str, messages: list, timeout: int = 180) -> str:
    """One chat completion; returns the assistant text. Retries with backoff."""
    url = base_url.rstrip("/") + "/chat/completions"
    body = {
        "model": model,
        "messages": messages,
        "temperature": 0.95,
        "max_tokens": 8192,
        "response_format": {"type": "json_object"},
    }
    payload = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url, data=payload, method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    last_error = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
            return result["choices"][0]["message"]["content"]
        except (urllib.error.URLError, urllib.error.HTTPError, KeyError, json.JSONDecodeError) as cause:
            last_error = cause
            wait = 10 * (2 ** attempt)
            print(f"  api call failed ({cause}); retrying in {wait}s...", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"DeepSeek API unreachable after retries: {last_error}")


def extract_json(text: str) -> dict:
    """Robustly parse a JSON object from the model response."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise ValueError(f"no JSON object in model response: {text[:200]!r}")
        parsed = json.loads(match.group(0))
    if not isinstance(parsed, dict):
        raise ValueError(f"expected a JSON object, got {type(parsed).__name__}")
    return parsed


def generate_seed_batch(api_key: str, base_url: str, model: str,
                        category: str, category_label: str,
                        granularity: str, granularity_label: str,
                        batch_size: int) -> list:
    system = (
        "You are a motion-intent lexicographer for an AI character (a desktop Live2D "
        "companion). Produce motion/persona descriptions in English, ARDY style: a "
        "concrete prompt describing a person performing an action, e.g. "
        '"A person waves their hand casually". These prompts are fed to a text-to-motion '
        "model, so they must be short, concrete, physically plausible, and written in "
        "natural English. Avoid rare words, abstract metaphors, or anything not "
        "visually performable by a standing human character."
    )
    user = (
        f'For the category "{category_label}" (slot: {category}) and granularity '
        f'"{granularity_label}", write {batch_size} distinct motion/persona intents.\n\n'
        "Rules:\n"
        "- intentZh: the Chinese intent label (2-12 Chinese characters).\n"
        '- prompt: English ARDY-style prompt. Word granularity may be a single word '
        '("wave"); phrase a short phrase ("wave one hand"); sentence starts with '
        '"A person ..." and describes one action; long adds scene context; composite '
        "combines 2-3 actions with ordering or simultaneity.\n"
        "- cacheKeyBase: lowercase slug like <category>.<short-id> using only "
        "[a-z0-9.-] (e.g. walk.turnaround).\n"
        "- Do not repeat prompts from previous batches; vary body parts, directions, "
        "emotions and modifiers.\n"
        '- Respond ONLY with JSON: {{"intents": [{{"intentZh", "prompt", "cacheKeyBase"}}]}}\n'
    )
    content = call_deepseek(api_key, base_url, model, [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ])
    parsed = extract_json(content)
    intents = parsed.get("intents")
    if not isinstance(intents, list):
        raise ValueError("model response missing 'intents' array")
    cleaned = []
    for raw in intents:
        if not isinstance(raw, dict):
            continue
        intent_zh = str(raw.get("intentZh", "")).strip()
        prompt = str(raw.get("prompt", "")).strip()
        key_base = str(raw.get("cacheKeyBase", "")).strip().lower()
        if not intent_zh or not prompt or not CACHE_KEY_RE.match(key_base):
            continue
        if len(prompt) > 512 or prompt != prompt.strip():
            continue
        cleaned.append({"intentZh": intent_zh, "prompt": prompt,
                        "cacheKeyBase": key_base, "category": category,
                        "granularity": granularity})
    return cleaned


def third_person(word: str) -> str:
    """Rough third-person singular for bare-verb prompts ("wave" -> "waves")."""
    if re.search(r"(s|x|z|ch|sh|o)$", word, re.IGNORECASE):
        return word + "es"
    return word + "s"


def expand_seed(seed: dict, rng: random.Random) -> list:
    """Local expansion: 1 base entry + N modifier variants of the seed."""
    prompt = seed["prompt"]
    base_key = seed["cacheKeyBase"]
    entries = [{
        "cacheKey": base_key,
        "prompt": prompt,
        "category": seed["category"],
        "granularity": seed["granularity"],
    }]

    dims = list(EXPANSION_DIMS)
    seen = {prompt.lower()}
    max_variants = 9
    tries = 0
    while len(entries) < max_variants + 1 and tries < 40:
        tries += 1
        # Compose 1-2 random modifier dimensions.
        chosen = rng.sample(dims, rng.randint(1, 2))
        parts = []
        key_parts = [base_key]
        for dim in chosen:
            modifier = rng.choice(EXPANSION_DIMS[dim])
            parts.append(modifier)
            key_parts.append(re.sub(r"[^a-z0-9]", "", modifier.replace(" ", ".")))
        if not parts:
            continue
        adverb_group = " ".join(parts)
        # Insert the adverb group right after "A person" (the canonical English
        # adverb slot) so the word order always stays grammatical.
        if prompt.lower().startswith("a person "):
            rest = prompt[len("A person "):]
            varied = f"A person {adverb_group} {rest}"
        else:
            # Bare word/phrase seed: conjugate the first verb, keep the rest.
            words = prompt.split()
            verb = third_person(words[0]) if words else "waves"
            tail = " ".join(words[1:])
            varied = f"A person {adverb_group} {verb}" + (f" {tail}" if tail else "")
        varied = " ".join(varied.split())
        lowered = varied.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        variant_key = ".".join(key_parts)
        if not CACHE_KEY_RE.match(variant_key) or len(variant_key) > 128:
            variant_key = base_key + f".v{len(entries)}"
        entries.append({
            "cacheKey": variant_key,
            "prompt": varied,
            "category": seed["category"],
            "granularity": seed["granularity"],
        })
    return entries


def dedupe_and_report(entries: list) -> list:
    by_key, by_prompt = {}, {}
    for entry in entries:
        key = entry["cacheKey"]
        if key in by_key:
            by_key[key]["prompt"] = entry["prompt"]  # last wins, keys stay unique
        else:
            by_key[key] = entry
        by_prompt[entry["prompt"]] = key
    unique = sorted(by_key.values(), key=lambda e: e["cacheKey"])
    print(f"dedupe: {len(entries)} raw -> {len(unique)} unique cacheKeys, "
          f"{len(by_prompt)} unique prompts")
    return unique


def report_coverage(entries: list) -> None:
    from collections import Counter
    by_category = Counter(e["category"] for e in entries)
    by_granularity = Counter(e["granularity"] for e in entries)
    print("coverage by category:")
    for name, count in by_category.most_common():
        print(f"  {name:<12} {count:>6}")
    print("coverage by granularity:")
    for name, count in by_granularity.most_common():
        print(f"  {name:<12} {count:>6}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate a large Rayure prompt dictionary (DeepSeek seeds + local expansion)",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--out", type=Path, default=Path("dictionary.json"))
    parser.add_argument("--target", type=int, default=30000,
                        help="final dictionary size (capped by the 512 MiB / ~45k-entry fp16 sentence limit)")
    parser.add_argument("--api-key", default=os.environ.get("DEEPSEEK_API_KEY"))
    parser.add_argument("--base-url", default=os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"))
    parser.add_argument("--model", default=os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"))
    parser.add_argument("--categories", default=None,
                        help="comma-separated slot subset (default: all)")
    parser.add_argument("--granularities", default=None,
                        help="comma-separated subset of word,phrase,sentence,long,composite")
    parser.add_argument("--seeds-per-cell", type=int, default=120,
                        help="intent seeds per category x granularity cell")
    parser.add_argument("--seed-batch", type=int, default=40,
                        help="intents requested from DeepSeek per API call")
    parser.add_argument("--parallel", type=int, default=4,
                        help="concurrent DeepSeek API workers (cells are independent; "
                             "keep below the API rate limit)")
    parser.add_argument("--resume", action="store_true",
                        help="continue a previous run (loads the seed state file)")
    parser.add_argument("--seed", type=int, default=42, help="expansion RNG seed")
    args = parser.parse_args()

    if not args.api_key:
        fail("no DeepSeek API key: set DEEPSEEK_API_KEY or pass --api-key")

    categories = [(s, dict(CATEGORIES)[s]) for s in args.categories.split(",")] if args.categories else CATEGORIES
    granularities = GRANULARITIES
    if args.granularities:
        wanted = set(args.granularities.split(","))
        granularities = [(g, label) for g, label in GRANULARITIES if g in wanted]

    state_path = args.out.with_name(args.out.stem + ".seed-state.json")
    state = load_seed_state(state_path) if args.resume else {}
    existing_entries = []
    if args.resume and args.out.exists():
        try:
            existing_entries = json.loads(args.out.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing_entries = []
        print(f"resume: {len(existing_entries)} entries already in {args.out}")

    # --- Stage 1: seed generation via DeepSeek (cells run concurrently) ---
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import threading

    state_lock = threading.Lock()
    progress_lock = threading.Lock()
    cells = [(category, category_label, granularity, granularity_label)
             for category, category_label in categories
             for granularity, granularity_label in granularities]
    total_cells = len(cells)
    done_count = 0

    def generate_cell(cell):
        category, category_label, granularity, granularity_label = cell
        cell_key = f"{category}/{granularity}"
        with state_lock:
            if cell_key in state:
                with progress_lock:
                    return cell_key, state[cell_key], True
        cell_seeds = []
        collected = 0
        rounds = 0
        while collected < args.seeds_per_cell and rounds < 12:
            rounds += 1
            want = min(args.seed_batch, args.seeds_per_cell - collected)
            try:
                batch = generate_seed_batch(
                    args.api_key, args.base_url, args.model,
                    category, category_label, granularity, granularity_label, want)
            except ValueError as cause:
                with progress_lock:
                    print(f"[{cell_key}] batch rejected: {cause}; retrying", flush=True)
                continue
            fresh = [s for s in batch
                     if s["prompt"] not in {x["prompt"] for x in cell_seeds}]
            cell_seeds.extend(fresh)
            collected += len(fresh)
            if len(fresh) == 0 and rounds >= 2:
                break
        with state_lock:
            state[cell_key] = cell_seeds
            save_seed_state(state_path, state)
        return cell_key, cell_seeds, False

    seeds = []
    with ThreadPoolExecutor(max_workers=args.parallel) as pool:
        futures = [pool.submit(generate_cell, cell) for cell in cells]
        for future in as_completed(futures):
            cell_key, cell_seeds, cached = future.result()
            done_count += 1
            with progress_lock:
                suffix = " (cached)" if cached else ""
                print(f"[{done_count}/{total_cells}] {cell_key}: "
                      f"{len(cell_seeds)} seeds{suffix}", flush=True)
            seeds.extend(cell_seeds)
    print(f"seeds total: {len(seeds)}")

    # --- Stage 2: local expansion ----------------------------------------
    rng = random.Random(args.seed)
    entries = list(existing_entries)
    seen_keys = {e["cacheKey"] for e in entries}
    seen_prompts = {e["prompt"] for e in entries}
    target = max(len(entries), args.target)
    budget_left = target - len(entries)
    for seed in seeds:
        if budget_left <= 0:
            break
        for variant in expand_seed(seed, rng):
            if budget_left <= 0:
                break
            if variant["cacheKey"] in seen_keys or variant["prompt"] in seen_prompts:
                continue
            seen_keys.add(variant["cacheKey"])
            seen_prompts.add(variant["prompt"])
            entries.append(variant)
            budget_left -= 1

    unique = dedupe_and_report(entries)
    if len(unique) < target:
        print(f"note: reached {len(unique)} entries (< {target}); "
              "raise --seeds-per-cell or --seed-batch for more")

    args.out.write_text(json.dumps(unique, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {args.out} ({len(unique)} entries)")
    report_coverage(unique)
    print("next: python3 generate-embeddings.py --dictionary dictionary.json "
          "--mode sentence --dtype float16 --out motion-features.json")


if __name__ == "__main__":
    main()
