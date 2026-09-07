import {
	ConversationDetailProjectionV1Schema,
	ConversationSseMessageV1Schema,
	ExecutionDetailProjectionV1Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
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
		expect(input.authorization.authorize).toHaveBeenCalledTimes(3);
	});

	it("stops before the next push when current access is revoked", async () => {
		const authorize = vi
			.fn()
			.mockResolvedValueOnce({ outcome: "allowed", authority })
			.mockResolvedValueOnce({ outcome: "denied" });
		const input = dependencies({ authorization: { authorize } });
		const response = await testApp(input).app.request(
			"/api/v1/conversations/conversation-1/events",
		);
		const body = await response.text();

		expect(body).not.toContain("id: event-1");
		expect(body).toContain('"type":"authorization.revoked"');
		expect(body).toContain('"code":"AUTHORIZATION_REVOKED"');
		expect(body).not.toContain("user-1");
	});

	it("fails closed without misreporting a temporary authorization outage", async () => {
		const authorize = vi
			.fn()
			.mockResolvedValueOnce({ outcome: "allowed", authority })
			.mockRejectedValueOnce(new Error("private identity dependency detail"));
		const response = await testApp(
			dependencies({ authorization: { authorize } }),
		).app.request("/api/v1/conversations/conversation-1/events");
		const body = await response.text();

		expect(body).toBe("");
		expect(body).not.toContain("authorization.revoked");
		expect(body).not.toContain("private identity dependency detail");
	});

	it("rejects ambiguous replay selectors and non-enumerates initial access", async () => {
		const ambiguous = await testApp().app.request(
			"/api/v1/conversations/conversation-1/events?cursor=cursor-1",
			{ headers: { "Last-Event-ID": "event-1" } },
		);
		expect(ambiguous.status).toBe(400);

		const denied = dependencies({
			authorization: {
				authorize: vi.fn().mockResolvedValue({ outcome: "denied" }),
			},
		});
		const forbidden = await testApp(denied).app.request(
			"/api/v1/conversations/conversation-private/events",
		);
		expect(forbidden.status).toBe(403);
		expect(await forbidden.json()).toMatchObject({
			code: "RESOURCE_UNAVAILABLE",
		});
	});

	it("never accepts malformed persisted data as an SSE event", async () => {
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
		).app.request("/api/v1/conversations/conversation-1/events");

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			code: "DEPENDENCY_UNAVAILABLE",
		});
	});

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
