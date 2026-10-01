#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repository_root"
kind_bin=${KIND_BIN:-kind}
[[ $("$kind_bin" version) == "kind v0.30.0"* ]] || { echo "kind v0.30.0 is required" >&2; exit 1; }
formal_chain=${WORKLOAD_KIND_FORMAL_CHAIN:-0}
if [[ $formal_chain == 1 ]]; then
  evidence_dir=${WORKLOAD_KIND_EVIDENCE_DIR:?formal chain evidence directory is required}
  mkdir -p "$evidence_dir"
  export WORKLOAD_KIND_EVIDENCE_DIR="$evidence_dir"
  source_commit=${SOURCE_COMMIT:?formal chain source commit is required}
  : "${AO_SESSION_ID:?formal chain session ID is required}"
  [[ $source_commit =~ ^[a-f0-9]{40}$ && $(git rev-parse HEAD) == "$source_commit" ]]
  [[ ${RUNNER_OS:-} == Linux && ${GITHUB_ACTIONS:-} == true ]]
  printf '%s\n' "$source_commit" > "$evidence_dir/source.txt"
  printf 'not_started\n' > "$evidence_dir/result.txt"
fi
state_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-infra-workload.XXXXXX")
export WORKLOAD_DOCKER_BIN
WORKLOAD_DOCKER_BIN=$(command -v docker)
mkdir "$state_dir/bin"
cp deploy/kind/workload-docker.sh "$state_dir/bin/docker"
chmod +x "$state_dir/bin/docker"
export PATH="$state_dir/bin:$PATH"
cluster_name="workload-${RANDOM}-$$"
registry_name="${cluster_name}-registry"
export KUBECONFIG="$state_dir/kubeconfig"
cleanup() {
  status=$?
  trap - EXIT
  "$kind_bin" delete cluster --name "$cluster_name" || status=1
  docker rm --force "$registry_name" >/dev/null 2>&1 || status=1
  if [[ $formal_chain == 1 ]]; then
    docker ps --all --quiet --filter "label=ao.session=$AO_SESSION_ID" > "$evidence_dir/remaining-before.ids" || status=1
    if [[ -s "$evidence_dir/remaining-before.ids" ]]; then
      status=1
      xargs -r docker rm --force --volumes < "$evidence_dir/remaining-before.ids" > "$evidence_dir/cleanup.log" 2>&1 || status=1
    fi
    docker ps --all --quiet --filter "label=ao.session=$AO_SESSION_ID" > "$evidence_dir/remaining-after.ids" || status=1
    if [[ -s "$evidence_dir/remaining-after.ids" ]]; then status=1; fi
  fi
  rm -rf "$state_dir" || status=1
  if [[ $formal_chain == 1 ]]; then
    printf '%s\n' "$status" > "$evidence_dir/exit-code.txt"
  fi
  exit "$status"
}
trap cleanup EXIT

check_capacity() {
  local stage=$1
  docker info --format '{{json .}}' > "$evidence_dir/daemon.json"
  local docker_root
  docker_root=$(jq -r '.DockerRootDir // empty' "$evidence_dir/daemon.json")
  [[ -n $docker_root && -d $docker_root ]]
  df -Pk "$docker_root" > "$evidence_dir/capacity-${stage}.txt"
  local available_kib
  available_kib=$(awk 'NR==2 {print $4}' "$evidence_dir/capacity-${stage}.txt")
  (( available_kib >= 5242880 ))
}
if [[ $formal_chain == 1 ]]; then
  check_capacity before-build
fi

docker run --detach --rm --label "ao.session=${AO_SESSION_ID:-workload-kind}" \
  --name "$registry_name" --publish 127.0.0.1::5000 registry:2.8.3 >/dev/null
registry_port=$(docker port "$registry_name" 5000/tcp | awk -F: '{print $NF}')
export WORKLOAD_KIND_REPOSITORY="localhost:${registry_port}/workload"
for version in A B; do
  docker build --build-arg "VERSION=$version" --tag "$WORKLOAD_KIND_REPOSITORY:$version" tests/fixtures/workload
  docker push "$WORKLOAD_KIND_REPOSITORY:$version"
