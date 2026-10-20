import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createExecutionGrantVerifier,
	createRuntimeExecutionGrantValidatorV4,
	FakeRuntimeDriver,
	FileRuntimeStore,
	type RuntimeDriver,
	RuntimeHost,
	requestDigest,
} from "@agent-infra/agent-runtime";
import {
	RuntimeBusinessGrantClaimsV4Schema,
	RuntimeNativeCapabilityRequestV4Schema,
	type RuntimeNativeCapabilityRequestV5,
	RuntimeNativeCapabilityRequestV5Schema,
	RuntimeNativeCapabilityTransportV4Schema,
	RuntimeNativeCapabilityTransportV5Schema,
	type RuntimeRestoreExecutionKeyGrantClaimsV5,
	RuntimeRestoreExecutionKeyGrantClaimsV5Schema,
	RuntimeRestoreExecutionKeyRequestV4Schema,
	type RuntimeRestoreExecutionKeyRequestV5,
	RuntimeRestoreExecutionKeyRequestV5Schema,
	RuntimeRestoreExecutionKeyTransportV5Schema,
	RuntimeSubmitTurnRequestV4Schema,
	RuntimeSubmitTurnTransportV4Schema,
	runtimeOperationDigestInputV5,
	runtimeRequestDigestV5,
	runtimeRequestSigningPayloadV4,
	runtimeRestoreExecutionKeyRequestDigestV5,
} from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntimeHostApp } from "./app.js";
import { createRuntimeV5GrantValidators } from "./runtime-v5-grant.js";

const now = Date.parse("2026-08-28T10:00:00Z");
const nowIso = new Date(now).toISOString();
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeys = new Map([["runtime-key", publicKey]]);
const serviceToken = "synthetic-service-proof";
const workerId = "worker-v5";
const issuer = "agent-platform";
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((value) => rm(value, { recursive: true })),
	);
});

function token(claims: unknown) {
	const header = Buffer.from(
		JSON.stringify({
			alg: "EdDSA",
			kid: "runtime-key",
			typ: "runtime-execution+jws",
		}),
	).toString("base64url");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	return `${header}.${payload}.${sign(
		null,
		Buffer.from(`${header}.${payload}`, "ascii"),
		privateKey,
	).toString("base64url")}`;
}

const attachmentText = new TextEncoder().encode("hello");
const attachment = {
	attachmentId: "file-v5",
	sha256: createHash("sha256").update(attachmentText).digest("hex"),
	byteLength: attachmentText.byteLength,
	mediaType: "text/plain" as const,
};

function businessFields(request: RuntimeNativeCapabilityRequestV5) {
	return {
		schemaVersion: 5 as const,
		issuer,
		audience: "runtime_host" as const,
		workerId,
		issuedAt: now,
		expiresAt: now + 30_000,
		grantId: "grant-v5",
		principal: request.principal,
		executionSource: request.executionSource,
		relayKeyBinding: request.keyBinding,
		channelId: request.channelId,
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		traceId: request.traceId,
		hostSessionRef: request.hostSessionRef,
		operation: request.operation,
		allowedCommands: ["native-capability.invoke"] as const,
		purpose: "business" as const,
		authorizationRecordId: "authorization-v5",
		attachments: request.attachments.map((entry) => ({
			attachmentId: entry.attachmentId,
			operations: ["read"] as const,
		})),
	};
}

function privateField(
	request: RuntimeNativeCapabilityRequestV5,
	claims: { grantId: string; requestDigest: string },
) {
	return {
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
		keyDelivery: { relayKey: "synthetic-pinned-key-k1" },
	};
}

