import { setTimeout as delay } from "node:timers/promises";
import {
	ConversationDetailProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	ConversationSseMessageV1Schema,
	ConversationSseMessageV2Schema,
	ExecutionDetailProjectionV1Schema,
	ExecutionDetailProjectionV2Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
	type ConversationRoutesDependencies,
	registerConversationRoutes,
} from "./conversation-routes.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user-1",
	displayName: "Ada",
	accountStatus: "active" as const,
	organizationIds: ["org-1"],
	roles: ["employee" as const],
	authorizationRevision: "authorization-1",
};

const authority = {
	schemaVersion: 1 as const,
	actorId: identity.userId,
	agentId: "agent-1",
	channelId: "web",
	authorizationRevision: identity.authorizationRevision,
	supportsSupplementaryInstruction: true,
};

const conversation = {
	conversationId: "conversation-1",
	agentId: "agent-1",
	status: "active" as const,
	lastConversationCursor: "cursor-1",
	createdAt: new Date("2026-09-06T00:00:00.000Z"),
	updatedAt: new Date("2026-09-06T00:01:00.000Z"),
};

const persistedEvent = {
	eventId: "event-1",
	conversationId: conversation.conversationId,
	executionId: "execution-1",
	sequence: 1,
	conversationCursor: "cursor-1",
	eventType: "text.delta",
	eventPayload: { type: "text.delta", text: "Hello" },
	occurredAt: new Date("2026-09-06T00:00:02.000Z"),
	traceId: "trace-1",
};

function dependencies(
	overrides: Partial<ConversationRoutesDependencies> = {},
): ConversationRoutesDependencies {
	const commands = {
		createConversation: vi.fn().mockResolvedValue({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				conversationId: conversation.conversationId,
				agentId: conversation.agentId,
				status: "ready",
			},
		}),
		accept: vi.fn().mockResolvedValue({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				status: "submitted",
				messageId: "message-1",
				executionId: "execution-1",
			},
		}),
		regenerate: vi.fn().mockResolvedValue({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				status: "submitted",
				messageId: null,
				executionId: "execution-2",
			},
		}),
		stop: vi.fn().mockResolvedValue({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				status: "submitted",
				executionId: "execution-1",
			},
		}),
		selectModel: vi.fn().mockResolvedValue({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				conversationId: conversation.conversationId,
			},
		}),
		readConversation: vi.fn().mockResolvedValue({
			outcome: "found",
			result: {
				schemaVersion: 1,
				conversation: {
					schemaVersion: 1,
					conversationId: conversation.conversationId,
					agentId: conversation.agentId,
					actorId: identity.userId,
					channelId: "web",
					status: conversation.status,
					sandboxReady: false,
					sessionGeneration: 1,
					hostSessionRef: null,
					authorizationRevision: identity.authorizationRevision,
					lastConversationCursor: 1,
					selectedModelOptionId: "model-primary",
					selectedReasoningLevel: "medium",
					createdAt: conversation.createdAt,
					updatedAt: conversation.updatedAt,
				},
				modelSelectionFallback: null,
			},
		}),
	};
	return {
		identity: {
			resolve: vi.fn().mockResolvedValue(identity),
			hydrateUsers: vi.fn().mockResolvedValue([]),
		},
		authorization: {
			authorize: vi.fn().mockResolvedValue({ outcome: "allowed", authority }),
		},
		commands: vi.fn().mockReturnValue(commands),
		query: {
			list: vi.fn().mockResolvedValue({
				items: [conversation],
				nextCursor: null,
			}),
			get: vi.fn().mockResolvedValue({
				conversation,
				messages: [
					{
						messageId: "message-1",
						text: "Run it",
						executionId: "execution-1",
						status: "submitted",
						createdAt: new Date("2026-09-06T00:00:01.000Z"),
					},
				],
				executions: [
					{
						executionId: "execution-1",
						conversationId: conversation.conversationId,
						sourceMessageId: "message-1",
						status: "completed",
						createdAt: new Date("2026-09-06T00:00:01.000Z"),
						updatedAt: new Date("2026-09-06T00:00:03.000Z"),
						traceId: "trace-1",
					},
				],
				events: [persistedEvent],
			}),
			getExecution: vi.fn().mockResolvedValue({
				execution: {
					executionId: "execution-1",
					conversationId: conversation.conversationId,
					sourceMessageId: "message-1",
					status: "completed",
					createdAt: new Date("2026-09-06T00:00:01.000Z"),
					updatedAt: new Date("2026-09-06T00:00:03.000Z"),
					traceId: "trace-1",
				},
				events: [
					{
						...persistedEvent,
						eventType: "execution.status",
						eventPayload: { type: "execution.status", status: "completed" },
					},
				],
			}),
			replay: vi
				.fn()
				.mockResolvedValueOnce({
					outcome: "events",
					events: [persistedEvent],
					resumeCursor: "cursor-1",
				})
				.mockResolvedValue({
					outcome: "reload",
					reason: "cursor_expired",
					resumeCursor: "cursor-1",
				}),
		},
		streamPollIntervalMs: 1,
		...overrides,
	};
}

function testApp(input = dependencies()) {
	const app = new Hono();
	registerConversationRoutes(app, input);
	return { app, dependencies: input };
}

const commandHeaders = {
	"content-type": "application/json",
	"Idempotency-Key": "Command.Aa-01",
};

