import { describe, expect, it } from "vitest";
import type {
	ConversationEventCommandV1,
	ConversationEventUseCaseV1,
	ConversationNormalizedEventV1,
} from "./conversation-events.ts";
import type {
	ConversationCommandResultV1,
	ConversationExecutionAuthorityV1,
	ConversationExecutionUseCaseV1,
	ConversationModelConfigurationV1,
	ConversationModelSelectionFallbackV1,
} from "./conversation-execution.ts";

export const conversationConformanceAuthorityV1: ConversationExecutionAuthorityV1 =
	{
		schemaVersion: 1,
		actorId: "actor_fixture",
		agentId: "agent_fixture",
		channelId: "channel_fixture",
		authorizationRevision: "authorization_fixture_1",
		supportsSupplementaryInstruction: true,
	};

const conversationConformanceModelConfigurationV1 = {
	configurationRevision: 1,
	options: [
		{ optionId: "model_primary", reasoningLevels: ["low", "medium"] },
		{ optionId: "model_alternate", reasoningLevels: ["high"] },
	],
	defaultOptionId: "model_primary",
	defaultReasoningLevel: "low",
} as const satisfies ConversationModelConfigurationV1;

export interface ConversationCommandConformanceSnapshotV1 {
	readonly conversations: number;
	readonly messages: number;
	readonly executions: number;
	readonly stops: number;
	readonly outbox: number;
	readonly audit: number;
	readonly idempotency: number;
}

export interface ConversationCommandConformanceHarnessV1 {
	readonly useCase: ConversationExecutionUseCaseV1;
	setAuthority(authority: ConversationExecutionAuthorityV1 | undefined): void;
	failNextCommit(): Promise<void> | void;
	failNextModelSelectionCommit(): Promise<void> | void;
	loseNextResponseAfterCommit(): void;
	completeExecution(executionId: string): Promise<void> | void;
	setModelConfiguration(
		configuration: ConversationModelConfigurationV1 | undefined,
	): Promise<void> | void;
	modelSnapshot(conversationId: string): Promise<{
		readonly selectedModelOptionId: string | null;
		readonly selectedReasoningLevel: string | null;
		readonly executions: readonly {
			readonly executionId: string;
			readonly modelConfigurationRevision: number | null;
			readonly modelOptionId: string | null;
			readonly reasoningLevel: string | null;
		}[];
		readonly outbox: readonly {
			readonly executionId: string;
			readonly modelConfigurationRevision: number | null;
			readonly modelOptionId: string | null;
			readonly reasoningLevel: string | null;
		}[];
		readonly auditActions: readonly string[];
		readonly fallbackFacts: readonly ConversationModelSelectionFallbackV1[];
	}>;
	snapshot(): Promise<ConversationCommandConformanceSnapshotV1>;
	close(): Promise<void>;
}

function modelSelectionFixture(conversationId: string, fixture: string) {
	return {
		schemaVersion: 1 as const,
		command: "model.select" as const,
		conversationId,
		modelOptionId: "model_alternate",
		reasoningLevel: "high",
		idempotencyKey: `model_selection_${fixture}`,
		requestId: `request_model_selection_${fixture}`,
		traceId: `trace_model_selection_${fixture}`,
	};
}

async function createConversationFixture(
	harness: ConversationCommandConformanceHarnessV1,
	fixture: string,
): Promise<string> {
	const decision = await harness.useCase.createConversation({
		schemaVersion: 1,
		agentId: conversationConformanceAuthorityV1.agentId,
		idempotencyKey: `create_${fixture}`,
		requestId: `request_create_${fixture}`,
		traceId: `trace_create_${fixture}`,
	});
	if (decision.outcome !== "accepted") {
		throw new Error("Expected Conversation creation to be accepted");
	}
	return decision.result.conversationId;
}

function messageFixture(conversationId: string, fixture: string, text: string) {
	return {
		schemaVersion: 1 as const,
		command: "message" as const,
		conversationId,
		text,
		idempotencyKey: `message_${fixture}`,
		requestId: `request_message_${fixture}`,
		traceId: `trace_message_${fixture}`,
	};
}

