import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { types } from "node:util";

import postgres from "postgres";

import { platformDatabaseUrlFromEnvironment } from "./migrate.js";

export type RelayKeyPurposeV1 = "personal" | "agent-default";

export interface RelayKeyVersionBindingV1 {
	readonly purpose: RelayKeyPurposeV1;
	readonly subjectId: string;
	readonly keyId: string;
	readonly keyVersion: number;
}

export interface RelayKeyVersionSubjectV1 {
	readonly purpose: RelayKeyPurposeV1;
	readonly subjectId: string;
}

export interface RelayKeyVersionCiphertextV1 extends RelayKeyVersionBindingV1 {
	readonly schemaVersion: 1;
	readonly crypto: {
		readonly schemaVersion: 1;
		readonly algorithmVersion: "aes-256-gcm:v1";
		readonly wrappingAlgorithmVersion: "rsa-oaep-sha256:v1";
		readonly wrappingKeyVersion: string;
		readonly aadVersion: "relay-key-aad:v1";
		readonly dekFingerprint: string;
		readonly nonce: string;
		readonly ciphertext: string;
		readonly authenticationTag: string;
		readonly wrappedDek: string;
	};
}

export class RelayKeyVersionStoreError extends Error {
	constructor() {
		super("Relay Key version persistence failed");
		this.name = "RelayKeyVersionStoreError";
	}
}

function validId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value) &&
		Buffer.byteLength(value, "utf8") <= 1024
	);
}

function object(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		types.isProxy(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Reflect.ownKeys(value).length !== keys.length
	)
		throw new RelayKeyVersionStoreError();
	const snapshot: Record<string, unknown> = {};
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (
			!descriptor ||
			!Object.hasOwn(descriptor, "value") ||
			!descriptor.enumerable
		)
			throw new RelayKeyVersionStoreError();
		snapshot[key] = descriptor.value;
	}
	return snapshot;
}

function base64(
	value: unknown,
	minimum: number,
	maximum: number,
): value is string {
	if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4)
		return false;
	const decoded = Buffer.from(value, "base64");
	return (
		decoded.byteLength >= minimum &&
		decoded.byteLength <= maximum &&
		decoded.toString("base64") === value
	);
}

function subject(value: RelayKeyVersionSubjectV1): RelayKeyVersionSubjectV1 {
	if (
		(value.purpose !== "personal" && value.purpose !== "agent-default") ||
		!validId(value.subjectId)
	)
		throw new RelayKeyVersionStoreError();
	return { purpose: value.purpose, subjectId: value.subjectId };
}

function version(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1)
		throw new RelayKeyVersionStoreError();
	return value as number;
}

function binding(value: RelayKeyVersionBindingV1): RelayKeyVersionBindingV1 {
	if (!validId(value.keyId)) throw new RelayKeyVersionStoreError();
	return {
		...subject(value),
		keyId: value.keyId,
		keyVersion: version(value.keyVersion),
	};
}

