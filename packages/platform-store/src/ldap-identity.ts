import { randomUUID } from "node:crypto";
import { ApiIdentityError } from "@agent-infra/platform-core";
import postgres from "postgres";

export interface CurrentLdapUserV1 {
	readonly userId: string;
	readonly accountStatus: "active" | "disabled";
	readonly roles: readonly ("employee" | "system_admin")[];
}

function assertText(value: string, maximum: number): void {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		!value.isWellFormed()
	)
		throw new Error("LDAP_IDENTITY_INPUT_INVALID");
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 32 || code === 127)
			throw new Error("LDAP_IDENTITY_INPUT_INVALID");
	}
}

function assertUserId(userId: string): void {
	if (
		typeof userId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
			userId,
		)
	)
		throw new Error("LDAP_IDENTITY_INPUT_INVALID");
}

/** Atomic, one-to-one Platform user IDs for the trusted LDAP issuer and UID. */
export class PostgresLdapIdentityIdsV1 {
	private readonly sql: ReturnType<typeof postgres>;

	constructor(databaseUrl: string) {
		this.sql = postgres(databaseUrl, { max: 4 });
	}

	async findByUid(issuer: string, uid: string): Promise<string | null> {
		assertText(issuer, 256);
		assertText(uid, 256);
		const [row] = await this.sql`
			select user_id from platform.ldap_identity_ids
			where issuer = ${issuer} and uid = ${uid}
		`;
		return row ? String(row.user_id) : null;
	}

	async findUidByUserId(
		issuer: string,
		userId: string,
	): Promise<string | null> {
		assertText(issuer, 256);
		assertUserId(userId);
		const [row] = await this.sql`
			select uid from platform.ldap_identity_ids
			where issuer = ${issuer} and user_id = ${userId}
		`;
		return row ? String(row.uid) : null;
	}

	async getOrCreate(
		issuer: string,
		uid: string,
		candidateUserId: string,
	): Promise<string> {
		assertText(issuer, 256);
		assertText(uid, 256);
		assertUserId(candidateUserId);
		const [row] = await this.sql`
			insert into platform.ldap_identity_ids (issuer, uid, user_id)
			values (${issuer}, ${uid}, ${candidateUserId})
			on conflict (issuer, uid) do update set uid = excluded.uid
			returning user_id
		`;
		if (!row) throw new Error("LDAP_IDENTITY_UNAVAILABLE");
		return String(row.user_id);
	}

	async close(): Promise<void> {
		await this.sql.end();
	}
}

/** Current Platform manual-disable authority; a database failure rejects the read. */
export class PostgresPlatformUserDisablesV1 {
	private readonly sql: ReturnType<typeof postgres>;
	private readonly currentLdapUser?: (
		userId: string,
	) => Promise<CurrentLdapUserV1 | null>;

	constructor(
		databaseUrl: string,
		currentLdapUser?: (userId: string) => Promise<CurrentLdapUserV1 | null>,
	) {
		this.sql = postgres(databaseUrl, { max: 4 });
		this.currentLdapUser = currentLdapUser;
	}

	async isPlatformDisabled(userId: string): Promise<boolean> {
		assertUserId(userId);
		const [row] = await this.sql`
			select user_id from platform.platform_user_disables
			where user_id = ${userId}
		`;
		return row !== undefined;
	}

	async recordRejected(input: {
		readonly actorUserId: string | null;
		readonly targetUserId: string | null;
		readonly traceId: string;
		readonly requestId: string;
		readonly reason: string;
		readonly outcome: "rejected" | "failed";
	}): Promise<void> {
		if (input.actorUserId !== null) assertUserId(input.actorUserId);
		if (input.targetUserId !== null) assertUserId(input.targetUserId);
		assertText(input.traceId, 256);
		assertText(input.requestId, 256);
		assertText(input.reason, 64);
		await this.sql`
			insert into platform.audit_events
				(id, trace_id, request_id, actor_type, actor_id, action,
				 target_type, target_id, outcome, details)
			values (${randomUUID()}, ${input.traceId}, ${input.requestId},
				${input.actorUserId === null ? "unknown" : "user"}, ${input.actorUserId ?? "unresolved"},
				'platform.user.disable.rejected', 'user',
				${input.targetUserId ?? "unresolved"}, ${input.outcome},
				${this.sql.json({ reason: input.reason })})
		`;
	}

	async setPlatformDisabled(input: {
		readonly actorUserId: string;
		readonly targetUserId: string;
		readonly disabled: boolean;
		readonly traceId: string;
		readonly requestId?: string;
	}): Promise<boolean> {
		assertUserId(input.actorUserId);
		assertUserId(input.targetUserId);
		assertText(input.traceId, 256);
		if (input.requestId !== undefined) assertText(input.requestId, 256);
		if (typeof input.disabled !== "boolean")
			throw new Error("LDAP_IDENTITY_INPUT_INVALID");
		const currentLdapUser = this.currentLdapUser;
		if (!currentLdapUser) throw new ApiIdentityError("dependency_unavailable");
		return this.sql.begin(async (sql) => {
			// The stable mapping rows serialize this write with disabling its actor.
			for (const userId of new Set(
				[input.actorUserId, input.targetUserId].toSorted(),
			)) {
				const [mapped] = await sql`
					select user_id from platform.ldap_identity_ids
					where user_id = ${userId} for update
				`;
				if (!mapped) throw new ApiIdentityError("resource_unavailable");
			}
			const [disabledActor] = await sql`
				select user_id from platform.platform_user_disables
				where user_id = ${input.actorUserId}
			`;
			if (disabledActor) throw new ApiIdentityError("not_authorized");
			let actor: CurrentLdapUserV1 | null;
			try {
				actor = await currentLdapUser(input.actorUserId);
			} catch {
				throw new ApiIdentityError("dependency_unavailable");
			}
			if (
				actor?.userId !== input.actorUserId ||
				actor.accountStatus !== "active" ||
				!actor.roles.includes("system_admin")
			)
				throw new ApiIdentityError("not_authorized");
			if (!input.disabled) {
				let target: CurrentLdapUserV1 | null;
				try {
					target = await currentLdapUser(input.targetUserId);
				} catch {
					throw new ApiIdentityError("dependency_unavailable");
				}
				if (
					target?.userId !== input.targetUserId ||
					target.accountStatus !== "active"
				)
					throw new ApiIdentityError("resource_unavailable");
			}
			const rows = input.disabled
				? await sql`
						insert into platform.platform_user_disables (user_id, disabled_by)
						values (${input.targetUserId}, ${input.actorUserId})
						on conflict (user_id) do nothing returning user_id
					`
				: await sql`
						delete from platform.platform_user_disables
						where user_id = ${input.targetUserId} returning user_id
					`;
			await sql`
					insert into platform.audit_events
						(id, trace_id, request_id, actor_type, actor_id, action,
						 target_type, target_id, outcome)
					values (${randomUUID()}, ${input.traceId}, ${input.requestId ?? null},
						'user', ${input.actorUserId},
						${input.disabled ? "platform.user.disabled" : "platform.user.enabled"},
						'user', ${input.targetUserId}, 'succeeded')
				`;
			return rows.length === 1;
		});
	}

	async close(): Promise<void> {
		await this.sql.end();
	}
}
