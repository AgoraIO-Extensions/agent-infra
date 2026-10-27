#!/usr/bin/env bash
set -euo pipefail

# Re-deploy and validate an ACK environment from one immutable source tuple.
# Secrets, kubeconfig and browser state stay outside the repository.

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
chart_dir=${ACK_CHART_DIR:-"$repo_root/deploy/ack/chart"}
namespace=${ACK_NAMESPACE:-agent-infra}
release=${ACK_RELEASE:-agent-infra-ack}
values_file=${ACK_VALUES_FILE:-}
timeout=${ACK_HELM_TIMEOUT:-15m}
source_sha=${ACK_SOURCE_SHA:-}
image_manifest=${ACK_IMAGE_MANIFEST:-}
evidence_dir=${ACK_EVIDENCE_DIR:-"${TMPDIR:-/tmp}/agent-infra-ack-redeploy-$(date -u +%Y%m%dT%H%M%SZ)"}

die() {
	echo "ack-redeploy: $*" >&2
	exit 2
}

usage() {
	cat <<'EOF'
Usage: deploy/ack/redeploy.sh <plan|deploy|provision|validate|clean|destroy|all>

Required for plan/deploy/validate:
  ACK_KUBECONFIG   private kubeconfig path
  ACK_VALUES_FILE  private Helm values file
  ACK_SOURCE_SHA   exact 40-hex commit used to build the immutable images
  ACK_IMAGE_MANIFEST private platform-amd64 image manifest JSON for that commit

Optional validation inputs:
  ACK_TEMPLATE_CONFIG_DIR  directory containing codex.json, claude.json,
                           opencode.json and pi.json for conversation-browser
  ACK_CUSTOM_AGENT_CONFIGS newline-separated private probe config paths
  ACK_CUSTOM_AGENT_PROBE   web (default) or platform-auth
  ACK_EVIDENCE_DIR         external directory for redacted receipts
  ACK_AGENT_REQUESTS_FILE  private JSON list for API Agent creation/replay

Destructive operations require exact confirmation:
  ACK_CLEAN_CONFIRM=DELETE_ACK_ENV deploy/ack/redeploy.sh destroy
  ACK_CLEAN_DELETE_DATA=true      also delete PVCs and Secrets
  ACK_CLEAN_DELETE_NAMESPACE=true delete the namespace after resources are gone
EOF
}

require_file() {
	local name=$1 path=$2
	[[ -n "$path" ]] || die "$name is required"
	[[ -r "$path" ]] || die "$name is not readable: $path"
}

require_source_tuple() {
	require_file ACK_KUBECONFIG "${ACK_KUBECONFIG:-}"
	require_file ACK_VALUES_FILE "$values_file"
	require_file ACK_IMAGE_MANIFEST "$image_manifest"
	[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || die "ACK_SOURCE_SHA must be a 40-hex commit"
	[[ -d "$chart_dir" ]] || die "chart directory does not exist: $chart_dir"
	local actual
	actual=$(git -C "$repo_root" rev-parse HEAD)
	[[ "$actual" == "$source_sha" ]] || die "worktree HEAD $actual does not match ACK_SOURCE_SHA $source_sha"
	if ! node - "$image_manifest" "$source_sha" <<'NODE'
const fs = require("node:fs");
const [file, source] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, "utf8"));
if (value.schemaVersion !== 1 || value.commitSha !== source || value.platform !== "linux/amd64") process.exit(1);
for (const name of ["web", "platformApi", "platformWorker", "enterpriseDirectorySync"]) {
	const image = value.images?.[name];
	if (!image || typeof image.repository !== "string" || !/^sha256:[0-9a-f]{64}$/.test(image.digest)) process.exit(1);
}
NODE
	then
		die "ACK_IMAGE_MANIFEST does not match ACK_SOURCE_SHA/linux-amd64 or lacks platform image digests"
	fi
}

prepare_evidence() {
	mkdir -p "$evidence_dir"
	chmod 700 "$evidence_dir"
	printf '%s\n' "$source_sha" >"$evidence_dir/source-sha"
	date -u +%Y-%m-%dT%H:%M:%SZ >"$evidence_dir/started-at"
}

render_manifest() {
	local output=$1
	helm template "$release" "$chart_dir" \
		--namespace "$namespace" \
		--values "$values_file" >"$output"
	for placeholder in \
		"sha256:0000000000000000000000000000000000000000000000000000000000000000" \
		"https://ack.example.invalid" \
		"ww0000000000000000"; do
		if grep -qF -- "$placeholder" "$output"; then
			die "rendered values still contain placeholder: $placeholder"
		fi
	done
}

