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
export PLATFORM_LOCAL_NATIVE_METADATA_WORKER_TOKEN_FILE="$local_state_root/$PLATFORM_LOCAL_PROJECT/native-metadata-worker-token"
export PLATFORM_LOCAL_NATIVE_METADATA_WORKER_ORIGIN=""
export PLATFORM_LOCAL_NATIVE_METADATA_WORKER_BIND_ADDRESS="${PLATFORM_LOCAL_NATIVE_METADATA_WORKER_BIND_ADDRESS:-}"
mkdir -p "$local_state_root/$PLATFORM_LOCAL_PROJECT"
chmod 700 "$local_state_root/$PLATFORM_LOCAL_PROJECT"
if [[ ! -e "$PLATFORM_LOCAL_NATIVE_METADATA_WORKER_TOKEN_FILE" ]]; then
  (umask 077 && : > "$PLATFORM_LOCAL_NATIVE_METADATA_WORKER_TOKEN_FILE")
fi
chmod 600 "$PLATFORM_LOCAL_NATIVE_METADATA_WORKER_TOKEN_FILE"
build_context_root=${PLATFORM_LOCAL_BUILD_CONTEXT:-$repository_root}
[[ "$build_context_root" = /* && -f "$build_context_root/docker-compose.yml" ]] || {
  echo "PLATFORM_LOCAL_BUILD_CONTEXT must contain a docker-compose.yml" >&2
  exit 1
}
docker_target=(docker --context "$PLATFORM_LOCAL_DOCKER_CONTEXT")
docker_endpoint=$("${docker_target[@]}" context inspect "$PLATFORM_LOCAL_DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}')
[[ "$docker_endpoint" == unix://* ]] || {
  echo "Local Platform requires a local Docker socket" >&2
  exit 1
}
compose=("${docker_target[@]}" compose --project-name "$PLATFORM_LOCAL_PROJECT" --profile enterprise-directory -f "$build_context_root/docker-compose.yml" -f "$repository_root/deploy/local/compose.yaml")
if [[ -n "${PLATFORM_LOCAL_BUILD_COMPOSE_OVERRIDE:-}" ]]; then
  [[ "$PLATFORM_LOCAL_BUILD_COMPOSE_OVERRIDE" = /* && -r "$PLATFORM_LOCAL_BUILD_COMPOSE_OVERRIDE" ]] || {
    echo "PLATFORM_LOCAL_BUILD_COMPOSE_OVERRIDE must be an absolute readable file" >&2
    exit 1
  }
  compose+=( -f "$PLATFORM_LOCAL_BUILD_COMPOSE_OVERRIDE" )
fi
worker_release="$PLATFORM_LOCAL_PROJECT"
worker_deployment="$worker_release-agent-infra-platform-worker"
database_service="$worker_release-postgres"
database_endpoint="$database_service-docker"
directory_service="enterprise-directory-sync"
directory_endpoint="enterprise-directory-sync-e2e"
object_storage_compose_service="object-storage"
object_storage_service="$worker_release-object-storage"
object_storage_endpoint="$object_storage_service-docker"
native_metadata_api_service="$worker_release-native-metadata-api"
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
  if ! active_workloads=$("${kube_target[@]}" get statefulsets -l agent-infra.agora.io/agent -o 'jsonpath={range .items[*]}{.metadata.name}{" "}{.spec.replicas}{"\n"}{end}' 2>/dev/null); then
    echo "Agent Workloads could not be read; Platform stop refused" >&2
    return 1
  fi
  while read -r name replicas; do
    [[ -z "$name" ]] && continue
    [[ "$replicas" == 0 ]] || {
      echo "Stop each Agent and wait for its Workload to scale to zero before stopping Platform" >&2
      return 1
    }
  done <<< "$active_workloads"
  if ! active_pods=$("${kube_target[@]}" get pods -l agent-infra.agora.io/agent -o name 2>/dev/null); then
    echo "Agent Pods could not be read; Platform stop refused" >&2
    return 1
  fi
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
    # 仓库内的本地默认值在前，私有 values 在后，私有 values 可以覆盖（#2883）。
    --values "$repository_root/deploy/local/platform-worker.local-defaults.values.yaml"
    --values "$PLATFORM_LOCAL_WORKER_VALUES"
    --set workloadTopology.enabled=false
    --set migration.enabled=false
    --set enterpriseDirectorySync.enabled=false
    --set web.placement=external
    --set platformApi.placement=external
    --set-string "platformWorker.nativeMetadataGateway.platformApiOrigin=http://$native_metadata_api_service:3000"
    --set-string "database.secretRef.name=$database_service"
    --set-string database.secretRef.key=url
    --set-string platformWorker.deploymentModule=file:///app/dist/deployment.mjs
  )
  # Optional staged file-plane E2E. The API Service already exists when the
  # native metadata route is enabled; the API still needs its own
  # file-deployment configuration and the same service token registered.
  if [[ -n "${PLATFORM_LOCAL_FILE_EXCHANGE_ENABLED:-}" ]]; then
    [[ "$PLATFORM_LOCAL_FILE_EXCHANGE_ENABLED" == "true" ]] || {
      echo "PLATFORM_LOCAL_FILE_EXCHANGE_ENABLED must be true when set" >&2
      exit 1
    }
    worker_options+=(
      --set-string "platformWorker.fileExchangeOrigin=http://$native_metadata_api_service:3000"
    )
  fi
  if [[ -n "${PLATFORM_LOCAL_HELM_POST_RENDERER:-}" ]]; then
    [[ "$PLATFORM_LOCAL_HELM_POST_RENDERER" = /* && -x "$PLATFORM_LOCAL_HELM_POST_RENDERER" ]] || {
      echo "PLATFORM_LOCAL_HELM_POST_RENDERER must be an executable absolute path" >&2
      exit 1
    }
    worker_options+=( --post-renderer "$PLATFORM_LOCAL_HELM_POST_RENDERER" )
  fi
  if [[ -n "${AGENT_INFRA_RUNTIME_IMAGE_REPOSITORY:-}" || -n "${AGENT_INFRA_RUNTIME_IMAGE_DIGEST:-}" ]]; then
    [[ -n "${AGENT_INFRA_RUNTIME_IMAGE_REPOSITORY:-}" && -n "${AGENT_INFRA_RUNTIME_IMAGE_DIGEST:-}" ]] || {
      echo "Runtime image repository and Digest must be supplied together" >&2
      exit 1
    }
    worker_options+=(
      --set-string "platformWorker.runtimeImageRepository=$AGENT_INFRA_RUNTIME_IMAGE_REPOSITORY"
      --set-string "platformWorker.runtimeImageDigest=$AGENT_INFRA_RUNTIME_IMAGE_DIGEST"
    )
  fi
  # Skill 绑定的 Agent Version：与 Compose API 读取同一个值（工程 Spec §11.6）。
  if [[ -n "${AGENT_INFRA_AGENT_VERSION:-}" ]]; then
    worker_options+=( --set-string "agentVersion=$AGENT_INFRA_AGENT_VERSION" )
  fi
}

native_metadata_route_enabled=false
native_metadata_token_secret=
native_metadata_token_key=
native_metadata_service_name=
native_metadata_forward_pid_file="$local_state_root/$PLATFORM_LOCAL_PROJECT/native-metadata-worker-port-forward.pid"
native_metadata_forward_log="$local_state_root/$PLATFORM_LOCAL_PROJECT/native-metadata-worker-port-forward.log"
native_metadata_proxy_pid_file="$local_state_root/$PLATFORM_LOCAL_PROJECT/native-metadata-worker-proxy.pid"
native_metadata_proxy_log="$local_state_root/$PLATFORM_LOCAL_PROJECT/native-metadata-worker-proxy.log"
native_metadata_forward_bind_address=

read_native_metadata_worker_route() {
  native_metadata_route_enabled=false
  native_metadata_token_secret=
  native_metadata_token_key=
  native_metadata_service_name=
  local route
  route=$(printf '%s' "$worker_manifest" | node --input-type=module -e '
    import { parseAllDocuments } from "yaml";
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const documents = parseAllDocuments(input).map((document) => document.toJS()).filter(Boolean);
        const deployment = documents.find((item) => item.kind === "Deployment" && item.spec?.template?.spec?.containers?.some((container) => container.name === "platform-worker"));
        const container = deployment?.spec?.template?.spec?.containers?.find((item) => item.name === "platform-worker");
        const enabled = container?.env?.find((item) => item.name === "PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_ENABLED")?.value === "true";
        if (!enabled) process.exit(0);
        const volume = deployment?.spec?.template?.spec?.volumes?.find((item) => item.name === "runtime-auth");
        const secretName = volume?.secret?.secretName;
        const key = volume?.secret?.items?.find((item) => item.path === "service-token")?.key;
        const service = documents.find((item) => item.kind === "Service" && item.metadata?.labels?.["app.kubernetes.io/component"] === "platform-worker" && item.spec?.ports?.some((port) => port.targetPort === "native-metadata"));
        const serviceName = service?.metadata?.name;
        if (typeof secretName !== "string" || typeof key !== "string" || typeof serviceName !== "string") process.exit(2);
        process.stdout.write(`${secretName}\t${key}\t${serviceName}`);
      } catch { process.exit(2); }
    });
  ') || {
    echo "Local Worker native metadata manifest could not be inspected" >&2
    return 1
  }
  if [[ -z "$route" ]]; then return 0; fi
  native_metadata_route_enabled=true
  native_metadata_token_secret=${route%%$'\t'*}
  route=${route#*$'\t'}
  native_metadata_token_key=${route%%$'\t'*}
  native_metadata_service_name=${route#*$'\t'}
  [[ -n "$native_metadata_token_secret" && -n "$native_metadata_token_key" && -n "$native_metadata_service_name" ]] || {
    echo "Local Worker native metadata token reference is invalid" >&2
    return 1
  }
}

# 终止一个后台进程并等它退出，最多约 2 秒，避免新的转发复用端口时撞上旧进程。
# 由 start_detached 启动的进程是自己进程组的组长，按进程组终止，连同监督循环正在运行的
# kubectl / sleep 一起回收：监督循环刚启动 kubectl、还没记下子进程 PID 时收到 TERM，会漏掉
# 这个子进程（#2741）。旧版脚本启动的进程不是组长，照旧只终止它本身。
stop_detached() {
  local pid=$1 target pgid state
  # PID 文件损坏或被篡改为 0 / 负数时，`kill -- -0` 会向调用方自己的进程组发信号。
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  pgid=$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d ' ')
  target=$pid
  [[ "$pgid" == "$pid" ]] && target=-$pid
  kill -TERM -- "$target" >/dev/null 2>&1 || true
  for _ in {1..40}; do
    if [[ "$target" == -* ]]; then
      kill -0 -- "$target" >/dev/null 2>&1 || return 0
    else
      state=$(ps -p "$pid" -o stat= 2>/dev/null || true)
      [[ -z "$state" || "$state" == Z* ]] && return 0
    fi
    sleep 0.05
  done
}

stop_native_metadata_forward() {
  local pid command
  if [[ -r "$native_metadata_forward_pid_file" ]]; then
    pid=$(cat "$native_metadata_forward_pid_file")
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
      command=$(ps -p "$pid" -o command= 2>/dev/null || true)
      if [[ "$command" == *"native-metadata-port-forward-supervisor"* ]]; then
        stop_detached "$pid"
      fi
    fi
  fi
  if [[ -r "$native_metadata_proxy_pid_file" ]]; then
    pid=$(cat "$native_metadata_proxy_pid_file")
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
      command=$(ps -p "$pid" -o command= 2>/dev/null || true)
      if [[ "$command" == *"native-metadata-proxy.mjs"* ]]; then
        stop_detached "$pid"
      fi
    fi
  fi
  rm -f "$native_metadata_forward_pid_file" "$native_metadata_forward_log" "$native_metadata_proxy_pid_file" "$native_metadata_proxy_log"
  (umask 077 && : > "$PLATFORM_LOCAL_NATIVE_METADATA_WORKER_TOKEN_FILE")
  export PLATFORM_LOCAL_NATIVE_METADATA_WORKER_ORIGIN=""
}

resolve_native_metadata_forward_bind_address() {
  local address candidate
  candidate=${PLATFORM_LOCAL_NATIVE_METADATA_WORKER_BIND_ADDRESS:-}
  if [[ -z "$candidate" ]]; then
    if command -v ipconfig >/dev/null 2>&1; then
      candidate=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
    else
      candidate=$(hostname -I 2>/dev/null | awk '{print $1}')
    fi
  fi
  [[ -n "$candidate" ]] || {
    echo "Local native metadata host address could not be resolved; set PLATFORM_LOCAL_NATIVE_METADATA_WORKER_BIND_ADDRESS" >&2
    return 1
  }
  address=$candidate
  [[ "$address" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "Local native metadata host address could not be resolved" >&2
    return 1
  }
  [[ "$address" =~ ^10\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[0-1])\. ]] || {
    echo "Local native metadata host address is not private" >&2
    return 1
  }
  printf '%s' "$address"
}

# 在新会话里启动一个长驻后台进程，标准输出与错误追加到日志，打印它的 PID（#2741）。
# 用 `&` 启动的进程和调用方同属一个会话和进程组：终端关闭（SIGHUP）或执行器在命令结束时
# 整组终止，都会让它们跟着退出。macOS 没有 setsid 命令，这里用 node 的 detached spawn
# （setsid）脱离调用方；stop 仍按 PID 文件校验命令行后回收。
start_detached() {
  local log=$1
  shift
  node -e '
    const { spawn } = require("node:child_process");
    const { openSync } = require("node:fs");
    const [log, command, ...args] = process.argv.slice(1);
    const output = openSync(log, "a");
    const child = spawn(command, args, { detached: true, stdio: ["ignore", output, output] });
    if (!child.pid) process.exit(1);
    child.unref();
    process.stdout.write(String(child.pid));
  ' "$log" "$@"
}

prepare_native_metadata_forward() {
  stop_native_metadata_forward
  : > "$PLATFORM_LOCAL_NATIVE_METADATA_WORKER_TOKEN_FILE"
  if [[ "$native_metadata_route_enabled" != true ]]; then return 0; fi
  local secret_json token encoded port
  if ! secret_json=$("${kube_target[@]}" get "secret/$native_metadata_token_secret" --ignore-not-found -o json); then
    echo "Local native metadata Worker Secret could not be read" >&2
    stop_native_metadata_forward
    return 1
  fi
  token=$(printf '%s' "$secret_json" | node -e '
    try {
      const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const value = input.data?.[process.argv[1]];
      if (typeof value !== "string" || value.length === 0) process.exit(1);
      process.stdout.write(Buffer.from(value, "base64").toString("utf8"));
    } catch { process.exit(1); }
  ' "$native_metadata_token_key") || {
    echo "Local native metadata Worker Secret is missing its service token" >&2
    stop_native_metadata_forward
    return 1
  }
  if [[ -z "$token" || ${#token} -gt 8192 || "$token" =~ [[:space:]] ]]; then
    echo "Local native metadata Worker service token is invalid" >&2
    stop_native_metadata_forward
    return 1
  fi
  (umask 077 && printf '%s' "$token" > "$PLATFORM_LOCAL_NATIVE_METADATA_WORKER_TOKEN_FILE")
  port=${PLATFORM_LOCAL_NATIVE_METADATA_WORKER_PORT:-3004}
  [[ "$port" =~ ^[1-9][0-9]{0,4}$ && "$port" -le 65535 ]] || {
    echo "PLATFORM_LOCAL_NATIVE_METADATA_WORKER_PORT must be a valid port" >&2
    stop_native_metadata_forward
    return 1
  }
  native_metadata_forward_bind_address=$(resolve_native_metadata_forward_bind_address) || {
    stop_native_metadata_forward
    return 1
  }
  export PLATFORM_LOCAL_NATIVE_METADATA_WORKER_BIND_ADDRESS="$native_metadata_forward_bind_address"
  local forward_port=$((port + 1))
  [[ "$forward_port" -le 65535 ]] || {
    echo "PLATFORM_LOCAL_NATIVE_METADATA_WORKER_PORT leaves no internal forward port" >&2
    stop_native_metadata_forward
    return 1
  }
  local compose_subnet
  compose_subnet=$("${docker_target[@]}" network inspect "${PLATFORM_LOCAL_PROJECT}_default" --format '{{(index .IPAM.Config 0).Subnet}}') || {
    echo "Local Compose network subnet could not be resolved" >&2
    stop_native_metadata_forward
    return 1
  }
  [[ "$compose_subnet" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.).*/([0-9]|[12][0-9]|3[0-2])$ ]] || {
    echo "Local Compose network subnet is not a private IPv4 CIDR" >&2
    stop_native_metadata_forward
    return 1
  }
  # Keep kubectl on loopback. The host proxy is the only listener reachable
  # from Compose and rejects every source outside the project subnet.
  # kubectl port-forward 在上游拒绝连接（Worker 网关晚于 Pod 就绪才监听）或所选 Pod 被替换时
  # 会退出，之后 API 一直 503（#2726）。由监督循环有界退避地重启它；PID 文件记录监督循环，
  # stop 时它连同当前的 kubectl 一起退出。
  : > "$native_metadata_forward_log"
  local pid
  pid=$(start_detached "$native_metadata_forward_log" bash -c '
    child=
    sleeper=
    stop() {
      [[ -z "$child" ]] || kill "$child" 2>/dev/null || true
      [[ -z "$sleeper" ]] || kill "$sleeper" 2>/dev/null || true
      [[ -z "$child" ]] || wait "$child" 2>/dev/null || true
      [[ -z "$sleeper" ]] || wait "$sleeper" 2>/dev/null || true
      exit 0
    }
    trap stop TERM INT
    delay=1
    while :; do
      "$@" &
      child=$!
      wait "$child"
      child=
      sleep "$delay" &
      sleeper=$!
      wait "$sleeper"
      sleeper=
      if [ "$delay" -lt 5 ]; then delay=$((delay + 1)); fi
    done
  ' native-metadata-port-forward-supervisor "${kube_target[@]}" port-forward --address 127.0.0.1 "service/$native_metadata_service_name" "$forward_port:80") || {
    echo "Local native metadata Worker port-forward could not start" >&2
    stop_native_metadata_forward
    return 1
  }
  printf '%s' "$pid" > "$native_metadata_forward_pid_file"
  # 等 kubectl 报告本地监听就绪；不在这里连接转发端口：每个连接都会让 kubectl 去连 Worker
  # 网关，网关还没监听时 kubectl 会退出（#2726）。
  local ready=false
  for _ in {1..100}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      echo "Local native metadata Worker port-forward exited" >&2
      stop_native_metadata_forward
      return 1
    fi
    if grep -q "Forwarding from 127.0.0.1:$forward_port " "$native_metadata_forward_log" 2>/dev/null; then
      ready=true
      break
    fi
    sleep 0.1
  done
  if [[ "$ready" != true ]]; then
    echo "Local native metadata Worker port-forward did not become ready" >&2
    stop_native_metadata_forward
    return 1
  fi
  : > "$native_metadata_proxy_log"
  pid=$(start_detached "$native_metadata_proxy_log" node deploy/local/native-metadata-proxy.mjs "$native_metadata_forward_bind_address" "$port" "$forward_port" "$compose_subnet") || {
    echo "Local native metadata host proxy could not start" >&2
    stop_native_metadata_forward
    return 1
  }
  printf '%s' "$pid" > "$native_metadata_proxy_pid_file"
  sleep 0.1
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    echo "Local native metadata host proxy exited" >&2
    stop_native_metadata_forward
    return 1
  fi
  export PLATFORM_LOCAL_NATIVE_METADATA_WORKER_ORIGIN="http://platform-worker-native-metadata:$port"
  return 0
}