async function v5Transport(hostSessionRef: string) {
	const request = RuntimeNativeCapabilityRequestV5Schema.parse({
		schemaVersion: 5,
		requestId: "request-v5",
		traceId: "trace-v5",
		principal: { kind: "user", id: "actor-v5" },
		executionSource: "web",
		channelId: "web",
		agentId: "agent-v5",
		conversationId: "conversation-v5",
		executionId: "execution-v5",
		turnId: "turn-v5",
		sessionGeneration: 1,
		hostSessionRef,
		operation: {
			kind: "execution",
			id: "execution-v5",
			deliveryFence: 1,
			executionDeliveryFence: 1,
		},
		keyBinding: {
			purpose: "personal",
			subjectId: "actor-v5",
			ciphertextRef: "key-v5",
			version: 1,
		},
		grant: {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: "a.b.c",
		},
		capabilityKind: "skill",
		capabilityId: "a".repeat(64),
		directoryRevision: "b".repeat(64),
		parameters: "{}",
		parametersDigest: createHash("sha256").update("{}").digest("hex"),
		capabilitySourceVersion: "1.0.0",
		attachments: [attachment],
	});
	const claims = RuntimeBusinessGrantClaimsV4Schema.parse({
		...businessFields(request),
		schemaVersion: 4,
		requestDigest: await runtimeRequestDigestV5(request),
	});
	const transport = RuntimeNativeCapabilityTransportV5Schema.parse({
		businessRequest: {
			...request,
			grant: { ...request.grant, token: token(claims) },
		},
		privateKeyField: privateField(request, claims),
	});
	return { request, claims, transport };
}

function toV4NativeRequest(request: RuntimeNativeCapabilityRequestV5) {
	const { attachments: _attachments, ...fields } = request;
	return RuntimeNativeCapabilityRequestV4Schema.parse({
		...fields,
		schemaVersion: 4,
	});
}

function v4SeedTransport() {
	const request = RuntimeSubmitTurnRequestV4Schema.parse({
		schemaVersion: 4,
		requestId: "request-seed",
		traceId: "trace-seed",
		principal: { kind: "user", id: "actor-v5" },
		executionSource: "web",
		channelId: "web",
		agentId: "agent-v5",
		conversationId: "conversation-v5",
		executionId: "execution-seed",
		turnId: "turn-seed",
		sessionGeneration: 1,
		hostSessionRef: null,
		operation: {
			kind: "execution",
			id: "execution-seed",
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
			subjectId: "actor-v5",
			ciphertextRef: "key-v5",
			version: 1,
		},
		input: { text: "seed", attachments: [] },
		selection: {
			schemaVersion: 1,
			modelOptionId: "model-option-primary",
			reasoningLevel: "high",
		},
	});
	const claims = RuntimeBusinessGrantClaimsV4Schema.parse({
		schemaVersion: 4,
		issuer,
		audience: "runtime_host",
		workerId,
		issuedAt: now,
		expiresAt: now + 30_000,
		grantId: "grant-seed",
		principal: request.principal,
		executionSource: request.executionSource,
		relayKeyBinding: request.keyBinding,
		channelId: request.channelId,
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		traceId: request.traceId,
		hostSessionRef: request.hostSessionRef,
		operation: request.operation,
		allowedCommands: ["turn.submit"],
		purpose: "business",
		authorizationRecordId: "authorization-seed",
		attachments: [],
		requestDigest: createHash("sha256")
			.update(runtimeRequestSigningPayloadV4(request))
			.digest("hex"),
	});
	return RuntimeSubmitTurnTransportV4Schema.parse({
		businessRequest: {
			...request,
			grant: { ...request.grant, token: token(claims) },
		},
		privateKeyField: {
			schemaVersion: 1,
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
			keyDelivery: { relayKey: "synthetic-pinned-key-k1" },
		},
	});
}

