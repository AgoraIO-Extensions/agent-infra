import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeCapsule, runCapsule } from "../deploy/ack/run-capsule.ts";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "ack-portable-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "source");
	const capsule = join(root, "private inputs");
	await mkdir(join(source, "deploy/ack"), { recursive: true });
	await mkdir(capsule, { mode: 0o700 });
	const script = `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == plan ]]
[[ "$ACK_PUBLIC_ORIGIN" == 'https://platform.example.test' ]]
[[ "$ACK_KUBECONFIG" == *'private inputs/kubeconfig' ]]
[[ -r "$ACK_BOOTSTRAP_INPUTS_FILE" ]]
if [[ -n "\${ACK_SESSION_RESERVES_FILE+x}" ]]; then
  [[ -r "$ACK_SESSION_RESERVES_FILE" ]]
  grep -q 'session-reserves.json' "$ACK_BOOTSTRAP_INPUTS_FILE"
fi
[[ -z "\${ACK_RUNTIME_IMAGE_MANIFEST+x}" ]]
[[ -z "\${ACK_CHART_DIR+x}" ]]
printf '%s\\n' "$1" > "$ACK_EVIDENCE_DIR/executed"
`;
	await writeFile(join(source, "deploy/ack/redeploy.sh"), script, {
		mode: 0o700,
	});
	const git = (args) =>
		execFileSync(
			"git",
			["-C", source, "-c", "core.hooksPath=/dev/null", ...args],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		).trim();
	git(["init", "-q"]);
	git(["add", "."]);
	git([
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.test",
		"commit",
		"-qm",
		"fixture",
	]);
	const sourceSha = git(["rev-parse", "HEAD"]);
	const save = async (relative, value) => {
		const path = join(capsule, relative);
		await writeFile(
			path,
			typeof value === "string" ? value : JSON.stringify(value),
			{ mode: 0o600 },
		);
		return path;
	};
	await save("kubeconfig", "private-cluster-material");
	await save("credential", "private-credential-sentinel");
	await save("request.json", {
		credentialFile: "@CAPSULE_ROOT@/credential",
		storageStateFile: "@CAPSULE_ROOT@/state/login.json",
		worktree: "@SOURCE_ROOT@",
	});
	await save("bootstrap.json", {
		namespace: "agent-infra",
		childFile: "@CAPSULE_ROOT@/request.json",
		files: { key: "@CAPSULE_ROOT@/credential" },
	});
	const value = {
		schemaVersion: 1,
		sourceSha,
		inputs: ["bootstrap.json", "request.json"],
		directories: ["state", "evidence"],
		environment: {
			ACK_KUBECONFIG: "@CAPSULE_ROOT@/kubeconfig",
			ACK_BOOTSTRAP_INPUTS_FILE: "@CAPSULE_ROOT@/bootstrap.json",
			ACK_PUBLIC_ORIGIN: "https://platform.example.test",
			ACK_EVIDENCE_DIR: "@CAPSULE_ROOT@/evidence",
			ACK_CUSTOM_AGENT_CONFIGS: ["@CAPSULE_ROOT@/request.json"],
		},
	};
	const manifest = await save("capsule.json", value);
	return { root, source, sourceSha, capsule, value, manifest, save };
}

test("the same capsule relocates without editing source templates or credential bytes", async (t) => {
	const f = await fixture(t);
	const before = await readFile(join(f.capsule, "bootstrap.json"));
	const copy = join(f.root, "relocated inputs with spaces");
	await cp(f.capsule, copy, { recursive: true });
	await chmod(copy, 0o700);
	for (const root of [f.capsule, copy]) {
		const canonical = await realpath(root);
		const result = await materializeCapsule(
			join(root, "capsule.json"),
			f.source,
		);
		const bootstrap = JSON.parse(
			await readFile(result.environment.ACK_BOOTSTRAP_INPUTS_FILE),
		);
		const request = JSON.parse(await readFile(bootstrap.childFile));
		assert(bootstrap.childFile.startsWith(join(canonical, ".resolved-")));
		assert.equal(request.worktree, f.source);
		assert.equal(request.storageStateFile, join(canonical, "state/login.json"));
		assert.equal(request.credentialFile, join(canonical, "credential"));
		assert.equal(result.environment.ACK_SOURCE_SHA, f.sourceSha);
		assert.equal(
			result.environment.ACK_CUSTOM_AGENT_CONFIGS,
			bootstrap.childFile,
		);
		assert.equal(
			await readFile(request.credentialFile, "utf8"),
			"private-credential-sentinel",
		);
		assert.equal((await lstat(bootstrap.childFile)).mode & 0o777, 0o600);
		assert.deepEqual(await readFile(join(root, "bootstrap.json")), before);
	}
});

