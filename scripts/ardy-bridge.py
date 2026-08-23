#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""ARDY JSONL Bridge for Rayure.

Wraps the official ARDY model (nv-tlabs/ardy) in the frozen Rayure process
protocol: one JSON request per line on stdin, one JSON result per line on
stdout. The text encoder is deliberately NOT loaded - Rayure feeds cached
Motion Semantic Features (text_feat / text_pad_mask) produced offline, so
this bridge only runs the motion model on the local GPU.

Protocol (see apps/companion/src/ardy-process-protocol.ts):
  request  {schema: "rayure.ardy-process-request.v1", type: "generate",
            requestId, model: "core", textFeature, numFrames,
            numDenoisingSteps, cfgWeight, history?, constraints?}
  result   {schema: "rayure.ardy-process-result.v1", type: "result",
            requestId, motion: {schema: "rayure.ardy-motion.v1",
            backend: "ardy-core", fps, jointNames, frames}}
  error    {schema: "rayure.ardy-process-error.v1", type: "error",
            requestId, code, message}
  cancel   {schema: "rayure.ardy-process-request.v1", type: "cancel",
            requestId}

The bridge is stateful across requests on purpose: ARDY's history is its own
normalized hybrid representation, so the last generated motion tensor is kept
in-process and used as init history for the next request (continuation).
A Canonical Motion `history` in the request is converted back to the hybrid
representation via motion_rep.forward when present.

Usage (inside the ardy python environment):
  python ardy-bridge.py --checkpoints_dir <dir> [--model core] [--device cuda]

