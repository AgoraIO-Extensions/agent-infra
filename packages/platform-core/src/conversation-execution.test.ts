import { describe, expect, it } from "vitest";
import {
	conversationCommandConformanceV1,
	conversationConformanceAuthorityV1,
	conversationConformanceModelIdV1,
} from "./conversation.conformance.ts";
import {
	type ConversationExecutionAuthorityV1,
	ConversationExecutionError,
	type ConversationExecutionStateV1,
	type ConversationExecutionTransactionPortV1,
	type ConversationExecutionUseCaseV1,
	type ConversationMetadataRecoveryStateV1,
	type ConversationMetadataRecoveryWritePlanV1,
	type ConversationTaskExecutionStatusV1,
	createConversationExecutionUseCaseV1,
	decideConversationWithdrawalV1,
	modelOptionDisplayNameV1,
	requestedModelDisplayNameV1,
} from "./conversation-execution.ts";
import {
	effectiveModelSelection,
	modelSelectionFallbackWrite,
	parseState,
} from "./conversation-execution-state.ts";
import { FakeConversationExecutionV1 } from "./fake-conversation-execution.ts";

const authority = {
	schemaVersion: 1 as const,
	actorId: "user_01",
	agentId: "agent_01",
	channelId: "web",
	authorizationRevision: "authorization_01",
	supportsSupplementaryInstruction: true,
};

const conformanceModelConfiguration = {
	configurationRevision: 1,
	options: [
		{ optionId: "model_primary", reasoningLevels: ["low", "medium"] },
		{ optionId: "model_alternate", reasoningLevels: ["high"] },
	],
	defaultOptionId: "model_primary",
	defaultReasoningLevel: "low",
} as const;

