import { generateKeyPairSync } from "node:crypto";

import { createRuntimeExecutionGrantVerifierV2 } from "@agent-infra/agent-runtime";

import {
	RuntimeEventReadRequestV4Schema,
	RuntimeSubmitTurnRequestV4Schema,
	validateRuntimeBusinessBindingV4,
	validateRuntimeEventAccessV4,
} from "@agent-infra/contracts/runtime";
import { expect, it } from "vitest";

import { createWorkerRuntimeGrantSignerV4 } from "./runtime-grant-signer-v4.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signer = createWorkerRuntimeGrantSignerV4({
	issuer: "platform-worker",
	workerId: "worker-1",
	keyId: "grant-key-1",
	privateKey,
	now: () => 100,
	id: () => "grant-1",
});

const request = RuntimeSubmitTurnRequestV4Schema.parse({
	schemaVersion: 4,
	requestId: "request-1",
	traceId: "trace-1",
	principal: { kind: "user", id: "alice" },
	executionSource: "web",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 1,
	hostSessionRef: null,
	operation: {
		kind: "execution",
		id: "execution-1",
		deliveryFence: 1,
		executionDeliveryFence: 1,
	},
	grant: { schemaVersion: 4, format: "runtime-execution-jws", token: "a.b.c" },
	keyBinding: {
		purpose: "personal",
		subjectId: "alice",
		ciphertextRef: "key-1",
		version: 1,
	},
	input: { text: "hello", attachments: [] },
	selection: {
		schemaVersion: 1,
		modelOptionId: "model-1",
		reasoningLevel: "high",
	},
});

it("signs the exact accepted Key and selection without a plaintext claim", async () => {
	const grant = signer.sign(request, "authorization-1");
	const signedRequest = { ...request, grant };
	const claims = signer.verify(grant);
	expect(claims.relayKeyBinding).toEqual(request.keyBinding);
	expect(claims.executionSource).toBe("web");
	expect(JSON.stringify(claims)).not.toContain('relayKey":');
	await expect(
		validateRuntimeBusinessBindingV4(signedRequest, claims),
	).resolves.toBeUndefined();
	await expect(
		validateRuntimeBusinessBindingV4(
			{
				...signedRequest,
				keyBinding: { ...request.keyBinding, version: 2 },
			},
			claims,
		),
	).rejects.toThrow();
	expect(() =>
		signer.verify({ ...grant, token: `${grant.token.slice(0, -1)}X` }),
	).toThrow("Runtime V4 grant is invalid");
});

it("signs V4 event access against the original Key and execution fence", async () => {
	const { input: _input, selection: _selection, ...base } = request;
	const read = RuntimeEventReadRequestV4Schema.parse({
		...base,
		hostSessionRef: "session-1",
		grant: {
			schemaVersion: 2,
			format: "runtime-execution-jws",
			token: "a.b.c",
		},
		consumer: "platform_worker_persistence",
		afterCursor: null,
	});
	const grant = await signer.signEvent(read, {
		purpose: "business",
		authorizationRecordId: "authorization-1",
	});
	const signed = { ...read, grant };
	const verified = createRuntimeExecutionGrantVerifierV2(
		new Map([["grant-key-1", publicKey]]),
	)(grant);
	const pinned = { ...read, hostSessionRef: null };
	const context = {
		expectedIssuer: "platform-worker",
		expectedWorkerId: "worker-1",
		now: 100,
		trustedOperation: read.operation,
	};
	await expect(
		validateRuntimeEventAccessV4(
			signed,
			verified,
			pinned,
			"session-1",
			context,
		),
	).resolves.toEqual(signed);
	for (const changed of [
		{ ...signed, keyBinding: { ...signed.keyBinding, version: 2 } },
		{
			...signed,
			operation: { ...signed.operation, executionDeliveryFence: 2 },
		},
	]) {
		await expect(
			validateRuntimeEventAccessV4(
				changed,
				verified,
				pinned,
				"session-1",
				context,
			),
		).rejects.toThrow("RuntimeHostV4 event access is invalid");
	}
});
