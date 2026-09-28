import { createHash, generateKeyPairSync, sign } from "node:crypto";

import {
	RuntimeBusinessGrantClaimsV4Schema,
	type RuntimeBusinessRequestV4,
	type RuntimePinnedExecutionKeyScopeV4,
	RuntimeSubmitTurnRequestV4Schema,
	RuntimeSupplementRequestV4Schema,
	runtimeRequestSigningPayloadV4,
	validateRuntimePinnedExecutionKeyScopeV4,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it } from "vitest";

import {
	createRuntimeExecutionGrantValidatorV4,
	createRuntimeExecutionGrantVerifierV4,
	createRuntimeExecutionKeyDeliveryValidatorV4,
} from "./grant-v4.js";

const keys = generateKeyPairSync("ed25519");
const verifyGrant = createRuntimeExecutionGrantVerifierV4(
	new Map([["fixture", keys.publicKey]]),
);
const now = 1_800_000_000_000;
const options = {
	expectedIssuer: "platform-fixture",
	expectedWorkerId: "worker-fixture",
	now: () => now,
};
const validateGrant = createRuntimeExecutionGrantValidatorV4(
	new Map([["fixture", keys.publicKey]]),
	options,
);
const validateKeyDelivery = createRuntimeExecutionKeyDeliveryValidatorV4(
	new Map([["fixture", keys.publicKey]]),
	options,
);

const request = RuntimeSubmitTurnRequestV4Schema.parse({
	schemaVersion: 4,
	requestId: "request-fixture",
	traceId: "trace-fixture",
	principal: { kind: "user", id: "user-fixture" },
	executionSource: "web",
	channelId: "web",
	agentId: "agent-fixture",
	conversationId: "conversation-fixture",
	executionId: "execution-fixture",
	turnId: "turn-fixture",
	sessionGeneration: 1,
	hostSessionRef: null,
	operation: {
		kind: "execution",
		id: "execution-fixture",
		deliveryFence: 1,
		executionDeliveryFence: 1,
	},
	grant: { schemaVersion: 4, format: "runtime-execution-jws", token: "a.b.c" },
	keyBinding: {
		purpose: "personal",
		subjectId: "user-fixture",
		ciphertextRef: "key-fixture",
		version: 1,
	},
	input: { text: "synthetic input", attachments: [] },
	selection: {
		schemaVersion: 1,
		modelOptionId: "model-fixture",
		reasoningLevel: "high",
	},
});

function signed(
	changes: Record<string, unknown> = {},
	headerChanges: Record<string, unknown> = {},
	baseRequest: RuntimeBusinessRequestV4 = request,
) {
	const claims = RuntimeBusinessGrantClaimsV4Schema.parse({
		schemaVersion: 4,
		issuer: "platform-fixture",
		audience: "runtime_host",
		issuedAt: now,
		expiresAt: now + 30_000,
		grantId: "grant-fixture",
		workerId: "worker-fixture",
		principal: baseRequest.principal,
		agentId: baseRequest.agentId,
		channelId: baseRequest.channelId,
		conversationId: baseRequest.conversationId,
		executionId: baseRequest.executionId,
		turnId: baseRequest.turnId,
		sessionGeneration: baseRequest.sessionGeneration,
		traceId: baseRequest.traceId,
		hostSessionRef: baseRequest.hostSessionRef,
		operation: baseRequest.operation,
		requestDigest: createHash("sha256")
			.update(runtimeRequestSigningPayloadV4(baseRequest))
			.digest("hex"),
		purpose: "business",
		authorizationRecordId: "authorization-fixture",
		allowedCommands: [
			"selection" in baseRequest ? "turn.submit" : "turn.supplement",
		],
		attachments: [],
		executionSource: baseRequest.executionSource,
		relayKeyBinding: baseRequest.keyBinding,
		...changes,
	});
	const header = Buffer.from(
		JSON.stringify({
			alg: "EdDSA",
			kid: "fixture",
			typ: "runtime-execution+jws",
			...headerChanges,
		}),
	).toString("base64url");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const signature = sign(
		null,
		Buffer.from(`${header}.${payload}`),
		keys.privateKey,
	).toString("base64url");
	return {
		...baseRequest,
		grant: { ...baseRequest.grant, token: `${header}.${payload}.${signature}` },
	};
}

function privateFieldFor(
	value: RuntimeBusinessRequestV4,
	relayKey = "private-key-value-k1",
) {
	const { claims } = verifyGrant(value.grant);
	return {
		schemaVersion: 1,
		context: {
			requestId: value.requestId,
			grantId: claims.grantId,
			requestDigest: claims.requestDigest,
			traceId: value.traceId,
			principal: value.principal,
			executionSource: value.executionSource,
			channelId: value.channelId,
			agentId: value.agentId,
			conversationId: value.conversationId,
			executionId: value.executionId,
			turnId: value.turnId,
			sessionGeneration: value.sessionGeneration,
			hostSessionRef: value.hostSessionRef,
			operation: value.operation,
			keyBinding: value.keyBinding,
		},
		keyDelivery: { relayKey },
	};
}

