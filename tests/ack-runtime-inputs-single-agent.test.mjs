import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishSingleAgentTemplateValidation } from "../deploy/ack/runtime-inputs.ts";
import { readSingleAgentSessionCompute } from "../deploy/ack/template-model-preflight.mjs";
import {
	readSingleAgentTemplateValidationInput,
	templatePreflightValidationReceipt,
} from "../deploy/ack/template-validation.mjs";

export { readSingleAgentSessionCompute };

const context = {
	sourceCommit: "a".repeat(40),
	clusterUid: "cluster-test",
	namespace: "test-release",
	namespaceUid: "namespace-test",
	installationId: "installation-test",
};
const template = {
	templateId: "opencode",
	driver: "acp",
	imageDigest: `sha256:${"b".repeat(64)}`,
	configurationRevision: "model-config-1",
	modelId: "model-1",
};

function worker(agent, session) {
	const env = [
		{
			name: "AGENT_INFRA_AGENT_WORKLOAD_PLACEMENT",
			value: JSON.stringify({
				architecture: "amd64",
				legacyUnplaced: "retain-until-lifecycle",
				compute: agent,
			}),
		},
	];
	if (session === "acs")
		env.push({
			name: "AGENT_INFRA_SESSION_RUNTIME_PLACEMENT",
			value: JSON.stringify({ architecture: "amd64", compute: session }),
		});
	return {
		kind: "Deployment",
		metadata: { name: "agent-infra-worker", namespace: context.namespace },
		spec: {
			template: { spec: { containers: [{ name: "platform-worker", env }] } },
		},
	};
}

