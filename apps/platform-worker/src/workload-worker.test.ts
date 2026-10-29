import type { OperationalEvent } from "@agent-infra/observability";
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
const monitorStore = vi.hoisted(() => ({
	runNext: vi.fn<() => Promise<"idle" | "advanced">>(),
	close: vi.fn<() => Promise<void>>(),
}));
const fileCleanup = vi.hoisted(() => ({
	runOnce: vi.fn<() => Promise<boolean>>(),
	close: vi.fn<() => Promise<void>>(),
}));
const evaluation = vi.hoisted(() => ({
	runOnce: vi.fn<() => Promise<boolean>>(),
	close: vi.fn<() => Promise<void>>(),
}));
const scorer = vi.hoisted(() => ({
	runOnce: vi.fn<() => Promise<void>>(),
	close: vi.fn<() => Promise<void>>(),
}));
vi.mock("./evaluation-scoring-worker.js", () => ({
	createEvaluationScoringWorkerV1: () => scorer,
}));
vi.mock("./file-worker.js", () => ({
	createPlatformFileReconciliationWorkerV1: () => fileCleanup,
}));
vi.mock("./evaluation-data-worker.js", () => ({
	createEvaluationDataWorkerV1: () => evaluation,
}));
vi.mock("@agent-infra/platform-store", () => ({
	openPostgresWorkloadReconciliationStoreV1: (options: {
		selection?: string;
	}) => {
		return (
			store.opened(options) ??
			(options.selection === "monitor" ? monitorStore : store)
		);
	},
}));

import { createWorkloadRuntimeV1 } from "./workload-runtime.js";
import {
	createPlatformWorkloadWorkerV1,
	startPlatformWorkloadWorkerFromDeploymentV1,
} from "./workload-worker.js";

vi.mock("./workload-runtime.js", { spy: true });

function fixture() {
	return {
		templateModelBindings: [],
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
	scorer.runOnce.mockReset().mockResolvedValue();
	scorer.close.mockReset().mockResolvedValue();
	fileCleanup.runOnce.mockReset().mockResolvedValue(true);
	fileCleanup.close.mockReset().mockResolvedValue();
	evaluation.runOnce.mockReset().mockResolvedValue(true);
	evaluation.close.mockReset().mockResolvedValue();
	store.opened.mockReset();
	store.runNext.mockReset().mockResolvedValue("idle");
	store.close.mockReset().mockResolvedValue();
	monitorStore.runNext.mockReset().mockResolvedValue("idle");
	monitorStore.close.mockReset().mockResolvedValue();
});
afterEach(() => vi.useRealTimers());

