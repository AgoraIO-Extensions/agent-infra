import { describe, expect, it, vi } from "vitest";
import { parseClaim } from "./conversation-dispatch-input.js";
import {
	isRuntimeEventOperation,
	parseRuntimeResponse,
	parseRuntimeStatusResponse,
} from "./conversation-dispatch-runtime.js";
import { decideConversationDispatchRejectedTransitionV1 } from "./conversation-dispatch-transition.js";
import { ConversationRuntimeHostError } from "./conversation-dispatch-types.js";
import { FakeConversationEventsV1 } from "./fake-conversation-events.js";
import { FakeConversationRuntimeHostV1 } from "./fake-conversation-runtime-host.js";
import {
	type ConversationDispatchAuthorizationPortV1,
	type ConversationDispatchClaimV1,
	ConversationDispatchError,
	type ConversationDispatchStateTransitionV1,
	type ConversationDispatchStorePortV1,
	type ConversationDispatchUseCaseV1,
	type ConversationEventUseCaseV1,
	type ConversationRuntimeDispatchRequestV1,
	type ConversationRuntimeEventV1,
	type ConversationRuntimeHostPortV1,
	type ConversationRuntimeOperationEventV2,
	type ConversationRuntimeReasoningEventV2,
	createConversationDispatchUseCaseV1,
	decideConversationDispatchRetryTransitionV1,
	decideConversationStopConfirmationStatusV1,
	decideConversationStopConfirmationTimeoutV1,
	nativeCapabilityParametersDigestV1,
} from "./index.js";

describe("stop confirmation timeout", () => {
	it.each([
		"submitted",
		"waiting",
		"completed",
		"failed",
		"cancelled",
	] as const)("does not mark %s as unknown", (executionStatus) => {
		expect(
			decideConversationStopConfirmationTimeoutV1({
				executionStatus,
				confirmationDeadline: 100,
				observedAt: 101,
				alreadyTimedOut: false,
			}),
		).toBeUndefined();
	});

	it("marks an active stop as unknown exactly once after its deadline", () => {
		expect(
			decideConversationStopConfirmationTimeoutV1({
				executionStatus: "processing",
				confirmationDeadline: 100,
				observedAt: 100,
				alreadyTimedOut: false,
			}),
		).toEqual({ status: "unknown", reason: "STOP_CONFIRMATION_TIMEOUT" });
		expect(
			decideConversationStopConfirmationTimeoutV1({
				executionStatus: "unknown",
				confirmationDeadline: 100,
				observedAt: 101,
				alreadyTimedOut: true,
			}),
		).toBeUndefined();
	});

	it("does not let a timed-out stop return to processing", () => {
		expect(
			decideConversationStopConfirmationStatusV1({
				executionStatus: "processing",
				confirmationTimedOut: true,
			}),
		).toBe("unknown");
	});
});

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

describe("rejected Runtime result transition", () => {
	it.each([
		"conversation.turn.submit.v1",
		"conversation.turn.regenerate.v1",
		"conversation.native-capability.invoke.v1",
	] as const)(
		"fails the %s Execution and marks the Conversation unavailable for a blocked session",
		(operation) => {
			expect(
				decideConversationDispatchRejectedTransitionV1({
					operation,
					code: "RUNTIME_SESSION_BLOCKED",
				}),
			).toEqual({
				executionStatus: "failed",
				conversationStatus: "unavailable",
			});
		},
	);

	it.each([
		"RUNTIME_TURN_NOT_ACTIVE",
		"RUNTIME_MODEL_SELECTION_UNSUPPORTED",
		"RUNTIME_FILE_INPUT_REJECTED",
	] as const)("keeps the Conversation ready for %s", (code) => {
		for (const operation of [
			"conversation.turn.submit.v1",
			"conversation.turn.regenerate.v1",
			"conversation.native-capability.invoke.v1",
		] as const)
			expect(
				decideConversationDispatchRejectedTransitionV1({ operation, code }),
			).toEqual({ executionStatus: "failed", conversationStatus: "ready" });
	});

	it.each([
		"conversation.turn.supplement.v1",
		"conversation.turn.stop.v1",
		"conversation.browser.handoff.v1",
	] as const)(
		"never changes Execution or Conversation state for a blocked %s",
		(operation) => {
			expect(
				decideConversationDispatchRejectedTransitionV1({
					operation,
					code: "RUNTIME_SESSION_BLOCKED",
				}),
			).toEqual({});
		},
	);
});

