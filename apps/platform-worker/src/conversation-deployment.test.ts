import { generateKeyPairSync } from "node:crypto";
import { runtimeModelInjectionV4 } from "@agent-infra/model-catalog";
import type {
	SessionSandboxDeletionProgressV1,
	SessionSandboxObservationV1,
	SessionSandboxReconciliationClaimV1,
} from "@agent-infra/platform-core";
import type { V1NetworkPolicy, V1Pod, V1Secret } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
	createRuntimeConnectionConsumerSnapshotV1,
	runtimeConnectionConsumerAnnotation,
	runtimeConnectionInstallationRevisionEnvironment,
} from "./connection-consumer-projection.js";
import {
	createProductionConversationRuntimeResolverV2,
	createProductionSessionSandboxReceiverV1,
} from "./conversation-deployment.js";
import {
	fakeKubernetesApi,
	workloadDesiredFixture,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { sessionSandboxServiceTokenV1 } from "./session-workload-adapter.js";
import {
	sessionSandboxDeploymentTokenFixture,
	sessionSandboxModelProjectionFixture,
	sessionSandboxRuntimeAuthFixture,
	sessionSandboxTemplateBindingFixture,
} from "./test-support/session-sandbox-v4.js";
import { workloadEgressRulesV1 } from "./workload-network.js";
import {
	type WorkloadRuntimeOptionsV1,
	workloadResourceConfigurationHashV1,
} from "./workload-runtime.js";

function fixture() {
	const api = fakeKubernetesApi();
	const client = {
		...api.client,
		async deleteResult(resource: Parameters<typeof api.client.delete>[0]) {
			await api.client.delete(resource);
			return "acknowledged" as const;
		},
	};
	const deployment = workloadDesiredFixture(1, "agent-a", "internal-only");
	const options: WorkloadRuntimeOptionsV1 = {
		workerId: "worker-a",
		client,
		policy: {
			...workloadTestPolicy,
			runtimeAuth: sessionSandboxRuntimeAuthFixture,
		},
		registry: workloadRegistryFixture(),
		admissionPolicyRef: "policy-a",
		registrySubjectRef: "subject-a",
		templateModelBindings: [
			sessionSandboxTemplateBindingFixture(deployment.imageDigest),
		],
		decryptor: {
			decrypt: async () => ({
				outcome: "failed",
				code: "SECRET_KEY_UNAVAILABLE",
			}),
		},
		probeRuntime: async () => ({ core: "passed", capabilities: {} }),
	};
	const modelProjection = sessionSandboxModelProjectionFixture({
		agentId: deployment.agentId,
		configurationRevision: deployment.configRevision,
		imageDigest: deployment.imageDigest,
	});
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
		modelProjection,
		previousObservation: null,
	};
	return {
		...api,
		client,
		claim,
		options,
		receive: createProductionSessionSandboxReceiverV1(options, {
			serviceToken: sessionSandboxDeploymentTokenFixture,
		}),
	};
}

