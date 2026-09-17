import { expect, it } from "vitest";
import { FakeFileStoreV1 } from "./fake-file-store.ts";
import { createFileAuthorityV1 } from "./file-authority.ts";

it("reserves one immutable upload intent and rejects conflicting replay", async () => {
	const store = new FakeFileStoreV1();
	const scope = {
		actorId: "alice",
		agentId: "agent",
		conversationId: "conversation",
		channelId: "web",
	};
	store.seedConversation(scope);
	const authority = createFileAuthorityV1({
		store,
		now: () => new Date("2026-09-15T00:00:00Z"),
		intentTtlMs: 60000,
		accessTtlMs: 10000,
		issuer: "platform",
		keyVersion: "key-1",
		storage: { inspect: async () => null },
	});
	const authorization = {
		authorize: async () => ({
			...scope,
			execution: null,
			limits: {
				revision: "verified-1",
				expiresAt: "2026-09-15T01:00:00Z",
				mediaTypes: ["text/plain"],
				maxBytes: 20,
			},
		}),
	};
	const request = {
		conversationId: "conversation",
		idempotencyKey: "upload-1",
		descriptor: {
			name: "hello.txt",
			mediaType: "text/plain",
			sizeBytes: 5,
			sha256:
				"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		},
	};
	const first = await authority.createUpload(request, authorization);
	expect(first.status).toBe("pending");
	expect(await authority.createUpload(request, authorization)).toEqual(first);
	await expect(
		authority.createUpload(
			{
				...request,
				descriptor: { ...request.descriptor, name: "changed.txt" },
			},
			authorization,
		),
	).rejects.toMatchObject({ code: "conflict" });
});

it("authorizes a single pending object and exposes it only after actual object confirmation", async () => {
	const store = new FakeFileStoreV1();
	const scope = {
		actorId: "alice",
		agentId: "agent",
		conversationId: "conversation",
		channelId: "web",
	};
	store.seedConversation(scope);
	let instant = new Date("2026-09-15T00:00:00Z");
	let object: {
		sizeBytes: number;
		mediaType: string;
		sha256: string;
		etag: string;
		version: string;
	} | null = null;
	const service = createFileAuthorityV1({
		store,
		now: () => instant,
		intentTtlMs: 60000,
		accessTtlMs: 10000,
		issuer: "platform",
		keyVersion: "key-1",
		storage: { inspect: async () => object },
	});
	const authorization = {
		authorize: async () => ({
			...scope,
			execution: null,
			limits: {
				revision: "verified-1",
				expiresAt: "2026-09-15T01:00:00Z",
				mediaTypes: ["text/plain"],
				maxBytes: 20,
			},
		}),
	};
	const file = await service.createUpload(
		{
			conversationId: scope.conversationId,
			idempotencyKey: "upload-1",
			descriptor: {
				name: "hello.txt",
				mediaType: "text/plain",
				sizeBytes: 5,
				sha256:
					"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
			},
		},
		authorization,
	);
	const request = {
		conversationId: scope.conversationId,
		fileId: file.fileId,
		operation: "write" as const,
		idempotencyKey: "access-1",
	};
	const access = await service.issueAccess(request, authorization);
	await expect(
		service.complete({ ...request, accessId: access.accessId }, authorization),
	).rejects.toMatchObject({ code: "conflict" });
	object = {
		sizeBytes: 5,
		mediaType: "text/plain",
		sha256: file.descriptor.sha256,
		etag: "etag-1",
		version: "version-1",
	};
	const confirmed = await service.complete(
		{ ...request, accessId: access.accessId },
		authorization,
	);
	expect(confirmed.status).toBe("available");
	expect(
		await service.complete(
			{ ...request, accessId: access.accessId },
			authorization,
		),
	).toEqual(confirmed);
	await expect(
		service.authorizeAccess(
			{ ...request, accessId: access.accessId },
			authorization,
		),
	).rejects.toMatchObject({ code: "denied" });
	instant = new Date("2026-09-15T00:00:11Z");
	await expect(
		service.complete({ ...request, accessId: access.accessId }, authorization),
	).rejects.toMatchObject({ code: "denied" });
});

it("allocates one result for the trusted execution and denies stale generation and owner access", async () => {
	const store = new FakeFileStoreV1();
	const scope = {
		actorId: "alice",
		agentId: "agent",
		conversationId: "conversation",
		channelId: "web",
	};
	store.seedConversation(scope);
	store.seedExecution({
		...scope,
		executionId: "execution",
		sessionGeneration: 1,
		status: "processing",
		stopPending: false,
	});
	const service = createFileAuthorityV1({
		store,
		now: () => new Date("2026-09-15T00:00:00Z"),
		intentTtlMs: 60000,
		accessTtlMs: 10000,
		issuer: "platform",
		keyVersion: "key-1",
		storage: { inspect: async () => null },
	});
	const trusted = {
		...scope,
		execution: {
			executionId: "execution",
			sessionGeneration: 1,
			grantId: "grant",
			attachments: [],
			expiresAt: "2026-09-15T00:00:05Z",
		},
		limits: {
			revision: "verified-1",
			expiresAt: "2026-09-15T01:00:00Z",
			mediaTypes: ["text/plain"],
			maxBytes: 20,
		},
	};
	const authorization = { authorize: async () => trusted };
	const request = {
		conversationId: scope.conversationId,
		idempotencyKey: "result-1",
		descriptor: {
			name: "hello.txt",
			mediaType: "text/plain",
			sizeBytes: 5,
			sha256:
				"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		},
	};
	const file = await service.createResult(request, authorization);
	expect(file.executionId).toBe("execution");
	expect(await service.createResult(request, authorization)).toEqual(file);
	const accessRequest = {
		conversationId: scope.conversationId,
		fileId: file.fileId,
		operation: "write" as const,
		idempotencyKey: "access-1",
	};
	const access = await service.issueAccess(accessRequest, authorization);
	expect(access.expiresAt).toBe("2026-09-15T00:00:05.000Z");
	await expect(
		service.issueAccess(accessRequest, {
			authorize: async () => ({
				...trusted,
				actorId: "agent-owner",
				execution: null,
			}),
		}),
	).rejects.toMatchObject({ code: "denied" });
	store.seedExecution({
		...scope,
		executionId: "execution",
		sessionGeneration: 2,
		status: "processing",
		stopPending: false,
	});
	await expect(
		service.authorizeAccess(
			{ ...accessRequest, accessId: access.accessId },
			authorization,
		),
	).rejects.toMatchObject({ code: "denied" });
});

it("does not permit another actor, Agent, Channel or Conversation to use a file access reference", async () => {
	const store = new FakeFileStoreV1();
	const scope = {
		actorId: "alice",
		agentId: "agent",
		conversationId: "conversation",
		channelId: "web",
	};
	store.seedConversation(scope);
	const service = createFileAuthorityV1({
		store,
		now: () => new Date("2026-09-15T00:00:00Z"),
		intentTtlMs: 60000,
		accessTtlMs: 10000,
		issuer: "platform",
		keyVersion: "key-1",
		storage: { inspect: async () => null },
	});
	const trusted = {
		...scope,
		execution: null,
		limits: {
			revision: "verified-1",
			expiresAt: "2026-09-15T01:00:00Z",
			mediaTypes: ["text/plain"],
			maxBytes: 20,
		},
	};
	const authorization = { authorize: async () => trusted };
	const file = await service.createUpload(
		{
			conversationId: scope.conversationId,
			idempotencyKey: "upload-1",
			descriptor: {
				name: "hello.txt",
				mediaType: "text/plain",
				sizeBytes: 5,
				sha256:
					"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
			},
		},
		authorization,
	);
	const request = {
		conversationId: scope.conversationId,
		fileId: file.fileId,
		operation: "write" as const,
		idempotencyKey: "access-1",
	};
	const access = await service.issueAccess(request, authorization);
	for (const key of [
		"actorId",
		"agentId",
		"channelId",
		"conversationId",
	] as const) {
		await expect(
			service.authorizeAccess(
				{ ...request, accessId: access.accessId },
				{ authorize: async () => ({ ...trusted, [key]: "other" }) },
			),
		).rejects.toMatchObject({ code: "denied" });
	}
	await expect(
		service.authorizeAccess(
			{ ...request, accessId: access.accessId },
			{ authorize: async () => null },
		),
	).rejects.toMatchObject({ code: "denied" });
});

it("replays an access issuance by its idempotency key without minting another authorization", async () => {
	const store = new FakeFileStoreV1();
	const scope = {
		actorId: "alice",
		agentId: "agent",
		conversationId: "conversation",
		channelId: "web",
	};
	store.seedConversation(scope);
	const service = createFileAuthorityV1({
		store,
		now: () => new Date("2026-09-15T00:00:00Z"),
		intentTtlMs: 60000,
		accessTtlMs: 10000,
		issuer: "platform",
		keyVersion: "key-1",
		storage: { inspect: async () => null },
	});
	const authorization = {
		authorize: async () => ({
			...scope,
			execution: null,
			limits: {
				revision: "verified-1",
				expiresAt: "2026-09-15T01:00:00Z",
				mediaTypes: ["text/plain"],
				maxBytes: 20,
			},
		}),
	};
	const file = await service.createUpload(
		{
			conversationId: scope.conversationId,
			idempotencyKey: "upload-1",
			descriptor: {
				name: "hello.txt",
				mediaType: "text/plain",
				sizeBytes: 5,
				sha256:
					"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
			},
		},
		authorization,
	);
	const request = {
		conversationId: scope.conversationId,
		fileId: file.fileId,
		operation: "write" as const,
		idempotencyKey: "access-1",
	};
	expect(await service.issueAccess(request, authorization)).toEqual(
		await service.issueAccess(request, authorization),
	);
});

it("reissues access for the same intent after access expiry without reopening completed bytes", async () => {
	const store = new FakeFileStoreV1();
	const scope = {
		actorId: "alice",
		agentId: "agent",
		channelId: "web",
		conversationId: "conversation",
	};
	store.seedConversation(scope);
	let instant = new Date("2026-09-15T00:00:00Z");
	const descriptor = {
		name: "fixture.txt",
		mediaType: "text/plain",
		sizeBytes: 5,
		sha256: "0".repeat(64),
	};
	const service = createFileAuthorityV1({
		store,
		now: () => instant,
		intentTtlMs: 1000,
		accessTtlMs: 100,
		issuer: "platform",
		keyVersion: "key",
		storage: {
			inspect: async () => ({
				...descriptor,
				version: "version",
				etag: "etag",
			}),
		},
	});
	const auth = {
		authorize: async () => ({
			...scope,
			execution: null,
			limits: {
				revision: "limits",
				expiresAt: "2099-01-01T00:00:00Z",
				maxBytes: 10,
				mediaTypes: ["text/plain"],
			},
		}),
	};
	const intent = {
		conversationId: scope.conversationId,
		descriptor,
		idempotencyKey: "intent",
	};
	const file = await service.createUpload(intent, auth);
	const request = {
		conversationId: scope.conversationId,
		fileId: file.fileId,
		operation: "write" as const,
		idempotencyKey: "attempt-1",
	};
	const first = await service.issueAccess(request, auth);
	await service.complete({ ...request, accessId: first.accessId }, auth);
	instant = new Date("2026-09-15T00:00:02Z");
	const replay = await service.createUpload(intent, auth);
	expect(replay.fileId).toBe(file.fileId);
	expect(replay.objectRef).toBe(file.objectRef);
	const renewed = await service.issueAccess(
		{ ...request, idempotencyKey: "attempt-2" },
		auth,
	);
	expect(
		(await service.complete({ ...request, accessId: renewed.accessId }, auth))
			.status,
	).toBe("available");
	await expect(
		service.authorizeAccess({ ...request, accessId: renewed.accessId }, auth),
	).rejects.toMatchObject({ code: "denied" });
});

it("applies current limits to delegated inputs while preserving authorized user history", async () => {
	const { bindInputFileV1 } = await import("./file-authority.ts");
	const store = new FakeFileStoreV1();
	const scope = {
		actorId: "alice",
		agentId: "agent",
		channelId: "web",
		conversationId: "conversation",
	};
	store.seedConversation(scope);
	store.seedExecution({
		...scope,
		executionId: "execution",
		sessionGeneration: 1,
		status: "processing",
		stopPending: false,
	});
	const descriptor = {
		name: "fixture.txt",
		mediaType: "text/plain",
		sizeBytes: 5,
		sha256: "0".repeat(64),
	};
	const service = createFileAuthorityV1({
		store,
		intentTtlMs: 60000,
		accessTtlMs: 10000,
		issuer: "platform",
		keyVersion: "key",
		storage: {
			inspect: async () => ({
				...descriptor,
				version: "version",
				etag: "etag",
			}),
		},
	});
	let limits = {
		revision: "limits",
		expiresAt: "2099-01-01T00:00:00Z",
		maxBytes: 10,
		mediaTypes: ["text/plain"],
	};
	const auth = {
		authorize: async () => ({ ...scope, execution: null, limits }),
	};
	const file = await service.createUpload(
		{
			conversationId: scope.conversationId,
			descriptor,
			idempotencyKey: "input",
		},
		auth,
	);
	const request = {
		conversationId: scope.conversationId,
		fileId: file.fileId,
		operation: "write" as const,
		idempotencyKey: "write",
	};
	const write = await service.issueAccess(request, auth);
	await service.complete({ ...request, accessId: write.accessId }, auth);
	await service.authorizeInputs(scope.conversationId, [file.fileId], auth);
	limits = { ...limits, maxBytes: 1 };
	await expect(
		service.authorizeInputs(scope.conversationId, [file.fileId], auth),
	).rejects.toMatchObject({ code: "denied" });
	limits = { ...limits, maxBytes: 10, mediaTypes: ["image/png"] };
	await expect(
		service.authorizeInputs(scope.conversationId, [file.fileId], auth),
	).rejects.toMatchObject({ code: "denied" });
	limits = { ...limits, mediaTypes: ["text/plain"] };
	await store.transaction(scope.conversationId, async (tx) => {
		const file = await tx.getFile(request.fileId);
		await tx.putFile(
			bindInputFileV1(
				file,
				scope,
				{
					messageId: "message",
					executionId: "execution",
					sessionGeneration: 1,
				},
				new Date(),
			),
		);
	});
	const delegated = {
		authorize: async () => ({
			...scope,
			limits,
			execution: {
				executionId: "execution",
				sessionGeneration: 1,
				grantId: "grant",
				attachments: [file.fileId],
				expiresAt: "2099-01-01T00:00:00Z",
			},
		}),
	};
	const read = {
		...request,
		operation: "read" as const,
		idempotencyKey: "read",
	};
	const access = await service.issueAccess(read, delegated);
	limits = { ...limits, maxBytes: 1 };
	await expect(
		service.authorizeAccess({ ...read, accessId: access.accessId }, delegated),
	).rejects.toMatchObject({ code: "denied" });
	expect(
		(await service.issueAccess({ ...read, idempotencyKey: "history" }, auth))
			.execution,
	).toBeNull();
	limits = { ...limits, maxBytes: 10 };
	store.seedConversation(scope, 2);
	store.seedExecution({
		...scope,
		executionId: "regenerated",
		sessionGeneration: 2,
		status: "processing",
		stopPending: false,
	});
	const regenerated = {
		authorize: async () => ({
			...scope,
			limits,
			execution: {
				executionId: "regenerated",
				sessionGeneration: 2,
				grantId: "new-grant",
				attachments: [file.fileId],
				expiresAt: "2099-01-01T00:00:00Z",
			},
		}),
	};
	expect(
		(
			await service.issueAccess(
				{ ...read, idempotencyKey: "regenerated" },
				regenerated,
			)
		).execution?.executionId,
	).toBe("regenerated");
	expect(
		await service.getFile(
			{ conversationId: scope.conversationId, fileId: file.fileId },
			auth,
		),
	).toMatchObject({
		executionId: "execution",
		sessionGeneration: 1,
		messageId: "message",
	});
	await expect(
		service.authorizeAccess({ ...read, accessId: access.accessId }, delegated),
	).rejects.toMatchObject({ code: "denied" });
	await expect(
		service.issueAccess(
			{ ...read, idempotencyKey: "unlisted" },
			{
				authorize: async () => {
					const value = await regenerated.authorize();
					return {
						...value,
						execution: { ...value.execution, attachments: [] },
					};
				},
			},
		),
	).rejects.toMatchObject({ code: "denied" });
});