test("the runner invokes the existing workflow without shell interpolation and returns its exit", async (t) => {
	const f = await fixture(t);
	const previous = {
		// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone capsule test outside Turbo.
		ACK_RUNTIME_IMAGE_MANIFEST: process.env.ACK_RUNTIME_IMAGE_MANIFEST,
		// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone capsule test outside Turbo.
		ACK_CHART_DIR: process.env.ACK_CHART_DIR,
	};
	process.env.ACK_RUNTIME_IMAGE_MANIFEST =
		"/another-installation/manifest.json";
	process.env.ACK_CHART_DIR = "/another-installation/chart";
	let result;
	try {
		result = await runCapsule(f.manifest, "plan", f.source);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	assert.equal(result.exitCode, 0);
	assert.equal(result.command, "plan");
	assert.equal(
		await readFile(join(f.capsule, "evidence/executed"), "utf8"),
		"plan\n",
	);
	assert(!JSON.stringify(result).includes("private-credential-sentinel"));
	await assert.rejects(
		runCapsule(f.manifest, "plan; touch unwanted", f.source),
		/CAPSULE_COMMAND_INVALID/,
	);
});

test("successful runtime stages promote generated JSON inputs and preserve the source template", async (t) => {
	const f = await fixture(t);
	const template = { schemaVersion: 1, sourceSha: f.sourceSha, templates: [] };
	await mkdir(join(f.capsule, "state"), { mode: 0o700 });
	await f.save("state/template-validations.json", template);
	f.value.inputs.push("state/template-validations.json");
	f.value.environment.ACK_TEMPLATE_VALIDATIONS_FILE =
		"@CAPSULE_ROOT@/state/template-validations.json";
	await writeFile(
		join(f.source, "deploy/ack/redeploy.sh"),
		`#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == runtime-inputs ]]
cat > "$ACK_TEMPLATE_VALIDATIONS_FILE" <<'JSON'
{"schemaVersion":1,"sourceSha":"${f.sourceSha}","templates":[{"templateId":"codex"}]}
JSON
`,
		{ mode: 0o700 },
	);
	await f.save("capsule.json", f.value);
	const before = await readFile(
		join(f.capsule, "state/template-validations.json"),
	);
	const result = await runCapsule(f.manifest, "runtime-inputs", f.source);
	assert.equal(result.exitCode, 0);
	assert.deepEqual(
		await readFile(join(f.capsule, "state/template-validations.json")),
		Buffer.from(
			`{"schemaVersion":1,"sourceSha":"${f.sourceSha}","templates":[{"templateId":"codex"}]}\n`,
		),
	);
	assert.notDeepEqual(
		await readFile(join(f.capsule, "state/template-validations.json")),
		before,
	);
	assert.deepEqual(result.promotedInputs, ["state/template-validations.json"]);
});

for (const command of ["bootstrap-credential", "provision"]) {
	test(`${command} promotes its declared generated input`, async (t) => {
		const f = await fixture(t);
		const relative =
			command === "bootstrap-credential"
				? "inputs/credential.json"
				: "inputs/requests.json";
		await mkdir(join(f.capsule, "inputs"), { mode: 0o700 });
		await f.save(relative, { original: true });
		f.value.inputs.push(relative);
		f.value.environment[
			command === "bootstrap-credential"
				? "ACK_CREDENTIAL_BOOTSTRAP_FILE"
				: "ACK_AGENT_REQUESTS_FILE"
		] = `@CAPSULE_ROOT@/${relative}`;
		await writeFile(
			join(f.source, "deploy/ack/redeploy.sh"),
			`#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == ${command} ]]
cat > "${command === "bootstrap-credential" ? "$ACK_CREDENTIAL_BOOTSTRAP_FILE" : "$ACK_AGENT_REQUESTS_FILE"}" <<'JSON'
{"generated":true}
JSON
`,
			{ mode: 0o700 },
		);
		await f.save("capsule.json", f.value);
		const result = await runCapsule(f.manifest, command, f.source);
		assert.equal(result.exitCode, 0);
		assert.deepEqual(
			JSON.parse(await readFile(join(f.capsule, relative), "utf8")),
			{ generated: true },
		);
		assert.deepEqual(result.promotedInputs, [relative]);
	});
}

async function reserveFixture(t, enabled = false) {
	const f = await fixture(t);
	const resources = {
		requests: { cpu: "100m", memory: "128Mi" },
		limits: { cpu: "1", memory: "2Gi" },
	};
	const resourceProfileRef = "small";
	const resourceConfigurationHash = createHash("sha256")
		.update(JSON.stringify({ resourceProfileRef, ...resources }))
		.digest("hex");
	const imageDigest = `sha256:${"a".repeat(64)}`;
	const costs = {
		cpuMillis: 1000,
		memoryBytes: 2 * 1024 ** 3,
		storageBytes: 1024 ** 3,
	};
	const measurement = {
		schemaVersion: 1,
		sourceCommit: f.sourceSha,
		scope: "ack-runtime-capacity",
		imageDigest,
		maximumConcurrentExecutions: 1,
		observedResources: resources,
		terminalStatus: "completed",
		replyMatched: true,
		modelOperationCount: 1,
		submittedAt: 1000,
		completedAt: 2000,
	};
	const bytes = JSON.stringify(measurement);
	await f.save("measurement.json", bytes);
	await f.save("capacity-profiles.json", {
		schemaVersion: 1,
		profiles: [
			{
				schemaVersion: 1,
				imageDigest,
				resourceProfileRef,
				resourceConfigurationHash,
				maximumConcurrentExecutions: 1,
				conformanceEvidenceHash: createHash("sha256")
					.update(bytes)
					.digest("hex"),
			},
		],
	});
	await f.save("workload-capacity.json", {
		schemaVersion: 1,
		sourceSha: f.sourceSha,
		resourceProfileRef,
		resources,
		profilesFile: "@CAPSULE_ROOT@/capacity-profiles.json",
		evidence: [{ imageDigest, file: "@CAPSULE_ROOT@/measurement.json" }],
	});
	await f.save("templates.json", {
		schemaVersion: 1,
		sourceSha: f.sourceSha,
		templates: [{ templateId: "codex", imageDigest }],
	});
	const reserve = {
		schemaVersion: 1,
		sourceSha: f.sourceSha,
		enabled,
		revision: 2,
		namespace: "agent-infra",
		totalBudget: enabled
			? costs
			: { cpuMillis: 0, memoryBytes: 0, storageBytes: 0 },
		resourceCosts: enabled
			? [{ resourceConfigurationHash, resources: costs }]
			: [],
		maximumReserves: enabled ? 1 : 0,
		maximumConcurrentCreates: enabled ? 1 : 0,
		ttlMs: 1000,
		cooldownMs: 1000,
		failureBackoffMs: 1000,
		profiles: enabled
			? [
					{
						agentId: "agent-a",
						templateId: "codex",
						imageDigest,
						resourceConfigurationHash,
						resources: costs,
						storageConfigurationVersion: "storage-v1",
						networkPolicyVersion: "network-v1",
						signingConfigurationVersion: "signing-v1",
						transportConfigurationVersion: "transport-v1",
						connectionConfigurationVersion: "connection-v1",
						minimum: 1,
						maximum: 1,
					},
				]
			: [],
	};
	await f.save("session-reserves.json", reserve);
	await f.save("bootstrap.json", {
		namespace: "agent-infra",
		objects: [
			{
				kind: "Secret",
				name: "test-worker-configuration",
				files: { "configuration.mjs": "@CAPSULE_ROOT@/credential" },
			},
		],
	});
	f.value.inputs.push(
		"session-reserves.json",
		"workload-capacity.json",
		"templates.json",
	);
	Object.assign(f.value.environment, {
		ACK_NAMESPACE: "agent-infra",
		ACK_WORKLOAD_CAPACITY_FILE: "@CAPSULE_ROOT@/workload-capacity.json",
		ACK_TEMPLATE_VALIDATIONS_FILE: "@CAPSULE_ROOT@/templates.json",
		ACK_SESSION_RESERVES_FILE: "@CAPSULE_ROOT@/session-reserves.json",
	});
	await f.save("capsule.json", f.value);
	const actual = {
		configuration: null,
		configurationHash: null,
		policy: {
			namespace: "agent-infra",
			resourceProfileRef,
			resources,
			storageSize: "1Gi",
		},
		resourceCosts: costs,
	};
	const canonical = (value) =>
		Array.isArray(value)
			? value.map(canonical)
			: value && typeof value === "object"
				? Object.fromEntries(
						Object.entries(value)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([key, child]) => [key, canonical(child)]),
					)
				: value;
	actual.configurationHash = createHash("sha256")
		.update(JSON.stringify(canonical(reserve)))
		.digest("hex");
	const { sourceSha: _reserveSource, ...parsedReserve } = reserve;
	actual.configuration = parsedReserve;
	actual.sourceSha = f.sourceSha;
	actual.storedReserveBytes = Buffer.from(JSON.stringify(reserve));
	return { ...f, reserve, actual, readWorker: () => actual };
}

