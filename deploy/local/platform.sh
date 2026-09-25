#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repository_root"
: "${PLATFORM_LOCAL_DOCKER_CONTEXT:?Set an explicit local Docker context}"
: "${PLATFORM_LOCAL_PROJECT:?Set an isolated Compose project name}"
[[ "$PLATFORM_LOCAL_PROJECT" =~ ^agent-infra-[a-z0-9][a-z0-9_-]*$ ]] || {
  echo "PLATFORM_LOCAL_PROJECT must start with agent-infra-" >&2
  exit 1
}
docker_target=(docker --context "$PLATFORM_LOCAL_DOCKER_CONTEXT")
docker_endpoint=$("${docker_target[@]}" context inspect "$PLATFORM_LOCAL_DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}')
[[ "$docker_endpoint" == unix://* ]] || {
  echo "Local Platform requires a local Docker socket" >&2
  exit 1
}
compose=("${docker_target[@]}" compose --project-name "$PLATFORM_LOCAL_PROJECT" -f docker-compose.yml -f deploy/local/compose.yaml)
case "${1:-}" in
  build)
    "${compose[@]}" --profile runtime build web platform-api platform-worker agent-runtime-host
    ;;
  data)
    "${compose[@]}" up --detach --wait postgres object-storage
    ;;
  migrate)
    "${compose[@]}" run --rm --no-deps platform-api node node_modules/@agent-infra/platform-store/dist/migrate-cli.mjs
    ;;
  up)
    [[ -f "${PLATFORM_LOCAL_API_DIRECTORY:?}/platform-api.mjs" ]] || { echo "API deployment module platform-api.mjs is missing" >&2; exit 1; }
    [[ -r "${PLATFORM_WEB_TLS_CERT_FILE:?}" && -r "${PLATFORM_WEB_TLS_KEY_FILE:?}" ]] || { echo "Local Web TLS files are missing" >&2; exit 1; }
    "${compose[@]}" up --detach --wait postgres object-storage platform-api web
    ;;
  status)
    "${compose[@]}" ps postgres object-storage platform-api web
    ;;
  stop)
    "${compose[@]}" stop web platform-api object-storage postgres
    ;;
  *)
    echo "Usage: bash deploy/local/platform.sh build|data|migrate|up|status|stop" >&2
    exit 1
    ;;
esac
