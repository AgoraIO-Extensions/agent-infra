import { randomUUID } from "node:crypto";

import type {
	AgentConfigurationRecord,
	AgentConfigurationRelayKeyAttachmentV1,
	AgentConfigurationWritePlanV1,
	AgentManagementWritePlanV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { replaceRelayKeyVersionInTransaction } from "./relay-key-versions.js";
import {
	agentAvailability,
	agentConfigurationRevisions,
	agentManagementHistory,
	agentOwners,
	agents,
	auditEvents,
	idempotencyRecords,
	outboxItems,
	skillHubAgentBindings,
	skillHubInstallations,
	skillHubSkills,
	skillHubVersions,
} from "./schema.js";
import { persistSessionSandboxManagementIntents } from "./session-sandbox-management.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];

/**
 * 配置版本只能沿 V2→V2、V3→V3 前进（#2401、#2421）：
 * - V3 基线绝不降级为需要模型凭证的 V2；
 * - V2 基线不会被悄悄改写成 V3；
 * - 替换默认 Key 的计划必须恰好带着 Key 附件（`keyAttached`），且只发生在 V3 上：
 *   没有附件会让配置前进而新 Key 被静默丢弃，有附件但计划没声明则是写入越权。
 */
export function configurationVersionTransitionAllowed(
	plan: Pick<AgentConfigurationWritePlanV1, "result">,
	configuration: Pick<AgentConfigurationRecord, "schemaVersion">,
	previous: Pick<AgentConfigurationRecord, "schemaVersion">,
	keyAttached = false,
): boolean {
	const replacesKey = plan.result.changedFields.includes("defaultRelayKey");
	if (replacesKey !== keyAttached) return false;
	if (configuration.schemaVersion === 3) return previous.schemaVersion === 3;
	return (
		!replacesKey &&
		configuration.schemaVersion === 2 &&
		previous.schemaVersion === 2
	);
}

/**
 * 在配置提交的同一事务内写入新的 Agent 默认 Key 版本和审计（#2421）。
 * 返回 `stale` 表示当前 Key 版本与调用方看到的 expectedVersion 不一致，此时没有写入
 * 任何 Key 材料；调用方据此返回可与配置修订冲突区分开的结果，或抛错回滚整个事务。
 * 审计只记录版本号，不含 Key 材料。
 */
export async function replaceAgentDefaultRelayKeyInTransaction(
	transaction: Transaction,
	plan: Pick<AgentConfigurationWritePlanV1, "agentId" | "nextRevision"> & {
		readonly auditEvent: Pick<
			AgentConfigurationWritePlanV1["auditEvent"],
			"actorId" | "traceId" | "requestId" | "occurredAt"
		>;
	},
	key: AgentConfigurationRelayKeyAttachmentV1,
): Promise<"replaced" | "stale"> {
	// 沿用原 Drizzle 事务，只把带标签的 SQL 适配给 Key 版本写入器。
	const keySql = async (
		parts: TemplateStringsArray,
		...parameters: (string | number)[]
	) => transaction.execute(sql(parts, ...parameters));
	const replacement = await replaceRelayKeyVersionInTransaction(keySql, {
		purpose: "agent-default",
		subjectId: plan.agentId,
		expectedCurrentVersion: key.expectedVersion,
		encrypt: (binding) => key.encrypt({ ...binding, purpose: "agent-default" }),
	});
	if (replacement.outcome !== "replaced") return "stale";
	await transaction.insert(auditEvents).values({
		id: randomUUID(),
		traceId: plan.auditEvent.traceId,
		requestId: plan.auditEvent.requestId,
		agentId: plan.agentId,
		actorType: "user",
		actorId: plan.auditEvent.actorId,
		action: "relay_key.agent_default.replace",
		targetType: "agent",
		targetId: plan.agentId,
		outcome: "succeeded",
		occurredAt: plan.auditEvent.occurredAt,
		details: {
			schemaVersion: 1,
			previousVersion: key.expectedVersion,
			keyVersion: replacement.binding.keyVersion,
			configurationRevision: plan.nextRevision,
		},
	});
	return "replaced";
}

export async function advanceAgentConfigurationRevision(
	transaction: Transaction,
	plan: AgentConfigurationWritePlanV1,
	configuration: AgentConfigurationRecord,
): Promise<boolean> {
	if (plan.nextRevision !== plan.baseRevision) {
		await transaction.insert(agentConfigurationRevisions).values({
			agentId: plan.agentId,
			revision: plan.nextRevision,
			sourceReference:
				configuration.source.kind === "standard"
					? configuration.source.templateId
					: configuration.source.imageDigest,
			configuration,
			createdAt: plan.auditEvent.occurredAt,
		});
	}
	const advanced = await transaction
		.update(agents)
		.set({
			currentConfigurationRevision: plan.nextRevision,
			authorizationRevision: plan.nextAuthorizationRevision,
		})
		.where(
			and(
				eq(agents.id, plan.agentId),
				eq(agents.currentConfigurationRevision, plan.baseRevision),
				eq(agents.authorizationRevision, plan.expectedAuthorizationRevision),
			),
		)
		.returning({ id: agents.id });
	return advanced.length === 1;
}

export async function replaceAgentAccess(
	transaction: Transaction,
	access: NonNullable<AgentConfigurationWritePlanV1["accessUpdate"]>,
	occurredAt: Date,
): Promise<void> {
	await transaction
		.delete(agentOwners)
		.where(eq(agentOwners.agentId, access.agentId));
	await transaction.insert(agentOwners).values(
		access.ownerIds.map((ownerId) => ({
			agentId: access.agentId,
			ownerId,
			createdAt: occurredAt,
		})),
	);
	await transaction
		.delete(agentAvailability)
		.where(eq(agentAvailability.agentId, access.agentId));
	if (access.availability.length > 0) {
		await transaction.insert(agentAvailability).values(
			access.availability.map((target) => ({
				agentId: access.agentId,
				targetType: target.kind,
				targetId:
					target.kind === "user" ? target.userId : target.organizationId,
			})),
		);
	}
}

export async function insertAgentConfigurationEffects(
	transaction: Transaction,
	plan: AgentConfigurationWritePlanV1,
): Promise<void> {
	if (plan.outboxIntent !== null) {
		await transaction.insert(outboxItems).values({
			id: randomUUID(),
			scopeType: "agent",
			scopeId: plan.agentId,
			operation: plan.outboxIntent.operation,
			payload: { ...plan.outboxIntent.payload },
			traceId: plan.outboxIntent.traceId,
			requestId: plan.outboxIntent.requestId,
			availableAt: plan.outboxIntent.occurredAt,
			createdAt: plan.outboxIntent.occurredAt,
			updatedAt: plan.outboxIntent.occurredAt,
		});
	}
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
}

export async function replaceSkillHubAgentBindings(
	transaction: Transaction,
	plan: AgentConfigurationWritePlanV1,
): Promise<void> {
	const skillBindings = plan.skillBindings;
	if (!skillBindings) return;
	if (skillBindings.bindings.length === 0) return;
	for (const binding of skillBindings.bindings) {
		const [version] = await transaction
			.select({
				state: skillHubVersions.state,
				parentStatus: skillHubSkills.status,
			})
			.from(skillHubVersions)
			.innerJoin(
				skillHubSkills,
				eq(skillHubSkills.id, skillHubVersions.skillId),
			)
			.where(eq(skillHubVersions.id, binding.skillVersionId))
			.for("update");
		if (version?.state !== "published" || version?.parentStatus !== "active")
			throw new Error("Skill version is no longer available");
		const [admission] = await transaction
			.select({ id: idempotencyRecords.id })
			.from(idempotencyRecords)
			.where(
				and(
					eq(idempotencyRecords.scopeType, "skill_package"),
					eq(idempotencyRecords.scopeId, binding.skillVersionId),
					eq(idempotencyRecords.status, "completed"),
				),
			)
			.limit(1);
		if (!admission) throw new Error("Skill package admission is unavailable");
		const [installation] = await transaction
			.select({ id: skillHubInstallations.id })
			.from(skillHubInstallations)
			.where(
				and(
					eq(skillHubInstallations.skillVersionId, binding.skillVersionId),
					eq(skillHubInstallations.principalType, binding.principalType),
					eq(skillHubInstallations.principalId, binding.principalId),
					eq(skillHubInstallations.state, "installed"),
				),
			)
			.for("share")
			.limit(1);
		if (!installation)
			throw new Error("Skill installation is no longer available");
	}
	await transaction.insert(skillHubAgentBindings).values(
		skillBindings.bindings.map((binding) => ({
			agentId: plan.agentId,
			agentVersion: skillBindings.agentVersion,
			configurationRevision: plan.nextRevision,
			skillVersionId: binding.skillVersionId,
			grant: binding.grant,
			syncRevision: 1,
			state: "pending_sync",
			failureReason: null,
			createdAt: plan.auditEvent.occurredAt,
			updatedAt: plan.auditEvent.occurredAt,
		})),
	);
}

export function agentManagementStateUpdate(plan: AgentManagementWritePlanV1) {
	return {
		status: plan.state.status,
		managementRevision: plan.state.revision,
		approvalRevision: plan.state.approvalRevision,
		decisionReason: plan.state.decisionReason,
		serviceAvailability: plan.state.serviceAvailability,
		desiredState: plan.state.desiredState,
		workloadRevision: plan.state.workloadRevision,
		fence: plan.state.fence,
		failureCode: plan.state.failureCode,
	};
}

export async function insertAgentManagementHistory(
	transaction: Transaction,
	plan: AgentManagementWritePlanV1,
): Promise<void> {
	await transaction.insert(agentManagementHistory).values({
		agentId: plan.state.agentId,
		revision: plan.state.revision,
		applicationId: plan.state.applicationId,
		subjectType: plan.subjectType,
		subjectId: plan.subjectId,
		operation: plan.operation,
		fromStatus: plan.transition.from,
		toStatus: plan.transition.to,
		occurredAt: plan.transition.occurredAt,
	});
}

export async function insertAgentManagementEffects(
	transaction: Transaction,
	plan: AgentManagementWritePlanV1,
): Promise<void> {
	if (plan.outboxIntent) {
		await persistSessionSandboxManagementIntents(transaction, plan);
		await transaction.insert(outboxItems).values({
			id: randomUUID(),
			scopeType: "agent",
			scopeId: plan.state.agentId,
			operation: plan.outboxIntent.operation,
			payload: { ...plan.outboxIntent.payload },
			traceId: plan.outboxIntent.traceId,
			requestId: plan.outboxIntent.requestId,
			availableAt: plan.outboxIntent.occurredAt,
			createdAt: plan.outboxIntent.occurredAt,
			updatedAt: plan.outboxIntent.occurredAt,
		});
	}
	await transaction.insert(auditEvents).values({
		id: randomUUID(),
		traceId: plan.auditEvent.traceId,
		requestId: plan.auditEvent.requestId,
		agentId: plan.state.agentId,
		actorType: plan.operation.startsWith("observe_")
			? "system"
			: (plan.auditEvent.actorType ?? "user"),
		actorId: plan.auditEvent.actorId,
		action: plan.auditEvent.action,
		targetType: plan.auditEvent.subjectType,
		targetId: plan.auditEvent.subjectId,
		outcome: "succeeded",
		occurredAt: plan.auditEvent.occurredAt,
	});
}
