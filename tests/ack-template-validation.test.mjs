import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateTemplateValidationExpectations } from "../deploy/ack/template-validation.mjs";

const sourceSha = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;

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

test("accepts four current real-runtime validation tuples", async () => {
	const f = await fixture();
	const result = await validateTemplateValidationExpectations(f.expectations);
	assert.equal(result.pass, true);
	assert.equal(result.results.length, 4);
	assert(result.results.every((entry) => entry.status === "passed"));
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