async function restoreTransport(
	hostSessionRef: string,
	originalRequest: RuntimeNativeCapabilityRequestV5,
) {
	const unsigned = RuntimeRestoreExecutionKeyRequestV5Schema.parse({
		schemaVersion: 5,
		mode: "existing-accepted-only",
		acceptedHostSessionRef: hostSessionRef,
		acceptedOperationDigest: requestDigest(
			runtimeOperationDigestInputV5(originalRequest),
		),
		acceptedAttachmentIds: originalRequest.attachments.map(
			(entry) => entry.attachmentId,
		),
		grant: {
			schemaVersion: 5,
			format: "runtime-execution-jws",
			token: "a.b.c",
		},
		originalRequest,
	});
	const claims = RuntimeRestoreExecutionKeyGrantClaimsV5Schema.parse({
		...businessFields(originalRequest),
		grantId: "recovery-grant-v5",
		allowedCommands: ["execution.key.restore"],
		attachments: [],
		mode: unsigned.mode,
		acceptedHostSessionRef: unsigned.acceptedHostSessionRef,
		acceptedOperationDigest: unsigned.acceptedOperationDigest,
		acceptedAttachmentIds: unsigned.acceptedAttachmentIds,
		requestDigest: await runtimeRestoreExecutionKeyRequestDigestV5(unsigned),
	});
	return {
		request: {
			...unsigned,
			grant: { ...unsigned.grant, token: token(claims) },
		} satisfies RuntimeRestoreExecutionKeyRequestV5,
		claims: claims satisfies RuntimeRestoreExecutionKeyGrantClaimsV5,
		transport: RuntimeRestoreExecutionKeyTransportV5Schema.parse({
			recoveryRequest: {
				...unsigned,
				grant: { ...unsigned.grant, token: token(claims) },
			},
			privateKeyField: privateField(originalRequest, claims),
		}),
	};
}

async function setup(options: { textInputDriver?: boolean } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "runtime-host-v5-http-"));
	directories.push(directory);
	const store = await FileRuntimeStore.open(join(directory, "host.json"));
	const fake = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const createNativeSkillCommand = vi.fn(
		(
			command: import("@agent-infra/agent-runtime").RuntimeNativeSkillCommandV1,
		) => ({
			schemaVersion: 1 as const,
			kind: "submit-turn" as const,
			operationId: command.operationId,
			agentId: command.agentId,
			conversationId: command.conversationId,
			executionId: command.executionId,
			turnId: command.turnId,
			sessionGeneration: command.sessionGeneration,
			nativeSessionRef: command.nativeSessionRef,
			input: { text: command.parameters, attachments: [] },
			nativeSkill: {
				capabilityId: command.capabilityId,
				directoryRevision: command.directoryRevision,
				name: command.capabilityName,
				version: command.capabilitySourceVersion,
				packageDigest: command.packageDigest,
				manifestDigest: command.manifestDigest,
			},
		}),
	);
	const driver =
		options.textInputDriver === false
			? fake
			: (Object.assign(fake, {
					nativeTextInputs: { schemaVersion: 1 as const },
					readNativeMetadataV1: async (
						selector: string,
						read: {
							assertCurrent(): void;
						},
					) => {
						read.assertCurrent();
						if (selector !== "skills") throw new Error("unexpected selector");
						return {
							selector: "skills" as const,
							revision: "b".repeat(64),
							capabilities: [
								{
									id: "a".repeat(64),
									kind: "skill" as const,
									name: "test-skill",
									description: "Controlled Skill",
									source: { name: "controlled", version: "1.0.0" },
									parameters: [],
									effect: "model_turn" as const,
									availability: "discovered" as const,
								},
							],
						};
					},
					resolveNativeSkillBinding: () => ({
						packageDigest: "c".repeat(64),
						manifestDigest: "d".repeat(64),
					}),
					createNativeSkillCommand,
				}) as RuntimeDriver);
	const validators = createRuntimeV5GrantValidators(publicKeys, {
		expectedIssuer: issuer,
		expectedWorkerId: workerId,
		now: () => now,
	});
	const host = await RuntimeHost.open({
		store,
		driver,
		grantValidation: { expectedIssuer: issuer, now: () => nowIso },
		grantValidationV2: {
			expectedIssuer: issuer,
			expectedWorkerId: workerId,
			now: () => now,
		},
		validateGrantV4: createRuntimeExecutionGrantValidatorV4(publicKeys, {
			expectedIssuer: issuer,
			expectedWorkerId: workerId,
			now: () => now,
		}),
		validateGrantV5: validators.validateGrantV5,
		validateRecoveryGrantV5: validators.validateRecoveryGrantV5,
		fileBridge: () => ({
			async readInput() {
				throw new Error("unexpected file input read");
			},
			async writeResult() {
				throw new Error("unexpected file result write");
			},
			revalidate() {},
		}),
	});
	const app = createRuntimeHostApp({
		host,
		serviceToken,
		runtimeWorkerId: workerId,
		verifyGrant: createExecutionGrantVerifier(publicKeys),
		verifyGrantV5: validators.validateGrantV5,
		verifyRecoveryGrantV5: validators.validateRecoveryGrantV5,
		logDiagnostic: () => {},
	});
	async function seedSession() {
		const submitted = await host.submitTurnV4(v4SeedTransport());
		// The fake Driver keeps one active execution per native session. Finish the
		// seed execution so the V5 Skill is admitted as the next active execution.
		await fake.setOperationStatus("execution-seed", "completed");
		return submitted.hostSessionRef;
	}
	return { app, driver, fake, host, seedSession };
}

