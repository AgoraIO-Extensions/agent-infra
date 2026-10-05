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
		principal?: BrowserSessionPrincipal,
	): Promise<void> {
		assertDigest(digest);
		await this.sql.begin(async (sql) => {
			await sql`delete from platform.browser_sessions where expires_at <= clock_timestamp()`;
			await sql`
				insert into platform.browser_sessions (token_digest, uid, expires_at, principal)
				values (${digest}, ${uid}, ${new Date(expiresAt)}, ${principal ? sql.json(principal as postgres.JSONValue) : null})
			`;
		});
	}

	async find(
		digest: string,
		now: number,
	): Promise<{ uid: string; principal?: BrowserSessionPrincipal } | null> {
		assertDigest(digest);
		const [row] = await this.sql`
			select uid, principal from platform.browser_sessions
			where token_digest = ${digest} and expires_at > ${new Date(now)}
		`;
		return row && typeof row.uid === "string"
			? {
					uid: row.uid,
					...(row.principal && typeof row.principal === "object"
						? { principal: row.principal as BrowserSessionPrincipal }
						: {}),
				}
			: null;
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
