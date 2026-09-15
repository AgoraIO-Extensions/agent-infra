#!/usr/bin/env python3
"""Install a complete, repository-pinned derived bundle without executing it."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tarfile
import tempfile

RELEASE = Path(__file__).resolve().parents[4] / 'packages/agent-runtime/src/codex-release.json'
TARGET = 'aarch64-unknown-linux-musl'
BINARIES = {
    'codex': 'bundle/bin/codex',
    'codex-responses-api-proxy': 'bundle/bin/codex-responses-api-proxy',
    'codex-code-mode-host': 'bundle/codex-resources/codex-code-mode-host',
    'bwrap': 'bundle/codex-resources/bwrap',
}
FILES = frozenset((*BINARIES.values(), 'bundle/codex-package.json', 'Cargo.lock',
                   'source.cdx.json', 'builder-environment.json',
                   'legal/UPSTREAM-LICENSE', 'legal/UPSTREAM-NOTICE', 'legal/JCS-NOTICE',
                   'legal/licenses/ryu-js-1.0.3-APACHE.txt',
                   'legal/licenses/ryu-js-1.0.3-BOOST.txt',
                   'legal/licenses/serde_json_canonicalizer-0.3.2-MIT.txt'))
CHUNK = 1024 * 1024
MAX_ARCHIVE = 512 * CHUNK
MAX_FILE = 512 * CHUNK
MAX_TOTAL = 768 * CHUNK
MAX_TAR = MAX_TOTAL + 16 * CHUNK
MAX_ENTRIES = 64
MAX_JSON = 16 * CHUNK


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def valid_sha(value):
    return isinstance(value, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', value)


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key')
        result[key] = value
    return result


def json_object(data):
    require(len(data) <= MAX_JSON, 'JSON size limit exceeded')
    value = json.loads(data, object_pairs_hook=object_pairs,
                       parse_constant=lambda _: require(False, 'Invalid JSON number'))
    require(isinstance(value, dict), 'Expected JSON object')
    return value


def hash_stream(stream):
    digest = hashlib.sha256()
    while chunk := stream.read(CHUNK):
        digest.update(chunk)
    return 'sha256:' + digest.hexdigest()


def pinned_release(architecture):
    raw = RELEASE.read_bytes()
    release = json_object(raw)
    require(release.get('schemaVersion') == 2, 'Derived release schema mismatch')
    distribution = release['distribution']
    require(set(distribution) == {'kind', 'buildId', 'sourceTree', 'buildInputSha256'}
            and distribution['kind'] == 'derived', 'Derived distribution mismatch')
    require(isinstance(distribution['buildId'], str)
            and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', distribution['buildId']),
            'Invalid derived build ID')
    require(isinstance(distribution['sourceTree'], str)
            and re.fullmatch(r'[a-f0-9]{40}', distribution['sourceTree'])
            and valid_sha(distribution['buildInputSha256']), 'Invalid derived source identity')
    provenance = release['provenance']
    require(set(provenance) == {'protocolVersion', 'codexVersion', 'upstreamTag',
                               'upstreamCommit', 'schemaSha256'}
            and provenance['protocolVersion'] == 2
            and isinstance(provenance['codexVersion'], str)
            and re.fullmatch(r'\d+\.\d+\.\d+', provenance['codexVersion'])
            and provenance['upstreamTag'] == 'rust-v' + provenance['codexVersion']
            and re.fullmatch(r'[a-f0-9]{40}', provenance['upstreamCommit'])
            and valid_sha(provenance['schemaSha256']), 'Invalid upstream compatibility provenance')
    artifact = release['artifacts'].get(architecture)
    require(architecture == 'arm64' and isinstance(artifact, dict)
            and artifact.get('target') == TARGET, 'Unsupported derived target')
    require(all(valid_sha(artifact.get(key)) for key in
                ('archiveSha256', 'candidateManifestSha256', 'executableSha256')),
            'Missing derived artifact digest')
    binaries = artifact.get('binaries')
    require(isinstance(binaries, dict) and set(binaries) == set(BINARIES)
            and all(valid_sha(value) for value in binaries.values())
            and artifact['executableSha256'] == binaries['codex'],
            'Invalid derived binary digest map')
    if 'transport' in artifact:
        transport = artifact['transport']
        require(isinstance(transport, dict) and set(transport) == {
            'kind', 'repository', 'runId', 'runAttempt', 'artifactId', 'sourceHead'}
            and transport['kind'] == 'github-actions'
            and transport['repository'] == 'AgoraIO-Extensions/agent-infra'
            and all(type(transport[key]) in (int, float)
                    and 0 < transport[key] <= 9007199254740991
                    and transport[key] == int(transport[key])
                    for key in ('runId', 'runAttempt', 'artifactId'))
            and isinstance(transport['sourceHead'], str)
            and re.fullmatch(r'[a-f0-9]{40}', transport['sourceHead']),
            'Invalid derived artifact transport')
    return raw, release, artifact


def candidate_manifest(raw, release, artifact):
    require(sha(raw) == artifact['candidateManifestSha256'], 'Candidate manifest checksum mismatch')
    candidate = json_object(raw)
    require(candidate['upstream'] == release['provenance']['upstreamCommit']
            and candidate['target'] == artifact['target']
            and candidate['sourceTree'] == release['distribution']['sourceTree']
            and candidate['inputSha256']['build-input-v1.json']
            == release['distribution']['buildInputSha256'], 'Candidate source or target mismatch')
    require(isinstance(candidate.get('head'), str)
            and re.fullmatch(r'[a-f0-9]{40}', candidate['head'])
            and candidate.get('nativeAcceptance') is False, 'Invalid candidate source record')
    if 'transport' in artifact:
        transport = artifact['transport']
        require(candidate['head'] == transport['sourceHead']
                and isinstance(candidate.get('run'), dict)
                and candidate['run'].get('id') == str(int(transport['runId']))
                and candidate['run'].get('attempt') == str(int(transport['runAttempt'])),
                'Candidate transport source binding mismatch')
    files = candidate['files']
    require(isinstance(files, dict) and set(files) == FILES
            and all(valid_sha(value) for value in files.values()), 'Incomplete candidate file inventory')
    binaries = candidate['binaries']
    require(isinstance(binaries, dict) and set(binaries) == set(BINARIES)
            and binaries == artifact['binaries']
            and all(binaries[name] == files[path] for name, path in BINARIES.items())
            and binaries['codex'] == artifact['executableSha256']
            and binaries['bwrap'] == candidate['bwrapSha256'], 'Candidate binary binding mismatch')
    inputs = candidate['inputSha256']
    require(isinstance(inputs, dict) and all(valid_sha(value) for value in inputs.values())
            and inputs.get('codex-rs/Cargo.lock') == files['Cargo.lock'], 'Candidate lock binding mismatch')
    probe = candidate['nativeProbe']
    require(probe.get('schemaVersion') == 1 and probe.get('transport') == 'anonymous-unix-stream-fd3'
            and probe.get('callbackSchemaSha256') == inputs.get('callback-v2.schema.json')
            and probe.get('coverageSha256') == inputs.get('coverage-v1.json')
            and probe.get('callbackCorpusSha256') == inputs.get('callback-v2-corpus.json')
            and all(valid_sha(probe.get(key)) for key in
                    ('callbackSchemaSha256', 'coverageSha256', 'callbackCorpusSha256')),
            'Candidate native probe binding mismatch')
    sbom = candidate['sbom']
    require(sbom.get('path') == 'source.cdx.json'
            and sbom.get('scope') == 'Cargo.lock source dependencies only'
            and sbom.get('binaryNativeDependenciesComplete') is False, 'Invalid source SBOM scope')
    scanner = sbom['scanner']
    require(isinstance(scanner.get('version'), str) and bool(scanner['version'])
            and all(isinstance(scanner.get(key), str) and re.fullmatch(r'[a-f0-9]{64}', scanner[key])
                    for key in ('archiveSha256', 'binarySha256')), 'Invalid SBOM scanner provenance')
    require(isinstance(candidate.get('builderSha256'), dict) and bool(candidate['builderSha256'])
            and all(valid_sha(value) for value in candidate['builderSha256'].values()),
            'Missing builder provenance')
    for name, value in release.get('legal', {}).items():
        require(name in ('LICENSE', 'NOTICE') and value == files['legal/UPSTREAM-' + name],
                'Upstream legal binding mismatch')
    return candidate


def inspect_archive(stream, artifact):
    members = []
    total = 0
    # The archive digest is already pinned. Still cap parsing before reading the manifest.
    for member in stream:
        members.append(member)
        total += member.size
        require(len(members) <= MAX_ENTRIES and 0 <= member.size <= MAX_FILE
                and total <= MAX_TOTAL, 'Archive entry or size limit exceeded')
    manifests = [member for member in members if member.name == 'candidate.json']
    require(len(manifests) == 1 and manifests[0].isfile()
            and manifests[0].size <= MAX_JSON, 'Missing or duplicate candidate manifest')
    with stream.extractfile(manifests[0]) as source:
        manifest = source.read(MAX_JSON + 1)
    require(sha(manifest) == artifact['candidateManifestSha256'], 'Candidate manifest checksum mismatch')
    seen = set()
    for member in members:
        name = member.name
        require(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE) and not member.sparse
                and not member.linkname and name in FILES | {'candidate.json'}
                and name not in seen and not name.startswith('/')
                and all(part not in ('', '.', '..') for part in name.split('/'))
                and '\\' not in name, 'Unsafe, duplicate or unexpected archive entry')
        expected_mode = 0o755 if name in BINARIES.values() else 0o644
        require(member.mode == expected_mode, 'Archive mode mismatch')
        require(member.size > 0, 'Empty candidate file')
        seen.add(name)
    require(seen == FILES | {'candidate.json'}, 'Incomplete candidate archive')
    return members, manifest


def verify_content(stream, members, candidate, release):
    metadata = {}
    for member in members:
        with stream.extractfile(member) as source:
            if member.name != 'candidate.json':
                require(hash_stream(source) == candidate['files'][member.name], 'Candidate file checksum mismatch')
            if member.name in BINARIES.values():
                source.seek(0)
                header = source.read(64)
                require(len(header) == 64 and header[:6] == b'\x7fELF\x02\x01'
                        and int.from_bytes(header[16:18], 'little') in (2, 3)
                        and int.from_bytes(header[18:20], 'little') == 183,
                        'Binary is not ELF64 little-endian Linux aarch64')
            elif member.name in ('bundle/codex-package.json', 'source.cdx.json', 'builder-environment.json'):
                require(member.size <= MAX_JSON, 'JSON size limit exceeded')
                source.seek(0)
                metadata[member.name] = json_object(source.read(MAX_JSON + 1))
    require(metadata['bundle/codex-package.json'] == {
        'version': release['provenance']['codexVersion'], 'target': TARGET, 'variant': 'codex'},
        'Codex package metadata mismatch')
    sbom = metadata['source.cdx.json']
    require(sbom.get('bomFormat') == 'CycloneDX' and isinstance(sbom.get('components'), list)
            and bool(sbom['components']), 'Empty or invalid source SBOM')
    environment = metadata['builder-environment.json']
    require(environment.get('system') == 'Linux' and environment.get('machine') in ('aarch64', 'arm64')
            and environment.get('nativeAcceptance') is False
            and all(isinstance(candidate['run'].get(key), str)
                    and re.fullmatch(r'[1-9][0-9]*', candidate['run'][key]) for key in ('id', 'attempt'))
            and environment.get('runId') == candidate['run']['id']
            and environment.get('runAttempt') == candidate['run']['attempt'], 'Builder environment mismatch')


def install(architecture, destination, archive):
    release_raw, release, artifact = pinned_release(architecture)
    destination = Path(os.path.abspath(destination))
    require(not os.path.lexists(destination), 'Installation destination already exists')
    # Decompress into a bounded private tar snapshot; tarfile handles PAX/GNU metadata.
    with tempfile.TemporaryDirectory(prefix='codex-bundle-') as directory:
        tar_path = Path(directory) / 'bundle.tar'
        descriptor = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as source:
            require(stat.S_ISREG(os.fstat(source.fileno()).st_mode)
                    and 0 < os.fstat(source.fileno()).st_size <= MAX_ARCHIVE, 'Invalid archive size or type')
            require(hash_stream(source) == artifact['archiveSha256'], 'Archive checksum mismatch')
            source.seek(0)
            with gzip.GzipFile(fileobj=source) as compressed, tar_path.open('xb') as expanded:
                total = 0
                while chunk := compressed.read(CHUNK):
                    total += len(chunk)
                    require(total <= MAX_TAR, 'Expanded archive size limit exceeded')
                    expanded.write(chunk)
        with tarfile.open(tar_path, 'r:') as stream:
            members, raw = inspect_archive(stream, artifact)
            candidate = candidate_manifest(raw, release, artifact)
            verify_content(stream, members, candidate, release)
            destination.parent.mkdir(parents=True, exist_ok=True)
            stage = Path(tempfile.mkdtemp(prefix='.codex-staging-', dir=destination.parent))
            try:
                for member in members:
                    relative = member.name.removeprefix('bundle/') if member.name.startswith('bundle/') else 'share/' + member.name
                    path = stage / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with stream.extractfile(member) as source, path.open('xb') as output:
                        shutil.copyfileobj(source, output, CHUNK)
                    path.chmod(0o555 if member.name in BINARIES.values() else 0o444)
                (stage / 'share/release.json').write_bytes(release_raw)
                (stage / 'share/release.json').chmod(0o444)
                for path in stage.rglob('*'):
                    if path.is_dir():
                        path.chmod(0o755)
                stage.chmod(0o755)
                require(not os.path.lexists(destination), 'Installation destination already exists')
                stage.rename(destination)
            finally:
                if stage.exists():
                    shutil.rmtree(stage)


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 4, 'usage: install-bundle.py <arm64> <destination> <complete-archive>')
        install(*sys.argv[1:])
    except (ValueError, KeyError, TypeError, OSError, EOFError, tarfile.TarError) as error:
        sys.exit(f'Codex derived installation rejected: {error}')
