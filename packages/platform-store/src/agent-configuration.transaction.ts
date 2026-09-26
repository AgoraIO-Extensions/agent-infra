import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
	AgentConfigurationTransactionPortV1,
	AgentConfigurationWritePlanV1,
	PendingSecretRecordAttachmentsV1,
} from "@agent-infra/platform-core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { default as postgres } from "postgres";
import {
	AgentConfigurationStoreError,
	canonicalSourceReference,
	commandType,
	decodedReplay,
	type PostgresAgentConfigurationOptionsV1,
	StaleAgentConfigurationCommit,
	scopeType,
	validatedPlan,
	validateText,
} from "./agent-configuration.shared.js";
import { decodeAgentConfigurationRecord } from "./agent-configuration-record.js";
import {
	advanceAgentConfigurationRevision,
	insertAgentConfigurationEffects,
	replaceAgentAccess,
} from "./plan-writes.js";
import {
	agentApplications,
	agentConfigurationRevisions,
	agents,
	idempotencyRecords,
} from "./schema.js";
import { insertPendingSecretRecordAttachments } from "./secret-records.js";

export class PostgresAgentConfigurationTransactionV1
	implements AgentConfigurationTransactionPortV1
{
	readonly #client;
	readonly #database;

	constructor(options: PostgresAgentConfigurationOptionsV1) {
		this.#client = postgres(options.databaseUrl, { max: 10 });
		this.#database = drizzle(this.#client);
	}

	async read(
		input: Parameters<AgentConfigurationTransactionPortV1["read"]>[0],
	): ReturnType<AgentConfigurationTransactionPortV1["read"]> {
		try {
			if (
				input.schemaVersion !== 1 ||
				!validateText(input.agentId) ||
				!validateText(input.actorId) ||
				!/^[A-Za-z0-9._~-]{1,128}$/.test(input.idempotencyKey) ||
				!/^[a-f0-9]{64}$/.test(input.requestDigest)
			) {
				throw new AgentConfigurationStoreError();
			}
			return await this.#database.transaction(
				async (transaction) => {
					const [existing] = await transaction
						.select({
							requestDigest: idempotencyRecords.requestDigest,
							status: idempotencyRecords.status,
							result: idempotencyRecords.result,
						})
						.from(idempotencyRecords)
						.where(
							and(
								eq(idempotencyRecords.scopeType, scopeType),
								eq(idempotencyRecords.scopeId, input.agentId),
								eq(idempotencyRecords.actorId, input.actorId),
								eq(idempotencyRecords.commandType, commandType),
								eq(idempotencyRecords.idempotencyKey, input.idempotencyKey),
							),
						)
						.limit(1);
					if (existing)
						return decodedReplay(existing, input.requestDigest, input.agentId);

					const [current] = await transaction
						.select({
							currentConfigurationRevision: agents.currentConfigurationRevision,
							authorizationRevision: agents.authorizationRevision,
							configuration: agentConfigurationRevisions.configuration,
							sourceReference: agentConfigurationRevisions.sourceReference,
						})
						.from(agents)
						.innerJoin(
							agentConfigurationRevisions,
							and(
								eq(agentConfigurationRevisions.agentId, agents.id),
								eq(
									agentConfigurationRevisions.revision,
									agents.currentConfigurationRevision,
								),
							),
						)
						.where(eq(agents.id, input.agentId))
						.limit(1);
					if (!current?.configuration) return { outcome: "missing" };
					if (!validateText(current.authorizationRevision)) {
						throw new AgentConfigurationStoreError();
					}
					const configuration = decodeAgentConfigurationRecord(
						current.configuration,
					);
					if (
						configuration.agentId !== input.agentId ||
						configuration.revision !== current.currentConfigurationRevision ||
						current.sourceReference !== canonicalSourceReference(configuration)
					) {
						throw new AgentConfigurationStoreError();
					}
					return {
						outcome: "ready",
						record: {
							schemaVersion: 1,
							configuration,
							authorizationRevision: current.authorizationRevision,
						},
					};
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
		} catch (error) {
			if (error instanceof AgentConfigurationStoreError) throw error;
			throw new AgentConfigurationStoreError();
		}
	}

	async commit(
		input: AgentConfigurationWritePlanV1,
		attachments?: PendingSecretRecordAttachmentsV1,
	): ReturnType<AgentConfigurationTransactionPortV1["commit"]> {
		try {
			const plan = validatedPlan(input);
			const { configuration, result } = plan;
			return await this.#database.transaction(async (transaction) => {
				const [agent] = await transaction
					.select({
						currentConfigurationRevision: agents.currentConfigurationRevision,
						authorizationRevision: agents.authorizationRevision,
					})
					.from(agents)
					.where(eq(agents.id, plan.agentId))
					.for("update")
					.limit(1);
				if (!agent) return { outcome: "stale" as const };

				const [existing] = await transaction
					.select({
						requestDigest: idempotencyRecords.requestDigest,
						status: idempotencyRecords.status,
						result: idempotencyRecords.result,
					})
					.from(idempotencyRecords)
					.where(
						and(
							eq(idempotencyRecords.scopeType, scopeType),
							eq(idempotencyRecords.scopeId, plan.agentId),
							eq(idempotencyRecords.actorId, plan.auditEvent.actorId),
							eq(idempotencyRecords.commandType, commandType),
							eq(idempotencyRecords.idempotencyKey, plan.idempotency.key),
						),
					)
					.limit(1);
				if (existing)
					return decodedReplay(
						existing,
						plan.idempotency.requestDigest,
						plan.agentId,
					);

				if (
					agent.currentConfigurationRevision !== plan.baseRevision ||
					agent.authorizationRevision !== plan.expectedAuthorizationRevision
				) {
					return { outcome: "stale" as const };
				}
				let applicationId: string | undefined;
				if (plan.expectedManagementRevision !== null) {
					const [application] = await transaction
						.select({
							id: agentApplications.id,
							managementRevision: agentApplications.managementRevision,
						})
						.from(agentApplications)
						.where(eq(agentApplications.agentId, plan.agentId))
						.for("update")
						.limit(1);
					if (
						!application ||
						application.managementRevision !==
							plan.expectedManagementRevision ||
						plan.accessUpdate?.expectedRevision === Number.MAX_SAFE_INTEGER
					) {
						return { outcome: "stale" as const };
					}
					applicationId = application.id;
				}
				const [previous] = await transaction
					.select({ configuration: agentConfigurationRevisions.configuration })
					.from(agentConfigurationRevisions)
					.where(
						and(
							eq(agentConfigurationRevisions.agentId, plan.agentId),
							eq(agentConfigurationRevisions.revision, plan.baseRevision),
						),
					)
					.limit(1);
				if (!previous?.configuration) throw new AgentConfigurationStoreError();
				const previousConfiguration = decodeAgentConfigurationRecord(
					previous.configuration,
				);
				if (
					previousConfiguration.agentId !== plan.agentId ||
					previousConfiguration.revision !== plan.baseRevision ||
					(plan.nextRevision === plan.baseRevision &&
						!isDeepStrictEqual(configuration, previousConfiguration))
				) {
					throw new AgentConfigurationStoreError();
				}

				if (
					!(await advanceAgentConfigurationRevision(
						transaction,
						plan,
						configuration,
					))
				) {
					throw new StaleAgentConfigurationCommit();
				}
				await insertPendingSecretRecordAttachments(
					transaction,
					attachments,
					configuration,
					previousConfiguration,
				);

				if (plan.accessUpdate && applicationId) {
					const accessAdvanced = await transaction
						.update(agentApplications)
						.set({ managementRevision: plan.accessUpdate.expectedRevision + 1 })
						.where(
							and(
								eq(agentApplications.id, applicationId),
								eq(
									agentApplications.managementRevision,
									plan.accessUpdate.expectedRevision,
								),
							),
						)
						.returning({ id: agentApplications.id });
					if (accessAdvanced.length !== 1) {
						throw new StaleAgentConfigurationCommit();
					}
					await replaceAgentAccess(
						transaction,
						plan.accessUpdate,
						plan.auditEvent.occurredAt,
					);
				}

				await transaction.insert(idempotencyRecords).values({
					id: randomUUID(),
					scopeType,
					scopeId: plan.agentId,
					actorId: plan.auditEvent.actorId,
					commandType,
					idempotencyKey: plan.idempotency.key,
					requestDigest: plan.idempotency.requestDigest,
					status: "completed",
					result: { ...result },
					createdAt: plan.auditEvent.occurredAt,
					updatedAt: plan.auditEvent.occurredAt,
				});
				await insertAgentConfigurationEffects(transaction, plan);
				return { outcome: "committed" as const, result };
			});
		} catch (error) {
			if (error instanceof StaleAgentConfigurationCommit) {
				return { outcome: "stale" };
			}
			if (error instanceof AgentConfigurationStoreError) throw error;
			throw new AgentConfigurationStoreError();
		}
	}

	async close(): Promise<void> {
		try {
			await this.#client.end();
		} catch {
			throw new AgentConfigurationStoreError();
		}
	}
}
