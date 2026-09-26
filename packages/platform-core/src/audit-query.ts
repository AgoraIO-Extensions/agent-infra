import {
	isAgentManagementText,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
	snapshotAgentManagementDenseArray,
} from "./agent-management-input.js";
import {
	type ApiCredentialMetadataV1,
	type ApiPrincipalV1,
	hasApiCredentialScopeV1,
	isApiCredentialScopeV1,
	sameApiPrincipalV1,
} from "./api-identity.js";
import {
	type ConversationOperationFactV2,
	parseConversationOperationEventV2,
} from "./conversation-operation-facts.js";
import {
	type CurrentTaskUserV1,
	parseCurrentTaskUserV1,
	parseTaskAuthorizationBoundaryV1,
} from "./task-authorization.js";

export type PlatformAuditQueryScopeV1 =
	| {
			readonly kind: "administrator";
			readonly administratorId: string;
	  }
	| {
			readonly kind: "execution";
			readonly principal: ApiPrincipalV1;
			readonly user?: CurrentTaskUserV1;
			readonly credential?: ApiCredentialMetadataV1;
	  };

export const platformAuditQueryResultsV1 = [
	"succeeded",
	"rejected",
	"failed",
	"accepted",
	"intent",
	"started",
	"submitted",
	"waiting",
	"processing",
	"completed",
	"cancelled",
	"unknown",
] as const;

export const platformAuditQueryActionsV1 = [
	"agent.application.submitted",
	"agent.application.updated",
	"agent.application.resubmitted",
	"agent.application.withdrawn",
	"agent.application.approved",
	"agent.application.rejected",
	"agent.lifecycle.stopped",
	"agent.lifecycle.restarted",
	"agent.lifecycle.creation_retried",
	"agent.lifecycle.disabled",
	"agent.workload.creation_succeeded",
	"agent.workload.creation_failed",
	"agent.workload.service_starting",
	"agent.workload.service_ready",
	"agent.workload.service_updating",
	"agent.workload.service_unavailable",
	"agent.configuration.revised",
	"agent.access.updated",
	"api.access.rejected",
	"api.application.created",
	"api.credential.issued",
	"api.credential.revoked",
	"api.credential.delivery.granted",
	"api.credential.delivery.revoked",
	"api.agent.grant.granted",
	"api.agent.grant.revoked",
	"task.api.access",
	"task.api.submit.result",
	"task.api.subscription.started",
	"task.api.subscription.ended",
	"task.authorization.accepted",
	"task.status.changed",
	"task.control.created",
	"execution.operation.observed",
	"conversation.task.accepted",
	"conversation.message.accepted",
	"conversation.regeneration.accepted",
	"conversation.stop.accepted",
	"conversation.model_selection.updated",
	"conversation.model_selection.fell_back",
	"conversation.task.status",
	"secret.decrypt",
	"secret.activate",
	"secret.rewrap",
	"secret.retire-key",
	"audit.query.completed",
	"audit.query.failed",
] as const;

export type PlatformAuditQueryActionV1 =
	(typeof platformAuditQueryActionsV1)[number];

export type PlatformAuditQueryResultV1 =
	(typeof platformAuditQueryResultsV1)[number];

export const platformAuditQueryDenialReasonsV1 = [
	"AUTHENTICATION_REQUIRED",
	"AUTHORIZATION_REVOKED",
	"RESOURCE_UNAVAILABLE",
	"DEPENDENCY_UNAVAILABLE",
	"INVALID_REQUEST",
	"invalid_request",
	"access_denied",
	"unavailable",
] as const;

export type PlatformAuditQueryDenialReasonV1 =
	(typeof platformAuditQueryDenialReasonsV1)[number];

function queryReason(input: unknown): PlatformAuditQueryDenialReasonV1 {
	if (!platformAuditQueryDenialReasonsV1.some((reason) => reason === input))
		throw new TypeError("Invalid audit query reason");
	return input as PlatformAuditQueryDenialReasonV1;
}