Environment overrides: CHECKPOINTS_DIR, ARDY_BRIDGE_MODEL, ARDY_BRIDGE_DEVICE.
"""

import argparse
import json
import sys
import threading

import numpy as np
import torch

# Official CoreSkeleton27 order (ardy/skeleton/definitions.py). Must match
# ARDY_CORE_JOINT_NAMES in apps/companion/src/ardy-motion-adapter.ts exactly.
CORE_JOINT_NAMES = [
    "Hips", "Spine", "Spine1", "Spine2", "Spine3", "Neck", "Head",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand", "RightHandEnd", "RightHandThumb1",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "LeftHandEnd", "LeftHandThumb1",
    "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
    "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
]

REQUEST_SCHEMA = "rayure.ardy-process-request.v1"
RESULT_SCHEMA = "rayure.ardy-process-result.v1"
ERROR_SCHEMA = "rayure.ardy-process-error.v1"
MOTION_SCHEMA = "rayure.ardy-motion.v1"

FOOT_CONTACT_JOINTS = {"LeftFoot", "RightFoot"}


class BridgeState:
    """Holds the model and the last generated motion tensor for continuation."""

    def __init__(self, model, device):
        self.model = model
        self.device = device
        self.motion_rep = model.motion_rep
        # Last generated normalized motion [1, T, D] (hybrid representation).
        self.last_motion_tensor = None
        self.fps = model.motion_rep.fps if hasattr(model.motion_rep, "fps") else 20.0
        self.lock = threading.Lock()


def load_bridge_state(checkpoints_dir, model_name, device):
    from ardy.model import load_model

    model = load_model(checkpoint=model_name, checkpoints_dir=checkpoints_dir, device=device,
                       text_encoder=None)
    model.eval()
    return BridgeState(model, torch.device(device))


def feature_to_tensors(state, text_feature):
    """Converts a Rayure MotionSemanticFeature into torch tensors.

    values: row-major [tokenCount, 4096] (already decoded from the cache file).
    textPadMask: true marks a real token (ARDY convention).
    """
    values = np.asarray(text_feature["values"], dtype=np.float32)
    token_count = int(text_feature["tokenCount"])
    dim = int(text_feature["featureDimension"])
    expected = token_count * dim
    if values.size != expected:
        raise ValueError(f"textFeature values size {values.size} != {expected}")
    values = values.reshape(token_count, dim)
    mask = np.asarray(text_feature["textPadMask"], dtype=bool)
    if mask.size != token_count:
        raise ValueError(f"textPadMask size {mask.size} != tokenCount {token_count}")
    text_feat = torch.from_numpy(values).to(state.device)[None]  # [1, N, D]
    text_pad_mask = torch.from_numpy(mask).to(state.device)[None]  # [1, N]
    return text_feat, text_pad_mask


def canonical_history_to_tensor(state, history):
    """Optionally converts a Canonical Motion history into the hybrid rep.

    Only used when the bridge has no internal state (fresh start with an
    explicit history). Frames are converted back to the normalized hybrid
    motion via the forward kinematics inverse path; if the installed ardy
    version exposes motion_rep.forward(posed_joints...), use it, otherwise
    the request is rejected with a clear error.
    """
    forward = getattr(state.motion_rep, "forward", None)
    if not callable(forward):
        raise ValueError("history continuation requires motion_rep.forward on this ardy build")
    joints = []
    for frame in history["frames"]:
        row = [None] * len(CORE_JOINT_NAMES)
        for name, pose in frame["joints"].items():
            if name not in CORE_JOINT_NAMES:
                raise ValueError(f"unknown joint in history: {name}")
            row[CORE_JOINT_NAMES.index(name)] = pose
        joints.append([[p["position"] for p in row]])
    posed = np.asarray(joints, dtype=np.float32)  # [T, 1, J, 3]
    posed = torch.from_numpy(posed).to(state.device).permute(1, 0, 2, 3)  # [1, T, J, 3]
    normalized = state.motion_rep.normalize(posed)
    motion_tensor = state.motion_rep.forward(normalized, is_normalized=True)
    return motion_tensor


def generate(state, request):
    request_id = request["requestId"]
    text_feature = request.get("textFeature")
    if not text_feature:
        raise ValueError("textFeature is required")
    num_frames = int(request["numFrames"])
    num_denoising_steps = int(request["numDenoisingSteps"])
    cfg_weight = float(request["cfgWeight"])

    text_feat, text_pad_mask = feature_to_tensors(state, text_feature)

    with state.lock:
        history_tensor = state.last_motion_tensor
        if history_tensor is None and request.get("history"):
            history_tensor = canonical_history_to_tensor(state, request["history"])

        init_global_translation = None
        init_first_heading_angle = None
        if history_tensor is None:
            init_global_translation = torch.zeros(1, 3, device=state.device)
            init_first_heading_angle = torch.zeros(1, device=state.device)

        with torch.inference_mode():
            samples = state.model.autoregressive_step(
                num_frames=num_frames,
                num_denoising_steps=num_denoising_steps,
                motion_mask=None,
                observed_motion=None,
                cfg_weight=(cfg_weight, cfg_weight),
                texts=None,
                text_feat=text_feat,
                text_pad_mask=text_pad_mask,
                init_history_sequence=history_tensor,
                init_global_translation=init_global_translation,
                init_first_heading_angle=init_first_heading_angle,
            )
            # Keep the full generated motion for the next continuation step.
            state.last_motion_tensor = samples

            samples_unnormalized = state.motion_rep.unnormalize(samples)
            pred = state.motion_rep.inverse(samples_unnormalized, is_normalized=False)

        posed_joints = pred["posed_joints"]  # [1, T, J, 3]
        global_rot_mats = pred.get("global_rot_mats")  # [1, T, J, 3, 3] optional
        foot_contacts = pred.get("foot_contacts")  # [1, T, J] optional

        posed = posed_joints[0].float().cpu().numpy()
        rots = global_rot_mats[0].float().cpu().numpy() if global_rot_mats is not None else None
        contacts = foot_contacts[0].float().cpu().numpy() if foot_contacts is not None else None

        fps = float(state.fps)
        step_ms = 1000.0 / fps if fps > 0 else 50.0

        frames = []
        for t in range(posed.shape[0]):
            joints = {}
            for j, name in enumerate(CORE_JOINT_NAMES):
                position = [round(float(x), 6) for x in posed[t, j]]
                if rots is not None:
                    m = rots[t, j]
                    quaternion = rotation_matrix_to_quaternion(m)
                else:
                    quaternion = [0.0, 0.0, 0.0, 1.0]
                joints[name] = {"position": position, "rotation": quaternion}
            frame = {
                "timeMs": int(round(t * step_ms)),
                "rootPosition": joints["Hips"]["position"],
                "rootRotation": joints["Hips"]["rotation"],
                "joints": joints,
            }
            if contacts is not None:
                touched = [
                    name for j, name in enumerate(CORE_JOINT_NAMES)
                    if contacts[t, j] > 0.5 and name in FOOT_CONTACT_JOINTS
                ]
                if touched:
                    frame["footContacts"] = touched
            frames.append(frame)

    motion = {
        "schema": MOTION_SCHEMA,
        "backend": "ardy-core",
        "fps": int(round(fps)),
        "jointNames": list(CORE_JOINT_NAMES),
        "frames": frames,
    }
    return {"schema": RESULT_SCHEMA, "type": "result", "requestId": request_id, "motion": motion}


def rotation_matrix_to_quaternion(matrix):
    """Converts a 3x3 rotation matrix (numpy) to [x, y, z, w]."""
    m = matrix
    trace = m[0, 0] + m[1, 1] + m[2, 2]
    if trace > 0:
        s = (trace + 1.0) ** 0.5 * 2
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s
        y = (m[0, 2] - m[2, 0]) / s
        z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = (1.0 + m[0, 0] - m[1, 1] - m[2, 2]) ** 0.5 * 2
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = (1.0 + m[1, 1] - m[0, 0] - m[2, 2]) ** 0.5 * 2
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = (1.0 + m[2, 2] - m[0, 0] - m[1, 1]) ** 0.5 * 2
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    norm = (x * x + y * y + z * z + w * w) ** 0.5
    if norm <= 1e-12:
        return [0.0, 0.0, 0.0, 1.0]
    return [round(float(x / norm), 6), round(float(y / norm), 6),
            round(float(z / norm), 6), round(float(w / norm), 6)]


def emit_error(request_id, code, message):
    payload = {
        "schema": ERROR_SCHEMA,
        "type": "error",
        "requestId": request_id,
        "code": code,
        "message": message[:512],
    }
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description="Rayure ARDY JSONL bridge")
    parser.add_argument("--checkpoints_dir", default=None)
    parser.add_argument("--model", default=None)
    parser.add_argument("--device", default=None)
    args = parser.parse_args()

    checkpoints_dir = args.checkpoints_dir or os_env("CHECKPOINTS_DIR")
    model_name = args.model or os_env("ARDY_BRIDGE_MODEL") or "core"
    device = args.device or os_env("ARDY_BRIDGE_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")

    if not checkpoints_dir:
        emit_error("startup", "invalid_config", "checkpoints_dir is required")
        return 1

    try:
        state = load_bridge_state(checkpoints_dir, model_name, device)
    except Exception as cause:  # noqa: BLE001 - startup failure must be reported
        emit_error("startup", "model_load_failed", str(cause))
        return 1

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = "unknown"
        try:
            request = json.loads(line)
            request_id = request.get("requestId", "unknown")
            schema = request.get("schema")
            if schema != REQUEST_SCHEMA:
                raise ValueError(f"unsupported schema: {schema}")
            if request.get("type") == "cancel":
                # Cancellation between steps: the current request (if any) was
                # already superseded by the companion; nothing to kill here.
                continue
            if request.get("type") != "generate":
                raise ValueError(f"unsupported type: {request.get('type')}")
            result = generate(state, request)
        except Exception as cause:  # noqa: BLE001 - per-request isolation
            emit_error(request_id, "generation_failed", str(cause))
            continue
        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.flush()
    return 0


def os_env(name):
    import os

    return os.environ.get(name)


if __name__ == "__main__":
    sys.exit(main())
