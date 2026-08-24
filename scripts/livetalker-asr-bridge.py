"""LiveTalker -> Rayure final-transcript bridge.

The real mode imports the external LiveTalker package, owns the microphone and
performs the same energy-based endpointing as its local dialogue engine. Only
the final text crosses stdout as ``rayure.asr-transcript.v1`` JSONL; raw audio,
emotion labels and provider diagnostics stay inside this process.

``--simulate`` is dependency-free and is used by CI and local contract smoke
runs.
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from pathlib import Path
from threading import Event


def main() -> int:
    parser = argparse.ArgumentParser(description="LiveTalker ASR bridge for Rayure")
    parser.add_argument("--simulate", action="store_true")
    parser.add_argument("--text", default="挥手")
    parser.add_argument("--turn-id", default="livetalker-simulated-turn")
    parser.add_argument("--confidence", type=float, default=0.9)
    parser.add_argument("--interval-ms", type=int, default=0)
    parser.add_argument("--livetalker-root", default="")
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args()
    if args.simulate:
        return run_simulation(args)
    return run_microphone(args)


def run_simulation(args: argparse.Namespace) -> int:
    if not isinstance(args.text, str) or not args.text.strip() or len(args.text) > 4096:
        print("simulation text is invalid", file=sys.stderr)
        return 2
    if not isinstance(args.turn_id, str) or not args.turn_id or len(args.turn_id) > 96:
        print("simulation turn id is invalid", file=sys.stderr)
        return 2
    if args.interval_ms < 0 or args.interval_ms > 60_000:
        print("simulation interval is out of range", file=sys.stderr)
        return 2
    if not isinstance(args.confidence, (int, float)) or not 0 <= args.confidence <= 1:
        print("simulation confidence is out of range", file=sys.stderr)
        return 2
    if args.interval_ms:
        time.sleep(args.interval_ms / 1000)
    emit_transcript(args.turn_id, args.text.strip(), float(args.confidence), "zh-CN")
    return 0


def run_microphone(args: argparse.Namespace) -> int:
    root = Path(args.livetalker_root).expanduser().resolve() if args.livetalker_root else Path.cwd().resolve()
    if not root.is_dir():
        print(f"LiveTalker root does not exist: {root}", file=sys.stderr)
        return 2
    sys.path.insert(0, str(root))
    try:
        from livetalker import LiveTalker
        from livetalker.audio import Microphone
    except Exception as exc:
        print(f"LiveTalker import failed: {exc}", file=sys.stderr)
        return 2

    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = root / config_path
    try:
        talker = LiveTalker(str(config_path))
        mic_cfg = talker.cfg["mic"]
        mic = Microphone(
            device=mic_cfg.get("device"),
            sample_rate=int(mic_cfg.get("sample_rate", 16_000)),
            chunk_ms=int(mic_cfg.get("chunk_ms", 20)),
        )
    except Exception as exc:
        print(f"LiveTalker microphone setup failed: {exc}", file=sys.stderr)
        return 2

    stop = Event()
    for name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is not None:
            signal.signal(sig, lambda _signum, _frame: stop.set())

    try:
        mic.start()
        run_vad_loop(talker, mic, mic_cfg, stop)
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        print(f"LiveTalker ASR bridge failed: {exc}", file=sys.stderr)
        return 1
    finally:
        mic.stop()
    return 0


def run_vad_loop(talker, mic, mic_cfg: dict, stop: Event) -> None:
    import numpy as np

    sample_rate = mic.sample_rate
    chunk_s = mic.chunk_duration
    threshold = float(mic_cfg.get("vad_threshold", 0.008))
    silence_s = float(mic_cfg.get("vad_silence_ms", 800)) / 1000
    min_s = float(mic_cfg.get("min_utterance_s", 0.25))
    max_s = float(mic_cfg.get("max_utterance_s", 20))
    preroll_n = max(1, round(0.3 / chunk_s))
    max_chunks = max(1, round(max_s / chunk_s))
    preroll: list[np.ndarray] = []
    buffer: list[np.ndarray] = []
    in_speech = False
    silence = 0.0
    turn_number = 0

    while not stop.is_set():
        chunk = mic.read_chunk(timeout=0.5)
        if chunk is None:
            continue
        energy = float(np.sqrt(np.mean(np.square(chunk))))
        preroll.append(chunk)
        if len(preroll) > preroll_n:
            preroll.pop(0)
        if energy > threshold:
            if not in_speech:
                in_speech = True
                buffer = list(preroll)
                silence = 0.0
            buffer.append(chunk)
            if len(buffer) >= max_chunks:
                turn_number += 1
                emit_utterance(talker, buffer, sample_rate, turn_number, min_s)
                buffer, in_speech, silence = [], False, 0.0
        elif in_speech:
            buffer.append(chunk)
            silence += chunk_s
            if silence >= silence_s:
                turn_number += 1
                emit_utterance(talker, buffer, sample_rate, turn_number, min_s)
                buffer, in_speech, silence = [], False, 0.0


def emit_utterance(talker, chunks, sample_rate: int, turn_number: int, min_s: float) -> None:
    import numpy as np

    audio = np.concatenate(chunks).astype(np.float32)
    if len(audio) / sample_rate < min_s:
        return
    try:
        result = talker.transcribe(audio, sample_rate)
    except Exception as exc:
        print(f"LiveTalker transcription failed: {exc}", file=sys.stderr)
        return
    text = str(result.get("text") or "").strip()
    if not text:
        return
    confidence = result.get("confidence", 0.9)
    try:
        confidence = min(1.0, max(0.0, float(confidence)))
    except (TypeError, ValueError):
        confidence = 0.9
    emit_transcript(f"livetalker-{turn_number}", text, confidence, "zh-CN")


def emit_transcript(turn_id: str, text: str, confidence: float, language: str) -> None:
    sys.stdout.write(json.dumps({
        "version": "rayure.asr-transcript.v1",
        "turnId": turn_id,
        "text": text,
        "language": language,
        "confidence": confidence,
        "observedAtMs": int(time.time() * 1000),
    }, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main())
