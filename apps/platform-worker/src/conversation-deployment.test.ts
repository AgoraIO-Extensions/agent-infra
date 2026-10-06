import { generateKeyPairSync } from "node:crypto";
import type { SessionSandboxReconciliationClaimV1 } from "@agent-infra/platform-core";
import type { V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
	createRuntimeConnectionConsumerSnapshotV1,
	runtimeConnectionConsumerAnnotation,
} from "./connection-consumer-projection.js";
import {
	createProductionConversationRuntimeResolverV2,
	createProductionSessionSandboxReceiverV1,
} from "./conversation-deployment.js";
import {
	fakeKubernetesApi,
	runtimeTlsSecretFixture,
	workloadDesiredFixture,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import {
	type WorkloadRuntimeOptionsV1,
	workloadResourceConfigurationHashV1,
} from "./workload-runtime.js";

type SessionRuntimeTlsPolicy = SessionSandboxReconciliationClaimV1["policy"] & {
	readonly sessionRuntimeTlsBindings: readonly {
		readonly sessionId: string;
		readonly sandboxId: string;
		readonly generation: number;
		readonly resourceFence: number;
		readonly serviceName: string;
		readonly secretName: string;
	}[];
};

function fixture() {
	const api = fakeKubernetesApi();
	api.seed(
		runtimeTlsSecretFixture("sandbox-allocation-a-tls", "agent-a", [
			"sandbox-allocation-a.workload-test.svc",
		]),
	);
	const deployment = workloadDesiredFixture(1, "agent-a", "internal-only");
	const sessionRuntimeTlsBindings = [
		{
			sessionId: "conversation-a",
			sandboxId: "allocation-a",
			generation: 2,
			resourceFence: 3,
			serviceName: "sandbox-allocation-a",
			secretName: "sandbox-allocation-a-tls",
		},
	] as const;
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
			sessionRuntimeTlsBindings,
		} as SessionRuntimeTlsPolicy,
		deployment,
		previousObservation: null,
	};
	return {
		...api,
		claim,
		options,
		receive: createProductionSessionSandboxReceiverV1(options),
	};
}

describe("production SessionSandbox resource receiver", () => {
	it("preserves the approved Connection snapshot through the production control resolver", async () => {
		const f = fixture();
		const signal = new AbortController().signal;
		const keys = generateKeyPairSync("ed25519");
		const signing = {
			workerId: "worker-a",
			issuer: "platform",
			keyId: "connection-profile-test",
			privateKey: keys.privateKey,
		};
		const profile = {
			schemaVersion: 1 as const,
			publicOrigin: "https://connection.example.test",
			mcpPath: "/mcp/v1",
			consumerId: "platform-worker",
			audience: "connection-api",
			egressProfile: { ref: "egress-platform", revision: "r1" },
		};
		const approval = {
			schemaVersion: 1 as const,
			configFingerprint:
				"26062a8f8e5a003ff8047fead83d76c254d9b54834ca5348fb7e4ceee67d205b",
			egressEnforced: true as const,
			source: { ref: "platform-deployment", revision: "r1" },
		};
		const expected = structuredClone({ profile, source: approval.source });
		const snapshot = createRuntimeConnectionConsumerSnapshotV1(
			profile,
			approval,
		);
		const selectedWorkload = {
			...f.options,
			policy: { ...f.options.policy, connectionConsumerSnapshot: snapshot },
		};
		const receive = createProductionSessionSandboxReceiverV1(selectedWorkload);
		const observation = await receive(f.claim, signal);
		const pod = await f.client.read<V1Pod>("Pod", "sandbox-allocation-a");
		expect(
			pod?.metadata?.annotations?.[runtimeConnectionConsumerAnnotation],
		).toBe(snapshot);
		const resolver = createProductionConversationRuntimeResolverV2({
			workload: {
				...selectedWorkload,
				policy: {
					...selectedWorkload.policy,
					runtimeAuth: {
						workerId: signing.workerId,
						grantIssuer: signing.issuer,
						grantKeyId: signing.keyId,
						grantPublicKey: keys.publicKey
							.export({ type: "spki", format: "pem" })
							.toString(),
						serviceTokenSecret: { name: "transport", key: "token" },
					},
				},
			},
			signing,
			serviceToken: "synthetic-transport-proof",
			connectionConsumerProfile: profile,
			connectionConsumerApproval: approval,
		});
		profile.audience = "changed-input";
		approval.source.revision = "changed-input";
		const target = await resolver({
			agentId: f.claim.sandbox.agentId,
			conversationId: f.claim.sandbox.sessionId,
			sessionGeneration: f.claim.sandbox.generation,
			purpose: "control",
			command: "turn.stop",
			workload: null,
			signal,
			sandboxResource: {
				sandbox: f.claim.sandbox,
				resourceFence: f.claim.resourceFence + 1,
				desiredState: "stopped",
				status: "observed",
				policy: f.claim.policy,
				observation,
				controlSource: {
					sandbox: f.claim.sandbox,
					resourceFence: f.claim.resourceFence,
					policy: f.claim.policy,
					observation,
					deployment: f.claim.deployment,
				},
			},
			...{
				url: "https://caller.example.test/mcp",
				headers: { Authorization: "synthetic-caller-proof" },
				consumerId: "caller-consumer",
				audience: "caller-audience",
				connectionConsumerProfile: profile,
			},
		});
		expect(target.connectionConsumer).toEqual({
			status: "available",
			schemaVersion: 1,
			...expected,
			configFingerprint: approval.configFingerprint,
			url: "https://connection.example.test/mcp/v1",
		});
		expect(target.baseUrl).toBe(
			"https://sandbox-allocation-a.workload-test.svc:8080",
		);
	});
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

	it("rejects an ambiguous Session TLS binding tuple before any resource write", async () => {
		const f = fixture();
		const policy = f.claim.policy as SessionRuntimeTlsPolicy;
		const binding = policy.sessionRuntimeTlsBindings[0];
		if (!binding) throw new Error("missing Session TLS binding");
		await expect(
			f.receive(
				{
					...f.claim,
					policy: {
						...policy,
						sessionRuntimeTlsBindings: [
							...policy.sessionRuntimeTlsBindings,
							{ ...binding, secretName: "sandbox-allocation-a-tls-alt" },
						],
					} as SessionRuntimeTlsPolicy,
				},
				new AbortController().signal,
			),
		).rejects.toThrow("Session Runtime TLS binding is ambiguous");
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
