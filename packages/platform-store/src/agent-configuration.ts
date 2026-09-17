import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";

import type {
	AgentConfigurationAccessTargetV1,
	AgentConfigurationRecordV2,
	AgentConfigurationTransactionPortV1,
	AgentConfigurationWritePlanV1,
	AgentManagementStateV1,
	AgentRuntimePresentationDecisionV1,
	AgentRuntimePresentationExpectationV1,
	AgentRuntimePresentationFactsV1,
	PendingSecretRecordAttachmentsV1,
} from "@agent-infra/platform-core";
import {
	decideAgentRuntimePresentationV1,
	isAgentOwnerV1,
	isAgentRuntimePresentationVisibleV1,
	snapshotAgentConfigurationWritePlanV1,
	snapshotAgentRuntimePresentationExpectationV1,
} from "@agent-infra/platform-core";
import { and, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
	decodeAgentConfigurationRecord,
	decodeAgentConfigurationResult,
} from "./agent-configuration-record.js";
import { readAgentManagementState } from "./agent-management.js";
import {
	advanceAgentConfigurationRevision,
	insertAgentConfigurationEffects,
	replaceAgentAccess,
} from "./plan-writes.js";
import {
	agentApplications,
	agentAvailability,
	agentConfigurationRevisions,
	agentOwners,
	agents,
	idempotencyRecords,
	wecomConnections,
	wecomSetupSessions,
	workloadReconciliations,
} from "./schema.js";
import { insertPendingSecretRecordAttachments } from "./secret-records.js";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

const commandType = "agent.configuration.update.v1";
const scopeType = "agent";
const idMaxBytes = 1024;
const maxAccessTargets = 256;

class StaleAgentConfigurationCommit extends Error {}

export class AgentConfigurationStoreError extends Error {
	readonly code = "unavailable" as const;

	constructor() {
		super("Agent configuration persistence unavailable");
		this.name = "AgentConfigurationStoreError";
	}
}

export interface PostgresAgentConfigurationOptionsV1 {
	readonly databaseUrl: string;
}

interface IdempotencyRow {
	readonly requestDigest: string;
	readonly status: "reserved" | "completed";
	readonly result: unknown;
}

function canonicalSourceReference(configuration: AgentConfigurationRecordV2) {
	return configuration.source.kind === "standard"
		? configuration.source.templateId
		: configuration.source.imageDigest;
}

function validateText(input: unknown, maximum = idMaxBytes): input is string {
	return (
		typeof input === "string" &&
		input.length > 0 &&
		!input.includes("\0") &&
		String.prototype.isWellFormed.call(input) &&
		Buffer.byteLength(input, "utf8") <= maximum
	);
}

function validatedPlan(input: AgentConfigurationWritePlanV1) {
	try {
		return snapshotAgentConfigurationWritePlanV1(input);
	} catch {
		throw new AgentConfigurationStoreError();
	}
}

