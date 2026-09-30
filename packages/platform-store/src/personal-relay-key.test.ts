import { randomUUID } from "node:crypto";

import type { RelayKeyEncryptorV1 } from "@agent-infra/secret-store";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresLdapIdentityIdsV1 } from "./ldap-identity.js";
import { migratePlatformDatabase } from "./migrate.js";
import { PostgresPersonalRelayKeyStoreV1 } from "./personal-relay-key.js";
import { startPostgresTestDatabase } from "./postgres-test.js";

const keyValue = "relay-personal-test-key-value";
const encryptor: RelayKeyEncryptorV1 = {
	encrypt({ plaintext: _plaintext, ...binding }) {
		return {
			schemaVersion: 1,
			...binding,
			crypto: {
				schemaVersion: 1,
				algorithmVersion: "aes-256-gcm:v1",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				wrappingKeyVersion: "test-wrapping-key",
				aadVersion: "relay-key-aad:v1",
				dekFingerprint: "a".repeat(64),
				nonce: Buffer.alloc(12).toString("base64"),
				ciphertext: Buffer.alloc(32).toString("base64"),
				authenticationTag: Buffer.alloc(16).toString("base64"),
				wrappedDek: Buffer.alloc(384).toString("base64"),
			},
		};
	},
};

let database: Awaited<ReturnType<typeof startPostgresTestDatabase>>;

beforeAll(async () => {
	database = await startPostgresTestDatabase("personal-relay-key");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
}, 120_000);

afterAll(async () => database?.stop());

async function mappedUser() {
	const userId = randomUUID();
	const ids = new PostgresLdapIdentityIdsV1(database.databaseUrl);
	try {
		await ids.getOrCreate("personal-relay-test", randomUUID(), userId);
		return userId;
	} finally {
		await ids.close();
	}
}

