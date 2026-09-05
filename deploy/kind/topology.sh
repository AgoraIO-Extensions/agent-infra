#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
chart="$repository_root/deploy/helm/agent-infra"
values="$repository_root/deploy/environments/kind.values.yaml"
cluster_config="$repository_root/deploy/kind/cluster.yaml"
cluster_name=agent-infra-topology
namespace=agent-infra
kind_bin=${KIND_BIN:-kind}
kubectl_bin=${KUBECTL_BIN:-kubectl}
helm_bin=${HELM_BIN:-helm}
docker_bin=${DOCKER_BIN:-docker}
curl_bin=${CURL_BIN:-curl}
openssl_bin=${OPENSSL_BIN:-openssl}
node_image=$(awk '/image: kindest\/node:/ { print $2 }' "$cluster_config")
state_dir=
kubeconfig=
topology_temp=

cleanup() {
	if [[ -n "$topology_temp" && -d "$topology_temp" ]]; then
		rm -r "$topology_temp"
	fi
	if [[ -n "$state_dir" && -d "$state_dir" ]]; then
		rm -r "$state_dir"
	fi
}
trap cleanup EXIT

prepare_state() {
	umask 077
	state_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-infra-kind-topology.XXXXXX")
	chmod 700 "$state_dir"
	kubeconfig="$state_dir/kubeconfig"
}

write_kubeconfig() {
	"$kind_bin" get kubeconfig --name "$cluster_name" > "$kubeconfig"
	chmod 600 "$kubeconfig"
}

render() {
	echo "kind v0.30.0"
	echo "$node_image"
	"$helm_bin" lint "$chart" --values "$values" --strict >/dev/null
	"$helm_bin" template topology "$chart" \
		--namespace "$namespace" \
		--values "$values" >/dev/null
}

require_kind() {
	local version
	version=$("$kind_bin" version)
	if [[ "$version" != "kind v0.30.0"* ]]; then
		echo "kind v0.30.0 is required" >&2
		exit 1
	fi
}

cluster_exists() {
	local clusters
	if ! clusters=$("$kind_bin" get clusters); then
		echo "failed to list kind clusters" >&2
		exit 1
	fi
	local candidate
	while IFS= read -r candidate; do
		[[ "$candidate" == "$cluster_name" ]] && return 0
	done <<< "$clusters"
	return 1
}

verify_cluster_image() {
	local actual_image
	actual_image=$("$docker_bin" inspect \
		--format '{{.Config.Image}}' "$cluster_name-control-plane")
	if [[ "$actual_image" != "$node_image" ]]; then
		echo "kind node image does not match cluster.yaml" >&2
		exit 1
	fi
}

apply_fixture_secrets() {
	"$kubectl_bin" --kubeconfig "$kubeconfig" -n "$namespace" \
		create secret generic agent-infra-platform-database \
		--from-literal=url=postgresql://topology.invalid/agent_infra \
		--dry-run=client -o yaml | \
		"$kubectl_bin" --kubeconfig "$kubeconfig" apply -f - >/dev/null
	"$kubectl_bin" --kubeconfig "$kubeconfig" -n "$namespace" \
		create secret generic agent-infra-worker-decryption-keyring \
		--from-literal=keyring.pem=topology-only \
		--dry-run=client -o yaml | \
		"$kubectl_bin" --kubeconfig "$kubeconfig" apply -f - >/dev/null
	topology_temp=$(mktemp -d "${TMPDIR:-/tmp}/agent-infra-kind-tls.XXXXXX")
	"$openssl_bin" req -x509 -newkey rsa:2048 -nodes -days 1 \
		-subj /CN=agent.kind.example.invalid \
		-keyout "$topology_temp/tls.key" \
		-out "$topology_temp/tls.crt" >/dev/null 2>&1
	"$kubectl_bin" --kubeconfig "$kubeconfig" -n "$namespace" \
		create secret tls agent-infra-kind-topology-tls \
		--key "$topology_temp/tls.key" \
		--cert "$topology_temp/tls.crt" \
		--dry-run=client -o yaml | \
		"$kubectl_bin" --kubeconfig "$kubeconfig" apply -f - >/dev/null
	rm -r "$topology_temp"
	topology_temp=
}

