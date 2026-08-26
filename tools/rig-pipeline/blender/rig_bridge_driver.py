"""Thin Phase 2 Blender/HRS driver.

This file is an orchestration harness, not a retarget implementation.  It
imports one target model and one CoreSkeleton27 BVH, calls the public HRS
``auto_guess`` and ``execute_retarget`` operators, validates the resulting
Action, exports a selected-model GLB, and reads that GLB in a clean scene.

The semantic map is supplied by the fixture caller.  The driver never writes
HRS mapping slots, creates aliases, or infers a bone from geometry.

The script is intentionally usable with the portable Blender from the Phase 2
scratch harness:

    blender.exe --background --factory-startup \
      --python rig_bridge_driver.py -- \
      --target <model> --bvh <ardy.bvh> --target-armature Armature \
      --probe-bones Hips,Head,LeftFoot,RightFoot \
      --expected-map expected.json --clip-id idle-001 \
      --glb <output.glb> --out <report.json>
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sys
import traceback
from datetime import datetime, timezone


CORE_ROLES = (
    "hips",
    "spine_01",
    "head",
    "left_upper_arm",
    "left_lower_arm",
    "left_hand",
    "right_upper_arm",
    "right_lower_arm",
    "right_hand",
    "left_upper_leg",
    "left_lower_leg",
    "left_foot",
    "right_upper_leg",
    "right_lower_leg",
    "right_foot",
)


class StageFailure(RuntimeError):
    """A stable, reportable failure in the offline pipeline."""

    def __init__(self, code: str, message: str, *, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


def _arg(name: str, default=None):
    if name not in sys.argv:
        return default
    index = sys.argv.index(name)
    if index + 1 >= len(sys.argv):
        raise StageFailure("INPUT_INVALID", f"Missing value for {name}.")
    return sys.argv[index + 1]


def _has_flag(name: str) -> bool:
    return name in sys.argv


def _finite(value) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json_write(path: str, value):
    if not path:
        return
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _enable_importers(bpy):
    enabled = []
    for module in ("io_scene_fbx", "io_scene_gltf2"):
        try:
            bpy.ops.preferences.addon_enable(module=module)
            enabled.append(module)
        except Exception as error:  # Blender builds differ in built-in module names.
            print(f"note: importer {module} did not need enabling: {error}")
    return enabled


def _enable_hrs(bpy):
    module = "bl_ext.user_default.humanoid_remap_studio"
    try:
        bpy.ops.preferences.addon_enable(module=module)
    except Exception as error:
        raise StageFailure("RIG_BRIDGE_NOT_INSTALLED", f"Cannot enable HRS: {error}")
    operator_ids = {
        getattr(cls, "bl_idname", "")
        for cls in bpy.types.Operator.__subclasses__()
        if getattr(cls, "bl_idname", "")
    }
    missing = {"hrs.auto_guess", "hrs.execute_retarget"} - operator_ids
    if missing:
        raise StageFailure(
            "RIG_BRIDGE_API_MISMATCH",
            "HRS public operators are not registered.",
            details={"missingOperators": sorted(missing)},
        )


def _import_target(bpy, path: str):
    if not os.path.isfile(path):
        raise StageFailure("IMPORT_FAILED", f"Target file does not exist: {os.path.basename(path)}")
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    importer = None
    options = {}
    notes = []
    if ext == "blend":
        importer = "blender.open_mainfile"
        options = {"filepath": "<source>"}
        try:
            bpy.ops.wm.open_mainfile(filepath=path)
        except RuntimeError as error:
            # Some private .blend files report a late shapekey warning after
            # populating the scene.  Continue only if a usable armature exists.
            notes.append(f"open_mainfile raised after load: {error}")
    elif ext == "fbx":
        importer = "blender.io_scene_fbx"
        options = {"filepath": "<source>"}
        try:
            bpy.ops.import_scene.fbx(filepath=path)
        except Exception as error:
            raise StageFailure("IMPORT_FAILED", f"FBX import failed: {error}") from error
    elif ext in {"glb", "gltf", "vrm"}:
        # Blender's bundled glTF importer is deliberately used for the GLB
        # container.  A VRM-specific metadata gate remains a later lock item;
        # no VRM conversion or skeleton rewrite is performed here.
        importer = "blender.io_scene_gltf2"
        options = {"filepath": "<source>"}
        try:
            bpy.ops.import_scene.gltf(filepath=path)
        except Exception as error:
            raise StageFailure("IMPORT_FAILED", f"glTF/VRM import failed: {error}") from error
    else:
        raise StageFailure(
            "IMPORTER_NOT_LOCKED",
            f"No locked Phase 2 importer for .{ext}.",
            details={"extension": ext},
        )
    return {
        "format": ext,
        "id": importer,
        "operator": importer,
        "options": options,
        "notes": notes,
    }


def _armatures(bpy):
    return [obj for obj in bpy.data.objects if obj.type == "ARMATURE"]


def _choose_target_armature(arms, requested: str | None):
    if requested:
        matches = [arm for arm in arms if arm.name == requested]
        if len(matches) != 1:
            raise StageFailure(
                "POSTURE_REFERENCE_UNAVAILABLE",
                f"Target armature {requested!r} is not unique.",
                details={"availableArmatures": [arm.name for arm in arms]},
            )
        return matches[0]
    if len(arms) != 1:
        raise StageFailure(
            "POSTURE_REFERENCE_UNAVAILABLE",
            "--target-armature is required when the model has multiple armatures.",
            details={"availableArmatures": [arm.name for arm in arms]},
        )
    return arms[0]


def _strict_posture(arm, names):
    if len(names) != 4 or any(not name for name in names):
        raise StageFailure(
            "POSTURE_REFERENCE_UNAVAILABLE",
            "Exactly four ground-truth posture bones are required: Hips, Head, LeftFoot, RightFoot.",
        )
    keys = ("hips", "head", "leftFoot", "rightFoot")
    values = {}
    missing = []
    for key, name in zip(keys, names):
        bone = arm.data.bones.get(name)
        if bone is None:
            missing.append(name)
            continue
        point = arm.matrix_world @ bone.head_local
        xyz = [float(point[index]) for index in range(3)]
        if not all(_finite(value) for value in xyz):
            raise StageFailure(
                "REST_POSE_REJECTED",
                f"Non-finite rest-pose coordinate on {name!r}.",
                details={"bone": name, "xyz": xyz},
            )
        values[key] = {"name": name, "xyz": [round(value, 6) for value in xyz]}
    if missing:
        raise StageFailure(
            "POSTURE_REFERENCE_UNAVAILABLE",
            "Ground-truth posture bone is missing.",
            details={"missing": missing, "armature": arm.name},
        )
    head_z = values["head"]["xyz"][2]
    hips_z = values["hips"]["xyz"][2]
    left_z = values["leftFoot"]["xyz"][2]
    right_z = values["rightFoot"]["xyz"][2]
    passed = bool(head_z > hips_z > left_z and head_z > hips_z > right_z)
    report = {
        "armature": arm.name,
        "bones": values,
        "matrixWorld": [[round(float(value), 8) for value in row] for row in arm.matrix_world],
        "headAboveHips": head_z > hips_z,
        "leftFootBelowHips": hips_z > left_z,
        "rightFootBelowHips": hips_z > right_z,
        "passed": passed,
    }
    if not passed:
        raise StageFailure(
            "REST_POSE_REJECTED",
            "Head/Hips/Feet world-Z posture gate failed.",
            details=report,
        )
    return report


def _fingerprint_armature(arm):
    bones = []
    for bone in sorted(arm.data.bones, key=lambda item: item.name):
        bones.append(
            {
                "name": bone.name,
                "parent": bone.parent.name if bone.parent else None,
                "head": [float(value) for value in bone.head_local],
                "tail": [float(value) for value in bone.tail_local],
                "matrix": [
                    [float(value) for value in row]
                    for row in bone.matrix_local
                ],
            }
        )
    payload = {"objectMatrix": [[float(value) for value in row] for row in arm.matrix_world], "bones": bones}
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {"sha256": hashlib.sha256(encoded).hexdigest(), "boneCount": len(bones), "boneNames": [row["name"] for row in bones]}


def _load_expected_map(path):
    if not path or not os.path.isfile(path):
        raise StageFailure(
            "RIG_MAPPING_SEMANTIC_MISMATCH",
            "A fixture ground-truth role-to-bone map is required for the semantic audit.",
        )
    with open(path, encoding="utf-8") as handle:
        value = json.load(handle)
    if isinstance(value, dict) and isinstance(value.get("target"), dict):
        value = value["target"]
    if not isinstance(value, dict):
        raise StageFailure("INPUT_INVALID", "Expected map must be a JSON object.")
    normalized = {}
    for role, entry in value.items():
        if isinstance(entry, dict):
            entry = entry.get("target")
        if isinstance(entry, str) and entry:
            normalized[str(role)] = entry
    missing = [role for role in CORE_ROLES if role not in normalized]
    if missing:
        raise StageFailure(
            "RIG_MAPPING_SEMANTIC_MISMATCH",
            "Expected map does not cover every HRS core role.",
            details={"missingExpectedRoles": missing},
        )
    return normalized


def _collect_slots(scene):
    slots = []
    for slot in scene.hrs_mapping_slots:
        slots.append(
            {
                "role": str(slot.role_id),
                "source": str(slot.source_bone),
                "target": str(slot.target_bone),
                "status": str(slot.status),
                "confidence": round(float(slot.confidence), 4),
                "note": str(slot.note),
            }
        )
    return slots


def _semantic_audit(scene, expected):
    slots = _collect_slots(scene)
    by_role = {row["role"]: row for row in slots}
    mismatches = []
    manual = []
    duplicate_targets = {}
    for role, target in expected.items():
        row = by_role.get(role)
        if row is None or not row["target"]:
            mismatches.append({"role": role, "expected": target, "actual": None})
            continue
        if row["status"] == "manual":
            manual.append(role)
        duplicate_targets.setdefault(row["target"], []).append(role)
        if row["target"] != target:
            mismatches.append({"role": role, "expected": target, "actual": row["target"]})
    duplicates = {
        target: roles for target, roles in duplicate_targets.items() if len(roles) > 1
    }
    passed = not mismatches and not manual and not duplicates
    return {
        "passed": passed,
        "expectedCoreRoles": len(CORE_ROLES),
        "mismatches": mismatches,
        "manualSlots": manual,
        "duplicateTargets": duplicates,
        "slots": slots,
    }


def _find_source_armature(bpy, target, before_names, bvh_path):
    stem = os.path.splitext(os.path.basename(bvh_path))[0]
    candidates = [
        arm
        for arm in _armatures(bpy)
        if arm is not target and arm.animation_data and arm.animation_data.action
    ]
    new_candidates = [arm for arm in candidates if arm.name not in before_names]
    candidates = new_candidates or candidates
    exact = [arm for arm in candidates if arm.name == stem]
    if exact:
        return exact[0]
    if len(candidates) == 1:
        return candidates[0]
    raise StageFailure(
        "SOURCE_MAPPING_FAILED",
        "Could not uniquely identify the imported BVH source armature.",
        details={"candidates": [arm.name for arm in candidates]},
    )


def _import_source_bvh(bpy, path: str):
    if not os.path.isfile(path):
        raise StageFailure("SOURCE_MAPPING_FAILED", "ARDY BVH does not exist.")
    try:
        bpy.ops.import_anim.bvh(
            filepath=path,
            axis_forward="Z",
            axis_up="Y",
            global_scale=1.0,
            use_fps_scale=False,
            update_scene_fps=True,
            update_scene_duration=False,
        )
    except Exception as error:
        raise StageFailure("SOURCE_MAPPING_FAILED", f"BVH import failed: {error}") from error


def _action_report(action):
    if action is None:
        raise StageFailure("BAKE_VALIDATION_FAILED", "No target Action was generated.")
    fcurves = list(action.fcurves)
    points = [point.co for curve in fcurves for point in curve.keyframe_points]
    finite = all(_finite(value) for point in points for value in point)
    start, end = [float(value) for value in action.frame_range]
    report = {
        "name": action.name,
        "frameStart": start,
        "frameEnd": end,
        "frameCount": int(math.floor(end - start + 1.0)) if end >= start else 0,
        "fcurveCount": len(fcurves),
        "keyframeCount": len(points),
        "finite": finite,
        "hrsRetargetResult": bool(action.get("hrs_retarget_result", False)),
    }
    if start > end or not fcurves or not points or not finite:
        raise StageFailure("BAKE_VALIDATION_FAILED", "Generated Action is empty or non-finite.", details=report)
    return report


def _discard_active_action(bpy, obj):
    """Detach an imported action and remove it when it is no longer used.

    Blender's glTF ``ACTIONS`` export mode enumerates Action datablocks, not
    just the active action on the selected armature.  Target files such as an
    FBX can therefore leak their original animation into the baked artifact
    unless that datablock is explicitly discarded before export.
    """
    if obj is None or not obj.animation_data:
        return None
    action = obj.animation_data.action
    obj.animation_data.action = None
    if action is not None and action.users == 0:
        bpy.data.actions.remove(action)
    return action


def _prune_actions_for_export(bpy, keep):
    """Keep only the baked target action in the export scene.

    ``export_animation_mode='ACTIONS'`` walks the scene's Action datablocks.
    Detaching an active action is not sufficient for files that mark the
    datablock as a fake user, so detach every non-target action first and then
    remove those datablocks explicitly.
    """
    for obj in bpy.data.objects:
        if obj.animation_data and obj.animation_data.action is not keep:
            obj.animation_data.action = None
    for candidate in list(bpy.data.actions):
        if candidate is keep:
            continue
        candidate.use_fake_user = False
        bpy.data.actions.remove(candidate)


def _select_model_objects(bpy, target, source):
    objects = {target}
    for obj in bpy.data.objects:
        if obj is source or obj.type in {"CAMERA", "LIGHT"}:
            continue
        if obj.type == "MESH":
            if any(mod.type == "ARMATURE" and mod.object is target for mod in obj.modifiers):
                objects.add(obj)
                continue
            parent = obj.parent
            while parent is not None:
                if parent is target:
                    objects.add(obj)
                    break
                parent = parent.parent
    return sorted(objects, key=lambda obj: obj.name)


def _export_glb(bpy, target, source, action, path):
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    target.animation_data_create()
    target.animation_data.action = action
    # ACTIONS mode can enumerate every Action datablock in the scene.  Detach
    # the imported source action for the export window so the artifact contains
    # only the baked target clip, then restore it for diagnostics.
    source_action = None
    if source is not None and source.animation_data:
        source_action = source.animation_data.action
        source.animation_data.action = None
        # ACTIONS mode enumerates Action datablocks rather than only active
        # actions.  The source BVH Action is no longer needed after bake; drop
        # this unreferenced datablock so it cannot leak into the GLB.
        if source_action is not None and source_action.users == 0:
            bpy.data.actions.remove(source_action)
    _prune_actions_for_export(bpy, action)
    for obj in bpy.context.selected_objects:
        obj.select_set(False)
    selected = _select_model_objects(bpy, target, source)
    for obj in selected:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = target
    options = {
        "filepath": path,
        "export_format": "GLB",
        "use_selection": True,
        "export_animations": True,
        "export_animation_mode": "ACTIONS",
        "export_frame_range": True,
    }
    try:
        result = bpy.ops.export_scene.gltf(**options)
    except Exception as error:
        raise StageFailure("EXPORT_FAILED", f"GLB export failed: {error}") from error
    finally:
        # The source action was intentionally removed above.  Keep the source
        # armature detached; it is not part of the exported artifact.
        if source is not None and source.animation_data:
            source.animation_data.action = None
    if "FINISHED" not in result or not os.path.isfile(path) or os.path.getsize(path) == 0:
        raise StageFailure("EXPORT_FAILED", "GLB exporter did not produce a non-empty file.")
    return {"pathBasename": os.path.basename(path), "bytes": os.path.getsize(path), "sha256": _sha256_file(path), "options": {key: value for key, value in options.items() if key != "filepath"}}


def _clean_glb_import(bpy, path, expected_clip):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _enable_importers(bpy)
    try:
        bpy.ops.import_scene.gltf(filepath=path)
    except Exception as error:
        raise StageFailure("BAKE_VALIDATION_FAILED", f"Clean GLB import failed: {error}") from error
    actions = sorted(action.name for action in bpy.data.actions)
    armatures = sorted(obj.name for obj in bpy.data.objects if obj.type == "ARMATURE")
    # Blender's glTF importer scopes an animation Action by armature name.  The
    # authored clip name remains the prefix; record the actual embedded name so
    # the manifest can address it exactly.
    matches = [name for name in actions if name == expected_clip or name.startswith(expected_clip + "_")]
    exact = len(matches) == 1
    report = {
        "passed": exact and bool(armatures),
        "expectedClip": expected_clip,
        "embeddedClipName": matches[0] if exact else None,
        "actions": actions,
        "armatures": armatures,
    }
    if not report["passed"]:
        raise StageFailure("BAKE_VALIDATION_FAILED", "Clean GLB import did not expose the baked clip.", details=report)
    return report


def _load_target_and_run(bpy, args):
    target_path = args["target"]
    bvh_path = args["bvh"]
    clip_id = args["clip_id"]
    expected_clip = f"rayure__{clip_id}"
    report = {
        "schema": "rayure.rig-pipeline-phase2-report.v1",
        "createdAt": _utc_now(),
        "status": "fail",
        "code": "INPUT_INVALID",
        "message": "",
        "model": {"basename": os.path.basename(target_path), "format": os.path.splitext(target_path)[1].lower().lstrip(".")},
        "motion": {"basename": os.path.basename(bvh_path), "sha256": _sha256_file(bvh_path) if os.path.isfile(bvh_path) else None},
        "toolchain": {"blenderVersion": ".".join(str(value) for value in bpy.app.version), "retargetToolId": "humanoid-remap-studio", "retargetMode": "auto"},
    }
    try:
        if not os.path.isfile(target_path) or not os.path.isfile(bvh_path):
            raise StageFailure("INPUT_INVALID", "Target or BVH input does not exist.")
        bpy.ops.wm.read_factory_settings(use_empty=True)
        importers = _enable_importers(bpy)
        report["toolchain"]["enabledImporters"] = importers
        importer = _import_target(bpy, target_path)
        report["importer"] = importer
        arms = _armatures(bpy)
        target = _choose_target_armature(arms, args.get("target_armature"))
        report["targetArmature"] = target.name
        # Target FBX files may contain a source animation of their own.  The
        # target is an output rig, so clear that active Action before importing
        # the ARDY source; this is not a mapping edit.
        _discard_active_action(bpy, target)
        report["posture"] = _strict_posture(target, args["probe_bones"])
        before_names = {arm.name for arm in _armatures(bpy)}
        _import_source_bvh(bpy, bvh_path)
        source = _find_source_armature(bpy, target, before_names, bvh_path)
        report["sourceArmature"] = source.name
        source_action = source.animation_data.action if source.animation_data else None
        if source_action is None:
            raise StageFailure("SOURCE_MAPPING_FAILED", "Imported BVH source has no Action.")
        report["sourceAction"] = {"name": source_action.name, "frameRange": [float(value) for value in source_action.frame_range], "fps": float(bpy.context.scene.render.fps)}
        expected = _load_expected_map(args.get("expected_map"))
        _enable_hrs(bpy)
        scene = bpy.context.scene
        scene.hrs_source_mode = "SINGLE"
        scene.hrs_source_armature = source
        scene.hrs_target_armature = target
        scene.hrs_source_armature_name = source.name
        scene.hrs_target_armature_name = target.name
        scene.hrs_retarget_keep_in_place = bool(args.get("keep_in_place"))
        auto_result = bpy.ops.hrs.auto_guess(overwrite_manual=True)
        report["hrs"] = {
            "autoOperatorResult": sorted(auto_result),
            "summary": str(scene.hrs_auto_summary),
            "detail": str(scene.hrs_auto_detail),
            "canExecuteRetarget": bool(scene.hrs_can_execute_retarget),
            "sourceProfile": str(scene.hrs_source_profile),
            "targetProfile": str(scene.hrs_target_profile),
        }
        if not scene.hrs_can_execute_retarget:
            report["hrs"]["slots"] = _collect_slots(scene)
            raise StageFailure("RIG_DETECTION_FAILED", "HRS auto_guess did not satisfy its execution gate.", details=report["hrs"])
        semantic = _semantic_audit(scene, expected)
        report["semanticAudit"] = semantic
        if not semantic["passed"]:
            raise StageFailure("RIG_MAPPING_SEMANTIC_MISMATCH", "HRS mapping failed the fixture role-to-bone audit.", details=semantic)
        before_rig = _fingerprint_armature(target)
        retarget_result = bpy.ops.hrs.execute_retarget()
        if "FINISHED" not in retarget_result:
            raise StageFailure("RETARGET_FAILED", f"HRS execute_retarget returned {sorted(retarget_result)}.")
        target_action = target.animation_data.action if target.animation_data else None
        if target_action is None:
            raise StageFailure("BAKE_VALIDATION_FAILED", "HRS did not attach a target Action.")
        target_action.name = expected_clip
        report["bake"] = _action_report(target_action)
        after_rig = _fingerprint_armature(target)
        report["targetRigBefore"] = before_rig
        report["targetRigAfter"] = after_rig
        if before_rig["sha256"] != after_rig["sha256"]:
            raise StageFailure("TARGET_RIG_MUTATED", "Target rig fingerprint changed during HRS bake.", details={"before": before_rig, "after": after_rig})
        glb = _export_glb(bpy, target, source, target_action, args["glb"])
        report["artifact"] = glb
        report["cleanImport"] = _clean_glb_import(bpy, args["glb"], expected_clip)
        report["artifact"]["embeddedClipName"] = report["cleanImport"]["embeddedClipName"]
        report["status"] = "pass"
        report["code"] = "POC_PASS_MODEL"
        report["message"] = "HRS auto_guess, semantic audit, retarget/bake, target-rig fingerprint, GLB export and clean import passed."
    except StageFailure as failure:
        report["code"] = failure.code
        report["message"] = failure.message
        if failure.details:
            report["failureDetails"] = failure.details
    except Exception as error:  # keep the report stable while retaining a short diagnostic
        report["code"] = "UNEXPECTED_ERROR"
        report["message"] = str(error)
        report["failureDetails"] = {"type": type(error).__name__, "tracebackTail": traceback.format_exc().splitlines()[-8:]}
    return report


def main():
    import bpy

    args = {
        "target": _arg("--target"),
        "bvh": _arg("--bvh"),
        "target_armature": _arg("--target-armature"),
        "expected_map": _arg("--expected-map"),
        "clip_id": _arg("--clip-id", "phase2-clip"),
        "glb": _arg("--glb"),
        "out": _arg("--out"),
        "probe_bones": [value.strip() for value in (_arg("--probe-bones", "Hips,Head,LeftFoot,RightFoot")).split(",")],
        "keep_in_place": _has_flag("--keep-in-place"),
    }
    if not args["target"] or not args["bvh"] or not args["glb"] or not args["out"]:
        report = {
            "schema": "rayure.rig-pipeline-phase2-report.v1",
            "createdAt": _utc_now(),
            "status": "fail",
            "code": "INPUT_INVALID",
            "message": "--target, --bvh, --glb and --out are required.",
        }
    else:
        report = _load_target_and_run(bpy, args)
    _json_write(args.get("out"), report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report.get("status") == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
