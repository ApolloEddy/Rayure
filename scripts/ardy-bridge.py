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
normalized internal representation. Each result carries an opaque continuation
id; a later request supplies that id plus renderer-confirmed frame progress.
Canonical JSON is never guessed back into ARDY's representation.

Request `numFrames` means the number of NEW frames for this segment (the
playback length). ARDY itself generates exactly gen_horizon_len (40) frames
per autoregressive step with window semantics, so larger requests loop
multiple steps internally and trim the result; see generate().

Usage (inside the ardy python environment):
  python ardy-bridge.py --checkpoints_dir <dir> [--model core] [--device cuda]

Environment overrides: CHECKPOINTS_DIR, ARDY_BRIDGE_MODEL, ARDY_BRIDGE_DEVICE.
"""

import argparse
from collections import OrderedDict
import json
import os
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

FOOT_CONTACT_JOINT_NAMES = None  # resolved from the skeleton at load time


def resolve_foot_contact_names(skeleton):
    """Maps the 4 foot-contact channels (left heel, left toe, right heel,
    right toe) to CoreSkeleton27 joint names via the skeleton's own indices."""
    global FOOT_CONTACT_JOINT_NAMES
    indices = list(getattr(skeleton, "left_foot_joint_idx", [])) + list(
        getattr(skeleton, "right_foot_joint_idx", [])
    )
    names = [CORE_JOINT_NAMES[i] for i in indices if 0 <= i < len(CORE_JOINT_NAMES)]
    if len(names) != 4:
        raise ValueError(f"skeleton foot joint indices do not map to 4 joints: {indices}")
    FOOT_CONTACT_JOINT_NAMES = names
    return names


class BridgeState:
    """Holds model-owned continuation tensors and bounded bridge state."""

    def __init__(self, model, device):
        self.model = model
        self.device = device
        self.motion_rep = model.motion_rep
        # Opaque continuation tensors are keyed by result-local ids.  They are
        # intentionally not inferred from "the latest generation": a renderer
        # may interrupt an earlier segment while a newer result exists.
        self.continuations = OrderedDict()
        self.continuation_sequence = 0
        self.fps = model.motion_rep.fps if hasattr(model.motion_rep, "fps") else 20.0
        self.lock = threading.Lock()


def load_bridge_state(checkpoints_dir, model_name, device):
    from ardy.model import load_model

    # text_encoder=False is required (None would build the Llama encoder);
    # the bridge only ever consumes cached Motion Semantic Features.
    model = load_model(modelname=model_name, checkpoints_dir=checkpoints_dir, device=device,
                       text_encoder=False)
    model.eval()
    resolve_foot_contact_names(model.skeleton)
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
    """Reject lossy JSON rehydration instead of silently discontinuing pose."""
    del state, history
    raise ValueError(
        "Canonical Motion history cannot be rehydrated by this ARDY build; "
        "use the continuationId returned by the bridge or generate a fresh segment"
    )


MAX_CONTINUATIONS = 64
SUPPORTED_CONSTRAINT_JOINTS = {"Hips", "LeftHand", "RightHand", "LeftFoot", "RightFoot"}


