import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PostgresLdapIdentityIds } from "./ldap-identity-ids.js";
import { migratePlatformDatabase } from "./migrate.js";
import { startPostgresTestDatabase } from "./postgres-test.js";

let database: Awaited<ReturnType<typeof startPostgresTestDatabase>>;
beforeAll(async () => {
	database = await startPostgresTestDatabase("ldap-identities");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
});
afterAll(async () => {
	await database?.stop();
});
it("allocates once across replicas, survives reconnect and isolates issuers and identities", async () => {
	const a = new PostgresLdapIdentityIds(database.databaseUrl);
	const b = new PostgresLdapIdentityIds(database.databaseUrl);
	let persisted = "";
	try {
		const ids = await Promise.all(
			Array.from({ length: 16 }, (_, i) =>
				(i % 2 ? a : b).getOrCreate("issuer-a", "uid-a", randomUUID()),
			),
		);
		expect(new Set(ids).size).toBe(1);
		persisted = ids[0] ?? "";
		expect(persisted).not.toBe("");
		expect(await a.findByUid("issuer-a", "uid-a")).toBe(persisted);
		expect(await b.findUidByUserId("issuer-a", persisted)).toBe("uid-a");
		expect(await a.findUidByUserId("issuer-b", persisted)).toBeNull();
		expect(await a.findByUid("issuer-a", "missing")).toBeNull();
		expect(await a.getOrCreate("issuer-b", "uid-a", randomUUID())).not.toBe(
			persisted,
		);
		expect(await b.getOrCreate("issuer-a", "uid-b", randomUUID())).not.toBe(
			persisted,
		);
		await expect(b.getOrCreate("issuer-c", "uid-c", persisted)).rejects.toThrow(
			/^LDAP_IDENTITY_STORE_UNAVAILABLE$/,
		);
		expect(await a.findByUid("issuer-c", "uid-c")).toBeNull();
		await expect(
			a.getOrCreate("issuer-a", "bad", "not-a-uuid"),
		).rejects.toThrow(/^LDAP_IDENTITY_STORE_UNAVAILABLE$/);
	} finally {
		await a.close();
		await b.close();
	}
	const reconnect = new PostgresLdapIdentityIds(database.databaseUrl);
	try {
		expect(await reconnect.getOrCreate("issuer-a", "uid-a", randomUUID())).toBe(
			persisted,
		);
	} finally {
		await reconnect.close();
	}
});
it("fails closed without disclosing database connection details", async () => {
	const store = new PostgresLdapIdentityIds(
		"postgres://private-user:private-password@127.0.0.1:1/missing",
	);
	try {
		await expect(store.findByUid("issuer", "uid")).rejects.toThrow(
			/^LDAP_IDENTITY_STORE_UNAVAILABLE$/,
		);
	} finally {
		await store.close();
	}
});
