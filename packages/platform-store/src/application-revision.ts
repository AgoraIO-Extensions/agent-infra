import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type {
	AgentConfigurationAccessTargetV1,
	ApplicationRevisionResultV1,
	ApplicationRevisionTransactionPortV1,
	ApplicationRevisionWritePlanV1,
} from "@agent-infra/platform-core";
import { snapshotApplicationRevisionWritePlanV1 } from "@agent-infra/platform-core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { decodeAgentConfigurationRecord } from "./agent-configuration-record.js";
import {
	advanceAgentConfigurationRevision,
	agentManagementStateUpdate,
	insertAgentConfigurationEffects,
	insertAgentManagementEffects,
	insertAgentManagementHistory,
	replaceAgentAccess,
} from "./plan-writes.js";
import {
	agentApplications,
	agentAvailability,
	agentConfigurationRevisions,
	agentManagementHistory,
	agentOwners,
	agents,
	idempotencyRecords,
	outboxItems,
} from "./schema.js";

const scopeType = "agent_application";
const commandType = "agent.application.revise.v1";
const maximumAccessTargets = 256;

export interface PostgresApplicationRevisionOptionsV1 {
	readonly databaseUrl: string;
}

export class ApplicationRevisionStoreError extends Error {
	readonly code = "unavailable" as const;

	constructor() {
		super("Application revision persistence unavailable");
		this.name = "ApplicationRevisionStoreError";
	}
}

interface IdempotencyRow {
	readonly requestDigest: string;
	readonly status: "reserved" | "completed";
	readonly result: unknown;
}

function unavailable(): never {
	throw new ApplicationRevisionStoreError();
}

function validText(input: unknown, maximum = 1024): input is string {
	return (
		typeof input === "string" &&
		input.length > 0 &&
		!input.includes("\0") &&
		String.prototype.isWellFormed.call(input) &&
		Buffer.byteLength(input, "utf8") <= maximum
	);
}

function safeInteger(input: unknown, minimum = 0): input is number {
	return Number.isSafeInteger(input) && (input as number) >= minimum;
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function exact(input: unknown, keys: readonly string[]): void {
	if (
		typeof input !== "object" ||
		input === null ||
		Array.isArray(input) ||
		Object.keys(input).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(input, key))
	) {
		unavailable();
	}
}

function snapshotPlan(
	input: ApplicationRevisionWritePlanV1,
): ApplicationRevisionWritePlanV1 {
	try {
		return snapshotApplicationRevisionWritePlanV1(input);
	} catch {
		unavailable();
	}
}

function resultValue(input: unknown): ApplicationRevisionResultV1 {
	exact(input, [
		"schemaVersion",
		"applicationId",
		"agentId",
		"status",
		"managementRevision",
		"configurationRevision",
	]);
	const result = input as ApplicationRevisionResultV1;
	if (
		result.schemaVersion !== 1 ||
		!validText(result.applicationId) ||
		!validText(result.agentId) ||
		result.status !== "pending_approval" ||
		!safeInteger(result.managementRevision, 1) ||
		!safeInteger(result.configurationRevision, 1)
	) {
		unavailable();
	}
	return result;
}

function accessKey(target: AgentConfigurationAccessTargetV1): string {
	return target.kind === "user"
		? `user\0${target.userId}`
		: `organization\0${target.organizationId}`;
}

