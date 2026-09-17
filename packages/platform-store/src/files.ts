import {
	FileAuthorityError,
	type FileStoreV1,
	type FileTransactionV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
	conversationExecutions,
	conversationStops,
	conversations,
	platformFileAccesses,
	platformFiles,
} from "./schema.js";

export class PostgresFileStoreV1 implements FileStoreV1 {
	private readonly client;
	private readonly database;
	constructor(databaseUrl: string) {
		this.client = postgres(databaseUrl, { max: 4 });
		this.database = drizzle(this.client);
	}
	async transaction<T>(
		conversationId: string,
		work: (transaction: FileTransactionV1) => Promise<T>,
	): Promise<T> {
		try {
			return await this.database.transaction(async (tx) => {
				const [conversation] = await tx
					.select({
						conversationId: conversations.id,
						agentId: conversations.agentId,
						actorId: conversations.actorId,
						channelId: conversations.channelId,
						sessionGeneration: conversations.sessionGeneration,
					})
					.from(conversations)
					.where(eq(conversations.id, conversationId))
					.for("update");
				const readFile = async (fileId: string) => {
					const [row] = await tx
						.select()
						.from(platformFiles)
						.where(
							and(
								eq(platformFiles.fileId, fileId),
								eq(platformFiles.conversationId, conversationId),
							),
						);
					return row?.record ?? null;
				};
				return work({
					conversation: conversation ?? null,
					async getExecution(executionId) {
						const [row] = await tx
							.select()
							.from(conversationExecutions)
							.where(
								and(
									eq(conversationExecutions.executionId, executionId),
									eq(conversationExecutions.conversationId, conversationId),
								),
							)
							.for("update");
						if (!row) return null;
						const [stop] = await tx
							.select()
							.from(conversationStops)
							.where(eq(conversationStops.executionId, executionId));
						return {
							agentId: row.agentId,
							actorId: row.actorId,
							channelId: row.channelId,
							conversationId: row.conversationId,
							executionId: row.executionId,
							sessionGeneration: row.sessionGeneration,
							status: row.status,
							stopPending: stop?.status === "submitted",
						};
					},
					async getIntent(actorId, key) {
						const [row] = await tx
							.select()
							.from(platformFiles)
							.where(
								and(
									eq(platformFiles.actorId, actorId),
									eq(platformFiles.idempotencyKey, key),
								),
							);
						return row?.record ?? null;
					},
					getFile: readFile,
					async putFile(file) {
						if (
							!conversation ||
							file.conversationId !== conversationId ||
							file.actorId !== conversation.actorId ||
							file.agentId !== conversation.agentId ||
							file.channelId !== conversation.channelId
						)
							throw new FileAuthorityError("denied");
						const existing = await readFile(file.fileId);
						if (existing) {
							for (const key of [
								"fileId",
								"objectRef",
								"kind",
								"idempotencyKey",
								"actorId",
								"agentId",
								"channelId",
								"conversationId",
								"createdAt",
								"expiresAt",
							] as const) {
								if (file[key] !== existing[key])
									throw new FileAuthorityError("conflict");
							}
							if (
								(["name", "mediaType", "sizeBytes", "sha256"] as const).some(
									(key) => file.descriptor[key] !== existing.descriptor[key],
								) ||
								file.revision !== existing.revision + 1 ||
								(existing.objectVersion !== null &&
									file.objectVersion !== existing.objectVersion) ||
								(existing.etag !== null && file.etag !== existing.etag) ||
								(existing.executionId !== null &&
									file.executionId !== existing.executionId) ||
								(existing.messageId !== null &&
									file.messageId !== existing.messageId) ||
								(existing.sessionGeneration !== null &&
									file.sessionGeneration !== existing.sessionGeneration)
							)
								throw new FileAuthorityError("conflict");
							await tx
								.update(platformFiles)
								.set({ record: file, updatedAt: new Date(file.updatedAt) })
								.where(eq(platformFiles.fileId, file.fileId));
						} else {
							if (file.revision !== 0) throw new FileAuthorityError("conflict");
							const inserted = await tx
								.insert(platformFiles)
								.values({
									fileId: file.fileId,
									actorId: file.actorId,
									conversationId,
									idempotencyKey: file.idempotencyKey,
									record: file,
									updatedAt: new Date(file.updatedAt),
								})
								.onConflictDoNothing()
								.returning({ fileId: platformFiles.fileId });
							if (inserted.length !== 1)
								throw new FileAuthorityError("conflict");
						}
					},
					async findAccess(fileId, operation, key) {
						const [row] = await tx
							.select()
							.from(platformFileAccesses)
							.where(
								and(
									eq(platformFileAccesses.fileId, fileId),
									eq(platformFileAccesses.operation, operation),
									eq(platformFileAccesses.idempotencyKey, key),
									eq(platformFileAccesses.conversationId, conversationId),
								),
							);
						return row?.record ?? null;
					},
					async getAccess(accessId) {
						const [row] = await tx
							.select()
							.from(platformFileAccesses)
							.where(
								and(
									eq(platformFileAccesses.accessId, accessId),
									eq(platformFileAccesses.conversationId, conversationId),
								),
							);
						return row?.record ?? null;
					},
					async putAccess(access) {
						const file = await readFile(access.fileId);
						if (
							!file ||
							access.conversationId !== conversationId ||
							access.actorId !== file.actorId ||
							access.agentId !== file.agentId ||
							access.channelId !== file.channelId
						)
							throw new FileAuthorityError("denied");
						await tx.insert(platformFileAccesses).values({
							accessId: access.accessId,
							fileId: access.fileId,
							conversationId,
							record: access,
							operation: access.operation,
							idempotencyKey: access.idempotencyKey,
							expiresAt: new Date(access.expiresAt),
						});
					},
				});
			});
		} catch (error) {
			if (error instanceof FileAuthorityError) throw error;
			throw new FileAuthorityError("unavailable");
		}
	}
	async expiredIntents(now: string, limit: number) {
		return this.database
			.select({
				conversationId: platformFiles.conversationId,
				fileId: platformFiles.fileId,
			})
			.from(platformFiles)
			.where(
				sql`${platformFiles.record}->>'status' = 'pending' and (${platformFiles.record}->>'expiresAt')::timestamptz <= ${now}::timestamptz`,
			)
			.orderBy(platformFiles.updatedAt)
			.limit(limit);
	}
	async findObject(objectRef: string) {
		const [row] = await this.database
			.select({
				conversationId: platformFiles.conversationId,
				fileId: platformFiles.fileId,
			})
			.from(platformFiles)
			.where(sql`${platformFiles.record}->>'objectRef' = ${objectRef}`)
			.limit(1);
		return row ?? null;
	}
	async checkpoint(work: (cursor: string | null) => Promise<string | null>) {
		try {
			return await this.client.begin(async (tx) => {
				const [lock] =
					await tx`select pg_try_advisory_xact_lock(442, 1) as acquired`;
				if (!lock?.acquired) return false;
				const [row] =
					await tx`select cursor from platform.file_reconciliation where id = 1`;
				const cursor = await work(row?.cursor ?? null);
				await tx`insert into platform.file_reconciliation (id, cursor) values (1, ${cursor}) on conflict (id) do update set cursor = excluded.cursor`;
				return true;
			});
		} catch {
			throw new FileAuthorityError("unavailable");
		}
	}
	async close() {
		await this.client.end();
	}
}
