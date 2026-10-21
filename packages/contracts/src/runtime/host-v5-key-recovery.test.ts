import { createHash } from "node:crypto";

import { expect, it } from "vitest";
import { RuntimeNativeCapabilityRequestV4Schema } from "./host-v4.ts";
import { RuntimeRestoreExecutionKeyRequestV4Schema } from "./host-v4-key-recovery.ts";
import {
	RuntimeNativeCapabilityRequestV5Schema,
	RuntimeRestoreExecutionKeyGrantClaimsV5Schema,
	RuntimeRestoreExecutionKeyRequestV5Schema,
	RuntimeRestoreExecutionKeyTransportV5Schema,
	runtimeRequestDigestV5,
	runtimeRequestSigningPayloadV5,
	runtimeRestoreExecutionKeyRequestDigestV5,
	runtimeRestoreExecutionKeySigningPayloadV5,
	validateRuntimeRestoreExecutionKeyBindingV5,
	validateRuntimeRestoreExecutionKeyPrivateFieldV5,
	validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV5,
} from "./host-v5.ts";

const attachmentA = {
	attachmentId: "file-a",
	sha256: "a".repeat(64),
	byteLength: 12,
	mediaType: "text/plain",
} as const;
const attachmentB = {
	attachmentId: "file-b",
	sha256: "b".repeat(64),
	byteLength: 34,
	mediaType: "text/plain",
} as const;

const native = RuntimeNativeCapabilityRequestV5Schema.parse({
	schemaVersion: 5,
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
	hostSessionRef: "session-1",
	operation: {
		kind: "execution",
		id: "execution-1",
		deliveryFence: 2,
		executionDeliveryFence: 2,
	},
	grant: { schemaVersion: 4, format: "runtime-execution-jws", token: "a.b.c" },
	keyBinding: {
		purpose: "personal",
		subjectId: "alice",
		ciphertextRef: "key-1",
		version: 1,
	},
	capabilityKind: "skill",
	capabilityId: "c".repeat(64),
	directoryRevision: "d".repeat(64),
	parameters: "restore the original control files",
	parametersDigest: createHash("sha256")
		.update("restore the original control files")
		.digest("hex"),
	capabilitySourceVersion: "source-version-1",
	attachments: [attachmentA, attachmentB],
});

const request = RuntimeRestoreExecutionKeyRequestV5Schema.parse({
	schemaVersion: 5,
	mode: "existing-accepted-only",
	acceptedHostSessionRef: "session-1",
	acceptedOperationDigest: "A".repeat(43),
	acceptedAttachmentIds: ["file-a", "file-b"],
	grant: { schemaVersion: 5, format: "runtime-execution-jws", token: "a.b.c" },
	originalRequest: native,
});

function claims(value = request) {
	const original = value.originalRequest;
	return RuntimeRestoreExecutionKeyGrantClaimsV5Schema.parse({
		schemaVersion: 5,
		issuer: "platform-worker",
		audience: "runtime_host",
		workerId: "worker-1",
		issuedAt: 100,
		expiresAt: 200,
		grantId: "recovery-grant",
		principal: original.principal,
		executionSource: original.executionSource,
		channelId: original.channelId,
		agentId: original.agentId,
		conversationId: original.conversationId,
		executionId: original.executionId,
		turnId: original.turnId,
		sessionGeneration: original.sessionGeneration,
		traceId: original.traceId,
		hostSessionRef: original.hostSessionRef,
		operation: original.operation,
		relayKeyBinding: original.keyBinding,
		requestDigest: "0".repeat(64),
		purpose: "business",
		authorizationRecordId: "authorization-1",
		allowedCommands: ["execution.key.restore"],
		attachments: [],
		mode: value.mode,
		acceptedHostSessionRef: value.acceptedHostSessionRef,
		acceptedOperationDigest: value.acceptedOperationDigest,
		acceptedAttachmentIds: value.acceptedAttachmentIds,
	});
}

async function signedClaims(value = request) {
	return {
		...claims(value),
		requestDigest: await runtimeRestoreExecutionKeyRequestDigestV5(value),
	};
}

it("restores only an already accepted Native V5 Skill request", async () => {
	const {
		schemaVersion: _schemaVersion,
		attachments: _attachments,
		...v4Context
	} = native;
	const v4Native = RuntimeNativeCapabilityRequestV4Schema.parse({
		...v4Context,
		schemaVersion: 4,
		capabilityKind: "skill",
	});
	expect(v4Native.hostSessionRef).toBe("session-1");
	expect(
		RuntimeRestoreExecutionKeyRequestV5Schema.safeParse({
			...request,
			originalRequest: v4Native,
		}).success,
	).toBe(false);
	expect(
		RuntimeRestoreExecutionKeyRequestV5Schema.safeParse({
			...request,
			originalRequest: { ...native, capabilityKind: "command" },
		}).success,
	).toBe(false);
	expect(
		RuntimeRestoreExecutionKeyRequestV5Schema.safeParse({
			...request,
			originalRequest: { ...native, attachments: [] },
		}).success,
	).toBe(false);
	expect(
		RuntimeRestoreExecutionKeyRequestV5Schema.safeParse({
			...request,
			acceptedAttachmentIds: [],
		}).success,
	).toBe(false);
	expect(
		RuntimeRestoreExecutionKeyRequestV5Schema.safeParse({
			...request,
			acceptedAttachmentIds: ["file-a"],
		}).success,
	).toBe(true);
	expect(
		RuntimeRestoreExecutionKeyRequestV5Schema.safeParse({
			...request,
			mode: "create-if-missing",
		}).success,
	).toBe(false);
	expect(
		RuntimeRestoreExecutionKeyRequestV5Schema.safeParse({
			...request,
			schemaVersion: 4,
		}).success,
	).toBe(false);
	// Restore V4 keeps its original Submit/Native V4 envelope exact.
	expect(
		RuntimeRestoreExecutionKeyRequestV4Schema.safeParse({
			schemaVersion: 4,
			mode: request.mode,
			acceptedHostSessionRef: request.acceptedHostSessionRef,
			acceptedOperationDigest: request.acceptedOperationDigest,
			grant: {
				schemaVersion: 4,
				format: "runtime-execution-jws",
				token: "a.b.c",
			},
			originalRequest: native,
		}).success,
	).toBe(false);
});

