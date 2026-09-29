import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	RuntimeBusinessGrantClaimsV4Schema,
	type RuntimeBusinessRequestV4,
	RuntimeEventAckRequestV4Schema,
	RuntimeEventReadRequestV4Schema,
	RuntimeExecutionGrantClaimsV2Schema,
	RuntimeSubmitTurnRequestV4Schema,
	runtimeEventRequestDigestV4,
	runtimeRequestSigningPayloadV4,
	VerifiedRuntimeExecutionGrantV2Schema,
	validateRuntimeBusinessBindingV4,
} from "@agent-infra/contracts/runtime";
import { afterEach, expect, it } from "vitest";

import { FakeRuntimeDriver } from "./fake-runtime-driver.js";
import { FileRuntimeStore } from "./file-runtime-store.js";
import { RuntimeHost } from "./runtime-host.js";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((path) => rm(path, { recursive: true })),
	);
});

function fixture() {
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
		grant: {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: "a.b.c",
		},
		keyBinding: {
			purpose: "personal",
			subjectId: "alice",
			ciphertextRef: "key-1",
			version: 1,
		},
		input: { text: "hello", attachments: [] },
		selection: {
			schemaVersion: 1,
			modelOptionId: "model-option-primary",
			reasoningLevel: "high",
		},
	});
	const now = Date.now();
	const claims = RuntimeBusinessGrantClaimsV4Schema.parse({
		schemaVersion: 4,
		issuer: "platform-worker",
		audience: "runtime_host",
		issuedAt: now - 1_000,
		expiresAt: now + 29_000,
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
		executionSource: request.executionSource,
		relayKeyBinding: request.keyBinding,
		hostSessionRef: request.hostSessionRef,
		operation: request.operation,
		requestDigest: createHash("sha256")
			.update(runtimeRequestSigningPayloadV4(request))
			.digest("hex"),
		purpose: "business",
		authorizationRecordId: "authorization-1",
		allowedCommands: ["turn.submit"],
		attachments: [],
	});
	const privateKeyField = {
		schemaVersion: 1 as const,
		context: {
			requestId: request.requestId,
			grantId: claims.grantId,
			requestDigest: claims.requestDigest,
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
		keyDelivery: { relayKey: "synthetic-relay-key-k1" },
	};
	return {
		request,
		claims,
		transport: { businessRequest: request, privateKeyField },
	};
}

