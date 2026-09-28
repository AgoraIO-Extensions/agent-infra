import { expect, it } from "vitest";

import {
	RuntimeExecutionGrantClaimsV2Schema,
	VerifiedRuntimeExecutionGrantV2Schema,
} from "./grant-v2.ts";
import {
	RuntimeEventAckRequestV4Schema,
	RuntimeEventReadRequestV4Schema,
	RuntimeReplayResponseV1Schema,
	runtimeEventRequestDigestV4,
	validateRuntimeEventAccessV4,
	validateRuntimeLiveEventV4,
	validateRuntimeReplayResponseV4,
} from "./index.ts";

const pinned = {
	principal: { kind: "user" as const, id: "alice" },
	executionSource: "web" as const,
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 1,
	hostSessionRef: null,
	keyBinding: {
		purpose: "personal" as const,
		subjectId: "alice",
		ciphertextRef: "key-1",
		version: 1,
	},
};

const readRequest = RuntimeEventReadRequestV4Schema.parse({
	...pinned,
	schemaVersion: 4,
	requestId: "request-read-1",
	traceId: "trace-1",
	hostSessionRef: "session-1",
	operation: {
		kind: "execution",
		id: "execution-1",
		deliveryFence: 2,
		executionDeliveryFence: 2,
	},
	grant: { schemaVersion: 2, format: "runtime-execution-jws", token: "a.b.c" },
	consumer: "platform_worker_persistence",
	afterCursor: null,
});

const grantContext = {
	expectedIssuer: "platform-worker",
	expectedWorkerId: "worker-1",
	now: 1,
	trustedOperation: readRequest.operation,
};

async function claims(
	request:
		| typeof readRequest
		| ReturnType<typeof RuntimeEventAckRequestV4Schema.parse>,
	purpose: "business" | "control" = "control",
) {
	const read = "afterCursor" in request;
	return RuntimeExecutionGrantClaimsV2Schema.parse({
		schemaVersion: 2,
		issuer: "platform-worker",
		audience: "runtime_host",
		issuedAt: 1,
		expiresAt: 2,
		grantId: "grant-1",
		workerId: "worker-1",
		principal: request.principal,
		agentId: request.agentId,
		channelId: request.channelId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		traceId: request.traceId,
		hostSessionRef: request.hostSessionRef,
		operation: request.operation,
		requestDigest: await runtimeEventRequestDigestV4(request),
		...(purpose === "control"
			? { purpose, controlRecordId: "control-1", reason: "recovery" }
			: { purpose, authorizationRecordId: "authorization-1", attachments: [] }),
		allowedCommands: [read ? "events.persist" : "events.ack"],
		eventAccess: read
			? {
					command: "events.persist",
					consumer: request.consumer,
					afterCursor: request.afterCursor,
				}
			: {
					command: "events.ack",
					consumer: request.consumer,
					confirmedCursor: request.confirmedCursor,
				},
	});
}

async function verified(
	request:
		| typeof readRequest
		| ReturnType<typeof RuntimeEventAckRequestV4Schema.parse>,
	purpose: "business" | "control" = "control",
) {
	return VerifiedRuntimeExecutionGrantV2Schema.parse({
		token: request.grant.token,
		claims: await claims(request, purpose),
	});
}

const textEvent = {
	schemaVersion: 1,
	adapterEventKey: "event-text-1",
	executionId: "execution-1",
	cursor: "cursor-1",
	occurredAt: "2026-09-28T00:00:00.000Z",
	type: "text",
	payload: { delta: "hello" },
};

const operationEvent = {
	schemaVersion: 2,
	adapterEventKey: "event-operation-1",
	executionId: "execution-1",
	cursor: "cursor-2",
	occurredAt: "2026-09-28T00:00:01.000Z",
	type: "operation",
	payload: {
		kind: "model",
		operationRef: "model-operation-1",
		attemptRef: "attempt-1",
		phase: "completed",
		model: {
			configVersion: "configuration-1",
			modelOptionId: "model-option-1",
			modelId: "model-1",
		},
		usage: { inputTokens: 2, outputTokens: 3 },
	},
};

it("binds V4 event read and ACK digests to source and Key without signing the Grant", async () => {
	const { afterCursor: _afterCursor, ...readContext } = readRequest;
	const ackRequest = RuntimeEventAckRequestV4Schema.parse({
		...readContext,
		requestId: "request-ack-1",
		confirmedCursor: "cursor-2",
	});
	for (const request of [readRequest, ackRequest]) {
		const digest = await runtimeEventRequestDigestV4(request);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(
			await runtimeEventRequestDigestV4({
				...request,
				grant: { ...request.grant, token: "d.e.f" },
			}),
		).toBe(digest);
		expect(
			await runtimeEventRequestDigestV4({
				...request,
				executionSource: "wecom",
			}),
		).not.toBe(digest);
		expect(
			await runtimeEventRequestDigestV4({
				...request,
				keyBinding: { ...request.keyBinding, version: 2 },
			}),
		).not.toBe(digest);
	}
});