test("promoted configuration paths remain relocatable across successful stages", async (t) => {
	const f = await fixture(t);
	await writeFile(
		join(f.source, "deploy/ack/redeploy.sh"),
		[
			"#!/usr/bin/env bash",
			"set -euo pipefail",
			"node -e 'const fs=require(\"node:fs\");const f=process.env.ACK_BOOTSTRAP_INPUTS_FILE;const v=JSON.parse(fs.readFileSync(f));v.generated=true;fs.writeFileSync(f,JSON.stringify(v));'",
		].join("\n"),
		{ mode: 0o700 },
	);
	const result = await runCapsule(f.manifest, "runtime-inputs", f.source);
	assert.equal(result.exitCode, 0);
	const saved = JSON.parse(await readFile(join(f.capsule, "bootstrap.json")));
	assert.equal(saved.generated, true);
	assert.equal(saved.childFile, "@CAPSULE_ROOT@/request.json");
	const relocated = join(f.root, "moved capsule");
	await cp(f.capsule, relocated, {
		recursive: true,
		filter: (file) => !file.includes(".resolved-"),
	});
	await rm(f.capsule, { recursive: true });
	const next = await materializeCapsule(
		join(relocated, "capsule.json"),
		f.source,
	);
	const bootstrap = JSON.parse(
		await readFile(next.environment.ACK_BOOTSTRAP_INPUTS_FILE),
	);
	const request = JSON.parse(await readFile(bootstrap.childFile));
	assert.equal(
		request.credentialFile,
		join(await realpath(relocated), "credential"),
	);
});

