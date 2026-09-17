import type { FileStoreV1 } from "./file-authority.js";

export interface FileObjectPageV1 {
	readonly objects: readonly {
		readonly objectRef: string;
		readonly version: string;
		readonly createdAt: string;
	}[];
	readonly cursor: string | null;
}
export interface FileReconciliationStorageV1 {
	scan(cursor: string | null, limit: number): Promise<FileObjectPageV1>;
	remove(objectRef: string, version: string): Promise<void>;
}
export interface FileReconciliationStoreV1 extends FileStoreV1 {
	expiredIntents(
		now: string,
		limit: number,
	): Promise<readonly { conversationId: string; fileId: string }[]>;
	findObject(
		objectRef: string,
	): Promise<{ conversationId: string; fileId: string } | null>;
	// A single durable checkpoint owner; a failed page retains its cursor for retry.
	checkpoint(
		work: (cursor: string | null) => Promise<string | null>,
	): Promise<boolean>;
}
export function createFileReconciliationV1(options: {
	store: FileReconciliationStoreV1;
	storage: FileReconciliationStorageV1;
	batchSize: number;
	orphanGraceMs: number;
	now?: () => Date;
}) {
	if (
		!Number.isSafeInteger(options.batchSize) ||
		options.batchSize < 1 ||
		options.batchSize > 100 ||
		!Number.isSafeInteger(options.orphanGraceMs) ||
		options.orphanGraceMs < 1
	)
		throw new Error("Invalid file reconciliation configuration");
	const now = options.now ?? (() => new Date());
	return {
		async runOnce() {
			return options.store.checkpoint(async (cursor) => {
				const instant = now();
				const expired = await options.store.expiredIntents(
					instant.toISOString(),
					options.batchSize,
				);
				for (const target of expired) {
					await options.store.transaction(target.conversationId, async (tx) => {
						const file = await tx.getFile(target.fileId);
						if (
							file?.status !== "pending" ||
							Date.parse(file.expiresAt) > instant.getTime()
						)
							return;
						await tx.putFile({
							...file,
							status: "expired",
							revision: file.revision + 1,
							updatedAt: instant.toISOString(),
						});
					});
				}
				const page = await options.storage.scan(cursor, options.batchSize);
				if (page.objects.length > options.batchSize)
					throw new Error("Invalid object reconciliation page");
				for (const object of page.objects) {
					const created = Date.parse(object.createdAt);
					if (
						!Number.isFinite(created) ||
						instant.getTime() - created < options.orphanGraceMs
					)
						continue;
					const target = await options.store.findObject(object.objectRef);
					if (!target) {
						await options.storage.remove(object.objectRef, object.version);
						continue;
					}
					const removable = await options.store.transaction(
						target.conversationId,
						async (tx) => {
							const file = await tx.getFile(target.fileId);
							if (
								!file ||
								file.objectRef !== object.objectRef ||
								!["expired", "failed", "deleting", "deleted"].includes(
									file.status,
								)
							)
								return false;
							if (file.status !== "deleted" && file.status !== "deleting")
								await tx.putFile({
									...file,
									status: "deleting",
									revision: file.revision + 1,
									updatedAt: instant.toISOString(),
								});
							return true;
						},
					);
					if (!removable) continue;
					await options.storage.remove(object.objectRef, object.version);
					await options.store.transaction(target.conversationId, async (tx) => {
						const file = await tx.getFile(target.fileId);
						if (file?.status === "deleting")
							await tx.putFile({
								...file,
								status: "deleted",
								revision: file.revision + 1,
								updatedAt: instant.toISOString(),
							});
					});
				}
				return page.cursor;
			});
		},
	};
}
