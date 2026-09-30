import { randomUUID } from "node:crypto";
import type { PersonalRelayKeyStorePortV1 } from "@agent-infra/platform-core";
import { ApiIdentityError } from "@agent-infra/platform-core";
import type { RelayKeyEncryptorV1 } from "@agent-infra/secret-store";
import postgres from "postgres";

import { platformDatabaseUrlFromEnvironment } from "./migrate.js";
import {
	currentRelayKeyVersionInTransaction,
	replaceRelayKeyVersionInTransaction,
	revokeCurrentRelayKeyInTransaction,
} from "./relay-key-versions.js";

type Transaction = postgres.TransactionSql;
type CurrentUser = {
	readonly userId: string;
	readonly accountStatus: "active" | "disabled";
};

function userId(value: string): void {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
			value,
		)
	)
		throw new Error("PERSONAL_RELAY_KEY_INPUT_INVALID");
}

function bounded(value: string, maximum: number): void {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		!value.isWellFormed()
	)
		throw new Error("PERSONAL_RELAY_KEY_INPUT_INVALID");
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 32 || code === 127)
			throw new Error("PERSONAL_RELAY_KEY_INPUT_INVALID");
	}
}

/** Personal-Key writes share the mapped identity lock with administrator disable. */
export class PostgresPersonalRelayKeyStoreV1
	implements PersonalRelayKeyStorePortV1
{
	private readonly sql: ReturnType<typeof postgres>;

	constructor(
		databaseUrl: string,
		private readonly currentUser: (
			userId: string,
		) => Promise<CurrentUser | null>,
		private readonly encryptor: RelayKeyEncryptorV1,
	) {
		this.sql = postgres(
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: databaseUrl,
			}),
			{ max: 4 },
		);
	}

	private async authorize(
		sql: Transaction,
		actorUserId: string,
	): Promise<void> {
		userId(actorUserId);
		const [mapped] = await sql`
			select user_id from platform.ldap_identity_ids
			where user_id = ${actorUserId} for update
		`;
		if (!mapped) throw new ApiIdentityError("resource_unavailable");
		const [disabled] = await sql`
			select user_id from platform.platform_user_disables
			where user_id = ${actorUserId}
		`;
		if (disabled) throw new ApiIdentityError("not_authorized");
		let current: CurrentUser | null;
		try {
			current = await this.currentUser(actorUserId);
		} catch {
			throw new ApiIdentityError("dependency_unavailable");
		}
		if (current?.userId !== actorUserId || current.accountStatus !== "active")
			throw new ApiIdentityError("not_authorized");
	}

	private async audit(
		sql: Transaction,
		input: {
			readonly actorUserId: string;
			readonly traceId: string;
			readonly requestId: string;
			readonly action: string;
			readonly outcome: "succeeded" | "rejected";
			readonly reason?: string;
		},
	): Promise<void> {
		await sql`
			insert into platform.audit_events
				(id, trace_id, request_id, actor_type, actor_id, action,
				 target_type, target_id, outcome, details)
			values (${randomUUID()}, ${input.traceId}, ${input.requestId},
				'user', ${input.actorUserId}, ${input.action}, 'user',
				${input.actorUserId}, ${input.outcome},
				${input.reason === undefined ? null : sql.json({ reason: input.reason })})
		`;
	}

	async current(input: {
		readonly actorUserId: string;
		readonly traceId: string;
		readonly requestId: string;
	}): Promise<number | null> {
		bounded(input.traceId, 256);
		bounded(input.requestId, 256);
		return this.sql.begin(async (sql) => {
			await this.authorize(sql, input.actorUserId);
			const binding = await currentRelayKeyVersionInTransaction(sql, {
				purpose: "personal",
				subjectId: input.actorUserId,
			});
			await this.audit(sql, {
				...input,
				action: "relay_key.personal.read",
				outcome: "succeeded",
			});
			return binding?.keyVersion ?? null;
		});
	}

	async replace(input: {
		readonly actorUserId: string;
		readonly expectedVersion: number | null;
		readonly keyValue: string;
		readonly traceId: string;
		readonly requestId: string;
	}): Promise<number | null> {
		bounded(input.traceId, 256);
		bounded(input.requestId, 256);
		return this.sql.begin(async (sql) => {
			await this.authorize(sql, input.actorUserId);
			const result = await replaceRelayKeyVersionInTransaction(sql, {
				purpose: "personal",
				subjectId: input.actorUserId,
				expectedCurrentVersion: input.expectedVersion,
				encrypt: (binding) =>
					this.encryptor.encrypt({ ...binding, plaintext: input.keyValue }),
			});
			await this.audit(sql, {
				...input,
				action:
					result.outcome === "stale"
						? "relay_key.personal.rejected"
						: "relay_key.personal.replaced",
				outcome: result.outcome === "stale" ? "rejected" : "succeeded",
				...(result.outcome === "stale" ? { reason: "STALE_VERSION" } : {}),
			});
			return result.outcome === "replaced" ? result.binding.keyVersion : null;
		});
	}

	async revoke(input: {
		readonly actorUserId: string;
		readonly expectedVersion: number;
		readonly traceId: string;
		readonly requestId: string;
	}): Promise<boolean> {
		bounded(input.traceId, 256);
		bounded(input.requestId, 256);
		return this.sql.begin(async (sql) => {
			await this.authorize(sql, input.actorUserId);
			const result = await revokeCurrentRelayKeyInTransaction(sql, {
				purpose: "personal",
				subjectId: input.actorUserId,
				expectedCurrentVersion: input.expectedVersion,
			});
			await this.audit(sql, {
				...input,
				action:
					result === "stale"
						? "relay_key.personal.rejected"
						: "relay_key.personal.revoked",
				outcome: result === "stale" ? "rejected" : "succeeded",
				...(result === "stale" ? { reason: "STALE_VERSION" } : {}),
			});
			return result === "revoked";
		});
	}

	async recordRejected(input: {
		readonly actorUserId: string | null;
		readonly traceId: string;
		readonly requestId: string;
		readonly reason: string;
		readonly outcome: "rejected" | "failed";
	}): Promise<void> {
		if (input.actorUserId !== null) userId(input.actorUserId);
		bounded(input.traceId, 256);
		bounded(input.requestId, 256);
		bounded(input.reason, 64);
		await this.sql`
			insert into platform.audit_events
				(id, trace_id, request_id, actor_type, actor_id, action,
				 target_type, target_id, outcome, details)
			values (${randomUUID()}, ${input.traceId}, ${input.requestId},
				${input.actorUserId === null ? "unknown" : "user"},
				${input.actorUserId ?? "unresolved"},
				'relay_key.personal.rejected', 'user',
				${input.actorUserId ?? "unresolved"}, ${input.outcome},
				${this.sql.json({ reason: input.reason })})
		`;
	}

	async close(): Promise<void> {
		await this.sql.end();
	}
}
