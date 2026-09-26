import { randomUUID } from "node:crypto";
import {
	CancelTaskRequestV1Schema,
	ConversationSseMessageV2Schema,
	frameTaskSseMessageV1,
	resolvePilotReplaySelectorV1,
	SubmitTaskRequestV1Schema,
	TaskAcceptedV1Schema,
	TaskCancellationV1Schema,
	TaskProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	type ConversationExecutionAuthorityV1,
	ConversationExecutionError,
	type ConversationExecutionUseCaseV1,
	type ConversationTaskSubmitCommandV1,
	type ConversationTaskSubmitDecisionV1,
	hasApiCredentialScopeV1,
	parseTaskAuthorizationBoundaryV1,
	sameApiPrincipalV1,
	type TaskApiAuditInputV1,
	taskApiChannelIdV1,
} from "@agent-infra/platform-core";
import {
	type ConversationExecutionDetailV1,
	ConversationQueryError,
	type PostgresConversationQueryV1,
} from "@agent-infra/platform-store";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
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
		renewSubscription(subscriptionId: string): Promise<void>;
		recoverSubscriptions(): Promise<number>;
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
	readonly query: Pick<
		PostgresConversationQueryV1,
		"getExecution" | "replayExecution"
	>;
	readonly streamPollIntervalMs?: number;
}