test("first-run generated template expectations are resolved on the next stage after relocation", async (t) => {
	const f = await fixture(t);
	f.value.environment.ACK_TEMPLATE_VALIDATIONS_FILE =
		"@CAPSULE_ROOT@/state/generated-templates.json";
	f.value.environment.ACK_AGENT_STATE_DIR = "@CAPSULE_ROOT@/state";
	await f.save("capsule.json", f.value);
	await writeFile(
		join(f.source, "deploy/ack/redeploy.sh"),
		[
			"#!/usr/bin/env bash",
			"set -euo pipefail",
			"umask 077",
			"[[ \"$ACK_AGENT_STATE_DIR\" != *'/.resolved-'* ]]",
			"node -e 'const fs=require(\"node:fs\");fs.writeFileSync(process.env.ACK_TEMPLATE_VALIDATIONS_FILE,JSON.stringify({validationFile:process.env.ACK_KUBECONFIG}));'",
		].join("\n"),
		{ mode: 0o700 },
	);
	const first = await runCapsule(f.manifest, "template-preflight", f.source);
	assert.equal(first.exitCode, 0);
	const saved = JSON.parse(
		await readFile(join(f.capsule, "state/generated-templates.json")),
	);
	assert.equal(saved.validationFile, "@CAPSULE_ROOT@/kubeconfig");
	const relocated = join(f.root, "moved generated outputs");
	await cp(f.capsule, relocated, {
		recursive: true,
		filter: (file) => !file.includes(".resolved-"),
	});
	await rm(f.capsule, { recursive: true });
	const next = await materializeCapsule(
		join(relocated, "capsule.json"),
		f.source,
	);
	const expectations = JSON.parse(
		await readFile(next.environment.ACK_TEMPLATE_VALIDATIONS_FILE),
	);
	assert.equal(
		expectations.validationFile,
		join(await realpath(relocated), "kubeconfig"),
	);
});

