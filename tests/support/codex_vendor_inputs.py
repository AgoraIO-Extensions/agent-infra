"""Exercise file reconstruction and real git patch application without compiling."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

VENDOR = Path("deploy/runtime/vendor/codex").resolve()
sys.path.insert(0, str(VENDOR))
from vendor_inputs import CORPUS_PATCH, FORMAT, MAX_INPUT_BYTES, MAX_PART_BYTES, corpus_patch_bytes, read_input, sha256

spec = importlib.util.spec_from_file_location("candidate", VENDOR / "build-linux-aarch64.py")
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


def fragment(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    folder = path.with_name(path.name + ".parts")
    folder.mkdir()
    cut = max(1, len(raw) // 2)
    parts = []
    for position, chunk in enumerate((raw[:cut], raw[cut:])):
        if not chunk:
            continue
        name = f"{position + 1:04d}.part"
        (folder / name).write_bytes(chunk)
        parts.append({"path": f"{folder.name}/{name}", "byteLength": len(chunk),
                      "sha256": sha256(chunk)})
    manifest = {"format": FORMAT, "byteLength": len(raw), "sha256": sha256(raw), "parts": parts}
    index = path.with_name(path.name + ".parts.json")
    index.write_text(json.dumps(manifest))
    return index, manifest


class VendorInputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "input"
        self.raw = b"first section\r\nsecond section\n"
        self.index, self.manifest = fragment(self.path, self.raw)

    def write_manifest(self):
        self.index.write_text(json.dumps(self.manifest))

    def test_original_file_takes_precedence_and_preserves_bytes(self):
        self.path.write_bytes(self.raw)
        self.index.write_text("not JSON")
        self.assertEqual(read_input(self.path), self.raw)

    def test_ordered_fragments_preserve_crlf(self):
        self.assertEqual(read_input(self.path), self.raw)

    def test_missing_part_is_rejected(self):
        (self.root / self.manifest["parts"][0]["path"]).unlink()
        with self.assertRaises(RuntimeError):
            read_input(self.path)

    def test_reordered_parts_are_rejected(self):
        self.manifest["parts"].reverse()
        self.write_manifest()
        with self.assertRaisesRegex(RuntimeError, "Reassembled"):
            read_input(self.path)

    def test_same_size_corruption_is_rejected(self):
        part = self.root / self.manifest["parts"][0]["path"]
        raw = part.read_bytes()
        part.write_bytes(b"!" + raw[1:])
        with self.assertRaises(RuntimeError):
            read_input(self.path)

    def test_missing_last_part_is_rejected(self):
        self.manifest["parts"].pop()
        self.write_manifest()
        with self.assertRaisesRegex(RuntimeError, "Reassembled"):
            read_input(self.path)

    def test_duplicate_part_is_rejected(self):
        self.manifest["parts"][1] = dict(self.manifest["parts"][0])
        self.write_manifest()
        with self.assertRaisesRegex(RuntimeError, "Duplicate"):
            read_input(self.path)

    def test_paths_cannot_escape_or_use_noncanonical_forms(self):
        original = self.manifest["parts"][0]["path"]
        for name in ("../outside", "/etc/passwd", "a/../../outside", "./input", "a//b",
                     "a\\b", "C:/outside", "a\x00b", "a/./b", "a/../b", ""):
            with self.subTest(name=name):
                self.manifest["parts"][0]["path"] = name
                self.write_manifest()
                with self.assertRaises(RuntimeError):
                    read_input(self.path)
        self.manifest["parts"][0]["path"] = original

    def test_symlink_parts_and_parent_directories_are_rejected(self):
        folder = self.root / "input.parts"
        folder.rename(self.root / "real-parts")
        folder.symlink_to(self.root / "real-parts", target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "Symlink"):
            read_input(self.path)
        folder.unlink()
        (self.root / "real-parts").rename(folder)
        part = self.root / self.manifest["parts"][0]["path"]
        raw = part.read_bytes()
        part.unlink()
        outside = self.root / "outside"
        outside.write_bytes(raw)
        part.symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError, "Symlink"):
            read_input(self.path)

    def test_original_and_index_must_be_regular_files(self):
        self.path.symlink_to(self.root / "missing")
        with self.assertRaises(RuntimeError):
            read_input(self.path)
        self.path.unlink()
        self.path.mkdir()
        with self.assertRaises(RuntimeError):
            read_input(self.path)
        self.path.rmdir()
        self.index.rename(self.root / "real-index")
        self.index.symlink_to(self.root / "real-index")
        with self.assertRaises(RuntimeError):
            read_input(self.path)

    def test_invalid_metadata_is_rejected(self):
        original = json.loads(json.dumps(self.manifest))
        changes = [("format", "unknown"), ("byteLength", True), ("byteLength", 0),
                   ("byteLength", 1.5), ("byteLength", MAX_INPUT_BYTES + 1),
                   ("sha256", "f" * 64), ("parts", []), ("parts", "not a list"),
                   ("extra", "unexpected")]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                self.manifest = dict(original)
                self.manifest[key] = value
                self.write_manifest()
                with self.assertRaises(RuntimeError):
                    read_input(self.path)
        self.manifest = original
        self.manifest["parts"][0]["byteLength"] = MAX_PART_BYTES + 1
        self.write_manifest()
        with self.assertRaises(RuntimeError):
            read_input(self.path)

    def test_duplicate_json_keys_and_invalid_json_are_rejected(self):
        for raw in ('{"format":"ignored",' + json.dumps(self.manifest)[1:], "[]", "null", "{", "\ufffd"):
            self.index.write_text(raw)
            with self.assertRaises(RuntimeError):
                read_input(self.path)

    def test_manifest_and_part_size_limits_are_enforced(self):
        self.index.write_bytes(b" " * (MAX_PART_BYTES + 1))
        with self.assertRaises(RuntimeError):
            read_input(self.path)
        self.write_manifest()
        part = self.root / self.manifest["parts"][0]["path"]
        part.write_bytes(part.read_bytes() + b"extra")
        with self.assertRaises(RuntimeError):
            read_input(self.path)

    def test_callback_loader_uses_node24_without_a_shell(self):
        path = self.root / "callback-v2-corpus.json"
        loader = self.root / "callback-corpus.mjs"
        loader.write_text("// fixture")
        with patch("vendor_inputs.subprocess.check_output", side_effect=[b"v24.19.0\n", self.raw]) as run:
            self.assertEqual(read_input(path), self.raw)
        self.assertEqual(run.call_args_list[0].args[0], ["node", "--version"])
        self.assertEqual(run.call_args_list[1].args[0], ["node", str(loader.resolve())])
        self.assertNotIn("shell", run.call_args_list[1].kwargs)

    def test_callback_loader_failure_and_wrong_node_version_are_rejected(self):
        path = self.root / "callback-v2-corpus.json"
        with self.assertRaisesRegex(RuntimeError, "Missing callback"):
            read_input(path)
        (self.root / "callback-corpus.mjs").write_text("// fixture")
        for result in (b"v26.0.0\n", b"not node"):
            with patch("vendor_inputs.subprocess.check_output", return_value=result) as run:
                with self.assertRaisesRegex(RuntimeError, "Node.js 24"):
                    read_input(path)
                self.assertEqual(run.call_count, 1)
        for error in (FileNotFoundError(), subprocess.CalledProcessError(1, "node"),
                      subprocess.TimeoutExpired("node", 30)):
            with patch("vendor_inputs.subprocess.check_output", side_effect=error):
                with self.assertRaisesRegex(RuntimeError, "Node.js 24"):
                    read_input(path)

    def test_checked_in_inputs_match_frozen_candidate_hashes(self):
        raw = read_input(VENDOR / "build-input-v1.json")
        self.assertEqual(sha256(raw), "sha256:3b5111408f510b493a6023f8b42461a887a46fb404d65124881eb160ee25c281")
        manifest = json.loads(raw)
        for entry in manifest["patches"]:
            self.assertEqual(sha256(read_input(VENDOR / entry["path"])), entry["sha256"])
        for name, expected in manifest["callbackInputs"].items():
            self.assertEqual(sha256(read_input(VENDOR / name)), expected)
        self.assertEqual(sha256(read_input(VENDOR / manifest["dependencyUpdate"]["licenseFile"])),
                         manifest["dependencyUpdate"]["licenseSha256"])
        for index in VENDOR.rglob("*.parts.json"):
            value = json.loads(index.read_bytes())
            original = index.with_name(index.name.removesuffix(".parts.json"))
            self.assertEqual(len(read_input(original)), value["byteLength"])
            for part in value["parts"]:
                if "generated" not in part:
                    self.assertLessEqual(part["byteLength"], MAX_PART_BYTES)

    def generated_fixture(self):
        vendor = self.root / "vendor"
        (vendor / "patches").mkdir(parents=True)
        corpus = b'{"unicode":"\xe4\xb8\xad","items":[]}\n'
        (vendor / "callback-v2-corpus.json").write_bytes(corpus)
        path = vendor / "patches" / "0003-protected-connection-client.patch"
        raw = corpus_patch_bytes(path)
        part = {"generated": CORPUS_PATCH, "byteLength": len(raw), "sha256": sha256(raw)}
        manifest = {"format": FORMAT, "byteLength": len(raw), "sha256": sha256(raw), "parts": [part]}
        index = path.with_name(path.name + ".parts.json")
        index.write_text(json.dumps(manifest))
        return path, index, manifest, corpus

    def test_generated_corpus_hunk_applies_as_original_file(self):
        path, _, _, corpus = self.generated_fixture()
        checkout = self.root / "checkout"
        checkout.mkdir()
        subprocess.run(["git", "init", "--quiet", str(checkout)], check=True)
        result = subprocess.run(["git", "apply", "-"], cwd=checkout,
                                input=read_input(path), capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        target = checkout / "codex-rs/rmcp-client/src/native_connection/callback-v2-corpus.json"
        self.assertEqual(target.read_bytes(), corpus)

    def test_generated_part_rejects_unknown_kind_extra_fields_and_duplicates(self):
        path, index, original, _ = self.generated_fixture()
        for change in ("unknown", "command", "duplicate"):
            manifest = json.loads(json.dumps(original))
            if change == "unknown":
                manifest["parts"][0]["generated"] = "run-command"
            elif change == "command":
                manifest["parts"][0]["command"] = "echo untrusted"
            else:
                manifest["parts"] *= 2
                manifest["byteLength"] *= 2
            index.write_text(json.dumps(manifest))
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                read_input(path)

    def test_generated_part_rejects_wrong_location_and_corrupted_corpus(self):
        path, index, manifest, _ = self.generated_fixture()
        wrong = path.with_name("other.patch")
        wrong.with_name(wrong.name + ".parts.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, "location"):
            read_input(wrong)
        (path.parent.parent / "callback-v2-corpus.json").write_bytes(b'{"different":true}\n')
        with self.assertRaisesRegex(RuntimeError, "metadata"):
            read_input(path)
        manifest["parts"][0]["sha256"] = "sha256:" + "0" * 64
        index.write_text(json.dumps(manifest))
        with self.assertRaises(RuntimeError):
            read_input(path)

    def test_candidate_contains_original_license_files_only(self):
        destination = self.root / "legal"
        candidate.copy_licenses(VENDOR, destination)
        self.assertEqual(sorted(p.name for p in destination.iterdir()), sorted(candidate.LICENSE_FILES))
        for path in destination.iterdir():
            self.assertEqual(path.read_bytes(), read_input(VENDOR / "licenses" / path.name))
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)

    def test_sequential_fragmented_patches_apply_to_real_git_checkout(self):
        source = self.root / "source"
        source.mkdir()
        env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        def git(*args):
            return subprocess.check_output(["git", *args], cwd=source, env=env,
                                           stderr=subprocess.DEVNULL).decode().strip()
        git("init")
        git("config", "user.name", "Vendor test")
        git("config", "user.email", "vendor@example.invalid")
        (source / "file.txt").write_bytes(b"before\n")
        git("add", ".")
        git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture")
        head = git("rev-parse", "HEAD")
        vendor = self.root / "vendor"
        vendor.mkdir()
        for name in ("apply-source.py", "vendor_inputs.py"):
            shutil.copy2(VENDOR / name, vendor / name)
        patches = []
        for number, before, after in ((1, "before", "middle"), (2, "middle", "after")):
            raw = (f"diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n"
                   f"@@ -1 +1 @@\n-{before}\n+{after}\n").encode()
            name = f"patches/{number}.patch"
            fragment(vendor / name, raw)
            patches.append({"path": name, "sha256": sha256(raw)})
        manifest = {"upstream": {"commit": head}, "patches": patches,
                    "sourceFiles": [{"path": "file.txt", "sha256": sha256(b"after\n")}]}
        fragment(vendor / "build-input-v1.json", json.dumps(manifest).encode())
        command = [sys.executable, "-B", str(vendor / "apply-source.py"), "--source-checkout", str(source)]
        result = subprocess.run(command, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((source / "file.txt").read_bytes(), b"after\n")
        result = subprocess.run([*command, "--verify-existing"], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        (source / "untracked.txt").write_text("dirty\n")
        result = subprocess.run([*command, "--verify-existing"], env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Untracked files", result.stderr)
        self.assertEqual(git("rev-parse", "HEAD"), head)


if __name__ == "__main__":
    unittest.main()