describe("personal Relay Key PostgreSQL authority", () => {
	it("uses a current non-LDAP identity without requiring an LDAP mapping", async () => {
		const actorUserId = `external:user:${"x".repeat(300)}:${randomUUID()}`;
		const store = new PostgresPersonalRelayKeyStoreV1(
			database.databaseUrl,
			async (userId) => ({ userId, accountStatus: "active" }),
			encryptor,
		);
		const sql = postgres(database.databaseUrl, { max: 1 });
		const metadata = { traceId: randomUUID(), requestId: randomUUID() };
		try {
			const [mapping] = await sql`
				select user_id from platform.ldap_identity_ids
				where user_id = ${actorUserId}
			`;
			expect(mapping).toBeUndefined();
			expect(
				await store.replace({
					actorUserId,
					expectedVersion: null,
					keyValue,
					...metadata,
				}),
			).toBe(1);
			expect(await store.current({ actorUserId, ...metadata })).toBe(1);
			await sql`
				insert into platform.platform_user_disables (user_id, disabled_by)
				values (${actorUserId}, 'administrator')
			`;
			await expect(
				store.revoke({ actorUserId, expectedVersion: 1, ...metadata }),
			).rejects.toMatchObject({ code: "not_authorized" });
		} finally {
			await Promise.all([store.close(), sql.end()]);
		}
	});

	it("isolates subjects, keeps ciphertext only, and audits every successful operation", async () => {
		const first = await mappedUser();
		const second = await mappedUser();
		const store = new PostgresPersonalRelayKeyStoreV1(
			database.databaseUrl,
			async (userId) => ({ userId, accountStatus: "active" }),
			encryptor,
		);
		const sql = postgres(database.databaseUrl, { max: 1 });
		const traceId = randomUUID();
		const metadata = { traceId, requestId: randomUUID() };
		try {
			expect(
				await store.replace({
					actorUserId: first,
					expectedVersion: null,
					keyValue,
					...metadata,
				}),
			).toBe(1);
			expect(await store.current({ actorUserId: first, ...metadata })).toBe(1);
			expect(
				await store.current({ actorUserId: second, ...metadata }),
			).toBeNull();
			expect(
				await store.revoke({
					actorUserId: first,
					expectedVersion: 1,
					...metadata,
				}),
			).toBe(true);
			expect(
				await store.current({ actorUserId: first, ...metadata }),
			).toBeNull();
			const versions = await sql`
				select subject_id, key_version, ciphertext::text as ciphertext
				from platform.relay_key_versions
				where purpose = 'personal' and subject_id = ${first}
			`;
			expect(versions).toHaveLength(1);
			expect(versions[0]?.subject_id).toBe(first);
			expect(versions[0]?.ciphertext).not.toContain(keyValue);
			const audits = await sql`
				select actor_id, action, outcome, details
				from platform.audit_events where trace_id = ${traceId}
				order by occurred_at, action
			`;
			expect(audits.map(({ action }) => action).toSorted()).toEqual([
				"relay_key.personal.read",
				"relay_key.personal.read",
				"relay_key.personal.read",
				"relay_key.personal.replaced",
				"relay_key.personal.revoked",
			]);
			expect(audits.every(({ outcome }) => outcome === "succeeded")).toBe(true);
			expect(JSON.stringify(audits)).not.toContain(keyValue);
		} finally {
			await Promise.all([store.close(), sql.end()]);
		}
	});

	it("audits stale versions and rejects a user disabled after session resolution", async () => {
		const actorUserId = await mappedUser();
		const store = new PostgresPersonalRelayKeyStoreV1(
			database.databaseUrl,
			async (userId) => ({ userId, accountStatus: "active" }),
			encryptor,
		);
		const sql = postgres(database.databaseUrl, { max: 1 });
		const traceId = randomUUID();
		const metadata = { traceId, requestId: randomUUID() };
		try {
			expect(
				await store.replace({
					actorUserId,
					expectedVersion: null,
					keyValue,
					...metadata,
				}),
			).toBe(1);
			expect(
				await store.replace({
					actorUserId,
					expectedVersion: null,
					keyValue,
					...metadata,
				}),
			).toBeNull();
			expect(
				await store.revoke({ actorUserId, expectedVersion: 2, ...metadata }),
			).toBe(false);
			await sql`
				insert into platform.platform_user_disables (user_id, disabled_by)
				values (${actorUserId}, ${actorUserId})
			`;
			await expect(
				store.replace({
					actorUserId,
					expectedVersion: 1,
					keyValue,
					...metadata,
				}),
			).rejects.toMatchObject({ code: "not_authorized" });
			await expect(
				store.current({ actorUserId, ...metadata }),
			).rejects.toMatchObject({
				code: "not_authorized",
			});
			const [version] = await sql`
				select count(*)::integer as count from platform.relay_key_versions
				where purpose = 'personal' and subject_id = ${actorUserId}
			`;
			expect(version?.count).toBe(1);
			const rejected = await sql`
				select details from platform.audit_events
				where trace_id = ${traceId} and action = 'relay_key.personal.rejected'
			`;
			expect(rejected).toEqual([
				{ details: { reason: "STALE_VERSION" } },
				{ details: { reason: "STALE_VERSION" } },
			]);
		} finally {
			await Promise.all([store.close(), sql.end()]);
		}
	});

	it("rolls back a new Key version if its audit insert fails", async () => {
		const actorUserId = await mappedUser();
		const store = new PostgresPersonalRelayKeyStoreV1(
			database.databaseUrl,
			async (userId) => ({ userId, accountStatus: "active" }),
			encryptor,
		);
		const sql = postgres(database.databaseUrl, { max: 1 });
		try {
			await sql.unsafe(`
				create function platform.reject_personal_key_audit() returns trigger
				language plpgsql as $$ begin
					if new.action = 'relay_key.personal.replaced' then
						raise exception 'audit unavailable';
					end if;
					return new;
				end $$
			`);
			await sql.unsafe(`
				create trigger reject_personal_key_audit before insert
				on platform.audit_events for each row
				execute function platform.reject_personal_key_audit()
			`);
			await expect(
				store.replace({
					actorUserId,
					expectedVersion: null,
					keyValue,
					traceId: randomUUID(),
					requestId: randomUUID(),
				}),
			).rejects.toThrow("audit unavailable");
			const [subject] = await sql`
				select count(*)::integer as count from platform.relay_key_subjects
				where purpose = 'personal' and subject_id = ${actorUserId}
			`;
			expect(subject?.count).toBe(0);
		} finally {
			await sql.unsafe(
				"drop trigger if exists reject_personal_key_audit on platform.audit_events",
			);
			await sql.unsafe(
				"drop function if exists platform.reject_personal_key_audit()",
			);
			await Promise.all([store.close(), sql.end()]);
		}
	});
});
