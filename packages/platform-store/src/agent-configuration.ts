import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type {
	AgentConfigurationAccessTargetV1,
	AgentConfigurationRecordV1,
	AgentConfigurationResultV1,
	AgentConfigurationTransactionPortV1,
	AgentConfigurationWritePlanV1,
} from "@agent-infra/platform-core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
	decodeAgentConfigurationRecord,
	decodeAgentConfigurationResult,
} from "./agent-configuration-record.js";
import {
	agentApplications,
	agentAvailability,
	agentConfigurationRevisions,
	agentOwners,
	agents,
	auditEvents,
	idempotencyRecords,
	outboxItems,
} from "./schema.js";

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

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalSourceReference(configuration: AgentConfigurationRecordV1) {
	return configuration.source.kind === "standard"
		? configuration.source.templateId
		: configuration.source.imageDigest;
}

function validDate(input: unknown): input is Date {
	try {
		return Number.isFinite(Date.prototype.getTime.call(input));
	} catch {
		return false;
	}
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

function validateAccessUpdate(
	input: AgentConfigurationWritePlanV1["accessUpdate"],
	agentId: string,
): void {
	if (input === null) return;
	if (
		input.schemaVersion !== 1 ||
		input.fragmentType !== "agent_access" ||
		input.agentId !== agentId ||
		!Number.isSafeInteger(input.expectedRevision) ||
		input.expectedRevision < 0 ||
		input.ownerIds.length === 0 ||
		input.ownerIds.length > maxAccessTargets ||
		new Set(input.ownerIds).size !== input.ownerIds.length ||
		!sameValue(input.ownerIds, [...input.ownerIds].sort()) ||
		input.ownerIds.some((ownerId) => !validateText(ownerId))
	) {
		throw new AgentConfigurationStoreError();
	}
	const targets = input.availability.map((target) =>
		target.kind === "user"
			? `user\0${target.userId}`
			: `organization\0${target.organizationId}`,
	);
	if (
		input.availability.length > maxAccessTargets ||
		new Set(targets).size !== targets.length ||
		!sameValue(targets, [...targets].sort()) ||
		input.availability.some((target) =>
			target.kind === "user"
				? !validateText(target.userId)
				: !validateText(target.organizationId),
		)
	) {
		throw new AgentConfigurationStoreError();
	}
}

function validatedPlan(plan: AgentConfigurationWritePlanV1) {
	let configuration: AgentConfigurationRecordV1;
	let result: AgentConfigurationResultV1;
	try {
		configuration = decodeAgentConfigurationRecord(plan.configuration);
		result = decodeAgentConfigurationResult(plan.result);
	} catch {
		throw new AgentConfigurationStoreError();
	}
	const outboxPayload = {
		schemaVersion: 1 as const,
		agentId: plan.agentId,
		baseRevision: plan.baseRevision,
		configurationRevision: plan.nextRevision,
		changedFields: [...result.changedFields],
	};
	if (
		plan.schemaVersion !== 1 ||
		!validateText(plan.agentId) ||
		!Number.isSafeInteger(plan.baseRevision) ||
		plan.baseRevision < 1 ||
		plan.nextRevision !== plan.baseRevision + 1 ||
		!Number.isSafeInteger(plan.nextRevision) ||
		!validateText(plan.authorizationRevision) ||
		configuration.agentId !== plan.agentId ||
		configuration.revision !== plan.nextRevision ||
		result.agentId !== plan.agentId ||
		result.revision !== plan.nextRevision ||
		!sameValue(configuration, plan.configuration) ||
		!sameValue(result, plan.result) ||
		!validateText(plan.idempotency.key) ||
		!/^[A-Za-z0-9._~-]{1,128}$/.test(plan.idempotency.key) ||
		!/^[a-f0-9]{64}$/.test(plan.idempotency.requestDigest) ||
		plan.outboxIntent.operation !== "agent.configuration.revised.v1" ||
		plan.outboxIntent.payload.schemaVersion !== 1 ||
		plan.outboxIntent.payload.agentId !== plan.agentId ||
		plan.outboxIntent.payload.baseRevision !== plan.baseRevision ||
		plan.outboxIntent.payload.configurationRevision !== plan.nextRevision ||
		!sameValue(plan.outboxIntent.payload.changedFields, result.changedFields) ||
		!sameValue(plan.outboxIntent.payload, outboxPayload) ||
		!validateText(plan.outboxIntent.traceId) ||
		!validateText(plan.outboxIntent.requestId) ||
		!validDate(plan.outboxIntent.occurredAt) ||
		(plan.auditEvent.action !== "agent.configuration.revised" &&
			plan.auditEvent.action !== "agent.access.updated") ||
		!validateText(plan.auditEvent.actorId) ||
		plan.auditEvent.agentId !== plan.agentId ||
		plan.auditEvent.subjectType !== "agent" ||
		plan.auditEvent.subjectId !== plan.agentId ||
		!sameValue(plan.auditEvent.changedFields, result.changedFields) ||
		plan.auditEvent.traceId !== plan.outboxIntent.traceId ||
		plan.auditEvent.requestId !== plan.outboxIntent.requestId ||
		!validDate(plan.auditEvent.occurredAt)
	) {
		throw new AgentConfigurationStoreError();
	}
	validateAccessUpdate(plan.accessUpdate, plan.agentId);
	const accessFields = result.changedFields.filter(
		(field) => field === "owners" || field === "availability",
	);
	const accessOnly = accessFields.length === result.changedFields.length;
	if (
		(accessFields.length > 0 && plan.accessUpdate === null) ||
		(plan.accessUpdate !== null && accessFields.length === 0) ||
		plan.auditEvent.action !==
			(accessOnly ? "agent.access.updated" : "agent.configuration.revised") ||
		Date.prototype.getTime.call(plan.auditEvent.occurredAt) !==
			Date.prototype.getTime.call(plan.outboxIntent.occurredAt)
	) {
		throw new AgentConfigurationStoreError();
	}
	return { configuration, result, outboxPayload };
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
						configuration,
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
		plan: AgentConfigurationWritePlanV1,
	): ReturnType<AgentConfigurationTransactionPortV1["commit"]> {
		try {
			const { configuration, result, outboxPayload } = validatedPlan(plan);
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
					agent.authorizationRevision !== plan.authorizationRevision
				) {
					return { outcome: "stale" as const };
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

				await transaction.insert(agentConfigurationRevisions).values({
					agentId: plan.agentId,
					revision: plan.nextRevision,
					sourceReference: canonicalSourceReference(configuration),
					configuration,
					createdAt: plan.outboxIntent.occurredAt,
				});
				const advanced = await transaction
					.update(agents)
					.set({ currentConfigurationRevision: plan.nextRevision })
					.where(
						and(
							eq(agents.id, plan.agentId),
							eq(agents.currentConfigurationRevision, plan.baseRevision),
							eq(agents.authorizationRevision, plan.authorizationRevision),
						),
					)
					.returning({ id: agents.id });
				if (advanced.length !== 1) throw new StaleAgentConfigurationCommit();

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
					await transaction
						.delete(agentOwners)
						.where(eq(agentOwners.agentId, plan.agentId));
					await transaction.insert(agentOwners).values(
						plan.accessUpdate.ownerIds.map((ownerId) => ({
							agentId: plan.agentId,
							ownerId,
							createdAt: plan.auditEvent.occurredAt,
						})),
					);
					await transaction
						.delete(agentAvailability)
						.where(eq(agentAvailability.agentId, plan.agentId));
					if (plan.accessUpdate.availability.length > 0) {
						await transaction.insert(agentAvailability).values(
							plan.accessUpdate.availability.map((target) => ({
								agentId: plan.agentId,
								targetType: target.kind,
								targetId:
									target.kind === "user"
										? target.userId
										: target.organizationId,
							})),
						);
					}
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
				await transaction.insert(outboxItems).values({
					id: randomUUID(),
					scopeType,
					scopeId: plan.agentId,
					operation: plan.outboxIntent.operation,
					payload: outboxPayload,
					traceId: plan.outboxIntent.traceId,
					requestId: plan.outboxIntent.requestId,
					availableAt: plan.outboxIntent.occurredAt,
					createdAt: plan.outboxIntent.occurredAt,
					updatedAt: plan.outboxIntent.occurredAt,
				});
				await transaction.insert(auditEvents).values({
					id: randomUUID(),
					traceId: plan.auditEvent.traceId,
					requestId: plan.auditEvent.requestId,
					agentId: plan.agentId,
					actorType: "user",
					actorId: plan.auditEvent.actorId,
					action: plan.auditEvent.action,
					targetType: plan.auditEvent.subjectType,
					targetId: plan.auditEvent.subjectId,
					outcome: "succeeded",
					details: { changedFields: plan.auditEvent.changedFields },
					occurredAt: plan.auditEvent.occurredAt,
				});
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
	readonly actions: AgentConfigurationRecordV1["actions"];
	readonly environment: AgentConfigurationRecordV1["environment"];
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

export class PostgresAgentConfigurationQueryV1 {
	readonly #client;
	readonly #database;

	constructor(options: PostgresAgentConfigurationOptionsV1) {
		this.#client = postgres(options.databaseUrl, { max: 10 });
		this.#database = drizzle(this.#client);
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
							actions: configuration.actions,
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
