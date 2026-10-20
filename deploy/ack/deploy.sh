#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
chart_dir=${ACK_CHART_DIR:-"$repo_root/deploy/ack/chart"}
namespace=${ACK_NAMESPACE:-agent-infra}
release=${ACK_RELEASE:-agent-infra-ack}
values_file=${ACK_VALUES_FILE:-}
timeout=${ACK_HELM_TIMEOUT:-15m}

: "${ACK_KUBECONFIG:?Set ACK_KUBECONFIG to the cluster config outside the repository}"
if [[ -z "$values_file" ]]; then
  echo "ACK_VALUES_FILE must point to a deployment values file" >&2
  exit 2
fi
[[ -r "$values_file" ]] || { echo "ACK_VALUES_FILE is not readable: $values_file" >&2; exit 2; }
[[ -d "$chart_dir" ]] || { echo "ACK_CHART_DIR is not a chart directory: $chart_dir" >&2; exit 2; }

rendered_manifest=$(mktemp "${TMPDIR:-/tmp}/ack-rendered.XXXXXX")
trap 'rm -f "$rendered_manifest"' EXIT
helm template "$release" "$chart_dir" --namespace "$namespace" --values "$values_file" > "$rendered_manifest"
for placeholder in \
  "sha256:0000000000000000000000000000000000000000000000000000000000000000" \
  "https://ack.example.invalid" \
  "ww0000000000000000"; do
  if grep -qF -- "$placeholder" "$rendered_manifest"; then
    echo "ACK values still contain placeholder '$placeholder'; provide real values in the private values file" >&2
    exit 2
  fi
done

export KUBECONFIG="$ACK_KUBECONFIG"
"$repo_root/deploy/ack/preflight.sh"
helm upgrade --install "$release" "$chart_dir" \
  --namespace "$namespace" \
  --create-namespace \
  --values "$values_file" \
  --wait \
  --timeout "$timeout"

kubectl -n "$namespace" get deploy,pod,job,svc,ingress,pvc -o wide
