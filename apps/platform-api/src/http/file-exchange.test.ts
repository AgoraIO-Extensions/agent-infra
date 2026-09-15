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
});
