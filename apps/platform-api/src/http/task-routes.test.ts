import type { OperationalEvent } from "@agent-infra/observability";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { TaskRoutesDependencies } from "./task-routes.js";
import { registerTaskRoutes } from "./task-routes.js";

const material = `papi_${"T".repeat(43)}`;
const principal = { kind: "user" as const, id: "user-1" };
const authority = {
	schemaVersion: 1 as const,
	actorId: principal.id,
	agentId: "agent-1",
	channelId: "api" as const,
	authorizationRevision: "agent-revision",
	taskBoundary: {
		schemaVersion: 1 as const,
		principal,
		agentId: "agent-1",
		channelId: "api",
		identityRevision: "identity-revision",
		agentAuthorizationRevision: "agent-revision",
		accessSources: [
			{ kind: "api-use" as const, useGrantRevision: "grant-revision" },
		],
	},
	personalApiAdmissionAuthority: {
		schemaVersion: 1 as const,
		principal,
		credentialId: "credential-reference",
		credentialHash: "a".repeat(64),
		agentId: "agent-1",
		channelId: "api" as const,
		operation: "agent:use" as const,
		identityRevision: "identity-revision",
		useGrantRevision: "grant-revision",
	},
};

function dependencies(
	decision: unknown = {
		outcome: "accepted",
		result: {
			schemaVersion: 1,
			status: "accepted",
			conversationId: "conversation-1",
			executionId: "execution-1",
			messageId: "message-1",
		},
	},
	observations: OperationalEvent[] = [],
): TaskRoutesDependencies {
	return {
		audit: { record: vi.fn().mockResolvedValue(undefined) },
		authorize: vi.fn().mockResolvedValue(authority),
		commands: vi.fn().mockReturnValue({
			submitTask: vi.fn().mockResolvedValue(decision),
			stop: vi.fn(),
		}),
		query: {
			getExecution: vi.fn().mockResolvedValue({
				execution: {
					executionId: "execution-1",
					conversationId: "conversation-1",
					sourceMessageId: "message-1",
					status: "submitted",
					createdAt: new Date("2026-10-14T00:00:00.000Z"),
					updatedAt: new Date("2026-10-14T00:00:00.000Z"),
					traceId: null,
				},
				events: [],
			}),
			replayExecution: vi.fn().mockResolvedValue({
				outcome: "events",
				events: [],
				resumeCursor: "cursor-1",
			}),
		},
		streamPollIntervalMs: 1,
		streamReadTimeoutMs: 100,
		observability: {
			record(event) {
				observations.push(event);
			},
		},
	};
}

function app(dependencies: TaskRoutesDependencies) {
	const router = new Hono();
	registerTaskRoutes(router, dependencies);
	return router;
}

const submitPath = "/api/v1/agents/agent-1/tasks";
const eventsPath =
	"/api/v1/conversations/conversation-1/tasks/execution-1/events";
const headers = {
	Authorization: `Bearer ${material}`,
	"Content-Type": "application/json",
	"Idempotency-Key": "task-observation",
};

describe("task route observability", () => {
	it("records bounded task admission success and isolates recorder failures", async () => {
		const observations: OperationalEvent[] = [];
		const deps = dependencies(undefined, observations);
		const response = await app(deps).request(submitPath, {
			method: "POST",
			headers,
			body: JSON.stringify({ schemaVersion: 1, text: "private input" }),
		});
		expect(response.status).toBe(202);
		expect(observations).toHaveLength(1);
		expect(observations[0]).toMatchObject({
			stage: "task_admission",
			outcome: "completed",
		});
		expect(observations[0]).not.toHaveProperty("conversationId");
		expect(observations[0]).not.toHaveProperty("executionId");

		const failing: TaskRoutesDependencies = {
			...dependencies(undefined, []),
			observability: {
				record() {
					throw new Error("telemetry sink unavailable");
				},
			},
		};
		const isolated = await app(failing).request(submitPath, {
			method: "POST",
			headers,
			body: JSON.stringify({ schemaVersion: 1, text: "private input" }),
		});
		expect(isolated.status).toBe(202);
	});

	it("records rejected task admission without exposing task identifiers", async () => {
		const observations: OperationalEvent[] = [];
		const response = await app(
			dependencies({ outcome: "capacity_full" }, observations),
		).request(submitPath, {
			method: "POST",
			headers,
			body: JSON.stringify({ schemaVersion: 1, text: "private input" }),
		});
		expect(response.status).toBe(409);
		expect(observations).toHaveLength(1);
		expect(observations[0]).toMatchObject({
			stage: "task_admission",
			outcome: "rejected",
			code: "TASK_UNAVAILABLE",
		});
		expect(observations[0]).not.toHaveProperty("operationRef");
	});

	it("records SSE open and terminal duration while keeping stream behavior unchanged", async () => {
		const observations: OperationalEvent[] = [];
		const controller = new AbortController();
		const readAuthority = {
			...authority,
			personalApiAdmissionAuthority: {
				...authority.personalApiAdmissionAuthority,
				operation: "agent:read" as const,
			},
		};
		const response = await app({
			...dependencies(undefined, observations),
			authorize: vi.fn().mockResolvedValue(readAuthority),
		}).request(eventsPath, { headers, signal: controller.signal });
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Missing SSE body");
		await reader.read();
		controller.abort();
		await reader.cancel();
		await vi.waitFor(() => {
			expect(observations.filter(({ stage }) => stage === "sse")).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ stage: "sse", operationRef: "sse.open" }),
					expect.objectContaining({ stage: "sse", operationRef: "sse.ended" }),
				]),
			);
		});
		const ended = observations.find(
			({ operationRef }) => operationRef === "sse.ended",
		);
		expect(ended?.durationMs).toEqual(expect.any(Number));
		expect(ended).not.toHaveProperty("conversationId");
		expect(ended).not.toHaveProperty("executionId");
	});
});
