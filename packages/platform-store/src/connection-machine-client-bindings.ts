import { createHash } from "node:crypto";
import postgres from "./observed-postgres.js";

const registrationKeyHashDomain =
	"agent-infra/connection-machine-registration-key/v1\0";

/** Domain-separated SHA-256. The key is already high-entropy, so no stored salt is needed. */
export function connectionMachineRegistrationKeyHashV1(key: string): string {
	return createHash("sha256")
		.update(registrationKeyHashDomain, "utf8")
		.update(key, "utf8")
		.digest("hex");
}

export interface ConnectionMachineClientBindingV1 {
	readonly clientId: string;
	readonly callbackUrl: string;
	readonly profileFingerprint: string;
	readonly source: { readonly ref: string; readonly revision: string };
	readonly registrationKey?: string;
}

type Row = {
	agent_id: string;
	association_revision: number;
	client_id: string;
	callback_url: string;
	profile_fingerprint: string;
	source_ref: string;
	source_revision: string;
	registration_key_hash: string | null;
};

/**
 * Stores only the non-secret receipt of a per-install machine client.
 * The association revision is checked against the current manual association
 * inside the same transaction so an old binding cannot be revived.
 */
export class PostgresConnectionMachineClientBindingStoreV1 {
	readonly #client: ReturnType<typeof postgres>;

	constructor(input: { readonly databaseUrl: string }) {
		this.#client = postgres(input.databaseUrl, { max: 2 });
	}

	async load(
		agentId: string,
		associationRevision: number,
		registrationKey: string,
	): Promise<ConnectionMachineClientBindingV1 | undefined> {
		if (!registrationKey) throw new Error("CONNECTION_MACHINE_BINDING_REGISTRATION_KEY_REQUIRED");
		const registrationKeyHash = connectionMachineRegistrationKeyHashV1(
			registrationKey,
		);
		const rows = await this.#client<Row[]>`
				select binding.agent_id, binding.association_revision, binding.client_id, binding.callback_url,
					binding.profile_fingerprint, binding.source_ref, binding.source_revision, binding.registration_key_hash
				from platform.connection_machine_client_bindings as binding
				inner join platform.connection_manual_associations as association
					on association.agent_id = binding.agent_id
					and association.association_revision = binding.association_revision
				where binding.agent_id = ${agentId}
					and binding.registration_key_hash = ${registrationKeyHash}
		`;
		const [row] = rows;
		if (
			!row ||
			(associationRevision !== undefined &&
				String(row.association_revision) !== String(associationRevision))
		)
			return undefined;
		return toBinding(row);
	}

	async persist(
		agentId: string,
		binding: ConnectionMachineClientBindingV1,
		associationRevision: number,
	): Promise<void> {
		await this.#client.begin(async (sql) => {
			const [association] = await sql<{ association_revision: number }[]>`
				select association_revision
				from platform.connection_manual_associations
				where agent_id = ${agentId}
				for update
			`;
			if (
				!association ||
				String(association.association_revision) !== String(associationRevision)
			)
				throw new Error("CONNECTION_MACHINE_BINDING_REVISION_CONFLICT");
			await sql`
				insert into platform.connection_machine_client_bindings (
					agent_id, association_revision, client_id, callback_url,
					profile_fingerprint, source_ref, source_revision, registration_key_hash
				) values (
					${agentId}, ${associationRevision}, ${binding.clientId}, ${binding.callbackUrl},
					${binding.profileFingerprint}, ${binding.source.ref}, ${binding.source.revision},
					${binding.registrationKey === undefined ? null : connectionMachineRegistrationKeyHashV1(binding.registrationKey)}
				)
				on conflict (agent_id) do update set
					association_revision = excluded.association_revision,
					client_id = excluded.client_id,
					callback_url = excluded.callback_url,
					profile_fingerprint = excluded.profile_fingerprint,
					source_ref = excluded.source_ref,
					source_revision = excluded.source_revision,
					registration_key_hash = excluded.registration_key_hash,
					updated_at = now()
			`;
		});
	}

	async close(): Promise<void> {
		await this.#client.end();
	}
}

function toBinding(row: Row): ConnectionMachineClientBindingV1 {
	return {
		clientId: row.client_id,
		callbackUrl: row.callback_url,
		profileFingerprint: row.profile_fingerprint,
		source: { ref: row.source_ref, revision: row.source_revision },
	};
}
