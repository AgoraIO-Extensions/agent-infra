import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "./observed-postgres.js";
import { connectionManualAssociations } from "./schema-connection-registration.js";

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
	/** #4199 C2: whether the Agent has a current verified association; reads no credential. */
	async associated(agentId: string) {
		const rows = await this.#database
			.select({ agentId: connectionManualAssociations.agentId })
			.from(connectionManualAssociations)
			.where(eq(connectionManualAssociations.agentId, agentId))
			.limit(1);
		return rows.length === 1;
	}
	async close() {
		await this.#client.end();
	}
}
