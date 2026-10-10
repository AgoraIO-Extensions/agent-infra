import { types } from "node:util";
import type { AgentManagementStateV1 } from "./agent-management.js";
import {
	snapshotAgentManagementDenseArray as array,
	requireAgentManagementExactKeys as exact,
	parseAgentManagementPortState,
	parseAgentManagementStringArray,
	snapshotAgentManagementDataObject,
	isAgentManagementText as text,
} from "./agent-management-input.js";
import type { ConversationDispatchExecutionStatusV1 } from "./conversation-dispatch.js";

export type TaskPrincipalV1 = {
	readonly kind: "user" | "application";
	readonly id: string;
};

export type TaskApiChannelV1 = "api" | "api:user" | "api:application";

export function isTaskApiChannelV1(
	channelId: string,
	principal: TaskPrincipalV1,
): boolean {
	return channelId === "api" || channelId === `api:${principal.kind}`;
}

/** Current explicit API use grant; credential lifetime is not Task lifetime. */
export interface CurrentTaskApiUseGrantV1 {
	readonly principal: TaskPrincipalV1;
	readonly grantType: "use";
	readonly agentId: string;
	readonly authorizationRevision: string;
	readonly revoked: boolean;
}

export interface CurrentTaskApplicationV1 {
	readonly schemaVersion: 1;
	readonly applicationId: string;
	readonly status: "active" | "disabled";
	readonly authorizationRevision: string;
	readonly useGrant: CurrentTaskApiUseGrantV1 | null;
}

/**
 * Opaque directory snapshot fact carried by trusted identity adapters.
 * Consumers must compare it at their own sensitive-operation boundary.
 */
export interface DirectorySnapshotBindingV1 {
	readonly schemaVersion: 1;
	readonly source: string;
	readonly revision: string;
	readonly fetchedAt: number;
	readonly validUntil: number;
}

function object(input: unknown): Record<string, unknown> {
	if (
		input !== null &&
		typeof input === "object" &&
		!types.isProxy(input) &&
		Object.hasOwn(input, "__proto__")
	) {
		throw new TypeError("Task authority is invalid");
	}
	return snapshotAgentManagementDataObject(input);
}

export function parseDirectorySnapshotBindingV1(
	input: unknown,
	now = Date.now(),
): DirectorySnapshotBindingV1 {
	const parsed = object(input);
	exact(parsed, [
		"schemaVersion",
		"source",
		"revision",
		"fetchedAt",
		"validUntil",
	]);
	if (
		parsed.schemaVersion !== 1 ||
		!text(parsed.source) ||
		!text(parsed.revision) ||
		!Number.isSafeInteger(parsed.fetchedAt) ||
		(parsed.fetchedAt as number) < 0 ||
		!Number.isSafeInteger(parsed.validUntil) ||
		(parsed.validUntil as number) <= 0 ||
		(parsed.fetchedAt as number) > now ||
		(parsed.validUntil as number) <= now ||
		(parsed.validUntil as number) <= (parsed.fetchedAt as number)
	)
		throw new TypeError("Directory snapshot binding is invalid");
	return {
		schemaVersion: 1,
		source: parsed.source,
		revision: parsed.revision,
		fetchedAt: parsed.fetchedAt as number,
		validUntil: parsed.validUntil as number,
	};
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
	readonly directorySnapshotBinding?: DirectorySnapshotBindingV1;
}

/** Deployment-selected IdentityAdapter boundary for task-scoped user facts. */
export interface TaskUserDirectoryV1 {
	/** Untrusted adapter payload; the identity package parses it before use. */
	resolveUser(userId: string): Promise<unknown | null>;
}

type TaskAccessSourceV1 =
	| { readonly kind: "owner" | "user"; readonly userId: string }
	| { readonly kind: "organization"; readonly organizationId: string }
	| { readonly kind: "api-use"; readonly useGrantRevision: string };

