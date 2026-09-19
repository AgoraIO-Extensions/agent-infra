import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("candidate rejects wrong head, source drift, missing helpers and changed bwrap", () => {
	const result = spawnSync(
		"python3",
		[
			"-B",
			"-c",
			String.raw`
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

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
        for name in (*candidate.UPSTREAM_TOOLS, candidate.RUST_TOOLCHAIN, 'codex-rs/Cargo.lock', 'MODULE.bazel.lock', 'changed.rs'):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('original\n')
        (self.source / candidate.RUST_TOOLCHAIN).write_text('[toolchain]\nchannel = \"1.96.0\"\n')
        git('add', '.')
        git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture')
        candidate.UPSTREAM = git('rev-parse', 'HEAD')
        self.head = candidate.UPSTREAM
        (self.vendor / 'patch').write_text('patch bytes')
        (self.vendor / 'callback').write_text('callback bytes')
        (self.source / 'changed.rs').write_text('patched\n')
        manifest = {
            'upstream': {'commit': self.head},
            'toolchain': {'rust': candidate.RUST_VERSION},
            'patches': [{'path': 'patch', 'sha256': candidate.digest(self.vendor / 'patch')}],
            'callbackInputs': {'callback': candidate.digest(self.vendor / 'callback')},
            'sourceFiles': [{'path': 'changed.rs', 'sha256': candidate.digest(self.source / 'changed.rs')},
                            {'path': candidate.RUST_TOOLCHAIN, 'sha256': candidate.digest(self.source / candidate.RUST_TOOLCHAIN)}],
            'currentLocks': {'cargoSha256': candidate.digest(self.source / 'codex-rs/Cargo.lock'),
                             'bazelSha256': candidate.digest(self.source / 'MODULE.bazel.lock')},
        }
        (self.vendor / 'build-input-v1.json').write_text(json.dumps(manifest))

    def test_source_inputs_are_bound_to_recorded_bytes(self):
        expected = candidate.verify_inputs(self.vendor, self.source)
        self.assertIn('build-input-v1.json', expected)
        for path in (self.vendor / 'patch', self.vendor / 'callback', self.source / 'changed.rs',
                     self.source / 'codex-rs/Cargo.lock', self.source / candidate.RUST_TOOLCHAIN,
                     self.source / candidate.UPSTREAM_TOOLS[0]):
            original = path.read_bytes()
            path.write_bytes(original + b'drift')
            with self.assertRaises(RuntimeError):
                candidate.verify_inputs(self.vendor, self.source)
            path.write_bytes(original)
        (self.source / 'unrecorded.rs').write_text('unapproved')
        with self.assertRaisesRegex(RuntimeError, 'Unrecorded'):
            candidate.verify_inputs(self.vendor, self.source)

    def test_toolchain_requires_both_recorded_source_and_fixed_version(self):
        path = self.vendor / 'build-input-v1.json'
        manifest = json.loads(path.read_text())
        manifest['sourceFiles'] = [entry for entry in manifest['sourceFiles']
                                   if entry['path'] != candidate.RUST_TOOLCHAIN]
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, 'missing from frozen'):
            candidate.verify_inputs(self.vendor, self.source)
        toolchain = self.source / candidate.RUST_TOOLCHAIN
        toolchain.write_text('[toolchain]\nchannel = "1.95.0"\n')
        manifest['sourceFiles'].append({'path': candidate.RUST_TOOLCHAIN, 'sha256': candidate.digest(toolchain)})
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, 'version mismatch'):
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

    def test_source_tree_includes_new_files_without_changing_head_or_index(self):
        manifest_path = self.vendor / 'build-input-v1.json'
        manifest = json.loads(manifest_path.read_text())
        (self.source / 'new.rs').write_text('new native source\n')
        manifest['sourceFiles'].append({'path': 'new.rs', 'sha256': candidate.digest(self.source / 'new.rs')})
        manifest_path.write_text(json.dumps(manifest))
        before_index = candidate.digest(self.source / '.git/index')
        before_status = self.git('status', '--porcelain')
        candidate.verify_inputs(self.vendor, self.source)
        tree = candidate.native_source_tree(self.vendor, self.source)
        self.assertEqual(tree, candidate.native_source_tree(self.vendor, self.source))
        self.assertEqual(self.git('show', f'{tree}:changed.rs'), 'patched')
        self.assertEqual(self.git('show', f'{tree}:new.rs'), 'new native source')
        self.assertEqual(self.git('show', f'{tree}:codex-rs/Cargo.lock'), 'original')
        self.assertNotEqual(tree, self.git('rev-parse', 'HEAD^{tree}'))
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.head)
        self.assertEqual(candidate.digest(self.source / '.git/index'), before_index)
        self.assertEqual(self.git('status', '--porcelain'), before_status)
        (self.source / 'changed.rs').write_text('different patch\n')
        self.assertNotEqual(candidate.native_source_tree(self.vendor, self.source), tree)
        self.assertEqual(candidate.digest(self.source / '.git/index'), before_index)

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

    def test_seal_rejects_binary_drift_during_scanner_stage(self):
        builder = object.__new__(candidate.Builder)
        builder.repo = entry.parents[4]
        builder.vendor = entry.parent
        builder.source = self.source
        builder.target = self.root / 'target'
        builder.output = self.root / 'output'
        builder.diag = builder.output / 'diagnostics'
        builder.candidate = builder.output / 'candidate'
        builder.head = self.head
        builder.diag.mkdir(parents=True)
        bundle = builder.candidate / 'bundle'
        header = b'\x7fELF\x02\x01' + b'\x00' * 10 + (2).to_bytes(2, 'little') + (183).to_bytes(2, 'little') + b'\x00' * 44
        for relative in candidate.BINARIES.values():
            native = bundle / relative
            native.parent.mkdir(parents=True, exist_ok=True)
            native.write_bytes(header)
            native.chmod(0o755)
        bwrap = candidate.digest(bundle / candidate.BINARIES['bwrap'])
        tree = '2' * 40
        candidate.save(builder.diag / 'build.json', {
            'head': self.head, 'upstream': candidate.UPSTREAM, 'inputSha256': {},
            'sourceTree': tree, 'bwrapSha256': bwrap,
            'binaries': candidate.verify_bundle(bundle, bwrap), 'nativeAcceptance': False})
        candidate.save(builder.diag / 'runner.json', {})
        builder.inputs = lambda: {}
        builder.guard = lambda *args: None
        def run(name, *args, **kwargs):
            if name == 'install-scanner':
                scanner = builder.target.parent / 'codex-native-trivy'
                scanner.mkdir()
                candidate.save(scanner / 'installation.json', {})
            elif name == 'source-sbom':
                candidate.save(builder.candidate / 'source.cdx.json',
                               {'bomFormat': 'CycloneDX', 'components': [{}]})
                (bundle / candidate.BINARIES['codex']).write_bytes(header + b'drift-after-verification')
        builder.run = run
        with patch.object(candidate, 'native_source_tree', return_value=tree), \
             patch.dict(candidate.os.environ, {'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'}):
            with self.assertRaisesRegex(RuntimeError, 'Candidate binary digest mismatch'):
                builder.seal()
        self.assertFalse((builder.output / 'artifact' / 'archive.json').exists())
        self.assertFalse((builder.output / 'artifact' / 'codex-candidate.tar.gz').exists())

    def test_archive_readback_rejects_substitution_modes_links_and_incomplete_sets(self):
        archive = self.root / 'candidate.tar.gz'
        names = ('bundle/bin/codex', 'candidate.json')
        contents = {name: name.encode() for name in names}
        hashes = {name: 'sha256:' + candidate.hashlib.sha256(data).hexdigest()
                  for name, data in contents.items()}
        modes = {names[0]: 0o755, names[1]: 0o644}
        def write(variant):
            entries = names + (names[0],) if variant == 'duplicate' else names
            if variant == 'missing':
                entries = names[:1]
            with candidate.tarfile.open(archive, 'w:gz') as stream:
                for name in entries:
                    data = contents[name] + (b'drift' if variant == 'bytes' else b'')
                    member = candidate.tarfile.TarInfo(name)
                    member.mode = 0o644 if variant == 'mode' else modes[name]
                    member.size = len(data)
                    if variant == 'symlink':
                        member.type = candidate.tarfile.SYMTYPE
                        member.linkname = '/outside'
                        member.size = 0
                    stream.addfile(member, io.BytesIO(data))
        write('valid')
        candidate.verify_archive(archive, hashes, modes)
        for variant in ('bytes', 'mode', 'duplicate', 'missing', 'symlink'):
            with self.subTest(variant=variant):
                write(variant)
                with self.assertRaises(RuntimeError):
                    candidate.verify_archive(archive, hashes, modes)

    def test_native_test_failure_or_candidate_drift_never_records_a_pass(self):
        builder = object.__new__(candidate.Builder)
        builder.diag = self.root / 'diagnostics'
        builder.diag.mkdir()
        builder.candidate = self.root / 'candidate'
        builder.candidate.mkdir()
        builder.vendor = self.vendor
        builder.source = self.source
        builder.head = self.head
        builder.output = self.root / 'runner-owned-output'
        builder.output.mkdir()
        inputs = {'build-input-v1.json': 'fixed'}
        builder.inputs = lambda: inputs.copy()
        tree = candidate.native_source_tree(self.vendor, self.source)
        record = {'head': self.head, 'inputSha256': inputs, 'sourceTree': tree,
                  'bwrapSha256': 'sha256:' + 'a' * 64, 'binaries': {'bwrap': 'sha256:' + 'a' * 64}}
        candidate.save(builder.candidate / 'candidate.json', record)
        commands = []
        test_roots = set()
        failure = RuntimeError('native test failed')
        def run(name, command, cwd, env):
            commands.append(command)
            self.assertEqual(cwd, self.source)
            self.assertEqual(env['CODEX_BWRAP_SHA256'], 'a' * 64)
            test_root = Path(env['CODEX_TEST_HOME_ROOT'])
            test_roots.add(test_root)
            self.assertTrue(test_root.is_absolute())
            self.assertEqual(test_root.parent, builder.output.resolve())
            self.assertEqual(test_root.stat().st_mode & 0o777, 0o700)
            self.assertFalse(test_root.is_relative_to(self.source.resolve()))
            self.assertFalse(test_root.is_relative_to(Path(tempfile.gettempdir()).resolve()))
            # Simulate a native ctor leaving its home behind after abort.
            (test_root / 'unfinished-test-home').mkdir(exist_ok=True)
            # Focused runs need Core's target-specific vendored OpenSSL feature.
            expected_packages = (['codex-core'] if name == 'native-tests-model-switch-compaction' else
                                 ['codex-rmcp-client', 'codex-core', 'codex-network-proxy',
                                  'codex-git-utils', 'codex-http-client'])
            self.assertEqual([command[index + 1] for index, value in enumerate(command) if value == '-p'],
                             expected_packages)
            self.assertIn('--no-tests=fail', command)
            self.assertIn('--release', command)
            self.assertEqual(command[command.index('--target') + 1], candidate.TARGET)
            expected_selection = {
                'native-tests-connection': 'package(=codex-rmcp-client) & (test(native_connection))',
                'native-tests-barrier': 'package(=codex-core) & (test(native_connection_bootstrap) | test(native_operation_barrier))',
                'native-tests-network-proxy': 'package(=codex-network-proxy) & (all())',
                'native-tests-git-utils': 'package(=codex-git-utils) & (all())',
                'native-tests-http-client': 'package(=codex-http-client) & (all())',
                'native-tests-model-switch-compaction': 'package(=codex-core) & (test(suite::compact::))',
            }
            self.assertEqual(command[command.index('-E') + 1], expected_selection[name])
            if name == 'native-tests-model-switch-compaction':
                self.assertNotIn('--lib', command)
                self.assertEqual(command[command.index('--test') + 1], 'all')
                if failure is not None:
                    raise failure
            else:
                self.assertIn('--lib', command)
        builder.run = run
        def version(command, cwd):
            return 'just 1.51.0' if command[0] == 'just' else 'cargo-nextest 0.9.103 (fixture)'
        # Model the runner's /home/runner/_temp separately from system /tmp.
        system_temp = self.root / 'system-temp'
        system_temp.mkdir()
        with patch.object(candidate, 'capture', side_effect=version), patch.object(candidate, 'verify_bundle'), patch.object(candidate.tempfile, 'gettempdir', return_value=str(system_temp)):
            for failure in (RuntimeError('native test failed'), KeyboardInterrupt('interrupted'), None):
                commands.clear()
                test_roots.clear()
                if failure is None:
                    builder.tests()
                    proof = builder.diag / 'native-tests.json'
                    self.assertFalse(json.loads(proof.read_text())['nativeAcceptance'])
                    proof.unlink()
                else:
                    with self.assertRaises(type(failure)):
                        builder.tests()
                self.assertEqual(len(commands), 6)
                self.assertEqual(len(test_roots), 1)
                self.assertTrue(all(not root.exists() for root in test_roots))
                self.assertFalse((builder.diag / 'native-tests.json').exists())
            for unsafe_output in (self.source, system_temp):
                builder.output = unsafe_output
                commands.clear()
                with self.assertRaisesRegex(RuntimeError, 'Test homes must be outside'):
                    builder.tests()
                self.assertEqual(commands, [])
        commands.clear()
        self.assertFalse((builder.diag / 'native-tests.json').exists())
        record['head'] = '0' * 40
        candidate.save(builder.candidate / 'candidate.json', record)
        commands.clear()
        with self.assertRaisesRegex(RuntimeError, 'inputs differ'):
            builder.tests()
        self.assertEqual(commands, [])

unittest.main()
`,
		],
		{ encoding: "utf8", timeout: 30_000 },
	);
	assert.equal(result.status, 0, result.stderr || result.stdout);
});
