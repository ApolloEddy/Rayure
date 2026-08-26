#!/usr/bin/env python3
"""Phase 1 failure-schema tests (spec §6.7 / Phase 1 task list).

jsonschema is not installed in the toolchain venv, so this module ships a
minimal recursive validator that covers exactly the keywords the committed
pipeline-failure.v1 schema uses (const / required / enum / type with null
unions / properties / additionalProperties:false / pattern / length bounds).
The schema file itself remains the source of truth; this is a structural
check that every report the pipeline actually writes conforms to it.

Run with the toolchain python:
  cd tools/rig-pipeline && python -m unittest discover tests
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RIG = os.path.dirname(HERE)
sys.path.insert(0, RIG)

import ardy_to_bvh as conv  # noqa: E402
from ardy_to_bvh import InputError, ProfileError  # noqa: E402

SCHEMA_PATH = os.path.join(RIG, "schemas", "pipeline-failure.v1.schema.json")
GOLDEN_NPZ = os.path.join(HERE, "fixtures", "golden_rest.npz")

# 14 stable codes from spec §6.7 (authoritative source: the schema enum).
EXPECTED_CODES = [
    "INPUT_INVALID",
    "ARDY_REFERENCE_SKELETON_MISSING",
    "IMPORT_FAILED",
    "RIG_BRIDGE_NOT_INSTALLED",
    "RIG_BRIDGE_API_MISMATCH",
    "RIG_DETECTION_FAILED",
    "REST_POSE_REJECTED",
    "SOURCE_MAPPING_FAILED",
    "RETARGET_FAILED",
    "BAKE_VALIDATION_FAILED",
    "EXPORT_FAILED",
    "TOOL_CAPABILITY_MISMATCH",
    "RUNTIME_LOAD_FAILED",
    "BAKED_CLIP_NOT_FOUND",
]


class ValidationError(Exception):
    pass


def _check_type(value, type_spec, path):
    types = type_spec if isinstance(type_spec, list) else [type_spec]
    ok = False
    for t in types:
        if t == "null":
            ok = ok or value is None
        elif t == "object":
            ok = ok or isinstance(value, dict)
        elif t == "array":
            ok = ok or isinstance(value, list)
        elif t == "boolean":
            ok = ok or isinstance(value, bool)
        elif t == "string":
            ok = ok or isinstance(value, str)
        elif t == "number":
            ok = ok or isinstance(value, (int, float)) and not isinstance(value, bool)
        elif t == "integer":
            ok = ok or isinstance(value, int) and not isinstance(value, bool)
        else:
            raise ValidationError(f"{path}: unsupported type {t!r}")
    if not ok:
        raise ValidationError(f"{path}: expected type {type_spec}, got {type(value).__name__}")


def validate_instance(value, schema, path="$"):
    if "const" in schema:
        if value != schema["const"]:
            raise ValidationError(f"{path}: expected const {schema['const']!r}, got {value!r}")
        return
    if "type" in schema:
        _check_type(value, schema["type"], path)

    if "enum" in schema and value not in schema["enum"]:
        raise ValidationError(f"{path}: value {value!r} not in enum {schema['enum']}")

    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            raise ValidationError(f"{path}: pattern {schema['pattern']!r} not matched by {value!r}")
        if "minLength" in schema and len(value) < schema["minLength"]:
            raise ValidationError(f"{path}: shorter than minLength {schema['minLength']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            raise ValidationError(f"{path}: longer than maxLength {schema['maxLength']}")

    if isinstance(value, dict):
        props = schema.get("properties", {})
        for required_key in schema.get("required", []):
            if required_key not in value:
                raise ValidationError(f"{path}: missing required key {required_key!r}")
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in props:
                    raise ValidationError(f"{path}: unexpected property {key!r}")
        for key, sub in props.items():
            if key in value:
                validate_instance(value[key], sub, f"{path}.{key}")


def load_schema():
    with open(SCHEMA_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def _tempdir() -> str:
    return tempfile.mkdtemp(prefix="rayure-phase1-schema-")


class TestSchemaDocument(unittest.TestCase):
    def setUp(self):
        self.schema = load_schema()

    def test_draft2020_12_and_id(self):
        self.assertEqual(self.schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
        self.assertEqual(self.schema["$id"], "rayure.rig-pipeline-failure.v1")

    def test_code_enum_has_exactly_the_14_spec_codes(self):
        self.assertEqual(self.schema["properties"]["code"]["enum"], EXPECTED_CODES)

    def test_stage_enum(self):
        self.assertEqual(
            self.schema["properties"]["stage"]["enum"],
            ["ardy-to-bvh", "rig-detection", "retarget-bake", "export-glb", "bundle-build", "runtime-load"],
        )

    def test_required_is_stable(self):
        self.assertEqual(self.schema["required"], ["schema", "runId", "stage", "code", "message"])


class TestReportsFromConverter(unittest.TestCase):
    """The two failure paths the converter actually emits must conform."""

    def _converter_failure(self, bad_input=False, bad_profile=False):
        tmp = _tempdir()
        try:
            report = os.path.join(tmp, "fail.json")
            npz = GOLDEN_NPZ
            if bad_input:
                npz = os.path.join(tmp, "bad.npz")
                np.savez(npz, local_rot_mats=np.zeros((1, 3, 27, 3, 3)),
                         root_positions=np.zeros((1, 3, 3)), fps=np.array(30))
            profile = "does-not-exist.v1" if bad_profile else "core-skeleton-27.v1"
            with self.assertRaises((InputError, ProfileError)):
                conv.convert(npz, os.path.join(tmp, "out.bvh"), profile, report)
            with open(report, encoding="utf-8") as fh:
                return json.load(fh)
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    def test_input_invalid_report_conforms(self):
        doc = self._converter_failure(bad_input=True)
        self.assertEqual(doc["code"], "INPUT_INVALID")
        self.assertEqual(doc["stage"], "ardy-to-bvh")
        self.assertFalse(doc["fallbackAttempted"])
        validate_instance(doc, load_schema())

    def test_missing_profile_report_conforms(self):
        doc = self._converter_failure(bad_profile=True)
        self.assertEqual(doc["code"], "ARDY_REFERENCE_SKELETON_MISSING")
        self.assertEqual(doc["stage"], "ardy-to-bvh")
        validate_instance(doc, load_schema())

    def test_report_rejects_unspecified_property(self):
        doc = self._converter_failure(bad_input=True)
        doc["surprise"] = True
        with self.assertRaises(ValidationError):
            validate_instance(doc, load_schema())


class TestManualReports(unittest.TestCase):
    """Hand-built reports for stages the converter does not emit (retarget-bake)."""

    def _retarget_failure(self):
        return {
            "schema": "rayure.rig-pipeline-failure.v1",
            "runId": "manual-retarget-fail",
            "stage": "retarget-bake",
            "code": "RETARGET_FAILED",
            "message": "external tool reported retarget failure",
            "input": {
                "motionBasename": "walk.bvh",
                "motionSha256": "a" * 64,
                "modelBasename": "model.pmx",
                "modelSha256": "b" * 64,
            },
            "toolchain": {
                "blenderVersion": "4.2.23",
                "rigBridgeVersion": "0.1.66",
                "bvhToolVersion": None,
                "gltfExporterVersion": None,
            },
            "externalToolStatus": {
                "autoSummary": "bad posture",
                "autoDetail": "feet apart too wide",
                "canExecuteRetarget": False,
                "postureGatePassed": False,
                "coverageReady": None,
            },
            "fallbackAttempted": False,
            "createdAt": "2026-08-26T00:00:00.000000+00:00",
        }

    def test_retarget_failure_conforms(self):
        validate_instance(self._retarget_failure(), load_schema())

    def test_null_model_fields_allowed_at_converter_stage(self):
        doc = self._retarget_failure()
        doc["stage"] = "ardy-to-bvh"
        doc["input"]["modelBasename"] = None
        doc["input"]["modelSha256"] = None
        validate_instance(doc, load_schema())


if __name__ == "__main__":
    unittest.main()
