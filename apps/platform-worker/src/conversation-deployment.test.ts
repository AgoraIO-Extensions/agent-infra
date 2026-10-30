import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createAppliedRuntimeSkillDirectoryV1 } from "@agent-infra/agent-runtime";
import { RuntimeSkillHubBindingV1Schema } from "@agent-infra/contracts/runtime";
import { runtimeModelInjectionV4 } from "@agent-infra/model-catalog";
import {
	decideSessionSandboxDrainObservationV1,
	type SessionSandboxDeletionProgressV1,
	type SessionSandboxObservationV1,
	type SessionSandboxReconciliationClaimV1,
	sessionSandboxFileExchangeTokenV1,
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
import { workloadResourceNameV1 } from "./kubernetes-runtime-comparison.js";
import { sessionSandboxServiceTokenV1 } from "./session-workload-adapter.js";
import { nativeEgressFixture } from "./test-support/native-egress.js";
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

/** 与 Agent Workload 共用的部署文件交换 origin（#3276）。 */
const fileExchangeOriginFixture = "http://platform-api.agent-infra.svc:3000";
// #3289：与 origin 成对的部署声明，端口等于 origin 端口。
const fileExchangeEgressFixture = [
	{
		destination: {
			namespace: "agent-infra",
			podLabels: { "app.kubernetes.io/component": "platform-api" },
		},
		port: 3000,
	},
];

function fixture() {
	const api = fakeKubernetesApi();
	let podReads = 0;
	const client = {
		...api.client,
		async read<T extends KubernetesObject>(
			kind: Parameters<typeof api.client.read>[0],
			name: string,
		): Promise<T | null> {
			if (kind === "Pod") podReads += 1;
			return api.client.read<T>(kind, name);
		},
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
		podReads: () => podReads,
		receive: createProductionSessionSandboxReceiverV1(options, {
			serviceToken: sessionSandboxDeploymentTokenFixture,
		}),
	};
}

async function skillFixture() {
	const f = fixture();
	const projection = {
		schemaVersion: 1,
		agentId: f.claim.sandbox.agentId,
		agentVersion: "agent-version-1",
		skillVersion: {
			schemaVersion: 1,
			skillId: "skill-a",
			skillVersionId: "skill-version-a",
			provider: "my_library",
			version: "1.0.0",
			packageObjectVersion: "object-a",
			packageDigest: "a".repeat(64),
			manifestDigest: "b".repeat(64),
			signatureDigest: "c".repeat(64),
		},
		manifest: {
			schemaVersion: 1,
			name: "session-notes",
			version: "1.0.0",
			entryPath: "SKILL.md",
			files: [
				{
					path: "SKILL.md",
					sizeBytes: 1,
					sha256: createHash("sha256").update("x").digest("hex"),
				},
			],
			packageDigest: "a".repeat(64),
		},
		targetPath: ".agents/skills/session-notes",
		readOnly: true,
		grant: {
			schemaVersion: 1,
			tools: [],
			connections: [],
			fileRoots: [],
			networkOrigins: [],
			scripts: false,
		},
	};
	const binding = RuntimeSkillHubBindingV1Schema.parse({
		schemaVersion: 1,
		agentId: projection.agentId,
		agentVersion: projection.agentVersion,
		configurationRevision: 1,
		generationId: "e".repeat(64),
		projections: [projection],
		appliedBindings: [
			{
				schemaVersion: 1,
				agentId: projection.agentId,
				agentVersion: projection.agentVersion,
				skillName: projection.manifest.name,
				skillVersion: projection.skillVersion,
				grant: projection.grant,
				configurationRevision: 1,
				syncRevision: 1,
				state: "synced",
				failureReason: null,
				appliedReceipt: {
					schemaVersion: 1,
					agentId: projection.agentId,
					agentVersion: projection.agentVersion,
					skillName: projection.manifest.name,
					configurationRevision: 1,
					syncRevision: 1,
					skillVersionId: projection.skillVersion.skillVersionId,
					generationId: "e".repeat(64),
					packageDigest: projection.skillVersion.packageDigest,
					manifestDigest: projection.skillVersion.manifestDigest,
					targetPath: projection.targetPath,
					readOnly: true,
				},
			},
		],
	});
	const claim = {
		...f.claim,
		deployment: {
			...workloadDesiredFixture(1, projection.agentId, "internal-only"),
			skillGenerationId: binding.generationId,
			skills: binding.projections,
			skillAppliedBindings: JSON.stringify(binding.appliedBindings),
		},
	};
	const sourceName = `${workloadResourceNameV1(projection.agentId)}-data`;
	await f.client.create({
		apiVersion: "v1",
		kind: "PersistentVolumeClaim",
		metadata: {
			name: sourceName,
			namespace: workloadTestPolicy.namespace,
			labels: {
				"agent-infra.agora.io/agent": workloadResourceNameV1(
					projection.agentId,
				),
			},
			annotations: { "agent-infra.agora.io/agent-id": projection.agentId },
		},
	});
	return { ...f, claim, binding, sourceName };
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
	it("performs one full observe after apply instead of a hot 100ms loop (#3739)", async () => {
		const f = fixture();
		const observed = await f.receive(f.claim, new AbortController().signal);
		expect(observed.status).toBe("observed");
		// One read can come from apply's ownership check; no 100ms observe loop follows.
		expect(f.podReads()).toBeLessThanOrEqual(2);
	});

	it("carries the verified Hub generation to the Session without sharing its workspace", async () => {
		const f = await skillFixture();
		const signal = new AbortController().signal;
		const observation = await f.receive(f.claim, signal);
		const pod = f.resources.get("Pod/sandbox-allocation-a") as V1Pod;
		const container = pod.spec?.containers[0];
		expect(container?.volumeMounts).toContainEqual({
			name: "skill-hub",
			mountPath: "/opt/agent-infra-skill-hub/.agents",
			subPath: `generations/${f.binding.generationId}/.agents`,
			readOnly: true,
		});
		expect(pod.spec?.volumes).toContainEqual({
			name: "skill-hub",
			persistentVolumeClaim: { claimName: f.sourceName, readOnly: true },
		});
		expect(pod.spec?.volumes).toContainEqual({
			name: "workspace",
			persistentVolumeClaim: { claimName: "sandbox-allocation-a" },
		});
		expect(
			JSON.parse(
				container?.env?.find(
					(e) => e.name === "AGENT_INFRA_RUNTIME_SKILL_HUB_BINDING",
				)?.value ?? "null",
			),
		).toEqual(f.binding);
		pod.status = {
			phase: "Running",
			conditions: [{ type: "Ready", status: "True" }],
		};
		expect(
			(
				await f.receive(
					{ ...f.claim, previousObservation: observation },
					signal,
				)
			).status,
		).toBe("ready");
	});

	it("mount layout is discoverable by the real Runtime Skill directory", async () => {
		const f = await skillFixture();
		await f.receive(f.claim, new AbortController().signal);
		const pod = f.resources.get("Pod/sandbox-allocation-a") as V1Pod;
		const mount = pod.spec?.containers[0]?.volumeMounts?.find(
			(m) => m.name === "skill-hub",
		);
		if (!mount) throw new Error("missing Skill mount");
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "session-skill-layout-")),
		);
		try {
			expect(mount.mountPath).toBe("/opt/agent-infra-skill-hub/.agents");
			const mounted = join(root, ".agents");
			await mkdir(join(mounted, "skills/session-notes"), { recursive: true });
			const skillFile = join(mounted, "skills/session-notes/SKILL.md");
			await writeFile(skillFile, "x", { mode: 0o444 });
			for (const path of [
				root,
				mounted,
				join(mounted, "skills"),
				join(mounted, "skills/session-notes"),
			])
				await chmod(path, 0o555);
			const directory = createAppliedRuntimeSkillDirectoryV1({
				...f.binding,
				root,
			});
			expect(directory.nativeSkillPaths?.()).toEqual([
				join(await realpath(root), ".agents/skills/session-notes/SKILL.md"),
			]);
		} finally {
			for (const path of [
				root,
				join(root, ".agents"),
				join(root, ".agents/skills"),
				join(root, ".agents/skills/session-notes"),
			])
				await chmod(path, 0o755).catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	});

	it("shares only immutable packages between independent Session workspaces", async () => {
		const f = await skillFixture();
		const signal = new AbortController().signal;
		await f.receive(f.claim, signal);
		const otherClaim = {
			...f.claim,
			sandbox: {
				...f.claim.sandbox,
				sessionId: "conversation-b",
				sandboxId: "allocation-b",
				resourceName: "sandbox-allocation-b",
				workspaceScope: "allocation-b",
			},
		};
		await f.receive(otherClaim, signal);
		const podA = f.resources.get("Pod/sandbox-allocation-a") as V1Pod;
		const podB = f.resources.get("Pod/sandbox-allocation-b") as V1Pod;
		expect(podA.spec?.volumes?.find((v) => v.name === "skill-hub")).toEqual(
			podB.spec?.volumes?.find((v) => v.name === "skill-hub"),
		);
		expect(podB.spec?.volumes?.find((v) => v.name === "workspace")).toEqual({
			name: "workspace",
			persistentVolumeClaim: { claimName: "sandbox-allocation-b" },
		});
		expect(podA.spec?.volumes?.find((v) => v.name === "workspace")).not.toEqual(
			podB.spec?.volumes?.find((v) => v.name === "workspace"),
		);
	});

	it("drains its recorded Session resources even after the Skill source volume disappears", async () => {
		const f = await skillFixture();
		const signal = new AbortController().signal;
		const observed = await f.receive(f.claim, signal);
		f.resources.delete(`PersistentVolumeClaim/${f.sourceName}`);
		const result = await f.receive(
			drainClaim(f, observed),
			signal,
			async () => "committed",
		);
		expect(result.status).toBe("stopped");
		expect(f.resources.get("Pod/sandbox-allocation-a")).toBeUndefined();
		expect(
			f.resources.get("PersistentVolumeClaim/sandbox-allocation-a"),
		).toBeDefined();
	});

	it.each(["missing", "other-agent", "terminating"])(
		"rejects a %s source PVC before creating Session resources",
		async (mutation) => {
			const f = await skillFixture();
			const key = `PersistentVolumeClaim/${f.sourceName}`;
			const source = f.resources.get(key);
			if (!source?.metadata) throw new Error("missing fixture PVC");
			if (mutation === "missing") f.resources.delete(key);
			if (mutation === "other-agent")
				source.metadata.annotations = {
					"agent-infra.agora.io/agent-id": "agent-b",
				};
			if (mutation === "terminating")
				source.metadata.deletionTimestamp = new Date();
			await expect(
				f.receive(f.claim, new AbortController().signal),
			).rejects.toThrow();
			expect(
				[...f.resources.keys()].filter((key) => key.includes("sandbox-")),
			).toEqual([]);
		},
	);

	it.each([
		"missing-applied",
		"stale-applied",
		"other-agent",
		"missing-generation",
	])("rejects %s Skill input before resource writes", async (mutation) => {
		const f = await skillFixture();
		const deployment = structuredClone(f.claim.deployment);
		if (mutation === "missing-applied") deployment.skillAppliedBindings = "[]";
		if (mutation === "stale-applied") {
			const bindings = JSON.parse(deployment.skillAppliedBindings);
			bindings[0].configurationRevision = 2;
			deployment.skillAppliedBindings = JSON.stringify(bindings);
		}
		if (mutation === "other-agent" && deployment.skills[0])
			deployment.skills[0].agentId = "agent-b";
		if (mutation === "missing-generation")
			Object.assign(deployment, { skillGenerationId: undefined });
		await expect(
			f.receive({ ...f.claim, deployment }, new AbortController().signal),
		).rejects.toThrow();
		expect(
			[...f.resources.keys()].filter((key) => key.includes("sandbox-")),
		).toEqual([]);
	});

	it.each([
		"writable-mount",
		"other-generation",
		"writable-volume",
		"missing-binding",
	])("rejects %s drift without replacing the Session Pod", async (mutation) => {
		const f = await skillFixture();
		const signal = new AbortController().signal;
		const observation = await f.receive(f.claim, signal);
		const pod = f.resources.get("Pod/sandbox-allocation-a") as V1Pod;
		const container = pod.spec?.containers[0];
		const mount = container?.volumeMounts?.find((m) => m.name === "skill-hub");
		if (!mount) throw new Error("missing Skill mount");
		if (mutation === "writable-mount") mount.readOnly = false;
		if (mutation === "other-generation")
			mount.subPath = `generations/${"f".repeat(64)}/.agents`;
		if (mutation === "writable-volume") {
			const volume = pod.spec?.volumes?.find((v) => v.name === "skill-hub");
			if (volume?.persistentVolumeClaim)
				volume.persistentVolumeClaim.readOnly = false;
		}
		if (mutation === "missing-binding" && container)
			container.env = container.env?.filter(
				(e) => e.name !== "AGENT_INFRA_RUNTIME_SKILL_HUB_BINDING",
			);
		const uid = pod.metadata?.uid;
		await expect(
			f.receive({ ...f.claim, previousObservation: observation }, signal),
		).rejects.toThrow();
		expect(f.resources.get("Pod/sandbox-allocation-a")?.metadata?.uid).toBe(
			uid,
		);
	});

	it("copies custom Owner Secret data into the Session Secret and keeps it out of the claim", async () => {
		const f = fixture();
		const ownerSecretName = "agent-owner-secret";
		await f.client.create({
			apiVersion: "v1",
			kind: "Secret",
			metadata: {
				name: ownerSecretName,
				namespace: f.options.policy.namespace,
				annotations: {
					"agent-infra.agora.io/secret-id": "owner-secret",
					"agent-infra.agora.io/secret-version": "1",
					"agent-infra.agora.io/config-revision": "1",
				},
			},
			immutable: true,
			data: { MODEL_API_KEY: Buffer.from("owner-value").toString("base64") },
		});
		const secretRef = {
			schemaVersion: 1 as const,
			ownerType: "agent-owner" as const,
			ownerId: "actor-a",
			agentId: "agent-a",
			secretId: "owner-secret",
			secretVersion: 1,
			configRevision: 1,
			algorithmVersion: "aes-256-gcm:v1" as const,
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
			wrappingKeyVersion: "key-a",
			name: ownerSecretName,
		};
		const customDeployment = workloadDesiredFixture(
			1,
			"agent-a",
			"internal-only",
		);
		(customDeployment as { secretRefs: (typeof secretRef)[] }).secretRefs = [
			secretRef,
		];
		const customClaim = {
			...f.claim,
			deployment: customDeployment,
			modelProjection: null,
		};
		const receive = createProductionSessionSandboxReceiverV1(
			{
				...f.options,
				policy: { ...f.options.policy, nativeEgress: nativeEgressFixture() },
			},
			{ serviceToken: sessionSandboxDeploymentTokenFixture },
		);
		await receive(customClaim, new AbortController().signal);
		const customNetwork = f.resources.get(
			"NetworkPolicy/sandbox-allocation-a",
		) as V1NetworkPolicy;
		expect(JSON.stringify(customNetwork.spec?.egress)).not.toContain("8.8.8.8");
		const sandboxSecret = f.resources.get(
			"Secret/sandbox-allocation-a",
		) as V1Secret;
		const sandboxPod = f.resources.get("Pod/sandbox-allocation-a") as V1Pod;
		expect(
			Buffer.from(sandboxSecret.data?.MODEL_API_KEY ?? "", "base64").toString(),
		).toBe("owner-value");
		expect(JSON.stringify(customClaim)).not.toContain("owner-value");
		expect(JSON.stringify(sandboxPod)).not.toContain("owner-value");
		expect(
			sandboxPod.spec?.containers[0]?.env?.some(
				(entry) => entry.name === "MODEL_API_KEY",
			),
		).toBe(true);
	});
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
			nativeEgress: nativeEgressFixture(),
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
					nativeEgress: {
						...nativeEgressFixture(),
						destinations: [{ destination: { ip: "1.1.1.1" }, port: 443 }],
					},
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
	it("returns one observed Pod check to durable pacing instead of a hot loop", async () => {
		const f = fixture();
		let podReads = 0;
		const originalRead = f.client.read.bind(f.client);
		f.client.read = (async (kind, name) => {
			const current = await originalRead(kind, name);
			if (kind === "Pod" && current) {
				podReads++;
			}
			return current;
		}) as typeof f.client.read;
		const observed = await f.receive(f.claim, new AbortController().signal);
		expect(observed.status).toBe("observed");
		expect(podReads).toBeLessThanOrEqual(2);
	});

	it.each(["claude", "acp", "pi"] as const)(
		"projects the deployment-trusted %s Driver into its own Session Pod",
		async (driver) => {
			const f = fixture();
			const modelProjection = sessionSandboxModelProjectionFixture({
				agentId: f.claim.sandbox.agentId,
				configurationRevision: 1,
				imageDigest: f.claim.policy.imageDigest,
				driver,
			});
			const receive = createProductionSessionSandboxReceiverV1(
				{
					...f.options,
					templateModelBindings: [modelProjection.standardTemplateBinding],
				},
				{ serviceToken: sessionSandboxDeploymentTokenFixture },
			);
			await receive(
				{ ...f.claim, modelProjection },
				new AbortController().signal,
			);
			const pod = f.resources.get("Pod/sandbox-allocation-a") as V1Pod;
			expect(pod.spec?.containers[0]?.env).toContainEqual({
				name: "AGENT_INFRA_RUNTIME_DRIVER",
				value: driver,
			});
			const secret = [...f.resources.values()].find(
				(resource) => resource.kind === "Secret",
			) as V1Secret;
			expect(
				Buffer.from(secret.data?.["model-config"] ?? "", "base64").toString(),
			).toBe(runtimeModelInjectionV4(modelProjection).configuration);
		},
	);

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

	describe("Runtime file exchange injection (#3276)", () => {
		const withOrigin = (
			f: ReturnType<typeof fixture>,
			fileExchangeOrigin: string,
		): WorkloadRuntimeOptionsV1 => ({
			...f.options,
			policy: {
				...f.options.policy,
				runtimeAuth: {
					...sessionSandboxRuntimeAuthFixture,
					fileExchangeOrigin,
				},
				fileExchangeEgress: fileExchangeEgressFixture,
			},
		});

		it("adds exactly the declared file exchange egress to the Session NetworkPolicy (#3289 AC-1)", async () => {
			const disabled = fixture();
			await disabled.receive(disabled.claim, new AbortController().signal);
			const f = fixture();
			const options = withOrigin(f, fileExchangeOriginFixture);
			await createProductionSessionSandboxReceiverV1(options, {
				serviceToken: sessionSandboxDeploymentTokenFixture,
			})(f.claim, new AbortController().signal);
			const egressOf = (resources: typeof f.resources) =>
				(resources.get("NetworkPolicy/sandbox-allocation-a") as V1NetworkPolicy)
					.spec?.egress ?? [];
			const before = egressOf(disabled.resources);
			const after = egressOf(f.resources);
			expect(after).toEqual(workloadEgressRulesV1(options.policy));
			expect(after).toHaveLength(before.length + 1);
			expect(
				after.filter(
					(rule) => !before.some((old) => isDeepStrictEqual(old, rule)),
				),
			).toEqual([
				{
					to: [
						{
							namespaceSelector: {
								matchLabels: { "kubernetes.io/metadata.name": "agent-infra" },
							},
							podSelector: {
								matchLabels: { "app.kubernetes.io/component": "platform-api" },
							},
						},
					],
					ports: [{ protocol: "TCP", port: 3000 }],
				},
			]);
		});

		it("rejects an origin without its declared egress before any write (#3289 AC-2)", async () => {
			const f = fixture();
			const options = withOrigin(f, fileExchangeOriginFixture);
			const receive = createProductionSessionSandboxReceiverV1(
				{
					...options,
					policy: { ...options.policy, fileExchangeEgress: undefined },
				},
				{ serviceToken: sessionSandboxDeploymentTokenFixture },
			);
			const writes = f.writes.length;
			await expect(
				receive(f.claim, new AbortController().signal),
			).rejects.toMatchObject({ code: "policy" });
			expect(f.writes.length).toBe(writes);
		});

		it("injects the Agent Workload origin and a token derived from this allocation", async () => {
			const f = fixture();
			const receive = createProductionSessionSandboxReceiverV1(
				withOrigin(f, fileExchangeOriginFixture),
				{ serviceToken: sessionSandboxDeploymentTokenFixture },
			);
			await receive(f.claim, new AbortController().signal);
			const pod = f.resources.get("Pod/sandbox-allocation-a") as V1Pod;
			const secret = f.resources.get("Secret/sandbox-allocation-a") as V1Secret;
			const env = pod.spec?.containers[0]?.env ?? [];
			expect(
				env.find(
					({ name }) => name === "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN",
				),
			).toEqual({
				name: "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN",
				value: fileExchangeOriginFixture,
			});
			expect(
				env.find(
					({ name }) =>
						name === "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN",
				),
			).toEqual({
				name: "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN",
				valueFrom: {
					secretKeyRef: {
						name: "sandbox-allocation-a",
						key: "file-exchange-token",
						optional: false,
					},
				},
			});
			const derived = sessionSandboxFileExchangeTokenV1(
				sessionSandboxDeploymentTokenFixture,
				{
					namespace: f.claim.policy.namespace,
					sandboxId: f.claim.sandbox.sandboxId,
					generation: f.claim.sandbox.generation,
					resourceFence: f.claim.resourceFence,
				},
			);
			expect(
				Buffer.from(
					secret.data?.["file-exchange-token"] ?? "",
					"base64",
				).toString(),
			).toBe(derived);
			// AC-3：部署 token（哨兵）不出现在 Pod 或 Secret 的任何值中，Pod 也不引用部署 Secret。
			const values = Object.values(secret.data ?? {}).map((value) =>
				Buffer.from(value, "base64").toString(),
			);
			expect(JSON.stringify(values)).not.toContain(
				sessionSandboxDeploymentTokenFixture,
			);
			expect(JSON.stringify(pod)).not.toContain(
				sessionSandboxDeploymentTokenFixture,
			);
			expect(JSON.stringify(pod)).not.toContain(derived);
			expect(JSON.stringify(pod)).not.toContain(
				sessionSandboxRuntimeAuthFixture.serviceTokenSecret.name,
			);
		});

		it("injects nothing when the deployment configures no origin", async () => {
			const f = fixture();
			await f.receive(f.claim, new AbortController().signal);
			const pod = f.resources.get("Pod/sandbox-allocation-a") as V1Pod;
			const secret = f.resources.get("Secret/sandbox-allocation-a") as V1Secret;
			expect(
				(pod.spec?.containers[0]?.env ?? []).filter(({ name }) =>
					name.startsWith("AGENT_INFRA_RUNTIME_FILE_EXCHANGE_"),
				),
			).toEqual([]);
			expect(Object.keys(secret.data ?? {})).not.toContain(
				"file-exchange-token",
			);
		});

		it.each([
			"http://10.0.0.1:3000",
			"https://platform-api.example.test/path",
			"ftp://platform-api",
		])("rejects origin %s before any Kubernetes write", async (origin) => {
			const f = fixture();
			const receive = createProductionSessionSandboxReceiverV1(
				withOrigin(f, origin),
				{ serviceToken: sessionSandboxDeploymentTokenFixture },
			);
			await expect(
				receive(f.claim, new AbortController().signal),
			).rejects.toMatchObject({ code: "policy" });
			expect(f.writes).toHaveLength(0);
		});
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

	it.each([
		"template-revoked",
		"token-rotated",
		"both",
		"file-exchange-enabled",
	] as const)(
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
				change === "template-revoked" || change === "file-exchange-enabled"
					? sessionSandboxDeploymentTokenFixture
					: "synthetic-rotated-deployment-token";
			// #3276：Worker 以新增的文件交换 origin 重新部署，已有 Sandbox 的 env 与 Secret 键不同。
			const receive = createProductionSessionSandboxReceiverV1(
				{
					...f.options,
					policy:
						change === "file-exchange-enabled"
							? {
									...f.options.policy,
									runtimeAuth: {
										...sessionSandboxRuntimeAuthFixture,
										fileExchangeOrigin: fileExchangeOriginFixture,
									},
									fileExchangeEgress: fileExchangeEgressFixture,
								}
							: f.options.policy,
					templateModelBindings:
						change === "token-rotated" || change === "file-exchange-enabled"
							? f.options.templateModelBindings
							: [],
				},
				{ serviceToken: rotatedToken },
			);
			const claim = drainClaim(f, observation);
			const writes = f.writes.length;
			await expect(
				receive({ ...f.claim, previousObservation: observation }, signal),
			).rejects.toMatchObject({
				code:
					change === "token-rotated" || change === "file-exchange-enabled"
						? "conflict"
						: "policy",
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
			expect(stopped.sourceStop.retainedPVC?.uid).toBe(sourcePVC?.uid);
			if (change !== "token-rotated" && change !== "file-exchange-enabled")
				return;
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
			if (change === "file-exchange-enabled") {
				// AC-2：替换后的 Pod 带上文件交换变量，Secret 中是按新代次与 fence 派生的值。
				const env = replacementPod?.spec?.containers[0]?.env ?? [];
				expect(
					env.find(
						({ name }) => name === "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN",
					)?.value,
				).toBe(fileExchangeOriginFixture);
				expect(
					env.find(
						({ name }) =>
							name === "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN",
					)?.valueFrom?.secretKeyRef?.key,
				).toBe("file-exchange-token");
				expect(
					Buffer.from(
						secret?.data?.["file-exchange-token"] ?? "",
						"base64",
					).toString(),
				).toBe(
					sessionSandboxFileExchangeTokenV1(rotatedToken, {
						namespace: f.claim.policy.namespace,
						sandboxId: f.claim.sandbox.sandboxId,
						generation: replacement.sandbox.generation,
						resourceFence: replacement.resourceFence,
					}),
				);
				expect(originalSecret?.data?.["file-exchange-token"]).toBeUndefined();
				return;
			}
			expect(secret?.data?.token).not.toBe(originalSecret?.data?.token);
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
			expect(observation.sourceStop?.retainedPVC?.uid).toBe(pvc?.uid);
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

		// #2995：重启后替换准备已在来源 fence 下建出资源（PVC 也被改写到该 fence），观测未提交时
		// 又停止。管理转换的来源仍是上一轮的停止观测，排空之前每次都在 confirmStoppedSource 冲突，
		// 替换 Pod 一直运行。
		describe("stop during an unobserved replacement preparation (#2995)", () => {
			/** 停止 → 回执 → 替换准备建出资源（观测未提交）→ 再停止的排空认领。 */
			const interruptedReplacementClaim = async (
				f: ReturnType<typeof fixture>,
			) => {
				const {
					claim: stoppedSource,
					signal,
					pvc,
				} = await stoppedSourceClaim(f);
				const stopped = await f.receive(
					stoppedSource,
					signal,
					async () => "committed",
				);
				if (!stoppedSource.lifecycle || !stopped.sourceStop)
					throw new Error("Expected stop");
				const sourceFence = stoppedSource.resourceFence + 1;
				const policy = {
					...f.claim.policy,
					workloadRevision: 2,
					managementFence: 2,
				};
				const deployment = {
					...(f.claim.deployment as ReturnType<typeof workloadDesiredFixture>),
					workloadRevision: 2,
				};
				await f.receive(
					{
						...stoppedSource,
						purpose: "prepare",
						desiredState: "running",
						drainComputeAllowed: false,
						resourceFence: sourceFence,
						resourceStatus: "applying",
						policy,
						deployment,
						previousObservation: stopped,
						lifecycle: {
							...stoppedSource.lifecycle,
							authority: {
								...stoppedSource.lifecycle.authority,
								targetDesiredState: "running",
							},
							stopReceipt: stopped.sourceStop,
							preparation: {
								generation: stoppedSource.sandbox.generation,
								resourceFence: sourceFence,
							},
						},
					},
					signal,
				);
				// 管理停止转换：上一个生命周期还在准备，来源取当时的分配——fence 是替换准备的
				// fence，观测仍是上一轮的停止观测；回执与准备都不保留。
				const claim: SessionSandboxReconciliationClaimV1 = {
					...stoppedSource,
					resourceFence: sourceFence + 1,
					resourceStatus: "unknown",
					policy,
					previousObservation: stopped,
					lifecycle: {
						...stoppedSource.lifecycle,
						source: {
							...stoppedSource.lifecycle.source,
							resourceFence: sourceFence,
							policy,
							deployment,
							observation: stopped,
						},
						stopReceipt: null,
						deletionProgress: [],
					},
				};
				return { claim, signal, pvc };
			};
			/** 模拟 Store：按 Core 判定写回来源证据与分配观测。 */
			const refined = (
				claim: SessionSandboxReconciliationClaimV1,
				observation: SessionSandboxObservationV1,
			): SessionSandboxReconciliationClaimV1 => {
				if (!claim.lifecycle) throw new Error("Expected lifecycle");
				const decision = decideSessionSandboxDrainObservationV1({
					sandbox: claim.sandbox,
					resourceFence: claim.resourceFence,
					lifecycle: claim.lifecycle,
					observation,
				});
				expect(decision.finished).toBe(false);
				return {
					...claim,
					previousObservation: decision.observation,
					lifecycle: {
						...claim.lifecycle,
						source: {
							...claim.lifecycle.source,
							observation: decision.observation,
						},
					},
				};
			};

			it("records the replacement resources as source evidence, then removes them and keeps the same PVC", async () => {
				const f = fixture();
				const { claim, signal, pvc } = await interruptedReplacementClaim(f);
				const name = claim.sandbox.resourceName;
				expect(await f.client.read("Pod", name)).not.toBeNull();
				const progress = new Map<string, SessionSandboxDeletionProgressV1>();
				const record = async (entry: SessionSandboxDeletionProgressV1) => {
					progress.set(entry.resource.kind, entry);
					return "committed" as const;
				};
				const writes = f.writes.length;
				const first = await f.receive(claim, signal, record);
				expect(first.status).toBe("observed");
				expect(f.writes).toHaveLength(writes);
				expect(
					first.resources.find(
						(resource) => resource.kind === "PersistentVolumeClaim",
					)?.uid,
				).toBe(pvc?.uid);
				let next = refined(claim, first);
				expect(next.lifecycle?.source.observation?.status).toBe("observed");
				let observation = first;
				for (let attempt = 0; attempt < 3; attempt += 1) {
					observation = await f.receive(next, signal, record);
					if (observation.status === "stopped") break;
					next = refined(next, observation);
				}
				expect(observation.status).toBe("stopped");
				expect(
					observation.sourceStop?.removed
						.map((proof) => proof.resource.kind)
						.sort(),
				).toEqual(
					[
						"NetworkPolicy",
						"Pod",
						"Secret",
						"Service",
						"ServiceAccount",
					].sort(),
				);
				expect(observation.sourceStop?.retainedPVC?.uid).toBe(pvc?.uid);
				for (const kind of [
					"Pod",
					"Secret",
					"Service",
					"ServiceAccount",
					"NetworkPolicy",
				] as const)
					expect(await f.client.read(kind, name)).toBeNull();
				expect(
					(await f.client.read("PersistentVolumeClaim", name))?.metadata?.uid,
				).toBe(pvc?.uid);
				if (!next.lifecycle) throw new Error("Expected lifecycle");
				expect(
					decideSessionSandboxDrainObservationV1({
						sandbox: next.sandbox,
						resourceFence: next.resourceFence,
						lifecycle: {
							...next.lifecycle,
							deletionProgress: [...progress.values()],
						},
						observation,
					}),
				).toMatchObject({ status: "stopped", finished: true });
			});

			it("proves the stop directly when the interrupted preparation only moved the PVC", async () => {
				const f = fixture();
				const { claim, signal, pvc } = await interruptedReplacementClaim(f);
				const name = claim.sandbox.resourceName;
				for (const key of [...f.resources.keys()])
					if (
						key.endsWith(`/${name}`) &&
						key !== `PersistentVolumeClaim/${name}`
					)
						f.resources.delete(key);
				const writes = f.writes.length;
				const observation = await f.receive(
					claim,
					signal,
					async () => "committed",
				);
				expect(observation.status).toBe("stopped");
				expect(observation.sourceStop?.removed).toEqual([]);
				expect(observation.sourceStop?.retainedPVC?.uid).toBe(pvc?.uid);
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

			it("still fails closed without deleting when the leftovers carry a newer fence or the PVC was replaced", async () => {
				for (const drift of ["fence", "pvc-uid"] as const) {
					const f = fixture();
					const { claim, signal } = await interruptedReplacementClaim(f);
					const name = claim.sandbox.resourceName;
					for (const [key, resource] of f.resources) {
						if (!key.endsWith(`/${name}`) || !resource.metadata?.annotations)
							continue;
						if (drift === "fence")
							resource.metadata.annotations[fence] = String(
								claim.resourceFence + 1,
							);
						if (
							drift === "pvc-uid" &&
							resource.kind === "PersistentVolumeClaim"
						)
							resource.metadata.uid = "replaced-pvc";
					}
					const writes = f.writes.length;
					await expect(
						f.receive(claim, signal, async () => "committed"),
					).rejects.toMatchObject({ code: "conflict" });
					expect(f.writes).toHaveLength(writes);
					expect(await f.client.read("Pod", name)).not.toBeNull();
				}
			});
		});
	});

	// #2918：准备中断，只建出了 ServiceAccount、观测从未提交。来源 observation 为 unknown 且没有资源，
	// 之前永远停在 unknown，ServiceAccount 一直留在集群里。
	describe("drain of a partially prepared source (#2918)", () => {
		const partialClaim = async (f: ReturnType<typeof fixture>) => {
			const signal = new AbortController().signal;
			await f.receive(f.claim, signal);
			for (const key of [...f.resources.keys()])
				if (key !== `ServiceAccount/${f.claim.sandbox.resourceName}`)
					f.resources.delete(key);
			const claim = drainClaim(f, { status: "unknown", resources: [] });
			if (!claim.lifecycle) throw new Error("Expected lifecycle");
			return {
				signal,
				claim: {
					...claim,
					resourceStatus: "unknown" as const,
					previousObservation: { status: "unknown" as const, resources: [] },
					lifecycle: {
						...claim.lifecycle,
						authority: {
							...claim.lifecycle.authority,
							targetDesiredState: "stopped" as const,
						},
						deletionProgress: [],
					},
				},
			};
		};
		/** 模拟 Store 按 Core 的补全规则写回来源证据。 */
		const refined = (
			claim: SessionSandboxReconciliationClaimV1,
			observation: SessionSandboxObservationV1,
		): SessionSandboxReconciliationClaimV1 => {
			if (!claim.lifecycle) throw new Error("Expected lifecycle");
			const decision = decideSessionSandboxDrainObservationV1({
				sandbox: claim.sandbox,
				resourceFence: claim.resourceFence,
				lifecycle: claim.lifecycle,
				observation,
			});
			return {
				...claim,
				previousObservation: decision.observation,
				lifecycle: {
					...claim.lifecycle,
					source: {
						...claim.lifecycle.source,
						observation: decision.observation,
					},
				},
			};
		};

		it("records the owned leftover as evidence, then removes it by UID without a retained PVC", async () => {
			const f = fixture();
			const { claim, signal } = await partialClaim(f);
			const name = claim.sandbox.resourceName;
			const progress = new Map<string, SessionSandboxDeletionProgressV1>();
			const record = async (entry: SessionSandboxDeletionProgressV1) => {
				progress.set(entry.resource.kind, entry);
				return "committed" as const;
			};
			const first = await f.receive(claim, signal, record);
			expect(first).toMatchObject({ status: "observed" });
			expect(first.resources.map((resource) => resource.kind)).toEqual([
				"ServiceAccount",
			]);
			expect(await f.client.read("ServiceAccount", name)).not.toBeNull();
			const next = refined(claim, first);
			expect(next.lifecycle?.source.observation?.resources).toHaveLength(1);
			const stopped = await f.receive(next, signal, record);
			expect(stopped.status).toBe("stopped");
			expect(
				stopped.sourceStop?.removed.map((proof) => proof.resource.kind),
			).toEqual(["ServiceAccount"]);
			expect(stopped.sourceStop?.retainedPVC).toBeNull();
			expect(stopped.resources).toEqual([]);
			expect(await f.client.read("ServiceAccount", name)).toBeNull();
			if (!next.lifecycle) throw new Error("Expected lifecycle");
			expect(
				decideSessionSandboxDrainObservationV1({
					sandbox: next.sandbox,
					resourceFence: next.resourceFence,
					lifecycle: {
						...next.lifecycle,
						deletionProgress: [...progress.values()],
					},
					observation: stopped,
				}),
			).toMatchObject({ status: "stopped", finished: true });
		});

		it("does not remove anything while executions still hold the Sandbox or a preparation started", async () => {
			const f = fixture();
			const { claim, signal } = await partialClaim(f);
			const first = await f.receive(claim, signal, async () => "committed");
			const next = refined(claim, first);
			if (!next.lifecycle) throw new Error("Expected lifecycle");
			for (const held of [
				{ ...next, drainComputeAllowed: false },
				{
					...next,
					lifecycle: {
						...next.lifecycle,
						preparation: {
							generation: next.sandbox.generation,
							resourceFence: next.resourceFence,
						},
					},
				},
			])
				await expect(
					f.receive(held, signal, async () => "committed"),
				).resolves.toMatchObject({ status: "unknown" });
			expect(
				await f.client.read("ServiceAccount", next.sandbox.resourceName),
			).not.toBeNull();
		});

		it("fails closed without deleting when a same-name object is not the recorded one", async () => {
			for (const leftover of ["Pod", "PersistentVolumeClaim"] as const) {
				const f = fixture();
				const { claim, signal } = await partialClaim(f);
				const name = claim.sandbox.resourceName;
				const first = await f.receive(claim, signal, async () => "committed");
				const next = refined(claim, first);
				f.seed({
					apiVersion: "v1",
					kind: leftover,
					metadata: {
						name,
						namespace: claim.policy.namespace,
						uid: `foreign-${leftover}`,
						resourceVersion: "1",
					},
				});
				const writes = f.writes.length;
				await expect(
					f.receive(next, signal, async () => "committed"),
				).rejects.toMatchObject({
					code: "conflict",
				});
				expect(f.writes).toHaveLength(writes);
				expect(await f.client.read("ServiceAccount", name)).not.toBeNull();
				expect(await f.client.read(leftover, name)).not.toBeNull();
			}
		});

		it("prepares the same Sandbox from scratch after a stop without a retained PVC", async () => {
			const f = fixture();
			const { claim, signal } = await partialClaim(f);
			const first = await f.receive(claim, signal, async () => "committed");
			const next = refined(claim, first);
			const stopped = await f.receive(next, signal, async () => "committed");
			if (!next.lifecycle || !stopped.sourceStop)
				throw new Error("Expected stop");
			const replacement: SessionSandboxReconciliationClaimV1 = {
				...next,
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
					...next.lifecycle,
					authority: {
						...next.lifecycle.authority,
						targetDesiredState: "running",
					},
					stopReceipt: stopped.sourceStop,
					preparation: {
						generation: next.sandbox.generation,
						resourceFence: next.resourceFence,
					},
				},
			};
			await f.receive(replacement, signal);
			const name = next.sandbox.resourceName;
			expect(await f.client.read("PersistentVolumeClaim", name)).not.toBeNull();
			expect(await f.client.read("Pod", name)).not.toBeNull();
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

it("rejects incomplete native deployment policy before Session writes", () => {
	const f = fixture();
	const nativeEgress = nativeEgressFixture();
	nativeEgress.protectedNetworks.kubernetesApi = [];
	expect(() =>
		createProductionSessionSandboxReceiverV1(
			{ ...f.options, policy: { ...f.options.policy, nativeEgress } },
			{ serviceToken: sessionSandboxDeploymentTokenFixture },
		),
	).toThrow();
	expect(f.resources.size).toBe(0);
});
it("production Session native egress rejects an overlapping allow policy before writing", async () => {
	const f = fixture();
	f.client.list = async (kind) =>
		structuredClone(
			[...f.resources.values()].filter((value) => value.kind === kind),
		) as never;
	f.resources.set("NetworkPolicy/foreign", {
		apiVersion: "networking.k8s.io/v1",
		kind: "NetworkPolicy",
		metadata: { name: "foreign", namespace: f.options.policy.namespace },
		spec: { podSelector: {}, policyTypes: ["Egress"], egress: [{}] },
	} as V1NetworkPolicy);
	const before = structuredClone([...f.resources]);
	const receive = createProductionSessionSandboxReceiverV1(
		{
			...f.options,
			policy: { ...f.options.policy, nativeEgress: nativeEgressFixture() },
		},
		{ serviceToken: sessionSandboxDeploymentTokenFixture },
	);
	await expect(
		receive(f.claim, new AbortController().signal),
	).rejects.toThrow();
	expect([...f.resources]).toEqual(before);
});
it("native Session policy clones deployment input and detects protected-only policy drift", async () => {
	const f = fixture();
	const nativeEgress = nativeEgressFixture();
	const receive = createProductionSessionSandboxReceiverV1(
		{ ...f.options, policy: { ...f.options.policy, nativeEgress } },
		{ serviceToken: sessionSandboxDeploymentTokenFixture },
	);
	nativeEgress.destinations[0].destination.ip = "1.1.1.1";
	await receive(f.claim, new AbortController().signal);
	const policy = f.resources.get(
		"NetworkPolicy/sandbox-allocation-a",
	) as V1NetworkPolicy;
	expect(JSON.stringify(policy.spec?.egress)).toContain("8.8.8.8/32");
	expect(JSON.stringify(policy.spec?.egress)).not.toContain("1.1.1.1/32");
	const changed = nativeEgressFixture();
	changed.protectedNetworks.platformDatabase = ["10.0.1.0/24"];
	const next = createProductionSessionSandboxReceiverV1(
		{ ...f.options, policy: { ...f.options.policy, nativeEgress: changed } },
		{ serviceToken: sessionSandboxDeploymentTokenFixture },
	);
	await expect(next(f.claim, new AbortController().signal)).rejects.toThrow();
});
