import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateAgentRequestFile } from "../deploy/ack/agent-request-preflight.ts";

const baseBody = {
	schemaVersion: 2,
	name: "custom",
	description: "custom request",
	source: {
		kind: "custom",
		imageReference: "ghcr.io/example/custom@sha256:" + "a".repeat(64),
		interactionMode: "self-managed",
		identityResponsibility: "self-managed",
	},
	coOwnerIds: [],
	availability: [],
	environment: [],
	secrets: [],
};

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "ack-request-preflight-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const write = async (name, value) => {
		const file = join(directory, name);
		await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
		await writeFile(
			file,
			typeof value === "string" ? value : JSON.stringify(value),
			{ mode: 0o600 },
		);
		return file;
	};
	const bodyFile = await write("body.json", baseBody);
	const credentialFile = await write("credential", "private-credential");
	const requestsFile = await write("requests.json", {
		schemaVersion: 1,
		requests: [
			{
				name: "custom",
				bodyFile,
				credentialFile,
				idempotencyKey: "custom-request-v1",
			},
		],
	});
	return { write, bodyFile, credentialFile, requestsFile };
}

test("validates custom self-managed request without reading credentials", async (t) => {
	const f = await fixture(t);
	const result = await validateAgentRequestFile(f.requestsFile);
	assert.equal(result.status, "passed");
	assert.deepEqual(result.sourceKinds, ["custom"]);
	assert.equal(result.requestCount, 1);
	assert(!JSON.stringify(result).includes("private-credential"));
});

test("validates standard, platform-adapter, single-entry and multi-service shapes", async (t) => {
	const f = await fixture(t);
	const standard = await f.write("standard.json", {
		schemaVersion: 3,
		name: "standard",
		description: "standard request",
		source: { kind: "standard", templateId: "codex" },
		coOwnerIds: [],
		availability: [],
		environment: [],
		secrets: [],
		modelConfiguration: {
			options: [
				{
					optionId: "default",
					endpointId: "relay",
					modelId: "model",
					reasoningLevels: ["low"],
				},
			],
			defaultOptionId: "default",
			defaultReasoningLevel: "low",
		},
		defaultRelayKey: "private-model-key-123456",
	});
	const adapter = await f.write("adapter.json", {
		...baseBody,
		name: "adapter",
		source: {
			kind: "custom",
			imageReference: "ghcr.io/example/adapter@sha256:" + "b".repeat(64),
			interactionMode: "platform-adapter",
		},
	});
	const multi = await f.write("multi.json", {
		...baseBody,
		name: "multi",
		source: {
			kind: "custom",
			interactionMode: "self-managed",
			identityResponsibility: "self-managed",
			manifest: "apiVersion: v1\nkind: ConfigMap\n",
		},
	});
	const requests = await f.write("matrix.json", {
		schemaVersion: 1,
		requests: [
			{
				name: "standard",
				bodyFile: standard,
				credentialFile: f.credentialFile,
				idempotencyKey: "standard-v1",
			},
			{
				name: "adapter",
				bodyFile: adapter,
				credentialFile: f.credentialFile,
				idempotencyKey: "adapter-v1",
			},
			{
				name: "single",
				bodyFile: f.bodyFile,
				credentialFile: f.credentialFile,
				idempotencyKey: "single-v1",
			},
			{
				name: "multi",
				bodyFile: multi,
				credentialFile: f.credentialFile,
				idempotencyKey: "multi-v1",
			},
		],
	});
	const result = await validateAgentRequestFile(requests);
	assert.equal(result.status, "passed");
	assert.deepEqual(result.sourceKinds, ["custom", "standard"]);
	assert.equal(result.requestCount, 4);
});

test("rejects multi-service manifest combined with imageReference", async (t) => {
	const f = await fixture(t);
	await f.write("body.json", {
		...baseBody,
		source: {
			kind: "custom",
			interactionMode: "self-managed",
			identityResponsibility: "self-managed",
			imageReference: "ghcr.io/example/custom@sha256:" + "a".repeat(64),
			manifest: "version: '3'\nservices: {}",
		},
	});
	const result = await validateAgentRequestFile(f.requestsFile);
	assert.deepEqual(result, {
		schemaVersion: 1,
		kind: "ack-agent-request-preflight",
		status: "failed",
		failureCode: "REQUEST_BODY_INVALID",
		failedIndex: 0,
		requestCount: 0,
		bodyHashes: [],
		businessVerified: false,
	});
});

