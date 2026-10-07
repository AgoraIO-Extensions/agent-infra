import postgres from "postgres";

export type BrowserSessionPrincipal = Record<string, unknown>;

function assertDigest(digest: string): void {
	if (!/^[0-9a-f]{64}$/u.test(digest)) {
		throw new Error("SESSION_INPUT_INVALID");
	}
}

/** Cross-replica storage for the opaque cookie digest, never the cookie itself. */
export class PostgresLdapSessionStoreV1 {
	private readonly sql: ReturnType<typeof postgres>;

	constructor(databaseUrl: string) {
		this.sql = postgres(databaseUrl, { max: 4 });
	}

	async create(
		digest: string,
		uid: string,
		expiresAt: number,
		absoluteExpiresAt: number,
		principal?: BrowserSessionPrincipal,
	): Promise<void> {
		assertDigest(digest);
		await this.sql.begin(async (sql) => {
			await sql`
				delete from platform.browser_sessions
				where expires_at <= clock_timestamp()
					or absolute_expires_at <= clock_timestamp()
			`;
			await sql`
				insert into platform.browser_sessions
					(token_digest, uid, expires_at, absolute_expires_at, principal)
				values (
					${digest},
					${uid},
					${new Date(expiresAt)},
					${new Date(absoluteExpiresAt)},
					${principal ? sql.json(principal as postgres.JSONValue) : null}
				)
			`;
		});
	}

	async find(
		digest: string,
		now: number,
	): Promise<{
		uid: string;
		expiresAt: number;
		absoluteExpiresAt: number;
		principal?: BrowserSessionPrincipal;
	} | null> {
		assertDigest(digest);
		const [row] = await this.sql`
			select uid, expires_at, absolute_expires_at, principal
			from platform.browser_sessions
			where token_digest = ${digest}
				and expires_at > ${new Date(now)}
				and absolute_expires_at > ${new Date(now)}
		`;
		return row && typeof row.uid === "string"
			? {
					uid: row.uid,
					expiresAt: new Date(row.expires_at).getTime(),
					absoluteExpiresAt: new Date(row.absolute_expires_at).getTime(),
					...(row.principal && typeof row.principal === "object"
						? { principal: row.principal as BrowserSessionPrincipal }
						: {}),
				}
			: null;
	}

	async renew(
		digest: string,
		now: number,
		expiresAt: number,
	): Promise<boolean> {
		assertDigest(digest);
		const rows = await this.sql`
			update platform.browser_sessions
			set expires_at = least(
				greatest(expires_at, ${new Date(expiresAt)}),
				absolute_expires_at
			)
			where token_digest = ${digest}
				and expires_at > ${new Date(now)}
				and absolute_expires_at > ${new Date(now)}
			returning token_digest
		`;
		return rows.length > 0;
	}

	async revoke(digest: string): Promise<void> {
		assertDigest(digest);
		await this.sql`
			delete from platform.browser_sessions where token_digest = ${digest}
		`;
	}

	async revokeUid(uid: string): Promise<void> {
		await this.sql`
			delete from platform.browser_sessions where uid = ${uid}
		`;
	}

	async close(): Promise<void> {
		await this.sql.end();
	}
}
