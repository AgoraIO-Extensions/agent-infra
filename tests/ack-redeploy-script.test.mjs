import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..");
const script = join(root, "deploy/ack/redeploy.sh");

test("bootstrap candidate creation and replay leave live consumers untouched", async (t) => {
	const source = await readFile(script, "utf8");
	const start = source.indexOf("bootstrap_inputs() {");
	const end = source.indexOf("bootstrap_database() {");
	assert(start > 0 && end > start);
	const bootstrap = source.slice(start, end);
	const directory = await mkdtemp(join(tmpdir(), "ack-bootstrap-rollout-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	for (const createCount of [2, 0]) {
		const result = spawnSync(
			"bash",
			[
				"-c",
				`set -euo pipefail
require_source_tuple(){ :; }
require_file(){ :; }
prepare_evidence(){ :; }
render_manifest(){ :; }
configuration_source_preflight(){ :; }
image_cache_gate(){ :; }
node(){
  case "$1" in
    */bootstrap-inputs.ts)
      test "$2" = apply
      printf '{"schemaVersion":1,"kind":"ack-private-inputs","createCount":${createCount}}\\n'
      ;;
    *) echo "UNEXPECTED_CONSUMER_OPERATION" >&2; exit 99;;
  esac
}
kubectl(){
  case " $* " in
    *" get deployment "*) printf 'deployment.apps/live-consumer\\n';;
    *) echo "UNEXPECTED_CONSUMER_OPERATION" >&2; exit 99;;
  esac
}
repo_root=/synthetic
namespace=test-ns
ACK_KUBECONFIG=/synthetic/kubeconfig
ACK_BOOTSTRAP_INPUTS_FILE=/synthetic/bootstrap.json
timeout=30s
evidence_dir="$1"
${bootstrap}
bootstrap_inputs apply
`,
				"bootstrap-test",
				directory,
			],
			{
				encoding: "utf8",
				env: { ...process.env, BASH_ENV: "/dev/null" },
			},
		);
		assert.equal(result.status, 0, result.stderr);
		assert.doesNotMatch(result.stderr, /UNEXPECTED_CONSUMER_OPERATION/);
		const receipt = JSON.parse(
			await readFile(join(directory, "bootstrap-inputs.json"), "utf8"),
		);
		assert.equal(receipt.createCount, createCount);
	}
});

test("template preflight uses the full release compute and cache inputs", async (t) => {
	const source = await readFile(script, "utf8");
	const functions = source.slice(
		source.indexOf("die() {"),
		source.indexOf("command=${1:-help}"),
	);
	const dir = await mkdtemp(join(tmpdir(), "ack-template-release-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const evidence = join(dir, "network.json");
	await writeFile(
		evidence,
		JSON.stringify({
			probes: ["eci", "acs"].map((compute) => ({ destination: { compute } })),
		}),
	);
	for (const cache of ["true", "false"]) {
		const result = spawnSync(
			"bash",
			[
				"-c",
				`
${functions}
repo_root=$1
chart_dir="$repo_root/deploy/ack/chart"
values_file=private-values evidence_dir=$2 template_manifest=synthetic
require_source_tuple(){ :; }
require_file(){ :; }
prepare_evidence(){ :; }
image_cache_gate(){ :; }
render_manifest(){ rm -f "$gate_manifest" "$list_file"; trap - EXIT; shift; printf '%s\\n' "$@"; exit 0; }
template_preflight
`,
				"preflight-test",
				root,
				dir,
			],
			{
				env: {
					...process.env,
					ACK_NETWORKPOLICY_EVIDENCE_FILE: evidence,
					ACK_IMAGE_CACHE_REQUIRED: cache,
					ACK_BOOTSTRAP_INPUTS_FILE: "bootstrap",
					ACK_TEMPLATE_PREFLIGHT_JOBS_FILE: "jobs",
				},
				encoding: "utf8",
			},
		);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(result.stdout.trim().split("\n"), [
			"--values",
			"private-values",
			"--set",
			"bootstrap.databaseOnly=false",
			"--set",
			"sessionRuntimeScheduling.retainBothComputes=true",
			...(cache === "true"
				? ["--values", join(dir, "image-cache.existing.values.json")]
				: []),
		]);
	}
});

test("deployed snapshot keeps the admitted full release and the activated cache policy", async (t) => {
	const source = await readFile(script, "utf8");
	const body = source.slice(
		source.indexOf("deploy() {"),
		source.indexOf("provision() {"),
	);
	const dir = await mkdtemp(join(tmpdir(), "ack-redeploy-snapshot-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "deploy/ack"), { recursive: true });
	await writeFile(
		join(dir, "deploy/ack/preflight.sh"),
		(await readFile(join(root, "deploy/ack/preflight.sh"), "utf8")) +
			"\nack_release_preflight(){ :; }\n",
	);
	for (const enabled of ["true", "false"]) {
		const result = spawnSync(
			"bash",
			[
				"-c",
				`set -euo pipefail
repo_root=$1
evidence_dir=$1
ACK_IMAGE_CACHE_REQUIRED=$2
ACK_KUBECONFIG=test-kubeconfig
namespace=test-ns release=test-release chart_dir=chart values_file=private-values timeout=1m trial_scope=""
require_source_tuple(){ :; }
prepare_evidence(){ :; }
image_cache_gate(){ :; }
configuration_source_preflight(){ :; }
node(){ :; }
kubectl(){ :; }
activate_cache_admission(){ :; }
render_manifest(){ local dest=$1; shift; printf '%s\\n' "$@" > "$dest"; }
snapshot(){ test "$1" = deployed; cat "$2"; }
${body}
deploy`,
				"snapshot",
				dir,
				enabled,
			],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /bootstrap\.databaseOnly=false/);
		if (enabled === "true")
			assert.match(result.stdout, /image-cache\.values\.json/);
		assert.doesNotMatch(result.stdout, /image-cache\.existing/);
	}
});

test("ACK re-deploy script is executable shell and exposes bounded commands", async () => {
	await access(script);
	execFileSync("bash", ["-n", script], { stdio: "pipe" });
	const help = execFileSync("bash", [script, "help"], { encoding: "utf8" });
	for (const command of [
		"capture-inputs",
		"plan",
		"bootstrap-plan",
		"bootstrap-inputs",
		"bootstrap-database",
		"template-preflight",
		"bootstrap-credential",
		"cleanup-plan",
		"deploy",
		"provision",
		"validate",
		"clean",
		"destroy",
		"all",
	])
		if (!help.includes(command)) throw new Error(`missing command: ${command}`);
	if (
		!help.includes("ACK_RUNTIME_IMAGE_MANIFEST") ||
		!help.includes("ACK_CA_CERT_FILE") ||
		!help.includes("ACK_TEMPLATE_VALIDATIONS_FILE") ||
		!help.includes("ACK_TEMPLATE_E2E_EVIDENCE_FILE") ||
		!help.includes("ACK_TEMPLATE_PREFLIGHT_JOBS_FILE") ||
		!help.includes("ACK_TEMPLATE_IMAGE_MANIFEST")
	)
		throw new Error(
			"provenance, CA, or template receipt inputs are missing from help",
		);
	if ((await readFile(script, "utf8")).includes("--insecure"))
		throw new Error(
			"HTTPS validation must not disable certificate verification",
		);
	const source = await readFile(script, "utf8");
	if (
		!source.includes(
			'git -C "$repo_root" status --porcelain --untracked-files=all',
		)
	)
		throw new Error("deploy must reject a dirty source checkout");
	if (
		!source.includes("local remaining_namespace") ||
		!source.includes("cleanup namespace absence verification failed")
	)
		throw new Error(
			"destroy must fail closed when namespace absence cannot be verified",
		);
	if (
		!source.includes('"$repo_root/deploy/ack/runtime-inputs.ts" apply') ||
		!source.includes("template-validation.mjs") ||
		!source.includes("four-template-e2e-receipt.mjs")
	)
		throw new Error(
			"configuration reload and template receipt gates are missing",
		);
	const chart = execFileSync(
		"helm",
		["template", "ack-test", join(root, "deploy/ack/chart")],
		{ encoding: "utf8" },
	);
	const role = parse(
		chart.split("---").find((document) => /^kind: Role$/m.test(document)),
	);
	assert.deepEqual(
		role.rules.filter((rule) => rule.resources.includes("endpoints")),
		[{ apiGroups: [""], resources: ["endpoints"], verbs: ["get"] }],
	);
	const allBlock = source.slice(source.indexOf("\n\tall)"));
	if (
		allBlock.indexOf("bootstrap_credential") >
		allBlock.indexOf('agent-bindings.ts" check')
	)
		throw new Error(
			"all must issue the credential before validating Agent inputs",
		);
});

test("ACK destructive command fails closed without its explicit confirmation", () => {
	let failed = false;
	try {
		execFileSync("bash", [script, "destroy"], {
			encoding: "utf8",
			stdio: "pipe",
		});
	} catch (error) {
		failed = true;
		const stderr = error.stderr?.toString() ?? "";
		if (!stderr.includes("ACK_CLEAN_CONFIRM=DELETE_ACK_ENV"))
			throw new Error("destroy did not explain its confirmation gate");
	}
	if (!failed) throw new Error("destroy unexpectedly succeeded");
});

test("destroy requires both explicit confirmations and a cleanup plan", () => {
	let failed = false;
	try {
		execFileSync("bash", [script, "destroy"], {
			env: {
				...process.env,
				ACK_CLEAN_CONFIRM: "DELETE_ACK_ENV",
				ACK_KUBECONFIG: "/dev/null",
			},
			stdio: "pipe",
		});
	} catch (error) {
		failed = true;
		if (!error.stderr.toString().includes("ACK_CLEANUP_PLAN_FILE"))
			throw new Error("destroy did not require a cleanup plan");
	}
	if (!failed) throw new Error("destroy unexpectedly succeeded");
});

for (const scenario of [
	"bootstrap-owner",
	"wrong-owner",
	"missing-owner",
	"cluster-drift",
	"namespace-drift",
	"inventory-failed",
]) {
	test(`destroy checks the bootstrapped namespace before deleting: ${scenario}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "ack-destroy-"));
		try {
			const bin = join(directory, "bin");
			await mkdir(bin);
			const input = {
				namespace: "agent-infra",
				release: "agent-infra-ack",
				clusterUid: "11111111-1111-4111-8111-111111111111",
				namespaceUid: "22222222-2222-4222-8222-222222222222",
				installationId: "33333333-3333-4333-8333-333333333333",
			};
			const plan = join(directory, "cleanup.json");
			const log = join(directory, "kubectl.jsonl");
			const marker = join(directory, "deleted");
			await writeFile(plan, JSON.stringify(input), { mode: 0o600 });
			await writeFile(log, "");
			await writeFile(
				join(bin, "kubectl"),
				`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), input = ${JSON.stringify(input)};
const scenario = ${JSON.stringify(scenario)}, log = ${JSON.stringify(log)}, marker = ${JSON.stringify(marker)};
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
const operation = args.findIndex(a => a === 'get' || a === 'delete');
const [verb, kind, name] = args.slice(operation);
if (verb === 'delete') {
  if (kind === 'namespace') fs.writeFileSync(marker, 'deleted');
  process.exit(0);
}
if (kind === 'namespace') {
  if (name === input.namespace && fs.existsSync(marker)) process.exit(0);
  let uid = name === 'kube-system' ? input.clusterUid : input.namespaceUid;
  if ((name === 'kube-system' && scenario === 'cluster-drift') || (name === input.namespace && scenario === 'namespace-drift')) uid = input.installationId;
  if (args.some(a => a.startsWith('jsonpath='))) { process.stdout.write(uid); process.exit(0); }
  const labels = {'app.kubernetes.io/part-of':'agent-infra','workloads.example.test/plane':'agent-infra'};
  if (scenario !== 'missing-owner') labels['agent-infra.agora.io/bootstrap-id'] = scenario === 'wrong-owner' ? input.clusterUid : input.installationId;
  if (scenario === 'bootstrap-owner') { delete labels['app.kubernetes.io/part-of']; delete labels['workloads.example.test/plane']; }
  console.log(JSON.stringify({metadata:{name,uid,labels}})); process.exit(0);
}
if (scenario === 'inventory-failed') process.exit(1);
if (kind.startsWith('mutatingadmission')) process.exit(0);
console.log(JSON.stringify({items:[]}));
`,
				{ mode: 0o700 },
			);
			const result = spawnSync("bash", [script, "destroy"], {
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					ACK_KUBECONFIG: plan,
					ACK_NAMESPACE: input.namespace,
					ACK_RELEASE: input.release,
					ACK_CLEANUP_PLAN_FILE: plan,
					ACK_EVIDENCE_DIR: join(directory, "evidence"),
					ACK_CLEAN_CONFIRM: "DELETE_ACK_ENV",
					ACK_CLEAN_ALLOW_FOREIGN: "DELETE_ALL_ACK_NAMESPACE",
				},
			});
			const calls = (await readFile(log, "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			const deletions = calls.filter((args) => args.includes("delete"));
			if (scenario === "bootstrap-owner") {
				assert.equal(result.status, 0, result.stderr);
				assert.deepEqual(
					deletions.map((args) =>
						args.slice(args.indexOf("delete") + 1, args.indexOf("delete") + 3),
					),
					[
						["mutatingadmissionpolicy", "agent-infra-session-eci"],
						["mutatingadmissionpolicybinding", "agent-infra-session-eci"],
						[
							"mutatingadmissionpolicybinding",
							"agent-infra-session-image-cache",
						],
						[
							"validatingadmissionpolicybinding",
							"agent-infra-session-image-cache",
						],
						["mutatingadmissionpolicy", "agent-infra-session-image-cache"],
						["validatingadmissionpolicy", "agent-infra-session-image-cache"],
						["namespace", "agent-infra"],
					],
				);
				const receipt = JSON.parse(
					await readFile(join(directory, "evidence/destroy.json"), "utf8"),
				);
				assert.equal(receipt.namespaceDeleted, true);
				assert.equal(calls.at(-1).includes("--ignore-not-found"), true);
			} else {
				assert.notEqual(result.status, 0);
				assert.deepEqual(deletions, []);
				if (scenario.endsWith("owner"))
					assert.match(result.stderr, /bootstrap ownership mismatch/u);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}