validate_deployment_material() {
  : "${PLATFORM_LOCAL_API_DIRECTORY:?Set the API-only deployment directory}"
  : "${PLATFORM_LOCAL_WORKER_CONFIGURATION:?Set the private Worker configuration.mjs path}"
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
  [[ "$PLATFORM_LOCAL_WORKER_CONFIGURATION" = /* && -r "$PLATFORM_LOCAL_WORKER_CONFIGURATION" ]] || {
    echo "Local Worker configuration.mjs is missing or unreadable" >&2
    return 1
  }
  if ! node --check "$PLATFORM_LOCAL_WORKER_CONFIGURATION" >/dev/null 2>&1; then
    echo "Local Worker configuration.mjs has invalid syntax" >&2
    return 1
  fi
  worker_values
  if ! worker_manifest=$("${helm_target[@]}" template "$worker_release" deploy/helm/agent-infra "${worker_options[@]}"); then
    echo "Local Worker values are missing or invalid" >&2
    return 1
  fi
  read_native_metadata_worker_route
}

check_worker_secret_material() {
  local secret_refs secret key secret_json
  secret_refs=$(printf '%s' "$worker_manifest" | node --input-type=module -e '
    import { parseAllDocuments } from "yaml";
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const refs = new Map();
        const add = (name, key = "") => {
          if (typeof name !== "string" || name.length === 0) return;
          const values = refs.get(name) ?? new Set();
          if (typeof key === "string") values.add(key);
          refs.set(name, values);
        };
        const collectPodSecrets = (podSpec) => {
          if (!podSpec || typeof podSpec !== "object") return;
          const volumes = new Map();
          for (const volume of Array.isArray(podSpec.volumes) ? podSpec.volumes : []) {
            const secret = volume?.secret;
            if (!secret || typeof secret.secretName !== "string") continue;
            volumes.set(volume.name, secret.secretName);
            const items = Array.isArray(secret.items) ? secret.items : [];
            if (items.length === 0) add(secret.secretName);
            for (const item of items) add(secret.secretName, item?.key);
          }
          for (const container of Array.isArray(podSpec.containers) ? podSpec.containers : []) {
            for (const mount of Array.isArray(container?.volumeMounts) ? container.volumeMounts : []) {
              const secretName = volumes.get(mount?.name);
              if (secretName && typeof mount.subPath === "string") {
                const volume = podSpec.volumes.find((candidate) => candidate?.name === mount.name);
                const items = Array.isArray(volume?.secret?.items) ? volume.secret.items : [];
                // Explicit items were already checked by their Secret keys above.
                if (items.length === 0) add(secretName, mount.subPath);
              }
            }
          }
        };
        const visit = (value) => {
          if (Array.isArray(value)) {
            for (const entry of value) visit(entry);
            return;
          }
          if (!value || typeof value !== "object") return;
          if (value.kind && value.spec?.template?.spec) collectPodSecrets(value.spec.template.spec);
          if (value.containers) collectPodSecrets(value);
          if (typeof value.secretName === "string") {
            const items = Array.isArray(value.items) ? value.items : [];
            if (items.length === 0) add(value.secretName);
            for (const item of items) add(value.secretName, item?.key);
          }
          const keyRef = value.secretKeyRef;
          if (keyRef && typeof keyRef === "object") add(keyRef.name, keyRef.key);
          for (const child of Object.values(value)) visit(child);
        };
        for (const document of parseAllDocuments(input)) visit(document.toJS());
        const lines = [];
        for (const [name, keys] of refs) {
          for (const key of keys) lines.push(`${name}\t${key}`);
        }
        process.stdout.write(lines.sort().join("\n"));
      } catch {
        process.exitCode = 1;
      }
    });
  ') || {
    echo "Local Worker manifest could not be inspected for Secret references" >&2
    return 1
  }
  [[ -n "$secret_refs" ]] || {
    echo "Local Worker manifest contains no verifiable Secret references" >&2
    return 1
  }
  while IFS=$'\t' read -r secret key; do
    [[ -n "$secret" ]] || continue
    if ! secret_json=$("${kube_target[@]}" get "secret/$secret" --ignore-not-found -o json); then
      echo "Local Worker Secret could not be read: $secret" >&2
      return 1
    fi
    if ! printf '%s' "$secret_json" | node -e '
      let input = "";
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        try {
          const secret = JSON.parse(input);
          const metadata = secret.metadata ?? {};
          const data = secret.data ?? {};
          if (secret.kind !== "Secret" ||
              metadata.name !== process.argv[1] ||
              metadata.namespace !== process.argv[2] ||
              (process.argv[3] &&
                (typeof data[process.argv[3]] !== "string" || data[process.argv[3]].length === 0))) process.exitCode = 1;
        } catch {
          process.exitCode = 1;
        }
      });
    ' "$secret" "$PLATFORM_LOCAL_NAMESPACE" "$key"; then
      if [[ -n "$key" ]]; then
        echo "Local Worker Secret is missing key $key: $secret" >&2
      else
        echo "Local Worker Secret is missing: $secret" >&2
      fi
      return 1
    fi
  done <<< "$secret_refs"
}

render_proxy_config() {
  [[ "${PLATFORM_LOCAL_PROXY_TOKEN_FILE:?Set the private local proxy token file}" = /* && -r "$PLATFORM_LOCAL_PROXY_TOKEN_FILE" ]] || {
    echo "PLATFORM_LOCAL_PROXY_TOKEN_FILE must be an absolute readable file" >&2
    return 1
  }
  node deploy/local/render-nginx.ts "$PLATFORM_LOCAL_PROXY_TOKEN_FILE" "$PLATFORM_LOCAL_NGINX_CONFIG"
}

check_native_metadata_api_ownership() {
  local resource
  for resource in service endpointslice; do
    if ! "${kube_target[@]}" get "$resource/$native_metadata_api_service" --ignore-not-found -o json |
      node -e '
        let input = "";
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", () => {
          if (!input.trim()) return;
          try {
            const labels = JSON.parse(input).metadata?.labels ?? {};
            if (labels["app.kubernetes.io/managed-by"] !== "agent-infra-local" ||
                labels["agent-infra.agora.io/local-project"] !== process.argv[1]) process.exitCode = 1;
          } catch { process.exitCode = 1; }
        });
      ' "$PLATFORM_LOCAL_PROJECT"; then
      echo "Local native metadata API $resource is not owned by this project" >&2
      return 1
    fi
  done
}

check_native_metadata_api_network_ownership() {
  local container aliases network_alias
  container=$("${compose[@]}" ps --all -q platform-api) || return 1
  if [[ -n "$container" ]]; then
    network_alias="$native_metadata_api_service-${container:0:12}"
    aliases=$("${docker_target[@]}" container inspect "$container" --format '{{with index .NetworkSettings.Networks "kind"}}{{join .Aliases " "}}{{end}}') || return 1
    if [[ -n "$aliases" ]]; then
      [[ "$aliases" == "$network_alias" ]] || {
        echo "Local Platform API is connected to kind outside this project" >&2
        return 1
      }
    fi
  fi
}

disconnect_native_metadata_api() {
  check_native_metadata_api_ownership || return 1
  check_native_metadata_api_network_ownership || return 1
  local container aliases
  container=$("${compose[@]}" ps --all -q platform-api) || return 1
  if [[ -n "$container" ]]; then
    aliases=$("${docker_target[@]}" container inspect "$container" --format '{{with index .NetworkSettings.Networks "kind"}}{{join .Aliases " "}}{{end}}') || return 1
    if [[ -n "$aliases" ]]; then
      "${docker_target[@]}" network disconnect kind "$container" || return 1
    fi
  fi
  "${kube_target[@]}" delete "endpointslice/$native_metadata_api_service" "service/$native_metadata_api_service" --ignore-not-found
}

connect_native_metadata_api() {
  check_native_metadata_api_ownership || return 1
  if [[ "$native_metadata_route_enabled" != true ]]; then
    disconnect_native_metadata_api
    return
  fi
  local container aliases network_alias api_ip
  container=$("${compose[@]}" ps -q platform-api) || return 1
  [[ -n "$container" ]] || { echo "Local Platform API container is missing" >&2; return 1; }
  network_alias="$native_metadata_api_service-${container:0:12}"
  aliases=$("${docker_target[@]}" container inspect "$container" --format '{{with index .NetworkSettings.Networks "kind"}}{{join .Aliases " "}}{{end}}') || return 1
  if [[ -z "$aliases" ]]; then
    "${docker_target[@]}" network connect --alias "$network_alias" kind "$container" || return 1
  elif [[ "$aliases" != "$network_alias" ]]; then
    echo "Local Platform API is connected to kind outside this project" >&2
    return 1
  fi
  api_ip=$("${docker_target[@]}" container inspect "$container" --format '{{(index .NetworkSettings.Networks "kind").IPAddress}}') || return 1
  [[ "$api_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "Local Platform API has no IPv4 address on the kind network" >&2
    return 1
  }
  "${kube_target[@]}" apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: $native_metadata_api_service
  labels:
    app.kubernetes.io/managed-by: agent-infra-local
    agent-infra.agora.io/local-project: $PLATFORM_LOCAL_PROJECT
spec:
  ports:
    - name: http
      port: 3000
      targetPort: 3000
      protocol: TCP
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: $native_metadata_api_service
  labels:
    app.kubernetes.io/managed-by: agent-infra-local
    agent-infra.agora.io/local-project: $PLATFORM_LOCAL_PROJECT
    kubernetes.io/service-name: $native_metadata_api_service
    endpointslice.kubernetes.io/managed-by: agent-infra-local
addressType: IPv4
ports:
  - name: http
    port: 3000
    protocol: TCP
endpoints:
  - addresses: ["$api_ip"]
    conditions:
      ready: true
EOF
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

directory_network_aliases() {
  "${docker_target[@]}" container inspect "$1" --format '{{with index .NetworkSettings.Networks "kind"}}{{join .Aliases " "}}{{end}}'
}

directory_route_alias() {
  "${kube_target[@]}" get "endpointslice/$directory_endpoint" --ignore-not-found -o json | node -e '
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
  ' "$PLATFORM_LOCAL_PROJECT" "$directory_service"
}

check_directory_resource_ownership() {
  local resource name
  for resource in service endpointslice; do
    name="$directory_service"
    [[ "$resource" == endpointslice ]] && name="$directory_endpoint"
    if ! "${kube_target[@]}" get "$resource/$name" --ignore-not-found -o json |
      node -e '
        let input = "";
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", () => {
          if (!input.trim()) return;
          try {
            const labels = JSON.parse(input).metadata?.labels ?? {};
            if (!["agent-infra-local", "agent-infra-e2e"].includes(labels["app.kubernetes.io/managed-by"]) ||
                labels["agent-infra.agora.io/local-project"] !== process.argv[1]) process.exitCode = 1;
          } catch {
            process.exitCode = 1;
          }
        });
      ' "$PLATFORM_LOCAL_PROJECT"; then
      echo "Local directory $resource/$name is not owned by this project" >&2
      return 1
    fi
  done
}

connect_directory_sync() {
  local container aliases network_alias directory_ip
  check_directory_resource_ownership || return 1
  container=$("${compose[@]}" ps -q "$directory_service")
  [[ -n "$container" ]] || { echo "Local directory sync container is missing" >&2; return 1; }
  aliases=$(directory_network_aliases "$container")
  if [[ -z "$aliases" ]]; then
    network_alias="$directory_service-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
    "${docker_target[@]}" network connect --alias "$network_alias" kind "$container"
  else
    network_alias=$(directory_route_alias)
    [[ "$aliases" == "$network_alias" ]] || {
      echo "Local directory sync is connected to kind outside this project" >&2
      return 1
    }
  fi
  directory_ip=$("${docker_target[@]}" container inspect "$container" --format '{{(index .NetworkSettings.Networks "kind").IPAddress}}')
  [[ "$directory_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "Local directory sync has no IPv4 address on the kind network" >&2
    return 1
  }
  "${kube_target[@]}" apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: $directory_service
  labels:
    app.kubernetes.io/managed-by: agent-infra-local
    agent-infra.agora.io/local-project: $PLATFORM_LOCAL_PROJECT
spec:
  ports:
    - name: https
      port: 3004
      targetPort: 3004
      protocol: TCP
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: $directory_endpoint
  labels:
    app.kubernetes.io/managed-by: agent-infra-local
    agent-infra.agora.io/local-project: $PLATFORM_LOCAL_PROJECT
    kubernetes.io/service-name: $directory_service
    endpointslice.kubernetes.io/managed-by: agent-infra-local
  annotations:
    agent-infra.agora.io/local-network-alias: $network_alias
addressType: IPv4
ports:
  - name: https
    port: 3004
    protocol: TCP
endpoints:
  - addresses: ["$directory_ip"]
    conditions:
      ready: true
EOF
}

disconnect_directory_sync() {
  local container aliases
  check_directory_resource_ownership
  container=$("${compose[@]}" ps --all -q "$directory_service")
  if [[ -n "$container" ]]; then
    aliases=$(directory_network_aliases "$container")
    if [[ -n "$aliases" ]]; then
      "${docker_target[@]}" network disconnect kind "$container"
    fi
  fi
  "${kube_target[@]}" delete "endpointslice/$directory_endpoint" "service/$directory_service" --ignore-not-found
}

# Worker 侧文件面开关与 fileExchangeOrigin 相同（PLATFORM_LOCAL_FILE_EXCHANGE_ENABLED=true）。
# 启用时 Worker 的 wecom.media 经 kind 内 Service 访问 Compose object-storage（#3261），
# 做法与 Postgres、目录同步相同：随机别名接入 kind，EndpointSlice 注解记录本项目别名。
object_storage_route_enabled() {
  [[ "${PLATFORM_LOCAL_FILE_EXCHANGE_ENABLED:-}" == true ]]
}

object_storage_network_aliases() {
  "${docker_target[@]}" container inspect "$1" --format '{{with index .NetworkSettings.Networks "kind"}}{{join .Aliases " "}}{{end}}'
}

object_storage_route_alias() {
  "${kube_target[@]}" get "endpointslice/$object_storage_endpoint" --ignore-not-found -o json | node -e '
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
  ' "$PLATFORM_LOCAL_PROJECT" "$object_storage_service"
}

check_object_storage_resource_ownership() {
  local resource name
  for resource in service endpointslice; do
    name="$object_storage_service"
    [[ "$resource" == endpointslice ]] && name="$object_storage_endpoint"
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
      echo "Local object storage $resource/$name is not owned by this project" >&2
      return 1
    fi
  done
}

# 对象存储容器已接入 kind 时，别名必须正是本项目 EndpointSlice 注解记录的别名；否则拒绝，
# 不断开也不覆盖其他项目的接入。
check_object_storage_network_ownership() {
  local container aliases owned_alias
  container=$("${compose[@]}" ps --all -q "$object_storage_compose_service") || return 1
  [[ -n "$container" ]] || return 0
  aliases=$(object_storage_network_aliases "$container") || return 1
  [[ -n "$aliases" ]] || return 0
  owned_alias=$(object_storage_route_alias) || {
    echo "Local object storage kind connection has no owned route marker" >&2
    return 1
  }
  if [[ -z "$owned_alias" || "$aliases" != "$owned_alias" ]]; then
    echo "Local object storage is connected to kind outside this project" >&2
    return 1
  fi
}

connect_object_storage() {
  if ! object_storage_route_enabled; then
    # 未启用文件面时不创建路由，并按 ownership 清理之前创建的接入。
    disconnect_object_storage
    return
  fi
  check_object_storage_resource_ownership || return 1
  check_object_storage_network_ownership || return 1
  local container aliases network_alias storage_ip
  container=$("${compose[@]}" ps -q "$object_storage_compose_service") || return 1
  [[ -n "$container" ]] || { echo "Local object storage container is missing" >&2; return 1; }
  aliases=$(object_storage_network_aliases "$container") || return 1
  if [[ -z "$aliases" ]]; then
    network_alias="$object_storage_service-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
    "${docker_target[@]}" network connect --alias "$network_alias" kind "$container" || return 1
  else
    network_alias=$(object_storage_route_alias) || return 1
    [[ "$aliases" == "$network_alias" ]] || {
      echo "Local object storage is connected to kind outside this project" >&2
      return 1
    }
  fi
  storage_ip=$("${docker_target[@]}" container inspect "$container" --format '{{(index .NetworkSettings.Networks "kind").IPAddress}}') || return 1
  [[ "$storage_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "Local object storage has no IPv4 address on the kind network" >&2
    return 1
  }
  "${kube_target[@]}" apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: $object_storage_service
  labels:
    app.kubernetes.io/managed-by: agent-infra-local
    agent-infra.agora.io/local-project: $PLATFORM_LOCAL_PROJECT
spec:
  ports:
    - name: http
      port: 9000
      targetPort: 9000
      protocol: TCP
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: $object_storage_endpoint
  labels:
    app.kubernetes.io/managed-by: agent-infra-local
    agent-infra.agora.io/local-project: $PLATFORM_LOCAL_PROJECT
    kubernetes.io/service-name: $object_storage_service
    endpointslice.kubernetes.io/managed-by: agent-infra-local
  annotations:
    agent-infra.agora.io/local-network-alias: $network_alias
addressType: IPv4
ports:
  - name: http
    port: 9000
    protocol: TCP
endpoints:
  - addresses: ["$storage_ip"]
    conditions:
      ready: true
EOF
}

disconnect_object_storage() {
  local container aliases
  check_object_storage_resource_ownership || return 1
  check_object_storage_network_ownership || return 1
  container=$("${compose[@]}" ps --all -q "$object_storage_compose_service") || return 1
  if [[ -n "$container" ]]; then
    aliases=$(object_storage_network_aliases "$container") || return 1
    if [[ -n "$aliases" ]]; then
      "${docker_target[@]}" network disconnect kind "$container" || return 1
    fi
  fi
  "${kube_target[@]}" delete "endpointslice/$object_storage_endpoint" "service/$object_storage_service" --ignore-not-found
}

delete_owned_agent_pvcs() {
  local names name pvc_json agent_identity agent_name agent_id
  [[ -n "${PLATFORM_LOCAL_AGENT_PVC_NAMES:-}" ]] || return 0
  IFS=',' read -r -a names <<< "$PLATFORM_LOCAL_AGENT_PVC_NAMES"
  for name in "${names[@]}"; do
    [[ "$name" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#name} -le 63 ]] || {
      echo "PLATFORM_LOCAL_AGENT_PVC_NAMES contains an invalid PVC name" >&2
      return 1
    }
    if ! pvc_json=$("${kube_target[@]}" get "pvc/$name" --ignore-not-found -o json); then
      echo "Refusing to delete an unowned Agent PVC: $name" >&2
      return 1
    fi
    if ! agent_identity=$(printf '%s' "$pvc_json" |
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
            if (pvc.kind !== "PersistentVolumeClaim" ||
                metadata.name !== process.argv[1] ||
                metadata.namespace !== process.argv[2] ||
                metadata.name !== `${agentName}-data` ||
                labels["agent-infra.agora.io/agent"] !== agentName ||
                (Array.isArray(metadata.ownerReferences) && metadata.ownerReferences.length > 0)) process.exitCode = 1;
            else process.stdout.write(`${agentName}\t${agentId}`);
          } catch {
            process.exitCode = 1;
          }
        });
      ' "$name" "$PLATFORM_LOCAL_NAMESPACE"); then
      echo "Refusing to delete an unowned Agent PVC: $name" >&2
      return 1
    fi
    agent_name=${agent_identity%%$'\t'*}
    agent_id=${agent_identity#*$'\t'}
    if ! "${kube_target[@]}" get "statefulset/$agent_name" --ignore-not-found -o json |
      node -e '
        let input = "";
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", () => {
          try {
            const workload = JSON.parse(input);
            const metadata = workload.metadata ?? {};
            const labels = metadata.labels ?? {};
            const annotations = metadata.annotations ?? {};
            if (workload.kind !== "StatefulSet" ||
                metadata.name !== process.argv[1] ||
                metadata.namespace !== process.argv[2] ||
                labels["agent-infra.agora.io/agent"] !== process.argv[1] ||
                annotations["agent-infra.agora.io/agent-id"] !== process.argv[3] ||
                metadata.deletionTimestamp) process.exitCode = 1;
          } catch {
            process.exitCode = 1;
          }
        });
      ' "$agent_name" "$PLATFORM_LOCAL_NAMESPACE" "$agent_id"; then
      echo "Refusing to delete an Agent PVC without its canonical StatefulSet: $name" >&2
      return 1
    fi
  done
  for name in "${names[@]}"; do
    "${kube_target[@]}" delete "pvc/$name" --wait --timeout=5m
  done
}

case "${1:-}" in
  build)
    read -r -a build_services <<< "${PLATFORM_LOCAL_BUILD_SERVICES:-web platform-api platform-worker enterprise-directory-sync agent-runtime-host}"
    [[ ${#build_services[@]} -gt 0 ]] || { echo "PLATFORM_LOCAL_BUILD_SERVICES must not be empty" >&2; exit 1; }
    "${compose[@]}" --profile runtime build "${build_services[@]}"
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
    check_object_storage_resource_ownership
    check_object_storage_network_ownership
    validate_deployment_material
    check_native_metadata_api_ownership
    check_native_metadata_api_network_ownership
    render_proxy_config
    "${compose[@]}" stop web platform-api
    "${compose[@]}" up --detach --wait postgres object-storage
    connect_worker_database
    "${compose[@]}" up --detach --wait "$directory_service"
    connect_directory_sync
    connect_object_storage
    check_worker_secret_material
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
    prepare_native_metadata_forward
    if ! "${compose[@]}" up --detach --wait --force-recreate --no-deps platform-api; then
      stop_native_metadata_forward
      exit 1
    fi
    if ! connect_native_metadata_api; then
      "${compose[@]}" stop platform-api
      stop_native_metadata_forward
      exit 1
    fi
    if ! node deploy/local/check-api-auth.ts "$PLATFORM_LOCAL_PROXY_RUNTIME_TOKEN_FILE" "${PLATFORM_LOCAL_API_PORT:-3000}" "${PLATFORM_LOCAL_WEB_PORT:-3001}"; then
      "${compose[@]}" stop platform-api
      stop_native_metadata_forward
      echo "Local API login boundary is unavailable; Web remains stopped" >&2
      exit 1
    fi
    if ! "${compose[@]}" up --detach --wait --force-recreate --no-deps web; then
      stop_native_metadata_forward
      exit 1
    fi
    ;;
  status)
    worker_context
    "${compose[@]}" ps postgres object-storage enterprise-directory-sync platform-api web
    "${helm_target[@]}" status "$worker_release"
    "${kube_target[@]}" get deployment "$worker_deployment"
    "${kube_target[@]}" get "service/$database_service" "endpointslice/$database_endpoint" "secret/$database_service" "service/$directory_service" "endpointslice/$directory_endpoint"
    if object_storage_route_enabled; then
      "${kube_target[@]}" get "service/$object_storage_service" "endpointslice/$object_storage_endpoint"
    fi
    ;;
  stop)
    stop_native_metadata_forward
    worker_context
    check_database_resource_ownership
    check_database_network_ownership
    check_object_storage_resource_ownership
    check_object_storage_network_ownership
    worker_replicas=$("${kube_target[@]}" get deployment "$worker_deployment" --ignore-not-found -o jsonpath='{.spec.replicas}')
    if [[ -z "$worker_replicas" ]]; then
      existing_release=$("${helm_target[@]}" list --all --filter "^${worker_release}$" -q)
      if [[ -n "$existing_release" ]]; then
        echo "Worker release exists without its Deployment" >&2
        exit 1
      fi
      ensure_agents_stopped
      "${compose[@]}" stop web platform-api
      "${compose[@]}" stop enterprise-directory-sync
      disconnect_directory_sync
      disconnect_worker_database
      disconnect_object_storage
      disconnect_native_metadata_api
      "${compose[@]}" stop object-storage postgres
      rm -f "$PLATFORM_LOCAL_NGINX_CONFIG" "$PLATFORM_LOCAL_PROXY_RUNTIME_TOKEN_FILE" "$PLATFORM_LOCAL_NATIVE_METADATA_WORKER_TOKEN_FILE"
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
    "${compose[@]}" stop enterprise-directory-sync
    disconnect_directory_sync
    disconnect_worker_database
    disconnect_object_storage
    disconnect_native_metadata_api
    "${compose[@]}" stop object-storage postgres
    rm -f "$PLATFORM_LOCAL_NGINX_CONFIG" "$PLATFORM_LOCAL_PROXY_RUNTIME_TOKEN_FILE" "$PLATFORM_LOCAL_NATIVE_METADATA_WORKER_TOKEN_FILE"
    ;;
  reset)
    [[ "${2:-}" == "$PLATFORM_LOCAL_PROJECT" ]] || {
      echo "Reset requires the exact isolated project name as confirmation" >&2
      exit 1
    }
    worker_context
    check_database_resource_ownership
    check_database_network_ownership
    check_object_storage_resource_ownership
    check_object_storage_network_ownership
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
