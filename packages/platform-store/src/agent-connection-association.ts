import { randomUUID } from "node:crypto";
import {
	type AgentConnectionAssociationAuditV1,
	type AgentConnectionAssociationDependenciesV1,
	AgentConnectionAssociationErrorV1,
	type AgentConnectionAssociationRecordV1,
	type AgentConnectionAssociationTransactionV1,
	PersonalApiCredentialErrorV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { resolveAgentApiIdentityV1 } from "./agent-api-identity.js";
import { enableConnectionConsumerRegistrationV1 } from "./connection-consumer-registration.js";
import { platformDatabaseUrlFromEnvironment } from "./migrate.js";
import postgres from "./observed-postgres.js";
import { isPostgresError } from "./postgres-error.js";
import {
	auditEvents,
	connectionAssociationGenerations,
	connectionConsumerDisables,
	connectionConsumerRegistrations,
	connectionHostSupplies,
	connectionManualAssociations,
} from "./schema.js";

type Database = ReturnType<typeof drizzle>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function audit(
	transaction: Transaction,
	event: AgentConnectionAssociationAuditV1,
) {
	await transaction.insert(auditEvents).values({
		id: randomUUID(),
		traceId: event.traceId,
		requestId: event.requestId,
		// Only a resolved Owner is a user actor; an unresolved API credential stays anonymous.
		actorType: event.actorId === null ? "api_credential" : "user",
		actorId: event.actorId ?? "unresolved",
		action: `connection.association.${event.operation}`,
		targetType: "agent",
		targetId: event.agentId,
		agentId: event.agentId,
		outcome: event.outcome,
		// Never carries the Connection Agent ID, credential, fingerprint or ciphertext.
		details: {
			schemaVersion: 1,
			entry: event.entry,
			...(event.reason === undefined ? {} : { reason: event.reason }),
			...(event.associationRevision === undefined
				? {}
				: { associationRevision: event.associationRevision }),
		},
	});
}

async function fenceRetiredHostSupply(
	transaction: Transaction,
	agentId: string,
	associationRevision: number,
) {
	await transaction
		.update(connectionHostSupplies)
		.set({ state: "cleanup_pending", updatedAt: sql`clock_timestamp()` })
		.where(
			and(
				eq(connectionHostSupplies.agentId, agentId),
				eq(connectionHostSupplies.associationRevision, associationRevision),
				or(
					eq(connectionHostSupplies.state, "writing"),
					eq(connectionHostSupplies.state, "available"),
				),
			),
		);
}

function operations(
	transaction: Transaction,
	directory: TaskUserDirectoryV1 | undefined,
): AgentConnectionAssociationTransactionV1 {
	return {
		async owner(entry, agentId) {
			let userId: string;
			if (entry.kind === "api") {
				let authenticated: Awaited<
					ReturnType<typeof resolveAgentApiIdentityV1>
				>;
				try {
					authenticated = await resolveAgentApiIdentityV1(
						transaction,
						entry.material,
						directory,
						"agent:manage",
					);
				} catch (error) {
					if (error instanceof PersonalApiCredentialErrorV1)
						throw error.code === "unavailable"
							? new AgentConnectionAssociationErrorV1("unavailable")
							: new AgentConnectionAssociationErrorV1("not_authorized");
					throw error;
				}
				// Only a user's own credential acts as that Owner; applications never own Agents.
				if (authenticated.identity.principal.kind !== "user") return null;
				userId = authenticated.identity.principal.id;
			} else {
				userId = entry.userId;
				await transaction.execute(
					sql`lock table platform.platform_user_disables in share mode`,
				);
			}
			const disabled = await transaction.execute(
				sql`select user_id from platform.platform_user_disables where user_id = ${userId}`,
			);
			if (disabled.length) return null;
			// Registration writers lock this row; the disable transaction reads after it.
			const [application] = await transaction.execute<{
				status: string;
				name: string;
			}>(
				sql`select status, name from platform.agent_applications where agent_id = ${agentId} for update`,
			);
			if (!application) return null;
			const owners = await transaction.execute(
				sql`select owner_id from platform.agent_owners where agent_id = ${agentId} and owner_id = ${userId} for share`,
			);
			if (!owners.length) return null;
			return {
				userId,
				agentName: application.name,
				agentStatus: application.status,
			};
		},
		async current(agentId): Promise<AgentConnectionAssociationRecordV1 | null> {
			const [manual] = await transaction
				.select({ revision: connectionManualAssociations.associationRevision })
				.from(connectionManualAssociations)
				.where(eq(connectionManualAssociations.agentId, agentId))
				.limit(1)
				.for("update");
			if (manual)
				return { source: "manual", associationRevision: manual.revision };
			const [registration] = await transaction
				.select({ status: connectionConsumerRegistrations.status })
				.from(connectionConsumerRegistrations)
				.where(eq(connectionConsumerRegistrations.agentId, agentId))
				.limit(1);
			if (!registration) return null;
			const [disable] = await transaction
				.select({ status: connectionConsumerDisables.status })
				.from(connectionConsumerDisables)
				.where(eq(connectionConsumerDisables.agentId, agentId))
				.limit(1);
			return {
				source: "automatic",
				status: registration.status,
				disableStatus: disable?.status ?? null,
			};
		},
		async inUseElsewhere({
			agentId,
			connectionAgentId,
			credentialFingerprint,
		}) {
			const manual = await transaction
				.select({ agentId: connectionManualAssociations.agentId })
				.from(connectionManualAssociations)
				.where(
					and(
						ne(connectionManualAssociations.agentId, agentId),
						or(
							eq(
								connectionManualAssociations.connectionAgentId,
								connectionAgentId,
							),
							eq(
								connectionManualAssociations.credentialFingerprint,
								credentialFingerprint,
							),
						),
					),
				)
				.limit(1);
			if (manual.length) return true;
			const automatic = await transaction
				.select({ agentId: connectionConsumerRegistrations.agentId })
				.from(connectionConsumerRegistrations)
				.where(
					and(
						ne(connectionConsumerRegistrations.agentId, agentId),
						eq(connectionConsumerRegistrations.consumerId, connectionAgentId),
					),
				)
				.limit(1);
			return automatic.length > 0;
		},
		async saveManual(input) {
			// The caller holds the Agent row lock. Every association, replacement and
			// reassociation takes a fresh generation that is never reused after disconnect.
			const [generation] = await transaction
				.insert(connectionAssociationGenerations)
				.values({ agentId: input.agentId, lastRevision: 1 })
				.onConflictDoUpdate({
					target: connectionAssociationGenerations.agentId,
					set: {
						lastRevision: sql`${connectionAssociationGenerations.lastRevision} + 1`,
						updatedAt: sql`clock_timestamp()`,
					},
				})
				.returning({ revision: connectionAssociationGenerations.lastRevision });
			const associationRevision = Number(generation?.revision);
			if (
				!Number.isSafeInteger(associationRevision) ||
				associationRevision < 1 ||
				(input.expectedRevision !== null &&
					associationRevision <= input.expectedRevision)
			)
				throw new AgentConnectionAssociationErrorV1("unavailable");
			const ciphertext = input.encrypt({
				agentId: input.agentId,
				ownerId: input.ownerId,
				associationRevision,
			});
			try {
				if (input.expectedRevision === null) {
					const inserted = await transaction
						.insert(connectionManualAssociations)
						.values({
							agentId: input.agentId,
							connectionAgentId: input.connectionAgentId,
							credentialFingerprint: input.credentialFingerprint,
							associationRevision,
							ownerId: input.ownerId,
							credentialCiphertext: ciphertext,
							verifiedAt: sql`clock_timestamp()`,
						})
						.onConflictDoNothing({
							target: connectionManualAssociations.agentId,
						})
						.returning({ agentId: connectionManualAssociations.agentId });
					return inserted.length ? associationRevision : null;
				}
				// Replacing re-verifies and drops the old ciphertext in the same statement.
				const updated = await transaction
					.update(connectionManualAssociations)
					.set({
						connectionAgentId: input.connectionAgentId,
						credentialFingerprint: input.credentialFingerprint,
						associationRevision,
						ownerId: input.ownerId,
						credentialCiphertext: ciphertext,
						verifiedAt: sql`clock_timestamp()`,
						updatedAt: sql`clock_timestamp()`,
					})
					.where(
						and(
							eq(connectionManualAssociations.agentId, input.agentId),
							eq(
								connectionManualAssociations.associationRevision,
								input.expectedRevision,
							),
						),
					)
					.returning({ agentId: connectionManualAssociations.agentId });
				if (!updated.length) return null;
				await fenceRetiredHostSupply(
					transaction,
					input.agentId,
					input.expectedRevision,
				);
				return associationRevision;
			} catch (error) {
				if (isPostgresError(error, "23505"))
					throw new AgentConnectionAssociationErrorV1("already_associated");
				throw error;
			}
		},
		async deleteManual(agentId, expectedRevision) {
			const deleted = await transaction
				.delete(connectionManualAssociations)
				.where(
					and(
						eq(connectionManualAssociations.agentId, agentId),
						eq(
							connectionManualAssociations.associationRevision,
							expectedRevision,
						),
					),
				)
				.returning({ agentId: connectionManualAssociations.agentId });
			if (!deleted.length) return false;
			await fenceRetiredHostSupply(transaction, agentId, expectedRevision);
			return true;
		},
		async enableAutomatic(input) {
			try {
				await enableConnectionConsumerRegistrationV1(transaction, {
					policy: input.policy,
					platformAgentId: input.agentId,
					platformOwnerId: input.ownerId,
					consumerName: input.consumerName,
					traceId: input.traceId,
					requestId: input.requestId,
					occurredAt: new Date(),
				});
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === "CONNECTION_CONSUMER_REGISTRATION_CONFLICT"
				)
					throw new AgentConnectionAssociationErrorV1("conflict");
				throw error;
			}
		},
		audit: (event) => audit(transaction, event),
	};
}

