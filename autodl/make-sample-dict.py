#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""从 dictionary.json 抽 20 条样例(含 wave.casual / walk.forward)用于全链路冒烟。"""
import json
from pathlib import Path

entries = json.loads(Path("dictionary.json").read_text(encoding="utf-8"))
want = {"wave.casual", "walk.forward"}
sample = [e for e in entries if e["cacheKey"] in want]
sample += [e for e in entries if e["cacheKey"] not in want][:20 - len(sample)]
Path("sample-dict.json").write_text(json.dumps(sample), encoding="utf-8")
for entry in sample[:2]:
    print(f'{entry["cacheKey"]}: {entry["prompt"]!r}')
print(f"sample-dict.json: {len(sample)} entries")