def crop_history(history, max_history, nfp):
    """Keeps a complete-token suffix of an explicit ARDY motion tensor."""
    if history is None:
        return None
    length = int(history.shape[1])
    aligned = (length // nfp) * nfp
    if aligned <= 0:
        return None
    start = max(0, aligned - max_history)
    start = (start // nfp) * nfp
    return history[:, start:aligned]


def resolve_continuation_history(state, request, max_history, nfp):
    """Resolves only the renderer-confirmed prefix of a specific segment.

    A continuation id is intentionally required for live re-planning.  The old
    "last bridge output" behavior was ambiguous whenever a later generation
    arrived before the renderer had consumed the earlier one.
    """
    continuation = request.get("continuation")
    if continuation is not None:
        if not isinstance(continuation, dict):
            raise ValueError("continuation must be an object")
        continuation_id = continuation.get("id")
        consumed = continuation.get("consumedFrameCount")
        if not isinstance(continuation_id, str) or not continuation_id:
            raise ValueError("continuation id is required")
        if not isinstance(consumed, int) or consumed < 1:
            raise ValueError("continuation consumedFrameCount must be a positive integer")
        entry = state.continuations.get(continuation_id)
        if entry is None:
            raise ValueError("continuation is unavailable; generate a fresh segment")
        if consumed > entry["output_frame_count"]:
            raise ValueError("continuation consumedFrameCount exceeds its published segment")

        rendered = (consumed // nfp) * nfp
        end = entry["base_history_length"] + rendered
        if end <= 0:
            return None
        history = entry["tensor"][:, :end].to(state.device)
        return crop_history(history, max_history, nfp)

    if request.get("history") is not None:
        return crop_history(canonical_history_to_tensor(state, request["history"]), max_history, nfp)
    return None


def remember_continuation(state, base_history, generated_tails, want):
    """Stores a bounded exact tensor prefix for the segment just returned."""
    base_length = 0 if base_history is None else int(base_history.shape[1])
    pieces = [] if base_history is None else [base_history]
    pieces.extend(generated_tails)
    if not pieces:
        raise ValueError("cannot create a continuation without generated motion")
    tensor = torch.cat(pieces, dim=1) if len(pieces) > 1 else pieces[0]
    tensor = tensor[:, :base_length + want].detach().to("cpu").clone()
    state.continuation_sequence += 1
    continuation_id = f"bridge-{state.continuation_sequence:x}-{os.urandom(8).hex()}"
    state.continuations[continuation_id] = {
        "tensor": tensor,
        "base_history_length": base_length,
        "output_frame_count": want,
    }
    while len(state.continuations) > MAX_CONTINUATIONS:
        state.continuations.popitem(last=False)
    return continuation_id


def normalize_constraints(state, request_constraints, want):
    """Normalizes JSON constraints to one unambiguous entry per joint/frame."""
    if request_constraints is None:
        return []
    if not isinstance(request_constraints, list) or len(request_constraints) > 256:
        raise ValueError("constraints must contain up to 256 items")
    merged = {}
    for index, constraint in enumerate(request_constraints):
        if not isinstance(constraint, dict):
            raise ValueError(f"constraint {index} must be an object")
        time_ms = constraint.get("timeMs")
        joint = constraint.get("joint")
        if not isinstance(time_ms, int) or time_ms < 0:
            raise ValueError(f"constraint {index}.timeMs must be a non-negative integer")
        if joint not in SUPPORTED_CONSTRAINT_JOINTS:
            allowed = ", ".join(sorted(SUPPORTED_CONSTRAINT_JOINTS))
            raise ValueError(f"constraint {index}.joint must be one of: {allowed}")
        frame_index = int(round(time_ms * float(state.fps) / 1000.0))
        if frame_index >= want:
            raise ValueError(f"constraint {index}.timeMs is outside the requested segment")
        key = (joint, frame_index)
        current = merged.setdefault(key, {"joint": joint, "frame_index": frame_index})
        if "position" in constraint:
            if "position" in current:
                raise ValueError(f"constraint {index} duplicates a position target")
            current["position"] = require_finite_vector(constraint["position"], 3, f"constraint {index}.position")
        if "rotation" in constraint:
            if "rotation" in current:
                raise ValueError(f"constraint {index} duplicates a rotation target")
            current["rotation"] = require_finite_vector(constraint["rotation"], 4, f"constraint {index}.rotation")
            if np.linalg.norm(current["rotation"]) <= 1e-6:
                raise ValueError(f"constraint {index}.rotation must not be zero")
        if "position" not in current and "rotation" not in current:
            raise ValueError(f"constraint {index} must define position or rotation")
    return list(merged.values())


def require_finite_vector(value, size, name):
    if not isinstance(value, list) or len(value) != size:
        raise ValueError(f"{name} must be a {size}D vector")
    if any(not isinstance(component, (int, float)) or not np.isfinite(component) for component in value):
        raise ValueError(f"{name} must contain finite numbers")
    return [float(component) for component in value]


def build_step_constraints(state, constraints, hist_len, generated_start, gen_horizon):
    """Builds official ARDY constraint sets for this autoregressive window."""
    selected = [
        constraint for constraint in constraints
        if generated_start <= constraint["frame_index"] < generated_start + gen_horizon
    ]
    if not selected:
        return None, None

    from ardy.constraints import EndEffectorConstraintSet, Root2DConstraintSet

    by_joint = {}
    for constraint in selected:
        by_joint.setdefault(constraint["joint"], []).append(constraint)
    constraint_sets = []
    skeleton = state.model.skeleton
    for joint, entries in by_joint.items():
        entries.sort(key=lambda entry: entry["frame_index"])
        frame_indices = torch.tensor(
            [hist_len + entry["frame_index"] - generated_start for entry in entries],
            dtype=torch.long,
        )
        positions, rotations = neutral_constraint_pose(state, len(entries))
        root_index = skeleton.root_idx
        root_2d = positions[:, root_index, [0, 2]].clone()

        if joint == "Hips":
            for row, entry in enumerate(entries):
                if "position" in entry:
                    root_2d[row] = torch.tensor(
                        [entry["position"][0], entry["position"][2]],
                        device=state.device,
                        dtype=torch.float32,
                    )
            constraint_sets.append(Root2DConstraintSet(
                skeleton,
                frame_indices,
                root_2d,
            ))
            heading_entries = [entry for entry in entries if entry.get("rotation") is not None]
            if heading_entries:
                heading_indices = torch.tensor(
                    [hist_len + entry["frame_index"] - generated_start for entry in heading_entries],
                    dtype=torch.long,
                )
                heading_roots = torch.stack([
                    root_2d[entries.index(entry)] for entry in heading_entries
                ])
                heading_tensor = torch.tensor(
                    [quaternion_heading(entry["rotation"]) for entry in heading_entries],
                    device=state.device,
                    dtype=torch.float32,
                )
                constraint_sets.append(Root2DConstraintSet(
                    skeleton,
                    heading_indices,
                    heading_roots,
                    heading_tensor,
                ))
            continue

        rot_joint_names, pos_joint_names = skeleton.expand_joint_names([joint])
        anchor_index = skeleton.bone_index[joint]
        for row, entry in enumerate(entries):
            if "position" in entry:
                target = torch.tensor(entry["position"], device=state.device, dtype=torch.float32)
                delta = target - positions[row, anchor_index]
                for name in pos_joint_names:
                    positions[row, skeleton.bone_index[name]] += delta
                root_2d[row] = positions[row, root_index, [0, 2]]
            if "rotation" in entry:
                rotation = quaternion_to_matrix(entry["rotation"], state.device)
                for name in rot_joint_names:
                    rotations[row, skeleton.bone_index[name]] = rotation

        constraint_sets.append(EndEffectorConstraintSet(
            skeleton,
            frame_indices,
            positions,
            rotations,
            root_2d,
            # ARDY's position-condition encoder requires one Hips entry for
            # every constrained timestamp; official hand/foot condition sets
            # include it for the same reason.
            joint_names=[joint, "Hips"],
        ))

    lengths = torch.tensor([hist_len + gen_horizon], device=state.device, dtype=torch.long)
    return state.motion_rep.create_conditions_from_constraints_batched(
        constraint_sets,
        lengths,
        to_normalize=True,
        device=str(state.device),
    )


def neutral_constraint_pose(state, count):
    skeleton = state.model.skeleton
    joint_count = len(skeleton.bone_order_names)
    local_rotations = torch.eye(3, device=state.device, dtype=torch.float32).reshape(1, 1, 3, 3)
    local_rotations = local_rotations.expand(count, joint_count, 3, 3).clone()
    roots = torch.zeros(count, 3, device=state.device, dtype=torch.float32)
    rotations, positions, _ = skeleton.fk(local_rotations, roots)
    return positions, rotations


def quaternion_heading(quaternion):
    if quaternion is None:
        return None
    x, y, z, w = quaternion
    magnitude = float(np.linalg.norm(quaternion))
    if magnitude <= 1e-6:
        return None
    x, y, z, w = x / magnitude, y / magnitude, z / magnitude, w / magnitude
    return float(np.arctan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z)))


def quaternion_to_matrix(quaternion, device):
    x, y, z, w = quaternion
    magnitude = float(np.linalg.norm(quaternion))
    if magnitude <= 1e-6:
        raise ValueError("constraint rotation must not be zero")
    x, y, z, w = x / magnitude, y / magnitude, z / magnitude, w / magnitude
    return torch.tensor([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ], device=device, dtype=torch.float32)


def generate(state, request):
    """Generates a segment plus an opaque continuation for its visible prefix.

    ARDY's autoregressive API receives a whole window but produces a 40-frame
    tail per call.  The bridge keeps every tail belonging to this response so
    a later request can slice at the *renderer-confirmed* frame count rather
    than accidentally continuing from whichever request ran most recently.
    """
    request_id = request["requestId"]
    text_feature = request.get("textFeature")
    if not text_feature:
        raise ValueError("textFeature is required")
    want = int(request["numFrames"])
    if want < 1 or want > 600:
        raise ValueError("numFrames must be from 1 through 600")
    num_denoising_steps = int(request["numDenoisingSteps"])
    cfg_weight = float(request["cfgWeight"])

    text_feat, text_pad_mask = feature_to_tensors(state, text_feature)
    gen_horizon = int(getattr(state.model, "gen_horizon_len", 40))
    nfp = max(1, int(getattr(state.model, "num_frames_per_token", 1)))
    # Trained window budget: 10 s * fps; history must leave room for one horizon.
    max_window = max(gen_horizon + nfp, int(round(float(state.fps) * 10.0)))
    max_history = max(nfp, (max_window - gen_horizon) // nfp * nfp)
    constraints = normalize_constraints(state, request.get("constraints"), want)

    with state.lock:
        history = resolve_continuation_history(state, request, max_history, nfp)
        base_history = history
        steps = max(1, -(-want // gen_horizon))
        generated_start = 0
        generated_tails = []
        new_posed, new_rots, new_contacts = [], [], []
        for _ in range(steps):
            history = crop_history(history, max_history, nfp)
            hist_len = 0 if history is None else int(history.shape[1])
            window = hist_len + gen_horizon
            observed_motion, motion_mask = build_step_constraints(
                state,
                constraints,
                hist_len,
                generated_start,
                gen_horizon,
            )

            init_global_translation = None
            init_first_heading_angle = None
            if history is None:
                init_global_translation = torch.zeros(1, 3, device=state.device)
                init_first_heading_angle = torch.zeros(1, device=state.device)

            with torch.inference_mode():
                samples = state.model.autoregressive_step(
                    num_frames=window,
                    num_denoising_steps=num_denoising_steps,
                    motion_mask=motion_mask,
                    observed_motion=observed_motion,
                    cfg_weight=(cfg_weight, cfg_weight),
                    texts=None,
                    text_feat=text_feat,
                    text_pad_mask=text_pad_mask,
                    init_history_sequence=history,
                    init_global_translation=init_global_translation,
                    init_first_heading_angle=init_first_heading_angle,
                )
                tail = samples[:, hist_len:]
                generated_tails.append(tail)
                history = samples
                generated_start += int(tail.shape[1])

                pred = decode_window(state, samples)
                new_posed.append(pred["posed"][hist_len:])
                if pred["rots"] is not None:
                    new_rots.append(pred["rots"][hist_len:])
                if pred["contacts"] is not None:
                    new_contacts.append(pred["contacts"][hist_len:])

        continuation_id = remember_continuation(state, base_history, generated_tails, want)
        posed = np.concatenate(new_posed, axis=0)[:want]
        rots = np.concatenate(new_rots, axis=0)[:want] if new_rots else None
        contacts = np.concatenate(new_contacts, axis=0)[:want] if new_contacts else None

        fps = float(state.fps)
        step_ms = 1000.0 / fps if fps > 0 else 50.0
        frames = []
        for t in range(posed.shape[0]):
            joints = {}
            for j, name in enumerate(CORE_JOINT_NAMES):
                position = [round(float(x), 6) for x in posed[t, j]]
                if rots is not None:
                    quaternion = rotation_matrix_to_quaternion(rots[t, j])
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
                    name for c, name in enumerate(FOOT_CONTACT_JOINT_NAMES)
                    if contacts[t, c] > 0.5
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
    return {
        "schema": RESULT_SCHEMA,
        "type": "result",
        "requestId": request_id,
        "motion": motion,
        "continuationId": continuation_id,
    }


def decode_window(state, samples):
    """Decodes one full window (normalized hybrid) into explicit motion arrays."""
    with torch.inference_mode():
        samples_unnormalized = state.motion_rep.unnormalize(samples)
        pred = state.motion_rep.inverse(samples_unnormalized, is_normalized=False)
    posed_joints = pred["posed_joints"]  # [1, T, J, 3]
    global_rot_mats = pred.get("global_rot_mats")  # [1, T, J, 3, 3] optional
    foot_contacts = pred.get("foot_contacts")  # [1, T, J] optional
    return {
        "posed": posed_joints[0].float().cpu().numpy(),
        "rots": global_rot_mats[0].float().cpu().numpy() if global_rot_mats is not None else None,
        "contacts": foot_contacts[0].float().cpu().numpy() if foot_contacts is not None else None,
    }


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


class ProtocolWriter:
    """Writes JSONL responses on the real stdout while fd 1 is redirected.

    ARDY and its dependencies print diagnostics (model config, warnings) to
    stdout, which would corrupt the JSONL protocol stream. The bridge
    therefore points fd 1 at stderr for its whole lifetime and keeps the
    original stdout for protocol writes only.
    """

    def __init__(self):
        sys.stdout.flush()
        self._saved_fd = os.dup(1)
        os.dup2(sys.stderr.fileno(), 1)
        self._stream = os.fdopen(self._saved_fd, "w", encoding="utf-8")

    def write_line(self, payload):
        self._stream.write(json.dumps(payload) + "\n")
        self._stream.flush()


_writer = None  # created in main() before any load can print


def emit_error(request_id, code, message):
    # The TypeScript parent validates a single printable line. Tensor/runtime
    # exceptions can contain newlines, so normalize before placing them on the
    # JSONL protocol instead of turning a useful bridge error into a second
    # protocol-validation failure.
    detail = " ".join(str(message).split())[:512]
    payload = {
        "schema": ERROR_SCHEMA,
        "type": "error",
        "requestId": request_id,
        "code": code,
        "message": detail or "ARDY bridge failed without an error message",
    }
    _writer.write_line(payload)


def main():
    global _writer
    _writer = ProtocolWriter()

    parser = argparse.ArgumentParser(description="Rayure ARDY JSONL bridge")
    parser.add_argument("--checkpoints_dir", default=None)
    parser.add_argument("--model", default=None)
    parser.add_argument("--device", default=None)
    parser.add_argument("--ardy_path", default=None,
                        help="path to the ardy source tree (when not pip-installed)")
    args = parser.parse_args()

    if args.ardy_path:
        sys.path.insert(0, args.ardy_path)

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
            emit_error(request_id, "generation_failed", f"{type(cause).__name__}: {cause}")
            continue
        _writer.write_line(result)
    return 0


def os_env(name):
    return os.environ.get(name)


if __name__ == "__main__":
    sys.exit(main())