snapshot() {
	local prefix=${1:-snapshot}
	export KUBECONFIG="$ACK_KUBECONFIG"
	local helm_list
	helm_list=$(helm list -n "$namespace" -o json 2>/dev/null || printf '[]')
	{
		printf 'source_sha=%s\nnamespace=%s\nrelease=%s\n' "$source_sha" "$namespace" "$release"
		printf '%s\n' "$helm_list" | node -e '
let s=""; process.stdin.on("data", c => s+=c).on("end", () => { try { const a=JSON.parse(s); console.log(`helm_revision=${a[0]?.revision ?? "absent"}`); } catch { console.log("helm_revision=unavailable"); } });'
	} >"$evidence_dir/$prefix.txt"
	helm history "$release" -n "$namespace" -o json >"$evidence_dir/$prefix-helm-history.json" 2>/dev/null || true
	kubectl -n "$namespace" get deploy,pod,job,svc,ingress,pvc -o wide >"$evidence_dir/$prefix-resources.txt" 2>&1 || true
	kubectl -n "$namespace" get deploy -o json >"$evidence_dir/$prefix-deployments.json" 2>/dev/null || true
	kubectl -n "$namespace" get events --sort-by=.metadata.creationTimestamp >"$evidence_dir/$prefix-events.txt" 2>/dev/null || true
}

plan() {
	require_source_tuple
	prepare_evidence
	render_manifest "$evidence_dir/rendered.yaml"
	helm lint "$chart_dir" --values "$values_file" --strict
	snapshot plan
	echo "ack-redeploy: plan passed; evidence=$evidence_dir"
}

deploy() {
	require_source_tuple
	prepare_evidence
	render_manifest "$evidence_dir/rendered.yaml"
	"$repo_root/deploy/ack/preflight.sh"
	export KUBECONFIG="$ACK_KUBECONFIG"
	helm upgrade --install "$release" "$chart_dir" \
		--namespace "$namespace" \
		--create-namespace \
		--values "$values_file" \
		--wait \
		--timeout "$timeout"
	kubectl -n "$namespace" rollout status deployment/agent-infra-api --timeout="$timeout"
	kubectl -n "$namespace" rollout status deployment/agent-infra-web --timeout="$timeout"
	kubectl -n "$namespace" rollout status deployment/agent-infra-worker --timeout="$timeout"
	kubectl -n "$namespace" rollout status deployment/agent-infra-directory --timeout="$timeout"
	snapshot deployed
	echo "ack-redeploy: deploy passed; evidence=$evidence_dir"
}

provision() {
	require_source_tuple
	local requests=${ACK_AGENT_REQUESTS_FILE:-}
	require_file ACK_AGENT_REQUESTS_FILE "$requests"
	prepare_evidence
	if ! node "$repo_root/deploy/ack/provision-agents.mjs" "$requests" >"$evidence_dir/agent-provision.json"; then
		die "one or more Agent API creation requests failed; inspect redacted receipt: $evidence_dir/agent-provision.json"
	fi
	echo "ack-redeploy: Agent provision passed; evidence=$evidence_dir"
}

validate_endpoint() {
	local origin=${ACK_PUBLIC_ORIGIN:-}
	[[ "$origin" =~ ^https://[^/]+$ ]] || die "ACK_PUBLIC_ORIGIN must be an HTTPS origin"
	local status
	status=$(curl --silent --show-error --insecure --output "$evidence_dir/web.body" --write-out '%{http_code}' "$origin/" || true)
	[[ "$status" == 200 ]] || die "Web readiness expected HTTP 200, got $status"
	status=$(curl --silent --show-error --insecure --output "$evidence_dir/api.body" --write-out '%{http_code}' "$origin/api/v2/agents" || true)
	[[ "$status" == 401 ]] || die "anonymous API probe expected HTTP 401, got $status"
	rm -f "$evidence_dir/web.body" "$evidence_dir/api.body"
}

validate_templates() {
	local dir=${ACK_TEMPLATE_CONFIG_DIR:-}
	[[ -n "$dir" ]] || die "ACK_TEMPLATE_CONFIG_DIR is required for four-template validation"
	[[ -d "$dir" ]] || die "template config directory does not exist: $dir"
	local template config out
	for template in codex claude opencode pi; do
		config="$dir/$template.json"
		[[ -r "$config" ]] || die "missing template config: $config"
		out="$evidence_dir/template-$template.json"
		local run_output receipt_dir
		run_output=$(node "$repo_root/tests/local-real-e2e/conversation-browser.mjs" "$config" 2>&1) || {
			printf '%s\n' "$run_output" >"$evidence_dir/template-$template.failure.log"
			die "template validation failed: $template"
		}
		receipt_dir=$(printf '%s\n' "$run_output" | tail -n 1)
		[[ -r "$receipt_dir/evidence.json" ]] || die "template validation did not produce evidence: $template"
		cp "$receipt_dir/evidence.json" "$out"
		node - "$out" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, "utf8"));
delete value.directory;
delete value.origin;
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE
		node - "$out" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value.result !== "passed") process.exit(1);
