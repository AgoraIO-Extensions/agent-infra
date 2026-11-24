import { createHash, randomUUID } from "node:crypto";
import postgres from "./observed-postgres.js";

export interface OidcEmployeeAccount {
	userId: string;
	employeeId: string;
	email: string;
}

export interface OidcLogoutEvent {
	issuer: string;
	subject: string;
	jti: string;
	issuedAt: number;
}

export function oidcBrowserSessionUidPrefix(issuer: string): string {
	return `oidc:${createHash("sha256").update(issuer).digest("hex")}:`;
}

type Binding = OidcEmployeeAccount & {
	issuer: string | null;
	subject: string | null;
};
type DirectoryIdentity = Omit<OidcEmployeeAccount, "userId">;
type LoginTransaction = { nonce: string; verifier: string };

export class OidcBindingError extends Error {}

function rejectUniqueCollision(error: unknown): never {
	if (error instanceof postgres.PostgresError && error.code === "23505")
		conflict();
	throw error;
}

function conflict(): never {
	throw new OidcBindingError("OIDC_IDENTITY_CONFLICT");
}

function employee(input: DirectoryIdentity) {
	const email = input.email.trim().toLowerCase();
	if (
		!/^[^\s@]+@[^\s@]+$/u.test(email) ||
		email.length > 320 ||
		!input.employeeId.trim() ||
		input.employeeId.length > 256
	)
		conflict();
	return { email, employeeId: input.employeeId };
}

export class PostgresOidcIdentityStore {
	private readonly sql: ReturnType<typeof postgres>;
	constructor(databaseUrl: string) {
		this.sql = postgres(databaseUrl, { max: 4, connect_timeout: 5 });
	}

	async findByUserId(userId: string): Promise<Binding | null> {
		const [row] = await this.sql<
			Binding[]
		>`select user_id as "userId", employee_id as "employeeId", email,issuer,subject
			from platform.oidc_employee_accounts where user_id=${userId}`;
		return row ?? null;
	}

	async findBySubject(
		issuer: string,
		subject: string,
	): Promise<Binding | null> {
		const [row] = await this.sql<
			Binding[]
		>`select user_id as "userId", employee_id as "employeeId", email,issuer,subject
			from platform.oidc_employee_accounts where issuer=${issuer} and subject=${subject}`;
		return row ?? null;
	}

	/** Trusted migration input cross-checked against the authoritative employee directory. */
	async stageLegacyAccount(input: OidcEmployeeAccount): Promise<void> {
		const { employeeId, email } = employee(input);
		await this.sql
			.begin(async (sql) => {
				const [stored] =
					await sql`insert into platform.oidc_employee_accounts (user_id, employee_id, email)
				select user_id, ${employeeId}, ${email} from platform.ldap_identity_ids where user_id=${input.userId}
				on conflict (user_id) do update set email = excluded.email
				where oidc_employee_accounts.email = excluded.email and oidc_employee_accounts.employee_id = excluded.employee_id
				returning user_id`;
				if (!stored) conflict();
			})
			.catch(rejectUniqueCollision);
	}

	/** Deployment has established that this particular employee has no historical account. */
	async stageNewAccount(input: DirectoryIdentity): Promise<void> {
		const { employeeId, email } = employee(input);
		const [staged] = await this
			.sql`insert into platform.oidc_employee_accounts (user_id,employee_id,email)
			values (${randomUUID()},${employeeId},${email})
			on conflict (employee_id) do update set email=excluded.email
			where oidc_employee_accounts.email=excluded.email and not exists (
				select 1 from platform.ldap_identity_ids l where l.user_id=oidc_employee_accounts.user_id)
			returning user_id`.catch(rejectUniqueCollision);
		if (!staged) conflict();
	}

	/** Caller verified this email with the configured issuer and resolved exactly one active directory employee. */
	async bind(
		input: DirectoryIdentity & { issuer: string; subject: string },
	): Promise<OidcEmployeeAccount> {
		const { issuer, subject } = input;
		if (
			!issuer.trim() ||
			issuer.length > 2048 ||
			!subject.trim() ||
			subject.length > 255
		)
			conflict();
		return this.resolveEmployee(input, { issuer, subject });
	}