test("promotion preserves concurrent canonical edits and rejects undeclared temporary outputs", async (t) => {
	for (const scenario of ["canonical-edit", "temporary-output"]) {
		const f = await fixture(t);
		const action =
			scenario === "canonical-edit"
				? "fs.writeFileSync(f.split('/.resolved-')[0]+'/bootstrap.json',JSON.stringify({concurrent:true}));"
				: "const v=JSON.parse(fs.readFileSync(f));v.output=require('node:path').dirname(f)+'/undeclared.json';fs.writeFileSync(f,JSON.stringify(v));";
		await writeFile(
			join(f.source, "deploy/ack/redeploy.sh"),
			"#!/usr/bin/env bash\nset -euo pipefail\nnode - <<'JS'\nconst fs=require('node:fs');const f=process.env.ACK_BOOTSTRAP_INPUTS_FILE;\n" +
				action +
				"\nJS\n",
			{ mode: 0o700 },
		);
		await assert.rejects(
			runCapsule(f.manifest, "runtime-inputs", f.source),
			scenario === "canonical-edit"
				? /CAPSULE_OUTPUT_LOCAL_DRIFT/
				: /CAPSULE_OUTPUT_UNDECLARED_PATH/,
		);
		const current = JSON.parse(
			await readFile(join(f.capsule, "bootstrap.json")),
		);
		if (scenario === "canonical-edit") assert.equal(current.concurrent, true);
		else assert.equal(current.output, undefined);
	}
});

test("promotion preflights every target before changing the first canonical file", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.capsule, "inputs"), { mode: 0o700 });
	await mkdir(join(f.capsule, "state"), { mode: 0o700 });
	await f.save("state/template-validations.json", { original: "template" });
	await f.save("inputs/bootstrap.json", { original: "bootstrap" });
	await f.save("inputs/capacity.json", { original: "capacity" });
	f.value.inputs.push(
		"state/template-validations.json",
		"inputs/bootstrap.json",
		"inputs/capacity.json",
	);
	f.value.environment.ACK_TEMPLATE_VALIDATIONS_FILE =
		"@CAPSULE_ROOT@/state/template-validations.json";
	f.value.environment.ACK_BOOTSTRAP_INPUTS_FILE =
		"@CAPSULE_ROOT@/inputs/bootstrap.json";
	f.value.environment.ACK_WORKLOAD_CAPACITY_FILE =
		"@CAPSULE_ROOT@/inputs/capacity.json";
	await f.save("capsule.json", f.value);
	await writeFile(
		join(f.source, "deploy/ack/redeploy.sh"),
		[
			"#!/usr/bin/env bash",
			"set -euo pipefail",
			"printf '%s\\n' '{\"generated\":true}' > \"$ACK_TEMPLATE_VALIDATIONS_FILE\"",
			`(sleep 0.1; printf '%s\\n' '{"concurrent":true}' > '${join(f.capsule, "inputs/capacity.json")}') &`,
			"sleep 0.2",
			"printf '%s\\n' '{\"generated-capacity\":true}' > \"$ACK_WORKLOAD_CAPACITY_FILE\"",
		].join("\n"),
		{ mode: 0o700 },
	);
	await assert.rejects(
		runCapsule(f.manifest, "runtime-inputs", f.source),
		/CAPSULE_OUTPUT_LOCAL_DRIFT/,
	);
	assert.deepEqual(
		JSON.parse(
			await readFile(join(f.capsule, "state/template-validations.json")),
		),
		{ original: "template" },
	);
	assert.deepEqual(
		JSON.parse(await readFile(join(f.capsule, "inputs/capacity.json"))),
		{ concurrent: true },
	);
});

