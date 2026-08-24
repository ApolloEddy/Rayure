"""Rayure ASR bridge boundary.

The Companion owns this process and accepts only final, structured transcript
JSONL. ``--simulate`` is dependency-free for CI; a real microphone/ASR adapter
can replace this file without changing the Companion or Wallpaper contracts.
"""

from __future__ import annotations

import argparse
import json
import sys
import time


def main() -> int:
    parser = argparse.ArgumentParser(description="Rayure ASR JSONL bridge")
    parser.add_argument("--simulate", action="store_true")
    parser.add_argument("--text", default="挥手")
    parser.add_argument("--turn-id", default="simulated-turn")
    parser.add_argument("--confidence", type=float, default=1.0)
    parser.add_argument("--interval-ms", type=int, default=0)
    args = parser.parse_args()
    if args.simulate:
        return run_simulation(args)
    print("Real microphone ASR is provider-owned; pass --simulate for the local contract smoke test.", file=sys.stderr)
    return 2


def run_simulation(args: argparse.Namespace) -> int:
    if not isinstance(args.text, str) or not args.text.strip() or len(args.text) > 4096:
        print("simulation text is invalid", file=sys.stderr)
        return 2
    if args.interval_ms < 0 or args.interval_ms > 60_000:
        print("simulation interval is out of range", file=sys.stderr)
        return 2
    if not isinstance(args.confidence, (int, float)) or not 0 <= args.confidence <= 1:
        print("simulation confidence is out of range", file=sys.stderr)
        return 2
    if args.interval_ms:
        time.sleep(args.interval_ms / 1000)
    sys.stdout.write(json.dumps({
        "version": "rayure.asr-transcript.v1",
        "turnId": args.turn_id,
        "text": args.text,
        "confidence": args.confidence,
        "observedAtMs": int(time.time() * 1000),
    }, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
