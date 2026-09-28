import { createHash, generateKeyPairSync } from "node:crypto";

import {
	type RuntimeSubmitTurnRequestV4,
	RuntimeSubmitTurnRequestV4Schema,
	type RuntimeSubmitTurnTransportV4,
	RuntimeSubmitTurnTransportV4Schema,
	runtimeRequestSigningPayloadV4,
	validateRuntimePinnedExecutionKeyScopeV4,
	validateRuntimePrivateRelayKeyFieldV1,
} from "@agent-infra/contracts/runtime";
import { createRelayKeyEncryptorV1 } from "@agent-infra/secret-store";
import { createRelayKeyWorkerDecryptorV1 } from "@agent-infra/secret-store/worker";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import {
	currentRelayKeyVersionInTransaction,
	type RelayKeyVersionBindingV1,
	RelayKeyVersionStoreError,
	readRelayKeyVersionInTransaction,
	replaceRelayKeyVersionInTransaction,
	revokeCurrentRelayKeyInTransaction,
	snapshotRelayKeyCiphertextV1,
} from "./relay-key-versions.ts";
import { relayKeyVersions } from "./schema-relay-keys.ts";

function ciphertext(binding: RelayKeyVersionBindingV1) {
	return {
		schemaVersion: 1,
		...binding,
		crypto: {
			schemaVersion: 1,
			algorithmVersion: "aes-256-gcm:v1",
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
			wrappingKeyVersion: "wrapping-key-1",
			aadVersion: "relay-key-aad:v1",
			dekFingerprint: "a".repeat(64),
			nonce: Buffer.alloc(12).toString("base64"),
			ciphertext: Buffer.alloc(16).toString("base64"),
			authenticationTag: Buffer.alloc(16).toString("base64"),
			wrappedDek: Buffer.alloc(384).toString("base64"),
		},
	};
}

// The transaction double checks state transitions; the PostgreSQL test below
// checks row locking. Migration registration remains a separate handoff gate.
function transaction() {
	type Row = { last_version: number; current_version: number | null };
	const subjects = new Map<string, Row>();
	const versions = new Map<string, { key_id: string; ciphertext: unknown }>();
	const query = Object.assign(
		async (
			strings: TemplateStringsArray,
			...args: unknown[]
		): Promise<unknown[]> => {
			const statement = strings.join("?").replace(/\s+/g, " ").trim();
			const key = `${args[0]}:${args[1]}`;
			if (statement.startsWith("insert into platform.relay_key_subjects")) {
				if (!subjects.has(key))
					subjects.set(key, { last_version: 0, current_version: null });
				return [];
			}
			if (statement.startsWith("select last_version, current_version")) {
				const row = subjects.get(key);
				return row
					? [
							{
								last_version: String(row.last_version),
								current_version:
									row.current_version === null
										? null
										: String(row.current_version),
							},
						]
					: [];
			}
			if (statement.startsWith("insert into platform.relay_key_versions")) {
				versions.set(`${key}:${args[2]}`, {
					key_id: args[3] as string,
					ciphertext: args[4],
				});
				return [];
			}
			if (
				statement.startsWith("update platform.relay_key_subjects") &&
				statement.includes("last_version")
			) {
				const row = subjects.get(`${args[2]}:${args[3]}`);
				if (!row) throw new Error("Missing subject row");
				row.last_version = args[0] as number;
				row.current_version = args[0] as number;
				return [];
			}
			if (
				statement.startsWith("update platform.relay_key_subjects") &&
				statement.includes("current_version = null")
			) {
				const row = subjects.get(key);
				if (!row) throw new Error("Missing subject row");
				row.current_version = null;
				return [];
			}
			if (statement.startsWith("select v.key_id")) {
				const version = subjects.get(key)?.current_version;
				const record =
					version === null || version === undefined
						? undefined
						: versions.get(`${key}:${version}`);
				return record && version
					? [{ key_id: record.key_id, key_version: String(version) }]
					: [];
			}
			if (statement.startsWith("select ciphertext")) {
				const record = versions.get(`${key}:${args[3]}`);
				return record && record.key_id === args[2]
					? [{ ciphertext: record.ciphertext }]
					: [];
			}
			throw new Error(`Unexpected query: ${statement}`);
		},
		{ json: (value: unknown) => value },
	);
	return { sql: query as never, subjects, versions };
}

