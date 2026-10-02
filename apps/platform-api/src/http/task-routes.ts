import { randomUUID } from "node:crypto";
import {
	CancelTaskRequestV1Schema,
	SubmitTaskRequestV1Schema,
	TaskAcceptedV1Schema,
	TaskCancellationV1Schema,
	TaskProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	assertTaskApiAuthorityV1,
	type ConversationExecutionAuthorityV1,
	ConversationExecutionError,
	type ConversationExecutionUseCaseV1,
	type ConversationTaskSubmitCommandV1,
	type ConversationTaskSubmitDecisionV1,
	hasApiCredentialScopeV1,
	sameApiPrincipalV1,
	type TaskApiAuditInputV1,
	taskApiChannelIdV1,
} from "@agent-infra/platform-core";
import {
	type ConversationExecutionDetailV1,
	ConversationQueryError,
	type ConversationQueryScopeV1,
} from "@agent-infra/platform-store";
import type { Context, Hono } from "hono";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	type RequestMetadata,
	requestMetadata,
} from "./common.js";
import { eventProjection } from "./conversation-routes.js";
import {
	type ApiIdentityContext,
	type IdentityAdapter,
	resolveApiIdentity,
} from "./identity.js";

export interface TaskAuthorizationInput {
	readonly schemaVersion: 1;
	readonly operation: "task.submit" | "task.read" | "task.cancel";
	readonly agentId?: string;
	readonly conversationId?: string;
}
export interface TaskRoutesDependencies {
	readonly identity: IdentityAdapter;
	readonly audit: {
		record(input: TaskApiAuditInputV1): Promise<void>;
	};
	readonly authorize: (
		identity: ApiIdentityContext,
		input: TaskAuthorizationInput,
	) => Promise<ConversationExecutionAuthorityV1 | null>;
	readonly commands: (identity: ApiIdentityContext) => {
		submitTask(
			command: ConversationTaskSubmitCommandV1,
		): Promise<ConversationTaskSubmitDecisionV1>;
		stop: ConversationExecutionUseCaseV1["stop"];
	};
	readonly query: TaskQuery;
}

export interface TaskQuery {
	getExecution(
		scope: ConversationQueryScopeV1,
		conversationId: string,
		executionId: string,
	): Promise<ConversationExecutionDetailV1 | undefined>;
}

interface TaskRequestAudit {
	principal: TaskApiAuditInputV1["principal"];
	target: TaskApiAuditInputV1["target"];
	record(
		phase: TaskApiAuditInputV1["phase"],
		result: TaskApiAuditInputV1["result"],
		reason: TaskApiAuditInputV1["reason"],
	): Promise<void>;
}

