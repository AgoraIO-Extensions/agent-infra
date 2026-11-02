import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { buildSync } from "esbuild";

function bundle(entry) {
	const output = buildSync({
		entryPoints: [entry], bundle: true, platform: "node", target: "node24", format: "cjs", write: false, logLevel: "error",
		alias: {
			"@agent-infra/contracts/runtime": resolve("packages/contracts/src/runtime/index.ts"),
			"@agent-infra/contracts": resolve("packages/contracts/src/index.ts"),
			"@agent-infra/contracts/files": resolve("packages/contracts/src/files.ts"),
			"@agent-infra/platform-core": resolve("packages/platform-core/src/index.ts"),
		},
	});
	const module = { exports: {} };
	new Function("require", "module", "exports", output.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
	return module.exports;
}
const { createTemplateExecutionRenewal } = bundle("deploy/ack/template-execution-renewal.mts");
const keys = generateKeyPairSync("ed25519");

function request() {
	return {
		schemaVersion: 4, requestId: "request", traceId: "trace", principal: { kind: "application", id: "app" },
		executionSource: "eval", channelId: "isolated-template-validation", agentId: "agent", conversationId: "conversation", executionId: "execution", turnId: "turn", sessionGeneration: 1,
		hostSessionRef: "host", operation: { kind: "execution", id: "execution", deliveryFence: 1, executionDeliveryFence: 1 },
		keyBinding: { purpose: "agent-default", subjectId: "agent", ciphertextRef: "ciphertext", version: 1 }, input: { text: "READY", attachments: [] },
	};
}

test("renews through V3-compatible Grant V2 and binds the accepted execution", async () => {
	let now = 1_800_000_000_000;
	const calls = [];
	const renew = createTemplateExecutionRenewal({
		request: request(), hostSessionRef: "host", authorizationRecordId: "authorization", initialExpiresAt: now + 30_000,
		signing: { issuer: "issuer", workerId: "worker", keyId: "key", privateKey: keys.privateKey, now: () => now }, signal: new AbortController().signal,
		waitForHostGrant: async () => {}, post: async (path, body) => { calls.push({ path, body }); return { schemaVersion: 3, executionId: "execution", expiresAt: now + 30_000 }; },
	});
	now += 15_000;
	await renew();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].path, "/internal/runtime/v3/authorizations/renew");
	assert.equal(calls[0].body.schemaVersion, 3);
	assert.equal(calls[0].body.hostSessionRef, "host");
	assert.equal(calls[0].body.executionId, "execution");
	assert.equal(calls[0].body.operation.executionDeliveryFence, 1);
});

test("renewal abort fails closed and does not report success", async () => {
	const controller = new AbortController();
	const renew = createTemplateExecutionRenewal({
		request: request(), hostSessionRef: "host", authorizationRecordId: "authorization", initialExpiresAt: 1_800_000_030_000,
		signing: { issuer: "issuer", workerId: "worker", keyId: "key", privateKey: keys.privateKey, now: () => 1_800_000_015_000 }, signal: controller.signal,
		waitForHostGrant: async () => controller.abort(), post: async () => ({ schemaVersion: 3, executionId: "execution", expiresAt: 1_800_000_045_000 }),
	});
	await assert.rejects(renew);
});
