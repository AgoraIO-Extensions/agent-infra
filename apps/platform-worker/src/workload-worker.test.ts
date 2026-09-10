import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fakeKubernetesApi,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";

const store = vi.hoisted(() => ({
	opened: vi.fn(),
	runNext: vi.fn<() => Promise<"idle" | "advanced">>(),
	close: vi.fn<() => Promise<void>>(),
}));
vi.mock("@agent-infra/platform-store", () => ({
	openPostgresWorkloadReconciliationStoreV1: () => {
		store.opened();
		return store;
	},
}));

import {
	createPlatformWorkloadWorkerV1,
	startPlatformWorkloadWorkerFromDeploymentV1,
} from "./workload-worker.js";

function fixture() {
	return {
		databaseUrl: "postgres://fixture",
		workerId: "worker-a",
		client: fakeKubernetesApi().client,
		policy: workloadTestPolicy,
		registry: workloadRegistryFixture(),
		admissionPolicyRef: "policy-a",
		registrySubjectRef: "subject-a",
		decryptor: {
			decrypt: async () => ({
				outcome: "failed" as const,
				code: "SECRET_KEY_UNAVAILABLE" as const,
			}),
		},
		probeRuntime: async () => ({ core: "passed" as const, capabilities: {} }),
		pollIntervalMs: 10,
		log: vi.fn(),
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	store.opened.mockReset();
	store.runNext.mockReset().mockResolvedValue("idle");
	store.close.mockReset().mockResolvedValue();
});
afterEach(() => vi.useRealTimers());

