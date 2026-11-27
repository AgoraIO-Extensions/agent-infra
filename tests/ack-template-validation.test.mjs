import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	readTemplateValidationAdoptionInputs,
	templatePreflightValidationReceipt,
	validateTemplateValidationExpectations,
} from "../deploy/ack/template-validation.mjs";

const sourceSha = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const validationContext = {
	sourceCommit: sourceSha,
	clusterUid: "cluster-a",
	namespace: "ack-test",
	namespaceUid: "namespace-a",
	installationId: "installation-a",
};

async function fixture({ expired = false, drift = false } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "ack-template-validation-"));
	const now = Date.now();
	const validationFiles = [];
	const preflightFiles = [];
	const definitions = [
		["codex", "codex"],
		["claude", "claude"],
		["opencode", "acp"],
		["pi", "pi"],
	];
	for (const [templateId, driver] of definitions) {
		const validationFile = join(
			directory,
			`template-validation-${templateId}.json`,
		);
		const preflightFile = join(
			directory,
			`template-model-preflight-${templateId}.json`,
		);
		await writeFile(
			validationFile,
			JSON.stringify({
				schemaVersion: 1,
				templateId,
				sourceCommit: sourceSha,
				imageDigest,
				driver,
				configurationRevision: `revision-${templateId}`,
				status: "passed",
				evidenceKind: "real-runtime-model",
				executionId: `execution-${templateId}`,
				modelId: templateId === "codex" ? "gpt-5.6-sol" : "claude-opus-5",
				validatedAt: now - 1_000,
				validUntil: expired ? now + 1_000 : now + 600_000,
			}),
			{ mode: 0o600 },
		);
		await writeFile(
			preflightFile,
			JSON.stringify({
				schemaVersion: 1,
				scope: "isolated-template-real-model",
				templateId,
				sourceCommit: sourceSha,
				imageDigest,
				configurationRevision: `revision-${templateId}`,
				modelId: templateId === "codex" ? "gpt-5.6-sol" : "claude-opus-5",
				terminalStatus: "completed",
				modelFactSource: "protected-driver-journal",
				modelOperationCount: 1,
				validatedAt: now - 1_000,
			}),
			{ mode: 0o600 },
		);
		validationFiles.push(validationFile);
		preflightFiles.push(preflightFile);
	}
	const templates = definitions.map(([templateId, driver], index) => ({
		templateId,
		driver,
		imageDigest:
			drift && templateId === "pi" ? `sha256:${"c".repeat(64)}` : imageDigest,
		configurationRevision: `revision-${templateId}`,
		modelId: templateId === "codex" ? "gpt-5.6-sol" : "claude-opus-5",
		validationFile: validationFiles[index],
		preflightFile: preflightFiles[index],
	}));
	return {
		directory,
		expectations: {
			schemaVersion: 1,
			sourceSha,
			minValidityMs: 60_000,
			templates,
		},
	};
}

test("single-Agent preflight checks the original source, target, model terminal and candidate window", async (t) => {
	const { directory, expectations } = await fixture();
	t.after(() => rm(directory, { recursive: true, force: true }));
	const item = expectations.templates.find(
		(entry) => entry.templateId === "opencode",
	);
	const candidate = JSON.parse(await readFile(item.validationFile));
	const preflight = templatePreflightValidationReceipt({
		...JSON.parse(await readFile(item.preflightFile)),
		executionId: candidate.executionId,
		validationTarget: validationContext,
	});
	const expectedFile = join(directory, "one-template.json");
	const contextFile = join(directory, "target.json");
	const save = (path, value) =>
		writeFile(path, JSON.stringify(value), { mode: 0o600 });
	await save(expectedFile, { ...expectations, templates: [item] });
	await save(contextFile, validationContext);
	await save(item.preflightFile, preflight);
	const run = (template = "opencode") =>
		spawnSync(
			process.execPath,
			[
				fileURLToPath(
					new URL("../deploy/ack/template-validation.mjs", import.meta.url),
				),
				expectedFile,
				"--single-agent",
				template,
				contextFile,
			],
			{ encoding: "utf8" },
		);
	const valid = run();
	assert.equal(valid.status, 0, valid.stderr);
	const report = JSON.parse(valid.stdout);
	assert.equal(report.kind, "single-agent-template-preflight-check");
	assert.equal(report.templateId, item.templateId);
	const hashFile = async (path) =>
		createHash("sha256")
			.update(await readFile(path))
			.digest("hex");
	assert.equal(report.candidateFileSha256, await hashFile(item.validationFile));
	assert.equal(report.preflightFileSha256, await hashFile(item.preflightFile));
	assert.equal(run("codex").status, 1);
	for (const change of [
		{ validationTarget: { ...validationContext, installationId: "other" } },
		{ executionId: "different" },
		{ modelOperationCount: 0 },
		{ terminalStatus: "failed" },
		{ sourceCommit: "e".repeat(40) },
		{ imageDigest: `sha256:${"e".repeat(64)}` },
		{ configurationRevision: "different" },
	]) {
		await save(item.preflightFile, { ...preflight, ...change });
		assert.equal(run().status, 1);
	}
	const malformedId = "x".repeat(1025);
	await save(item.validationFile, { ...candidate, executionId: malformedId });
	await save(item.preflightFile, { ...preflight, executionId: malformedId });
	assert.equal(run().status, 1);
	await save(item.preflightFile, preflight);
	for (const validUntil of [
		candidate.validatedAt + 3_600_001,
		candidate.validatedAt + 1,
	]) {
		await save(item.validationFile, { ...candidate, validUntil });
		assert.equal(run().status, 1);
	}
});

