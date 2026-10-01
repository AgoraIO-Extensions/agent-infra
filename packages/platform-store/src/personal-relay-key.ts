import { randomUUID } from "node:crypto";
import {
	type PersonalRelayKeyAuditV1,
	PersonalRelayKeyErrorV1,
	type PersonalRelayKeyTransactionPortV1,
	type PersonalRelayKeyTransactionV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { platformDatabaseUrlFromEnvironment } from "./migrate.js";
import {
	currentRelayKeyVersionInTransaction,
	replaceRelayKeyVersionInTransaction,
	revokeCurrentRelayKeyInTransaction,
} from "./relay-key-versions.js";

async function audit(
	sql: postgres.Sql | postgres.TransactionSql,
	event: PersonalRelayKeyAuditV1,
): Promise<void> {
	// Construct only the explicitly allowed audit fields; never persist an input object.
	await sql`
		insert into platform.audit_events
		(id, trace_id, request_id, actor_type, actor_id, action, target_type, target_id, outcome, details)
		values (${randomUUID()}, ${event.traceId}, ${event.requestId},
		${event.userId === null ? "unknown" : "user"}, ${event.userId ?? "unknown"},
		${`relay_key.personal.${event.operation}`}, 'secret', ${event.userId ?? "unknown"},
		${event.outcome}, ${sql.json(event.reason === undefined ? {} : { reason: event.reason })})
	`;
}

function operations(
	sql: postgres.TransactionSql,
): PersonalRelayKeyTransactionV1 {
	return {
		async lockUserDisabled(userId) {
			// Covers missing rows, with the same D-first ordering as credential governance.
			await sql`lock table platform.platform_user_disables in share mode`;
			const rows =
				await sql`select user_id from platform.platform_user_disables where user_id = ${userId}`;
			return rows.length > 0;
		},
		async current(userId) {
			const binding = await currentRelayKeyVersionInTransaction(sql, {
				purpose: "personal",
				subjectId: userId,
			});
			return binding?.keyVersion ?? null;
		},
		async replace(userId, expectedVersion, encrypt) {
			const result = await replaceRelayKeyVersionInTransaction(sql, {
				purpose: "personal",
				subjectId: userId,
				expectedCurrentVersion: expectedVersion,
				encrypt: (binding) => encrypt({ ...binding, purpose: "personal" }),
			});
			return result.outcome === "replaced" ? result.binding.keyVersion : null;
		},
		async revoke(userId, expectedVersion) {
			return (
				(await revokeCurrentRelayKeyInTransaction(sql, {
					purpose: "personal",
					subjectId: userId,
					expectedCurrentVersion: expectedVersion,
				})) === "revoked"
			);
		},
		recordAudit: (event) => audit(sql, event),
	};
}

export class PostgresPersonalRelayKeyStoreV1
	implements PersonalRelayKeyTransactionPortV1
{
	readonly #client;
	constructor(input: { readonly databaseUrl: string }) {
		this.#client = postgres(
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: input.databaseUrl,
			}),
			{ max: 4 },
		);
	}

	async execute<T>(
		work: (transaction: PersonalRelayKeyTransactionV1) => Promise<T>,
	): Promise<T> {
		try {
			const result = await this.#client.begin(
				"isolation level read committed",
				async (sql) => {
					await sql`set local lock_timeout = '5s'`;
					await sql`set local statement_timeout = '15s'`;
					return { value: await work(operations(sql)) };
				},
			);
			return result.value;
		} catch (error) {
			if (error instanceof PersonalRelayKeyErrorV1) throw error;
			throw new PersonalRelayKeyErrorV1("unavailable");
		}
	}

	async recordAudit(event: PersonalRelayKeyAuditV1): Promise<void> {
		// Refusals run after rollback, with the same bounded database waits as commands.
		await this.execute((transaction) => transaction.recordAudit(event));
	}

	async close(): Promise<void> {
		await this.#client.end();
	}
}
