import { generateKeyPairSync } from "node:crypto";
import { runtimeModelInjectionV4 } from "@agent-infra/model-catalog";
import {
	decideSessionSandboxDrainObservationV1,
	type SessionSandboxDeletionProgressV1,
	type SessionSandboxObservationV1,
	type SessionSandboxReconciliationClaimV1,
} from "@agent-infra/platform-core";
import type {
	KubernetesObject,
	V1NetworkPolicy,
	V1Pod,
	V1Secret,
	V1Service,
} from "@kubernetes/client-node";
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
						nativeMetadataWorkerOrigin:
							"http://platform-worker-native-metadata",
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
			nativeMetadataWorkerEgress: [
				{
					destination: {
						namespace: workloadTestPolicy.namespace,
						podLabels: { "app.kubernetes.io/component": "platform-worker" },
					},
					port: 3004,
				},
			],
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
	it("rejects an arbitrary native metadata destination before writing a Sandbox", async () => {
		const f = fixture();
		const receive = createProductionSessionSandboxReceiverV1(
			{
				...f.options,
				policy: {
					...f.options.policy,
					nativeMetadataWorkerEgress: [
						{ destination: { ip: "203.0.113.10" }, port: 3004 },
					],
				},
			},
			{ serviceToken: sessionSandboxDeploymentTokenFixture },
		);
		await expect(
			receive(f.claim, new AbortController().signal),
		).rejects.toThrow();
		expect(f.resources.size).toBe(0);
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
	it("waits briefly for a Pod readiness edge within the receiver lease", async () => {
		const f = fixture();
		let podReads = 0;
		const originalRead = f.client.read.bind(f.client);
		f.client.read = (async (kind, name) => {
			const current = await originalRead(kind, name);
			if (kind === "Pod" && current) {
				podReads++;
				if (podReads >= 2) {
					(current as V1Pod).status = {
						phase: "Running",
						conditions: [{ type: "Ready", status: "True" }],
					};
				}
			}
			return current;
		}) as typeof f.client.read;
		const observed = await f.receive(f.claim, new AbortController().signal);
		expect(observed.status).toBe("ready");
		expect(podReads).toBeGreaterThanOrEqual(2);
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

	describe("resources created before the managed selector label (#2691)", () => {
		const managedLabel = "agent-infra.agora.io/managed";
		/** 模拟 #2684 之前的 Worker 创建的资源：只有 managed 注解，没有同名标签和 selector 项。 */
		const asLegacy = (f: ReturnType<typeof fixture>) => {
			for (const object of f.resources.values()) {
				if (object.metadata?.name !== f.claim.sandbox.resourceName) continue;
				delete object.metadata.labels?.[managedLabel];
				if (object.kind === "Service")
					delete (object as V1Service).spec?.selector?.[managedLabel];
				if (object.kind === "NetworkPolicy")
					delete (object as V1NetworkPolicy).spec?.podSelector?.matchLabels?.[
						managedLabel
					];
			}
		};
		const readyRunning = async (f: ReturnType<typeof fixture>) => {
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
			return signal;
		};
		/** 空闲回收（drain）之后用保留的 PVC 恢复的认领（与上面 token-rotated 的恢复一致）。 */
		const resumeAfterDrain = async (
			f: ReturnType<typeof fixture>,
			observation: SessionSandboxObservationV1,
			signal: AbortSignal,
		) => {
			const claim = drainClaim(f, observation);
			if (!claim.lifecycle) throw new Error("Expected management lifecycle");
			const progress = new Map<string, SessionSandboxDeletionProgressV1>();
			const stopped = await f.receive(claim, signal, async (entry) => {
				progress.set(entry.resource.kind, entry);
				return "committed";
			});
			if (stopped.status !== "stopped" || !("sourceStop" in stopped))
				throw new Error(`Expected a complete stop, got ${stopped.status}`);
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
					stopReceipt: stopped.sourceStop ?? null,
					deletionProgress: [...progress.values()],
					preparation: {
						generation: claim.sandbox.generation,
						resourceFence: claim.resourceFence,
					},
				},
			};
			return { claim, stopped, replacement };
		};

		it("keeps a running legacy Sandbox ready, reclaims it and resumes it from the retained PVC", async () => {
			const f = fixture();
			const signal = await readyRunning(f);
			asLegacy(f);
			// 升级前创建、仍在运行的 Sandbox：观测仍为 ready，apply 不判冲突。
			const observation = await f.receive(f.claim, signal);
			expect(observation.status).toBe("ready");
			const sourcePVC = observation.resources.find(
				(resource) => resource.kind === "PersistentVolumeClaim",
			);
			// 空闲回收删除旧资源、保留 PVC；随后从保留的 PVC 恢复。
			const { claim, stopped, replacement } = await resumeAfterDrain(
				f,
				observation,
				signal,
			);
			expect(stopped.status).toBe("stopped");
			expect(
				await f.client.read("Pod", f.claim.sandbox.resourceName),
			).toBeNull();
			await f.receive(replacement, signal);
			const pvc = await f.client.read<KubernetesObject>(
				"PersistentVolumeClaim",
				f.claim.sandbox.resourceName,
			);
			expect(pvc?.metadata?.uid).toBe(sourcePVC?.uid);
			expect(pvc?.metadata?.labels?.[managedLabel]).toBe("session-sandbox-v1");
			expect(pvc?.metadata?.annotations?.["agent-infra.agora.io/fence"]).toBe(
				String(claim.resourceFence),
			);
			const pod = await f.client.read<V1Pod>(
				"Pod",
				f.claim.sandbox.resourceName,
			);
			expect(pod?.metadata?.labels?.[managedLabel]).toBe("session-sandbox-v1");
		});

		it.each([
			["a foreign managed label", "label"],
			["no managed annotation", "annotation"],
		] as const)(
			"still refuses to resume from a retained PVC with %s",
			async (_name, drift) => {
				const f = fixture();
				const signal = await readyRunning(f);
				const observation = await f.receive(f.claim, signal);
				const { replacement } = await resumeAfterDrain(f, observation, signal);
				const pvc = f.resources.get(
					`PersistentVolumeClaim/${f.claim.sandbox.resourceName}`,
				);
				if (!pvc?.metadata) throw new Error("Expected retained PVC");
				if (drift === "label")
					pvc.metadata.labels = {
						...pvc.metadata.labels,
						[managedLabel]: "someone-else",
					};
				else delete pvc.metadata.annotations?.[managedLabel];
				const writes = f.writes.length;
				await expect(f.receive(replacement, signal)).rejects.toMatchObject({
					code: "conflict",
				});
				expect(f.writes).toHaveLength(writes);
				expect(
					await f.client.read("Pod", f.claim.sandbox.resourceName),
				).toBeNull();
			},
		);
	});

	// #2917：上一轮排空完成、只剩 PVC 的沙箱被管理转换重新当作来源（resourceFence 已前进，
	// PVC 的 fence 注解仍是最初准备时的值），之前永远停在 unknown。
	describe("drain of a source that was already stopped (#2917)", () => {
		const fence = "agent-infra.agora.io/fence";
		/** 准备 → 就绪 → 完整排空，得到只剩 PVC 的沙箱；再构造把它当作来源的新排空认领。 */
		const stoppedSourceClaim = async (f: ReturnType<typeof fixture>) => {
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
			const ready = await f.receive(f.claim, signal);
			const first = drainClaim(f, ready);
			const stopped = await f.receive(first, signal, async () => "committed");
			if (stopped.status !== "stopped" || !first.lifecycle)
				throw new Error(`Expected a complete stop, got ${stopped.status}`);
			// 管理转换：来源取当时已停止的分配，resourceFence 前进，回执丢失。
			const sourceFence = first.resourceFence + 1;
			const claim: SessionSandboxReconciliationClaimV1 = {
				...first,
				resourceFence: sourceFence + 1,
				resourceStatus: "unknown",
				previousObservation: {
					status: "stopped",
					resources: stopped.resources,
				},
				lifecycle: {
					...first.lifecycle,
					authority: {
						...first.lifecycle.authority,
						targetDesiredState: "stopped",
					},
					source: {
						...first.lifecycle.source,
						sandbox: first.sandbox,
						resourceFence: sourceFence,
						observation: { status: "stopped", resources: stopped.resources },
					},
					stopReceipt: null,
					deletionProgress: [],
				},
			};
			return { claim, signal, pvc: stopped.resources[0] };
		};

		it("stops with an empty removal set, the same PVC and a proof Core accepts", async () => {
			const f = fixture();
			const { claim, signal, pvc } = await stoppedSourceClaim(f);
			const writes = f.writes.length;
			const observation = await f.receive(
				claim,
				signal,
				async () => "committed",
			);
			expect(observation.status).toBe("stopped");
			expect(observation.sourceStop?.removed).toEqual([]);
			expect(observation.sourceStop?.retainedPVC.uid).toBe(pvc?.uid);
			expect(f.writes).toHaveLength(writes);
			if (!claim.lifecycle) throw new Error("Expected lifecycle");
			expect(
				decideSessionSandboxDrainObservationV1({
					sandbox: claim.sandbox,
					resourceFence: claim.resourceFence,
					lifecycle: claim.lifecycle,
					observation,
				}),
			).toMatchObject({ status: "stopped", finished: true });
		});

		it("prepares the same Sandbox again from that proof and moves the PVC to the new fence", async () => {
			const f = fixture();
			const { claim, signal, pvc } = await stoppedSourceClaim(f);
			const stopped = await f.receive(claim, signal, async () => "committed");
			if (!claim.lifecycle || !stopped.sourceStop)
				throw new Error("Expected stop");
			const replacement: SessionSandboxReconciliationClaimV1 = {
				...claim,
				purpose: "prepare",
				desiredState: "running",
				drainComputeAllowed: false,
				resourceStatus: "applying",
				policy: { ...f.claim.policy, workloadRevision: 2, managementFence: 2 },
				deployment: {
					...(f.claim.deployment as ReturnType<typeof workloadDesiredFixture>),
					workloadRevision: 2,
				},
				previousObservation: stopped,
				lifecycle: {
					...claim.lifecycle,
					authority: {
						...claim.lifecycle.authority,
						targetDesiredState: "running",
					},
					stopReceipt: stopped.sourceStop,
					preparation: {
						generation: claim.sandbox.generation,
						resourceFence: claim.resourceFence,
					},
				},
			};
			await f.receive(replacement, signal);
			const retained = await f.client.read<KubernetesObject>(
				"PersistentVolumeClaim",
				claim.sandbox.resourceName,
			);
			expect(retained?.metadata?.uid).toBe(pvc?.uid);
			expect(retained?.metadata?.annotations?.[fence]).toBe(
				String(replacement.resourceFence),
			);
			expect(
				await f.client.read("Pod", claim.sandbox.resourceName),
			).not.toBeNull();
		});

		it("does not conclude while executions still hold the Sandbox or a preparation started", async () => {
			const f = fixture();
			const { claim, signal } = await stoppedSourceClaim(f);
			if (!claim.lifecycle) throw new Error("Expected lifecycle");
			for (const held of [
				{ ...claim, drainComputeAllowed: false },
				{
					...claim,
					lifecycle: {
						...claim.lifecycle,
						preparation: {
							generation: claim.sandbox.generation,
							resourceFence: claim.resourceFence,
						},
					},
				},
			])
				await expect(
					f.receive(held, signal, async () => "committed"),
				).resolves.toMatchObject({ status: "unknown" });
		});

		it("fails closed without deleting when another same-name resource exists or the PVC is not the recorded one", async () => {
			for (const drift of ["pod", "pvc-fence", "pvc-uid"] as const) {
				const f = fixture();
				const { claim, signal } = await stoppedSourceClaim(f);
				const name = claim.sandbox.resourceName;
				if (drift === "pod")
					f.seed({
						apiVersion: "v1",
						kind: "Pod",
						metadata: {
							name,
							namespace: claim.policy.namespace,
							uid: "late-pod",
							resourceVersion: "1",
						},
					});
				const pvc = f.resources.get(`PersistentVolumeClaim/${name}`);
				if (!pvc?.metadata?.annotations) throw new Error("Expected PVC");
				if (drift === "pvc-fence")
					pvc.metadata.annotations[fence] = String(
						(claim.lifecycle?.source.resourceFence ?? 0) + 1,
					);
				if (drift === "pvc-uid") pvc.metadata.uid = "replaced-pvc";
				const writes = f.writes.length;
				await expect(
					f.receive(claim, signal, async () => "committed"),
				).rejects.toMatchObject({ code: "conflict" });
				expect(f.writes).toHaveLength(writes);
				if (drift === "pod")
					expect(await f.client.read("Pod", name)).not.toBeNull();
			}
		});
	});

	it("replays a persisted stop receipt as stopped", async () => {
		const f = fixture();
		const claim = drainClaim(f, { status: "ready", resources: [] });
		if (!claim.lifecycle) throw new Error("Expected management lifecycle");
		const retainedPVC = {
			kind: "PersistentVolumeClaim" as const,
			namespace: claim.policy.namespace,
			name: claim.sandbox.resourceName,
			uid: "retained-pvc",
			resourceVersion: "1",
		};
		const receipt = {
			schemaVersion: 1 as const,
			sandboxId: claim.sandbox.sandboxId,
			sessionId: claim.sandbox.sessionId,
			sourceGeneration: claim.lifecycle.source.sandbox.generation,
			sourceResourceFence: claim.lifecycle.source.resourceFence,
			targetGeneration: claim.sandbox.generation,
			targetResourceFence: claim.resourceFence,
			removed: [],
			retainedPVC,
		};
		const receive = createProductionSessionSandboxReceiverV1(f.options, {
			serviceToken: "synthetic-token",
		});
		await expect(
			receive(
				{
					...claim,
					lifecycle: { ...claim.lifecycle, stopReceipt: receipt },
				},
				new AbortController().signal,
			),
		).resolves.toEqual({
			status: "stopped",
			sourceStop: receipt,
			resources: [retainedPVC],
		});
	});

	it("refreshes a source whose Pod resourceVersion moved before any delete (#1523)", async () => {
		const f = fixture();
		const signal = new AbortController().signal;
		await f.receive(f.claim, signal);
		const ready = async () => {
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
		};
		await ready();
		const observation = await f.receive(f.claim, signal);
		// A later status update moves only the Pod's resourceVersion.
		await ready();
		const writes = f.writes.length;
		const progress: SessionSandboxDeletionProgressV1[] = [];
		const record = async (entry: SessionSandboxDeletionProgressV1) => {
			progress.push(entry);
			return "committed" as const;
		};
		const refreshed = await f.receive(
			drainClaim(f, observation),
			signal,
			record,
		);
		expect(refreshed.status).toBe("observed");
		const before = observation.resources.find(
			(resource) => resource.kind === "Pod",
		);
		const after = refreshed.resources.find(
			(resource) => resource.kind === "Pod",
		);
		expect(after?.uid).toBe(before?.uid);
		expect(after?.resourceVersion).not.toBe(before?.resourceVersion);
		expect(progress).toHaveLength(0);
		expect(f.writes).toHaveLength(writes);
		expect(
			await f.receive(
				drainClaim(f, { ...observation, resources: refreshed.resources }),
				signal,
				record,
			),
		).toMatchObject({ status: "stopped" });
		expect(progress[0]).toMatchObject({
			resource: { kind: "Pod", resourceVersion: after?.resourceVersion },
		});
	});

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
