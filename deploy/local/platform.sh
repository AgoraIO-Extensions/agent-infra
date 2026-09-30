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
local_state_root=${PLATFORM_LOCAL_STATE_DIRECTORY:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-infra/local}
[[ "$local_state_root" = /* ]] || {
  echo "PLATFORM_LOCAL_STATE_DIRECTORY must be an absolute path" >&2
  exit 1
}
export PLATFORM_LOCAL_NGINX_CONFIG="$local_state_root/$PLATFORM_LOCAL_PROJECT/nginx.conf"
export PLATFORM_LOCAL_PROXY_RUNTIME_TOKEN_FILE="$local_state_root/$PLATFORM_LOCAL_PROJECT/proxy-token"
docker_target=(docker --context "$PLATFORM_LOCAL_DOCKER_CONTEXT")
docker_endpoint=$("${docker_target[@]}" context inspect "$PLATFORM_LOCAL_DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}')
[[ "$docker_endpoint" == unix://* ]] || {
  echo "Local Platform requires a local Docker socket" >&2
  exit 1
}
compose=("${docker_target[@]}" compose --project-name "$PLATFORM_LOCAL_PROJECT" -f docker-compose.yml -f deploy/local/compose.yaml)
worker_release="$PLATFORM_LOCAL_PROJECT"
worker_deployment="$worker_release-agent-infra-platform-worker"
database_service="$worker_release-postgres"
database_endpoint="$database_service-docker"
helm_target=(helm)

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
  if [[ "$worker_replicas" == 0 ]]; then
    echo "Worker had zero replicas; API and Web remain stopped" >&2
    return 1
  fi
  if ! "${kube_target[@]}" scale "deployment/$worker_deployment" --replicas="$worker_replicas" ||
     ! "${kube_target[@]}" rollout status "deployment/$worker_deployment" --timeout=5m; then
    echo "Worker could not be restored; API and Web remain stopped" >&2
    return 1
  fi
  "${compose[@]}" up --detach --wait platform-api web
}

abort_stop() {
  restore_local_services || echo "Local services could not be fully restored" >&2
  exit 1
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
    --set-string "database.secretRef.name=$database_service"
    --set-string database.secretRef.key=url
    --set-string platformWorker.deploymentModule=file:///app/dist/deployment.mjs
  )
}

validate_deployment_material() {
  : "${PLATFORM_LOCAL_API_DIRECTORY:?Set the API-only deployment directory}"
  : "${PLATFORM_LOCAL_WORKER_VALUES:?Set an absolute local Worker values file}"
  [[ "$PLATFORM_LOCAL_API_DIRECTORY" = /* && -r "$PLATFORM_LOCAL_API_DIRECTORY/configuration.mjs" ]] || {
    echo "API configuration.mjs is missing or unreadable" >&2
    return 1
  }
  [[ "$PLATFORM_LOCAL_WORKER_VALUES" = /* && -r "$PLATFORM_LOCAL_WORKER_VALUES" ]] || {
    echo "PLATFORM_LOCAL_WORKER_VALUES must be an absolute readable file" >&2
    return 1
  }
  if ! node --check "$PLATFORM_LOCAL_API_DIRECTORY/configuration.mjs" >/dev/null 2>&1; then
    echo "Local API configuration.mjs has invalid syntax" >&2
    return 1
  fi
  worker_values
  if ! "${helm_target[@]}" template "$worker_release" deploy/helm/agent-infra "${worker_options[@]}" >/dev/null 2>&1; then
    echo "Local Worker values are missing or invalid" >&2
    return 1
  fi
}

render_proxy_config() {
  [[ "${PLATFORM_LOCAL_PROXY_TOKEN_FILE:?Set the private local proxy token file}" = /* && -r "$PLATFORM_LOCAL_PROXY_TOKEN_FILE" ]] || {
    echo "PLATFORM_LOCAL_PROXY_TOKEN_FILE must be an absolute readable file" >&2
    return 1
  }
  node deploy/local/render-nginx.ts "$PLATFORM_LOCAL_PROXY_TOKEN_FILE" "$PLATFORM_LOCAL_NGINX_CONFIG"
}

check_database_resource_ownership() {
  local resource name
  for resource in service endpointslice secret; do
    case "$resource" in
      service|secret) name="$database_service" ;;
      endpointslice) name="$database_endpoint" ;;
    esac
    if ! "${kube_target[@]}" get "$resource/$name" --ignore-not-found -o json |
      node -e '
        let input = "";
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", () => {
          if (!input.trim()) return;
          try {
            const labels = JSON.parse(input).metadata?.labels ?? {};
            if (labels["app.kubernetes.io/managed-by"] !== "agent-infra-local" ||
                labels["agent-infra.agora.io/local-project"] !== process.argv[1]) process.exitCode = 1;
          } catch {
            process.exitCode = 1;
          }
        });
      ' "$PLATFORM_LOCAL_PROJECT"; then
      echo "Local database $resource/$name is not owned by this project" >&2
      return 1
    fi
  done
}

database_network_aliases() {
  "${docker_target[@]}" container inspect "$1" --format '{{with index .NetworkSettings.Networks "kind"}}{{join .Aliases " "}}{{end}}'
}

database_route_alias() {
  "${kube_target[@]}" get "endpointslice/$database_endpoint" --ignore-not-found -o json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      if (!input.trim()) return;
      try {
        const resource = JSON.parse(input);
        const labels = resource.metadata?.labels ?? {};
        const alias = resource.metadata?.annotations?.["agent-infra.agora.io/local-network-alias"];
        if (labels["app.kubernetes.io/managed-by"] !== "agent-infra-local" ||
            labels["agent-infra.agora.io/local-project"] !== process.argv[1] ||
            typeof alias !== "string" ||
            !new RegExp("^" + process.argv[2] + "-[0-9a-f]{16}$").test(alias)) process.exitCode = 1;
        else process.stdout.write(alias);
      } catch {
        process.exitCode = 1;
      }
    });
  ' "$PLATFORM_LOCAL_PROJECT" "$database_service"
}

check_database_network_ownership() {
  local container aliases owned_alias
  container=$("${compose[@]}" ps --all -q postgres)
  [[ -n "$container" ]] || return 0
  aliases=$(database_network_aliases "$container")
  if [[ -n "$aliases" ]]; then
    owned_alias=$(database_route_alias) || {
      echo "Local PostgreSQL kind connection has no owned route marker" >&2
      return 1
    }
    if [[ -z "$owned_alias" || "$aliases" != "$owned_alias" ]]; then
      echo "Local PostgreSQL is connected to kind outside this project" >&2
      return 1
    fi
  fi
}

connect_worker_database() {
  local container database_ip aliases network_alias
  container=$("${compose[@]}" ps -q postgres)
  [[ -n "$container" ]] || { echo "Local PostgreSQL container is missing" >&2; return 1; }
  aliases=$(database_network_aliases "$container")
  if [[ -z "$aliases" ]]; then
    network_alias="$database_service-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
    "${docker_target[@]}" network connect --alias "$network_alias" kind "$container"
  else
    network_alias=$(database_route_alias)
    [[ "$aliases" == "$network_alias" ]] || {
      echo "Local PostgreSQL is connected to kind outside this project" >&2
      return 1
    }
  fi
  database_ip=$("${docker_target[@]}" container inspect "$container" --format '{{(index .NetworkSettings.Networks "kind").IPAddress}}')
  [[ "$database_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "Local PostgreSQL has no IPv4 address on the kind network" >&2
    return 1
  }
  "${kube_target[@]}" apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: $database_service
  labels:
    app.kubernetes.io/managed-by: agent-infra-local
    agent-infra.agora.io/local-project: $PLATFORM_LOCAL_PROJECT
spec:
  ports:
    - name: postgres
      port: 5432
      targetPort: 5432
      protocol: TCP
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: $database_endpoint
  labels:
    app.kubernetes.io/managed-by: agent-infra-local
    agent-infra.agora.io/local-project: $PLATFORM_LOCAL_PROJECT
    kubernetes.io/service-name: $database_service
    endpointslice.kubernetes.io/managed-by: agent-infra-local
  annotations:
    agent-infra.agora.io/local-network-alias: $network_alias
addressType: IPv4
ports:
  - name: postgres
    port: 5432
    protocol: TCP
endpoints:
  - addresses: ["$database_ip"]
    conditions:
      ready: true
EOF
  "${compose[@]}" config --format json | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const source = new URL(JSON.parse(input).services["platform-api"].environment.PLATFORM_DATABASE_URL);
        if (source.hostname !== "postgres" || source.port !== "5432" || source.protocol !== "postgresql:") {
          throw new Error("unexpected database target");
        }
        source.hostname = process.argv[1];
        process.stdout.write(JSON.stringify({
          apiVersion: "v1", kind: "Secret", type: "Opaque",
          metadata: { name: process.argv[2], labels: {
            "app.kubernetes.io/managed-by": "agent-infra-local",
            "agent-infra.agora.io/local-project": process.argv[3],
          } },
          data: { url: Buffer.from(source.toString()).toString("base64") },
        }));
      } catch {
        console.error("Local API database URL is invalid or does not target Compose postgres:5432");
        process.exitCode = 1;
      }
    });
  ' "$database_service.$PLATFORM_LOCAL_NAMESPACE.svc.cluster.local" "$database_service" "$PLATFORM_LOCAL_PROJECT" |
    "${kube_target[@]}" apply --server-side --field-manager=agent-infra-local -f -
}

disconnect_worker_database() {
  local container aliases
  check_database_resource_ownership
  check_database_network_ownership
  container=$("${compose[@]}" ps --all -q postgres)
  if [[ -n "$container" ]]; then
    aliases=$(database_network_aliases "$container")
    if [[ -n "$aliases" ]]; then
      "${docker_target[@]}" network disconnect kind "$container"
    fi
  fi
  "${kube_target[@]}" delete "endpointslice/$database_endpoint" "service/$database_service" "secret/$database_service" --ignore-not-found
}

delete_owned_agent_pvcs() {
  local names name
  [[ -n "${PLATFORM_LOCAL_AGENT_PVC_NAMES:-}" ]] || return 0
  IFS=',' read -r -a names <<< "$PLATFORM_LOCAL_AGENT_PVC_NAMES"
  for name in "${names[@]}"; do
    [[ "$name" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#name} -le 63 ]] || {
      echo "PLATFORM_LOCAL_AGENT_PVC_NAMES contains an invalid PVC name" >&2
      return 1
    }
    if ! "${kube_target[@]}" get "pvc/$name" --ignore-not-found -o json |
      node -e '
        const { createHash } = require("node:crypto");
        let input = "";
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", () => {
          try {
            const pvc = JSON.parse(input);
            const metadata = pvc.metadata ?? {};
            const labels = metadata.labels ?? {};
            const annotations = metadata.annotations ?? {};
            const agentId = annotations["agent-infra.agora.io/agent-id"];
            const agentName = typeof agentId === "string"
              ? `agent-${createHash("sha256").update(agentId).digest("hex").slice(0, 32)}`
              : "";
            const ownerReferences = Array.isArray(metadata.ownerReferences)
              ? metadata.ownerReferences
              : [];
            if (pvc.kind !== "PersistentVolumeClaim" ||
                metadata.name !== process.argv[1] ||
                metadata.namespace !== process.argv[2] ||
                metadata.name !== `${agentName}-data` ||
                labels["agent-infra.agora.io/agent"] !== agentName ||
                !ownerReferences.some((owner) =>
                  owner?.apiVersion?.startsWith("apps/") &&
                  owner.kind === "StatefulSet" &&
                  owner.name === agentName &&
                  owner.controller === true)) process.exitCode = 1;
          } catch {
            process.exitCode = 1;
          }
        });
      ' "$name" "$PLATFORM_LOCAL_NAMESPACE"; then
      echo "Refusing to delete an unowned Agent PVC: $name" >&2
      return 1
    fi
  done
  for name in "${names[@]}"; do
    "${kube_target[@]}" delete "pvc/$name" --wait --timeout=5m
  done
}

case "${1:-}" in
  build)
    "${compose[@]}" --profile runtime build web platform-api platform-worker agent-runtime-host
    ;;
  data)
    "${compose[@]}" up --detach --wait postgres object-storage
    ;;
  migrate)
    render_proxy_config
    "${compose[@]}" run --rm --no-deps platform-api node node_modules/@agent-infra/platform-store/dist/migrate-cli.mjs
    ;;
  up)
    [[ -r "${PLATFORM_WEB_TLS_CERT_FILE:?}" && -r "${PLATFORM_WEB_TLS_KEY_FILE:?}" ]] || { echo "Local Web TLS files are missing" >&2; exit 1; }
    worker_context
    check_database_resource_ownership
    check_database_network_ownership
    validate_deployment_material
    render_proxy_config
    "${compose[@]}" stop web platform-api
    "${compose[@]}" up --detach --wait postgres object-storage
    connect_worker_database
    "${helm_target[@]}" upgrade --install "$worker_release" deploy/helm/agent-infra "${worker_options[@]}" --wait --timeout 5m
    worker_replicas=$("${helm_target[@]}" get values "$worker_release" --all --output json | node -e '
      try {
        const replicas = JSON.parse(require("node:fs").readFileSync(0, "utf8")).platformWorker.replicas;
        if (!Number.isInteger(replicas) || replicas < 1) throw new Error();
        process.stdout.write(String(replicas));
      } catch {
        console.error("Local Worker replica count is invalid");
        process.exitCode = 1;
      }
    ')
    "${kube_target[@]}" scale "deployment/$worker_deployment" --replicas="$worker_replicas"
    "${kube_target[@]}" rollout status "deployment/$worker_deployment" --timeout=5m
    "${compose[@]}" up --detach --wait --force-recreate --no-deps platform-api
    if ! node deploy/local/check-api-auth.ts "$PLATFORM_LOCAL_PROXY_RUNTIME_TOKEN_FILE" "${PLATFORM_LOCAL_API_PORT:-3000}" "${PLATFORM_LOCAL_WEB_PORT:-3001}"; then
      "${compose[@]}" stop platform-api
      echo "Local API login boundary is unavailable; Web remains stopped" >&2
      exit 1
    fi
    "${compose[@]}" up --detach --wait --force-recreate --no-deps web
    ;;
  status)
    worker_context
    "${compose[@]}" ps postgres object-storage platform-api web
    "${helm_target[@]}" status "$worker_release"
    "${kube_target[@]}" get deployment "$worker_deployment"
    "${kube_target[@]}" get "service/$database_service" "endpointslice/$database_endpoint" "secret/$database_service"
    ;;
  stop)
    worker_context
    check_database_resource_ownership
    check_database_network_ownership
    worker_replicas=$("${kube_target[@]}" get deployment "$worker_deployment" --ignore-not-found -o jsonpath='{.spec.replicas}')
    if [[ -z "$worker_replicas" ]]; then
      existing_release=$("${helm_target[@]}" list --all --filter "^${worker_release}$" -q)
      if [[ -n "$existing_release" ]]; then
        echo "Worker release exists without its Deployment" >&2
        exit 1
      fi
      ensure_agents_stopped
      "${compose[@]}" stop web platform-api
      disconnect_worker_database
      "${compose[@]}" stop object-storage postgres
      rm -f "$PLATFORM_LOCAL_NGINX_CONFIG" "$PLATFORM_LOCAL_PROXY_RUNTIME_TOKEN_FILE"
      exit 0
    fi
    [[ "$worker_replicas" =~ ^[0-9]+$ ]] || { echo "Worker deployment has no valid replica count" >&2; exit 1; }
    "${compose[@]}" stop web platform-api
    if ! "${kube_target[@]}" scale "deployment/$worker_deployment" --replicas=0 ||
       ! "${kube_target[@]}" rollout status "deployment/$worker_deployment" --timeout=5m; then
      abort_stop
    fi
    if ! worker_pods=$("${kube_target[@]}" get pods -l "app.kubernetes.io/instance=$worker_release,app.kubernetes.io/component=platform-worker" -o name); then
      abort_stop
    fi
    if [[ -n "$worker_pods" ]]; then
      if ! "${kube_target[@]}" wait --for=delete pod -l "app.kubernetes.io/instance=$worker_release,app.kubernetes.io/component=platform-worker" --timeout=5m; then
        abort_stop
      fi
    fi
    if ! ensure_agents_stopped || ! "${helm_target[@]}" uninstall "$worker_release" --ignore-not-found --wait --timeout 5m; then
      abort_stop
    fi
    disconnect_worker_database
    "${compose[@]}" stop object-storage postgres
    rm -f "$PLATFORM_LOCAL_NGINX_CONFIG" "$PLATFORM_LOCAL_PROXY_RUNTIME_TOKEN_FILE"
    ;;
  reset)
    [[ "${2:-}" == "$PLATFORM_LOCAL_PROJECT" ]] || {
      echo "Reset requires the exact isolated project name as confirmation" >&2
      exit 1
    }
    worker_context
    check_database_resource_ownership
    check_database_network_ownership
    bash "$0" stop
    delete_owned_agent_pvcs
    "${compose[@]}" down --volumes --remove-orphans
    ;;
  validate)
    validate_deployment_material
    ;;
  *)
    echo "Usage: bash deploy/local/platform.sh build|data|migrate|up|status|stop|reset <exact-project>|validate" >&2
    exit 1
    ;;
esac
