import { describe, expect, it } from "vitest";
import { conversationEventConformanceV1 } from "./conversation.conformance.ts";
import {
	ConversationEventError,
	type ConversationEventStateV1,
	type ConversationEventTransactionPortV1,
	type ConversationEventUseCaseV1,
	conversationEventBatchLimitV1,
	createConversationEventUseCaseV1,
	isBatchableConversationEventV1,
	parseConversationPersistedEventPayloadV1,
	publicTaskStatusEventV1,
} from "./conversation-events.js";
import { FakeConversationEventsV1 } from "./fake-conversation-events.js";

const event = {
	schemaVersion: 1 as const,
	conversationId: "conversation_events",
	executionId: "execution_events",
	sessionGeneration: 3,
	deliveryFence: 5,
	adapterEventKey: "adapter_event_1",
	runtimeCursor: "runtime_cursor_1",
	occurredAt: "2026-09-04T00:00:00.000Z",
	event: { type: "text.delta" as const, text: "Hello" },
};

conversationEventConformanceV1("Fake", async () => {
	let nextEventId = 1;
	const fake = new FakeConversationEventsV1({
		fileScope: {
			actorId: "actor",
			agentId: "agent",
			channelId: "web",
			conversationId: "conversation_event_fixture",
		},
		conversationId: "conversation_event_fixture",
		executionId: "execution_event_fixture",
		sessionGeneration: 3,
		deliveryFence: 5,
		newId: () => `event_fixture_${nextEventId++}`,
	});
	fake.seedFile({
		fileId: "file_fixture",
		objectRef: "00000000-0000-4000-8000-000000000001",
		kind: "result",
		idempotencyKey: "result_fixture",
		actorId: "actor",
		agentId: "agent",
		channelId: "web",
		conversationId: "conversation_event_fixture",
		executionId: "execution_event_fixture",
		messageId: null,
		sessionGeneration: 3,
		status: "available",
		descriptor: {
			name: "fixture.txt",
			mediaType: "text/plain",
			sizeBytes: 16,
			sha256: "0".repeat(64),
		},
		objectVersion: "version",
		etag: "etag",
		createdAt: "2026-09-04T00:00:00Z",
		updatedAt: "2026-09-04T00:00:00Z",
		expiresAt: "2026-09-04T01:00:00Z",
		revision: 1,
	});
	let loseNextResponse = false;
	const events: ConversationEventUseCaseV1 = {
		async persist(command) {
			const decision = await fake.persist(command);
			if (loseNextResponse) {
				loseNextResponse = false;
				throw new Error("Injected response loss");
			}
			return decision;
		},
	};
	return {
		events,
		failNextCommit() {
			fake.failNextCommit();
		},
		loseNextResponseAfterCommit() {
			loseNextResponse = true;
		},
		async snapshot() {
			const snapshot = fake.snapshot();
			return {
				events: snapshot.events.length,
				conversationCursor: snapshot.lastConversationCursor,
				executionSequence: fake.executionSequence(),
				runtimeCursor: fake.runtimeCursor(),
			};
		},
		async close() {},
	};
});

function activeState(): ConversationEventStateV1 {
	return {
		conversation: {
			conversationId: event.conversationId,
			sessionGeneration: event.sessionGeneration,
			lastConversationCursor: 0,
		},
		execution: {
			executionId: event.executionId,
			conversationId: event.conversationId,
			sessionGeneration: event.sessionGeneration,
			deliveryFence: event.deliveryFence,
			lastSequence: 0,
		},
		existingEvent: undefined,
	};
}

