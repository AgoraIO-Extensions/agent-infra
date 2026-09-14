import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

test("candidate rejects wrong head, source drift, missing helpers and changed bwrap", () => {
	const result = spawnSync(
		"python3",
		[
			"-B",
			"-c",
			String.raw`
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

entry = Path('deploy/runtime/vendor/codex/build-linux-aarch64.py').resolve()
spec = importlib.util.spec_from_file_location('candidate', entry)
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)

class CandidateGates(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.vendor = self.root / 'vendor'
        self.vendor.mkdir()
        def git(*args):
            return subprocess.check_output(['git', *args], cwd=self.source, stderr=subprocess.DEVNULL).decode().strip()
        self.git = git
        git('init')
        git('config', 'user.name', 'Candidate test')
        git('config', 'user.email', 'candidate@example.invalid')
        for name in (*candidate.UPSTREAM_TOOLS, 'codex-rs/Cargo.lock', 'MODULE.bazel.lock', 'changed.rs'):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('original\n')
        git('add', '.')
        git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture')
        candidate.UPSTREAM = git('rev-parse', 'HEAD')
        self.head = candidate.UPSTREAM
        (self.vendor / 'patch').write_text('patch bytes')
        (self.vendor / 'callback').write_text('callback bytes')
        (self.source / 'changed.rs').write_text('patched\n')
        manifest = {
            'upstream': {'commit': self.head},
            'patches': [{'path': 'patch', 'sha256': candidate.digest(self.vendor / 'patch')}],
            'callbackInputs': {'callback': candidate.digest(self.vendor / 'callback')},
            'sourceFiles': [{'path': 'changed.rs', 'sha256': candidate.digest(self.source / 'changed.rs')}],
            'currentLocks': {'cargoSha256': candidate.digest(self.source / 'codex-rs/Cargo.lock'),
                             'bazelSha256': candidate.digest(self.source / 'MODULE.bazel.lock')},
        }
        (self.vendor / 'build-input-v1.json').write_text(json.dumps(manifest))

    def test_source_inputs_are_bound_to_recorded_bytes(self):
        expected = candidate.verify_inputs(self.vendor, self.source)
        self.assertIn('build-input-v1.json', expected)
        for path in (self.vendor / 'patch', self.vendor / 'callback', self.source / 'changed.rs',
                     self.source / 'codex-rs/Cargo.lock', self.source / candidate.UPSTREAM_TOOLS[0]):
            original = path.read_bytes()
            path.write_bytes(original + b'drift')
            with self.assertRaises(RuntimeError):
                candidate.verify_inputs(self.vendor, self.source)
            path.write_bytes(original)
        (self.source / 'unrecorded.rs').write_text('unapproved')
        with self.assertRaisesRegex(RuntimeError, 'Unrecorded'):
            candidate.verify_inputs(self.vendor, self.source)

    def test_wrong_head_and_dirty_pr_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'PR head mismatch'):
            candidate.verify_head(self.source, '0' * 40)
        with self.assertRaisesRegex(RuntimeError, 'not clean'):
            candidate.verify_head(self.source, self.head)
        self.git('checkout', '--', 'changed.rs')
        candidate.verify_head(self.source, self.head)
        candidate.UPSTREAM = '0' * 40
        with self.assertRaisesRegex(RuntimeError, 'upstream'):
            candidate.verify_inputs(self.vendor, self.source)

    def test_bundle_requires_original_bwrap_and_all_arm64_helpers(self):
        bundle = self.root / 'bundle'
        header = b'\x7fELF\x02\x01' + b'\x00' * 10 + (2).to_bytes(2, 'little') + (183).to_bytes(2, 'little') + b'\x00' * 44
        for relative in candidate.BINARIES.values():
            path = bundle / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(header + relative.encode())
            path.chmod(0o755)
        bwrap = bundle / candidate.BINARIES['bwrap']
        expected = candidate.digest(bwrap)
        hashes = candidate.verify_bundle(bundle, expected)
        helper = bundle / candidate.BINARIES['codex-code-mode-host']
        original = helper.read_bytes()
        helper.unlink()
        with self.assertRaisesRegex(RuntimeError, 'Missing'):
            candidate.verify_bundle(bundle, expected)
        helper.write_bytes(original)
        helper.chmod(0o755)
        bwrap.write_bytes(bwrap.read_bytes() + b'changed after compile')
        with self.assertRaisesRegex(RuntimeError, 'bwrap digest'):
            candidate.verify_bundle(bundle, expected)
        bwrap.write_bytes(header + candidate.BINARIES['bwrap'].encode())
        helper.write_bytes(header[:18] + (62).to_bytes(2, 'little') + header[20:])
        with self.assertRaisesRegex(RuntimeError, 'aarch64'):
            candidate.verify_bundle(bundle, expected)
        helper.write_bytes(original + b'changed helper')
        with self.assertRaisesRegex(RuntimeError, 'Candidate binary digest'):
            candidate.verify_bundle(bundle, expected, hashes)

    def test_environment_file_is_data_not_shell(self):
        env = self.root / 'env'
        candidate.write_github_env(env, {'RUSTY_V8_ARCHIVE': '/tmp/a file$(no-execution)'})
        self.assertEqual(env.read_text(), 'RUSTY_V8_ARCHIVE=/tmp/a file$(no-execution)\n')
        with self.assertRaisesRegex(RuntimeError, 'environment'):
            candidate.write_github_env(env, {'RUSTY_V8_ARCHIVE': '/tmp/a\nEVIL=yes'})

    def test_free_disk_floor_cannot_be_ignored(self):
        builder = object.__new__(candidate.Builder)
        builder.diag = self.root
        builder.resources = lambda: {'freeBytes': candidate.MIN_FREE - 1}
        with self.assertRaisesRegex(RuntimeError, '2 GiB'):
            builder.guard()
        builder.resources = lambda: {'freeBytes': candidate.MIN_FREE}
        builder.guard()

unittest.main()
`,
		],
		{ encoding: "utf8", timeout: 30_000 },
	);
	assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("candidate uses an isolated read-only exact PR checkout and fixed standard Arm runner", () => {
	const expression = (body) => `\${{ ${body} }}`;
	const workflow = YAML.parse(
		readFileSync(".github/workflows/codex-native-candidate.yml", "utf8"),
	);
	assert.deepEqual(Object.keys(workflow.on), ["pull_request"]);
	assert.deepEqual(workflow.permissions, { contents: "read" });
	assert.ok(
		workflow.on.pull_request.paths.includes("deploy/runtime/vendor/codex/**"),
	);
	const job = workflow.jobs.candidate;
	assert.equal(job["runs-on"], "ubuntu-24.04-arm");
	assert.equal(job["timeout-minutes"], 180);
	assert.equal(job.env.CARGO_BUILD_JOBS, "2");
	assert.equal(job.env.CARGO_INCREMENTAL, "0");
	assert.equal(job.env.TARGET, "aarch64-unknown-linux-musl");
	for (const name of ["HOME", "CODEX_HOME", "CARGO_HOME"])
		assert.equal(job.env[name], undefined);
	assert.equal(
		job.steps[0].with.ref,
		expression("github.event.pull_request.head.sha"),
	);
	assert.equal(
		job.steps[1].with.ref,
		"41e22fee981a63b3698df7ed36bad393cda24715",
	);
	for (const step of job.steps) {
		if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
		if (step.uses?.startsWith("actions/checkout@"))
			assert.equal(step.with["persist-credentials"], false);
		if (step.uses?.startsWith("actions/upload-artifact@")) {
			assert.equal(step.with["retention-days"], 1);
			assert.match(
				step.with.path,
				/codex-native-candidate\/(artifact|diagnostics)\/$/,
			);
		}
	}
	assert.equal(job.steps.at(-2).if, expression("success()"));
	assert.equal(job.steps.at(-1).if, expression("always()"));
	assert.deepEqual(workflow.jobs.outcome.needs, ["candidate"]);
	assert.deepEqual(workflow.jobs.outcome.permissions, {});
});