describe.each([
	{
		code: "RUNTIME_SESSION_BLOCKED",
		message: "Runtime session is blocked by an unconfirmed turn",
	},
	// #3314：附件读取在原生副作用前被平台明确拒绝。
	{
		code: "RUNTIME_FILE_INPUT_REJECTED",
		message: "Runtime file input was rejected",
	},
] as const)(
	"Runtime operation response parsing for $code",
	({ code, message }) => {
		const blocked = {
			outcome: "rejected",
			code,
			message,
			retryable: false,
		} as const;
		const response = (
			result: Record<string, unknown>,
			schemaVersion: 1 | 2 = 2,
		) => ({
			schemaVersion,
			hostSessionRef: "host-session-conversation-1",
			operationId: "execution-1",
			result,
		});

		it("accepts the exact blocked rejection from a V2 submit response", () => {
			for (const operation of [
				"conversation.turn.submit.v1",
				"conversation.turn.regenerate.v1",
			] as const)
				expect(
					parseRuntimeResponse(response(blocked), claim({ operation })),
				).toEqual({
					schemaVersion: 2,
					hostSessionRef: "host-session-conversation-1",
					operationId: "execution-1",
					result: blocked,
				});
		});

		it.each([
			[
				"a different message",
				{ ...blocked, message: "Runtime session blocked" },
			],
			["a retryable flag", { ...blocked, retryable: true }],
			["a missing retryable flag", { ...blocked, retryable: undefined }],
			["an extra status", { ...blocked, status: "unknown" }],
		])("fails closed on a V2 blocked rejection with %s", (_label, result) => {
			const input = Object.fromEntries(
				Object.entries(result).filter(([, value]) => value !== undefined),
			);
			expect(() => parseRuntimeResponse(response(input), claim())).toThrow(
				expect.objectContaining({ code: "unavailable" }),
			);
		});

		it("fails closed when a V1 response carries the blocked code", () => {
			const v1Claim = claim({
				modelConfigurationRevision: null,
				modelOptionId: null,
				reasoningLevel: null,
			});
			expect(() => parseRuntimeResponse(response(blocked, 1), v1Claim)).toThrow(
				expect.objectContaining({ code: "unavailable" }),
			);
			expect(() =>
				parseRuntimeResponse(
					response(blocked, 1),
					nativeParametersClaim("summary", "skill"),
				),
			).toThrow(expect.objectContaining({ code: "unavailable" }));
		});
	},
);

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
	capacity:
		| "available"
		| "capacity_wait"
		| "capacity_unavailable"
		| "sandbox_wait"
		| "stop_changed" = "available";
	released = 0;
	releaseDelays: number[] = [];

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
		const turn = isRuntimeEventOperation(this.current.operation);
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
			isRuntimeEventOperation(input.claim.operation) &&
			this.current.executionStatus === "submitted"
		) {
			this.current = { ...this.current, executionStatus: "unknown" };
		}
		return true;
	}

	async cancelUnaccepted(input: { claim: ConversationDispatchClaimV1 }) {
		if (
			!this.#owned(input.claim) ||
			!this.current.stopPending ||
			(this.current.executionStatus !== "unknown" &&
				this.current.executionStatus !== "submitted" &&
				this.current.executionStatus !== "waiting")
		) {
			return false;
		}
		this.outboxStatus = "succeeded";
		this.current = { ...this.current, executionStatus: "cancelled" };
		return true;
	}

	async cancelAccepted(input: { claim: ConversationDispatchClaimV1 }) {
		if (
			!this.#owned(input.claim) ||
			(this.current.executionStatus !== "unknown" &&
				this.current.executionStatus !== "processing") ||
			input.claim.executionDeliveryFence < 1
		)
			return false;
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

	async releaseUnsentDispatch(input: {
		claim: ConversationDispatchClaimV1;
		retryDelayMs: number;
		errorCode: string;
		hostSessionRef?: string;
	}) {
		const recoveringUnacceptedTurn =
			input.claim.executionStatus === "unknown" &&
			isRuntimeEventOperation(input.claim.operation);
		const restoredStatus = recoveringUnacceptedTurn
			? input.claim.taskWaitOrder === undefined
				? "submitted"
				: "waiting"
			: input.claim.executionStatus;
		if (
			!this.#owned(input.claim) ||
			this.current.executionStatus !== "unknown" ||
			(!recoveringUnacceptedTurn &&
				input.claim.executionStatus !== "submitted" &&
				input.claim.executionStatus !== "waiting") ||
			(input.hostSessionRef !== undefined &&
				this.current.hostSessionRef !== null &&
				this.current.hostSessionRef !== input.hostSessionRef)
		)
			return false;
		this.released++;
		this.releaseDelays.push(input.retryDelayMs);
		this.outboxStatus = "retry_scheduled";
		this.errorCode = input.errorCode;
		this.current = {
			...this.current,
			executionStatus: restoredStatus,
			hostSessionRef:
				this.current.hostSessionRef ?? input.hostSessionRef ?? null,
			...(input.errorCode === "RUNTIME_TURN_NOT_SUBMITTED"
				? {
						notSubmittedResubmissions: {
							count: (this.current.notSubmittedResubmissions?.count ?? 0) + 1,
							elapsedMs: this.current.notSubmittedResubmissions?.elapsedMs ?? 0,
						},
					}
				: {}),
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

/** #3378：批量持久化的内存实现，按序逐个写入并记录每批大小。 */
class BatchedMemoryEvents extends MemoryEvents {
	readonly batches: number[] = [];
	failNextBatch = false;

	async persistBatch(
		commands: readonly Parameters<ConversationEventUseCaseV1["persist"]>[0][],
	) {
		this.batches.push(commands.length);
		if (this.failNextBatch) {
			this.failNextBatch = false;
			throw new Error("injected batch persistence failure");
		}
		const decisions = [];
		for (const command of commands) decisions.push(await this.persist(command));
		return decisions;
	}
}

function deniedAuthorization(): ConversationDispatchAuthorizationPortV1 {
	return {
		async authorize() {
			return { outcome: "denied" };
		},
	};
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
		maxRecoveryAttempts?: number;
		recoveryBudgetMs?: number;
		retryDelayMs?: number;
		batched?: true;
	} = {},
) {
	const store = options.store ?? new MemoryDispatchStore();
	const runtimeHost =
		options.runtimeHost ?? new FakeConversationRuntimeHostV1();
	const events = options.batched
		? new BatchedMemoryEvents(store)
		: new MemoryEvents(store);
	const useCase = createConversationDispatchUseCaseV1(
		{
			store,
			authorization: options.authorization ?? authorization(),
			runtimeHost,
			events,
		},
		{
			leaseDurationMs: 3_000,
			retryDelayMs: options.retryDelayMs ?? 0,
			...(options.maxRecoveryAttempts === undefined
				? {}
				: { maxRecoveryAttempts: options.maxRecoveryAttempts }),
			...(options.recoveryBudgetMs === undefined
				? {}
				: { recoveryBudgetMs: options.recoveryBudgetMs }),
		},
	);
	return { store, runtimeHost, events, useCase };
}

function dispatch(
	useCase: ConversationDispatchUseCaseV1,
	itemId = "conversation:turn:execution-1",
) {
	return useCase.dispatch({ schemaVersion: 1, itemId, workerId: "worker-1" });
}

describe("accepted unknown stop boundaries (#3315)", () => {
	const acceptedStop = () =>
		claim({
			operation: "conversation.turn.stop.v1",
			messageId: null,
			stopRequestId: "stop-original",
			input: null,
			executionStatus: "unknown",
			stopPending: true,
			stopConfirmationTimedOut: true,
			hostSessionRef: "host-original",
			acceptedOriginalHostSessionRef: "host-original",
		});

	it.each([
		{ acceptedOriginalHostSessionRef: "" },
		{ acceptedOriginalHostSessionRef: "foreign-host" },
		{ acceptedOriginalHostSessionRef: null },
		{ hostSessionRef: null },
		{ executionDeliveryFence: 0 },
		{ stopPending: false },
	])("rejects a mismatched or unbound receipt %j", (override) => {
		expect(() => parseClaim({ ...acceptedStop(), ...override })).toThrow();
	});

	it("never promotes a current Conversation Host into an acceptance receipt", () => {
		const { acceptedOriginalHostSessionRef: _receipt, ...unproven } =
			acceptedStop();
		expect(parseClaim(unproven)).not.toHaveProperty(
			"acceptedOriginalHostSessionRef",
		);
		expect(() =>
			parseClaim({
				...claim(),
				acceptedOriginalHostSessionRef: "host-original",
				hostSessionRef: "host-original",
			}),
		).toThrow();
	});

	it.each([
		"unconfirmed",
		"not_found",
		"recovery_failed",
		"busy",
		"foreign-execution",
		"foreign-host",
	] as const)("does not send stop on %s evidence", async (mode) => {
		const original = acceptedStop();
		const { acceptedOriginalHostSessionRef: _receipt, ...unproven } = original;
		const store = new MemoryDispatchStore(
			mode === "unconfirmed" ? unproven : original,
		);
		const runtimeHost: ConversationRuntimeHostPortV1 =
			new FakeConversationRuntimeHostV1();
		runtimeHost.recoverOriginalStatus = async () => {
			const base = {
				schemaVersion: 2 as const,
				executionId: original.executionId,
				hostSessionRef: "host-original",
			};
			if (mode === "not_found") return { ...base, outcome: "not_found" };
			if (mode === "recovery_failed")
				return {
					...base,
					outcome: "recovery_failed",
					code: "RUNTIME_SESSION_RECOVERY_FAILED",
				};
			return {
				...base,
				outcome: "found",
				status: "unknown",
				...(mode === "busy" ? { operationOutcome: "busy" as const } : {}),
				...(mode === "foreign-execution"
					? { executionId: "other-execution" }
					: {}),
				...(mode === "foreign-host" ? { hostSessionRef: "other-host" } : {}),
			};
		};
		const sent = vi.spyOn(runtimeHost, "dispatch");
		const f = setup({ store, runtimeHost });
		await dispatch(f.useCase);
		expect(sent).not.toHaveBeenCalled();
		expect(store.current.executionStatus).toBe("unknown");
		expect(store.outboxStatus).toBe("retry_scheduled");
	});

	it.each([
		"actorId",
		"agentId",
		"conversationId",
		"authorizationRevision",
	] as const)(
		"an acceptance receipt never overrides current %s authorization",
		async (field) => {
			const runtimeHost = new FakeConversationRuntimeHostV1();
			const sent = vi.spyOn(runtimeHost, "dispatch");
			const store = new MemoryDispatchStore(acceptedStop());
			const f = setup({
				store,
				runtimeHost,
				authorization: authorization({ [field]: "other" }),
			});
			await expect(dispatch(f.useCase)).rejects.toThrow();
			expect(sent).not.toHaveBeenCalled();
			expect(store.current.executionStatus).toBe("unknown");
		},
	);
});

function nativeParametersClaim(parameters: string, kind: "command" | "skill") {
	return claim({
		operation: "conversation.native-capability.invoke.v1",
		itemId: "conversation:native-capability:execution-1",
		input: null,
		messageId: null,
		modelConfigurationRevision: null,
		modelOptionId: null,
		reasoningLevel: null,
		hostSessionRef: "host-session-conversation-1",
		nativeCapability: {
			agentId: "agent-1",
			actorId: "actor-1",
			channelId: "web",
			turnId: "turn-1",
			capabilityId: "a".repeat(64),
			capabilityKind: kind,
			directoryRevision: "b".repeat(64),
			parameters,
			parametersDigest: nativeCapabilityParametersDigestV1(parameters),
			capabilitySourceVersion: "1.0.0",
		},
	});
}

describe("native dispatch parameter bounds", () => {
	it.each([
		{ label: "empty command", kind: "command" as const, parameters: "" },
		{
			label: "1025 byte Skill",
			kind: "skill" as const,
			parameters: "a".repeat(1025),
		},
		{
			label: "16384 byte Skill",
			kind: "skill" as const,
			parameters: "a".repeat(16384),
		},
		{
			label: "16384 UTF-8 byte Skill",
			kind: "skill" as const,
			parameters: "é".repeat(8192),
		},
	])(
		"delivers the unchanged $label to Runtime and persists its terminal event",
		async ({ kind, parameters }) => {
			const native = nativeParametersClaim(parameters, kind);
			const store = new MemoryDispatchStore(native);
			const runtimeHost = new FakeConversationRuntimeHostV1();
			runtimeHost.setEvents([runtimeEvent(1)]);
			const delivered = vi.spyOn(runtimeHost, "dispatch");
			const f = setup({ store, runtimeHost });
			expect(await dispatch(f.useCase, native.itemId)).toMatchObject({
				outcome: "accepted",
			});
			expect(delivered).toHaveBeenCalledTimes(1);
			expect(delivered.mock.calls[0]?.[0]).toMatchObject({
				operation: "native-capability.invoke",
				nativeCapability: {
					parameters,
					parametersDigest: nativeCapabilityParametersDigestV1(parameters),
				},
			});
			expect(store.current.executionStatus).toBe("completed");
			expect(store.outboxStatus).toBe("succeeded");
		},
	);

	it.each([
		{ label: "non-string", value: null },
		{ label: "NUL", value: "\0" },
		{ label: "ill-formed Unicode", value: "\ud800" },
		{ label: "over byte limit", value: "a".repeat(16385) },
		{ label: "over UTF-8 byte limit", value: "é".repeat(8193) },
	])("rejects $label native parameters", ({ value }) => {
		const native = nativeParametersClaim("summary", "skill");
		expect(() =>
			parseClaim({
				...native,
				nativeCapability: { ...native.nativeCapability, parameters: value },
			}),
		).toThrow();
	});

	it("keeps ordinary identity fields nonempty", () => {
		const native = nativeParametersClaim("", "command");
		expect(() =>
			parseClaim({
				...native,
				nativeCapability: { ...native.nativeCapability, actorId: "" },
			}),
		).toThrow();
	});
});

describe("native capability with terminal execution (#2919)", () => {
	// 固定环境的条目：执行已 cancelled，从未被 Runtime 受理（没有 hostSessionRef），
	// 授权每次都是 unavailable，条目以 AUTHORIZATION_UNAVAILABLE 每秒重试。
	function nativeTerminalClaim(
		overrides: Partial<{
			hostSessionRef: string | null;
			executionStatus: "cancelled" | "completed" | "failed" | "submitted";
		}> = {},
	) {
		return claim({
			operation: "conversation.native-capability.invoke.v1",
			itemId: "conversation:native-capability:execution-cancel-1",
			input: null,
			messageId: null,
			modelConfigurationRevision: null,
			modelOptionId: null,
			reasoningLevel: null,
			hostSessionRef:
				overrides.hostSessionRef === undefined
					? null
					: overrides.hostSessionRef,
			executionStatus: overrides.executionStatus ?? "cancelled",
			nativeCapability: {
				agentId: "agent-1",
				actorId: "actor-1",
				channelId: "web",
				turnId: "turn-1",
				capabilityId: "a".repeat(64),
				capabilityKind: "skill",
				directoryRevision: "b".repeat(64),
				parameters: "summarize files",
				parametersDigest: "c".repeat(64),
				capabilitySourceVersion: "1.0.0",
			},
		});
	}
	const unavailableAuthorization = () => ({
		async authorize() {
			return { outcome: "unavailable" as const };
		},
	});
	const runtime = () => ({
		dispatch: vi.fn(),
		recoverStatus: vi.fn(),
		events: vi.fn(async function* () {}),
	});

	it.each([
		["cancelled", "unavailable"],
		["completed", "unavailable"],
		["failed", "unavailable"],
		["cancelled", "denied"],
		["completed", "denied"],
		["failed", "denied"],
	] as const)(
		"关闭从未被 Runtime 受理的 %s 条目（授权 %s），不重试也不调用 Runtime",
		async (executionStatus, decision) => {
			const native = nativeTerminalClaim({ executionStatus });
			const store = new MemoryDispatchStore(native);
			const runtimeHost = runtime();
			const h = setup({
				store,
				authorization:
					decision === "denied"
						? deniedAuthorization()
						: unavailableAuthorization(),
				runtimeHost,
			});
			await expect(dispatch(h.useCase, native.itemId)).resolves.toMatchObject({
				outcome: "already_completed",
			});
			expect(runtimeHost.dispatch).not.toHaveBeenCalled();
			expect(runtimeHost.events).not.toHaveBeenCalled();
			expect(store.outboxStatus).toBe("succeeded");
			expect(store.errorCode).toBeUndefined();
		},
	);

	it.each(["unavailable", "denied"] as const)(
		"已被 Runtime 受理（有 hostSessionRef）的已终态条目在授权 %s 时仍重试，保留事件续读",
		async (decision) => {
			const native = nativeTerminalClaim({ hostSessionRef: "host-session-1" });
			const store = new MemoryDispatchStore(native);
			const h = setup({
				store,
				authorization:
					decision === "denied"
						? deniedAuthorization()
						: unavailableAuthorization(),
				runtimeHost: runtime(),
			});
			await expect(dispatch(h.useCase, native.itemId)).resolves.toMatchObject({
				outcome: "retry",
			});
			expect(store.outboxStatus).not.toBe("succeeded");
		},
	);

	it("执行仍为 submitted 时行为不变（授权拒绝走 reject）", async () => {
		const submitted = {
			...nativeTerminalClaim({ executionStatus: "submitted" }),
			itemId: "conversation:native-capability:execution-submitted-1",
		};
		const store = new MemoryDispatchStore(submitted);
		const runtimeHost = runtime();
		const h = setup({
			store,
			authorization: deniedAuthorization(),
			runtimeHost,
		});
		await expect(dispatch(h.useCase, submitted.itemId)).resolves.toMatchObject({
			outcome: "rejected",
		});
		expect(runtimeHost.dispatch).not.toHaveBeenCalled();
		expect(store.outboxStatus).toBe("failed");
	});
});

describe("bounded unknown recovery", () => {
	it("closes a denied unknown stop after the wall-clock recovery budget", async () => {
		const store = new MemoryDispatchStore(
			claim({
				operation: "conversation.turn.stop.v1",
				itemId: "conversation:stop:stop-1",
				messageId: null,
				stopRequestId: "stop-1",
				input: null,
				executionStatus: "unknown",
				stopPending: true,
				attemptCount: 3,
				recoveryElapsedMs: 300_000,
			}),
		);
		const h = setup({
			store,
			authorization: deniedAuthorization(),
		});

		await expect(dispatch(h.useCase, store.current.itemId)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "rejected",
		});
		expect(store.outboxStatus).toBe("failed");
		expect(store.errorCode).toBe("RUNTIME_RECOVERY_TIMEOUT");
		expect(store.current.executionStatus).toBe("failed");
	});

	it("fails an occupied unknown execution after the wall-clock recovery budget", async () => {
		const store = new MemoryDispatchStore(
			claim({
				executionStatus: "unknown",
				attemptCount: 3,
				recoveryElapsedMs: 300_000,
			}),
		);
		const recoverOriginalStatus = vi.fn(async () => {
			throw new Error("Runtime recovery is unavailable");
		});
		const runtimeHost =
			new FakeConversationRuntimeHostV1() as unknown as ConversationRuntimeHostPortV1;
		runtimeHost.recoverOriginalStatus = recoverOriginalStatus;
		const h = setup({ store, runtimeHost });

		await expect(dispatch(h.useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "rejected",
		});
		expect(recoverOriginalStatus).not.toHaveBeenCalled();
		expect(store.outboxStatus).toBe("failed");
		expect(store.errorCode).toBe("RUNTIME_RECOVERY_TIMEOUT");
		expect(store.current.executionStatus).toBe("failed");
	});

	// #3373：预算按 Execution 进入 unknown 以来的墙钟时间计，不按认领次数计。
	it.each([
		["below the default budget after many claims", 299_999, undefined],
		["below a configured budget", 59_999, 60_000],
	])(
		"keeps querying the original Turn %s",
		async (_name, recoveryElapsedMs, recoveryBudgetMs) => {
			const store = new MemoryDispatchStore(
				claim({
					executionStatus: "unknown",
					attemptCount: 10_000,
					recoveryElapsedMs,
				}),
			);
			const recoverOriginalStatus = vi.fn(async () => {
				throw new Error("Runtime recovery is unavailable");
			});
			const runtimeHost =
				new FakeConversationRuntimeHostV1() as unknown as ConversationRuntimeHostPortV1;
			runtimeHost.recoverOriginalStatus = recoverOriginalStatus;
			const h = setup({
				store,
				runtimeHost,
				...(recoveryBudgetMs === undefined ? {} : { recoveryBudgetMs }),
			});

			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "retry",
			});
			expect(recoverOriginalStatus).toHaveBeenCalledOnce();
			expect(store.errorCode).not.toBe("RUNTIME_RECOVERY_TIMEOUT");
			expect(store.current.executionStatus).toBe("unknown");
		},
	);

	it("applies a configured wall-clock budget", async () => {
		const store = new MemoryDispatchStore(
			claim({ executionStatus: "unknown", recoveryElapsedMs: 60_000 }),
		);
		const h = setup({ store, recoveryBudgetMs: 60_000 });

		await expect(dispatch(h.useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "rejected",
		});
		expect(store.errorCode).toBe("RUNTIME_RECOVERY_TIMEOUT");
	});

	it.each([0, 86_400_001, 1.5])(
		"rejects an invalid recovery budget %s",
		(recoveryBudgetMs) => {
			expect(() => setup({ recoveryBudgetMs })).toThrow(
				ConversationDispatchError,
			);
		},
	);

	it("closes terminal metadata recovery after the durable attempt limit", async () => {
		const store = new MemoryDispatchStore(
			claim({
				executionStatus: "completed",
				attemptCount: 3,
				hostSessionRef: "host-session",
				runtimeCursor: "cursor-1",
				metadataRecovery: {
					id: "metadata-recovery-1",
					requestedAt: 1,
					originalStatus: "succeeded",
				},
			}),
		);
		const recoverOriginalStatus = vi.fn(async () => {
			throw new Error("Runtime recovery is unavailable");
		});
		const runtimeHost =
			new FakeConversationRuntimeHostV1() as unknown as ConversationRuntimeHostPortV1;
		runtimeHost.recoverOriginalStatus = recoverOriginalStatus;
		const h = setup({ store, maxRecoveryAttempts: 3, runtimeHost });

		await expect(dispatch(h.useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "rejected",
		});
		expect(recoverOriginalStatus).not.toHaveBeenCalled();
		expect(store.outboxStatus).toBe("failed");
		expect(store.errorCode).toBe("RUNTIME_METADATA_RECOVERY_TIMEOUT");
		expect(store.current.executionStatus).toBe("completed");
	});
});

