#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repository_root"
: "${PLATFORM_LOCAL_DOCKER_CONTEXT:?Set an explicit local Docker context}"
: "${PLATFORM_LOCAL_PROJECT:?Set an isolated Compose project name}"
[[ "$PLATFORM_LOCAL_PROJECT" =~ ^agent-infra-[a-z0-9]+(-[a-z0-9]+)*$ ]] && [[ ${#PLATFORM_LOCAL_PROJECT} -le 35 ]] || {
  echo "PLATFORM_LOCAL_PROJECT must be a hyphenated agent-infra- name of at most 35 characters" >&2
  exit 1
}
docker_target=(docker --context "$PLATFORM_LOCAL_DOCKER_CONTEXT")
docker_endpoint=$("${docker_target[@]}" context inspect "$PLATFORM_LOCAL_DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}')
[[ "$docker_endpoint" == unix://* ]] || {
  echo "Local Platform requires a local Docker socket" >&2
  exit 1
}
compose=("${docker_target[@]}" compose --project-name "$PLATFORM_LOCAL_PROJECT" -f docker-compose.yml -f deploy/local/compose.yaml)
worker_release="$PLATFORM_LOCAL_PROJECT"
worker_deployment="$worker_release-agent-infra-platform-worker"

worker_context() {
  : "${PLATFORM_LOCAL_KUBECONFIG:?Set an explicit local kubeconfig}"
  : "${PLATFORM_LOCAL_KUBE_CONTEXT:?Set an explicit local kind context}"
  : "${PLATFORM_LOCAL_NAMESPACE:?Set an explicit local namespace}"
  [[ "$PLATFORM_LOCAL_KUBECONFIG" = /* && -r "$PLATFORM_LOCAL_KUBECONFIG" ]] || {
    echo "PLATFORM_LOCAL_KUBECONFIG must be an absolute readable file" >&2
    exit 1
  }
  [[ "$PLATFORM_LOCAL_KUBE_CONTEXT" =~ ^kind-[a-z0-9][a-z0-9-]*$ ]] || {
    echo "PLATFORM_LOCAL_KUBE_CONTEXT must name an explicit kind context" >&2
    exit 1
  }
  [[ "$PLATFORM_LOCAL_NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] && [[ ${#PLATFORM_LOCAL_NAMESPACE} -le 63 ]] || {
    echo "PLATFORM_LOCAL_NAMESPACE must be a Kubernetes namespace name" >&2
    exit 1
  }
  local server
  server=$(kubectl --kubeconfig "$PLATFORM_LOCAL_KUBECONFIG" --context "$PLATFORM_LOCAL_KUBE_CONTEXT" config view --minify --output=jsonpath='{.clusters[0].cluster.server}')
  [[ "$server" =~ ^https://(127\.0\.0\.1|\[::1\]):[1-9][0-9]*$ ]] || {
    echo "Local kind API server must use a loopback endpoint" >&2
    exit 1
  }
  helm_target=(helm --kubeconfig "$PLATFORM_LOCAL_KUBECONFIG" --kube-context "$PLATFORM_LOCAL_KUBE_CONTEXT" --namespace "$PLATFORM_LOCAL_NAMESPACE")
  kube_target=(kubectl --kubeconfig "$PLATFORM_LOCAL_KUBECONFIG" --context "$PLATFORM_LOCAL_KUBE_CONTEXT" --namespace "$PLATFORM_LOCAL_NAMESPACE")
}

worker_values() {
  : "${PLATFORM_LOCAL_WORKER_VALUES:?Set an absolute local Worker values file}"
  [[ "$PLATFORM_LOCAL_WORKER_VALUES" = /* && -r "$PLATFORM_LOCAL_WORKER_VALUES" ]] || {
    echo "PLATFORM_LOCAL_WORKER_VALUES must be an absolute readable file" >&2
    exit 1
  }
  worker_options=(
    --values "$PLATFORM_LOCAL_WORKER_VALUES"
    --set workloadTopology.enabled=false
    --set migration.enabled=false
    --set enterpriseDirectorySync.enabled=false
    --set web.placement=external
    --set platformApi.placement=external
  )
}
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
    worker_context
    worker_values
    "${helm_target[@]}" template "$worker_release" deploy/helm/agent-infra "${worker_options[@]}" >/dev/null
    "${compose[@]}" up --detach --wait postgres object-storage platform-api web
    "${helm_target[@]}" upgrade --install "$worker_release" deploy/helm/agent-infra "${worker_options[@]}" --wait --timeout 5m
    "${kube_target[@]}" rollout status "deployment/$worker_deployment" --timeout=5m
    ;;
  status)
    worker_context
    "${compose[@]}" ps postgres object-storage platform-api web
    "${helm_target[@]}" status "$worker_release"
    "${kube_target[@]}" get deployment "$worker_deployment"
    ;;
  stop)
    worker_context
    worker_stop_status=0
    "${helm_target[@]}" uninstall "$worker_release" --ignore-not-found || worker_stop_status=$?
    "${compose[@]}" stop web platform-api object-storage postgres
    exit "$worker_stop_status"
    ;;
  *)
    echo "Usage: bash deploy/local/platform.sh build|data|migrate|up|status|stop" >&2
    exit 1
    ;;
esac
