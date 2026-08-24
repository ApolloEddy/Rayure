#!/usr/bin/env python3
"""Rayure's external, privacy-preserving MediaPipe observation bridge.

The process owns the camera and emits only a bounded derived observation JSONL
contract. It never writes frames, landmarks, or recordings to disk. --simulate
is intentionally dependency-free so Companion lifecycle tests can run offline.
"""

from __future__ import annotations

import argparse
import json
import math
import signal
import sys
import time
from pathlib import Path
from typing import Any


SCHEMA = "rayure.vision-observation.v1"
MAX_OUTPUT_BYTES = 16 * 1024
STOP = False


def main() -> int:
    args = parse_args()
    install_signals()
    if args.simulate:
        return run_simulation(args)
    return run_camera(args)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rayure derived MediaPipe vision bridge")
    parser.add_argument("--simulate", action="store_true")
    parser.add_argument("--model", type=str)
    parser.add_argument("--camera-index", type=int, default=0)
    parser.add_argument("--fps", type=int, default=8)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=360)
    parser.add_argument("--frames", type=int, default=0, help="simulation frame count; 0 means continuous")
    parser.add_argument("--interval-ms", type=int, default=125)
    return parser.parse_args()


def install_signals() -> None:
    def stop(_signum: int, _frame: Any) -> None:
        global STOP
        STOP = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)


def run_simulation(args: argparse.Namespace) -> int:
    if args.frames < 0 or args.frames > 100_000:
        return fail("simulation frame count is out of range")
    if args.interval_ms < 1 or args.interval_ms > 10_000:
        return fail("simulation interval is out of range")
    total = args.frames if args.frames > 0 else None
    frame_index = 0
    while not STOP and (total is None or frame_index < total):
        timestamp_ms = frame_index * args.interval_ms
        phase = frame_index % 6
        x = 0.22 if phase % 2 == 0 else 0.40
        observation = make_observation(
            frame_id=f"sim-{frame_index + 1}",
            observed_at_ms=timestamp_ms,
            presence=0.9,
            head={"yaw": 0.0, "pitch": 0.0, "confidence": 0.9},
            left_hand={"wrist": [x, 0.30], "shoulderY": 0.55, "confidence": 0.9},
        )
        write_observation(observation)
        frame_index += 1
        if total is None:
            time.sleep(args.interval_ms / 1000.0)
    return 0


def run_camera(args: argparse.Namespace) -> int:
    if args.model is None:
        return fail("a package-outside pose model is required unless --simulate is used")
    model_path = Path(args.model)
    if not model_path.is_absolute() or not model_path.is_file():
        return fail("configured pose model is unavailable")
    if args.camera_index < 0 or args.camera_index > 32:
        return fail("camera index is out of range")
    if args.fps < 1 or args.fps > 30:
        return fail("camera fps must be between 1 and 30")
    if args.width < 160 or args.width > 1920 or args.height < 120 or args.height > 1080:
        return fail("camera dimensions are out of range")

    try:
        import cv2  # type: ignore
        import mediapipe as mp  # type: ignore
        from mediapipe.tasks import python  # type: ignore
        from mediapipe.tasks.python import vision  # type: ignore
    except Exception:
        return fail("MediaPipe and OpenCV are unavailable in the configured Python environment")

    capture = None
    try:
        capture = cv2.VideoCapture(args.camera_index, cv2.CAP_DSHOW)
        if not capture.isOpened():
            return fail("camera could not be opened")
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
        capture.set(cv2.CAP_PROP_FPS, args.fps)

        def on_result(result: Any, _output_image: Any, timestamp_ms: int) -> None:
            write_observation(observation_from_result(result, timestamp_ms))

        options = vision.PoseLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=str(model_path)),
            running_mode=vision.RunningMode.LIVE_STREAM,
            num_poses=1,
            min_pose_detection_confidence=0.5,
            min_pose_presence_confidence=0.5,
            min_tracking_confidence=0.5,
            result_callback=on_result,
        )
        with vision.PoseLandmarker.create_from_options(options) as landmarker:
            last_timestamp_ms = -1
            next_frame_at = time.monotonic()
            while not STOP:
                ok, frame = capture.read()
                if not ok:
                    return fail("camera frame capture failed")
                now = time.monotonic()
                if now < next_frame_at:
                    time.sleep(min(next_frame_at - now, 0.05))
                next_frame_at = max(next_frame_at + 1.0 / args.fps, now)
                timestamp_ms = max(last_timestamp_ms + 1, int(time.monotonic() * 1000))
                last_timestamp_ms = timestamp_ms
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                landmarker.detect_async(image, timestamp_ms)
        return 0
    except Exception as exc:
        return fail(f"vision inference failed: {type(exc).__name__}")
    finally:
        if capture is not None:
            capture.release()