function decodedReplay(
	row: IdempotencyRow,
	requestDigest: string,
	agentId: string,
) {
	if (row.requestDigest !== requestDigest) {
		return { outcome: "idempotency_conflict" as const };
	}
	if (row.status !== "completed") throw new AgentConfigurationStoreError();
	try {
		const result = decodeAgentConfigurationResult(row.result);
		if (result.agentId !== agentId) throw new AgentConfigurationStoreError();
		return {
			outcome: "replayed" as const,
			result,
		};
	} catch {
		throw new AgentConfigurationStoreError();
	}
}

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

	async commitWecomSetup(
		input: AgentConfigurationWritePlanV1,
		setup: {
			readonly sessionId: string;
			readonly holderId: string;
			readonly fence: number;
		},
	) {
		return this.commit(input, undefined, setup);
	}
	async commit(
		input: AgentConfigurationWritePlanV1,
		attachments?: PendingSecretRecordAttachmentsV1,
		setup?: {
			readonly sessionId: string;
			readonly holderId: string;
			readonly fence: number;
		},
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
				if (setup) {
					const [candidate] = await transaction
						.select({ session: wecomSetupSessions })
						.from(wecomSetupSessions)
						.innerJoin(
							wecomConnections,
							eq(
								wecomConnections.bindingReference,
								wecomSetupSessions.sessionId,
							),
						)
						.innerJoin(
							agentOwners,
							and(
								eq(agentOwners.agentId, wecomSetupSessions.agentId),
								eq(agentOwners.ownerId, wecomSetupSessions.actorId),
							),
						)
						.where(
							and(
								eq(wecomSetupSessions.sessionId, setup.sessionId),
								eq(wecomSetupSessions.status, "verifying"),
								gt(wecomSetupSessions.expiresAt, sql`clock_timestamp()`),
								eq(wecomConnections.agentId, wecomSetupSessions.agentId),
								eq(wecomConnections.botId, wecomSetupSessions.botId),
								eq(wecomConnections.holderId, setup.holderId),
								eq(wecomConnections.fence, setup.fence),
								gt(wecomConnections.leaseUntil, sql`clock_timestamp()`),
							),
						)
						.for("update");
					if (
						!candidate ||
						(candidate.session.kind === "wecom_app" &&
							!candidate.session.callbackVerifiedAt) ||
						candidate.session.agentId !== plan.agentId ||
						candidate.session.actorId !== plan.auditEvent.actorId ||
						candidate.session.configurationRevision !== plan.baseRevision ||
						candidate.session.authorizationRevision !==
							plan.expectedAuthorizationRevision ||
						plan.result.changedFields.length !== 1 ||
						plan.result.changedFields[0] !== "channels" ||
						!plan.configuration.channels.some(
							(c) =>
								c.kind === candidate.session.kind &&
								c.bindingReference === setup.sessionId,
						)
					)
						return { outcome: "stale" as const };
					await transaction
						.update(wecomSetupSessions)
						.set({ status: "active" })
						.where(eq(wecomSetupSessions.sessionId, setup.sessionId));
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
					previousConfiguration.revision !== plan.baseRevision
				) {
					throw new AgentConfigurationStoreError();
				}

				let applicationId: string | undefined;
				if (plan.accessUpdate) {
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
							plan.accessUpdate.expectedRevision ||
						plan.accessUpdate.expectedRevision === Number.MAX_SAFE_INTEGER
					) {
						return { outcome: "stale" as const };
					}
					applicationId = application.id;
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
				await transaction.execute(sql`with ended as (
 update platform.wecom_setup_sessions set status='conflict',encrypted_credential=null,encrypted_callback=null
 where agent_id=${plan.agentId} and status in ('awaiting_input','verifying') and configuration_revision<>${plan.configuration.revision}
 returning session_id,agent_id
 ) insert into platform.audit_events (id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome,request_id,agent_id,details)
 select gen_random_uuid()::text,session_id,'system',${setup ? "platform-worker" : "platform-api"},'wecom.setup_failed','agent',agent_id,'failed',session_id,agent_id,NULL from ended`);
				// Retired channel bindings must not retain decryptable credentials indefinitely.
				await transaction.execute(sql`update platform.wecom_setup_sessions set status='cancelled',encrypted_credential=null,encrypted_callback=null
				 where agent_id=${plan.agentId} and status='active' and not (${JSON.stringify(plan.configuration.channels)}::jsonb @> jsonb_build_array(jsonb_build_object('kind',kind,'bindingReference',session_id)))`);
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

export type AgentConfigurationQueryIntentV1 = "discover" | "manage";

export interface AgentConfigurationQueryInputV1 {
	readonly agentId: string;
	readonly actorId: string;
	readonly organizationIds: readonly string[];
	readonly isAdministrator: boolean;
	readonly intent: AgentConfigurationQueryIntentV1;
}

export interface AgentConfigurationProjectionV1 {
	readonly agentId: string;
	readonly revision: number;
	readonly source:
		| {
				readonly kind: "standard";
				readonly templateId: string;
				readonly connectionEnabled: boolean;
		  }
		| {
				readonly kind: "custom";
				readonly interactionMode: "self-managed" | "platform-adapter";
				readonly identityResponsibility?: "self-managed" | "platform-managed";
				readonly connectionEnabled: boolean;
		  };
	readonly ownerIds: readonly string[];
	readonly availability: readonly AgentConfigurationAccessTargetV1[];
	readonly modelOptions: readonly {
		readonly optionId: string;
		readonly modelId: string;
		readonly reasoningLevels: readonly string[];
	}[];
	readonly defaultModelOptionId: string | null;
	readonly defaultReasoningLevel: string | null;
	readonly environment: AgentConfigurationRecordV2["environment"];
	readonly channelKinds: readonly ("wecom_bot" | "wecom_app")[];
	readonly secrets: readonly {
		readonly name: string;
		readonly isSet: true;
		readonly version: number;
	}[];
}

export type AgentConfigurationQueryResultV1 =
	| {
			readonly outcome: "found";
			readonly configuration: AgentConfigurationProjectionV1;
	  }
	| { readonly outcome: "unavailable" };

export type AgentConfigurationAuthorityQueryInputV1 = Omit<
	AgentConfigurationQueryInputV1,
	"intent"
>;
export type AgentConfigurationAuthorityQueryResultV1 =
	| {
			readonly outcome: "found";
			readonly configuration: AgentConfigurationRecordV2;
			readonly management: AgentManagementStateV1;
			readonly authorizationRevision: string;
	  }
	| { readonly outcome: "unavailable" };

export interface AgentRuntimePresentationQueryInputV1
	extends AgentConfigurationAuthorityQueryInputV1 {
	readonly expected: AgentRuntimePresentationExpectationV1;
}
export type AgentRuntimePresentationQueryResultV1 =
	AgentRuntimePresentationDecisionV1;

export class PostgresAgentConfigurationQueryV1 {
	readonly #client;
	readonly #database;

	constructor(options: PostgresAgentConfigurationOptionsV1) {
		this.#client = postgres(options.databaseUrl, { max: 10 });
		this.#database = drizzle(this.#client);
	}

	/** Internal admission material; an administrator role never grants Owner authority. */
	async readAuthority(
		input: AgentConfigurationAuthorityQueryInputV1,
	): Promise<AgentConfigurationAuthorityQueryResultV1> {
		try {
			if (
				!validateText(input.agentId) ||
				!validateText(input.actorId) ||
				typeof input.isAdministrator !== "boolean" ||
				!Array.isArray(input.organizationIds) ||
				input.organizationIds.length > maxAccessTargets ||
				input.organizationIds.some((id) => !validateText(id))
			)
				throw new AgentConfigurationStoreError();
			return await this.#database.transaction(
				async (transaction) => {
					const management = await readAgentManagementState(
						transaction,
						input.agentId,
					);
					if (!management || !isAgentOwnerV1(management, input.actorId))
						return { outcome: "unavailable" };
					if (
						management.agentId !== input.agentId ||
						management.ownerIds.length === 0 ||
						new Set(management.ownerIds).size !== management.ownerIds.length ||
						management.ownerIds.some((id) => !validateText(id))
					)
						throw new AgentConfigurationStoreError();
					const [current] = await transaction
						.select({
							configuration: agentConfigurationRevisions.configuration,
							revision: agents.currentConfigurationRevision,
							sourceReference: agentConfigurationRevisions.sourceReference,
							authorizationRevision: agents.authorizationRevision,
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
					if (!current?.configuration) return { outcome: "unavailable" };
					const configuration = decodeAgentConfigurationRecord(
						current.configuration,
					);
					if (
						configuration.agentId !== input.agentId ||
						configuration.revision !== current.revision ||
						canonicalSourceReference(configuration) !==
							current.sourceReference ||
						!validateText(current.authorizationRevision)
					)
						throw new AgentConfigurationStoreError();
					return {
						outcome: "found",
						configuration,
						management,
						authorizationRevision: current.authorizationRevision,
					};
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
		} catch (error) {
			if (error instanceof AgentConfigurationStoreError) throw error;
			throw new AgentConfigurationStoreError();
		}
	}

	/** Read one database snapshot; Core decides whether it matches the upstream projection. */
	async readRuntimePresentation(
		input: AgentRuntimePresentationQueryInputV1,
	): Promise<AgentRuntimePresentationQueryResultV1> {
		try {
			if (
				!validateText(input.agentId) ||
				!validateText(input.actorId) ||
				typeof input.isAdministrator !== "boolean" ||
				!Array.isArray(input.organizationIds) ||
				input.organizationIds.length > maxAccessTargets ||
				input.organizationIds.some((id) => !validateText(id))
			)
				throw new AgentConfigurationStoreError();
			const expected = snapshotAgentRuntimePresentationExpectationV1(
				input.expected,
			);
			const actor = {
				schemaVersion: 1 as const,
				userId: input.actorId,
				accountStatus: "active" as const,
				organizationIds: [...input.organizationIds],
				isAdministrator: input.isAdministrator,
			};
			return await this.#database.transaction(
				async (transaction) => {
					const management = await readAgentManagementState(
						transaction,
						input.agentId,
					);
					if (
						!management ||
						!isAgentRuntimePresentationVisibleV1(management, actor)
					)
						return { outcome: "unavailable" };
					const [current] = await transaction
						.select({
							configuration: agentConfigurationRevisions.configuration,
							revision: agents.currentConfigurationRevision,
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
					if (!current?.configuration) return { outcome: "unavailable" };
					const configuration = decodeAgentConfigurationRecord(
						current.configuration,
					);
					if (
						configuration.agentId !== input.agentId ||
						configuration.revision !== current.revision ||
						canonicalSourceReference(configuration) !== current.sourceReference
					)
						throw new AgentConfigurationStoreError();
					const [row] = await transaction
						.select({
							revision: workloadReconciliations.revision,
							state: workloadReconciliations.state,
						})
						.from(workloadReconciliations)
						.where(eq(workloadReconciliations.agentId, input.agentId))
						.limit(1);
					let runtime: AgentRuntimePresentationFactsV1["runtime"] = null;
					if (row) {
						let persisted: ReturnType<typeof decodePersistedWorkloadStateV1> =
							null;
						try {
							persisted = decodePersistedWorkloadStateV1(
								row.state,
								input.agentId,
							);
						} catch {
							/* Invalid persisted runtime data provides no verified facts. */
						}
						if (persisted && !persisted.legacy && persisted.state.verified) {
							const state = persisted.state;
							const verified = persisted.state.verified;
							const [active] = await transaction
								.select({
									configuration: agentConfigurationRevisions.configuration,
									sourceReference: agentConfigurationRevisions.sourceReference,
								})
								.from(agentConfigurationRevisions)
								.where(
									and(
										eq(agentConfigurationRevisions.agentId, input.agentId),
										eq(
											agentConfigurationRevisions.revision,
											verified.configuration.revision,
										),
									),
								)
								.limit(1);
							if (active?.configuration) {
								try {
									const verifiedConfiguration = decodeAgentConfigurationRecord(
										active.configuration,
									);
									if (
										verifiedConfiguration.agentId !== input.agentId ||
										verifiedConfiguration.revision !==
											verified.configuration.revision ||
										canonicalSourceReference(verifiedConfiguration) !==
											active.sourceReference
									)
										throw new AgentConfigurationStoreError();
									runtime = {
										revision: row.revision,
										state,
										verifiedConfiguration,
										verifiedSourceReference: active.sourceReference,
										deployment: validateAgentWorkloadDesiredV1(
											verified.deployment,
										),
									};
								} catch {
									/* Incomplete history or invalid deployment is not runtime evidence. */
								}
							}
						}
					}
					return decideAgentRuntimePresentationV1({
						agentId: input.agentId,
						actor,
						expected,
						facts: {
							management,
							configuration,
							sourceReference: current.sourceReference,
							runtime,
						},
					});
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
		} catch (error) {
			if (error instanceof AgentConfigurationStoreError) throw error;
			throw new AgentConfigurationStoreError();
		}
	}

	async read(
		input: AgentConfigurationQueryInputV1,
	): Promise<AgentConfigurationQueryResultV1> {
		try {
			if (
				!validateText(input.agentId) ||
				!validateText(input.actorId) ||
				typeof input.isAdministrator !== "boolean" ||
				(input.intent !== "discover" && input.intent !== "manage") ||
				!Array.isArray(input.organizationIds) ||
				input.organizationIds.length > maxAccessTargets ||
				input.organizationIds.some(
					(organizationId) => !validateText(organizationId),
				)
			) {
				throw new AgentConfigurationStoreError();
			}
			return await this.#database.transaction(
				async (transaction) => {
					const [current] = await transaction
						.select({
							currentConfigurationRevision: agents.currentConfigurationRevision,
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
					if (!current?.configuration) return { outcome: "unavailable" };
					const [owners, availabilityRows] = await Promise.all([
						transaction
							.select({ ownerId: agentOwners.ownerId })
							.from(agentOwners)
							.where(eq(agentOwners.agentId, input.agentId)),
						transaction
							.select({
								targetType: agentAvailability.targetType,
								targetId: agentAvailability.targetId,
							})
							.from(agentAvailability)
							.where(eq(agentAvailability.agentId, input.agentId)),
					]);
					const ownerIds = owners.map(({ ownerId }) => ownerId).toSorted();
					if (
						ownerIds.length === 0 ||
						new Set(ownerIds).size !== ownerIds.length ||
						ownerIds.some((ownerId) => !validateText(ownerId)) ||
						availabilityRows.some(
							({ targetType, targetId }) =>
								(targetType !== "user" && targetType !== "organization") ||
								!validateText(targetId),
						)
					) {
						throw new AgentConfigurationStoreError();
					}
					const availability: AgentConfigurationAccessTargetV1[] =
						availabilityRows
							.map(({ targetType, targetId }) =>
								targetType === "user"
									? { kind: "user" as const, userId: targetId }
									: {
											kind: "organization" as const,
											organizationId: targetId,
										},
							)
							.toSorted((left, right) => {
								const leftKey =
									left.kind === "user"
										? `user\0${left.userId}`
										: `organization\0${left.organizationId}`;
								const rightKey =
									right.kind === "user"
										? `user\0${right.userId}`
										: `organization\0${right.organizationId}`;
								return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
							});
					const owner = ownerIds.includes(input.actorId);
					const available = availability.some((target) =>
						target.kind === "user"
							? target.userId === input.actorId
							: input.organizationIds.includes(target.organizationId),
					);
					if (
						!input.isAdministrator &&
						!owner &&
						(input.intent === "manage" || !available)
					) {
						return { outcome: "unavailable" };
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
					const projectedSource =
						configuration.source.kind === "standard"
							? {
									kind: "standard" as const,
									templateId: current.sourceReference,
									connectionEnabled: configuration.source.connectionEnabled,
								}
							: {
									kind: "custom" as const,
									interactionMode: configuration.source.interactionMode,
									...(configuration.source.interactionMode === "self-managed"
										? {
												identityResponsibility:
													configuration.source.identityResponsibility,
											}
										: {}),
									connectionEnabled: configuration.source.connectionEnabled,
								};
					return {
						outcome: "found",
						configuration: {
							agentId: configuration.agentId,
							revision: configuration.revision,
							source: projectedSource,
							ownerIds,
							availability,
							modelOptions:
								configuration.modelConfiguration?.options.map((option) => ({
									optionId: option.optionId,
									modelId: option.modelId,
									reasoningLevels: option.reasoningLevels,
								})) ?? [],
							defaultModelOptionId:
								configuration.modelConfiguration?.defaultOptionId ?? null,
							defaultReasoningLevel:
								configuration.modelConfiguration?.defaultReasoningLevel ?? null,
							environment: configuration.environment,
							channelKinds: configuration.channels.map(({ kind }) => kind),
							secrets: configuration.secrets.map(({ name, version }) => ({
								name,
								isSet: true as const,
								version,
							})),
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

	async close(): Promise<void> {
		try {
			await this.#client.end();
		} catch {
			throw new AgentConfigurationStoreError();
		}
	}
}
