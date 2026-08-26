#!/usr/bin/env python3
"""Strict ARDY CoreSkeleton27 -> BVH format bridge (spec Phase 1).

Consumes an official ARDY CoreSkeleton27 `.npz`
(`local_rot_mats` [1,T,27,3,3], `root_positions` [1,T,3], `fps` scalar)
and writes a deterministic CoreSkeleton27 BVH per the `core-skeleton-27.v1`
profile. It is a pure format bridge with no model knowledge.

Hard constraints (spec §3.2, §6.1):
- No target-model knowledge, no alias / axis-guessing / retarget / scale-to-character code.
- No resampling, no smoothing, no foot-fixing, no root-motion modification.
- Hips is the only translation channel; other joints carry rotation only.
- End Sites come from the fixed profile, never from a target rig.
- Deterministic: same input bytes + profile + tool version -> identical BVH bytes.
- On any invalid input: nonzero exit, structured failure report
  (`rayure.rig-pipeline-failure.v1`) written to `--report`, and NO `.bvh` produced.

Usage:
  ardy_to_bvh.py --input motion.npz --output motion.bvh \
      --profile core-skeleton-27.v1 --report motion.conversion.json

Exit codes: 0 = success, 2 = INPUT_INVALID, 3 = ARDY_REFERENCE_SKELETON_MISSING,
4 = internal/toolchain error.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

try:
    from scipy.spatial.transform import Rotation
except ImportError as exc:  # pragma: no cover - toolchain dependency guard
    print(f"fatal: scipy is required (round-trip contract uses scipy Rotation): {exc}", file=sys.stderr)
    sys.exit(4)

PROFILE_VERSION = "0.1.0"
CONVERTER_VERSION = "1.0.0"
CONVERSION_REPORT_SCHEMA = "rayure.rig-pipeline-conversion.v1"
FAILURE_REPORT_SCHEMA = "rayure.rig-pipeline-failure.v1"

# Euler sequence written to BVH channels, in channel order. Matches the
# profile contract (scipy as_euler('ZYX', degrees=True) -> channels Z,Y,X) and
# the Blender native importer's reconstruction (verified 2026-08-26: file order
# Z,Y,X + Blender Euler((X,Y,Z),'XYZ') == Rz@Ry@Rx == scipy intrinsic 'ZYX').
EULER_ORDER = "ZYX"
ROOT_CHANNELS = ["Xposition", "Yposition", "Zposition", "Zrotation", "Yrotation", "Xrotation"]
NON_ROOT_CHANNELS = ["Zrotation", "Yrotation", "Xrotation"]
FLOAT_FMT = "{:.6f}"

# Oversized-input guard (DoS cap). 65536 frames = ~54 minutes at the locked
# 20 fps; far beyond any real ARDY motion while bounding pathological input.
MAX_FRAMES = 65536

# Forbidden CLI flags / concepts (spec §6.1). Kept here so tests can assert the
# converter never grows a target-aware path.
FORBIDDEN_CLI_FLAGS = [
    "--target-model",
    "--bone-map",
    "--guess-axis",
    "--scale-to-character",
    "--fix-feet",
]

# Toolchain identity recorded in reports. Updated by hand; tests assert version
# is present, never that it equals a specific string.
BVH_TOOL_NAME = "ardy_to_bvh"


class ProfileError(Exception):
    """The profile JSON is missing or structurally invalid (ARDY_REFERENCE_SKELETON_MISSING)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "ARDY_REFERENCE_SKELETON_MISSING"