describe("Conversation HTTP routes", () => {
	it("serves V2 detail and execution projections with durable events", async () => {
		const { app } = testApp();
		const detail = await app.request("/api/v2/conversations/conversation-1");
		const execution = await app.request(
			"/api/v2/conversations/conversation-1/executions/execution-1",
		);
		expect(detail.status).toBe(200);
		expect(execution.status).toBe(200);
		const detailBody = ConversationDetailProjectionV2Schema.parse(
			await detail.json(),
		);
		const executionBody = ExecutionDetailProjectionV2Schema.parse(
			await execution.json(),
		);
		expect(detailBody.conversation.sandboxReady).toBe(false);
		expect(detailBody.events).toHaveLength(1);
		expect(executionBody.events).toHaveLength(1);
	});

	it("keeps V2 conversation and execution reads actor-scoped", async () => {
		const input = dependencies();
		input.commands(identity).readConversation = vi
			.fn()
			.mockResolvedValue({ outcome: "denied" });
		for (const path of [
			"/api/v2/conversations/conversation-1",
			"/api/v2/conversations/conversation-1/executions/execution-1",
		]) {
			const response = await testApp(input).app.request(path);
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({
				code: "RESOURCE_UNAVAILABLE",
			});
		}
		expect(input.query.get).not.toHaveBeenCalled();
		expect(input.query.getExecution).not.toHaveBeenCalled();
	});

	it("maps generated command requests to the Core seam without caller identity", async () => {
		const { app, dependencies: input } = testApp();
		const create = await app.request("/api/v1/agents/agent-1/conversations", {
			method: "POST",
			headers: commandHeaders,
			body: JSON.stringify({ schemaVersion: 1 }),
		});
		const message = await app.request(
			"/api/v1/conversations/conversation-1/messages",
			{
				method: "POST",
				headers: commandHeaders,
				body: JSON.stringify({ schemaVersion: 1, text: "Run it" }),
			},
		);
		const regenerate = await app.request(
			"/api/v1/conversations/conversation-1/regenerations",
			{
				method: "POST",
				headers: commandHeaders,
				body: JSON.stringify({ schemaVersion: 1, messageId: "message-1" }),
			},
		);
		const stop = await app.request(
			"/api/v1/conversations/conversation-1/stops",
			{
				method: "POST",
				headers: commandHeaders,
				body: JSON.stringify({
					schemaVersion: 1,
					targetExecutionId: "execution-1",
				}),
			},
		);
		const selection = await app.request(
			"/api/v1/conversations/conversation-1/model-selection",
			{
				method: "PUT",
				headers: commandHeaders,
				body: JSON.stringify({
					schemaVersion: 1,
					modelOptionId: "model-primary",
					reasoningLevel: "medium",
				}),
			},
		);

		expect([
			create.status,
			message.status,
			regenerate.status,
			stop.status,
			selection.status,
		]).toEqual([201, 202, 202, 202, 200]);
		expect(await stop.json()).toMatchObject({
			messageId: null,
			executionId: "execution-1",
		});
		expect(await selection.json()).toMatchObject({
			selectedModelOptionId: "model-primary",
			selectedReasoningLevel: "medium",
		});
		expect(input.commands).toHaveBeenCalledTimes(5);
		const command = input.commands(identity);
		expect(command.accept).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conversation-1",
				text: "Run it",
				idempotencyKey: "Command.Aa-01",
			}),
		);
		expect(command.accept).not.toHaveBeenCalledWith(
			expect.objectContaining({ actorId: expect.anything() }),
		);
		expect(command.selectModel).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "model.select",
				modelOptionId: "model-primary",
				reasoningLevel: "medium",
			}),
		);
	});

	it("rejects caller identity, invalid idempotency, and busy commands with redacted errors", async () => {
		const busy = dependencies();
		busy.commands(identity).accept = vi
			.fn()
			.mockResolvedValue({ outcome: "busy" });
		const { app } = testApp(busy);
		const injected = await app.request(
			"/api/v1/conversations/conversation-1/messages",
			{
				method: "POST",
				headers: commandHeaders,
				body: JSON.stringify({
					schemaVersion: 1,
					text: "Run it",
					actorId: "user-2",
				}),
			},
		);
		const invalidKey = await app.request(
			"/api/v1/conversations/conversation-1/messages",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ schemaVersion: 1, text: "Run it" }),
			},
		);
		const busyResponse = await app.request(
			"/api/v1/conversations/conversation-1/messages",
			{
				method: "POST",
				headers: commandHeaders,
				body: JSON.stringify({ schemaVersion: 1, text: "Run it" }),
			},
		);

		expect([injected.status, invalidKey.status, busyResponse.status]).toEqual([
			400, 400, 409,
		]);
		const error = PilotProtocolErrorV1Schema.parse(await busyResponse.json());
		expect(error).toMatchObject({ code: "AGENT_BUSY", retryable: true });
		expect(JSON.stringify(error)).not.toContain("Run it");
	});

	it("maps temporarily unavailable Agent commands to a retryable Runtime error", async () => {
		const input = dependencies({
			authorization: {
				authorize: vi.fn().mockResolvedValue({ outcome: "unavailable" }),
			},
		});
		const command = input.commands(identity);
		command.createConversation = vi
			.fn()
			.mockResolvedValue({ outcome: "denied" });
		command.accept = vi.fn().mockResolvedValue({ outcome: "denied" });
		command.regenerate = vi.fn().mockResolvedValue({ outcome: "denied" });
		const { app } = testApp(input);
		const responses = await Promise.all([
			app.request("/api/v1/agents/agent-1/conversations", {
				method: "POST",
				headers: commandHeaders,
				body: JSON.stringify({ schemaVersion: 1 }),
			}),
			app.request("/api/v1/conversations/conversation-1/messages", {
				method: "POST",
				headers: commandHeaders,
				body: JSON.stringify({ schemaVersion: 1, text: "Run it" }),
			}),
			app.request("/api/v1/conversations/conversation-1/regenerations", {
				method: "POST",
				headers: commandHeaders,
				body: JSON.stringify({ schemaVersion: 1, messageId: "message-1" }),
			}),
		]);

		expect(responses.map(({ status }) => status)).toEqual([503, 503, 503]);
		for (const response of responses) {
			expect(await response.json()).toMatchObject({
				code: "RUNTIME_UNAVAILABLE",
				retryable: true,
			});
		}
	});

	it("returns actor-scoped history, timeline, and execution details", async () => {
		const { app, dependencies: input } = testApp();
		const list = await app.request("/api/v1/agents/agent-1/conversations");
		const detail = await app.request("/api/v1/conversations/conversation-1");
		const execution = await app.request(
			"/api/v1/conversations/conversation-1/executions/execution-1",
		);

		expect(list.status).toBe(200);
		expect(await list.json()).toMatchObject({
			items: [{ conversationId: "conversation-1", title: null }],
		});
		const timeline = ConversationDetailProjectionV1Schema.parse(
			await detail.json(),
		);
		expect(timeline.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "user", text: "Run it" }),
				expect.objectContaining({ role: "assistant", text: "Hello" }),
			]),
		);
		expect(
			ExecutionDetailProjectionV1Schema.parse(await execution.json()),
		).toMatchObject({ status: "completed", error: null });
		expect(input.query.get).toHaveBeenCalledWith(
			{ actorId: "user-1", channelId: "web" },
			"conversation-1",
		);
	});

	it("uses the authoritative Core status across a normal read transition", async () => {
		const input = dependencies();
		const current = await input.query.get(
			{ actorId: identity.userId, channelId: "web" },
			"conversation-1",
		);
		if (!current) throw new Error("Expected Conversation fixture");
		input.query.get = vi.fn().mockResolvedValue({
			...current,
			conversation: { ...conversation, status: "ready" },
		});

		const response = await testApp(input).app.request(
			"/api/v1/conversations/conversation-1",
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			conversation: { status: "active" },
		});
	});

	it("exposes the persisted supplementary delivery failure reason", async () => {
		const input = dependencies();
		const current = await input.query.get(
			{ actorId: identity.userId, channelId: "web" },
			"conversation-1",
		);
		if (!current) throw new Error("Expected Conversation fixture");
		input.query.get = vi.fn().mockResolvedValue({
			...current,
			messages: [
				{
					...current.messages[0],
					status: "failed",
					failureCode: "ORIGINAL_RESPONSE_NOT_STARTED",
				},
			],
		});

		const response = await testApp(input).app.request(
			"/api/v1/conversations/conversation-1",
		);
		const detail = ConversationDetailProjectionV1Schema.parse(
			await response.json(),
		);

		expect(response.status).toBe(200);
		expect(detail.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "user",
					status: "failed",
					error: expect.objectContaining({
						code: "ORIGINAL_RESPONSE_NOT_STARTED",
					}),
				}),
			]),
		);
	});

	it("maps an authorized unavailable Conversation without exposing internals", async () => {
		const input = dependencies();
		input.commands(identity).accept = vi
			.fn()
			.mockResolvedValue({ outcome: "denied" });
		const current = await input.query.get(
			{ actorId: identity.userId, channelId: "web" },
			"conversation-1",
		);
		if (!current) throw new Error("Expected Conversation fixture");
		input.query.get = vi.fn().mockResolvedValue({
			...current,
			conversation: { ...conversation, status: "unavailable" },
		});
		const response = await testApp(input).app.request(
			"/api/v1/conversations/conversation-1/messages",
			{
				method: "POST",
				headers: commandHeaders,
				body: JSON.stringify({ schemaVersion: 1, text: "Run it" }),
			},
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code: "CONVERSATION_UNAVAILABLE",
			retryable: false,
		});
	});

	it("does not inspect an actor-scoped row after Conversation access is revoked", async () => {
		const input = dependencies({
			authorization: {
				authorize: vi.fn().mockResolvedValue({ outcome: "denied" }),
			},
		});
		input.commands(identity).accept = vi
			.fn()
			.mockResolvedValue({ outcome: "denied" });
		const get = vi.fn().mockResolvedValue({
			conversation: { ...conversation, status: "unavailable" },
			messages: [],
			executions: [],
			events: [],
		});
		input.query.get = get;

		const response = await testApp(input).app.request(
			"/api/v1/conversations/conversation-1/messages",
			{
				method: "POST",
				headers: commandHeaders,
				body: JSON.stringify({ schemaVersion: 1, text: "Run it" }),
			},
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			code: "RESOURCE_UNAVAILABLE",
		});
		expect(get).not.toHaveBeenCalled();
	});

	it("makes missing and forbidden conversations indistinguishable", async () => {
		for (const conversationId of [
			"conversation-private",
			"conversation-missing",
		]) {
			const input = dependencies();
			input.commands(identity).readConversation = vi
				.fn()
				.mockResolvedValue({ outcome: "denied" });
			const response = await testApp(input).app.request(
				`/api/v1/conversations/${conversationId}`,
			);
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({
				code: "RESOURCE_UNAVAILABLE",
			});
		}
	});

	it("fails closed when an authorization Adapter changes the trusted actor", async () => {
		const input = dependencies({
			authorization: {
				authorize: vi.fn().mockResolvedValue({
					outcome: "allowed",
					authority: { ...authority, actorId: "user-other" },
				}),
			},
		});
		const response = await testApp(input).app.request(
			"/api/v1/agents/agent-1/conversations",
		);

		expect(response.status).toBe(503);
		expect(JSON.stringify(await response.json())).not.toContain("user-other");
	});
});