describe("Relay Key version authority", () => {
	it("declares the four-column Execution binding constraint alongside Key ID uniqueness", () => {
		const config = getTableConfig(relayKeyVersions);
		expect(
			config.uniqueConstraints.map((constraint) => ({
				name: constraint.name,
				columns: constraint.columns.map((column) => column.name),
			})),
		).toContainEqual({
			name: "relay_key_version_identity_unique",
			columns: ["purpose", "subject_id", "key_version", "key_id"],
		});
		expect(config.indexes.map((index) => index.config.name)).toContain(
			"relay_key_version_key_id_unique",
		);
	});

	it("pins K1 for accepted work while K2 and later versions become current", async () => {
		const { sql, versions } = transaction();
		const target = { purpose: "personal" as const, subjectId: "user-a" };
		const first = await replaceRelayKeyVersionInTransaction(sql, {
			...target,
			expectedCurrentVersion: null,
			encrypt: ciphertext,
		});
		expect(first.outcome).toBe("replaced");
		if (first.outcome !== "replaced") throw new Error();
		const second = await replaceRelayKeyVersionInTransaction(sql, {
			...target,
			expectedCurrentVersion: 1,
			encrypt: ciphertext,
		});
		expect(second.outcome).toBe("replaced");
		if (second.outcome !== "replaced") throw new Error();
		expect(second.binding.keyVersion).toBe(2);
		expect(await currentRelayKeyVersionInTransaction(sql, target)).toEqual(
			second.binding,
		);
		expect(await readRelayKeyVersionInTransaction(sql, first.binding)).toEqual(
			ciphertext(first.binding),
		);
		expect(versions.size).toBe(2);
		const stale = await replaceRelayKeyVersionInTransaction(sql, {
			...target,
			expectedCurrentVersion: 1,
			encrypt: () => {
				throw new Error("must not encrypt stale command");
			},
		});
		expect(stale).toEqual({ outcome: "stale" });
		expect(
			await revokeCurrentRelayKeyInTransaction(sql, {
				...target,
				expectedCurrentVersion: 1,
			}),
		).toBe("stale");
		expect(
			await revokeCurrentRelayKeyInTransaction(sql, {
				...target,
				expectedCurrentVersion: 2,
			}),
		).toBe("revoked");
		expect(await currentRelayKeyVersionInTransaction(sql, target)).toBeNull();
		expect(await readRelayKeyVersionInTransaction(sql, first.binding)).toEqual(
			ciphertext(first.binding),
		);
		const third = await replaceRelayKeyVersionInTransaction(sql, {
			...target,
			expectedCurrentVersion: null,
			encrypt: ciphertext,
		});
		expect(third.outcome).toBe("replaced");
		if (third.outcome !== "replaced") throw new Error();
		expect(third.binding.keyVersion).toBe(3);
	});

	it("rejects ciphertext from a different purpose, subject, reference or version", async () => {
		const expected: RelayKeyVersionBindingV1 = {
			purpose: "personal",
			subjectId: "user-a",
			keyId: "key-a",
			keyVersion: 1,
		};
		for (const changed of [
			{ purpose: "agent-default" as const },
			{ subjectId: "user-b" },
			{ keyId: "key-b" },
			{ keyVersion: 2 },
		]) {
			expect(() =>
				snapshotRelayKeyCiphertextV1(
					ciphertext({ ...expected, ...changed }),
					expected,
				),
			).toThrow(RelayKeyVersionStoreError);
		}
		for (const malformed of [
			{ ...ciphertext(expected), plaintext: "must-not-be-stored" },
			{
				...ciphertext(expected),
				crypto: {
					...ciphertext(expected).crypto,
					plaintext: "must-not-be-stored",
				},
			},
			new Proxy(ciphertext(expected), {}),
			{
				...ciphertext(expected),
				crypto: { ...ciphertext(expected).crypto, ciphertext: "not-base64" },
			},
		]) {
			expect(() => snapshotRelayKeyCiphertextV1(malformed, expected)).toThrow(
				RelayKeyVersionStoreError,
			);
		}
	});

	it("does not read another subject or a mismatched ciphertext reference", async () => {
		const { sql } = transaction();
		const inserted = await replaceRelayKeyVersionInTransaction(sql, {
			purpose: "agent-default",
			subjectId: "agent-a",
			expectedCurrentVersion: null,
			encrypt: ciphertext,
		});
		if (inserted.outcome !== "replaced") throw new Error();
		for (const changed of [
			{ purpose: "personal" as const },
			{ subjectId: "agent-b" },
			{ keyId: "other-key" },
			{ keyVersion: 2 },
		]) {
			expect(
				await readRelayKeyVersionInTransaction(sql, {
					...inserted.binding,
					...changed,
				}),
			).toBeNull();
		}
	});
});

