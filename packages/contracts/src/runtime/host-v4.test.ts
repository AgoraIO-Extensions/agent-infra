import { createHash } from "node:crypto";

import { expect, it } from "vitest";
import { RuntimeBusinessGrantClaimsV2Schema } from "./grant-v2.js";
import {
	type RuntimeSubmitTurnRequestV4,
	RuntimeSubmitTurnRequestV4Schema,
	type RuntimeSupplementRequestV4,
	RuntimeSupplementRequestV4Schema,
	runtimeRequestSigningPayloadV4,
	validateRuntimeBusinessBindingV4,
} from "./host-v4.js";

type BusinessRequest = RuntimeSubmitTurnRequestV4 | RuntimeSupplementRequestV4;

const request = RuntimeSubmitTurnRequestV4Schema.parse({
	schemaVersion: 4,
	requestId: "request-1",
	traceId: "trace-1",
	principal: { kind: "user", id: "alice" },
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
	grant: { schemaVersion: 2, format: "runtime-execution-jws", token: "a.b.c" },
	keyBinding: {
		purpose: "personal",
		subjectId: "alice",
		ciphertextRef: "key-1",
		version: 1,
	},
	keyDelivery: { relayKey: "private-key-value-k1" },
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
	return RuntimeBusinessGrantClaimsV2Schema.parse({
		schemaVersion: 2,
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
		hostSessionRef: value.hostSessionRef,
		operation: value.operation,
		requestDigest: digest(value),
		purpose: "business",
		authorizationRecordId: "authorization-1",
		allowedCommands: ["selection" in value ? "turn.submit" : "turn.supplement"],
		attachments: [],
	});
}

it("binds the Key reference/version into the Grant digest without the Key", () => {
	const payload = runtimeRequestSigningPayloadV4(request);
	expect(payload).toContain('"ciphertextRef":"key-1"');
	expect(payload).toContain('"version":1');
	expect(payload).not.toContain("private-key-value-k1");
	expect(payload).not.toContain("keyDelivery");
	expect(() =>
		validateRuntimeBusinessBindingV4(request, claims(request), digest(request)),
	).not.toThrow();
	expect(
		digest({
			...request,
			keyBinding: { ...request.keyBinding, version: 2 },
		}),
	).not.toBe(digest(request));
});

it("rejects substituted subject, channel, operation fence and stale Grant digest", () => {
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
		expect(() =>
			validateRuntimeBusinessBindingV4(changed, grant, digest(changed)),
		).toThrow("RuntimeHostV4 binding is invalid");
	}
	expect(() =>
		validateRuntimeBusinessBindingV4(request, grant, "0".repeat(64)),
	).toThrow("RuntimeHostV4 binding is invalid");
});

it("accepts an Agent default Key for an API principal and rejects cross-Agent reuse", () => {
	const apiRequest = RuntimeSubmitTurnRequestV4Schema.parse({
		...request,
		principal: { kind: "application", id: "api-client" },
		channelId: "platform-api",
		keyBinding: {
			purpose: "agent-default",
			subjectId: "agent-1",
			ciphertextRef: "agent-key-1",
			version: 2,
		},
	});
	expect(() =>
		validateRuntimeBusinessBindingV4(
			apiRequest,
			claims(apiRequest),
			digest(apiRequest),
		),
	).not.toThrow();
	expect(() =>
		validateRuntimeBusinessBindingV4(
			{
				...apiRequest,
				keyBinding: { ...apiRequest.keyBinding, subjectId: "agent-2" },
			},
			claims(apiRequest),
			digest(apiRequest),
		),
	).toThrow("RuntimeHostV4 binding is invalid");
	expect(() =>
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
			digest(apiRequest),
		),
	).toThrow("RuntimeHostV4 binding is invalid");
});

it("keeps the original Key binding for a supplement after Key replacement", () => {
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
	expect(() =>
		validateRuntimeBusinessBindingV4(
			supplement,
			claims(supplement),
			digest(supplement),
		),
	).not.toThrow();
	const changed = {
		...supplement,
		keyBinding: { ...supplement.keyBinding, version: 2 },
	};
	expect(() =>
		validateRuntimeBusinessBindingV4(
			changed,
			claims(supplement),
			digest(changed),
		),
	).toThrow("RuntimeHostV4 binding is invalid");
});

it("rejects static credential fallback and an unprintable private Key", () => {
	expect(
		RuntimeSubmitTurnRequestV4Schema.safeParse({
			...request,
			keyDelivery: undefined,
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
			keyDelivery: { relayKey: "private-key-value-k1\n" },
		}).success,
	).toBe(false);
});
