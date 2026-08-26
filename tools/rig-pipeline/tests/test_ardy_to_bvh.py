#!/usr/bin/env python3
"""Phase 1 converter tests (spec Phase 1 task list).

Covers: deterministic output hash, illegal shapes, missing joint field, NaN/Inf,
wrong FPS, truncated file, oversized input, missing profile, golden fixture, and
absence of target/alias/guess/retarget code paths.

Run with the toolchain python (has numpy + scipy):
  python -m unittest tools.rig_pipeline.tests.test_ardy_to_bvh  # or
  cd tools/rig-pipeline && python -m unittest discover tests
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RIG = os.path.dirname(HERE)  # tools/rig-pipeline
sys.path.insert(0, RIG)

import ardy_to_bvh as conv  # noqa: E402
from ardy_to_bvh import InputError, ProfileError, convert, load_profile, validate_npz  # noqa: E402

FIXTURES = os.path.join(HERE, "fixtures")
GOLDEN_NPZ = os.path.join(FIXTURES, "golden_rest.npz")
GOLDEN_BVH = os.path.join(FIXTURES, "golden_rest.bvh")


def _motion(T: int = 3, batch: bool = True) -> dict:
    if batch:
        local = np.zeros((1, T, 27, 3, 3), dtype=np.float64)
        root = np.zeros((1, T, 3), dtype=np.float64)
    else:
        local = np.zeros((T, 27, 3, 3), dtype=np.float64)
        root = np.zeros((T, 3), dtype=np.float64)
    for t in range(T):
        local[t if not batch else 0, t] = np.eye(3)
    return {"local_rot_mats": local, "root_positions": root, "fps": np.array(20)}


def _tempdir() -> str:
    return tempfile.mkdtemp(prefix="rayure-phase1-")


class TestValidation(unittest.TestCase):
    def setUp(self) -> None:
        self.profile = load_profile("core-skeleton-27.v1")

    def _reject(self, data: dict, fragment: str) -> None:
        with self.assertRaises(InputError) as cm:
            validate_npz(data, self.profile)
        self.assertEqual(cm.exception.code, "INPUT_INVALID")
        self.assertIn(fragment, str(cm.exception))

    def test_missing_joint_field(self):
        data = _motion()
        del data["local_rot_mats"]
        self._reject(data, "local_rot_mats")

    def test_missing_root_field(self):
        data = _motion()
        del data["root_positions"]
        self._reject(data, "root_positions")

    def test_missing_fps_field(self):
        data = _motion()
        del data["fps"]
        self._reject(data, "fps")

    def test_wrong_joint_count(self):
        data = _motion()
        data["local_rot_mats"] = np.zeros((1, 3, 26, 3, 3))
        self._reject(data, "local_rot_mats")

    def test_wrong_rotation_dims(self):
        data = _motion()
        data["local_rot_mats"] = np.zeros((1, 3, 27, 2, 3))
        self._reject(data, "local_rot_mats")

    def test_batch_greater_than_one(self):
        data = _motion()
        data["local_rot_mats"] = np.zeros((2, 3, 27, 3, 3))
        self._reject(data, "batch dim")

    def test_frame_count_mismatch(self):
        data = _motion()
        data["root_positions"] = np.zeros((1, 5, 3))
        self._reject(data, "frame count mismatch")

    def test_zero_frames(self):
        data = _motion(T=0)
        self._reject(data, "zero frames")

    def test_nan_in_local_rotations(self):
        data = _motion()
        data["local_rot_mats"][0, 0, 5, 1, 2] = np.nan
        self._reject(data, "NaN/Inf")

    def test_inf_in_root_positions(self):
        data = _motion()
        data["root_positions"][0, 1, 0] = np.inf
        self._reject(data, "NaN/Inf")

    def test_wrong_fps(self):
        data = _motion()
        data["fps"] = np.array(30)
        self._reject(data, "fps=30.0")

    def test_oversized_input(self):
        # Shrink the cap so the test does not allocate a 65537-frame array
        # (~380 MB); the guard reads the module global at call time.
        with mock.patch.object(conv, "MAX_FRAMES", 5):
            data = _motion(T=6)
            with self.assertRaises(InputError) as cm:
                validate_npz(data, self.profile)
        self.assertEqual(cm.exception.code, "INPUT_INVALID")
        self.assertIn("exceeds cap", str(cm.exception))


class TestDeterminism(unittest.TestCase):
    def test_identical_bvh_bytes_for_identical_input(self):
        tmp = _tempdir()
        try:
            out1 = os.path.join(tmp, "a.bvh")
            out2 = os.path.join(tmp, "b.bvh")
            conv.convert(GOLDEN_NPZ, out1, "core-skeleton-27.v1", None, run_id="det-1")
            conv.convert(GOLDEN_NPZ, out2, "core-skeleton-27.v1", None, run_id="det-2")
            with open(out1, "rb") as fh:
                h1 = hashlib.sha256(fh.read()).hexdigest()
            with open(out2, "rb") as fh:
                h2 = hashlib.sha256(fh.read()).hexdigest()
            self.assertEqual(h1, h2)
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


class TestGolden(unittest.TestCase):
    def test_golden_bvh_matches(self):
        """Converter output on the committed fixture must byte-match the golden snapshot."""
        tmp = _tempdir()
        try:
            out = os.path.join(tmp, "out.bvh")
            conv.convert(GOLDEN_NPZ, out, "core-skeleton-27.v1", None, run_id="golden-check")
            with open(out, "rb") as fh:
                produced = fh.read()
            with open(GOLDEN_BVH, "rb") as fh:
                golden = fh.read()
            self.assertEqual(produced, golden)
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


class TestTruncatedInput(unittest.TestCase):
    def test_truncated_file_rejected(self):
        tmp = _tempdir()
        try:
            junk = os.path.join(tmp, "junk.npz")
            with open(junk, "wb") as fh:
                fh.write(b"this is not a valid zip/npz container at all")
            with self.assertRaises(InputError) as cm:
                conv.convert(junk, os.path.join(tmp, "junk.bvh"), "core-skeleton-27.v1", None)
            self.assertEqual(cm.exception.code, "INPUT_INVALID")
            self.assertFalse(os.path.exists(os.path.join(tmp, "junk.bvh")))
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


class TestProfileMissing(unittest.TestCase):
    def test_missing_profile(self):
        tmp = _tempdir()
        try:
            with self.assertRaises(ProfileError) as cm:
                conv.convert(GOLDEN_NPZ, os.path.join(tmp, "x.bvh"), "does-not-exist.v1", None)
            self.assertEqual(cm.exception.code, "ARDY_REFERENCE_SKELETON_MISSING")
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


class TestFailureReportWritten(unittest.TestCase):
    def test_failure_report_written_on_bad_input(self):
        tmp = _tempdir()
        try:
            report = os.path.join(tmp, "fail.json")
            data = _motion()
            data["fps"] = np.array(30)
            npz_path = os.path.join(tmp, "bad.npz")
            np.savez(npz_path, **data)
            with self.assertRaises(InputError):
                conv.convert(npz_path, os.path.join(tmp, "bad.bvh"), "core-skeleton-27.v1", report)
            with open(report, encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertEqual(doc["schema"], "rayure.rig-pipeline-failure.v1")
            self.assertEqual(doc["code"], "INPUT_INVALID")
            self.assertFalse(doc["fallbackAttempted"])
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


class TestNoForbiddenPaths(unittest.TestCase):
    """Spec Phase 1 acceptance: no target/alias/guess/retarget code in the converter.

    Two complementary checks:
      1. Runtime: every forbidden CLI flag is rejected with exit code 4.
      2. Source: the forbidden concepts may appear ONLY in the guard constant
         and the prose docstring (which says "no retarget code"); no executable
         statement may reference them.
    """

    # Concept tokens that would indicate a target-aware / retarget / axis-guess
    # code path if they appeared in executable source.
    CONCEPT_TOKENS = [
        "--target-model", "--bone-map", "--guess-axis",
        "--scale-to-character", "--fix-feet",
        "guess_bone", "infer_axis", "bone_map", "alias", "retarget",
    ]

    def _executable_source(self) -> str:
        """Module source minus the docstring, comments, and the guard constant."""
        with open(os.path.join(RIG, "ardy_to_bvh.py"), encoding="utf-8") as fh:
            lines = fh.read().splitlines()

        in_doc = False
        in_constant = False
        kept = []
        for ln in lines:
            stripped = ln.lstrip()
            if stripped.startswith('"""'):
                in_doc = not in_doc
                continue
            if in_doc or stripped.startswith("#") or not stripped:
                continue
            # Skip the FORBIDDEN_CLI_FLAGS literal block (it legitimately lists
            # the flag strings); anything else must not mention them.
            if stripped.startswith("FORBIDDEN_CLI_FLAGS = ["):
                in_constant = True
                continue
            if in_constant:
                if stripped == "]":
                    in_constant = False
                continue
            kept.append(ln)
        return "\n".join(kept)

    def test_forbidden_flags_rejected_with_exit_4(self):
        tmp = _tempdir()
        try:
            base = ["--input", GOLDEN_NPZ, "--output", os.path.join(tmp, "o.bvh"),
                    "--profile", "core-skeleton-27.v1"]
            for flag in conv.FORBIDDEN_CLI_FLAGS:
                for bad_arg in (flag, flag + "=some_model"):
                    code = conv.main(base + [bad_arg, "whatever"])
                    self.assertEqual(code, 4, f"flag {bad_arg!r} must exit 4, got {code}")
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    def test_concept_tokens_absent_from_executable_source(self):
        source = self._executable_source()
        for token in self.CONCEPT_TOKENS:
            self.assertNotIn(token, source, f"forbidden concept present in executable source: {token}")

    def test_profile_forbidden_cli_list_is_nonempty(self):
        profile = load_profile("core-skeleton-27.v1")
        self.assertGreaterEqual(len(profile.get("forbiddenCli", [])), 5)


class TestCLI(unittest.TestCase):
    def test_invalid_input_exit_code(self):
        tmp = _tempdir()
        try:
            data = _motion()
            data["fps"] = np.array(30)
            npz_path = os.path.join(tmp, "bad.npz")
            np.savez(npz_path, **data)
            code = conv.main(["--input", npz_path, "--output", os.path.join(tmp, "o.bvh"),
                              "--profile", "core-skeleton-27.v1", "--report", os.path.join(tmp, "r.json")])
            self.assertEqual(code, 2)
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    def test_success_exit_code(self):
        tmp = _tempdir()
        try:
            code = conv.main(["--input", GOLDEN_NPZ, "--output", os.path.join(tmp, "o.bvh"),
                              "--profile", "core-skeleton-27.v1"])
            self.assertEqual(code, 0)
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