describe("Conversation persisted SSE", () => {
	const operationEvent = {
		...persistedEvent,
		eventSchemaVersion: 2 as const,
		eventId: "operation-event-2",
		sequence: 2,
		conversationCursor: "cursor-2",
		eventType: "execution.operation",
		eventPayload: {
			kind: "model",
			operationRef: "model-operation-1",
			attemptRef: "model-attempt-1",
			phase: "intent",
			model: {
				configVersion: "revision-1",
				modelOptionId: "option-1",
				modelId: "model-1",
				reasoningLevel: "medium",
			},
		},
	};
	it("keeps V1 details readable when V2 operation facts are persisted", async () => {
		const input = dependencies();
		const scope = { actorId: identity.userId, channelId: "web" };
		const detail = await input.query.get(scope, conversation.conversationId);
		const execution = await input.query.getExecution(
			scope,
			conversation.conversationId,
			"execution-1",
		);
		if (!detail || !execution) throw new Error("Missing detail fixture");
		input.query.get = vi.fn().mockResolvedValue({
			...detail,
			events: [...detail.events, operationEvent],
		});
		input.query.getExecution = vi.fn().mockResolvedValue({
			...execution,
			events: [...execution.events, operationEvent],
		});
		const { app } = testApp(input);
		const v1Detail = await app.request("/api/v1/conversations/conversation-1");
		const v1Execution = await app.request(
			"/api/v1/conversations/conversation-1/executions/execution-1",
		);
		expect(v1Detail.status).toBe(200);
		expect(v1Execution.status).toBe(200);
		expect(
			ConversationDetailProjectionV1Schema.parse(await v1Detail.json()),
		).toHaveProperty("messages");
		expect(
			ExecutionDetailProjectionV1Schema.parse(await v1Execution.json()),
		).toHaveProperty("processSummary");
	});
	it("preserves mixed V2 history in details and cursor replay", async () => {
		const input = dependencies();
		const scope = { actorId: identity.userId, channelId: "web" };
		const detail = await input.query.get(scope, conversation.conversationId);
		const execution = await input.query.getExecution(
			scope,
			conversation.conversationId,
			"execution-1",
		);
		if (!detail || !execution) throw new Error("Missing detail fixture");
		const events = [persistedEvent, operationEvent];
		input.query.get = vi.fn().mockResolvedValue({ ...detail, events });
		input.query.getExecution = vi
			.fn()
			.mockResolvedValue({ ...execution, events });
		input.query.replay = vi
			.fn()
			.mockResolvedValueOnce({
				outcome: "events",
				events: [operationEvent],
				resumeCursor: "cursor-2",
			})
			.mockResolvedValue({
				outcome: "reload",
				reason: "cursor_expired",
				resumeCursor: "cursor-2",
			});
		const { app } = testApp(input);
		const history = ConversationDetailProjectionV2Schema.parse(
			await (await app.request("/api/v2/conversations/conversation-1")).json(),
		);
		const executionHistory = ExecutionDetailProjectionV2Schema.parse(
			await (
				await app.request(
					"/api/v2/conversations/conversation-1/executions/execution-1",
				)
			).json(),
		);
		expect(
			history.events.map((event) => [event.schemaVersion, event.eventId]),
		).toEqual([
			[1, "event-1"],
			[2, "operation-event-2"],
		]);
		expect(executionHistory.events).toEqual(history.events);
		const response = await app.request(
			"/api/v2/conversations/conversation-1/events?cursor=cursor-1",
		);
		const messages = (await response.text())
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) =>
				ConversationSseMessageV2Schema.parse(JSON.parse(line.slice(6))),
			);
		expect(messages.filter((message) => message.kind === "event")).toEqual([
			history.events[1],
		]);
		expect(input.query.replay).toHaveBeenNthCalledWith(
			1,
			scope,
			"conversation-1",
			{ kind: "cursor", value: "cursor-1" },
		);
	});
	it("keeps V1 streaming after validated V2 facts using the original cursor", async () => {
		const query = dependencies().query;
		query.replay = vi
			.fn()
			.mockResolvedValueOnce({
				outcome: "events",
				events: [persistedEvent, operationEvent],
				resumeCursor: "cursor-2",
			})
			.mockResolvedValueOnce({
				outcome: "events",
				events: [
					{
						...persistedEvent,
						eventId: "event-3",
						sequence: 3,
						conversationCursor: "cursor-3",
						eventPayload: { type: "text.delta", text: "after operation" },
					},
				],
				resumeCursor: "cursor-3",
			})
			.mockResolvedValue({
				outcome: "reload",
				reason: "cursor_expired",
				resumeCursor: "cursor-3",
			});
		const response = await testApp(dependencies({ query })).app.request(
			"/api/v1/conversations/conversation-1/events",
		);
		expect(response.status).toBe(200);
		const stream = await response.text();
		const messages = stream
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) =>
				ConversationSseMessageV1Schema.parse(JSON.parse(line.slice(6))),
			);
		expect(
			messages
				.filter((message) => message.kind === "event")
				.map((message) => message.eventId),
		).toEqual(["event-1", "event-3"]);
		expect(stream).not.toContain("operation-event-2");
		expect(query.replay).toHaveBeenNthCalledWith(
			2,
			{ actorId: identity.userId, channelId: "web" },
			conversation.conversationId,
			{ kind: "cursor", value: "cursor-2" },
		);
	});
	it.each([
		{ eventSchemaVersion: undefined },
		{
			eventPayload: { ...operationEvent.eventPayload, secret: "must-not-pass" },
		},
		{ eventId: "invalid\nevent" },
		{ sequence: 0 },
	])("rejects malformed V2 facts before V1 streaming: %j", async (change) => {
		const query = dependencies().query;
		query.replay = vi.fn().mockResolvedValue({
			outcome: "events",
			events: [{ ...operationEvent, ...change }],
			resumeCursor: "cursor-2",
		});
		const response = await testApp(dependencies({ query })).app.request(
			"/api/v1/conversations/conversation-1/events",
		);
		expect(response.status).toBe(503);
	});
	it("maps the persisted model fallback notice without local policy", async () => {
		const input = dependencies();
		input.query.replay = vi
			.fn()
			.mockResolvedValueOnce({
				outcome: "events",
				events: [
					{
						...persistedEvent,
						eventType: "model.selection.fell_back",
						eventPayload: {
							type: "model.selection.fell_back",
							modelOptionId: "model-primary",
							reasoningLevel: "medium",
							reason: "selection_unavailable",
						},
					},
				],
				resumeCursor: "cursor-1",
			})
			.mockResolvedValue({
				outcome: "reload",
				reason: "cursor_expired",
				resumeCursor: "cursor-1",
			});

		const response = await testApp(input).app.request(
			"/api/v1/conversations/conversation-1/events",
		);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toContain('"type":"model.selection.fell_back"');
		expect(body).toContain(
			'"payload":{"modelOptionId":"model-primary","reasoningLevel":"medium","reason":"selection_unavailable"}',
		);
		expect(body).not.toContain("previousModelOptionId");
		expect(body).not.toContain("nativeModelId");
		expect(body).not.toContain("credential");
	});

	it("redacts Runtime error codes into the browser protocol", async () => {
		const input = dependencies();
		input.query.replay = vi
			.fn()
			.mockResolvedValueOnce({
				outcome: "events",
				events: [
					{
						...persistedEvent,
						eventType: "conversation.error",
						eventPayload: {
							type: "conversation.error",
							code: "fixture_error",
							message: "private Runtime failure detail",
							retryable: false,
						},
					},
				],
				resumeCursor: "cursor-1",
			})
			.mockResolvedValue({
				outcome: "reload",
				reason: "cursor_expired",
				resumeCursor: "cursor-1",
			});

		const response = await testApp(input).app.request(
			"/api/v1/conversations/conversation-1/events",
		);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toContain('"code":"EXECUTION_FAILED"');
		expect(body).not.toContain("fixture_error");
		expect(body).not.toContain("private Runtime failure detail");
	});

	it("resolves Last-Event-ID, rechecks authorization before each event, and emits reload", async () => {
		const input = dependencies();
		const response = await testApp(input).app.request(
			"/api/v1/conversations/conversation-1/events",
			{ headers: { "Last-Event-ID": "event-before" } },
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const body = await response.text();
		expect(body).toContain("id: event-1");
		expect(body).toContain('"type":"text.delta"');
		expect(body).toContain('"type":"timeline.reload"');
		expect(input.query.replay).toHaveBeenNthCalledWith(
			1,
			{ actorId: "user-1", channelId: "web" },
			"conversation-1",
			{ kind: "last-event-id", value: "event-before" },
		);
		expect(input.authorization.authorize).toHaveBeenCalledTimes(4);
	});

	it.each([1, 2])(
		"classifies current idle identity failures without replay on V%d",
		async (version) => {
			for (const [value, reason] of [
				[{ ...identity, accountStatus: "disabled" }, "disabled"],
				[null, "session_invalid"],
				[{ ...identity, userId: "other-subject" }, "subject_changed"],
				[{ ...identity, roles: "invalid-private-value" }, "invalid_response"],
			] as const) {
				const input = dependencies();
				input.identity.resolve = vi
					.fn()
					.mockResolvedValueOnce(identity)
					.mockResolvedValue(value);
				input.query.replay = vi.fn().mockResolvedValue({
					outcome: "events",
					events: [],
					resumeCursor: "cursor-secret",
				});
				const response = await testApp(input).app.request(
					`/api/v${version}/conversations/conversation-1/events`,
				);
				const body = await response.text();
				expect(body).toContain(`: conversation-stream.closed ${reason}`);
				expect(body.includes("authorization.revoked")).toBe(
					reason !== "invalid_response",
				);
				expect(body).not.toMatch(
					/other-subject|invalid-private-value|cursor-secret|conversation-1/,
				);
				expect(input.query.replay).toHaveBeenCalledTimes(1);
			}
		},
	);

	it.each(["identity", "authorization", "replay"] as const)(
		"bounds a hanging %s read and ignores its late result",
		async (dependency) => {
			const input = dependencies({
				streamPollIntervalMs: 5,
				streamReadTimeoutMs: 10,
			});
			let release!: (value: never) => void;
			const pending = new Promise<never>((resolve) => {
				release = resolve;
			});
			input.query.replay = vi.fn().mockResolvedValue({
				outcome: "events",
				events: [],
				resumeCursor: "cursor-1",
			});
			if (dependency === "identity")
				input.identity.resolve = vi
					.fn()
					.mockResolvedValueOnce(identity)
					.mockReturnValue(pending);
			if (dependency === "authorization")
				input.authorization.authorize = vi
					.fn()
					.mockResolvedValueOnce({ outcome: "allowed", authority })
					.mockReturnValue(pending);
			if (dependency === "replay")
				input.query.replay = vi
					.fn()
					.mockResolvedValueOnce({
						outcome: "events",
						events: [],
						resumeCursor: "cursor-1",
					})
					.mockReturnValue(pending);
			const started = performance.now();
			const response = await testApp(input).app.request(
				"/api/v2/conversations/conversation-1/events",
			);
			expect(await response.text()).toBe(
				": conversation-stream.closed dependency_unavailable\n\n",
			);
			expect(performance.now() - started).toBeLessThan(500);
			release(undefined as never);
		},
	);

	it("keeps polling an empty timeline and resumes only after fresh authorization", async () => {
		const input = dependencies();
		input.query.replay = vi
			.fn()
			.mockResolvedValueOnce({
				outcome: "events",
				events: [],
				resumeCursor: "cursor-0",
			})
			.mockResolvedValueOnce({
				outcome: "events",
				events: [],
				resumeCursor: "cursor-0",
			})
			.mockResolvedValueOnce({
				outcome: "events",
				events: [persistedEvent],
				resumeCursor: "cursor-1",
			})
			.mockResolvedValue(undefined);
		const response = await testApp(input).app.request(
			"/api/v2/conversations/conversation-1/events?cursor=cursor-0",
		);
		const body = await response.text();
		expect(body).toContain("id: event-1");
		expect(body).toContain(": conversation-stream.closed resource_unavailable");
		expect(body).not.toContain("authorization.revoked");
		expect(input.identity.resolve).toHaveBeenCalledTimes(5);
		expect(input.authorization.authorize).toHaveBeenCalledTimes(5);
		expect(input.query.replay).toHaveBeenLastCalledWith(
			{ actorId: identity.userId, channelId: "web" },
			"conversation-1",
			{ kind: "cursor", value: "cursor-1" },
		);
	});

	it.each([1, 2])(
		"discards authorization resolved after disconnect on V%d",
		async (version) => {
			const controller = new AbortController();
			const input = dependencies();
			input.authorization.authorize = vi
				.fn()
				.mockResolvedValueOnce({ outcome: "allowed", authority })
				.mockImplementation(async () => {
					controller.abort();
					return { outcome: "allowed", authority };
				});
			const response = await testApp(input).app.request(
				`/api/v${version}/conversations/conversation-1/events`,
				{ signal: controller.signal },
			);
			expect(await response.text()).toBe("");
			expect(input.query.replay).toHaveBeenCalledTimes(1);
		},
	);

	it.each([1, 2])(
		"closes invalid authorization responses without claiming revocation on V%d",
		async (version) => {
			for (const invalid of [
				null,
				{ outcome: "unknown" },
				{ outcome: "allowed", authority: { ...authority, actorId: "foreign" } },
			]) {
				const input = dependencies();
				input.authorization.authorize = vi
					.fn()
					.mockResolvedValueOnce({ outcome: "allowed", authority })
					.mockResolvedValue(invalid);
				const response = await testApp(input).app.request(
					`/api/v${version}/conversations/conversation-1/events`,
				);
				expect(await response.text()).toBe(
					": conversation-stream.closed invalid_response\n\n",
				);
			}
		},
	);

	it("reauthorizes cursor reconnect after dependency recovery and rejects a switched subject", async () => {
		const input = dependencies();
		let outage = true;
		let switched = false;
		input.authorization.authorize = vi.fn().mockImplementation(async () => {
			if (outage) throw new Error("private outage");
			return switched
				? { outcome: "denied" }
				: { outcome: "allowed", authority };
		});
		const app = testApp(input).app;
		const target =
			"/api/v2/conversations/conversation-1/events?cursor=cursor-1";
		expect((await app.request(target)).status).toBe(503);
		expect(input.query.replay).not.toHaveBeenCalled();
		outage = false;
		const recovered = await app.request(target);
		expect(await recovered.text()).toContain("id: event-1");
		const reads = vi.mocked(input.query.replay).mock.calls.length;
		switched = true;
		input.identity.resolve = vi
			.fn()
			.mockResolvedValue({ ...identity, userId: "other-subject" });
		const denied = await app.request(target);
		expect(denied.status).toBe(404);
		expect(await denied.text()).not.toContain("conversation-1");
		expect(input.query.replay).toHaveBeenCalledTimes(reads);
	});

	it.each([1, 2])(
		"reauthorizes stopped execution replay when revocation races a stop on V%d",
		async (version) => {
			const input = dependencies();
			const pendingReplay = Promise.withResolvers<void>();
			const releaseReplay = Promise.withResolvers<void>();
			const controller = new AbortController();
			let revoked = false;
			input.authorization.authorize = vi
				.fn()
				.mockImplementation(async () =>
					revoked ? { outcome: "revoked" } : { outcome: "allowed", authority },
				);
			input.query.replay = vi
				.fn()
				.mockResolvedValueOnce({
					outcome: "events",
					events: [],
					resumeCursor: "cursor-0",
				})
				.mockImplementation(async () => {
					pendingReplay.resolve();
					await releaseReplay.promise;
					return {
						outcome: "events",
						events: [
							{
								...persistedEvent,
								eventType: "execution.status",
								eventPayload: { type: "execution.status", status: "cancelled" },
							},
						],
						resumeCursor: "cursor-1",
					};
				});
			const app = testApp(input).app;
			try {
				const response = await app.request(
					`/api/v${version}/conversations/conversation-1/events?cursor=cursor-0`,
					{ signal: controller.signal },
				);
				await pendingReplay.promise;
				const stop = await app.request(
					"/api/v1/conversations/conversation-1/stops",
					{
						method: "POST",
						headers: commandHeaders,
						body: JSON.stringify({
							schemaVersion: 1,
							targetExecutionId: "execution-1",
						}),
					},
				);
				expect(stop.status).toBe(202);
				expect(input.commands).toHaveBeenCalledWith(identity);
				// Stop acceptance cannot preserve the stream's prior authorization.
				revoked = true;
				releaseReplay.resolve();
				const body = await response.text();
				expect(body).toContain(": conversation-stream.closed revoked");
				expect(body).toContain("authorization.revoked");
				expect(body).not.toMatch(/execution.status|cancelled|event-1|cursor-1/);
				expect(input.query.replay).toHaveBeenCalledTimes(2);
			} finally {
				controller.abort();
				releaseReplay.resolve();
			}
		},
	);

	it("closes a real HTTP idle SSE connection within the configured detection budget", async () => {
		const poll = 30;
		const timeout = 50;
		const input = dependencies({
			streamPollIntervalMs: poll,
			streamReadTimeoutMs: timeout,
		});
		let revoked = false;
		input.authorization.authorize = vi
			.fn()
			.mockImplementation(async () =>
				revoked ? { outcome: "revoked" } : { outcome: "allowed", authority },
			);
		input.query.replay = vi
			.fn()
			.mockResolvedValueOnce({
				outcome: "events",
				events: [persistedEvent],
				resumeCursor: "cursor-1",
			})
			.mockResolvedValue({
				outcome: "events",
				events: [],
				resumeCursor: "cursor-1",
			});
		const app = testApp(input).app;
		const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
		const controller = new AbortController();
		try {
			if (!server.listening)
				await new Promise<void>((resolve) => server.once("listening", resolve));
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("Missing test listener");
			const response = await fetch(
				`http://127.0.0.1:${address.port}/api/v2/conversations/conversation-1/events`,
				{ signal: controller.signal },
			);
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Missing SSE body");
			expect(new TextDecoder().decode((await reader.read()).value)).toContain(
				"id: event-1",
			);
			// Remain idle for multiple complete authorization/replay cycles.
			await delay(poll * 4);
			expect(
				vi.mocked(input.query.replay).mock.calls.length,
			).toBeGreaterThanOrEqual(3);
			const reads = vi.mocked(input.query.replay).mock.calls.length;
			const started = performance.now();
			revoked = true;
			let terminal = "";
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				terminal += new TextDecoder().decode(chunk.value);
			}
			// Scheduling slack is explicit; logical budget is poll + two bounded reads.
			expect(performance.now() - started).toBeLessThan(
				poll + 2 * timeout + 200,
			);
			expect(terminal).toContain("authorization.revoked");
			expect(terminal).not.toMatch(/event-1|heartbeat|cursor-1/);
			expect(input.query.replay).toHaveBeenCalledTimes(reads);
		} finally {
			controller.abort();
			if ("closeAllConnections" in server) server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("aborts a backpressured SSE writer instead of retaining stale authorization", async () => {
		const input = dependencies({
			streamPollIntervalMs: 5,
			streamReadTimeoutMs: 10,
		});
		input.query.replay = vi.fn().mockResolvedValue({
			outcome: "events",
			events: Array.from({ length: 20 }, (_, index) => ({
				...persistedEvent,
				eventId: `event-${index + 1}`,
				sequence: index + 1,
				conversationCursor: `cursor-${index + 1}`,
			})),
			resumeCursor: "cursor-20",
		});
		const response = await testApp(input).app.request(
			"/api/v2/conversations/conversation-1/events",
		);
		// Deliberately do not consume the response until the writer deadline expires.
		await delay(80);
		const checks = vi.mocked(input.authorization.authorize).mock.calls.length;
		expect(checks).toBeLessThan(21);
		const body = await response.text();
		expect(body).not.toContain("event-20");
		expect(input.query.replay).toHaveBeenCalledTimes(1);
		await delay(20);
		expect(input.authorization.authorize).toHaveBeenCalledTimes(checks);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 30001])(
		"rejects invalid idle/read bounds: %s",
		(value) => {
			expect(() =>
				testApp(dependencies({ streamPollIntervalMs: value })),
			).toThrow("intervals");
			expect(() =>
				testApp(dependencies({ streamReadTimeoutMs: value })),
			).toThrow("intervals");
		},
	);

	it.each([1, 2])(
		"reauthorizes an idle stream before reading the next replay on V%d",
		async (version) => {
			const input = dependencies();
			input.query.replay = vi
				.fn()
				.mockResolvedValueOnce({
					outcome: "events",
					events: [],
					resumeCursor: "cursor-1",
				})
				.mockResolvedValue(undefined);
			input.authorization.authorize = vi
				.fn()
				.mockResolvedValueOnce({ outcome: "allowed", authority })
				.mockResolvedValue({ outcome: "revoked" });
			const response = await testApp(input).app.request(
				`/api/v${version}/conversations/conversation-1/events`,
			);
			const body = await response.text();
			expect(body).toContain('"type":"authorization.revoked"');
			expect(input.identity.resolve).toHaveBeenCalledTimes(2);
			expect(input.query.replay).toHaveBeenCalledTimes(1);
			expect(body).not.toContain("cursor-1");
		},
	);

	it.each([1, 2])(
		"stops before the next push when current access is revoked on V%d",
		async (version) => {
			const authorize = vi
				.fn()
				.mockResolvedValueOnce({ outcome: "allowed", authority })
				.mockResolvedValueOnce({ outcome: "denied" });
			const input = dependencies({ authorization: { authorize } });
			const response = await testApp(input).app.request(
				`/api/v${version}/conversations/conversation-1/events`,
			);
			const body = await response.text();

			expect(body).not.toContain("id: event-1");
			expect(body).toContain('"type":"authorization.revoked"');
			expect(body).toContain('"code":"AUTHORIZATION_REVOKED"');
			expect(body).not.toContain("user-1");
		},
	);

	it.each([1, 2])(
		"fails closed without misreporting a temporary authorization outage on V%d",
		async (version) => {
			const authorize = vi
				.fn()
				.mockResolvedValueOnce({ outcome: "allowed", authority })
				.mockRejectedValueOnce(new Error("private identity dependency detail"));
			const response = await testApp(
				dependencies({ authorization: { authorize } }),
			).app.request(`/api/v${version}/conversations/conversation-1/events`);
			const body = await response.text();

			expect(body).toBe(
				": conversation-stream.closed dependency_unavailable\n\n",
			);
			expect(body).not.toContain("authorization.revoked");
			expect(body).not.toContain("private identity dependency detail");
		},
	);

	it.each([
		{ version: 1, status: 403 },
		{ version: 2, status: 404 },
	])(
		"rejects ambiguous replay and non-enumerates V$version initial access",
		async ({ version, status }) => {
			const target = `/api/v${version}/conversations/conversation-private/events`;
			const ambiguous = await testApp().app.request(
				`${target}?cursor=cursor-1`,
				{
					headers: { "Last-Event-ID": "event-1" },
				},
			);
			expect(ambiguous.status).toBe(400);
			const denied = dependencies({
				authorization: {
					authorize: vi.fn().mockResolvedValue({ outcome: "denied" }),
				},
			});
			const forbidden = await testApp(denied).app.request(target);
			expect(forbidden.status).toBe(status);
			expect(await forbidden.json()).toMatchObject({
				code: "RESOURCE_UNAVAILABLE",
			});
			expect(denied.query.replay).not.toHaveBeenCalled();
			const missing = dependencies();
			missing.query.replay = vi.fn().mockResolvedValue(undefined);
			const unavailable = await testApp(missing).app.request(target);
			expect(unavailable.status).toBe(status);
			const body = await unavailable.text();
			expect(JSON.parse(body)).toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
			expect(body).not.toContain("conversation-private");
			expect(body).not.toContain(identity.userId);
		},
	);

	it.each([1, 2])(
		"never accepts malformed persisted data as an SSE event on V%d",
		async (version) => {
			const query = dependencies().query;
			query.replay = vi.fn().mockResolvedValue({
				outcome: "events",
				events: [
					{
						...persistedEvent,
						eventPayload: {
							type: "text.delta",
							text: "safe",
							secret: "must-not-pass",
						},
					},
				],
				resumeCursor: "cursor-1",
			});
			const response = await testApp(
				dependencies({ query, streamPollIntervalMs: 1 }),
			).app.request(`/api/v${version}/conversations/conversation-1/events`);

			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				code: "DEPENDENCY_UNAVAILABLE",
			});
		},
	);

	it("emits only messages accepted by the generated SSE schema", () => {
		expect(
			ConversationSseMessageV1Schema.parse({
				schemaVersion: 1,
				kind: "event",
				eventId: "event-1",
				conversationId: "conversation-1",
				executionId: "execution-1",
				sequence: 1,
				conversationCursor: "cursor-1",
				occurredAt: "2026-09-06T00:00:02.000Z",
				type: "text.delta",
				payload: { text: "Hello" },
			}),
		).toBeDefined();
	});
});