done
export WORKLOAD_KIND_IMAGE_A
export WORKLOAD_KIND_IMAGE_B
WORKLOAD_KIND_IMAGE_A=$(docker inspect "$WORKLOAD_KIND_REPOSITORY:A" --format '{{index .RepoDigests 0}}' | awk -F@ '{print $2}')
WORKLOAD_KIND_IMAGE_B=$(docker inspect "$WORKLOAD_KIND_REPOSITORY:B" --format '{{index .RepoDigests 0}}' | awk -F@ '{print $2}')
if [[ $formal_chain == 1 ]]; then
  export WORKLOAD_KIND_RUNTIME_REPOSITORY="localhost:${registry_port}/runtime-host"
  runtime_reference="$WORKLOAD_KIND_RUNTIME_REPOSITORY:$source_commit"
  mkdir "$state_dir/runtime-source"
  git archive "$source_commit" | tar -x -C "$state_dir/runtime-source"
  lockfile_hash=$(shasum -a 256 "$state_dir/runtime-source/pnpm-lock.yaml" | awk '{print $1}')
  date -u +%FT%TZ > "$evidence_dir/runtime-build-started.txt"
  docker build --target runner --file "$state_dir/runtime-source/apps/agent-runtime-host/Dockerfile" \
    --build-arg "SOURCE_COMMIT=$source_commit" \
    --label "agent-infra.lockfile-sha256=$lockfile_hash" \
    --tag "$runtime_reference" "$state_dir/runtime-source" > "$evidence_dir/runtime-build.log" 2>&1
  date -u +%FT%TZ > "$evidence_dir/runtime-build-finished.txt"
  docker push "$runtime_reference" > "$evidence_dir/runtime-push.log" 2>&1
  export WORKLOAD_KIND_RUNTIME_IMAGE
  WORKLOAD_KIND_RUNTIME_IMAGE=$(docker inspect "$runtime_reference" --format '{{index .RepoDigests 0}}' | awk -F@ '{print $2}')
  [[ $WORKLOAD_KIND_RUNTIME_IMAGE =~ ^sha256:[a-f0-9]{64}$ ]]
  docker image inspect "$runtime_reference" > "$evidence_dir/runtime-image-inspect.json"
  export TRIVY_TOOL_DIR="$state_dir/trivy-tool"
  node .github/scripts/install-trivy.mjs "$TRIVY_TOOL_DIR" > "$evidence_dir/scanner-install.log" 2>&1
  node --input-type=module - "$evidence_dir" <<'NODE'
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { approvedExceptions, scanImages, source } from './.github/scripts/vulnerability-scan.mjs';
import { evaluate, sha256, validateReport } from './.github/scripts/vulnerability-policy.mjs';

const directory = process.argv[2];
const expected = await source();
assert.equal(expected.commit, process.env.SOURCE_COMMIT);
const [image] = JSON.parse(await readFile(join(directory, 'runtime-image-inspect.json'), 'utf8'));
const repository = process.env.WORKLOAD_KIND_RUNTIME_REPOSITORY;
const digest = process.env.WORKLOAD_KIND_RUNTIME_IMAGE;
assert.match(repository, /^localhost:[1-9][0-9]*\/runtime-host$/);
assert.match(digest, /^sha256:[a-f0-9]{64}$/);
assert.ok(image.RepoDigests.includes(`${repository}@${digest}`));
assert.equal(image.Config.Labels['org.opencontainers.image.revision'], expected.commit);
assert.equal(image.Config.Labels['agent-infra.lockfile-sha256'], expected.lockfileSha256);
assert.equal(image.Config.User, 'node');
assert.equal(image.Config.WorkingDir, '/app');
assert.deepEqual(image.Config.Entrypoint, ['docker-entrypoint.sh']);
assert.deepEqual(image.Config.Cmd, ['/bin/sh', './start-runtime-host.sh']);

