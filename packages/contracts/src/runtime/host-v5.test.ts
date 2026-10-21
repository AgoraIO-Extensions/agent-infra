import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import {
	RuntimeBusinessGrantClaimsV4Schema,
	RuntimeNativeCapabilityRequestV4Schema,
	RuntimePrivateRelayKeyFieldV1Schema,
} from "./host-v4.ts";
import {
	RuntimeNativeCapabilityRequestV5Schema,
	RuntimeNativeCapabilityTransportV5Schema,
	RuntimeReadOnlyTextAttachmentV5Schema,
	runtimeOperationDigestInputV5,
	runtimeRequestDigestV5,
	runtimeRequestSigningPayloadV5,
	validateRuntimeBusinessBindingV5,
	validateRuntimePrivateRelayKeyFieldV5,
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
	parameters: "summarize the control files",
	parametersDigest: createHash("sha256")
		.update("summarize the control files")
		.digest("hex"),
	capabilitySourceVersion: "source-version-1",
	attachments: [attachmentA, attachmentB],
});

function digest(value = native): string {
	return createHash("sha256")
		.update(runtimeRequestSigningPayloadV5(value))
		.digest("hex");
}

function claims(value = native) {
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
		hostSessionRef: value.hostSessionRef,
		executionSource: value.executionSource,
		relayKeyBinding: value.keyBinding,
		operation: value.operation,
		requestDigest: digest(value),
		purpose: "business",
		authorizationRecordId: "authorization-1",
		allowedCommands: ["native-capability.invoke"],
		attachments: value.attachments.map((entry) => ({
			attachmentId: entry.attachmentId,
			operations: ["read"] as const,
		})),
	});
}

