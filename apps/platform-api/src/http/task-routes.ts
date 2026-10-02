import {
	CancelTaskRequestV1Schema,
	SubmitTaskRequestV1Schema,
	TaskAcceptedV1Schema,
	TaskCancellationV1Schema,
} from "@agent-infra/contracts/pilot";
import type { Hono } from "hono";
import { HttpProtocolError, parseIdempotencyKey, parseJson } from "./common.js";
import {
	authorize,
	boundary,
	resolveAuthority,
	scope,
	type TaskRoutesDependencies,
	taskProjection,
} from "./task-route-support.js";

export type { TaskRoutesDependencies } from "./task-route-support.js";

export function registerTaskRoutes(
	app: Hono,
	dependencies: TaskRoutesDependencies,
) {
	app.post("/api/v1/agents/:agentId/tasks", (context) =>
		boundary(context, dependencies, "submit", async (metadata, audit) => {
			const { value: body } = await parseJson(
				context.req.raw,
				SubmitTaskRequestV1Schema,
				metadata.traceId,
			);
			const agentId = context.req.param("agentId");
			const input = {
				schemaVersion: 1 as const,
				operation: "task.submit" as const,
				agentId,
				...(body.conversationId === undefined
					? {}
					: { conversationId: body.conversationId }),
			};
			const initial = await resolveAuthority(
				dependencies,
				context.req.raw,
				input,
				metadata.traceId,
			);
			audit.principal = initial.taskBoundary.principal;
			audit.target = { kind: "agent", agentId };
			await audit.record("access", "succeeded", "request_accepted");
			const current = await authorize(
				dependencies,
				initial,
				input,
				metadata.traceId,
				context.req.raw,
			);
			const decision = await dependencies.commands(current).submitTask({
				...body,
				agentId,
				idempotencyKey: parseIdempotencyKey(context.req.raw, metadata.traceId),
				...metadata,
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
			const conversationId = context.req.param("conversationId");
			const executionId = context.req.param("executionId");
			const input = {
				schemaVersion: 1 as const,
				operation: "task.read" as const,
				conversationId,
			};
			const initial = await resolveAuthority(
				dependencies,
				context.req.raw,
				input,
				metadata.traceId,
			);
			audit.principal = initial.taskBoundary.principal;
			const detail = await dependencies.query.getExecution(
				scope(initial),
				conversationId,
				executionId,
			);
			if (!detail)
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
			audit.target = {
				kind: "execution",
				agentId: initial.agentId,
				conversationId,
				executionId,
			};
			await audit.record("access", "succeeded", "request_accepted");
			await authorize(
				dependencies,
				initial,
				input,
				metadata.traceId,
				context.req.raw,
			);
			return context.json(taskProjection(detail));
		}),
	);
	app.post(`${path}/cancel`, (context) =>
		boundary(context, dependencies, "cancel", async (metadata, audit) => {
			const conversationId = context.req.param("conversationId");
			const executionId = context.req.param("executionId");
			const input = {
				schemaVersion: 1 as const,
				operation: "task.cancel" as const,
				conversationId,
			};
			const initial = await resolveAuthority(
				dependencies,
				context.req.raw,
				input,
				metadata.traceId,
			);
			audit.principal = initial.taskBoundary.principal;
			await parseJson(
				context.req.raw,
				CancelTaskRequestV1Schema,
				metadata.traceId,
			);
			const detail = await dependencies.query.getExecution(
				scope(initial),
				conversationId,
				executionId,
			);
			if (!detail)
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
			audit.target = {
				kind: "execution",
				agentId: initial.agentId,
				conversationId,
				executionId,
			};
			await audit.record("access", "succeeded", "request_accepted");
			const current = await authorize(
				dependencies,
				initial,
				input,
				metadata.traceId,
				context.req.raw,
			);
			const decision = await dependencies.commands(current).stop({
				schemaVersion: 1,
				command: "stop",
				conversationId,
				targetExecutionId: executionId,
				idempotencyKey: parseIdempotencyKey(context.req.raw, metadata.traceId),
				...metadata,
			});
			if (decision.outcome === "denied")
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
			if (decision.outcome === "conflict")
				throw new HttpProtocolError("CONFLICT", metadata.traceId);
			return context.json(TaskCancellationV1Schema.parse(decision.result), 202);
		}),
	);
}