function drainClaim(
	f: ReturnType<typeof fixture>,
	observation: SessionSandboxObservationV1,
): SessionSandboxReconciliationClaimV1 {
	return {
		...f.claim,
		purpose: "drain",
		desiredState: "stopped",
		drainComputeAllowed: true,
		resourceFence: f.claim.resourceFence + 1,
		sandbox: { ...f.claim.sandbox, generation: f.claim.sandbox.generation + 1 },
		lifecycle: {
			schemaVersion: 1,
			authority: {
				kind: "management",
				applicationId: "application-a",
				managementRevision: 2,
				managementFence: 2,
				workloadRevision: 2,
				targetDesiredState: "running",
			},
			source: {
				sandbox: f.claim.sandbox,
				resourceFence: f.claim.resourceFence,
				policy: f.claim.policy,
				deployment: f.claim.deployment,
				modelProjection: f.claim.modelProjection,
				observation,
			},
			stopReceipt: null,
		},
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
			policy: {
				...f.options.policy,
				connectionConsumerSnapshot: snapshot,
				connectionInstallationRevision: JSON.stringify([
					"approved-session-export",
					"r7",
				]),
			},
		};
		const receive = createProductionSessionSandboxReceiverV1(selectedWorkload, {
			serviceToken: sessionSandboxDeploymentTokenFixture,
		});
		// Later dependency mutation and Store claims cannot replace the captured selector.
		selectedWorkload.policy.connectionInstallationRevision = '["mutated","r8"]';
		const observation = await receive(
			{ ...f.claim, ...{ connectionInstallationRevision: '["caller","r9"]' } },
			signal,
		);
		const pod = await f.client.read<V1Pod>("Pod", "sandbox-allocation-a");
		expect(
			pod?.metadata?.annotations?.[runtimeConnectionConsumerAnnotation],
		).toBe(snapshot);
		expect(pod?.spec?.containers[0]?.env).toContainEqual({
			name: runtimeConnectionInstallationRevisionEnvironment,
			value: '["approved-session-export","r7"]',
		});
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
					modelProjection: f.claim.modelProjection,
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
			"http://sandbox-allocation-a.workload-test.svc:8080",
		);
		// The control route uses the source Sandbox's own token (#1466).
		expect(target.serviceToken).toBe(
			sessionSandboxServiceTokenV1(
				"synthetic-transport-proof",
				"workload-test",
				f.claim.sandbox.sandboxId,
			),
		);
		expect(target.serviceToken).not.toBe("synthetic-transport-proof");
	});
	it("compiles Session egress only from the Worker deployment policy (#1445)", async () => {
		const f = fixture();
		const approved = {
			dnsEgress: [
				{ namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
			],
			modelEgress: [{ destination: { ip: "203.0.113.10" }, port: 443 }],
		};
		const receive = createProductionSessionSandboxReceiverV1(
			{
				...f.options,
				policy: { ...f.options.policy, ...approved },
			},
			{ serviceToken: sessionSandboxDeploymentTokenFixture },
		);
		await receive(
			{
				...f.claim,
				// A Store claim cannot widen the deployment-approved destinations.
				policy: {
					...f.claim.policy,
					modelEgress: [{ destination: { ip: "198.51.100.7" }, port: 443 }],
				} as typeof f.claim.policy,
			},
			new AbortController().signal,
		);
		const policy = f.resources.get(
			"NetworkPolicy/sandbox-allocation-a",
		) as V1NetworkPolicy;
		expect(policy.spec?.egress).toEqual(workloadEgressRulesV1(approved));
	});
	it("denies all Session egress when the deployment approves none", async () => {
		const f = fixture();
		await f.receive(f.claim, new AbortController().signal);
		const policy = f.resources.get(
			"NetworkPolicy/sandbox-allocation-a",
		) as V1NetworkPolicy;
		expect(policy.spec?.policyTypes).toEqual(["Ingress", "Egress"]);
		expect(policy.spec?.egress).toEqual([]);
	});
	it("applies the Store allocation using Worker policy and records readiness with the resource fence", async () => {
		const f = fixture();
		const signal = new AbortController().signal;
		const observed = await f.receive(f.claim, signal);
		expect(observed.status).toBe("observed");
		expect(observed.resources).toHaveLength(6);
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

	it("prepares Session resources without any Session TLS input (ADR-0020)", async () => {
		const f = fixture();
		await f.receive(f.claim, new AbortController().signal);
		const pod = f.resources.get("Pod/sandbox-allocation-a") as V1Pod;
		const container = pod.spec?.containers[0];
		expect(container?.readinessProbe?.httpGet?.scheme).toBe("HTTP");
		expect(
			container?.volumeMounts?.some((mount) =>
				mount.mountPath.startsWith("/var/run/agent-infra/runtime-tls"),
			),
		).toBe(false);
		expect(pod.spec?.volumes?.some((volume) => volume.secret)).toBe(false);
		// Only this Sandbox's own Runtime Secret (#1466); no TLS material.
		expect(
			[...f.resources.keys()].filter((key) => key.startsWith("Secret/")),
		).toEqual(["Secret/sandbox-allocation-a"]);
	});

	it("writes only the derived Sandbox token and verified V4 configuration (#1466)", async () => {
		const f = fixture();
		await f.receive(f.claim, new AbortController().signal);
		const secret = f.resources.get("Secret/sandbox-allocation-a") as V1Secret;
		const decoded = (key: string) =>
			Buffer.from(secret.data?.[key] ?? "", "base64").toString();
		expect(decoded("token")).toBe(
			sessionSandboxServiceTokenV1(
				sessionSandboxDeploymentTokenFixture,
				"workload-test",
				"allocation-a",
			),
		);
		expect(decoded("model-config")).toBe(
			runtimeModelInjectionV4(
				f.claim.modelProjection as Parameters<
					typeof runtimeModelInjectionV4
				>[0],
			).configuration,
		);
		const pod = f.resources.get("Pod/sandbox-allocation-a") as V1Pod;
		const env = pod.spec?.containers[0]?.env ?? [];
		expect(env.find(({ name }) => name === "LOG_LEVEL")?.value).toBe("info");
		expect(
			env.find(({ name }) => name === "AGENT_INFRA_RUNTIME_WORKER_ID")?.value,
		).toBe(sessionSandboxRuntimeAuthFixture.workerId);
		expect(JSON.stringify(pod)).not.toContain(
			sessionSandboxDeploymentTokenFixture,
		);
		expect(JSON.stringify(pod)).not.toContain(
			sessionSandboxRuntimeAuthFixture.serviceTokenSecret.name,
		);
	});

	it.each([
		["a missing projection", () => ({ modelProjection: null })],
		[
			"a static-key V1 projection",
			(f: ReturnType<typeof fixture>) => ({
				modelProjection: {
					...(f.claim.modelProjection as Record<string, unknown>),
					schemaVersion: 1,
				},
			}),
		],
		[
			"a tampered projection fingerprint",
			(f: ReturnType<typeof fixture>) => ({
				modelProjection: {
					...(f.claim.modelProjection as Record<string, unknown>),
					defaultReasoningLevel: "high",
				},
			}),
		],
		[
			"another Agent's projection",
			(f: ReturnType<typeof fixture>) => ({
				modelProjection: sessionSandboxModelProjectionFixture({
					agentId: "agent-b",
					configurationRevision: 1,
					imageDigest: (f.claim.deployment as { imageDigest: string })
						.imageDigest,
				}),
			}),
		],
		[
			"an Agent-level Secret reference",
			(f: ReturnType<typeof fixture>) => ({
				deployment: {
					...(f.claim.deployment as Record<string, unknown>),
					secretRefs: [
						{
							schemaVersion: 1,
							agentId: "agent-a",
							ownerType: "agent-owner",
							ownerId: "owner-a",
							secretId: "secret-a",
							secretVersion: 1,
							configRevision: 1,
							algorithmVersion: "aes-256-gcm:v1",
							wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
							wrappingKeyVersion: "key-a",
							name: "agent-secret-1",
						},
					],
				},
			}),
		],
	])(
		"fails Session prepare with policy before any write for %s (AC-5)",
		async (_name, override) => {
			const f = fixture();
			await expect(
				f.receive(
					{ ...f.claim, ...override(f) } as SessionSandboxReconciliationClaimV1,
					new AbortController().signal,
				),
			).rejects.toMatchObject({ code: "policy" });
			expect(f.writes).toHaveLength(0);
		},
	);

	it("fails before any write when the Worker no longer trusts the template binding", async () => {
		const f = fixture();
		const receive = createProductionSessionSandboxReceiverV1(
			{ ...f.options, templateModelBindings: [] },
			{ serviceToken: sessionSandboxDeploymentTokenFixture },
		);
		await expect(
			receive(f.claim, new AbortController().signal),
		).rejects.toMatchObject({ code: "policy" });
		expect(f.writes).toHaveLength(0);
	});

	it.each(["template-revoked", "token-rotated", "both"] as const)(
		"drains the captured Sandbox under management authority after %s",
		async (change) => {
			const f = fixture();
			const signal = new AbortController().signal;
			await f.receive(f.claim, signal);
			const pod = await f.client.read<V1Pod>(
				"Pod",
				f.claim.sandbox.resourceName,
			);
			if (!pod) throw new Error("Expected prepared Pod");
			pod.status = {
				phase: "Running",
				conditions: [{ type: "Ready", status: "True" }],
			};
			await f.client.replace(pod);
			const observation = await f.receive(f.claim, signal);
			const originalSecret = await f.client.read<V1Secret>(
				"Secret",
				f.claim.sandbox.resourceName,
			);
			const rotatedToken =
				change === "template-revoked"
					? sessionSandboxDeploymentTokenFixture
					: "synthetic-rotated-deployment-token";
			const receive = createProductionSessionSandboxReceiverV1(
				{
					...f.options,
					templateModelBindings:
						change === "token-rotated" ? f.options.templateModelBindings : [],
				},
				{ serviceToken: rotatedToken },
			);
			const claim = drainClaim(f, observation);
			const writes = f.writes.length;
			await expect(
				receive({ ...f.claim, previousObservation: observation }, signal),
			).rejects.toMatchObject({
				code: change === "token-rotated" ? "conflict" : "policy",
			});
			expect(f.writes).toHaveLength(writes);
			await expect(
				receive({ ...claim, drainComputeAllowed: false }, signal),
			).resolves.toEqual({
				status: "unknown",
				resources: observation.resources,
			});
			expect(f.writes).toHaveLength(writes);
			if (!claim.lifecycle) throw new Error("Expected management lifecycle");
			const progress = new Map<string, SessionSandboxDeletionProgressV1>();
			const stopped = await receive(claim, signal, async (entry) => {
				progress.set(entry.resource.kind, entry);
				return "committed";
			});
			expect(stopped.status).toBe("stopped");
			if (!("sourceStop" in stopped) || !stopped.sourceStop)
				throw new Error("Expected complete source stop proof");
			expect(
				stopped.sourceStop.removed.map(({ resource }) => resource.kind),
			).toEqual([
				"Pod",
				"Secret",
				"Service",
				"NetworkPolicy",
				"ServiceAccount",
			]);
			expect(
				await f.client.read("Pod", f.claim.sandbox.resourceName),
			).toBeNull();
			expect(
				await f.client.read("Secret", f.claim.sandbox.resourceName),
			).toBeNull();
			const sourcePVC = observation.resources.find(
				(resource) => resource.kind === "PersistentVolumeClaim",
			);
			expect(stopped.sourceStop.retainedPVC.uid).toBe(sourcePVC?.uid);
			if (change !== "token-rotated") return;
			const replacement: SessionSandboxReconciliationClaimV1 = {
				...claim,
				purpose: "prepare",
				desiredState: "running",
				drainComputeAllowed: false,
				policy: { ...f.claim.policy, workloadRevision: 2, managementFence: 2 },
				deployment: {
					...(f.claim.deployment as ReturnType<typeof workloadDesiredFixture>),
					workloadRevision: 2,
				},
				previousObservation: stopped,
				lifecycle: {
					...claim.lifecycle,
					stopReceipt: stopped.sourceStop,
					deletionProgress: [...progress.values()],
					preparation: {
						generation: claim.sandbox.generation,
						resourceFence: claim.resourceFence,
					},
				},
			};
			await receive(replacement, signal);
			const secret = await f.client.read<V1Secret>(
				"Secret",
				f.claim.sandbox.resourceName,
			);
			expect(secret?.metadata?.uid).not.toBe(originalSecret?.metadata?.uid);
			expect(secret?.data?.token).toBe(
				Buffer.from(
					sessionSandboxServiceTokenV1(
						rotatedToken,
						f.claim.policy.namespace,
						f.claim.sandbox.sandboxId,
					),
				).toString("base64"),
			);
			expect(secret?.data?.token).not.toBe(originalSecret?.data?.token);
			const replacementPod = await f.client.read<V1Pod>(
				"Pod",
				f.claim.sandbox.resourceName,
			);
			expect(replacementPod?.metadata?.uid).not.toBe(pod.metadata?.uid);
			expect(
				(
					await f.client.read(
						"PersistentVolumeClaim",
						f.claim.sandbox.resourceName,
					)
				)?.metadata?.uid,
			).toBe(sourcePVC?.uid);
		},
	);

	it("rejects a tampered captured projection before drain writes", async () => {
		const f = fixture();
		const signal = new AbortController().signal;
		const observation = await f.receive(f.claim, signal);
		const claim = drainClaim(f, observation);
		if (!claim.lifecycle) throw new Error("Expected management lifecycle");
		const writes = f.writes.length;
		await expect(
			f.receive(
				{
					...claim,
					lifecycle: {
						...claim.lifecycle,
						source: {
							...claim.lifecycle.source,
							modelProjection: {
								...(f.claim.modelProjection as Record<string, unknown>),
								agentId: "other-agent",
							},
						},
					},
				},
				signal,
			),
		).rejects.toMatchObject({ code: "policy" });
		expect(f.writes).toHaveLength(writes);
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
						modelProjection: f.claim.modelProjection,
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