type TransactionPort = AgentConnectionAssociationDependenciesV1["transaction"];

/** Owner-managed association; the ciphertext is never read back by the API. */
export class PostgresAgentConnectionAssociationStoreV1
	implements TransactionPort
{
	readonly #client;
	readonly #database: Database;
	readonly #directory: TaskUserDirectoryV1 | undefined;
	constructor(input: {
		readonly databaseUrl: string;
		/** Required for API credential entries; browser entries are already resolved. */
		readonly directory?: TaskUserDirectoryV1;
	}) {
		this.#client = postgres(
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: input.databaseUrl,
			}),
			{ max: 4 },
		);
		this.#database = drizzle(this.#client);
		this.#directory = input.directory;
	}
	async execute<T>(
		work: (transaction: AgentConnectionAssociationTransactionV1) => Promise<T>,
	): Promise<T> {
		try {
			return await this.#database.transaction(
				async (transaction) => {
					await transaction.execute(sql`set local lock_timeout = '5s'`);
					await transaction.execute(sql`set local statement_timeout = '15s'`);
					return work(operations(transaction, this.#directory));
				},
				{ isolationLevel: "read committed" },
			);
		} catch (error) {
			if (error instanceof AgentConnectionAssociationErrorV1) throw error;
			throw new AgentConnectionAssociationErrorV1("unavailable");
		}
	}
	async recordRefusal(event: AgentConnectionAssociationAuditV1) {
		try {
			await this.#database.transaction((transaction) =>
				audit(transaction, event),
			);
		} catch {
			throw new AgentConnectionAssociationErrorV1("unavailable");
		}
	}
	async close() {
		await this.#client.end();
	}
}