class InputError(Exception):
    """The input .npz is invalid (INPUT_INVALID)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "INPUT_INVALID"


def load_profile(profile_arg: str) -> Dict[str, Any]:
    """Resolve a profile id or path to a parsed profile dict.

    `core-skeleton-27.v1` -> `<script_dir>/schemas/core-skeleton-27.v1.json`.
    Any existing file path is used directly.
    """
    path = profile_arg
    if not os.path.exists(path):
        candidate = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schemas", f"{profile_arg}.json")
        if os.path.exists(candidate):
            path = candidate
        else:
            raise ProfileError(
                f"profile not found: {profile_arg!r} (tried direct path and schemas/<id>.json next to converter)"
            )
    try:
        with open(path, "r", encoding="utf-8") as fh:
            profile = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        raise ProfileError(f"profile unreadable/unparseable at {path}: {exc}") from exc
    _validate_profile(profile)
    return profile


def _validate_profile(profile: Dict[str, Any]) -> None:
    if profile.get("schema") != "rayure.rig-pipeline.core-skeleton-27.v1":
        raise ProfileError("profile schema id is not rayure.rig-pipeline.core-skeleton-27.v1")
    joints = profile.get("joints")
    if not isinstance(joints, list) or len(joints) != profile.get("jointCount", 27):
        raise ProfileError("profile joints array is missing or wrong length")
    for j in joints:
        if not isinstance(j.get("name"), str) or not isinstance(j.get("restOffsetMeters"), list) \
                or len(j["restOffsetMeters"]) != 3:
            raise ProfileError(f"profile joint entry malformed: {j!r}")
    timing = profile.get("timing", {})
    if not isinstance(timing.get("fps"), (int, float)):
        raise ProfileError("profile timing.fps missing")
    channels = profile.get("channels", {})
    if channels.get("eulerOrder") != "ZYX":
        raise ProfileError("profile eulerOrder is not ZYX (converter is hard-wired to ZYX)")


def _squeeze_single_batch(arr: np.ndarray, name: str, target_ndim: int) -> np.ndarray:
    a = np.asarray(arr)
    if a.ndim == target_ndim + 1:
        if a.shape[0] != 1:
            raise InputError(f"{name} has a batch dim > 1 ({a.shape[0]}); single-motion npz required")
        a = a[0]
    if a.ndim != target_ndim:
        raise InputError(f"{name} expected {target_ndim}D (or 1,{target_ndim}D) got {a.ndim}D shape {a.shape}")
    return a


def validate_npz(data: Dict[str, Any], profile: Dict[str, Any]) -> Tuple[np.ndarray, np.ndarray, float]:
    """Strictly validate an ARDY npz and return (local_rot_mats, root_positions, fps).

    Raises InputError with code INPUT_INVALID on any violation.
    """
    for key in ("local_rot_mats", "root_positions", "fps"):
        if key not in data:
            raise InputError(f"missing required field {key!r}")

    local_rot_mats = _squeeze_single_batch(data["local_rot_mats"], "local_rot_mats", 4)
    root_positions = _squeeze_single_batch(data["root_positions"], "root_positions", 2)

    if local_rot_mats.shape != (local_rot_mats.shape[0], 27, 3, 3):
        raise InputError(
            f"local_rot_mats must be [T,27,3,3], got {local_rot_mats.shape}"
        )
    if root_positions.shape != (root_positions.shape[0], 3):
        raise InputError(f"root_positions must be [T,3], got {root_positions.shape}")

    n_frames = local_rot_mats.shape[0]
    if n_frames != root_positions.shape[0]:
        raise InputError(
            f"frame count mismatch: local_rot_mats T={n_frames} vs root_positions T={root_positions.shape[0]}"
        )
    if n_frames < 1:
        raise InputError("motion has zero frames")
    if n_frames > MAX_FRAMES:
        raise InputError(f"motion frame count {n_frames} exceeds cap {MAX_FRAMES}")

    try:
        fps = float(np.asarray(data["fps"]).reshape(-1)[0])
    except (ValueError, IndexError, TypeError) as exc:
        raise InputError(f"fps field is not a scalar number: {data['fps']!r}") from exc

    expected_fps = float(profile["timing"]["fps"])
    if not np.isclose(fps, expected_fps):
        raise InputError(f"fps={fps} does not match profile fps={expected_fps}")

    if not np.isfinite(local_rot_mats).all():
        raise InputError("local_rot_mats contains NaN/Inf values")
    if not np.isfinite(root_positions).all():
        raise InputError("root_positions contains NaN/Inf values")

    return local_rot_mats.astype(np.float64), root_positions.astype(np.float64), fps


def rotations_to_euler(local_rot_mats: np.ndarray) -> np.ndarray:
    """Decompose [T,27,3,3] parent-local rotation matrices to [T,27,3] degrees.

    Returns values in channel order [Z, Y, X] for the ZYX euler order. Applies
    per-channel +/-360 unwrapping for cross-frame continuity (allowed by spec
    §3.2; it preserves the exact rotation and keeps BVH animation smooth).
    """
    # Flatten (T*27, 3, 3) through scipy for speed, then reshape.
    mats = local_rot_mats.reshape(-1, 3, 3)
    angles = Rotation.from_matrix(mats).as_euler(EULER_ORDER, degrees=True)  # [T*27, 3] = [z, y, x]
    angles = angles.reshape(local_rot_mats.shape[0], 27, 3)

    # Unwrap each joint's three channels across frames: keep |delta| <= 180.
    unwrapped = angles.copy()
    for ch in range(3):
        prev = unwrapped[:, :, ch]
        for t in range(1, unwrapped.shape[0]):
            delta = unwrapped[t, :, ch] - unwrapped[t - 1, :, ch]
            wrap = np.where(delta > 180.0, -360.0, 0.0) + np.where(delta < -180.0, 360.0, 0.0)
            unwrapped[t, :, ch] += wrap
        del prev
    return unwrapped


def _leaf_children(profile: Dict[str, Any]) -> List[int]:
    parents = {int(j["index"]): (None if j["parent"] is None else int(j["parent"])) for j in profile["joints"]}
    children_of: Dict[int, List[int]] = {idx: [] for idx in parents}
    for idx, parent in parents.items():
        if parent is not None:
            children_of[parent].append(idx)
    return [idx for idx in parents if not children_of[idx]]


def _end_site_offset(profile: Dict[str, Any], leaf_index: int) -> Tuple[float, float, float]:
    """Fixed, deterministic End Site stub from the rest profile (never a target rig).

    Points along the leaf segment direction, length 0.02 m. Falls back to +Y if
    the segment has near-zero length.
    """
    joints = {int(j["index"]): j for j in profile["joints"]}
    leaf = joints[leaf_index]
    # leaf.restOffsetMeters is already parent-relative (OFFSET[leaf]); it is the
    # bone segment direction from parent to leaf, which is what the End Site stub
    # should continue along.
    seg = np.asarray(leaf["restOffsetMeters"])
    length = float(np.linalg.norm(seg))
    if length < 1e-9:
        seg = np.array([0.0, 1.0, 0.0])
    else:
        seg = seg / length
    stub = seg * 0.02
    return (float(stub[0]), float(stub[1]), float(stub[2]))


def _format_vec(v) -> str:
    return " ".join(FLOAT_FMT.format(float(x)) for x in v)


def _build_hierarchy(profile: Dict[str, Any]) -> str:
    joints = {int(j["index"]): j for j in profile["joints"]}
    children_of: Dict[int, List[int]] = {int(j["index"]): [] for j in profile["joints"]}
    for j in profile["joints"]:
        idx = int(j["index"])
        if j["parent"] is not None:
            children_of[int(j["parent"])].append(idx)

    root_idx = int(profile["root_index"]) if "root_index" in profile else 0
    lines: List[str] = ["HIERARCHY"]

    def emit(idx: int, depth: int, is_root: bool) -> None:
        indent = "\t" * depth
        j = joints[idx]
        lines.append(f"{indent}{'ROOT' if is_root else 'JOINT'} {j['name']}")
        lines.append(f"{indent}{{")
        lines.append(f"{indent}\tOFFSET {_format_vec(j['restOffsetMeters'])}")
        channels = ROOT_CHANNELS if is_root else NON_ROOT_CHANNELS
        lines.append(f"{indent}\tCHANNELS {len(channels)} {' '.join(channels)}")
        for child in children_of[idx]:
            emit(child, depth + 1, is_root=False)
        if not children_of[idx]:
            stub = _end_site_offset(profile, idx)
            lines.append(f"{indent}\tEnd Site")
            lines.append(f"{indent}\t{{")
            lines.append(f"{indent}\t\tOFFSET {_format_vec(stub)}")
            lines.append(f"{indent}\t}}")
        lines.append(f"{indent}}}")

    emit(root_idx, 0, True)
    return "\n".join(lines) + "\n"


def build_bvh(profile: Dict[str, Any], local_rot_mats: np.ndarray, root_positions: np.ndarray, fps: float) -> str:
    """Render the complete BVH text (hierarchy + motion) deterministically."""
    hierarchy = _build_hierarchy(profile)
    euler = rotations_to_euler(local_rot_mats)  # [T, 27, 3] degrees, channel order Z,Y,X

    n_frames = local_rot_mats.shape[0]
    frame_time = 1.0 / fps

    motion_lines: List[str] = ["MOTION", f"Frames: {n_frames}", f"Frame Time: {frame_time:.6f}"]
    for t in range(n_frames):
        # Hips: 6 channels (3 translation + 3 rotation).
        p = root_positions[t]
        r = euler[t, 0]
        parts = [FLOAT_FMT.format(p[0]), FLOAT_FMT.format(p[1]), FLOAT_FMT.format(p[2]),
                 FLOAT_FMT.format(r[0]), FLOAT_FMT.format(r[1]), FLOAT_FMT.format(r[2])]
        # 26 non-root joints: 3 rotation channels each, in joint order.
        for j in range(1, 27):
            rj = euler[t, j]
            parts.extend([FLOAT_FMT.format(rj[0]), FLOAT_FMT.format(rj[1]), FLOAT_FMT.format(rj[2])])
        motion_lines.append(" ".join(parts))

    return hierarchy + "\n" + "\n".join(motion_lines) + "\n"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_npz(path: str) -> Dict[str, Any]:
    try:
        with np.load(path) as npz:
            return {key: npz[key] for key in npz.files}
    except Exception as exc:
        raise InputError(f"unable to read .npz (truncated or not an npz?): {exc}") from exc


def _failure_report(code: str, message: str, stage: str, input_path: Optional[str],
                    profile_arg: Optional[str], run_id: str) -> Dict[str, Any]:
    motion_sha = None
    motion_base = None
    if input_path and os.path.exists(input_path):
        with open(input_path, "rb") as fh:
            motion_sha = hashlib.sha256(fh.read()).hexdigest()
        motion_base = os.path.basename(input_path)
    return {
        "schema": FAILURE_REPORT_SCHEMA,
        "runId": run_id,
        "stage": stage,
        "code": code,
        "message": message,
        "input": {
            "motionBasename": motion_base,
            "motionSha256": motion_sha,
            "modelBasename": None,
            "modelSha256": None,
        },
        "toolchain": {
            "blenderVersion": None,
            "rigBridgeVersion": None,
            "bvhToolVersion": f"{BVH_TOOL_NAME} {CONVERTER_VERSION} (profile {PROFILE_VERSION})",
        },
        "externalToolStatus": None,
        "fallbackAttempted": False,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


def _success_report(run_id: str, input_path: str, output_path: str, profile_id: str,
                    n_frames: int, fps: float, output_sha: str, output_bytes: int,
                    input_sha: str) -> Dict[str, Any]:
    return {
        "schema": CONVERSION_REPORT_SCHEMA,
        "runId": run_id,
        "status": "ok",
        "input": {
            "file": os.path.basename(input_path),
            "sha256": input_sha,
            "bytes": os.path.getsize(input_path),
            "frames": n_frames,
            "fps": fps,
        },
        "output": {
            "file": os.path.basename(output_path),
            "sha256": output_sha,
            "bytes": output_bytes,
        },
        "profile": profile_id,
        "toolchain": {
            "bvhToolVersion": f"{BVH_TOOL_NAME} {CONVERTER_VERSION}",
            "profileVersion": PROFILE_VERSION,
        },
        "determinism": "same input bytes + profile + tool version -> identical BVH hash",
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


def convert(input_path: str, output_path: str, profile_arg: str, report_path: Optional[str],
            run_id: Optional[str] = None) -> Dict[str, Any]:
    """Run the conversion. Returns the success report dict; raises on failure.

    On failure, writes a pipeline-failure report to report_path (if given) and
    re-raises the InputError/ProfileError.
    """
    rid = run_id or str(uuid.uuid4())
    stage = "ardy-to-bvh"
    profile: Optional[Dict[str, Any]] = None
    try:
        profile = load_profile(profile_arg)
    except ProfileError as exc:
        failure = _failure_report(exc.code, str(exc), stage, input_path, profile_arg, rid)
        if report_path:
            _write_json_atomic(report_path, failure)
        raise

    data: Optional[Dict[str, Any]] = None
    try:
        data = load_npz(input_path)
        local_rot_mats, root_positions, fps = validate_npz(data, profile)
        bvh_text = build_bvh(profile, local_rot_mats, root_positions, fps)
        bvh_bytes = bvh_text.encode("utf-8")
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        with open(output_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(bvh_text)
        out_sha = sha256_bytes(bvh_bytes)
        with open(input_path, "rb") as fh:
            in_sha = hashlib.sha256(fh.read()).hexdigest()
        report = _success_report(rid, input_path, output_path, profile_arg,
                                 int(local_rot_mats.shape[0]), float(fps), out_sha, len(bvh_bytes), in_sha)
        if report_path:
            _write_json_atomic(report_path, report)
        return report
    except InputError as exc:
        failure = _failure_report(exc.code, str(exc), stage, input_path, profile_arg, rid)
        if report_path:
            _write_json_atomic(report_path, failure)
        # Never leave a half-written BVH on failure.
        if os.path.exists(output_path):
            os.remove(output_path)
        raise


def _write_json_atomic(path: str, payload: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, path)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Strict ARDY CoreSkeleton27 -> BVH format bridge")
    parser.add_argument("--input", required=True, help="official ARDY .npz (local_rot_mats/root_positions/fps)")
    parser.add_argument("--output", required=True, help="output .bvh path")
    parser.add_argument("--profile", default="core-skeleton-27.v1", help="profile id or JSON path")
    parser.add_argument("--report", default=None, help="optional JSON report path (success or failure)")

    # Reject forbidden CLI flags BEFORE argparse parses, so the documented exit
    # code 4 wins over argparse's own unknown-argument error (SystemExit 2).
    # The guard checks the real argument vector (works whether main() was called
    # with an explicit argv list or with sys.argv) and matches both "--flag" and
    # "--flag=value" spellings.
    arg_vector = argv if argv is not None else sys.argv[1:]
    for flag in FORBIDDEN_CLI_FLAGS:
        if any(a == flag or a.startswith(flag + "=") for a in arg_vector):
            print(f"fatal: forbidden flag {flag} is not allowed for this converter", file=sys.stderr)
            return 4

    args = parser.parse_args(argv)

    try:
        convert(args.input, args.output, args.profile, args.report)
        return 0
    except ProfileError as exc:
        print(f"ardy_to_bvh: {exc.code}: {exc}", file=sys.stderr)
        return 3
    except InputError as exc:
        print(f"ardy_to_bvh: {exc.code}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
