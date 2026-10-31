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