test("directory environment paths stay canonical while file inputs use the resolved run", async (t) => {
	const f = await fixture(t);
	f.value.directories.push("state/agents");
	f.value.environment.ACK_AGENT_STATE_DIR = "@CAPSULE_ROOT@/state/agents";
	await mkdir(join(f.capsule, "state/agents"), {
		mode: 0o700,
		recursive: true,
	});
	await writeFile(
		join(f.source, "deploy/ack/redeploy.sh"),
		'#!/usr/bin/env bash\nset -euo pipefail\n[[ "$ACK_AGENT_STATE_DIR" == *\'/private inputs/state/agents\' ]]\nmkdir -p "$ACK_AGENT_STATE_DIR"\n',
		{ mode: 0o700 },
	);
	await f.save("capsule.json", f.value);
	assert.equal((await runCapsule(f.manifest, "plan", f.source)).exitCode, 0);
});

test("an update preserves the observed Secret bytes for bootstrap while keeping the new reserve candidate separate", async (t) => {
	const f = await reserveFixture(t, true);
	const before = Buffer.from(`  ${JSON.stringify(f.reserve)}\n`);
	f.actual.storedReserveBytes = before;
	f.reserve.revision += 1;
	await f.save("session-reserves.json", f.reserve);
	const { environment } = await materializeCapsule(
		f.manifest,
		f.source,
		f.readWorker,
	);
	const bootstrap = JSON.parse(
		await readFile(environment.ACK_BOOTSTRAP_INPUTS_FILE, "utf8"),
	);
	const baseline = bootstrap.objects[0].files["session-reserves.json"];
	assert.notEqual(baseline, environment.ACK_SESSION_RESERVES_FILE);
	assert.deepEqual(await readFile(baseline), before);
	assert.equal(
		JSON.parse(await readFile(environment.ACK_SESSION_RESERVES_FILE, "utf8"))
			.revision,
		3,
	);
});

test("default-disabled capsule injects one source-bound reserve file without changing original input", async (t) => {
	const f = await reserveFixture(t);
	const before = await readFile(join(f.capsule, "bootstrap.json"));
	const result = await runCapsule(f.manifest, "plan", f.source, () => null);
	assert.equal(result.exitCode, 0);
	assert.equal(result.reserve.revision, 2);
	assert.equal(result.reserve.enabled, false);
	assert.deepEqual(await readFile(join(f.capsule, "bootstrap.json")), before);
});

test("enabled pilot requires current measured resources and emits no profile identities", async (t) => {
	const f = await reserveFixture(t, true);
	const result = await runCapsule(f.manifest, "plan", f.source, f.readWorker);
	assert.equal(result.exitCode, 0);
	assert.equal(result.reserve.revision, 2);
	assert.equal(result.reserve.enabled, true);
	assert(!JSON.stringify(result).includes("agent-a"));
});

test("all performs an exact post-run reserve adoption readback", async (t) => {
	const f = await reserveFixture(t, true);
	await writeFile(
		join(f.source, "deploy/ack/redeploy.sh"),
		'#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$1" > "$ACK_EVIDENCE_DIR/executed"\n',
		{ mode: 0o700 },
	);
	const result = await runCapsule(f.manifest, "all", f.source, f.readWorker);
	assert.equal(result.exitCode, 0);
	assert.equal(result.reserve.mountedInputVerified, true);
	const stale = { ...f.actual, configuration: { ...f.reserve, revision: 1 } };
	await assert.rejects(
		runCapsule(f.manifest, "all", f.source, () => stale),
		/CAPSULE_RESERVE_ADOPTION_MISMATCH/,
	);
});