export interface TaskAuthorizationBoundaryV1 {
	readonly schemaVersion: 1;
	readonly principal: TaskPrincipalV1;
	readonly agentId: string;
	readonly channelId: string;
	readonly identityRevision: string;
	readonly agentAuthorizationRevision: string;
	readonly accessSources: readonly TaskAccessSourceV1[];
	readonly directorySnapshotBinding?: DirectorySnapshotBindingV1;
}

function sameDirectorySnapshotBinding(
	a: DirectorySnapshotBindingV1 | undefined,
	b: DirectorySnapshotBindingV1 | undefined,
): boolean {
	if (!a || !b) return a === b;
	return (
		a.schemaVersion === b.schemaVersion &&
		a.source === b.source &&
		a.revision === b.revision &&
		a.fetchedAt === b.fetchedAt &&
		a.validUntil === b.validUntil
	);
}

export function parseCurrentTaskUserV1(input: unknown): CurrentTaskUserV1 {
	const value = object(input);
	const keys = [
		"schemaVersion",
		"userId",
		"accountStatus",
		"organizationIds",
		"authorizationRevision",
	];
	if (Object.hasOwn(value, "directorySnapshotBinding"))
		keys.push("directorySnapshotBinding");
	exact(value, keys);
	if (
		value.schemaVersion !== 1 ||
		!text(value.userId) ||
		(value.accountStatus !== "active" && value.accountStatus !== "disabled") ||
		!text(value.authorizationRevision)
	) {
		throw new TypeError("Current task identity is invalid");
	}
	const binding = value.directorySnapshotBinding;
	let directorySnapshotBinding: DirectorySnapshotBindingV1 | undefined;
	if (binding !== undefined) {
		directorySnapshotBinding = parseDirectorySnapshotBindingV1(binding);
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
		...(directorySnapshotBinding ? { directorySnapshotBinding } : {}),
	};
}

