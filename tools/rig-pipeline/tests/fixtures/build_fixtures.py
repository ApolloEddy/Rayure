#!/usr/bin/env python3
"""Deterministic builder for the committed Phase 1 golden fixtures.

Creates `golden_rest.npz` (official-shape synthetic ARDY motion) and
`golden_rest.bvh` (converter output snapshot) in this directory. The BVH is a
golden SNAPSHOT: it locks byte-determinism of the converter. Numerical
correctness is proven separately by the Blender round-trip test.

Run with the toolchain python (ARDY venv has numpy + scipy):
  python tools/rig-pipeline/tests/fixtures/build_fixtures.py
"""

from __future__ import annotations

import hashlib
import os
import sys

import numpy as np
from scipy.spatial.transform import Rotation as R

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(HERE))))
sys.path.insert(0, os.path.join(REPO, "tools", "rig-pipeline"))

from ardy_to_bvh import convert  # noqa: E402  (after sys.path setup)

T_FRAMES = 3
FPS = 20


def build_motion() -> dict:
    """Hand-built 3-frame motion: rest, then RightArm/Head rotations, then walk.

    Frame 0: identity (rest pose).
    Frame 1: Hips translated (+X/+Z), RightArm euler ZYX(30,15,0), Head euler
             ZYX(5,-10,0).
    Frame 2: Hips translated further, RightArm euler ZYX(45,20,10).
    """
    local_rot_mats = np.zeros((1, T_FRAMES, 27, 3, 3), dtype=np.float64)
    identity = np.broadcast_to(np.eye(3), (27, 3, 3)).copy()
    for t in range(T_FRAMES):
        local_rot_mats[0, t] = identity.copy()

    # RightArm = joint index 8; Head = joint index 6.
    local_rot_mats[0, 1, 8] = R.from_euler("ZYX", [30.0, 15.0, 0.0], degrees=True).as_matrix()
    local_rot_mats[0, 2, 8] = R.from_euler("ZYX", [45.0, 20.0, 10.0], degrees=True).as_matrix()
    local_rot_mats[0, 1, 6] = R.from_euler("ZYX", [5.0, -10.0, 0.0], degrees=True).as_matrix()

    root_positions = np.array(
        [[0.0, 0.0, 0.0], [0.10, 0.0, 0.05], [0.20, 0.0, 0.10]],
        dtype=np.float64,
    )[None]

    return {
        "local_rot_mats": local_rot_mats,
        "root_positions": root_positions,
        "fps": np.array(FPS, dtype=np.int64),
    }


def main() -> int:
    npz_path = os.path.join(HERE, "golden_rest.npz")
    bvh_path = os.path.join(HERE, "golden_rest.bvh")
    report_path = os.path.join(HERE, "golden_rest.conversion.json")

    motion = build_motion()
    np.savez(npz_path, **motion)

    convert(npz_path, bvh_path, "core-skeleton-27.v1", report_path, run_id="golden-fixture-v1")

    with open(bvh_path, "rb") as fh:
        bvh_sha = hashlib.sha256(fh.read()).hexdigest()
    with open(npz_path, "rb") as fh:
        npz_sha = hashlib.sha256(fh.read()).hexdigest()

    print(f"wrote {npz_path}  sha256={npz_sha}")
    print(f"wrote {bvh_path}  sha256={bvh_sha}")
    print(f"wrote {report_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
