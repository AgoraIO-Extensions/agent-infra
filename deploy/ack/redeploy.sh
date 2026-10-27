#!/usr/bin/env bash
set -euo pipefail
umask 077

# Re-deploy and validate an ACK environment from one immutable source tuple.
# Secrets, kubeconfig and browser state stay outside the repository.

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
chart_dir=${ACK_CHART_DIR:-"$repo_root/deploy/ack/chart"}
namespace=${ACK_NAMESPACE:-agent-infra}
export ACK_NAMESPACE="$namespace"
release=${ACK_RELEASE:-agent-infra-ack}
values_file=${ACK_VALUES_FILE:-}
timeout=${ACK_HELM_TIMEOUT:-15m}
source_sha=${ACK_SOURCE_SHA:-}
image_manifest=${ACK_IMAGE_MANIFEST:-}
runtime_manifest=${ACK_RUNTIME_IMAGE_MANIFEST:-}
evidence_dir=${ACK_EVIDENCE_DIR:-"${TMPDIR:-/tmp}/agent-infra-ack-redeploy-$(date -u +%Y%m%dT%H%M%SZ)"}

die() {
	echo "ack-redeploy: $*" >&2
	exit 2
}

usage() {
	cat <<'EOF'
Usage: deploy/ack/redeploy.sh <capture-inputs|plan|bootstrap-plan|bootstrap-inputs|bootstrap-database|bootstrap-credential|cleanup-plan|deploy|provision|validate|clean|destroy|all>

Required for plan/deploy/validate:
  ACK_KUBECONFIG   private kubeconfig path
  ACK_VALUES_FILE  private Helm values file
  ACK_SOURCE_SHA   exact 40-hex commit used to build the immutable images
  ACK_IMAGE_MANIFEST private platform-amd64 image manifest JSON for that commit
  ACK_RUNTIME_IMAGE_MANIFEST private amd64 RuntimeHost manifest JSON for that commit

Optional validation inputs:
  ACK_TEMPLATE_CONFIG_DIR  directory containing codex.json, claude.json,
                           opencode.json and pi.json for conversation-browser
  ACK_CUSTOM_AGENT_CONFIGS newline-separated private probe config paths
  ACK_CUSTOM_AGENT_PROBE   web (default) or platform-auth
  ACK_CA_CERT_FILE         private CA bundle for the public HTTPS origin
  ACK_EVIDENCE_DIR         external directory for redacted receipts
  ACK_BOOTSTRAP_INPUTS_FILE private Secret/ConfigMap file-reference bundle
  ACK_AGENT_REQUESTS_FILE  private JSON list for API Agent creation/replay
  ACK_CREDENTIAL_BOOTSTRAP_FILE private browser storageState credential request
  ACK_CLEANUP_PLAN_FILE    private cluster/namespace ownership input for cleanup-plan
  ACK_AGENT_STATE_DIR      external existing 0700 directory for private ID bindings
  ACK_BROWSER_BLUEPRINT_DIR private browser configs without a fixed Agent ID
  ACK_CAPTURE_DIR          external 0700 directory for read-only ACK input capture

`destroy` requires both ACK_CLEAN_CONFIRM=DELETE_ACK_ENV and
ACK_CLEAN_ALLOW_FOREIGN=DELETE_ALL_ACK_NAMESPACE. It deletes the selected
namespace and the exact Session ECI admission objects after identity checks.

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
	require_file ACK_RUNTIME_IMAGE_MANIFEST "$runtime_manifest"
	[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || die "ACK_SOURCE_SHA must be a 40-hex commit"
	[[ -d "$chart_dir" ]] || die "chart directory does not exist: $chart_dir"
	local actual
	actual=$(git -C "$repo_root" rev-parse HEAD)
	[[ "$actual" == "$source_sha" ]] || die "worktree HEAD $actual does not match ACK_SOURCE_SHA $source_sha"
	local worktree_status
	worktree_status=$(git -C "$repo_root" status --porcelain --untracked-files=all) || die "cannot verify worktree cleanliness"
	[[ -z "$worktree_status" ]] || die "source checkout must be clean; commit or remove local changes before redeploying"
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
	if ! node - "$runtime_manifest" "$source_sha" <<'NODE'
const fs = require("node:fs");
const [file, source] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, "utf8"));
if (
	value.schemaVersion !== 1 ||
	value.commitSha !== source ||
	value.platform !== "linux/amd64" ||
	typeof value.repository !== "string" ||
	!/^sha256:[0-9a-f]{64}$/u.test(value.digest ?? "")
)
	process.exit(1);