test("disabling reserves requires post-run adoption and a source-bound readback", async (t) => {
	const f = await reserveFixture(t, false);
	await writeFile(
		join(f.source, "deploy/ack/redeploy.sh"),
		"#!/usr/bin/env bash\nexit 0\n",
		{ mode: 0o700 },
	);
	const success = await runCapsule(f.manifest, "all", f.source, f.readWorker);
	assert.equal(success.reserve.mountedInputVerified, true);
	const stale = {
		...f.actual,
		configuration: { ...f.actual.configuration, revision: 1 },
	};
	await assert.rejects(
		runCapsule(f.manifest, "all", f.source, () => stale),
		/CAPSULE_RESERVE_ADOPTION_MISMATCH/,
	);
	await assert.rejects(
		runCapsule(f.manifest, "all", f.source, () => ({
			...f.actual,
			sourceSha: undefined,
		})),
		/CAPSULE_RESERVE_SOURCE_READBACK_MISMATCH/,
	);
});

for (const scenario of [
	"source",
	"namespace",
	"revision",
	"hash",
	"unverified-hash",
	"extra-field",
	"profile-digest",
	"unverified-cost",
	"no-worker",
	"old-revision",
	"same-revision-drift",
	"measurement-source",
	"model-facts",
	"duplicate-secret",
]) {
	test(`reserve ${scenario} is rejected before materialization or any workflow write`, async (t) => {
		const f = await reserveFixture(t, true);
		let readWorker = f.readWorker;
		if (scenario === "source") f.reserve.sourceSha = "f".repeat(40);
		if (scenario === "namespace") f.reserve.namespace = "other";
		if (scenario === "revision") f.reserve.revision = -1;
		if (scenario === "hash")
			f.reserve.profiles[0].resourceConfigurationHash = "invalid";
		if (scenario === "unverified-hash") {
			f.reserve.profiles[0].resourceConfigurationHash = "b".repeat(64);
			f.reserve.resourceCosts[0].resourceConfigurationHash = "b".repeat(64);
		}
		if (scenario === "extra-field") f.reserve.credential = "sentinel";
		if (scenario === "profile-digest")
			f.reserve.profiles[0].digest = "b".repeat(64);
		if (scenario === "unverified-cost")
			f.actual.resourceCosts = {
				...f.actual.resourceCosts,
				storageBytes: 2 * 1024 ** 3,
			};
		if (scenario === "no-worker") readWorker = () => null;
		if (["old-revision", "same-revision-drift"].includes(scenario)) {
			const { sourceSha, ...configuration } = structuredClone(f.reserve);
			f.actual.configuration = {
				...configuration,
				revision: scenario === "old-revision" ? 3 : 2,
				ttlMs: 1001,
			};
		}
		if (["measurement-source", "model-facts"].includes(scenario)) {
			const measurement = JSON.parse(
				await readFile(join(f.capsule, "measurement.json"), "utf8"),
			);
			if (scenario === "measurement-source")
				measurement.sourceCommit = "b".repeat(40);
			else measurement.modelOperationCount = 0;
			const bytes = JSON.stringify(measurement);
			await f.save("measurement.json", bytes);
			const profiles = JSON.parse(
				await readFile(join(f.capsule, "capacity-profiles.json"), "utf8"),
			);
			profiles.profiles[0].conformanceEvidenceHash = createHash("sha256")
				.update(bytes)
				.digest("hex");
			await f.save("capacity-profiles.json", profiles);
		}
		if (scenario === "duplicate-secret")
			await f.save("bootstrap.json", {
				namespace: "agent-infra",
				objects: ["a", "b"].map((name) => ({
					kind: "Secret",
					name: `${name}-worker-configuration`,
					files: {},
				})),
			});
		await f.save("session-reserves.json", f.reserve);
		await assert.rejects(runCapsule(f.manifest, "plan", f.source, readWorker));
		assert(
			!(await readdir(f.capsule)).some((name) => name.startsWith(".resolved-")),
		);
		await assert.rejects(readFile(join(f.capsule, "evidence/executed")), {
			code: "ENOENT",
		});
	});
}

