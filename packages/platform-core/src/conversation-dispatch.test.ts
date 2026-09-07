import { describe, expect, it } from "vitest";
import { FakeConversationRuntimeHostV1 } from "./fake-conversation-runtime-host.js";
import {
	type ConversationDispatchAuthorizationPortV1,
	type ConversationDispatchClaimV1,
	type ConversationDispatchStateTransitionV1,
	type ConversationDispatchStorePortV1,
	type ConversationDispatchUseCaseV1,
	type ConversationEventUseCaseV1,
	type ConversationRuntimeDispatchRequestV1,
	type ConversationRuntimeEventV1,
	type ConversationRuntimeHostPortV1,
	createConversationDispatchUseCaseV1,
} from "./index.js";

function claim(
	overrides: Partial<ConversationDispatchClaimV1> = {},
): ConversationDispatchClaimV1 {
	return {
		schemaVersion: 1,
		itemId: "conversation:turn:execution-1",
		leaseOwner: "worker-1",
		operation: "conversation.turn.submit.v1",
		requestId: "request-1",
		traceId: "trace-1",
		agentId: "agent-1",
		actorId: "actor-1",
		channelId: "web",
		conversationId: "conversation-1",
		executionId: "execution-1",
		turnId: "turn-1",
		messageId: "message-1",
		stopRequestId: null,
		sessionGeneration: 1,
		deliveryFence: 1,
		executionDeliveryFence: 1,
		authorizationRevision: "authorization-1",
		modelConfigurationRevision: 4,
		modelOptionId: "model-option-1",
		reasoningLevel: "medium",
		hostSessionRef: null,
		runtimeCursor: null,
		input: { text: "bounded fixture", attachments: [] },
		executionStatus: "submitted",
		stopPending: false,
		...overrides,
	};
}

class MemoryDispatchStore implements ConversationDispatchStorePortV1 {
	current: ConversationDispatchClaimV1;
	outboxStatus:
		| "pending"
		| "processing"
		| "retry_scheduled"
		| "succeeded"
		| "failed" = "pending";
	errorCode: string | undefined;
	renewable = true;
	recordable = true;

	constructor(seed = claim()) {
		this.current = structuredClone(seed);
	}

	async claim(input: {
		schemaVersion: 1;
		itemId: string;
		workerId: string;
		leaseDurationMs: number;
	}) {
		if (this.outboxStatus === "succeeded" || this.outboxStatus === "failed") {
			return { outcome: this.outboxStatus } as const;
		}
		this.outboxStatus = "processing";
		const nextFence =
			this.current.deliveryFence + (this.current.deliveryFence > 0 ? 1 : 0);
		const turn =
			this.current.operation === "conversation.turn.submit.v1" ||
			this.current.operation === "conversation.turn.regenerate.v1";
		this.current = {
			...this.current,
			itemId: input.itemId,
			leaseOwner: input.workerId,
			deliveryFence: nextFence,
			executionDeliveryFence: turn
				? nextFence
				: this.current.executionDeliveryFence,
		};
		return {
			outcome: "claimed" as const,
			claim: structuredClone(this.current),
		};
	}

	async renew() {
		return this.renewable && this.outboxStatus === "processing";
	}