describe("Workload Worker lifecycle", () => {
	it.each(["", "worker\0a"])(
		"rejects invalid Worker identity before opening the Store: %j",
		(workerId) => {
			const options = { ...fixture(), workerId };
			expect(() => createPlatformWorkloadWorkerV1(options)).toThrow(
				"Invalid Worker identity",
			);
			expect(store.opened).not.toHaveBeenCalled();
			expect(options.log).not.toHaveBeenCalled();
		},
	);
	it.each([false, true])(
		"does not start polling after termination during deployment assembly (already aborted: %s)",
		async (alreadyAborted) => {
			const controller = new AbortController();
			const entered = Promise.withResolvers<void>();
			const assembled = Promise.withResolvers<ReturnType<typeof fixture>>();
			const factory = vi.fn((signal: AbortSignal) => {
				expect(signal).toBe(controller.signal);
				entered.resolve();
				return assembled.promise;
			});
			vi.stubGlobal("workloadDeploymentTestFactory", factory);
			if (alreadyAborted) controller.abort();
			const starting = startPlatformWorkloadWorkerFromDeploymentV1(
				"data:text/javascript,export const createPlatformWorkloadWorkerOptionsV1 = signal => globalThis.workloadDeploymentTestFactory(signal);",
				controller.signal,
			);
			let worker: Awaited<typeof starting> | undefined;
			try {
				if (alreadyAborted) {
					await expect(starting).rejects.toThrow(
						"Platform Worker deployment dependencies are unavailable",
					);
					expect(factory).not.toHaveBeenCalled();
					expect(store.opened).not.toHaveBeenCalled();
					return;
				}
				await entered.promise;
				controller.abort();
				assembled.resolve(fixture());
				worker = await starting;
				expect(store.runNext).not.toHaveBeenCalled();
				expect(store.close).toHaveBeenCalledOnce();
				worker.start();
				await vi.advanceTimersByTimeAsync(100);
				expect(store.runNext).not.toHaveBeenCalled();
			} finally {
				assembled.resolve(fixture());
				if (worker) await worker.stop();
				else if (!alreadyAborted) await (await starting).stop();
				vi.unstubAllGlobals();
			}
		},
	);
	it("serializes polling, starts once, drains an in-flight step and closes once", async () => {
		const step = Promise.withResolvers<"idle">();
		store.runNext.mockReturnValueOnce(step.promise);
		const worker = createPlatformWorkloadWorkerV1(fixture());
		worker.start();
		worker.start();
		await vi.advanceTimersByTimeAsync(100);
		expect(store.runNext).toHaveBeenCalledOnce();
		const stopped = worker.stop();
		expect(worker.stop()).toBe(stopped);
		expect(store.close).not.toHaveBeenCalled();
		step.resolve("idle");
		await stopped;
		worker.start();
		await vi.advanceTimersByTimeAsync(100);
		expect(store.runNext).toHaveBeenCalledOnce();
		expect(store.close).toHaveBeenCalledOnce();
	});
	it("retries a failed transaction without logging provider details", async () => {
		const options = fixture();
		store.runNext.mockRejectedValueOnce(new Error("private-provider-response"));
		const worker = createPlatformWorkloadWorkerV1(options);
		worker.start();
		await vi.advanceTimersByTimeAsync(10);
		await worker.stop();
		expect(store.runNext).toHaveBeenCalledTimes(2);
		expect(options.log.mock.calls.join()).toContain(
			"WORKLOAD_RECONCILIATION_UNAVAILABLE",
		);
		expect(options.log.mock.calls.join()).not.toContain(
			"private-provider-response",
		);
	});
	it("continues polling and closes the Store when retry logging throws", async () => {
		const options = fixture();
		options.log.mockImplementation((message) => {
			if (message.includes("WORKLOAD_RECONCILIATION_UNAVAILABLE"))
				throw new Error("broken-log-sink");
		});
		store.runNext.mockRejectedValueOnce(new Error("polling-failure"));
		const worker = createPlatformWorkloadWorkerV1(options);
		worker.start();
		await vi.advanceTimersByTimeAsync(10);
		await expect(worker.stop()).resolves.toBeUndefined();
		expect(store.runNext).toHaveBeenCalledTimes(2);
		expect(store.close).toHaveBeenCalledOnce();
	});
	it("serializes a manual tick behind an in-flight polling tick", async () => {
		const first = Promise.withResolvers<"idle">();
		store.runNext.mockReturnValueOnce(first.promise);
		const worker = createPlatformWorkloadWorkerV1(fixture());
		worker.start();
		const manual = worker.tick();
		await Promise.resolve();
		expect(store.runNext).toHaveBeenCalledOnce();
		first.resolve("idle");
		await expect(manual).resolves.toBe("idle");
		expect(store.runNext).toHaveBeenCalledTimes(2);
		await worker.stop();
	});
	it("drains a queued tick and stop after the in-flight deadline expires", async () => {
		store.runNext.mockReturnValueOnce(
			new Promise<"idle">((_resolve, reject) => {
				setTimeout(
					() => reject(new Error("Workload admission is unavailable")),
					60_000,
				);
			}),
		);
		const worker = createPlatformWorkloadWorkerV1(fixture());
		worker.start();
		const manual = worker.tick();
		const stopped = worker.stop();
		await Promise.resolve();
		expect(store.runNext).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(59_999);
		expect(store.runNext).toHaveBeenCalledOnce();
		expect(store.close).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		await expect(manual).resolves.toBe("idle");
		await expect(stopped).resolves.toBeUndefined();
		expect(store.runNext).toHaveBeenCalledTimes(2);
		expect(store.close).toHaveBeenCalledOnce();
	});
	it("drains an in-flight manual tick before closing the Store", async () => {
		const step = Promise.withResolvers<"idle">();
		store.runNext.mockReturnValueOnce(step.promise);
		const worker = createPlatformWorkloadWorkerV1(fixture());
		const manual = worker.tick();
		const stopped = worker.stop();
		await Promise.resolve();
		expect(store.close).not.toHaveBeenCalled();
		step.resolve("idle");
		await manual;
		await stopped;
		expect(store.close).toHaveBeenCalledOnce();
	});
	it("releases the Store after startup validation fails", () => {
		expect(() =>
			createPlatformWorkloadWorkerV1({ ...fixture(), maximumAttempts: 0 }),
		).toThrow("Invalid Workload retry limit");
		expect(store.close).toHaveBeenCalledOnce();
	});
	it("fails closed when deployment assembly is missing or invalid", async () => {
		await expect(
			startPlatformWorkloadWorkerFromDeploymentV1(""),
		).rejects.toThrow("PLATFORM_WORKER_DEPLOYMENT_MODULE is required");
		await expect(
			startPlatformWorkloadWorkerFromDeploymentV1(
				"data:text/javascript,export default {};",
			),
		).rejects.toThrow(
			"Platform Worker deployment dependencies are unavailable",
		);
		expect(store.runNext).not.toHaveBeenCalled();
	});
});