up() {
	require_kind
	render
	prepare_state
	if ! cluster_exists; then
		"$kind_bin" create cluster \
			--name "$cluster_name" \
			--config "$cluster_config" \
			--kubeconfig "$kubeconfig" \
			--wait 5m
	fi
	verify_cluster_image
	write_kubeconfig
	"$kubectl_bin" --kubeconfig "$kubeconfig" create namespace "$namespace" \
		--dry-run=client -o yaml | \
		"$kubectl_bin" --kubeconfig "$kubeconfig" apply -f - >/dev/null
	apply_fixture_secrets
	"$helm_bin" upgrade --install topology "$chart" \
		--kubeconfig "$kubeconfig" \
		--namespace "$namespace" \
		--values "$values" \
		--wait \
		--timeout 5m
	verify_topology
}

verify_topology() {
	"$kubectl_bin" --kubeconfig "$kubeconfig" -n "$namespace" \
		rollout status deployment/topology-agent-infra-platform-worker --timeout=2m
	"$kubectl_bin" --kubeconfig "$kubeconfig" -n "$namespace" \
		rollout status statefulset/topology-agent-infra-workload --timeout=2m
	"$kubectl_bin" --kubeconfig "$kubeconfig" -n "$namespace" \
		rollout status deployment/topology-agent-infra-route --timeout=2m
	"$kubectl_bin" --kubeconfig "$kubeconfig" -n "$namespace" \
		get service/topology-agent-infra-workload \
		networkpolicy/topology-agent-infra-workload \
		service/topology-agent-infra-route >/dev/null
	local route_log
	route_log=$(mktemp "${TMPDIR:-/tmp}/agent-infra-kind-route.XXXXXX")
	"$kubectl_bin" --kubeconfig "$kubeconfig" -n "$namespace" \
		port-forward service/topology-agent-infra-route 18443:443 \
		>"$route_log" 2>&1 &
	local route_pid=$!
	local route_ready=false
	for _ in {1..30}; do
		if "$curl_bin" --fail --insecure --silent https://127.0.0.1:18443/ >/dev/null; then
			route_ready=true
			break
		fi
		sleep 1
	done
	kill "$route_pid" >/dev/null 2>&1 || true
	wait "$route_pid" >/dev/null 2>&1 || true
	rm -f "$route_log"
	[[ "$route_ready" == "true" ]]
	local worker_authority
	worker_authority=$("$kubectl_bin" --kubeconfig "$kubeconfig" auth can-i \
		create statefulsets \
		--namespace "$namespace" \
		--as "system:serviceaccount:$namespace:topology-agent-infra-platform-worker")
	[[ "$worker_authority" == "yes" ]]
	local workload_authority
	workload_authority=$("$kubectl_bin" --kubeconfig "$kubeconfig" auth can-i \
		get pods \
		--namespace "$namespace" \
		--as "system:serviceaccount:$namespace:topology-agent-infra-workload" || true)
	[[ "$workload_authority" == "no" ]]
	if "$kubectl_bin" --kubeconfig "$kubeconfig" -n "$namespace" \
		get deployment/topology-agent-infra-web >/dev/null 2>&1; then
		echo "Web must remain external in the kind topology" >&2
		exit 1
	fi
	if "$kubectl_bin" --kubeconfig "$kubeconfig" -n "$namespace" \
		get deployment/topology-agent-infra-platform-api >/dev/null 2>&1; then
		echo "Platform API must remain external in the kind topology" >&2
		exit 1
	fi
}

verify() {
	require_kind
	if ! cluster_exists; then
		echo "kind cluster agent-infra-topology does not exist" >&2
		exit 1
	fi
	verify_cluster_image
	prepare_state
	write_kubeconfig
	verify_topology
}

down() {
	require_kind
	if ! cluster_exists; then
		echo "kind cluster $cluster_name does not exist" >&2
		return 0
	fi
	verify_cluster_image
	"$kind_bin" delete cluster --name "$cluster_name"
}

case "${1:-}" in
	render) render ;;
	up) up ;;
	verify) verify ;;
	down) down ;;
	*)
		echo "usage: $0 {render|up|verify|down}" >&2
		exit 2
		;;
esac