conversationCommandConformanceV1("Fake", async () => {
	let nextId = 1;
	let effectiveAuthority: ConversationExecutionAuthorityV1 | undefined =
		conversationConformanceAuthorityV1;
	const fake = new FakeConversationExecutionV1({
		authority: conversationConformanceAuthorityV1,
		authorization: {
			async authorize() {
				return effectiveAuthority
					? { outcome: "allowed", authority: effectiveAuthority }
					: { outcome: "denied" };
			},
		},
		modelConfiguration: conformanceModelConfiguration,
		modelIdOf: conversationConformanceModelIdV1,
		now: () => new Date("2026-09-04T00:00:00.000Z"),
		newId: () => `conversation_fixture_${nextId++}`,
	});
	let loseNextResponse = false;
	const useCase: ConversationExecutionUseCaseV1 = {
		requestMetadataRecovery: (query) => fake.requestMetadataRecovery(query),
		readConversation: (query) => fake.readConversation(query),
		createConversation: (command) => fake.createConversation(command),
		async accept(command) {
			const decision = await fake.accept(command);
			if (loseNextResponse) {
				loseNextResponse = false;
				throw new Error("Injected response loss");
			}
			return decision;
		},
		regenerate: (command) => fake.regenerate(command),
		selectModel: (command) => fake.selectModel(command),
		stop: (command) => fake.stop(command),
		withdraw: (command) => fake.withdraw(command),
	};
	return {
		useCase,
		setAuthority(authority) {
			effectiveAuthority = authority;
		},
		failNextCommit() {
			fake.failNextCommit();
		},
		failNextModelSelectionCommit() {
			fake.failNextCommit();
		},
		failNextFallbackEventCommit() {
			fake.failNextCommit();
		},
		loseNextResponseAfterCommit() {
			loseNextResponse = true;
		},
		completeExecution(executionId) {
			fake.completeExecution(executionId);
		},
		startExecution(executionId) {
			fake.markExecutionProcessing(executionId);
		},
		setModelConfiguration(configuration) {
			fake.setModelConfiguration(configuration);
		},
		async persistRuntimeEvent(conversationId, executionId, adapterEventKey) {
			const decision = await fake.persistRuntimeEvent({
				schemaVersion: 1,
				conversationId,
				executionId,
				sessionGeneration: 1,
				deliveryFence: 0,
				adapterEventKey,
				runtimeCursor: `runtime_cursor_${adapterEventKey}`,
				occurredAt: "2026-09-04T00:00:00.000Z",
				event: { type: "text.delta", text: "bounded runtime fixture" },
			});
			if (decision.outcome !== "accepted") {
				throw new Error("Expected Fake Runtime event acceptance");
			}
			return decision.event;
		},
		async eventSnapshot(conversationId) {
			const snapshot = fake.snapshot();
			const conversation = snapshot.conversations.find(
				(candidate) => candidate?.conversationId === conversationId,
			);
			if (!conversation) throw new Error("Expected Conversation");
			const events = snapshot.events
				.filter(({ event }) => event.conversationId === conversationId)
				.toSorted(
					(left, right) =>
						left.event.conversationCursor - right.event.conversationCursor,
				);
			return {
				lastConversationCursor: conversation.lastConversationCursor,
				executions: snapshot.executions
					.filter((execution) => execution.conversationId === conversationId)
					.map((execution) => ({
						executionId: execution.executionId,
						lastEventSequence: execution.lastEventSequence,
						lastRuntimeCursor:
							events.findLast(
								(event) =>
									event.source === "runtime" &&
									event.event.executionId === execution.executionId,
							)?.runtimeCursor ?? null,
					})),
				events: events.map(({ source, runtimeCursor, event }) => ({
					source,
					runtimeCursor,
					event,
				})),
				fallbackAuditExecutionIds: snapshot.audit
					.filter(
						({ action }) => action === "conversation.model_selection.fell_back",
					)
					.map(({ executionId }) => String(executionId)),
			};
		},
		async modelSnapshot(conversationId) {
			const snapshot = fake.snapshot();
			const conversation = snapshot.conversations.find(
				(candidate) => candidate?.conversationId === conversationId,
			);
			if (!conversation) throw new Error("Expected Conversation");
			return {
				selectedModelOptionId: conversation.selectedModelOptionId,
				selectedReasoningLevel: conversation.selectedReasoningLevel,
				executions: snapshot.executions
					.filter((execution) => execution.conversationId === conversationId)
					.map(
						({
							executionId,
							modelConfigurationRevision,
							modelOptionId,
							reasoningLevel,
						}) => ({
							executionId,
							modelConfigurationRevision,
							modelOptionId,
							reasoningLevel,
						}),
					),
				outbox: snapshot.outbox
					.filter(
						(item) =>
							item.operation === "conversation.turn.submit.v1" ||
							item.operation === "conversation.turn.regenerate.v1",
					)
					.map(
						({
							executionId,
							modelConfigurationRevision,
							modelOptionId,
							reasoningLevel,
						}) => ({
							executionId,
							modelConfigurationRevision: modelConfigurationRevision ?? null,
							modelOptionId: modelOptionId ?? null,
							reasoningLevel: reasoningLevel ?? null,
						}),
					),
				auditActions: snapshot.audit.map(({ action }) => action).toSorted(),
				fallbackFacts: snapshot.audit
					.filter(
						({ action }) => action === "conversation.model_selection.fell_back",
					)
					.map(({ details }) => ({
						previousModelOptionId: String(details?.previousModelOptionId),
						previousReasoningLevel: String(details?.previousReasoningLevel),
						modelConfigurationRevision: Number(
							details?.modelConfigurationRevision,
						),
						modelOptionId: String(details?.modelOptionId),
						reasoningLevel: String(details?.reasoningLevel),
					})),
			};
		},
		async snapshot() {
			const snapshot = fake.snapshot();
			return {
				conversations: snapshot.conversations.length,
				messages: snapshot.messages.length,
				executions: snapshot.executions.length,
				stops: snapshot.stops.length,
				outbox: snapshot.outbox.length,
				audit: snapshot.audit.length,
				idempotency: fake.idempotencyCount(),
			};
		},
		async close() {},
	};
});

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
			async requestMetadataRecovery() {
				return { outcome: "not_applicable" as const };
			},
			async readConversation() {
				return { outcome: "found", result: {} } as never;
			},
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
			async executeModelSelection() {
				return {
					outcome: "accepted",
					result: {
						schemaVersion: 1,
						conversationId: "conversation_other",
						modelOptionId: "model_other",
						reasoningLevel: "other",
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
			conversation.readConversation({
				schemaVersion: 1,
				conversationId: "conversation_01",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
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
			conversation.selectModel({
				schemaVersion: 1,
				command: "model.select",
				conversationId: "conversation_01",
				modelOptionId: "model_01",
				reasoningLevel: "medium",
				idempotencyKey: "model_selection_malformed",
				requestId: "request_model_selection_malformed",
				traceId: "trace_model_selection_malformed",
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
			async requestMetadataRecovery() {
				return { outcome: "not_applicable" as const };
			},
			async readConversation() {
				throw new Error("Authorization must resolve before a transaction");
			},
			async createConversation() {
				throw new Error("Authorization must resolve before a transaction");
			},
			async executeMessage() {
				throw new Error("Authorization must resolve before a transaction");
			},
			async executeModelSelection() {
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

	it("fails closed when a transaction throws an internal validation error", async () => {
		const transaction = {
			async requestMetadataRecovery() {
				return { outcome: "not_applicable" as const };
			},
			async readConversation() {
				throw new ConversationExecutionError("invalid_input");
			},
			async createConversation() {
				throw new ConversationExecutionError("invalid_input");
			},
			async executeMessage() {
				throw new ConversationExecutionError("invalid_input");
			},
			async executeModelSelection() {
				throw new ConversationExecutionError("invalid_input");
			},
			async executeRegeneration() {
				throw new ConversationExecutionError("invalid_input");
			},
			async executeStop() {
				throw new ConversationExecutionError("invalid_input");
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
				idempotencyKey: "create_transaction_error",
				requestId: "request_create_transaction_error",
				traceId: "trace_create_transaction_error",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		await expect(
			conversation.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "conversation_transaction_error",
				text: "Message",
				idempotencyKey: "message_transaction_error",
				requestId: "request_message_transaction_error",
				traceId: "trace_message_transaction_error",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		await expect(
			conversation.regenerate({
				schemaVersion: 1,
				command: "regenerate",
				conversationId: "conversation_transaction_error",
				sourceMessageId: "message_transaction_error",
				idempotencyKey: "regenerate_transaction_error",
				requestId: "request_regenerate_transaction_error",
				traceId: "trace_regenerate_transaction_error",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		await expect(
			conversation.stop({
				schemaVersion: 1,
				command: "stop",
				conversationId: "conversation_transaction_error",
				targetExecutionId: "execution_transaction_error",
				idempotencyKey: "stop_transaction_error",
				requestId: "request_stop_transaction_error",
				traceId: "trace_stop_transaction_error",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
	});

	it("uses the target Execution generation for supplement and stop intents", async () => {
		let supplementGeneration: number | undefined;
		let stopGeneration: number | undefined;
		const conversation = {
			schemaVersion: 1,
			conversationId: "conversation_generation",
			agentId: authority.agentId,
			actorId: authority.actorId,
			channelId: authority.channelId,
			status: "active",
			sessionGeneration: 2,
			hostSessionRef: "host_session_2",
			authorizationRevision: authority.authorizationRevision,
			lastConversationCursor: 0,
			selectedModelOptionId: null,
			selectedReasoningLevel: null,
			createdAt: new Date("2026-09-03T00:00:00.000Z"),
			updatedAt: new Date("2026-09-03T00:00:00.000Z"),
		} as const;
		const supplementState = {
			conversation,
			modelConfiguration: undefined,
			sourceMessage: undefined,
			targetExecution: undefined,
			existingStop: undefined,
			activeExecution: {
				executionId: "execution_generation",
				conversationId: conversation.conversationId,
				actorId: authority.actorId,
				turnId: "turn_generation",
				sessionGeneration: 1,
				modelConfigurationRevision: null,
				modelOptionId: null,
				reasoningLevel: null,
				lastEventSequence: 0,
				stopPending: false,
				status: "processing",
			},
		} satisfies ConversationExecutionStateV1;
		const stopState = {
			conversation,
			modelConfiguration: undefined,
			sourceMessage: undefined,
			targetExecution: {
				executionId: "execution_generation",
				conversationId: conversation.conversationId,
				actorId: authority.actorId,
				sessionGeneration: 1,
				modelConfigurationRevision: null,
				modelOptionId: null,
				reasoningLevel: null,
				status: "submitted",
			},
			existingStop: undefined,
			activeExecution: undefined,
		} satisfies ConversationExecutionStateV1;
		const transaction = {
			async requestMetadataRecovery() {
				return { outcome: "not_applicable" as const };
			},
			async readConversation() {
				throw new Error("Not used by this test");
			},
			async createConversation() {
				throw new Error("Not used by this test");
			},
			async executeMessage(_request, decide) {
				const decision = decide(supplementState);
				if ("outcome" in decision) {
					throw new Error("Expected a supplement plan");
				}
				supplementGeneration = decision.outboxIntent.sessionGeneration;
				return { outcome: "accepted", result: decision.result };
			},
			async executeModelSelection() {
				throw new Error("Not used by this test");
			},
			async executeRegeneration() {
				throw new Error("Not used by this test");
			},
			async executeStop(_request, decide) {
				const decision = decide(stopState);
				if ("outcome" in decision) {
					throw new Error("Expected a stop plan");
				}
				stopGeneration = decision.outboxIntent.sessionGeneration;
				return { outcome: "accepted", result: decision.result };
			},
		} satisfies ConversationExecutionTransactionPortV1;
		const useCase = createConversationExecutionUseCaseV1({
			authorization: {
				async authorize() {
					return { outcome: "allowed" as const, authority };
				},
			},
			transaction,
		});

		await expect(
			useCase.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: conversation.conversationId,
				text: "Supplemental instruction",
				idempotencyKey: "message_generation",
				requestId: "request_message_generation",
				traceId: "trace_message_generation",
			}),
		).resolves.toMatchObject({ outcome: "accepted" });
		await expect(
			useCase.stop({
				schemaVersion: 1,
				command: "stop",
				conversationId: conversation.conversationId,
				targetExecutionId: "execution_generation",
				idempotencyKey: "stop_generation",
				requestId: "request_stop_generation",
				traceId: "trace_stop_generation",
			}),
		).resolves.toMatchObject({ outcome: "accepted" });
		expect({ supplementGeneration, stopGeneration }).toEqual({
			supplementGeneration: 1,
			stopGeneration: 1,
		});
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

	it("wakes recovery of an unknown occupant without changing the busy outcome (#3373)", async () => {
		const ownerAuthority = {
			...authority,
			supportsSupplementaryInstruction: false,
		};
		let currentAuthority = ownerAuthority;
		const conversation = new FakeConversationExecutionV1({
			authority: ownerAuthority,
			authorization: {
				async authorize() {
					return { outcome: "allowed" as const, authority: currentAuthority };
				},
			},
			now: () => new Date("2026-10-25T00:00:00.000Z"),
			newId: (() => {
				let value = 1;
				return () => `wake_${value++}`;
			})(),
		});
		await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_wake",
			requestId: "request_create_wake",
			traceId: "trace_create_wake",
		});
		const first = await conversation.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "wake_1",
			text: "First",
			idempotencyKey: "message_wake_first",
			requestId: "request_message_wake_first",
			traceId: "trace_message_wake_first",
		});
		if (first.outcome !== "accepted") throw new Error("Expected acceptance");
		const second = {
			schemaVersion: 1 as const,
			command: "message" as const,
			conversationId: "wake_1",
			text: "Second",
			idempotencyKey: "message_wake_second",
			requestId: "request_message_wake_second",
			traceId: "trace_message_wake_second",
			// 排队时限已过，确定性地得到繁忙结果（#3376 的排队不在本用例范围内）。
			queueDeadlineLimit: "2026-10-25T00:00:00.000Z",
		};
		// 活跃 Execution 已被 Runtime 处理（未受理不明）时不唤醒。
		expect(await conversation.accept(second)).toEqual({
			outcome: "busy",
			queuedCount: 0,
		});
		expect(conversation.wokenRecoveries).toEqual([]);
		conversation.markExecutionUnknown(first.result.executionId);
		const before = conversation.snapshot();
		// 另一用户的消息被拒绝，不唤醒该 Conversation 的恢复。
		currentAuthority = { ...ownerAuthority, actorId: "user_02" };
		expect(await conversation.accept(second)).toEqual({ outcome: "denied" });
		expect(conversation.wokenRecoveries).toEqual([]);
		currentAuthority = ownerAuthority;
		expect(await conversation.accept(second)).toEqual({
			outcome: "busy",
			queuedCount: 0,
		});
		// 受理不明占用时先唤醒恢复核实，不释放占用，也不新增可见记录。
		expect(conversation.wokenRecoveries).toEqual([
			{ conversationId: "wake_1", executionId: first.result.executionId },
		]);
		expect(conversation.snapshot()).toEqual(before);
	});

	it("queues a message that cannot supplement behind the active reply and replays it", async () => {
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
		const queued = {
			schemaVersion: 1 as const,
			command: "message" as const,
			conversationId: "busy_1",
			text: "Second",
			idempotencyKey: "message_busy_second",
			requestId: "request_message_busy_second",
			traceId: "trace_message_busy_second",
		};
		const accepted = await conversation.accept(queued);
		expect(accepted).toEqual({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				status: "submitted",
				messageId: "busy_5",
				executionId: "busy_6",
				queuePosition: 1,
			},
		});
		if (accepted.outcome !== "accepted") throw new Error("Expected queued");
		// 重放返回首次受理的结果，不按变化后的活跃状态重新判定分支。
		expect(await conversation.accept(queued)).toEqual({
			outcome: "replayed",
			result: accepted.result,
		});
		expect(conversation.snapshot()).toMatchObject({
			executions: [
				{ executionId: "busy_3", status: "submitted" },
				{ executionId: "busy_6", status: "waiting", taskWaitOrder: 1 },
			],
			outbox: [
				{ operation: "conversation.turn.submit.v1", executionId: "busy_3" },
				{ operation: "conversation.turn.submit.v1", executionId: "busy_6" },
			],
			audit: expect.arrayContaining([
				expect.objectContaining({ action: "conversation.message.queued" }),
			]),
		});
	});

	it("queues instead of supplementing before the Runtime accepts the original reply", async () => {
		const conversation = new FakeConversationExecutionV1({
			authority,
			newId: (() => {
				let value = 1;
				return () => `unaccepted_${value++}`;
			})(),
		});
		await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_unaccepted",
			requestId: "request_create_unaccepted",
			traceId: "trace_create_unaccepted",
		});
		await conversation.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "unaccepted_1",
			text: "First",
			idempotencyKey: "message_unaccepted_first",
			requestId: "request_message_unaccepted_first",
			traceId: "trace_message_unaccepted_first",
		});
		// 原回复尚未被 Runtime 接受：即使支持补充指令也直接排队（§12.5 判定 2、3）。
		await expect(
			conversation.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "unaccepted_1",
				text: "Second",
				idempotencyKey: "message_unaccepted_second",
				requestId: "request_message_unaccepted_second",
				traceId: "trace_message_unaccepted_second",
			}),
		).resolves.toMatchObject({
			outcome: "accepted",
			result: { queuePosition: 1, executionId: "unaccepted_6" },
		});
		conversation.markExecutionProcessing("unaccepted_3");
		// 已有排队消息时，新消息排到队尾，不作为补充指令越过先到的消息。
		await expect(
			conversation.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "unaccepted_1",
				text: "Third",
				idempotencyKey: "message_unaccepted_third",
				requestId: "request_message_unaccepted_third",
				traceId: "trace_message_unaccepted_third",
			}),
		).resolves.toMatchObject({
			outcome: "accepted",
			result: { queuePosition: 2 },
		});
		expect(
			conversation
				.snapshot()
				.outbox.map(({ operation }) => operation)
				.filter((operation) => operation === "conversation.turn.supplement.v1"),
		).toEqual([]);
	});

	it("caps the queue per conversation, the shared Agent waiting capacity and the channel deadline", async () => {
		const conversation = new FakeConversationExecutionV1({
			authority: { ...authority, supportsSupplementaryInstruction: false },
			now: () => new Date("2026-10-25T00:00:00.000Z"),
			newId: (() => {
				let value = 1;
				return () => `cap_${value++}`;
			})(),
		});
		await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_cap",
			requestId: "request_create_cap",
			traceId: "trace_create_cap",
		});
		const send = (suffix: string, extra: object = {}) =>
			conversation.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "cap_1",
				text: `Message ${suffix}`,
				idempotencyKey: `message_cap_${suffix}`,
				requestId: `request_message_cap_${suffix}`,
				traceId: `trace_message_cap_${suffix}`,
				...extra,
			});
		await send("initial");
		// 渠道回复时限不足以排队时按繁忙处理，不写入任何记录。
		await expect(
			send("expired", { queueDeadlineLimit: "2026-10-25T00:00:00.000Z" }),
		).resolves.toEqual({ outcome: "busy", queuedCount: 0 });
		await expect(
			send("first", { queueDeadlineLimit: "2026-10-25T00:08:30.000Z" }),
		).resolves.toMatchObject({ result: { queuePosition: 1 } });
		await send("second");
		await send("third");
		await expect(send("fourth")).resolves.toEqual({
			outcome: "busy",
			queuedCount: 3,
		});
		expect(
			conversation
				.snapshot()
				.executions.filter(({ status }) => status === "waiting"),
		).toHaveLength(3);
	});

	it("regenerates only after the active reply and every queued message finish", async () => {
		const conversation = new FakeConversationExecutionV1({
			authority: { ...authority, supportsSupplementaryInstruction: false },
			newId: (() => {
				let value = 1;
				return () => `busy_retry_${value++}`;
			})(),
		});
		await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_busy_retry",
			requestId: "request_create_busy_retry",
			traceId: "trace_create_busy_retry",
		});
		const initial = await conversation.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "busy_retry_1",
			text: "Initial message",
			idempotencyKey: "message_busy_retry_initial",
			requestId: "request_message_busy_retry_initial",
			traceId: "trace_message_busy_retry_initial",
		});
		if (initial.outcome !== "accepted" || initial.result.messageId === null) {
			throw new Error("Expected an accepted initial message");
		}
		const queued = await conversation.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "busy_retry_1",
			text: "Wait for the active turn",
			idempotencyKey: "message_busy_retry",
			requestId: "request_message_busy_retry",
			traceId: "trace_message_busy_retry",
		});
		if (queued.outcome !== "accepted") throw new Error("Expected queued");
		const busyRegeneration = {
			schemaVersion: 1 as const,
			command: "regenerate" as const,
			conversationId: "busy_retry_1",
			sourceMessageId: initial.result.messageId,
			idempotencyKey: "regenerate_busy_retry",
			requestId: "request_regenerate_busy_retry",
			traceId: "trace_regenerate_busy_retry",
		};
		expect(await conversation.regenerate(busyRegeneration)).toEqual({
			outcome: "busy",
		});
		conversation.completeExecution(initial.result.executionId);
		// 重新生成不越过仍在排队的消息。
		expect(await conversation.regenerate(busyRegeneration)).toEqual({
			outcome: "busy",
		});
		conversation.startWaitingExecution(queued.result.executionId);
		conversation.completeExecution(queued.result.executionId);
		expect(await conversation.regenerate(busyRegeneration)).toMatchObject({
			outcome: "accepted",
		});
		expect(conversation.snapshot()).toMatchObject({
			messages: [{ messageId: "busy_retry_2" }, { messageId: "busy_retry_5" }],
			executions: [
				{ executionId: "busy_retry_3", status: "completed" },
				{ executionId: "busy_retry_6", status: "completed" },
				{ executionId: "busy_retry_9", status: "submitted" },
			],
		});
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
		// 补充指令只给已被 Runtime 接受、仍在运行的回复（§12.5）。
		conversation.markExecutionProcessing("supplement_3");

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

	it("queues instead of supplementing an Execution with a pending stop, and the stop keeps the queue", async () => {
		const conversation = new FakeConversationExecutionV1({
			authority,
			newId: (() => {
				let value = 1;
				return () => `stop_pending_${value++}`;
			})(),
		});
		await conversation.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create_stop_pending",
			requestId: "request_create_stop_pending",
			traceId: "trace_create_stop_pending",
		});
		const initial = await conversation.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "stop_pending_1",
			text: "Initial message",
			idempotencyKey: "message_stop_pending_initial",
			requestId: "request_message_stop_pending_initial",
			traceId: "trace_message_stop_pending_initial",
		});
		if (initial.outcome !== "accepted") {
			throw new Error("Expected an accepted initial message");
		}
		conversation.markExecutionProcessing(initial.result.executionId);
		const stopped = await conversation.stop({
			schemaVersion: 1,
			command: "stop",
			conversationId: "stop_pending_1",
			targetExecutionId: initial.result.executionId,
			idempotencyKey: "stop_pending",
			requestId: "request_stop_pending",
			traceId: "trace_stop_pending",
		});
		expect(stopped).toMatchObject({ outcome: "accepted" });

		const followup = await conversation.accept({
			schemaVersion: 1,
			command: "message",
			conversationId: "stop_pending_1",
			text: "Do not supplement a stopped Execution",
			idempotencyKey: "message_stop_pending_followup",
			requestId: "request_message_stop_pending_followup",
			traceId: "trace_message_stop_pending_followup",
		});
		expect(followup).toMatchObject({
			outcome: "accepted",
			result: { queuePosition: 1 },
		});
		if (followup.outcome !== "accepted") throw new Error("Expected queued");
		expect(followup.result.executionId).not.toBe(initial.result.executionId);
		const snapshot = conversation.snapshot();
		// 停止只作用于当前回复：排队消息保留，不写补充指令 outbox。
		expect(
			snapshot.executions.find(
				({ executionId }) => executionId === followup.result.executionId,
			),
		).toMatchObject({ status: "waiting" });
		expect(
			snapshot.outbox.filter(
				({ operation }) => operation === "conversation.turn.supplement.v1",
			),
		).toEqual([]);
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

