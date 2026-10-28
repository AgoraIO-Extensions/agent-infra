import { beforeEach, expect, it, vi } from "vitest";
import type { EvaluationScoringWorkerOptionsV1 } from "./evaluation-scoring-worker.js";

const fixture = vi.hoisted(() => ({
	model: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
	error: undefined as unknown,
	due: vi.fn(),
	readKey: vi.fn(),
	storeClose: vi.fn(),
	claim: vi.fn(),
	retry: vi.fn(),
	succeeded: vi.fn(),
	outboxClose: vi.fn(),
	transport: vi.fn(),
}));
vi.mock("@agent-infra/model-catalog", () => ({
	scoreEvaluationModelV1: fixture.transport,
}));
vi.mock("@agent-infra/platform-store", () => ({
	createPostgresOutboxStore: () => ({
		claim: fixture.claim,
		scheduleRetry: fixture.retry,
		markSucceeded: fixture.succeeded,
		close: fixture.outboxClose,
	}),
	PostgresEvaluationScoringV1: class {
		constructor(options: { model: (...args: unknown[]) => Promise<unknown> }) {
			fixture.model = options.model;
		}
		due = fixture.due;
		readKey = fixture.readKey;
		close = fixture.storeClose;
	},
}));
vi.mock("@agent-infra/platform-core", async (original) => ({
	...(await original<typeof import("@agent-infra/platform-core")>()),
	createEvaluationScoreWorkV1: () => ({
		execute: async (lease: unknown) => {
			try {
				await fixture.model?.(
					lease,
					{
						scorer: {
							implementation: {
								kind: "model",
								endpointId: "fixture",
								catalogRevision: "fixture",
								modelId: "fixture",
								inputCategories: ["output", "rubric"],
								maxOutputTokens: 10,
							},
							timeoutMs: 300000,
							minimum: 0,
							maximum: 1,
							maxInputBytes: 1000,
							maxOutputBytes: 1000,
						},
					},
					{ output: "synthetic", rubric: "synthetic" },
				);
				return { outcome: "completed" };
			} catch (error) {
				fixture.error = error;
				throw error;
			}
		},
	}),
}));

import { EvaluationModelNotSentErrorV1 } from "@agent-infra/platform-core";
import { createEvaluationScoringWorkerV1 } from "./evaluation-scoring-worker.js";

beforeEach(() => {
	fixture.error = undefined;
	fixture.model = undefined;
	fixture.due.mockReset().mockResolvedValue(["first", "second"]);
	fixture.readKey
		.mockReset()
		.mockResolvedValue({ binding: {}, ciphertext: {} });
	fixture.storeClose.mockReset().mockResolvedValue(undefined);
	fixture.claim
		.mockReset()
		.mockResolvedValue({ payload: { intentId: "intent" }, deliveryFence: 1n });
	fixture.retry.mockReset().mockResolvedValue(true);
	fixture.succeeded.mockReset().mockResolvedValue(true);
	fixture.outboxClose.mockReset().mockResolvedValue(undefined);
	fixture.transport.mockReset();
});
function options(plaintext: Uint8Array): EvaluationScoringWorkerOptionsV1 {
	return {
		databaseUrl: "postgres://fixture",
		batchSize: 2,
		leaseMs: 300000,
		retryDelayMs: 1000,
		catalog: { resolve: async () => ({}) },
		decryptor: { decrypt: async () => ({ outcome: "decrypted", plaintext }) },
	} as unknown as EvaluationScoringWorkerOptionsV1;
}
it("serializes runOnce and cancels an in-flight model without claiming the next intent or misclassifying sent work", async () => {
	const started = Promise.withResolvers<void>();
	fixture.transport.mockImplementation(
		async (input: { signal: AbortSignal }) => {
			started.resolve();
			await new Promise((_, reject) =>
				input.signal.addEventListener(
					"abort",
					() => reject(new Error("synthetic transport abort")),
					{ once: true },
				),
			);
		},
	);
	const key = new Uint8Array([1, 2, 3]);
	const worker = createEvaluationScoringWorkerV1(options(key));
	const run = worker.runOnce();
	expect(worker.runOnce()).toBe(run);
	await started.promise;
	const closed = worker.close();
	expect(worker.close()).toBe(closed);
	await closed;
	await run;
	expect(fixture.claim).toHaveBeenCalledOnce();
	expect(fixture.transport).toHaveBeenCalledOnce();
	expect(fixture.error).not.toBeInstanceOf(EvaluationModelNotSentErrorV1);
	expect([...key]).toEqual([0, 0, 0]);
	expect(fixture.retry).toHaveBeenCalledOnce();
	expect(fixture.storeClose).toHaveBeenCalledOnce();
	expect(fixture.outboxClose).toHaveBeenCalledOnce();
	await worker.runOnce();
	expect(fixture.claim).toHaveBeenCalledOnce();
});
it("checks shutdown again after claim and preserves an unstarted intent for another worker", async () => {
	const claimed = Promise.withResolvers<{
		payload: { intentId: string };
		deliveryFence: bigint;
	}>();
	fixture.claim.mockReturnValueOnce(claimed.promise);
	const worker = createEvaluationScoringWorkerV1(options(new Uint8Array([1])));
	const run = worker.runOnce();
	await vi.waitFor(() => expect(fixture.claim).toHaveBeenCalledOnce());
	const closing = worker.close();
	claimed.resolve({ payload: { intentId: "intent" }, deliveryFence: 1n });
	await closing;
	await run;
	expect(fixture.readKey).not.toHaveBeenCalled();
	expect(fixture.transport).not.toHaveBeenCalled();
	expect(fixture.retry).toHaveBeenCalledWith(
		expect.objectContaining({ errorCode: "EVALUATION_SCORE_STOPPING" }),
	);
	expect(fixture.claim).toHaveBeenCalledOnce();
});
