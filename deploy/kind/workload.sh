#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repository_root"
kind_bin=${KIND_BIN:-kind}
[[ $("$kind_bin" version) == "kind v0.30.0"* ]] || { echo "kind v0.30.0 is required" >&2; exit 1; }
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
  "$kind_bin" delete cluster --name "$cluster_name"
  docker rm --force "$registry_name" >/dev/null 2>&1 || true
  rm -rf "$state_dir"
}
trap cleanup EXIT

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
# Build the original default Host once, from this immutable source only.
export WORKLOAD_SOURCE_COMMIT WORKLOAD_KIND_CONTEXT WORKLOAD_KIND_HOST_IMAGE
WORKLOAD_SOURCE_COMMIT=${WORKLOAD_SOURCE_COMMIT:-$(git rev-parse HEAD)}
[[ "$WORKLOAD_SOURCE_COMMIT" == "$(git rev-parse HEAD)" ]] || { echo "Workload source mismatch" >&2; exit 1; }
WORKLOAD_KIND_CONTEXT="kind-$cluster_name"
export WORKLOAD_KIND_EVIDENCE_DIR
WORKLOAD_KIND_EVIDENCE_DIR=${WORKLOAD_KIND_EVIDENCE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/agent-infra-workload-evidence.XXXXXX")}
mkdir -p "$WORKLOAD_KIND_EVIDENCE_DIR" "$state_dir/source"
git archive "$WORKLOAD_SOURCE_COMMIT" | tar -x -C "$state_dir/source"
docker build --target runner --build-arg "SOURCE_COMMIT=$WORKLOAD_SOURCE_COMMIT" \
  --file "$state_dir/source/apps/agent-runtime-host/Dockerfile" \
  --tag "$WORKLOAD_KIND_REPOSITORY:host" "$state_dir/source"
docker push "$WORKLOAD_KIND_REPOSITORY:host"
WORKLOAD_KIND_HOST_IMAGE=$(docker inspect "$WORKLOAD_KIND_REPOSITORY:host" --format '{{index .RepoDigests 0}}' | awk -F@ '{print $2}')
curl --fail --silent --show-error --max-time 30 \
  -H 'Accept: application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.manifest.v1+json' \
  "http://127.0.0.1:$registry_port/v2/workload/manifests/$WORKLOAD_KIND_HOST_IMAGE" \
  --output "$WORKLOAD_KIND_EVIDENCE_DIR/manifest.json"
config_digest=$(node --input-type=module -e 'import fs from "node:fs"; const m=JSON.parse(fs.readFileSync(process.argv[1])); if(m.schemaVersion!==2 || !/^sha256:[a-f0-9]{64}$/.test(m.config?.digest)) throw Error("Invalid Host manifest"); console.log(m.config.digest)' "$WORKLOAD_KIND_EVIDENCE_DIR/manifest.json")
curl --fail --silent --show-error --max-time 30 \
  "http://127.0.0.1:$registry_port/v2/workload/blobs/$config_digest" \
  --output "$WORKLOAD_KIND_EVIDENCE_DIR/config.json"
node --input-type=module - "$state_dir/source/pnpm-lock.yaml" <<'IMAGE_RECEIPT'
import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {join} from "node:path";
const env=process.env, directory=env.WORKLOAD_KIND_EVIDENCE_DIR;
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const manifestBytes=readFileSync(join(directory,"manifest.json"));
const configBytes=readFileSync(join(directory,"config.json"));
const manifest=JSON.parse(manifestBytes), config=JSON.parse(configBytes);
assert.equal(`sha256:${hash(manifestBytes)}`,env.WORKLOAD_KIND_HOST_IMAGE);
assert.equal(`sha256:${hash(configBytes)}`,manifest.config.digest);
assert.equal(config.config.Labels["org.opencontainers.image.revision"],env.WORKLOAD_SOURCE_COMMIT);
assert.deepEqual(config.config.Cmd,["/bin/sh","./start-runtime-host.sh"]);
writeFileSync(join(directory,"image.json"),JSON.stringify({
  schemaVersion:1,sourceCommit:env.WORKLOAD_SOURCE_COMMIT,
  lockfileSha256:hash(readFileSync(process.argv[2])), imageDigest:env.WORKLOAD_KIND_HOST_IMAGE,
  configDigest:manifest.config.digest, cmd:config.config.Cmd, entrypoint:config.config.Entrypoint,
  runtimeManifest:JSON.parse(config.config.Labels["io.agora.agent.runtime.manifest"]),
  kubeContext:env.WORKLOAD_KIND_CONTEXT, namespace:"workload-test"
},null,2)+"\n");
IMAGE_RECEIPT
"$kind_bin" create cluster --name "$cluster_name" --config deploy/kind/workload-cluster.yaml --kubeconfig "$KUBECONFIG"
docker network connect kind "$registry_name"
for node in $("$kind_bin" get nodes --name "$cluster_name"); do
  docker exec "$node" mkdir -p "/etc/containerd/certs.d/localhost:${registry_port}"
  printf '[host."http://%s:5000"]\n  capabilities = ["pull", "resolve"]\n' "$registry_name" > "$state_dir/hosts.toml"
  docker cp "$state_dir/hosts.toml" "$node:/etc/containerd/certs.d/localhost:${registry_port}/hosts.toml"
  docker exec "$node" crictl pull "$WORKLOAD_KIND_REPOSITORY@$WORKLOAD_KIND_IMAGE_A"
  docker exec "$node" crictl pull "$WORKLOAD_KIND_REPOSITORY@$WORKLOAD_KIND_IMAGE_B"
  docker exec "$node" crictl pull "$WORKLOAD_KIND_REPOSITORY@$WORKLOAD_KIND_HOST_IMAGE"
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
pnpm --filter @agent-infra/platform-worker exec vitest run src/workload.kind.test.ts