test("rejects unknown fields and missing body without exposing details", async (t) => {
	const f = await fixture(t);
	await f.write("body.json", {
		...baseBody,
		privateCredential: "should-not-appear",
	});
	assert.equal(
		(await validateAgentRequestFile(f.requestsFile)).failureCode,
		"REQUEST_BODY_INVALID",
	);
	await f.write("requests.json", {
		schemaVersion: 1,
		requests: [
			{
				name: "custom",
				bodyFile: join(f.bodyFile, "missing"),
				credentialFile: f.credentialFile,
				idempotencyKey: "custom-request-v1",
			},
		],
	});
	const result = await validateAgentRequestFile(f.requestsFile);
	assert.equal(result.failureCode, "REQUEST_BODY_UNREADABLE");
	assert(!JSON.stringify(result).includes("missing"));
});

test("rejects more than twenty requests before reading any body", async (t) => {
	const f = await fixture(t);
	const result = await validateAgentRequestFile(
		await f.write("many.json", {
			schemaVersion: 1,
			requests: Array.from({ length: 21 }, (_, index) => ({
				name: `custom-${index}`,
				bodyFile: "/private/missing",
				credentialFile: "/private/credential",
				idempotencyKey: `key-${index}-v1`,
			})),
		}),
	);
	assert.equal(result.failureCode, "REQUEST_FILE_TOO_MANY");
});

test("rejects duplicate names, idempotency keys and empty paths before reading bodies", async (t) => {
	const f = await fixture(t);
	const duplicateName = await f.write("duplicate-name.json", {
		schemaVersion: 1,
		requests: [
			{
				name: "same",
				bodyFile: f.bodyFile,
				credentialFile: f.credentialFile,
				idempotencyKey: "same-key-v1",
			},
			{
				name: "same",
				bodyFile: f.bodyFile,
				credentialFile: f.credentialFile,
				idempotencyKey: "other-key-v1",
			},
		],
	});
	assert.equal(
		(await validateAgentRequestFile(duplicateName)).failureCode,
		"REQUEST_ENTRY_INVALID",
	);
	const duplicateKey = await f.write("duplicate-key.json", {
		schemaVersion: 1,
		requests: [
			{
				name: "first",
				bodyFile: f.bodyFile,
				credentialFile: f.credentialFile,
				idempotencyKey: "same-key-v1",
			},
			{
				name: "second",
				bodyFile: f.bodyFile,
				credentialFile: f.credentialFile,
				idempotencyKey: "same-key-v1",
			},
		],
	});
	assert.equal(
		(await validateAgentRequestFile(duplicateKey)).failureCode,
		"REQUEST_ENTRY_INVALID",
	);
	const emptyPath = await f.write("empty-path.json", {
		schemaVersion: 1,
		requests: [
			{
				name: "empty",
				bodyFile: "",
				credentialFile: f.credentialFile,
				idempotencyKey: "empty-key-v1",
			},
		],
	});
	assert.equal(
		(await validateAgentRequestFile(emptyPath)).failureCode,
		"REQUEST_ENTRY_INVALID",
	);
});

test("CLI exits before deployment when the formal request schema rejects a body", async (t) => {
	const f = await fixture(t);
	await f.write("body.json", {
		...baseBody,
		source: {
			kind: "custom",
			interactionMode: "self-managed",
			identityResponsibility: "self-managed",
			imageReference: "ghcr.io/example/custom@sha256:" + "a".repeat(64),
			manifest: "version: '3'\nservices: {}",
		},
	});
	const { spawnSync } = await import("node:child_process");
	const result = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"deploy/ack/agent-request-preflight.ts",
			f.requestsFile,
		],
		{ encoding: "utf8" },
	);
	assert.notEqual(result.status, 0);
	assert.equal(JSON.parse(result.stdout).failureCode, "REQUEST_BODY_INVALID");
	assert(!result.stdout.includes("private-credential"));
});