async function eventVerification(
	request:
		| ReturnType<typeof RuntimeEventReadRequestV4Schema.parse>
		| ReturnType<typeof RuntimeEventAckRequestV4Schema.parse>,
) {
	const read = "afterCursor" in request;
	const claims = RuntimeExecutionGrantClaimsV2Schema.parse({
		schemaVersion: 2,
		issuer: "platform-worker",
		audience: "runtime_host",
		issuedAt: Date.now() - 1_000,
		expiresAt: Date.now() + 29_000,
		grantId: `event-${request.requestId}`,
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
		purpose: "business",
		authorizationRecordId: "authorization-1",
		allowedCommands: [read ? "events.persist" : "events.ack"],
		attachments: [],
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
	return VerifiedRuntimeExecutionGrantV2Schema.parse({
		token: request.grant.token,
		claims,
	});
}

it("reinstalls the pinned Key on a running submit replay after Host restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-host-v4-"));
	directories.push(directory);
	const store = await FileRuntimeStore.open(join(directory, "host.json"));
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const { request, claims, transport } = fixture();
	const grants = new Map([[request.operation.id, claims]]);
	const options = {
		store,
		driver,
		grantValidation: { expectedIssuer: "agent-platform" },
		grantValidationV2: {
			expectedIssuer: "platform-worker",
			expectedWorkerId: "worker-1",
		},
		allowLegacyBusiness: false,
		validateGrantV4: async (value: unknown) => {
			const parsed = value as RuntimeBusinessRequestV4;
			const current = grants.get(parsed.operation.id);
			if (!current) throw new Error("Unknown test Grant");
			await validateRuntimeBusinessBindingV4(parsed, current);
			return { request: parsed, claims: current };
		},
	};
	const host = await RuntimeHost.open(options);
	expect(() => host.submitTurnV3({} as never, undefined)).toThrowError(
		"Runtime authorization is unavailable",
	);
	await expect(host.submitTurn({} as never, undefined)).rejects.toMatchObject({
		code: "RUNTIME_GRANT_INVALID",
	});
	const accepted = await host.submitTurnV4(transport);
	expect(accepted).toMatchObject({
		schemaVersion: 4,
		operationId: request.executionId,
		result: { outcome: "accepted", status: "running" },
	});
	expect(store.readOriginalExecutionKeyScopeV4(request)?.scope).toMatchObject({
		keyBinding: request.keyBinding,
	});
	expect(
		Object.keys(
			store.readOriginalExecutionKeyScopeV4(request)?.scope ?? {},
		).sort(),
	).toEqual([
		"agentId",
		"channelId",
		"conversationId",
		"executionId",
		"executionSource",
		"hostSessionRef",
		"keyBinding",
		"principal",
		"sessionGeneration",
		"turnId",
	]);
	const action = {
		nativeSessionRef: store.nativeSessionRef(accepted.hostSessionRef) as string,
		executionId: request.executionId,
		runtimeOperationId: request.executionId,
		operationRef: "model-fact-1",
		attemptRef: "attempt-1",
		kind: "model" as const,
	};
	await expect(host.authorizeExternalAction(action)).resolves.toEqual({
		relayKey: "synthetic-relay-key-k1",
	});
	await host.close();
	const reopened = await RuntimeHost.open(options);
	await expect(reopened.authorizeExternalAction(action)).rejects.toMatchObject({
		code: "RUNTIME_GRANT_INVALID",
	});
	await expect(
		reopened.submitTurnV4({
			...transport,
			privateKeyField: {
				...transport.privateKeyField,
				context: {
					...transport.privateKeyField.context,
					executionId: "other-execution",
				},
			},
		}),
	).rejects.toThrow("RuntimeHostV4 private Key field is invalid");
	await expect(reopened.authorizeExternalAction(action)).rejects.toMatchObject({
		code: "RUNTIME_GRANT_INVALID",
	});
	await expect(reopened.submitTurnV4(transport)).resolves.toEqual(accepted);
	expect(await driver.sideEffectCount()).toBe(1);
	await expect(reopened.authorizeExternalAction(action)).resolves.toEqual({
		relayKey: "synthetic-relay-key-k1",
	});
	const supplement = {
		...request,
		requestId: "request-2",
		hostSessionRef: accepted.hostSessionRef,
		operation: {
			kind: "message" as const,
			id: "message-1",
			deliveryFence: 2,
			executionDeliveryFence: 1,
		},
	};
	const { selection: _selection, ...supplementRequest } = supplement;
	const supplementClaims = RuntimeBusinessGrantClaimsV4Schema.parse({
		...claims,
		grantId: "grant-2",
		hostSessionRef: accepted.hostSessionRef,
		operation: supplementRequest.operation,
		allowedCommands: ["turn.supplement"],
		requestDigest: createHash("sha256")
			.update(runtimeRequestSigningPayloadV4(supplementRequest))
			.digest("hex"),
	});
	grants.set(supplementRequest.operation.id, supplementClaims);
	const privateKeyField = {
		...transport.privateKeyField,
		context: {
			...transport.privateKeyField.context,
			requestId: supplementRequest.requestId,
			grantId: supplementClaims.grantId,
			requestDigest: supplementClaims.requestDigest,
			hostSessionRef: accepted.hostSessionRef,
			operation: supplementRequest.operation,
		},
	};
	await expect(
		reopened.supplementV4({
			businessRequest: supplementRequest,
			privateKeyField: {
				...privateKeyField,
				context: { ...privateKeyField.context, executionId: "other-execution" },
			},
		}),
	).rejects.toThrow("RuntimeHostV4 private Key field is invalid");
	await expect(reopened.authorizeExternalAction(action)).resolves.toEqual({
		relayKey: "synthetic-relay-key-k1",
	});
	await expect(
		reopened.supplementV4({
			businessRequest: supplementRequest,
			privateKeyField,
		}),
	).resolves.toMatchObject({
		schemaVersion: 4,
		operationId: "message-1",
		result: { outcome: "accepted" },
	});
	await expect(reopened.authorizeExternalAction(action)).resolves.toEqual({
		relayKey: "synthetic-relay-key-k1",
	});
	await reopened.close();
	await store.close();
});

it("accepts V4 event read and ACK on the assigned Session for a nullable submit scope", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-host-v4-events-"));
	directories.push(directory);
	const store = await FileRuntimeStore.open(join(directory, "host.json"));
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const { request, claims, transport } = fixture();
	const options = {
		store,
		driver,
		grantValidation: { expectedIssuer: "agent-platform" },
		grantValidationV2: {
			expectedIssuer: "platform-worker",
			expectedWorkerId: "worker-1",
		},
		allowLegacyBusiness: false,
		validateGrantV4: async (value: unknown) => {
			const parsed = value as RuntimeBusinessRequestV4;
			await validateRuntimeBusinessBindingV4(parsed, claims);
			return { request: parsed, claims };
		},
	};
	const host = await RuntimeHost.open(options);
	const accepted = await host.submitTurnV4(transport);
	const { input: _input, selection: _selection, ...eventBase } = request;
	const operation = request.operation;
	const read = RuntimeEventReadRequestV4Schema.parse({
		...eventBase,
		requestId: "event-read-1",
		hostSessionRef: accepted.hostSessionRef,
		operation,
		grant: {
			schemaVersion: 2,
			format: "runtime-execution-jws",
			token: "event-read.token.x",
		},
		consumer: "platform_worker_persistence",
		afterCursor: null,
	});
	const replay = await host.readEventsV4(read, await eventVerification(read));
	expect(replay.events).toHaveLength(1);
	const firstEvent = replay.events[0];
	if (!firstEvent) throw new Error("Fake V4 event is missing");
	const ack = RuntimeEventAckRequestV4Schema.parse({
		...eventBase,
		requestId: "event-ack-1",
		hostSessionRef: accepted.hostSessionRef,
		operation,
		grant: {
			schemaVersion: 2,
			format: "runtime-execution-jws",
			token: "event-ack.token.x",
		},
		consumer: "platform_worker_persistence",
		confirmedCursor: firstEvent.cursor,
	});
	await expect(
		host.acknowledgeEventsV4(ack, await eventVerification(ack)),
	).resolves.toMatchObject({
		schemaVersion: 4,
		executionId: request.executionId,
		confirmedCursor: firstEvent.cursor,
	});
	const foreign = RuntimeEventReadRequestV4Schema.parse({
		...read,
		hostSessionRef: "foreign-host",
		grant: { ...read.grant, token: "foreign.token.x" },
	});
	await expect(
		host.readEventsV4(foreign, await eventVerification(foreign)),
	).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
	await host.close();
	await store.close();
});