NODE
		rm -rf "$receipt_dir"
	done
}

validate_custom_agents() {
	local configs=${ACK_CUSTOM_AGENT_CONFIGS:-}
	[[ -n "$configs" ]] || return 0
	local probe=${ACK_CUSTOM_AGENT_PROBE:-web}
	local script
	case "$probe" in
		web) script="$repo_root/tests/local-real-e2e/custom-agent-web-probe.ts" ;;
		platform-auth) script="$repo_root/tests/local-real-e2e/custom-agent-platform-auth-probe.ts" ;;
		*) die "ACK_CUSTOM_AGENT_PROBE must be web or platform-auth" ;;
	esac
	local config index=0
	while IFS= read -r config; do
		[[ -n "$config" ]] || continue
		[[ -r "$config" ]] || die "custom Agent config is not readable: $config"
		if ! node --experimental-strip-types "$script" "$config" >"$evidence_dir/custom-agent-$index.json"; then
			die "custom Agent probe failed: $config"
		fi
		if ! node - "$evidence_dir/custom-agent-$index.json" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value.pass !== true) process.exit(1);
NODE
		then
			die "custom Agent probe failed: $config"
		fi
		index=$((index + 1))
	done <<<"$configs"
}

validate() {
	require_source_tuple
	prepare_evidence
	export KUBECONFIG="$ACK_KUBECONFIG"
	kubectl -n "$namespace" wait --for=condition=available deployment/agent-infra-api deployment/agent-infra-web deployment/agent-infra-worker deployment/agent-infra-directory --timeout="$timeout"
	validate_endpoint
	validate_templates
	validate_custom_agents
	snapshot validated
	date -u +%Y-%m-%dT%H:%M:%SZ >"$evidence_dir/completed-at"
	echo "ack-redeploy: validate passed; evidence=$evidence_dir"
}

clean() {
	require_file ACK_KUBECONFIG "${ACK_KUBECONFIG:-}"
	export KUBECONFIG="$ACK_KUBECONFIG"
	prepare_evidence
	snapshot before-clean
	helm uninstall "$release" -n "$namespace" --wait --timeout="$timeout" 2>/dev/null || true
	kubectl -n "$namespace" delete mutatingadmissionpolicy,mutatingadmissionpolicybinding \
		"$namespace-session-eci" --ignore-not-found >/dev/null 2>&1 || true
	kubectl -n "$namespace" delete all,role,rolebinding,serviceaccount,resourcequota,networkpolicy,ingress \
		-l app.kubernetes.io/name=agent-infra --ignore-not-found >/dev/null 2>&1 || true
	snapshot after-clean
	echo "ack-redeploy: chart-owned workloads removed; PVCs, Secrets and user Agents were preserved; evidence=$evidence_dir"
}

destroy() {
	[[ "${ACK_CLEAN_CONFIRM:-}" == DELETE_ACK_ENV ]] || die "destroy requires ACK_CLEAN_CONFIRM=DELETE_ACK_ENV"
	[[ "${ACK_CLEAN_DELETE_DATA:-false}" == true ]] || die "destroy requires ACK_CLEAN_DELETE_DATA=true"
	[[ "${ACK_CLEAN_DELETE_NAMESPACE:-false}" == true ]] || die "destroy requires ACK_CLEAN_DELETE_NAMESPACE=true"
	require_file ACK_KUBECONFIG "${ACK_KUBECONFIG:-}"
	export KUBECONFIG="$ACK_KUBECONFIG"
	prepare_evidence
	snapshot before-destroy
	kubectl delete namespace "$namespace" --wait --timeout="$timeout"
	echo "ack-redeploy: namespace destroyed; evidence=$evidence_dir"
}

command=${1:-help}
case "$command" in
	help|-h|--help) usage ;;
	plan) plan ;;
	deploy) deploy ;;
	validate) validate ;;
	clean) clean ;;
	destroy) destroy ;;
	provision) provision ;;
	all) deploy; if [[ -n "${ACK_AGENT_REQUESTS_FILE:-}" ]]; then provision; fi; validate ;;
	*) usage; die "unknown command: $command" ;;
esac
