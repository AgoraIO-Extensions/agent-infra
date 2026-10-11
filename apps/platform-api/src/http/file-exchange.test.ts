import { generateKeyPairSync } from "node:crypto";
import { FileAccessResponseV1Schema } from "@agent-infra/contracts/files";
import { FakeObjectStorageV1 } from "@agent-infra/object-storage";
import { createFileAuthorityV1 } from "@agent-infra/platform-core";
import { FakeFileStoreV1 } from "@agent-infra/platform-core/testing";
import { expect, it } from "vitest";
import { createPlatformHealthApp } from "../app.ts";
import { createFileGrantCodecV1 } from "../file-grants.ts";
import { registerFileRoutesV1 } from "./file-routes.ts";

it("allocates a result only through the trusted execution exchange and rejects a retired generation", async () => {
	const store = new FakeFileStoreV1();
	const storage = new FakeObjectStorageV1();
	const scope = {
		actorId: "alice",
		agentId: "agent",
		channelId: "web",
		conversationId: "conversation",
	};
	store.seedConversation(scope);
	const execution = {
		...scope,
		executionId: "execution",
		sessionGeneration: 1,
		status: "processing" as const,
		stopPending: false,
	};
	store.seedExecution(execution);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const trusted = {
		...scope,
		execution: {
			executionId: "execution",
			sessionGeneration: 1,
			grantId: "grant",
			attachments: [],
			expiresAt: "2099-01-01T00:00:00Z",
		},
		limits: {
			revision: "limits-1",
			expiresAt: "2099-01-01T00:00:00Z",
			mediaTypes: ["text/plain"],
			maxBytes: 20,
		},
	};
	const authorization = { authorize: async () => trusted };
	const app = createPlatformHealthApp();
	registerFileRoutesV1(app, {
		service: createFileAuthorityV1({
			store,
			storage,
			intentTtlMs: 60000,
			accessTtlMs: 10000,
			issuer: "platform",
			keyVersion: "key-1",
		}),
		storage,
		codec: createFileGrantCodecV1({
			issuer: "platform",
			keyVersion: "key-1",
			privateKey,
			publicKeys: new Map([["key-1", publicKey]]),
		}),
		authorization: () => authorization,
		maxConcurrentTransfers: 2,
		exchange: {
			authenticate: async (request) => {
				if (request.headers.get("test-service") !== "worker")
					throw new Error("Denied");
				return { conversationId: scope.conversationId, authorization };
			},
		},
		runtimeExchange: {
			authenticate: async (request, value) => {
				if (request.headers.get("test-service") !== "worker")
					throw new Error("Denied");
				if (
					value.actorId !== scope.actorId ||
					value.agentId !== scope.agentId ||
					value.channelId !== scope.channelId ||
					value.conversationId !== scope.conversationId ||
					value.executionId !== execution.executionId ||
					value.sessionGeneration !== execution.sessionGeneration
				)
					throw new Error("Binding denied");
				return { conversationId: value.conversationId, authorization };
			},
		},
	});
	const request = {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": "result-1",
			"test-service": "worker",
		},
		body: JSON.stringify({
			schemaVersion: 1,
			operation: "result",
			executionGrant: {
				schemaVersion: 1,
				format: "compact-jws",
				token: "a.b.c",
			},
			descriptor: {
				name: "hello.txt",
				mediaType: "text/plain",
				sizeBytes: 5,
				sha256:
					"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
			},
		}),
	};
	const first = await app.request("/internal/v1/files/exchange", request);
	expect(first.status).toBe(200);
	const value = FileAccessResponseV1Schema.parse(await first.json());
	expect(value.file.kind).toBe("result");
	const replay = await app.request("/internal/v1/files/exchange", request);
	expect(
		FileAccessResponseV1Schema.parse(await replay.json()).file.fileId,
	).toBe(value.file.fileId);
	expect(
		(
			await app.request("/internal/v1/files/exchange", {
				...request,
				headers: { ...request.headers, "test-service": "other" },
			})
		).status,
	).toBe(404);
	store.seedExecution({ ...execution, sessionGeneration: 2 });
	expect(
		(await app.request("/internal/v1/files/exchange", request)).status,
	).toBe(404);
	store.seedExecution(execution);
	const runtimeRequest = {
		schemaVersion: 1,
		operation: "result",
		actorId: scope.actorId,
		agentId: scope.agentId,
		channelId: scope.channelId,
		conversationId: scope.conversationId,
		executionId: execution.executionId,
		sessionGeneration: execution.sessionGeneration,
		grantId: "grant-v4",
		expiresAt: "2099-01-01T00:00:00Z",
		idempotencyKey: "runtime-result-1",
		descriptor: {
			name: "runtime.txt",
			mediaType: "text/plain",
			sizeBytes: 5,
			sha256:
				"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		},
	};
	const runtimeResponse = await app.request(
		"/internal/v1/files/runtime-exchange",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Idempotency-Key": runtimeRequest.idempotencyKey,
				"test-service": "worker",
			},
			body: JSON.stringify(runtimeRequest),
		},
	);
	expect(runtimeResponse.status).toBe(200);
	expect(
		FileAccessResponseV1Schema.parse(await runtimeResponse.json()).file.kind,
	).toBe("result");
	const runtimeReplay = await app.request(
		"/internal/v1/files/runtime-exchange",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Idempotency-Key": runtimeRequest.idempotencyKey,
				"test-service": "worker",
			},
			body: JSON.stringify(runtimeRequest),
		},
	);
	expect(runtimeReplay.status).toBe(200);
	const crossSubject = await app.request(
		"/internal/v1/files/runtime-exchange",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Idempotency-Key": runtimeRequest.idempotencyKey,
				"test-service": "worker",
			},
			body: JSON.stringify({ ...runtimeRequest, actorId: "other-actor" }),
		},
	);
	expect(crossSubject.status).toBe(404);
	store.seedExecution({ ...execution, sessionGeneration: 2 });
	const retired = await app.request("/internal/v1/files/runtime-exchange", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": "runtime-result-retired",
			"test-service": "worker",
		},
		body: JSON.stringify({
			...runtimeRequest,
			idempotencyKey: "runtime-result-retired",
		}),
	});
	expect(retired.status).toBe(404);
});
