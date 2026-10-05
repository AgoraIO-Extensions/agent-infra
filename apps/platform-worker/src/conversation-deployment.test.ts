import type { SessionSandboxReconciliationClaimV1 } from "@agent-infra/platform-core";
import type { V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { createProductionSessionSandboxReceiverV1 } from "./conversation-deployment.js";
import {
	fakeKubernetesApi,
	workloadDesiredFixture,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import {
	type WorkloadRuntimeOptionsV1,
	workloadResourceConfigurationHashV1,
} from "./workload-runtime.js";

function fixture() {
	const api = fakeKubernetesApi();
	const deployment = workloadDesiredFixture(1, "agent-a", "internal-only");
	const options: WorkloadRuntimeOptionsV1 = {
		workerId: "worker-a",
		client: api.client,
		policy: workloadTestPolicy,
		registry: workloadRegistryFixture(),
		admissionPolicyRef: "policy-a",
		registrySubjectRef: "subject-a",
		templateModelBindings: [],
		decryptor: {
			decrypt: async () => ({
				outcome: "failed",
				code: "SECRET_KEY_UNAVAILABLE",
			}),
		},
		probeRuntime: async () => ({ core: "passed", capabilities: {} }),
	};
	const claim: SessionSandboxReconciliationClaimV1 = {
		schemaVersion: 1,
		operation: "conversation.sandbox.reconcile.v1",
		execution: null,
		itemId: "resource-intent-a",
		leaseOwner: "worker-a",
		deliveryFence: 7,
		resourceFence: 3,
		resourceStatus: "applying",
		desiredState: "running",
		authorization: null,
		purpose: "prepare",
		drainComputeAllowed: false,
		lifecycle: null,
		sandbox: {
			schemaVersion: 1,
			agentId: "agent-a",
			sessionId: "conversation-a",
			sandboxId: "allocation-a",
			principal: { kind: "user", id: "actor-a" },
			channelId: "web",
			generation: 2,
			resourceName: "sandbox-allocation-a",
			workspaceScope: "allocation-a",
		},
		policy: {
			namespace: workloadTestPolicy.namespace,
			resourceConfigurationHash:
				workloadResourceConfigurationHashV1(workloadTestPolicy),
			configurationRevision: 1,
			workloadRevision: 1,
			managementFence: 1,
			imageDigest: deployment.imageDigest,
		},
		deployment,
		previousObservation: null,
	};
	return {
		...api,
		claim,
		receive: createProductionSessionSandboxReceiverV1(options),
	};
}

describe("production SessionSandbox resource receiver", () => {
	it("applies the Store allocation using Worker policy and records readiness with the resource fence", async () => {
		const f = fixture();
		const signal = new AbortController().signal;
		const observed = await f.receive(f.claim, signal);
		expect(observed.status).toBe("observed");
		expect(observed.resources).toHaveLength(5);
		const pod = f.resources.get("Pod/sandbox-allocation-a") as V1Pod;
		expect(pod.metadata?.annotations?.["agent-infra.agora.io/fence"]).toBe("3");
		expect(pod.spec?.containers[0]?.resources).toEqual(
			workloadTestPolicy.resources,
		);
		pod.status = {
			phase: "Running",
			conditions: [{ type: "Ready", status: "True" }],
		};
		const ready = await f.receive(
			{ ...f.claim, previousObservation: observed },
			signal,
		);
		expect(ready.status).toBe("ready");
		expect(ready.resources.map(({ uid }) => uid)).toEqual(
			observed.resources.map(({ uid }) => uid),
		);
	});

	it("rejects a mismatched persisted policy before any resource write", async () => {
		const f = fixture();
		await expect(
			f.receive(
				{
					...f.claim,
					policy: {
						...f.claim.policy,
						resourceConfigurationHash: "stale-policy",
					},
				},
				new AbortController().signal,
			),
		).rejects.toThrow("verified policy");
		expect(f.writes).toHaveLength(0);
	});

	it("keeps source resources and returns unknown while an original execution prevents drain", async () => {
		const f = fixture();
		const signal = new AbortController().signal;
		const observation = await f.receive(f.claim, signal);
		const before = structuredClone([...f.resources]);
		const result = await f.receive(
			{
				...f.claim,
				purpose: "drain",
				desiredState: "stopped",
				resourceFence: 4,
				lifecycle: {
					schemaVersion: 1,
					authority: {
						kind: "management",
						applicationId: "application-a",
						managementRevision: 2,
						managementFence: 2,
						workloadRevision: 2,
						targetDesiredState: "stopped",
					},
					source: {
						sandbox: f.claim.sandbox,
						resourceFence: 3,
						policy: f.claim.policy,
						deployment: f.claim.deployment,
						observation,
					},
					stopReceipt: null,
				},
			},
			signal,
		);
		expect(result).toEqual({
			status: "unknown",
			resources: observation.resources,
		});
		expect([...f.resources]).toEqual(before);
	});
});
