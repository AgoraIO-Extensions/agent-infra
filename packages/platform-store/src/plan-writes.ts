import { randomUUID } from "node:crypto";

import type {
	AgentConfigurationRecordV1,
	AgentConfigurationWritePlanV1,
	AgentManagementWritePlanV1,
} from "@agent-infra/platform-core";
import { and, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";

import {
	agentAvailability,
	agentConfigurationRevisions,
	agentManagementHistory,
	agentOwners,
	agents,
	auditEvents,
	outboxItems,
} from "./schema.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];

export async function advanceAgentConfigurationRevision(
	transaction: Transaction,
	plan: AgentConfigurationWritePlanV1,
	configuration: AgentConfigurationRecordV1,
): Promise<boolean> {
	await transaction.insert(agentConfigurationRevisions).values({
		agentId: plan.agentId,
		revision: plan.nextRevision,
		sourceReference:
			configuration.source.kind === "standard"
				? configuration.source.templateId
				: configuration.source.imageDigest,
		configuration,
		createdAt: plan.outboxIntent.occurredAt,
	});
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
		actorType: plan.operation.startsWith("observe_") ? "system" : "user",
		actorId: plan.auditEvent.actorId,
		action: plan.auditEvent.action,
		targetType: plan.auditEvent.subjectType,
		targetId: plan.auditEvent.subjectId,
		outcome: "succeeded",
		occurredAt: plan.auditEvent.occurredAt,
	});
}
