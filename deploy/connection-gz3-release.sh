#!/usr/bin/env bash
set -euo pipefail

version=${1:-}
shift || true
publish=false
deploy=false
for option in "$@"; do
  case "$option" in
    --publish) publish=true ;;
    --deploy) deploy=true ;;
    *) echo "Unknown option: $option" >&2; exit 2 ;;
  esac
done

if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: deploy/connection-gz3-release.sh vX.Y.Z [--publish] [--deploy]" >&2
  exit 2
fi

root=$(git rev-parse --show-toplevel)
cd "$root"
git fetch origin connection --prune
connection_sha=$(git rev-parse origin/connection)
head_sha=$(git rev-parse HEAD)
if [[ "$head_sha" != "$connection_sha" ]]; then
  echo "HEAD must equal origin/connection: $connection_sha" >&2
  exit 1
fi

tag_sha=$(git ls-remote --tags --refs origin "refs/tags/$version" | awk '{print $1}')
if [[ -n "$tag_sha" && "$tag_sha" != "$connection_sha" ]]; then
  echo "$version already points to $tag_sha" >&2
  exit 1
fi

previous_ref=$(git ls-remote --tags --refs origin 'refs/tags/v*' | awk '{sub("refs/tags/", "", $2); print $2, $1}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+ ' | grep -v "^${version} " | sort -V | tail -1 || true)
previous_tag=${previous_ref%% *}
previous_sha=${previous_ref##* }
if [[ -n "$previous_ref" ]] && ! git diff --quiet "$previous_sha..$connection_sha" -- migrations/connection; then
  echo "Connection migrations changed since $previous_tag; run the reviewed migration path instead of --no-hooks." >&2
  exit 1
fi

echo "Preflight OK: $version -> $connection_sha (previous: ${previous_tag:-none})"
[[ -n "$previous_tag" ]] || { echo "A previous production tag is required for catalog comparison" >&2; exit 1; }
node .github/scripts/connection-release-guard.mjs --baseline "$previous_tag" | tee /tmp/connection-catalog-diff.txt

if $publish; then
  if [[ -z "$tag_sha" ]]; then
    if git rev-parse -q --verify "refs/tags/$version" >/dev/null; then
      echo "Local $version already exists while the remote tag does not" >&2
      exit 1
    fi
    git tag "$version" "$connection_sha"
    git push origin "$version"
  fi
  run_id=""
  for _ in {1..12}; do
    run_id=$(gh run list --repo AgoraIO-Extensions/agent-infra --workflow publish-ghcr.yml --branch "$version" --limit 1 --json databaseId --jq '.[0].databaseId // empty')
    [[ -n "$run_id" ]] && break
    sleep 5
  done
  [[ -n "$run_id" ]] || { echo "GHCR workflow was not created" >&2; exit 1; }
  gh run watch "$run_id" --repo AgoraIO-Extensions/agent-infra --exit-status
fi

if ! $deploy; then
  echo "Dry run complete. Add --publish and/or --deploy explicitly."
  exit 0
fi

context=guoxianzhe-agora-hci-guangzhou3s
namespace=gz3-agent-connector-prod
release=connection-gz3
chart=${CONNECTION_HELM_CHART:-../helm/agent-infra}
[[ $(kubectl config current-context) == "$context" ]] || { echo "Wrong Kubernetes context" >&2; exit 1; }
[[ -f "$chart/Chart.yaml" ]] || { echo "Helm chart not found: $chart" >&2; exit 1; }

api_image="ghcr.io/agoraio-extensions/agent-infra/connection-api:$version"
web_image="ghcr.io/agoraio-extensions/agent-infra/connection-web:$version"
helm upgrade "$release" "$chart" -n "$namespace" --reuse-values --no-hooks \
  --set-string "images.api=$api_image" --set-string "images.web=$web_image"

deadline=$((SECONDS + 300))
ready=false
while (( SECONDS < deadline )); do
  api_ready=$(kubectl -n "$namespace" get deploy connection-api -o jsonpath='{.status.readyReplicas}')
  web_ready=$(kubectl -n "$namespace" get deploy connection-web -o jsonpath='{.status.readyReplicas}')
  api_desired=$(kubectl -n "$namespace" get deploy connection-api -o jsonpath='{.spec.replicas}')
  web_desired=$(kubectl -n "$namespace" get deploy connection-web -o jsonpath='{.spec.replicas}')
  current_api=$(kubectl -n "$namespace" get deploy connection-api -o jsonpath='{.spec.template.spec.containers[0].image}')
  current_web=$(kubectl -n "$namespace" get deploy connection-web -o jsonpath='{.spec.template.spec.containers[0].image}')
  api_pod_ready=$(kubectl -n "$namespace" get pods -l app.kubernetes.io/name=connection-api -o jsonpath='{range .items[*]}{.spec.containers[0].image}={.status.containerStatuses[0].ready}{"\n"}{end}' | grep -Fxc "$api_image=true" || true)
  web_pod_ready=$(kubectl -n "$namespace" get pods -l app.kubernetes.io/name=connection-web -o jsonpath='{range .items[*]}{.spec.containers[0].image}={.status.containerStatuses[0].ready}{"\n"}{end}' | grep -Fxc "$web_image=true" || true)
  if [[ "$api_ready" == "$api_desired" && "$web_ready" == "$web_desired" && "$current_api" == "$api_image" && "$current_web" == "$web_image" && "$api_pod_ready" == "$api_desired" && "$web_pod_ready" == "$web_desired" ]]; then
    helm -n "$namespace" status "$release"
    kubectl -n "$namespace" get pods \
      -o custom-columns='NAME:.metadata.name,IMAGE:.spec.containers[0].image,READY:.status.containerStatuses[0].ready,RESTARTS:.status.containerStatuses[0].restartCount'
    ready=true
    break
  fi
  sleep 5
done

if ! $ready; then
  kubectl -n "$namespace" get pods -o wide
  echo "Deployment did not become ready within 300 seconds" >&2
  exit 1
fi

node .github/scripts/connection-production-read-verify.mjs \
  | tee /tmp/connection-production-read-result.json
echo "Deployment and real Provider READ acceptance succeeded."
