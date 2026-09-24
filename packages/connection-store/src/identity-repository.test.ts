import {
	BrowserSessionService,
	PrincipalIdentityResolver,
	stablePrincipalId,
} from "@agent-infra/connection-identity";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createConnectionDatabase } from "./database.js";
import {
	createBrowserSessionStore,
	createPostgresPrincipalDirectory,
	createPrincipalIdentityStore,
} from "./identity-repository.js";
import { migrateConnectionDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let testDatabase: PostgresTestDatabase | undefined;

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("connection-identity");
	await migrateConnectionDatabase(testDatabase.databaseUrl);
}, 120_000);

it("single-flights directory checks across database clients and disables a missing Principal", async () => {
	if (!testDatabase)
		throw new Error("PostgreSQL test database was not initialized");
	const firstHandle = createConnectionDatabase(testDatabase.databaseUrl);
	const secondHandle = createConnectionDatabase(testDatabase.databaseUrl);
	try {
		const principals = createPrincipalIdentityStore(firstHandle.db);
		const principal = await new PrincipalIdentityResolver(principals).resolve({
			issuer: "corp-ldap",
			uid: "carl",
			dn: "uid=carl,ou=people,dc=example,dc=test",
			attributes: {},
		});
		let now = Date.now();
		let exists = true;
		let calls = 0;
		const checker = {
			async entryExists() {
				calls += 1;
				await new Promise((resolve) => setTimeout(resolve, 30));
				return exists;
			},
		};
		const first = createPostgresPrincipalDirectory(
			firstHandle.db,
			"corp-ldap",
			checker,
			() => now,
		);
		const second = createPostgresPrincipalDirectory(
			secondHandle.db,
			"corp-ldap",
			checker,
			() => now,
		);
		expect(
			await Promise.all([
				first.check("corp-ldap", "carl"),
				second.check("corp-ldap", "carl"),
			]),
		).toEqual([{ exists: true }, { exists: true }]);
		expect(calls).toBe(1);
		await first.check("corp-ldap", "carl");
		expect(calls).toBe(1);
		await expect(first.check("wrong-issuer", "carl")).rejects.toThrow();
		expect(calls).toBe(1);
		now += 15 * 60_000;
		await Promise.all([
			first.check("corp-ldap", "carl"),
			second.check("corp-ldap", "carl"),
		]);
		expect(calls).toBe(2);
		exists = false;
		now += 15 * 60_000;
		expect(
			await Promise.all([
				first.check("corp-ldap", "carl"),
				second.check("corp-ldap", "carl"),
			]),
		).toEqual([{ exists: false }, { exists: false }]);
		expect(calls).toBe(3);
		expect(await principals.findById(principal.id)).toMatchObject({
			status: "disabled",
			recoveryGeneration: 2,
		});
	} finally {
		await firstHandle.close();
		await secondHandle.close();
	}
}, 120_000);

afterAll(async () => {
	await testDatabase?.stop();
});

it("persists only session hashes and enforces Principal, revocation and recovery boundaries", async () => {
	if (!testDatabase)
		throw new Error("PostgreSQL test database was not initialized");
	const handle = createConnectionDatabase(testDatabase.databaseUrl);
	const inspect = postgres(testDatabase.databaseUrl);
	try {
		const principals = createPrincipalIdentityStore(handle.db);
		const sessions = createBrowserSessionStore(handle.db);
		const resolver = new PrincipalIdentityResolver(principals);
		const alice = await resolver.resolve({
			issuer: "corp-ldap",
			uid: "alice",
			dn: "uid=alice,ou=people,dc=example,dc=test",
			attributes: { displayName: "Alice", mail: "alice@example.test" },
		});
		const bob = await resolver.resolve({
			issuer: "corp-ldap",
			uid: "bob",
			dn: "uid=bob,ou=people,dc=example,dc=test",
			attributes: {},
		});
		expect(alice.id).toBe(stablePrincipalId("corp-ldap", "alice"));
		expect(bob.id).not.toBe(alice.id);
		const renamed = await resolver.resolve({
			issuer: "corp-ldap",
			uid: "alice",
			dn: "uid=alice,ou=people,dc=example,dc=test",
			attributes: { displayName: "Renamed" },
		});
		expect(renamed.id).toBe(alice.id);

		let now = Date.now();
		let exists = true;
		const service = new BrowserSessionService(
			sessions,
			principals,
			{ check: async () => ({ exists }) },
			() => now,
		);
		const first = await service.create(alice);
		const second = await service.create(alice);
		const [stored] = await inspect`
			select token_hash, principal_id, issuer, uid, recovery_generation
			from connection.browser_sessions where id = ${first.record.id}
		`;
		expect(stored).toMatchObject({
			token_hash: first.record.tokenHash,
			principal_id: alice.id,
			issuer: "corp-ldap",
			uid: "alice",
			recovery_generation: "1",
		});
		expect(JSON.stringify(stored)).not.toContain(first.token);
		expect(JSON.stringify(stored)).not.toContain("Renamed");
		expect(await service.resolve(first.token)).toEqual(alice);
		expect(await service.resolve("x".repeat(43))).toBeUndefined();
		await service.revoke(first.token);
		expect(await service.resolve(first.token)).toBeUndefined();
		expect(await service.resolve(second.token)).toEqual(alice);

		exists = false;
		expect(await service.resolve(second.token)).toBeUndefined();
		const disabled = await principals.findById(alice.id);
		expect(disabled).toMatchObject({
			status: "disabled",
			recoveryGeneration: 2,
		});
		await expect(service.create(alice)).rejects.toThrow(
			"LDAP authentication failed",
		);
		await expect(
			sessions.insert({
				...second.record,
				id: "stale-session",
				tokenHash: "a".repeat(64),
			}),
		).rejects.toThrow("LDAP authentication failed");
		await expect(
			sessions.insert({
				...second.record,
				id: "cross-principal-session",
				tokenHash: "b".repeat(64),
				principalId: bob.id,
			}),
		).rejects.toThrow("LDAP authentication failed");

		now += 8 * 60 * 60 * 1000;
		expect(await service.resolve(second.token)).toBeUndefined();
	} finally {
		await inspect.end();
		await handle.close();
	}
}, 120_000);