test("Pi companion publication needs the original companion measurement", async () => {
	const { expectations } = await fixture();
	const pi = expectations.templates.find((item) => item.templateId === "pi");
	pi.transport = "paseo-sdk-pod";
	const input = JSON.parse(await readFile(pi.preflightFile, "utf8"));
	const measure = async (transport) => {
		await writeFile(
			pi.preflightFile,
			JSON.stringify({
				...input,
				schemaVersion: 3,
				executionId: "execution-pi",
				transport,
				transportEvidence: "original-pi-driver-session",
			}),
		);
		return (
			await validateTemplateValidationExpectations(expectations)
		).results.find((item) => item.templateId === "pi");
	};
	assert.equal((await measure("paseo-sdk")).status, "failed");
	assert.equal((await measure("paseo-sdk-pod")).status, "passed");
});

test("publishing the measured OpenCode CPU split accepts only its SDK expectation", async (t) => {
	const { directory, expectations } = await fixture();
	t.after(() => rm(directory, { recursive: true, force: true }));
	const item = expectations.templates.find((t) => t.templateId === "opencode");
	Object.assign(item, {
		transport: "paseo-sdk-pod",
		companionCpuLimitPercent: 80,
	});
	const original = JSON.parse(await readFile(item.preflightFile, "utf8"));
	await writeFile(
		item.preflightFile,
		JSON.stringify({
			...original,
			schemaVersion: 3,
			executionId: "execution-opencode",
			transport: item.transport,
			transportEvidence: "original-acp-driver-session",
		}),
	);
	const result = await validateTemplateValidationExpectations(expectations);
	assert.equal(
		result.results.find((r) => r.templateId === "opencode").status,
		"passed",
	);
	delete item.transport;
	await assert.rejects(
		validateTemplateValidationExpectations(expectations),
		/TEMPLATE_EXPECTATION_INVALID/,
	);
});

test("native publication rejects SDK transport evidence", async () => {
	const { expectations } = await fixture();
	const pi = expectations.templates.find((item) => item.templateId === "pi");
	const preflight = JSON.parse(await readFile(pi.preflightFile, "utf8"));
	await writeFile(
		pi.preflightFile,
		JSON.stringify({
			...preflight,
			schemaVersion: 3,
			executionId: "execution-pi",
			transport: "paseo-sdk",
			transportEvidence: "original-pi-driver-session",
		}),
	);
	const result = await validateTemplateValidationExpectations(expectations);
	assert.equal(result.pass, false);
	assert.equal(
		result.results.find((item) => item.templateId === "pi")?.status,
		"failed",
	);
});