export interface PlatformAuditQueryFiltersV1 {
	readonly from?: string;
	readonly until?: string;
	readonly principal?: ApiPrincipalV1;
	readonly agentId?: string;
	readonly action?: PlatformAuditQueryActionV1;
	readonly result?: PlatformAuditQueryResultV1;
	readonly executionId?: string;
}

export interface PlatformAuditQueryInputV1 {
	readonly limit: number;
	readonly cursor?: string;
	readonly filters: PlatformAuditQueryFiltersV1;
}

export class PlatformAuditScopeErrorV1 extends Error {
	readonly code: "invalid_request" | "access_denied" | "unavailable";

	constructor(code: PlatformAuditScopeErrorV1["code"]) {
		super("Platform audit query is unavailable");
		this.name = "PlatformAuditScopeErrorV1";
		this.code = code;
	}
}

function exact(
	input: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
) {
	const value = snapshotAgentManagementDataObject(input);
	requireAgentManagementExactKeys(value, [
		...required,
		...optional.filter((key) => Object.hasOwn(value, key)),
	]);
	return value;
}

function text(input: unknown): string {
	if (!isAgentManagementText(input)) throw new TypeError("Invalid audit value");
	return input;
}

function principal(input: unknown): ApiPrincipalV1 {
	const value = exact(input, ["kind", "id"]);
	if (value.kind !== "user" && value.kind !== "application")
		throw new TypeError("Invalid audit principal");
	return { kind: value.kind, id: text(value.id) };
}

function timestamp(input: unknown): string {
	const value = text(input);
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
			value,
		)
	)
		throw new TypeError("Invalid audit time");
	const date = new Date(value);
	const localDate = new Date(`${value.slice(0, 19)}Z`);
	if (
		!Number.isFinite(date.getTime()) ||
		!Number.isFinite(localDate.getTime()) ||
		localDate.toISOString().slice(0, 19) !== value.slice(0, 19)
	)
		throw new TypeError("Invalid audit time");
	return date.toISOString();
}

function credentialMetadata(input: unknown): ApiCredentialMetadataV1 {
	const value = exact(input, [
		"schemaVersion",
		"credentialId",
		"principal",
		"scopes",
		"expiresAt",
		"revokedAt",
		"createdAt",
	]);
	const date = (value: unknown): Date => {
		if (
			!(value instanceof Date) ||
			!Number.isFinite(Date.prototype.getTime.call(value))
		)
			throw new TypeError("Invalid audit credential date");
		return new Date(Date.prototype.getTime.call(value));
	};
	const scopes = snapshotAgentManagementDenseArray(value.scopes);
	if (
		value.schemaVersion !== 1 ||
		scopes.some((scope) => !isApiCredentialScopeV1(scope)) ||
		new Set(scopes).size !== scopes.length
	)
		throw new TypeError("Invalid audit credential");
	return {
		schemaVersion: 1,
		credentialId: text(value.credentialId),
		principal: principal(value.principal),
		scopes: scopes as ApiCredentialMetadataV1["scopes"],
		expiresAt: value.expiresAt === null ? null : date(value.expiresAt),
		revokedAt: value.revokedAt === null ? null : date(value.revokedAt),
		createdAt: date(value.createdAt),
	};
}

export function parsePlatformAuditQueryScopeV1(
	input: unknown,
	now = new Date(),
): PlatformAuditQueryScopeV1 {
	try {
		const shape = snapshotAgentManagementDataObject(input);
		if (shape.kind === "administrator") {
			const value = exact(input, ["kind", "administratorId"]);
			return {
				kind: "administrator",
				administratorId: text(value.administratorId),
			};
		}
		const value = exact(input, ["kind", "principal"], ["user", "credential"]);
		if (value.kind !== "execution") throw new TypeError("Invalid audit scope");
		const subject = principal(value.principal);
		const user = Object.hasOwn(value, "user")
			? parseCurrentTaskUserV1(value.user)
			: undefined;
		if (
			(subject.kind === "user" &&
				(!user ||
					user.userId !== subject.id ||
					user.accountStatus !== "active")) ||
			(subject.kind === "application" && user !== undefined)
		)
			throw new TypeError("Invalid audit identity");
		const credential = Object.hasOwn(value, "credential")
			? credentialMetadata(value.credential)
			: undefined;
		if (
			(subject.kind === "application" && !credential) ||
			(credential &&
				(!sameApiPrincipalV1(credential.principal, subject) ||
					!hasApiCredentialScopeV1(credential, "agent:use", now)))
		)
			throw new TypeError("Invalid audit credential");
		return {
			kind: "execution",
			principal: subject,
			...(user ? { user } : {}),
			...(credential ? { credential } : {}),
		};
	} catch {
		throw new PlatformAuditScopeErrorV1("access_denied");
	}
}

