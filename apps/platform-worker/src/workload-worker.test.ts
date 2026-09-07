import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fakeKubernetesApi,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";

const store = vi.hoisted(() => ({
	runNext: vi.fn<() => Promise<"idle" | "advanced">>(),
	close: vi.fn<() => Promise<void>>(),
}));
vi.mock("@agent-infra/platform-store", () => ({
	openPostgresWorkloadReconciliationStoreV1: () => store,
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
		revisionBinder: {
			bind: async () => ({
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
	store.runNext.mockReset().mockResolvedValue("idle");
	store.close.mockReset().mockResolvedValue();
});
afterEach(() => vi.useRealTimers());

describe("Workload Worker lifecycle", () => {
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
