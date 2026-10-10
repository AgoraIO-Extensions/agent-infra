#!/usr/bin/env bash
set -euo pipefail
application=${1:?application required}
subject=${2:?subject file required}
case "$application" in connection-api|connection-web) ;; *) exit 2 ;; esac
[[ ${GITHUB_REPOSITORY_ID:-} == 1316991471 && ${GITHUB_REPOSITORY:-} == AgoraIO-Extensions/agent-infra && ${GITHUB_EVENT_NAME:-} == push ]]
[[ ${GITHUB_REF:-} =~ ^refs/tags/connection-v[0-9]+\.[0-9]+\.[0-9]+$ ]]
git fetch origin connection --prune
[[ $(git rev-parse HEAD) == "$GITHUB_SHA" && $(git rev-parse origin/connection) == "$GITHUB_SHA" ]]

directory="build-evidence/signed/$application"
mkdir -p "$directory"
ref=$(node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1])); process.stdout.write(s.image+"@"+s.digest)' "$subject")
node deploy/connection-supply-chain.mjs subject "$application" "$GITHUB_REF_NAME" "$GITHUB_SHA" "${ref##*@}" > "$directory/expected-subject.json"
cmp "$subject" "$directory/expected-subject.json"
docker pull "$ref" > /dev/null
container=$(docker create "$ref")
trap 'docker rm "$container" > /dev/null' EXIT
if [[ "$application" == connection-api ]]; then
  docker cp "$container:/app/third-party/build-evidence/bundle-inventory.json" "$directory/bundle-inventory.json"
  docker cp "$container:/usr/local/bin/node" "$directory/node-runtime"
  runtime_sha=$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).buildRuntime.sha256)' "$directory/bundle-inventory.json")
  echo "$runtime_sha  $directory/node-runtime" | sha256sum --check
  mkdir -p "$directory/kernel"
  docker cp "$container:/app/third-party/openconnector-kernel/." "$directory/kernel/"
  for file in LICENSE.txt NOTICE.md PROVENANCE.json; do
    cmp "packages/openconnector-kernel/$file" "$directory/kernel/$file"
  done
else
  docker cp "$container:/usr/share/connection-evidence/bundle-inventory.json" "$directory/bundle-inventory.json"
fi
if ! syft "registry:$ref" --scope squashed -o "cyclonedx-json=$directory/image.cdx.json" > /dev/null 2>&1; then
  echo "Final image SBOM scan failed" >&2
  exit 1
fi
node deploy/connection-supply-chain.mjs prepare "$subject" "$directory/image.cdx.json" "$directory/bundle-inventory.json" "$directory"
signing_cosign() {
  if ! cosign "$@" > /dev/null 2>&1; then
    echo "Connection signature operation failed" >&2
    return 1
  fi
}
signing_cosign sign --yes --oidc-provider github-actions "$ref"
signing_cosign sign-blob --yes --oidc-provider github-actions --bundle "$directory/manifest.sigstore.json" "$directory/manifest.json"
signing_cosign sign-blob --yes --oidc-provider github-actions --bundle "$directory/sbom.sigstore.json" "$directory/sbom.cdx.json"
node deploy/connection-supply-chain.mjs pack "$directory"
signing_cosign attest --yes --oidc-provider github-actions --type https://agent-infra.agoralab.co/connection/release-evidence/v1 --predicate "$directory/evidence.json" "$ref"
node deploy/connection-supply-chain.mjs verify "$subject"