export function parsePlatformAuditQueryInputV1(
	input: unknown,
	scope: PlatformAuditQueryScopeV1,
): PlatformAuditQueryInputV1 {
	try {
		const value = exact(input, ["limit", "filters"], ["cursor"]);
		if (
			!Number.isInteger(value.limit) ||
			(value.limit as number) < 1 ||
			(value.limit as number) > 100
		)
			throw new TypeError("Invalid audit page");
		const raw = exact(
			value.filters,
			[],
			[
				"from",
				"until",
				"principal",
				"agentId",
				"action",
				"result",
				"executionId",
			],
		);
		const filters: PlatformAuditQueryFiltersV1 = {
			...(Object.hasOwn(raw, "from") ? { from: timestamp(raw.from) } : {}),
			...(Object.hasOwn(raw, "until") ? { until: timestamp(raw.until) } : {}),
			...(Object.hasOwn(raw, "principal")
				? { principal: principal(raw.principal) }
				: {}),
			...(Object.hasOwn(raw, "agentId") ? { agentId: text(raw.agentId) } : {}),
			...(Object.hasOwn(raw, "action")
				? { action: text(raw.action) as PlatformAuditQueryActionV1 }
				: {}),
			...(Object.hasOwn(raw, "executionId")
				? { executionId: text(raw.executionId) }
				: {}),
			...(Object.hasOwn(raw, "result")
				? { result: raw.result as PlatformAuditQueryResultV1 }
				: {}),
		};
		if (
			(filters.from && filters.until && filters.from >= filters.until) ||
			(filters.action !== undefined &&
				!platformAuditQueryActionsV1.includes(filters.action)) ||
			(filters.result !== undefined &&
				!platformAuditQueryResultsV1.includes(filters.result))
		)
			throw new TypeError("Invalid audit filters");
		if (
			scope.kind === "execution" &&
			filters.principal &&
			!sameApiPrincipalV1(scope.principal, filters.principal)
		)
			throw new PlatformAuditScopeErrorV1("access_denied");
		return {
			limit: value.limit as number,
			filters,
			...(Object.hasOwn(value, "cursor") ? { cursor: text(value.cursor) } : {}),
		};
	} catch (error) {
		if (error instanceof PlatformAuditScopeErrorV1) throw error;
		throw new PlatformAuditScopeErrorV1("invalid_request");
	}
}