describe("Workload Worker lifecycle", () => {
	it("advances a newly due lifecycle while another Agent monitor remains in flight", async () => {
		const monitor = Promise.withResolvers<"idle">();
		monitorStore.runNext.mockReturnValueOnce(monitor.promise);
		// The previous mixed poller first selects the only due work: this monitor.
		store.opened.mockImplementation((options: { selection?: string }) =>
			options.selection === undefined ? monitorStore : undefined,
		);
		let lifecycleDue = false;
		let advanced = false;
		store.runNext.mockImplementation(async () => {
			if (!lifecycleDue) return "idle";
			lifecycleDue = false;
			advanced = true;
			return "advanced";
		});
		const worker = createPlatformWorkloadWorkerV1(fixture());
		try {
			worker.start();
			await vi.advanceTimersByTimeAsync(1);
			expect(monitorStore.runNext).toHaveBeenCalledOnce();
			lifecycleDue = true;
			await vi.advanceTimersByTimeAsync(10);
			expect(advanced).toBe(true);
			expect(monitorStore.runNext).toHaveBeenCalledOnce();
		} finally {
			monitor.resolve("idle");
			await worker.stop();
		}
	});

	it("keeps manual fallback in the two polling slots and drains it before closing", async () => {
		const lifecycle = Promise.withResolvers<"idle">();
		const monitor = Promise.withResolvers<"idle">();
		const fallback = Promise.withResolvers<"advanced">();
		store.runNext.mockReturnValueOnce(lifecycle.promise);
		monitorStore.runNext
			.mockReturnValueOnce(monitor.promise)
			.mockReturnValueOnce(fallback.promise);
		const worker = createPlatformWorkloadWorkerV1(fixture());
		worker.start();
		await vi.advanceTimersByTimeAsync(1);
		const manual = worker.tick();
		const stopped = worker.stop();
		try {
			await vi.advanceTimersByTimeAsync(100);
			expect(store.runNext).toHaveBeenCalledOnce();
			expect(monitorStore.runNext).toHaveBeenCalledOnce();
			lifecycle.resolve("idle");
			await vi.advanceTimersByTimeAsync(1);
			expect(store.runNext).toHaveBeenCalledTimes(2);
			expect(monitorStore.runNext).toHaveBeenCalledOnce();
			monitor.resolve("idle");
			await vi.advanceTimersByTimeAsync(1);
			expect(monitorStore.runNext).toHaveBeenCalledTimes(2);
			expect(store.close).not.toHaveBeenCalled();
			expect(monitorStore.close).not.toHaveBeenCalled();
			fallback.resolve("advanced");
			await expect(manual).resolves.toBe("advanced");
			await stopped;
			expect(store.close).toHaveBeenCalledOnce();
			expect(monitorStore.close).toHaveBeenCalledOnce();
		} finally {
			lifecycle.resolve("idle");
			monitor.resolve("idle");
			fallback.resolve("advanced");
			await manual;
			await stopped;
		}
	});

	it("closes the lifecycle Store if opening the monitor Store fails", async () => {
		store.opened.mockImplementation((options: { selection?: string }) => {
			if (options.selection === "monitor")
				throw new Error("monitor open failed");
		});
		expect(() => createPlatformWorkloadWorkerV1(fixture())).toThrow(
			"monitor open failed",
		);
		expect(store.close).toHaveBeenCalledOnce();
	});

	it("bounds both pollers independently without duplicating maintenance", async () => {
		store.runNext.mockResolvedValue("advanced");
		monitorStore.runNext.mockResolvedValue("advanced");
		const worker = createPlatformWorkloadWorkerV1({
			...fixture(),
			pollIntervalMs: 1000,
			files: {} as never,
			evaluation: {} as never,
		});
		worker.start();
		await vi.advanceTimersByTimeAsync(100);
		expect(store.runNext).toHaveBeenCalledTimes(20);
		expect(monitorStore.runNext).toHaveBeenCalledTimes(20);
		expect(fileCleanup.runOnce).toHaveBeenCalledOnce();
		expect(evaluation.runOnce).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(850);
		expect(store.runNext).toHaveBeenCalledTimes(20);
		expect(monitorStore.runNext).toHaveBeenCalledTimes(20);
		await worker.stop();
		expect(store.close).toHaveBeenCalledOnce();
		expect(monitorStore.close).toHaveBeenCalledOnce();
		expect(fileCleanup.close).toHaveBeenCalledOnce();
		expect(evaluation.close).toHaveBeenCalledOnce();
	});

	it("recovers a failed monitor independently and closes both Stores after a close failure", async () => {
		monitorStore.runNext.mockRejectedValueOnce(
			new Error("private monitor error"),
		);
		monitorStore.close.mockRejectedValueOnce(new Error("monitor close failed"));
		const options = fixture();
		const worker = createPlatformWorkloadWorkerV1(options);
		worker.start();
		await vi.advanceTimersByTimeAsync(10);
		expect(store.runNext).toHaveBeenCalledTimes(2);
		expect(monitorStore.runNext).toHaveBeenCalledTimes(2);
		expect(options.log.mock.calls.join()).not.toContain(
			"private monitor error",
		);
		await expect(worker.stop()).rejects.toThrow("monitor close failed");
		expect(store.close).toHaveBeenCalledOnce();
		expect(monitorStore.close).toHaveBeenCalledOnce();
		await expect(worker.tick()).rejects.toThrow("Platform Worker is stopped");
	});
	it.each(["none", "callback", "logger"])(
		"forwards diagnostics independently of %s failure",
		async (failure) => {
			const diagnostic = {
				schemaVersion: 1 as const,
				agentId: "agent-a",
				workloadRevision: 1,
				stage: "workload_not_ready" as const,
				workloads: [],
				services: [],
			};
			const onHealthDiagnostic = vi.fn(() => {
				if (failure === "callback") throw new Error("private callback failure");
			});
			const log = vi.fn(() => {
				if (failure === "logger") throw new Error("private logger failure");
			});
			const worker = createPlatformWorkloadWorkerV1({
				...fixture(),
				onHealthDiagnostic,
				log,
			});
			try {
				const runtimeOptions = vi
					.mocked(createWorkloadRuntimeV1)
					.mock.calls.at(-1)?.[0];
				expect(() =>
					runtimeOptions?.onHealthDiagnostic?.(diagnostic),
				).not.toThrow();
				expect(onHealthDiagnostic).toHaveBeenCalledExactlyOnceWith(diagnostic);
				expect(log).toHaveBeenCalledExactlyOnceWith(
					JSON.stringify({
						service: "platform-worker",
						code: "WORKLOAD_MULTI_SERVICE_HEALTH_DIAGNOSTIC",
						...diagnostic,
					}),
				);
				await expect(worker.tick()).resolves.toBe("idle");
			} finally {
				await worker.stop();
			}
		},
	);
	it("continues file cleanup when successive workload reconciliation attempts fail", async () => {
		store.runNext.mockRejectedValue(new Error("workload unavailable"));
		const worker = createPlatformWorkloadWorkerV1({
			...fixture(),
			files: {
				storage: {
					scan: async () => ({ objects: [], cursor: null }),
					remove: async () => {},
				},
				batchSize: 1,
				orphanGraceMs: 1,
			},
		});
		try {
			await expect(worker.tick()).rejects.toThrow("workload unavailable");
			await expect(worker.tick()).rejects.toThrow("workload unavailable");
			expect(fileCleanup.runOnce).toHaveBeenCalledTimes(2);
		} finally {
			await worker.stop();
		}
		expect(fileCleanup.close).toHaveBeenCalledOnce();
	});

	it("rejects a deployment module missing template bindings before opening the Store", async () => {
		const { templateModelBindings: _bindings, ...options } = fixture();
		vi.stubGlobal("workloadDeploymentTestFactory", () => options);
		try {
			await expect(
				startPlatformWorkloadWorkerFromDeploymentV1(
					"data:text/javascript,export const createPlatformWorkloadWorkerOptionsV1 = () => globalThis.workloadDeploymentTestFactory();",
				),
			).rejects.toThrow("Template model bindings are required");
			expect(store.opened).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
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
	it("runs the next due step at once after an advance and waits only when idle (#2295)", async () => {
		store.runNext
			.mockResolvedValueOnce("advanced")
			.mockResolvedValueOnce("advanced")
			.mockResolvedValueOnce("advanced")
			.mockResolvedValue("idle");
		const worker = createPlatformWorkloadWorkerV1({
			...fixture(),
			pollIntervalMs: 1000,
			files: {
				storage: { scan: async () => ({ objects: [], cursor: null }) },
				batchSize: 10,
				orphanGraceMs: 60_000,
			} as never,
		});
		worker.start();
		// 三次推进加一次空闲远早于一个轮询间隔就完成。
		await vi.advanceTimersByTimeAsync(50);
		expect(store.runNext).toHaveBeenCalledTimes(4);
		// 存储扫描不随连续步数放大：这一轮只在空闲前清理一次。
		expect(fileCleanup.runOnce).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(900);
		expect(store.runNext).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(100);
		expect(store.runNext).toHaveBeenCalledTimes(5);
		expect(fileCleanup.runOnce).toHaveBeenCalledTimes(2);
		await worker.stop();
	});
	it("waits one poll interval after the maximum consecutive advances (#2295)", async () => {
		store.runNext.mockResolvedValue("advanced");
		const worker = createPlatformWorkloadWorkerV1({
			...fixture(),
			pollIntervalMs: 1000,
		});
		worker.start();
		await vi.advanceTimersByTimeAsync(100);
		expect(store.runNext).toHaveBeenCalledTimes(20);
		await vi.advanceTimersByTimeAsync(850);
		expect(store.runNext).toHaveBeenCalledTimes(20);
		await vi.advanceTimersByTimeAsync(150);
		expect(store.runNext).toHaveBeenCalledTimes(40);
		await worker.stop();
	});
	it("retries a failed transaction without logging provider details", async () => {
		const observations: OperationalEvent[] = [];
		const options = {
			...fixture(),
			observability: {
				record: (event: OperationalEvent) => observations.push(event),
			},
		};
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
		expect(observations).toEqual([
			expect.objectContaining({
				stage: "workload",
				outcome: "failed",
				code: "WORKLOAD_UNAVAILABLE",
				durationMs: expect.any(Number),
			}),
		]);
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

it("slow scoring leaves Workload polling and manual ticks live and drains its own in-flight work", async () => {
	const model = Promise.withResolvers<void>();
	scorer.runOnce.mockReturnValueOnce(model.promise);
	scorer.close.mockImplementationOnce(async () => {
		await model.promise;
	});
	const worker = createPlatformWorkloadWorkerV1({
		...fixture(),
		evaluationScoring: {} as never,
	});
	worker.start();
	await vi.advanceTimersByTimeAsync(50);
	expect(scorer.runOnce).toHaveBeenCalledOnce();
	expect(store.runNext.mock.calls.length).toBeGreaterThan(2);
	await expect(worker.tick()).resolves.toBe("idle");
	const closing = worker.stop();
	expect(scorer.close).toHaveBeenCalledOnce();
	expect(store.close).not.toHaveBeenCalled();
	model.resolve();
	await closing;
	await vi.advanceTimersByTimeAsync(100);
	expect(scorer.runOnce).toHaveBeenCalledOnce();
	expect(store.close).toHaveBeenCalledOnce();
});
it("observes a scorer close rejection immediately while draining Workload and still closes its store", async () => {
	const step = Promise.withResolvers<"idle">();
	store.runNext.mockReturnValueOnce(step.promise);
	scorer.close.mockRejectedValueOnce(new Error("synthetic close"));
	const worker = createPlatformWorkloadWorkerV1({
		...fixture(),
		evaluationScoring: {} as never,
	});
	worker.start();
	await vi.advanceTimersByTimeAsync(1);
	const closing = worker.stop();
	const observed = expect(closing).rejects.toThrow("synthetic close");
	await vi.advanceTimersByTimeAsync(20);
	expect(store.close).not.toHaveBeenCalled();
	step.resolve("idle");
	await observed;
	expect(store.close).toHaveBeenCalledOnce();
});