def observation_from_result(result: Any, timestamp_ms: int) -> dict[str, Any]:
    poses = getattr(result, "pose_landmarks", None) or []
    if not poses:
        return make_observation(f"frame-{timestamp_ms}", timestamp_ms, 0.0)
    landmarks = poses[0]
    nose = landmark(landmarks, 0)
    left_shoulder = landmark(landmarks, 11)
    right_shoulder = landmark(landmarks, 12)
    left_wrist = landmark(landmarks, 15)
    right_wrist = landmark(landmarks, 16)
    shoulder_width = max(abs(left_shoulder["x"] - right_shoulder["x"]), 0.05)
    shoulder_center_x = (left_shoulder["x"] + right_shoulder["x"]) / 2.0
    nose_visibility = landmark_confidence(nose)
    shoulder_confidence = min(landmark_confidence(left_shoulder), landmark_confidence(right_shoulder))
    presence = clamp(min(nose_visibility, shoulder_confidence), 0.0, 1.0)
    head = {
        "yaw": clamp((nose["x"] - shoulder_center_x) / shoulder_width * 60.0, -90.0, 90.0),
        "pitch": clamp((nose["y"] - (left_shoulder["y"] + right_shoulder["y"]) / 2.0) / shoulder_width * 60.0, -60.0, 60.0),
        "confidence": presence,
    }
    return make_observation(
        frame_id=f"frame-{timestamp_ms}",
        observed_at_ms=timestamp_ms,
        presence=presence,
        head=head,
        left_hand=hand_from_landmarks(left_wrist, left_shoulder),
        right_hand=hand_from_landmarks(right_wrist, right_shoulder),
    )


def landmark(landmarks: Any, index: int) -> dict[str, float]:
    item = landmarks[index]
    return {
        "x": float(getattr(item, "x", 0.0)),
        "y": float(getattr(item, "y", 0.0)),
        "visibility": float(getattr(item, "visibility", 0.0) or 0.0),
        "presence": float(getattr(item, "presence", 0.0) or 0.0),
    }


def landmark_confidence(item: dict[str, float]) -> float:
    return clamp(max(item.get("visibility", 0.0), item.get("presence", 0.0)), 0.0, 1.0)


def hand_from_landmarks(wrist: dict[str, float], shoulder: dict[str, float]) -> dict[str, Any]:
    return {
        "wrist": [clamp(wrist["x"], -1.0, 2.0), clamp(wrist["y"], -1.0, 2.0)],
        "shoulderY": clamp(shoulder["y"], -1.0, 2.0),
        "confidence": clamp(min(landmark_confidence(wrist), landmark_confidence(shoulder)), 0.0, 1.0),
    }


def make_observation(
    frame_id: str,
    observed_at_ms: int,
    presence: float,
    head: dict[str, float] | None = None,
    left_hand: dict[str, Any] | None = None,
    right_hand: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "version": SCHEMA,
        "id": frame_id,
        "observedAtMs": int(observed_at_ms),
        "presenceConfidence": clamp(presence, 0.0, 1.0),
    }
    if head is not None:
        result["head"] = head
    if left_hand is not None:
        result["leftHand"] = left_hand
    if right_hand is not None:
        result["rightHand"] = right_hand
    return result


def write_observation(observation: dict[str, Any]) -> None:
    raw = json.dumps(observation, separators=(",", ":"), ensure_ascii=True)
    if len(raw.encode("utf-8")) > MAX_OUTPUT_BYTES:
        raise RuntimeError("vision observation exceeded protocol limit")
    sys.stdout.write(raw + "\n")
    sys.stdout.flush()


def clamp(value: float, minimum: float, maximum: float) -> float:
    if not math.isfinite(value):
        return minimum
    return max(minimum, min(maximum, value))


def fail(message: str) -> int:
    safe = " ".join(str(message).split())[:512]
    sys.stderr.write(safe + "\n")
    sys.stderr.flush()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