describe("Runtime V4 Grant trust boundary", () => {
	it("accepts a private Key only after the signed submit and supplement bindings", async () => {
		const submitted = signed();
		await expect(
			validateKeyDelivery({
				businessRequest: submitted,
				privateKeyField: privateFieldFor(submitted),
			}),
		).resolves.toMatchObject({
			request: submitted,
			relayKey: "private-key-value-k1",
		});

		const { selection: _selection, ...supplementBase } = request;
		const supplementRequest = RuntimeSupplementRequestV4Schema.parse({
			...supplementBase,
			hostSessionRef: "session-fixture",
			operation: {
				kind: "message",
				id: "message-fixture",
				deliveryFence: 2,
				executionDeliveryFence: 1,
			},
		});
		const supplemented = signed({}, {}, supplementRequest);
		await expect(
			validateKeyDelivery({
				businessRequest: supplemented,
				privateKeyField: privateFieldFor(supplemented),
			}),
		).resolves.toMatchObject({
			request: supplemented,
			relayKey: "private-key-value-k1",
		});
	});

	it("rejects substituted private context even when the request is changed to match", async () => {
		const submitted = signed();
		const privateKeyField = privateFieldFor(submitted);
		for (const context of [
			{ ...privateKeyField.context, grantId: "other-grant" },
			{ ...privateKeyField.context, requestDigest: "0".repeat(64) },
			{ ...privateKeyField.context, executionId: "other-execution" },
			{ ...privateKeyField.context, channelId: "wecom" },
			{
				...privateKeyField.context,
				keyBinding: { ...privateKeyField.context.keyBinding, version: 2 },
			},
			{
				...privateKeyField.context,
				operation: { ...privateKeyField.context.operation, deliveryFence: 2 },
			},
		]) {
			await expect(
				validateKeyDelivery({
					businessRequest: submitted,
					privateKeyField: { ...privateKeyField, context },
				}),
			).rejects.toThrow("Runtime authorization is unavailable");
		}
		await expect(
			validateKeyDelivery({
				businessRequest: { ...submitted, executionId: "other-execution" },
				privateKeyField: {
					...privateKeyField,
					context: {
						...privateKeyField.context,
						executionId: "other-execution",
					},
				},
			}),
		).rejects.toThrow("Runtime authorization is unavailable");
		await expect(
			validateKeyDelivery({ businessRequest: submitted }),
		).rejects.toThrow("Runtime authorization is unavailable");
	});

	it("verifies Ed25519 JWS and binds the accepted Execution and Key version", async () => {
		const accepted = signed();
		const verified = verifyGrant(accepted.grant);
		await expect(validateGrant(accepted)).resolves.toMatchObject({
			claims: { relayKeyBinding: request.keyBinding },
		});
		expect(verified.claims.grantId).toBe("grant-fixture");
		for (const changed of [
			{ ...accepted, channelId: "wecom" },
			{ ...accepted, executionId: "other-execution" },
			{ ...accepted, keyBinding: { ...accepted.keyBinding, version: 2 } },
			{
				...accepted,
				operation: { ...accepted.operation, deliveryFence: 2 },
			},
		]) {
			await expect(validateGrant(changed)).rejects.toThrow(
				"Runtime authorization is unavailable",
			);
		}
	});

	it("rejects forged, wrong-domain, noncanonical and old-version tokens", () => {
		const accepted = signed();
		const [header, payload, signature] = accepted.grant.token.split(".");
		if (!header || !payload || !signature) throw new Error("Invalid fixture");
		const forgedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
		for (const grant of [
			{ ...accepted.grant, token: `${header}.${payload}.${forgedSignature}` },
			{ ...accepted.grant, token: `${accepted.grant.token}.extra` },
			{ ...accepted.grant, token: accepted.grant.token.replace(".", "=.") },
			{ ...accepted.grant, schemaVersion: 2 },
			signed({}, { typ: "workload-readiness+jws" }).grant,
			signed({}, { kid: "unknown" }).grant,
		]) {
			expect(() => verifyGrant(grant)).toThrow(
				"Runtime authorization is unavailable",
			);
		}
	});

	it("rejects validly signed claims with wrong source, subject or lifetime", async () => {
		for (const changes of [
			{ executionSource: "platform-api" },
			{ relayKeyBinding: { ...request.keyBinding, subjectId: "other-user" } },
			{ issuer: "other-issuer" },
			{ workerId: "other-worker" },
			{ expiresAt: now + 30_001 },
			{
				eventAccess: {
					command: "events.persist",
					consumer: "platform_worker_persistence",
					afterCursor: null,
				},
			},
		]) {
			const changed = signed(changes);
			await expect(validateGrant(changed)).rejects.toThrow(
				"Runtime authorization is unavailable",
			);
		}
	});

	it("rejects a re-signed Key substitution against trusted accepted Execution scopes", async () => {
		const original = signed();
		const acceptedK1: RuntimePinnedExecutionKeyScopeV4 = {
			principal: { kind: "user", id: "user-fixture" },
			executionSource: "web",
			channelId: "web",
			agentId: "agent-fixture",
			conversationId: "conversation-fixture",
			executionId: "execution-fixture",
			turnId: "turn-fixture",
			sessionGeneration: 1,
			keyBinding: {
				purpose: "personal",
				subjectId: "user-fixture",
				ciphertextRef: "key-fixture",
				version: 1,
			},
		};
		const acceptedK2: RuntimePinnedExecutionKeyScopeV4 = {
			...acceptedK1,
			executionId: "execution-next",
			turnId: "turn-next",
			keyBinding: {
				...acceptedK1.keyBinding,
				ciphertextRef: "key-next",
				version: 2,
			},
		};
		const pinned = new Map([
			[acceptedK1.executionId, acceptedK1],
			[acceptedK2.executionId, acceptedK2],
		]);
		let driverCalls = 0;
		async function fakeHost(value: unknown) {
			const accepted = await validateKeyDelivery(value);
			const trusted = pinned.get(accepted.request.executionId);
			if (!trusted) throw new TypeError("Accepted Execution is unavailable");
			validateRuntimePinnedExecutionKeyScopeV4(trusted, accepted.request);
			driverCalls += 1;
			return accepted.relayKey;
		}
		const substitutedFirst = signed(
			{},
			{},
			RuntimeSubmitTurnRequestV4Schema.parse({
				...request,
				keyBinding: { ...request.keyBinding, version: 2 },
			}),
		);
		await expect(
			fakeHost({
				businessRequest: substitutedFirst,
				privateKeyField: privateFieldFor(
					substitutedFirst,
					"private-key-value-k2",
				),
			}),
		).rejects.toThrow("RuntimeHostV4 pinned Execution Key is invalid");
		expect(driverCalls).toBe(0);
		await expect(
			fakeHost({
				businessRequest: original,
				privateKeyField: privateFieldFor(original),
			}),
		).resolves.toBe("private-key-value-k1");
		const { selection: _selection, ...supplementBase } = request;
		const originalSupplement = signed(
			{},
			{},
			RuntimeSupplementRequestV4Schema.parse({
				...supplementBase,
				requestId: "request-supplement",
				hostSessionRef: "session-fixture",
				operation: {
					kind: "message",
					id: "message-fixture",
					deliveryFence: 2,
					executionDeliveryFence: 1,
				},
			}),
		);
		await expect(
			fakeHost({
				businessRequest: originalSupplement,
				privateKeyField: privateFieldFor(originalSupplement),
			}),
		).resolves.toBe("private-key-value-k1");
		const nextExecution = signed(
			{},
			{},
			RuntimeSubmitTurnRequestV4Schema.parse({
				...request,
				requestId: "request-next",
				executionId: "execution-next",
				turnId: "turn-next",
				operation: {
					...request.operation,
					id: "execution-next",
				},
				keyBinding: {
					...request.keyBinding,
					ciphertextRef: "key-next",
					version: 2,
				},
			}),
		);
		await expect(
			fakeHost({
				businessRequest: nextExecution,
				privateKeyField: privateFieldFor(nextExecution, "private-key-value-k2"),
			}),
		).resolves.toBe("private-key-value-k2");
		for (const changed of [
			{ ...request, keyBinding: { ...request.keyBinding, version: 2 } },
			{
				...request,
				principal: { kind: "user" as const, id: "other-user" },
				keyBinding: { ...request.keyBinding, subjectId: "other-user" },
			},
			{ ...request, agentId: "other-agent" },
			{ ...request, channelId: "wecom" },
		]) {
			const substituted = signed(
				{},
				{},
				RuntimeSubmitTurnRequestV4Schema.parse(changed),
			);
			await expect(
				fakeHost({
					businessRequest: substituted,
					privateKeyField: privateFieldFor(substituted),
				}),
			).rejects.toThrow("RuntimeHostV4 pinned Execution Key is invalid");
		}
		await expect(
			fakeHost({
				businessRequest: {
					...original,
					grant: { ...original.grant, schemaVersion: 2 },
				},
				privateKeyField: privateFieldFor(original),
			}),
		).rejects.toThrow("Runtime authorization is unavailable");
		expect(driverCalls).toBe(3);
	});
});