test("higher disabled revision preserves accounting facts while stale enabled revision is rejected", async (t) => {
	const f = await reserveFixture(t, true);
	const { sourceSha, ...configuration } = structuredClone(f.reserve);
	f.actual.configuration = configuration;
	f.reserve.enabled = false;
	f.reserve.revision = 3;
	await f.save("session-reserves.json", f.reserve);
	assert.equal(
		(await runCapsule(f.manifest, "plan", f.source, f.readWorker)).reserve
			.enabled,
		false,
	);
});

for (const scenario of [
	"source",
	"duplicate",
	"traversal",
	"missing",
	"raw-missing",
	"public-input",
	"public-root",
	"symlink-input",
	"symlink-parent",
	"unknown-env",
	"absolute-env",
	"hidden-destroy-confirmation",
]) {
	test(`portable capsule rejects ${scenario} before invoking the workflow`, async (t) => {
		const f = await fixture(t);
		if (scenario === "source") f.value.sourceSha = "f".repeat(40);
		if (scenario === "duplicate") f.value.inputs.push("request.json");
		if (scenario === "traversal")
			await f.save("request.json", { path: "@CAPSULE_ROOT@/../outside" });
		if (scenario === "missing") await rm(join(f.capsule, "request.json"));
		if (scenario === "raw-missing") await rm(join(f.capsule, "credential"));
		if (scenario === "public-input")
			await chmod(join(f.capsule, "request.json"), 0o644);
		if (scenario === "public-root") await chmod(f.capsule, 0o755);
		if (scenario === "symlink-input") {
			await rm(join(f.capsule, "request.json"));
			await symlink(
				join(f.capsule, "bootstrap.json"),
				join(f.capsule, "request.json"),
			);
		}
		if (scenario === "symlink-parent") {
			await symlink(f.source, join(f.capsule, "state"));
		}
		if (scenario === "unknown-env") f.value.environment.PATH = "/attacker";
		if (scenario === "absolute-env")
			f.value.environment.ACK_KUBECONFIG = "/other/machine/kubeconfig";
		if (scenario === "hidden-destroy-confirmation")
			f.value.environment.ACK_CLEAN_CONFIRM = "DELETE_ACK_ENV";
		await f.save("capsule.json", f.value);
		await assert.rejects(runCapsule(f.manifest, "plan", f.source));
		assert(
			!(await readdir(f.capsule)).some((name) => name.startsWith(".resolved-")),
		);
		await assert.rejects(readFile(join(f.capsule, "evidence/executed")), {
			code: "ENOENT",
		});
	});
}

test("each materialization isolates mutable JSON inputs from earlier runs", async (t) => {
	const f = await fixture(t);
	const first = await materializeCapsule(f.manifest, f.source);
	await writeFile(
		first.environment.ACK_BOOTSTRAP_INPUTS_FILE,
		'{"modifiedDuringRun":true}',
	);
	const next = await materializeCapsule(f.manifest, f.source);
	assert.notEqual(
		first.environment.ACK_BOOTSTRAP_INPUTS_FILE,
		next.environment.ACK_BOOTSTRAP_INPUTS_FILE,
	);
	assert.equal(
		JSON.parse(await readFile(next.environment.ACK_BOOTSTRAP_INPUTS_FILE))
			.modifiedDuringRun,
		undefined,
	);
});

test("directory consumers read resolved browser blueprints, not the original templates", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.capsule, "blueprints"), { mode: 0o700 });
	await f.save("blueprints/codex.json", {
		owner: { stateFile: "@CAPSULE_ROOT@/state/owner.json" },
	});
	f.value.inputs.push("blueprints/codex.json");
	f.value.environment.ACK_BROWSER_BLUEPRINT_DIR = "@CAPSULE_ROOT@/blueprints";
	await f.save("capsule.json", f.value);
	const resolved = await materializeCapsule(f.manifest, f.source);
	const directory = resolved.environment.ACK_BROWSER_BLUEPRINT_DIR;
	assert(directory.includes("/.resolved-"));
	const blueprint = JSON.parse(await readFile(join(directory, "codex.json")));
	assert.equal(
		blueprint.owner.stateFile,
		join(await realpath(f.capsule), "state/owner.json"),
	);
	assert(
		(await readFile(join(f.capsule, "blueprints/codex.json"), "utf8")).includes(
			"@CAPSULE_ROOT@",
		),
	);
});