	async recordRuntimeResponse(input: {
		claim: ConversationDispatchClaimV1;
		hostSessionRef: string;
		transition: ConversationDispatchStateTransitionV1;
	}) {
		if (!this.#owned(input.claim) || !this.recordable) return false;
		if (
			this.current.hostSessionRef !== null &&
			this.current.hostSessionRef !== input.hostSessionRef
		) {
			return false;
		}
		this.current = {
			...this.current,
			hostSessionRef: input.hostSessionRef,
			executionStatus:
				input.transition.executionStatus ?? this.current.executionStatus,
		};
		return true;
	}

	async recordEventStatus(input: {
		claim: ConversationDispatchClaimV1;
		transition: ConversationDispatchStateTransitionV1;
	}) {
		if (!this.#owned(input.claim) || !this.recordable) return false;
		this.current = {
			...this.current,
			executionStatus:
				input.transition.executionStatus ?? this.current.executionStatus,
		};
		return true;
	}

	async finish(input: {
		claim: ConversationDispatchClaimV1;
		status: "succeeded" | "failed";
		transition: ConversationDispatchStateTransitionV1;
		errorCode?: string;
	}) {
		if (!this.#owned(input.claim) || !this.recordable) return false;
		this.outboxStatus = input.status;
		this.errorCode = input.errorCode;
		this.current = {
			...this.current,
			executionStatus:
				input.transition.executionStatus ?? this.current.executionStatus,
		};
		return true;
	}

	async retry(input: {
		claim: ConversationDispatchClaimV1;
		retryDelayMs: number;
		errorCode: string;
		transition: ConversationDispatchStateTransitionV1;
	}) {
		if (!this.#owned(input.claim) || !this.recordable) return false;
		this.outboxStatus = "retry_scheduled";
		this.errorCode = input.errorCode;
		this.current = {
			...this.current,
			executionStatus:
				input.transition.executionStatus ?? this.current.executionStatus,
		};
		return true;
	}

	setRuntimeCursor(cursor: string) {
		this.current = { ...this.current, runtimeCursor: cursor };
	}

	#owned(value: ConversationDispatchClaimV1) {
		return (
			this.outboxStatus === "processing" &&
			value.itemId === this.current.itemId &&
			value.leaseOwner === this.current.leaseOwner &&
			value.deliveryFence === this.current.deliveryFence
		);
	}
}

class MemoryEvents implements Pick<ConversationEventUseCaseV1, "persist"> {
	readonly persisted: Parameters<ConversationEventUseCaseV1["persist"]>[0][] =
		[];
	loseNextResponse = false;
	stale = false;

	constructor(private readonly store: MemoryDispatchStore) {}

	async persist(command: Parameters<ConversationEventUseCaseV1["persist"]>[0]) {
		if (this.stale) return { outcome: "stale" as const };
		const existing = this.persisted.find(
			(event) => event.adapterEventKey === command.adapterEventKey,
		);
		if (!existing) this.persisted.push(structuredClone(command));
		this.store.setRuntimeCursor(command.runtimeCursor);
		if (this.loseNextResponse) {
			this.loseNextResponse = false;
			throw new Error("injected response loss after commit");
		}
		return {
			outcome: existing ? ("replayed" as const) : ("accepted" as const),
			event: {
				schemaVersion: 1 as const,
				eventId: `persisted-${command.adapterEventKey}`,
				conversationId: command.conversationId,
				executionId: command.executionId,
				sequence: 1,
				conversationCursor: 1,
				occurredAt: command.occurredAt,
				event: command.event,
			},
		};
	}
}

function authorization(
	overrides: Partial<{
		agentId: string;
		actorId: string;
		conversationId: string;
		authorizationRevision: string;
	}> = {},
): ConversationDispatchAuthorizationPortV1 {
	return {
		async authorize(input) {
			return {
				outcome: "allowed",
				authority: {
					schemaVersion: 1,
					agentId: overrides.agentId ?? input.agentId,
					actorId: overrides.actorId ?? input.actorId,
					channelId: input.channelId,
					conversationId: overrides.conversationId ?? input.conversationId,
					executionId: input.executionId,
					turnId: input.turnId,
					sessionGeneration: input.sessionGeneration,
					authorizationRevision:
						overrides.authorizationRevision ?? input.authorizationRevision,
					runtimeGrant: "synthetic-grant",
				},
			};
		},
	};
}

function runtimeEvent(
	sequence: number,
	type: "running" | "completed" = "completed",
): ConversationRuntimeEventV1 {
	return type === "running"
		? {
				schemaVersion: 1,
				adapterEventKey: `event-${sequence}`,
				executionId: "execution-1",
				cursor: `cursor-${sequence}`,
				occurredAt: `2026-09-06T00:00:0${sequence}.000Z`,
				type: "status",
				payload: { status: "running" },
			}
		: {
				schemaVersion: 1,
				adapterEventKey: `event-${sequence}`,
				executionId: "execution-1",
				cursor: `cursor-${sequence}`,
				occurredAt: `2026-09-06T00:00:0${sequence}.000Z`,
				type: "completed",
				payload: { status: "completed" },
			};
}

function setup(
	options: {
		store?: MemoryDispatchStore;
		runtimeHost?: ConversationRuntimeHostPortV1;
		authorization?: ConversationDispatchAuthorizationPortV1;
	} = {},
) {
	const store = options.store ?? new MemoryDispatchStore();
	const runtimeHost =
		options.runtimeHost ?? new FakeConversationRuntimeHostV1();
	const events = new MemoryEvents(store);
	const useCase = createConversationDispatchUseCaseV1(
		{
			store,
			authorization: options.authorization ?? authorization(),
			runtimeHost,
			events,
		},
		{ leaseDurationMs: 3_000, retryDelayMs: 0 },
	);
	return { store, runtimeHost, events, useCase };
}

function dispatch(
	useCase: ConversationDispatchUseCaseV1,
	itemId = "conversation:turn:execution-1",
) {
	return useCase.dispatch({ schemaVersion: 1, itemId, workerId: "worker-1" });
}

describe("Conversation Worker dispatch", () => {
	it("forwards the Execution-frozen selection without resolving defaults", async () => {
		const inner = new FakeConversationRuntimeHostV1();
		inner.setResult({ outcome: "accepted", status: "completed" });
		let observedRequest: ConversationRuntimeDispatchRequestV1 | undefined;
		const runtimeHost: ConversationRuntimeHostPortV1 = {
			async dispatch(request) {
				observedRequest = request;
				return inner.dispatch(request);
			},
			events: (request) => inner.events(request),
		};
		const { useCase } = setup({ runtimeHost });

		await expect(dispatch(useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "accepted",
		});
		expect(observedRequest?.selection).toEqual({
			schemaVersion: 1,
			modelOptionId: "model-option-1",
			reasoningLevel: "medium",
		});
		if (!observedRequest?.selection) {
			throw new Error("Expected a selected Runtime request");
		}
		await expect(
			inner.dispatch({
				...observedRequest,
				selection: {
					...observedRequest.selection,
					reasoningLevel: "high",
				},
			}),
		).rejects.toMatchObject({ code: "RUNTIME_OPERATION_CONFLICT" });
		expect(inner.sideEffectCount()).toBe(1);
	});

	it("persists normalized Runtime events before acknowledging them", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.setEvents([runtimeEvent(1, "running"), runtimeEvent(2)]);
		const { useCase, store, events } = setup({ runtimeHost });

		await expect(dispatch(useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "accepted",
		});

		expect(events.persisted.map((event) => event.event)).toEqual([
			{ type: "execution.status", status: "processing" },
			{ type: "execution.status", status: "completed" },
		]);
		expect(events.persisted[0]?.dispatchLease).toEqual({
			schemaVersion: 1,
			itemId: "conversation:turn:execution-1",
			leaseOwner: "worker-1",
			deliveryFence: 2,
		});
		expect(runtimeHost.acknowledgedEventCount()).toBe(2);
		expect(store.outboxStatus).toBe("succeeded");
		expect(store.current.executionStatus).toBe("completed");
	});

	it("recovers a persisted-before-ack crash without a second Runtime effect", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.setEvents([runtimeEvent(1, "running"), runtimeEvent(2)]);
		const harness = setup({ runtimeHost });
		harness.events.loseNextResponse = true;

		await expect(dispatch(harness.useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "retry",
			retryScheduled: true,
		});
		expect(runtimeHost.acknowledgedEventCount()).toBe(0);
		expect(harness.events.persisted).toHaveLength(1);

		await expect(dispatch(harness.useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "accepted",
		});
		expect(runtimeHost.sideEffectCount()).toBe(1);
		expect(harness.events.persisted).toHaveLength(2);
		expect(harness.events.persisted[1]?.adapterEventKey).toBe("event-2");
	});

	it("rejects a status event that contradicts an accepted terminal result", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.setResult({ outcome: "accepted", status: "completed" });
		runtimeHost.setEvents([runtimeEvent(1, "running"), runtimeEvent(2)]);
		const { useCase, store, events } = setup({ runtimeHost });

		await expect(dispatch(useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "rejected",
		});
		expect(events.persisted).toHaveLength(0);
		expect(runtimeHost.acknowledgedEventCount()).toBe(0);
		expect(store.current.executionStatus).toBe("completed");
		expect(store.outboxStatus).toBe("failed");
		expect(store.errorCode).toBe("RUNTIME_EVENT_CONFLICT");
	});

	it.each([
		[
			{ outcome: "busy" as const },
			{ schemaVersion: 1, outcome: "busy", retryScheduled: true },
			"RUNTIME_BUSY",
			"retry_scheduled",
		],
		[
			{
				outcome: "unknown" as const,
				code: "RUNTIME_ACCEPTANCE_UNKNOWN" as const,
				message: "Runtime command acceptance could not be confirmed" as const,
			},
			{ schemaVersion: 1, outcome: "unknown", retryScheduled: true },
			"RUNTIME_ACCEPTANCE_UNKNOWN",
			"retry_scheduled",
		],
		[
			{
				outcome: "rejected" as const,
				code: "RUNTIME_TURN_NOT_ACTIVE" as const,
				message: "Runtime turn is no longer active" as const,
				retryable: false as const,
			},
			{ schemaVersion: 1, outcome: "rejected" },
			"RUNTIME_TURN_NOT_ACTIVE",
			"failed",
		],
		[
			{
				outcome: "rejected" as const,
				code: "RUNTIME_MODEL_SELECTION_UNSUPPORTED" as const,
				message: "Runtime model selection is unsupported" as const,
				retryable: false as const,
			},
			{ schemaVersion: 1, outcome: "rejected" },
			"RUNTIME_MODEL_SELECTION_UNSUPPORTED",
			"failed",
		],
	])(
		"maps Runtime result %# to one durable product state",
		async (result, expected, code, status) => {
			const runtimeHost = new FakeConversationRuntimeHostV1();
			runtimeHost.setResult(result);
			const { useCase, store } = setup({ runtimeHost });

			await expect(dispatch(useCase)).resolves.toEqual(expected);
			expect(store.errorCode).toBe(code);
			expect(store.outboxStatus).toBe(status);
			expect(runtimeHost.sideEffectCount()).toBe(1);
		},
	);

	it("fails closed on cross-user, cross-Agent, stale, and raw-native result facts", async () => {
		for (const invalidAuthorization of [
			{ actorId: "other-actor" },
			{ agentId: "other-agent" },
			{ conversationId: "other-conversation" },
			{ authorizationRevision: "stale-authorization" },
		]) {
			const runtimeHost = new FakeConversationRuntimeHostV1();
			const { useCase } = setup({
				runtimeHost,
				authorization: authorization(invalidAuthorization),
			});
			await expect(dispatch(useCase)).rejects.toMatchObject({
				code: "unavailable",
			});
			expect(runtimeHost.sideEffectCount()).toBe(0);
		}

		const staleStore = new MemoryDispatchStore();
		staleStore.recordable = false;
		const staleRuntime = new FakeConversationRuntimeHostV1();
		await expect(
			dispatch(setup({ store: staleStore, runtimeHost: staleRuntime }).useCase),
		).resolves.toEqual({ schemaVersion: 1, outcome: "stale" });

		const rawRuntime: ConversationRuntimeHostPortV1 = {
			async dispatch(request) {
				return {
					schemaVersion: 2,
					hostSessionRef: "host-raw",
					operationId: request.executionId,
					result: { outcome: "accepted", status: "running" },
					nativeSessionId: "must-not-cross",
				} as never;
			},
			async *events() {},
		};
		const raw = setup({ runtimeHost: rawRuntime });
		await expect(dispatch(raw.useCase)).resolves.toMatchObject({
			outcome: "retry",
			retryScheduled: true,
		});
		expect(raw.events.persisted).toHaveLength(0);
	});

	it("maps authorization denial and temporary failure before Runtime dispatch", async () => {
		for (const outcome of ["denied", "unavailable"] as const) {
			const runtimeHost = new FakeConversationRuntimeHostV1();
			const harness = setup({
				runtimeHost,
				authorization: {
					async authorize() {
						return { outcome };
					},
				},
			});
			await expect(dispatch(harness.useCase)).resolves.toMatchObject(
				outcome === "denied"
					? { outcome: "rejected" }
					: { outcome: "retry", retryScheduled: true },
			);
			expect(runtimeHost.sideEffectCount()).toBe(0);
			expect(harness.store.outboxStatus).toBe(
				outcome === "denied" ? "failed" : "retry_scheduled",
			);
		}
	});

	it("recovers an acceptance-unknown Turn before dispatching its pending stop", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.setResult({ outcome: "accepted", status: "completed" });
		const store = new MemoryDispatchStore(
			claim({ executionStatus: "unknown", stopPending: true }),
		);
		const { useCase } = setup({ store, runtimeHost });

		await expect(dispatch(useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "accepted",
		});
		expect(runtimeHost.sideEffectCount()).toBe(1);
		expect(store.current.executionStatus).toBe("completed");
		expect(store.outboxStatus).toBe("succeeded");
	});

