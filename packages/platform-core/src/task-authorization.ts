import type { AgentManagementStateV1 } from "./agent-management.js";
import {
	snapshotAgentManagementDenseArray as array,
	requireAgentManagementExactKeys as exact,
	snapshotAgentManagementDataObject as object,
	parseAgentManagementPortState,
	parseAgentManagementStringArray,
	isAgentManagementText as text,
} from "./agent-management-input.js";
import type { ConversationDispatchExecutionStatusV1 } from "./conversation-dispatch.js";

export interface TaskPrincipalV1 {
	/** Application principals are supplied by the #481 application-grant slice. */
	readonly kind: "user";
	readonly id: string;
}

/**
 * Task-scoped directory facts resolved by a deployment IdentityAdapter.
 * This is not the canonical platform IdentityContext; application grants and
 * platform-role facts are supplied by their owning slices.
 */
export interface CurrentTaskUserV1 {
	readonly schemaVersion: 1;
	readonly userId: string;
	readonly accountStatus: "active" | "disabled";
	readonly organizationIds: readonly string[];
	readonly authorizationRevision: string;
}

type TaskAccessSourceV1 =
	| { readonly kind: "owner" | "user"; readonly userId: string }
	| { readonly kind: "organization"; readonly organizationId: string };

export interface TaskAuthorizationBoundaryV1 {
	readonly schemaVersion: 1;
	readonly principal: TaskPrincipalV1;
	readonly agentId: string;
	readonly channelId: string;
	readonly identityRevision: string;
	readonly agentAuthorizationRevision: string;
	readonly accessSources: readonly TaskAccessSourceV1[];
}

export function parseCurrentTaskUserV1(input: unknown): CurrentTaskUserV1 {
	const value = object(input);
	exact(value, [
		"schemaVersion",
		"userId",
		"accountStatus",
		"organizationIds",
		"authorizationRevision",
	]);
	if (
		value.schemaVersion !== 1 ||
		!text(value.userId) ||
		(value.accountStatus !== "active" && value.accountStatus !== "disabled") ||
		!text(value.authorizationRevision)
	) {
		throw new TypeError("Current task identity is invalid");
	}
	return {
		schemaVersion: 1,
		userId: value.userId,
		accountStatus: value.accountStatus,
		organizationIds: parseAgentManagementStringArray(
			value.organizationIds,
			true,
		),
		authorizationRevision: value.authorizationRevision,
	};
}

function principal(input: unknown): TaskPrincipalV1 {
	const value = object(input);
	exact(value, ["kind", "id"]);
	if (
		value.kind !== "user" ||
		!text(value.id)
	) {
		throw new TypeError("Task principal is invalid");
	}
	return { kind: value.kind, id: value.id };
}

function accessSources(
	user: CurrentTaskUserV1,
	agent: AgentManagementStateV1,
): readonly TaskAccessSourceV1[] {
	if (user.accountStatus !== "active") return [];
	const sources: TaskAccessSourceV1[] = [];
	if (agent.ownerIds.includes(user.userId)) {
		sources.push({ kind: "owner", userId: user.userId });
	}
	for (const target of agent.availability) {
		if (
			target.kind === "user"
				? target.userId === user.userId
				: user.organizationIds.includes(target.organizationId)
		) {
			sources.push({ ...target });
		}
	}
	return sources;
}

function sourceKey(source: TaskAccessSourceV1): string {
	return JSON.stringify([
		source.kind,
		source.kind === "organization" ? source.organizationId : source.userId,
	]);
}

export function parseTaskAuthorizationBoundaryV1(
	input: unknown,
): TaskAuthorizationBoundaryV1 {
	const value = object(input);
	exact(value, [
		"schemaVersion",
		"principal",
		"agentId",
		"channelId",
		"identityRevision",
		"agentAuthorizationRevision",
		"accessSources",
	]);
	if (
		value.schemaVersion !== 1 ||
		![
			value.agentId,
			value.channelId,
			value.identityRevision,
			value.agentAuthorizationRevision,
		].every((value) => text(value))
	) {
		throw new TypeError("Task authorization boundary is invalid");
	}
	const subject = principal(value.principal);
	const sources = array(value.accessSources).map(
		(input): TaskAccessSourceV1 => {
			const source = object(input);
			if (source.kind === "organization") {
				exact(source, ["kind", "organizationId"]);
				if (!text(source.organizationId))
					throw new TypeError("Task access source is invalid");
				return { kind: "organization", organizationId: source.organizationId };
			}
			exact(source, ["kind", "userId"]);
			if (
				(source.kind !== "owner" && source.kind !== "user") ||
				!text(source.userId) ||
				source.userId !== subject.id
			) {
				throw new TypeError("Task access source is invalid");
			}
			return { kind: source.kind, userId: source.userId };
		},
	);
	if (
		sources.length === 0 ||
		new Set(sources.map(sourceKey)).size !== sources.length
	) {
		throw new TypeError("Task access sources are invalid");
	}
	return {
		schemaVersion: 1,
		principal: subject,
		agentId: value.agentId as string,
		channelId: value.channelId as string,
		identityRevision: value.identityRevision as string,
		agentAuthorizationRevision: value.agentAuthorizationRevision as string,
		accessSources: sources,
	};
}

