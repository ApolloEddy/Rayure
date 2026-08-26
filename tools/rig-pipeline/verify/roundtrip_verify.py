#!/usr/bin/env python3
"""Phase 1 round-trip verification driver (spec Phase 1 acceptance item 2).

Compares the transforms Blender's native importer recovered from a BVH file
(dumped by blender_bvh_dump.py) against an ARDY FK reference computed from the
original .npz + core-skeleton-27.v1 profile:

  - per-bone world rotation:   angle(R_global[j], pose_rot)      <= 0.25 deg
  - per-bone head translation: |P_j - pose_trans|                <= 1 mm

plus the fps / frame-count contract (BVH 20 fps -> scene fps 20; BVH frame k
lands on Blender frame k+1 -- the importer's internal anim_data placeholder at
index 0 is the thing skipped, so every BVH frame is animated).

Run in the toolchain venv (numpy only; scipy is used by the converter, not here):
  python roundtrip_verify.py --npz <motion.npz> --profile core-skeleton-27.v1 \
      --dump <dump.json> --out <report.json>

Exit codes: 0 = PASS, 1 = FAIL (tolerance or contract breach), 2 = usage.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np

ROTATION_TOL_DEG = 0.25
TRANSLATION_TOL_M = 0.001  # 1 mm

PROFILE_FALLBACK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "schemas", "core-skeleton-27.v1.json")


def load_npz(path: str) -> tuple[np.ndarray, np.ndarray]:
    with np.load(path) as npz:
        local = npz["local_rot_mats"]
        root = npz["root_positions"]
    if local.ndim == 5:  # [1,T,27,3,3] -> [T,27,3,3]
        local = local[0]
    if root.ndim == 3:  # [1,T,3] -> [T,3]
        root = root[0]
    return local.astype(np.float64), root.astype(np.float64)


def load_profile(path_or_id: str) -> dict:
    path = path_or_id
    if not os.path.exists(path):
        cand = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "schemas", f"{path_or_id}.json")
        if os.path.exists(cand):
            path = cand
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def fk_reference(local: np.ndarray, root: np.ndarray, profile: dict):
    """ARDY forward kinematics in file space.

    Returns per-frame global rotation matrices [T,27,3,3] and joint positions
    [T,27,3] following P_j = P_parent + R_parent @ offset_j (offset in the
    parent's rest frame), R_j = R_parent @ local_j.
    """
    joints = profile["joints"]
    n = len(joints)
    parents = [j["parent"] for j in joints]
    offsets = np.asarray([j["restOffsetMeters"] for j in joints], dtype=np.float64)

    T = local.shape[0]
    R = np.zeros((T, n, 3, 3), dtype=np.float64)
    P = np.zeros((T, n, 3), dtype=np.float64)
    for t in range(T):
        R[t, 0] = local[t, 0]
        P[t, 0] = root[t]
        for j in range(1, n):
            p = parents[j]
            R[t, j] = R[t, p] @ local[t, j]
            P[t, j] = P[t, p] + R[t, p] @ offsets[j]
    return R, P


def angle_between(a: np.ndarray, b: np.ndarray) -> float:
    """Angular difference in degrees between two 3x3 rotation matrices."""
    diff = a.T @ b
    trace = max(-1.0, min(3.0, float(np.trace(diff))))
    return math.degrees(math.acos((trace - 1.0) / 2.0))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--npz", required=True)
    ap.add_argument("--profile", default="core-skeleton-27.v1")
    ap.add_argument("--dump", required=True)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    local, root = load_npz(args.npz)
    profile = load_profile(args.profile)
    R_global, P = fk_reference(local, root, profile)

    with open(args.dump, encoding="utf-8") as fh:
        dump = json.load(fh)

    joint_names = [j["name"] for j in profile["joints"]]
    bones = dump["bones"]
    pose = dump["pose"]

    missing = [nm for nm in joint_names if nm not in bones]
    if missing:
        print(f"FAIL: dump missing bones: {missing}")
        return 1

    # Frame contract: the importer's anim_data placeholder (index 0) is skipped,
    # so BVH frame k lands on Blender frame k+1. All T BVH frames are animated.
    actual_frames = sorted(int(f) for f in pose)
    expected_frames = [k + 1 for k in range(local.shape[0])]
    if actual_frames != expected_frames:
        print(f"FAIL: frame mapping BVH[0..{local.shape[0]-1}] -> Blender frames {actual_frames}; "
              f"expected {expected_frames}")
        return 1
    if dump["scene"]["fps"] != profile["timing"]["fps"]:
        print(f"FAIL: scene fps {dump['scene']['fps']} != profile fps {profile['timing']['fps']}")
        return 1
    if not dump.get("armatureMatrixWorldIsIdentity", False):
        print("FAIL: armature.matrix_world is not identity; transforms are not in file space")
        return 1

    max_rot_err = 0.0
    max_trans_err = 0.0
    worst_rot = None
    worst_trans = None
    results = {}
    for nm in joint_names:
        j = joint_names.index(nm)
        rest_rot = np.asarray(bones[nm]["restMatrix3"], dtype=np.float64)
        for bf in actual_frames:
            k = bf - 1  # BVH frame index
            pb = pose[str(bf)]
            exp_R = R_global[k, j] @ rest_rot
            obs_R = np.asarray(pb[nm]["rotation3"], dtype=np.float64)
            err = angle_between(exp_R, obs_R)
            if err > max_rot_err:
                max_rot_err, worst_rot = err, (nm, bf)

            exp_P = P[k, j]
            obs_P = np.asarray(pb[nm]["translation"], dtype=np.float64)
            terr = float(np.linalg.norm(obs_P - exp_P))
            if terr > max_trans_err:
                max_trans_err, worst_trans = terr, (nm, bf)

            results.setdefault(nm, {"maxRotDeg": 0.0, "maxTransM": 0.0})
            results[nm]["maxRotDeg"] = max(results[nm]["maxRotDeg"], err)
            results[nm]["maxTransM"] = max(results[nm]["maxTransM"], terr)

    # Root (Hips) translation is the spec's headline check.
    root_errs = results["Hips"]["maxTransM"]

    ok = max_rot_err <= ROTATION_TOL_DEG and max_trans_err <= TRANSLATION_TOL_M
    verdict = "PASS" if ok else "FAIL"

    report = {
        "schema": "rayure.rig-pipeline.roundtrip-verify.v1",
        "verdict": verdict,
        "tolerances": {"rotationDeg": ROTATION_TOL_DEG, "translationM": TRANSLATION_TOL_M},
        "frameContract": {
            "importerPlaceholderSkipped": True,
            "bvhFrameToBlenderFrame": "bvh frame k -> blender frame k+1",
            "mappedFrames": actual_frames,
            "sceneFps": dump["scene"]["fps"],
            "profileFps": profile["timing"]["fps"],
        },
        "errors": {
            "maxRotationDeg": round(max_rot_err, 6),
            "maxTranslationM": round(max_trans_err, 8),
            "rootTranslationM": round(root_errs, 8),
            "worstRotation": list(worst_rot) if worst_rot else None,
            "worstTranslation": list(worst_trans) if worst_trans else None,
        },
        "perBone": results,
        "bpv": f"golden_rest round-trip on Blender {dump.get('blenderVersion')}",
    }

    print(f"verdict={verdict}")
    print(f"  max rotation error   : {max_rot_err:.6f} deg (tolerance {ROTATION_TOL_DEG})  worst={worst_rot}")
    print(f"  max translation error: {max_trans_err:.8f} m (tolerance {TRANSLATION_TOL_M})  worst={worst_trans}")
    print(f"  root (Hips) translation error: {root_errs:.8f} m")
    print(f"  frame contract: BVH frames 0..{local.shape[0]-1} -> Blender frames {actual_frames}; "
          f"scene fps {dump['scene']['fps']}")

    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(report, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        print(f"wrote {args.out}")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