// Copy each scalar into a fresh object. The Store never receives plaintext and
// never persists an arbitrary object with extra fields or accessors.
export function snapshotRelayKeyCiphertextV1(
	value: unknown,
	expected: RelayKeyVersionBindingV1,
): RelayKeyVersionCiphertextV1 {
	try {
		const record = object(value, [
			"schemaVersion",
			"purpose",
			"subjectId",
			"keyId",
			"keyVersion",
			"crypto",
		]);
		const crypto = object(record.crypto, [
			"schemaVersion",
			"algorithmVersion",
			"wrappingAlgorithmVersion",
			"wrappingKeyVersion",
			"aadVersion",
			"dekFingerprint",
			"nonce",
			"ciphertext",
			"authenticationTag",
			"wrappedDek",
		]);
		const required = binding(expected);
		if (
			record.schemaVersion !== 1 ||
			record.purpose !== required.purpose ||
			record.subjectId !== required.subjectId ||
			record.keyId !== required.keyId ||
			record.keyVersion !== required.keyVersion ||
			crypto.schemaVersion !== 1 ||
			crypto.algorithmVersion !== "aes-256-gcm:v1" ||
			crypto.wrappingAlgorithmVersion !== "rsa-oaep-sha256:v1" ||
			crypto.aadVersion !== "relay-key-aad:v1" ||
			!validId(crypto.wrappingKeyVersion) ||
			typeof crypto.dekFingerprint !== "string" ||
			!/^[a-f0-9]{64}$/.test(crypto.dekFingerprint) ||
			!base64(crypto.nonce, 12, 12) ||
			!base64(crypto.ciphertext, 16, 8192) ||
			!base64(crypto.authenticationTag, 16, 16) ||
			!base64(crypto.wrappedDek, 384, 8192)
		)
			throw new RelayKeyVersionStoreError();
		return {
			schemaVersion: 1,
			...required,
			crypto: {
				schemaVersion: 1,
				algorithmVersion: "aes-256-gcm:v1",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				wrappingKeyVersion: crypto.wrappingKeyVersion,
				aadVersion: "relay-key-aad:v1",
				dekFingerprint: crypto.dekFingerprint,
				nonce: crypto.nonce,
				ciphertext: crypto.ciphertext,
				authenticationTag: crypto.authenticationTag,
				wrappedDek: crypto.wrappedDek,
			},
		} as RelayKeyVersionCiphertextV1;
	} catch {
		throw new RelayKeyVersionStoreError();
	}
}

interface SubjectRow {
	readonly last_version: string;
	readonly current_version: string | null;
}

interface CiphertextRow {
	readonly ciphertext: unknown;
}

type Transaction = postgres.TransactionSql;

function postgresVersion(value: string, minimum: number): number {
	if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
		throw new RelayKeyVersionStoreError();
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum)
		throw new RelayKeyVersionStoreError();
	return parsed;
}

export async function currentRelayKeyVersionInTransaction(
	sql: Transaction,
	input: RelayKeyVersionSubjectV1,
): Promise<RelayKeyVersionBindingV1 | null> {
	const target = subject(input);
	const rows = await sql<{ key_id: string; key_version: string }[]>`
		select v.key_id, v.key_version
		from platform.relay_key_subjects s
		join platform.relay_key_versions v
			on v.purpose = s.purpose and v.subject_id = s.subject_id
			and v.key_version = s.current_version
		where s.purpose = ${target.purpose} and s.subject_id = ${target.subjectId}
		for share of s
	`;
	const row = rows[0];
	if (!row) return null;
	return binding({
		...target,
		keyId: row.key_id,
		keyVersion: postgresVersion(row.key_version, 1),
	});
}

export async function replaceRelayKeyVersionInTransaction(
	sql: Transaction,
	input: RelayKeyVersionSubjectV1 & {
		readonly expectedCurrentVersion: number | null;
		readonly encrypt: (
			binding: RelayKeyVersionBindingV1,
		) => unknown | Promise<unknown>;
	},
): Promise<
	| { readonly outcome: "replaced"; readonly binding: RelayKeyVersionBindingV1 }
	| { readonly outcome: "stale" }
> {
	const target = subject(input);
	if (input.expectedCurrentVersion !== null)
		version(input.expectedCurrentVersion);
	await sql`
		insert into platform.relay_key_subjects (purpose, subject_id)
		values (${target.purpose}, ${target.subjectId})
		on conflict (purpose, subject_id) do nothing
	`;
	const rows = await sql<SubjectRow[]>`
		select last_version, current_version
		from platform.relay_key_subjects
		where purpose = ${target.purpose} and subject_id = ${target.subjectId}
		for update
	`;
	const row = rows[0];
	if (!row) throw new RelayKeyVersionStoreError();
	const lastVersion = postgresVersion(row.last_version, 0);
	const currentVersion =
		row.current_version === null
			? null
			: postgresVersion(row.current_version, 1);
	if (currentVersion !== input.expectedCurrentVersion)
		return { outcome: "stale" };
	const next = lastVersion + 1;
	version(next);
	const nextBinding = binding({
		...target,
		keyId: randomUUID(),
		keyVersion: next,
	});
	const encrypted = snapshotRelayKeyCiphertextV1(
		await input.encrypt(nextBinding),
		nextBinding,
	);
	await sql`
		insert into platform.relay_key_versions
			(purpose, subject_id, key_version, key_id, ciphertext)
		values
			(${target.purpose}, ${target.subjectId}, ${next}, ${nextBinding.keyId},
			 ${sql.json(encrypted as unknown as postgres.JSONValue)})
	`;
	await sql`
		update platform.relay_key_subjects
		set last_version = ${next}, current_version = ${next}, updated_at = now()
		where purpose = ${target.purpose} and subject_id = ${target.subjectId}
	`;
	return { outcome: "replaced", binding: nextBinding };
}

