import {
	ConversationDetailProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	ConversationSseMessageV1Schema,
	ConversationSseMessageV2Schema,
	ExecutionDetailProjectionV1Schema,
	ExecutionDetailProjectionV2Schema,
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

const operationEvent = {
	...persistedEvent,
	eventId: "operation-event-2",
	sequence: 2,
	conversationCursor: "cursor-2",
	eventSchemaVersion: 2 as const,
	eventType: "execution.operation",
	eventPayload: {
		schemaVersion: 2,
		type: "execution.operation",
		fact: {
			kind: "model",
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			phase: "unknown",
			failureCode: "response_incomplete",
			model: {
				configVersion: "config-1",
				modelOptionId: "model-primary",
				modelId: "model-1",
				reasoningLevel: "medium",
			},
		},
	},
};

function dependencies(
	overrides: Partial<ConversationRoutesDependencies> = {},
): ConversationRoutesDependencies {
	const commands = {
		requestMetadataRecovery: vi
			.fn()
			.mockResolvedValue({ outcome: "not_applicable" }),
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

async function operationDependencies() {
	const input = dependencies();
	const detail = await input.query.get(
		{ actorId: identity.userId, channelId: "web" },
		conversation.conversationId,
	);
	const execution = await input.query.getExecution(
		{ actorId: identity.userId, channelId: "web" },
		conversation.conversationId,
		"execution-1",
	);
	if (!detail || !execution) throw new Error("Missing controlled fixture");
	vi.mocked(input.query.get)
		.mockResolvedValue({ ...detail, events: [persistedEvent, operationEvent] })
		.mockClear();
	vi.mocked(input.query.getExecution)
		.mockResolvedValue({
			...execution,
			execution: { ...execution.execution, status: "unknown" },
			events: [persistedEvent, operationEvent],
		})
		.mockClear();
	vi.mocked(input.query.replay)
		.mockReset()
		.mockResolvedValueOnce({
			outcome: "events",
			events: [persistedEvent, operationEvent],
			resumeCursor: "cursor-2",
		})
		.mockResolvedValue({
			outcome: "reload",
			reason: "cursor_expired",
			resumeCursor: "cursor-2",
		});
	return input;
}

const commandHeaders = {
	"content-type": "application/json",
	"Idempotency-Key": "Command.Aa-01",
};

describe("Conversation HTTP routes", () => {
	it("returns complete V2 mixed history while preserving original V1 messages and events", async () => {
		const input = await operationDependencies();
		const response = await testApp(input).app.request(
			"/api/v2/conversations/conversation-1",
		);
		expect(response.status).toBe(200);
		const detail = ConversationDetailProjectionV2Schema.parse(
			await response.json(),
		);
		expect(detail.schemaVersion).toBe(2);
		expect(
			detail.messages.find((message) => message.role === "assistant")?.text,
		).toBe("Hello");
		expect(
			detail.events.map((event) => [
				event.schemaVersion,
				event.eventId,
				event.sequence,
			]),
		).toEqual([
			[1, "event-1", 1],
			[2, "operation-event-2", 2],
		]);
		expect(detail.events[1]).toMatchObject({
			type: "execution.operation",
			payload: operationEvent.eventPayload.fact,
		});
		const legacyResponse = await testApp(
			await operationDependencies(),
		).app.request("/api/v1/conversations/conversation-1");
		expect(
			ConversationDetailProjectionV1Schema.safeParse(
				await legacyResponse.json(),
			).success,
		).toBe(true);
	});

	it("shows actual unknown facts in V2 execution detail without inventing usage or model summaries", async () => {
		const response = await testApp(await operationDependencies()).app.request(
			"/api/v2/conversations/conversation-1/executions/execution-1",
		);
		expect(response.status).toBe(200);
		const detail = ExecutionDetailProjectionV2Schema.parse(
			await response.json(),
		);
		expect(detail.schemaVersion).toBe(2);
		expect(detail.status).toBe("unknown");
		expect(detail.events[1]).toMatchObject({
			type: "execution.operation",
			payload: {
				phase: "unknown",
				operationRef: "operation-1",
				attemptRef: "attempt-1",
			},
		});
		expect(detail.events[1]?.payload).not.toHaveProperty("usage");
		expect(detail.events[1]?.payload).not.toHaveProperty("durationMs");
		expect(detail.processSummary).toEqual([]);
	});

	it("streams V1 and V2 events in original order under V2 with unchanged Last-Event-ID replay", async () => {
		const input = await operationDependencies();
		const response = await testApp(input).app.request(
			"/api/v2/conversations/conversation-1/events",
			{ headers: { "Last-Event-ID": "before-mixed-history" } },
		);
		expect(response.status).toBe(200);
		const frames = (await response.text())
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) =>
				ConversationSseMessageV2Schema.parse(JSON.parse(line.slice(6))),
			);
		expect(frames.map((frame) => [frame.schemaVersion, frame.type])).toEqual([
			[1, "text.delta"],
			[2, "execution.operation"],
			[1, "timeline.reload"],
		]);
		expect(input.query.replay).toHaveBeenNthCalledWith(
			1,
			{ actorId: "user-1", channelId: "web" },
			"conversation-1",
			{ kind: "last-event-id", value: "before-mixed-history" },
		);
		expect(input.authorization.authorize).toHaveBeenCalledTimes(4);
	});

	it("does not silently discard or relabel V2 operation facts on the V1 event stream", async () => {
		const response = await testApp(await operationDependencies()).app.request(
			"/api/v1/conversations/conversation-1/events",
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			code: "DEPENDENCY_UNAVAILABLE",
		});
	});

	it("rejects cross-conversation and cross-execution event substitution before V2 projection", async () => {
		const streamInput = await operationDependencies();
		vi.mocked(streamInput.query.replay)
			.mockReset()
			.mockResolvedValue({
				outcome: "events",
				events: [{ ...operationEvent, conversationId: "private-conversation" }],
				resumeCursor: "cursor-2",
			});
		const stream = await testApp(streamInput).app.request(
			"/api/v2/conversations/conversation-1/events",
		);
		expect(stream.status).toBe(503);
		expect(await stream.text()).not.toContain("private-conversation");
		const detailInput = await operationDependencies();
		const original = await detailInput.query.getExecution(
			{ actorId: "user-1", channelId: "web" },
			"conversation-1",
			"execution-1",
		);
		if (!original) throw new Error("Missing execution fixture");
		vi.mocked(detailInput.query.getExecution).mockResolvedValue({
			...original,
			events: [{ ...operationEvent, executionId: "private-execution" }],
		});
		const detail = await testApp(detailInput).app.request(
			"/api/v2/conversations/conversation-1/executions/execution-1",
		);
		expect(detail.status).toBe(503);
		expect(await detail.text()).not.toContain("private-execution");
	});

	it("closes V2 delivery before a structured fact when current user authorization is revoked", async () => {
		const input = await operationDependencies();
		vi.mocked(input.authorization.authorize)
			.mockReset()
			.mockResolvedValueOnce({ outcome: "allowed", authority })
			.mockResolvedValueOnce({ outcome: "allowed", authority })
			.mockResolvedValueOnce({ outcome: "denied" });
		const response = await testApp(input).app.request(
			"/api/v2/conversations/conversation-1/events",
		);
		const body = await response.text();
		expect(body).toContain("id: event-1");
		expect(body).toContain('"type":"authorization.revoked"');
		expect(body).not.toContain("operation-event-2");
		expect(body).not.toContain('"operationRef"');
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

describe("historical metadata recovery admission", () => {
	it("registers only successful Conversation and Execution history reads", async () => {
		const h = testApp();
		const command = h.dependencies.commands(identity);
		expect(
			(await h.app.request("/api/v2/conversations/conversation-1")).status,
		).toBe(200);
		expect(command.requestMetadataRecovery).toHaveBeenCalledWith({
			schemaVersion: 1,
			conversationId: "conversation-1",
		});
		vi.mocked(command.requestMetadataRecovery).mockClear();
		expect(
			(
				await h.app.request(
					"/api/v2/conversations/conversation-1/executions/execution-1",
				)
			).status,
		).toBe(200);
		expect(command.requestMetadataRecovery).toHaveBeenCalledWith({
			schemaVersion: 1,
			conversationId: "conversation-1",
			executionId: "execution-1",
		});
		vi.mocked(command.requestMetadataRecovery).mockClear();
		vi.mocked(h.dependencies.query.getExecution).mockResolvedValue(undefined);
		expect(
			(
				await h.app.request(
					"/api/v2/conversations/conversation-1/executions/missing",
				)
			).status,
		).not.toBe(200);
		expect(command.requestMetadataRecovery).not.toHaveBeenCalled();
		vi.mocked(command.readConversation).mockResolvedValue({
			outcome: "denied",
		});
		expect(
			(await h.app.request("/api/v2/conversations/conversation-1")).status,
		).not.toBe(200);
		expect(command.requestMetadataRecovery).not.toHaveBeenCalled();
	});

	it("registers once on initial SSE subscription while ordinary polls remain read-only", async () => {
		const h = testApp(dependencies({ streamPollIntervalMs: 1 }));
		const command = h.dependencies.commands(identity);
		const controller = new AbortController();
		const response = await h.app.request(
			"/api/v2/conversations/conversation-1/events",
			{ signal: controller.signal },
		);
		expect(response.status).toBe(200);
		if (!response.body) throw new Error("missing SSE body");
		const reader = response.body.getReader();
		await reader.read();
		await vi.waitFor(() =>
			expect(
				vi.mocked(h.dependencies.query.replay).mock.calls.length,
			).toBeGreaterThan(1),
		);
		controller.abort();
		await reader.cancel();
		expect(command.requestMetadataRecovery).toHaveBeenCalledTimes(1);
	});
});
