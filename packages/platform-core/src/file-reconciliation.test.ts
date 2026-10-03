import { expect, it } from "vitest";
import { FakeFileStoreV1 } from "./fake-file-store.ts";
import { createFileAuthorityV1 } from "./file-authority.ts";
import { createFileReconciliationV1 } from "./file-reconciliation.ts";

it("retries failed cleanup from its checkpoint and never deletes confirmed history", async () => {
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
		accessTtlMs: 500,
		issuer: "platform",
		keyVersion: "key",
		storage: {
			inspect: async () => ({
				...descriptor,
				etag: "etag",
				version: "version",
			}),
		},
	});
	const authorization = {
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
	const expired = await service.createUpload(
		{
			conversationId: scope.conversationId,
			descriptor,
			idempotencyKey: "expired",
		},
		authorization,
	);
	const valid = await service.createUpload(
		{
			conversationId: scope.conversationId,
			descriptor,
			idempotencyKey: "valid",
		},
		authorization,
	);
	const access = await service.issueAccess(
		{
			conversationId: scope.conversationId,
			fileId: valid.fileId,
			operation: "write",
			idempotencyKey: "access",
		},
		authorization,
	);
	await service.complete(
		{
			conversationId: scope.conversationId,
			fileId: valid.fileId,
			accessId: access.accessId,
		},
		authorization,
	);
	instant = new Date("2026-09-15T00:01:00Z");
	const removed: string[] = [];
	const cursors: (string | null)[] = [];
	let fail = true;
	const reconciliation = createFileReconciliationV1({
		store,
		now: () => instant,
		batchSize: 3,
		orphanGraceMs: 1000,
		storage: {
			scan: async (cursor) => {
				cursors.push(cursor);
				return {
					cursor: "next",
					objects: [expired.objectRef, valid.objectRef, "orphan"].map(
						(objectRef) => ({
							objectRef,
							version: "version",
							createdAt: "2026-09-15T00:00:00Z",
						}),
					),
				};
			},
			remove: async (objectRef) => {
				if (fail) {
					fail = false;
					throw new Error("temporary outage");
				}
				removed.push(objectRef);
			},
		},
	});
	await expect(reconciliation.runOnce()).rejects.toThrow("temporary outage");
	await expect(
		service.getFile(
			{ conversationId: scope.conversationId, fileId: expired.fileId },
			authorization,
		),
	).resolves.toMatchObject({ status: "deleting" });
	await reconciliation.runOnce();
	expect(cursors).toEqual([null, null]);
	expect(removed).toEqual([expired.objectRef, "orphan"]);
	expect(
		await service.getFile(
			{ conversationId: scope.conversationId, fileId: valid.fileId },
			authorization,
		),
	).toMatchObject({ status: "available" });
	expect(
		await service.getFile(
			{ conversationId: scope.conversationId, fileId: expired.fileId },
			authorization,
		),
	).toMatchObject({ status: "deleted" });
	// A late write at a tombstoned reference is removed by a later sweep as well.
	await reconciliation.runOnce();
	expect(cursors.at(-1)).toBe("next");
	expect(removed.filter((ref) => ref === expired.objectRef)).toHaveLength(2);
});