async function acceptMessageFixture(
	harness: ConversationCommandConformanceHarnessV1,
	conversationId: string,
	fixture: string,
	text: string,
): Promise<ConversationCommandResultV1 & { readonly messageId: string }> {
	const decision = await harness.useCase.accept(
		messageFixture(conversationId, fixture, text),
	);
	if (decision.outcome !== "accepted" || decision.result.messageId === null) {
		throw new Error("Expected message acceptance");
	}
	return { ...decision.result, messageId: decision.result.messageId };
}

export function conversationCommandConformanceV1(
	adapterName: string,
	open: () => Promise<ConversationCommandConformanceHarnessV1>,
): void {
	describe(`${adapterName} Conversation command conformance`, () => {
		it("serializes concurrent same-key commands without duplicate effects", async () => {
			const harness = await open();
			try {
				const conversationId = await createConversationFixture(
					harness,
					"concurrent_fixture",
				);
				const command = messageFixture(
					conversationId,
					"concurrent_fixture",
					"bounded fixture message",
				);
				const decisions = await Promise.all([
					harness.useCase.accept(command),
					harness.useCase.accept(command),
				]);
				expect(decisions.map(({ outcome }) => outcome).toSorted()).toEqual([
					"accepted",
					"replayed",
				]);
				const accepted = decisions.find(
					(decision) => decision.outcome === "accepted",
				);
				const replayed = decisions.find(
					(decision) => decision.outcome === "replayed",
				);
				if (accepted?.outcome !== "accepted") {
					throw new Error("Expected one accepted command");
				}
				if (replayed?.outcome !== "replayed") {
					throw new Error("Expected one replayed command");
				}
				expect(replayed.result).toEqual(accepted.result);
				await harness.completeExecution(accepted.result.executionId);
				harness.setAuthority({
					...conversationConformanceAuthorityV1,
					supportsSupplementaryInstruction: false,
				});
				await expect(harness.useCase.accept(command)).resolves.toEqual({
					outcome: "replayed",
					result: accepted.result,
				});
				await expect(
					harness.useCase.accept({
						...command,
						text: "bounded conflicting fixture",
					}),
				).resolves.toEqual({
					outcome: "conflict",
					reason: "idempotency_conflict",
				});
				expect(await harness.snapshot()).toEqual({
					conversations: 1,
					messages: 1,
					executions: 1,
					stops: 0,
					outbox: 1,
					audit: 1,
					idempotency: 2,
				});
			} finally {
				await harness.close();
			}
		});

		it("binds a supplemental message to the active execution idempotently", async () => {
			const harness = await open();
			try {
				const conversationId = await createConversationFixture(
					harness,
					"supplement_fixture",
				);
				const initial = await acceptMessageFixture(
					harness,
					conversationId,
					"initial_supplement_fixture",
					"bounded initial supplement fixture",
				);
				const supplement = messageFixture(
					conversationId,
					"supplement_fixture",
					"bounded supplemental fixture",
				);
				const accepted = await harness.useCase.accept(supplement);
				if (accepted.outcome !== "accepted") {
					throw new Error("Expected supplemental message acceptance");
				}
				expect(accepted.result.executionId).toBe(initial.executionId);
				expect(accepted.result.messageId).not.toBeNull();
				await expect(harness.useCase.accept(supplement)).resolves.toEqual({
					outcome: "replayed",
					result: accepted.result,
				});
				expect(await harness.snapshot()).toEqual({
					conversations: 1,
					messages: 2,
					executions: 1,
					stops: 0,
					outbox: 2,
					audit: 2,
					idempotency: 3,
				});
			} finally {
				await harness.close();
			}
		});

		it("serializes distinct concurrent commands into one active execution", async () => {
			const harness = await open();
			try {
				harness.setAuthority({
					...conversationConformanceAuthorityV1,
					supportsSupplementaryInstruction: false,
				});
				const conversationId = await createConversationFixture(
					harness,
					"distinct_fixture",
				);
				const decisions = await Promise.all(
					["first", "second"].map((suffix) =>
						harness.useCase.accept(
							messageFixture(
								conversationId,
								`${suffix}_concurrent_fixture`,
								`bounded ${suffix} concurrent fixture`,
							),
						),
					),
				);
				expect(decisions.map(({ outcome }) => outcome).toSorted()).toEqual([
					"accepted",
					"busy",
				]);
				expect(await harness.snapshot()).toEqual({
					conversations: 1,
					messages: 1,
					executions: 1,
					stops: 0,
					outbox: 1,
					audit: 1,
					idempotency: 2,
				});
			} finally {
				await harness.close();
			}
		});

		it("rejects authorization loss and busy commands without visible effects", async () => {
			const harness = await open();
			try {
				const conversationId = await createConversationFixture(
					harness,
					"authorization_fixture",
				);
				const initial = await acceptMessageFixture(
					harness,
					conversationId,
					"authorization_fixture",
					"bounded authorization fixture",
				);
				const before = await harness.snapshot();

				harness.setAuthority(undefined);
				await expect(
					harness.useCase.accept(
						messageFixture(
							conversationId,
							"denied_fixture",
							"bounded denied fixture",
						),
					),
				).resolves.toEqual({ outcome: "denied" });
				await expect(
					harness.useCase.regenerate({
						schemaVersion: 1,
						command: "regenerate",
						conversationId,
						sourceMessageId: initial.messageId,
						idempotencyKey: "regenerate_denied_fixture",
						requestId: "request_regenerate_denied_fixture",
						traceId: "trace_regenerate_denied_fixture",
					}),
				).resolves.toEqual({ outcome: "denied" });
				await expect(
					harness.useCase.stop({
						schemaVersion: 1,
						command: "stop",
						conversationId,
						targetExecutionId: initial.executionId,
						idempotencyKey: "stop_denied_fixture",
						requestId: "request_stop_denied_fixture",
						traceId: "trace_stop_denied_fixture",
					}),
				).resolves.toEqual({ outcome: "denied" });

				harness.setAuthority({
					...conversationConformanceAuthorityV1,
					supportsSupplementaryInstruction: false,
				});
				await expect(
					harness.useCase.accept(
						messageFixture(
							conversationId,
							"busy_fixture",
							"bounded busy fixture",
						),
					),
				).resolves.toEqual({ outcome: "busy" });
				expect(await harness.snapshot()).toEqual(before);
			} finally {
				await harness.close();
			}
		});

		it("denies a foreign actor authority without visible effects", async () => {
			const harness = await open();
			try {
				const conversationId = await createConversationFixture(
					harness,
					"foreign_actor_fixture",
				);
				await acceptMessageFixture(
					harness,
					conversationId,
					"foreign_actor_initial_fixture",
					"bounded foreign actor initial fixture",
				);
				const before = await harness.snapshot();
				harness.setAuthority({
					...conversationConformanceAuthorityV1,
					actorId: "foreign_actor_fixture",
				});
				await expect(
					harness.useCase.accept(
						messageFixture(
							conversationId,
							"foreign_actor_fixture",
							"bounded foreign actor fixture",
						),
					),
				).resolves.toEqual({ outcome: "denied" });
				expect(await harness.snapshot()).toEqual(before);
			} finally {
				await harness.close();
			}
		});

		it("rolls back a failed command without exposing partial state", async () => {
			const harness = await open();
			try {
				const conversationId = await createConversationFixture(
					harness,
					"rollback_fixture",
				);
				const command = messageFixture(
					conversationId,
					"rollback_fixture",
					"bounded rollback fixture",
				);
				const before = await harness.snapshot();
				await harness.failNextCommit();
				await expect(harness.useCase.accept(command)).rejects.toMatchObject({
					code: "unavailable",
				});
				expect(await harness.snapshot()).toEqual(before);
				await expect(harness.useCase.accept(command)).resolves.toMatchObject({
					outcome: "accepted",
				});
				expect(await harness.snapshot()).toEqual({
					conversations: 1,
					messages: 1,
					executions: 1,
					stops: 0,
					outbox: 1,
					audit: 1,
					idempotency: 2,
				});
			} finally {
				await harness.close();
			}
		});

		it("recovers a committed command after response loss without duplicate effects", async () => {
			const harness = await open();
			try {
				const conversationId = await createConversationFixture(
					harness,
					"recovery_fixture",
				);
				const command = messageFixture(
					conversationId,
					"recovery_fixture",
					"bounded recovery fixture",
				);
				harness.loseNextResponseAfterCommit();
				await expect(harness.useCase.accept(command)).rejects.toThrow(
					"Injected response loss",
				);
				const committed = await harness.snapshot();
				expect(committed).toEqual({
					conversations: 1,
					messages: 1,
					executions: 1,
					stops: 0,
					outbox: 1,
					audit: 1,
					idempotency: 2,
				});
				await expect(harness.useCase.accept(command)).resolves.toMatchObject({
					outcome: "replayed",
				});
				expect(await harness.snapshot()).toEqual(committed);
			} finally {
				await harness.close();
			}
		});

		it("persists one model selection, snapshots executions, and falls back to the current default", async () => {
			const harness = await open();
			try {
				const conversationId = await createConversationFixture(
					harness,
					"model_selection_fixture",
				);
				const selection = modelSelectionFixture(
					conversationId,
					"model_selection_fixture",
				);
				const decisions = await Promise.all([
					harness.useCase.selectModel(selection),
					harness.useCase.selectModel(selection),
				]);
				expect(decisions.map(({ outcome }) => outcome).toSorted()).toEqual([
					"accepted",
					"replayed",
				]);
				const acceptedSelection = decisions.find(
					(decision) => decision.outcome === "accepted",
				);
				const replayedSelection = decisions.find(
					(decision) => decision.outcome === "replayed",
				);
				if (acceptedSelection?.outcome !== "accepted") {
					throw new Error("Expected one accepted model selection");
				}
				if (replayedSelection?.outcome !== "replayed") {
					throw new Error("Expected one replayed model selection");
				}
				expect(acceptedSelection.result).toEqual({
					schemaVersion: 1,
					conversationId,
				});
				expect(replayedSelection.result).toEqual(acceptedSelection.result);

				const first = await acceptMessageFixture(
					harness,
					conversationId,
					"selected_model_fixture",
					"bounded selected model fixture",
				);
				await harness.completeExecution(first.executionId);
				await harness.setModelConfiguration({
					configurationRevision: 2,
					options: [{ optionId: "model_primary", reasoningLevels: ["medium"] }],
					defaultOptionId: "model_primary",
					defaultReasoningLevel: "medium",
				});
				await expect(harness.useCase.selectModel(selection)).resolves.toEqual({
					outcome: "replayed",
					result: acceptedSelection.result,
				});
				await expect(
					harness.useCase.selectModel({
						...selection,
						modelOptionId: "model_primary",
						reasoningLevel: "medium",
					}),
				).resolves.toEqual({
					outcome: "conflict",
					reason: "idempotency_conflict",
				});
				await expect(
					harness.useCase.readConversation({
						schemaVersion: 1,
						conversationId,
					}),
				).resolves.toMatchObject({
					outcome: "found",
					result: {
						conversation: {
							conversationId,
							selectedModelOptionId: "model_primary",
							selectedReasoningLevel: "medium",
							createdAt: expect.any(Date),
							updatedAt: expect.any(Date),
						},
						modelSelectionFallback: {
							previousModelOptionId: "model_alternate",
							previousReasoningLevel: "high",
							modelConfigurationRevision: 2,
							modelOptionId: "model_primary",
							reasoningLevel: "medium",
						},
					},
				});
				const second = await acceptMessageFixture(
					harness,
					conversationId,
					"fallback_model_fixture",
					"bounded fallback model fixture",
				);
				expect(await harness.modelSnapshot(conversationId)).toEqual({
					selectedModelOptionId: "model_primary",
					selectedReasoningLevel: "medium",
					executions: [
						{
							executionId: first.executionId,
							modelConfigurationRevision: 1,
							modelOptionId: "model_alternate",
							reasoningLevel: "high",
						},
						{
							executionId: second.executionId,
							modelConfigurationRevision: 2,
							modelOptionId: "model_primary",
							reasoningLevel: "medium",
						},
					],
					outbox: [
						{
							executionId: first.executionId,
							modelConfigurationRevision: 1,
							modelOptionId: "model_alternate",
							reasoningLevel: "high",
						},
						{
							executionId: second.executionId,
							modelConfigurationRevision: 2,
							modelOptionId: "model_primary",
							reasoningLevel: "medium",
						},
					],
					auditActions: [
						"conversation.message.accepted",
						"conversation.message.accepted",
						"conversation.model_selection.fell_back",
						"conversation.model_selection.updated",
					],
					fallbackFacts: [
						{
							previousModelOptionId: "model_alternate",
							previousReasoningLevel: "high",
							modelConfigurationRevision: 2,
							modelOptionId: "model_primary",
							reasoningLevel: "medium",
						},
					],
				});
				await expect(
					harness.useCase.readConversation({
						schemaVersion: 1,
						conversationId,
					}),
				).resolves.toMatchObject({
					outcome: "found",
					result: {
						conversation: {
							selectedModelOptionId: "model_primary",
							selectedReasoningLevel: "medium",
						},
						modelSelectionFallback: null,
					},
				});
				expect(await harness.snapshot()).toEqual({
					conversations: 1,
					messages: 2,
					executions: 2,
					stops: 0,
					outbox: 2,
					audit: 4,
					idempotency: 4,
				});
			} finally {
				await harness.close();
			}
		});

		it("rejects invalid and stale model selection without partial effects", async () => {
			const harness = await open();
			try {
				const conversationId = await createConversationFixture(
					harness,
					"model_selection_denial_fixture",
				);
				const selection = modelSelectionFixture(
					conversationId,
					"model_selection_denial_fixture",
				);
				const before = await harness.snapshot();
				await expect(
					harness.useCase.selectModel({
						...selection,
						modelOptionId: "model_missing",
						idempotencyKey: "model_selection_missing",
					}),
				).resolves.toEqual({ outcome: "denied" });
				await expect(
					harness.useCase.selectModel({
						...selection,
						reasoningLevel: "medium",
						idempotencyKey: "model_selection_reasoning_missing",
					}),
				).resolves.toEqual({ outcome: "denied" });
				await expect(
					harness.useCase.selectModel({
						...selection,
						actorId: conversationConformanceAuthorityV1.actorId,
					} as never),
				).rejects.toMatchObject({ code: "invalid_input" });

				harness.setAuthority({
					...conversationConformanceAuthorityV1,
					authorizationRevision: "authorization_stale",
				});
				await expect(harness.useCase.selectModel(selection)).resolves.toEqual({
					outcome: "denied",
				});
				harness.setAuthority({
					...conversationConformanceAuthorityV1,
					actorId: "actor_foreign",
				});
				await expect(harness.useCase.selectModel(selection)).resolves.toEqual({
					outcome: "denied",
				});
				await expect(
					harness.useCase.readConversation({
						schemaVersion: 1,
						conversationId,
					}),
				).resolves.toEqual({ outcome: "denied" });
				harness.setAuthority({
					...conversationConformanceAuthorityV1,
					agentId: "agent_foreign",
				});
				await expect(harness.useCase.selectModel(selection)).resolves.toEqual({
					outcome: "denied",
				});
				await expect(
					harness.useCase.readConversation({
						schemaVersion: 1,
						conversationId,
					}),
				).resolves.toEqual({ outcome: "denied" });
				harness.setAuthority(conversationConformanceAuthorityV1);
				await harness.setModelConfiguration({
					configurationRevision: 2,
					options: [{ optionId: "model_primary", reasoningLevels: ["medium"] }],
					defaultOptionId: "model_primary",
					defaultReasoningLevel: "medium",
				});
				await expect(harness.useCase.selectModel(selection)).resolves.toEqual({
					outcome: "denied",
				});
				expect(await harness.snapshot()).toEqual(before);

				await harness.setModelConfiguration(
					conversationConformanceModelConfigurationV1,
				);
				await harness.failNextModelSelectionCommit();
				await expect(
					harness.useCase.selectModel(selection),
				).rejects.toMatchObject({
					code: "unavailable",
				});
				expect(await harness.snapshot()).toEqual(before);
				await expect(
					harness.useCase.selectModel(selection),
				).resolves.toMatchObject({
					outcome: "accepted",
				});
				expect(await harness.snapshot()).toEqual({
					...before,
					audit: 1,
					idempotency: 2,
				});
			} finally {
				await harness.close();
			}
		});

		it("serializes model selection with message acceptance without rewriting an execution", async () => {
			const harness = await open();
			try {
				const conversationId = await createConversationFixture(
					harness,
					"model_selection_order_fixture",
				);
				const selection = modelSelectionFixture(
					conversationId,
					"model_selection_order_fixture",
				);
				const [selectionDecision, messageDecision] = await Promise.all([
					harness.useCase.selectModel(selection),
					harness.useCase.accept(
						messageFixture(
							conversationId,
							"model_selection_order_fixture",
							"bounded ordered model fixture",
						),
					),
				]);
				expect(selectionDecision.outcome).toBe("accepted");
				if (messageDecision.outcome !== "accepted") {
					throw new Error("Expected concurrent message acceptance");
				}
				const firstSnapshot = await harness.modelSnapshot(conversationId);
				const firstExecution = firstSnapshot.executions[0];
				if (!firstExecution) throw new Error("Expected first Execution");
				await harness.completeExecution(messageDecision.result.executionId);
				const second = await acceptMessageFixture(
					harness,
					conversationId,
					"model_selection_order_next_fixture",
					"bounded next ordered model fixture",
				);
				const finalSnapshot = await harness.modelSnapshot(conversationId);
				expect(finalSnapshot.executions[0]).toEqual(firstExecution);
				expect(finalSnapshot.executions[1]).toEqual({
					executionId: second.executionId,
					modelConfigurationRevision: 1,
					modelOptionId: "model_alternate",
					reasoningLevel: "high",
				});
			} finally {
				await harness.close();
			}
		});

		it("stops one target and regenerates one answer version idempotently", async () => {
			const harness = await open();
			try {
				const conversationId = await createConversationFixture(
					harness,
					"lifecycle_fixture",
				);
				const initial = await acceptMessageFixture(
					harness,
					conversationId,
					"lifecycle_fixture",
					"bounded lifecycle fixture",
				);
				const stop = {
					schemaVersion: 1 as const,
					command: "stop" as const,
					conversationId,
					targetExecutionId: initial.executionId,
					idempotencyKey: "stop_lifecycle_fixture",
					requestId: "request_stop_lifecycle_fixture",
					traceId: "trace_stop_lifecycle_fixture",
				};
				await expect(harness.useCase.stop(stop)).resolves.toMatchObject({
					outcome: "accepted",
					result: { executionId: initial.executionId },
				});
				await expect(
					harness.useCase.stop({
						...stop,
						idempotencyKey: "stop_lifecycle_retry_fixture",
						requestId: "request_stop_lifecycle_retry_fixture",
						traceId: "trace_stop_lifecycle_retry_fixture",
					}),
				).resolves.toMatchObject({
					outcome: "replayed",
					result: { executionId: initial.executionId },
				});

				await harness.completeExecution(initial.executionId);
				const regeneration = {
					schemaVersion: 1 as const,
					command: "regenerate" as const,
					conversationId,
					sourceMessageId: initial.messageId,
					idempotencyKey: "regenerate_lifecycle_fixture",
					requestId: "request_regenerate_lifecycle_fixture",
					traceId: "trace_regenerate_lifecycle_fixture",
				};
				const regenerated = await harness.useCase.regenerate(regeneration);
				if (regenerated.outcome !== "accepted") {
					throw new Error("Expected regeneration acceptance");
				}
				await expect(harness.useCase.regenerate(regeneration)).resolves.toEqual(
					{ outcome: "replayed", result: regenerated.result },
				);
				expect(await harness.snapshot()).toEqual({
					conversations: 1,
					messages: 1,
					executions: 2,
					stops: 1,
					outbox: 3,
					audit: 3,
					idempotency: 5,
				});
			} finally {
				await harness.close();
			}
		});
	});
}