describe("Relay Key version authority on PostgreSQL", () => {
	let database: PostgresTestDatabase | undefined;

	beforeAll(async () => {
		database = await startPostgresTestDatabase("relay-key-versions");
		const client = postgres(database.databaseUrl, { max: 1 });
		try {
			await client`create schema platform`;
			await client`
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
			await client`
				create table platform.relay_key_versions (
					purpose text not null,
					subject_id text not null,
					key_version bigint not null,
					key_id text not null unique,
					ciphertext jsonb not null,
					primary key (purpose, subject_id, key_version),
					constraint relay_key_version_identity_unique
						unique (purpose, subject_id, key_version, key_id),
					foreign key (purpose, subject_id)
						references platform.relay_key_subjects (purpose, subject_id)
				)
			`;
			await client`
				create table platform.relay_key_binding_probe (
					purpose text not null,
					subject_id text not null,
					key_version bigint not null,
					key_id text not null,
					foreign key (purpose, subject_id, key_version, key_id)
						references platform.relay_key_versions
							(purpose, subject_id, key_version, key_id)
				)
			`;
		} finally {
			await client.end();
		}
	}, 120_000);

	afterAll(async () => database?.stop());

	it("enforces the exact four-column binding in PostgreSQL", async () => {
		if (!database) throw new Error("PostgreSQL test database is unavailable");
		const client = postgres(database.databaseUrl, { max: 2 });
		try {
			const first = await client.begin((sql) =>
				replaceRelayKeyVersionInTransaction(sql, {
					purpose: "personal",
					subjectId: "user-fk",
					expectedCurrentVersion: null,
					encrypt: ciphertext,
				}),
			);
			if (first.outcome !== "replaced") throw new Error();
			const binding = first.binding;
			await client`
				insert into platform.relay_key_binding_probe
					(purpose, subject_id, key_version, key_id)
				values (${binding.purpose}, ${binding.subjectId}, ${binding.keyVersion}, ${binding.keyId})
			`;
			await expect(client`
				insert into platform.relay_key_binding_probe
					(purpose, subject_id, key_version, key_id)
				values (${binding.purpose}, ${binding.subjectId}, ${binding.keyVersion}, ${"wrong-key"})
			`).rejects.toMatchObject({ code: "23503" });
		} finally {
			await client.end();
		}
	}, 120_000);

	it("reads and decrypts only the accepted ciphertext version after replacement and revoke", async () => {
		if (!database) throw new Error("PostgreSQL test database is unavailable");
		const client = postgres(database.databaseUrl, { max: 2 });
		const { publicKey, privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 3072,
		});
		const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
		const encryptor = createRelayKeyEncryptorV1({
			encryptionKeys: {
				schemaVersion: 1,
				activeWrappingKeyVersion: "test-wrapping-key",
				keys: [
					{
						schemaVersion: 1,
						keyVersion: "test-wrapping-key",
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
					keyVersion: "test-wrapping-key",
					privateKeyPkcs8DerBase64: privateKey
						.export({ format: "der", type: "pkcs8" })
						.toString("base64"),
				},
			],
		});
		const target = { purpose: "personal" as const, subjectId: "user-crypto" };
		const k1 = "sk-user-crypto-version-one";
		const k2 = "sk-user-crypto-version-two";
		async function decryptedText(
			record: unknown,
			binding: RelayKeyVersionBindingV1,
		) {
			const result = await decryptor.decrypt({
				encryptedRecord: record,
				expectedBinding: binding,
			});
			expect(result.outcome).toBe("decrypted");
			if (result.outcome !== "decrypted") throw new Error();
			try {
				return Buffer.from(result.plaintext).toString("utf8");
			} finally {
				result.plaintext.fill(0);
			}
		}
		async function fakeWorkerTransport(request: RuntimeSubmitTurnRequestV4) {
			const binding = {
				purpose: request.keyBinding.purpose,
				subjectId: request.keyBinding.subjectId,
				keyId: request.keyBinding.ciphertextRef,
				keyVersion: request.keyBinding.version,
			};
			const record = await client.begin((sql) =>
				readRelayKeyVersionInTransaction(sql, binding),
			);
			if (!record) return null;
			const result = await decryptor.decrypt({
				encryptedRecord: record,
				expectedBinding: binding,
			});
			if (result.outcome !== "decrypted") return null;
			try {
				const {
					schemaVersion: _schemaVersion,
					grant: _grant,
					input: _input,
					selection: _selection,
					...context
				} = request;
				return RuntimeSubmitTurnTransportV4Schema.parse({
					businessRequest: request,
					privateKeyField: {
						schemaVersion: 1,
						context: {
							...context,
							grantId: "grant-crypto-fixture",
							requestDigest: createHash("sha256")
								.update(runtimeRequestSigningPayloadV4(request))
								.digest("hex"),
						},
						keyDelivery: {
							relayKey: Buffer.from(result.plaintext).toString("utf8"),
						},
					},
				});
			} finally {
				result.plaintext.fill(0);
			}
		}
		const driverKeys: string[] = [];
		function fakeHost(
			transport: RuntimeSubmitTurnTransportV4,
			original: RuntimeSubmitTurnRequestV4,
		) {
			const privateField = validateRuntimePrivateRelayKeyFieldV1(
				transport.privateKeyField,
				{
					request: transport.businessRequest,
					grantId: "grant-crypto-fixture",
					requestDigest: createHash("sha256")
						.update(runtimeRequestSigningPayloadV4(transport.businessRequest))
						.digest("hex"),
				},
			);
			validateRuntimePinnedExecutionKeyScopeV4(
				original,
				transport.businessRequest,
				null,
			);
			driverKeys.push(privateField.keyDelivery.relayKey);
		}
		try {
			const first = await client.begin((sql) =>
				replaceRelayKeyVersionInTransaction(sql, {
					...target,
					expectedCurrentVersion: null,
					encrypt: (binding) =>
						encryptor.encrypt({ ...binding, plaintext: k1 }),
				}),
			);
			if (first.outcome !== "replaced") throw new Error();
			const acceptedBinding = first.binding;
			const second = await client.begin((sql) =>
				replaceRelayKeyVersionInTransaction(sql, {
					...target,
					expectedCurrentVersion: 1,
					encrypt: (binding) =>
						encryptor.encrypt({ ...binding, plaintext: k2 }),
				}),
			);
			if (second.outcome !== "replaced") throw new Error();
			expect(
				await client.begin((sql) =>
					currentRelayKeyVersionInTransaction(sql, target),
				),
			).toEqual(second.binding);
			const pinnedRecord = await client.begin((sql) =>
				readRelayKeyVersionInTransaction(sql, acceptedBinding),
			);
			const currentRecord = await client.begin((sql) =>
				readRelayKeyVersionInTransaction(sql, second.binding),
			);
			expect(pinnedRecord).not.toBeNull();
			expect(JSON.stringify(pinnedRecord)).not.toContain(k1);
			expect(JSON.stringify(currentRecord)).not.toContain(k2);
			expect(await decryptedText(pinnedRecord, acceptedBinding)).toBe(k1);
			expect(await decryptedText(currentRecord, second.binding)).toBe(k2);
			const k1Request = RuntimeSubmitTurnRequestV4Schema.parse({
				schemaVersion: 4,
				requestId: "request-crypto-k1",
				traceId: "trace-crypto",
				principal: { kind: "user", id: target.subjectId },
				executionSource: "web",
				channelId: "web",
				agentId: "agent-crypto",
				conversationId: "conversation-crypto",
				executionId: "execution-crypto-k1",
				turnId: "turn-crypto-k1",
				sessionGeneration: 1,
				hostSessionRef: null,
				operation: {
					kind: "execution",
					id: "execution-crypto-k1",
					deliveryFence: 1,
					executionDeliveryFence: 1,
				},
				grant: {
					schemaVersion: 4,
					format: "runtime-execution-jws",
					token: "a.b.c",
				},
				keyBinding: {
					purpose: acceptedBinding.purpose,
					subjectId: acceptedBinding.subjectId,
					ciphertextRef: acceptedBinding.keyId,
					version: acceptedBinding.keyVersion,
				},
				input: { text: "synthetic input", attachments: [] },
				selection: {
					schemaVersion: 1,
					modelOptionId: "model-crypto",
					reasoningLevel: "high",
				},
			});
			const k2Request = RuntimeSubmitTurnRequestV4Schema.parse({
				...k1Request,
				requestId: "request-crypto-k2",
				executionId: "execution-crypto-k2",
				turnId: "turn-crypto-k2",
				operation: { ...k1Request.operation, id: "execution-crypto-k2" },
				keyBinding: {
					purpose: second.binding.purpose,
					subjectId: second.binding.subjectId,
					ciphertextRef: second.binding.keyId,
					version: second.binding.keyVersion,
				},
			});
			const k1Transport = await fakeWorkerTransport(k1Request);
			const k2Transport = await fakeWorkerTransport(k2Request);
			if (!k1Transport || !k2Transport)
				throw new Error("Missing fake Key delivery");
			fakeHost(k1Transport, k1Request);
			const reboundRequest = RuntimeSubmitTurnRequestV4Schema.parse({
				...k1Request,
				requestId: "request-crypto-rebound",
				keyBinding: k2Request.keyBinding,
			});
			const reboundTransport = await fakeWorkerTransport(reboundRequest);
			if (!reboundTransport) throw new Error("Missing fake rebound delivery");
			expect(() => fakeHost(reboundTransport, k1Request)).toThrow(
				"RuntimeHostV4 pinned Execution Key is invalid",
			);
			fakeHost(k2Transport, k2Request);
			expect(
				await fakeWorkerTransport(
					RuntimeSubmitTurnRequestV4Schema.parse({
						...k1Request,
						principal: { kind: "user", id: "other-user" },
						keyBinding: { ...k1Request.keyBinding, subjectId: "other-user" },
					}),
				),
			).toBeNull();
			expect(
				await decryptor.decrypt({
					encryptedRecord: pinnedRecord,
					expectedBinding: second.binding,
				}),
			).toEqual({ outcome: "failed", code: "RELAY_KEY_METADATA_INVALID" });
			expect(
				await client.begin((sql) =>
					readRelayKeyVersionInTransaction(sql, {
						...acceptedBinding,
						subjectId: "other-user",
					}),
				),
			).toBeNull();
			expect(
				await client.begin((sql) =>
					revokeCurrentRelayKeyInTransaction(sql, {
						...target,
						expectedCurrentVersion: 2,
					}),
				),
			).toBe("revoked");
			expect(
				await client.begin((sql) =>
					currentRelayKeyVersionInTransaction(sql, target),
				),
			).toBeNull();
			expect(
				await client.begin((sql) =>
					readRelayKeyVersionInTransaction(sql, acceptedBinding),
				),
			).toEqual(pinnedRecord);
			expect(await decryptedText(pinnedRecord, acceptedBinding)).toBe(k1);
			const resumedK1 = await fakeWorkerTransport(k1Request);
			if (!resumedK1) throw new Error("Missing pinned Key after revoke");
			fakeHost(resumedK1, k1Request);
			expect(driverKeys).toEqual([k1, k2, k1]);
		} finally {
			await client.end();
		}
	}, 120_000);

	it("serializes concurrent replacement and preserves pinned versions after revoke", async () => {
		if (!database) throw new Error("PostgreSQL test database is unavailable");
		const client = postgres(database.databaseUrl, { max: 4 });
		const target = { purpose: "personal" as const, subjectId: "user-a" };
		try {
			const attempts = await Promise.all(
				Array.from({ length: 2 }, () =>
					client.begin((sql) =>
						replaceRelayKeyVersionInTransaction(sql, {
							...target,
							expectedCurrentVersion: null,
							encrypt: ciphertext,
						}),
					),
				),
			);
			expect(attempts.map(({ outcome }) => outcome).sort()).toEqual([
				"replaced",
				"stale",
			]);
			const first = attempts.find((attempt) => attempt.outcome === "replaced");
			if (first?.outcome !== "replaced") throw new Error();
			expect(first.binding.keyVersion).toBe(1);
			const second = await client.begin((sql) =>
				replaceRelayKeyVersionInTransaction(sql, {
					...target,
					expectedCurrentVersion: 1,
					encrypt: ciphertext,
				}),
			);
			if (second.outcome !== "replaced") throw new Error();
			expect(second.binding.keyVersion).toBe(2);
			expect(
				await client.begin((sql) =>
					currentRelayKeyVersionInTransaction(sql, target),
				),
			).toEqual(second.binding);
			expect(
				await client.begin((sql) =>
					readRelayKeyVersionInTransaction(sql, first.binding),
				),
			).toEqual(ciphertext(first.binding));
			for (const changed of [
				{ purpose: "agent-default" as const },
				{ subjectId: "user-b" },
				{ keyId: "another-key" },
				{ keyVersion: 2 },
			]) {
				expect(
					await client.begin((sql) =>
						readRelayKeyVersionInTransaction(sql, {
							...first.binding,
							...changed,
						}),
					),
				).toBeNull();
			}
			expect(
				await client.begin((sql) =>
					revokeCurrentRelayKeyInTransaction(sql, {
						...target,
						expectedCurrentVersion: 1,
					}),
				),
			).toBe("stale");
			expect(
				await client.begin((sql) =>
					revokeCurrentRelayKeyInTransaction(sql, {
						...target,
						expectedCurrentVersion: 2,
					}),
				),
			).toBe("revoked");
			expect(
				await client.begin((sql) =>
					currentRelayKeyVersionInTransaction(sql, target),
				),
			).toBeNull();
			expect(
				await client.begin((sql) =>
					readRelayKeyVersionInTransaction(sql, first.binding),
				),
			).toEqual(ciphertext(first.binding));
			const third = await client.begin((sql) =>
				replaceRelayKeyVersionInTransaction(sql, {
					...target,
					expectedCurrentVersion: null,
					encrypt: ciphertext,
				}),
			);
			expect(third.outcome).toBe("replaced");
			if (third.outcome === "replaced")
				expect(third.binding.keyVersion).toBe(3);
		} finally {
			await client.end();
		}
	}, 120_000);

	it("holds the selected version until its read transaction commits", async () => {
		if (!database) throw new Error("PostgreSQL test database is unavailable");
		const client = postgres(database.databaseUrl, { max: 4 });
		const target = { purpose: "personal" as const, subjectId: "user-locked" };
		try {
			const first = await client.begin((sql) =>
				replaceRelayKeyVersionInTransaction(sql, {
					...target,
					expectedCurrentVersion: null,
					encrypt: ciphertext,
				}),
			);
			if (first.outcome !== "replaced") throw new Error();
			let reportRead = (_value: RelayKeyVersionBindingV1 | null) => {};
			const read = new Promise<RelayKeyVersionBindingV1 | null>((resolve) => {
				reportRead = resolve;
			});
			let release = () => {};
			const hold = new Promise<void>((resolve) => {
				release = resolve;
			});
			const acceptance = client.begin(async (sql) => {
				const selected = await currentRelayKeyVersionInTransaction(sql, target);
				reportRead(selected);
				await hold;
				return selected;
			});
			try {
				expect(await read).toEqual(first.binding);
				const replacement = client.begin((sql) =>
					replaceRelayKeyVersionInTransaction(sql, {
						...target,
						expectedCurrentVersion: 1,
						encrypt: ciphertext,
					}),
				);
				try {
					let blocked = false;
					for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
						const rows = await client<{ blocked: boolean }[]>`
							select exists (
								select 1 from pg_stat_activity
								where datname = current_database()
									and pid <> pg_backend_pid()
									and wait_event_type = 'Lock'
									and query like '%relay_key_subjects%'
							) as blocked
						`;
						blocked = rows[0]?.blocked ?? false;
						if (!blocked)
							await new Promise((resolve) => setTimeout(resolve, 25));
					}
					expect(blocked).toBe(true);
				} finally {
					release();
				}
				const [selected, second] = await Promise.all([acceptance, replacement]);
				expect(selected).toEqual(first.binding);
				expect(second.outcome).toBe("replaced");
				if (second.outcome === "replaced")
					expect(second.binding.keyVersion).toBe(2);
			} finally {
				release();
			}
		} finally {
			await client.end();
		}
	}, 120_000);
});