async function fixture(t) {
	const dir = await mkdtemp(join(tmpdir(), "ack-release-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const jobFile = join(dir, "job.json");
	const bytes = JSON.stringify({ fixture: "no runtime executed" });
	await writeFile(jobFile, bytes, { mode: 0o600 });
	const binding = {
		revision: "deployment-1",
		releaseId: "release-1",
		agentId: "agent-1",
		expectedConfigurationRevision: 3,
		jobFile,
		jobFileSha256: createHash("sha256").update(bytes).digest("hex"),
		expected: { ...template, context, kubeconfig: join(dir, "workers.json") },
	};
	const setWorkers = (...items) =>
		writeFile(binding.expected.kubeconfig, JSON.stringify({ items }));
	await setWorkers(worker("eci", "eci"));
	await writeFile(
		join(dir, "kubectl"),
		`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[4] !== "get" || args[5] !== "pods,deployments,replicasets") process.exit(2);
process.stdout.write(fs.readFileSync(args[1]));`,
		{ mode: 0o700 },
	);
	const previousPath = process.env.PATH;
	process.env.PATH = dir + ":" + previousPath;
	t.after(() => {
		process.env.PATH = previousPath;
	});
	return { dir, binding, setWorkers, readBinding: async () => binding };
}

// Only the mock publisher import below resolves its native measurement to this fixture.
export async function runSingleAgentTemplatePreflight(_jobFile, expected, dir) {
	assert.deepEqual(expected.context, context);
	const measuredTemplate = {
		...template,
		templateId: expected.templateId,
		driver: expected.driver,
	};
	const sessionCompute = readSingleAgentSessionCompute(
		expected.kubeconfig,
		context.namespace,
	);
	const validatedAt = Date.now();
	const candidate = {
		...measuredTemplate,
		schemaVersion: 1,
		sourceCommit: context.sourceCommit,
		status: "passed",
		evidenceKind: "real-runtime-model",
		executionId: "test-execution",
		validatedAt,
		validUntil: validatedAt + 3_600_000,
	};
	const preflight = templatePreflightValidationReceipt({
		...candidate,
		...(expected.transport
			? {
					transport: expected.transport,
					transportEvidence: "original-codex-driver-session",
				}
			: {}),
		validationTarget: context,
		scope: "isolated-template-real-model",
		terminalStatus: "completed",
		modelFactSource: "protected-driver-journal",
		modelOperationCount: 1,
	});
	const validationFile = join(dir, "candidate.json");
	const preflightFile = join(dir, "preflight.json");
	await writeFile(validationFile, JSON.stringify(candidate), { mode: 0o600 });
	await writeFile(preflightFile, JSON.stringify(preflight), { mode: 0o600 });
	if (sessionCompute)
		await writeFile(
			join(dir, "runtime-capacity.receipt.json"),
			JSON.stringify({
				scope: "ack-runtime-capacity",
				sourceCommit: context.sourceCommit,
				imageDigest: expected.imageDigest,
				transport: expected.transport,
				computeInstanceId: sessionCompute + "-test01",
				completedAt: validatedAt,
				modelOperationCount: 1,
				terminalStatus: "completed",
				replyMatched: true,
			}),
			{ mode: 0o600 },
		);
	const expectations = {
		schemaVersion: 1,
		sourceSha: context.sourceCommit,
		minValidityMs: 60_000,
		templates: [
			{
				...measuredTemplate,
				transport: expected.transport,
				validationFile,
				preflightFile,
			},
		],
	};
	const input = await readSingleAgentTemplateValidationInput(
		expectations,
		expected.templateId,
		context,
		sessionCompute,
	);
	return { ...input, expectations, sessionCompute };
}

async function loadFixturePublisher() {
	const runtime = new URL(
		"../deploy/ack/runtime-inputs.ts?fixture",
		import.meta.url,
	);
	const hook = registerHooks({
		resolve(specifier, options, next) {
			if (
				options.parentURL === runtime.href &&
				specifier === "./template-model-preflight.mjs"
			)
				return { url: import.meta.url, shortCircuit: true };
			return next(specifier, options);
		},
	});
	try {
		return (await import(runtime)).publishSingleAgentTemplateValidation;
	} finally {
		hook.deregister();
	}
}

test("native publisher refuses a supplied fixture without a measured job", async (t) => {
	const { dir, binding, readBinding } = await fixture(t);
	await runSingleAgentTemplatePreflight(binding.jobFile, binding.expected, dir);
	const publish = t.mock.fn();
	await assert.rejects(
		publishSingleAgentTemplateValidation({ readBinding, publish }, dir),
		/JOB_UNBOUNDED/,
	);
	assert.equal(publish.mock.callCount(), 0);
});

test("single-Agent adoption requires a checked write and the same bytes from both roles", async (t) => {
	const run = await loadFixturePublisher();
	const { dir, binding, readBinding } = await fixture(t);
	const result = await run(
		{
			readBinding,
			async publish(input) {
				await input.verifyBeforeWrite();
				assert.deepEqual(input.binding, binding);
				const record = JSON.parse(input.recordBytes);
				assert.equal(record.kind, "adopted-template-validation");
				assert.deepEqual(record.adoption.target, context);
				assert.equal(record.candidate.executionId, "test-execution");
				assert.equal(input.expiresAt, record.candidate.validUntil);
				return {
					api: Buffer.from(input.recordBytes),
					worker: Buffer.from(input.recordBytes),
					result: "read back",
				};
			},
		},
		dir,
	);
	assert.equal(result, "read back");

	for (const omitted of ["verification", "api", "worker"]) {
		await assert.rejects(
			run(
				{
					readBinding,
					async publish(input) {
						if (omitted !== "verification") await input.verifyBeforeWrite();
						return {
							api: omitted === "api" ? undefined : input.recordBytes,
							worker:
								omitted === "worker"
									? Buffer.from("older revision")
									: input.recordBytes,
						};
					},
				},
				dir,
			),
			/RUNTIME_INPUT_SECRET_READBACK_FAILED/,
			omitted,
		);
	}
});

test("replacing the target Agent or deployment revision before commit prevents the write", async (t) => {
	const run = await loadFixturePublisher();
	for (const change of [{ agentId: "agent-2" }, { revision: "deployment-2" }]) {
		const { dir, binding, readBinding } = await fixture(t);
		const write = t.mock.fn();
		await assert.rejects(
			run(
				{
					readBinding,
					async publish(input) {
						Object.assign(binding, change);
						await input.verifyBeforeWrite();
						write();
					},
				},
				dir,
			),
			/RUNTIME_INPUT_SINGLE_AGENT_BINDING_CHANGED/,
		);
		assert.equal(write.mock.callCount(), 0);
	}
});

test("single-Agent publication binds the measured Session instance while old Workers can still write", async (t) => {
	const run = await loadFixturePublisher();
	const { dir, binding, readBinding, setWorkers } = await fixture(t);
	const deploy = {
		readBinding,
		async publish(input) {
			await input.verifyBeforeWrite();
			return {
				api: input.recordBytes,
				worker: input.recordBytes,
				result: "adopted",
			};
		},
	};
	const oldPod = {
		kind: "Pod",
		spec: worker("eci", "acs").spec.template.spec,
		status: { phase: "Running" },
	};
	await setWorkers(worker("eci", "eci"), oldPod);
	await assert.rejects(run(deploy, dir), /RUNTIME_INPUT_COMPUTE_DRIFT/);

	const current = worker("acs", "eci");
	await setWorkers(current);
	await assert.rejects(run(deploy, dir), /TEMPLATE_EXPECTATION_INVALID/);
	Object.assign(binding.expected, {
		templateId: "codex",
		driver: "codex",
		transport: "paseo-sdk-pod",
	});
	for (const released of [current, worker("eci", "acs")]) {
		await setWorkers(released);
		assert.equal(await run(deploy, dir), "adopted");
	}
	for (const change of [
		() => appendFile(join(dir, "runtime-capacity.receipt.json"), "\n"),
		() => setWorkers(current),
	]) {
		await setWorkers(worker("eci", "acs"));
		const write = t.mock.fn();
		await assert.rejects(
			run(
				{
					readBinding,
					async publish(input) {
						await change();
						await input.verifyBeforeWrite();
						write();
					},
				},
				dir,
			),
			/RUNTIME_INPUT_(LOCAL|COMPUTE)_DRIFT/,
		);
		assert.equal(write.mock.callCount(), 0);
	}
});
