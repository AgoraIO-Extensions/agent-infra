import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "./observed-postgres.js";
import { connectionManualAssociations } from "./schema-connection-registration.js";

type Query = (
	template: TemplateStringsArray,
	...values: string[]
) => PromiseLike<readonly unknown[]>;

/**
 * #4199 C2 (Spec §13.5.6 工具声明): the Agent has a verified Owner manual association whose
 * Owner is still a current, enabled Owner of that Agent. Replacing or removing the Owner does
 * not delete the association row, so its existence alone is not enough. Selects no credential.
 */
export async function hasCurrentConnectionManualAssociationV1(
	query: Query,
	agentId: string,
) {
	const rows =
		await query`select a.agent_id from platform.connection_manual_associations a
		join platform.agent_owners own on own.agent_id = a.agent_id and own.owner_id = a.owner_id
		where a.agent_id = ${agentId}
			and not exists(select 1 from platform.platform_user_disables disabled
				where disabled.user_id = a.owner_id)
		limit 1`;
	return rows.length === 1;
}

export interface ConnectionManualAssociationMaterialV1 {
	readonly agentId: string;
	readonly connectionAgentId: string;
	readonly ownerId: string;
	readonly associationRevision: number;
	readonly credentialFingerprint: string;
	readonly credentialCiphertext: unknown;
}

/** Worker-only read of the current Owner association. The credential remains encrypted
 * until the caller's Host-bound keyring decryptor is invoked. */
export class PostgresConnectionManualAssociationReaderV1 {
	readonly #client: ReturnType<typeof postgres>;
	readonly #database: ReturnType<typeof drizzle>;
	constructor(input: { readonly databaseUrl: string }) {
		this.#client = postgres(input.databaseUrl, { max: 2 });
		this.#database = drizzle(this.#client);
	}
	async current(agentIds?: readonly string[]) {
		const rows = await this.#database
			.select({
				agentId: connectionManualAssociations.agentId,
				connectionAgentId: connectionManualAssociations.connectionAgentId,
				ownerId: connectionManualAssociations.ownerId,
				associationRevision: connectionManualAssociations.associationRevision,
				credentialFingerprint:
					connectionManualAssociations.credentialFingerprint,
				credentialCiphertext: connectionManualAssociations.credentialCiphertext,
			})
			.from(connectionManualAssociations)
			.where(
				agentIds === undefined
					? undefined
					: inArray(connectionManualAssociations.agentId, [...agentIds]),
			);
		return Object.freeze(
			Object.fromEntries(
				rows.map((row) => [row.agentId, Object.freeze({ ...row })]),
			) as Readonly<Record<string, ConnectionManualAssociationMaterialV1>>,
		);
	}
	async currentOne(agentId: string) {
		const result = await this.current([agentId]);
		return result[agentId];
	}
	/** #4199 C2: see `hasCurrentConnectionManualAssociationV1`; reads no credential. */
	async associated(agentId: string) {
		return hasCurrentConnectionManualAssociationV1(
			(template, ...values) => this.#client(template, ...values),
			agentId,
		);
	}
	async close() {
		await this.#client.end();
	}
}
