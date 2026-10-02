import { randomUUID } from "node:crypto";
import {
	TaskProjectionV1Schema,
	TaskStatusEventV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type ConversationExecutionAuthorityV1,
	ConversationExecutionError,
	type ConversationExecutionUseCaseV1,
	type ConversationTaskSubmitCommandV1,
	type ConversationTaskSubmitDecisionV1,
	PersonalApiCredentialErrorV1,
	type PersonalApiTaskAdmissionAuthorityV1,
	parseConversationPersistedEventPayloadV1,
	parsePersonalApiTaskAdmissionAuthorityV1,
	parseTaskAuthorizationBoundaryV1,
	type TaskApiAuditRecordInputV1,
	type TaskAuthorizationBoundaryV1,
} from "@agent-infra/platform-core";
import {
	type ConversationExecutionDetailV1,
	ConversationQueryError,
	type ConversationQueryEventV1,
	type ConversationQueryScopeV1,
	type PostgresConversationExecutionTransactionV1,
} from "@agent-infra/platform-store";
import type { Context } from "hono";
import {
	HttpProtocolError,
	type RequestMetadata,
	requestMetadata,
} from "./common.js";
import { eventProjection } from "./conversation-routes.js";
export interface TaskAuthorizationInput {
	readonly schemaVersion: 1;
	readonly operation: "task.submit" | "task.read" | "task.cancel";
	readonly agentId?: string;
	readonly conversationId?: string;
}
export interface TaskAccessDependencies {
	readonly audit: { record(input: TaskApiAuditRecordInputV1): Promise<void> };
	readonly authorize: PostgresConversationExecutionTransactionV1["authorizeTaskApi"];
}
export interface TaskRoutesDependencies extends TaskAccessDependencies {
	readonly commands: (authority: ConversationExecutionAuthorityV1) => {
		submitTask(
			command: ConversationTaskSubmitCommandV1,
		): Promise<ConversationTaskSubmitDecisionV1>;
		stop: ConversationExecutionUseCaseV1["stop"];
	};
	readonly query: {
		getExecution(
			scope: ConversationQueryScopeV1,
			conversationId: string,
			executionId: string,
		): Promise<ConversationExecutionDetailV1 | undefined>;
	};
}

export type TaskRequestAuthority = ConversationExecutionAuthorityV1 & {
	readonly taskBoundary: TaskAuthorizationBoundaryV1;
	readonly personalApiAdmissionAuthority: PersonalApiTaskAdmissionAuthorityV1;
};

interface TaskRequestAudit {
	principal: TaskApiAuditRecordInputV1["principal"];
	target: TaskApiAuditRecordInputV1["target"];
	subscriptionId?: string;
	record(
		phase: TaskApiAuditRecordInputV1["phase"],
		result: TaskApiAuditRecordInputV1["result"],
		reason: TaskApiAuditRecordInputV1["reason"],
	): Promise<void>;
}

export function auditReason(
	error: HttpProtocolError,
): TaskApiAuditRecordInputV1["reason"] {
	switch (error.body.code) {
		case "AUTHENTICATION_REQUIRED":
			return "authentication_required";
		case "AUTHORIZATION_REVOKED":
			return "authorization_revoked";
		case "RESOURCE_UNAVAILABLE":
			return error.status === 403 ? "missing_scope" : "resource_unavailable";
		case "AGENT_BUSY":
			return "capacity_full";
		case "INVALID_REQUEST":
			return error.status === 409 ? "conflict" : "invalid_request";
		default:
			return "dependency_unavailable";
	}
}

export async function boundary(
	context: Context,
	dependencies: TaskAccessDependencies,
	operation: TaskApiAuditRecordInputV1["operation"],
	work: (
		metadata: RequestMetadata,
		audit: TaskRequestAudit,
	) => Promise<Response>,
) {
	const metadata = requestMetadata(context.req.raw);
	const audit: TaskRequestAudit = {
		principal: { kind: "unknown" },
		target: { kind: "unknown" },
		...(operation === "subscribe" ? { subscriptionId: randomUUID() } : {}),
		async record(phase, result, reason) {
			await dependencies.audit.record({
				schemaVersion: 1,
				auditId: randomUUID(),
				...metadata,
				operation,
				phase,
				result,
				reason,
				principal: audit.principal,
				target: audit.target,
				...(audit.subscriptionId
					? { subscriptionId: audit.subscriptionId }
					: {}),
			});
		},
	};
	try {
		return await work(metadata, audit);
	} catch (error) {
		const protocol =
			error instanceof HttpProtocolError
				? error
				: new HttpProtocolError(
						error instanceof ConversationExecutionError ||
							error instanceof ConversationQueryError
							? error.code === "invalid_input" ||
								error.code === "invalid_request"
								? "INVALID_REQUEST"
								: "DEPENDENCY_UNAVAILABLE"
							: "DEPENDENCY_UNAVAILABLE",
						metadata.traceId,
					);
		try {
			await audit.record(
				"access",
				protocol.status >= 500 ? "failed" : "rejected",
				auditReason(protocol),
			);
		} catch {
			const unavailable = new HttpProtocolError(
				"DEPENDENCY_UNAVAILABLE",
				metadata.traceId,
			);
			return context.json(unavailable.body, unavailable.status);
		}
		return context.json(protocol.body, protocol.status);
	}
}

