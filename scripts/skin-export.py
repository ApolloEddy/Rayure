#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""One-time export of the ARDY CoreSkeleton27 test skin + a numeric reference.

Turns the official test mesh (skin_standard.npz + joints.p) and a real cached
rayure.motion.v1 motion into two git-ignored JSON fixtures under
scratch/ardy3d/ so the wallpaper adapter can be verified for numeric
equivalence against ARDY's own math without loading the model:

  core-skin-data.json      bind mesh + LBS data (what core-skin-loader.ts reads)
  core-skin-reference.json per-frame world matrix per CoreSkeleton27 joint
                           (what canonical-rig-adapter.test.ts compares against)

Reference math mirrors ardy/viz/core_skin.py:skin(rot_is_global=True):
  world[j] = T(joint_pos) * R(joint_rot)          # 4x4, Y-up meters, +Z forward
  skinning = world @ bind_rig_transform_inv       # == THREE matrixWorld @ boneInverse

Usage (ARDY python venv, has numpy + torch):
  python scripts/skin-export.py [--skin <npz>] [--joints <pth>] [--motion <json>]
"""

import argparse
from pathlib import Path
import json

import numpy as np
import torch

# Official CoreSkeleton27 order (scripts/ardy-bridge.py CORE_JOINT_NAMES ==
# apps/companion/src/ardy-motion-adapter.ts ARDY_CORE_JOINT_NAMES).  Index into
# this list is the joint order used everywhere (frames, bind transforms).
CORE_JOINT_NAMES = [
    "Hips", "Spine", "Spine1", "Spine2", "Spine3", "Neck", "Head",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand", "RightHandEnd", "RightHandThumb1",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "LeftHandEnd", "LeftHandThumb1",
    "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
    "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
]

# CORE -> protocol joint name (rayure.motion.v1).  Mirror of ARDY_TO_CANONICAL
# in apps/companion/src/ardy-motion-adapter.ts; keep in sync.
ARDY_TO_CANONICAL = {
    "Hips": "hips", "Spine": "spine", "Spine1": "spine1", "Spine2": "spine2",
    "Spine3": "spine3", "Neck": "neck", "Head": "head",
    "RightShoulder": "right_shoulder", "RightArm": "right_upper_arm",
    "RightForeArm": "right_elbow", "RightHand": "right_wrist",
    "RightHandEnd": "right_hand_end", "RightHandThumb1": "right_thumb",
    "LeftShoulder": "left_shoulder", "LeftArm": "left_upper_arm",
    "LeftForeArm": "left_elbow", "LeftHand": "left_wrist",
    "LeftHandEnd": "left_hand_end", "LeftHandThumb1": "left_thumb",
    "RightUpLeg": "right_hip", "RightLeg": "right_knee",
    "RightFoot": "right_ankle", "RightToeBase": "right_toe",
    "LeftUpLeg": "left_hip", "LeftLeg": "left_knee",
    "LeftFoot": "left_ankle", "LeftToeBase": "left_toe",
}

DEFAULT_SKIN = Path(r"D:\Dev\ardy-spike\ardy\ardy\assets\skeletons\cskel27\skin_standard.npz")
DEFAULT_JOINTS = Path(r"D:\Dev\ardy-spike\ardy\ardy\assets\skeletons\cskel27\joints.p")
DEFAULT_MOTION = Path(__file__).resolve().parent.parent / ".walk-motion.json"
OUT_DIR = Path(__file__).resolve().parent.parent / "scratch" / "ardy3d"


def quat_to_rotmat(q):
    """[x, y, z, w] quaternion -> 3x3 rotation matrix (numpy, float64)."""
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def world_matrix(position, rotation):
    """T(p) * R(q) as a 4x4 (mirrors CoreSkin.skin rot_is_global=True)."""
    m = np.eye(4)
    m[:3, :3] = quat_to_rotmat(rotation)
    m[:3, 3] = position
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skin", default=DEFAULT_SKIN, type=Path)
    ap.add_argument("--joints", default=DEFAULT_JOINTS, type=Path)
    ap.add_argument("--motion", default=DEFAULT_MOTION, type=Path)
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # --- bind skin -----------------------------------------------------
    skin = np.load(args.skin)
    rig_joint_names = [str(n) for n in skin["rig_joint_names"]]
    assert rig_joint_names == CORE_JOINT_NAMES, (
        f"rig_joint_names mismatch:\n  skin: {rig_joint_names}\n  core: {CORE_JOINT_NAMES}"
    )

    joints_t = torch.load(args.joints, map_location="cpu", weights_only=True)
    rest_positions = joints_t.detach().numpy()
    assert rest_positions.shape == (27, 3), f"joints.p shape {rest_positions.shape} != (27, 3)"

    bind_data = {
        "schema": "rayure.core-skin-data.v1",
        "jointNames": rig_joint_names,            # CoreSkeleton27 order
        "bindVertices": skin["bind_vertices"].tolist(),      # [V,3]
        "faces": skin["faces"].tolist(),                     # [F,3]
        "bindRigTransform": skin["bind_rig_transform"].tolist(),  # [R,4,4]
        "lbsIndices": skin["lbs_indices"].tolist(),          # [V,5]
        "lbsWeights": skin["lbs_weights"].tolist(),          # [V,5]
        "rigJointConnections": skin["rig_joint_connections"].tolist(),  # [26,2]
        "restJointPositions": rest_positions.tolist(),       # [R,3]
    }
    data_path = OUT_DIR / "core-skin-data.json"
    data_path.write_text(json.dumps(bind_data, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {data_path} ({data_path.stat().st_size / 1e6:.2f} MB)")

    # --- numeric reference from a real cached motion ---------------------
    motion = json.loads(args.motion.read_text(encoding="utf-8"))
    assert motion["schema"] == "rayure.motion.v1"
    assert motion["jointNames"] == [ARDY_TO_CANONICAL[n] for n in CORE_JOINT_NAMES], (
        "motion jointNames do not match CoreSkeleton27 -> canonical mapping"
    )

    frames = []
    for t, frame in enumerate(motion["frames"]):
        world = np.stack([
            world_matrix(
                np.asarray(frame["joints"][ARDY_TO_CANONICAL[n]]["position"], dtype=np.float64),
                np.asarray(frame["joints"][ARDY_TO_CANONICAL[n]]["rotation"], dtype=np.float64),
            )
            for n in CORE_JOINT_NAMES
        ])  # [27, 4, 4]
        frames.append(world.reshape(27, 16).tolist())

    reference = {
        "schema": "rayure.core-skin-reference.v1",
        "source": str(args.motion),
        "backend": motion["backend"],
        "jointSetId": motion["jointSetId"],
        "jointNames": list(CORE_JOINT_NAMES),   # index order == frames[j]
        "fps": motion["fps"],
        "frames": frames,                        # [T][27][16] row-major 4x4
    }
    ref_path = OUT_DIR / "core-skin-reference.json"
    ref_path.write_text(json.dumps(reference, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {ref_path} ({ref_path.stat().st_size / 1e6:.2f} MB, "
          f"{len(frames)} frames x {len(CORE_JOINT_NAMES)} joints)")

    # --- vertex reference (ARDY's own CoreSkin.lbs() on a sample of vertices) ---
    # Validates the full pipeline end-to-end in the JS test: the adapter's world
    # matrices, composed with bind_rig_transform_inv and weighted over the 5 LBS
    # influences, must reproduce the same skinned positions as ARDY's numpy.
    bind_vertices = np.asarray(skin["bind_vertices"], dtype=np.float64)
    bind_inv = np.linalg.inv(skin["bind_rig_transform"]).astype(np.float64)
    lbs_indices = skin["lbs_indices"]
    lbs_weights = skin["lbs_weights"]

    sample_vertices = list(range(0, min(len(bind_vertices), 1024), 16))  # ~64 verts
    vert_ref = {"schema": "rayure.core-skin-vertex-reference.v1",
                "vertexIndices": sample_vertices,
                "bindVertices": [bind_vertices[i].tolist() for i in sample_vertices],
                "frames": []}
    for t, frame in enumerate(reference["frames"]):
        world = np.asarray(frame).reshape(27, 4, 4)  # [J,4,4]
        affine = world @ bind_inv  # [J,3,4] after truncating below
        skinned = []
        for vi in sample_vertices:
            pos = np.concatenate([bind_vertices[vi], [1.0]])
            v = np.zeros(3, dtype=np.float64)
            for w in range(5):
                j = int(lbs_indices[vi, w])
                weight = float(lbs_weights[vi, w])
                if weight == 0.0:
                    continue
                mat = affine[j][:3, :]
                v += weight * (mat @ pos)
            skinned.append(v.tolist())
        vert_ref["frames"].append(skinned)

    vert_path = OUT_DIR / "core-skin-vertex-reference.json"
    vert_path.write_text(json.dumps(vert_ref, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {vert_path} ({vert_path.stat().st_size / 1e6:.2f} MB, "
          f"{len(sample_vertices)} sampled vertices x {len(frames)} frames)")

    # sanity: report a couple of world translations to eyeball the convention
    first = reference["frames"][0]
    hips = first[0]
    head = first[6]
    print(f"sanity Hips pos = {hips[3]:.4f},{hips[7]:.4f},{hips[11]:.4f}")
    print(f"sanity Head pos = {head[3]:.4f},{head[7]:.4f},{head[11]:.4f}")
    print(f"sanity vertex[0] frame0 = {vert_ref['frames'][0][0]}")
    print(f"sanity vertex[8] frame29 = {vert_ref['frames'][29][8]}")


if __name__ == "__main__":
    main()
