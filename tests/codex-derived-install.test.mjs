import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("derived installer verifies the complete pinned bundle before installing", () => {
	const result = spawnSync(
		"python3",
		[
			"-B",
			"-c",
			String.raw`
import copy
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

node, installer = sys.argv[1:]
installer = Path(installer)
helper = installer.parent / 'vendor/codex/install-bundle.py'
spec = importlib.util.spec_from_file_location('bundle_installer', helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def encoded(value):
    return (json.dumps(value, indent=2) + '\n').encode()

def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()

class DerivedInstallation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.entry = self.root / 'repo/deploy/runtime/install-codex.mjs'
        self.helper = self.entry.parent / 'vendor/codex/install-bundle.py'
        self.helper.parent.mkdir(parents=True)
        shutil.copy2(installer, self.entry)
        shutil.copy2(helper, self.helper)
        self.release_path = self.root / 'repo/packages/agent-runtime/src/codex-release.json'
        self.release_path.parent.mkdir(parents=True)
        self.destination = self.root / 'installed'
        self.archive = self.root / 'complete candidate.tar.gz'
        self.files = {name: (name + '\n').encode() for name in module.FILES}
        header = bytearray(64)
        header[:6] = b'\x7fELF\x02\x01'
        header[16:18] = (2).to_bytes(2, 'little')
        header[18:20] = (183).to_bytes(2, 'little')
        for relative in module.BINARIES.values():
            self.files[relative] = bytes(header) + relative.encode()
        self.files['bundle/codex-package.json'] = encoded({
            'version': '0.153.0', 'target': module.TARGET, 'variant': 'codex'})
        self.files['source.cdx.json'] = encoded({
            'bomFormat': 'CycloneDX', 'specVersion': '1.5',
            'components': [{'type': 'library', 'name': 'fixture', 'version': '1.0.0'}]})
        self.files['builder-environment.json'] = encoded({
            'system': 'Linux', 'machine': 'aarch64', 'nativeAcceptance': False,
            'runId': '1234', 'runAttempt': '1'})
        self.candidate = {
            'head': '1' * 40, 'upstream': '2' * 40, 'sourceTree': '3' * 40,
            'target': module.TARGET, 'nativeAcceptance': False,
            'inputSha256': {
                'build-input-v1.json': sha(b'build input'),
                'codex-rs/Cargo.lock': sha(self.files['Cargo.lock']),
                'callback-v2.schema.json': sha(b'callback'),
                'coverage-v1.json': sha(b'coverage'),
                'callback-v2-corpus.json': sha(b'corpus')},
            'binaries': {name: sha(self.files[path]) for name, path in module.BINARIES.items()},
            'bwrapSha256': sha(self.files[module.BINARIES['bwrap']]),
            'builderSha256': {'deploy/runtime/vendor/codex/build-linux-aarch64.py': sha(b'builder')},
            'nativeProbe': {'schemaVersion': 1, 'transport': 'anonymous-unix-stream-fd3',
                'callbackSchemaSha256': sha(b'callback'), 'coverageSha256': sha(b'coverage'),
                'callbackCorpusSha256': sha(b'corpus')},
            'run': {'id': '1234', 'attempt': '1'},
            'sbom': {'path': 'source.cdx.json', 'scope': 'Cargo.lock source dependencies only',
                'binaryNativeDependenciesComplete': False,
                'scanner': {'version': '0.69.0', 'archiveSha256': '4' * 64, 'binarySha256': '5' * 64}},
            'files': {path: sha(data) for path, data in self.files.items()},
        }
        self.release = {
            'schemaVersion': 2,
            'provenance': {'protocolVersion': 2, 'codexVersion': '0.153.0',
                'upstreamTag': 'rust-v0.153.0', 'upstreamCommit': '2' * 40, 'schemaSha256': sha(b'appserver schema')},
            'distribution': {'kind': 'derived', 'buildId': 'test-codex-derived-recovery',
                'sourceTree': '3' * 40, 'buildInputSha256': sha(b'build input')},
            'artifacts': {'arm64': {'target': module.TARGET,
                'archiveSha256': '', 'candidateManifestSha256': '',
                'executableSha256': self.candidate['binaries']['codex'],
                'binaries': copy.deepcopy(self.candidate['binaries'])}},
            'legal': {'LICENSE': sha(self.files['legal/UPSTREAM-LICENSE']),
                      'NOTICE': sha(self.files['legal/UPSTREAM-NOTICE'])},
        }
        self.seal()

    def seal(self, change_entries=None, candidate_bytes=None):
        raw = candidate_bytes if candidate_bytes is not None else encoded(self.candidate)
        entries = []
        for name, data in {**self.files, 'candidate.json': raw}.items():
            member = tarfile.TarInfo(name)
            member.mode = 0o755 if name in module.BINARIES.values() else 0o644
            member.size = len(data)
            entries.append((member, data))
        if change_entries:
            entries = change_entries(entries)
        with tarfile.open(self.archive, 'w:gz') as stream:
            for member, data in entries:
                stream.addfile(member, None if data is None else io.BytesIO(data))
        artifact = self.release['artifacts']['arm64']
        artifact['archiveSha256'] = sha(self.archive.read_bytes())
        artifact['candidateManifestSha256'] = sha(raw)
        self.save_release()

    def save_release(self):
        self.release_path.write_bytes(encoded(self.release))

    def run_install(self, architecture='arm64', archive=True, extra=()):
        command = [node, str(self.entry), architecture, str(self.destination)]
        if archive:
            command.append(str(self.archive))
        command.extend(extra)
        return subprocess.run(command, capture_output=True, text=True, timeout=15)

    def reject(self, expected, **options):
        result = self.run_install(**options)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(expected, result.stderr)
        self.assertFalse(self.destination.exists())
        self.assertEqual(list(self.root.glob('.codex-staging-*')), [])

    def rehash_file(self, name):
        self.candidate['files'][name] = sha(self.files[name])

    def test_complete_bundle_installs_original_layout_and_provenance(self):
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = {'share/candidate.json', 'share/release.json'}
        for name, data in self.files.items():
            target = name.removeprefix('bundle/') if name.startswith('bundle/') else 'share/' + name
            expected.add(target)
            path = self.destination / target
            self.assertEqual(path.read_bytes(), data)
            self.assertEqual(path.stat().st_mode & 0o7777,
                             0o555 if name in module.BINARIES.values() else 0o444)
        self.assertEqual((self.destination / 'share/release.json').read_bytes(), self.release_path.read_bytes())
        self.assertEqual(json.loads((self.destination / 'share/candidate.json').read_bytes()), self.candidate)
        self.assertEqual({str(path.relative_to(self.destination)) for path in self.destination.rglob('*') if path.is_file()}, expected)
        self.assertEqual(list(self.root.glob('.codex-staging-*')), [])

    def transport(self, **changes):
        return {'kind': 'github-actions', 'repository': 'AgoraIO-Extensions/agent-infra',
                'runId': 1234, 'runAttempt': 1, 'artifactId': 5678,
                'sourceHead': self.candidate['head'], **changes}

    def test_matching_transport_installs_and_preserves_pinned_source(self):
        artifact = self.release['artifacts']['arm64']
        artifact['transport'] = self.transport(runId=1234.0)
        self.save_release()
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        installed = json.loads((self.destination / 'share/release.json').read_bytes())
        self.assertEqual(installed['artifacts']['arm64']['transport'], artifact['transport'])
        self.assertEqual(json.loads((self.destination / 'share/candidate.json').read_bytes()), self.candidate)

    def test_transport_requires_exact_repository_identity_and_positive_safe_numbers(self):
        variants = [None, [], {**self.transport(), 'extra': True},
                    {key: value for key, value in self.transport().items() if key != 'runAttempt'},
                    self.transport(kind='release'), self.transport(repository='other/repository'),
                    self.transport(sourceHead='A' * 40), self.transport(sourceHead='1' * 39)]
        for key in ('runId', 'runAttempt', 'artifactId'):
            for value in (True, '1', 0, -1, 1.5, 9007199254740992):
                variants.append(self.transport(**{key: value}))
        for transport in variants:
            with self.subTest(transport=transport):
                self.release['artifacts']['arm64']['transport'] = transport
                self.save_release()
                self.reject('Invalid derived artifact transport')

    def test_valid_archive_from_another_attempt_cannot_use_successful_attempt_transport(self):
        # The archive and candidate hashes legitimately pin attempt 2, while transport
        # can identify a successful attempt 1. Internal builder agreement is insufficient.
        self.candidate['run']['attempt'] = '2'
        environment = json.loads(self.files['builder-environment.json'])
        environment['runAttempt'] = '2'
        self.files['builder-environment.json'] = encoded(environment)
        self.rehash_file('builder-environment.json')
        self.seal()
        artifact = self.release['artifacts']['arm64']
        self.assertEqual(artifact['archiveSha256'], sha(self.archive.read_bytes()))
        self.assertEqual(artifact['candidateManifestSha256'], sha(encoded(self.candidate)))
        for transport in (self.transport(runAttempt=1), self.transport(runAttempt=2, runId=1235),
                          self.transport(runAttempt=2, sourceHead='9' * 40)):
            with self.subTest(transport=transport):
                artifact['transport'] = transport
                self.save_release()
                self.reject('Candidate transport source binding mismatch')
        # The same bytes install when their own run/head/attempt is pinned.
        artifact['transport'] = self.transport(runAttempt=2)
        self.save_release()
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_archive_and_manifest_bytes_are_pinned(self):
        self.archive.write_bytes(self.archive.read_bytes() + b'tampered')
        self.reject('Archive checksum mismatch')
        self.seal()
        self.release['artifacts']['arm64']['candidateManifestSha256'] = sha(b'wrong manifest')
        self.save_release()
        self.reject('Candidate manifest checksum mismatch')

    def test_each_required_file_and_binary_digest_is_checked(self):
        original = copy.deepcopy(self.files)
        original_candidate = copy.deepcopy(self.candidate)
        for name in self.files:
            with self.subTest(name=name):
                self.files = {**original, name: original[name] + b'changed'}
                self.seal()
                self.reject('Candidate file checksum mismatch')
        self.files = original
        self.candidate['binaries']['bwrap'] = sha(b'substituted bwrap')
        self.seal()
        self.reject('Candidate binary binding mismatch')
        self.candidate = original_candidate
        self.seal()
        pinned = copy.deepcopy(self.release['artifacts']['arm64'])
        for helper in ('codex-code-mode-host', 'codex-responses-api-proxy', 'bwrap'):
            with self.subTest(wrong_pinned_helper=helper):
                self.release['artifacts']['arm64'] = copy.deepcopy(pinned)
                self.release['artifacts']['arm64']['binaries'][helper] = sha(b'wrong helper')
                self.save_release()
                self.reject('Candidate binary binding mismatch')
        for invalid in (None, {key: value for key, value in pinned['binaries'].items() if key != 'bwrap'},
                        {**pinned['binaries'], 'extra-helper': sha(b'extra')},
                        {**pinned['binaries'], 'bwrap': 'invalid-sha'},
                        {**pinned['binaries'], 'codex': sha(b'wrong executable')}):
            with self.subTest(invalid_pinned_map=invalid):
                self.release['artifacts']['arm64'] = {**pinned, 'binaries': invalid}
                self.save_release()
                self.reject('Invalid derived binary digest map')

    def test_every_file_is_required_in_archive_and_manifest(self):
        for name in self.files:
            with self.subTest(archive_missing=name):
                self.seal(lambda entries: [(member, data) for member, data in entries if member.name != name])
                self.reject('Incomplete candidate archive')
        del self.candidate['files']['bundle/codex-resources/codex-code-mode-host']
        self.seal()
        self.reject('Incomplete candidate file inventory')

    def test_links_directories_duplicates_traversal_and_extra_entries_are_rejected(self):
        def malformed(entries, variant):
            member = copy.copy(entries[0][0])
            data = entries[0][1]
            if variant in ('symlink', 'hardlink'):
                member.type = tarfile.SYMTYPE if variant == 'symlink' else tarfile.LNKTYPE
                member.linkname = '/outside'
                member.size = 0
                entries[0] = (member, b'')
            elif variant == 'directory':
                member.type = tarfile.DIRTYPE
                member.size = 0
                entries[0] = (member, b'')
            elif variant == 'duplicate':
                entries.append((member, data))
            else:
                member.name = variant
                entries.append((member, data))
            return entries
        for variant in ('symlink', 'hardlink', 'directory', 'duplicate', '../outside', '/outside',
                        'bundle/../outside', 'bundle//bin/codex', './bundle/bin/codex', 'bundle\\bin\\codex', 'extra.txt'):
            with self.subTest(variant=variant):
                self.seal(lambda entries: malformed(entries, variant))
                self.reject('Unsafe, duplicate or unexpected archive entry')

    def test_all_modes_and_setid_bits_are_rejected(self):
        for name in ('bundle/bin/codex', 'bundle/codex-resources/bwrap', 'source.cdx.json'):
            for mode in (0o777, 0o4755, 0o2755, 0o600):
                with self.subTest(name=name, mode=mode):
                    def change(entries):
                        for member, _ in entries:
                            if member.name == name:
                                member.mode = mode
                        return entries
                    self.seal(change)
                    self.reject('Archive mode mismatch')

    def test_candidate_source_upstream_target_and_build_input_are_bound(self):
        original = copy.deepcopy(self.candidate)
        for change in ({'sourceTree': '6' * 40}, {'upstream': '7' * 40}, {'target': 'x86_64-unknown-linux-musl'},
                       {'inputSha256': {**original['inputSha256'], 'build-input-v1.json': sha(b'identity-only')}}):
            with self.subTest(change=change):
                self.candidate = {**original, **change}
                self.seal()
                self.reject('Candidate source or target mismatch')
        self.candidate = original
        self.candidate['nativeProbe']['coverageSha256'] = sha(b'wrong coverage')
        self.seal()
        self.reject('Candidate native probe binding mismatch')

    def test_each_binary_must_have_the_expected_elf_class_endianness_and_machine(self):
        original_files = copy.deepcopy(self.files)
        original_candidate = copy.deepcopy(self.candidate)
        for name, path in module.BINARIES.items():
            for offset, value in ((0, 0), (4, 1), (5, 2), (16, 1), (18, 62)):
                with self.subTest(binary=name, offset=offset):
                    self.files = copy.deepcopy(original_files)
                    self.candidate = copy.deepcopy(original_candidate)
                    data = bytearray(self.files[path]); data[offset] = value
                    self.files[path] = bytes(data)
                    self.rehash_file(path)
                    self.candidate['binaries'][name] = sha(data)
                    self.candidate['bwrapSha256'] = self.candidate['binaries']['bwrap']
                    self.release['artifacts']['arm64']['executableSha256'] = self.candidate['binaries']['codex']
                    self.release['artifacts']['arm64']['binaries'] = copy.deepcopy(self.candidate['binaries'])
                    self.seal()
                    self.reject('Binary is not ELF64')

    def test_package_sbom_lock_and_builder_are_semantically_checked(self):
        original_files = copy.deepcopy(self.files)
        original_candidate = copy.deepcopy(self.candidate)
        variants = [
            ('bundle/codex-package.json', {'version': '0.153.0', 'target': module.TARGET, 'variant': 'other'}, 'Codex package metadata'),
            ('source.cdx.json', {'bomFormat': 'CycloneDX', 'components': []}, 'Empty or invalid source SBOM'),
            ('source.cdx.json', {'bomFormat': 'SPDX', 'components': [{}]}, 'Empty or invalid source SBOM'),
            ('builder-environment.json', {'system': 'Linux', 'machine': 'x86_64', 'runId': '1234', 'runAttempt': '1', 'nativeAcceptance': False}, 'Builder environment mismatch'),
            ('builder-environment.json', {'system': 'Linux', 'machine': 'aarch64', 'runId': 'different', 'runAttempt': '1', 'nativeAcceptance': False}, 'Builder environment mismatch'),
        ]
        for name, value, message in variants:
            with self.subTest(name=name, value=value):
                self.files = copy.deepcopy(original_files); self.candidate = copy.deepcopy(original_candidate)
                self.files[name] = encoded(value); self.rehash_file(name); self.seal()
                self.reject(message)
        self.files = original_files; self.candidate = original_candidate
        self.candidate['inputSha256']['codex-rs/Cargo.lock'] = sha(b'other lock')
        self.seal(); self.reject('Candidate lock binding mismatch')
        self.candidate['inputSha256']['codex-rs/Cargo.lock'] = sha(self.files['Cargo.lock'])
        self.candidate['sbom']['binaryNativeDependenciesComplete'] = True
        self.seal(); self.reject('Invalid source SBOM scope')

    def test_destination_is_never_merged_overwritten_or_followed(self):
        self.destination.mkdir()
        marker = self.destination / 'existing'
        marker.write_text('preserve me')
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('destination already exists', result.stderr)
        self.assertEqual(marker.read_text(), 'preserve me')
        marker.unlink(); self.destination.rmdir()
        self.destination.symlink_to(self.root / 'absent-target')
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.destination.is_symlink())
        self.assertFalse((self.root / 'absent-target').exists())

    def test_cli_does_not_allow_external_manifest_or_digest_overrides_or_fallback(self):
        self.reject('complete archive', archive=False)
        self.reject('usage:', architecture='amd64')
        self.reject('usage:', extra=['external-manifest.json'])
        self.release['artifacts']['amd64'] = {**self.release['artifacts']['arm64'], 'target': 'x86_64-unknown-linux-musl'}
        self.save_release(); self.reject('Unsupported derived target', architecture='amd64')
        del self.release['artifacts']['arm64']['archiveSha256']
        self.save_release(); self.reject('Missing derived artifact digest')

    def test_archive_entry_and_expansion_limits_are_bounded(self):
        self.seal(lambda entries: entries + [entries[0]] * module.MAX_ENTRIES)
        self.reject('Archive entry or size limit exceeded')
        oversized = tarfile.TarInfo('bundle/bin/codex')
        oversized.size = module.MAX_FILE + 1
        oversized.mode = 0o755
        self.archive.write_bytes(gzip.compress(oversized.tobuf() + b'\x00' * 10240))
        self.release['artifacts']['arm64']['archiveSha256'] = sha(self.archive.read_bytes())
        self.save_release()
        self.reject('Archive entry or size limit exceeded')
        self.seal()
        with patch.object(module, 'RELEASE', self.release_path), patch.object(module, 'MAX_TAR', 1024):
            with self.assertRaisesRegex(ValueError, 'Expanded archive size limit exceeded'):
                module.install('arm64', self.destination, self.archive)
        self.assertFalse(self.destination.exists())

    def test_duplicate_json_keys_and_missing_manifest_are_rejected(self):
        raw = encoded(self.candidate)
        raw = b'{"target":"wrong",' + raw[1:]
        self.seal(candidate_bytes=raw)
        self.reject('Duplicate JSON key')
        self.seal(lambda entries: [(member, data) for member, data in entries if member.name != 'candidate.json'])
        self.reject('Missing or duplicate candidate manifest')

unittest.main(argv=['derived-install'], verbosity=2)
`,
			process.execPath,
			fileURLToPath(
				new URL("../deploy/runtime/install-codex.mjs", import.meta.url),
			),
		],
		{ encoding: "utf8", timeout: 60_000 },
	);
	assert.equal(result.status, 0, result.stderr || result.stdout);
});
