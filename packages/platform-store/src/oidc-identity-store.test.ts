import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.js";
import {
	OidcBindingError,
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
