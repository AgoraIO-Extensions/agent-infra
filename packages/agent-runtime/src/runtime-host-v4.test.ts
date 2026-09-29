import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	RuntimeBusinessGrantClaimsV4Schema,
	type RuntimeBusinessRequestV4,
	RuntimeSubmitTurnRequestV4Schema,
	runtimeRequestSigningPayloadV4,
	validateRuntimeBusinessBindingV4,
	validateVerifiedRuntimeExecutionGrantClaimsV4,
} from "@agent-infra/contracts/runtime";
import { afterEach, expect, it } from "vitest";

import { FakeRuntimeDriver } from "./fake-runtime-driver.js";
import { FileRuntimeStore } from "./file-runtime-store.js";
import {
	runtimeGrantFixture,
	verificationForRuntimeGrant,
} from "./grant-fixture.test-support.js";
import {
	signV3Fixture,
	submitV3Fixture,
	verifyRuntimeV2Fixture,
} from "./grant-v2-fixture.test-support.js";
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
	const legacyV3 = signV3Fixture(submitV3Fixture(), "turn.submit");
	expect(() =>
		host.submitTurnV3(legacyV3, verifyRuntimeV2Fixture(legacyV3.grant)),
	).toThrowError("Runtime authorization is unavailable");
	const binding = {
		agentId: request.agentId,
		actorId: request.principal.id,
		channelId: request.channelId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		traceId: request.traceId,
	};
	const legacyV2Grant = runtimeGrantFixture(binding, ["turn.submit"]);
	await expect(
		host.submitTurnV2(
			{
				schemaVersion: 2,
				requestId: "legacy-v2-request",
				...binding,
				deliveryFence: 1,
				grant: legacyV2Grant,
				input: request.input,
				selection: request.selection,
			},
			verificationForRuntimeGrant(legacyV2Grant),
		),
	).rejects.toMatchObject({
		code: "RUNTIME_GRANT_INVALID",
	});
	expect(await driver.sideEffectCount()).toBe(0);
	const accepted = await host.submitTurnV4(transport);
	expect(accepted).toMatchObject({
		schemaVersion: 4,
		operationId: request.executionId,
		result: { outcome: "accepted", status: "running" },
	});
	expect(store.readOriginalExecutionKeyScopeV4(request)?.scope).toMatchObject({
		keyBinding: request.keyBinding,
	});
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

const rejectedV4Cases = [
	"expired-grant",
	"changed-fence",
	"changed-key-version",
	"changed-private-context",
] as const;

it.each(rejectedV4Cases)(
	"rejects %s before V4 Driver work",
	async (substitution) => {
		const directory = await mkdtemp(join(tmpdir(), "runtime-host-v4-denied-"));
		directories.push(directory);
		const store = await FileRuntimeStore.open(join(directory, "host.json"));
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const { request, claims, transport } = fixture();
		const now = Date.now();
		const delivered =
			substitution === "changed-fence"
				? {
						...transport,
						businessRequest: {
							...request,
							operation: { ...request.operation, deliveryFence: 2 },
						},
					}
				: substitution === "changed-key-version"
					? {
							...transport,
							businessRequest: {
								...request,
								keyBinding: { ...request.keyBinding, version: 2 },
							},
						}
					: substitution === "changed-private-context"
						? {
								...transport,
								privateKeyField: {
									...transport.privateKeyField,
									context: {
										...transport.privateKeyField.context,
										executionId: "other-execution",
									},
								},
							}
						: transport;
		const signedClaims =
			substitution === "expired-grant"
				? { ...claims, issuedAt: now - 2_000, expiresAt: now - 1_000 }
				: claims;
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
				const acceptedClaims = validateVerifiedRuntimeExecutionGrantClaimsV4(
					signedClaims,
					{
						expectedIssuer: "platform-worker",
						expectedWorkerId: "worker-1",
						now,
					},
				);
				await validateRuntimeBusinessBindingV4(parsed, acceptedClaims);
				return { request: parsed, claims: acceptedClaims };
			},
		});
		await expect(host.submitTurnV4(delivered)).rejects.toThrow();
		expect(store.readOriginalExecutionKeyScopeV4(request)).toBeNull();
		expect(await driver.sideEffectCount()).toBe(0);
		await host.close();
		await store.close();
	},
);