function compareAccessTargets(
	left: AgentConfigurationAccessTargetV1,
	right: AgentConfigurationAccessTargetV1,
): number {
	const leftKey = accessKey(left);
	const rightKey = accessKey(right);
	return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function validateAccess(
	ownerIds: readonly string[],
	availability: readonly AgentConfigurationAccessTargetV1[],
): void {
	const targetKeys = availability.map(accessKey);
	if (
		ownerIds.length === 0 ||
		ownerIds.length > maximumAccessTargets ||
		new Set(ownerIds).size !== ownerIds.length ||
		!sameValue(ownerIds, [...ownerIds].sort()) ||
		ownerIds.some((ownerId) => !validText(ownerId)) ||
		availability.length > maximumAccessTargets ||
		new Set(targetKeys).size !== targetKeys.length ||
		!sameValue(targetKeys, [...targetKeys].sort()) ||
		availability.some((target) =>
			target.kind === "user"
				? !validText(target.userId)
				: target.kind !== "organization" || !validText(target.organizationId),
		)
	) {
		unavailable();
	}
}

function validatedPlan(input: ApplicationRevisionWritePlanV1) {
	const plan = snapshotPlan(input);
	return {
		plan,
		result: plan.result,
		configuration: plan.configuration?.configuration ?? null,
	};
}

function replayValue(
	row: IdempotencyRow,
	requestDigest: string,
	applicationId: string,
):
	| {
			readonly outcome: "replayed";
			readonly result: ApplicationRevisionResultV1;
	  }
	| { readonly outcome: "idempotency_conflict" } {
	if (row.requestDigest !== requestDigest) {
		return { outcome: "idempotency_conflict" };
	}
	if (row.status !== "completed") unavailable();
	const result = resultValue(row.result);
	if (result.applicationId !== applicationId) unavailable();
	return { outcome: "replayed", result };
}

function sourceReference(
	configuration: ReturnType<typeof decodeAgentConfigurationRecord>,
): string {
	return configuration.source.kind === "standard"
		? configuration.source.templateId
		: configuration.source.imageDigest;
}

export class PostgresApplicationRevisionTransactionV1
	implements ApplicationRevisionTransactionPortV1
{
	readonly #client;
	readonly #database;

	constructor(options: PostgresApplicationRevisionOptionsV1) {
		this.#client = postgres(options.databaseUrl, { max: 10 });
		this.#database = drizzle(this.#client);
	}

	async read(
		input: Parameters<ApplicationRevisionTransactionPortV1["read"]>[0],
	): ReturnType<ApplicationRevisionTransactionPortV1["read"]> {
		try {
			if (
				input.schemaVersion !== 1 ||
				!validText(input.applicationId) ||
				!validText(input.actorId) ||
				!/^[A-Za-z0-9._~-]{1,128}$/.test(input.idempotencyKey) ||
				!/^[a-f0-9]{64}$/.test(input.requestDigest)
			) {
				unavailable();
			}
			return await this.#database.transaction(async (transaction) => {
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
							eq(idempotencyRecords.scopeId, input.applicationId),
							eq(idempotencyRecords.actorId, input.actorId),
							eq(idempotencyRecords.commandType, commandType),
							eq(idempotencyRecords.idempotencyKey, input.idempotencyKey),
						),
					)
					.limit(1);
				if (existing) {
					const replay = replayValue(
						existing,
						input.requestDigest,
						input.applicationId,
					);
					if (replay.outcome === "replayed") {
						await this.#requireReplayIntegrity(
							transaction,
							input.actorId,
							replay.result,
						);
					}
					return replay;
				}

				const [row] = await transaction
					.select({
						applicationId: agentApplications.id,
						agentId: agents.id,
						applicantId: agentApplications.applicantId,
						name: agentApplications.name,
						description: agentApplications.description,
						status: agentApplications.status,
						managementRevision: agentApplications.managementRevision,
						approvalRevision: agentApplications.approvalRevision,
						decisionReason: agentApplications.decisionReason,
						serviceAvailability: agentApplications.serviceAvailability,
						desiredState: agentApplications.desiredState,
						workloadRevision: agentApplications.workloadRevision,
						fence: agentApplications.fence,
						failureCode: agentApplications.failureCode,
						configurationRevision: agents.currentConfigurationRevision,
						authorizationRevision: agents.authorizationRevision,
						configuration: agentConfigurationRevisions.configuration,
						sourceReference: agentConfigurationRevisions.sourceReference,
					})
					.from(agents)
					.innerJoin(
						agentApplications,
						and(
							eq(agentApplications.agentId, agents.id),
							eq(agentApplications.id, input.applicationId),
							eq(agentApplications.applicantId, input.actorId),
						),
					)
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
					.for("update")
					.limit(1);
				if (!row?.configuration || !validText(row.authorizationRevision)) {
					return { outcome: "unavailable" as const };
				}
				const [ownerRows, availabilityRows] = await Promise.all([
					transaction
						.select({ ownerId: agentOwners.ownerId })
						.from(agentOwners)
						.where(eq(agentOwners.agentId, row.agentId)),
					transaction
						.select({
							targetType: agentAvailability.targetType,
							targetId: agentAvailability.targetId,
						})
						.from(agentAvailability)
						.where(eq(agentAvailability.agentId, row.agentId)),
				]);
				const ownerIds = ownerRows.map(({ ownerId }) => ownerId).sort();
				const availability = availabilityRows
					.map(({ targetType, targetId }) =>
						targetType === "user"
							? { kind: "user" as const, userId: targetId }
							: {
									kind: "organization" as const,
									organizationId: targetId,
								},
					)
					.sort(compareAccessTargets);
				validateAccess(ownerIds, availability);
				const configuration = decodeAgentConfigurationRecord(row.configuration);
				if (
					configuration.agentId !== row.agentId ||
					configuration.revision !== row.configurationRevision ||
					sourceReference(configuration) !== row.sourceReference
				) {
					unavailable();
				}
				return {
					outcome: "ready" as const,
					state: {
						schemaVersion: 1 as const,
						application: {
							applicationId: row.applicationId,
							agentId: row.agentId,
							applicantId: row.applicantId,
							name: row.name,
							description: row.description,
						},
						management: {
							schemaVersion: 1 as const,
							applicationId: row.applicationId,
							agentId: row.agentId,
							applicantId: row.applicantId,
							status: row.status,
							revision: row.managementRevision,
							approvalRevision: row.approvalRevision,
							decisionReason: row.decisionReason,
							serviceAvailability: row.serviceAvailability,
							desiredState: row.desiredState,
							workloadRevision: row.workloadRevision,
							fence: row.fence,
							ownerIds,
							availability,
							failureCode: row.failureCode,
						},
						configuration,
						authorizationRevision: row.authorizationRevision,
					},
				};
			});
		} catch (error) {
			if (error instanceof ApplicationRevisionStoreError) throw error;
			throw new ApplicationRevisionStoreError();
		}
	}

	async commit(
		input: ApplicationRevisionWritePlanV1,
	): ReturnType<ApplicationRevisionTransactionPortV1["commit"]> {
		try {
			const { plan, result, configuration } = validatedPlan(input);
			return await this.#database.transaction(async (transaction) => {
				const [agent] = await transaction
					.select({
						configurationRevision: agents.currentConfigurationRevision,
						authorizationRevision: agents.authorizationRevision,
					})
					.from(agents)
					.where(eq(agents.id, plan.application.agentId))
					.for("update")
					.limit(1);
				const [application] = await transaction
					.select({
						managementRevision: agentApplications.managementRevision,
						status: agentApplications.status,
					})
					.from(agentApplications)
					.where(
						and(
							eq(agentApplications.id, plan.application.applicationId),
							eq(agentApplications.agentId, plan.application.agentId),
							eq(agentApplications.applicantId, plan.application.applicantId),
						),
					)
					.for("update")
					.limit(1);
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
							eq(idempotencyRecords.scopeId, plan.application.applicationId),
							eq(idempotencyRecords.actorId, plan.application.applicantId),
							eq(idempotencyRecords.commandType, commandType),
							eq(idempotencyRecords.idempotencyKey, plan.idempotency.key),
						),
					)
					.limit(1);
				if (existing) {
					const replay = replayValue(
						existing,
						plan.idempotency.requestDigest,
						plan.application.applicationId,
					);
					if (replay.outcome === "idempotency_conflict") {
						return {
							outcome: "conflict" as const,
							reason: "idempotency_conflict" as const,
						};
					}
					await this.#requireReplayIntegrity(
						transaction,
						plan.application.applicantId,
						replay.result,
					);
					return replay;
				}
				if (
					!agent ||
					agent.configurationRevision !== plan.expected.configurationRevision
				) {
					return {
						outcome: "conflict" as const,
						reason: "stale_configuration" as const,
					};
				}
				if (
					agent.authorizationRevision !== plan.expected.authorizationRevision
				) {
					return {
						outcome: "conflict" as const,
						reason: "stale_authorization" as const,
					};
				}
				if (
					!application ||
					application.managementRevision !== plan.expected.managementRevision ||
					application.status !== plan.management.transition.from
				) {
					return {
						outcome: "conflict" as const,
						reason: "stale_management" as const,
					};
				}
				await this.#requireCurrentIntegrity(transaction, plan);

				if (configuration && plan.configuration) {
					if (
						!(await advanceAgentConfigurationRevision(
							transaction,
							plan.configuration,
							configuration,
						))
					) {
						unavailable();
					}
				} else {
					const advancedAgent = await transaction
						.update(agents)
						.set({
							currentConfigurationRevision: result.configurationRevision,
							authorizationRevision: plan.nextAuthorizationRevision,
						})
						.where(
							and(
								eq(agents.id, plan.application.agentId),
								eq(
									agents.currentConfigurationRevision,
									plan.expected.configurationRevision,
								),
								eq(
									agents.authorizationRevision,
									plan.expected.authorizationRevision,
								),
							),
						)
						.returning({ id: agents.id });
					if (advancedAgent.length !== 1) unavailable();
				}

				const advancedApplication = await transaction
					.update(agentApplications)
					.set({
						...agentManagementStateUpdate(plan.management),
						name: plan.application.name,
						description: plan.application.description,
						traceId: plan.application.traceId,
						requestId: plan.application.requestId,
					})
					.where(
						and(
							eq(agentApplications.id, plan.application.applicationId),
							eq(agentApplications.agentId, plan.application.agentId),
							eq(agentApplications.applicantId, plan.application.applicantId),
							eq(
								agentApplications.managementRevision,
								plan.expected.managementRevision,
							),
							eq(agentApplications.status, plan.management.transition.from),
						),
					)
					.returning({ id: agentApplications.id });
				if (advancedApplication.length !== 1) unavailable();

				if (plan.configuration?.accessUpdate) {
					await replaceAgentAccess(
						transaction,
						plan.configuration.accessUpdate,
						plan.outboxIntent.occurredAt,
					);
				}

				await insertAgentManagementHistory(transaction, plan.management);
				await transaction.insert(idempotencyRecords).values({
					id: randomUUID(),
					scopeType,
					scopeId: plan.application.applicationId,
					actorId: plan.application.applicantId,
					commandType,
					idempotencyKey: plan.idempotency.key,
					requestDigest: plan.idempotency.requestDigest,
					status: "completed",
					result: { ...result },
					createdAt: plan.outboxIntent.occurredAt,
					updatedAt: plan.outboxIntent.occurredAt,
				});
				if (plan.configuration) {
					await insertAgentConfigurationEffects(
						transaction,
						plan.configuration,
					);
				}
				await transaction.insert(outboxItems).values({
					id: randomUUID(),
					scopeType: "agent",
					scopeId: plan.application.agentId,
					operation: plan.outboxIntent.operation,
					payload: { ...result },
					traceId: plan.outboxIntent.traceId,
					requestId: plan.outboxIntent.requestId,
					availableAt: plan.outboxIntent.occurredAt,
					createdAt: plan.outboxIntent.occurredAt,
					updatedAt: plan.outboxIntent.occurredAt,
				});
				await insertAgentManagementEffects(transaction, plan.management);
				return { outcome: "committed" as const, result };
			});
		} catch (error) {
			if (error instanceof ApplicationRevisionStoreError) throw error;
			throw new ApplicationRevisionStoreError();
		}
	}

	async close(): Promise<void> {
		try {
			await this.#client.end();
		} catch {
			throw new ApplicationRevisionStoreError();
		}
	}

	async #requireReplayIntegrity(
		transaction: Parameters<
			Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
		>[0],
		actorId: string,
		result: ApplicationRevisionResultV1,
	): Promise<void> {
		const [row] = await transaction
			.select({
				agentId: agentApplications.agentId,
				configuration: agentConfigurationRevisions.configuration,
				operation: agentManagementHistory.operation,
				toStatus: agentManagementHistory.toStatus,
			})
			.from(agentApplications)
			.innerJoin(
				agentConfigurationRevisions,
				and(
					eq(agentConfigurationRevisions.agentId, agentApplications.agentId),
					eq(
						agentConfigurationRevisions.revision,
						result.configurationRevision,
					),
				),
			)
			.innerJoin(
				agentManagementHistory,
				and(
					eq(agentManagementHistory.agentId, agentApplications.agentId),
					eq(agentManagementHistory.revision, result.managementRevision),
					eq(agentManagementHistory.applicationId, agentApplications.id),
				),
			)
			.where(
				and(
					eq(agentApplications.id, result.applicationId),
					eq(agentApplications.applicantId, actorId),
				),
			)
			.limit(1);
		if (
			!row?.configuration ||
			row.agentId !== result.agentId ||
			row.operation !== "update_application" ||
			row.toStatus !== "pending_approval"
		) {
			unavailable();
		}
		const configuration = decodeAgentConfigurationRecord(row.configuration);
		if (
			configuration.agentId !== result.agentId ||
			configuration.revision !== result.configurationRevision
		) {
			unavailable();
		}
	}

	async #requireCurrentIntegrity(
		transaction: Parameters<
			Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
		>[0],
		plan: ApplicationRevisionWritePlanV1,
	): Promise<void> {
		const [configurationRows, ownerRows, availabilityRows] = await Promise.all([
			transaction
				.select({
					configuration: agentConfigurationRevisions.configuration,
					sourceReference: agentConfigurationRevisions.sourceReference,
				})
				.from(agentConfigurationRevisions)
				.where(
					and(
						eq(agentConfigurationRevisions.agentId, plan.application.agentId),
						eq(
							agentConfigurationRevisions.revision,
							plan.expected.configurationRevision,
						),
					),
				)
				.limit(1),
			transaction
				.select({ ownerId: agentOwners.ownerId })
				.from(agentOwners)
				.where(eq(agentOwners.agentId, plan.application.agentId)),
			transaction
				.select({
					targetType: agentAvailability.targetType,
					targetId: agentAvailability.targetId,
				})
				.from(agentAvailability)
				.where(eq(agentAvailability.agentId, plan.application.agentId)),
		]);
		const [configurationRow] = configurationRows;
		if (!configurationRow?.configuration) unavailable();
		const current = decodeAgentConfigurationRecord(
			configurationRow.configuration,
		);
		const ownerIds = ownerRows.map(({ ownerId }) => ownerId).sort();
		const availability = availabilityRows
			.map(({ targetType, targetId }) =>
				targetType === "user"
					? { kind: "user" as const, userId: targetId }
					: {
							kind: "organization" as const,
							organizationId: targetId,
						},
			)
			.sort(compareAccessTargets);
		validateAccess(ownerIds, availability);
		if (
			current.agentId !== plan.application.agentId ||
			current.revision !== plan.expected.configurationRevision ||
			sourceReference(current) !== configurationRow.sourceReference ||
			(!plan.configuration?.accessUpdate &&
				(!sameValue(ownerIds, plan.management.state.ownerIds) ||
					!sameValue(availability, plan.management.state.availability)))
		) {
			unavailable();
		}
	}
}