it("binds V4 event read and ACK to the original Keyed Execution and scoped V2 Grant", async () => {
	const readVerification = await verified(readRequest);
	await expect(
		validateRuntimeEventAccessV4(
			readRequest,
			readVerification,
			pinned,
			"session-1",
			grantContext,
		),
	).resolves.toEqual(readRequest);
	const { afterCursor: _afterCursor, ...readContext } = readRequest;
	const ackRequest = RuntimeEventAckRequestV4Schema.parse({
		...readContext,
		requestId: "request-ack-1",
		confirmedCursor: "cursor-2",
	});
	await expect(
		validateRuntimeEventAccessV4(
			ackRequest,
			await verified(ackRequest),
			pinned,
			"session-1",
			grantContext,
		),
	).resolves.toEqual(ackRequest);
	expect(JSON.stringify(readRequest)).not.toContain("privateKeyField");
	expect(JSON.stringify(readRequest)).not.toContain("relayKey");
	await expect(
		validateRuntimeEventAccessV4(
			readRequest,
			await verified(readRequest, "business"),
			pinned,
			"session-1",
			grantContext,
		),
	).resolves.toEqual(readRequest);
});

it("rejects matching-claims cross-scope Key, identity and fence substitutions", async () => {
	for (const changed of [
		{ principal: { kind: "user", id: "bob" } },
		{ executionSource: "wecom" },
		{ channelId: "wecom" },
		{ agentId: "agent-2" },
		{ conversationId: "conversation-2" },
		{ executionId: "execution-2" },
		{ turnId: "turn-2" },
		{ sessionGeneration: 2 },
		{ hostSessionRef: "session-2" },
		{ keyBinding: { ...readRequest.keyBinding, subjectId: "bob" } },
		{ keyBinding: { ...readRequest.keyBinding, ciphertextRef: "key-2" } },
		{ keyBinding: { ...readRequest.keyBinding, version: 2 } },
		{
			operation: {
				...readRequest.operation,
				deliveryFence: 3,
				executionDeliveryFence: 3,
			},
		},
	]) {
		const substituted = RuntimeEventReadRequestV4Schema.parse({
			...readRequest,
			...changed,
		});
		await expect(
			validateRuntimeEventAccessV4(
				substituted,
				await verified(substituted),
				pinned,
				"session-1",
				grantContext,
			),
		).rejects.toThrow("RuntimeHostV4 event access is invalid");
	}
});

it("rejects stale cursor, mismatched verified claims, wrong Host Session and private Key injection", async () => {
	const originalVerification = await verified(readRequest);
	for (const changed of [
		{ ...readRequest, afterCursor: "cursor-other" },
		{
			...readRequest,
			operation: {
				...readRequest.operation,
				deliveryFence: 3,
				executionDeliveryFence: 3,
			},
		},
		{ ...readRequest, keyBinding: { ...readRequest.keyBinding, version: 2 } },
		{
			...readRequest,
			privateKeyField: { relayKey: "must-not-enter-event-request" },
		},
	]) {
		await expect(
			validateRuntimeEventAccessV4(
				changed,
				originalVerification,
				pinned,
				"session-1",
				grantContext,
			),
		).rejects.toThrow("RuntimeHostV4 event access is invalid");
	}
	for (const changed of [
		{
			...originalVerification,
			claims: {
				...originalVerification.claims,
				requestDigest: "0".repeat(64),
			},
		},
		{
			...originalVerification,
			claims: {
				...originalVerification.claims,
				eventAccess: {
					...originalVerification.claims.eventAccess,
					afterCursor: "cursor-other",
				},
			},
		},
		{
			...originalVerification,
			claims: { ...originalVerification.claims, workerId: "other-worker" },
		},
		{ ...originalVerification, token: "d.e.f" },
	]) {
		await expect(
			validateRuntimeEventAccessV4(
				readRequest,
				changed,
				pinned,
				"session-1",
				grantContext,
			),
		).rejects.toThrow("RuntimeHostV4 event access is invalid");
	}
	await expect(
		validateRuntimeEventAccessV4(
			readRequest,
			originalVerification,
			pinned,
			"different-session",
			grantContext,
		),
	).rejects.toThrow("RuntimeHostV4 event access is invalid");
});

it("preserves V1 and V2 operation facts in live and replay without widening V1", () => {
	expect(validateRuntimeLiveEventV4(textEvent, "execution-1")).toEqual(
		textEvent,
	);
	expect(validateRuntimeLiveEventV4(operationEvent, "execution-1")).toEqual(
		operationEvent,
	);
	const replay = {
		schemaVersion: 4,
		hostSessionRef: "session-1",
		executionId: "execution-1",
		events: [textEvent, operationEvent],
	};
	expect(validateRuntimeReplayResponseV4(replay, readRequest)).toEqual(replay);
	expect(
		RuntimeReplayResponseV1Schema.safeParse({
			schemaVersion: 1,
			events: [textEvent, operationEvent],
		}).success,
	).toBe(false);
	expect(() =>
		validateRuntimeLiveEventV4(
			{ ...operationEvent, executionId: "execution-2" },
			"execution-1",
		),
	).toThrow("RuntimeHostV4 event is invalid");
	expect(() =>
		validateRuntimeLiveEventV4(
			{
				...operationEvent,
				payload: { ...operationEvent.payload, relayKey: "secret" },
			},
			"execution-1",
		),
	).toThrow("RuntimeHostV4 event is invalid");
	for (const changed of [
		{ ...replay, hostSessionRef: "other-session" },
		{ ...replay, executionId: "execution-2" },
		{
			...replay,
			events: [textEvent, { ...operationEvent, executionId: "execution-2" }],
		},
	]) {
		expect(() => validateRuntimeReplayResponseV4(changed, readRequest)).toThrow(
			"RuntimeHostV4 replay is invalid",
		);
	}
});