describe("task boundary HTTP authorization", () => {
	const taskBoundary = {
		schemaVersion: 1 as const,
		principal: { kind: "user" as const, id: identity.userId },
		agentId: authority.agentId,
		channelId: "web",
		identityRevision: "current_directory",
		agentAuthorizationRevision: "agent_revision",
		accessSources: [{ kind: "user" as const, userId: identity.userId }],
	};
	it.each([
		{
			...taskBoundary,
			principal: { kind: "user", id: "other_user" },
			accessSources: [{ kind: "user", userId: "other_user" }],
		},
		{ ...taskBoundary, agentId: "other_agent" },
		{ ...taskBoundary, channelId: "other_channel" },
		{ ...taskBoundary, agentAuthorizationRevision: "other_revision" },
		{ ...taskBoundary, identityRevision: "" },
	])(
		"rejects a malformed or mismatched authority boundary",
		async (boundary) => {
			const deps = dependencies({
				authorization: {
					authorize: vi.fn().mockResolvedValue({
						outcome: "allowed",
						authority: {
							...authority,
							authorizationRevision: "agent_revision",
							taskBoundary: boundary,
						},
					}),
				},
			});
			const app = new Hono();
			registerConversationRoutes(app, deps);
			const response = await app.request(
				"/api/v1/agents/agent-1/conversations",
			);
			expect(response.status).toBe(503);
			expect(deps.query.list).not.toHaveBeenCalled();
		},
	);

	it("fails closed when authorization returns a null authority", async () => {
		const deps = dependencies({
			authorization: {
				authorize: vi.fn().mockResolvedValue({
					outcome: "allowed",
					authority: null as never,
				}),
			},
		});
		const app = new Hono();
		registerConversationRoutes(app, deps);
		const response = await app.request("/api/v1/agents/agent-1/conversations");
		expect(response.status).toBe(503);
		expect(deps.query.list).not.toHaveBeenCalled();
	});
});
