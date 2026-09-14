#!/usr/bin/env python3
"""Build one frozen WIP candidate; never install it or change a release pin."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time

UPSTREAM = "41e22fee981a63b3698df7ed36bad393cda24715"
TARGET = "aarch64-unknown-linux-musl"
MIN_FREE = 2 * 1024**3
MAX_LOG = 16 * 1024**2
BINARIES = {
    "codex": "bin/codex",
    "codex-code-mode-host": "codex-resources/codex-code-mode-host",
    "codex-responses-api-proxy": "bin/codex-responses-api-proxy",
    "bwrap": "codex-resources/bwrap",
}
V8_FILES = {
    f"librusty_v8_ptrcomp_sandbox_release_{TARGET}.a.gz":
        "d258efd9c17b67077013f110302ff148fd11428cc4804fcb5c9ad05e3e634cb4",
    f"src_binding_ptrcomp_sandbox_release_{TARGET}.rs":
        "7727826ae479bdb645e807239fb12d1f8e2e23de7a6cf16f5ee592690d1d8506",
    f"rusty_v8_ptrcomp_sandbox_release_{TARGET}.sha256":
        "9c40a51e4d5fcedaec527757b8660115b2a10ca3e2ddacadc3075924ad005b66",
}
UPSTREAM_TOOLS = (
    ".github/scripts/install-musl-build-tools.sh",
    ".github/actions/setup-rusty-v8/action.yml",
    ".github/scripts/rusty_v8_bazel.py",
    "codex-rs/rust-toolchain.toml",
)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    require(path.is_file() and not path.is_symlink(), "Missing regular input file")
    with path.open("rb") as stream:
        return "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def capture(command, cwd):
    return subprocess.check_output(command, cwd=cwd, timeout=30).decode().strip()


def relative_file(root, name):
    path = Path(name)
    require(not path.is_absolute() and ".." not in path.parts, "Unsafe input path")
    target = root / path
    require(target.resolve().is_relative_to(root.resolve()), "Input escapes root")
    return target


def verify_head(repo, expected):
    require(re.fullmatch(r"[a-f0-9]{40}", expected), "Invalid PR head")
    require(capture(["git", "rev-parse", "HEAD"], repo) == expected, "PR head mismatch")
    require(not capture(["git", "status", "--porcelain", "--untracked-files=all"], repo),
            "PR checkout is not clean")


def verify_inputs(vendor, source):
    manifest = json.loads((vendor / "build-input-v1.json").read_text())
    require(manifest["upstream"]["commit"] == UPSTREAM, "Unexpected manifest upstream")
    require(capture(["git", "rev-parse", "HEAD"], source) == UPSTREAM,
            "Native source head mismatch")
    hashes = {"build-input-v1.json": digest(vendor / "build-input-v1.json")}
    for entry in manifest["patches"]:
        actual = digest(relative_file(vendor, entry["path"]))
        require(actual == entry["sha256"], "Patch digest mismatch")
        hashes[entry["path"]] = actual
    for name, expected in manifest["callbackInputs"].items():
        actual = digest(relative_file(vendor, name))
        require(actual == expected, "Callback input digest mismatch")
        hashes[name] = actual
    for entry in manifest["sourceFiles"]:
        require(digest(relative_file(source, entry["path"])) == entry["sha256"],
                "Native source digest mismatch")
    for name, key in (("codex-rs/Cargo.lock", "cargoSha256"),
                      ("MODULE.bazel.lock", "bazelSha256")):
        hashes[name] = digest(source / name)
        require(hashes[name] == manifest["currentLocks"][key], "Lock digest mismatch")
    changed = set(capture(["git", "diff", "--name-only", "HEAD"], source).splitlines())
    changed.update(capture(["git", "ls-files", "--others", "--exclude-standard"], source).splitlines())
    require(changed <= {entry["path"] for entry in manifest["sourceFiles"]},
            "Unrecorded native source change")
    for name in UPSTREAM_TOOLS:
        original = subprocess.check_output(["git", "show", f"{UPSTREAM}:{name}"], cwd=source)
        require((source / name).read_bytes() == original, "Upstream build tool changed")
        hashes[name] = digest(source / name)
    return hashes


def check_elf(path):
    require(path.is_file() and not path.is_symlink(), "Missing native binary/helper")
    require(path.stat().st_mode & stat.S_IXUSR, "Native binary is not executable")
    with path.open("rb") as stream:
        header = stream.read(64)
    require(len(header) == 64 and header[:6] == b"\x7fELF\x02\x01"
            and int.from_bytes(header[16:18], "little") in (2, 3)
            and int.from_bytes(header[18:20], "little") == 183,
            "Native binary is not ELF64 Linux aarch64")


def verify_bundle(bundle, expected_bwrap, expected_hashes=None):
    hashes = {}
    for name, relative in BINARIES.items():
        path = bundle / relative
        check_elf(path)
        hashes[name] = digest(path)
    require(hashes["bwrap"] == expected_bwrap, "Final bwrap digest mismatch")
    if expected_hashes is not None:
        require(hashes == expected_hashes, "Candidate binary digest mismatch")
    return hashes


def write_github_env(path, values):
    for name, value in values.items():
        require(re.fullmatch(r"[A-Z][A-Z0-9_]*", name)
                and not any(c in str(value) for c in "\r\n\x00"), "Invalid environment output")
    with path.open("a") as stream:
        for name, value in values.items():
            stream.write(f"{name}={value}\n")


class Builder:
    def __init__(self):
        self.vendor = Path(__file__).resolve().parent
        self.repo = self.vendor.parents[3]
        self.source = Path(os.environ["CANDIDATE_SOURCE"]).resolve()
        self.output = Path(os.environ["CANDIDATE_OUTPUT"]).resolve()
        self.target = Path(os.environ["CARGO_TARGET_DIR"]).resolve()
        self.v8 = Path(os.environ["CANDIDATE_V8_DIR"]).resolve()
        self.head = os.environ["CANDIDATE_HEAD"]
        require(os.environ.get("TARGET") == TARGET, "Unexpected target")
        require(platform.system() == "Linux" and platform.machine() in ("aarch64", "arm64"),
                "A native Linux aarch64 runner is required")
        temp = Path(os.environ["RUNNER_TEMP"]).resolve()
        for path in (self.output, self.target, self.v8):
            require(path != temp and path.is_relative_to(temp), "Build output must be task-owned runner temp")
        require(len({self.output, self.target, self.v8}) == 3, "Build directories overlap")
        for path in (self.output, self.target, self.v8):
            require(not any(path != other and path.is_relative_to(other)
                            for other in (self.output, self.target, self.v8)), "Build directories overlap")
        for path in (self.output, self.target, self.v8):
            path.mkdir(parents=True, exist_ok=True)
        self.diag = self.output / "diagnostics"
        self.diag.mkdir(exist_ok=True)
        self.candidate = self.output / "candidate"
        self.phase = sys.argv[1]

    def resources(self):
        return {"time": time.time(), "phase": self.phase,
                "freeBytes": min(shutil.disk_usage(path).free
                                 for path in (self.source, self.target, self.output))}

    def guard(self, required_bytes=0):
        snapshot = self.resources()
        with (self.diag / "resources.jsonl").open("a") as stream:
            stream.write(json.dumps(snapshot) + "\n")
        require(snapshot["freeBytes"] >= MIN_FREE + required_bytes,
                "Stopped at 2 GiB free-disk guard")

    def run(self, name, command, cwd=None, env=None):
        self.guard()
        print(f"Candidate stage: {name}", flush=True)
        log = self.diag / f"{name}.log"
        with log.open("wb") as stream:
            process = subprocess.Popen(
                ["/usr/bin/time", "-v", "-o", str(self.diag / f"{name}.time"), *command],
                cwd=cwd or self.source / "codex-rs", env=env,
                stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                while process.poll() is None:
                    self.guard()
                    require(log.stat().st_size <= MAX_LOG, "Build diagnostic size limit exceeded")
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        pass
                require(process.returncode == 0, f"Stage {name} failed with exit {process.returncode}")
                require(log.stat().st_size <= MAX_LOG, "Build diagnostic size limit exceeded")
                self.guard()
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                if log.stat().st_size > MAX_LOG:
                    with log.open("r+b") as capped:
                        capped.truncate(MAX_LOG)

    def inputs(self):
        verify_head(self.repo, self.head)
        return verify_inputs(self.vendor, self.source)

    def prepare(self):
        verify_head(self.repo, self.head)
        require(not self.candidate.exists(), "Candidate output already exists")
        require(not any(self.target.iterdir()) and not any(self.v8.iterdir()),
                "Candidate target and V8 directories must start empty")
        self.run("apply-source", [sys.executable, str(self.vendor / "apply-source.py"),
                 "--source-checkout", str(self.source)], cwd=self.repo)
        inputs = self.inputs()
        save(self.diag / "inputs.json", {"head": self.head, "upstream": UPSTREAM, "sha256": inputs})
        save(self.diag / "runner.json", {
            "system": platform.system(), "machine": platform.machine(),
            "kernel": platform.release(), "cpuCount": os.cpu_count(),
            "memory": Path("/proc/meminfo").read_text().splitlines()[:3],
            "imageVersion": os.environ.get("ImageVersion"),
            "runId": os.environ.get("GITHUB_RUN_ID"), "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
            "minimumFreeBytes": MIN_FREE, "nativeAcceptance": False})

    def musl(self):
        self.inputs()
        self.run("musl", ["bash", str(self.source / UPSTREAM_TOOLS[0])])

    def setup_v8(self):
        self.inputs()
        version = capture([sys.executable, str(self.source / UPSTREAM_TOOLS[2]),
                           "resolved-v8-crate-version"], self.source)
        require(version == "150.4.0", "Unexpected V8 crate version")
        for index, (name, expected) in enumerate(V8_FILES.items()):
            path = self.v8 / name
            self.run(f"v8-{index}", ["curl", "--fail", "--location", "--proto", "=https",
                     "--tlsv1.2", "--silent", "--show-error", "--max-time", "180", "--retry", "2",
                     f"https://github.com/openai/codex/releases/download/rusty-v8-v{version}/{name}",
                     "--output", str(path)])
            require(digest(path) == "sha256:" + expected, "V8 input checksum mismatch")
        records = (self.v8 / list(V8_FILES)[2]).read_text().splitlines()
        expected_records = {f"{sha}  {name}" for name, sha in list(V8_FILES.items())[:2]}
        require(set(records) == expected_records and len(records) == 2, "V8 checksum manifest mismatch")
        write_github_env(Path(os.environ["GITHUB_ENV"]), {
            "RUSTY_V8_ARCHIVE": str(self.v8 / list(V8_FILES)[0]),
            "RUSTY_V8_SRC_BINDING_PATH": str(self.v8 / list(V8_FILES)[1]),
        })

    def build(self):
        inputs = self.inputs()
        require(os.environ.get("CARGO_BUILD_JOBS") == "2"
                and os.environ.get("CARGO_INCREMENTAL") == "0", "Unexpected Cargo resource settings")
        for name, expected in V8_FILES.items():
            require(digest(self.v8 / name) == "sha256:" + expected, "V8 input changed")
        require(os.environ.get("RUSTY_V8_ARCHIVE") == str(self.v8 / list(V8_FILES)[0])
                and os.environ.get("RUSTY_V8_SRC_BINDING_PATH") == str(self.v8 / list(V8_FILES)[1]),
                "V8 environment was not applied in a subsequent step")
        tools = {name: capture(command, self.source) for name, command in {
            "rustc": ["rustc", "--version", "--verbose"], "cargo": ["cargo", "--version"],
            "zig": ["zig", "version"], "strip": ["strip", "--version"],
            "linker": [os.environ["CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER"], "--version"],
        }.items()}
        require(tools["rustc"].startswith("rustc 1.95.0 ") and tools["zig"] == "0.14.0",
                "Build tool version mismatch")
        save(self.diag / "tools.json", tools)
        command = ["cargo", "build", "--locked", "--target", TARGET, "--release", "--timings"]
        self.run("build-bwrap", [*command, "--bin", "bwrap"])
        release = self.target / TARGET / "release"
        bwrap = release / "bwrap"
        check_elf(bwrap)
        self.run("strip-bwrap", ["strip", "--strip-debug", "--strip-unneeded", str(bwrap)])
        bwrap_sha = digest(bwrap)
        env = os.environ.copy()
        env["CODEX_BWRAP_SHA256"] = bwrap_sha.removeprefix("sha256:")
        self.run("build-codex", [*command, "--bin", "codex", "--bin", "codex-code-mode-host",
                 "--bin", "codex-responses-api-proxy"], env=env)
        require(digest(bwrap) == bwrap_sha, "bwrap changed after Codex digest binding")
        for name in BINARIES:
            check_elf(release / name)
            if name != "bwrap":
                self.run(f"strip-{name}", ["strip", "--strip-debug", "--strip-unneeded", str(release / name)])
        require(self.inputs() == inputs, "Source changed during build")
        bundle = self.candidate / "bundle"
        for name, relative in BINARIES.items():
            destination = bundle / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            self.guard((release / name).stat().st_size)
            shutil.copy2(release / name, destination)
        save(bundle / "codex-package.json", {"version": "0.153.0", "target": TARGET, "variant": "codex"})
        hashes = verify_bundle(bundle, bwrap_sha)
        self.run("native-version", [str(bundle / "bin/codex"), "--version"])
        require((self.diag / "native-version.log").read_text().strip() == "codex-cli 0.153.0",
                "Candidate CLI version mismatch")
        self.run("native-probe", [str(bundle / "bin/codex"), "--agent-infra-native-barrier-info"])
        require(json.loads((self.diag / "native-probe.log").read_text())
                == json.loads((self.vendor / "native-barrier-v1.json").read_text()),
                "Candidate native probe mismatch")
        legal = self.candidate / "legal"
        legal.mkdir()
        for name in ("UPSTREAM-LICENSE", "UPSTREAM-NOTICE", "JCS-NOTICE"):
            shutil.copy2(self.vendor / name, legal / name)
        shutil.copytree(self.vendor / "licenses", legal / "licenses")
        shutil.copy2(self.source / "codex-rs/Cargo.lock", self.candidate / "Cargo.lock")
        for path in (self.target / "cargo-timings").glob("*.html"):
            if path.stat().st_size <= MAX_LOG:
                shutil.copy2(path, self.diag / path.name)
        save(self.diag / "build.json", {
            "head": self.head, "upstream": UPSTREAM, "target": TARGET, "profile": "release",
            "jobs": 2, "incremental": False, "inputSha256": inputs, "tools": tools,
            "commands": [command + ["--bin", "bwrap"], command + ["--bin", "codex", "--bin",
                         "codex-code-mode-host", "--bin", "codex-responses-api-proxy"]],
            "bwrapSha256": bwrap_sha, "binaries": hashes, "nativeAcceptance": False,
            "prebuiltV8Sha256": {name: digest(self.v8 / name) for name in V8_FILES},
            "nativeProbe": json.loads((self.diag / "native-probe.log").read_text())})

    def seal(self):
        inputs = self.inputs()
        record = json.loads((self.diag / "build.json").read_text())
        require(record["head"] == self.head and record["upstream"] == UPSTREAM
                and record["inputSha256"] == inputs, "Candidate provenance mismatch")
        verify_bundle(self.candidate / "bundle", record["bwrapSha256"], record["binaries"])
        scanner = self.target.parent / "codex-native-trivy"
        self.run("install-scanner", ["node", str(self.repo / ".github/scripts/install-trivy.mjs"), str(scanner)],
                 cwd=self.repo)
        # Scan only the final locked Rust dependency input. This is a source SBOM,
        # not a claim that statically linked C/C++ or all binary resources are covered.
        sbom_source = self.target.parent / "codex-native-sbom-source"
        sbom_source.mkdir()
        shutil.copy2(self.source / "codex-rs/Cargo.lock", sbom_source / "Cargo.lock")
        self.run("source-sbom", [str(scanner / "trivy"), "fs", "--format", "cyclonedx",
                 "--cache-dir", str(scanner / "cache"), "--output", str(self.candidate / "source.cdx.json"),
                 str(sbom_source)])
        sbom = json.loads((self.candidate / "source.cdx.json").read_text())
        require(sbom.get("bomFormat") == "CycloneDX" and bool(sbom.get("components")), "Empty source SBOM")
        record["sbom"] = {"path": "source.cdx.json", "scope": "Cargo.lock source dependencies only",
                          "binaryNativeDependenciesComplete": False,
                          "scanner": json.loads((scanner / "installation.json").read_text())}
        record["run"] = {"id": os.environ["GITHUB_RUN_ID"], "attempt": os.environ["GITHUB_RUN_ATTEMPT"]}
        record["status"] = "candidate; not installed, published or accepted"
        record["files"] = {str(path.relative_to(self.candidate)): digest(path)
                           for path in sorted(self.candidate.rglob("*")) if path.is_file()}
        record["builderSha256"] = {str(path.relative_to(self.repo)): digest(path) for path in (
            self.repo / ".github/workflows/codex-native-candidate.yml",
            self.vendor / "build-linux-aarch64.sh", self.vendor / "build-linux-aarch64.py",
            self.vendor / "apply-source.py", self.repo / ".github/scripts/install-trivy.mjs",
            self.repo / ".github/scripts/vulnerability-policy.mjs")}
        require(self.inputs() == inputs, "Inputs changed before sealing")
        save(self.candidate / "candidate.json", record)
        # Artifact services do not preserve executable modes. A tar archive does.
        artifact = self.output / "artifact"
        artifact.mkdir()
        files = sorted(path for path in self.candidate.rglob("*") if path.is_file())
        self.guard(sum(path.stat().st_size for path in files) + 1024**2)
        archive = artifact / "codex-candidate.tar.gz"
        with tarfile.open(archive, "w:gz") as stream:
            for path in files:
                self.guard()
                stream.add(path, arcname=str(path.relative_to(self.candidate)), recursive=False)
        save(artifact / "archive.json", {
            "head": self.head, "upstream": UPSTREAM, "target": TARGET,
            "archive": archive.name, "archiveSha256": digest(archive),
            "candidateManifestSha256": digest(self.candidate / "candidate.json"),
            "nativeAcceptance": False})
        self.guard()


def main():
    require(len(sys.argv) == 2 and sys.argv[1] in ("paths", "prepare", "musl", "v8", "build", "seal"),
            "usage: build-linux-aarch64.sh <paths|prepare|musl|v8|build|seal>")
    if sys.argv[1] == "paths":
        temp = Path(os.environ["RUNNER_TEMP"]).resolve()
        write_github_env(Path(os.environ["GITHUB_ENV"]), {
            "CANDIDATE_OUTPUT": str(temp / "codex-native-candidate"),
            "CANDIDATE_V8_DIR": str(temp / "codex-native-v8"),
            "CARGO_TARGET_DIR": str(temp / "codex-native-target"),
        })
        return
    builder = Builder()
    try:
        builder.guard()
        getattr(builder, "setup_v8" if builder.phase == "v8" else builder.phase)()
        status = "passed"
    except BaseException:
        save(builder.diag / f"{builder.phase}-status.json", {
            "phase": builder.phase, "status": "failed", "nativeAcceptance": False,
            "resources": builder.resources()})
        raise
    save(builder.diag / f"{builder.phase}-status.json", {
        "phase": builder.phase, "status": status, "nativeAcceptance": False,
        "resources": builder.resources()})


if __name__ == "__main__":
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt("Candidate build interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    main()