export function parseTaskPrincipalV1(input: unknown): TaskPrincipalV1 {
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

export function parseCurrentTaskApiUseGrantV1(
	input: unknown,
): CurrentTaskApiUseGrantV1 {
	const value = object(input);
	exact(value, [
		"principal",
		"grantType",
		"agentId",
		"authorizationRevision",
		"revoked",
	]);
	if (
		value.grantType !== "use" ||
		!text(value.agentId) ||
		!text(value.authorizationRevision) ||
		typeof value.revoked !== "boolean"
	) {
		throw new TypeError("Task API use grant is invalid");
	}
	return {
		principal: parseTaskPrincipalV1(value.principal),
		grantType: "use",
		agentId: value.agentId,
		authorizationRevision: value.authorizationRevision,
		revoked: value.revoked,
	};
}

export function parseCurrentTaskApplicationV1(
	input: unknown,
): CurrentTaskApplicationV1 {
	const value = object(input);
	exact(value, [
		"schemaVersion",
		"applicationId",
		"status",
		"authorizationRevision",
		"useGrant",
	]);
	if (
		value.schemaVersion !== 1 ||
		!text(value.applicationId) ||
		(value.status !== "active" && value.status !== "disabled") ||
		!text(value.authorizationRevision)
	) {
		throw new TypeError("Task application is invalid");
	}
	const useGrant =
		value.useGrant === null
			? null
			: parseCurrentTaskApiUseGrantV1(value.useGrant);
	if (
		useGrant &&
		(useGrant.principal.kind !== "application" ||
			useGrant.principal.id !== value.applicationId)
	) {
		throw new TypeError("Task application grant is invalid");
	}
	return {
		schemaVersion: 1,
		applicationId: value.applicationId,
		status: value.status,
		authorizationRevision: value.authorizationRevision,
		useGrant,
	};
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
	if (source.kind === "api-use")
		return JSON.stringify([source.kind, source.useGrantRevision]);
	return JSON.stringify([
		source.kind,
		source.kind === "organization" ? source.organizationId : source.userId,
	]);
}

export function parseTaskAuthorizationBoundaryV1(
	input: unknown,
): TaskAuthorizationBoundaryV1 {
	const value = object(input);
	const keys = [
		"schemaVersion",
		"principal",
		"agentId",
		"channelId",
		"identityRevision",
		"agentAuthorizationRevision",
		"accessSources",
	];
	if (Object.hasOwn(value, "directorySnapshotBinding"))
		keys.push("directorySnapshotBinding");
	exact(value, keys);
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
	const subject = parseTaskPrincipalV1(value.principal);
	if (
		(value.channelId === "api:user" || value.channelId === "api:application") &&
		!isTaskApiChannelV1(value.channelId, subject)
	)
		throw new TypeError("Task API channel is invalid");
	const sources = array(value.accessSources).map(
		(input): TaskAccessSourceV1 => {
			const source = object(input);
			if (source.kind === "api-use") {
				exact(source, ["kind", "useGrantRevision"]);
				if (
					!isTaskApiChannelV1(value.channelId as string, subject) ||
					!text(source.useGrantRevision)
				) {
					throw new TypeError("Task API access source is invalid");
				}
				return { kind: "api-use", useGrantRevision: source.useGrantRevision };
			}
			if (subject.kind !== "user")
				throw new TypeError("Task access source is invalid");
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
		(sources.some((source) => source.kind === "api-use") &&
			sources.length !== 1) ||
		(subject.kind === "application" &&
			!isTaskApiChannelV1(value.channelId as string, subject)) ||
		new Set(sources.map(sourceKey)).size !== sources.length
	) {
		throw new TypeError("Task access sources are invalid");
	}
	const directorySnapshotBinding = Object.hasOwn(
		value,
		"directorySnapshotBinding",
	)
		? parseDirectorySnapshotBindingV1(value.directorySnapshotBinding)
		: undefined;
	return {
		schemaVersion: 1,
		principal: subject,
		agentId: value.agentId as string,
		channelId: value.channelId as string,
		identityRevision: value.identityRevision as string,
		agentAuthorizationRevision: value.agentAuthorizationRevision as string,
		accessSources: sources,
		...(directorySnapshotBinding ? { directorySnapshotBinding } : {}),
	};
}

export function captureTaskAuthorizationBoundaryV1(input: {
	readonly principal: TaskPrincipalV1;
	readonly user: CurrentTaskUserV1;
	readonly agent: AgentManagementStateV1;
	readonly channelId: string;
	readonly agentAuthorizationRevision: string;
}): TaskAuthorizationBoundaryV1 | null {
	const subject = parseTaskPrincipalV1(input.principal);
	if (subject.kind !== "user" || isTaskApiChannelV1(input.channelId, subject))
		return null;
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
		...(user.directorySnapshotBinding
			? { directorySnapshotBinding: user.directorySnapshotBinding }
			: {}),
	});
}

function apiUseCurrent(
	boundary: TaskAuthorizationBoundaryV1,
	input: CurrentTaskApiUseGrantV1 | null,
): boolean {
	if (!input) return false;
	const grant = parseCurrentTaskApiUseGrantV1(input);
	return (
		!grant.revoked &&
		grant.agentId === boundary.agentId &&
		grant.principal.kind === boundary.principal.kind &&
		grant.principal.id === boundary.principal.id &&
		boundary.accessSources.length === 1 &&
		boundary.accessSources[0]?.kind === "api-use" &&
		boundary.accessSources[0].useGrantRevision === grant.authorizationRevision
	);
}

export function captureTaskApplicationAuthorizationBoundaryV1(input: {
	readonly principal: TaskPrincipalV1;
	readonly application: CurrentTaskApplicationV1;
	readonly agent: AgentManagementStateV1;
	readonly channelId: string;
	readonly agentAuthorizationRevision: string;
}): TaskAuthorizationBoundaryV1 | null {
	const subject = parseTaskPrincipalV1(input.principal);
	const application = parseCurrentTaskApplicationV1(input.application);
	const agent = parseAgentManagementPortState(input.agent);
	const grant = application.useGrant;
	if (
		subject.kind !== "application" ||
		subject.id !== application.applicationId ||
		!isTaskApiChannelV1(input.channelId, subject) ||
		application.status !== "active" ||
		!grant ||
		grant.revoked ||
		grant.agentId !== agent.agentId
	)
		return null;
	return parseTaskAuthorizationBoundaryV1({
		schemaVersion: 1,
		principal: subject,
		agentId: agent.agentId,
		channelId: input.channelId,
		identityRevision: application.authorizationRevision,
		agentAuthorizationRevision: input.agentAuthorizationRevision,
		accessSources: [
			{ kind: "api-use", useGrantRevision: grant.authorizationRevision },
		],
	});
}

