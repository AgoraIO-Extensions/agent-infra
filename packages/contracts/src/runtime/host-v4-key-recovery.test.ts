import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
	RuntimeNativeCapabilityRequestV4Schema,
	RuntimeSubmitTurnRequestV4Schema,
} from "./host-v4.ts";
import {
	RuntimeRestoreExecutionKeyGrantClaimsV4Schema,
	RuntimeRestoreExecutionKeyRequestV4Schema,
	RuntimeRestoreExecutionKeyTransportV4Schema,
	runtimeRestoreExecutionKeyRequestDigestV4,
	validateRuntimeRestoreExecutionKeyBindingV4,
	validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV4,
} from "./host-v4-key-recovery.ts";

const originalRequest = RuntimeSubmitTurnRequestV4Schema.parse({
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
	input: { text: "accepted input", attachments: [] },
	selection: {
		schemaVersion: 1,
		modelOptionId: "model-a",
		reasoningLevel: "high",
	},
});

const request = RuntimeRestoreExecutionKeyRequestV4Schema.parse({
	schemaVersion: 4,
	mode: "existing-accepted-only",
	acceptedHostSessionRef: "host-session-1",
	acceptedOperationDigest: "A".repeat(43),
	grant: { schemaVersion: 4, format: "runtime-execution-jws", token: "a.b.c" },
	originalRequest,
});

function claims(requestValue = request) {
	const originalRequest = requestValue.originalRequest;
	return RuntimeRestoreExecutionKeyGrantClaimsV4Schema.parse({
		schemaVersion: 4,
		issuer: "platform-worker",
		audience: "runtime_host",
		workerId: "worker-1",
		issuedAt: 100,
		expiresAt: 200,
		grantId: "recovery-grant",
		principal: originalRequest.principal,
		executionSource: originalRequest.executionSource,
		channelId: originalRequest.channelId,
		agentId: originalRequest.agentId,
		conversationId: originalRequest.conversationId,
		executionId: originalRequest.executionId,
		turnId: originalRequest.turnId,
		sessionGeneration: originalRequest.sessionGeneration,
		traceId: originalRequest.traceId,
		hostSessionRef: originalRequest.hostSessionRef,
		operation: originalRequest.operation,
		relayKeyBinding: originalRequest.keyBinding,
		requestDigest: "0".repeat(64),
		purpose: "business",
		authorizationRecordId: "authorization-1",
		allowedCommands: ["execution.key.restore"],
		attachments: [],
		mode: requestValue.mode,
		acceptedHostSessionRef: requestValue.acceptedHostSessionRef,
		acceptedOperationDigest: requestValue.acceptedOperationDigest,
	});
}

it("restores the original native Skill without a synthetic Turn input or selection", async () => {
	const { input: _input, selection: _selection, ...context } = originalRequest;
	const skill = RuntimeNativeCapabilityRequestV4Schema.parse({
		...context,
		hostSessionRef: "host-session-1",
		capabilityId: "a".repeat(64),
		capabilityKind: "skill",
		directoryRevision: "b".repeat(64),
		parameters: "original parameters",
		parametersDigest: createHash("sha256")
			.update("original parameters")
			.digest("hex"),
		capabilitySourceVersion: "source-version-1",
	});
	const value = RuntimeRestoreExecutionKeyRequestV4Schema.parse({
		...request,
		originalRequest: skill,
	});
	const signed = {
		...claims(value),
		requestDigest: await runtimeRestoreExecutionKeyRequestDigestV4(value),
	};
	await expect(
		validateRuntimeRestoreExecutionKeyBindingV4(value, signed),
	).resolves.toBeUndefined();
	for (const change of [
		{ capabilityId: "c".repeat(64) },
		{ directoryRevision: "d".repeat(64) },
		{ parameters: "changed parameters" },
		{ capabilitySourceVersion: "different-source" },
		{ principal: { kind: "user", id: "bob" } },
		{ agentId: "other-agent" },
		{ keyBinding: { ...skill.keyBinding, version: 2 } },
	]) {
		await expect(
			validateRuntimeRestoreExecutionKeyBindingV4(
				{
					...value,
					originalRequest: { ...skill, ...change },
				},
				signed,
			),
		).rejects.toThrow();
	}
	// A newly signed envelope still cannot substitute raw parameters for their digest.
	const mismatched = {
		...value,
		originalRequest: { ...skill, parameters: "changed" },
	};
	await expect(
		validateRuntimeRestoreExecutionKeyBindingV4(mismatched, {
			...signed,
			requestDigest:
				await runtimeRestoreExecutionKeyRequestDigestV4(mismatched),
		}),
	).rejects.toThrow();
	for (const original of [
		{ ...skill, capabilityKind: "command" },
		{ ...skill, input: originalRequest.input },
		{ ...skill, selection: originalRequest.selection },
		{
			...context,
			hostSessionRef: "host-session-1",
			input: originalRequest.input,
		},
	]) {
		expect(
			RuntimeRestoreExecutionKeyRequestV4Schema.safeParse({
				...request,
				originalRequest: original,
			}).success,
		).toBe(false);
	}
});