describe("Conversation event ingestion", () => {
	it("allocates once and replays the original event before stale-fence classification", async () => {
		const events = new FakeConversationEventsV1({
			conversationId: event.conversationId,
			executionId: event.executionId,
			sessionGeneration: event.sessionGeneration,
			deliveryFence: event.deliveryFence,
			newId: () => "event_1",
		});

		const accepted = await events.persist(event);
		if (accepted.outcome !== "accepted") {
			throw new Error("Expected the first event to be accepted");
		}
		expect(accepted).toEqual({
			outcome: "accepted",
			event: {
				schemaVersion: 1,
				eventId: "event_1",
				conversationId: event.conversationId,
				executionId: event.executionId,
				sequence: 1,
				conversationCursor: 1,
				occurredAt: event.occurredAt,
				event: event.event,
			},
		});

		expect(
			await events.persist({
				...event,
				deliveryFence: event.deliveryFence - 1,
			}),
		).toEqual({
			outcome: "replayed",
			event: accepted.event,
		});
		expect(events.snapshot().lastConversationCursor).toBe(1);
	});

	it("accepts the current zero delivery fence without exposing private cursor metadata", async () => {
		const events = new FakeConversationEventsV1({
			conversationId: event.conversationId,
			executionId: event.executionId,
			sessionGeneration: event.sessionGeneration,
			deliveryFence: 0,
			newId: () => "event_zero_fence",
		});

		const accepted = await events.persist({ ...event, deliveryFence: 0 });
		if (accepted.outcome !== "accepted") {
			throw new Error("Expected the zero-fence event to be accepted");
		}
		expect(accepted).toMatchObject({
			outcome: "accepted",
			event: {
				eventId: "event_zero_fence",
				sequence: 1,
				conversationCursor: 1,
			},
		});
		expect(accepted.event).not.toHaveProperty("runtimeCursor");
	});

	it("rejects a first stale event without creating an event or advancing the cursor", async () => {
		const events = new FakeConversationEventsV1({
			conversationId: event.conversationId,
			executionId: event.executionId,
			sessionGeneration: event.sessionGeneration,
			deliveryFence: event.deliveryFence,
		});

		await expect(
			events.persist({
				...event,
				sessionGeneration: event.sessionGeneration - 1,
			}),
		).resolves.toEqual({ outcome: "stale" });
		await expect(
			events.persist({
				...event,
				deliveryFence: event.deliveryFence - 1,
			}),
		).resolves.toEqual({ outcome: "stale" });
		expect(events.snapshot()).toEqual({
			events: [],
			lastConversationCursor: 0,
		});
	});

	it("uses deterministic Fake IDs for equal text at distinct adapter event keys", async () => {
		const events = new FakeConversationEventsV1({
			conversationId: event.conversationId,
			executionId: event.executionId,
			sessionGeneration: event.sessionGeneration,
			deliveryFence: event.deliveryFence,
		});

		const first = await events.persist(event);
		const second = await events.persist({
			...event,
			adapterEventKey: "adapter_event_2",
			runtimeCursor: "runtime_cursor_2",
		});
		if (first.outcome !== "accepted" || second.outcome !== "accepted") {
			throw new Error("Expected both normalized events to be accepted");
		}
		expect(second.event).toMatchObject({
			eventId: "event_2",
			sequence: 2,
			conversationCursor: 2,
			event: event.event,
		});
		expect(first.event.eventId).toBe("event_1");
		expect(events.snapshot().events).toEqual([first.event, second.event]);
	});

	it("rejects raw native fields and conflicting reuse of an adapter event key", async () => {
		const events = new FakeConversationEventsV1({
			conversationId: event.conversationId,
			executionId: event.executionId,
			sessionGeneration: event.sessionGeneration,
			deliveryFence: event.deliveryFence,
		});

		await expect(
			events.persist({
				...event,
				event: {
					...event.event,
					nativeSessionId: "private_runtime_session",
				} as never,
			}),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			events.persist({
				...event,
				event: {
					type: "execution.status",
					status: "unknown",
					reason: "STOP_CONFIRMATION_TIMEOUT",
				} as never,
			}),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			events.persist({ ...event, source: "platform" } as never),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			events.persist({
				...event,
				event: {
					type: "model.selection.fell_back",
					modelOptionId: "model_primary",
					reasoningLevel: "medium",
					reason: "selection_unavailable",
				},
			} as never),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			events.persist({
				...event,
				transition: {
					executionStatus: "completed",
					conversationStatus: "ready",
				},
			} as never),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			events.persist({
				...event,
				event: { type: "execution.status", status: "completed" },
				transition: {
					executionStatus: "processing",
					conversationStatus: "active",
				},
			} as never),
		).rejects.toMatchObject({ code: "invalid_input" });
		await events.persist(event);
		await expect(
			events.persist({
				...event,
				event: { type: "text.delta", text: "changed" },
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(events.snapshot().lastConversationCursor).toBe(1);
	});

	it("fails closed when a transaction returns a forged event decision", async () => {
		const transaction: ConversationEventTransactionPortV1 = {
			persistEvent: async (_request, decide) => {
				decide(activeState());
				return {
					outcome: "accepted",
					event: {
						schemaVersion: 1,
						eventId: "event_forged",
						conversationId: "conversation_other",
						executionId: event.executionId,
						sequence: 1,
						conversationCursor: 1,
						occurredAt: event.occurredAt,
						event: event.event,
					},
				} as never;
			},
		};
		const events = createConversationEventUseCaseV1(
			{ transaction },
			{ newId: () => "event_1" },
		);

		await expect(events.persist(event)).rejects.toMatchObject({
			code: "unavailable",
		});
	});

	it("maps a transaction adapter failure to unavailable after command validation", async () => {
		const transaction: ConversationEventTransactionPortV1 = {
			persistEvent: async () => {
				throw new ConversationEventError("invalid_input");
			},
		};
		const events = createConversationEventUseCaseV1({ transaction });

		await expect(events.persist(event)).rejects.toMatchObject({
			code: "unavailable",
		});
	});

	it("fails closed when a transaction mutates the Core event plan", async () => {
		const transaction: ConversationEventTransactionPortV1 = {
			persistEvent: async (_request, decide) => {
				const plan = decide(activeState());
				if (Object.hasOwn(plan, "outcome")) {
					throw new Error("Expected an accepted event plan");
				}
				const mutablePlan = plan as {
					event: { conversationId: string };
				};
				mutablePlan.event.conversationId = "conversation_other";
				return { outcome: "accepted", event: mutablePlan.event } as never;
			},
		};
		const events = createConversationEventUseCaseV1(
			{ transaction },
			{ newId: () => "event_1" },
		);

		await expect(events.persist(event)).rejects.toMatchObject({
			code: "unavailable",
		});
	});

	it("fails closed when a transaction returns a raw replay event", async () => {
		const persisted = {
			schemaVersion: 1 as const,
			eventId: "event_replayed",
			conversationId: event.conversationId,
			executionId: event.executionId,
			sequence: 1,
			conversationCursor: 1,
			occurredAt: event.occurredAt,
			event: event.event,
		};
		const transaction: ConversationEventTransactionPortV1 = {
			persistEvent: async (request, decide) => {
				decide({
					...activeState(),
					existingEvent: {
						event: persisted,
						eventDigest: request.eventDigest,
					},
				});
				return {
					outcome: "replayed",
					event: {
						...persisted,
						event: {
							...persisted.event,
							nativeSessionId: "private_runtime_session",
						},
					},
				} as never;
			},
		};
		const events = createConversationEventUseCaseV1({ transaction });

		await expect(events.persist(event)).rejects.toMatchObject({
			code: "unavailable",
		});
	});

	it("rejects a Platform fallback forged as an existing Runtime event", async () => {
		const transaction: ConversationEventTransactionPortV1 = {
			persistEvent: async (request, decide) => {
				const forged = {
					schemaVersion: 1 as const,
					eventId: "event_forged_fallback",
					conversationId: event.conversationId,
					executionId: event.executionId,
					sequence: 1,
					conversationCursor: 1,
					occurredAt: event.occurredAt,
					event: {
						type: "model.selection.fell_back" as const,
						modelOptionId: "model_primary",
						reasoningLevel: "medium",
						reason: "selection_unavailable" as const,
					},
				};
				decide({
					...activeState(),
					existingEvent: {
						event: forged,
						eventDigest: request.eventDigest,
					},
				} as never);
				return { outcome: "replayed", event: forged } as never;
			},
		};
		const events = createConversationEventUseCaseV1({ transaction });

		await expect(events.persist(event)).rejects.toMatchObject({
			code: "unavailable",
		});
	});
});

describe("batched delta persistence (#3378)", () => {
	const delta = (index: number) => ({
		...event,
		adapterEventKey: `adapter_event_${index}`,
		runtimeCursor: `runtime_cursor_${index}`,
		event: { type: "text.delta" as const, text: `part ${index}` },
	});

	it("classifies only plain deltas as batchable", () => {
		expect(isBatchableConversationEventV1(delta(1))).toBe(true);
		expect(
			isBatchableConversationEventV1({
				...delta(1),
				event: { type: "reasoning.delta", kind: "raw", text: "thought" },
			}),
		).toBe(true);
		expect(
			isBatchableConversationEventV1({
				...delta(1),
				transition: {
					executionStatus: "processing",
					conversationStatus: "active",
				},
			}),
		).toBe(false);
		expect(
			isBatchableConversationEventV1({
				...delta(1),
				operationMetadataOnly: true,
			}),
		).toBe(false);
		expect(
			isBatchableConversationEventV1({
				...delta(1),
				event: { type: "execution.status", status: "processing" },
			} as never),
		).toBe(false);
	});

	it("decides each event from the counters left by the previous one", async () => {
		const seen: number[] = [];
		const transaction: ConversationEventTransactionPortV1 = {
			persistEvent: async () => {
				throw new Error("single persistence is not used");
			},
			persistEvents: async (requests, decide) => {
				let sequence = 0;
				return requests.map((_request, index) => {
					const state = activeState();
					const plan = decide(index, {
						...state,
						conversation: state.conversation && {
							...state.conversation,
							lastConversationCursor: sequence,
						},
						execution: state.execution && {
							...state.execution,
							lastSequence: sequence,
						},
					});
					if (Object.hasOwn(plan, "outcome"))
						throw new Error("Expected an accepted event plan");
					const accepted = plan as { event: { sequence: number } };
					sequence = accepted.event.sequence;
					seen.push(sequence);
					return { outcome: "accepted", event: accepted.event } as never;
				});
			},
		};
		let id = 0;
		const events = createConversationEventUseCaseV1(
			{ transaction },
			{ newId: () => `event_${++id}` },
		);
		const decisions = await events.persistBatch?.([
			delta(1),
			delta(2),
			delta(3),
		]);
		expect(seen).toEqual([1, 2, 3]);
		expect(decisions?.map((decision) => decision.outcome)).toEqual([
			"accepted",
			"accepted",
			"accepted",
		]);
	});

	it("rejects a batch that mixes Executions, non-deltas or exceeds 64 events", async () => {
		const transaction: ConversationEventTransactionPortV1 = {
			persistEvent: async () => {
				throw new Error("not used");
			},
			persistEvents: async () => {
				throw new Error("not used");
			},
		};
		const events = createConversationEventUseCaseV1({ transaction });
		await expect(events.persistBatch?.([])).rejects.toMatchObject({
			code: "invalid_input",
		});
		await expect(
			events.persistBatch?.([
				delta(1),
				{ ...delta(2), executionId: "execution_other" },
			]),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			events.persistBatch?.([
				delta(1),
				{
					...delta(2),
					event: { type: "execution.status", status: "processing" },
				} as never,
			]),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			events.persistBatch?.(
				Array.from({ length: conversationEventBatchLimitV1 + 1 }, (_, index) =>
					delta(index + 1),
				),
			),
		).rejects.toMatchObject({ code: "invalid_input" });
	});

	it("persists one by one when the transaction has no batch port", async () => {
		let single = 0;
		const transaction: ConversationEventTransactionPortV1 = {
			persistEvent: async (_request, decide) => {
				single++;
				const state = activeState();
				const plan = decide({
					...state,
					conversation: state.conversation && {
						...state.conversation,
						lastConversationCursor: single - 1,
					},
					execution: state.execution && {
						...state.execution,
						lastSequence: single - 1,
					},
				});
				return {
					outcome: "accepted",
					event: (plan as { event: unknown }).event,
				} as never;
			},
		};
		const events = createConversationEventUseCaseV1({ transaction });
		const decisions = await events.persistBatch?.([delta(1), delta(2)]);
		expect(single).toBe(2);
		expect(decisions).toHaveLength(2);
	});

	it("fails closed when the batch port returns a different number of decisions", async () => {
		const transaction: ConversationEventTransactionPortV1 = {
			persistEvent: async () => {
				throw new Error("not used");
			},
			persistEvents: async (_requests, decide) => {
				const plan = decide(0, activeState()) as { event: unknown };
				return [{ outcome: "accepted", event: plan.event }] as never;
			},
		};
		const events = createConversationEventUseCaseV1({ transaction });
		await expect(
			events.persistBatch?.([delta(1), delta(2)]),
		).rejects.toMatchObject({
			code: "unavailable",
		});
	});
});

describe("platform-owned task status reasons", () => {
	it("publishes only bounded reasons for the matching state", () => {
		expect(
			publicTaskStatusEventV1({
				isTask: true,
				status: "failed",
				reason: "TASK_WAIT_TIMEOUT",
			}),
		).toEqual({
			type: "task.status",
			status: "failed",
			reason: "TASK_WAIT_TIMEOUT",
		});
		expect(
			publicTaskStatusEventV1({
				isTask: true,
				status: "failed",
				reason: "private runtime text",
			}),
		).toEqual({
			type: "task.status",
			status: "failed",
		});
		expect(
			publicTaskStatusEventV1({
				isTask: false,
				status: "failed",
				reason: "TASK_WAIT_TIMEOUT",
			}),
		).toBeNull();
	});

	it("reads bounded failure and stop reasons while rejecting invalid pairs", () => {
		expect(
			parseConversationPersistedEventPayloadV1({
				type: "task.status",
				status: "unknown",
				reason: "STOP_CONFIRMATION_TIMEOUT",
			}),
		).toEqual({
			type: "task.status",
			status: "unknown",
			reason: "STOP_CONFIRMATION_TIMEOUT",
		});
		expect(
			parseConversationPersistedEventPayloadV1({
				type: "task.status",
				status: "failed",
				reason: "AGENT_UNAVAILABLE",
			}),
		).toEqual({
			type: "task.status",
			status: "failed",
			reason: "AGENT_UNAVAILABLE",
		});
		for (const payload of [
			{
				type: "task.status",
				status: "processing",
				reason: "STOP_CONFIRMATION_TIMEOUT",
			},
			{
				type: "task.status",
				status: "unknown",
				reason: "private runtime text",
			},
			{ type: "task.status", status: "waiting", reason: "TASK_WAIT_TIMEOUT" },
			{
				type: "execution.status",
				status: "unknown",
				reason: "STOP_CONFIRMATION_TIMEOUT",
			},
		])
			expect(() => parseConversationPersistedEventPayloadV1(payload)).toThrow(
				ConversationEventError,
			);
	});
});

describe("reasoning delta events (#2979)", () => {
	const reasoning = {
		type: "reasoning.delta" as const,
		kind: "raw" as const,
		text: "Synthetic thought",
	};

	it("reads bounded raw and summary reasoning as persisted conversation content", () => {
		expect(parseConversationPersistedEventPayloadV1(reasoning)).toEqual(
			reasoning,
		);
		const summary = { ...reasoning, kind: "summary" as const };
		expect(parseConversationPersistedEventPayloadV1(summary)).toEqual(summary);
		const limit = { ...reasoning, text: "思".repeat(21_845) };
		expect(parseConversationPersistedEventPayloadV1(limit)).toEqual(limit);
		for (const payload of [
			{ ...reasoning, kind: "encrypted" },
			{ ...reasoning, kind: undefined },
			{ type: "reasoning.delta", text: "missing kind" },
			{ ...reasoning, text: "" },
			{ ...reasoning, text: "x".repeat(65_537) },
			{ ...reasoning, text: "\u0000" },
			{ ...reasoning, signature: "opaque" },
			{ ...reasoning, encrypted_content: "opaque" },
		])
			expect(() => parseConversationPersistedEventPayloadV1(payload)).toThrow(
				ConversationEventError,
			);
	});

	it("persists reasoning as a Runtime event with its own cursor and no transition", async () => {
		const events = new FakeConversationEventsV1({
			conversationId: event.conversationId,
			executionId: event.executionId,
			sessionGeneration: event.sessionGeneration,
			deliveryFence: event.deliveryFence,
			newId: () => "event_reasoning",
		});
		const accepted = await events.persist({ ...event, event: reasoning });
		expect(accepted).toMatchObject({
			outcome: "accepted",
			event: {
				eventId: "event_reasoning",
				sequence: 1,
				conversationCursor: 1,
				event: reasoning,
			},
		});
		// 思考过程不能带状态迁移，也不能用同一个 adapter key 改写内容。
		await expect(
			events.persist({
				...event,
				adapterEventKey: "adapter-event-transition",
				runtimeCursor: "runtime-cursor-transition",
				event: reasoning,
				transition: {
					executionStatus: "completed",
					conversationStatus: "ready",
				},
			}),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			events.persist({
				...event,
				event: { ...reasoning, text: "changed thought" },
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(events.snapshot().lastConversationCursor).toBe(1);
	});
});

describe("Browser handoff event parsing", () => {
	it("accepts a bounded authenticated transition and rejects a mismatched binding", () => {
		const payload = {
			type: "browser.handoff" as const,
			handoffId: "handoff-1",
			status: "active" as const,
			reason: "mfa" as const,
			requestedAt: "2026-10-14T00:00:00.000Z",
			expiresAt: "2026-10-14T00:05:00.000Z",
			operatorId: "subject-1",
			terminalReason: "BROWSER_HANDOFF_RETURNED",
			binding: {
				subjectId: "subject-1",
				agentId: "agent-1",
				conversationId: "conversation-1",
				executionId: "execution-1",
				sessionGeneration: 2,
				resourceFence: 7,
				workloadRevision: 3,
				imageDigest: `sha256:${"a".repeat(64)}`,
				capabilityVersion: 4,
				capabilityRevision: 4,
				pageRevision: 5,
			},
		};
		expect(parseConversationPersistedEventPayloadV1(payload)).toEqual(payload);
		expect(() =>
			parseConversationPersistedEventPayloadV1({
				...payload,
				binding: { ...payload.binding, pageRevision: 0 },
			}),
		).toThrow(ConversationEventError);
	});
});

describe("Browser side-effect event parsing", () => {
	it("accepts a bounded pending confirmation and rejects scope drift", () => {
		const payload = {
			type: "browser.side_effect" as const,
			confirmationId: "confirmation-1",
			status: "pending" as const,
			requestedAt: "2026-10-14T00:00:00.000Z",
			expiresAt: "2026-10-14T00:05:00.000Z",
			operation: "click",
			targetOrigin: "https://example.test",
			redactedTargetSummary: "提交公开表单",
			binding: {
				subjectId: "subject-1",
				agentId: "agent-1",
				conversationId: "conversation-1",
				executionId: "execution-1",
				sessionGeneration: 2,
				resourceFence: 7,
				workloadRevision: 3,
				imageDigest: `sha256:${"a".repeat(64)}`,
				capabilityVersion: 4,
				capabilityRevision: 4,
				pageRevision: 5,
				actionId: "action-1",
				confirmationId: "confirmation-1",
				operationRef: "operation-1",
				attemptRef: "attempt-1",
			},
		};
		expect(parseConversationPersistedEventPayloadV1(payload)).toEqual(payload);
		expect(() =>
			parseConversationPersistedEventPayloadV1({
				...payload,
				binding: { ...payload.binding, confirmationId: "foreign" },
			}),
		).toThrow(ConversationEventError);
		expect(() =>
			parseConversationPersistedEventPayloadV1({
				...payload,
				targetOrigin: "https://example.test/path",
			}),
		).toThrow(ConversationEventError);
	});
});

describe("model-selection fallback payload parsing (G-07)", () => {
	const legacy = {
		type: "model.selection.fell_back" as const,
		modelOptionId: "model_primary",
		reasoningLevel: "medium",
		reason: "selection_unavailable" as const,
	};

	it("keeps legacy payloads without the requested model readable", () => {
		expect(parseConversationPersistedEventPayloadV1(legacy)).toEqual(legacy);
	});

	it("reads the requested option with its accepted display name or a null name", () => {
		for (const requestedModelDisplayName of ["relay-model-alternate", null]) {
			const payload = {
				...legacy,
				requestedModelOptionId: "model_alternate",
				requestedModelDisplayName,
			};
			expect(parseConversationPersistedEventPayloadV1(payload)).toEqual(
				payload,
			);
		}
	});

	it("rejects unpaired, empty, overlong or extra requested-model fields", () => {
		for (const payload of [
			{ ...legacy, requestedModelOptionId: "model_alternate" },
			{ ...legacy, requestedModelDisplayName: "relay-model-alternate" },
			{
				...legacy,
				requestedModelOptionId: "",
				requestedModelDisplayName: "relay-model-alternate",
			},
			{
				...legacy,
				requestedModelOptionId: "model_alternate",
				requestedModelDisplayName: "",
			},
			{
				...legacy,
				requestedModelOptionId: "model_alternate",
				requestedModelDisplayName: "m".repeat(1025),
			},
			{
				...legacy,
				requestedModelOptionId: "model_alternate",
				requestedModelDisplayName: 7,
			},
			{
				...legacy,
				requestedModelOptionId: "model_alternate",
				requestedModelDisplayName: "relay-model-alternate",
				requestedReasoningLevel: "high",
			},
		]) {
			expect(() => parseConversationPersistedEventPayloadV1(payload)).toThrow(
				ConversationEventError,
			);
		}
	});
});

describe("waiting control event ownership", () => {
	it("reads the platform cancellation event without exposing its internal reason", () => {
		const payload = publicTaskStatusEventV1({
			isTask: true,
			status: "cancelled",
			reason: "AUTHORIZATION_REVOKED",
		});
		expect(payload).toEqual({ type: "task.status", status: "cancelled" });
		expect(parseConversationPersistedEventPayloadV1(payload)).toEqual(payload);
	});

	it("rejects a platform task event forged as a previously persisted Runtime event", async () => {
		const transaction: ConversationEventTransactionPortV1 = {
			persistEvent: async (request, decide) => {
				const forged = {
					schemaVersion: 1 as const,
					eventId: "event_forged_task",
					conversationId: event.conversationId,
					executionId: event.executionId,
					sequence: 1,
					conversationCursor: 1,
					occurredAt: event.occurredAt,
					event: { type: "task.status" as const, status: "cancelled" as const },
				};
				decide({
					...activeState(),
					existingEvent: { event: forged, eventDigest: request.eventDigest },
				} as never);
				return { outcome: "replayed", event: forged } as never;
			},
		};
		const events = createConversationEventUseCaseV1({ transaction });
		await expect(events.persist(event)).rejects.toMatchObject({
			code: "unavailable",
		});
	});
});
