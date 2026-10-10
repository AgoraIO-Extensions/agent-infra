import { setTimeout as delay } from "node:timers/promises";
import {
	CancelTaskRequestV1Schema,
	frameTaskSseMessageV1,
	resolvePilotReplaySelectorV1,
	SubmitTaskRequestV1Schema,
	TaskAcceptedV1Schema,
	TaskCancellationV1Schema,
} from "@agent-infra/contracts/pilot";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { HttpProtocolError, parseIdempotencyKey, parseJson } from "./common.js";
import {
	authorize,
	boundary,
	resolveAuthority,
	scope,
	type TaskRoutesDependencies,
	taskEventProjection,
	taskProjection,
} from "./task-route-support.js";

export type { TaskRoutesDependencies } from "./task-route-support.js";

function replaySelector(request: Request, traceId: string) {
	const search = new URL(request.url).searchParams;
	if (
		[...search.keys()].some((key) => key !== "cursor") ||
		search.getAll("cursor").length > 1
	) {
		throw new HttpProtocolError("INVALID_REQUEST", traceId);
	}
	try {
		return resolvePilotReplaySelectorV1({
			...(search.get("cursor") === null
				? {}
				: { cursor: search.get("cursor") as string }),
			...(request.headers.get("Last-Event-ID") === null
				? {}
				: { lastEventId: request.headers.get("Last-Event-ID") as string }),
		});
	} catch {
		throw new HttpProtocolError("INVALID_REQUEST", traceId);
	}
}

function validateTaskEvents(
	events: readonly { conversationId: string; executionId: string }[],
	conversationId: string,
	executionId: string,
): void {
	for (const event of events) {
		if (
			event.conversationId !== conversationId ||
			event.executionId !== executionId
		)
			throw new Error("Task replay contains another execution");
	}
}