	resolveDirectoryEmployee(
		input: DirectoryIdentity,
	): Promise<OidcEmployeeAccount> {
		return this.resolveEmployee(input, null);
	}

	private async resolveEmployee(
		input: DirectoryIdentity,
		binding: { issuer: string; subject: string } | null,
	): Promise<OidcEmployeeAccount> {
		const { employeeId, email } = employee(input);
		const issuer = binding?.issuer ?? null;
		const subject = binding?.subject ?? null;
		return this.sql
			.begin(async (sql) => {
				// Serialize first logins for this employee, including logins from different API replicas.
				await sql`select pg_advisory_xact_lock(hashtextextended(${employeeId}, 4433))`;
				const [existing] = await sql<
					Binding[]
				>`select user_id as "userId",employee_id as "employeeId",email,issuer,subject
				from platform.oidc_employee_accounts where employee_id=${employeeId} for update`;
				if (existing) {
					if (
						existing.email !== email ||
						(binding &&
							existing.issuer === issuer &&
							existing.subject !== subject)
					)
						conflict();
					if (binding && existing.issuer !== issuer) {
						await sql`update platform.oidc_employee_accounts set issuer=${issuer},subject=${subject}
						where user_id=${existing.userId}`;
					}
					return { userId: existing.userId, employeeId, email };
				}
				// A missing email on a historical identity cannot establish that the claimant is new.
				const [unmapped] = await sql`select 1 from platform.ldap_identity_ids l
				where not exists (select 1 from platform.oidc_employee_accounts a where a.user_id=l.user_id) limit 1`;
				if (unmapped)
					throw new OidcBindingError("OIDC_LEGACY_MAPPING_REQUIRED");
				const userId = randomUUID();
				await sql`insert into platform.oidc_employee_accounts (user_id,employee_id,email,issuer,subject)
				values (${userId},${employeeId},${email},${issuer},${subject})`;
				return { userId, employeeId, email };
			})
			.catch(rejectUniqueCollision);
	}

	/** Caller verified the logout token. Record delivery and revoke sessions together. */
	async logout({
		issuer,
		subject,
		jti,
		issuedAt,
	}: OidcLogoutEvent): Promise<void> {
		const digest = createHash("sha256")
			.update(JSON.stringify([issuer, jti]))
			.digest("hex");
		const prefix = oidcBrowserSessionUidPrefix(issuer);
		await this.sql.begin(async (sql) => {
			await sql`delete from platform.oidc_logout_receipts where digest in (
				select digest from platform.oidc_logout_receipts where expires_at <= clock_timestamp()
				order by expires_at limit 64 for update skip locked)`;
			const [firstDelivery] =
				await sql`insert into platform.oidc_logout_receipts (digest, expires_at)
				select ${digest}, to_timestamp(${issuedAt}) + interval '1 day'
				where to_timestamp(${issuedAt}) + interval '1 day' > clock_timestamp()
				on conflict (digest) do nothing returning digest`;
			if (!firstDelivery) return;
			await sql`delete from platform.browser_sessions where uid = (
				select ${prefix} || user_id from platform.oidc_employee_accounts
				where issuer=${issuer} and subject=${subject} for share)`;
		});
	}

	async put(key: string, value: LoginTransaction): Promise<void> {
		await this.sql.begin(async (sql) => {
			await sql`delete from platform.oidc_login_transactions where key in (
				select key from platform.oidc_login_transactions where expires_at <= clock_timestamp()
				order by expires_at limit 64 for update skip locked)`;
			await sql`insert into platform.oidc_login_transactions (key,nonce,verifier,expires_at)
				values (${key},${value.nonce},${value.verifier},clock_timestamp()+interval '5 minutes')`;
		});
	}
	async take(key: string): Promise<LoginTransaction | null> {
		const [row] = await this.sql<
			LoginTransaction[]
		>`delete from platform.oidc_login_transactions
			where key=${key} and expires_at > clock_timestamp() returning nonce,verifier`;
		return row ?? null;
	}
	close() {
		return this.sql.end();
	}
}