export interface ConversationEventConformanceSnapshotV1 {
	readonly events: number;
	readonly conversationCursor: number;
	readonly executionSequence: number;
	readonly runtimeCursor: string | null;
}

export interface ConversationEventConformanceHarnessV1 {
	readonly events: ConversationEventUseCaseV1;
	failNextCommit(): Promise<void> | void;
	loseNextResponseAfterCommit(): void;
	snapshot(): Promise<ConversationEventConformanceSnapshotV1>;
	close(): Promise<void>;
}

const eventFixture = {
	schemaVersion: 1,
	conversationId: "conversation_event_fixture",
	executionId: "execution_event_fixture",
	sessionGeneration: 3,
	deliveryFence: 5,
	adapterEventKey: "adapter_event_fixture_1",
	runtimeCursor: "runtime_cursor_fixture_1",
	occurredAt: "2026-09-04T00:00:00.000Z",
	event: { type: "text.delta", text: "bounded event fixture" },
} as const satisfies ConversationEventCommandV1;

const normalizedEventFixtures = [
	{ type: "text.delta", text: "bounded text fixture" },
	{ type: "execution.status", status: "processing" },
	{
		type: "execution.detail",
		category: "status",
		summary: "bounded detail fixture",
	},
	{
		type: "result.file",
		fileId: "file_fixture",
		name: "fixture.txt",
		mediaType: "text/plain",
		sizeBytes: 16,
	},
	{
		type: "conversation.error",
		code: "fixture_error",
		message: "bounded error fixture",
		retryable: false,
	},
] as const satisfies readonly ConversationNormalizedEventV1[];

