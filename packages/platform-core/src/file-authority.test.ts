import { expect, it } from "vitest";
import { FakeFileStoreV1 } from "./fake-file-store.ts";
import {
	bindInputFileV1,
	bindNativeTextInputFileV1,
	createFileAuthorityV1,
	type FileLimitsV1,
	type FileRecordV1,
	type FileScopeV1,
	isConfirmedResultFileV1,
	nativeTextInputLimitV1,
	resolveNativeTextInputsV1,
} from "./file-authority.ts";

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
		deliveryFence: 1,
		authorizationRevision: "auth-1",
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
	store.seedExecution({
		...scope,
		executionId: "execution",
		sessionGeneration: 1,
		deliveryFence: 1,
		authorizationRevision: "auth-1",
		status: "waiting",
		stopPending: false,
	});
	await expect(
		service.issueAccess(
			{ ...accessRequest, idempotencyKey: "waiting-access" },
			authorization,
		),
	).rejects.toMatchObject({ code: "denied" });
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
		deliveryFence: 1,
		authorizationRevision: "auth-1",
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

it("records the result workspace reference once and rejects a replay with another reference (#3226)", async () => {
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
		deliveryFence: 1,
		authorizationRevision: "auth-1",
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
	const authorization = {
		authorize: async () => ({
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
		}),
	};
	const descriptor = {
		name: "hello.txt",
		mediaType: "text/plain",
		sizeBytes: 5,
		sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
	};
	const referenced = await service.createResult(
		{
			conversationId: scope.conversationId,
			idempotencyKey: "result-referenced",
			descriptor,
			workspaceReference: "out/hello.txt",
		},
		authorization,
	);
	expect(referenced.workspaceReference).toBe("out/hello.txt");
	expect(
		await service.createResult(
			{
				conversationId: scope.conversationId,
				idempotencyKey: "result-referenced",
				descriptor,
				workspaceReference: "out/hello.txt",
			},
			authorization,
		),
	).toEqual(referenced);
	for (const workspaceReference of ["out/other.txt", null, undefined])
		await expect(
			service.createResult(
				{
					conversationId: scope.conversationId,
					idempotencyKey: "result-referenced",
					descriptor,
					...(workspaceReference === undefined ? {} : { workspaceReference }),
				},
				authorization,
			),
		).rejects.toMatchObject({ code: "conflict" });
	const unreferenced = await service.createResult(
		{
			conversationId: scope.conversationId,
			idempotencyKey: "result-null",
			descriptor,
			workspaceReference: null,
		},
		authorization,
	);
	expect(unreferenced.workspaceReference).toBeNull();
	// 旧调用方省略该字段时记录保持原形状。
	const legacy = await service.createResult(
		{
			conversationId: scope.conversationId,
			idempotencyKey: "result-legacy",
			descriptor,
		},
		authorization,
	);
	expect(legacy).not.toHaveProperty("workspaceReference");
	for (const workspaceReference of [
		"",
		"/out/hello.txt",
		"out/../hello.txt",
		"out//hello.txt",
		"out\\hello.txt",
		"a".repeat(1025),
	])
		await expect(
			service.createResult(
				{
					conversationId: scope.conversationId,
					idempotencyKey: "result-invalid",
					descriptor,
					workspaceReference,
				},
				authorization,
			),
		).rejects.toMatchObject({ code: "invalid" });
	// 附件意图不能携带工作区引用。
	await expect(
		service.createUpload(
			{
				conversationId: scope.conversationId,
				idempotencyKey: "upload-referenced",
				descriptor,
				workspaceReference: "out/hello.txt",
			} as Parameters<typeof service.createUpload>[0],
			authorization,
		),
	).rejects.toMatchObject({ code: "invalid" });
});

