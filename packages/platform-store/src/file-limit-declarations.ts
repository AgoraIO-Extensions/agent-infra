import {
	FileLimitDeclarationErrorV1,
	type FileLimitDeclarationRecordV1,
	type FileLimitDeclarationScopeV1,
	type FileLimitDeclarationStoreV1,
	type FileLimitDeclarationSubjectV1,
	type FileLimitDeclarationWriteRequestV1,
} from "@agent-infra/platform-core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "./observed-postgres.js";
import { agents, fileLimitDeclarations } from "./schema.js";

type DeclarationRow = typeof fileLimitDeclarations.$inferSelect;

function subjectColumns(subject: FileLimitDeclarationSubjectV1): {
	readonly scope: FileLimitDeclarationScopeV1;
	readonly agentId: string;
	readonly channelId: string;
} {
	switch (subject.scope) {
		case "deployment":
			return { scope: "deployment", agentId: "", channelId: "" };
		case "agent":
			return { scope: "agent", agentId: subject.agentId, channelId: "" };
		case "channel":
			return {
				scope: "channel",
				agentId: subject.agentId,
				channelId: subject.channelId,
			};
	}
}

function subjectWhere(subject: FileLimitDeclarationSubjectV1) {
	const columns = subjectColumns(subject);
	return and(
		eq(fileLimitDeclarations.scope, columns.scope),
		eq(fileLimitDeclarations.agentId, columns.agentId),
		eq(fileLimitDeclarations.channelId, columns.channelId),
	);
}

function toRecord(row: DeclarationRow): FileLimitDeclarationRecordV1 {
	return {
		scope: row.scope as FileLimitDeclarationScopeV1,
		agentId: row.agentId,
		channelId: row.channelId === "" ? null : row.channelId,
		revision: Number(row.revision),
		expiresAt: row.expiresAt.toISOString(),
		mediaTypes: row.mediaTypes,
		maxBytes: Number(row.maxBytes),
		updatedAt: row.updatedAt.toISOString(),
		updatedBy: row.updatedBy,
	};
}

function replayed(
	row: DeclarationRow,
	input: FileLimitDeclarationWriteRequestV1,
): boolean {
	return (
		row.idempotencyKey === input.idempotencyKey &&
		row.requestDigest === input.requestDigest
	);
}

export class PostgresFileLimitDeclarationStoreV1
	implements FileLimitDeclarationStoreV1
{
	readonly #client;
	readonly #database;
	constructor(databaseUrl: string) {
		this.#client = postgres(databaseUrl, { max: 4 });
		this.#database = drizzle(this.#client);
	}

	async read(
		subject: FileLimitDeclarationSubjectV1,
	): Promise<FileLimitDeclarationRecordV1 | null> {
		try {
			const [row] = await this.#database
				.select()
				.from(fileLimitDeclarations)
				.where(subjectWhere(subject))
				.limit(1);
			return row ? toRecord(row) : null;
		} catch {
			throw new FileLimitDeclarationErrorV1("unavailable");
		}
	}

	async readAgentConfigurationRevision(
		agentId: string,
	): Promise<number | null> {
		try {
			const [row] = await this.#database
				.select({ revision: agents.currentConfigurationRevision })
				.from(agents)
				.where(eq(agents.id, agentId))
				.limit(1);
			return row ? Number(row.revision) : null;
		} catch {
			throw new FileLimitDeclarationErrorV1("unavailable");
		}
	}

	async write(
		input: FileLimitDeclarationWriteRequestV1,
	): Promise<FileLimitDeclarationRecordV1> {
		const columns = subjectColumns(input.subject);
		const values = {
			...columns,
			expiresAt: new Date(input.declaration.expiresAt),
			maxBytes: input.declaration.maxBytes,
			mediaTypes: input.declaration.mediaTypes,
			idempotencyKey: input.idempotencyKey,
			requestDigest: input.requestDigest,
			updatedAt: input.now,
			updatedBy: input.actorId,
		};
		try {
			return await this.#database.transaction(async (transaction) => {
				const [existing] = await transaction
					.select()
					.from(fileLimitDeclarations)
					.where(subjectWhere(input.subject))
					.for("update")
					.limit(1);
				if (existing) {
					if (replayed(existing, input)) return toRecord(existing);
					if (
						input.expectedRevision === null ||
						Number(existing.revision) !== input.expectedRevision
					)
						throw new FileLimitDeclarationErrorV1("conflict");
					const [updated] = await transaction
						.update(fileLimitDeclarations)
						.set({ ...values, revision: input.expectedRevision + 1 })
						.where(
							and(
								subjectWhere(input.subject),
								eq(fileLimitDeclarations.revision, input.expectedRevision),
							),
						)
						.returning();
					if (!updated) throw new FileLimitDeclarationErrorV1("conflict");
					return toRecord(updated);
				}
				if (input.expectedRevision !== null)
					throw new FileLimitDeclarationErrorV1("conflict");
				const [inserted] = await transaction
					.insert(fileLimitDeclarations)
					.values({ ...values, revision: 1 })
					.onConflictDoNothing()
					.returning();
				if (inserted) return toRecord(inserted);
				// A concurrent writer created the row first: only an identical request replays.
				const [current] = await transaction
					.select()
					.from(fileLimitDeclarations)
					.where(subjectWhere(input.subject))
					.for("update")
					.limit(1);
				if (current && replayed(current, input)) return toRecord(current);
				throw new FileLimitDeclarationErrorV1("conflict");
			});
		} catch (error) {
			if (error instanceof FileLimitDeclarationErrorV1) throw error;
			throw new FileLimitDeclarationErrorV1("unavailable");
		}
	}

	async close(): Promise<void> {
		await this.#client.end();
	}
}
