import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type {
	AgentConfigurationAccessTargetV1,
	AgentConfigurationWritePlanV1,
	AgentManagementStateV1,
	AgentManagementWritePlanV1,
	ApplicationRevisionResultV1,
	ApplicationRevisionTransactionPortV1,
	ApplicationRevisionWritePlanV1,
} from "@agent-infra/platform-core";
import { snapshotApplicationRevisionWritePlanV1 } from "@agent-infra/platform-core";
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
	agentManagementHistory,
	agentOwners,
	agents,
	auditEvents,
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

function validDate(input: unknown): input is Date {
	try {
		return Number.isFinite(Date.prototype.getTime.call(input));
	} catch {
		return false;
	}
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

function validateManagementState(
	state: AgentManagementStateV1,
	plan: ApplicationRevisionWritePlanV1,
): void {
	exact(state, [
		"schemaVersion",
		"applicationId",
		"agentId",
		"applicantId",
		"status",
		"revision",
		"approvalRevision",
		"decisionReason",
		"serviceAvailability",
		"desiredState",
		"workloadRevision",
		"fence",
		"ownerIds",
		"availability",
		"failureCode",
	]);
	if (
		state.schemaVersion !== 1 ||
		state.applicationId !== plan.application.applicationId ||
		state.agentId !== plan.application.agentId ||
		state.applicantId !== plan.application.applicantId ||
		state.status !== "pending_approval" ||
		state.revision !== plan.expected.managementRevision + 1 ||
		state.approvalRevision !== null ||
		state.decisionReason !== null ||
		state.serviceAvailability !== null ||
		state.desiredState !== "stopped" ||
		state.workloadRevision !== 0 ||
		state.fence !== 0 ||
		state.failureCode !== null
	) {
		unavailable();
	}
	validateAccess(state.ownerIds, state.availability);
}

function validateManagement(
	management: AgentManagementWritePlanV1,
	plan: ApplicationRevisionWritePlanV1,
): void {
	exact(management, [
		"schemaVersion",
		"operation",
		"subjectType",
		"subjectId",
		"expectedRevision",
		"state",
		"transition",
		"outboxIntent",
		"auditEvent",
		"idempotency",
	]);
	exact(management.transition, ["from", "to", "occurredAt"]);
	exact(management.auditEvent, [
		"action",
		"actorId",
		"subjectType",
		"subjectId",
		"traceId",
		"requestId",
		"occurredAt",
	]);
	exact(management.idempotency, ["key", "requestDigest"]);
	validateManagementState(management.state, plan);
	const resubmission = management.transition.from === "rejected";
	if (
		management.schemaVersion !== 1 ||
		management.operation !== "update_application" ||
		management.subjectType !== "agent_application" ||
		management.subjectId !== plan.application.applicationId ||
		management.expectedRevision !== plan.expected.managementRevision ||
		(management.transition.from !== "pending_approval" && !resubmission) ||
		management.transition.to !== "pending_approval" ||
		!validDate(management.transition.occurredAt) ||
		management.outboxIntent !== null ||
		management.auditEvent.action !==
			(resubmission
				? "agent.application.resubmitted"
				: "agent.application.updated") ||
		management.auditEvent.actorId !== plan.application.applicantId ||
		management.auditEvent.subjectType !== "agent_application" ||
		management.auditEvent.subjectId !== plan.application.applicationId ||
		management.auditEvent.traceId !== plan.application.traceId ||
		management.auditEvent.requestId !== plan.application.requestId ||
		!validDate(management.auditEvent.occurredAt) ||
		Date.prototype.getTime.call(management.transition.occurredAt) !==
			Date.prototype.getTime.call(management.auditEvent.occurredAt) ||
		management.idempotency.key !== plan.idempotency.key ||
		!/^[A-Za-z0-9._~-]{1,128}$/.test(management.idempotency.key) ||
		!/^[a-f0-9]{64}$/.test(management.idempotency.requestDigest)
	) {
		unavailable();
	}
}

function validateConfiguration(
	configurationPlan: AgentConfigurationWritePlanV1,
	plan: ApplicationRevisionWritePlanV1,
): ReturnType<typeof decodeAgentConfigurationRecord> {
	exact(configurationPlan, [
		"schemaVersion",
		"agentId",
		"baseRevision",
		"nextRevision",
		"expectedAuthorizationRevision",
		"nextAuthorizationRevision",
		"configuration",
		"accessUpdate",
		"result",
		"idempotency",
		"outboxIntent",
		"auditEvent",
	]);
	exact(configurationPlan.idempotency, ["key", "requestDigest"]);
	exact(configurationPlan.outboxIntent, [
		"operation",
		"payload",
		"traceId",
		"requestId",
		"occurredAt",
	]);
	exact(configurationPlan.outboxIntent.payload, [
		"schemaVersion",
		"agentId",
		"baseRevision",
		"configurationRevision",
		"changedFields",
	]);
	exact(configurationPlan.auditEvent, [
		"action",
		"actorId",
		"agentId",
		"subjectType",
		"subjectId",
		"changedFields",
		"traceId",
		"requestId",
		"occurredAt",
	]);
	let configuration: ReturnType<typeof decodeAgentConfigurationRecord>;
	let result: ReturnType<typeof decodeAgentConfigurationResult>;
	try {
		configuration = decodeAgentConfigurationRecord(
			configurationPlan.configuration,
		);
		result = decodeAgentConfigurationResult(configurationPlan.result);
	} catch {
		unavailable();
	}
	const payload = {
		schemaVersion: 1 as const,
		agentId: plan.application.agentId,
		baseRevision: plan.expected.configurationRevision,
		configurationRevision: configurationPlan.nextRevision,
		changedFields: [...result.changedFields],
	};
	if (
		configurationPlan.schemaVersion !== 1 ||
		configurationPlan.agentId !== plan.application.agentId ||
		configurationPlan.baseRevision !== plan.expected.configurationRevision ||
		configurationPlan.nextRevision !==
			plan.expected.configurationRevision + 1 ||
		configurationPlan.expectedAuthorizationRevision !==
			plan.expected.authorizationRevision ||
		configurationPlan.nextAuthorizationRevision !==
			plan.nextAuthorizationRevision ||
		configuration.agentId !== plan.application.agentId ||
		configuration.revision !== configurationPlan.nextRevision ||
		result.agentId !== plan.application.agentId ||
		result.revision !== configurationPlan.nextRevision ||
		configurationPlan.idempotency.key !== plan.idempotency.key ||
		!/^[A-Za-z0-9._~-]{1,128}$/.test(configurationPlan.idempotency.key) ||
		!/^[a-f0-9]{64}$/.test(configurationPlan.idempotency.requestDigest) ||
		configurationPlan.outboxIntent.operation !==
			"agent.configuration.revised.v1" ||
		!sameValue(configurationPlan.outboxIntent.payload, payload) ||
		configurationPlan.outboxIntent.traceId !== plan.application.traceId ||
		configurationPlan.outboxIntent.requestId !== plan.application.requestId ||
		!validDate(configurationPlan.outboxIntent.occurredAt) ||
		(configurationPlan.auditEvent.action !== "agent.configuration.revised" &&
			configurationPlan.auditEvent.action !== "agent.access.updated") ||
		configurationPlan.auditEvent.actorId !== plan.application.applicantId ||
		configurationPlan.auditEvent.agentId !== plan.application.agentId ||
		configurationPlan.auditEvent.subjectType !== "agent" ||
		configurationPlan.auditEvent.subjectId !== plan.application.agentId ||
		!sameValue(
			configurationPlan.auditEvent.changedFields,
			result.changedFields,
		) ||
		configurationPlan.auditEvent.traceId !== plan.application.traceId ||
		configurationPlan.auditEvent.requestId !== plan.application.requestId ||
		!validDate(configurationPlan.auditEvent.occurredAt) ||
		Date.prototype.getTime.call(configurationPlan.auditEvent.occurredAt) !==
			Date.prototype.getTime.call(configurationPlan.outboxIntent.occurredAt)
	) {
		unavailable();
	}
	if (configurationPlan.accessUpdate) {
		exact(configurationPlan.accessUpdate, [
			"schemaVersion",
			"fragmentType",
			"agentId",
			"expectedRevision",
			"ownerIds",
			"availability",
		]);
		if (
			configurationPlan.accessUpdate.schemaVersion !== 1 ||
			configurationPlan.accessUpdate.fragmentType !== "agent_access" ||
			configurationPlan.accessUpdate.agentId !== plan.application.agentId ||
			configurationPlan.accessUpdate.expectedRevision !==
				plan.expected.managementRevision
		) {
			unavailable();
		}
		validateAccess(
			configurationPlan.accessUpdate.ownerIds,
			configurationPlan.accessUpdate.availability,
		);
		if (
			!sameValue(
				configurationPlan.accessUpdate.ownerIds,
				plan.management.state.ownerIds,
			) ||
			!sameValue(
				configurationPlan.accessUpdate.availability,
				plan.management.state.availability,
			)
		) {
			unavailable();
		}
	}
	const accessFields = result.changedFields.filter(
		(field) => field === "owners" || field === "availability",
	);
	const accessOnly = accessFields.length === result.changedFields.length;
	if (
		accessFields.length > 0 !== (configurationPlan.accessUpdate !== null) ||
		configurationPlan.auditEvent.action !==
			(accessOnly ? "agent.access.updated" : "agent.configuration.revised")
	) {
		unavailable();
	}
	return configuration;
}

function validatedPlan(input: ApplicationRevisionWritePlanV1) {
	const plan = snapshotPlan(input);
	exact(plan, [
		"schemaVersion",
		"application",
		"expected",
		"nextAuthorizationRevision",
		"management",
		"configuration",
		"result",
		"idempotency",
		"outboxIntent",
		"auditEvent",
	]);
	exact(plan.application, [
		"applicationId",
		"agentId",
		"applicantId",
		"name",
		"description",
		"traceId",
		"requestId",
	]);
	exact(plan.expected, [
		"managementRevision",
		"configurationRevision",
		"authorizationRevision",
	]);
	exact(plan.idempotency, ["key", "requestDigest"]);
	exact(plan.outboxIntent, [
		"operation",
		"payload",
		"traceId",
		"requestId",
		"occurredAt",
	]);
	const result = resultValue(plan.result);
	const payload = resultValue(plan.outboxIntent.payload);
	validateManagement(plan.management, plan);
	const configuration = plan.configuration
		? validateConfiguration(plan.configuration, plan)
		: null;
	if (
		plan.schemaVersion !== 1 ||
		!validText(plan.application.applicationId) ||
		!validText(plan.application.agentId) ||
		!validText(plan.application.applicantId) ||
		!validText(plan.application.name, 800) ||
		Array.from(plan.application.name).length > 200 ||
		!validText(plan.application.description, 65_536) ||
		!validText(plan.application.traceId) ||
		!validText(plan.application.requestId) ||
		!safeInteger(plan.expected.managementRevision) ||
		!safeInteger(plan.expected.configurationRevision, 1) ||
		!validText(plan.expected.authorizationRevision) ||
		!validText(plan.nextAuthorizationRevision) ||
		result.applicationId !== plan.application.applicationId ||
		result.agentId !== plan.application.agentId ||
		result.managementRevision !== plan.management.state.revision ||
		result.configurationRevision !==
			(plan.configuration?.nextRevision ??
				plan.expected.configurationRevision) ||
		!sameValue(payload, result) ||
		!/^[A-Za-z0-9._~-]{1,128}$/.test(plan.idempotency.key) ||
		!/^[a-f0-9]{64}$/.test(plan.idempotency.requestDigest) ||
		plan.outboxIntent.operation !== "agent.application.revised.v1" ||
		plan.outboxIntent.traceId !== plan.application.traceId ||
		plan.outboxIntent.requestId !== plan.application.requestId ||
		!validDate(plan.outboxIntent.occurredAt) ||
		!sameValue(plan.auditEvent, plan.management.auditEvent) ||
		Date.prototype.getTime.call(plan.outboxIntent.occurredAt) !==
			Date.prototype.getTime.call(plan.auditEvent.occurredAt)
	) {
		unavailable();
	}
	return { plan, result, configuration };
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
					await transaction.insert(agentConfigurationRevisions).values({
						agentId: plan.application.agentId,
						revision: plan.configuration.nextRevision,
						sourceReference: sourceReference(configuration),
						configuration,
						createdAt: plan.outboxIntent.occurredAt,
					});
				}
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

				const advancedApplication = await transaction
					.update(agentApplications)
					.set({
						name: plan.application.name,
						description: plan.application.description,
						traceId: plan.application.traceId,
						requestId: plan.application.requestId,
						status: plan.management.state.status,
						managementRevision: plan.management.state.revision,
						approvalRevision: plan.management.state.approvalRevision,
						decisionReason: plan.management.state.decisionReason,
						serviceAvailability: plan.management.state.serviceAvailability,
						desiredState: plan.management.state.desiredState,
						workloadRevision: plan.management.state.workloadRevision,
						fence: plan.management.state.fence,
						failureCode: plan.management.state.failureCode,
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
					await transaction
						.delete(agentOwners)
						.where(eq(agentOwners.agentId, plan.application.agentId));
					await transaction.insert(agentOwners).values(
						plan.configuration.accessUpdate.ownerIds.map((ownerId) => ({
							agentId: plan.application.agentId,
							ownerId,
							createdAt: plan.outboxIntent.occurredAt,
						})),
					);
					await transaction
						.delete(agentAvailability)
						.where(eq(agentAvailability.agentId, plan.application.agentId));
					if (plan.configuration.accessUpdate.availability.length > 0) {
						await transaction.insert(agentAvailability).values(
							plan.configuration.accessUpdate.availability.map((target) => ({
								agentId: plan.application.agentId,
								targetType: target.kind,
								targetId:
									target.kind === "user"
										? target.userId
										: target.organizationId,
							})),
						);
					}
				}

				await transaction.insert(agentManagementHistory).values({
					agentId: plan.application.agentId,
					revision: plan.management.state.revision,
					applicationId: plan.application.applicationId,
					subjectType: plan.management.subjectType,
					subjectId: plan.management.subjectId,
					operation: plan.management.operation,
					fromStatus: plan.management.transition.from,
					toStatus: plan.management.transition.to,
					occurredAt: plan.management.transition.occurredAt,
				});
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
					await transaction.insert(outboxItems).values({
						id: randomUUID(),
						scopeType: "agent",
						scopeId: plan.application.agentId,
						operation: plan.configuration.outboxIntent.operation,
						payload: { ...plan.configuration.outboxIntent.payload },
						traceId: plan.configuration.outboxIntent.traceId,
						requestId: plan.configuration.outboxIntent.requestId,
						availableAt: plan.configuration.outboxIntent.occurredAt,
						createdAt: plan.configuration.outboxIntent.occurredAt,
						updatedAt: plan.configuration.outboxIntent.occurredAt,
					});
					await transaction.insert(auditEvents).values({
						id: randomUUID(),
						traceId: plan.configuration.auditEvent.traceId,
						requestId: plan.configuration.auditEvent.requestId,
						agentId: plan.application.agentId,
						actorType: "user",
						actorId: plan.configuration.auditEvent.actorId,
						action: plan.configuration.auditEvent.action,
						targetType: plan.configuration.auditEvent.subjectType,
						targetId: plan.configuration.auditEvent.subjectId,
						outcome: "succeeded",
						details: {
							changedFields: plan.configuration.auditEvent.changedFields,
						},
						occurredAt: plan.configuration.auditEvent.occurredAt,
					});
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
				await transaction.insert(auditEvents).values({
					id: randomUUID(),
					traceId: plan.auditEvent.traceId,
					requestId: plan.auditEvent.requestId,
					agentId: plan.application.agentId,
					actorType: "user",
					actorId: plan.auditEvent.actorId,
					action: plan.auditEvent.action,
					targetType: plan.auditEvent.subjectType,
					targetId: plan.auditEvent.subjectId,
					outcome: "succeeded",
					occurredAt: plan.auditEvent.occurredAt,
				});
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
