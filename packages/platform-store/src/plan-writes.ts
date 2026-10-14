import { randomUUID } from "node:crypto";

import type {
	AgentConfigurationRecord,
	AgentConfigurationWritePlanV1,
	AgentManagementWritePlanV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import {
	agentAvailability,
	agentConfigurationRevisions,
	agentManagementHistory,
	agentOwners,
	agents,
	auditEvents,
	idempotencyRecords,
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
 * 配置版本只能沿 V2→V2、V3→V3 前进（#2401）：
 * - V3 基线绝不降级为需要模型凭证的 V2；
 * - V2 基线要变成 V3，必须由替换默认 Key 的计划完成，不能悄悄改写版本；
 * - 替换默认 Key 的计划需要持久化 Key 附件，当前提交边界尚未实现，一律拒绝，
 *   避免配置已前进而新 Key 被静默丢弃。
 */
export function configurationVersionTransitionAllowed(
	plan: Pick<AgentConfigurationWritePlanV1, "result">,
	configuration: Pick<AgentConfigurationRecord, "schemaVersion">,
	previous: Pick<AgentConfigurationRecord, "schemaVersion">,
): boolean {
	if (plan.result.changedFields.includes("defaultRelayKey")) return false;
	if (configuration.schemaVersion === 3) return previous.schemaVersion === 3;
	return configuration.schemaVersion === 2 && previous.schemaVersion === 2;
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
		await transaction.execute(sql`
			insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, trace_id, request_id,
				 available_at, created_at, updated_at)
			values (${randomUUID()}, 'agent', ${plan.agentId},
				${plan.outboxIntent.operation},
				${JSON.stringify({ ...plan.outboxIntent.payload })}::jsonb,
				${plan.outboxIntent.traceId}, ${plan.outboxIntent.requestId},
				${plan.outboxIntent.occurredAt.toISOString()},
				${plan.outboxIntent.occurredAt.toISOString()},
				${plan.outboxIntent.occurredAt.toISOString()})
		`);
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
		await transaction.execute(sql`
			insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, trace_id, request_id,
				 available_at, created_at, updated_at)
			values (${randomUUID()}, 'agent', ${plan.state.agentId},
				${plan.outboxIntent.operation},
				${JSON.stringify({ ...plan.outboxIntent.payload })}::jsonb,
				${plan.outboxIntent.traceId}, ${plan.outboxIntent.requestId},
				${plan.outboxIntent.occurredAt.toISOString()},
				${plan.outboxIntent.occurredAt.toISOString()},
				${plan.outboxIntent.occurredAt.toISOString()})
		`);
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
