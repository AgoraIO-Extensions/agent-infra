import { generateKeyPairSync } from "node:crypto";
import {
	FileAccessResponseV1Schema,
	FileProjectionV1Schema,
} from "@agent-infra/contracts/files";
import { FakeObjectStorageV1 } from "@agent-infra/object-storage";
import { createFileAuthorityV1 } from "@agent-infra/platform-core";
import { FakeFileStoreV1 } from "@agent-infra/platform-core/testing";
import { expect, it } from "vitest";
import { createPlatformHealthApp } from "../app.ts";
import { createFileGrantCodecV1 } from "../file-grants.ts";
import { registerFileRoutesV1 } from "./file-routes.ts";

it("authenticates the same data URL for every use and never returns a storage bearer URL", async () => {
	const store = new FakeFileStoreV1();
	const storage = new FakeObjectStorageV1();
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const scope = {
		actorId: "alice",
		agentId: "agent",
		channelId: "web",
		conversationId: "conversation",
	};
	store.seedConversation(scope);
	let revoked = false;
	const service = createFileAuthorityV1({
		store,
		storage,
		intentTtlMs: 60000,
		accessTtlMs: 10000,
		issuer: "platform",
		keyVersion: "key-1",
	});
	const app = createPlatformHealthApp();
	registerFileRoutesV1(app, {
		service,
		storage,
		codec: createFileGrantCodecV1({
			issuer: "platform",
			keyVersion: "key-1",
			privateKey,
			publicKeys: new Map([["key-1", publicKey]]),
		}),
		authorization: (request) => ({
			authorize: async () =>
				revoked
					? null
					: {
							...scope,
							actorId: request.headers.get("test-actor") ?? "anonymous",
							execution: null,
							limits: {
								revision: "limits-1",
								expiresAt: "2099-01-01T00:00:00Z",
								mediaTypes: ["text/plain"],
								maxBytes: 20,
							},
						},
		}),
		maxConcurrentTransfers: 1,
	});
	const headers = {
		"test-actor": "alice",
		"Content-Type": "application/json",
		"Idempotency-Key": "upload-1",
	};
	const intent = await app.request("/api/v1/conversations/conversation/files", {
		method: "POST",
		headers,
		body: JSON.stringify({
			schemaVersion: 1,
			descriptor: {
				name: "hello.txt",
				mediaType: "text/plain",
				sizeBytes: 5,
				sha256:
					"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
			},
		}),
	});
	expect(intent.status).toBe(201);
	const file = FileProjectionV1Schema.parse(await intent.json());
	expect(Object.keys(file).sort()).toEqual([
		"createdAt",
		"descriptor",
		"expiresAt",
		"fileId",
		"kind",
		"schemaVersion",
		"status",
	]);
	const accessResponse = await app.request(
		`/api/v1/conversations/conversation/files/${file.fileId}/access`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({ schemaVersion: 1, operation: "write" }),
		},
	);
	expect(accessResponse.status).toBe(200);
	const access = FileAccessResponseV1Schema.parse(await accessResponse.json());
	expect(access.path).toMatch(/^\/api\/v1\//);
	const writeHeaders = {
		"test-actor": "alice",
		"X-Platform-File-Grant": access.grant.token,
		"Content-Type": "text/plain",
		"Content-Length": "5",
	};
	expect(
		(
			await app.request(access.path, {
				method: "PUT",
				headers: { ...writeHeaders, "test-actor": "bob" },
				body: "hello",
			})
		).status,
	).toBe(404);
	expect(
		(
			await app.request(access.path, {
				method: "PUT",
				headers: writeHeaders,
				body: "hello",
			})
		).status,
	).toBe(204);
	const inspect = storage.inspect.bind(storage);
	let releaseInspection = () => {};
	let enteredInspection = () => {};
	const hold = new Promise<void>((resolve) => {
		releaseInspection = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		enteredInspection = resolve;
	});
	storage.inspect = async (objectRef) => {
		enteredInspection();
		await hold;
		return inspect(objectRef);
	};
	const completing = app.request(
		`/api/v1/conversations/conversation/files/${file.fileId}/complete`,
		{
			method: "POST",
			headers: { ...headers, "X-Platform-File-Grant": access.grant.token },
			body: JSON.stringify({ schemaVersion: 1, accessId: access.accessId }),
		},
	);
	await entered;
	const rejected = await app.request(
		`/api/v1/conversations/conversation/files/${file.fileId}/complete`,
		{
			method: "POST",
			headers: { ...headers, "X-Platform-File-Grant": access.grant.token },
			body: JSON.stringify({ schemaVersion: 1, accessId: access.accessId }),
		},
	);
	releaseInspection();
	const complete = await completing;
	storage.inspect = inspect;
	expect(rejected.status).toBe(503);
	expect(complete.status).toBe(200);
	const readResponse = await app.request(
		`/api/v1/conversations/conversation/files/${file.fileId}/access`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({ schemaVersion: 1, operation: "read" }),
		},
	);
	const read = FileAccessResponseV1Schema.parse(await readResponse.json());
	const readHeaders = {
		"test-actor": "alice",
		"X-Platform-File-Grant": read.grant.token,
	};
	expect(
		await (await app.request(read.path, { headers: readHeaders })).text(),
	).toBe("hello");
	expect(
		(
			await app.request(read.path, {
				headers: { ...readHeaders, "test-actor": "bob" },
			})
		).status,
	).toBe(404);
	revoked = true;
	expect((await app.request(read.path, { headers: readHeaders })).status).toBe(
		404,
	);
});