NODE
	then
		die "ACK_RUNTIME_IMAGE_MANIFEST does not match ACK_SOURCE_SHA/linux-amd64"
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
	local kube_version
	kube_version=$(kubectl --kubeconfig "$ACK_KUBECONFIG" version --request-timeout=10s -o json 2>/dev/null | node -e '
let data="";process.stdin.on("data", chunk=>data+=chunk).on("end",()=>{
 try {const version=JSON.parse(data).serverVersion.gitVersion;
 if(!/^v[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*$/.test(version))process.exit(1);
 process.stdout.write(version);}catch{process.exit(1)}
});') || die "ACK_CLUSTER_VERSION_READ_FAILED"
	helm template "$release" "$chart_dir" \
		--namespace "$namespace" --kube-version "$kube_version" \
		--values "$values_file" >"$output" 2>/dev/null || die "HELM_RENDER_FAILED"
	for placeholder in \
		"sha256:0000000000000000000000000000000000000000000000000000000000000000" \
		"https://ack.example.invalid" \
		"ww0000000000000000"; do
		if grep -qF -- "$placeholder" "$output"; then
			die "rendered values still contain placeholder: $placeholder"
		fi
	done
	node "$repo_root/deploy/ack/redeploy-evidence.ts" render "$output" "$image_manifest" "$runtime_manifest"

}

snapshot() {
	local prefix=${1:-snapshot}
	export KUBECONFIG="$ACK_KUBECONFIG"
	node "$repo_root/deploy/ack/redeploy-evidence.ts" snapshot "$namespace" "$release" "$source_sha" >"$evidence_dir/$prefix.json"
}

bootstrap_inputs() {
	require_source_tuple
	require_file ACK_BOOTSTRAP_INPUTS_FILE "${ACK_BOOTSTRAP_INPUTS_FILE:-}"
	prepare_evidence
	rendered_manifest=$(mktemp)
	trap 'unlink "$rendered_manifest"' EXIT
	render_manifest "$rendered_manifest"
	node "$repo_root/deploy/ack/bootstrap-inputs.ts" "$1" "$ACK_BOOTSTRAP_INPUTS_FILE" "$rendered_manifest" >"$evidence_dir/bootstrap-inputs.json"
	unlink "$rendered_manifest"
	trap - EXIT
}

bootstrap_database() {
	require_source_tuple
	require_file ACK_BOOTSTRAP_INPUTS_FILE "${ACK_BOOTSTRAP_INPUTS_FILE:-}"
	prepare_evidence
	rendered_manifest=$(mktemp)
	trap 'unlink "$rendered_manifest"' EXIT
	render_manifest "$rendered_manifest"
	node "$repo_root/deploy/ack/bootstrap-database.ts" "${1:-apply}" "$ACK_BOOTSTRAP_INPUTS_FILE" "$rendered_manifest" "$chart_dir" "$values_file" >"$evidence_dir/bootstrap-database.json"
	unlink "$rendered_manifest"
	trap - EXIT
}

bootstrap_credential() {
	require_file ACK_CREDENTIAL_BOOTSTRAP_FILE "${ACK_CREDENTIAL_BOOTSTRAP_FILE:-}"
	prepare_evidence
	if ! node "$repo_root/deploy/ack/bootstrap-credential.mjs" "$ACK_CREDENTIAL_BOOTSTRAP_FILE" >"$evidence_dir/api-credential.json"; then
		die "API credential bootstrap failed; inspect only the redacted receipt: $evidence_dir/api-credential.json"
	fi
	echo "ack-redeploy: API credential bootstrap passed; evidence=$evidence_dir"
}

capture_inputs() {
	require_file ACK_KUBECONFIG "${ACK_KUBECONFIG:-}"
	local output=${ACK_CAPTURE_DIR:-"${TMPDIR:-/tmp}/agent-infra-ack-inputs-$(date -u +%Y%m%dT%H%M%SZ)"}
	mkdir -p "$output"
	chmod 700 "$output"
	if ! node --experimental-strip-types "$repo_root/deploy/ack/capture-inputs.ts" "$output" >"$output/capture.stdout.json"; then
		die "ACK input capture failed; no deployment was attempted"
	fi
	chmod 600 "$output/capture.stdout.json"
	echo "ack-redeploy: existing ACK inputs captured read-only; source-bound image manifests remain required; capsule=$output"
}

cleanup_plan() {
	require_file ACK_CLEANUP_PLAN_FILE "${ACK_CLEANUP_PLAN_FILE:-}"
	prepare_evidence
	if ! node "$repo_root/deploy/ack/cleanup-plan.ts" "$ACK_CLEANUP_PLAN_FILE" >"$evidence_dir/cleanup-plan.json"; then
		die "cleanup plan failed closed; inspect only the bounded status code"
	fi
	echo "ack-redeploy: cleanup plan created; deletion remains disabled; evidence=$evidence_dir"
}

plan() {
	require_source_tuple
	prepare_evidence
	rendered_manifest=$(mktemp)
	trap 'unlink "$rendered_manifest"' EXIT
	render_manifest "$rendered_manifest"
	unlink "$rendered_manifest"
	trap - EXIT
	helm lint "$chart_dir" --values "$values_file" --strict >/dev/null 2>&1 || die "HELM_LINT_FAILED"
	snapshot plan
	echo "ack-redeploy: plan passed; evidence=$evidence_dir"
}

deploy() {
	require_source_tuple
	prepare_evidence
	rendered_manifest=$(mktemp)
	trap 'unlink "$rendered_manifest"' EXIT
	render_manifest "$rendered_manifest"
	unlink "$rendered_manifest"
	trap - EXIT
	"$repo_root/deploy/ack/preflight.sh"
	export KUBECONFIG="$ACK_KUBECONFIG"
	helm upgrade --install "$release" "$chart_dir" \
		--namespace "$namespace" \
		--create-namespace \
		--values "$values_file" \
		--set bootstrap.databaseOnly=false \
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
	[[ -n "${ACK_AGENT_STATE_DIR:-}" && -n "${ACK_BROWSER_BLUEPRINT_DIR:-}" ]] || die "Agent state and browser blueprint directories are required"
	if ! node "$repo_root/deploy/ack/agent-bindings.ts" provision "$requests" "$ACK_AGENT_STATE_DIR" "$ACK_BROWSER_BLUEPRINT_DIR" "$source_sha" >"$evidence_dir/agent-provision.json"; then
		die "one or more Agent API creation requests failed; inspect redacted receipt: $evidence_dir/agent-provision.json"
	fi
	export ACK_TEMPLATE_CONFIG_DIR="$ACK_AGENT_STATE_DIR/browser"
	echo "ack-redeploy: Agent provision passed; evidence=$evidence_dir"
}

validate_endpoint() {
	local origin=${ACK_PUBLIC_ORIGIN:-}
	[[ "$origin" =~ ^https://[^/]+$ ]] || die "ACK_PUBLIC_ORIGIN must be an HTTPS origin"
	local -a tls_args=()
	if [[ -n "${ACK_CA_CERT_FILE:-}" ]]; then
		require_file ACK_CA_CERT_FILE "$ACK_CA_CERT_FILE"
		tls_args+=(--cacert "$ACK_CA_CERT_FILE")
	fi
	local status
	status=$(curl --silent --show-error "${tls_args[@]}" --connect-timeout 10 --max-time 30 --output /dev/null --write-out '%{http_code}' "$origin/" || true)
	[[ "$status" == 200 ]] || die "Web readiness expected HTTP 200, got $status"
	status=$(curl --silent --show-error "${tls_args[@]}" --connect-timeout 10 --max-time 30 --output /dev/null --write-out '%{http_code}' "$origin/api/v2/agents" || true)
	[[ "$status" == 401 ]] || die "anonymous API probe expected HTTP 401, got $status"
}

validate_templates() {
	local dir=${ACK_TEMPLATE_CONFIG_DIR:-}
	if [[ -n "${ACK_AGENT_STATE_DIR:-}" ]]; then
		node "$repo_root/deploy/ack/agent-bindings.ts" materialize "${ACK_AGENT_REQUESTS_FILE:-}" "$ACK_AGENT_STATE_DIR" "${ACK_BROWSER_BLUEPRINT_DIR:-}" "$source_sha" >/dev/null
		dir="$ACK_AGENT_STATE_DIR/browser"
	fi
	[[ -n "$dir" ]] || die "ACK_TEMPLATE_CONFIG_DIR is required for four-template validation"
	[[ -d "$dir" ]] || die "template config directory does not exist: $dir"
	local template config out
	local -a journey_configs=("$dir/codex.json" "$dir/claude.json" "$dir/opencode.json" "$dir/pi.json")
	for config in "$dir"/custom-*.json; do
		[[ -f "$config" ]] || continue
		journey_configs+=("$config")
	done
	for config in "${journey_configs[@]}"; do
		template=$(basename "$config" .json)
		[[ -r "$config" ]] || die "missing template config: $config"
		out="$evidence_dir/template-$template.json"
		local run_output receipt_dir
		local run_status=0
		run_output=$(node "$repo_root/tests/local-real-e2e/conversation-browser.mjs" "$config" 2>&1) || run_status=$?

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
if (value.result !== "passed" || !Number.isInteger(value.requestedTurnCount) ||
	value.requestedTurnCount < 3 || value.completedTurnCount !== value.requestedTurnCount ||
	!Array.isArray(value.turns) || value.turns.length !== value.requestedTurnCount ||
	value.turns.some(turn => turn.result !== "passed")) process.exit(1);
NODE
		[[ "$run_status" -eq 0 ]] || die "browser journey failed"
		# Preserve the browser runner evidence and masked screenshots for diagnosis.
	done
}

validate_custom_agents() {
	local configs=${ACK_CUSTOM_AGENT_CONFIGS:-}
	[[ -n "$configs" ]] || die "ACK_CUSTOM_AGENT_CONFIGS is required"
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
	if ! node - "$evidence_dir/validated.json" "$configs" <<'NODE'
const fs = require("node:fs");
const [workloadsFile, configs] = process.argv.slice(2);
const workloads = JSON.parse(fs.readFileSync(workloadsFile, "utf8"));
const hash = value => require("node:crypto").createHash("sha256").update(value).digest("hex");
const images = new Set(workloads.resources.flatMap(resource => resource.images.map(image => image.digestHash)));
for (const file of configs.split("\n").filter(Boolean)) {
		const input = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!/^sha256:[a-f0-9]{64}$/.test(input.imageDigest) || !images.has(hash(input.imageDigest))) process.exit(1);
}
NODE
	then
		die "custom Agent declared image digest was not found in Kubernetes workload readback"
	fi
}

validate() {
	require_source_tuple
	prepare_evidence
	rendered_manifest=$(mktemp)
	trap 'unlink "$rendered_manifest"' EXIT
	render_manifest "$rendered_manifest"
	unlink "$rendered_manifest"
	trap - EXIT
	export KUBECONFIG="$ACK_KUBECONFIG"
	kubectl -n "$namespace" wait --for=condition=available deployment/agent-infra-api deployment/agent-infra-web deployment/agent-infra-worker deployment/agent-infra-directory --timeout="$timeout"
	validate_endpoint
	validate_templates
	snapshot validated
	validate_custom_agents
	date -u +%Y-%m-%dT%H:%M:%SZ >"$evidence_dir/completed-at"
	echo "ack-redeploy: browser/entry checks passed; full rebuild acceptance remains unverified; evidence=$evidence_dir"
}

clean() {
	die "ACK cleanup is disabled until an exact resource inventory and restore verification are implemented"
}

destroy() {
	[[ "${ACK_CLEAN_CONFIRM:-}" == DELETE_ACK_ENV ]] || die "destroy requires ACK_CLEAN_CONFIRM=DELETE_ACK_ENV"
	require_file ACK_KUBECONFIG "${ACK_KUBECONFIG:-}"
	require_file ACK_CLEANUP_PLAN_FILE "${ACK_CLEANUP_PLAN_FILE:-}"
	[[ "${ACK_CLEAN_ALLOW_FOREIGN:-}" == DELETE_ALL_ACK_NAMESPACE ]] || die "destroy requires ACK_CLEAN_ALLOW_FOREIGN=DELETE_ALL_ACK_NAMESPACE"
	prepare_evidence
	export KUBECONFIG="$ACK_KUBECONFIG"
	local expected_cluster expected_namespace
	expected_cluster=$(node - "$ACK_CLEANUP_PLAN_FILE" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!/^[a-f0-9-]{36}$/u.test(value.clusterUid) || !/^[a-f0-9-]{36}$/u.test(value.namespaceUid) ||
	!/^[a-f0-9-]{36}$/u.test(value.installationId) || value.namespace !== process.env.ACK_NAMESPACE ||
	value.release !== process.env.ACK_RELEASE) process.exit(1);
process.stdout.write(`${value.clusterUid}\n`);
NODE
) || die "cleanup identity input is invalid"
	expected_namespace=$(node - "$ACK_CLEANUP_PLAN_FILE" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(`${value.namespaceUid}\n`);
NODE
) || die "cleanup namespace identity input is invalid"
	local live_cluster live_namespace namespace_json
	live_cluster=$(kubectl --kubeconfig "$ACK_KUBECONFIG" get namespace kube-system -o jsonpath='{.metadata.uid}' 2>/dev/null) || die "cleanup cluster identity read failed"
	live_namespace=$(kubectl --kubeconfig "$ACK_KUBECONFIG" get namespace "$namespace" -o jsonpath='{.metadata.uid}' 2>/dev/null) || die "cleanup namespace identity read failed"
	[[ "$live_cluster" == "$expected_cluster" && "$live_namespace" == "$expected_namespace" ]] || die "cleanup UID identity mismatch"
	namespace_json=$(kubectl --kubeconfig "$ACK_KUBECONFIG" get namespace "$namespace" -o json 2>/dev/null) || die "cleanup namespace read failed"
	if ! node - "$namespace_json" <<'NODE'
const value = JSON.parse(process.argv[2]);
const labels = value.metadata?.labels ?? {};
if (labels["app.kubernetes.io/part-of"] !== "agent-infra" || labels["app.agoralab.co/workload-plane"] !== "agent-infra") process.exit(1);
NODE
	then
		die "cleanup namespace ownership labels are missing"
	fi
	cleanup_plan >/dev/null
	local admission="${namespace}-session-eci"
	kubectl --kubeconfig "$ACK_KUBECONFIG" delete mutatingadmissionpolicy "$admission" --ignore-not-found --wait >/dev/null 2>&1 || die "cleanup admission policy deletion failed"
	kubectl --kubeconfig "$ACK_KUBECONFIG" delete mutatingadmissionpolicybinding "$admission" --ignore-not-found --wait >/dev/null 2>&1 || die "cleanup admission binding deletion failed"
	kubectl --kubeconfig "$ACK_KUBECONFIG" delete namespace "$namespace" --wait --timeout="$timeout" >/dev/null 2>&1 || die "cleanup namespace deletion failed"
	local remaining_namespace
	remaining_namespace=$(kubectl --kubeconfig "$ACK_KUBECONFIG" get namespace "$namespace" --ignore-not-found -o name 2>/dev/null) \
		|| die "cleanup namespace absence verification failed"
	if [[ -n "$remaining_namespace" ]]; then
		die "cleanup namespace still exists"
	fi
	cat >"$evidence_dir/destroy.json" <<'JSON'
{"schemaVersion":1,"kind":"ack-destroy","namespaceDeleted":true,"sessionAdmissionDeleted":true,"foreignResourcesExplicitlyApproved":true,"dataRestoreVerified":false,"businessVerified":false}
JSON
	chmod 600 "$evidence_dir/destroy.json"
	echo "ack-redeploy: ACK namespace and exact Session ECI objects deleted; evidence=$evidence_dir"
}

command=${1:-help}
case "$command" in
	help|-h|--help) usage ;;
	capture-inputs) capture_inputs ;;
	plan) plan ;;
	bootstrap-plan) bootstrap_inputs plan ;;
	bootstrap-inputs) bootstrap_inputs apply ;;
	bootstrap-database) bootstrap_database ;;
	bootstrap-credential) bootstrap_credential ;;
	cleanup-plan) cleanup_plan ;;
	deploy) deploy ;;
	validate) validate ;;
	clean) clean ;;
	destroy) destroy ;;
	provision) provision ;;
	all)
		require_source_tuple
		if [[ -n "${ACK_BOOTSTRAP_INPUTS_FILE:-}" ]]; then
			bootstrap_database check
			bootstrap_inputs apply
			bootstrap_database
		fi
		deploy
		if [[ -n "${ACK_CREDENTIAL_BOOTSTRAP_FILE:-}" ]]; then
			bootstrap_credential
		fi
		node "$repo_root/deploy/ack/agent-bindings.ts" check "${ACK_AGENT_REQUESTS_FILE:-}" "${ACK_AGENT_STATE_DIR:-}" "${ACK_BROWSER_BLUEPRINT_DIR:-}" "$source_sha" >/dev/null
		provision
		validate
		;;
	*) usage; die "unknown command: $command" ;;
esac