test("Codex SDK adoption binds its original SDK execution and rejects Native or foreign evidence", async (t) => {
	const { directory, expectations } = await fixture();
	t.after(() => rm(directory, { recursive: true, force: true }));
	const codex = expectations.templates.find(
		(item) => item.templateId === "codex",
	);
	expectations.templates = [codex];
	codex.transport = "paseo-sdk-pod";
	const original = JSON.parse(await readFile(codex.preflightFile, "utf8"));
	const receipt = templatePreflightValidationReceipt({
		...original,
		executionId: "execution-codex",
		transport: "paseo-sdk-pod",
		transportEvidence: "original-codex-driver-session",
		validationTarget: validationContext,
	});
	const save = (value) =>
		writeFile(codex.preflightFile, JSON.stringify(value), { mode: 0o600 });
	await save(receipt);
	assert.equal(
		(
			await validateTemplateValidationExpectations(expectations, {
				codexTrial: true,
			})
		).pass,
		true,
	);
	const adopted = await readTemplateValidationAdoptionInputs(
		expectations,
		validationContext,
		true,
	);
	assert.equal(adopted.length, 1);
	assert.deepEqual(JSON.parse(adopted[0].preflightBytes), receipt);
	const rendered = spawnSync(
		"helm",
		[
			"template",
			"agent-infra",
			"deploy/ack/chart",
			"--namespace",
			validationContext.namespace,
			"--kube-version",
			"1.36.0",
			"--set",
			"agentWorkloadScheduling.enabled=true,sessionRuntimeScheduling.enabled=true,sessionRuntimeScheduling.compute=acs",
		],
		{ encoding: "utf8" },
	);
	assert.equal(rendered.status, 0, rendered.stderr);
	const manifestFile = join(directory, "rendered.yaml");
	const expectedFile = join(directory, "expectations.json");
	const targetFile = join(directory, "target.json");
	await writeFile(manifestFile, rendered.stdout);
	await writeFile(targetFile, JSON.stringify(validationContext), {
		mode: 0o600,
	});
	const runSingle = async (expected) => {
		await writeFile(expectedFile, JSON.stringify(expected), { mode: 0o600 });
		return spawnSync(
			process.execPath,
			[
				fileURLToPath(
					new URL("../deploy/ack/template-validation.mjs", import.meta.url),
				),
				expectedFile,
				"--single-agent",
				"codex",
				targetFile,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					ACK_NAMESPACE: validationContext.namespace,
					ACK_RENDERED_MANIFEST_FILE: manifestFile,
				},
			},
		);
	};
	const capacityFile = join(directory, "runtime-capacity.receipt.json");
	const capacity = {
		schemaVersion: 1,
		scope: "ack-runtime-capacity",
		sourceCommit: sourceSha,
		imageDigest,
		transport: codex.transport,
		computeInstanceId: "acs-example01",
		completedAt: receipt.validatedAt,
		modelOperationCount: receipt.modelOperationCount,
		terminalStatus: "completed",
		replyMatched: true,
	};
	assert.equal((await runSingle(expectations)).status, 1);
	for (const change of [
		{ computeInstanceId: "eci-example01" },
		{ completedAt: capacity.completedAt - 1 },
		{ modelOperationCount: 0 },
	]) {
		await writeFile(capacityFile, JSON.stringify({ ...capacity, ...change }), {
			mode: 0o600,
		});
		assert.equal((await runSingle(expectations)).status, 1);
	}
	await writeFile(capacityFile, JSON.stringify(capacity), { mode: 0o600 });
	const single = await runSingle(expectations);
	assert.equal(single.status, 0, single.stderr);
	assert.equal(JSON.parse(single.stdout).templateId, "codex");
	assert.equal(JSON.parse(single.stdout).sessionCompute, "acs");
	assert.equal(
		JSON.parse(single.stdout).capacityFileSha256,
		createHash("sha256")
			.update(await readFile(capacityFile))
			.digest("hex"),
	);
	const otherNamespace = {
		...validationContext,
		namespace: "other-installation",
	};
	await writeFile(targetFile, JSON.stringify(otherNamespace));
	await save({ ...receipt, validationTarget: otherNamespace });
	assert.equal((await runSingle(expectations)).status, 1);
	await writeFile(targetFile, JSON.stringify(validationContext));
	await save(
		templatePreflightValidationReceipt({
			...original,
			executionId: "execution-codex",
			validationTarget: validationContext,
		}),
	);
	const native = { ...codex };
	delete native.transport;
	assert.equal(
		(await runSingle({ ...expectations, templates: [native] })).status,
		1,
	);
	for (const invalid of [
		original,
		{ ...receipt, transportEvidence: "original-pi-driver-session" },
		{ ...receipt, executionId: "foreign-execution" },
		{
			...receipt,
			validationTarget: {
				...validationContext,
				namespaceUid: "foreign-namespace",
			},
		},
	]) {
		await save(invalid);
		await assert.rejects(() =>
			readTemplateValidationAdoptionInputs(
				expectations,
				validationContext,
				true,
			),
		);
	}
});

test("accepts four current real-runtime validation tuples", async () => {
	const f = await fixture();
	const result = await validateTemplateValidationExpectations(f.expectations);
	assert.equal(result.pass, true);
	assert.equal(result.results.length, 4);
	assert(result.results.every((entry) => entry.status === "passed"));
});

