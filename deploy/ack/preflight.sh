#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
chart_dir=${ACK_CHART_DIR:-"$repo_root/deploy/ack/chart"}
namespace=${ACK_NAMESPACE:-agent-infra}
: "${ACK_KUBECONFIG:?Set ACK_KUBECONFIG outside the repository}"
: "${ACK_VALUES_FILE:?Set ACK_VALUES_FILE to private target values}"
export KUBECONFIG="$ACK_KUBECONFIG"
export ACK_NAMESPACE="$namespace"

kubectl get namespace "$namespace" --request-timeout=10s >/dev/null 2>&1 || {
  echo "ACK namespace is unavailable; preflight does not create resources" >&2
  exit 2
}
kube_version=$(kubectl version --request-timeout=10s -o json 2>/dev/null | node -e '
let data="";process.stdin.on("data",chunk=>data+=chunk).on("end",()=>{
 try {const version=JSON.parse(data).serverVersion.gitVersion;
 if(!/^v[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*$/.test(version))process.exit(1);
 process.stdout.write(version);}catch{process.exit(1)}
});') || { echo "ACK cluster version unavailable" >&2; exit 2; }

rendered=$(mktemp)
trap 'unlink "$rendered"' EXIT
helm lint "$chart_dir" --values "$ACK_VALUES_FILE" --strict >/dev/null 2>&1 || {
  echo "ACK chart values lint failed" >&2
  exit 2
}
helm template "${ACK_RELEASE:-agent-infra-ack}" "$chart_dir" --namespace "$namespace" \
  --kube-version "$kube_version" --values "$ACK_VALUES_FILE" >"$rendered" 2>/dev/null || {
  echo "ACK chart rendering failed" >&2
  exit 2
}
node "$repo_root/deploy/ack/bootstrap-inputs.ts" existing "$rendered"
