import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";

import { createPersonalRelayKeyUseCaseV1 } from "@agent-infra/platform-core";
import {
	migratePlatformDatabase,
	PostgresPersonalRelayKeyStoreV1,
} from "@agent-infra/platform-store";
import { createRelayKeyEncryptorV1 } from "@agent-infra/secret-store";
import { createRelayKeyWorkerDecryptorV1 } from "@agent-infra/secret-store/worker";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../../packages/platform-store/src/postgres-test.js";
import { registerPersonalRelayKeyRoutes } from "./personal-relay-key-routes.js";

vi.setConfig({ testTimeout: 30_000 });

const first = `external:user:${randomUUID()}`;
const second = `external:user:${randomUUID()}`;
const keyValue = "relay-personal-integration-key";
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 3072,
});
const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
const wrappingKeyVersion = "test-wrapping-key";
const encryptor = createRelayKeyEncryptorV1({
	encryptionKeys: {
		schemaVersion: 1,
		activeWrappingKeyVersion: wrappingKeyVersion,
		keys: [
			{
				schemaVersion: 1,
				keyVersion: wrappingKeyVersion,
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				publicKeySpkiDerBase64: publicKeyDer.toString("base64"),
				publicKeyFingerprint: createHash("sha256")
					.update(publicKeyDer)
					.digest("hex"),
				rsaModulusBits: 3072,
				status: "active",
			},
		],
	},
});
const decryptor = createRelayKeyWorkerDecryptorV1({
	keys: [
		{
			keyVersion: wrappingKeyVersion,
			privateKeyPkcs8DerBase64: privateKey
				.export({ format: "der", type: "pkcs8" })
				.toString("base64"),
		},
	],
});

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresPersonalRelayKeyStoreV1;
let app: Hono;

beforeAll(async () => {
	database = await startPostgresTestDatabase("personal-relay-key-http");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 1 });
	// #482 owns the shared Relay Key migration. This exercises the HTTP path
	// against its current two-table contract until the ordered SQL is published.
	await sql`
		create table platform.relay_key_subjects (
			purpose text not null,
			subject_id text not null,
			last_version bigint not null default 0,
			current_version bigint,
			updated_at timestamptz not null default now(),
			primary key (purpose, subject_id),
			check (current_version is null or current_version between 1 and last_version)
		)
	`;
	await sql`
		create table platform.relay_key_versions (
			purpose text not null,
			subject_id text not null,
			key_version bigint not null,
			key_id text not null unique,
			ciphertext jsonb not null,
			primary key (purpose, subject_id, key_version),
			foreign key (purpose, subject_id)
				references platform.relay_key_subjects (purpose, subject_id)
		)
	`;
	store = new PostgresPersonalRelayKeyStoreV1(
		database.databaseUrl,
		async (userId) =>
			userId === first || userId === second
				? { userId, accountStatus: "active" }
				: null,
		encryptor,
	);
	app = new Hono();
	registerPersonalRelayKeyRoutes(app, {
		identity: {
			async resolve(request) {
				const userId = request.headers.get("x-test-user");
				return userId === first || userId === second
					? {
							schemaVersion: 1,
							userId,
							displayName: "Test user",
							accountStatus: "active",
							organizationIds: [],
							roles: ["employee"],
							authorizationRevision: "directory-revision-1",
						}
					: null;
			},
			async hydrateUsers() {
				return [];
			},
		},
		keys: createPersonalRelayKeyUseCaseV1({
			store,
			validate: async () => "valid",
		}),
	});
}, 120_000);

afterAll(async () => {
	await Promise.all([store?.close(), sql?.end()]);
	await database?.stop();
});

describe("personal Relay Key HTTP with PostgreSQL", () => {
	it("keeps two subjects isolated and rejects stale or disabled writes without leaking the Key", async () => {
		const path = "/api/v2/me/relay-key";
		const request = (userId: string, method = "GET", body?: object) =>
			app.request(path, {
				method,
				headers: {
					"x-test-user": userId,
					...(body ? { "content-type": "application/json" } : {}),
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			});
		const replace = {
			schemaVersion: 1,
			expectedVersion: null,
			keyValue,
		};
		expect(await (await request(first)).json()).toMatchObject({ isSet: false });
		const created = await request(first, "PUT", replace);
		expect(created.status).toBe(200);
		expect(await created.json()).toMatchObject({
			isSet: true,
			keyVersion: 1,
		});
		expect(await (await request(second)).json()).toMatchObject({
			isSet: false,
			keyVersion: null,
		});
		const stale = await request(first, "PUT", replace);
		expect(stale.status).toBe(409);
		const revoked = await request(first, "DELETE", {
			schemaVersion: 1,
			expectedVersion: 1,
		});
		expect(revoked.status).toBe(200);
		await sql`
			insert into platform.platform_user_disables (user_id, disabled_by)
			values (${first}, 'administrator')
		`;
		const disabled = await request(first, "PUT", {
			...replace,
			expectedVersion: 1,
		});
		expect(disabled.status).toBe(403);
		const versions = await sql`
			select key_id as "keyId", key_version as "keyVersion", ciphertext
			from platform.relay_key_versions
			where purpose = 'personal' and subject_id = ${first}
		`;
		expect(versions).toHaveLength(1);
		const version = versions[0];
		expect(JSON.stringify(version?.ciphertext)).not.toContain(keyValue);
		const decrypted = await decryptor.decrypt({
			encryptedRecord: version?.ciphertext,
			expectedBinding: {
				purpose: "personal",
				subjectId: first,
				keyId: version?.keyId,
				keyVersion: Number(version?.keyVersion),
			},
		});
		expect(decrypted.outcome).toBe("decrypted");
		if (decrypted.outcome === "decrypted") {
			const plaintext = new TextDecoder().decode(decrypted.plaintext);
			decrypted.plaintext.fill(0);
			expect(plaintext).toBe(keyValue);
		}
		expect(
			await decryptor.decrypt({
				encryptedRecord: version?.ciphertext,
				expectedBinding: {
					purpose: "personal",
					subjectId: second,
					keyId: version?.keyId,
					keyVersion: Number(version?.keyVersion),
				},
			}),
		).toEqual({ outcome: "failed", code: "RELAY_KEY_METADATA_INVALID" });
		const audits = await sql`
			select action, outcome, details from platform.audit_events
			where target_id = ${first}
		`;
		expect(
			audits.map(({ action, outcome }) => `${action}:${outcome}`).toSorted(),
		).toEqual(
			[
				"relay_key.personal.read:succeeded",
				"relay_key.personal.replaced:succeeded",
				"relay_key.personal.rejected:rejected",
				"relay_key.personal.revoked:succeeded",
				"relay_key.personal.rejected:rejected",
			].toSorted(),
		);
		expect(JSON.stringify(audits)).not.toContain(keyValue);
		expect(await stale.text()).not.toContain(keyValue);
		expect(await disabled.text()).not.toContain(keyValue);
	});
});