it("binds recovery intent separately from the original submit digest", async () => {
	const value = claims();
	const digest = await runtimeRestoreExecutionKeyRequestDigestV4(request);
	const bound = { ...value, requestDigest: digest };
	expect(
		validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV4(bound, {
			expectedIssuer: "platform-worker",
			expectedWorkerId: "worker-1",
			now: 150,
		}),
	).toEqual(bound);
	await expect(
		validateRuntimeRestoreExecutionKeyBindingV4(request, bound),
	).resolves.toBeUndefined();
	const transport = RuntimeRestoreExecutionKeyTransportV4Schema.safeParse({
		recoveryRequest: request,
		privateKeyField: {
			schemaVersion: 1,
			context: {
				requestId: originalRequest.requestId,
				grantId: bound.grantId,
				requestDigest: bound.requestDigest,
				traceId: originalRequest.traceId,
				principal: originalRequest.principal,
				executionSource: originalRequest.executionSource,
				channelId: originalRequest.channelId,
				agentId: originalRequest.agentId,
				conversationId: originalRequest.conversationId,
				executionId: originalRequest.executionId,
				turnId: originalRequest.turnId,
				sessionGeneration: originalRequest.sessionGeneration,
				hostSessionRef: originalRequest.hostSessionRef,
				operation: originalRequest.operation,
				keyBinding: originalRequest.keyBinding,
			},
			keyDelivery: { relayKey: "synthetic-pinned-key" },
		},
	});
	expect(transport.success).toBe(true);
});

it.each([
	"turn.submit",
	"turn.supplement",
	"session.status",
	"turn.stop",
] as const)("rejects ordinary %s capability", (command) => {
	const value = claims();
	expect(
		RuntimeRestoreExecutionKeyGrantClaimsV4Schema.safeParse({
			...value,
			allowedCommands: [command],
		}).success,
	).toBe(false);
});

it("rejects changed target, digest and original binding", async () => {
	const value = claims();
	const digest = await runtimeRestoreExecutionKeyRequestDigestV4(request);
	const signed = { ...value, requestDigest: digest };
	for (const changed of [
		{ ...request, acceptedHostSessionRef: "other-session" },
		{ ...request, acceptedOperationDigest: "B".repeat(43) },
		{
			...request,
			originalRequest: {
				...originalRequest,
				keyBinding: { ...originalRequest.keyBinding, version: 2 },
			},
		},
	]) {
		await expect(
			validateRuntimeRestoreExecutionKeyBindingV4(changed, signed),
		).rejects.toThrow();
	}
});

it("keeps the recovery envelope strict and forbids attachment capability", () => {
	expect(
		RuntimeRestoreExecutionKeyRequestV4Schema.safeParse({
			...request,
			createIfMissing: true,
		}).success,
	).toBe(false);
	const value = claims();
	expect(
		RuntimeRestoreExecutionKeyGrantClaimsV4Schema.safeParse({
			...value,
			attachments: [{ attachmentId: "file-1", operations: ["read"] }],
		}).success,
	).toBe(false);
});