const authorizedHeaders = {
	authorization: `Bearer ${serviceToken}`,
	"content-type": "application/json",
};

async function post(
	app: Awaited<ReturnType<typeof setup>>["app"],
	body: unknown,
) {
	return app.request("/internal/runtime/v5/native-capability", {
		method: "POST",
		headers: authorizedHeaders,
		body: JSON.stringify(body),
	});
}

describe("RuntimeHost HTTP V5 routes", () => {
	it("dispatches a V5 native Skill with ordered text attachments", async () => {
		const { app, seedSession } = await setup();
		const hostSessionRef = await seedSession();
		const { request, transport } = await v5Transport(hostSessionRef);
		const response = await post(app, transport);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			schemaVersion: 5,
			hostSessionRef,
			operationId: request.executionId,
			result: { outcome: "accepted", status: "running" },
		});
	});

	it("rejects V4 native-capability and unknown fields on the V5 route", async () => {
		const { app, seedSession } = await setup();
		const hostSessionRef = await seedSession();
		const { request, transport } = await v5Transport(hostSessionRef);

		const v4Request = toV4NativeRequest(request);
		const v4Response = await post(
			app,
			RuntimeNativeCapabilityTransportV4Schema.parse({
				businessRequest: v4Request,
				privateKeyField: transport.privateKeyField,
			}),
		);
		expect(v4Response.status).toBe(400);
		expect(await v4Response.json()).toMatchObject({
			code: "RUNTIME_REQUEST_INVALID",
		});

		const extraResponse = await post(app, { ...transport, extra: true });
		expect(extraResponse.status).toBe(400);

		const nestedResponse = await post(app, {
			...transport,
			businessRequest: { ...transport.businessRequest, extra: true },
		});
		expect(nestedResponse.status).toBe(400);

		const missingAttachmentResponse = await post(app, {
			...transport,
			businessRequest: {
				...transport.businessRequest,
				attachments: [],
			},
		});
		expect(missingAttachmentResponse.status).toBe(400);
	});

	it("maps a malformed private Key field to 400 and a mismatched context to 403", async () => {
		const { app, seedSession } = await setup();
		const hostSessionRef = await seedSession();
		const { transport } = await v5Transport(hostSessionRef);

		const malformed = await post(app, {
			...transport,
			privateKeyField: {
				...transport.privateKeyField,
				keyDelivery: { relayKey: "short" },
			},
		});
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({
			code: "RUNTIME_REQUEST_INVALID",
		});

		const mismatched = await post(app, {
			...transport,
			privateKeyField: {
				...transport.privateKeyField,
				context: {
					...transport.privateKeyField.context,
					executionId: "other-execution",
				},
			},
		});
		expect(mismatched.status).toBe(403);
		expect(await mismatched.json()).toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
	});

	it("rejects a V5 Grant issued for another Worker", async () => {
		const { app, seedSession } = await setup();
		const hostSessionRef = await seedSession();
		const { request } = await v5Transport(hostSessionRef);
		const claims = RuntimeBusinessGrantClaimsV4Schema.parse({
			...businessFields(request),
			schemaVersion: 4,
			workerId: "other-worker",
			requestDigest: await runtimeRequestDigestV5(request),
		});
		const transport = RuntimeNativeCapabilityTransportV5Schema.parse({
			businessRequest: {
				...request,
				grant: { ...request.grant, token: token(claims) },
			},
			privateKeyField: privateField(request, claims),
		});
		const response = await post(app, transport);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
	});

	it("maps an unsupported text-input Driver to the existing 409 capability code", async () => {
		const { app, seedSession } = await setup({ textInputDriver: false });
		const hostSessionRef = await seedSession();
		const { transport } = await v5Transport(hostSessionRef);
		const response = await post(app, transport);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code: "RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED",
		});
	});

	it("restores an accepted V5 execution key from the original envelope", async () => {
		const { app, seedSession } = await setup();
		const hostSessionRef = await seedSession();
		const { request, transport } = await v5Transport(hostSessionRef);
		const dispatched = await post(app, transport);
		expect(dispatched.status).toBe(200);
		const { transport: restore } = await restoreTransport(
			hostSessionRef,
			request,
		);
		const response = await app.request(
			"/internal/runtime/v5/execution-key/restore",
			{
				method: "POST",
				headers: authorizedHeaders,
				body: JSON.stringify(restore),
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			schemaVersion: 5,
			hostSessionRef,
			operationId: request.executionId,
			result: "restored",
		});
	});

	it("rejects V4 restore envelopes and V4 originals on the V5 restore route", async () => {
		const { app, seedSession } = await setup();
		const hostSessionRef = await seedSession();
		const { request, transport } = await v5Transport(hostSessionRef);
		expect((await post(app, transport)).status).toBe(200);

		const v4Restore = RuntimeRestoreExecutionKeyRequestV4Schema.parse({
			schemaVersion: 4,
			mode: "existing-accepted-only",
			acceptedHostSessionRef: hostSessionRef,
			acceptedOperationDigest: requestDigest(
				runtimeOperationDigestInputV5(request),
			),
			grant: {
				schemaVersion: 4,
				format: "runtime-execution-jws",
				token: "a.b.c",
			},
			originalRequest: toV4NativeRequest(request),
		});
		const v4Response = await app.request(
			"/internal/runtime/v5/execution-key/restore",
			{
				method: "POST",
				headers: authorizedHeaders,
				body: JSON.stringify({
					recoveryRequest: v4Restore,
					privateKeyField: transport.privateKeyField,
				}),
			},
		);
		expect(v4Response.status).toBe(400);

		const { transport: restore } = await restoreTransport(
			hostSessionRef,
			request,
		);
		const v4Original = toV4NativeRequest(request);
		const originalResponse = await app.request(
			"/internal/runtime/v5/execution-key/restore",
			{
				method: "POST",
				headers: authorizedHeaders,
				body: JSON.stringify({
					...restore,
					recoveryRequest: {
						...restore.recoveryRequest,
						originalRequest: v4Original,
					},
				}),
			},
		);
		expect(originalResponse.status).toBe(400);
	});

	it("requires the deployment service token on every V5 route", async () => {
		const { app } = await setup();
		for (const path of [
			"/internal/runtime/v5/native-capability",
			"/internal/runtime/v5/execution-key/restore",
		]) {
			const missing = await app.request(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(missing.status).toBe(401);
			const wrong = await app.request(path, {
				method: "POST",
				headers: {
					authorization: "Bearer other-service-proof",
					"content-type": "application/json",
				},
				body: "{}",
			});
			expect(wrong.status).toBe(401);
		}
	});
});
