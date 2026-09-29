import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
	AgentConfigurationTransactionPortV1,
	AgentConfigurationWritePlanV1,
	PendingSecretRecordAttachmentsV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
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
	agentOwners,
	agents,
	auditEvents,
	idempotencyRecords,
	wecomConnections,
	wecomSetupSessions,
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
		return this.#commit(input, attachments);
	}

	async commitWecomSetup(
		input: AgentConfigurationWritePlanV1,
		claim: {
			readonly sessionId: string;
			readonly holderId: string;
			readonly fence: number;
		},
	): ReturnType<AgentConfigurationTransactionPortV1["commit"]> {
		return this.#commit(input, undefined, claim);
	}

	async #commit(
		input: AgentConfigurationWritePlanV1,
		attachments?: PendingSecretRecordAttachmentsV1,
		wecom?: {
			readonly sessionId: string;
			readonly holderId: string;
			readonly fence: number;
		},
	): ReturnType<AgentConfigurationTransactionPortV1["commit"]> {
		try {
			const plan = validatedPlan(input);
			if (
				wecom &&
				(!validateText(wecom.sessionId) ||
					!validateText(wecom.holderId) ||
					!Number.isSafeInteger(wecom.fence) ||
					wecom.fence < 1)
			)
				throw new AgentConfigurationStoreError();
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
				let setup: { readonly botId: string } | undefined;
				if (wecom) {
					const [candidate] = await transaction
						.select({ botId: wecomSetupSessions.botId })
						.from(wecomSetupSessions)
						.where(eq(wecomSetupSessions.sessionId, wecom.sessionId))
						.limit(1);
					if (!candidate?.botId) return { outcome: "stale" as const };
					const [connection] = await transaction
						.select({ botId: wecomConnections.botId })
						.from(wecomConnections)
						.where(
							and(
								eq(wecomConnections.botId, candidate.botId),
								eq(wecomConnections.agentId, plan.agentId),
								eq(wecomConnections.bindingReference, wecom.sessionId),
								eq(wecomConnections.holderId, wecom.holderId),
								eq(wecomConnections.fence, wecom.fence),
								sql`${wecomConnections.leaseUntil} > clock_timestamp()`,
								sql`${wecomConnections.status} in ('verifying','connected')`,
							),
						)
						.for("update")
						.limit(1);
					if (!connection) return { outcome: "stale" as const };
					const [session] = await transaction
						.select({
							botId: wecomSetupSessions.botId,
						})
						.from(wecomSetupSessions)
						.where(
							and(
								eq(wecomSetupSessions.sessionId, wecom.sessionId),
								eq(wecomSetupSessions.agentId, plan.agentId),
								eq(wecomSetupSessions.actorId, plan.auditEvent.actorId),
								eq(wecomSetupSessions.configurationRevision, plan.baseRevision),
								eq(
									wecomSetupSessions.authorizationRevision,
									plan.expectedAuthorizationRevision,
								),
								eq(wecomSetupSessions.status, "verifying"),
								sql`${wecomSetupSessions.expiresAt} > clock_timestamp()`,
							),
						)
						.for("update")
						.limit(1);
					if (
						!session ||
						session.botId !== connection.botId ||
						configuration.channelRevision !== wecom.sessionId ||
						!configuration.channels.some(
							(channel) =>
								channel.kind === "wecom_bot" &&
								channel.bindingReference === wecom.sessionId,
						)
					)
						return { outcome: "stale" as const };
					const [owner] = await transaction
						.select({ ownerId: agentOwners.ownerId })
						.from(agentOwners)
						.where(
							and(
								eq(agentOwners.agentId, plan.agentId),
								eq(agentOwners.ownerId, plan.auditEvent.actorId),
							),
						)
						.for("share")
						.limit(1);
					if (!owner) return { outcome: "stale" as const };
					setup = { botId: connection.botId };
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
				const previousBot = previousConfiguration.channels.find(
					(channel) => channel.kind === "wecom_bot",
				);
				if (
					previousBot &&
					!configuration.channels.some(
						(channel) =>
							channel.kind === "wecom_bot" &&
							channel.bindingReference === previousBot.bindingReference,
					)
				) {
					await transaction
						.update(wecomSetupSessions)
						.set({ status: "cancelled", encryptedCredential: null })
						.where(
							and(
								eq(wecomSetupSessions.sessionId, previousBot.bindingReference),
								eq(wecomSetupSessions.agentId, plan.agentId),
								eq(wecomSetupSessions.status, "active"),
							),
						);
				}
				if (wecom && setup) {
					const activated = await transaction
						.update(wecomSetupSessions)
						.set({ status: "active" })
						.where(
							and(
								eq(wecomSetupSessions.sessionId, wecom.sessionId),
								eq(wecomSetupSessions.status, "verifying"),
								sql`${wecomSetupSessions.expiresAt} > clock_timestamp()`,
								sql`exists (select 1 from ${wecomConnections} where ${wecomConnections.botId} = ${setup.botId} and ${wecomConnections.holderId} = ${wecom.holderId} and ${wecomConnections.fence} = ${wecom.fence} and ${wecomConnections.leaseUntil} > clock_timestamp())`,
							),
						)
						.returning({ sessionId: wecomSetupSessions.sessionId });
					if (activated.length !== 1) throw new StaleAgentConfigurationCommit();
					await transaction.insert(auditEvents).values({
						id: randomUUID(),
						traceId: wecom.sessionId,
						actorType: "system",
						actorId: "platform-worker",
						action: "wecom.setup_activated",
						targetType: "agent",
						targetId: plan.agentId,
						outcome: "succeeded",
						requestId: wecom.sessionId,
						agentId: plan.agentId,
					});
				}
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
