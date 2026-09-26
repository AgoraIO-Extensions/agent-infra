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
	readonly kind: "user" | "application";
	readonly id: string;
}

/** Server-owned API channels also isolate equal user/application IDs in legacy actor columns. */
export function taskApiChannelIdV1(
	input: TaskPrincipalV1,
): "api:user" | "api:application" {
	const subject = principal(input);
	return subject.kind === "user" ? "api:user" : "api:application";
}

/** Existing user channels remain valid; application and reserved API channels bind subject type. */
export function isTaskPrincipalChannelV1(
	subject: TaskPrincipalV1,
	channelId: string,
): boolean {
	return (
		(subject.kind === "user" && !channelId.startsWith("api:")) ||
		channelId === taskApiChannelIdV1(subject)
	);
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

/** Current facts for an independently authenticated application principal. */
export interface CurrentTaskApplicationV1 {
	readonly schemaVersion: 1;
	readonly applicationId: string;
	readonly accountStatus: "active" | "disabled";
	readonly authorizationRevision: string;
}

/** Deployment-selected IdentityAdapter boundary for task-scoped user facts. */
export interface TaskUserDirectoryV1 {
	/** Untrusted adapter payload; the identity package parses it before use. */
	resolveUser(userId: string): Promise<unknown | null>;
}

type TaskAccessSourceV1 =
	| { readonly kind: "owner" | "user"; readonly userId: string }
	| { readonly kind: "organization"; readonly organizationId: string }
	| { readonly kind: "application"; readonly applicationId: string };

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

export function parseCurrentTaskApplicationV1(
	input: unknown,
): CurrentTaskApplicationV1 {
	const value = object(input);
	exact(value, [
		"schemaVersion",
		"applicationId",
		"accountStatus",
		"authorizationRevision",
	]);
	if (
		value.schemaVersion !== 1 ||
		!text(value.applicationId) ||
		(value.accountStatus !== "active" && value.accountStatus !== "disabled") ||
		!text(value.authorizationRevision)
	) {
		throw new TypeError("Current application identity is invalid");
	}
	return {
		schemaVersion: 1,
		applicationId: value.applicationId,
		accountStatus: value.accountStatus,
		authorizationRevision: value.authorizationRevision,
	};
}

function principal(input: unknown): TaskPrincipalV1 {
	const value = object(input);
	exact(value, ["kind", "id"]);
	if (
		(value.kind !== "user" && value.kind !== "application") ||
		!text(value.id)
	) {
		throw new TypeError("Task principal is invalid");
	}
	return { kind: value.kind, id: value.id };
}

function accessSources(
	principalValue: TaskPrincipalV1,
	user: CurrentTaskUserV1 | undefined,
	agent: AgentManagementStateV1,
	channelId: string,
): readonly TaskAccessSourceV1[] {
	if (!isTaskPrincipalChannelV1(principalValue, channelId)) return [];
	if (principalValue.kind === "user" && user?.accountStatus !== "active")
		return [];
	if (principalValue.kind === "application" || channelId === "api:user") {
		const granted = agent.principalGrants?.some(
			(grant) =>
				grant.principal.kind === principalValue.kind &&
				grant.principal.id === principalValue.id &&
				grant.grantType === "use" &&
				grant.revokedAt === null,
		);
		if (!granted) return [];
		return principalValue.kind === "application"
			? [{ kind: "application", applicationId: principalValue.id }]
			: [{ kind: "user", userId: principalValue.id }];
	}
	if (!user) return [];
	const sources: TaskAccessSourceV1[] = [];
	if (agent.ownerIds.includes(user.userId)) {
		sources.push({ kind: "owner", userId: user.userId });
	}
	for (const target of agent.availability) {
		if (
			target.kind === "user"
				? target.userId === user.userId
				: target.kind === "organization" &&
					user.organizationIds.includes(target.organizationId)
		) {
			sources.push({ ...target });
		}
	}
	return sources;
}

function sourceKey(source: TaskAccessSourceV1): string {
	if (source.kind === "organization") {
		return JSON.stringify([source.kind, source.organizationId]);
	}
	if (source.kind === "application") {
		return JSON.stringify([source.kind, source.applicationId]);
	}
	return JSON.stringify([source.kind, source.userId]);
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
				if (subject.kind !== "user" || !text(source.organizationId))
					throw new TypeError("Task access source is invalid");
				return { kind: "organization", organizationId: source.organizationId };
			}
			if (source.kind === "application") {
				exact(source, ["kind", "applicationId"]);
				if (
					!text(source.applicationId) ||
					subject.kind !== "application" ||
					source.applicationId !== subject.id
				) {
					throw new TypeError("Task access source is invalid");
				}
				return { kind: "application", applicationId: source.applicationId };
			}
			exact(source, ["kind", "userId"]);
			if (
				subject.kind !== "user" ||
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
	if (subject.kind !== "user" || subject.id !== user.userId) return null;
	const sources = accessSources(subject, user, agent, input.channelId);
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

/** Capture the same durable boundary for an independently authorized application. */
export function captureApplicationTaskAuthorizationBoundaryV1(input: {
	readonly application: CurrentTaskApplicationV1;
	readonly agent: AgentManagementStateV1;
	readonly channelId: string;
	readonly agentAuthorizationRevision: string;
}): TaskAuthorizationBoundaryV1 | null {
	const application = parseCurrentTaskApplicationV1(input.application);
	const agent = parseAgentManagementPortState(input.agent);
	if (application.accountStatus !== "active") return null;
	const subject: TaskPrincipalV1 = {
		kind: "application",
		id: application.applicationId,
	};
	const sources = accessSources(subject, undefined, agent, input.channelId);
	if (sources.length === 0) return null;
	return parseTaskAuthorizationBoundaryV1({
		schemaVersion: 1,
		principal: subject,
		agentId: agent.agentId,
		channelId: input.channelId,
		identityRevision: application.authorizationRevision,
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
	readonly user?: CurrentTaskUserV1;
	readonly application?: CurrentTaskApplicationV1;
	readonly agent: AgentManagementStateV1;
}): boolean {
	const boundary = parseTaskAuthorizationBoundaryV1(input.boundary);
	const agent = parseAgentManagementPortState(input.agent);
	if (boundary.agentId !== agent.agentId) return false;
	let user: CurrentTaskUserV1 | undefined;
	if (boundary.principal.kind === "user") {
		if (!input.user) return false;
		user = parseCurrentTaskUserV1(input.user);
		if (boundary.principal.id !== user.userId) return false;
	} else {
		if (!input.application) return false;
		const application = parseCurrentTaskApplicationV1(input.application);
		if (
			boundary.principal.id !== application.applicationId ||
			application.accountStatus !== "active"
		)
			return false;
	}
	const current = new Set(
		accessSources(boundary.principal, user, agent, boundary.channelId).map(
			sourceKey,
		),
	);
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
		input.execution.sessionGeneration < 1 ||
		![
			"waiting",
			"submitted",
			"processing",
			"unknown",
			"completed",
			"failed",
			"cancelled",
		].includes(input.execution.status) ||
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
			["stop", "authorization_revoked"].includes(input.reason) &&
			["submitted", "processing", "unknown"].includes(input.execution.status),
		revokeAuthorization: input.reason === "authorization_revoked",
		audit: {
			action: "task.control.created" as const,
			originalPrincipal: boundary.principal,
			reason: input.reason,
		},
	};
}