it("confirms a result.file only when its workspace reference matches the file record (#3226)", () => {
	const scope = {
		actorId: "alice",
		agentId: "agent",
		conversationId: "conversation",
		channelId: "web",
	};
	const execution = {
		...scope,
		executionId: "execution",
		sessionGeneration: 1,
	};
	const record = {
		...scope,
		fileId: "file-1",
		kind: "result",
		executionId: "execution",
		sessionGeneration: 1,
		status: "available",
		objectVersion: "version-1",
		etag: "etag-1",
		descriptor: {
			name: "chart.png",
			mediaType: "image/png",
			sizeBytes: 2,
			sha256: "a".repeat(64),
		},
	} as unknown as FileRecordV1;
	const event = {
		fileId: "file-1",
		name: "chart.png",
		mediaType: "image/png",
		sizeBytes: 2,
	};
	const referenced = { ...record, workspaceReference: "out/chart.png" };
	expect(
		isConfirmedResultFileV1(referenced, execution, {
			...event,
			workspaceReference: "out/chart.png",
		}),
	).toBe(true);
	for (const workspaceReference of ["out/other.png", null, undefined])
		expect(
			isConfirmedResultFileV1(referenced, execution, {
				...event,
				...(workspaceReference === undefined ? {} : { workspaceReference }),
			}),
		).toBe(false);
	// 旧记录、null 记录与 V1 事件及 null 事件互相等价。
	for (const file of [record, { ...record, workspaceReference: null }]) {
		expect(isConfirmedResultFileV1(file, execution, event)).toBe(true);
		expect(
			isConfirmedResultFileV1(file, execution, {
				...event,
				workspaceReference: null,
			}),
		).toBe(true);
		expect(
			isConfirmedResultFileV1(file, execution, {
				...event,
				workspaceReference: "out/chart.png",
			}),
		).toBe(false);
	}
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
		deliveryFence: 1,
		authorizationRevision: "auth-1",
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
		deliveryFence: 1,
		authorizationRevision: "auth-1",
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

const nativeScope: FileScopeV1 = {
	actorId: "native-actor",
	agentId: "native-agent",
	channelId: "web",
	conversationId: "native-conversation",
};

const nativeNow = new Date("2026-10-13T00:00:00.000Z");

const nativeLimits: FileLimitsV1 = {
	revision: "native-limits",
	expiresAt: "2099-01-01T00:00:00Z",
	maxBytes: nativeTextInputLimitV1.maxBytes,
	mediaTypes: [nativeTextInputLimitV1.mediaType],
};

function nativeRecord(
	fileId: string,
	overrides: Partial<FileRecordV1> = {},
): FileRecordV1 {
	return {
		...nativeScope,
		fileId,
		objectRef: `object-${fileId}`,
		kind: "attachment",
		idempotencyKey: `intent-${fileId}`,
		descriptor: {
			name: `${fileId}.txt`,
			mediaType: "text/plain",
			sizeBytes: 5,
			sha256: "a".repeat(64),
		},
		status: "available",
		executionId: null,
		messageId: null,
		sessionGeneration: null,
		objectVersion: "version-1",
		etag: "etag-1",
		createdAt: "2026-10-13T00:00:00.000Z",
		expiresAt: "2099-01-01T00:00:00Z",
		updatedAt: "2026-10-13T00:00:00.000Z",
		revision: 1,
		...overrides,
	};
}

it("binds native text inputs once to an Execution and resolves ordered facts", () => {
	const first = nativeRecord("native-a");
	const second = nativeRecord("native-b");
	const bound = bindNativeTextInputFileV1(
		first,
		nativeScope,
		{ executionId: "execution", sessionGeneration: 1 },
		nativeNow,
	);
	expect(bound).toMatchObject({
		fileId: "native-a",
		messageId: null,
		executionId: "execution",
		sessionGeneration: 1,
		revision: 2,
	});
	expect(() =>
		bindNativeTextInputFileV1(
			bound,
			nativeScope,
			{ executionId: "other-execution", sessionGeneration: 1 },
			nativeNow,
		),
	).toThrow();
	expect(() =>
		bindNativeTextInputFileV1(
			bindInputFileV1(
				second,
				nativeScope,
				{
					messageId: "message",
					executionId: "execution",
					sessionGeneration: 1,
				},
				nativeNow,
			),
			nativeScope,
			{ executionId: "execution-2", sessionGeneration: 1 },
			nativeNow,
		),
	).toThrow();
	expect(
		resolveNativeTextInputsV1(
			[nativeRecord("native-b"), first],
			nativeScope,
			nativeLimits,
			nativeNow,
		),
	).toEqual([
		{
			fileId: "native-b",
			sha256: "a".repeat(64),
			byteLength: 5,
			mediaType: "text/plain",
		},
		{
			fileId: "native-a",
			sha256: "a".repeat(64),
			byteLength: 5,
			mediaType: "text/plain",
		},
	]);
});

it.each([
	{ label: "foreign actor", overrides: { actorId: "other" } },
	{ label: "foreign agent", overrides: { agentId: "other" } },
	{ label: "foreign channel", overrides: { channelId: "other" } },
	{ label: "foreign conversation", overrides: { conversationId: "other" } },
	{ label: "unavailable input", overrides: { status: "pending" as const } },
	{
		label: "non-text input",
		overrides: {
			descriptor: {
				name: "a.png",
				mediaType: "image/png",
				sizeBytes: 5,
				sha256: "a".repeat(64),
			},
		},
	},
	{
		label: "oversize input",
		overrides: {
			descriptor: {
				name: "a.txt",
				mediaType: "text/plain",
				sizeBytes: nativeTextInputLimitV1.maxBytes + 1,
				sha256: "a".repeat(64),
			},
		},
	},
	{ label: "message-bound input", overrides: { messageId: "message" } },
	{
		label: "execution-bound input",
		overrides: { executionId: "execution", sessionGeneration: 1 },
	},
])("refuses to bind a $label", ({ overrides }) => {
	expect(() =>
		bindNativeTextInputFileV1(
			nativeRecord("native-invalid", overrides as Partial<FileRecordV1>),
			nativeScope,
			{ executionId: "execution", sessionGeneration: 1 },
			nativeNow,
		),
	).toThrow();
});

it.each([
	{ label: "missing input", inputs: [null] },
	{
		label: "five inputs",
		inputs: ["a", "b", "c", "d", "e"].map((id) => nativeRecord(id)),
	},
	{
		label: "duplicate input",
		inputs: [nativeRecord("a"), nativeRecord("a")],
	},
	{
		label: "no FileLimits",
		inputs: [nativeRecord("a")],
		limits: null,
	},
	{
		label: "media type not allowed",
		inputs: [nativeRecord("a")],
		limits: { ...nativeLimits, mediaTypes: ["image/png"] },
	},
	{
		label: "byte limit below the file",
		inputs: [nativeRecord("a")],
		limits: { ...nativeLimits, maxBytes: 1 },
	},
])("refuses to resolve $label", ({ inputs, limits }) => {
	expect(() =>
		resolveNativeTextInputsV1(
			inputs,
			nativeScope,
			limits === undefined ? nativeLimits : limits,
			nativeNow,
		),
	).toThrow();
});

it("authorizes Execution-scoped input reads only for the bound Execution and generation", async () => {
	const store = new FakeFileStoreV1();
	store.seedConversation(nativeScope);
	store.seedExecution({
		...nativeScope,
		executionId: "execution",
		sessionGeneration: 1,
		deliveryFence: 1,
		authorizationRevision: "revision-1",
		status: "processing",
		stopPending: false,
	});
	const service = createFileAuthorityV1({
		store,
		now: () => nativeNow,
		intentTtlMs: 60000,
		accessTtlMs: 10000,
		issuer: "platform",
		keyVersion: "key",
		storage: {
			inspect: async () => ({
				name: "input.txt",
				mediaType: "text/plain",
				sizeBytes: 5,
				sha256: "a".repeat(64),
				version: "version",
				etag: "etag",
			}),
		},
	});
	const authorization = {
		authorize: async () => ({
			...nativeScope,
			limits: nativeLimits,
			execution: null,
		}),
	};
	const created = await service.createUpload(
		{
			conversationId: nativeScope.conversationId,
			idempotencyKey: "native-upload",
			descriptor: {
				name: "input.txt",
				mediaType: "text/plain",
				sizeBytes: 5,
				sha256: "a".repeat(64),
			},
		},
		authorization,
	);
	const write = {
		conversationId: nativeScope.conversationId,
		fileId: created.fileId,
		operation: "write" as const,
		idempotencyKey: "native-write",
	};
	const issued = await service.issueAccess(write, authorization);
	await service.complete(
		{ ...write, accessId: issued.accessId },
		authorization,
	);
	await store.transaction(nativeScope.conversationId, async (tx) => {
		await tx.putFile(
			bindNativeTextInputFileV1(
				await tx.getFile(created.fileId),
				nativeScope,
				{ executionId: "execution", sessionGeneration: 1 },
				nativeNow,
			),
		);
	});
	const executionAuthority = {
		authorize: async () => ({
			...nativeScope,
			limits: nativeLimits,
			execution: {
				executionId: "execution",
				sessionGeneration: 1,
				grantId: "grant",
				attachments: [created.fileId],
				expiresAt: "2099-01-01T00:00:00Z",
			},
		}),
	};
	const read = {
		conversationId: nativeScope.conversationId,
		fileId: created.fileId,
		operation: "read" as const,
		idempotencyKey: "native-read",
	};
	const access = await service.issueAccess(read, executionAuthority);
	await expect(
		service.authorizeAccess(
			{ ...read, accessId: access.accessId },
			executionAuthority,
		),
	).resolves.toMatchObject({ file: { fileId: created.fileId } });
	for (const [label, execution] of Object.entries({
		"another Execution": {
			executionId: "execution-2",
			sessionGeneration: 1,
			grantId: "grant-2",
			attachments: [created.fileId],
			expiresAt: "2099-01-01T00:00:00Z",
		},
		"another Session generation": {
			executionId: "execution",
			sessionGeneration: 2,
			grantId: "grant-3",
			attachments: [created.fileId],
			expiresAt: "2099-01-01T00:00:00Z",
		},
		"a revoked Grant": {
			executionId: "execution",
			sessionGeneration: 1,
			grantId: "grant-4",
			attachments: [],
			expiresAt: "2099-01-01T00:00:00Z",
		},
	})) {
		await expect(
			service.issueAccess(
				{ ...read, idempotencyKey: `denied-${label}` },
				{
					authorize: async () => ({
						...nativeScope,
						limits: nativeLimits,
						execution,
					}),
				},
			),
		).rejects.toMatchObject({ code: "denied" });
	}
});