export async function resolveAuthority(
	dependencies: TaskAccessDependencies,
	request: Request,
	input: TaskAuthorizationInput,
	traceId: string,
): Promise<TaskRequestAuthority> {
	const match = /^Bearer (papi_[A-Za-z0-9_-]{43})$/i.exec(
		request.headers.get("Authorization") ?? "",
	);
	if (!match?.[1])
		throw new HttpProtocolError("AUTHENTICATION_REQUIRED", traceId);
	try {
		const operation =
			input.operation === "task.read" ? "agent:read" : "agent:use";
		const authority = await dependencies.authorize({
			material: match[1],
			operation,
			...(input.agentId === undefined ? {} : { agentId: input.agentId }),
			...(input.conversationId === undefined
				? {}
				: { conversationId: input.conversationId }),
		});
		if (!authority)
			throw new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
		const admission = parsePersonalApiTaskAdmissionAuthorityV1(
			authority.personalApiAdmissionAuthority,
		);
		const boundary = parseTaskAuthorizationBoundaryV1(authority.taskBoundary);
		if (
			admission.operation !== operation ||
			authority.actorId !== boundary.principal.id ||
			boundary.principal.kind !== admission.principal.kind ||
			boundary.principal.id !== admission.principal.id ||
			authority.agentId !== admission.agentId ||
			boundary.agentId !== admission.agentId ||
			authority.channelId !== admission.channelId ||
			boundary.channelId !== admission.channelId ||
			(input.agentId !== undefined && authority.agentId !== input.agentId) ||
			authority.authorizationRevision !== boundary.agentAuthorizationRevision ||
			boundary.identityRevision !== admission.identityRevision ||
			boundary.accessSources.length !== 1 ||
			boundary.accessSources[0]?.kind !== "api-use" ||
			boundary.accessSources[0].useGrantRevision !== admission.useGrantRevision
		)
			throw new Error("Task API authority is inconsistent");
		return {
			...authority,
			taskBoundary: boundary,
			personalApiAdmissionAuthority: admission,
		};
	} catch (error) {
		if (error instanceof HttpProtocolError) throw error;
		if (error instanceof PersonalApiCredentialErrorV1) {
			throw new HttpProtocolError(
				error.code === "authentication_required"
					? "AUTHENTICATION_REQUIRED"
					: error.code === "forbidden" || error.code === "not_found"
						? "AUTHORIZATION_REVOKED"
						: "DEPENDENCY_UNAVAILABLE",
				traceId,
			);
		}
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
}

/** Recheck the same used credential after every final access/audit await. */
export async function authorize(
	dependencies: TaskAccessDependencies,
	initial: TaskRequestAuthority,
	input: TaskAuthorizationInput,
	traceId: string,
	request: Request,
): Promise<TaskRequestAuthority> {
	const current = await resolveAuthority(dependencies, request, input, traceId);
	const before = initial.personalApiAdmissionAuthority;
	const after = current.personalApiAdmissionAuthority;
	if (
		before.principal.kind !== after.principal.kind ||
		before.principal.id !== after.principal.id ||
		before.credentialId !== after.credentialId ||
		before.credentialHash !== after.credentialHash ||
		before.identityRevision !== after.identityRevision ||
		before.useGrantRevision !== after.useGrantRevision ||
		initial.authorizationRevision !== current.authorizationRevision ||
		before.agentId !== after.agentId ||
		before.channelId !== after.channelId
	)
		throw new HttpProtocolError("AUTHORIZATION_REVOKED", traceId);
	return current;
}
export function scope(
	authority: TaskRequestAuthority,
): ConversationQueryScopeV1 {
	return {
		actorId: authority.actorId,
		channelId: authority.channelId,
		principal: authority.taskBoundary.principal,
	};
}
export function taskProjection(detail: ConversationExecutionDetailV1) {
	const events = detail.events.map((event) => {
		if (
			event.executionId !== detail.execution.executionId ||
			event.conversationId !== detail.execution.conversationId
		)
			throw new Error("Task events are inconsistent");
		return taskEventProjection(event);
	});
	return TaskProjectionV1Schema.parse({
		schemaVersion: 1,
		conversationId: detail.execution.conversationId,
		executionId: detail.execution.executionId,
		status: detail.execution.status,
		output: events
			.map((event) => (event.type === "text.delta" ? event.payload.text : ""))
			.join(""),
		events,
	});
}

export function taskEventProjection(event: ConversationQueryEventV1) {
	if (event.eventType !== "task.status") return eventProjection(event);
	if (event.eventSchemaVersion !== undefined)
		throw new Error("Task status schema is invalid");
	const persisted = parseConversationPersistedEventPayloadV1(
		event.eventPayload,
	);
	if (persisted.type !== "task.status")
		throw new Error("Task status payload is inconsistent");
	const { type, ...payload } = persisted;
	return TaskStatusEventV1Schema.parse({
		schemaVersion: 1,
		kind: "event",
		eventId: event.eventId,
		conversationId: event.conversationId,
		executionId: event.executionId,
		sequence: event.sequence,
		conversationCursor: event.conversationCursor,
		occurredAt: event.occurredAt.toISOString(),
		type,
		payload,
	});
}
