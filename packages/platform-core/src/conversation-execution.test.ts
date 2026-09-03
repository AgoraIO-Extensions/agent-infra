import { describe, expect, it } from "vitest";

import {
	type ConversationExecutionTransactionPortV1,
	createConversationExecutionUseCaseV1,
} from "./conversation-execution.ts";
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
	it("uses deterministic Fake defaults when controls are omitted", async () => {
		const command = {
			schemaVersion: 1 as const,
			agentId: authority.agentId,
			idempotencyKey: "create_deterministic_default",
			requestId: "request_create_deterministic_default",
			traceId: "trace_create_deterministic_default",
		};
		const first = new FakeConversationExecutionV1({ authority });
		const second = new FakeConversationExecutionV1({ authority });
		const expected = {
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				conversationId: "fake_conversation_1",
				agentId: authority.agentId,
				status: "ready",
			},
		} as const;

		for (const conversation of [first, second]) {
			await expect(conversation.createConversation(command)).resolves.toEqual(
				expected,
			);
		}
	});

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

	it("fails closed when transaction results are malformed", async () => {
		const transaction = {
			async createConversation() {
				return {
					outcome: "accepted",
					result: {
						schemaVersion: 1,
						conversationId: "conversation_01",
						agentId: authority.agentId,
						status: "ready",
						injected: true,
					},
				} as never;
			},
			async executeMessage() {
				return {
					outcome: "replayed",
					result: {
						schemaVersion: 1,
						status: "submitted",
						messageId: null,
						executionId: "execution_01",
					},
				} as never;
			},
			async executeRegeneration() {
				return {
					outcome: "accepted",
					result: {
						schemaVersion: 1,
						status: "submitted",
						messageId: "message_01",
						executionId: "execution_01",
					},
				} as never;
			},
			async executeStop() {
				return {
					outcome: "replayed",
					result: {
						schemaVersion: 1,
						status: "submitted",
						executionId: "execution_other",
					},
				} as never;
			},
		} satisfies ConversationExecutionTransactionPortV1;
		const conversation = createConversationExecutionUseCaseV1({
			authorization: {
				async authorize() {
					return { outcome: "allowed" as const, authority };
				},
			},
			transaction,
		});

		await expect(
			conversation.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "create_malformed",
				requestId: "request_create_malformed",
				traceId: "trace_create_malformed",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		await expect(
			conversation.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "conversation_01",
				text: "Message",
				idempotencyKey: "message_malformed",
				requestId: "request_message_malformed",
				traceId: "trace_message_malformed",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		await expect(
			conversation.regenerate({
				schemaVersion: 1,
				command: "regenerate",
				conversationId: "conversation_01",
				sourceMessageId: "message_01",
				idempotencyKey: "regenerate_malformed",
				requestId: "request_regenerate_malformed",
				traceId: "trace_regenerate_malformed",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		await expect(
			conversation.stop({
				schemaVersion: 1,
				command: "stop",
				conversationId: "conversation_01",
				targetExecutionId: "execution_01",
				idempotencyKey: "stop_malformed",
				requestId: "request_stop_malformed",
				traceId: "trace_stop_malformed",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
	});

	it("fails closed when authorization results are malformed", async () => {
		const transaction = {
			async createConversation() {
				throw new Error("Authorization must resolve before a transaction");
			},
			async executeMessage() {
				throw new Error("Authorization must resolve before a transaction");
			},
			async executeRegeneration() {
				throw new Error("Authorization must resolve before a transaction");
			},
			async executeStop() {
				throw new Error("Authorization must resolve before a transaction");
			},
		} satisfies ConversationExecutionTransactionPortV1;
		const conversation = createConversationExecutionUseCaseV1({
			authorization: {
				async authorize() {
					return {
						outcome: "allowed",
						authority: { ...authority, actorId: undefined },
					} as never;
				},
			},
			transaction,
		});

		await expect(
			conversation.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey: "create_malformed_authorization",
				requestId: "request_create_malformed_authorization",
				traceId: "trace_create_malformed_authorization",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
	});

	it("replays the exact logical message before classifying later state", async () => {
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
		if (accepted.outcome !== "accepted" || accepted.result.messageId === null) {
			throw new Error("Expected an accepted initial message");
		}
		conversation.completeExecution(accepted.result.executionId);

		expect(
			await conversation.accept({
				...command,
				requestId: "request_message_replay_retry",
				traceId: "trace_message_replay_retry",
			}),
		).toEqual({
			outcome: "replayed",
			result: accepted.result,
		});
		expect(
			await conversation.accept({ ...command, text: "Changed submission" }),
		).toEqual({ outcome: "conflict", reason: "idempotency_conflict" });
		expect(conversation.snapshot().messages).toHaveLength(1);
		expect(conversation.snapshot().executions).toHaveLength(1);
		expect(conversation.snapshot().outbox).toHaveLength(1);
	});

	it("does not replay a command across actor, Agent, or channel bindings", async () => {
		let currentAuthority = authority;
		const conversation = new FakeConversationExecutionV1({
			authorization: {
				async authorize() {
					return { outcome: "allowed" as const, authority: currentAuthority };
				},
			},
			newId: (() => {
				let value = 1;
				return () => `binding_${value++}`;
			})(),
		});
		await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_binding",
			requestId: "request_create_binding",
			traceId: "trace_create_binding",
		});
		const command = {
			schemaVersion: 1 as const,
			command: "message" as const,
			conversationId: "binding_1",
			text: "Original message",
			idempotencyKey: "message_binding",
			requestId: "request_message_binding",
			traceId: "trace_message_binding",
		};
		expect(await conversation.accept(command)).toMatchObject({
			outcome: "accepted",
		});
		const before = conversation.snapshot();

		for (const changedAuthority of [
			{ ...authority, actorId: "user_02" },
			{ ...authority, agentId: "agent_02" },
			{ ...authority, channelId: "channel_02" },
		]) {
			currentAuthority = changedAuthority;
			expect(await conversation.accept(command)).toEqual({ outcome: "denied" });
			expect(conversation.snapshot()).toEqual(before);
		}
	});

	it("scopes create idempotency by channel while replaying transport retries", async () => {
		let currentAuthority = authority;
		const conversation = new FakeConversationExecutionV1({
			authorization: {
				async authorize() {
					return { outcome: "allowed" as const, authority: currentAuthority };
				},
			},
			newId: (() => {
				let value = 1;
				return () => `create_channel_${value++}`;
			})(),
		});
		const command = {
			schemaVersion: 1 as const,
			agentId: authority.agentId,
			idempotencyKey: "create_channel",
			requestId: "request_create_channel",
			traceId: "trace_create_channel",
		};
		const created = await conversation.createConversation(command);
		if (created.outcome !== "accepted") throw new Error("Expected acceptance");
		expect(
			await conversation.createConversation({
				...command,
				requestId: "request_create_channel_retry",
				traceId: "trace_create_channel_retry",
			}),
		).toEqual({ outcome: "replayed", result: created.result });

		currentAuthority = { ...authority, channelId: "wecom" };
		expect(await conversation.createConversation(command)).toEqual({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				conversationId: "create_channel_2",
				agentId: authority.agentId,
				status: "ready",
			},
		});
		expect(conversation.snapshot().conversations).toMatchObject([
			{ conversationId: "create_channel_1", channelId: authority.channelId },
			{ conversationId: "create_channel_2", channelId: "wecom" },
		]);
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

		const regenerated = await conversation.regenerate({
			schemaVersion: 1,
			command: "regenerate",
			conversationId: "regenerate_1",
			sourceMessageId: "regenerate_2",
			idempotencyKey: "regenerate_01",
			requestId: "request_regenerate_01",
			traceId: "trace_regenerate_01",
		});
		expect(regenerated).toEqual({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				status: "submitted",
				messageId: null,
				executionId: "regenerate_5",
			},
		});
		if (regenerated.outcome !== "accepted") {
			throw new Error("Expected acceptance");
		}
		expect(
			await conversation.regenerate({
				schemaVersion: 1,
				command: "regenerate",
				conversationId: "regenerate_1",
				sourceMessageId: "regenerate_2",
				idempotencyKey: "regenerate_01",
				requestId: "request_regenerate_01_retry",
				traceId: "trace_regenerate_01_retry",
			}),
		).toEqual({ outcome: "replayed", result: regenerated.result });
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

	it("does not replay regeneration across Agent or channel bindings", async () => {
		let currentAuthority = authority;
		const conversation = new FakeConversationExecutionV1({
			authorization: {
				async authorize() {
					return { outcome: "allowed" as const, authority: currentAuthority };
				},
			},
			newId: (() => {
				let value = 1;
				return () => `regeneration_binding_${value++}`;
			})(),
		});
		await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_regeneration_binding",
			requestId: "request_create_regeneration_binding",
			traceId: "trace_create_regeneration_binding",
		});
		const accepted = await conversation.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "regeneration_binding_1",
			text: "Original message",
			idempotencyKey: "message_regeneration_binding",
			requestId: "request_message_regeneration_binding",
			traceId: "trace_message_regeneration_binding",
		});
		if (accepted.outcome !== "accepted" || accepted.result.messageId === null) {
			throw new Error("Expected an accepted initial message");
		}
		conversation.completeExecution(accepted.result.executionId);
		const command = {
			schemaVersion: 1 as const,
			command: "regenerate" as const,
			conversationId: "regeneration_binding_1",
			sourceMessageId: accepted.result.messageId,
			idempotencyKey: "regenerate_binding",
			requestId: "request_regenerate_binding",
			traceId: "trace_regenerate_binding",
		};
		expect(await conversation.regenerate(command)).toMatchObject({
			outcome: "accepted",
		});
		const before = conversation.snapshot();

		for (const changedAuthority of [
			{ ...authority, actorId: "user_02" },
			{ ...authority, agentId: "agent_02" },
			{ ...authority, channelId: "channel_02" },
		]) {
			currentAuthority = changedAuthority;
			expect(await conversation.regenerate(command)).toEqual({
				outcome: "denied",
			});
			expect(conversation.snapshot()).toEqual(before);
		}
	});

	it("conflicts on changed regeneration sources and stop targets without effects", async () => {
		const conversation = new FakeConversationExecutionV1({
			authority,
			newId: (() => {
				let value = 1;
				return () => `changed_key_${value++}`;
			})(),
		});
		await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_changed_key",
			requestId: "request_create_changed_key",
			traceId: "trace_create_changed_key",
		});
		const submitAndComplete = async (idempotencyKey: string, text: string) => {
			const accepted = await conversation.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "changed_key_1",
				text,
				idempotencyKey,
				requestId: `request_${idempotencyKey}`,
				traceId: `trace_${idempotencyKey}`,
			});
			if (
				accepted.outcome !== "accepted" ||
				accepted.result.messageId === null
			) {
				throw new Error("Expected an accepted initial message");
			}
			conversation.completeExecution(accepted.result.executionId);
			return {
				messageId: accepted.result.messageId,
				executionId: accepted.result.executionId,
			};
		};
		const first = await submitAndComplete("message_changed_key_first", "First");
		const second = await submitAndComplete(
			"message_changed_key_second",
			"Second",
		);
		const regeneration = {
			schemaVersion: 1 as const,
			command: "regenerate" as const,
			conversationId: "changed_key_1",
			sourceMessageId: first.messageId,
			idempotencyKey: "regenerate_changed_key",
			requestId: "request_regenerate_changed_key",
			traceId: "trace_regenerate_changed_key",
		};
		const regenerated = await conversation.regenerate(regeneration);
		if (regenerated.outcome !== "accepted")
			throw new Error("Expected acceptance");
		conversation.completeExecution(regenerated.result.executionId);
		const beforeRegenerationConflict = conversation.snapshot();
		expect(
			await conversation.regenerate({
				...regeneration,
				sourceMessageId: second.messageId,
			}),
		).toEqual({ outcome: "conflict", reason: "idempotency_conflict" });
		expect(conversation.snapshot()).toEqual(beforeRegenerationConflict);

		const stop = {
			schemaVersion: 1 as const,
			command: "stop" as const,
			conversationId: "changed_key_1",
			targetExecutionId: first.executionId,
			idempotencyKey: "stop_changed_key",
			requestId: "request_stop_changed_key",
			traceId: "trace_stop_changed_key",
		};
		expect(await conversation.stop(stop)).toMatchObject({
			outcome: "accepted",
			result: { status: "already_finished" },
		});
		const beforeStopConflict = conversation.snapshot();
		expect(
			await conversation.stop({
				...stop,
				targetExecutionId: second.executionId,
			}),
		).toEqual({ outcome: "conflict", reason: "idempotency_conflict" });
		expect(conversation.snapshot()).toEqual(beforeStopConflict);
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

		const stopped = await conversation.stop({
			schemaVersion: 1,
			command: "stop",
			conversationId: "stop_1",
			targetExecutionId: "stop_3",
			idempotencyKey: "stop_01",
			requestId: "request_stop_01",
			traceId: "trace_stop_01",
		});
		expect(stopped).toEqual({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				status: "submitted",
				executionId: "stop_3",
			},
		});
		if (stopped.outcome !== "accepted") throw new Error("Expected acceptance");
		expect(
			await conversation.stop({
				schemaVersion: 1,
				command: "stop",
				conversationId: "stop_1",
				targetExecutionId: "stop_3",
				idempotencyKey: "stop_01",
				requestId: "request_stop_01_retry",
				traceId: "trace_stop_01_retry",
			}),
		).toEqual({ outcome: "replayed", result: stopped.result });
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
					sessionGeneration: 1,
				}),
			]),
		});
	});

	it("does not replay stop across actor, Agent, or channel bindings", async () => {
		let currentAuthority = authority;
		const conversation = new FakeConversationExecutionV1({
			authorization: {
				async authorize() {
					return { outcome: "allowed" as const, authority: currentAuthority };
				},
			},
			newId: (() => {
				let value = 1;
				return () => `stop_binding_${value++}`;
			})(),
		});
		await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_stop_binding",
			requestId: "request_create_stop_binding",
			traceId: "trace_create_stop_binding",
		});
		const accepted = await conversation.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "stop_binding_1",
			text: "Original message",
			idempotencyKey: "message_stop_binding",
			requestId: "request_message_stop_binding",
			traceId: "trace_message_stop_binding",
		});
		if (accepted.outcome !== "accepted") throw new Error("Expected acceptance");
		const command = {
			schemaVersion: 1 as const,
			command: "stop" as const,
			conversationId: "stop_binding_1",
			targetExecutionId: accepted.result.executionId,
			idempotencyKey: "stop_binding",
			requestId: "request_stop_binding",
			traceId: "trace_stop_binding",
		};
		expect(await conversation.stop(command)).toMatchObject({
			outcome: "accepted",
		});
		const before = conversation.snapshot();

		for (const changedAuthority of [
			{ ...authority, actorId: "user_02" },
			{ ...authority, agentId: "agent_02" },
			{ ...authority, channelId: "channel_02" },
		]) {
			currentAuthority = changedAuthority;
			expect(await conversation.stop(command)).toEqual({ outcome: "denied" });
			expect(conversation.snapshot()).toEqual(before);
		}
	});

	it("denies a stop target from another Conversation without visible effects", async () => {
		const conversation = new FakeConversationExecutionV1({
			authority,
			newId: (() => {
				let value = 1;
				return () => `cross_stop_${value++}`;
			})(),
		});
		for (const idempotencyKey of [
			"create_cross_stop_first",
			"create_cross_stop_second",
		]) {
			await conversation.createConversation({
				schemaVersion: 1,
				agentId: authority.agentId,
				idempotencyKey,
				requestId: `request_${idempotencyKey}`,
				traceId: `trace_${idempotencyKey}`,
			});
		}
		await conversation.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "cross_stop_1",
			text: "First conversation work",
			idempotencyKey: "message_cross_stop",
			requestId: "request_message_cross_stop",
			traceId: "trace_message_cross_stop",
		});
		const before = conversation.snapshot();

		expect(
			await conversation.stop({
				schemaVersion: 1,
				command: "stop",
				conversationId: "cross_stop_2",
				targetExecutionId: "cross_stop_4",
				idempotencyKey: "stop_cross_stop",
				requestId: "request_stop_cross_stop",
				traceId: "trace_stop_cross_stop",
			}),
		).toEqual({ outcome: "denied" });
		expect(conversation.snapshot()).toEqual(before);
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
		const before = conversation.snapshot();

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
		expect(conversation.snapshot()).toEqual(before);
	});
});
