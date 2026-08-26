#!/usr/bin/env python3
"""Phase 1 round-trip dump: import a BVH with Blender's NATIVE importer and dump
rest + per-frame pose transforms to JSON for offline comparison against the ARDY
FK reference (spec Phase 1 acceptance item 2).

Run inside headless Blender 4.2.x:
  blender.exe --background --factory-startup --python blender_bvh_dump.py -- \
      --bvh <file.bvh> --out <dump.json>

Why axis_forward='Y', axis_up='Z': the io_anim_bvh operator computes
global_matrix = axis_conversion(from_forward, from_up).to_4x4(), and
axis_conversion('Y','Z') == identity (probed on Blender 4.2.23, 2026-08-26).
With an identity global matrix the armature stays in the BVH's native
Y-up / Z-forward file space, so pose_bone.matrix is directly comparable to the
ARDY FK reference without any axis bookkeeping.

Importer behaviors relied upon (from addons_core/io_anim_bvh/import_bvh.py):
- BVH frame 0 is dropped (skip_frame = 1); BVH frame k (k >= 1) lands on
  Blender frame k (frame_start = 1, use_fps_scale = False).
- Each non-root bone's pose rotation is keyframed as rest_inv @ R_bvh @ rest,
  so pose_bone.matrix rotation == R_global[j] @ rest_rotation[j] and
  translation == P_j when global_matrix is identity.
- update_scene_fps=True sets scene.render.fps to round(1/frame_time), so the
  dump records whether the 20 fps contract survives the import.

The dump JSON is consumed by roundtrip_verify.py (runs in the toolchain venv,
no Blender required).
"""

from __future__ import annotations

import json
import sys


def _arg(name: str, default: str | None = None):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return default


def _mat3(m):
    return [[float(m[i][j]) for j in range(3)] for i in range(3)]


def _mat4(m):
    return [[float(m[i][j]) for j in range(4)] for i in range(4)]


def main() -> int:
    import bpy

    bvh_path = _arg("--bvh")
    out_path = _arg("--out")
    if not bvh_path or not out_path:
        print("usage: blender --background --factory-startup --python blender_bvh_dump.py -- --bvh <file.bvh> --out <dump.json>")
        return 2

    # Enable the bundled native BVH importer.
    bpy.ops.preferences.addon_enable(module="io_anim_bvh")

    bpy.ops.import_anim.bvh(
        filepath=bvh_path,
        axis_forward="Y",
        axis_up="Z",
        rotate_mode="NATIVE",
        global_scale=1.0,
        use_fps_scale=False,
        update_scene_fps=True,
        update_scene_duration=True,
    )

    scene = bpy.context.scene
    arm = None
    for obj in bpy.data.objects:
        if obj.type == "ARMATURE":
            arm = obj
            break
    if arm is None:
        print("fatal: no armature found after BVH import")
        return 3

    action = arm.animation_data.action
    if action is None:
        print("fatal: imported armature has no action")
        return 3

    rest = {}
    pose = {}
    for bone in arm.data.bones:
        rest[bone.name] = {
            "head": [float(bone.head_local[i]) for i in range(3)],
            "tail": [float(bone.tail_local[i]) for i in range(3)],
            "length": float(bone.length),
            "restMatrix3": _mat3(bone.matrix_local.to_3x3()),
            "connected": bool(bone.use_connect),
        }

    frame_start = int(action.frame_range[0])
    frame_end = int(action.frame_range[1])
    for f in range(frame_start, frame_end + 1):
        scene.frame_set(f)
        bpy.context.view_layer.update()
        frame_pose = {}
        for pb in arm.pose.bones:
            m = pb.matrix  # armature space; matrix_world is identity after import
            frame_pose[pb.name] = {
                "translation": [float(m[i][3]) for i in range(3)],
                "rotation3": _mat3(m.to_3x3()),
            }
        pose[f] = frame_pose

    doc = {
        "blenderVersion": bpy.app.version_string,
        "bvhFile": bvh_path,
        "armatureObject": arm.name,
        "armatureMatrixWorldIsIdentity": all(
            abs(float(arm.matrix_world[i][j]) - (1.0 if i == j else 0.0)) < 1e-6
            for i in range(4) for j in range(4)
        ),
        "scene": {
            "fps": scene.render.fps,
            "fpsBase": scene.render.fps_base,
        },
        "action": {
            "name": action.name,
            "frameRange": [frame_start, frame_end],
            "fcurveCount": len(action.fcurves),
            "keyframeCountsByBone": {
                bvh_bone: 0 for bvh_bone in rest
            },
        },
        "bones": rest,
        "pose": {str(f): pose[f] for f in pose},
    }

    # Count keyframes per bone to cross-check the frame count contract.
    for fcu in action.fcurves:
        if len(fcu.keyframe_points):
            bone_name = fcu.group.name if fcu.group else "?"
            doc["action"]["keyframeCountsByBone"][bone_name] = doc["action"]["keyframeCountsByBone"].get(bone_name, 0) + len(fcu.keyframe_points)

    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    print(f"wrote {out_path}: bones={len(rest)} frames={frame_start}..{frame_end} "
          f"scene_fps={scene.render.fps} fcurves={len(action.fcurves)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
