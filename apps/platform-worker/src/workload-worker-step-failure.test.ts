import type { WorkloadStepFailureV1 } from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import {
	fakeKubernetesApi,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";

const captured = vi.hoisted(() => ({
	onStepFailure: undefined as
		| ((failure: WorkloadStepFailureV1) => void)
		| undefined,
}));
vi.mock("@agent-infra/platform-core", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@agent-infra/platform-core")>();
	return {
		...actual,
		createWorkloadReconciliationV1: (
			options: Parameters<typeof actual.createWorkloadReconciliationV1>[0],
		) => {
			captured.onStepFailure = options.onStepFailure;
			return { tick: async () => "idle" as const };
		},
	};
});
vi.mock("./file-worker.js", () => ({
	createPlatformFileReconciliationWorkerV1: () => ({
		runOnce: async () => true,
		close: async () => undefined,
	}),
}));
vi.mock("@agent-infra/platform-store", () => ({
	openPostgresWorkloadReconciliationStoreV1: () => ({
		runNext: async () => "idle" as const,
		close: async () => undefined,
	}),
}));

import { createPlatformWorkloadWorkerV1 } from "./workload-worker.js";

describe("Workload Worker step failure logging (#2532)", () => {
	it("hands swallowed reconciliation exceptions to a bounded log record", () => {
		const log = vi.fn();
		createPlatformWorkloadWorkerV1({
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
			log,
		});
		if (!captured.onStepFailure) throw new Error("onStepFailure not wired");
		captured.onStepFailure({
			agentId: "agent-a",
			phase: "applying",
			attempts: 4,
			terminal: false,
			error: new WorkloadKubernetesError("unavailable", {
				status: 403,
				kind: "Deployment",
				verb: "create",
			}),
		});
		expect(log).toHaveBeenCalledOnce();
		expect(JSON.parse(log.mock.calls[0]?.[0])).toEqual({
			service: "platform-worker",
			code: "WORKLOAD_STEP_FAILED",
			agentId: "agent-a",
			phase: "applying",
			attempts: 4,
			terminal: false,
			reason: "kubernetes_forbidden",
			kubernetes: { status: 403, kind: "Deployment", verb: "create" },
		});
	});

	it("keeps reconciling when the log sink throws", () => {
		const log = vi.fn(() => {
			throw new Error("broken-log-sink");
		});
		createPlatformWorkloadWorkerV1({
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
			log,
		});
		expect(() =>
			captured.onStepFailure?.({
				agentId: "agent-a",
				phase: "promoting",
				attempts: 1,
				terminal: false,
				error: new Error("boom"),
			}),
		).not.toThrow();
	});
});