describe("Conversation Worker dispatch", () => {
	it("cancels an accepted Turn when stop wins during Runtime key delivery", async () => {
		const store = new MemoryDispatchStore(
			claim({ executionStatus: "processing", hostSessionRef: "host" }),
		);
		const runtimeHost =
			new FakeConversationRuntimeHostV1() as unknown as ConversationRuntimeHostPortV1;
		runtimeHost.dispatch = vi.fn(async () => {
			throw new ConversationRuntimeHostError("RUNTIME_STOP_PENDING", false);
		});
		const h = setup({ store, runtimeHost });

		await expect(dispatch(h.useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "already_completed",
		});
		expect(store.current.executionStatus).toBe("cancelled");
		expect(store.outboxStatus).toBe("succeeded");
		expect(store.errorCode).toBeUndefined();
	});

	it.each(["submitted", "waiting"] as const)(
		"locally cancels an unaccepted stop after authorization denial (%s)",
		async (executionStatus) => {
			const store = new MemoryDispatchStore(
				claim({
					operation: "conversation.turn.stop.v1",
					itemId: "conversation:stop:stop-1",
					messageId: null,
					stopRequestId: "stop-1",
					input: null,
					executionStatus,
					stopPending: true,
					taskWaitOrder: executionStatus === "waiting" ? 1 : undefined,
				}),
			);
			const runtimeDispatch = vi.fn();
			const h = setup({
				store,
				authorization: deniedAuthorization(),
				runtimeHost: {
					dispatch: runtimeDispatch,
					recoverStatus: vi.fn(),
					events: vi.fn(),
				},
			});

			await expect(dispatch(h.useCase, store.current.itemId)).resolves.toEqual({
				schemaVersion: 1,
				outcome: "already_completed",
			});
			expect(runtimeDispatch).not.toHaveBeenCalled();
			expect(store.outboxStatus).toBe("succeeded");
			expect(store.current.executionStatus).toBe("cancelled");
		},
	);

	it("locally cancels an unaccepted stop after control-only authorization", async () => {
		const store = new MemoryDispatchStore(
			claim({
				operation: "conversation.turn.stop.v1",
				itemId: "conversation:stop:stop-1",
				messageId: null,
				stopRequestId: "stop-1",
				input: null,
				executionStatus: "submitted",
				stopPending: true,
			}),
		);
		const runtimeDispatch = vi.fn();
		const h = setup({
			store,
			authorization: authorization({ controlOnly: true }),
			runtimeHost: {
				dispatch: runtimeDispatch,
				recoverStatus: vi.fn(),
				events: vi.fn(),
			},
		});

		await expect(dispatch(h.useCase, store.current.itemId)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "already_completed",
		});
		expect(runtimeDispatch).not.toHaveBeenCalled();
		expect(store.outboxStatus).toBe("succeeded");
		expect(store.current.executionStatus).toBe("cancelled");
	});

	it("keeps unknown stops on the existing recovery path after authorization denial", async () => {
		const store = new MemoryDispatchStore(
			claim({
				operation: "conversation.turn.stop.v1",
				itemId: "conversation:stop:stop-1",
				messageId: null,
				stopRequestId: "stop-1",
				input: null,
				executionStatus: "unknown",
				stopPending: true,
			}),
		);
		const h = setup({ store, authorization: deniedAuthorization() });

		await expect(
			dispatch(h.useCase, store.current.itemId),
		).resolves.toMatchObject({
			outcome: "retry",
		});
		expect(store.outboxStatus).toBe("retry_scheduled");
		expect(store.current.executionStatus).toBe("unknown");
	});

	it.each([
		[
			{ outcome: "found", status: "completed" },
			"accepted",
			"completed",
			"succeeded",
			1,
		],
		[{ outcome: "not_found" }, "retry", "submitted", "retry_scheduled", 0],
		[
			{ outcome: "found", status: "unknown", operationOutcome: "busy" },
			"rejected",
			"failed",
			"failed",
			0,
		],
	] as const)(
		"recovers an unknown native capability from %j without dispatching it twice",
		async (recovered, outcome, executionStatus, outboxStatus, eventCount) => {
			const native = claim({
				operation: "conversation.native-capability.invoke.v1",
				itemId: "conversation:native-capability:execution-1",
				input: null,
				messageId: null,
				modelConfigurationRevision: null,
				modelOptionId: null,
				reasoningLevel: null,
				hostSessionRef: "host-session",
				executionStatus: "unknown",
				attemptCount: 1,
				nativeCapability: {
					agentId: "agent-1",
					actorId: "actor-1",
					channelId: "web",
					turnId: "turn-1",
					capabilityId: "a".repeat(64),
					capabilityKind: "skill",
					directoryRevision: "b".repeat(64),
					parameters: "summarize files",
					parametersDigest: "c".repeat(64),
					capabilitySourceVersion: "1.0.0",
				},
			});
			const store = new MemoryDispatchStore(native);
			const runtimeDispatch = vi.fn(async () => {
				throw new Error("native side effect must not be replayed");
			});
			const recoverOriginalStatus = vi.fn(async () => ({
				schemaVersion: 2 as const,
				hostSessionRef: "host-session",
				executionId: "execution-1",
				...recovered,
			}));
			const runtimeHost: ConversationRuntimeHostPortV1 = {
				dispatch: runtimeDispatch,
				recoverStatus: vi.fn(),
				recoverOriginalStatus,
				async *events() {
					yield runtimeEvent(1, "completed");
				},
			};
			const h = setup({ store, runtimeHost });

			const decision = await dispatch(h.useCase, native.itemId);
			expect(decision).toMatchObject({ schemaVersion: 1, outcome });
			expect(runtimeDispatch).not.toHaveBeenCalled();
			expect(recoverOriginalStatus).toHaveBeenCalledOnce();
			expect(store.outboxStatus).toBe(outboxStatus);
			expect(store.current.executionStatus).toBe(executionStatus);
			expect(h.events.persisted).toHaveLength(eventCount);
		},
	);

	it("bounds repeated unknown native capability recovery", async () => {
		const store = new MemoryDispatchStore(
			claim({
				operation: "conversation.native-capability.invoke.v1",
				itemId: "conversation:native-capability:execution-1",
				input: null,
				messageId: null,
				modelConfigurationRevision: null,
				modelOptionId: null,
				reasoningLevel: null,
				hostSessionRef: "host-session",
				executionStatus: "unknown",
				attemptCount: 3,
				recoveryElapsedMs: 300_000,
				nativeCapability: {
					agentId: "agent-1",
					actorId: "actor-1",
					channelId: "web",
					turnId: "turn-1",
					capabilityId: "a".repeat(64),
					capabilityKind: "command",
					directoryRevision: "b".repeat(64),
					parameters: "noop",
					parametersDigest: "c".repeat(64),
					capabilitySourceVersion: "1.0.0",
				},
			}),
		);
		const recoverOriginalStatus = vi.fn(async () => {
			throw new Error("recovery must be bounded");
		});
		const runtimeHost = {
			dispatch: vi.fn(),
			recoverOriginalStatus,
			recoverStatus: vi.fn(),
			async *events() {},
		} as unknown as ConversationRuntimeHostPortV1;
		const h = setup({ store, runtimeHost });

		await expect(dispatch(h.useCase, store.current.itemId)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "rejected",
		});
		expect(recoverOriginalStatus).not.toHaveBeenCalled();
		expect(runtimeHost.dispatch).not.toHaveBeenCalled();
		expect(store.errorCode).toBe("RUNTIME_RECOVERY_TIMEOUT");
		expect(store.outboxStatus).toBe("failed");
	});

	it.each([
		"conversation.turn.submit.v1",
		"conversation.turn.regenerate.v1",
		"conversation.turn.stop.v1",
	] as const)(
		"writes only the original ref for a missing-binding %s recovery and keeps occupancy",
		async (operation) => {
			const stop = operation === "conversation.turn.stop.v1";
			const store = new MemoryDispatchStore(
				claim({
					operation,
					executionStatus: "unknown",
					stopPending: true,
					...(stop
						? {
								messageId: null,
								input: null,
								stopRequestId: "stop-original",
								itemId: "conversation:stop:stop-original",
							}
						: {}),
					runtimeCursor: "committed-original-cursor",
				}),
			);
			let dispatched = 0;
			let reads = 0;
			const runtimeHost: ConversationRuntimeHostPortV1 = {
				async dispatch() {
					dispatched++;
					throw new Error("Business dispatch forbidden");
				},
				async recoverStatus() {
					throw new Error("Only original recovery allowed");
				},
				async recoverOriginalStatus(request) {
					reads++;
					expect(request).toMatchObject({
						hostSessionRef: null,
						executionId: "execution-1",
						turnId: "turn-1",
						deliveryFence: store.current.executionDeliveryFence,
					});
					return {
						schemaVersion: 2,
						outcome: "binding_found",
						hostSessionRef: "durable-original",
						executionId: "execution-1",
					};
				},
				events() {
					throw new Error("Binding-only is not a status/event receipt");
				},
			};
			const h = setup({
				store,
				runtimeHost,
				authorization: authorization({ controlOnly: true }),
			});
			await expect(
				dispatch(h.useCase, store.current.itemId),
			).resolves.toMatchObject({ outcome: "unknown", retryScheduled: true });
			expect(store.current).toMatchObject({
				hostSessionRef: "durable-original",
				executionStatus: "unknown",
				stopPending: true,
				runtimeCursor: "committed-original-cursor",
				executionId: "execution-1",
				turnId: "turn-1",
				sessionGeneration: 1,
				authorizationRevision: "authorization-1",
			});
			expect(h.events.persisted).toEqual([]);
			expect(dispatched).toBe(0);
			expect(reads).toBe(1);
		},
	);

	it.each(["takeover", "CAS"] as const)(
		"does not write or accept a binding after %s becomes stale",
		async (failure) => {
			const store = new MemoryDispatchStore(
				claim({ executionStatus: "unknown", stopPending: true }),
			);
			const runtimeHost: ConversationRuntimeHostPortV1 = {
				async dispatch() {
					throw new Error("Business dispatch forbidden");
				},
				async recoverStatus() {
					throw new Error("Only original recovery allowed");
				},
				async recoverOriginalStatus() {
					if (failure === "takeover")
						store.current = {
							...store.current,
							leaseOwner: "other-worker",
							deliveryFence: store.current.deliveryFence + 1,
						};
					else store.recordable = false;
					return {
						schemaVersion: 2,
						outcome: "binding_found",
						hostSessionRef: "durable-original",
						executionId: "execution-1",
					};
				},
				events() {
					throw new Error("Events forbidden");
				},
			};
			const h = setup({
				store,
				runtimeHost,
				authorization: authorization({ controlOnly: true }),
			});
			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "stale",
			});
			expect(store.current).toMatchObject({
				hostSessionRef: null,
				executionStatus: "unknown",
				stopPending: true,
			});
		},
	);

	it("rejects malformed binding-only responses and ordinary status introducing a missing ref", () => {
		const original = claim({ executionStatus: "unknown", stopPending: true });
		const binding = {
			schemaVersion: 2,
			outcome: "binding_found",
			hostSessionRef: "durable-original",
			executionId: original.executionId,
		};
		expect(parseRuntimeStatusResponse(binding, original)).toEqual(binding);
		for (const invalid of [
			{ ...binding, executionId: "other" },
			{ ...binding, hostSessionRef: "" },
			{ ...binding, hostSessionRef: null },
			{ ...binding, schemaVersion: 3 },
			{ ...binding, status: "running" },
			{ ...binding, status: undefined },
			{ ...binding, code: undefined },
			{ ...binding, code: "RUNTIME_ACCEPTANCE_UNKNOWN" },
			{ ...binding, unexpected: true },
			{ ...binding, outcome: "found", status: "running" },
		])
			expect(() => parseRuntimeStatusResponse(invalid, original)).toThrow();
		expect(() =>
			parseRuntimeStatusResponse(binding, claim({ hostSessionRef: "other" })),
		).toThrow();
		expect(() =>
			parseRuntimeStatusResponse(
				binding,
				claim({ hostSessionRef: "durable-original" }),
			),
		).toThrow();
		expect(
			parseRuntimeStatusResponse(
				{
					schemaVersion: 2,
					outcome: "recovery_failed",
					hostSessionRef: "durable-original",
					executionId: original.executionId,
					code: "RUNTIME_SESSION_RECOVERY_FAILED",
				},
				original,
			),
		).toMatchObject({
			outcome: "recovery_failed",
			hostSessionRef: "durable-original",
		});
	});

	it("keeps a missing-ref unknown stop pending when the Host has no reliable binding", async () => {
		const store = new MemoryDispatchStore(
			claim({
				operation: "conversation.turn.stop.v1",
				itemId: "conversation:stop:stop-original",
				stopRequestId: "stop-original",
				messageId: null,
				input: null,
				executionStatus: "unknown",
				stopPending: true,
			}),
		);
		const runtimeHost: ConversationRuntimeHostPortV1 = {
			async dispatch() {
				throw new Error("Stop needs a durable ref");
			},
			async recoverStatus() {
				throw new Error("Only original recovery allowed");
			},
			async recoverOriginalStatus() {
				return {
					schemaVersion: 2,
					outcome: "not_found",
					hostSessionRef: null,
					executionId: "execution-1",
				};
			},
			events() {
				throw new Error("Events forbidden");
			},
		};
		const h = setup({
			store,
			runtimeHost,
			authorization: authorization({ controlOnly: true }),
		});
		await expect(
			dispatch(h.useCase, store.current.itemId),
		).resolves.toMatchObject({ outcome: "unknown" });
		expect(store.current).toMatchObject({
			hostSessionRef: null,
			executionStatus: "unknown",
			stopPending: true,
		});
		expect(store.outboxStatus).toBe("retry_scheduled");
	});

	it("keeps a recovered Turn open until its terminal event persists (#1524)", async () => {
		const pages = [
			[
				{
					schemaVersion: 1 as const,
					adapterEventKey: "event-t1",
					executionId: "execution-1",
					cursor: "cursor-t1",
					occurredAt: "2026-09-06T00:00:01.000Z",
					type: "text" as const,
					payload: { delta: "partial" },
				},
			],
			[runtimeEvent(2)],
		];
		let reads = 0;
		const runtimeHost: ConversationRuntimeHostPortV1 = {
			async dispatch() {
				throw new Error("Recovery must not resubmit");
			},
			async recoverStatus() {
				throw new Error("Unexpected legacy recovery");
			},
			async recoverOriginalStatus(request) {
				return {
					schemaVersion: 2,
					executionId: request.executionId,
					hostSessionRef: "host-session-conversation-1",
					outcome: "found",
					status: "completed",
				};
			},
			async *events() {
				// The Host replays a bounded page; this stream ends without the
				// terminal event although the status response says completed.
				for (const event of pages[reads++] ?? []) yield event;
			},
		};
		const store = new MemoryDispatchStore(
			claim({
				executionStatus: "processing",
				hostSessionRef: "host-session-conversation-1",
			}),
		);
		const h = setup({ store, runtimeHost });
		expect(await dispatch(h.useCase)).toMatchObject({ outcome: "retry" });
		expect(store.outboxStatus).toBe("retry_scheduled");
		expect(store.errorCode).toBe("RUNTIME_STREAM_INCOMPLETE");
		expect(h.events.persisted.map((event) => event.runtimeCursor)).toEqual([
			"cursor-t1",
		]);
		expect(await dispatch(h.useCase)).toMatchObject({ outcome: "accepted" });
		expect(store.outboxStatus).toBe("succeeded");
		expect(h.events.persisted.map((event) => event.runtimeCursor)).toEqual([
			"cursor-t1",
			"cursor-2",
		]);
	});
	it("releases an original execution when recovery finds no accepted Turn", async () => {
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
		expect(await dispatch(f.useCase)).toMatchObject({
			outcome: "retry",
			retryScheduled: true,
		});
		expect({ dispatches, recoveries }).toEqual({
			dispatches: 0,
			recoveries: 1,
		});
		expect(store.current.executionStatus).toBe("submitted");
	});

	it("releases an unaccepted Turn after recovery proves it was never found", async () => {
		let dispatches = 0;
		const runtimeHost: ConversationRuntimeHostPortV1 = {
			async dispatch() {
				dispatches++;
				return {
					schemaVersion: 2,
					hostSessionRef: "host-retry",
					operationId: "execution-1",
					result: { outcome: "accepted", status: "running" },
				};
			},
			async recoverStatus() {
				throw new Error("Unexpected legacy recovery");
			},
			async recoverOriginalStatus(request) {
				return {
					schemaVersion: 2,
					executionId: request.executionId,
					hostSessionRef: null,
					outcome: "not_found" as const,
				};
			},
			async *events() {
				yield runtimeEvent(1);
			},
		};
		const store = new MemoryDispatchStore(
			claim({ executionStatus: "unknown", taskWaitOrder: 3 }),
		);
		const h = setup({ store, runtimeHost });
		expect(await dispatch(h.useCase)).toEqual({
			schemaVersion: 1,
			outcome: "retry",
			retryScheduled: true,
		});
		expect(store.current.executionStatus).toBe("waiting");
		expect(store.released).toBe(1);

		// The retry keeps the same execution and claims a higher delivery fence.
		store.outboxStatus = "retry_scheduled";
		const second = await dispatch(h.useCase);
		expect(second).toMatchObject({
			schemaVersion: 1,
			outcome: "accepted",
		});
		expect(dispatches).toBe(1);
		expect(store.current.executionId).toBe("execution-1");
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

	it.each(["capacity_wait", "capacity_unavailable", "sandbox_wait"] as const)(
		"preserves unreserved submitted work when preparation reports %s",
		async (capacity) => {
			const runtimeHost = new FakeConversationRuntimeHostV1();
			runtimeHost.setEvents([runtimeEvent(1)]);
			const f = setup({ runtimeHost });
			f.store.capacity = capacity;
			expect(await dispatch(f.useCase)).toMatchObject({
				outcome: "retry",
				retryScheduled: true,
			});
			expect(f.store.current.executionStatus).toBe("submitted");
			expect(f.store.outboxStatus).toBe("retry_scheduled");
			expect(f.store.errorCode).toBe(
				capacity === "capacity_wait"
					? "AGENT_CAPACITY_FULL"
					: capacity === "sandbox_wait"
						? "SESSION_SANDBOX_UPDATING"
						: "AGENT_CAPACITY_UNVERIFIED",
			);
			f.store.capacity = "available";
			expect(runtimeHost.sideEffectCount()).toBe(0);
			expect(await dispatch(f.useCase)).toMatchObject({ outcome: "accepted" });
			expect(runtimeHost.sideEffectCount()).toBe(1);
		},
	);
	it("abandons a claim whose Stop was accepted after the claim without scheduling a retry (#2534)", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.setEvents([runtimeEvent(1)]);
		const f = setup({ runtimeHost });
		f.store.capacity = "stop_changed";
		// Store 已把条目释放为可重新认领；Core 不 retry、不 reject，也不碰 Runtime。
		expect(await dispatch(f.useCase)).toMatchObject({ outcome: "stale" });
		expect(f.store.outboxStatus).toBe("processing");
		expect(f.store.errorCode).toBeUndefined();
		expect(f.store.current.executionStatus).toBe("submitted");
		expect(runtimeHost.sideEffectCount()).toBe(0);
	});
	it.each([
		["not sent", true, "submitted", 1],
		["possibly sent", false, "unknown", 0],
	] as const)(
		"returns a %s Turn to its waiting position only with proof (#1522)",
		async (_label, notSent, expectedStatus, released) => {
			const runtimeHost = new FakeConversationRuntimeHostV1();
			runtimeHost.setEvents([runtimeEvent(1)]);
			runtimeHost.failNext("RUNTIME_WORKLOAD_UNAVAILABLE", true, notSent);
			const f = setup({ runtimeHost });
			expect(await dispatch(f.useCase)).toMatchObject({
				outcome: "retry",
				retryScheduled: true,
			});
			expect(f.store.current.executionStatus).toBe(expectedStatus);
			expect(f.store.released).toBe(released);
			expect(f.store.outboxStatus).toBe("retry_scheduled");
			expect(f.store.errorCode).toBe("RUNTIME_WORKLOAD_UNAVAILABLE");
			expect(runtimeHost.sideEffectCount()).toBe(0);
			if (!notSent) return;
			expect(await dispatch(f.useCase)).toMatchObject({ outcome: "accepted" });
			expect(runtimeHost.sideEffectCount()).toBe(1);
		},
	);
	it("releases a native invocation only when delivery is proven unsent", async () => {
		const native = claim({
			operation: "conversation.native-capability.invoke.v1",
			itemId: "conversation:native-capability:execution-1",
			input: null,
			messageId: null,
			modelConfigurationRevision: null,
			modelOptionId: null,
			reasoningLevel: null,
			hostSessionRef: "host-session",
			executionStatus: "submitted",
			nativeCapability: {
				agentId: "agent-1",
				actorId: "actor-1",
				channelId: "web",
				turnId: "turn-1",
				capabilityId: "a".repeat(64),
				capabilityKind: "skill",
				directoryRevision: "b".repeat(64),
				parameters: "summary",
				parametersDigest: "c".repeat(64),
				capabilitySourceVersion: "1.0.0",
			},
		});
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.failNext("RUNTIME_WORKLOAD_UNAVAILABLE", true, true);
		const store = new MemoryDispatchStore(native);
		const f = setup({ runtimeHost, store });
		expect(await dispatch(f.useCase, native.itemId)).toMatchObject({
			outcome: "retry",
			retryScheduled: true,
		});
		expect(store.current.executionStatus).toBe("submitted");
		expect(store.released).toBe(1);
		expect(runtimeHost.sideEffectCount()).toBe(0);
	});

	it("keeps a recovering unknown Turn unknown even when the retry was not sent (#1522)", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.failNext("RUNTIME_WORKLOAD_UNAVAILABLE", true, true);
		const f = setup({
			store: new MemoryDispatchStore(claim({ executionStatus: "unknown" })),
			runtimeHost,
		});
		expect(await dispatch(f.useCase)).toMatchObject({ outcome: "retry" });
		expect(f.store.released).toBe(0);
		expect(f.store.current.executionStatus).toBe("unknown");
	});
	it("settles a persisted busy result during unknown Turn recovery", async () => {
		const runtimeHost =
			new FakeConversationRuntimeHostV1() as unknown as ConversationRuntimeHostPortV1;
		runtimeHost.recoverOriginalStatus = async (request) => ({
			schemaVersion: 2,
			hostSessionRef: request.hostSessionRef,
			executionId: request.executionId,
			outcome: "found" as const,
			status: "unknown" as const,
			operationOutcome: "busy" as const,
		});
		const store = new MemoryDispatchStore(
			claim({ executionStatus: "unknown", hostSessionRef: "host-original" }),
		);
		const f = setup({
			store,
			runtimeHost,
			authorization: authorization({ controlOnly: true }),
		});

		expect(await dispatch(f.useCase)).toEqual({
			schemaVersion: 1,
			outcome: "rejected",
		});
		expect(store.current.executionStatus).toBe("failed");
		expect(store.errorCode).toBe("RUNTIME_BUSY");
		expect(store.outboxStatus).toBe("failed");
	});
	it("rejects a busy result bound to another execution without settling this Turn", async () => {
		const runtimeHost =
			new FakeConversationRuntimeHostV1() as unknown as ConversationRuntimeHostPortV1;
		runtimeHost.recoverOriginalStatus = async (request) => ({
			schemaVersion: 2,
			hostSessionRef: request.hostSessionRef,
			executionId: "foreign-execution",
			outcome: "found" as const,
			status: "unknown" as const,
			operationOutcome: "busy" as const,
		});
		const store = new MemoryDispatchStore(
			claim({ executionStatus: "unknown", hostSessionRef: "host-original" }),
		);
		const f = setup({
			store,
			runtimeHost,
			authorization: authorization({ controlOnly: true }),
		});

		expect(await dispatch(f.useCase)).toMatchObject({ outcome: "retry" });
		expect(store.current.executionStatus).toBe("unknown");
		expect(store.errorCode).toBe("RUNTIME_UNAVAILABLE");
		expect(store.outboxStatus).toBe("retry_scheduled");
	});
	it("keeps a stop recovery on its existing unknown path when Host reports busy", async () => {
		const runtimeHost =
			new FakeConversationRuntimeHostV1() as unknown as ConversationRuntimeHostPortV1;
		runtimeHost.recoverOriginalStatus = async (request) => ({
			schemaVersion: 2,
			hostSessionRef: request.hostSessionRef,
			executionId: request.executionId,
			outcome: "found" as const,
			status: "unknown" as const,
			operationOutcome: "busy" as const,
		});
		const store = new MemoryDispatchStore(
			claim({
				operation: "conversation.turn.stop.v1",
				messageId: null,
				stopRequestId: "stop-original",
				input: null,
				executionStatus: "processing",
				stopPending: true,
				stopConfirmationTimedOut: true,
				hostSessionRef: "host-original",
			}),
		);
		const f = setup({ store, runtimeHost });

		expect(await dispatch(f.useCase)).toMatchObject({ outcome: "unknown" });
		expect(store.current.executionStatus).toBe("processing");
		expect(store.errorCode).toBe("RUNTIME_ACCEPTANCE_UNKNOWN");
		expect(store.outboxStatus).toBe("retry_scheduled");
	});
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

	it("dispatches a claim whose durable work item carries a W3C traceparent (#2473)", async () => {
		const traceParent =
			"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.setEvents([runtimeEvent(1, "running"), runtimeEvent(2)]);
		const h = setup({
			store: new MemoryDispatchStore(claim({ traceParent })),
			runtimeHost,
		});
		await expect(dispatch(h.useCase)).resolves.toMatchObject({
			outcome: "accepted",
		});
		expect(runtimeHost.sideEffectCount()).toBe(1);
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
		// The cumulative ACK waits for the terminal event, so both events are
		// committed when that single ACK is lost (#1525).
		expect(acknowledged).toEqual([]);
		expect(harness.events.persisted).toHaveLength(2);
		await expect(dispatch(harness.useCase)).resolves.toMatchObject({
			outcome: "accepted",
		});
		expect(acknowledged).toEqual(["cursor-2"]);
		expect(harness.events.persisted).toHaveLength(2);
		expect(inner.sideEffectCount()).toBe(1);
	});

	describe("cumulative event acknowledgement (#1525)", () => {
		const text = (sequence: number): ConversationRuntimeEventV1 => ({
			schemaVersion: 1,
			adapterEventKey: `event-${sequence}`,
			executionId: "execution-1",
			cursor: `cursor-${sequence}`,
			occurredAt: "2026-09-06T00:00:01.000Z",
			type: "text",
			payload: { delta: `part ${sequence}` },
		});
		const tool = (
			sequence: number,
			phase: "intent" | "started",
		): ConversationRuntimeOperationEventV2 => ({
			...runtimeEvent(sequence),
			schemaVersion: 2,
			type: "operation",
			payload: {
				kind: "tool",
				toolId: "connection.create_pr",
				operationRef: "tool-1",
				attemptRef: "attempt-1",
				phase,
				...(phase === "started"
					? { startedAt: "2026-09-06T00:00:02.000Z" }
					: {}),
			} as ConversationRuntimeOperationEventV2["payload"],
		});
		function host(
			stream: (
				request: { afterCursor?: string },
				hooks?: { readonly beforeRead?: () => Promise<void> },
			) => AsyncIterable<unknown>,
		) {
			const inner = new FakeConversationRuntimeHostV1();
			const acknowledged: string[] = [];
			const runtimeHost: ConversationRuntimeHostPortV1 = {
				dispatch: (request) => inner.dispatch(request),
				recoverStatus: (request) => inner.recoverStatus(request),
				events: (request, _signal, hooks) => stream(request, hooks) as never,
				async acknowledge(request) {
					acknowledged.push(request.confirmedCursor);
				},
			};
			return { inner, runtimeHost, acknowledged };
		}

		it("confirms a reply with one ACK of its terminal cursor", async () => {
			const { runtimeHost, acknowledged } = host(async function* () {
				yield runtimeEvent(1, "running");
				for (let sequence = 2; sequence <= 9; sequence++) yield text(sequence);
				yield runtimeEvent(10);
			});
			const h = setup({ runtimeHost });
			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "accepted",
			});
			expect(h.events.persisted.map((event) => event.runtimeCursor)).toEqual(
				Array.from({ length: 10 }, (_, index) => `cursor-${index + 1}`),
			);
			expect(acknowledged).toEqual(["cursor-10"]);
		});

		const reasoning = (
			sequence: number,
			kind: "raw" | "summary",
		): ConversationRuntimeReasoningEventV2 => ({
			...text(sequence),
			schemaVersion: 2,
			type: "reasoning",
			payload: { kind, delta: `thought ${sequence}` },
		});

		it("persists plain reasoning deltas in Runtime order with the reply's single ACK (#2979)", async () => {
			const { runtimeHost, acknowledged } = host(async function* () {
				yield runtimeEvent(1, "running");
				yield reasoning(2, "raw");
				yield text(3);
				yield reasoning(4, "summary");
				yield runtimeEvent(5);
			});
			const h = setup({ runtimeHost });
			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "accepted",
			});
			expect(
				h.events.persisted.slice(1, 4).map((command) => command.event),
			).toEqual([
				{ type: "reasoning.delta", kind: "raw", text: "thought 2" },
				{ type: "text.delta", text: "part 3" },
				{ type: "reasoning.delta", kind: "summary", text: "thought 4" },
			]);
			expect(
				h.events.persisted
					.filter((command) => command.event.type === "reasoning.delta")
					.map((command) => [command.adapterEventKey, command.transition]),
			).toEqual([
				["event-2", undefined],
				["event-4", undefined],
			]);
			expect(acknowledged).toEqual(["cursor-5"]);
		});

		it.each([
			["an unknown kind", { kind: "encrypted", delta: "opaque" }],
			["an empty delta", { kind: "raw", delta: "" }],
			["an oversized delta", { kind: "raw", delta: "x".repeat(65_537) }],
			[
				"an extra field",
				{ kind: "raw", delta: "thought", encrypted_content: "opaque" },
			],
			["a missing kind", { delta: "thought" }],
		])(
			"fails closed for a reasoning delta with %s without persisting or acknowledging it (#2979)",
			async (_name, payload) => {
				const { runtimeHost, acknowledged } = host(async function* () {
					yield runtimeEvent(1, "running");
					yield text(2);
					yield { ...reasoning(3, "raw"), payload };
					yield runtimeEvent(4);
				});
				const h = setup({ runtimeHost });
				const result = await dispatch(h.useCase);
				expect(result.outcome).not.toBe("accepted");
				expect(h.events.persisted.map((event) => event.runtimeCursor)).toEqual([
					"cursor-1",
					"cursor-2",
				]);
				expect(acknowledged).not.toContain("cursor-3");
				expect(acknowledged).not.toContain("cursor-4");
			},
		);

		it("acknowledges a tool fact before the Runtime is asked for more events", async () => {
			const seen: number[] = [];
			const { runtimeHost, acknowledged } = host(async function* () {
				yield tool(1, "intent");
				// The Runtime does not call the tool until this fact is confirmed.
				seen.push(acknowledged.length);
				yield tool(2, "started");
				seen.push(acknowledged.length);
				yield text(3);
				seen.push(acknowledged.length);
				yield runtimeEvent(4);
			});
			const h = setup({ runtimeHost });
			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "accepted",
			});
			expect(seen).toEqual([1, 2, 2]);
			expect(acknowledged).toEqual(["cursor-1", "cursor-2", "cursor-4"]);
		});

		it("bounds unacknowledged events and confirms the last committed cursor when the stream ends", async () => {
			const { runtimeHost, acknowledged } = host(async function* () {
				for (let sequence = 1; sequence <= 70; sequence++) yield text(sequence);
			});
			const h = setup({ runtimeHost });
			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "retry",
			});
			expect(h.events.persisted).toHaveLength(70);
			expect(acknowledged).toEqual(["cursor-32", "cursor-64", "cursor-70"]);
		});

		it("never acknowledges past a failed commit and resumes from the committed cursor", async () => {
			const stream = [
				runtimeEvent(1, "running"),
				text(2),
				text(3),
				text(4),
				runtimeEvent(5),
			];
			const requests: (string | undefined)[] = [];
			const { inner, runtimeHost, acknowledged } = host(
				async function* (request) {
					requests.push(request.afterCursor);
					const index = request.afterCursor
						? stream.findIndex(
								(event) => event.cursor === request.afterCursor,
							) + 1
						: 0;
					yield* stream.slice(index);
				},
			);
			const h = setup({ runtimeHost });
			const binding = {
				conversationId: "conversation-1",
				executionId: "execution-1",
				sessionGeneration: 1,
				hostSessionRef: "host-session-conversation-1",
			};
			const persist = h.events.persist.bind(h.events);
			let failed = false;
			h.events.persist = async (command) => {
				if (command.runtimeCursor === "cursor-4" && !failed) {
					failed = true;
					throw new Error("injected persistence failure");
				}
				return persist(command);
			};
			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "retry",
			});
			expect(acknowledged).toEqual([]);
			expect(h.store.current.runtimeCursor).toBe("cursor-3");
			expect(h.events.persisted.map(({ event }) => event)).toEqual([
				{ type: "execution.status", status: "processing" },
				{ type: "text.delta", text: "part 2" },
				{ type: "text.delta", text: "part 3" },
			]);
			expect(h.store).toMatchObject({
				errorCode: "EVENT_PERSISTENCE_UNAVAILABLE",
				outboxStatus: "retry_scheduled",
				current: {
					...binding,
					executionStatus: "unknown",
					deliveryFence: 2,
					executionDeliveryFence: 2,
				},
			});
			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "accepted",
			});
			expect(h.store).toMatchObject({
				outboxStatus: "succeeded",
				current: {
					...binding,
					executionStatus: "completed",
					deliveryFence: 3,
					executionDeliveryFence: 3,
				},
			});
			// The resumed claim first confirms what the failed attempt committed.
			expect(acknowledged).toEqual(["cursor-3", "cursor-5"]);
			expect(requests).toEqual([undefined, "cursor-3"]);
			expect(h.events.persisted.map((event) => event.runtimeCursor)).toEqual([
				"cursor-1",
				"cursor-2",
				"cursor-3",
				"cursor-4",
				"cursor-5",
			]);
			expect(inner.sideEffectCount()).toBe(1);
		});

		describe("batched delta persistence (#3378)", () => {
			const batchedEvents = (h: ReturnType<typeof setup>) =>
				h.events as BatchedMemoryEvents;

			it("persists consecutive deltas in one batch and keeps Runtime order and the single ACK", async () => {
				const { runtimeHost, acknowledged } = host(async function* () {
					yield runtimeEvent(1, "running");
					for (let sequence = 2; sequence <= 9; sequence++)
						yield text(sequence);
					yield runtimeEvent(10);
				});
				const h = setup({ runtimeHost, batched: true });
				await expect(dispatch(h.useCase)).resolves.toMatchObject({
					outcome: "accepted",
				});
				expect(batchedEvents(h).batches).toEqual([8]);
				expect(h.events.persisted.map((event) => event.runtimeCursor)).toEqual(
					Array.from({ length: 10 }, (_, index) => `cursor-${index + 1}`),
				);
				expect(acknowledged).toEqual(["cursor-10"]);
			});

			it("commits buffered deltas before a tool fact and acknowledges the fact at once", async () => {
				const { runtimeHost, acknowledged } = host(async function* () {
					yield text(1);
					yield text(2);
					yield tool(3, "intent");
					yield runtimeEvent(4);
				});
				const h = setup({ runtimeHost, batched: true });
				await expect(dispatch(h.useCase)).resolves.toMatchObject({
					outcome: "accepted",
				});
				expect(batchedEvents(h).batches).toEqual([2]);
				expect(h.events.persisted.map((event) => event.runtimeCursor)).toEqual([
					"cursor-1",
					"cursor-2",
					"cursor-3",
					"cursor-4",
				]);
				expect(acknowledged).toEqual(["cursor-3", "cursor-4"]);
			});

			it("bounds a batch at 64 deltas and the unacknowledged events below the Host bound", async () => {
				const { runtimeHost, acknowledged } = host(async function* () {
					for (let sequence = 1; sequence <= 70; sequence++)
						yield text(sequence);
				});
				const h = setup({ runtimeHost, batched: true });
				await expect(dispatch(h.useCase)).resolves.toMatchObject({
					outcome: "retry",
				});
				expect(batchedEvents(h).batches).toEqual([64, 6]);
				expect(h.events.persisted).toHaveLength(70);
				expect(acknowledged).toEqual(["cursor-64", "cursor-70"]);
			});

			it("commits buffered deltas after 50 ms without a new event", async () => {
				let release: () => void = () => undefined;
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				const { runtimeHost } = host(async function* () {
					yield runtimeEvent(1, "running");
					yield text(2);
					await gate;
					yield runtimeEvent(3);
				});
				const h = setup({ runtimeHost, batched: true });
				const result = dispatch(h.useCase);
				await vi.waitFor(
					() =>
						expect(h.events.persisted.at(-1)?.runtimeCursor).toBe("cursor-2"),
					{ timeout: 1_000, interval: 10 },
				);
				release();
				await expect(result).resolves.toMatchObject({ outcome: "accepted" });
				expect(batchedEvents(h).batches).toEqual([1]);
			});

			it("returns stale when a batched delta is stale", async () => {
				const { runtimeHost, acknowledged } = host(async function* () {
					yield text(1);
					yield text(2);
				});
				const h = setup({ runtimeHost, batched: true });
				h.events.stale = true;
				await expect(dispatch(h.useCase)).resolves.toEqual({
					schemaVersion: 1,
					outcome: "stale",
				});
				expect(acknowledged).toEqual([]);
			});

			it("never acknowledges past a failed batch and resumes from the committed cursor", async () => {
				const stream = [
					runtimeEvent(1, "running"),
					text(2),
					text(3),
					runtimeEvent(4),
				];
				const requests: (string | undefined)[] = [];
				const { inner, runtimeHost, acknowledged } = host(
					async function* (request) {
						requests.push(request.afterCursor);
						const index = request.afterCursor
							? stream.findIndex(
									(event) => event.cursor === request.afterCursor,
								) + 1
							: 0;
						yield* stream.slice(index);
					},
				);
				const h = setup({ runtimeHost, batched: true });
				batchedEvents(h).failNextBatch = true;
				await expect(dispatch(h.useCase)).resolves.toMatchObject({
					outcome: "retry",
				});
				expect(acknowledged).toEqual([]);
				expect(h.store.current.runtimeCursor).toBe("cursor-1");
				await expect(dispatch(h.useCase)).resolves.toMatchObject({
					outcome: "accepted",
				});
				expect(requests).toEqual([undefined, "cursor-1"]);
				expect(acknowledged).toEqual(["cursor-1", "cursor-4"]);
				expect(h.events.persisted.map((event) => event.runtimeCursor)).toEqual([
					"cursor-1",
					"cursor-2",
					"cursor-3",
					"cursor-4",
				]);
				expect(inner.sideEffectCount()).toBe(1);
			});

			it("reports a failed batch before a non-retryable stream failure", async () => {
				const { runtimeHost } = host(async function* () {
					yield runtimeEvent(1, "running");
					yield text(2);
					throw new ConversationRuntimeHostError(
						"RUNTIME_PROTOCOL_INVALID",
						false,
					);
				});
				const h = setup({ runtimeHost, batched: true });
				batchedEvents(h).failNextBatch = true;
				// 增量没有提交，持久化失败可重试；不能按流错误拒绝这次执行。
				await expect(dispatch(h.useCase)).resolves.toMatchObject({
					outcome: "retry",
				});
				expect(h.store.current.runtimeCursor).toBe("cursor-1");
			});

			it("commits buffered deltas before the Host's next read and never while a read is in flight (#3443)", async () => {
				let reading = false;
				const committedDuringRead: number[] = [];
				const cursorsAtRead: (string | null | undefined)[] = [];
				let h: ReturnType<typeof setup> | undefined;
				const { runtimeHost, acknowledged } = host(
					async function* (_request, hooks) {
						await hooks?.beforeRead?.();
						cursorsAtRead.push(h?.store.current.runtimeCursor);
						yield runtimeEvent(1, "running");
						yield text(2);
						yield text(3);
						await hooks?.beforeRead?.();
						cursorsAtRead.push(h?.store.current.runtimeCursor);
						// 读取进行中超过 50 ms，期间不能有提交改变读取发送前复核的 fenced state。
						reading = true;
						await new Promise((resolve) => setTimeout(resolve, 150));
						reading = false;
						yield text(4);
						yield runtimeEvent(5);
					},
				);
				h = setup({ runtimeHost, batched: true });
				const events = batchedEvents(h);
				const persistBatch = events.persistBatch.bind(events);
				events.persistBatch = async (commands) => {
					if (reading) committedDuringRead.push(commands.length);
					return persistBatch(commands);
				};
				await expect(dispatch(h.useCase)).resolves.toMatchObject({
					outcome: "accepted",
				});
				expect(committedDuringRead).toEqual([]);
				expect(events.batches).toEqual([2, 1]);
				expect(cursorsAtRead).toEqual([null, "cursor-3"]);
				expect(h.events.persisted.map((event) => event.runtimeCursor)).toEqual([
					"cursor-1",
					"cursor-2",
					"cursor-3",
					"cursor-4",
					"cursor-5",
				]);
				expect(acknowledged).toEqual(["cursor-5"]);
			});

			it("reports stale when the commit before a read loses the lease (#3443)", async () => {
				const { runtimeHost } = host(async function* (_request, hooks) {
					await hooks?.beforeRead?.();
					yield text(1);
					await hooks?.beforeRead?.();
					yield text(2);
				});
				const h = setup({ runtimeHost, batched: true });
				const events = batchedEvents(h);
				const persistBatch = events.persistBatch.bind(events);
				events.persistBatch = async (commands) => {
					events.stale = true;
					return persistBatch(commands);
				};
				await expect(dispatch(h.useCase)).resolves.toEqual({
					schemaVersion: 1,
					outcome: "stale",
				});
			});

			it("commits deltas read before a stream failure", async () => {
				const { runtimeHost, acknowledged } = host(async function* () {
					yield runtimeEvent(1, "running");
					yield text(2);
					yield text(3);
					throw new ConversationRuntimeHostError("RUNTIME_UNAVAILABLE", true);
				});
				const h = setup({ runtimeHost, batched: true });
				await expect(dispatch(h.useCase)).resolves.toMatchObject({
					outcome: "retry",
				});
				expect(h.store.current.runtimeCursor).toBe("cursor-3");
				expect(acknowledged).not.toContain("cursor-3");
			});
		});
	});

	it.each([
		["running", "processing", false, false],
		["pending stop", "processing", true, false],
		["unknown pending stop", "unknown", true, false],
		["pending stop after lease loss", "unknown", true, true],
	] as const)(
		"keeps a re-claimed %s drain leased without renewing stopped business authority",
		async (_name, executionStatus, stopPending, loseLease) => {
			vi.useFakeTimers();
			const store = new MemoryDispatchStore(
				claim({
					executionStatus,
					stopPending,
					hostSessionRef: "host-session-conversation-1",
				}),
			);
			const renewLease = vi.spyOn(store, "renew");
			const submit = vi.fn();
			const acknowledge = vi.fn(async () => {});
			const renewAuthorization = vi.fn(async () => {
				if (stopPending)
					throw new ConversationRuntimeHostError("AUTHORIZATION_REVOKED", true);
			});
			let reading = false;
			const runtimeHost: ConversationRuntimeHostPortV1 = {
				dispatch: submit,
				recoverStatus: vi.fn(),
				async recoverOriginalStatus() {
					return {
						schemaVersion: 2,
						hostSessionRef: "host-session-conversation-1",
						executionId: "execution-1",
						outcome: "found",
						status: "running",
					};
				},
				renewAuthorization,
				async *events(_request, signal) {
					reading = true;
					await new Promise((resolve) => setTimeout(resolve, 250));
					signal?.throwIfAborted();
					yield runtimeEvent(1);
				},
				acknowledge,
			};
			const events = new MemoryEvents(store);
			const useCase = createConversationDispatchUseCaseV1(
				{ store, authorization: authorization(), runtimeHost, events },
				{ leaseDurationMs: 300, retryDelayMs: 0 },
			);
			try {
				const draining = dispatch(useCase);
				await vi.advanceTimersByTimeAsync(0);
				expect(reading).toBe(true);
				if (loseLease) {
					store.current = { ...store.current, leaseOwner: "another-worker" };
					store.renewable = false;
				}
				await vi.advanceTimersByTimeAsync(250);
				expect(await draining).toMatchObject({
					outcome: loseLease ? "stale" : "accepted",
				});
				expect(submit).not.toHaveBeenCalled();
				expect(renewAuthorization).toHaveBeenCalledTimes(stopPending ? 0 : 3);
				expect(renewLease).toHaveBeenCalledTimes(loseLease ? 2 : 3);
				expect(events.persisted).toHaveLength(loseLease ? 0 : 1);
				expect(acknowledge).toHaveBeenCalledTimes(loseLease ? 0 : 1);
				expect(store.current.executionStatus).toBe(
					loseLease ? "processing" : "completed",
				);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	describe("finished Turn drain after a refused renewal (#1554)", () => {
		const hostSessionRef = "host-session-conversation-1";
		const text = (sequence: number): ConversationRuntimeEventV1 => ({
			schemaVersion: 1,
			adapterEventKey: `event-${sequence}`,
			executionId: "execution-1",
			cursor: `cursor-${sequence}`,
			occurredAt: "2026-09-06T00:00:01.000Z",
			type: "text",
			payload: { delta: `part ${sequence}` },
		});
		const status = (value: string) => ({
			schemaVersion: 2 as const,
			hostSessionRef,
			executionId: "execution-1",
			outcome: "found" as const,
			status: value,
		});
		const refused = () =>
			new ConversationRuntimeHostError("RUNTIME_GRANT_INVALID", false);
		function harness(options: {
			readonly renew: (call: number) => void;
			readonly recover?: () => Promise<unknown>;
			readonly fail?: (sequence: number) => boolean;
		}) {
			const inner = new FakeConversationRuntimeHostV1();
			const acknowledged: string[] = [];
			const recovered: unknown[] = [];
			const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
			let renewals = 0;
			const runtimeHost: ConversationRuntimeHostPortV1 = {
				dispatch: (request) => inner.dispatch(request),
				recoverStatus: (request) => inner.recoverStatus(request),
				async recoverOriginalStatus(request) {
					recovered.push(request);
					// Malformed or unexpected shapes are part of what is tested.
					return (await (
						options.recover ?? (async () => status("completed"))
					)()) as never;
				},
				async renewAuthorization() {
					renewals++;
					options.renew(renewals);
				},
				async *events(_, signal) {
					yield runtimeEvent(1, "running");
					// The Runtime has finished; its journal drains over several
					// renewal periods.
					for (let sequence = 2; sequence <= 9; sequence++) {
						await tick();
						signal?.throwIfAborted();
						if (options.fail?.(sequence)) throw refused();
						yield text(sequence);
					}
					yield runtimeEvent(10);
				},
				async acknowledge(request) {
					acknowledged.push(request.confirmedCursor);
				},
			};
			const store = new MemoryDispatchStore();
			const events = new MemoryEvents(store);
			const useCase = createConversationDispatchUseCaseV1(
				{ store, authorization: authorization(), runtimeHost, events },
				// One heartbeat every 10 ms.
				{ leaseDurationMs: 30, retryDelayMs: 0 },
			);
			return {
				store,
				events,
				useCase,
				acknowledged,
				recovered,
				renewals: () => renewals,
			};
		}

		it("drains every event in the same claim once the Host confirms the finish", async () => {
			const h = harness({
				renew(call) {
					if (call > 1) throw refused();
				},
			});
			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "accepted",
			});
			expect(h.store.outboxStatus).toBe("succeeded");
			expect(h.store.errorCode).toBeUndefined();
			expect(h.store.current.executionStatus).toBe("completed");
			expect(h.events.persisted.map((event) => event.runtimeCursor)).toEqual(
				Array.from({ length: 10 }, (_, index) => `cursor-${index + 1}`),
			);
			expect(h.recovered).toEqual([
				expect.objectContaining({
					schemaVersion: 2,
					executionId: "execution-1",
					deliveryFence: h.store.current.executionDeliveryFence,
					hostSessionRef,
				}),
			]);
			// The confirmed status, not later events, owns the terminal state.
			expect(
				h.events.persisted
					.filter((event) => event.transition !== undefined)
					.map((event) => event.runtimeCursor),
			).toEqual(["cursor-1", "cursor-10"]);
			expect(h.acknowledged.at(-1)).toBe("cursor-10");
			// No business renewal is attempted after the refusal.
			const renewals = h.renewals();
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(h.renewals()).toBe(renewals);
		});

		it.each([
			["a running Turn", async () => status("running")],
			["an unknown Turn", async () => status("unknown")],
			[
				"no accepted Turn",
				async () => ({
					schemaVersion: 2,
					hostSessionRef,
					executionId: "execution-1",
					outcome: "not_found",
				}),
			],
			[
				"an unavailable status",
				async () => {
					throw new ConversationRuntimeHostError("RUNTIME_UNAVAILABLE", true);
				},
			],
		])(
			"keeps the recovery path when the refusal concerns %s",
			async (_, recover) => {
				const h = harness({
					renew(call) {
						if (call > 1) throw refused();
					},
					recover,
				});
				await expect(dispatch(h.useCase)).resolves.toMatchObject({
					outcome: "retry",
				});
				expect(h.store.outboxStatus).toBe("retry_scheduled");
				expect(h.store.errorCode).toBe("RUNTIME_HEARTBEAT_INTERRUPTED");
				expect(h.store.current.executionStatus).toBe("processing");
				expect(h.recovered).toHaveLength(1);
			},
		);

		it("never resolves a Worker-side revocation or stop through the Host status", async () => {
			const h = harness({
				renew(call) {
					if (call > 1)
						throw new ConversationRuntimeHostError(
							"AUTHORIZATION_REVOKED",
							true,
						);
				},
			});
			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "retry",
			});
			expect(h.store.errorCode).toBe("RUNTIME_HEARTBEAT_INTERRUPTED");
			expect(h.store.current.executionStatus).toBe("processing");
			expect(h.recovered).toHaveLength(0);
		});

		it("does not fail a Turn whose business read is refused before the finish is confirmed", async () => {
			let refusedRenewal = false;
			const h = harness({
				renew(call) {
					if (call > 1) {
						refusedRenewal = true;
						throw refused();
					}
				},
				fail: () => refusedRenewal,
			});
			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "retry",
			});
			expect(h.store.outboxStatus).toBe("retry_scheduled");
			expect(h.store.errorCode).toBe("RUNTIME_HEARTBEAT_INTERRUPTED");
			expect(h.store.current.executionStatus).toBe("processing");
		});
	});

	describe("drain after the business authority lapsed (#1888)", () => {
		const expired = () =>
			new ConversationRuntimeHostError("RUNTIME_GRANT_INVALID", false);
		function harness(renew: () => void) {
			const inner = new FakeConversationRuntimeHostV1();
			const calls: string[] = [];
			let reads = 0;
			// The Host's business authority lapses while the first drain is
			// interrupted for longer than its 30 s lease.
			let lapsed = false;
			const runtimeHost: ConversationRuntimeHostPortV1 = {
				dispatch: (request) => inner.dispatch(request),
				recoverStatus: (request) => inner.recoverStatus(request),
				async recoverOriginalStatus() {
					calls.push("recover");
					return {
						schemaVersion: 2,
						hostSessionRef: "host-session-conversation-1",
						executionId: "execution-1",
						outcome: "found",
						status: "running",
					};
				},
				async renewAuthorization() {
					calls.push("renew");
					renew();
					lapsed = false;
				},
				async *events() {
					calls.push("events");
					reads++;
					if (reads === 1) {
						lapsed = true;
						throw new ConversationRuntimeHostError(
							"RUNTIME_WORKLOAD_UNAVAILABLE",
							true,
						);
					}
					if (lapsed) throw expired();
					yield runtimeEvent(1, "running");
					yield runtimeEvent(2);
				},
				async acknowledge(request) {
					calls.push(`ack:${request.confirmedCursor}`);
					if (lapsed) throw expired();
				},
			};
			const store = new MemoryDispatchStore();
			const events = new MemoryEvents(store);
			const useCase = createConversationDispatchUseCaseV1(
				{ store, authorization: authorization(), runtimeHost, events },
				{ retryDelayMs: 0 },
			);
			return { store, events, useCase, calls };
		}

		async function interruptedFirstDrain(h: ReturnType<typeof harness>) {
			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "retry",
			});
			// The fresh submit has just established its authority; the failed
			// read leaves the Turn's outcome unknown until it is re-claimed.
			expect(h.calls).toEqual(["events"]);
			expect(h.store.current.executionStatus).toBe("unknown");
		}

		it("renews the running Turn's authority before the re-claimed drain's first event request", async () => {
			const h = harness(() => {});
			await interruptedFirstDrain(h);
			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "accepted",
			});
			// The re-claim first recovers the unknown outcome, then renews before reading.
			expect(h.calls.slice(1, 4)).toEqual(["recover", "renew", "events"]);
			expect(h.store.outboxStatus).toBe("succeeded");
			expect(h.store.current.executionStatus).toBe("completed");
			expect(h.events.persisted.map((event) => event.runtimeCursor)).toEqual([
				"cursor-1",
				"cursor-2",
			]);
		});

		it("re-claims instead of failing when that renewal cannot be sent", async () => {
			const h = harness(() => {
				throw new ConversationRuntimeHostError("RUNTIME_ROUTE_STALE", true);
			});
			await interruptedFirstDrain(h);
			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "retry",
			});
			expect(h.calls).toEqual(["events", "recover", "renew"]);
			expect(h.store.outboxStatus).toBe("retry_scheduled");
			expect(h.store.errorCode).toBe("RUNTIME_HEARTBEAT_INTERRUPTED");
			// The re-claim recovered the running Turn; it is not failed.
			expect(h.store.current.executionStatus).toBe("processing");
		});

		it("re-claims instead of failing when the renewal is refused but the finish is unproven", async () => {
			const h = harness(() => {
				throw expired();
			});
			await interruptedFirstDrain(h);
			await expect(dispatch(h.useCase)).resolves.toMatchObject({
				outcome: "retry",
			});
			expect(h.calls).toEqual(["events", "recover", "renew", "recover"]);
			expect(h.store.errorCode).toBe("RUNTIME_HEARTBEAT_INTERRUPTED");
			expect(h.store.current.executionStatus).toBe("processing");
			expect(h.events.persisted).toEqual([]);
		});
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
		// A finished Turn still journals its terminal event (HLD §8.2).
		inner.setEvents([runtimeEvent(1)]);
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

	it.each([
		[
			{ outcome: "busy" as const },
			{ schemaVersion: 1, outcome: "rejected" },
			"RUNTIME_BUSY",
			"failed",
			{ executionStatus: "failed", conversationStatus: "ready" },
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
			undefined,
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
			{ executionStatus: "failed", conversationStatus: "ready" },
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
			{ executionStatus: "failed", conversationStatus: "ready" },
		],
		[
			{
				outcome: "rejected" as const,
				code: "RUNTIME_SESSION_BLOCKED" as const,
				message: "Runtime session is blocked by an unconfirmed turn" as const,
				retryable: false as const,
			},
			{ schemaVersion: 1, outcome: "rejected" },
			"RUNTIME_SESSION_BLOCKED",
			"failed",
			// ADR-0029：本次执行失败，同一事务把会话标记为不可用。
			{ executionStatus: "failed", conversationStatus: "unavailable" },
		],
		[
			{
				outcome: "rejected" as const,
				code: "RUNTIME_FILE_INPUT_REJECTED" as const,
				message: "Runtime file input was rejected" as const,
				retryable: false as const,
			},
			{ schemaVersion: 1, outcome: "rejected" },
			"RUNTIME_FILE_INPUT_REJECTED",
			"failed",
			// #3314：附件在原生副作用前被平台明确拒绝：本次执行失败，会话保持可用。
			{ executionStatus: "failed", conversationStatus: "ready" },
		],
	] as const)(
		"maps Runtime result %# to one durable product state",
		async (result, expected, code, status, transition) => {
			const runtimeHost = new FakeConversationRuntimeHostV1();
			runtimeHost.setResult(result);
			const { useCase, store } = setup({ runtimeHost });
			const finish = vi.spyOn(store, "finish");

			await expect(dispatch(useCase)).resolves.toEqual(expected);
			expect(store.errorCode).toBe(code);
			expect(store.outboxStatus).toBe(status);
			expect(runtimeHost.sideEffectCount()).toBe(1);
			if (transition === undefined) expect(finish).not.toHaveBeenCalled();
			else
				expect(finish).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({
						status: "failed",
						errorCode: code,
						transition,
					}),
				);
		},
	);

	const sessionBlocked = {
		outcome: "rejected",
		code: "RUNTIME_SESSION_BLOCKED",
		message: "Runtime session is blocked by an unconfirmed turn",
		retryable: false,
	} as const;

	// #3314 AC-2：Host 无法确认附件读取是否被拒绝（交换超时、断连、5xx，或拒绝未经 Driver
	// 声明）时返回可重试错误；执行保持 unknown 并重试，不推断为失败。
	it.each([
		"RUNTIME_DRIVER_INVALID",
		"RUNTIME_UNAVAILABLE",
		"RUNTIME_INTERRUPTED",
	])(
		"keeps the Turn unknown and retries when the Host reports %s (#3314)",
		async (code) => {
			const runtimeHost = new FakeConversationRuntimeHostV1();
			runtimeHost.failNext(code, true);
			const { useCase, store } = setup({ runtimeHost });
			const finish = vi.spyOn(store, "finish");

			await expect(dispatch(useCase)).resolves.toEqual({
				schemaVersion: 1,
				outcome: "retry",
				retryScheduled: true,
			});
			expect(store.current.executionStatus).toBe("unknown");
			expect(store.errorCode).toBe(code);
			expect(store.outboxStatus).toBe("retry_scheduled");
			expect(finish).not.toHaveBeenCalled();
		},
	);

	it("fails a blocked regenerate and marks only its Conversation unavailable", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.setResult(sessionBlocked);
		const store = new MemoryDispatchStore(
			claim({ operation: "conversation.turn.regenerate.v1" }),
		);
		const { useCase } = setup({ store, runtimeHost });
		const finish = vi.spyOn(store, "finish");
		const isolation = vi.fn();
		Object.assign(store, { beginGenerationIsolation: isolation });

		await expect(dispatch(useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "rejected",
		});
		expect(finish).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				status: "failed",
				errorCode: "RUNTIME_SESSION_BLOCKED",
				transition: {
					executionStatus: "failed",
					conversationStatus: "unavailable",
				},
			}),
		);
		expect(store.current.executionStatus).toBe("failed");
		expect(isolation).not.toHaveBeenCalled();
		expect(runtimeHost.sideEffectCount()).toBe(1);
	});

	it.each([
		[
			"native-capability.invoke",
			nativeParametersClaim("summary", "skill"),
			"conversation:native-capability:execution-1",
		],
		[
			"supplement",
			claim({
				operation: "conversation.turn.supplement.v1",
				messageId: "message-supplement",
				executionStatus: "processing",
				hostSessionRef: "host-session-conversation-1",
			}),
			"conversation:turn:execution-1",
		],
		[
			"stop",
			claim({
				operation: "conversation.turn.stop.v1",
				messageId: null,
				input: null,
				stopRequestId: "stop-request-1",
				executionStatus: "processing",
				hostSessionRef: "host-session-conversation-1",
			}),
			"conversation:turn:execution-1",
		],
	] as const)(
		"fails closed on a V1 %s response carrying the blocked code without marking the Conversation unavailable",
		async (_label, seed, itemId) => {
			const runtimeHost = new FakeConversationRuntimeHostV1();
			runtimeHost.setResult(sessionBlocked);
			const store = new MemoryDispatchStore(seed);
			const { useCase } = setup({ store, runtimeHost });
			const finish = vi.spyOn(store, "finish");
			const retry = vi.spyOn(store, "retry");

			await expect(dispatch(useCase, itemId)).resolves.toMatchObject({
				outcome: "retry",
			});
			expect(finish).not.toHaveBeenCalled();
			expect(store.errorCode).toBe("RUNTIME_UNAVAILABLE");
			expect(
				retry.mock.calls.some(
					([input]) => input.transition.conversationStatus === "unavailable",
				),
			).toBe(false);
		},
	);

	it.each([
		[{ outcome: "accepted", status: "running" }, true],
		[{ outcome: "busy" }, false],
		[
			{
				outcome: "unknown",
				code: "RUNTIME_ACCEPTANCE_UNKNOWN",
				message: "Runtime command acceptance could not be confirmed",
			},
			false,
		],
	] as const)(
		"records original acceptance only from an accepted Turn response %j",
		async (result, accepted) => {
			const runtimeHost = new FakeConversationRuntimeHostV1();
			runtimeHost.setResult(result);
			const { useCase, store } = setup({ runtimeHost });
			const responses = vi.spyOn(store, "recordRuntimeResponse");
			await dispatch(useCase);
			expect(responses).toHaveBeenCalled();
			expect(
				responses.mock.calls.some(
					([input]) =>
						"originalOperationAccepted" in input &&
						input.originalOperationAccepted === true,
				),
			).toBe(accepted);
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

	// #3375：补充指令无法进入原回复时转入排队（工程 Spec §12.5）。
	class QueueingDispatchStore extends MemoryDispatchStore {
		queued: ConversationDispatchClaimV1[] = [];
		async queueSupplement(input: {
			readonly claim: ConversationDispatchClaimV1;
		}) {
			this.queued.push(input.claim);
			this.outboxStatus = "succeeded";
			return true;
		}
	}
	it.each([
		[
			"Runtime explicitly rejects the steer",
			{ executionStatus: "processing" as const },
			true,
		],
		[
			"the original reply already finished",
			{ executionStatus: "completed" as const },
			false,
		],
		[
			"the original reply has a pending stop",
			{ executionStatus: "processing" as const, stopPending: true },
			false,
		],
		[
			"the original reply became unknown",
			{ executionStatus: "unknown" as const },
			false,
		],
	])(
		"queues a supplement when %s (#3375)",
		async (_name, state, reachesRuntime) => {
			const runtimeHost = new FakeConversationRuntimeHostV1();
			runtimeHost.setResult({
				outcome: "rejected",
				code: "RUNTIME_TURN_NOT_ACTIVE",
				message: "Runtime turn is no longer active",
				retryable: false,
			});
			const store = new QueueingDispatchStore(
				claim({
					operation: "conversation.turn.supplement.v1",
					messageId: "message-supplement",
					hostSessionRef: "host-session-conversation-1",
					...state,
				}),
			);
			const sent = vi.spyOn(runtimeHost, "dispatch");
			const { useCase } = setup({ store, runtimeHost });

			await expect(dispatch(useCase)).resolves.toMatchObject({
				outcome: "rejected",
			});
			expect(store.queued).toHaveLength(1);
			expect(store.queued[0]).toMatchObject({
				messageId: "message-supplement",
			});
			// 不再按“原回复已结束”终结这条补充指令。
			expect(store.errorCode).toBeUndefined();
			expect(sent.mock.calls.length > 0).toBe(reachesRuntime);
		},
	);

	it("keeps an unclear supplement result unknown instead of queueing it (#3375)", async () => {
		const runtimeHost = new FakeConversationRuntimeHostV1();
		runtimeHost.setResult({
			outcome: "unknown",
			code: "RUNTIME_ACCEPTANCE_UNKNOWN",
			message: "Runtime command acceptance could not be confirmed",
		});
		const store = new QueueingDispatchStore(
			claim({
				operation: "conversation.turn.supplement.v1",
				messageId: "message-supplement",
				executionStatus: "processing",
				hostSessionRef: "host-session-conversation-1",
			}),
		);
		const { useCase } = setup({ store, runtimeHost });

		await dispatch(useCase);
		expect(store.queued).toEqual([]);
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

	describe.each([false, true])(
		"Platform reserved events with original recovery=%s",
		(recoveringOriginal) => {
			describe.each([1, 2])("Runtime event schema %s", (schemaVersion) => {
				it.each([
					{
						label: "waiting task",
						type: "task.status",
						payload: { status: "waiting" },
					},
					{
						label: "completed task",
						type: "task.status",
						payload: { status: "completed" },
					},
					{
						label: "unconfirmed stop",
						type: "task.status",
						payload: {
							status: "unknown",
							reason: "STOP_CONFIRMATION_TIMEOUT",
						},
					},
					{
						label: "model selection fallback",
						type: "model.selection.fell_back",
						payload: {
							modelOptionId: "model-option-2",
							reasoningLevel: "low",
							reason: "selection_unavailable",
						},
					},
				])(
					"rejects Runtime-forged $label before commit and ACK",
					async (forged) => {
						const hostSessionRef = "host-session-conversation-1";
						const store = new MemoryDispatchStore(
							claim(
								recoveringOriginal
									? {
											executionStatus: "unknown",
											stopPending: true,
											hostSessionRef,
											runtimeCursor: "cursor-1",
										}
									: {},
							),
						);
						const retry = vi.spyOn(store, "retry");
						const inner = new FakeConversationRuntimeHostV1();
						const acknowledged: string[] = [];
						const eventCursors: Array<string | undefined> = [];
						let dispatchCalls = 0;
						let recoveryCalls = 0;
						let forgedDeliveries = 0;
						let trailingReads = 0;
						const runtimeHost: ConversationRuntimeHostPortV1 = {
							async dispatch(request) {
								dispatchCalls++;
								if (recoveringOriginal) throw new Error("Unexpected resubmit");
								return inner.dispatch(request);
							},
							async recoverStatus() {
								throw new Error("Unexpected legacy recovery");
							},
							async recoverOriginalStatus(request) {
								recoveryCalls++;
								expect(request).toMatchObject({
									hostSessionRef,
									executionId: "execution-1",
									turnId: "turn-1",
									sessionGeneration: 1,
									deliveryFence: store.current.executionDeliveryFence,
								});
								return {
									schemaVersion: 2,
									hostSessionRef,
									executionId: request.executionId,
									outcome: "found",
									status: "running",
								};
							},
							async *events(request) {
								eventCursors.push(request.afterCursor);
								if (!recoveringOriginal) yield runtimeEvent(1, "running");
								forgedDeliveries++;
								yield {
									...runtimeEvent(2),
									schemaVersion,
									type: forged.type,
									payload: forged.payload,
								} as never;
								trailingReads++;
								yield runtimeEvent(3);
							},
							async acknowledge(request) {
								acknowledged.push(request.confirmedCursor);
							},
						};
						const h = setup({ store, runtimeHost });
						const deliveries = recoveringOriginal ? 2 : 1;
						for (let delivery = 0; delivery < deliveries; delivery++) {
							await expect(dispatch(h.useCase)).resolves.toMatchObject({
								outcome: "retry",
								retryScheduled: true,
							});
							expect(store.current).toMatchObject({
								executionId: "execution-1",
								turnId: "turn-1",
								sessionGeneration: 1,
								hostSessionRef,
								runtimeCursor: "cursor-1",
								executionStatus: "unknown",
								stopPending: recoveringOriginal,
							});
							expect(store.current.runtimeTerminalEventSeen).toBeUndefined();
							expect(store.outboxStatus).toBe("retry_scheduled");
							expect(retry).toHaveBeenLastCalledWith(
								expect.objectContaining({
									transition: {
										executionStatus: "unknown",
										conversationStatus: "active",
									},
								}),
							);
						}
						expect(
							h.events.persisted.map((event) => event.runtimeCursor),
						).toEqual(recoveringOriginal ? [] : ["cursor-1"]);
						// Only the resumed claim re-acknowledges its committed cursor; a
						// batched ACK is never sent for an attempt that hit the forgery.
						expect(acknowledged).toEqual(
							recoveringOriginal ? Array(deliveries).fill("cursor-1") : [],
						);
						expect(eventCursors).toEqual(
							Array(deliveries).fill(
								recoveringOriginal ? "cursor-1" : undefined,
							),
						);
						expect({
							dispatchCalls,
							recoveryCalls,
							forgedDeliveries,
							trailingReads,
						}).toEqual({
							dispatchCalls: recoveringOriginal ? 0 : 1,
							recoveryCalls: recoveringOriginal ? 2 : 0,
							forgedDeliveries: deliveries,
							trailingReads: 0,
						});
					},
				);
			});
		},
	);

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
		runtimeHost.setEvents([{ ...runtimeEvent(1), executionId: "execution-2" }]);
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

describe("claim traceparent (#2473)", () => {
	const traceParent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

	it("keeps a valid traceparent and does not invent one", () => {
		expect(parseClaim(claim({ traceParent })).traceParent).toBe(traceParent);
		expect(parseClaim(claim())).not.toHaveProperty("traceParent");
	});

	it.each([
		["not a string", 7],
		["null", null],
		["empty", ""],
		["too short", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331"],
		["wrong version", `01${traceParent.slice(2)}`],
		["zero trace id", `00-${"0".repeat(32)}-b7ad6b7169203331-01`],
		[
			"zero span id",
			`00-0af7651916cd43dd8448eb211c80319c-${"0".repeat(16)}-01`,
		],
	])("rejects a malformed traceparent (%s)", (_name, value) => {
		expect(() => parseClaim({ ...claim(), traceParent: value })).toThrow(
			expect.objectContaining({ code: "unavailable" }),
		);
	});

	it("still rejects unknown claim keys", () => {
		expect(() =>
			parseClaim({ ...claim({ traceParent }), unexpected: 1 }),
		).toThrow();
	});
});

// #3227：企微只带附件的消息正文为空；正文与附件至少有一项。
describe("attachment-only claim input (#3227)", () => {
	it("admits an empty body only together with attachments", () => {
		expect(
			parseClaim(claim({ input: { text: "", attachments: ["file-1"] } })).input,
		).toEqual({ text: "", attachments: ["file-1"] });
		expect(() =>
			parseClaim(claim({ input: { text: "", attachments: [] } })),
		).toThrow(expect.objectContaining({ code: "unavailable" }));
	});
});

// #3373：Runtime 已核实本次 Turn 在原生提交点之前未提交。Worker 退回投递前状态，以新的
// 认领（更高 fence、新 Grant）重提同一 Execution；2 分钟内最多 3 次，之后按阶段明确失败。
describe("Runtime-reported unsubmitted Turns (#3373)", () => {
	const notSubmitted = (
		reason: "file_input_unavailable" | "session_preparation_failed",
	) =>
		({
			outcome: "rejected",
			code: "RUNTIME_TURN_NOT_SUBMITTED",
			message: "Runtime turn was not submitted",
			reason,
			retryable: true,
		}) as const;
	function hostReturning(
		results: Record<string, unknown>[],
		schemaVersion: 1 | 2 = 2,
	) {
		const dispatchRuntime = vi.fn(
			async (request: ConversationRuntimeDispatchRequestV1) => ({
				schemaVersion,
				hostSessionRef: "host-session-1",
				operationId: request.executionId,
				result: results.shift() ?? { outcome: "accepted", status: "running" },
			}),
		);
		const runtimeHost = {
			dispatch: dispatchRuntime,
			recoverOriginalStatus: vi.fn(),
			recoverStatus: vi.fn(),
			async *events() {},
		} as unknown as ConversationRuntimeHostPortV1;
		return { runtimeHost, dispatchRuntime };
	}

	it("accepts only the exact V2 submit result", () => {
		const response = (result: Record<string, unknown>, schemaVersion = 2) => ({
			schemaVersion,
			hostSessionRef: "host-session-1",
			operationId: "execution-1",
			result,
		});
		for (const reason of [
			"file_input_unavailable",
			"session_preparation_failed",
		] as const)
			expect(
				parseRuntimeResponse(response(notSubmitted(reason)), claim()),
			).toMatchObject({ result: notSubmitted(reason) });
		for (const drifted of [
			{ ...notSubmitted("file_input_unavailable"), retryable: false },
			{ ...notSubmitted("file_input_unavailable"), reason: "timeout" },
			{ ...notSubmitted("file_input_unavailable"), message: "not sent" },
			{ ...notSubmitted("file_input_unavailable"), outcome: "unknown" },
			{
				...notSubmitted("file_input_unavailable"),
				code: "RUNTIME_SESSION_BLOCKED",
			},
		])
			expect(() => parseRuntimeResponse(response(drifted), claim())).toThrow();
		// submit V1 与原生能力的结果枚举不能表示未提交。
		expect(() =>
			parseRuntimeResponse(
				response(notSubmitted("file_input_unavailable"), 1),
				claim({
					modelConfigurationRevision: null,
					modelOptionId: null,
					reasoningLevel: null,
				}),
			),
		).toThrow();
	});

	it("returns the Execution to its pre-delivery state and resubmits it under a new claim", async () => {
		const store = new MemoryDispatchStore();
		const { runtimeHost, dispatchRuntime } = hostReturning([
			notSubmitted("file_input_unavailable"),
		]);
		const h = setup({ store, runtimeHost, retryDelayMs: 1_000 });
		const finish = vi.spyOn(store, "finish");

		await expect(dispatch(h.useCase)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "retry",
			retryScheduled: true,
		});
		// 没有进入 unknown：退回投递前的状态，并记录 Host 返回的 Session Ref。
		expect(store.current.executionStatus).toBe("submitted");
		expect(store.current.hostSessionRef).toBe("host-session-1");
		expect(store.errorCode).toBe("RUNTIME_TURN_NOT_SUBMITTED");
		expect(store.releaseDelays).toEqual([1_000]);
		expect(finish).not.toHaveBeenCalled();

		await dispatch(h.useCase);
		expect(dispatchRuntime).toHaveBeenCalledTimes(2);
		const [first, second] = dispatchRuntime.mock.calls.map(
			([request]) => request,
		);
		expect(second?.executionId).toBe(first?.executionId);
		expect(second?.deliveryFence).toBeGreaterThan(first?.deliveryFence ?? 0);
		expect(store.current.executionStatus).not.toBe("submitted");
	});

	it("backs off each resubmission within the window", async () => {
		const store = new MemoryDispatchStore(
			claim({ notSubmittedResubmissions: { count: 2, elapsedMs: 30_000 } }),
		);
		const { runtimeHost } = hostReturning([
			notSubmitted("session_preparation_failed"),
		]);
		const h = setup({ store, runtimeHost, retryDelayMs: 1_000 });

		await expect(dispatch(h.useCase)).resolves.toMatchObject({
			outcome: "retry",
		});
		expect(store.releaseDelays).toEqual([9_000]);
		expect(store.current.notSubmittedResubmissions?.count).toBe(3);
	});

	it("keeps the resubmission backoff within the Store delay bound", async () => {
		// 部署允许的最大重试间隔乘以退避系数后仍须是 Store 接受的延迟，否则退回投递前状态失败。
		const store = new MemoryDispatchStore(
			claim({ notSubmittedResubmissions: { count: 2, elapsedMs: 30_000 } }),
		);
		const { runtimeHost } = hostReturning([
			notSubmitted("file_input_unavailable"),
		]);
		const h = setup({ store, runtimeHost, retryDelayMs: 86_400_000 });

		await expect(dispatch(h.useCase)).resolves.toMatchObject({
			outcome: "retry",
			retryScheduled: true,
		});
		expect(store.releaseDelays).toEqual([86_400_000]);
	});

	it.each([
		[
			"three resubmissions are spent",
			{ count: 3, elapsedMs: 20_000 },
			"session_preparation_failed",
			"RUNTIME_SESSION_PREPARATION_FAILED",
		],
		[
			"the two-minute window has passed",
			{ count: 1, elapsedMs: 120_000 },
			"file_input_unavailable",
			"RUNTIME_FILE_INPUT_UNAVAILABLE",
		],
	] as const)(
		"fails with a classified code once %s",
		async (_name, notSubmittedResubmissions, reason, code) => {
			const store = new MemoryDispatchStore(
				claim({ notSubmittedResubmissions }),
			);
			const { runtimeHost } = hostReturning([notSubmitted(reason)]);
			const h = setup({ store, runtimeHost });
			const finish = vi.spyOn(store, "finish");

			await expect(dispatch(h.useCase)).resolves.toEqual({
				schemaVersion: 1,
				outcome: "rejected",
			});
			expect(store.released).toBe(0);
			expect(store.errorCode).toBe(code);
			expect(store.outboxStatus).toBe("failed");
			expect(store.current.executionStatus).toBe("failed");
			expect(finish).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					status: "failed",
					errorCode: code,
					transition: {
						executionStatus: "failed",
						conversationStatus: "ready",
					},
				}),
			);
		},
	);

	it("keeps an uncertain acceptance unknown instead of resubmitting", async () => {
		const store = new MemoryDispatchStore();
		const { runtimeHost } = hostReturning([
			{
				outcome: "unknown",
				code: "RUNTIME_ACCEPTANCE_UNKNOWN",
				message: "Runtime command acceptance could not be confirmed",
			},
		]);
		const h = setup({ store, runtimeHost });

		await expect(dispatch(h.useCase)).resolves.toMatchObject({
			outcome: "unknown",
		});
		expect(store.released).toBe(0);
		expect(store.errorCode).toBe("RUNTIME_ACCEPTANCE_UNKNOWN");
		expect(store.current.executionStatus).toBe("unknown");
	});

	it("does not resubmit a not-submitted result from a V1 response", async () => {
		const store = new MemoryDispatchStore(
			claim({
				modelConfigurationRevision: null,
				modelOptionId: null,
				reasoningLevel: null,
			}),
		);
		const { runtimeHost } = hostReturning(
			[notSubmitted("file_input_unavailable")],
			1,
		);
		const h = setup({ store, runtimeHost });

		await expect(dispatch(h.useCase)).resolves.toMatchObject({
			outcome: "retry",
		});
		expect(store.released).toBe(0);
		expect(store.current.executionStatus).toBe("unknown");
	});
});
