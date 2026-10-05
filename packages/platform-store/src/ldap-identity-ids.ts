import postgres from "postgres";

const unavailable = () => new Error("LDAP_IDENTITY_STORE_UNAVAILABLE");
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