it("binds the recovery intent to the original digest, attachments and Key version", async () => {
	const signed = await signedClaims();
	expect(
		validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV5(signed, {
			expectedIssuer: "platform-worker",
			expectedWorkerId: "worker-1",
			now: 150,
		}),
	).toEqual(signed);
	await expect(
		validateRuntimeRestoreExecutionKeyBindingV5(request, signed),
	).resolves.toBeUndefined();
	for (const changed of [
		{ ...request, acceptedHostSessionRef: "session-2" },
		{ ...request, acceptedOperationDigest: "B".repeat(43) },
		{ ...request, acceptedAttachmentIds: ["file-b", "file-a"] },
		{ ...request, acceptedAttachmentIds: ["file-a"] },
	]) {
		await expect(
			validateRuntimeRestoreExecutionKeyBindingV5(changed, signed),
		).rejects.toThrow("RuntimeHostV5 Key recovery binding is invalid");
	}
	// A recovery Grant only restores the private Key context.
	expect(
		RuntimeRestoreExecutionKeyGrantClaimsV5Schema.safeParse({
			...claims(),
			attachments: [{ attachmentId: "file-a", operations: ["read"] }],
		}).success,
	).toBe(false);
	for (const command of ["turn.submit", "native-capability.invoke"] as const) {
		expect(
			RuntimeRestoreExecutionKeyGrantClaimsV5Schema.safeParse({
				...claims(),
				allowedCommands: [command],
			}).success,
		).toBe(false);
	}
	// A stale recovery signature cannot be reused for a changed original request.
	for (const changed of [
		{
			...request,
			originalRequest: {
				...native,
				attachments: [{ ...attachmentA, sha256: "e".repeat(64) }],
			},
		},
		{
			...request,
			originalRequest: { ...native, capabilityId: "e".repeat(64) },
		},
		{
			...request,
			originalRequest: {
				...native,
				keyBinding: { ...native.keyBinding, version: 2 },
			},
		},
		{
			...request,
			originalRequest: { ...native, sessionGeneration: 2 },
		},
	]) {
		await expect(
			validateRuntimeRestoreExecutionKeyBindingV5(changed, signed),
		).rejects.toThrow();
	}
	for (const changedClaims of [
		{ ...signed, issuer: "other-issuer" },
		{ ...signed, workerId: "other-worker" },
		{ ...signed, expiresAt: 31_000 },
		{ ...signed, issuedAt: 200 },
	]) {
		expect(() =>
			validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV5(changedClaims, {
				expectedIssuer: "platform-worker",
				expectedWorkerId: "worker-1",
				now: 150,
			}),
		).toThrow();
	}
});

it("keeps the recovery digest separate from the original business digest", async () => {
	const signed = await signedClaims();
	const recoveryDigest =
		await runtimeRestoreExecutionKeyRequestDigestV5(request);
	expect(signed.requestDigest).toBe(recoveryDigest);
	expect(recoveryDigest).not.toBe(await runtimeRequestDigestV5(native));
	const payload = runtimeRequestSigningPayloadV5(native);
	expect(payload).not.toContain("a.b.c");
	const recoveryPayload = JSON.stringify(
		runtimeRestoreExecutionKeySigningPayloadV5(request),
	);
	expect(recoveryPayload).toContain("file-a");
	expect(recoveryPayload).toContain("file-b");
	expect(recoveryPayload).not.toContain("a.b.c");
	expect(recoveryPayload).not.toContain("private-key-value-k1");
	const privateField = {
		schemaVersion: 1 as const,
		context: {
			requestId: native.requestId,
			grantId: signed.grantId,
			requestDigest: signed.requestDigest,
			traceId: native.traceId,
			principal: native.principal,
			executionSource: native.executionSource,
			channelId: native.channelId,
			agentId: native.agentId,
			conversationId: native.conversationId,
			executionId: native.executionId,
			turnId: native.turnId,
			sessionGeneration: native.sessionGeneration,
			hostSessionRef: native.hostSessionRef,
			operation: native.operation,
			keyBinding: native.keyBinding,
		},
		keyDelivery: { relayKey: "private-key-value-k1" },
	};
	const transport = RuntimeRestoreExecutionKeyTransportV5Schema.parse({
		recoveryRequest: request,
		privateKeyField: privateField,
	});
	expect(
		validateRuntimeRestoreExecutionKeyPrivateFieldV5(
			transport.privateKeyField,
			{ request, claims: signed },
		),
	).toEqual(transport.privateKeyField);
	for (const changed of [
		{
			...privateField.context,
			requestDigest: await runtimeRequestDigestV5(native),
		},
		{ ...privateField.context, grantId: "other-grant" },
		{ ...privateField.context, executionId: "execution-2" },
		{
			...privateField.context,
			keyBinding: { ...native.keyBinding, version: 2 },
		},
	]) {
		expect(() =>
			validateRuntimeRestoreExecutionKeyPrivateFieldV5(
				{ ...privateField, context: changed },
				{ request, claims: signed },
			),
		).toThrow("RuntimeHostV5 private Key field is invalid");
	}
});