/** A personal API task uses the original explicit use grant, never Web Owner scope. */
export function capturePersonalApiTaskAuthorizationBoundaryV1(input: {
	readonly user: CurrentTaskUserV1;
	readonly channelId?: TaskApiChannelV1;
	readonly useGrant: CurrentTaskApiUseGrantV1 | null;
	readonly agent: AgentManagementStateV1;
	readonly agentAuthorizationRevision: string;
}): TaskAuthorizationBoundaryV1 | null {
	const user = parseCurrentTaskUserV1(input.user);
	const agent = parseAgentManagementPortState(input.agent);
	const grant =
		input.useGrant === null
			? null
			: parseCurrentTaskApiUseGrantV1(input.useGrant);
	if (
		user.accountStatus !== "active" ||
		!grant ||
		grant.revoked ||
		grant.agentId !== agent.agentId ||
		grant.principal.kind !== "user" ||
		grant.principal.id !== user.userId ||
		!isTaskApiChannelV1(input.channelId ?? "api", grant.principal)
	)
		return null;
	return parseTaskAuthorizationBoundaryV1({
		schemaVersion: 1,
		principal: grant.principal,
		agentId: agent.agentId,
		channelId: input.channelId ?? "api",
		identityRevision: user.authorizationRevision,
		agentAuthorizationRevision: input.agentAuthorizationRevision,
		accessSources: [
			{ kind: "api-use", useGrantRevision: grant.authorizationRevision },
		],
		...(user.directorySnapshotBinding
			? { directorySnapshotBinding: user.directorySnapshotBinding }
			: {}),
	});
}

export function isTaskApplicationAuthorizationCurrentV1(input: {
	readonly boundary: TaskAuthorizationBoundaryV1;
	readonly application: CurrentTaskApplicationV1;
	readonly agent: AgentManagementStateV1;
}): boolean {
	const boundary = parseTaskAuthorizationBoundaryV1(input.boundary);
	const application = parseCurrentTaskApplicationV1(input.application);
	const agent = parseAgentManagementPortState(input.agent);
	return (
		boundary.principal.kind === "application" &&
		isTaskApiChannelV1(boundary.channelId, boundary.principal) &&
		boundary.principal.id === application.applicationId &&
		boundary.agentId === agent.agentId &&
		application.status === "active" &&
		boundary.identityRevision === application.authorizationRevision &&
		apiUseCurrent(boundary, application.useGrant)
	);
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
	readonly useGrant?: CurrentTaskApiUseGrantV1 | null;
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
	if (
		!sameDirectorySnapshotBinding(
			boundary.directorySnapshotBinding,
			user.directorySnapshotBinding,
		)
	)
		return false;
	if (isTaskApiChannelV1(boundary.channelId, boundary.principal))
		return (
			user.accountStatus === "active" &&
			apiUseCurrent(boundary, input.useGrant ?? null)
		);
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
		/** Required for application executions; old user records may omit it. */
		readonly principal?: TaskPrincipalV1;
		readonly agentId: string;
		readonly channelId: string;
		readonly authorizationRevision: string;
		readonly status: ConversationDispatchExecutionStatusV1 | "waiting";
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
		(boundary.principal.kind === "application" &&
			input.execution.principal === undefined) ||
		(input.execution.principal !== undefined &&
			(parseTaskPrincipalV1(input.execution.principal).kind !==
				boundary.principal.kind ||
				input.execution.principal.id !== boundary.principal.id)) ||
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