test("formal adoption reads the exact real preflight bytes and original target, not a target attached to legacy evidence", async () => {
	const f = await fixture();
	await assert.rejects(
		readTemplateValidationAdoptionInputs(f.expectations, validationContext),
		/PREFLIGHT_TARGET_INVALID/,
	);
	for (const expected of f.expectations.templates) {
		const candidate = JSON.parse(await readFile(expected.validationFile));
		const preflight = JSON.parse(await readFile(expected.preflightFile));
		await writeFile(
			expected.preflightFile,
			JSON.stringify(
				templatePreflightValidationReceipt({
					...preflight,
					executionId: candidate.executionId,
					validationTarget: validationContext,
				}),
			),
			{ mode: 0o600 },
		);
	}
	const inputs = await readTemplateValidationAdoptionInputs(
		f.expectations,
		validationContext,
	);
	assert.equal(inputs.length, 4);
	assert.equal(
		(await validateTemplateValidationExpectations(f.expectations)).pass,
		true,
	);
	for (const entry of inputs) {
		assert.equal(entry.candidateFileSha256.length, 64);
		assert.deepEqual(
			entry.candidateBytes,
			await readFile(entry.validationFile),
		);
		assert.deepEqual(entry.preflightBytes, await readFile(entry.preflightFile));
	}
	await assert.rejects(
		readTemplateValidationAdoptionInputs(f.expectations, {
			...validationContext,
			namespaceUid: "different",
		}),
		/PREFLIGHT_TARGET_INVALID/,
	);
	const originalCandidate = await readFile(
		f.expectations.templates[0].validationFile,
	);
	const shiftedCandidate = JSON.parse(originalCandidate);
	shiftedCandidate.validatedAt += 1;
	await writeFile(
		f.expectations.templates[0].validationFile,
		JSON.stringify(shiftedCandidate),
		{ mode: 0o600 },
	);
	await assert.rejects(
		readTemplateValidationAdoptionInputs(f.expectations, validationContext),
		/PREFLIGHT_TARGET_INVALID/,
	);
	await writeFile(
		f.expectations.templates[0].validationFile,
		originalCandidate,
		{ mode: 0o600 },
	);
	const file = f.expectations.templates[0].preflightFile;
	const value = JSON.parse(await readFile(file));
	value.executionId = "unrelated-execution";
	await writeFile(file, JSON.stringify(value), { mode: 0o600 });
	await assert.rejects(
		readTemplateValidationAdoptionInputs(f.expectations, validationContext),
		/PREFLIGHT_TARGET_INVALID/,
	);
});

test("projects Runtime diagnostics into the deployment receipt without losing required evidence", async () => {
	const f = await fixture();
	const file = f.expectations.templates[0].preflightFile;
	const measured = {
		...JSON.parse(await readFile(file, "utf8")),
		executionId: "private-validation-execution",
		submittedAt: Date.now() - 2_000,
		observedResourceLimits: { cpu: "1", memory: "2Gi" },
	};
	await writeFile(file, JSON.stringify(measured));
	assert.equal(
		(await validateTemplateValidationExpectations(f.expectations)).results[0]
			.reason,
		"PREFLIGHT_UNBOUNDED",
	);
	await writeFile(
		file,
		JSON.stringify(templatePreflightValidationReceipt(measured)),
	);
	assert.equal(
		(await validateTemplateValidationExpectations(f.expectations)).pass,
		true,
	);
	await writeFile(
		file,
		JSON.stringify(
			templatePreflightValidationReceipt({
				...measured,
				modelOperationCount: 0,
			}),
		),
	);
	assert.equal(
		(await validateTemplateValidationExpectations(f.expectations)).results[0]
			.reason,
		"PREFLIGHT_TUPLE_INVALID",
	);
});

test("rejects an expired receipt before it can authorize deployment", async () => {
	const f = await fixture({ expired: true });
	const result = await validateTemplateValidationExpectations(f.expectations);
	assert.equal(result.pass, false);
	assert.equal(
		result.results.find((entry) => entry.templateId === "codex")?.reason,
		"VALIDATION_EXPIRED_OR_CLOCK_INVALID",
	);
});

test("rejects image tuple drift", async () => {
	const f = await fixture({ drift: true });
	const result = await validateTemplateValidationExpectations(f.expectations);
	assert.equal(result.pass, false);
	assert.equal(
		result.results.find((entry) => entry.templateId === "pi")?.reason,
		"VALIDATION_TUPLE_INVALID",
	);
});

test("requires private regular files", async () => {
	const f = await fixture();
	await chmod(f.expectations.templates[0].validationFile, 0o644);
	const result = await validateTemplateValidationExpectations(f.expectations);
	assert.equal(result.pass, false);
	assert.equal(result.results[0].reason, "VALIDATION_FILE_INVALID");
});
