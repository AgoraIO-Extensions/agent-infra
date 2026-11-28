#!/usr/bin/env bash

# Add both providers to the full-release Helm inputs only when the receipt carries
# measurements for both. The gate below verifies each provider on every node.
ack_session_recovery_values() {
  [[ -n "${ACK_NETWORKPOLICY_EVIDENCE_FILE:-}" ]] || return 0
  # External charts accepted by ACK_CHART_DIR can predate this Helm value.
  [[ -f "$chart_dir/values.schema.json" ]] && node -e '
    const schema = require(process.argv[1]);
    process.exit(schema.properties?.sessionRuntimeScheduling?.properties?.retainBothComputes ? 0 : 1);
  ' "$chart_dir/values.schema.json" || return 0
  if node -e '
    try {
      const evidence = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      const kinds = new Set(evidence.probes.map(p => p.destination.compute));
      process.exit(kinds.has("acs") && kinds.has("eci") ? 0 : 1);
    } catch { process.exit(1); }
  ' "$ACK_NETWORKPOLICY_EVIDENCE_FILE"; then
    release_values+=(--set sessionRuntimeScheduling.retainBothComputes=true)
  fi
}
# Deployment callers supply their own render and the same values passed to helm upgrade.
ack_release_preflight() (
  set -euo pipefail
  umask 077
  local rendered=$1 scope=$2
  shift 2
  if [[ -n "$scope" && "$scope" != "--codex-trial" ]]; then
    echo "Invalid ACK preflight scope" >&2
    exit 2
  fi
  local repo_root
  repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  local chart_dir=${ACK_CHART_DIR:-"$repo_root/deploy/ack/chart"}
  local namespace=${ACK_NAMESPACE:-agent-infra}
  : "${ACK_KUBECONFIG:?Set ACK_KUBECONFIG outside the repository}"
  : "${ACK_VALUES_FILE:?Set ACK_VALUES_FILE to private target values}"
  export KUBECONFIG="$ACK_KUBECONFIG"
  export ACK_NAMESPACE="$namespace"

  kubectl get namespace "$namespace" --request-timeout=10s >/dev/null 2>&1 || {
    echo "ACK namespace is unavailable; preflight does not create resources" >&2
    exit 2
  }
  helm lint "$chart_dir" "$@" --strict >/dev/null 2>&1 || {
    echo "ACK chart values lint failed" >&2
    exit 2
  }
  if [[ -z "$rendered" ]]; then
    rendered=$(mktemp)
    trap 'unlink "$rendered"' EXIT
    local kube_version
    kube_version=$(kubectl version --request-timeout=10s -o json 2>/dev/null | node -e '
    let data="";process.stdin.on("data",chunk=>data+=chunk).on("end",()=>{
     try {const version=JSON.parse(data).serverVersion.gitVersion;
     if(!/^v[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*$/.test(version))process.exit(1);
     process.stdout.write(version);}catch{process.exit(1)}
    });') || { echo "ACK cluster version unavailable" >&2; exit 2; }
    helm template "${ACK_RELEASE:-agent-infra-ack}" "$chart_dir" --namespace "$namespace" \
      --kube-version "$kube_version" "$@" >"$rendered" 2>/dev/null || {
      echo "ACK chart rendering failed" >&2
      exit 2
    }
  fi
  # Agent workloads and Sessions run only where NetworkPolicy is proven enforced
  # (Engineering Spec §10.1). ACS rollouts also verify the serving Worker's mounted file digest.
  ACK_RENDERED_MANIFEST_FILE="$rendered" \
    node "$repo_root/deploy/ack/networkpolicy-enforcement.mjs" ${scope:+"$scope"} >&2 || {
    echo "ACK NetworkPolicy enforcement evidence is missing or does not match" >&2
    exit 2
  }
  node "$repo_root/deploy/ack/bootstrap-inputs.ts" existing "$rendered"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  [[ $# -le 1 ]] || { echo "Invalid ACK preflight arguments" >&2; exit 2; }
  chart_dir=${ACK_CHART_DIR:-"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/chart"}
  release_values=(--values "${ACK_VALUES_FILE:?Set ACK_VALUES_FILE to private target values}")
  ack_session_recovery_values
  ack_release_preflight "" "${1:-}" "${release_values[@]}"
fi