// Preserve original registry response bytes; derived inspect JSON is not an OCI blob.
const raw = {};
async function registryBytes(kind, digest, file) {
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  const response = await fetch(`http://${repository.replace('/runtime-host', '')}/v2/runtime-host/${kind}/${digest}`, {
    headers: { Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' },
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(`sha256:${sha256(bytes)}`, digest);
  await writeFile(join(directory, file), bytes);
  raw[file] = { path: file, sha256: sha256(bytes) };
  return JSON.parse(bytes.toString('utf8'));
}
let resolvedManifestDigest = digest;
let manifest = await registryBytes('manifests', digest, 'runtime-manifest.json');
if (manifest.manifests) {
  const matches = manifest.manifests.filter(({ platform }) => platform?.os === image.Os && platform?.architecture === image.Architecture);
  assert.equal(matches.length, 1);
  resolvedManifestDigest = matches[0].digest;
  manifest = await registryBytes('manifests', resolvedManifestDigest, 'runtime-selected-manifest.json');
}
assert.equal(manifest.config.digest, image.Id);
const config = await registryBytes('blobs', manifest.config.digest, 'runtime-config.json');
assert.deepEqual(config.rootfs.diff_ids, image.RootFS.Layers);
for (const key of ['User', 'Entrypoint', 'Cmd', 'WorkingDir', 'Env', 'Labels']) {
  assert.deepEqual(config.config[key], image.Config[key]);
}
const target = { name: 'agent-runtime-host', imageId: image.Id, diffIds: image.RootFS.Layers, os: image.Os, architecture: image.Architecture };
const reportDirectory = join(directory, 'runtime-scan');
const scan = await scanImages({ expected, images: [target], includeLockfile: true, reportDirectory });
assert.deepEqual(scan.errors, []);
assert.equal(scan.reports.length, 2);
const findings = [];
for (const report of scan.reports) {
  const bytes = await readFile(join(reportDirectory, report.file));
  assert.equal(sha256(bytes), report.sha256);
  findings.push(...validateReport(JSON.parse(bytes), report, expected));
}
const results = evaluate(findings, await approvedExceptions());
const blocked = results.filter((finding) => finding.blocked).length;
const passed = blocked === 0;
const policy = process.env.GITHUB_EVENT_NAME === 'pull_request' ? 'advisory' : 'strict';
const gatePassed = policy === 'advisory' || passed;
const verdict = { scope: 'same-head kind Runtime image and complete lockfile only', source: expected, passed, gatePassed, policy, blocked, findings: results, registryAdmissionAccepted: false };
await writeFile(join(directory, 'runtime-scan-verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`);
await writeFile(join(directory, 'runtime-image.json'), `${JSON.stringify({
  sourceCommit: expected.commit, repository, manifestDigest: digest, resolvedManifestDigest,
  configDigest: manifest.config.digest, imageId: image.Id, labels: image.Config.Labels,
  command: image.Config.Cmd, entrypoint: image.Config.Entrypoint, workingDirectory: image.Config.WorkingDir,
  user: image.Config.User, os: image.Os, architecture: image.Architecture, diffIds: image.RootFS.Layers, raw,
  scan: { verdictPath: 'runtime-scan-verdict.json', passed, gatePassed, blocked }, registryAdmissionAccepted: false,
}, null, 2)}\n`);
assert.ok(gatePassed, 'same-head Runtime vulnerability policy failed');
NODE
  check_capacity after-build
fi
"$kind_bin" create cluster --name "$cluster_name" --config deploy/kind/workload-cluster.yaml --kubeconfig "$KUBECONFIG"
docker network connect kind "$registry_name"
for node in $("$kind_bin" get nodes --name "$cluster_name"); do
  docker exec "$node" mkdir -p "/etc/containerd/certs.d/localhost:${registry_port}"
  printf '[host."http://%s:5000"]\n  capabilities = ["pull", "resolve"]\n' "$registry_name" > "$state_dir/hosts.toml"
  docker cp "$state_dir/hosts.toml" "$node:/etc/containerd/certs.d/localhost:${registry_port}/hosts.toml"
  docker exec "$node" crictl pull "$WORKLOAD_KIND_REPOSITORY@$WORKLOAD_KIND_IMAGE_A"
  docker exec "$node" crictl pull "$WORKLOAD_KIND_REPOSITORY@$WORKLOAD_KIND_IMAGE_B"
  if [[ $formal_chain == 1 ]]; then
    docker exec "$node" crictl pull "$WORKLOAD_KIND_RUNTIME_REPOSITORY@$WORKLOAD_KIND_RUNTIME_IMAGE"
  fi
done
curl --fail --silent --show-error --connect-timeout 10 --max-time 30 \
  https://raw.githubusercontent.com/projectcalico/calico/3302e8bfd48e6375013d1d79ccb2c693306400a9/manifests/calico.yaml \
  --output "$state_dir/calico.yaml" || \
  curl --fail --silent --show-error --connect-timeout 10 --max-time 30 \
    -H 'Accept: application/vnd.github.raw+json' \
    'https://api.github.com/repos/projectcalico/calico/contents/manifests/calico.yaml?ref=3302e8bfd48e6375013d1d79ccb2c693306400a9' \
    --output "$state_dir/calico.yaml"
printf '%s  %s\n' \
  9382d2b27a76f40c170454b408653e6d71e2205ef0aef069e942bb690e7381d0 \
  "$state_dir/calico.yaml" | shasum -a 256 --check --status
kubectl create --request-timeout=60s -f "$state_dir/calico.yaml"
kubectl rollout status daemonset/calico-node --namespace kube-system --timeout=300s
kubectl wait nodes --all --for=condition=Ready --timeout=300s
export WORKLOAD_KIND_TEST=1
if [[ $formal_chain == 1 ]]; then
  check_capacity before-test
  printf 'running\n' > "$evidence_dir/result.txt"
  pnpm --filter @agent-infra/platform-worker exec vitest run src/workload.kind.test.ts \
    --maxWorkers=1 --no-file-parallelism --cache=false --reporter=json \
    --outputFile="$evidence_dir/tests.json" > "$evidence_dir/tests.log" 2>&1
  node --input-type=module - "$evidence_dir" "$source_commit" <<'NODE'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [directory, source] = process.argv.slice(2);
const tests = JSON.parse(await readFile(`${directory}/tests.json`, 'utf8'));
assert.equal(tests.success, true);
assert.equal(tests.numPendingTests, 0);
assert.equal(tests.numPassedTests, tests.numTotalTests);
const receipt = JSON.parse(await readFile(`${directory}/formal-chain.json`, 'utf8'));
assert.equal(receipt.sourceCommit, source);
assert.equal(receipt.registryAdmissionAccepted, false);
NODE
  printf 'passed\n' > "$evidence_dir/result.txt"
else
  pnpm --filter @agent-infra/platform-worker exec vitest run src/workload.kind.test.ts
fi
