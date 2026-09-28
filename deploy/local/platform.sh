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
  [[ "$PLATFORM_LOCAL_NAMESPACE" == "$PLATFORM_LOCAL_PROJECT" ]] || {
    echo "PLATFORM_LOCAL_NAMESPACE must match the isolated Compose project" >&2
    exit 1
  }
  local server
  server=$(kubectl --kubeconfig "$PLATFORM_LOCAL_KUBECONFIG" --context "$PLATFORM_LOCAL_KUBE_CONTEXT" config view --minify --output=jsonpath='{.clusters[0].cluster.server}')
  [[ "$server" =~ ^https://(127\.0\.0\.1|\[::1\]):[1-9][0-9]*$ ]] || {
    echo "Local kind API server must use a loopback endpoint" >&2
    exit 1
  }
  local cluster node cluster_label published_api
  cluster=${PLATFORM_LOCAL_KUBE_CONTEXT#kind-}
  node="$cluster-control-plane"
  cluster_label=$("${docker_target[@]}" container inspect "$node" --format '{{index .Config.Labels "io.x-k8s.kind.cluster"}}') || {
    echo "Local kind control-plane is missing from the selected Docker context" >&2
    exit 1
  }
  [[ "$cluster_label" == "$cluster" ]] || {
    echo "Local kind control-plane label does not match the selected context ($cluster_label != $cluster)" >&2
    exit 1
  }
  published_api=$("${docker_target[@]}" port "$node" 6443/tcp) || {
    echo "Local kind API port is not published by the selected Docker context" >&2
    exit 1
  }
  [[ "$published_api" == "${server#https://}" ]] || {
    echo "Kubeconfig API endpoint does not match the local kind control-plane" >&2
    exit 1
  }
  helm_target=(helm --kubeconfig "$PLATFORM_LOCAL_KUBECONFIG" --kube-context "$PLATFORM_LOCAL_KUBE_CONTEXT" --namespace "$PLATFORM_LOCAL_NAMESPACE")
  kube_target=(kubectl --kubeconfig "$PLATFORM_LOCAL_KUBECONFIG" --context "$PLATFORM_LOCAL_KUBE_CONTEXT" --namespace "$PLATFORM_LOCAL_NAMESPACE")
}

ensure_agents_stopped() {
  local active_workloads active_pods
  active_workloads=$("${kube_target[@]}" get statefulsets -l agent-infra.agora.io/agent -o 'jsonpath={range .items[*]}{.metadata.name}{" "}{.spec.replicas}{"\n"}{end}')
  while read -r name replicas; do
    [[ -z "$name" ]] && continue
    [[ "$replicas" == 0 ]] || {
      echo "Stop each Agent and wait for its Workload to scale to zero before stopping Platform" >&2
      return 1
    }
  done <<< "$active_workloads"
  active_pods=$("${kube_target[@]}" get pods -l agent-infra.agora.io/agent -o name)
  [[ -z "$active_pods" ]] || {
    echo "Wait for Agent Pods to terminate before stopping Platform" >&2
    return 1
  }
}

restore_local_services() {
  if ! "${kube_target[@]}" scale "deployment/$worker_deployment" --replicas="$worker_replicas" ||
     ! "${kube_target[@]}" rollout status "deployment/$worker_deployment" --timeout=5m; then
    echo "Worker could not be restored; API and Web remain stopped" >&2
    return 1
  fi
  "${compose[@]}" up --detach --wait platform-api web
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
    worker_replicas=$("${kube_target[@]}" get deployment "$worker_deployment" -o jsonpath='{.spec.replicas}')
    [[ "$worker_replicas" =~ ^[0-9]+$ ]] || { echo "Worker deployment has no valid replica count" >&2; exit 1; }
    "${compose[@]}" stop web platform-api
    if ! "${kube_target[@]}" scale "deployment/$worker_deployment" --replicas=0 ||
       ! "${kube_target[@]}" rollout status "deployment/$worker_deployment" --timeout=5m; then
      restore_local_services || echo "Local services could not be fully restored" >&2
      exit 1
    fi
    if ! worker_pods=$("${kube_target[@]}" get pods -l "app.kubernetes.io/instance=$worker_release,app.kubernetes.io/component=platform-worker" -o name); then
      restore_local_services || echo "Local services could not be fully restored" >&2
      exit 1
    fi
    if [[ -n "$worker_pods" ]]; then
      if ! "${kube_target[@]}" wait --for=delete pod -l "app.kubernetes.io/instance=$worker_release,app.kubernetes.io/component=platform-worker" --timeout=5m; then
        restore_local_services || echo "Local services could not be fully restored" >&2
        exit 1
      fi
    fi
    if ! ensure_agents_stopped || ! "${helm_target[@]}" uninstall "$worker_release" --ignore-not-found --wait --timeout 5m; then
      restore_local_services || echo "Local services could not be fully restored" >&2
      exit 1
    fi
    "${compose[@]}" stop object-storage postgres
    ;;
  *)
    echo "Usage: bash deploy/local/platform.sh build|data|migrate|up|status|stop" >&2
    exit 1
    ;;
esac