export function projectPlatformAuditQueryRecordV1(input: {
	scope: PlatformAuditQueryScopeV1;
	query: PlatformAuditQueryInputV1;
	operation: "list" | "detail";
	result: "succeeded" | "rejected" | "failed";
	count: number;
	reason?: PlatformAuditQueryDenialReasonV1;
}) {
	try {
		const value = exact(
			input,
			["scope", "query", "operation", "result", "count"],
			["reason"],
		);
		const scope = parsePlatformAuditQueryScopeV1(value.scope);
		const query = parsePlatformAuditQueryInputV1(value.query, scope);
		const { count, operation, result } = value;
		if (
			!Number.isSafeInteger(count) ||
			(count as number) < 0 ||
			(count as number) > query.limit ||
			(operation !== "list" && operation !== "detail") ||
			(result !== "succeeded" &&
				result !== "rejected" &&
				result !== "failed") ||
			(result !== "succeeded" && count !== 0) ||
			(operation === "detail" && (count as number) > 1)
		)
			throw new TypeError("Invalid query audit");
		const reason = Object.hasOwn(value, "reason")
			? queryReason(value.reason)
			: undefined;
		if (reason !== undefined && result === "succeeded")
			throw new TypeError("Successful query cannot have a denial reason");
		const { from, until, action, result: filterResult } = query.filters;
		return {
			schemaVersion: 1 as const,
			scope:
				scope.kind === "administrator"
					? { kind: "administrator" as const }
					: { kind: "execution" as const, principal: scope.principal },
			operation,
			filters: {
				...(from !== undefined ? { from } : {}),
				...(until !== undefined ? { until } : {}),
				...(action !== undefined ? { action } : {}),
				...(filterResult !== undefined ? { result: filterResult } : {}),
				...(query.filters.principal !== undefined
					? { hasPrincipal: true }
					: {}),
				...(query.filters.agentId !== undefined ? { hasAgentId: true } : {}),
				...(query.filters.executionId !== undefined
					? { hasExecutionId: true }
					: {}),
			},
			limit: query.limit,
			hasCursor: query.cursor !== undefined,
			result,
			count: count as number,
			...(reason !== undefined ? { reason } : {}),
		};
	} catch (error) {
		if (error instanceof PlatformAuditScopeErrorV1) throw error;
		throw new PlatformAuditScopeErrorV1("invalid_request");
	}
}

/** Rejections before scope resolution retain only an already trusted identity. */
export function projectPlatformAuditQueryDenialV1(input: {
	principal: ApiPrincipalV1 | null;
	requestedScope: "administrator" | "execution";
	operation: "list" | "detail";
	result: "rejected" | "failed";
	reason: PlatformAuditQueryDenialReasonV1;
}) {
	try {
		const value = exact(input, [
			"principal",
			"requestedScope",
			"operation",
			"result",
			"reason",
		]);
		const { requestedScope, operation, result } = value;
		if (
			(requestedScope !== "administrator" && requestedScope !== "execution") ||
			(operation !== "list" && operation !== "detail") ||
			(result !== "rejected" && result !== "failed")
		)
			throw new TypeError("Invalid denied audit query");
		const subject =
			value.principal === null ? null : principal(value.principal);
		return {
			actor: subject
				? { kind: subject.kind, actorId: subject.id }
				: { kind: "unknown" as const, actorId: "unknown" },
			details: {
				schemaVersion: 1 as const,
				scope: { kind: "denied" as const, requestedScope },
				operation,
				result,
				count: 0 as const,
				reason: queryReason(value.reason),
			},
		};
	} catch {
		throw new PlatformAuditScopeErrorV1("invalid_request");
	}
}