export function captureTaskAuthorizationBoundaryV1(input: {
	readonly principal: TaskPrincipalV1;
	readonly user: CurrentTaskUserV1;
	readonly agent: AgentManagementStateV1;
	readonly channelId: string;
	readonly agentAuthorizationRevision: string;
}): TaskAuthorizationBoundaryV1 | null {
	const subject = principal(input.principal);
	const user = parseCurrentTaskUserV1(input.user);
	const agent = parseAgentManagementPortState(input.agent);
	if (subject.id !== user.userId) return null;
	const sources = accessSources(user, agent);
	if (sources.length === 0) return null;
	return parseTaskAuthorizationBoundaryV1({
		schemaVersion: 1,
		principal: subject,
		agentId: agent.agentId,
		channelId: input.channelId,
		identityRevision: user.authorizationRevision,
		agentAuthorizationRevision: input.agentAuthorizationRevision,
		accessSources: sources,
	});
}

/**
 * New access sources cannot expand a stored task boundary.
 *
 * This is only the scope-intersection check. The Store must also reject a
 * persisted revokedAt/control receipt before calling it; restoration of a
 * matching organization grant is not proof that a revoked task is current.
 */
export function isTaskAuthorizationCurrentV1(input: {
	readonly boundary: TaskAuthorizationBoundaryV1;
	readonly user: CurrentTaskUserV1;
	readonly agent: AgentManagementStateV1;
}): boolean {
	const boundary = parseTaskAuthorizationBoundaryV1(input.boundary);
	const user = parseCurrentTaskUserV1(input.user);
	const agent = parseAgentManagementPortState(input.agent);
	if (
		boundary.principal.kind !== "user" ||
		boundary.principal.id !== user.userId ||
		boundary.agentId !== agent.agentId
	)
		return false;
	const current = new Set(accessSources(user, agent).map(sourceKey));
	return boundary.accessSources.some((source) =>
		current.has(sourceKey(source)),
	);
}

export type TaskSystemControlReasonV1 =
	| "stop"
	| "authorization_revoked"
	| "recovery"
	| "generation_isolation";

export interface TaskSystemControlBindingV1 {
	readonly executionId: string;
	readonly conversationId: string;
	readonly sessionGeneration: number;
}

/** Decided from the Store's locked current rows; all resulting writes share its transaction. */
export function planTaskSystemControlV1(input: {
	readonly reason: TaskSystemControlReasonV1;
	readonly workerId: string;
	readonly boundary: TaskAuthorizationBoundaryV1;
	readonly execution: {
		readonly executionId: string;
		readonly conversationId: string;
		readonly sessionGeneration: number;
		readonly actorId: string;
		readonly agentId: string;
		readonly channelId: string;
		readonly authorizationRevision: string;
		readonly status: ConversationDispatchExecutionStatusV1;
	};
}) {
	const boundary = parseTaskAuthorizationBoundaryV1(input.boundary);
	if (
		![
			"stop",
			"authorization_revoked",
			"recovery",
			"generation_isolation",
		].includes(input.reason) ||
		!text(input.workerId) ||
		!text(input.execution.executionId) ||
		!text(input.execution.conversationId) ||
		!Number.isSafeInteger(input.execution.sessionGeneration) ||
		input.execution.sessionGeneration < 0 ||
		boundary.principal.kind !== "user" ||
		boundary.principal.id !== input.execution.actorId ||
		boundary.agentId !== input.execution.agentId ||
		boundary.channelId !== input.execution.channelId ||
		boundary.agentAuthorizationRevision !==
			input.execution.authorizationRevision
	)
		throw new TypeError("Task system control is invalid");
	return {
		schemaVersion: 1 as const,
		workerId: input.workerId,
		binding: {
			executionId: input.execution.executionId,
			conversationId: input.execution.conversationId,
			sessionGeneration: input.execution.sessionGeneration,
		},
		ensureStop:
			input.reason === "authorization_revoked" &&
			["submitted", "processing", "unknown"].includes(input.execution.status),
		revokeAuthorization: input.reason === "authorization_revoked",
		audit: {
			action: "task.control.created" as const,
			originalPrincipal: boundary.principal,
			reason: input.reason,
		},
	};
}
