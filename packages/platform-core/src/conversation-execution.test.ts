import { describe, expect, it } from "vitest";

import { FakeConversationExecutionV1 } from "./fake-conversation-execution.ts";

const authority = {
	schemaVersion: 1 as const,
	actorId: "user_01",
	agentId: "agent_01",
	channelId: "web",
	authorizationRevision: "authorization_01",
	supportsSupplementaryInstruction: true,
};

describe("Conversation execution use case", () => {
	it("atomically accepts a first message without accepting caller identity", async () => {
		const conversation = new FakeConversationExecutionV1({
			authority,
			now: () => new Date("2026-09-03T00:00:00.000Z"),
			newId: (() => {
				let value = 1;
				return () => `id_${value++}`;
			})(),
		});

		const created = await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_01",
			requestId: "request_create_01",
			traceId: "trace_create_01",
		});
		expect(created).toEqual({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				conversationId: "id_1",
				agentId: authority.agentId,
				status: "ready",
			},
		});

		const accepted = await conversation.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "id_1",
			text: "Hello",
			idempotencyKey: "message_01",
			requestId: "request_message_01",
			traceId: "trace_message_01",
		});
		expect(accepted).toEqual({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				status: "submitted",
				messageId: "id_2",
				executionId: "id_3",
			},
		});
		expect(conversation.snapshot()).toMatchObject({
			conversations: [
				{
					conversationId: "id_1",
					actorId: authority.actorId,
					status: "active",
					sessionGeneration: 1,
				},
			],
			messages: [
				{
					messageId: "id_2",
					conversationId: "id_1",
					executionId: "id_3",
					text: "Hello",
				},
			],
			executions: [
				{
					executionId: "id_3",
					conversationId: "id_1",
					status: "submitted",
				},
			],
			outbox: [
				{
					operation: "conversation.turn.submit.v1",
					executionId: "id_3",
					messageId: "id_2",
				},
			],
			audit: [
				{
					action: "conversation.message.accepted",
					actorId: authority.actorId,
					traceId: "trace_message_01",
					requestId: "request_message_01",
				},
			],
		});
		expect(conversation.snapshot().audit).not.toContainEqual(
			expect.objectContaining({ text: "Hello" }),
		);

		await expect(
			conversation.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "id_1",
				text: "identity injection",
				idempotencyKey: "message_02",
				requestId: "request_message_02",
				traceId: "trace_message_02",
				actorId: "user_other",
			} as never),
		).rejects.toMatchObject({ code: "invalid_input" });
	});

	it("replays an accepted message before classifying a later active execution", async () => {
		const conversation = new FakeConversationExecutionV1({
			authority,
			newId: (() => {
				let value = 1;
				return () => `replay_${value++}`;
			})(),
		});
		await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_replay",
			requestId: "request_create_replay",
			traceId: "trace_create_replay",
		});
		const command = {
			schemaVersion: 1 as const,
			command: "message" as const,
			conversationId: "replay_1",
			text: "First submission",
			idempotencyKey: "message_replay",
			requestId: "request_message_replay",
			traceId: "trace_message_replay",
		};
		const accepted = await conversation.accept(command);
		expect(await conversation.accept(command)).toEqual({
			outcome: "replayed",
			result:
				accepted.outcome === "accepted" ? accepted.result : expect.anything(),
		});
		expect(
			await conversation.accept({ ...command, text: "Changed submission" }),
		).toEqual({ outcome: "conflict", reason: "idempotency_conflict" });
		expect(conversation.snapshot().messages).toHaveLength(1);
		expect(conversation.snapshot().executions).toHaveLength(1);
		expect(conversation.snapshot().outbox).toHaveLength(1);
	});

	it("returns busy without a new visible side effect when the active execution cannot supplement", async () => {
		const conversation = new FakeConversationExecutionV1({
			authority: { ...authority, supportsSupplementaryInstruction: false },
			newId: (() => {
				let value = 1;
				return () => `busy_${value++}`;
			})(),
		});
		await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_busy",
			requestId: "request_create_busy",
			traceId: "trace_create_busy",
		});
		await conversation.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "busy_1",
			text: "First",
			idempotencyKey: "message_busy_first",
			requestId: "request_message_busy_first",
			traceId: "trace_message_busy_first",
		});
		const before = conversation.snapshot();
		const busy = {
			schemaVersion: 1 as const,
			command: "message" as const,
			conversationId: "busy_1",
			text: "Second",
			idempotencyKey: "message_busy_second",
			requestId: "request_message_busy_second",
			traceId: "trace_message_busy_second",
		};
		expect(await conversation.accept(busy)).toEqual({ outcome: "busy" });
		expect(await conversation.accept(busy)).toEqual({ outcome: "busy" });
		expect(conversation.snapshot()).toEqual(before);
	});

	it("adds a supplemental message to the current execution without opening a second turn", async () => {
		const conversation = new FakeConversationExecutionV1({
			authority,
			newId: (() => {
				let value = 1;
				return () => `supplement_${value++}`;
			})(),
		});
		await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_supplement",
			requestId: "request_create_supplement",
			traceId: "trace_create_supplement",
		});
		await conversation.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "supplement_1",
			text: "Initial",
			idempotencyKey: "message_supplement_initial",
			requestId: "request_message_supplement_initial",
			traceId: "trace_message_supplement_initial",
		});

		expect(
			await conversation.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "supplement_1",
				text: "Supplemental instruction",
				idempotencyKey: "message_supplement_followup",
				requestId: "request_message_supplement_followup",
				traceId: "trace_message_supplement_followup",
			}),
		).toEqual({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				status: "submitted",
				messageId: "supplement_5",
				executionId: "supplement_3",
			},
		});
		expect(conversation.snapshot()).toMatchObject({
			executions: [{ executionId: "supplement_3" }],
			outbox: [
				{ operation: "conversation.turn.submit.v1" },
				{
					operation: "conversation.turn.supplement.v1",
					executionId: "supplement_3",
					messageId: "supplement_5",
				},
			],
			audit: expect.arrayContaining([
				expect.objectContaining({
					action: "conversation.message.supplemented",
					traceId: "trace_message_supplement_followup",
				}),
			]),
		});
	});

	it("regenerates from an existing user message only after the active turn finishes", async () => {
		const conversation = new FakeConversationExecutionV1({
			authority,
			newId: (() => {
				let value = 1;
				return () => `regenerate_${value++}`;
			})(),
		});
		await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_regenerate",
			requestId: "request_create_regenerate",
			traceId: "trace_create_regenerate",
		});
		await conversation.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "regenerate_1",
			text: "Please answer",
			idempotencyKey: "message_regenerate",
			requestId: "request_message_regenerate",
			traceId: "trace_message_regenerate",
		});
		conversation.completeExecution("regenerate_3");

		expect(
			await conversation.regenerate({
				schemaVersion: 1,
				command: "regenerate",
				conversationId: "regenerate_1",
				sourceMessageId: "regenerate_2",
				idempotencyKey: "regenerate_01",
				requestId: "request_regenerate_01",
				traceId: "trace_regenerate_01",
			}),
		).toEqual({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				status: "submitted",
				messageId: null,
				executionId: "regenerate_5",
			},
		});
		expect(conversation.snapshot()).toMatchObject({
			messages: [{ messageId: "regenerate_2", text: "Please answer" }],
			executions: [
				{ executionId: "regenerate_3", status: "completed" },
				{ executionId: "regenerate_5", status: "submitted" },
			],
			outbox: expect.arrayContaining([
				expect.objectContaining({
					operation: "conversation.turn.regenerate.v1",
					executionId: "regenerate_5",
					messageId: "regenerate_2",
				}),
			]),
		});
	});

	it("creates one stable stop intent without a Message or replacement Execution", async () => {
		const conversation = new FakeConversationExecutionV1({
			authority,
			newId: (() => {
				let value = 1;
				return () => `stop_${value++}`;
			})(),
		});
		await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_stop",
			requestId: "request_create_stop",
			traceId: "trace_create_stop",
		});
		await conversation.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "stop_1",
			text: "Please work",
			idempotencyKey: "message_stop",
			requestId: "request_message_stop",
			traceId: "trace_message_stop",
		});

		expect(
			await conversation.stop({
				schemaVersion: 1,
				command: "stop",
				conversationId: "stop_1",
				targetExecutionId: "stop_3",
				idempotencyKey: "stop_01",
				requestId: "request_stop_01",
				traceId: "trace_stop_01",
			}),
		).toEqual({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				status: "submitted",
				executionId: "stop_3",
			},
		});
		expect(
			await conversation.stop({
				schemaVersion: 1,
				command: "stop",
				conversationId: "stop_1",
				targetExecutionId: "stop_3",
				idempotencyKey: "stop_02",
				requestId: "request_stop_02",
				traceId: "trace_stop_02",
			}),
		).toEqual({
			outcome: "replayed",
			result: {
				schemaVersion: 1,
				status: "submitted",
				executionId: "stop_3",
			},
		});
		expect(conversation.snapshot()).toMatchObject({
			messages: [{ messageId: "stop_2" }],
			executions: [{ executionId: "stop_3" }],
			outbox: expect.arrayContaining([
				expect.objectContaining({
					operation: "conversation.turn.stop.v1",
					executionId: "stop_3",
					stopRequestId: "stop_5",
				}),
			]),
		});
	});

	it("returns already finished when a stop targets a terminal Execution", async () => {
		const conversation = new FakeConversationExecutionV1({
			authority,
			newId: (() => {
				let value = 1;
				return () => `terminal_${value++}`;
			})(),
		});
		await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_terminal",
			requestId: "request_create_terminal",
			traceId: "trace_create_terminal",
		});
		await conversation.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "terminal_1",
			text: "Finished work",
			idempotencyKey: "message_terminal",
			requestId: "request_message_terminal",
			traceId: "trace_message_terminal",
		});
		conversation.completeExecution("terminal_3");

		expect(
			await conversation.stop({
				schemaVersion: 1,
				command: "stop",
				conversationId: "terminal_1",
				targetExecutionId: "terminal_3",
				idempotencyKey: "stop_terminal",
				requestId: "request_stop_terminal",
				traceId: "trace_stop_terminal",
			}),
		).toEqual({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				status: "already_finished",
				executionId: "terminal_3",
			},
		});
		expect(
			conversation
				.snapshot()
				.outbox.filter(
					({ operation }) => operation === "conversation.turn.stop.v1",
				),
		).toHaveLength(0);
	});
});
