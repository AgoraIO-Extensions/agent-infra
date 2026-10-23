import { createHash, generateKeyPairSync } from "node:crypto";
import {
	FileAccessResponseV1Schema,
	FileProjectionV1Schema,
} from "@agent-infra/contracts/files";
import { FakeObjectStorageV1 } from "@agent-infra/object-storage";
import { createFileAuthorityV1 } from "@agent-infra/platform-core";
import { FakeFileStoreV1 } from "@agent-infra/platform-core/testing";
import { describe, expect, it } from "vitest";
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

/** #3257：按一组 FileLimits 走完 create → write access → content → complete，返回各步状态。 */
async function uploadThroughRoutes(
	mediaTypes: readonly string[],
	mediaType: string,
	bytes: Uint8Array,
) {
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
		authorization: () => ({
			authorize: async () => ({
				...scope,
				execution: null,
				limits: {
					revision: "limits-1",
					expiresAt: "2099-01-01T00:00:00Z",
					mediaTypes,
					maxBytes: 1024,
				},
			}),
		}),
		maxConcurrentTransfers: 1,
	});
	const headers = {
		"Content-Type": "application/json",
		"Idempotency-Key": "upload-1",
	};
	const root = "/api/v1/conversations/conversation/files";
	const intent = await app.request(root, {
		method: "POST",
		headers,
		body: JSON.stringify({
			schemaVersion: 1,
			descriptor: {
				name: "table.csv",
				mediaType,
				sizeBytes: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
		}),
	});
	if (intent.status !== 201) return { created: intent.status };
	const file = FileProjectionV1Schema.parse(await intent.json());
	const access = FileAccessResponseV1Schema.parse(
		await (
			await app.request(`${root}/${file.fileId}/access`, {
				method: "POST",
				headers,
				body: JSON.stringify({ schemaVersion: 1, operation: "write" }),
			})
		).json(),
	);
	const written = await app.request(access.path, {
		method: "PUT",
		headers: {
			"X-Platform-File-Grant": access.grant.token,
			"Content-Type": mediaType,
		},
		body: bytes,
	});
	const completed = await app.request(`${root}/${file.fileId}/complete`, {
		method: "POST",
		headers: { ...headers, "X-Platform-File-Grant": access.grant.token },
		body: JSON.stringify({ schemaVersion: 1, accessId: access.accessId }),
	});
	const record = await store.transaction("conversation", (tx) =>
		tx.getFile(file.fileId),
	);
	return {
		created: intent.status,
		written: written.status,
		completed: completed.status,
		record: record?.descriptor.mediaType,
		status: record?.status,
	};
}

describe("text subtype declarations (#3257)", () => {
	const csv = Buffer.from("名称,数量\n苹果,3\n");
	const png = Buffer.from(
		"89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
			"1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
		"hex",
	);

	it("AC-1: records a CSV upload as text/csv when FileLimits allow text/csv", async () => {
		expect(
			await uploadThroughRoutes(["text/csv"], "text/csv", csv),
		).toMatchObject({
			created: 201,
			written: 204,
			completed: 200,
			record: "text/csv",
			status: "available",
		});
	});

	it("AC-1: rejects CSV content that is not valid UTF-8 text", async () => {
		const result = await uploadThroughRoutes(
			["text/csv"],
			"text/csv",
			Buffer.from("c3fbb3c62cbafd0a", "hex"),
		);
		// 写入与完成确认都按实际字节拒绝，记录停留在 pending，不会成为可引用文件。
		expect(result).toEqual({
			created: 201,
			written: 409,
			completed: 409,
			record: "text/csv",
			status: "pending",
		});
	});

	it("rejects a text/csv declaration when FileLimits only allow text/plain", async () => {
		// CSV 规范化为 text/csv，不在 FileLimits 内；FileLimits 不会把 text/plain 扩展到子类型。
		expect(await uploadThroughRoutes(["text/plain"], "text/csv", csv)).toEqual({
			created: 404,
		});
		// 声明为 text/plain 的同一字节仍按字节识别记为 text/plain。
		expect(
			await uploadThroughRoutes(["text/plain"], "text/plain", csv),
		).toMatchObject({ completed: 200, record: "text/plain" });
	});

	it.each([
		["a subtype outside the platform whitelist", "text/x-python", csv],
		["a text/csv declaration over PNG bytes", "text/csv", png],
	] as const)(
		"AC-2: rejects %s even when FileLimits list it",
		async (_label, mediaType, bytes) => {
			expect(await uploadThroughRoutes([mediaType], mediaType, bytes)).toEqual({
				created: 201,
				written: 409,
				completed: 409,
				record: mediaType,
				status: "pending",
			});
		},
	);
});