async function streamRead<T>(
	task: () => Promise<T>,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: () => void = () => {};
	const interrupted = new Promise<never>((_, reject) => {
		abort = () => reject(new Error("Task stream read interrupted"));
		if (signal.aborted) return abort();
		signal.addEventListener("abort", abort, { once: true });
		timer = setTimeout(abort, timeoutMs);
	});
	try {
		return await Promise.race([
			interrupted,
			Promise.resolve().then(() => {
				if (signal.aborted) throw new Error("Task stream read interrupted");
				return task();
			}),
		]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}

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
			const current = await authorize(
				dependencies,
				initial,
				input,
				metadata.traceId,
				context.req.raw,
			);
			await audit.record("access", "succeeded", "request_accepted");
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
			await authorize(
				dependencies,
				initial,
				input,
				metadata.traceId,
				context.req.raw,
			);
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
			const current = await authorize(
				dependencies,
				initial,
				input,
				metadata.traceId,
				context.req.raw,
			);
			await audit.record("access", "succeeded", "request_accepted");
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
	app.get(`${path}/events`, (context) =>
		boundary(context, dependencies, "subscribe", async (metadata, audit) => {
			const replayExecution = dependencies.query.replayExecution;
			if (!replayExecution)
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
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
			audit.target = {
				kind: "execution",
				agentId: initial.agentId,
				conversationId,
				executionId,
			};
			const detail = await dependencies.query.getExecution(
				scope(initial),
				conversationId,
				executionId,
			);
			if (!detail)
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
			await authorize(
				dependencies,
				initial,
				input,
				metadata.traceId,
				context.req.raw,
			);
			const firstReplay = await replayExecution(
				scope(initial),
				conversationId,
				executionId,
				replaySelector(context.req.raw, metadata.traceId),
			);
			if (!firstReplay)
				throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
			if (firstReplay.outcome === "events") {
				try {
					validateTaskEvents(firstReplay.events, conversationId, executionId);
					firstReplay.events.forEach(taskEventProjection);
				} catch {
					throw new HttpProtocolError(
						"DEPENDENCY_UNAVAILABLE",
						metadata.traceId,
					);
				}
			}
			const pollIntervalMs = dependencies.streamPollIntervalMs ?? 1000;
			const readTimeoutMs = dependencies.streamReadTimeoutMs ?? 1000;
			if (
				!Number.isInteger(pollIntervalMs) ||
				pollIntervalMs < 1 ||
				pollIntervalMs > 30_000 ||
				!Number.isInteger(readTimeoutMs) ||
				readTimeoutMs < 1 ||
				readTimeoutMs > 30_000
			)
				throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", metadata.traceId);
			await audit.record("access", "succeeded", "request_accepted");
			await audit.record(
				"subscription.started",
				"succeeded",
				"request_accepted",
			);
			const request = context.req.raw;
			return streamSSE(context, async (stream) => {
				const lifetime = new AbortController();
				const abort = () => lifetime.abort();
				let endReason:
					| "stream_ended"
					| "authorization_revoked"
					| "dependency_unavailable"
					| "client_disconnected" = "stream_ended";
				request.signal.addEventListener("abort", abort, { once: true });
				stream.onAbort(abort);
				if (request.signal.aborted || stream.aborted) abort();
				const write = async (message: unknown) => {
					const frame = frameTaskSseMessageV1(message);
					try {
						return await streamRead(
							() =>
								stream.writeSSE({
									...(frame.id === undefined ? {} : { id: frame.id }),
									data: JSON.stringify(frame.data),
								}),
							readTimeoutMs,
							lifetime.signal,
						);
					} catch (error) {
						stream.abort();
						throw error;
					}
				};
				const closeForRevocation = async () => {
					if (lifetime.signal.aborted) return;
					await write({
						schemaVersion: 1,
						kind: "control",
						type: "authorization.revoked",
						error: new HttpProtocolError(
							"AUTHORIZATION_REVOKED",
							metadata.traceId,
						).body,
					});
				};
				try {
					let current = initial;
					let replay = firstReplay;
					let cursor = replay.resumeCursor;
					while (!lifetime.signal.aborted) {
						current = await streamRead(
							() =>
								authorize(
									dependencies,
									initial,
									input,
									metadata.traceId,
									request,
								),
							readTimeoutMs,
							lifetime.signal,
						);
						if (replay.outcome === "reload") {
							current = await streamRead(
								() =>
									authorize(
										dependencies,
										initial,
										input,
										metadata.traceId,
										request,
									),
								readTimeoutMs,
								lifetime.signal,
							);
							await write({
								schemaVersion: 1,
								kind: "control",
								type: "timeline.reload",
								reason: replay.reason,
								resumeCursor: replay.resumeCursor,
							});
							break;
						}
						await write({
							schemaVersion: 1,
							kind: "control",
							type: "heartbeat",
							occurredAt: new Date().toISOString(),
						});
						validateTaskEvents(replay.events, conversationId, executionId);
						for (const event of replay.events) {
							if (lifetime.signal.aborted) break;
							try {
								current = await streamRead(
									() =>
										authorize(
											dependencies,
											initial,
											input,
											metadata.traceId,
											request,
										),
									readTimeoutMs,
									lifetime.signal,
								);
							} catch (error) {
								if (
									error instanceof HttpProtocolError &&
									[
										"AUTHORIZATION_REVOKED",
										"AUTHENTICATION_REQUIRED",
										"RESOURCE_UNAVAILABLE",
									].includes(error.body.code)
								) {
									endReason = "authorization_revoked";
									await closeForRevocation();
									return;
								}
								endReason = "dependency_unavailable";
								return;
							}
							await write(taskEventProjection(event));
							cursor = event.conversationCursor;
						}
						if (lifetime.signal.aborted) break;
						await delay(pollIntervalMs, undefined, {
							signal: lifetime.signal,
						});
						if (lifetime.signal.aborted) break;
						current = await streamRead(
							() =>
								authorize(
									dependencies,
									initial,
									input,
									metadata.traceId,
									request,
								),
							readTimeoutMs,
							lifetime.signal,
						);
						const nextReplay = await streamRead(
							() =>
								replayExecution(scope(current), conversationId, executionId, {
									kind: "cursor",
									value: cursor,
								}),
							readTimeoutMs,
							lifetime.signal,
						);
						if (!nextReplay) {
							endReason = "dependency_unavailable";
							break;
						}
						replay = nextReplay;
					}
				} catch (error) {
					if (
						error instanceof HttpProtocolError &&
						[
							"AUTHORIZATION_REVOKED",
							"AUTHENTICATION_REQUIRED",
							"RESOURCE_UNAVAILABLE",
						].includes(error.body.code)
					) {
						endReason = "authorization_revoked";
						await closeForRevocation();
					} else if (!lifetime.signal.aborted) {
						endReason = "dependency_unavailable";
					}
				} finally {
					if (request.signal.aborted || stream.aborted)
						endReason = "client_disconnected";
					request.signal.removeEventListener("abort", abort);
					abort();
					try {
						await audit.record(
							"subscription.ended",
							endReason === "dependency_unavailable"
								? "failed"
								: endReason === "authorization_revoked"
									? "rejected"
									: "succeeded",
							endReason,
						);
					} catch {
						// The stream is already terminal; no second response is possible.
					}
				}
			});
		}),
	);
}