/** Validate durable query metadata before rendering its bounded public reason. */
export function projectPlatformAuditQuerySummaryV1(
	action: "audit.query.completed" | "audit.query.failed",
	details: unknown,
): string {
	try {
		const value = snapshotAgentManagementDataObject(details);
		const scope = snapshotAgentManagementDataObject(value.scope);
		const denied = scope.kind === "denied";
		exact(
			value,
			[
				"schemaVersion",
				"scope",
				"operation",
				"result",
				"count",
				...(denied ? [] : ["filters", "limit", "hasCursor"]),
			],
			["reason"],
		);
		if (
			value.schemaVersion !== 1 ||
			(value.operation !== "list" && value.operation !== "detail") ||
			!Number.isSafeInteger(value.count) ||
			(value.count as number) < 0 ||
			(value.operation === "detail" && (value.count as number) > 1) ||
			(action === "audit.query.completed"
				? value.result !== "succeeded"
				: action !== "audit.query.failed" ||
					(value.result !== "rejected" && value.result !== "failed") ||
					value.count !== 0)
		)
			throw new TypeError("Invalid stored query audit");
		if (denied) {
			exact(scope, ["kind", "requestedScope"]);
			if (
				(scope.requestedScope !== "administrator" &&
					scope.requestedScope !== "execution") ||
				action !== "audit.query.failed"
			)
				throw new TypeError("Invalid denied query audit");
		} else {
			if (scope.kind === "administrator") exact(scope, ["kind"]);
			else if (scope.kind === "execution") {
				exact(scope, ["kind", "principal"]);
				principal(scope.principal);
			} else throw new TypeError("Invalid stored query scope");
			if (
				!Number.isInteger(value.limit) ||
				(value.limit as number) < 1 ||
				(value.limit as number) > 100 ||
				(value.count as number) > (value.limit as number) ||
				typeof value.hasCursor !== "boolean"
			)
				throw new TypeError("Invalid stored query page");
			const filters = exact(
				value.filters,
				[],
				[
					"from",
					"until",
					"action",
					"result",
					"hasPrincipal",
					"hasAgentId",
					"hasExecutionId",
				],
			);
			for (const field of ["from", "until"])
				if (Object.hasOwn(filters, field)) timestamp(filters[field]);
			if (
				Object.hasOwn(filters, "action") &&
				!platformAuditQueryActionsV1.some((action) => action === filters.action)
			)
				throw new TypeError("Invalid stored query action filter");
			if (
				Object.hasOwn(filters, "result") &&
				!platformAuditQueryResultsV1.some((result) => result === filters.result)
			)
				throw new TypeError("Invalid stored query result filter");
			for (const field of ["hasPrincipal", "hasAgentId", "hasExecutionId"])
				if (Object.hasOwn(filters, field) && filters[field] !== true)
					throw new TypeError("Invalid stored query identifier filter");
		}
		const reason = Object.hasOwn(value, "reason")
			? queryReason(value.reason)
			: "unknown";
		if (action === "audit.query.completed") {
			if (Object.hasOwn(value, "reason"))
				throw new TypeError("Unexpected denial reason");
			return action;
		}
		return `${action}: reason=${reason}`;
	} catch {
		throw new PlatformAuditScopeErrorV1("unavailable");
	}
}

/** Describe only known producer metadata; this projection does not establish ownership. */
export function projectPlatformTaskAuditSummaryV1(
	action: "task.control.created" | "task.status.changed",
	details: unknown,
): string {
	try {
		if (action !== "task.control.created" && action !== "task.status.changed")
			throw new TypeError("Invalid task audit action");
		const value =
			details === null || details === undefined
				? {}
				: exact(
						details,
						[],
						action === "task.control.created"
							? [
									"workerId",
									"originalPrincipal",
									"controlRecordId",
									"authorizationRecordId",
									"reason",
								]
							: [
									"status",
									"eventId",
									"originalPrincipal",
									"originalExecution",
									"reason",
								],
					);
		if (Object.hasOwn(value, "originalPrincipal"))
			principal(value.originalPrincipal);
		for (const field of ["workerId", "authorizationRecordId", "eventId"])
			if (Object.hasOwn(value, field)) text(value[field]);
		if (action === "task.control.created") {
			const reason = [
				"stop",
				"authorization_revoked",
				"recovery",
				"generation_isolation",
			].includes(value.reason as string)
				? (value.reason as string)
				: "unknown";
			const controlRecordId = Object.hasOwn(value, "controlRecordId")
				? text(value.controlRecordId)
				: "unknown";
			return text(
				`${action}: reason=${reason}, controlRecordId=${controlRecordId}`,
			);
		}
		if (Object.hasOwn(value, "originalExecution")) {
			if (Object.hasOwn(value, "originalPrincipal"))
				throw new TypeError("Ambiguous task audit principal");
			const original = exact(value.originalExecution, ["actorId", "channelId"]);
			text(original.actorId);
			text(original.channelId);
		}
		const status = [
			"waiting",
			"submitted",
			"processing",
			"completed",
			"failed",
			"cancelled",
			"unknown",
		].includes(value.status as string)
			? (value.status as string)
			: "unknown";
		const reason = [
			"STOP_CONFIRMATION_TIMEOUT",
			"TASK_WAIT_TIMEOUT",
			"TASK_CANCELLED",
			"AUTHORIZATION_REVOKED",
			"RUNTIME_UNACCEPTED",
			"AGENT_UNAVAILABLE",
			"CONVERSATION_UNAVAILABLE",
		].includes(value.reason as string)
			? (value.reason as string)
			: "unknown";
		return `${action}: status=${status}, reason=${reason}`;
	} catch {
		throw new PlatformAuditScopeErrorV1("unavailable");
	}
}