interface TaskRequestAudit {
	principal: TaskApiAuditInputV1["principal"];
	target: TaskApiAuditInputV1["target"];
	subscriptionId?: string;
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
		if (authority) {
			const task = parseTaskAuthorizationBoundaryV1(authority.taskBoundary);
			if (
				authority.schemaVersion !== 1 ||
				authority.actorId !== identity.principal.id ||
				authority.channelId !== taskApiChannelIdV1(identity.principal) ||
				!sameApiPrincipalV1(task.principal, identity.principal) ||
				task.agentId !== authority.agentId ||
				task.channelId !== authority.channelId ||
				task.agentAuthorizationRevision !== authority.authorizationRevision ||
				(input.agentId !== undefined && input.agentId !== authority.agentId)
			)
				throw new Error("Task authority does not match its principal");
		}
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

function selector(request: Request, traceId: string) {
	const search = new URL(request.url).searchParams;
	if (
		[...search.keys()].some((key) => key !== "cursor") ||
		search.getAll("cursor").length > 1
	)
		throw new HttpProtocolError("INVALID_REQUEST", traceId);
	try {
		return resolvePilotReplaySelectorV1({
			...(search.has("cursor") ? { cursor: search.get("cursor") } : {}),
			...(request.headers.has("Last-Event-ID")
				? { lastEventId: request.headers.get("Last-Event-ID") }
				: {}),
		});
	} catch {
		throw new HttpProtocolError("INVALID_REQUEST", traceId);
	}
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
	app.get(`${path}/events`, (context) =>
		boundary(context, dependencies, "subscribe", async (metadata, audit) => {
			const request = context.req.raw;
			const initial = await resolveApiIdentity(
				dependencies.identity,
				request,
				metadata.traceId,
			);
			audit.principal = initial.principal;
			const conversationId = context.req.param("conversationId");
			const executionId = context.req.param("executionId");
			const check = async () => {
				const current = await currentIdentity(
					dependencies,
					request,
					initial,
					metadata.traceId,
				);
				return authorize(
					dependencies,
					current,
					{ schemaVersion: 1, operation: "task.read", conversationId },
					metadata.traceId,
				);
			};
			const authority = await check();
			let next = selector(request, metadata.traceId);
			let batch = await dependencies.query.replayExecution(
				scope(initial),
				conversationId,
				executionId,
				next,
			);
			if (!batch)
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
			audit.target = {
				kind: "execution",
				agentId: authority.agentId,
				conversationId,
				executionId,
			};
			await audit.record("access", "succeeded", "request_accepted");
			await audit.record(
				"subscription.started",
				"succeeded",
				"request_accepted",
			);
			const subscriptionId = audit.subscriptionId;
			if (!subscriptionId) throw new Error("Task subscription ID is absent");
			return streamSSE(context, async (stream) => {
				let endResult: TaskApiAuditInputV1["result"] = "succeeded";
				let endReason: TaskApiAuditInputV1["reason"] = "stream_ended";
				let maintenanceFailure = false;
				let maintenance: Promise<void> | undefined;
				const maintain = () => {
					maintenance ??= dependencies.audit
						.renewSubscription(subscriptionId)
						.then(async () => {
							await check();
						})
						.catch((error: unknown) => {
							maintenanceFailure = true;
							endResult =
								error instanceof HttpProtocolError && error.status < 500
									? "rejected"
									: "failed";
							endReason =
								error instanceof HttpProtocolError
									? auditReason(error)
									: "dependency_unavailable";
							stream.abort();
							throw error;
						})
						.finally(() => {
							maintenance = undefined;
						});
					return maintenance;
				};
				const leaseTimer = setInterval(() => {
					void maintain().catch(() => {});
				}, 5000);
				leaseTimer.unref();
				const write = async (value: unknown) => {
					await maintain();
					if (stream.aborted) throw new Error("Task subscription is closed");
					const frame = frameTaskSseMessageV1(value);
					await stream.writeSSE({
						...(frame.id === undefined ? {} : { id: frame.id }),
						data: JSON.stringify(frame.data),
					});
				};
				try {
					while (!stream.aborted) {
						await check();
						if (!batch)
							throw new HttpProtocolError(
								"RESOURCE_UNAVAILABLE",
								metadata.traceId,
							);
						if (batch.outcome === "reload") {
							await write({
								schemaVersion: 1,
								kind: "control",
								type: "timeline.reload",
								reason: batch.reason,
								resumeCursor: batch.resumeCursor,
							});
							return;
						}
						for (const event of batch.events) {
							if (stream.aborted) return;
							if (
								event.executionId !== executionId ||
								event.conversationId !== conversationId
							)
								throw new Error("Task replay contains another execution");
							await write(eventProjection(event));
						}
						const last = batch.events.at(-1);
						if (last) next = { kind: "last-event-id", value: last.eventId };
						await write({
							schemaVersion: 1,
							kind: "control",
							type: "heartbeat",
							occurredAt: new Date().toISOString(),
						});
						await stream.sleep(dependencies.streamPollIntervalMs ?? 500);
						if (stream.aborted) return;
						batch = await dependencies.query.replayExecution(
							scope(initial),
							conversationId,
							executionId,
							next,
						);
					}
				} catch (error) {
					endResult = "failed";
					endReason =
						error instanceof HttpProtocolError
							? auditReason(error)
							: "dependency_unavailable";
					if (
						!stream.aborted &&
						error instanceof HttpProtocolError &&
						[
							"AUTHENTICATION_REQUIRED",
							"AUTHORIZATION_REVOKED",
							"RESOURCE_UNAVAILABLE",
						].includes(error.body.code)
					) {
						endResult = "rejected";
						endReason = "authorization_revoked";
						const signal = ConversationSseMessageV2Schema.parse({
							schemaVersion: 1,
							kind: "control",
							type: "authorization.revoked",
							error: new HttpProtocolError(
								"AUTHORIZATION_REVOKED",
								metadata.traceId,
							).body,
						});
						await stream.writeSSE({ data: JSON.stringify(signal) });
					} else if (!stream.aborted) {
						const frame = frameTaskSseMessageV1({
							schemaVersion: 1,
							kind: "control",
							type: "task.stream.error",
							error: new HttpProtocolError(
								"DEPENDENCY_UNAVAILABLE",
								metadata.traceId,
							).body,
						});
						await stream.writeSSE({ data: JSON.stringify(frame.data) });
					}
				} finally {
					clearInterval(leaseTimer);
					await maintenance?.catch(() => {});
					await audit.record(
						"subscription.ended",
						endResult,
						stream.aborted && !maintenanceFailure
							? "client_disconnected"
							: endReason,
					);
				}
			});
		}),
	);
}