export async function revokeCurrentRelayKeyInTransaction(
	sql: Transaction,
	input: RelayKeyVersionSubjectV1 & { readonly expectedCurrentVersion: number },
): Promise<"revoked" | "stale"> {
	const target = subject(input);
	version(input.expectedCurrentVersion);
	const rows = await sql<SubjectRow[]>`
		select last_version, current_version
		from platform.relay_key_subjects
		where purpose = ${target.purpose} and subject_id = ${target.subjectId}
		for update
	`;
	if (
		rows[0]?.current_version === null ||
		rows[0]?.current_version === undefined ||
		postgresVersion(rows[0].current_version, 1) !== input.expectedCurrentVersion
	)
		return "stale";
	await sql`
		update platform.relay_key_subjects
		set current_version = null, updated_at = now()
		where purpose = ${target.purpose} and subject_id = ${target.subjectId}
	`;
	return "revoked";
}

// The caller must first verify the immutable binding on an accepted Execution
// in its authorization transaction. This exact lookup never substitutes the
// subject's current version for the Execution's pinned version.
export async function readRelayKeyVersionInTransaction(
	sql: Transaction,
	input: RelayKeyVersionBindingV1,
): Promise<RelayKeyVersionCiphertextV1 | null> {
	const expected = binding(input);
	const rows = await sql<CiphertextRow[]>`
		select ciphertext from platform.relay_key_versions
		where purpose = ${expected.purpose} and subject_id = ${expected.subjectId}
			and key_id = ${expected.keyId} and key_version = ${expected.keyVersion}
	`;
	if (!rows[0]) return null;
	return snapshotRelayKeyCiphertextV1(rows[0].ciphertext, expected);
}

export class PostgresRelayKeyVersionStoreV1 {
	readonly #client: ReturnType<typeof postgres>;

	constructor(options: { readonly databaseUrl: string }) {
		this.#client = postgres(
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: options.databaseUrl,
			}),
			{ max: 4 },
		);
	}

	async close(): Promise<void> {
		await this.#client.end();
	}

	async current(
		input: RelayKeyVersionSubjectV1,
	): Promise<RelayKeyVersionBindingV1 | null> {
		try {
			return await this.#client.begin((sql) =>
				currentRelayKeyVersionInTransaction(sql, input),
			);
		} catch {
			throw new RelayKeyVersionStoreError();
		}
	}

	async replace(
		input: Parameters<typeof replaceRelayKeyVersionInTransaction>[1],
	): ReturnType<typeof replaceRelayKeyVersionInTransaction> {
		try {
			return await this.#client.begin((sql) =>
				replaceRelayKeyVersionInTransaction(sql, input),
			);
		} catch {
			throw new RelayKeyVersionStoreError();
		}
	}

	async revoke(
		input: Parameters<typeof revokeCurrentRelayKeyInTransaction>[1],
	): ReturnType<typeof revokeCurrentRelayKeyInTransaction> {
		try {
			return await this.#client.begin((sql) =>
				revokeCurrentRelayKeyInTransaction(sql, input),
			);
		} catch {
			throw new RelayKeyVersionStoreError();
		}
	}

	async read(
		input: RelayKeyVersionBindingV1,
	): Promise<RelayKeyVersionCiphertextV1 | null> {
		try {
			return await this.#client.begin((sql) =>
				readRelayKeyVersionInTransaction(sql, input),
			);
		} catch {
			throw new RelayKeyVersionStoreError();
		}
	}
}