const privateField = RuntimePrivateRelayKeyFieldV1Schema.parse({
	schemaVersion: 1,
	context: {
		requestId: native.requestId,
		grantId: "grant-1",
		requestDigest: digest(native),
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
});

it("publishes a Skill-only V5 request that V4 cannot accept", () => {
	expect(native.attachments).toEqual([attachmentA, attachmentB]);
	expect(
		RuntimeNativeCapabilityRequestV4Schema.safeParse({
			...native,
			schemaVersion: 4,
		}).success,
	).toBe(false);
	expect(
		RuntimeNativeCapabilityRequestV4Schema.safeParse({
			...native,
			schemaVersion: 4,
			attachments: undefined,
		}).success,
	).toBe(false);
	for (const change of [
		{ capabilityKind: "command" },
		{ attachments: [] },
		{
			attachments: Array.from({ length: 5 }, (_, index) => ({
				...attachmentA,
				attachmentId: `file-${index}`,
			})),
		},
		{ attachments: [attachmentA, attachmentA] },
		{ attachments: [{ ...attachmentA, mediaType: "application/json" }] },
		{ attachments: [{ ...attachmentA, byteLength: 4097 }] },
		{ attachments: [{ ...attachmentA, byteLength: -1 }] },
		{ attachments: [{ ...attachmentA, byteLength: 1.5 }] },
		{ attachments: [{ ...attachmentA, sha256: "not-a-digest" }] },
		{ attachments: [{ ...attachmentA, path: "/workspace/control.txt" }] },
		{ attachments: [{ ...attachmentA, operations: ["read"] }] },
		{ input: { text: "caller-controlled", attachments: [] } },
		{ root: "/caller-selected-workspace" },
		{ schemaVersion: 4 },
	]) {
		expect(
			RuntimeNativeCapabilityRequestV5Schema.safeParse({
				...native,
				...change,
			}).success,
		).toBe(false);
	}
	// The contract bound is the documented 4096-byte ceiling; content policy
	// (NUL, UTF-8 and FileLimits intersection) remains a Host/Core check.
	expect(
		RuntimeReadOnlyTextAttachmentV5Schema.safeParse({
			...attachmentA,
			byteLength: 0,
		}).success,
	).toBe(true);
	expect(
		RuntimeReadOnlyTextAttachmentV5Schema.safeParse({
			...attachmentA,
			byteLength: 4096,
		}).success,
	).toBe(true);
});

it("signs the normalized request and the complete ordered attachment sequence", async () => {
	const payload = runtimeRequestSigningPayloadV5(native);
	expect(payload).toContain('"attachmentId":"file-a"');
	expect(payload).toContain('"attachmentId":"file-b"');
	expect(payload).toContain(`"sha256":"${attachmentA.sha256}"`);
	expect(payload).toContain('"byteLength":34');
	expect(payload).toContain('"mediaType":"text/plain"');
	expect(payload).toContain('"ciphertextRef":"key-1"');
	expect(payload).toContain('"version":1');
	expect(payload).not.toContain("a.b.c");
	expect(payload).not.toContain("relayKey");
	expect(payload).not.toContain("private-key-value-k1");
	expect(payload).not.toContain(
		createHash("sha256").update("private-key-value-k1").digest("hex"),
	);
	expect(digest()).toBe(digest(native));
	expect(await runtimeRequestDigestV5(native)).toBe(digest(native));
	expect(native.parametersDigest).toBe(
		createHash("sha256").update(native.parameters).digest("hex"),
	);
	for (const changed of [
		{ ...native, attachments: [attachmentB, attachmentA] },
		{
			...native,
			attachments: [{ ...attachmentA, sha256: "e".repeat(64) }, attachmentB],
		},
		{
			...native,
			attachments: [{ ...attachmentA, byteLength: 13 }, attachmentB],
		},
	]) {
		expect(digest(changed)).not.toBe(digest(native));
	}
	// parametersDigest stays a digest of the original task parameters only.
	expect(digest({ ...native, parameters: "changed" })).not.toBe(digest(native));
});

it("publishes the immutable V5 operation digest input with attachments", () => {
	const input = runtimeOperationDigestInputV5(native);
	expect(input).toMatchObject({
		kind: "native-capability",
		capabilityKind: "skill",
		parametersDigest: native.parametersDigest,
		attachments: [attachmentA, attachmentB],
		operation: { kind: "execution", id: "execution-1" },
	});
	expect(input.operation).not.toHaveProperty("deliveryFence");
	expect(input.operation).not.toHaveProperty("executionDeliveryFence");
	expect(
		runtimeOperationDigestInputV5({
			...native,
			attachments: [attachmentB, attachmentA],
		}),
	).not.toEqual(input);
	expect(
		runtimeOperationDigestInputV5({
			...native,
			sessionGeneration: 2,
		}),
	).not.toEqual(input);
	expect(() =>
		runtimeOperationDigestInputV5({
			...native,
			attachments: [],
		}),
	).toThrow("RuntimeHostV5 request is invalid");
});

it("binds V4 business claims to the exact ordered attachment set", async () => {
	await expect(
		validateRuntimeBusinessBindingV5(native, claims()),
	).resolves.toBeUndefined();
	for (const changedClaims of [
		{ ...claims(), attachments: claims().attachments.slice(0, 1) },
		{
			...claims(),
			attachments: [
				...claims().attachments,
				{ attachmentId: "file-c", operations: ["read"] as const },
			],
		},
		{ ...claims(), attachments: [...claims().attachments].reverse() },
		{
			...claims(),
			attachments: [
				{ attachmentId: "file-a", operations: ["write"] },
				{ attachmentId: "file-b", operations: ["read"] },
			],
		},
		{
			...claims(),
			attachments: [
				{ attachmentId: "file-a", operations: ["read"] as const },
				{ attachmentId: "file-a", operations: ["read"] as const },
			],
		},
		{ ...claims(), requestDigest: "0".repeat(64) },
		{ ...claims(), allowedCommands: ["turn.submit"] },
		{ ...claims(), principal: { kind: "user", id: "bob" } },
		{ ...claims(), channelId: "wecom" },
		{ ...claims(), agentId: "agent-2" },
		{ ...claims(), conversationId: "conversation-2" },
		{ ...claims(), executionId: "execution-2" },
		{ ...claims(), turnId: "turn-2" },
		{ ...claims(), sessionGeneration: 2 },
		{ ...claims(), hostSessionRef: "session-2" },
		{ ...claims(), traceId: "trace-2" },
		{ ...claims(), executionSource: "platform-api" },
		{ ...claims(), relayKeyBinding: { ...native.keyBinding, version: 2 } },
		{
			...claims(),
			operation: { ...native.operation, deliveryFence: 3 },
		},
	]) {
		await expect(
			validateRuntimeBusinessBindingV5(native, changedClaims),
		).rejects.toThrow("RuntimeHostV5 binding is invalid");
	}
	for (const changedRequest of [
		{ ...native, parametersDigest: "0".repeat(64) },
		{ ...native, capabilityId: "e".repeat(64) },
		{ ...native, directoryRevision: "f".repeat(64) },
		{ ...native, capabilitySourceVersion: "source-version-2" },
		{ ...native, operation: { ...native.operation, kind: "message" } },
		{
			...native,
			operation: { ...native.operation, deliveryFence: 3 },
		},
		{ ...native, keyBinding: { ...native.keyBinding, version: 2 } },
	]) {
		await expect(
			validateRuntimeBusinessBindingV5(changedRequest, claims()),
		).rejects.toThrow("RuntimeHostV5 binding is invalid");
	}
});

it("requires an independent private Key field for the V5 transport", () => {
	const transport = RuntimeNativeCapabilityTransportV5Schema.parse({
		businessRequest: native,
		privateKeyField: privateField,
	});
	expect(transport.businessRequest).toEqual(native);
	expect(
		RuntimeNativeCapabilityTransportV5Schema.safeParse({
			businessRequest: native,
		}).success,
	).toBe(false);
	expect(
		RuntimeNativeCapabilityTransportV5Schema.safeParse({
			businessRequest: { ...native, privateKeyField: privateField },
			privateKeyField: privateField,
		}).success,
	).toBe(false);
	expect(
		validateRuntimePrivateRelayKeyFieldV5(privateField, {
			request: native,
			grantId: "grant-1",
			requestDigest: digest(native),
		}),
	).toEqual(privateField);
	for (const changed of [
		{ ...privateField.context, executionId: "execution-2" },
		{ ...privateField.context, hostSessionRef: "session-2" },
		{ ...privateField.context, grantId: "other-grant" },
		{ ...privateField.context, requestDigest: "0".repeat(64) },
		{
			...privateField.context,
			operation: { ...privateField.context.operation, deliveryFence: 3 },
		},
		{
			...privateField.context,
			keyBinding: { ...privateField.context.keyBinding, version: 2 },
		},
	]) {
		expect(() =>
			validateRuntimePrivateRelayKeyFieldV5(
				{ ...privateField, context: changed },
				{ request: native, grantId: "grant-1", requestDigest: digest(native) },
			),
		).toThrow("RuntimeHostV5 private Key field is invalid");
	}
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
});
