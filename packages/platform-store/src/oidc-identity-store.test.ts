import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PostgresLdapSessionStoreV1 } from "./browser-session.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	OidcBindingError,
	oidcBrowserSessionUidPrefix,
	PostgresOidcIdentityStore,
} from "./oidc-identity-store.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase;
let store: PostgresOidcIdentityStore;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
	database = await startPostgresTestDatabase("4433-oidc");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	store = new PostgresOidcIdentityStore(database.databaseUrl);
	sql = postgres(database.databaseUrl);
}, 60_000);
afterAll(async () => {
	await store?.close();
	await sql?.end();
	await database?.stop();
});

it("reuses the employee's ID for simultaneous first WeCom and OIDC logins without clearing the subject", async () => {
	const input = {
		employeeId: '["wecom","new-worker"]',
		email: "worker@example.invalid",
	};
	const oidc = {
		...input,
		issuer: "https://test.invalid",
		subject: "worker-sub",
	};
	const [fromWecom, fromWeb] = await Promise.all([
		store.resolveDirectoryEmployee(input),
		store.bind(oidc),
	]);
	expect(fromWeb.userId).toBe(fromWecom.userId);
	expect((await store.resolveDirectoryEmployee(input)).userId).toBe(
		fromWeb.userId,
	);
	expect(await store.findBySubject(oidc.issuer, oidc.subject)).toMatchObject(
		fromWecom,
	);
});

it("binds a verified legacy employee to the existing ID and rejects conflicting identity or email ownership", async () => {
	const userId = randomUUID();
	const claims = {
		issuer: "https://test.invalid",
		subject: "subject-a",
		employeeId: "employee-a",
		email: "employee-a@example.invalid",
	};
	await sql`insert into platform.ldap_identity_ids(issuer,uid,user_id) values ('old','uid-a',${userId})`;
	await expect(store.bind(claims)).rejects.toThrow(
		"OIDC_LEGACY_MAPPING_REQUIRED",
	);
	await expect(
		store.stageLegacyAccount({ ...claims, userId: randomUUID() }),
	).rejects.toThrow(OidcBindingError);
	const confirmed = {
		employeeId: "confirmed-new",
		email: "new@example.invalid",
	};
	await store.stageNewAccount(confirmed);
	const created = await store.bind({
		...confirmed,
		issuer: claims.issuer,
		subject: "confirmed-new",
	});
	await store.stageNewAccount(confirmed);
	expect(created.userId).not.toBe(userId);
	await store.stageLegacyAccount({ ...claims, userId });
	await store.stageLegacyAccount({ ...claims, userId });
	await expect(
		store.stageLegacyAccount({
			...claims,
			userId,
			employeeId: "another-employee",
		}),
	).rejects.toThrow(OidcBindingError);
	expect(await store.findByUserId(userId)).toMatchObject({
		issuer: null,
		subject: null,
	});
	const first = await store.bind(claims);
	expect(first.userId).toBe(userId);
	await expect(store.stageNewAccount(claims)).rejects.toThrow(OidcBindingError);
	await expect(store.bind({ ...claims, subject: "other-sub" })).rejects.toThrow(
		OidcBindingError,
	);
	await expect(
		store.bind({ ...claims, subject: "other-sub", employeeId: "employee-b" }),
	).rejects.toThrow(OidcBindingError);
	expect(
		await store.bind({
			...claims,
			issuer: "https://new.invalid",
			subject: "new-sub",
		}),
	).toEqual(first);
	expect(await store.findBySubject(claims.issuer, claims.subject)).toBeNull();
	expect(
		await store.findBySubject("https://new.invalid", "new-sub"),
	).toMatchObject(first);
});

it("serializes first bindings across API instances and enforces subject uniqueness", async () => {
	const second = new PostgresOidcIdentityStore(database.databaseUrl);
	const claims = {
		issuer: "https://test.invalid",
		subject: "subject-c",
		employeeId: "employee-c",
		email: "employee-c@example.invalid",
	};
	try {
		const [a, b] = await Promise.all([store.bind(claims), second.bind(claims)]);
		expect(a).toEqual(b);
		await expect(
			second.bind({
				...claims,
				email: "different@example.invalid",
				employeeId: "different",
			}),
		).rejects.toThrow(OidcBindingError);
	} finally {
		await second.close();
	}
});

it("consumes a live login transaction exactly once and rejects expired transactions", async () => {
	const value = { nonce: "nonce", verifier: "verifier" };
	const key = "a".repeat(64);
	const expired = "b".repeat(64);
	await store.put(key, value);
	expect(await Promise.all([store.take(key), store.take(key)])).toEqual(
		expect.arrayContaining([null, value]),
	);
	await store.put(expired, value);
	await sql`update platform.oidc_login_transactions set expires_at=clock_timestamp() where key=${expired}`;
	expect(await store.take(expired)).toBeNull();
	await store.put(key, value);
	expect(
		await sql`select 1 from platform.oidc_login_transactions where key=${expired}`,
	).toHaveLength(0);
});

it("atomically consumes a logout notification across replicas and revokes only the bound OIDC sessions", async () => {
	const issuer = "https://logout.example.invalid";
	const subject = "paired-employee";
	const claims = {
		issuer,
		subject,
		employeeId: "logout-employee",
		email: "logout@example.invalid",
	};
	const account = await store.bind(claims);
	const other = await store.bind({
		...claims,
		subject: "different",
		employeeId: "different-logout",
		email: "different-logout@example.invalid",
	});
	const prefix = oidcBrowserSessionUidPrefix(issuer);
	const event = {
		issuer,
		subject,
		jti: randomUUID(),
		issuedAt: Math.floor(Date.now() / 1000),
	};
	const expires = Date.now() + 60_000;
	const sessions = new PostgresLdapSessionStoreV1(database.databaseUrl);
	const second = new PostgresOidcIdentityStore(database.databaseUrl);
	const token = (digit: string) => digit.repeat(64);
	try {
		await sessions.create(
			token("1"),
			prefix + account.userId,
			expires,
			expires,
		);
		await sessions.create(
			token("2"),
			prefix + account.userId,
			expires,
			expires,
		);
		await sessions.create(token("3"), prefix + other.userId, expires, expires);
		await sessions.create(
			token("4"),
			oidcBrowserSessionUidPrefix("other-issuer") + account.userId,
			expires,
			expires,
		);
		await store.logout({ ...event, issuer: "other-issuer" });
		expect(await sessions.find(token("1"), Date.now())).not.toBeNull();
		await sql`create function platform.test_deny_logout() returns trigger language plpgsql as $$
			begin raise exception 'synthetic refusal'; end $$`;
		await sql`create trigger test_deny_logout before delete on platform.browser_sessions for each row execute function platform.test_deny_logout()`;
		try {
			await expect(store.logout(event)).rejects.toThrow("synthetic refusal");
			expect(await sessions.find(token("1"), Date.now())).not.toBeNull();
		} finally {
			await sql`drop trigger test_deny_logout on platform.browser_sessions`;
		}

		await Promise.all([store.logout(event), second.logout(event)]);
		expect(await sessions.find(token("1"), Date.now())).toBeNull();
		expect(await sessions.find(token("2"), Date.now())).toBeNull();
		expect(await sessions.find(token("3"), Date.now())).not.toBeNull();
		expect(await sessions.find(token("4"), Date.now())).not.toBeNull();
		await sessions.create(
			token("5"),
			prefix + account.userId,
			expires,
			expires,
		);
		await store.logout(event);
		expect(await sessions.find(token("5"), Date.now())).not.toBeNull();
	} finally {
		await sessions.close();
		await second.close();
	}
});
