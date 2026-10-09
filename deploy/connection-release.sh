#!/usr/bin/env bash
set -euo pipefail

version=${1:-}
shift || true
publish=false
deploy=false
kubeconfig=${CONNECTION_KUBECONFIG:-}
while (( $# )); do
  case "$1" in
    --publish) publish=true; shift ;;
    --deploy) deploy=true; shift ;;
    --kubeconfig) kubeconfig=${2:?--kubeconfig requires a file}; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ ! "$version" =~ ^connection-v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: deploy/connection-release.sh connection-vX.Y.Z [--publish] [--deploy] [--kubeconfig FILE]" >&2
  exit 2
fi

root=$(git rev-parse --show-toplevel)
cd "$root"
[[ -z $(git status --porcelain) ]] || { echo "Use a clean release worktree" >&2; exit 1; }
if $deploy && [[ -z "$kubeconfig" ]]; then
  echo "Shanghai deployment requires --kubeconfig or CONNECTION_KUBECONFIG" >&2
  exit 1
fi
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

previous_ref=$(git ls-remote --tags --refs origin 'refs/tags/connection-v*' | awk '{sub("refs/tags/", "", $2); print $2, $1}' | grep -E '^connection-v[0-9]+\.[0-9]+\.[0-9]+ ' | grep -v "^${version} " | sort -V | tail -1 || true)
previous_tag=${previous_ref%% *}
previous_sha=${previous_ref##* }
if [[ -n "$previous_ref" ]] && ! git diff --quiet "$previous_sha..$connection_sha" -- migrations/connection; then
  echo "Connection migrations changed since $previous_tag; use the reviewed migration path before deploying." >&2
  exit 1
fi

echo "Preflight OK: $version -> $connection_sha (previous: ${previous_tag:-none})"
[[ -n "$previous_tag" ]] || { echo "A previous production tag is required for catalog comparison" >&2; exit 1; }
[[ $(printf '%s\n' "$version" "$previous_tag" | sort -V | tail -1) == "$version" ]] || { echo "Choose a release newer than $previous_tag" >&2; exit 1; }
if ! catalog_diff=$(node .github/scripts/connection-release-guard.mjs --baseline "$previous_tag"); then
  echo "Connection catalog guard failed" >&2
  exit 1
fi
printf '%s\n' "$catalog_diff"
if [[ -n "$kubeconfig" ]]; then
  node deploy/connection-shanghai-release.mjs --preflight "$version" "$kubeconfig"
fi

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

node deploy/connection-shanghai-release.mjs --deploy "$version" "$kubeconfig"