function auditReason(error: HttpProtocolError): TaskApiAuditInputV1["reason"] {
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

async function boundary(
	context: Context,
	dependencies: TaskRoutesDependencies,
	operation: TaskApiAuditInputV1["operation"],
	work: (
		metadata: RequestMetadata,
		audit: TaskRequestAudit,
	) => Promise<Response>,
) {
	const metadata = requestMetadata(context.req.raw);
	const audit: TaskRequestAudit = {
		principal: { kind: "unknown" },
		target: { kind: "unknown" },
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

async function authorize(
	dependencies: TaskRoutesDependencies,
	identity: ApiIdentityContext,
	input: TaskAuthorizationInput,
	traceId: string,
) {
	if (!hasApiCredentialScopeV1(identity.credential, "agent:use"))
		throw new HttpProtocolError("FORBIDDEN", traceId);
	let authority: ConversationExecutionAuthorityV1 | null;
	try {
		authority = await dependencies.authorize(identity, input);
		if (authority)
			assertTaskApiAuthorityV1({
				authority,
				principal: identity.principal,
				agentId: input.agentId,
			});
	} catch {
		throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
	}
	if (!authority) throw new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
	return authority;
}

function scope(identity: ApiIdentityContext) {
	return {
		actorId: identity.principal.id,
		channelId: taskApiChannelIdV1(identity.principal),
	};
}

async function currentIdentity(
	dependencies: TaskRoutesDependencies,
	request: Request,
	initial: ApiIdentityContext,
	traceId: string,
) {
	const current = await resolveApiIdentity(
		dependencies.identity,
		request,
		traceId,
	);
	if (
		!sameApiPrincipalV1(initial.principal, current.principal) ||
		initial.credential.credentialId !== current.credential.credentialId
	)
		throw new HttpProtocolError("AUTHORIZATION_REVOKED", traceId);
	return current;
}

function taskProjection(detail: ConversationExecutionDetailV1) {
	const events = detail.events.map((event) => {
		if (
			event.executionId !== detail.execution.executionId ||
			event.conversationId !== detail.execution.conversationId
		)
			throw new Error("Task events are inconsistent");
		return eventProjection(event);
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

export function registerTaskRoutes(
	app: Hono,
	dependencies: TaskRoutesDependencies,
) {
	app.post("/api/v1/agents/:agentId/tasks", (context) =>
		boundary(context, dependencies, "submit", async (metadata, audit) => {
			const identity = await resolveApiIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			audit.principal = identity.principal;
			const { value: body } = await parseJson(
				context.req.raw,
				SubmitTaskRequestV1Schema,
				metadata.traceId,
			);
			const agentId = context.req.param("agentId");
			const authority = await authorize(
				dependencies,
				identity,
				{
					schemaVersion: 1,
					operation: "task.submit",
					agentId,
					conversationId: body.conversationId,
				},
				metadata.traceId,
			);
			audit.target = { kind: "agent", agentId: authority.agentId };
			await audit.record("access", "succeeded", "request_accepted");
			const current = await currentIdentity(
				dependencies,
				context.req.raw,
				identity,
				metadata.traceId,
			);
			await authorize(
				dependencies,
				current,
				{
					schemaVersion: 1,
					operation: "task.submit",
					agentId,
					conversationId: body.conversationId,
				},
				metadata.traceId,
			);
			const decision = await dependencies.commands(current).submitTask({
				...body,
				agentId,
				idempotencyKey: parseIdempotencyKey(context.req.raw, metadata.traceId),
				requestId: metadata.requestId,
				traceId: metadata.traceId,
			});
			if (decision.outcome === "capacity_full")
				throw new HttpProtocolError("BUSY", metadata.traceId);
			if (decision.outcome === "conflict")
				throw new HttpProtocolError("CONFLICT", metadata.traceId);
			if (decision.outcome === "denied")
				throw new HttpProtocolError(
					decision.reason === "conversation_unavailable"
						? "RESOURCE_UNAVAILABLE"
						: "RUNTIME_UNAVAILABLE",
					metadata.traceId,
				);
			return context.json(TaskAcceptedV1Schema.parse(decision.result), 202);
		}),
	);
	const path = "/api/v1/conversations/:conversationId/tasks/:executionId";
	app.get(path, (context) =>
		boundary(context, dependencies, "read", async (metadata, audit) => {
			const identity = await resolveApiIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			audit.principal = identity.principal;
			const conversationId = context.req.param("conversationId");
			const executionId = context.req.param("executionId");
			const authority = await authorize(
				dependencies,
				identity,
				{ schemaVersion: 1, operation: "task.read", conversationId },
				metadata.traceId,
			);
			const detail = await dependencies.query.getExecution(
				scope(identity),
				conversationId,
				executionId,
			);
			if (!detail)
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
			audit.target = {
				kind: "execution",
				agentId: authority.agentId,
				conversationId,
				executionId,
			};
			await audit.record("access", "succeeded", "request_accepted");
			const current = await currentIdentity(
				dependencies,
				context.req.raw,
				identity,
				metadata.traceId,
			);
			await authorize(
				dependencies,
				current,
				{ schemaVersion: 1, operation: "task.read", conversationId },
				metadata.traceId,
			);
			return context.json(taskProjection(detail));
		}),
	);
	app.post(`${path}/cancel`, (context) =>
		boundary(context, dependencies, "cancel", async (metadata, audit) => {
			const identity = await resolveApiIdentity(
				dependencies.identity,
				context.req.raw,
				metadata.traceId,
			);
			audit.principal = identity.principal;
			await parseJson(
				context.req.raw,
				CancelTaskRequestV1Schema,
				metadata.traceId,
			);
			const conversationId = context.req.param("conversationId");
			const executionId = context.req.param("executionId");
			const authority = await authorize(
				dependencies,
				identity,
				{ schemaVersion: 1, operation: "task.cancel", conversationId },
				metadata.traceId,
			);
			const detail = await dependencies.query.getExecution(
				scope(identity),
				conversationId,
				executionId,
			);
			if (!detail)
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
			audit.target = {
				kind: "execution",
				agentId: authority.agentId,
				conversationId,
				executionId,
			};
			await audit.record("access", "succeeded", "request_accepted");
			const current = await currentIdentity(
				dependencies,
				context.req.raw,
				identity,
				metadata.traceId,
			);
			await authorize(
				dependencies,
				current,
				{ schemaVersion: 1, operation: "task.cancel", conversationId },
				metadata.traceId,
			);
			const decision = await dependencies.commands(current).stop({
				schemaVersion: 1,
				command: "stop",
				conversationId,
				targetExecutionId: executionId,
				idempotencyKey: parseIdempotencyKey(context.req.raw, metadata.traceId),
				requestId: metadata.requestId,
				traceId: metadata.traceId,
			});
			if (decision.outcome === "denied")
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
			if (decision.outcome === "conflict")
				throw new HttpProtocolError("CONFLICT", metadata.traceId);
			return context.json(TaskCancellationV1Schema.parse(decision.result), 202);
		}),
	);
}