describe("Conversation metadata recovery planning", () => {
	const taskBoundary = {
		schemaVersion: 1 as const,
		principal: { kind: "user" as const, id: authority.actorId },
		agentId: authority.agentId,
		channelId: authority.channelId,
		identityRevision: "identity_01",
		agentAuthorizationRevision: authority.authorizationRevision,
		accessSources: [{ kind: "user" as const, userId: authority.actorId }],
	};
	const requestedAt = new Date("2026-09-04T00:00:00.000Z");
	const query = {
		schemaVersion: 1 as const,
		conversationId: "conversation_01",
	};
	function fixture() {
		const execution = {
			executionId: "execution_01",
			conversationId: query.conversationId,
			agentId: authority.agentId,
			actorId: authority.actorId,
			channelId: authority.channelId,
			turnId: "turn_01",
			sessionGeneration: 1,
			deliveryFence: 7,
			runtimeCursor: "cursor_03",
			authorizationRevision: authority.authorizationRevision,
			status: "completed",
		};
		return {
			conversation: {
				schemaVersion: 1 as const,
				conversationId: query.conversationId,
				agentId: authority.agentId,
				actorId: authority.actorId,
				channelId: authority.channelId,
				status: "ready" as const,
				sessionGeneration: 1,
				hostSessionRef: "host_01",
				authorizationRevision: authority.authorizationRevision,
				lastConversationCursor: 3,
				selectedModelOptionId: null,
				selectedReasoningLevel: null,
				createdAt: requestedAt,
				updatedAt: requestedAt,
			},
			candidates: [
				{
					execution,
					originalOutboxes: [
						{
							itemId: "conversation:turn:execution_01",
							operation: "conversation.turn.submit.v1",
							status: "succeeded",
							payload: {
								schemaVersion: 1,
								conversationId: query.conversationId,
								executionId: execution.executionId,
								messageId: "message_01",
								turnId: execution.turnId,
								sessionGeneration: 1,
							},
						},
					],
					boundary: taskBoundary,
					latestToolFacts: [
						{
							kind: "tool" as const,
							toolId: "connection.create_pr",
							operationRef: "tool_01",
							attemptRef: "attempt_01",
							phase: "intent" as const,
							connection: {
								serviceRef: "github",
								verification: "unverified" as const,
								reason: "receipt_missing",
							},
						},
					],
				},
			],
		} satisfies ConversationMetadataRecoveryStateV1;
	}
	async function evaluate(
		state: ConversationMetadataRecoveryStateV1,
		executionId?: string,
	) {
		let plan: ConversationMetadataRecoveryWritePlanV1 | undefined;
		let allocatedIds = 0;
		const unused = async (): Promise<never> => {
			throw new Error("Unexpected transaction operation");
		};
		const useCase = createConversationExecutionUseCaseV1(
			{
				authorization: {
					async authorize() {
						return { outcome: "allowed", authority };
					},
				},
				transaction: {
					async requestMetadataRecovery(_request, decide) {
						plan = decide(state);
						return plan.result;
					},
					readConversation: unused,
					createConversation: unused,
					executeMessage: unused,
					executeRegeneration: unused,
					executeStop: unused,
					executeModelSelection: unused,
				},
			},
			{ now: () => requestedAt, newId: () => `pass_${++allocatedIds}` },
		);
		const result = await useCase.requestMetadataRecovery({
			...query,
			...(executionId ? { executionId } : {}),
		});
		return { result, plan, allocatedIds };
	}

	it.each(["succeeded", "failed"])(
		"plans original %s outbox recovery without changing input state",
		async (status) => {
			const state = fixture();
			const original = state.candidates[0]?.originalOutboxes[0];
			if (!original) throw new Error("Missing original outbox fixture");
			original.status = status;
			const before = structuredClone(state);
			expect(await evaluate(state)).toEqual({
				result: { outcome: "scheduled" },
				allocatedIds: 1,
				plan: {
					result: { outcome: "scheduled" },
					updates: [
						{
							itemId: "conversation:turn:execution_01",
							metadataRecovery: {
								id: "pass_1",
								requestedAt: requestedAt.getTime(),
								originalStatus: status,
							},
						},
					],
				},
			});
			expect(state).toEqual(before);
		},
	);

	it("denies another Conversation principal and ignores unavailable runtime sessions", async () => {
		const state = fixture();
		for (const conversation of [
			undefined,
			{ ...state.conversation, conversationId: "other" },
			{ ...state.conversation, actorId: "other" },
			{ ...state.conversation, agentId: "other" },
			{ ...state.conversation, channelId: "other" },
		]) {
			expect(await evaluate({ ...state, conversation })).toMatchObject({
				result: { outcome: "denied" },
				allocatedIds: 0,
				plan: { updates: [] },
			});
		}
		for (const conversation of [
			{ ...state.conversation, hostSessionRef: null },
			{ ...state.conversation, isolationPending: true as const },
		]) {
			expect(await evaluate({ ...state, conversation })).toMatchObject({
				result: { outcome: "not_applicable" },
				allocatedIds: 0,
				plan: { updates: [] },
			});
		}
	});

	it("rechecks original execution, outbox and principal eligibility independently of adapter filtering", async () => {
		const state = fixture();
		const candidate = state.candidates[0];
		if (!candidate) throw new Error("Missing original execution fixture");
		const original = candidate.originalOutboxes[0];
		if (!original) throw new Error("Missing original outbox fixture");
		const latest = candidate.latestToolFacts[0];
		if (!latest) throw new Error("Missing original tool fact fixture");
		const invalidCandidates: ConversationMetadataRecoveryStateV1["candidates"] =
			[
				...[
					{ conversationId: "other" },
					{ actorId: "other" },
					{ agentId: "other" },
					{ channelId: "other" },
					{ sessionGeneration: 2 },
					{ status: "processing" },
					{ deliveryFence: 0 },
					{ runtimeCursor: null },
				].map((patch) => ({
					...candidate,
					execution: { ...candidate.execution, ...patch },
				})),
				{ ...candidate, originalOutboxes: [] },
				{ ...candidate, originalOutboxes: [original, original] },
				{ ...candidate, originalOutboxes: [{ ...original, itemId: "other" }] },
				{
					...candidate,
					originalOutboxes: [
						{ ...original, operation: "conversation.turn.stop.v1" },
					],
				},
				{
					...candidate,
					originalOutboxes: [{ ...original, status: "pending" }],
				},
				...[
					{ conversationId: "other" },
					{ executionId: "other" },
					{ turnId: "other" },
					{ sessionGeneration: 2 },
					{ messageId: "" },
				].map((patch) => ({
					...candidate,
					originalOutboxes: [
						{ ...original, payload: { ...original.payload, ...patch } },
					],
				})),
				{ ...candidate, boundary: null },
				...[
					{
						principal: { kind: "user", id: "other" },
						accessSources: [{ kind: "user", userId: "other" }],
					},
					{ principal: { kind: "application", id: authority.actorId } },
					{ agentId: "other" },
					{ channelId: "other" },
					{ agentAuthorizationRevision: "other" },
				].map((patch) => ({
					...candidate,
					boundary: { ...taskBoundary, ...patch },
				})),
				{ ...candidate, latestToolFacts: [] },
				{
					...candidate,
					latestToolFacts: [
						{
							...latest,
							connection: {
								serviceRef: "github",
								verification: "verified",
								callRef: "call_01",
							},
						},
					],
				},
			];
		for (const invalid of invalidCandidates) {
			expect(
				await evaluate({ ...state, candidates: [invalid] }),
				JSON.stringify(invalid),
			).toMatchObject({
				result: { outcome: "not_applicable" },
				allocatedIds: 0,
				plan: { updates: [] },
			});
		}
		expect(await evaluate(state, "execution_other")).toMatchObject({
			result: { outcome: "not_applicable" },
			allocatedIds: 0,
		});
	});

	it.each(["pending", "processing", "retry_scheduled"])(
		"coalesces %s recovery without allocating a new pass",
		async (status) => {
			const state = fixture();
			const candidate = state.candidates[0];
			if (!candidate) throw new Error("Missing original execution fixture");
			const original = candidate.originalOutboxes[0];
			if (!original) throw new Error("Missing original outbox fixture");
			const metadataRecovery = {
				id: "existing_pass",
				requestedAt: 1,
				originalStatus: "failed",
			};
			const candidates = [
				{
					...candidate,
					originalOutboxes: [
						{
							...original,
							status,
							payload: { ...original.payload, metadataRecovery },
						},
					],
				},
			];
			expect(await evaluate({ ...state, candidates })).toEqual({
				result: { outcome: "coalesced" },
				allocatedIds: 0,
				plan: { result: { outcome: "coalesced" }, updates: [] },
			});
		},
	);

	it("bounds a pass to sixteen original outboxes and prioritizes the least recently requested", async () => {
		const state = fixture();
		const candidate = state.candidates[0];
		if (!candidate) throw new Error("Missing original execution fixture");
		const original = candidate.originalOutboxes[0];
		if (!original) throw new Error("Missing original outbox fixture");
		const candidates = Array.from({ length: 18 }, (_, index) => {
			const executionId = `execution_${index}`;
			return {
				...candidate,
				execution: { ...candidate.execution, executionId },
				originalOutboxes: [
					{
						...original,
						itemId: `conversation:turn:${executionId}`,
						payload: {
							...original.payload,
							executionId,
							metadataRecovery: {
								id: `old_${index}`,
								requestedAt: 18 - index,
								originalStatus: "succeeded",
							},
						},
					},
				],
			};
		});
		const result = await evaluate({ ...state, candidates });
		expect(result.result).toEqual({ outcome: "scheduled" });
		expect(result.allocatedIds).toBe(16);
		expect(result.plan?.updates.map((update) => update.itemId)).toEqual(
			Array.from(
				{ length: 16 },
				(_, index) => `conversation:turn:execution_${17 - index}`,
			),
		);
	});

	async function fakeHistory(
		outboxStatus: "succeeded" | "failed",
		withBoundary = true,
	) {
		const fake = new FakeConversationExecutionV1({
			authority: { ...authority, ...(withBoundary ? { taskBoundary } : {}) },
			now: () => requestedAt,
		});
		const created = await fake.createConversation({
			schemaVersion: 1,
			agentId: authority.agentId,
			idempotencyKey: "create",
			requestId: "request_create",
			traceId: "trace_create",
		});
		if (created.outcome !== "accepted")
			throw new Error("Expected Conversation creation");
		const conversationId = created.result.conversationId;
		const accepted = await fake.accept({
			schemaVersion: 1,
			command: "message",
			conversationId,
			text: "Create a PR",
			idempotencyKey: "message",
			requestId: "request_message",
			traceId: "trace_message",
		});
		if (accepted.outcome !== "accepted")
			throw new Error("Expected original Execution");
		const executionId = accepted.result.executionId;
		fake.completeExecution(executionId, {
			hostSessionRef: "host_01",
			deliveryFence: 7,
			outboxStatus,
		});
		const tool = {
			kind: "tool" as const,
			toolId: "connection.create_pr",
			operationRef: "tool_01",
			attemptRef: "attempt_01",
			connection: {
				serviceRef: "github",
				verification: "unverified" as const,
				reason: "receipt_missing" as const,
			},
		};
		const startedAt = requestedAt.toISOString();
		const outcome = {
			...tool,
			phase: "unknown" as const,
			startedAt,
			finishedAt: startedAt,
			durationMs: 0,
		};
		let sequence = 0;
		async function persist(
			fact: import("./conversation-operation-facts.ts").ConversationOperationFactV2,
		) {
			sequence++;
			expect(
				await fake.persistRuntimeEvent({
					schemaVersion: 1,
					conversationId,
					executionId,
					sessionGeneration: 1,
					deliveryFence: 7,
					adapterEventKey: `event_${sequence}`,
					runtimeCursor: `cursor_${sequence}`,
					occurredAt: startedAt,
					event: { schemaVersion: 2, type: "execution.operation", fact },
				}),
			).toMatchObject({ outcome: "accepted" });
		}
		await persist({ ...tool, phase: "intent" });
		await persist({ ...tool, phase: "started", startedAt });
		await persist(outcome);
		return {
			fake,
			query: { schemaVersion: 1 as const, conversationId, executionId },
			outcome,
			persist,
		};
	}

	it.each(["succeeded", "failed"] as const)(
		"Fake applies the Core plan for original %s delivery and stops when latest metadata is verified",
		async (status) => {
			const { fake, query, outcome, persist } = await fakeHistory(status);
			const before = fake.snapshot();
			await expect(fake.requestMetadataRecovery(query)).resolves.toEqual({
				outcome: "scheduled",
			});
			const after = fake.snapshot();
			expect(after.outbox[0]).toMatchObject({
				status: "pending",
				metadataRecovery: {
					requestedAt: requestedAt.getTime(),
					originalStatus: status,
				},
			});
			expect(after.outbox[0]?.metadataRecovery?.id).toBeTruthy();
			expect({ ...after, outbox: before.outbox }).toEqual(before);
			await expect(fake.requestMetadataRecovery(query)).resolves.toEqual({
				outcome: "coalesced",
			});
			expect(fake.snapshot()).toEqual(after);
			await persist({
				...outcome,
				connection: {
					serviceRef: "github",
					verification: "verified",
					callRef: "call_01",
				},
			});
			const verified = fake.snapshot();
			await expect(fake.requestMetadataRecovery(query)).resolves.toEqual({
				outcome: "not_applicable",
			});
			expect(fake.snapshot()).toEqual(verified);
		},
	);

	it("Fake keeps missing original authorization ineligible and rolls back a failed recovery commit", async () => {
		const missing = await fakeHistory("succeeded", false);
		const beforeMissing = missing.fake.snapshot();
		await expect(
			missing.fake.requestMetadataRecovery(missing.query),
		).resolves.toEqual({ outcome: "not_applicable" });
		expect(missing.fake.snapshot()).toEqual(beforeMissing);
		const valid = await fakeHistory("succeeded");
		const beforeValid = valid.fake.snapshot();
		valid.fake.failNextCommit();
		await expect(
			valid.fake.requestMetadataRecovery(valid.query),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(valid.fake.snapshot()).toEqual(beforeValid);
		await expect(
			valid.fake.requestMetadataRecovery(valid.query),
		).resolves.toEqual({ outcome: "scheduled" });
	});
});

describe("model-selection fallback requested model (G-07)", () => {
	const conversation = {
		schemaVersion: 1 as const,
		conversationId: "conversation_01",
		agentId: authority.agentId,
		actorId: authority.actorId,
		channelId: authority.channelId,
		status: "ready" as const,
		sessionGeneration: 1,
		hostSessionRef: null,
		authorizationRevision: authority.authorizationRevision,
		lastConversationCursor: 0,
		selectedModelOptionId: "model_alternate",
		selectedReasoningLevel: "high",
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	const current = {
		configurationRevision: 2,
		options: [{ optionId: "model_primary", reasoningLevels: ["medium"] }],
		defaultOptionId: "model_primary",
		defaultReasoningLevel: "medium",
	};
	const state = (modelConfiguration: unknown) =>
		({
			conversation,
			modelConfiguration,
			sourceMessage: undefined,
			targetExecution: undefined,
			existingStop: undefined,
			activeExecution: undefined,
		}) as ConversationExecutionStateV1;
	const write = (configuration: Parameters<typeof parseState>[0]) => {
		const parsed = parseState(configuration);
		const selection = effectiveModelSelection(
			conversation,
			parsed.modelConfiguration,
		);
		return modelSelectionFallbackWrite(
			selection.fallback,
			parsed.modelConfiguration,
			authority,
			conversation.conversationId,
			"execution_01",
			0,
			0,
			"request_01",
			"trace_01",
			new Date(0),
			() => "event_01",
		)?.timelineEvent.event;
	};

	it("records the removed option and its last applied model name", () => {
		expect(
			write(
				state({
					...current,
					selectedOption: { optionId: "model_alternate", modelId: "relay-a" },
				}),
			),
		).toEqual({
			type: "model.selection.fell_back",
			modelOptionId: "model_primary",
			reasoningLevel: "medium",
			reason: "selection_unavailable",
			requestedModelOptionId: "model_alternate",
			requestedModelDisplayName: "relay-a",
		});
	});

	it("records the resolved deployment name and preserves an explicitly unavailable name", () => {
		for (const displayName of ["Trusted model name", null]) {
			expect(
				write(
					state({
						...current,
						selectedOption: {
							optionId: "model_alternate",
							modelId: "relay-a",
							displayName,
						},
					}),
				),
			).toMatchObject({
				requestedModelOptionId: "model_alternate",
				requestedModelDisplayName: displayName,
			});
		}
	});

	it("records a null name instead of the option ID when no applied record is readable", () => {
		expect(write(state(current))).toMatchObject({
			requestedModelOptionId: "model_alternate",
			requestedModelDisplayName: null,
		});
		expect(
			requestedModelDisplayNameV1(
				{
					previousModelOptionId: "model_alternate",
					previousReasoningLevel: "high",
					modelConfigurationRevision: 2,
					modelOptionId: "model_primary",
					reasoningLevel: "medium",
				},
				{
					...current,
					selectedOption: {
						optionId: "model_alternate",
						modelId: "m".repeat(1025),
					},
				},
			),
		).toBeNull();
	});

	it("fails closed when the adapter supplies another option's record or extra fields", () => {
		for (const selectedOption of [
			{ optionId: "model_primary", modelId: "relay-p" },
			{ optionId: "model_alternate", modelId: "" },
			{ optionId: "model_alternate", modelId: "relay-a", endpointId: "e" },
			{ optionId: "model_alternate", modelId: "relay-a", displayName: 42 },
			{ optionId: "model_alternate", modelId: "relay-a", displayName: "" },
			{
				optionId: "model_alternate",
				modelId: "relay-a",
				displayName: "m".repeat(1025),
			},
		]) {
			expect(() => parseState(state({ ...current, selectedOption }))).toThrow(
				ConversationExecutionError,
			);
		}
	});

	it("uses the standard option presentation rule for the display name", () => {
		expect(modelOptionDisplayNameV1({ modelId: "relay-a" })).toBe("relay-a");
	});
});

describe("queued message withdrawal (#3376)", () => {
	const withdrawAuthority = { ...authority, channelId: "web" };
	const conversation = {
		schemaVersion: 1,
		conversationId: "withdraw_conversation",
		agentId: withdrawAuthority.agentId,
		actorId: withdrawAuthority.actorId,
		channelId: "web",
		status: "active",
		sessionGeneration: 1,
		hostSessionRef: null,
		authorizationRevision: withdrawAuthority.authorizationRevision,
		lastConversationCursor: 1,
		selectedModelOptionId: null,
		selectedReasoningLevel: null,
		createdAt: new Date("2026-10-25T00:00:00.000Z"),
		updatedAt: new Date("2026-10-25T00:00:00.000Z"),
	} as const;
	const command = {
		schemaVersion: 1,
		command: "withdraw",
		conversationId: conversation.conversationId,
		targetExecutionId: "queued_execution",
		idempotencyKey: "withdraw_key",
		requestId: "withdraw_request",
		traceId: "withdraw_trace",
	} as const;
	const target = (
		status: ConversationTaskExecutionStatusV1,
		queued = true,
	) => ({
		executionId: "queued_execution",
		conversationId: conversation.conversationId,
		actorId: withdrawAuthority.actorId,
		status,
		queued,
	});

	it.each([
		["waiting", "withdrawn"],
		["unknown", "already_started"],
		["processing", "already_started"],
		["completed", "already_finished"],
		["failed", "already_finished"],
		["cancelled", "already_finished"],
	] as const)("decides a %s queued execution as %s", (status, expected) => {
		expect(
			decideConversationWithdrawalV1(
				{ conversation, target: target(status) },
				command,
				withdrawAuthority,
				"digest",
			),
		).toEqual({
			schemaVersion: 1,
			result: {
				schemaVersion: 1,
				status: expected,
				executionId: "queued_execution",
			},
			idempotency: {
				scopeType: "conversation",
				scopeId: conversation.conversationId,
				actorId: withdrawAuthority.actorId,
				commandType: "withdraw",
				key: "withdraw_key",
				requestDigest: "digest",
			},
		});
	});

	it.each([
		["another sender", { target: { ...target("waiting"), actorId: "other" } }],
		["a message that was never queued", { target: target("submitted", false) }],
		["a missing execution", { target: undefined }],
		[
			"another conversation",
			{
				target: { ...target("waiting"), conversationId: "other_conversation" },
			},
		],
	])("denies withdrawing %s", (_name, changes) => {
		expect(
			decideConversationWithdrawalV1(
				{ conversation, ...changes },
				command,
				withdrawAuthority,
				"digest",
			),
		).toEqual({ outcome: "denied" });
	});

	it("only offers withdrawal to the Web channel", () => {
		expect(
			decideConversationWithdrawalV1(
				{
					conversation: { ...conversation, channelId: "wecom_bot:channel" },
					target: target("waiting"),
				},
				command,
				{ ...withdrawAuthority, channelId: "wecom_bot:channel" },
				"digest",
			),
		).toEqual({ outcome: "denied" });
	});

	it("withdraws a queued Web message through the use case", async () => {
		const fake = new FakeConversationExecutionV1({
			authority: withdrawAuthority,
			newId: (() => {
				let value = 1;
				return () => `withdraw_${value++}`;
			})(),
		});
		await fake.createConversation({
			schemaVersion: 1,
			agentId: withdrawAuthority.agentId,
			idempotencyKey: "create_withdraw",
			requestId: "request_create_withdraw",
			traceId: "trace_create_withdraw",
		});
		const send = (suffix: string) =>
			fake.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: "withdraw_1",
				text: suffix,
				idempotencyKey: `message_withdraw_${suffix}`,
				requestId: `request_message_withdraw_${suffix}`,
				traceId: `trace_message_withdraw_${suffix}`,
			});
		const active = await send("active");
		const queued = await send("queued");
		if (active.outcome !== "accepted" || queued.outcome !== "accepted")
			throw new Error("Expected acceptance");
		const withdraw = (executionId: string) =>
			fake.withdraw({
				...command,
				conversationId: "withdraw_1",
				targetExecutionId: executionId,
			});
		await expect(withdraw(queued.result.executionId)).resolves.toEqual({
			outcome: "accepted",
			result: {
				schemaVersion: 1,
				status: "withdrawn",
				executionId: queued.result.executionId,
			},
		});
		// 当前回复不是排队消息，不能撤回；停止当前回复另走 stop。
		await expect(withdraw(active.result.executionId)).resolves.toEqual({
			outcome: "denied",
		});
	});
});
