"""Exercise builder provenance and archive modes using only synthetic files."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

VENDOR = Path(__file__).resolve().parents[2] / "deploy/runtime/vendor/codex"
spec = importlib.util.spec_from_file_location("candidate_builder", VENDOR / "build-linux-aarch64.py")
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class BuilderTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="codex-builder-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        # The Linux-runner constructor is irrelevant to these two methods. All
        # paths still point into this test's private temporary directory.
        self.builder = candidate.Builder.__new__(candidate.Builder)
        for name in ("repo", "source", "output", "target", "v8"):
            value = self.root / name
            value.mkdir()
            setattr(self.builder, name, value)
        b = self.builder
        b.vendor = b.repo / "deploy/runtime/vendor/codex"
        b.vendor.mkdir(parents=True)
        b.diag = b.output / "diagnostics"
        b.diag.mkdir()
        b.candidate = b.output / "candidate"
        b.head = "1" * 40
        b.guard = Mock()
        b.inputs = Mock(return_value={"synthetic-input": "sha256:synthetic"})
        b.run = Mock(side_effect=self.fake_run)
        self.start_patch(patch.dict(os.environ, {
            "CARGO_BUILD_JOBS": "2", "CARGO_INCREMENTAL": "0",
            "RUSTY_V8_ARCHIVE": str(b.v8 / "archive"),
            "RUSTY_V8_SRC_BINDING_PATH": str(b.v8 / "binding"),
            "CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER": "synthetic-linker",
            "GITHUB_RUN_ID": "synthetic-run", "GITHUB_RUN_ATTEMPT": "1",
        }, clear=True))
        # Any unmocked process launch fails immediately, even if new production
        # code starts bypassing Builder.run/capture in the future.
        for method in ("Popen", "run", "check_call", "check_output", "call"):
            self.start_patch(patch.object(candidate.subprocess, method,
                                          side_effect=AssertionError("external tool forbidden")))
        self.start_patch(patch.object(candidate, "capture", side_effect=self.fake_capture))
        self.start_patch(patch.object(candidate, "native_source_tree", return_value="2" * 40))
        v8 = {}
        for name in ("archive", "binding", "checksums"):
            self.write(b.v8 / name, b"synthetic V8 input")
            v8[name] = candidate.digest(b.v8 / name).removeprefix("sha256:")
        self.start_patch(patch.object(candidate, "V8_FILES", v8))
        release = b.target / candidate.TARGET / "release"
        header = bytearray(64)
        header[:6] = b"\x7fELF\x02\x01"
        header[16:18] = (2).to_bytes(2, "little")
        header[18:20] = (183).to_bytes(2, "little")
        for name in candidate.BINARIES:
            self.write(release / name, bytes(header))
            (release / name).chmod(0o755)
        self.write(b.source / "codex-rs/Cargo.lock", b"synthetic lock")
        self.write(b.vendor / "native-barrier-v1.json", b'{"synthetic": true}')
        for name in ("UPSTREAM-LICENSE", "UPSTREAM-NOTICE", "JCS-NOTICE"):
            self.write(b.vendor / name, b"synthetic license")
        for name in candidate.LICENSE_FILES:
            self.write(b.vendor / "licenses" / name, b"synthetic license")
        for name in ("build-linux-aarch64.sh", "build-linux-aarch64.py",
                     "apply-source.py", "vendor_inputs.py"):
            self.write(b.vendor / name, b"synthetic builder provenance")
        for name in ("install-trivy.mjs", "vulnerability-policy.mjs"):
            self.write(b.repo / ".github/scripts" / name, b"synthetic scanner provenance")
        self.write(b.diag / "runner.json", b'{"synthetic": true}')

    def start_patch(self, patcher):
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    @staticmethod
    def write(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def fake_capture(self, command, _cwd):
        outputs = {
            ("rustc", "--version", "--verbose"): f"rustc {candidate.RUST_VERSION} synthetic",
            ("cargo", "--version"): "synthetic cargo",
            ("zig", "version"): "0.14.0",
            ("strip", "--version"): "synthetic strip",
            ("synthetic-linker", "--version"): "synthetic linker",
        }
        self.assertIn(tuple(command), outputs, "unexpected tool request")
        return outputs[tuple(command)]

    def fake_run(self, name, _command, **_kwargs):
        b = self.builder
        if name in {"build-bwrap", "build-codex", *(f"strip-{n}" for n in candidate.BINARIES)}:
            return  # Synthetic ELF headers are pre-created; never executable code.
        if name == "native-version":
            self.write(b.diag / "native-version.log", b"codex-cli 0.153.0\n")
        elif name == "native-probe":
            self.write(b.diag / "native-probe.log", b'{"synthetic": true}')
        elif name == "install-scanner":
            self.write(b.target.parent / "codex-native-trivy/installation.json", b'{"synthetic": true}')
        elif name == "source-sbom":
            self.write(b.candidate / "source.cdx.json",
                       b'{"bomFormat":"CycloneDX","components":[{"name":"synthetic"}]}')
        else:
            self.fail(f"unexpected external stage: {name}")

    def test_build_records_two_jobs(self):
        self.builder.build()
        record = json.loads((self.builder.diag / "build.json").read_text())
        self.assertEqual(record["jobs"], 2)

    def test_build_records_three_jobs(self):
        os.environ["CARGO_BUILD_JOBS"] = "3"
        self.builder.build()
        record = json.loads((self.builder.diag / "build.json").read_text())
        self.assertEqual(record["jobs"], 3)

    def test_build_rejects_invalid_resources_before_any_stage(self):
        for jobs, incremental in ((None, "0"), ("1", "0"), ("4", "0"),
                                  ("02", "0"), ("3 ", "0"), ("2", "1")):
            with self.subTest(jobs=jobs, incremental=incremental):
                if jobs is None:
                    os.environ.pop("CARGO_BUILD_JOBS", None)
                else:
                    os.environ["CARGO_BUILD_JOBS"] = jobs
                os.environ["CARGO_INCREMENTAL"] = incremental
                with self.assertRaisesRegex(RuntimeError, "Unexpected Cargo resource settings"):
                    self.builder.build()
                self.builder.run.assert_not_called()
                self.assertFalse((self.builder.diag / "build.json").exists())

    def test_seal_normalizes_all_member_modes_with_restrictive_umask(self):
        previous = os.umask(0o077)
        try:
            self.builder.build()
            b = self.builder
            # Binary owner-execute is required by verify_bundle, but other bits
            # and ordinary file execute bits must not survive into the archive.
            for relative in candidate.BINARIES.values():
                (b.candidate / "bundle" / relative).chmod(0o700)
            (b.candidate / "legal/UPSTREAM-LICENSE").chmod(0o755)
            contents = {str(p.relative_to(b.candidate)): p.read_bytes()
                        for p in b.candidate.rglob("*") if p.is_file()}
            modes = {name: stat.S_IMODE((b.candidate / name).stat().st_mode)
                     for name in contents}
            b.seal()
        finally:
            os.umask(previous)
        binary_paths = {"bundle/" + path for path in candidate.BINARIES.values()}
        with tarfile.open(b.output / "artifact/codex-candidate.tar.gz", "r:gz") as archive:
            members = archive.getmembers()
            self.assertEqual(len(members), len({member.name for member in members}))
            self.assertEqual({member.name for member in members},
                             set(contents) | {"candidate.json", "source.cdx.json",
                                              "builder-environment.json"})
            for member in members:
                self.assertTrue(member.isfile())
                self.assertEqual(stat.S_IMODE(member.mode),
                                 0o755 if member.name in binary_paths else 0o644, member.name)
                if member.name in contents:
                    self.assertEqual(archive.extractfile(member).read(), contents[member.name])
        for name, data in contents.items():
            self.assertEqual((b.candidate / name).read_bytes(), data)
            self.assertEqual(stat.S_IMODE((b.candidate / name).stat().st_mode), modes[name], name)


if __name__ == "__main__":
    unittest.main()