export interface PlatformExecutionAuditBindingV1 {
	readonly executionId: string;
	readonly agentId: string;
	readonly actorId: string;
	readonly channelId: string;
	readonly authorizationRecordId: string;
	readonly boundary: unknown;
	readonly acceptedActor: ApiPrincipalV1;
	readonly acceptedExecutionId: string;
	readonly acceptedAgentId: string;
	readonly acceptedAuthorizationRecordId: string;
}

/** Only the original durable acceptance establishes who owns a Worker record. */
function checkedExecutionAuditBinding(
	input: PlatformExecutionAuditBindingV1,
	scope: PlatformAuditQueryScopeV1,
) {
	try {
		const value = exact(input, [
			"executionId",
			"agentId",
			"actorId",
			"channelId",
			"authorizationRecordId",
			"boundary",
			"acceptedActor",
			"acceptedExecutionId",
			"acceptedAgentId",
			"acceptedAuthorizationRecordId",
		]);
		const boundary = parseTaskAuthorizationBoundaryV1(value.boundary);
		text(value.executionId);
		const authorizationRecordId = text(value.authorizationRecordId);
		if (
			value.executionId !== value.acceptedExecutionId ||
			value.agentId !== value.acceptedAgentId ||
			authorizationRecordId !== value.acceptedAuthorizationRecordId ||
			boundary.agentId !== value.agentId ||
			boundary.principal.id !== value.actorId ||
			boundary.channelId !== value.channelId ||
			!sameApiPrincipalV1(boundary.principal, principal(value.acceptedActor)) ||
			(scope.kind === "execution" &&
				!sameApiPrincipalV1(scope.principal, boundary.principal))
		)
			throw new TypeError("Invalid audit binding");
		return { originalPrincipal: boundary.principal, authorizationRecordId };
	} catch {
		throw new PlatformAuditScopeErrorV1("access_denied");
	}
}

export function requirePlatformExecutionAuditBindingV1(
	input: PlatformExecutionAuditBindingV1,
	scope: PlatformAuditQueryScopeV1,
): ApiPrincipalV1 {
	return checkedExecutionAuditBinding(input, scope).originalPrincipal;
}

export interface PlatformOperationAuditProjectionV1 {
	readonly eventId: string;
	readonly originalPrincipal: ApiPrincipalV1;
	readonly executor: "platform_worker";
	readonly result: ConversationOperationFactV2["phase"];
	readonly fact: ConversationOperationFactV2;
}

export function projectPlatformOperationAuditV1(
	input: unknown,
	binding: PlatformExecutionAuditBindingV1,
	scope: PlatformAuditQueryScopeV1,
): PlatformOperationAuditProjectionV1 {
	const { originalPrincipal, authorizationRecordId } =
		checkedExecutionAuditBinding(binding, scope);
	try {
		const value = exact(input, [
			"schemaVersion",
			"eventId",
			"authorizationRecordId",
			"executor",
			"fact",
		]);
		if (
			value.schemaVersion !== 2 ||
			value.executor !== "platform_worker" ||
			value.authorizationRecordId !== authorizationRecordId
		)
			throw new TypeError("Invalid operation audit");
		const { fact } = parseConversationOperationEventV2({
			schemaVersion: 2,
			type: "execution.operation",
			fact: value.fact,
		});
		if (
			(fact.phase === "unknown" &&
				(fact.finishedAt !== undefined || fact.durationMs !== undefined)) ||
			(fact.durationMs !== undefined &&
				(fact.startedAt === undefined || fact.finishedAt === undefined))
		)
			throw new TypeError("Unconfirmed operation timing");
		return {
			eventId: text(value.eventId),
			originalPrincipal,
			executor: "platform_worker",
			result: fact.phase,
			fact,
		};
	} catch {
		throw new PlatformAuditScopeErrorV1("unavailable");
	}
}
