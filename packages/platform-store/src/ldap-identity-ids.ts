import { randomUUID } from "node:crypto";
import postgres from "postgres";

export class PlatformUserDisableError extends Error {
	readonly code:
		| "invalid_input"
		| "not_authorized"
		| "resource_unavailable"
		| "dependency_unavailable";

	constructor(
		code:
			| "invalid_input"
			| "not_authorized"
			| "resource_unavailable"
			| "dependency_unavailable",
	) {
		super("Platform user governance is unavailable");
		this.name = "PlatformUserDisableError";
		this.code = code;
	}
}

const unavailable = () => new Error("LDAP_IDENTITY_STORE_UNAVAILABLE");
const governanceOperationTimeoutMs = 2_000;

async function withGovernanceTimeout<T>(operation: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => {
					reject(new PlatformUserDisableError("dependency_unavailable"));
				}, governanceOperationTimeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
function text(value: string) {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 256 ||
		!value.isWellFormed() ||
		Array.from(value).some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		)
	)
		throw unavailable();
	return value;
}
function id(value: string) {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
			value,
		)
	)
		throw unavailable();
	return value;
}
/** Stable issuer/UID identity; concurrent login never reallocates a Platform ID. */
export class PostgresLdapIdentityIds {
	private readonly sql: ReturnType<typeof postgres>;
	constructor(databaseUrl: string) {
		this.sql = postgres(databaseUrl, { max: 4, connect_timeout: 5 });
	}
	async findByUid(issuer: string, uid: string): Promise<string | null> {
		try {
			const [row] = await this
				.sql`select user_id from platform.ldap_identity_ids where issuer=${text(issuer)} and uid=${text(uid)}`;
			return row ? id(row.user_id) : null;
		} catch {
			throw unavailable();
		}
	}
	async findUidByUserId(
		issuer: string,
		userId: string,
	): Promise<string | null> {
		try {
			const [row] = await this
				.sql`select uid from platform.ldap_identity_ids where issuer=${text(issuer)} and user_id=${id(userId)}`;
			return row ? text(row.uid) : null;
		} catch {
			throw unavailable();
		}
	}
	async getOrCreate(
		issuer: string,
		uid: string,
		candidateUserId: string,
	): Promise<string> {
		try {
			const [row] = await this
				.sql`insert into platform.ldap_identity_ids(issuer,uid,user_id) values(${text(issuer)},${text(uid)},${id(candidateUserId)}) on conflict (issuer,uid) do update set uid=excluded.uid returning user_id`;
			return id(row?.user_id);
		} catch {
			throw unavailable();
		}
	}
	async close() {
		await this.sql.end();
	}
}

export interface CurrentPlatformUserV1 {
	readonly userId: string;
	readonly accountStatus: "active" | "disabled";
	readonly isSystemAdmin: boolean;
}

/** The durable Platform override consumed by every current-identity gate. */
export class PostgresPlatformUserDisablesV1 {
	private readonly sql: ReturnType<typeof postgres>;
	private readonly currentUser: (
		userId: string,
	) => Promise<CurrentPlatformUserV1 | null>;

	constructor(
		databaseUrl: string,
		currentUser: (userId: string) => Promise<CurrentPlatformUserV1 | null>,
	) {
		this.sql = postgres(databaseUrl, { max: 4, connect_timeout: 5 });
		this.currentUser = currentUser;
	}

	async isPlatformDisabled(userId: string): Promise<boolean> {
		try {
			const [row] = await this.sql`
				select user_id from platform.platform_user_disables where user_id=${id(userId)}
			`;
			return row !== undefined;
		} catch {
			throw new PlatformUserDisableError("dependency_unavailable");
		}
	}

	async setPlatformDisabled(input: {
		readonly actorUserId: string;
		readonly targetUserId: string;
		readonly disabled: boolean;
		readonly traceId: string;
		readonly requestId?: string;
	}): Promise<boolean> {
		try {
			id(input.actorUserId);
			id(input.targetUserId);
			text(input.traceId);
			if (input.requestId !== undefined) text(input.requestId);
			if (typeof input.disabled !== "boolean") throw new Error();
		} catch {
			throw new PlatformUserDisableError("invalid_input");
		}
		try {
			return await this.sql.begin(async (sql) => {
				await sql`set local lock_timeout = '2s'`;
				await sql`set local statement_timeout = '5s'`;
				// Match all existing current-authority readers before resolving identity.
				await sql`lock table platform.platform_user_disables in share row exclusive mode`;
				const actor = await withGovernanceTimeout(
					this.currentUser(input.actorUserId),
				);
				if (
					!actor ||
					actor.userId !== input.actorUserId ||
					actor.accountStatus !== "active" ||
					!actor.isSystemAdmin
				)
					throw new PlatformUserDisableError("not_authorized");
				const [actorDisable] = await sql`
					select user_id
					from platform.platform_user_disables
					where user_id=${input.actorUserId}
				`;
				if (actorDisable) throw new PlatformUserDisableError("not_authorized");
				const target = await withGovernanceTimeout(
					this.currentUser(input.targetUserId),
				);
				if (!target || target.userId !== input.targetUserId)
					throw new PlatformUserDisableError("resource_unavailable");
				if (!input.disabled && target.accountStatus !== "active")
					throw new PlatformUserDisableError("resource_unavailable");
				const currentActor = await withGovernanceTimeout(
					this.currentUser(input.actorUserId),
				);
				if (
					!currentActor ||
					currentActor.userId !== input.actorUserId ||
					currentActor.accountStatus !== "active" ||
					!currentActor.isSystemAdmin
				)
					throw new PlatformUserDisableError("not_authorized");
				const [currentActorDisable] = await sql`
					select user_id
					from platform.platform_user_disables
					where user_id=${input.actorUserId}
				`;
				if (currentActorDisable)
					throw new PlatformUserDisableError("not_authorized");
				const rows = input.disabled
					? await sql`
							insert into platform.platform_user_disables (user_id)
							values (${input.targetUserId})
							on conflict (user_id) do nothing returning user_id
						`
					: await sql`
							delete from platform.platform_user_disables
							where user_id=${input.targetUserId} returning user_id
						`;
				if (rows.length === 0) return false;
				await sql`
					insert into platform.audit_events
						(id, trace_id, request_id, actor_type, actor_id, action,
						target_type, target_id, outcome)
					values (${randomUUID()}, ${input.traceId}, ${input.requestId ?? null},
						'user', ${input.actorUserId},
						${input.disabled ? "platform.user.disabled" : "platform.user.reenabled"},
						'user', ${input.targetUserId}, 'succeeded')
				`;
				return true;
			});
		} catch (error) {
			if (error instanceof PlatformUserDisableError) throw error;
			throw new PlatformUserDisableError("dependency_unavailable");
		}
	}

	async close(): Promise<void> {
		await this.sql.end();
	}
}