export function conversationEventConformanceV1(
	adapterName: string,
	open: () => Promise<ConversationEventConformanceHarnessV1>,
): void {
	describe(`${adapterName} Conversation event conformance`, () => {
		it("replays a duplicate before stale fencing without advancing cursors", async () => {
			const harness = await open();
			try {
				const accepted = await harness.events.persist(eventFixture);
				if (accepted.outcome !== "accepted") {
					throw new Error("Expected event acceptance");
				}
				await expect(
					harness.events.persist({
						...eventFixture,
						deliveryFence: eventFixture.deliveryFence - 1,
					}),
				).resolves.toEqual({ outcome: "replayed", event: accepted.event });
				await expect(
					harness.events.persist({
						...eventFixture,
						event: { type: "text.delta", text: "bounded conflict fixture" },
					}),
				).rejects.toMatchObject({ code: "unavailable" });
				expect(await harness.snapshot()).toEqual({
					events: 1,
					conversationCursor: 1,
					executionSequence: 1,
					runtimeCursor: eventFixture.runtimeCursor,
				});
			} finally {
				await harness.close();
			}
		});

		it("persists every normalized event with monotonic cursors", async () => {
			const harness = await open();
			try {
				const decisions = [];
				for (const [index, event] of normalizedEventFixtures.entries()) {
					decisions.push(
						await harness.events.persist({
							...eventFixture,
							adapterEventKey: `adapter_normalized_fixture_${index + 1}`,
							runtimeCursor: `runtime_normalized_fixture_${index + 1}`,
							event,
						}),
					);
				}
				const persisted = decisions.map((decision) => {
					if (decision.outcome !== "accepted") {
						throw new Error("Expected normalized event acceptance");
					}
					return decision.event;
				});
				expect(persisted.map(({ event }) => event)).toEqual(
					normalizedEventFixtures,
				);
				expect(persisted.map(({ sequence }) => sequence)).toEqual([
					1, 2, 3, 4, 5,
				]);
				expect(
					persisted.map(({ conversationCursor }) => conversationCursor),
				).toEqual([1, 2, 3, 4, 5]);
				expect(await harness.snapshot()).toEqual({
					events: 5,
					conversationCursor: 5,
					executionSequence: 5,
					runtimeCursor: "runtime_normalized_fixture_5",
				});
			} finally {
				await harness.close();
			}
		});

		it("rejects first stale generation and fence events without visible state", async () => {
			const harness = await open();
			try {
				await expect(
					harness.events.persist({
						...eventFixture,
						sessionGeneration: eventFixture.sessionGeneration - 1,
					}),
				).resolves.toEqual({ outcome: "stale" });
				await expect(
					harness.events.persist({
						...eventFixture,
						adapterEventKey: "adapter_stale_fence_fixture",
						runtimeCursor: "runtime_stale_fence_fixture",
						deliveryFence: eventFixture.deliveryFence - 1,
					}),
				).resolves.toEqual({ outcome: "stale" });
				expect(await harness.snapshot()).toEqual({
					events: 0,
					conversationCursor: 0,
					executionSequence: 0,
					runtimeCursor: null,
				});
			} finally {
				await harness.close();
			}
		});

		it("serializes concurrent events into unique monotonic cursors", async () => {
			const harness = await open();
			try {
				const decisions = await Promise.all(
					[1, 2].map((index) =>
						harness.events.persist({
							...eventFixture,
							adapterEventKey: `adapter_concurrent_fixture_${index}`,
							runtimeCursor: `runtime_concurrent_fixture_${index}`,
						}),
					),
				);
				const persisted = decisions.map((decision) => {
					if (decision.outcome !== "accepted") {
						throw new Error("Expected concurrent event acceptance");
					}
					return decision.event;
				});
				expect(persisted.map(({ sequence }) => sequence).toSorted()).toEqual([
					1, 2,
				]);
				expect(
					persisted
						.map(({ conversationCursor }) => conversationCursor)
						.toSorted(),
				).toEqual([1, 2]);
				expect(await harness.snapshot()).toMatchObject({
					events: 2,
					conversationCursor: 2,
					executionSequence: 2,
				});
			} finally {
				await harness.close();
			}
		});

		it("rolls back a failed event without advancing any cursor", async () => {
			const harness = await open();
			try {
				await harness.failNextCommit();
				await expect(
					harness.events.persist(eventFixture),
				).rejects.toMatchObject({
					code: "unavailable",
				});
				expect(await harness.snapshot()).toEqual({
					events: 0,
					conversationCursor: 0,
					executionSequence: 0,
					runtimeCursor: null,
				});
				await expect(
					harness.events.persist(eventFixture),
				).resolves.toMatchObject({
					outcome: "accepted",
				});
				expect(await harness.snapshot()).toEqual({
					events: 1,
					conversationCursor: 1,
					executionSequence: 1,
					runtimeCursor: eventFixture.runtimeCursor,
				});
			} finally {
				await harness.close();
			}
		});

		it("recovers a committed event after response loss without duplicate state", async () => {
			const harness = await open();
			try {
				harness.loseNextResponseAfterCommit();
				await expect(harness.events.persist(eventFixture)).rejects.toThrow(
					"Injected response loss",
				);
				const committed = await harness.snapshot();
				expect(committed).toEqual({
					events: 1,
					conversationCursor: 1,
					executionSequence: 1,
					runtimeCursor: eventFixture.runtimeCursor,
				});
				await expect(
					harness.events.persist(eventFixture),
				).resolves.toMatchObject({
					outcome: "replayed",
					event: { sequence: 1, conversationCursor: 1 },
				});
				expect(await harness.snapshot()).toEqual(committed);
			} finally {
				await harness.close();
			}
		});
	});
}
