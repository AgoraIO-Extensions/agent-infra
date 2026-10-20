#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
chart_dir=${ACK_CHART_DIR:-"$repo_root/deploy/ack/chart"}
namespace=${ACK_NAMESPACE:-agent-infra}
: "${ACK_KUBECONFIG:?Set ACK_KUBECONFIG to the cluster config outside the repository}"
export KUBECONFIG="$ACK_KUBECONFIG"

kubectl version --request-timeout=10s >/dev/null
kubectl get namespace "$namespace" >/dev/null
helm lint "$chart_dir" >/dev/null

required_secrets=(
  ack-ghcr-pull
  agent-infra-platform-database
  agent-infra-api-configuration
  agent-infra-api-proxy-token
  agent-infra-encryption-public-key
  agent-infra-directory-db
  agent-infra-directory-migration-db
  agent-infra-directory-runtime
  agent-infra-directory-ca
  agent-infra-worker-configuration
  agent-infra-worker-runtime-auth
  agent-infra-worker-keyring
  agent-infra-worker-directory-read
  agent-infra-worker-ca
)
for secret in "${required_secrets[@]}"; do
  kubectl -n "$namespace" get secret "$secret" >/dev/null || {
    echo "missing Secret: $namespace/$secret" >&2
    exit 2
  }
done
kubectl -n "$namespace" get configmap agent-infra-directory-source >/dev/null || {
  echo "missing ConfigMap: $namespace/agent-infra-directory-source" >&2
  exit 2
}

echo "ACK preflight passed for namespace=$namespace chart=$chart_dir"
