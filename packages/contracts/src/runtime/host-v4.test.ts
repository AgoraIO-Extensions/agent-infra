import { createHash } from "node:crypto";

import { expect, it } from "vitest";
import {
	RuntimeBusinessGrantClaimsV4Schema,
	RuntimePrivateRelayKeyFieldV1Schema,
	type RuntimeSubmitTurnRequestV4,
	RuntimeSubmitTurnRequestV4Schema,
	type RuntimeSupplementRequestV4,
	RuntimeSupplementRequestV4Schema,
	runtimeRequestDigestV4,
	runtimeRequestSigningPayloadV4,
	validateRuntimeBusinessBindingV4,
	validateRuntimePrivateRelayKeyFieldV1,
	validateVerifiedRuntimeExecutionGrantClaimsV4,
} from "./host-v4.js";

type BusinessRequest = RuntimeSubmitTurnRequestV4 | RuntimeSupplementRequestV4;

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
		modelOptionId: "model-a",
		reasoningLevel: "high",
	},
});

function digest(value: BusinessRequest): string {
	return createHash("sha256")
		.update(runtimeRequestSigningPayloadV4(value))
		.digest("hex");
}

function claims(value: BusinessRequest) {
	return RuntimeBusinessGrantClaimsV4Schema.parse({
		schemaVersion: 4,
		issuer: "platform-worker",
		audience: "runtime_host",
		issuedAt: 1,
		expiresAt: 2,
		grantId: "grant-1",
		workerId: "worker-1",
		principal: value.principal,
		agentId: value.agentId,
		channelId: value.channelId,
		conversationId: value.conversationId,
		executionId: value.executionId,
		turnId: value.turnId,
		sessionGeneration: value.sessionGeneration,
		traceId: value.traceId,
		executionSource: value.executionSource,
		relayKeyBinding: value.keyBinding,
		hostSessionRef: value.hostSessionRef,
		operation: value.operation,
		requestDigest: digest(value),
		purpose: "business",
		authorizationRecordId: "authorization-1",
		allowedCommands: ["selection" in value ? "turn.submit" : "turn.supplement"],
		attachments: [],
	});
}

const privateField = RuntimePrivateRelayKeyFieldV1Schema.parse({
	schemaVersion: 1,
	context: {
		requestId: request.requestId,
		grantId: "grant-1",
		requestDigest: digest(request),
		traceId: request.traceId,
		principal: request.principal,
		executionSource: request.executionSource,
		channelId: request.channelId,
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		hostSessionRef: request.hostSessionRef,
		operation: request.operation,
		keyBinding: request.keyBinding,
	},
	keyDelivery: { relayKey: "private-key-value-k1" },
});

it("binds the Key reference/version into the Grant digest without the Key", async () => {
	const payload = runtimeRequestSigningPayloadV4(request);
	expect(payload).toContain('"ciphertextRef":"key-1"');
	expect(payload).toContain('"version":1');
	expect(payload).not.toContain("private-key-value-k1");
	expect(payload).not.toContain("relayKey");
	expect(
		RuntimeSubmitTurnRequestV4Schema.safeParse({
			...request,
			keyDelivery: privateField.keyDelivery,
		}).success,
	).toBe(false);
	expect(
		validateRuntimePrivateRelayKeyFieldV1(privateField, {
			request,
			grantId: "grant-1",
			requestDigest: digest(request),
		}),
	).toEqual(privateField);
	expect(await runtimeRequestDigestV4(request)).toBe(digest(request));
	await expect(
		validateRuntimeBusinessBindingV4(request, claims(request)),
	).resolves.toBeUndefined();
	expect(
		validateVerifiedRuntimeExecutionGrantClaimsV4(claims(request), {
			expectedIssuer: "platform-worker",
			expectedWorkerId: "worker-1",
			now: 1,
		}),
	).toEqual(claims(request));
	expect(
		digest({
			...request,
			keyBinding: { ...request.keyBinding, version: 2 },
		}),
	).not.toBe(digest(request));
});

