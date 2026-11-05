import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
	type PlatformSecretRecordV1,
	validatePlatformSecretRecordV1,
} from "@agent-infra/contracts/workload";
import { platformDatabaseUrlFromEnvironment } from "./migrate.ts";
import postgres from "./observed-postgres.js";

/** One Owner Secret reference from the verified Agent deployment. */
export interface SessionOwnerSecretReferenceV1 {
	readonly ownerType: string;
	readonly ownerId: string;
	readonly agentId: string;
	readonly secretId: string;
	readonly secretVersion: number;
	readonly configRevision: number;
	readonly algorithmVersion: string;
	readonly wrappingAlgorithmVersion: string;
	readonly wrappingKeyVersion: string;
}

class SessionOwnerSecretStoreError extends Error {
	constructor() {
		super("Session Owner Secret is unavailable");
		this.name = "SessionOwnerSecretStoreError";
	}
}

function text(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\0") ||
		!String.prototype.isWellFormed.call(value) ||
		Buffer.byteLength(value, "utf8") > 1024
	)
		throw new SessionOwnerSecretStoreError();
	return value;
}

/**
 * Original ciphertext records for custom Session Owner Secrets (Engineering
 * Spec §10.1.1, #3938). Plaintext never passes through this Store; the Worker
 * decrypts the returned records with its own keyring and audits each attempt.
 */
export class PostgresSessionOwnerSecretStoreV1 {
	readonly #client: postgres.Sql;
	readonly #ownsClient: boolean;

	constructor(
		options:
			| { readonly databaseUrl: string }
			/** Shared pool; each call runs in its own short statement or transaction. */
			| { readonly client: postgres.Sql },
	) {
		if ("client" in options) {
			this.#client = options.client;
			this.#ownsClient = false;
			return;
		}
		this.#client = postgres(
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: text(options.databaseUrl),
			}),
			{ max: 4 },
		);
		this.#ownsClient = true;
	}

	async close(): Promise<void> {
		if (this.#ownsClient) await this.#client.end();
	}

	/**
	 * Every reference must name exactly one active record of the same Agent,
	 * owned by a current Agent owner and wrapped by an unretired key; any other
	 * state fails closed without returning a record.
	 */
	async resolve(input: {
		readonly agentId: string;
		readonly references: readonly SessionOwnerSecretReferenceV1[];
	}): Promise<readonly PlatformSecretRecordV1[]> {
		try {
			const agentId = text(input.agentId);
			const references = input.references;
			if (
				!Array.isArray(references) ||
				references.length === 0 ||
				references.length > 64 ||
				new Set(
					references.map(
						(reference) => `${reference.secretId}\0${reference.secretVersion}`,
					),
				).size !== references.length
			)
				throw new SessionOwnerSecretStoreError();
			const secretIds = [
				...new Set(references.map((reference) => text(reference.secretId))),
			];
			return await this.#client.begin(
				"isolation level repeatable read read only",
				async (sql) => {
					const rows = await sql<{ record: unknown }[]>`
						select record from platform.secret_records
						where agent_id = ${agentId} and secret_id = any(${sql.array(secretIds)})`;
					const records = rows.map((row) =>
						validatePlatformSecretRecordV1(row.record),
					);
					const owners = new Set(
						(
							await sql<{ owner_id: string }[]>`
								select owner_id from platform.agent_owners where agent_id = ${agentId}`
						).map((row) => row.owner_id),
					);
					const keyVersions = [
						...new Set(
							records.map((record) => record.crypto.wrappingKeyVersion),
						),
					];
					const retired = new Set(
						keyVersions.length
							? (
									await sql<{ key_version: string }[]>`
										select key_version from platform.retired_secret_wrapping_keys
										where key_version = any(${sql.array(keyVersions)})`
								).map((row) => row.key_version)
							: [],
					);
					return references.map((reference) => {
						const matches = records.filter(
							(record) =>
								record.secretId === reference.secretId &&
								record.secretVersion === reference.secretVersion,
						);
						const record = matches.length === 1 ? matches[0] : undefined;
						if (
							!record ||
							reference.agentId !== agentId ||
							record.agentId !== agentId ||
							reference.ownerType !== "agent-owner" ||
							record.ownerType !== "agent-owner" ||
							record.ownerId !== reference.ownerId ||
							!owners.has(record.ownerId) ||
							record.configRevision !== reference.configRevision ||
							record.lifecycleState !== "active" ||
							record.crypto.algorithmVersion !== reference.algorithmVersion ||
							record.crypto.wrappingAlgorithmVersion !==
								reference.wrappingAlgorithmVersion ||
							record.crypto.wrappingKeyVersion !==
								reference.wrappingKeyVersion ||
							retired.has(record.crypto.wrappingKeyVersion)
						)
							throw new SessionOwnerSecretStoreError();
						return record;
					});
				},
			);
		} catch {
			throw new SessionOwnerSecretStoreError();
		}
	}

	/** Same value-free `secret.decrypt` event as the Agent Workload path. */
	async auditDecryption(input: {
		readonly agentId: string;
		readonly secretId: string;
		readonly wrappingKeyVersion: string;
		readonly outcome: "succeeded" | "rejected";
		readonly traceId: string;
		readonly requestId: string;
		readonly workerId: string;
	}): Promise<void> {
		try {
			if (input.outcome !== "succeeded" && input.outcome !== "rejected")
				throw new SessionOwnerSecretStoreError();
			const details = {
				wrappingKeyVersion: text(input.wrappingKeyVersion),
				operation: "decrypt",
				result: input.outcome,
			};
			await this.#client`
				insert into platform.audit_events
					(id, trace_id, actor_type, actor_id, action, target_type, target_id,
					 outcome, request_id, agent_id, details)
				values
					(${randomUUID()}, ${text(input.traceId)}, 'system', ${text(input.workerId)},
					 'secret.decrypt', 'secret', ${text(input.secretId)}, ${input.outcome},
					 ${text(input.requestId)}, ${text(input.agentId)}, ${this.#client.json(details)})`;
		} catch {
			throw new SessionOwnerSecretStoreError();
		}
	}
}
