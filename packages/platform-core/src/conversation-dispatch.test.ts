import { describe, expect, it, vi } from "vitest";
import { FakeConversationEventsV1 } from "./fake-conversation-events.js";
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
	ConversationRuntimeHostError,
	type ConversationRuntimeHostPortV1,
	type ConversationRuntimeOperationEventV2,
	createConversationDispatchUseCaseV1,
	decideConversationDispatchRetryTransitionV1,
	planConversationGenerationConfirmationV1,
} from "./index.js";

describe("current-state retry transition", () => {
	it.each(["completed", "failed", "cancelled"] as const)(
		"preserves an already %s original Turn and its Conversation during unknown retry",
		(executionStatus) => {
			for (const operation of [
				"conversation.turn.submit.v1",
				"conversation.turn.regenerate.v1",
			] as const) {
				expect(
					decideConversationDispatchRetryTransitionV1({
						operation,
						executionStatus,
						transition: {
							executionStatus: "unknown",
							conversationStatus: "active",
						},
					}),
				).toEqual({});
			}
		},
	);

	it.each(["submitted", "processing", "unknown"] as const)(
		"retains the requested retry transition for %s work",
		(executionStatus) => {
			const transition = {
				executionStatus: "unknown",
				conversationStatus: "active",
			} as const;
			expect(
				decideConversationDispatchRetryTransitionV1({
					operation: "conversation.turn.submit.v1",
					executionStatus,
					transition,
				}),
			).toEqual(transition);
		},
	);

	it("leaves control, conflicting terminal, and metadata transitions for the Store to validate", () => {
		const cases = [
			{
				operation: "conversation.turn.stop.v1",
				transition: {
					executionStatus: "unknown",
					conversationStatus: "active",
				},
			},
			{
				operation: "conversation.turn.supplement.v1",
				transition: {
					executionStatus: "unknown",
					conversationStatus: "active",
				},
			},
			{
				operation: "conversation.turn.submit.v1",
				transition: { executionStatus: "failed", conversationStatus: "ready" },
			},
			{ operation: "conversation.turn.submit.v1", transition: {} },
		] as const;
		for (const { operation, transition } of cases)
			expect(
				decideConversationDispatchRetryTransitionV1({
					operation,
					executionStatus: "cancelled",
					transition,
				}),
			).toEqual(transition);
	});
});

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
	capacity: "available" | "capacity_wait" | "capacity_unavailable" =
		"available";

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
			executionDeliveryFence:
				turn &&
				!["completed", "failed", "cancelled"].includes(
					this.current.executionStatus,
				)
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

	async prepareRuntimeDispatch(input: {
		claim: ConversationDispatchClaimV1;
		leaseDurationMs: number;
	}) {
		if (!(await this.renew())) return false;
		if (this.capacity !== "available") return this.capacity;
		if (
			(input.claim.operation === "conversation.turn.submit.v1" ||
				input.claim.operation === "conversation.turn.regenerate.v1") &&
			(this.current.executionStatus === "submitted" ||
				this.current.executionStatus === "waiting")
		) {
			this.current = { ...this.current, executionStatus: "unknown" };
		}
		return true;
	}

	async cancelUnaccepted(input: { claim: ConversationDispatchClaimV1 }) {
		if (
			!this.#owned(input.claim) ||
			!this.current.stopPending ||
			this.current.executionStatus !== "unknown"
		) {
			return false;
		}
		this.outboxStatus = "succeeded";
		this.current = { ...this.current, executionStatus: "cancelled" };
		return true;
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

	applyEventTransition(transition: ConversationDispatchStateTransitionV1) {
		this.current = {
			...this.current,
			...(["completed", "failed", "cancelled"].includes(
				transition.executionStatus ?? "",
			)
				? { runtimeTerminalEventSeen: true as const }
				: {}),
			executionStatus:
				transition.executionStatus ?? this.current.executionStatus,
		};
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
		if (
			!this.#owned(input.claim) ||
			!this.recordable ||
			(["completed", "failed", "cancelled"].includes(
				this.current.executionStatus,
			) &&
				input.transition.executionStatus !== undefined &&
				input.transition.executionStatus !== this.current.executionStatus)
		)
			return false;
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
		if (!existing && command.transition) {
			this.store.applyEventTransition(command.transition);
		}
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
		controlOnly: true;
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
					...(overrides.controlOnly ? { controlOnly: true } : {}),
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
	it.each([
		["unknown", false],
		["unknown", true],
		["processing", false],
		["processing", true],
	] as const)(
		"resumes %s API business or drains stop control evidence (stop race %s)",
		async (executionStatus, stopRaces) => {
			const store = new MemoryDispatchStore(
				claim({
					executionStatus,
					taskWaitOrder: 1,
					hostSessionRef: "host-original",
					runtimeCursor: "cursor-prior",
				}),
			);
			const calls: string[] = [];
			let renewed = false;
			const runtimeHost: ConversationRuntimeHostPortV1 = {
				async dispatch() {
					throw new Error("Unexpected dispatch");
				},
				async recoverStatus() {
					throw new Error("Unexpected legacy recovery");
				},
				async recoverOriginalStatus(request) {
					calls.push("status");
					return {
						schemaVersion: 2,
						executionId: request.executionId,
						hostSessionRef: "host-original",
						outcome: "found",
						status: "running",
					};
				},
				async renewAuthorization() {
					calls.push("renew");
					expect(store.current.executionStatus).toBe("processing");
					if (stopRaces) {
						store.current = { ...store.current, stopPending: true };
						throw new ConversationRuntimeHostError(
							"TASK_AUTHORIZATION_CONTROL_ONLY",
							false,
						);
					}
					renewed = true;
				},
				async acknowledge() {
					calls.push("ack");
					if (!renewed && !store.current.stopPending)
						throw new ConversationRuntimeHostError(
							"RUNTIME_GRANT_INVALID",
							false,
						);
				},
				async *events() {
					calls.push("events");
					if (!renewed && !store.current.stopPending)
						throw new ConversationRuntimeHostError(
							"RUNTIME_GRANT_INVALID",
							false,
						);
					yield stopRaces
						? {
								...runtimeEvent(1),
								type: "completed" as const,
								payload: { status: "cancelled" as const },
							}
						: runtimeEvent(1);
				},
			};
			const f = setup({ store, runtimeHost });
			expect(await dispatch(f.useCase)).toMatchObject({ outcome: "accepted" });
			expect(calls).toEqual(["status", "renew", "ack", "events", "ack"]);
			expect(store.current.executionStatus).toBe(
				stopRaces ? "cancelled" : "completed",
			);
		},
	);

	it.each([true, false])(
		"attempts control evidence after failed recovery renewal (allowed %s)",
		async (evidenceAllowed) => {
			vi.useFakeTimers();
			try {
				const store = new MemoryDispatchStore(
					claim({
						executionStatus: "unknown",
						taskWaitOrder: 1,
						hostSessionRef: "host-original",
					}),
				);
				const renewAuthorization = vi.fn(async () => {
					throw new ConversationRuntimeHostError(
						"RUNTIME_WORKLOAD_UNAVAILABLE",
						false,
					);
				});
				const events = vi.fn();
				const f = setup({
					store,
					runtimeHost: {
						async dispatch() {
							throw new Error("Unexpected dispatch");
						},
						async recoverStatus() {
							throw new Error("Unexpected legacy recovery");
						},
						async recoverOriginalStatus(request) {
							return {
								schemaVersion: 2,
								executionId: request.executionId,
								hostSessionRef: "host-original",
								outcome: "found",
								status: "running",
							};
						},
						renewAuthorization,
						async *events() {
							events();
							await vi.advanceTimersByTimeAsync(1_100);
							if (!evidenceAllowed)
								throw new ConversationRuntimeHostError(
									"RUNTIME_GRANT_INVALID",
									false,
								);
							yield runtimeEvent(1);
						},
					},
				});
				expect(await dispatch(f.useCase)).toMatchObject(
					evidenceAllowed
						? { outcome: "accepted" }
						: { outcome: "retry", retryScheduled: true },
				);
				expect(events).toHaveBeenCalledOnce();
				expect(renewAuthorization).toHaveBeenCalledOnce();
				expect(store.current.executionStatus).toBe(
					evidenceAllowed ? "completed" : "processing",
				);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("keeps replayed processing evidence unknown until a fresh running lookup", async () => {
		const store = new MemoryDispatchStore(
			claim({
				executionStatus: "unknown",
				taskWaitOrder: 1,
				hostSessionRef: "host-original",
			}),
		);
		const calls: string[] = [];
		const f = setup({
			store,
			runtimeHost: {
				async dispatch() {
					throw new Error("Unexpected dispatch");
				},
				async recoverStatus() {
					throw new Error("Unexpected legacy recovery");
				},
				async recoverOriginalStatus(request) {
					calls.push("status");
					return {
						schemaVersion: 2,
						executionId: request.executionId,
						hostSessionRef: "host-original",
						outcome: "found",
						status: "unknown",
					};
				},
				async renewAuthorization() {
					calls.push("renew");
				},
				async acknowledge() {
					calls.push("ack");
					expect(store.current.executionStatus).toBe("unknown");
				},
				async *events() {
					calls.push("events");
					yield runtimeEvent(1, "running");
				},
			},
		});
		expect(await dispatch(f.useCase)).toMatchObject({ outcome: "retry" });
		expect(calls).toEqual(["status", "events", "ack"]);
		expect(store.current.executionStatus).toBe("unknown");
		expect(f.events.persisted[0]?.event).toEqual({
			type: "execution.status",
			status: "processing",
		});
		expect(f.events.persisted[0]?.transition).toBeUndefined();
	});

	it("drains stopped API recovery under control without resuming business authority", async () => {
		const store = new MemoryDispatchStore(
			claim({
				executionStatus: "processing",
				taskWaitOrder: 1,
				hostSessionRef: "host-original",
				stopPending: true,
			}),
		);
		const renewAuthorization = vi.fn(async () => {
			throw new Error("Business renewal is forbidden under stop");
		});
		const f = setup({
			store,
			runtimeHost: {
				async dispatch() {
					throw new Error("Unexpected dispatch");
				},
				async recoverStatus() {
					throw new Error("Unexpected legacy recovery");
				},
				async recoverOriginalStatus(request) {
					return {
						schemaVersion: 2,
						executionId: request.executionId,
						hostSessionRef: "host-original",
						outcome: "found",
						status: "running",
					};
				},
				renewAuthorization,
				async *events() {
					yield {
						...runtimeEvent(1),
						type: "completed" as const,
						payload: { status: "cancelled" as const },
					};
				},
			},
		});
		expect(await dispatch(f.useCase)).toMatchObject({ outcome: "accepted" });
		expect(renewAuthorization).not.toHaveBeenCalled();
		expect(store.current.executionStatus).toBe("cancelled");
	});

	it("keeps unknown API evidence reads under control without an interval business renewal", async () => {
		vi.useFakeTimers();
		try {
			const store = new MemoryDispatchStore(
				claim({
					executionStatus: "unknown",
					taskWaitOrder: 1,
					hostSessionRef: "host-original",
				}),
			);
			const renewAuthorization = vi.fn(async () => {});
			const f = setup({
				store,
				runtimeHost: {
					async dispatch() {
						throw new Error("Unexpected dispatch");
					},
					async recoverStatus() {
						throw new Error("Unexpected legacy recovery");
					},
					async recoverOriginalStatus(request) {
						return {
							schemaVersion: 2,
							executionId: request.executionId,
							hostSessionRef: "host-original",
							outcome: "found",
							status: "unknown",
						};
					},
					renewAuthorization,
					async *events() {
						await vi.advanceTimersByTimeAsync(1_100);
						yield {
							...runtimeEvent(1),
							type: "text" as const,
							payload: { delta: "Actual bounded evidence" },
						};
					},
				},
			});
			expect(await dispatch(f.useCase)).toMatchObject({ outcome: "retry" });
			expect(renewAuthorization).not.toHaveBeenCalled();
			expect(store.current.executionStatus).toBe("unknown");
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		["waiting", false],
		["failed", false],
		["cancelled", true],
		["stale", false],
	] as const)(
		"reconciles fenced absence of the original API Turn as %s without resending",
		async (result, stopPending) => {
			const store = new MemoryDispatchStore(
				claim({
					executionStatus: "unknown",
					taskWaitOrder: 1,
					hostSessionRef: null,
					stopPending,
				}),
			);
			const reconcileUnacceptedTask = vi.fn(async () => {
				if (result !== "stale") {
					store.current = {
						...store.current,
						executionStatus: result,
						hostSessionRef: "host-original",
					};
					store.outboxStatus = result === "waiting" ? "pending" : "failed";
				}
				return result;
			});
			Object.assign(store, { reconcileUnacceptedTask });
			const native = new FakeConversationRuntimeHostV1();
			const recoverOriginalStatus = vi.fn(
				async (request: { executionId: string }) => ({
					schemaVersion: 2 as const,
					executionId: request.executionId,
					hostSessionRef: "host-original",
					outcome: "not_found" as const,
				}),
			);
			const f = setup({
				store,
				runtimeHost: {
					dispatch: native.dispatch.bind(native),
					events: native.events.bind(native),
					recoverStatus: native.recoverStatus.bind(native),
					recoverOriginalStatus,
				},
			});
			expect(await dispatch(f.useCase)).toEqual(
				result === "waiting"
					? { schemaVersion: 1, outcome: "retry", retryScheduled: true }
					: {
							schemaVersion: 1,
							outcome:
								result === "failed"
									? "rejected"
									: result === "cancelled"
										? "already_completed"
										: "stale",
						},
			);
			expect(reconcileUnacceptedTask).toHaveBeenCalledWith({
				claim: expect.objectContaining({
					executionId: "execution-1",
					executionStatus: "unknown",
					taskWaitOrder: 1,
				}),
				hostSessionRef: "host-original",
			});
			expect(recoverOriginalStatus).toHaveBeenCalledOnce();
			expect(native.sideEffectCount()).toBe(0);
			if (result === "stale")
				expect(store.current.executionStatus).toBe("unknown");
		},
	);

	it.each([
		{ taskWaitOrder: undefined },
		{ operation: "conversation.turn.regenerate.v1" as const },
		{ executionStatus: "processing" as const },
		{ hostSessionRef: null },
	])(
		"does not restore absence outside original API acceptance proof: %j",
		async (change) => {
			const store = new MemoryDispatchStore(
				claim({
					executionStatus: "unknown",
					taskWaitOrder: 1,
					hostSessionRef: "host-original",
					...change,
				}),
			);
			const reconcileUnacceptedTask = vi.fn(async () => "waiting" as const);
			Object.assign(store, { reconcileUnacceptedTask });
			const native = new FakeConversationRuntimeHostV1();
			const f = setup({
				store,
				runtimeHost: {
					dispatch: native.dispatch.bind(native),
					events: native.events.bind(native),
					recoverStatus: native.recoverStatus.bind(native),
					async recoverOriginalStatus(request) {
						return {
							schemaVersion: 2,
							executionId: request.executionId,
							hostSessionRef: request.hostSessionRef,
							outcome: "not_found",
						};
					},
				},
			});
			expect(await dispatch(f.useCase)).toMatchObject({ outcome: "unknown" });
			expect(reconcileUnacceptedTask).not.toHaveBeenCalled();
			expect(native.sideEffectCount()).toBe(0);
		},
	);

	it("keeps confirmed running API work occupied and never reconciles it as unsent", async () => {
		const store = new MemoryDispatchStore(
			claim({
				executionStatus: "unknown",
				taskWaitOrder: 1,
				hostSessionRef: "host-original",
			}),
		);
		const reconcileUnacceptedTask = vi.fn(async () => "waiting" as const);
		Object.assign(store, { reconcileUnacceptedTask });
		const native = new FakeConversationRuntimeHostV1();
		native.setEvents([runtimeEvent(1)]);
		const f = setup({
			store,
			runtimeHost: {
				dispatch: native.dispatch.bind(native),
				events: native.events.bind(native),
				recoverStatus: native.recoverStatus.bind(native),
				async recoverOriginalStatus(request) {
					return {
						schemaVersion: 2,
						executionId: request.executionId,
						hostSessionRef: "host-original",
						outcome: "found",
						status: "running",
					};
				},
			},
		});
		expect(await dispatch(f.useCase)).toMatchObject({ outcome: "accepted" });
		expect(reconcileUnacceptedTask).not.toHaveBeenCalled();
		expect(native.sideEffectCount()).toBe(0);
		expect(store.current.executionStatus).toBe("completed");
	});

	it("sends an eligible waiting task as its original Turn without recovery", async () => {
		const native = new FakeConversationRuntimeHostV1();
		native.setEvents([runtimeEvent(1)]);
		const recoverOriginalStatus = vi.fn(async () => {
			throw new Error("Waiting task has never been sent");
		});
		const store = new MemoryDispatchStore(
			claim({ executionStatus: "waiting" }),
		);
		const f = setup({
			store,
			runtimeHost: {
				dispatch: native.dispatch.bind(native),
				events: native.events.bind(native),
				recoverStatus: native.recoverStatus.bind(native),
				recoverOriginalStatus,
			},
		});
		expect(await dispatch(f.useCase)).toMatchObject({ outcome: "accepted" });
		expect(native.sideEffectCount()).toBe(1);
		expect(recoverOriginalStatus).not.toHaveBeenCalled();
		expect(store.current.executionId).toBe("execution-1");
		expect(store.current.executionStatus).toBe("completed");
	});

	it("cancels revoked waiting work without releasing another Turn's Conversation", async () => {
		const store = new MemoryDispatchStore(
			claim({ executionStatus: "waiting" }),
		);
		const finish = vi.spyOn(store, "finish");
		const runtimeHost = new FakeConversationRuntimeHostV1();
		const f = setup({
			store,
			runtimeHost,
			authorization: {
				async authorize() {
					return { outcome: "denied" };
				},
			},
		});
		expect(await dispatch(f.useCase)).toMatchObject({ outcome: "rejected" });
		expect(store.current.executionStatus).toBe("cancelled");
		expect(finish.mock.calls[0]?.[0].transition).toEqual({
			executionStatus: "cancelled",
		});
		expect(runtimeHost.sideEffectCount()).toBe(0);
	});

	it("holds never-sent waiting work when a pending stop races its claim", async () => {
		const store = new MemoryDispatchStore(
			claim({ executionStatus: "waiting", stopPending: true }),
		);
		const runtimeHost = new FakeConversationRuntimeHostV1();
		const f = setup({ store, runtimeHost });
		expect(await dispatch(f.useCase)).toMatchObject({
			outcome: "retry",
			retryScheduled: true,
		});
		expect(store.current.executionStatus).toBe("waiting");
		expect(runtimeHost.sideEffectCount()).toBe(0);
	});

	it("includes original-generation waiting work in a confirmed isolation failure", () => {
		const plan = planConversationGenerationConfirmationV1(
			claim({
				executionStatus: "unknown",
				hostSessionRef: "host-session-conversation-1",
				generationIsolation: {
					operationId: "generation:conversation-1:1",
					controlRecordId: "control-1",
					originalPrincipal: { kind: "user", id: "actor-1" },
				},
			}),
		);
		expect(plan.nextGeneration).toBe(2);
		expect(plan.executionStatusesToFail).toEqual([
			"waiting",
			"submitted",
			"processing",
			"unknown",
		]);
		expect(plan.conversationStatus).toBe("unavailable");
	});

	it("retains an occupied original execution when recovery finds no accepted Turn without resubmitting", async () => {
		let dispatches = 0;
		let recoveries = 0;
		const runtimeHost: ConversationRuntimeHostPortV1 = {
			async dispatch() {
				dispatches++;
				throw new Error("Unexpected submit");
			},
			async recoverStatus() {
				throw new Error("Unexpected legacy recovery");
			},
			async recoverOriginalStatus(request) {
				recoveries++;
				return {
					schemaVersion: 2,
					executionId: request.executionId,
					hostSessionRef: "host-original",
					outcome: "not_found",
				};
			},
			async *events() {
				yield runtimeEvent(1);
			},
		};
		const store = new MemoryDispatchStore(
			claim({ executionStatus: "unknown", hostSessionRef: "host-original" }),
		);
		const f = setup({ store, runtimeHost });
		expect(await dispatch(f.useCase)).toMatchObject({ outcome: "unknown" });
		expect({ dispatches, recoveries }).toEqual({
			dispatches: 0,
			recoveries: 1,
		});
		expect(store.current.executionStatus).toBe("unknown");
	});

	it("rejects a found recovery that introduces a Runtime Host reference", async () => {
		const runtimeHost: ConversationRuntimeHostPortV1 = {
			async dispatch() {
				throw new Error("Unexpected dispatch");
			},
			async recoverStatus() {
				throw new Error("Unexpected status recovery");
			},
			async recoverOriginalStatus(request) {
				return {
					schemaVersion: 2,
					hostSessionRef: "introduced-host",
					executionId: request.executionId,
					outcome: "found",
					status: "running",
				};
			},
			async *events() {
				yield* [];
				throw new Error("Unexpected event drain");
			},
		};
		const store = new MemoryDispatchStore(
			claim({ executionStatus: "unknown", hostSessionRef: null }),
		);
		const { useCase, events } = setup({ store, runtimeHost });
		expect(await dispatch(useCase)).toMatchObject({ outcome: "retry" });
		expect(store.errorCode).toBe("RUNTIME_UNAVAILABLE");
		expect(events.persisted).toHaveLength(0);
	});

	it("rejects metadata recovery when Runtime status contradicts the committed execution", async () => {
		const runtimeHost: ConversationRuntimeHostPortV1 = {
			async dispatch() {
				throw new Error("Unexpected dispatch");
			},
			async recoverStatus() {
				throw new Error("Unexpected status recovery");
			},
			async recoverOriginalStatus(request) {
				return {
					schemaVersion: 2,
					hostSessionRef: request.hostSessionRef,
					executionId: request.executionId,
					outcome: "found",
					status: "failed",
				};
			},
			async *events() {
				yield* [];
				throw new Error("Unexpected event drain");
			},
		};
		const store = new MemoryDispatchStore(
			claim({
				executionStatus: "completed",
				hostSessionRef: "host-original",
				runtimeCursor: "cursor-committed",
				metadataRecovery: {
					id: "metadata-recovery-1",
					requestedAt: 1,
					originalStatus: "succeeded",
				},
			}),
		);
		const { useCase, events } = setup({ store, runtimeHost });

		await expect(dispatch(useCase)).resolves.toMatchObject({
			outcome: "rejected",
		});
		expect(events.persisted).toHaveLength(0);
		expect(store.outboxStatus).toBe("failed");
		expect(store.errorCode).toBe("RUNTIME_STATUS_CONFLICT");
	});

	it.each([
		["submitted", "capacity_wait"],
		["submitted", "capacity_unavailable"],
		["waiting", "capacity_wait"],
		["waiting", "capacity_unavailable"],
	] as const)(
		"preserves unreserved %s work when preparation reports %s",
		async (executionStatus, capacity) => {
			const runtimeHost = new FakeConversationRuntimeHostV1();
			runtimeHost.setEvents([runtimeEvent(1)]);
			const f = setup({
				runtimeHost,
				store: new MemoryDispatchStore(claim({ executionStatus })),
			});
			f.store.capacity = capacity;
			expect(await dispatch(f.useCase)).toMatchObject({
				outcome: "retry",
				retryScheduled: true,
			});
			expect(f.store.current.executionStatus).toBe(executionStatus);
			expect(f.store.outboxStatus).toBe("retry_scheduled");
			expect(f.store.errorCode).toBe(
				capacity === "capacity_wait"
					? "AGENT_CAPACITY_FULL"
					: "AGENT_CAPACITY_UNVERIFIED",
			);
			f.store.capacity = "available";
			expect(runtimeHost.sideEffectCount()).toBe(0);
			expect(await dispatch(f.useCase)).toMatchObject({ outcome: "accepted" });
			expect(runtimeHost.sideEffectCount()).toBe(1);
		},
	);
	it.each(["found", "not_found"] as const)(
		"recovers a historical control-only task with %s evidence without business dispatch or renewal",
		async (outcome) => {
			let dispatches = 0;
			let renewals = 0;
			let recoveries = 0;
			const runtimeHost: ConversationRuntimeHostPortV1 = {
				async dispatch() {
					dispatches++;
					throw new Error("Business dispatch forbidden");
				},
				async recoverStatus() {
					throw new Error("Body recovery forbidden");
				},
				async recoverOriginalStatus(request) {
					recoveries++;
					expect(request).not.toHaveProperty("recovery");
					return {
						schemaVersion: 2,
						hostSessionRef: "host-original",
						executionId: request.executionId,
						...(outcome === "found"
							? { outcome: "found" as const, status: "running" as const }
							: { outcome: "not_found" as const }),
					};
				},
				async renewAuthorization() {
					renewals++;
				},
				async *events() {
					await new Promise((resolve) => setTimeout(resolve, 1100));
					yield runtimeEvent(1);
				},
			};
			const store = new MemoryDispatchStore(
				claim({ executionStatus: "unknown", hostSessionRef: "host-original" }),
			);
			const h = setup({
				store,
				runtimeHost,
				authorization: authorization({ controlOnly: true }),
			});
			expect(await dispatch(h.useCase)).toMatchObject({
				outcome: outcome === "found" ? "accepted" : "unknown",
			});
			expect({ dispatches, renewals, recoveries }).toEqual({
				dispatches: 0,
				renewals: 0,
				recoveries: 1,
			});
			expect(store.current.executionStatus).toBe(
				outcome === "found" ? "completed" : "unknown",
			);
		},
	);

	it("does not dispatch a never-started historical task on principal-only evidence", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		const h = setup({
			runtimeHost,
			authorization: authorization({ controlOnly: true }),
		});
		expect(await dispatch(h.useCase)).toMatchObject({ outcome: "retry" });
		expect(runtimeHost.sideEffectCount()).toBe(0);
		expect(h.store.current.executionStatus).toBe("submitted");
	});

	it("acknowledges only committed cursors and resumes after a lost acknowledgement without repeating execution", async () => {
		const inner = new FakeConversationRuntimeHostV1();
		inner.setEvents([runtimeEvent(1, "running"), runtimeEvent(2)]);
		const acknowledged: string[] = [];
		let failAck = true;
		const runtimeHost: ConversationRuntimeHostPortV1 = {
			dispatch: (request) => inner.dispatch(request),
			recoverStatus: (request) => inner.recoverStatus(request),
			events: (request) => inner.events(request),
			async acknowledge(request) {
				expect(
					harness.events.persisted.some(
						(event) => event.runtimeCursor === request.confirmedCursor,
					),
				).toBe(true);
				if (failAck) {
					failAck = false;
					throw new Error("controlled acknowledgement loss");
				}
				acknowledged.push(request.confirmedCursor);
			},
		};
		const harness = setup({ runtimeHost });
		await expect(dispatch(harness.useCase)).resolves.toMatchObject({
			outcome: "retry",
		});
		expect(acknowledged).toEqual([]);
		expect(harness.events.persisted).toHaveLength(1);
		await expect(dispatch(harness.useCase)).resolves.toMatchObject({
			outcome: "accepted",
		});
		expect(acknowledged).toEqual(["cursor-1", "cursor-2"]);
		expect(harness.events.persisted).toHaveLength(2);
		expect(inner.sideEffectCount()).toBe(1);
	});

	it("does not release an active execution when current authority is denied", async () => {
		const store = new MemoryDispatchStore(
			claim({
				executionStatus: "processing",
				hostSessionRef: "host-session-conversation-1",
			}),
		);
		const harness = setup({
			store,
			authorization: {
				async authorize() {
					return { outcome: "denied" };
				},
			},
		});
		await expect(dispatch(harness.useCase)).resolves.toMatchObject({
			outcome: "retry",
		});
		expect(store.current.executionStatus).toBe("processing");
	});

	it("forwards the Execution-frozen selection without resolving defaults", async () => {
		const inner = new FakeConversationRuntimeHostV1();
		inner.setResult({ outcome: "accepted", status: "completed" });
		let observedRequest: ConversationRuntimeDispatchRequestV1 | undefined;
		const runtimeHost: ConversationRuntimeHostPortV1 = {
			async dispatch(request) {
				observedRequest = request;
				return inner.dispatch(request);
			},
			recoverStatus: (request) => inner.recoverStatus(request),
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

	it("enforces the Fake RuntimeHost recovery digest and fence barrier", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		const recovery = {
			schemaVersion: 2 as const,
			requestId: "request-recovery",
			traceId: "trace-1",
			agentId: "agent-1",
			actorId: "actor-1",
			channelId: "web",
			conversationId: "conversation-1",
			executionId: "execution-1",
			turnId: "turn-1",
			sessionGeneration: 1,
			deliveryFence: 2,
			hostSessionRef: "host-session-conversation-1",
			recovery: {
				schemaVersion: 1 as const,
				input: { text: "bounded fixture", attachments: [] },
				selection: {
					schemaVersion: 1 as const,
					modelOptionId: "model-option-1",
					reasoningLevel: "medium",
				},
			},
			runtimeGrant: "synthetic-grant",
		};
		const { recovery: recoveryInput, ...runtimeContext } = recovery;
		const submit = {
			...runtimeContext,
			schemaVersion: 1 as const,
			operation: "turn.submit" as const,
			input: recoveryInput.input,
			selection: recoveryInput.selection,
		};

		await expect(runtimeHost.recoverStatus(recovery)).resolves.toMatchObject({
			outcome: "not_found",
		});
		await expect(runtimeHost.dispatch(submit)).rejects.toMatchObject({
			code: "RUNTIME_FENCE_STALE",
		});

		const accepted = await runtimeHost.dispatch({
			...submit,
			deliveryFence: 3,
		});
		await expect(
			runtimeHost.recoverStatus({
				...recovery,
				deliveryFence: 4,
				hostSessionRef: accepted.hostSessionRef,
			}),
		).resolves.toMatchObject({ outcome: "found", status: "running" });
		await expect(
			runtimeHost.recoverStatus({
				...recovery,
				deliveryFence: 5,
				hostSessionRef: accepted.hostSessionRef,
				recovery: {
					...recovery.recovery,
					selection: {
						...recovery.recovery.selection,
						reasoningLevel: "high",
					},
				},
			}),
		).rejects.toMatchObject({ code: "RUNTIME_OPERATION_CONFLICT" });
		expect(runtimeHost.sideEffectCount()).toBe(1);
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

	it("commits a terminal event and status before an acknowledgement is lost", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.setEvents([runtimeEvent(1)]);
		const harness = setup({ runtimeHost });
		harness.events.loseNextResponse = true;

		await expect(dispatch(harness.useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "retry",
			retryScheduled: true,
		});
		expect(harness.events.persisted).toHaveLength(1);
		expect(harness.store.current.executionStatus).toBe("completed");

		await expect(dispatch(harness.useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "accepted",
		});
		expect(runtimeHost.sideEffectCount()).toBe(1);
		expect(harness.store.outboxStatus).toBe("succeeded");
	});

	it("replays historical status before validating an accepted terminal result", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.setResult({ outcome: "accepted", status: "completed" });
		runtimeHost.setEvents([runtimeEvent(1, "running"), runtimeEvent(2)]);
		const { useCase, store, events } = setup({ runtimeHost });

		await expect(dispatch(useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "accepted",
		});
		expect(events.persisted.map(({ event }) => event)).toEqual([
			{ type: "execution.status", status: "processing" },
			{ type: "execution.status", status: "completed" },
		]);
		expect(runtimeHost.acknowledgedEventCount()).toBe(2);
		expect(store.current.executionStatus).toBe("completed");
		expect(store.outboxStatus).toBe("succeeded");
	});

	it("rejects a terminal event that contradicts an accepted terminal result", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.setResult({ outcome: "accepted", status: "completed" });
		runtimeHost.setEvents([
			{
				schemaVersion: 1,
				adapterEventKey: "event-1",
				executionId: "execution-1",
				cursor: "cursor-1",
				occurredAt: "2026-09-06T00:00:01.000Z",
				type: "completed",
				payload: { status: "failed" },
			},
		]);
		const { useCase, store, events } = setup({ runtimeHost });

		await expect(dispatch(useCase)).resolves.toMatchObject({
			outcome: "rejected",
		});
		expect(events.persisted).toHaveLength(0);
		expect(store.current.executionStatus).toBe("completed");
		expect(store.errorCode).toBe("RUNTIME_EVENT_CONFLICT");
	});

	it.each(["completed", "failed", "unknown"] as const)(
		"persists post-terminal Connection verification for the original %s tool outcome before ACK",
		async (phase) => {
			const inner = new FakeConversationRuntimeHostV1();
			const runtimeHost: ConversationRuntimeHostPortV1 = inner;
			const operation = (
				sequence: number,
				payload: ConversationRuntimeOperationEventV2["payload"],
			): ConversationRuntimeOperationEventV2 => ({
				...runtimeEvent(sequence),
				schemaVersion: 2,
				type: "operation",
				payload,
			});
			const intent = {
				kind: "tool",
				toolId: "connection.create_pr",
				operationRef: "tool-1",
				attemptRef: "attempt-1",
				phase: "intent",
			} as const;
			const started = {
				...intent,
				phase: "started",
				startedAt: "2026-09-06T00:00:02.000Z",
			} as const;
			const outcome = {
				...started,
				phase,
				finishedAt: "2026-09-06T00:00:03.000Z",
				durationMs: 1000,
			};
			runtimeHost.events = async function* () {
				yield operation(1, intent);
				yield operation(2, started);
				yield operation(3, outcome);
				yield runtimeEvent(4);
				yield operation(5, {
					...outcome,
					connection: {
						serviceRef: "connection-primary",
						verification: "verified",
						callRef: "call-1",
					},
				});
			};
			const harness = setup({ runtimeHost });
			const facts = new FakeConversationEventsV1({
				conversationId: "conversation-1",
				executionId: "execution-1",
				sessionGeneration: 1,
				deliveryFence: 2,
			});
			const persist = harness.events.persist.bind(harness.events);
			harness.events.persist = async (command) => {
				await facts.persist(command);
				return persist(command);
			};
			const acknowledged: string[] = [];
			runtimeHost.acknowledge = async ({ confirmedCursor }) => {
				expect(harness.events.persisted.at(-1)?.runtimeCursor).toBe(
					confirmedCursor,
				);
				acknowledged.push(confirmedCursor);
			};
			await expect(dispatch(harness.useCase)).resolves.toMatchObject({
				outcome: "accepted",
			});
			expect(harness.events.persisted).toHaveLength(5);
			expect(harness.events.persisted[4]).toMatchObject({
				operationMetadataOnly: true,
				event: {
					fact: { ...outcome, connection: { verification: "verified" } },
				},
			});
			expect(acknowledged).toEqual([
				"cursor-1",
				"cursor-2",
				"cursor-3",
				"cursor-4",
				"cursor-5",
			]);
			expect(harness.store.current.executionStatus).toBe("completed");
			expect(inner.sideEffectCount()).toBe(1);
		},
	);

	it("rejects ordinary Runtime output after the terminal event", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.setEvents([
			runtimeEvent(1),
			{
				schemaVersion: 1,
				adapterEventKey: "event-2",
				executionId: "execution-1",
				cursor: "cursor-2",
				occurredAt: "2026-09-06T00:00:02.000Z",
				type: "text",
				payload: { delta: "late" },
			},
		]);
		const { useCase, store, events } = setup({ runtimeHost });

		await expect(dispatch(useCase)).resolves.toMatchObject({
			outcome: "rejected",
		});
		expect(events.persisted).toHaveLength(1);
		expect(runtimeHost.acknowledgedEventCount()).toBe(1);
		expect(store.errorCode).toBe("RUNTIME_EVENT_CONFLICT");
	});

	it.each(["waiting", "unknown"] as const)(
		"terminates an accepted API task after confirmed busy from %s without replaying it",
		async (executionStatus) => {
			const runtimeHost = new FakeConversationRuntimeHostV1();
			runtimeHost.setResult({ outcome: "busy" });
			const { useCase, store } = setup({
				runtimeHost,
				store: new MemoryDispatchStore(
					claim({ executionStatus, taskWaitOrder: 1 }),
				),
			});
			await expect(dispatch(useCase)).resolves.toEqual({
				schemaVersion: 1,
				outcome: "rejected",
			});
			expect(store.errorCode).toBe("RUNTIME_BUSY");
			expect(store.outboxStatus).toBe("failed");
			await expect(dispatch(useCase)).resolves.toEqual({
				schemaVersion: 1,
				outcome: "rejected",
			});
			expect(runtimeHost.sideEffectCount()).toBe(1);
		},
	);

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

	it("maps a Runtime-ended supplement to the product failure reason", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.setResult({
			outcome: "rejected",
			code: "RUNTIME_TURN_NOT_ACTIVE",
			message: "Runtime turn is no longer active",
			retryable: false,
		});
		const store = new MemoryDispatchStore(
			claim({
				operation: "conversation.turn.supplement.v1",
				messageId: "message-supplement",
				executionStatus: "processing",
				hostSessionRef: "host-session-conversation-1",
			}),
		);
		const { useCase } = setup({ store, runtimeHost });

		await expect(dispatch(useCase)).resolves.toMatchObject({
			outcome: "rejected",
		});
		expect(store.errorCode).toBe("ORIGINAL_RESPONSE_ALREADY_FINISHED");
	});

	it("completes a stop when Runtime reports the target already ended", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.setResult({
			outcome: "rejected",
			code: "RUNTIME_TURN_NOT_ACTIVE",
			message: "Runtime turn is no longer active",
			retryable: false,
		});
		const store = new MemoryDispatchStore(
			claim({
				operation: "conversation.turn.stop.v1",
				messageId: null,
				stopRequestId: "stop-request-1",
				executionStatus: "processing",
				hostSessionRef: "host-session-conversation-1",
				input: null,
			}),
		);
		const { useCase } = setup({ store, runtimeHost });

		await expect(dispatch(useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "already_completed",
		});
		expect(store.outboxStatus).toBe("succeeded");
		expect(store.errorCode).toBeUndefined();
		expect(store.current.executionStatus).toBe("processing");
	});

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
			async recoverStatus() {
				throw new Error("Unexpected status recovery");
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
			expect(harness.store.current.executionStatus).toBe(
				outcome === "denied" ? "failed" : "submitted",
			);
		}
	});

	it("keeps acceptance unknown without submitting a stopped Turn again", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		const store = new MemoryDispatchStore(
			claim({ executionStatus: "unknown", stopPending: true }),
		);
		const { useCase } = setup({ store, runtimeHost });

		await expect(dispatch(useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "unknown",
			retryScheduled: true,
		});
		expect(runtimeHost.sideEffectCount()).toBe(0);
		expect(store.current.executionStatus).toBe("unknown");
		expect(store.outboxStatus).toBe("retry_scheduled");
	});

	it("recovers a stopped unknown Turn through status without submitting it again", async () => {
		let statusCalls = 0;
		let dispatchCalls = 0;
		const runtimeHost: ConversationRuntimeHostPortV1 = {
			async dispatch() {
				dispatchCalls += 1;
				throw new Error("Unexpected submit");
			},
			async recoverStatus(request) {
				statusCalls += 1;
				return {
					schemaVersion: 2,
					hostSessionRef: request.hostSessionRef,
					executionId: request.executionId,
					outcome: "found",
					status: "running",
				};
			},
			async *events() {
				yield runtimeEvent(1);
			},
		};
		const store = new MemoryDispatchStore(
			claim({
				executionStatus: "unknown",
				stopPending: true,
				hostSessionRef: "host-session-conversation-1",
			}),
		);
		const { useCase } = setup({ store, runtimeHost });

		await expect(dispatch(useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "accepted",
		});
		expect({ statusCalls, dispatchCalls }).toEqual({
			statusCalls: 1,
			dispatchCalls: 0,
		});
		expect(store.current.executionStatus).toBe("completed");
	});

	it("keeps stop pending until original recovery confirms running, then uses the existing stop path", async () => {
		const original = new MemoryDispatchStore(
			claim({
				executionStatus: "unknown",
				stopPending: true,
				hostSessionRef: "host-session-conversation-1",
			}),
		);
		const stopped = () =>
			new MemoryDispatchStore({
				...original.current,
				operation: "conversation.turn.stop.v1",
				messageId: null,
				stopRequestId: "stop-original",
				input: null,
			});
		let stops = 0;
		const runtimeHost: ConversationRuntimeHostPortV1 = {
			async dispatch(request) {
				expect(request.operation).toBe("turn.stop");
				expect(request.stopRequestId).toBe("stop-original");
				stops += 1;
				return {
					schemaVersion: 1,
					hostSessionRef: "host-session-conversation-1",
					operationId: "stop-original",
					result: { outcome: "accepted", status: "cancelled" },
				};
			},
			async recoverStatus() {
				throw new Error("Unexpected legacy recovery");
			},
			async recoverOriginalStatus(request) {
				return {
					schemaVersion: 2,
					hostSessionRef: "host-session-conversation-1",
					executionId: request.executionId,
					outcome: "found",
					status: "running",
				};
			},
			async *events() {
				expect(original.current.executionStatus).toBe("processing");
				const control = setup({
					store: stopped(),
					runtimeHost,
					authorization: authorization({ controlOnly: true }),
				});
				expect(
					await dispatch(control.useCase, "conversation:stop:stop-original"),
				).toMatchObject({ outcome: "accepted" });
				expect(control.store.current.executionStatus).toBe("cancelled");
				yield {
					...runtimeEvent(1),
					type: "completed",
					payload: { status: "cancelled" },
				};
			},
		};
		const pending = setup({
			store: stopped(),
			runtimeHost,
			authorization: authorization({ controlOnly: true }),
		});
		expect(
			await dispatch(pending.useCase, "conversation:stop:stop-original"),
		).toMatchObject({ outcome: "retry" });
		expect(pending.store.errorCode).toBe("ORIGINAL_RESPONSE_NOT_STARTED");
		expect(stops).toBe(0);
		const recovery = setup({
			store: original,
			runtimeHost,
			authorization: authorization({ controlOnly: true }),
		});
		expect(await dispatch(recovery.useCase)).toMatchObject({
			outcome: "accepted",
		});
		expect(original.current.executionStatus).toBe("cancelled");
		expect(stops).toBe(1);
	});

	it("locally cancels after RuntimeHost fences a never-accepted Turn", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		const store = new MemoryDispatchStore(
			claim({
				executionStatus: "unknown",
				stopPending: true,
				hostSessionRef: "host-session-conversation-1",
			}),
		);
		const { useCase } = setup({ store, runtimeHost });

		await expect(dispatch(useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "already_completed",
		});
		expect(runtimeHost.sideEffectCount()).toBe(0);
		expect(store.current.executionStatus).toBe("cancelled");
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
			async recoverStatus() {
				throw new Error("Unexpected status recovery");
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

describe("terminal Runtime delivery recovery", () => {
	it.each([
		"terminal-commit",
		"terminal-ack",
		"metadata-before-commit",
		"metadata-commit",
		"metadata-ack",
	])(
		"retries %s loss twice with original cursor/fence and no second Turn",
		async (fault) => {
			const inner = new FakeConversationRuntimeHostV1();
			const runtimeHost: ConversationRuntimeHostPortV1 = inner;
			const tool = {
				kind: "tool",
				toolId: "connection.create_pr",
				operationRef: "tool",
				attemptRef: "attempt",
				phase: "intent",
			} as const;
			const started = {
				...tool,
				phase: "started",
				startedAt: "2026-09-06T00:00:02.000Z",
			} as const;
			const outcome = {
				...started,
				phase: "unknown",
				finishedAt: "2026-09-06T00:00:03.000Z",
				durationMs: 1000,
			} as const;
			const operation = (
				sequence: number,
				payload: ConversationRuntimeOperationEventV2["payload"],
			): ConversationRuntimeOperationEventV2 => ({
				...runtimeEvent(sequence),
				schemaVersion: 2,
				type: "operation",
				payload,
			});
			const stream = [
				operation(1, tool),
				operation(2, started),
				operation(3, outcome),
				runtimeEvent(4),
				operation(5, {
					...outcome,
					connection: {
						serviceRef: "connection",
						verification: "verified",
						callRef: "call",
					},
				}),
			];
			const requests: { afterCursor?: string; deliveryFence: number }[] = [];
			runtimeHost.events = async function* (request) {
				requests.push(request);
				const index = request.afterCursor
					? stream.findIndex((event) => event.cursor === request.afterCursor) +
						1
					: 0;
				for (const event of stream.slice(index)) yield event;
			};
			const h = setup({ runtimeHost });
			const persist = h.events.persist.bind(h.events);
			let remaining = fault.includes("commit")
				? fault === "metadata-before-commit"
					? 2
					: 1
				: 2;
			h.events.persist = async (command) => {
				const target = fault.startsWith("terminal") ? "cursor-4" : "cursor-5";
				if (
					command.runtimeCursor === target &&
					remaining > 0 &&
					fault.includes("commit")
				) {
					remaining--;
					if (fault !== "metadata-before-commit") await persist(command);
					throw new Error("injected persistence loss");
				}
				return persist(command);
			};
			const acknowledgements: string[] = [];
			runtimeHost.acknowledge = async (request) => {
				expect(request.deliveryFence).toBe(2);
				expect(
					h.events.persisted.some(
						(event) => event.runtimeCursor === request.confirmedCursor,
					),
				).toBe(true);
				if (
					fault.endsWith("ack") &&
					remaining > 0 &&
					request.confirmedCursor ===
						(fault.startsWith("terminal") ? "cursor-4" : "cursor-5")
				) {
					remaining--;
					throw new Error("injected ACK loss");
				}
				acknowledgements.push(request.confirmedCursor);
			};
			let prepares = 0;
			const prepare = h.store.prepareRuntimeDispatch.bind(h.store);
			h.store.prepareRuntimeDispatch = async (input) => {
				prepares++;
				return prepare(input);
			};
			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "retry",
				retryScheduled: true,
			});
			expect(h.store.current.executionStatus).toBe("completed");
			h.store.capacity = "capacity_unavailable";
			for (
				let attempt = 0;
				attempt < 3 && h.store.outboxStatus !== "succeeded";
				attempt++
			)
				await dispatch(h.useCase);
			expect(h.store.outboxStatus).toBe("succeeded");
			expect(h.store.current.executionStatus).toBe("completed");
			expect(h.store.current.executionDeliveryFence).toBe(2);
			expect(h.store.current.deliveryFence).toBeGreaterThan(2);
			expect(prepares).toBe(1);
			expect(inner.sideEffectCount()).toBe(1);
			expect(h.events.persisted).toHaveLength(5);
			expect(h.events.persisted[4]).toMatchObject({
				operationMetadataOnly: true,
				event: {
					fact: { ...outcome, connection: { verification: "verified" } },
				},
			});
			expect(acknowledgements.at(-1)).toBe("cursor-5");
			expect(
				requests
					.slice(1)
					.every(
						(request) =>
							request.deliveryFence === 2 && request.afterCursor !== undefined,
					),
			).toBe(true);
		},
	);

	it("drains historical events after a final response without falsely treating unfinished history as metadata", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.setResult({ outcome: "accepted", status: "completed" });
		runtimeHost.setEvents([runtimeEvent(1, "running"), runtimeEvent(2)]);
		const h = setup({ runtimeHost });
		h.events.loseNextResponse = true;
		await expect(dispatch(h.useCase)).resolves.toMatchObject({
			outcome: "retry",
		});
		expect(h.store.current.executionStatus).toBe("completed");
		expect(h.store.current.runtimeTerminalEventSeen).toBeUndefined();
		await expect(dispatch(h.useCase)).resolves.toMatchObject({
			outcome: "accepted",
		});
		expect(h.events.persisted).toHaveLength(2);
		expect(h.events.persisted[1]?.operationMetadataOnly).toBeUndefined();
		expect(runtimeHost.sideEffectCount()).toBe(1);
	});
});