it("does not reinstall a Key when replaying a terminal submit receipt", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-host-v4-terminal-"));
	directories.push(directory);
	const store = await FileRuntimeStore.open(join(directory, "host.json"));
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const { request, claims, transport } = fixture();
	const options = {
		store,
		driver,
		grantValidation: { expectedIssuer: "agent-platform" },
		grantValidationV2: {
			expectedIssuer: "platform-worker",
			expectedWorkerId: "worker-1",
		},
		allowLegacyBusiness: false,
		validateGrantV4: async (value: unknown) => {
			const parsed = value as RuntimeBusinessRequestV4;
			await validateRuntimeBusinessBindingV4(parsed, claims);
			return { request: parsed, claims };
		},
	};
	const host = await RuntimeHost.open(options);
	const accepted = await host.submitTurnV4(transport);
	await driver.setOperationStatus(request.operation.id, "completed");
	await store.resolveOperation(
		accepted.hostSessionRef,
		request.operation.id,
		{ outcome: "accepted", status: "completed" },
		store.nativeSessionRef(accepted.hostSessionRef),
	);
	await host.close();
	const reopened = await RuntimeHost.open(options);
	await expect(reopened.submitTurnV4(transport)).resolves.toMatchObject({
		operationId: request.operation.id,
		result: { outcome: "accepted", status: "completed" },
	});
	const action = {
		nativeSessionRef: store.nativeSessionRef(accepted.hostSessionRef) as string,
		executionId: request.executionId,
		runtimeOperationId: request.executionId,
		operationRef: "model-fact-1",
		attemptRef: "attempt-1",
		kind: "model" as const,
	};
	await expect(reopened.authorizeExternalAction(action)).rejects.toMatchObject({
		code: "RUNTIME_GRANT_INVALID",
	});
	expect(await driver.sideEffectCount()).toBe(1);
	await reopened.close();
	await store.close();
});

it("rejects an invalid private Key field before reserving a V4 operation", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "runtime-host-v4-private-field-"),
	);
	directories.push(directory);
	const store = await FileRuntimeStore.open(join(directory, "host.json"));
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const { request, claims, transport } = fixture();
	const host = await RuntimeHost.open({
		store,
		driver,
		grantValidation: { expectedIssuer: "agent-platform" },
		grantValidationV2: {
			expectedIssuer: "platform-worker",
			expectedWorkerId: "worker-1",
		},
		allowLegacyBusiness: false,
		validateGrantV4: async (value: unknown) => {
			const parsed = value as RuntimeBusinessRequestV4;
			await validateRuntimeBusinessBindingV4(parsed, claims);
			return { request: parsed, claims };
		},
	});
	await expect(
		host.submitTurnV4({
			...transport,
			privateKeyField: {
				...transport.privateKeyField,
				context: {
					...transport.privateKeyField.context,
					executionId: "other-execution",
				},
			},
		}),
	).rejects.toThrow("RuntimeHostV4 private Key field is invalid");
	expect(store.readOriginalExecutionKeyScopeV4(request)).toBeNull();
	expect(await driver.sideEffectCount()).toBe(0);
	await host.close();
	await store.close();
});

it("does not dispatch V4 business after Host closes during Grant validation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-host-v4-close-"));
	directories.push(directory);
	const store = await FileRuntimeStore.open(join(directory, "host.json"));
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const { request, claims, transport } = fixture();
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const host = await RuntimeHost.open({
		store,
		driver,
		grantValidation: { expectedIssuer: "agent-platform" },
		grantValidationV2: {
			expectedIssuer: "platform-worker",
			expectedWorkerId: "worker-1",
		},
		validateGrantV4: async () => {
			await gate;
			return { request, claims };
		},
	});
	const pending = host.submitTurnV4(transport);
	const rejection = expect(pending).rejects.toMatchObject({
		code: "RUNTIME_GRANT_INVALID",
	});
	await host.close();
	release?.();
	await rejection;
	expect(await driver.sideEffectCount()).toBe(0);
	expect(store.readOriginalExecutionKeyScopeV4(request)).toBeNull();
	await store.close();
});
