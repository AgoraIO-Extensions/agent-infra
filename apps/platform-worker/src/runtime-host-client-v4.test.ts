import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createRuntimeExecutionGrantValidatorV4,
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import {
	RuntimeBusinessGrantClaimsV4Schema,
	RuntimeSubmitTurnRequestV4Schema,
	runtimeRequestSigningPayloadV4,
} from "@agent-infra/contracts/runtime";
import { ConversationRuntimeHostError } from "@agent-infra/platform-core";
import { expect, it, vi } from "vitest";

import { createRuntimeHostApp } from "../../agent-runtime-host/src/app.js";
import { createWorkerRuntimeGrantSignerV4 } from "./runtime-grant-signer-v4.js";
import { createWorkerRuntimeHostClientV4 } from "./runtime-host-client.js";

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

const claims = RuntimeBusinessGrantClaimsV4Schema.parse({
	schemaVersion: 4,
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

function fixture() {
	const readAcceptedExecution = vi.fn(async () => ({
		scope: {
			principal: request.principal,
			executionSource: request.executionSource,
			channelId: request.channelId,
			agentId: request.agentId,
			conversationId: request.conversationId,
			executionId: request.executionId,
			turnId: request.turnId,
			sessionGeneration: request.sessionGeneration,
			hostSessionRef: request.hostSessionRef,
			keyBinding: request.keyBinding,
		},
		trustedHostSessionRef: null,
	}));
	const readCiphertext = vi.fn(async () => ({ encrypted: true }));
	const plaintext = new TextEncoder().encode("synthetic-relay-key-k1");
	const decrypt = vi.fn(async () => ({
		outcome: "decrypted" as const,
		plaintext,
	}));
	const assertCurrentAuthorization = vi.fn(async () => {});
	const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
		new Response(
			JSON.stringify({
				schemaVersion: 4,
				hostSessionRef: "host-1",
				operationId: "execution-1",
				result: { outcome: "accepted", status: "running" },
			}),
		),
	);
	const client = createWorkerRuntimeHostClientV4({
		baseUrl: "https://runtime.example.test",
		serviceToken: "synthetic-service-token",
		verifyGrant: async () => claims,
		executionKeys: { readAcceptedExecution, readCiphertext },
		decryptor: { decrypt },
		assertCurrentAuthorization,
		fetch: fetcher,
	});
	return {
		client,
		readAcceptedExecution,
		readCiphertext,
		decrypt,
		assertCurrentAuthorization,
		fetcher,
		plaintext,
	};
}

it("delivers only the pinned version in the private V4 transport", async () => {
	const f = fixture();
	await expect(f.client.submitTurn(request)).resolves.toMatchObject({
		schemaVersion: 4,
		operationId: "execution-1",
	});
	expect(f.readCiphertext).toHaveBeenCalledWith({
		purpose: "personal",
		subjectId: "alice",
		keyId: "key-1",
		keyVersion: 1,
	});
	expect(f.readAcceptedExecution).toHaveBeenCalledTimes(2);
	expect(f.plaintext.every((value) => value === 0)).toBe(true);
	const [url, init] = f.fetcher.mock.calls[0] ?? [];
	expect(init?.redirect).toBe("error");
	expect(String(url)).toBe(
		"https://runtime.example.test/internal/runtime/v4/turns",
	);
	const body = JSON.parse(String(init?.body));
	expect(body.businessRequest).toEqual(request);
	expect(body.businessRequest).not.toHaveProperty("relayKey");
	expect(body.privateKeyField).toMatchObject({
		context: { grantId: "grant-1", keyBinding: request.keyBinding },
		keyDelivery: { relayKey: "synthetic-relay-key-k1" },
	});
});

it("rejects a cross-subject or changed-version request before decrypting", async () => {
	const f = fixture();
	for (const changed of [
		{ ...request, principal: { kind: "user" as const, id: "bob" } },
		{ ...request, keyBinding: { ...request.keyBinding, version: 2 } },
	]) {
		await expect(f.client.submitTurn(changed)).rejects.toMatchObject({
			code: "RUNTIME_REQUEST_INVALID",
		});
	}
	expect(f.decrypt).not.toHaveBeenCalled();
	expect(f.fetcher).not.toHaveBeenCalled();
});

it("fails closed when the original Execution or exact ciphertext is absent", async () => {
	const f = fixture();
	f.readAcceptedExecution.mockResolvedValueOnce(null as never);
	await expect(f.client.submitTurn(request)).rejects.toMatchObject({
		code: "RUNTIME_GRANT_INVALID",
	});
	f.readCiphertext.mockResolvedValueOnce(null as never);
	await expect(f.client.submitTurn(request)).rejects.toMatchObject({
		code: "RELAY_KEY_UNAVAILABLE",
	});
	expect(f.decrypt).not.toHaveBeenCalled();
	expect(f.fetcher).not.toHaveBeenCalled();
});

it("rejects a changed original Execution after decryption", async () => {
	const f = fixture();
	f.readAcceptedExecution.mockResolvedValueOnce({
		scope: {
			principal: request.principal,
			executionSource: request.executionSource,
			channelId: request.channelId,
			agentId: request.agentId,
			conversationId: request.conversationId,
			executionId: request.executionId,
			turnId: request.turnId,
			sessionGeneration: request.sessionGeneration,
			hostSessionRef: request.hostSessionRef,
			keyBinding: request.keyBinding,
		},
		trustedHostSessionRef: null,
	});
	f.readAcceptedExecution.mockResolvedValueOnce(null as never);
	await expect(f.client.submitTurn(request)).rejects.toMatchObject({
		code: "RUNTIME_GRANT_INVALID",
	});
	expect(f.fetcher).not.toHaveBeenCalled();
});

it("withholds the Key transport after current authority is revoked", async () => {
	const f = fixture();
	f.assertCurrentAuthorization.mockRejectedValueOnce(
		new ConversationRuntimeHostError("AUTHORIZATION_REVOKED", true),
	);
	await expect(f.client.submitTurn(request)).rejects.toMatchObject({
		code: "AUTHORIZATION_REVOKED",
	});
	expect(f.assertCurrentAuthorization).toHaveBeenCalledOnce();
	expect(f.fetcher).not.toHaveBeenCalled();
	expect(f.plaintext.every((value) => value === 0)).toBe(true);
});

it("does not retry a certificate failure over HTTP", async () => {
	const f = fixture();
	f.fetcher.mockRejectedValueOnce(new Error("CERT_HAS_EXPIRED"));
	await expect(f.client.submitTurn(request)).rejects.toMatchObject({
		code: "RUNTIME_UNAVAILABLE",
	});
	expect(f.fetcher).toHaveBeenCalledOnce();
	expect(String(f.fetcher.mock.calls[0]?.[0])).toMatch(/^https:\/\//);
});

it("requires confidential transport for private Key delivery", () => {
	const f = fixture();
	expect(() =>
		createWorkerRuntimeHostClientV4({
			baseUrl: "http://runtime.namespace.svc",
			serviceToken: "synthetic-service-token",
			verifyGrant: async () => claims,
			executionKeys: {
				readAcceptedExecution: f.readAcceptedExecution,
				readCiphertext: f.readCiphertext,
			},
			decryptor: { decrypt: f.decrypt },
			assertCurrentAuthorization: async () => {},
		}),
	).toThrow("RuntimeHost V4 transport must be confidential");
	vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
	try {
		expect(() => fixture()).toThrow(
			"RuntimeHost V4 transport must be confidential",
		);
	} finally {
		vi.unstubAllEnvs();
	}
});

it("carries a signed V4 Turn through Worker, Host and durable Fake Driver", async () => {
	const directory = await mkdtemp(join(tmpdir(), "worker-host-v4-"));
	const storePath = join(directory, "host.json");
	const store = await FileRuntimeStore.open(storePath);
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"), [
		request.selection,
	]);
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const now = Date.now();
	const signer = createWorkerRuntimeGrantSignerV4({
		issuer: "platform-worker",
		workerId: "worker-1",
		keyId: "key-1",
		privateKey,
		now: () => now,
	});
	const host = await RuntimeHost.open({
		store,
		driver,
		grantValidation: { expectedIssuer: "agent-platform" },
		grantValidationV2: {
			expectedIssuer: "platform-worker",
			expectedWorkerId: "worker-1",
		},
		allowLegacyBusiness: false,
		validateGrantV4: createRuntimeExecutionGrantValidatorV4(
			new Map([["key-1", publicKey]]),
			{ expectedIssuer: "platform-worker", expectedWorkerId: "worker-1" },
		),
	});
	try {
		const app = createRuntimeHostApp({
			host,
			serviceToken: "synthetic-service-token",
			verifyGrant: () => {
				throw new Error("V1 verifier must not run");
			},
		});
		const fetcher = vi.fn<typeof fetch>(async (url, init) =>
			app.request(new Request(url, init)),
		);
		const client = createWorkerRuntimeHostClientV4({
			baseUrl: "https://runtime.example.test",
			serviceToken: "synthetic-service-token",
			verifyGrant: signer.verify,
			executionKeys: {
				readAcceptedExecution: async () => ({
					scope: {
						principal: request.principal,
						executionSource: request.executionSource,
						channelId: request.channelId,
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						hostSessionRef: request.hostSessionRef,
						keyBinding: request.keyBinding,
					},
					trustedHostSessionRef: null,
				}),
				readCiphertext: async () => ({ encrypted: true }),
			},
			decryptor: {
				decrypt: async () => ({
					outcome: "decrypted" as const,
					plaintext: new TextEncoder().encode("synthetic-relay-key-k1"),
				}),
			},
			assertCurrentAuthorization: async () => {},
			fetch: fetcher,
		});
		const signed = {
			...request,
			grant: signer.sign(request, "authorization-1"),
		};
		const accepted = await client.submitTurn(signed);
		expect(accepted).toMatchObject({
			schemaVersion: 4,
			operationId: request.executionId,
			result: { outcome: "accepted", status: "running" },
		});
		expect(await driver.sideEffectCount()).toBe(1);
		expect(await readFile(storePath, "utf8")).not.toContain(
			"synthetic-relay-key-k1",
		);
		await expect(client.submitTurn(signed)).resolves.toEqual(accepted);
		expect(await driver.sideEffectCount()).toBe(1);
		expect(fetcher).toHaveBeenCalledTimes(2);
	} finally {
		await host.close();
		await store.close();
		await rm(directory, { recursive: true });
	}
});
