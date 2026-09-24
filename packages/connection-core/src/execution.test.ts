import { describe, expect, it, vi } from "vitest";

import { executeActionCall } from "./execution.js";
import type {
	ActionCallRecord,
	ActionCallRequest,
	DispatchRecord,
	EffectRecord,
	GrantRecord,
} from "./types.js";

const request: ActionCallRequest = {
	requestId: "request-input-is-not-persisted",
	idempotencyKey: "idem-1",
	principalId: "principal",
	consumerId: "consumer",
	consumerInstanceId: "instance",
	actorId: null,
	grantId: "grant",
	connectionId: "connection",
	actionVersionId: "action@v1",
	arguments: { owner: "agora" },
};

const grant: GrantRecord = {
	id: "grant",
	principalId: "principal",
	consumerId: "consumer",
	consumerInstanceId: "instance",
	actorId: "__consumer_actor__",
	connectionId: "connection",
	credentialVersionId: "credential@1",
	actionVersionIds: ["action@v1"],
	revision: 1,
	status: "active",
	principalRecoveryGeneration: 1,
};

function repository(options: { revoked?: boolean } = {}) {
	let call: ActionCallRecord | undefined;
	let dispatch: DispatchRecord | undefined;
	let effect: EffectRecord | undefined;
	return {
		get state() {
			return { call, dispatch, effect };
		},
		findActiveGrant: vi.fn(async () => (options.revoked ? undefined : grant)),
		findByIdempotency: vi.fn(async () => call),
		insert: vi.fn(async (record: ActionCallRecord) => {
			call = record;
		}),
		transition: vi.fn(
			async (
				_id: string,
				from: ActionCallRecord["status"],
				to: ActionCallRecord["status"],
			) => {
				if (!call || call.status !== from) return false;
				call = { ...call, status: to };
				return true;
			},
		),
		reserveExecution: vi.fn(
			async (input: {
				actionCall: ActionCallRecord;
				dispatch: DispatchRecord;
				effect?: EffectRecord;
			}) => {
				call = input.actionCall;
				dispatch = input.dispatch;
				effect = input.effect;
			},
		),
		claimDispatch: vi.fn(async () => {
			if (dispatch?.status !== "pending") return false;
			dispatch = { ...dispatch, status: "claimed", attemptCount: 1 };
			return true;
		}),
		transitionDispatch: vi.fn(
			async (
				_id: string,
				from: DispatchRecord["status"],
				to: DispatchRecord["status"],
			) => {
				if (!dispatch || dispatch.status !== from) return false;
				dispatch = {
					...dispatch,
					status: to,
					leaseOwner: null,
					leaseExpiresAt: null,
				};
				return true;
			},
		),
		transitionEffect: vi.fn(
			async (
				_id: string,
				from: EffectRecord["status"],
				to: EffectRecord["status"],
				result?: Record<string, unknown> | null,
			) => {
				if (!effect || effect.status !== from) return false;
				effect = {
					...effect,
					status: to,
					result: result === undefined ? effect.result : result,
				};
				return true;
			},
		),
		recordProviderOutcome: vi.fn(
			async (input: {
				actionCallId: string;
				dispatchId: string;
				effectId?: string;
				outcome: {
					kind: "succeeded" | "failed" | "unknown";
					result?: Record<string, unknown> | null;
				};
			}) => {
				if (
					!call ||
					call.id !== input.actionCallId ||
					call.status !== "submission_started"
				)
					return false;
				if (
					!dispatch ||
					dispatch.id !== input.dispatchId ||
					dispatch.status !== "claimed"
				)
					return false;
				if (
					input.effectId &&
					(!effect ||
						effect.id !== input.effectId ||
						effect.status !== "submitted")
				)
					return false;
				call = {
					...call,
					status:
						input.outcome.kind === "succeeded"
							? "provider_succeeded"
							: input.outcome.kind === "failed"
								? "provider_failed"
								: "result_pending",
				};
				dispatch = {
					...dispatch,
					status:
						input.outcome.kind === "succeeded"
							? "completed"
							: input.outcome.kind === "failed"
								? "failed"
								: "unknown",
					leaseOwner: null,
					leaseExpiresAt: null,
				};
				if (effect)
					effect = {
						...effect,
						status:
							input.outcome.kind === "succeeded"
								? "succeeded"
								: input.outcome.kind === "failed"
									? "failed"
									: "unknown",
						result:
							input.outcome.kind === "unknown"
								? effect.result
								: (input.outcome.result ?? null),
					};
				return true;
			},
		),
	};
}

const audit = { insert: vi.fn(async () => {}) };

describe("Connection provider execution", () => {
	it("persists Dispatch and Effect before a write provider call", async () => {
		const store = repository();
		const provider = {
			execute: vi.fn(async () => ({
				kind: "succeeded" as const,
				result: { ok: true },
			})),
		};
		const result = await executeActionCall(store, {
			request,
			principalRecoveryGeneration: 1,
			requestId: "request-1",
			traceId: "trace-1",
			effect: "write",
			provider,
			audit,
		});
		expect(store.reserveExecution).toHaveBeenCalledOnce();
		expect(provider.execute).toHaveBeenCalledOnce();
		expect(store.state.dispatch?.status).toBe("completed");
		expect(store.state.effect?.status).toBe("succeeded");
		expect(store.state.call?.status).toBe("provider_succeeded");
		expect(result.kind).toBe("completed");
	});

	it("marks transport exceptions unknown without retrying the provider", async () => {
		const store = repository();
		const provider = {
			execute: vi.fn(async () => {
				throw new Error("connection reset");
			}),
		};
		const result = await executeActionCall(store, {
			request,
			principalRecoveryGeneration: 1,
			requestId: "request-1",
			traceId: "trace-1",
			effect: "write",
			provider,
			audit,
		});
		expect(provider.execute).toHaveBeenCalledOnce();
		expect(store.state.dispatch?.status).toBe("unknown");
		expect(store.state.effect?.status).toBe("unknown");
		expect(store.state.call?.status).toBe("result_pending");
		expect(result.kind).toBe("completed");
	});

	it("does not call a provider when revocation wins the preflight", async () => {
		const store = repository({ revoked: true });
		const provider = {
			execute: vi.fn(async () => ({
				kind: "succeeded" as const,
				result: null,
			})),
		};
		await expect(
			executeActionCall(store, {
				request,
				principalRecoveryGeneration: 1,
				requestId: "request-1",
				traceId: "trace-1",
				effect: "write",
				provider,
				audit,
			}),
		).rejects.toThrow("Connection authorization denied");
		expect(provider.execute).not.toHaveBeenCalled();
	});

	it("reuses an identical idempotent call", async () => {
		const store = repository();
		const first = await executeActionCall(store, {
			request,
			principalRecoveryGeneration: 1,
			requestId: "request-1",
			traceId: "trace-1",
			effect: "read",
			provider: {
				execute: vi.fn(async () => ({
					kind: "succeeded" as const,
					result: null,
				})),
			},
			audit,
		});
		const provider = {
			execute: vi.fn(async () => ({
				kind: "succeeded" as const,
				result: null,
			})),
		};
		const second = await executeActionCall(store, {
			request,
			principalRecoveryGeneration: 1,
			requestId: "request-2",
			traceId: "trace-2",
			effect: "read",
			provider,
			audit,
		});
		expect(first.kind).toBe("completed");
		expect(second.kind).toBe("reused");
		expect(provider.execute).not.toHaveBeenCalled();
	});
});