	it("does not acknowledge stale or raw-native Runtime events", async () => {
		const staleRuntime = new FakeConversationRuntimeHostV1();
		staleRuntime.setEvents([runtimeEvent(1)]);
		const stale = setup({ runtimeHost: staleRuntime });
		stale.events.stale = true;
		await expect(dispatch(stale.useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "stale",
		});
		expect(staleRuntime.acknowledgedEventCount()).toBe(0);

		const rawRuntime: ConversationRuntimeHostPortV1 = {
			async dispatch(request) {
				return {
					schemaVersion: 2,
					hostSessionRef: "host-raw-event",
					operationId: request.executionId,
					result: { outcome: "accepted", status: "running" },
				};
			},
			async *events() {
				yield {
					...runtimeEvent(1),
					nativeSessionId: "must-not-cross",
				} as never;
			},
		};
		const raw = setup({ runtimeHost: rawRuntime });
		await expect(dispatch(raw.useCase)).resolves.toMatchObject({
			outcome: "retry",
			retryScheduled: true,
		});
		expect(raw.events.persisted).toHaveLength(0);
	});

	it("isolates a failed Runtime Session from another Conversation", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.failNext();
		const first = setup({ runtimeHost });
		const secondStore = new MemoryDispatchStore(
			claim({
				itemId: "conversation:turn:execution-2",
				conversationId: "conversation-2",
				executionId: "execution-2",
				turnId: "turn-2",
				messageId: "message-2",
			}),
		);
		const secondEvents = new MemoryEvents(secondStore);
		const second = createConversationDispatchUseCaseV1(
			{
				store: secondStore,
				authorization: authorization(),
				runtimeHost,
				events: secondEvents,
			},
			{ leaseDurationMs: 3_000, retryDelayMs: 0 },
		);

		await expect(dispatch(first.useCase)).resolves.toMatchObject({
			outcome: "retry",
		});
		runtimeHost.setResult({ outcome: "accepted", status: "completed" });
		await expect(
			dispatch(second, "conversation:turn:execution-2"),
		).resolves.toEqual({ schemaVersion: 1, outcome: "accepted" });
		expect(first.store.outboxStatus).toBe("retry_scheduled");
		expect(secondStore.outboxStatus).toBe("succeeded");
	});
});