it("rejects substituted subject, channel, operation fence and stale Grant digest", async () => {
	const grant = claims(request);
	for (const changed of [
		{ ...request, keyBinding: { ...request.keyBinding, subjectId: "bob" } },
		{ ...request, channelId: "wecom" },
		{
			...request,
			operation: { ...request.operation, deliveryFence: 2 },
		},
		{ ...request, keyBinding: { ...request.keyBinding, version: 2 } },
	]) {
		await expect(
			validateRuntimeBusinessBindingV4(changed, grant),
		).rejects.toThrow("RuntimeHostV4 binding is invalid");
	}
	await expect(
		validateRuntimeBusinessBindingV4(request, {
			...grant,
			requestDigest: "0".repeat(64),
		}),
	).rejects.toThrow("RuntimeHostV4 binding is invalid");
	await expect(
		validateRuntimeBusinessBindingV4(request, {
			...grant,
			relayKeyBinding: { ...grant.relayKeyBinding, version: 2 },
		}),
	).rejects.toThrow("RuntimeHostV4 binding is invalid");
	await expect(
		validateRuntimeBusinessBindingV4(request, {
			...grant,
			purpose: "control",
		} as unknown),
	).rejects.toThrow("RuntimeHostV4 binding is invalid");
});

it("accepts an Agent default Key for an API principal and rejects cross-Agent reuse", async () => {
	const apiRequest = RuntimeSubmitTurnRequestV4Schema.parse({
		...request,
		principal: { kind: "application", id: "api-client" },
		executionSource: "platform-api",
		channelId: "platform-api",
		keyBinding: {
			purpose: "agent-default",
			subjectId: "agent-1",
			ciphertextRef: "agent-key-1",
			version: 2,
		},
	});
	await expect(
		validateRuntimeBusinessBindingV4(apiRequest, claims(apiRequest)),
	).resolves.toBeUndefined();
	await expect(
		validateRuntimeBusinessBindingV4(
			{
				...apiRequest,
				keyBinding: { ...apiRequest.keyBinding, subjectId: "agent-2" },
			},
			claims(apiRequest),
		),
	).rejects.toThrow("RuntimeHostV4 binding is invalid");
	await expect(
		validateRuntimeBusinessBindingV4(
			{
				...apiRequest,
				keyBinding: {
					purpose: "personal",
					subjectId: "alice",
					ciphertextRef: "key-1",
					version: 1,
				},
			},
			claims(apiRequest),
		),
	).rejects.toThrow("RuntimeHostV4 binding is invalid");
});

it("keeps the original Key binding for a supplement after Key replacement", async () => {
	const { selection: _selection, ...original } = request;
	const supplement = RuntimeSupplementRequestV4Schema.parse({
		...original,
		requestId: "request-2",
		hostSessionRef: "session-1",
		operation: {
			kind: "message",
			id: "message-2",
			deliveryFence: 2,
			executionDeliveryFence: 1,
		},
	});
	await expect(
		validateRuntimeBusinessBindingV4(supplement, claims(supplement)),
	).resolves.toBeUndefined();
	const changed = {
		...supplement,
		keyBinding: { ...supplement.keyBinding, version: 2 },
	};
	await expect(
		validateRuntimeBusinessBindingV4(changed, claims(supplement)),
	).rejects.toThrow("RuntimeHostV4 binding is invalid");
});

it("rejects a freshly signed request with the wrong Key purpose for its source", async () => {
	const apiUser = RuntimeSubmitTurnRequestV4Schema.parse({
		...request,
		executionSource: "platform-api",
		channelId: "platform-api",
	});
	const webDefault = RuntimeSubmitTurnRequestV4Schema.parse({
		...request,
		keyBinding: {
			purpose: "agent-default",
			subjectId: "agent-1",
			ciphertextRef: "agent-key-1",
			version: 1,
		},
	});
	for (const wrongPurpose of [apiUser, webDefault]) {
		await expect(
			validateRuntimeBusinessBindingV4(wrongPurpose, claims(wrongPurpose)),
		).rejects.toThrow("RuntimeHostV4 binding is invalid");
	}
});

it("does not trust a request-supplied source over persisted acceptance authority", async () => {
	const apiRequest = RuntimeSubmitTurnRequestV4Schema.parse({
		...request,
		executionSource: "platform-api",
		channelId: "platform-api",
		principal: { kind: "application", id: "api-client" },
		keyBinding: {
			purpose: "agent-default",
			subjectId: "agent-1",
			ciphertextRef: "agent-key-1",
			version: 1,
		},
	});
	await expect(
		validateRuntimeBusinessBindingV4(apiRequest, {
			...claims(apiRequest),
			executionSource: "web",
		}),
	).rejects.toThrow("RuntimeHostV4 binding is invalid");
});

