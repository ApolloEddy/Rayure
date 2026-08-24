"""Rayure TTS JSONL bridge.

This dependency-free simulation reads ``rayure.tts-request.v1`` requests and
returns a valid WAV plus mouth cues. A real local TTS engine can replace this
process while preserving the same request/response contract.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
import struct
import sys
import wave


def main() -> int:
    parser = argparse.ArgumentParser(description="Rayure TTS JSONL bridge")
    parser.add_argument("--simulate", action="store_true")
    args = parser.parse_args()
    if not args.simulate:
        print("Real TTS is provider-owned; pass --simulate for the local contract smoke test.", file=sys.stderr)
        return 2
    return run_simulation()


def run_simulation() -> int:
    for raw in sys.stdin:
        try:
            request = json.loads(raw)
            if request.get("version") != "rayure.tts-request.v1":
                raise ValueError("unsupported request version")
            request_id = request["requestId"]
            speech_id = request["speechId"]
            text = request["text"]
            if not isinstance(request_id, str) or not isinstance(speech_id, str) or not isinstance(text, str) or not text.strip():
                raise ValueError("invalid request")
            duration_ms = min(1800, max(240, len(text) * 65))
            audio = make_wav(duration_ms)
            cue_count = min(32, max(2, math.ceil(len(text) / 2)))
            cues = [
                {"timeMs": round(index * duration_ms / cue_count), "value": 0.85 if index % 3 == 1 else 0.25}
                for index in range(cue_count)
            ]
            response = {
                "version": "rayure.tts-response.v1",
                "requestId": request_id,
                "mimeType": "audio/wav",
                "audioBase64": base64.b64encode(audio).decode("ascii"),
                "durationMs": duration_ms,
                "cues": cues,
            }
        except Exception as exc:  # keep the process alive for the next request
            print(f"TTS request failed: {exc}", file=sys.stderr)
            continue
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    return 0


def make_wav(duration_ms: int) -> bytes:
    sample_rate = 8000
    samples = max(1, round(sample_rate * duration_ms / 1000))
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        frames = bytearray()
        for index in range(samples):
            envelope = min(1.0, index / (sample_rate * 0.02), (samples - index) / (sample_rate * 0.02))
            value = math.sin(index / sample_rate * math.pi * 2 * 440) * 0.12 * max(0.0, envelope)
            frames.extend(struct.pack("<h", round(value * 32767)))
        wav.writeframes(frames)
    return output.getvalue()


if __name__ == "__main__":
    raise SystemExit(main())