it("rejects freshly signed requests that violate Grant operation or attachment scope", async () => {
	for (const changed of [
		{
			...request,
			operation: { ...request.operation, id: "other-execution" },
		},
		{
			...request,
			operation: { ...request.operation, deliveryFence: 2 },
		},
	]) {
		await expect(
			validateRuntimeBusinessBindingV4(changed, claims(changed)),
		).rejects.toThrow("RuntimeHostV4 binding is invalid");
	}
	const withAttachment = RuntimeSubmitTurnRequestV4Schema.parse({
		...request,
		input: { text: "hello", attachments: ["attachment-1"] },
	});
	await expect(
		validateRuntimeBusinessBindingV4(withAttachment, claims(withAttachment)),
	).rejects.toThrow("RuntimeHostV4 binding is invalid");
	await expect(
		validateRuntimeBusinessBindingV4(withAttachment, {
			...claims(withAttachment),
			attachments: [{ attachmentId: "attachment-1", operations: ["read"] }],
		}),
	).resolves.toBeUndefined();
	await expect(
		validateRuntimeBusinessBindingV4(withAttachment, {
			...claims(withAttachment),
			attachments: [{ attachmentId: "attachment-1", operations: ["write"] }],
		} as unknown),
	).rejects.toThrow("RuntimeHostV4 binding is invalid");
	const twoAttachments = RuntimeSubmitTurnRequestV4Schema.parse({
		...request,
		input: { text: "hello", attachments: ["attachment-1", "attachment-2"] },
	});
	await expect(
		validateRuntimeBusinessBindingV4(twoAttachments, {
			...claims(twoAttachments),
			attachments: [
				{ attachmentId: "attachment-1", operations: ["read"] },
				{ attachmentId: "attachment-1", operations: ["read"] },
			],
		}),
	).rejects.toThrow("RuntimeHostV4 binding is invalid");
	await expect(
		validateRuntimeBusinessBindingV4(request, {
			...claims(request),
			traceId: "other-trace",
		}),
	).rejects.toThrow("RuntimeHostV4 binding is invalid");
});

it("rejects static credential fallback and an unprintable private Key", () => {
	expect(
		RuntimeSubmitTurnRequestV4Schema.safeParse({
			...request,
			grant: { ...request.grant, schemaVersion: 2 },
		}).success,
	).toBe(false);
	expect(
		RuntimeSubmitTurnRequestV4Schema.safeParse({
			...request,
			keyBinding: undefined,
		}).success,
	).toBe(false);
	expect(
		RuntimeSubmitTurnRequestV4Schema.safeParse({
			...request,
			credentialEnvironmentVariable: "AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_A",
		}).success,
	).toBe(false);
	expect(
		RuntimeSubmitTurnRequestV4Schema.safeParse({
			...request,
			keyBinding: { ...request.keyBinding, version: 0 },
		}).success,
	).toBe(false);
	for (const relayKey of [
		" private-key-value-k1",
		"private-key-value-k1 ",
		"private-key-value k1",
	]) {
		expect(
			RuntimePrivateRelayKeyFieldV1Schema.safeParse({
				...privateField,
				keyDelivery: { relayKey },
			}).success,
		).toBe(false);
	}
	expect(() =>
		validateRuntimePrivateRelayKeyFieldV1(
			{
				...privateField,
				context: { ...privateField.context, executionId: "other-execution" },
			},
			{ request, grantId: "grant-1", requestDigest: digest(request) },
		),
	).toThrow("RuntimeHostV4 private Key field is invalid");
	for (const changed of [
		{ ...privateField.context, channelId: "wecom" },
		{ ...privateField.context, grantId: "other-grant" },
		{ ...privateField.context, requestDigest: "0".repeat(64) },
		{
			...privateField.context,
			operation: { ...privateField.context.operation, deliveryFence: 2 },
		},
	]) {
		expect(() =>
			validateRuntimePrivateRelayKeyFieldV1(
				{ ...privateField, context: changed },
				{ request, grantId: "grant-1", requestDigest: digest(request) },
			),
		).toThrow("RuntimeHostV4 private Key field is invalid");
	}
});

it("rejects V4 claims with the wrong issuer, worker or lifetime", () => {
	const grant = claims(request);
	for (const changed of [
		{ ...grant, issuer: "other-issuer" },
		{ ...grant, workerId: "other-worker" },
		{ ...grant, expiresAt: 31_000 },
		{ ...grant, issuedAt: 2 },
	]) {
		expect(() =>
			validateVerifiedRuntimeExecutionGrantClaimsV4(changed, {
				expectedIssuer: "platform-worker",
				expectedWorkerId: "worker-1",
				now: 1,
			}),
		).toThrow("Runtime Execution Grant V4 claims are inconsistent");
	}
});
