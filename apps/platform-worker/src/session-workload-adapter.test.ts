import { isDeepStrictEqual } from "node:util";
import { connectionConsumerProfileFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import type {
	SessionSandboxDeletionProgressV1,
	SessionSandboxLifecycleV1,
	SessionSandboxResourceIdentityV1,
} from "@agent-infra/platform-core";
import { sessionSandboxFileExchangeTokenV1 } from "@agent-infra/platform-core";
import type {
	KubernetesObject,
	V1NetworkPolicy,
	V1PersistentVolumeClaim,
	V1Pod,
	V1Secret,
	V1Service,
} from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
	createRuntimeConnectionConsumerSnapshotV1,
	runtimeConnectionConsumerAnnotation,
	runtimeConnectionConsumerFileEnvironment,
	runtimeConnectionInstallationRevisionEnvironment,
} from "./connection-consumer-projection.js";
import type {
	WorkerKubernetesClientV1,
	WorkloadResourceKind,
} from "./kubernetes-client.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-adapter.js";
import {
	bindSessionSandboxCustomSecretMaterializationV1,
	createSessionSandboxWorkloadAdapterV1,
	hasSessionSandboxIdentityV1,
	type SessionSandboxAllocationV1,
	type SessionSandboxRuntimeInputV1,
	sessionSandboxIdentityAnnotationsV1,
	sessionSandboxLabelsMatchV1,
	sessionSandboxLabelsV1,
	sessionSandboxResourcesV1,
	sessionSandboxSelectorMatchesV1,
	sessionSandboxServiceTokenV1,
} from "./session-workload-adapter.js";
import {
	sessionSandboxDeploymentTokenFixture,
	sessionSandboxRuntimeInputFixture,
} from "./test-support/session-sandbox-v4.js";
import {
	type WorkloadEgressDestinationV1,
	workloadEgressRulesV1,
} from "./workload-network.js";

const api = () => {
	const resources = new Map<string, KubernetesObject>();
	const key = (kind: string, name: string) => `${kind}/${name}`;
	const client: WorkerKubernetesClientV1 & {
		deleteResult: NonNullable<WorkerKubernetesClientV1["deleteResult"]>;
	} = {
		namespace: "workload-test",
		async read<T extends KubernetesObject>(
			kind: WorkloadResourceKind,
			name: string,
		): Promise<T | null> {
			return (resources.get(key(kind, name)) as T | undefined) ?? null;
		},
		async list<T extends KubernetesObject>(
			_kind: WorkloadResourceKind,
			_selector: string,
		): Promise<T[]> {
			return [];
		},
		async create<T extends KubernetesObject>(object: T): Promise<T> {
			object.metadata = {
				...object.metadata,
				uid: object.metadata?.uid ?? `uid-${resources.size}`,
				resourceVersion:
					object.metadata?.resourceVersion ?? String(resources.size + 1),
			};
			resources.set(
				key(object.kind ?? "", object.metadata?.name ?? ""),
				object,
			);
			return object;
		},
		async replace<T extends KubernetesObject>(object: T): Promise<T> {
			object.metadata = {
				...object.metadata,
				uid: object.metadata?.uid ?? `uid-${resources.size}`,
				resourceVersion:
					object.metadata?.resourceVersion ?? String(resources.size + 1),
			};
			resources.set(
				key(object.kind ?? "", object.metadata?.name ?? ""),
				object,
			);
			return object;
		},
		async delete(object: KubernetesObject) {
			resources.delete(key(object.kind ?? "", object.metadata?.name ?? ""));
		},
		async deleteResult(object: KubernetesObject) {
			resources.delete(key(object.kind ?? "", object.metadata?.name ?? ""));
			return "acknowledged" as const;
		},
	};
	return Object.assign(client, { resources });
};

const allocation: SessionSandboxAllocationV1 = {
	schemaVersion: 1,
	agentId: "agent-a",
	sessionId: "session-a",
	sandboxId: "sandbox-a",
	principal: { kind: "user", id: "actor-a" },
	channelId: "web",
	resourceName: "sandbox-sandbox-a",
	workspaceScope: "sandbox-a",
	generation: 3,
	resourceFence: 9,
	namespace: "workload-test",
	podName: "sandbox-sandbox-a",
	serviceName: "sandbox-sandbox-a",
	serviceAccountName: "sandbox-sandbox-a",
	pvcName: "sandbox-sandbox-a",
	networkPolicyName: "sandbox-sandbox-a",
	secretName: "sandbox-sandbox-a",
	egress: {},
	imageDigest: `registry.example.test/runtime@sha256:${"a".repeat(64)}`,
	authorizedIngressSelector: { component: "dispatcher" },
	containerPort: 8080,
	workspaceMountPath: "/workspace",
	resources: {
		requests: { cpu: "100m", memory: "128Mi" },
		limits: { cpu: "1", memory: "1Gi" },
	},
	storageSize: "1Gi",
	env: { SESSION_ID: "session-a" },
	runtime: sessionSandboxRuntimeInputFixture({
		agentId: "agent-a",
		namespace: "workload-test",
		sandboxId: "sandbox-a",
		codexContainerBoundaryEnabled: true,
	}),
	desiredState: "running",
};

describe("Sandbox identity for resources created before the managed label (#2691)", () => {
	const managedLabel = "agent-infra.agora.io/managed";
	const object = (labels: Record<string, string>) => ({
		metadata: {
			labels,
			annotations: { ...sessionSandboxIdentityAnnotationsV1(allocation) },
		},
	});
	const { [managedLabel]: _marker, ...legacy } =
		sessionSandboxLabelsV1(allocation);

	it("accepts the current labels and a legacy object without the marker", () => {
		expect(
			hasSessionSandboxIdentityV1(
				object({ ...sessionSandboxLabelsV1(allocation) }),
				allocation,
			),
		).toBe(true);
		expect(hasSessionSandboxIdentityV1(object(legacy), allocation)).toBe(true);
		expect(
			sessionSandboxSelectorMatchesV1(
				legacy,
				sessionSandboxLabelsV1(allocation),
			),
		).toBe(true);
	});

	it("rejects a foreign marker value, a missing identity label or an extra selector key", () => {
		expect(
			hasSessionSandboxIdentityV1(
				object({ ...legacy, [managedLabel]: "someone-else" }),
				allocation,
			),
		).toBe(false);
		const { "agent-infra.agora.io/generation": _generation, ...partial } =
			legacy;
		expect(hasSessionSandboxIdentityV1(object(partial), allocation)).toBe(
			false,
		);
		expect(
			sessionSandboxSelectorMatchesV1(
				{ ...legacy, extra: "x" },
				sessionSandboxLabelsV1(allocation),
			),
		).toBe(false);
		expect(
			sessionSandboxLabelsMatchV1(
				{ ...legacy, [managedLabel]: "someone-else" },
				sessionSandboxLabelsV1(allocation),
			),
		).toBe(false);
		// 没有 selector 的 Service 不能当作升级前的 Sandbox 路由，即使期望里只剩 managed 一个键。
		expect(
			sessionSandboxSelectorMatchesV1(undefined, {
				[managedLabel]: "session-sandbox-v1",
			}),
		).toBe(false);
		expect(
			sessionSandboxSelectorMatchesV1(
				undefined,
				sessionSandboxLabelsV1(allocation),
			),
		).toBe(false);
	});
});

function customAllocation(): SessionSandboxAllocationV1 {
	return {
		...allocation,
		runtime: {
			driver: "acp",
			modelConfiguration: "",
			workerId: "worker-a",
			grantKeyId: "grant-a",
			grantPublicKey: sessionSandboxRuntimeInputFixture({
				agentId: "agent-a",
				namespace: "workload-test",
				sandboxId: "sandbox-a",
			}).grantPublicKey,
			grantIssuer: "issuer-a",
			serviceToken: sessionSandboxRuntimeInputFixture({
				agentId: "agent-a",
				namespace: "workload-test",
				sandboxId: "sandbox-a",
			}).serviceToken,
			custom: {
				secretRefs: [
					{
						schemaVersion: 1,
						ownerType: "agent-owner",
						ownerId: "actor-a",
						agentId: "agent-a",
						secretId: "owner-secret",
						secretVersion: 1,
						configRevision: 1,
						algorithmVersion: "aes-256-gcm:v1",
						wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
						wrappingKeyVersion: "key-a",
						name: "owner-secret-k8s",
					},
				],
			},
		},
	};
}

it("materializes custom Owner Secret values only into the Session Secret", () => {
	const custom = customAllocation();
	bindSessionSandboxCustomSecretMaterializationV1(custom, {
		data: { MODEL_API_KEY: "redacted-test-value" },
		environmentNames: ["MODEL_API_KEY"],
	});
	const resources = sessionSandboxResourcesV1(custom);
	const secret = resources.find(
		(resource) => resource.kind === "Secret",
	) as V1Secret;
	const pod = resources.find((resource) => resource.kind === "Pod") as V1Pod;
	expect(
		pod.spec?.containers[0]?.env?.find(
			(entry) => entry.name === "AGENT_INFRA_RUNTIME_DRIVER",
		),
	).toEqual({ name: "AGENT_INFRA_RUNTIME_DRIVER", value: "acp" });
	expect(
		pod.spec?.containers[0]?.env?.some(
			(entry) => entry.name === "AGENT_INFRA_RUNTIME_MODEL_CONFIG",
		),
	).toBe(false);
	expect(secret.data?.MODEL_API_KEY).toBe(
		Buffer.from("redacted-test-value").toString("base64"),
	);
	expect(
		pod.spec?.containers[0]?.env?.find(
			(entry) => entry.name === "MODEL_API_KEY",
		),
	).toMatchObject({
		valueFrom: {
			secretKeyRef: { name: custom.secretName, key: "MODEL_API_KEY" },
		},
	});
	expect(JSON.stringify(pod)).not.toContain("redacted-test-value");
});

async function retainedCustomPVCFixture(sourceStatus: "ready" | "stopped") {
	const client = api();
	const adapter = createSessionSandboxWorkloadAdapterV1({ client });
	const source = customAllocation();
	const materialization = {
		data: { MODEL_API_KEY: "synthetic-resume-secret" },
		environmentNames: ["MODEL_API_KEY"],
	};
	bindSessionSandboxCustomSecretMaterializationV1(source, materialization);
	await adapter.apply(source);
	const observed = await adapter.observe(source);
	const progress = new Map<string, SessionSandboxDeletionProgressV1>();
	const target = { ...source, resourceFence: source.resourceFence + 1 };
	const receipt = await adapter.cleanup(source, observed.resources, {
		sourceGeneration: source.generation,
		sourceResourceFence: source.resourceFence,
		targetGeneration: target.generation,
		targetResourceFence: target.resourceFence,
		managementFence: 1,
		async recordDeletionProgress(value) {
			progress.set(value.resource.kind, value);
			return "committed";
		},
	});
	const pvc = receipt.retainedPVC;
	if (!pvc) throw new Error("Expected retained PVC");
	bindSessionSandboxCustomSecretMaterializationV1(target, materialization);
	const lifecycle: SessionSandboxLifecycleV1 = {
		schemaVersion: 1,
		reason: "idle_reclaim",
		resumeRequested: true,
		authority: {
			kind: "management",
			applicationId: "application-a",
			managementRevision: 1,
			managementFence: 1,
			workloadRevision: 1,
			targetDesiredState: "running",
		},
		source: {
			sandbox: {
				schemaVersion: 1,
				agentId: source.agentId,
				sessionId: source.sessionId,
				sandboxId: source.sandboxId,
				principal: source.principal,
				channelId: source.channelId,
				generation: source.generation,
				resourceName: source.resourceName,
				workspaceScope: source.workspaceScope,
			},
			resourceFence: source.resourceFence,
			policy: {
				namespace: source.namespace,
				resourceConfigurationHash: "policy",
				configurationRevision: 1,
				workloadRevision: 1,
				managementFence: 1,
				imageDigest: `sha256:${"a".repeat(64)}`,
			},
			observation: {
				status: sourceStatus,
				resources: sourceStatus === "ready" ? observed.resources : [pvc],
			},
		},
		stopReceipt: {
			...receipt,
			removed: sourceStatus === "ready" ? receipt.removed : [],
		},
		deletionProgress: sourceStatus === "ready" ? [...progress.values()] : [],
		preparation: {
			generation: target.generation,
			resourceFence: target.resourceFence,
		},
	};
	return { client, adapter, source, target, lifecycle, pvc };
}

describe("custom retained PVC rebind (#3305)", () => {
	it.each(["ready", "stopped"] as const)(
		"resumes a %s source without rendering credentials for its copied allocation",
		async (sourceStatus) => {
			const { client, adapter, target, lifecycle, pvc } =
				await retainedCustomPVCFixture(sourceStatus);
			await expect(
				adapter.prepareRetainedPVC(target, lifecycle, [pvc]),
			).resolves.toBeUndefined();
			const retained = await client.read("PersistentVolumeClaim", pvc.name);
			if (!retained) throw new Error("Expected retained PVC");
			expect(retained?.metadata).toMatchObject({
				uid: pvc.uid,
				resourceVersion: pvc.resourceVersion,
				annotations: {
					"agent-infra.agora.io/fence": String(target.resourceFence),
				},
			});
			expect(hasSessionSandboxIdentityV1(retained, target)).toBe(true);
			expect(JSON.stringify(lifecycle)).not.toContain(
				"synthetic-resume-secret",
			);
			expect(JSON.stringify(retained)).not.toContain("synthetic-resume-secret");
			// Rebinding a PVC must not make Secret material transferable to another object.
			expect(() => sessionSandboxResourcesV1({ ...target })).toThrow();
			await adapter.apply(target);
			expect(
				(await client.read("PersistentVolumeClaim", pvc.name))?.metadata?.uid,
			).toBe(pvc.uid);
		},
	);

	it("rejects a replaced retained PVC before rebinding it", async () => {
		const { client, adapter, target, lifecycle, pvc } =
			await retainedCustomPVCFixture("ready");
		const retained = await client.read("PersistentVolumeClaim", pvc.name);
		if (!retained?.metadata) throw new Error("Expected retained PVC");
		retained.metadata.uid = "unrelated-pvc";
		await expect(
			adapter.prepareRetainedPVC(target, lifecycle, [pvc]),
		).rejects.toMatchObject({ code: "conflict" });
		expect(retained.metadata.annotations?.["agent-infra.agora.io/fence"]).toBe(
			String(target.resourceFence - 1),
		);
	});
});

describe("session sandbox workload adapter", () => {
	it("projects a complete approved file on the real Session Pod and rejects drift without changing cleanup authority", async () => {
		const profile = {
			schemaVersion: 1 as const,
			publicOrigin: "https://connection.example.test",
			mcpPath: "/mcp",
			consumerId: "platform-consumer",
			audience: "connection-resource",
			egressProfile: { ref: "approved-egress", revision: "r1" },
		};
		const snapshot = createRuntimeConnectionConsumerSnapshotV1(profile, {
			schemaVersion: 1,
			configFingerprint: connectionConsumerProfileFingerprintV1(profile),
			egressEnforced: true,
			source: { ref: "approved-deployment", revision: "r1" },
		});
		const installationRevision = JSON.stringify([
			"private-session-supply",
			"r7",
		]);
		const selected = {
			...allocation,
			connectionConsumerSnapshot: snapshot,
			connectionInstallationRevision: installationRevision,
		};
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(selected);
		const pod = await client.read<V1Pod>("Pod", selected.podName);
		if (!pod?.spec || !pod.metadata) throw new Error("Missing fixture Pod");
		expect(
			pod.metadata.annotations?.[runtimeConnectionConsumerAnnotation],
		).toBe(snapshot);
		expect(pod.spec.containers[0]?.env).toContainEqual({
			name: runtimeConnectionConsumerFileEnvironment,
			value: "/var/run/agent-infra/connection-consumer/snapshot.json",
		});
		expect(
			pod.spec.containers[0]?.volumeMounts?.find(
				(item) => item.name === "connection-consumer",
			)?.readOnly,
		).toBe(true);
		pod.status = {
			phase: "Running",
			conditions: [{ type: "Ready", status: "True" }],
		};
		expect((await adapter.observe(selected)).status).toBe("ready");
		const installation = pod.spec.containers[0]?.env?.find(
			(entry) =>
				entry.name === runtimeConnectionInstallationRevisionEnvironment,
		);
		if (!installation) throw new Error("Missing installation selector");
		expect(installation.value).toBe(installationRevision);
		for (const changed of [
			["other-supply", "r7"],
			["private-session-supply", "r8"],
		]) {
			installation.value = JSON.stringify(changed);
			expect((await adapter.observe(selected)).status).toBe("unknown");
			await expect(adapter.apply(selected)).rejects.toThrow();
		}
		installation.value = installationRevision;
		const updatedApproval = {
			schemaVersion: 1,
			configFingerprint: connectionConsumerProfileFingerprintV1(profile),
			egressEnforced: true,
			source: { ref: "approved-deployment", revision: "r2" },
		};
		const updatedSnapshot = createRuntimeConnectionConsumerSnapshotV1(
			profile,
			updatedApproval,
		);
		pod.metadata.annotations = {
			...pod.metadata.annotations,
			[runtimeConnectionConsumerAnnotation]: updatedSnapshot ?? "",
		};
		// Downward API may update the file, but it cannot change the old process's
		// immutable PodSpec revision or captured Host snapshot.
		expect(
			(
				await adapter.observe({
					...selected,
					connectionConsumerSnapshot: updatedSnapshot,
				})
			).status,
		).toBe("unknown");
		pod.metadata.annotations = {
			...pod.metadata.annotations,
			[runtimeConnectionConsumerAnnotation]: "{}",
		};
		expect((await adapter.observe(selected)).status).toBe("unknown");
		await expect(adapter.apply(selected)).rejects.toThrow();
		const previous = (await adapter.observe(selected)).resources;
		const unavailable = {
			...selected,
			connectionConsumerSnapshot: null,
			connectionInstallationRevision: null,
			env: {
				...selected.env,
				[runtimeConnectionConsumerFileEnvironment]: "/invalid-current-config",
				[runtimeConnectionInstallationRevisionEnvironment]: '["caller","r9"]',
			},
		};
		const controlObservation = await adapter.observe(
			unavailable,
			previous,
			"control",
		);
		expect(controlObservation.status).toBe("observed");
		expect(controlObservation.resources).toHaveLength(6);
		await adapter.cleanup(unavailable, previous, {
			recordDeletionProgress: async () => "committed",
		});
		expect(await client.read("Pod", selected.podName)).toBeNull();
	});
	it("refuses to apply a running allocation without runtime before any write (#2885)", async () => {
		// 只有排空（stopped）允许 runtime 为 null；运行中缺 runtime 会建出缺 Secret / env 的 Pod。
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await expect(
			adapter.apply({ ...allocation, desiredState: "running", runtime: null }),
		).rejects.toThrow();
		expect(await client.read("Pod", allocation.podName)).toBeNull();
		expect(await client.read("Secret", allocation.secretName)).toBeNull();
		// 排空中的旧 payload：只用于按名称与标签删除，Secret 不带数据。
		const secret = sessionSandboxResourcesV1({
			...allocation,
			desiredState: "stopped",
			runtime: null,
		}).find((resource) => resource.kind === "Secret") as
			| { data?: unknown }
			| undefined;
		expect(secret).toBeDefined();
		expect(secret?.data).toBeUndefined();
	});
	it("rejects a Session env file override before Pod creation", () => {
		expect(() =>
			sessionSandboxResourcesV1({
				...allocation,
				env: { [runtimeConnectionConsumerFileEnvironment]: "/caller" },
			}),
		).toThrow();
	});
	it("rejects caller Session installation selection and invalid source before rendering", () => {
		for (const input of [
			{
				...allocation,
				env: {
					[runtimeConnectionInstallationRevisionEnvironment]: '["caller","r1"]',
				},
			},
			{ ...allocation, connectionInstallationRevision: null },
			{ ...allocation, connectionInstallationRevision: '["unapproved","r1"]' },
		])
			expect(() => sessionSandboxResourcesV1(input)).toThrow();
	});
	it("renders one Pod, Service, SA, retained PVC, isolated NetworkPolicy and own Secret with allocation fence", () => {
		const resources = sessionSandboxResourcesV1(allocation);
		expect(resources.map((resource) => resource.kind)).toEqual([
			"ServiceAccount",
			"PersistentVolumeClaim",
			"NetworkPolicy",
			"Service",
			"Secret",
			"Pod",
		]);
		for (const resource of resources) {
			expect(resource.metadata?.labels).toEqual(
				sessionSandboxLabelsV1(allocation),
			);
			expect(resource.metadata?.annotations).toMatchObject({
				"agent-infra.agora.io/agent-id": "agent-a",
				"agent-infra.agora.io/session-id": "session-a",
			});
			expect(
				resource.metadata?.annotations?.["agent-infra.agora.io/fence"],
			).toBe("9");
		}
		const pvc = resources[1];
		expect(pvc.spec?.accessModes).toEqual(["ReadWriteOnce"]);
		expect(resources[2].spec?.ingress).toMatchObject([
			{ ports: [{ port: 8080 }] },
		]);
		expect(resources[2].spec?.egress).toEqual([]);
	});

	it("converges independent resources concurrently and creates the Pod in the second wave", async () => {
		const client = api();
		const read = client.read.bind(client);
		const create = client.create.bind(client);
		let active = 0;
		let maximum = 0;
		const creates: string[] = [];
		const delay = () => new Promise((resolve) => setTimeout(resolve, 5));
		client.read = async (kind, name) => {
			active++;
			maximum = Math.max(maximum, active);
			try {
				await delay();
				return await read(kind, name);
			} finally {
				active--;
			}
		};
		client.create = async (object) => {
			creates.push(object.kind ?? "");
			await delay();
			return create(object);
		};
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });

		await adapter.apply(allocation);
		expect(maximum).toBeGreaterThan(1);
		const podCreate = creates.indexOf("Pod");
		expect(podCreate).toBeGreaterThan(-1);
		for (const kind of [
			"ServiceAccount",
			"PersistentVolumeClaim",
			"NetworkPolicy",
			"Service",
			"Secret",
		])
			expect(creates.indexOf(kind)).toBeLessThan(podCreate);

		maximum = 0;
		await adapter.observe(allocation);
		expect(maximum).toBeGreaterThan(1);
	});

	it("settles every parallel convergence before surfacing a failure", async () => {
		const client = api();
		const read = client.read.bind(client);
		const create = client.create.bind(client);
		const delay = () => new Promise((resolve) => setTimeout(resolve, 20));
		let active = 0;
		client.read = async (kind, name) => {
			active++;
			try {
				await delay();
				return await read(kind, name);
			} finally {
				active--;
			}
		};
		client.create = async (object) => {
			if (object.kind === "ServiceAccount") throw new Error("boom");
			return create(object);
		};
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });

		await expect(adapter.apply(allocation)).rejects.toThrow("boom");
		expect(active).toBe(0);
	});

	it("applies the same deployment-approved egress as the Agent Workload (#1445)", async () => {
		const egress = {
			dnsEgress: [
				{ namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
			],
			modelEgress: [{ destination: { cidr: "8.8.8.0/24" }, port: 443 }],
			connectionEgress: [
				{
					destination: {
						namespace: "connection",
						podLabels: { "app.kubernetes.io/name": "connection-api" },
					},
					port: 3002,
				},
			],
		};
		const approved = { ...allocation, egress };
		const [, , policy] = sessionSandboxResourcesV1(approved);
		expect(policy.spec?.policyTypes).toEqual(["Ingress", "Egress"]);
		expect(policy.spec?.egress).toEqual(workloadEgressRulesV1(egress));
		expect(policy.spec?.ingress).toEqual([
			{
				_from: [{ podSelector: { matchLabels: { component: "dispatcher" } } }],
				ports: [{ protocol: "TCP", port: 8080 }],
			},
		]);
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(approved);
		const live = await client.read<V1NetworkPolicy>(
			"NetworkPolicy",
			approved.networkPolicyName,
		);
		expect(live?.spec?.egress).toEqual(workloadEgressRulesV1(egress));
		// The same live object no longer matches an allocation without approval.
		await expect(adapter.apply(allocation)).rejects.toMatchObject({
			code: "conflict",
		});
	});

	it.each([
		["unknown policy field", { ...allocation, egress: { anyEgress: [] } }],
		[
			"arbitrary CIDR destination",
			{
				...allocation,
				egress: {
					modelEgress: [{ destination: { ip: "0.0.0.0/0" }, port: 443 }],
				},
			},
		],
		[
			"reserved CIDR destination",
			{
				...allocation,
				egress: {
					modelEgress: [{ destination: { cidr: "4000::/48" }, port: 443 }],
				},
			},
		],
		[
			"CIDR without port",
			{
				...allocation,
				egress: {
					modelEgress: [{ destination: { cidr: "8.8.8.0/24" } } as never],
				},
			},
		],
		[
			"missing port",
			{
				...allocation,
				egress: { modelEgress: [{ destination: { ip: "203.0.113.10" } }] },
			},
		],
		["missing egress", { ...allocation, egress: undefined }],
	])("rejects %s before any resource write", async (_name, invalid) => {
		const client = api();
		let writes = 0;
		const adapter = createSessionSandboxWorkloadAdapterV1({
			client: {
				...client,
				async create(object) {
					writes++;
					return client.create(object);
				},
			},
		});
		await expect(
			adapter.apply(invalid as unknown as SessionSandboxAllocationV1),
		).rejects.toMatchObject({ code: "policy" });
		expect(writes).toBe(0);
	});

	it.each(["added", "removed", "changed"] as const)(
		"fails closed when live Session egress is %s",
		async (mutation) => {
			const egress = {
				modelEgress: [{ destination: { ip: "203.0.113.10" }, port: 443 }],
			};
			const approved = { ...allocation, egress };
			const client = api();
			const adapter = createSessionSandboxWorkloadAdapterV1({ client });
			await adapter.apply(approved);
			const pod = await client.read<V1Pod>("Pod", approved.podName);
			if (!pod) throw new Error("Missing Pod");
			pod.status = {
				phase: "Running",
				conditions: [{ type: "Ready", status: "True" }],
			};
			const before = await adapter.observe(approved);
			expect(before.status).toBe("ready");
			const live = await client.read<V1NetworkPolicy>(
				"NetworkPolicy",
				approved.networkPolicyName,
			);
			if (!live?.spec) throw new Error("Missing NetworkPolicy");
			const rules = live.spec.egress ?? [];
			live.spec.egress =
				mutation === "added"
					? [...rules, { to: [{ ipBlock: { cidr: "198.51.100.7/32" } }] }]
					: mutation === "removed"
						? []
						: [
								{
									to: [{ ipBlock: { cidr: "198.51.100.7/32" } }],
									ports: [{ protocol: "TCP", port: 443 }],
								},
							];
			let writes = 0;
			const guarded = createSessionSandboxWorkloadAdapterV1({
				client: {
					...client,
					async replace(object) {
						writes++;
						return client.replace(object);
					},
					async create(object) {
						writes++;
						return client.create(object);
					},
				},
			});
			expect((await guarded.observe(approved, before.resources)).status).toBe(
				"unknown",
			);
			await expect(
				guarded.apply(approved, before.resources),
			).rejects.toMatchObject({ code: "conflict" });
			expect(writes).toBe(0);
		},
	);

	it("bounds selector labels for real platform Agent IDs (#1461)", () => {
		const agentId = `agent_${"a9".repeat(32)}`;
		const sandboxId = "d45cdac5-4766-40f7-976b-bac05dd9c1db";
		const real = {
			...allocation,
			agentId,
			sessionId: "d02d3ce7-0276-4f8b-8e83-64cd53b7533a",
			sandboxId,
			resourceName: `sandbox-${sandboxId}`,
			workspaceScope: sandboxId,
			podName: `sandbox-${sandboxId}`,
			serviceName: `sandbox-${sandboxId}`,
			serviceAccountName: `sandbox-${sandboxId}`,
			pvcName: `sandbox-${sandboxId}`,
			networkPolicyName: `sandbox-${sandboxId}`,
			secretName: `sandbox-${sandboxId}`,
			runtime: sessionSandboxRuntimeInputFixture({
				agentId,
				namespace: allocation.namespace,
				sandboxId,
			}),
		};
		expect(agentId).toHaveLength(70);
		const kubernetesLabelValue =
			/^(?:[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/;
		for (const resource of sessionSandboxResourcesV1(real)) {
			const selectors = [
				resource.metadata?.labels ?? {},
				(resource as V1Service).spec?.selector ?? {},
				(resource as V1NetworkPolicy).spec?.podSelector?.matchLabels ?? {},
			];
			for (const selector of selectors)
				for (const value of Object.values(selector))
					expect(value).toMatch(kubernetesLabelValue);
			expect(resource.metadata?.labels).toEqual({
				"agent-infra.agora.io/managed": "session-sandbox-v1",
				"agent-infra.agora.io/agent-ref": workloadResourceNameV1(agentId),
				"agent-infra.agora.io/session-ref": expect.stringMatching(
					/^session-[a-f0-9]{32}$/,
				),
				"agent-infra.agora.io/sandbox-id": sandboxId,
				"agent-infra.agora.io/generation": "3",
			});
			expect(resource.metadata?.annotations).toMatchObject({
				"agent-infra.agora.io/agent-id": agentId,
				"agent-infra.agora.io/session-id": real.sessionId,
			});
		}
	});

	it("is never selected by the Agent-level Workload selectors", () => {
		const [, , , , , pod] = sessionSandboxResourcesV1(allocation);
		const podLabels = pod.metadata?.labels ?? {};
		const agentSelector = {
			"agent-infra.agora.io/agent": workloadResourceNameV1(allocation.agentId),
		};
		expect(
			Object.entries(agentSelector).every(
				([key, value]) => podLabels[key] === value,
			),
		).toBe(false);
		expect(Object.hasOwn(podLabels, "agent-infra.agora.io/agent")).toBe(false);
	});

	it.each(["agent-infra.agora.io/agent-id", "agent-infra.agora.io/session-id"])(
		"treats a same-label resource with a different exact %s as foreign",
		async (annotation) => {
			const client = api();
			const adapter = createSessionSandboxWorkloadAdapterV1({ client });
			await adapter.apply(allocation);
			const service = await client.read<V1Service>(
				"Service",
				allocation.serviceName,
			);
			if (!service?.metadata?.annotations) throw new Error("Missing Service");
			service.metadata.annotations[annotation] = "colliding-identity";
			await expect(adapter.apply(allocation)).rejects.toMatchObject({
				code: "conflict",
			});
			await expect(adapter.observe(allocation)).resolves.toMatchObject({
				status: "unknown",
			});
		},
	);

	it("keeps two Session allocations fully disjoint under one Agent", () => {
		const second: SessionSandboxAllocationV1 = {
			...allocation,
			sessionId: "session-b",
			sandboxId: "sandbox-b",
			principal: { kind: "user", id: "actor-b" },
			channelId: "api",
			resourceName: "sandbox-sandbox-b",
			workspaceScope: "sandbox-b",
			generation: 1,
			resourceFence: 12,
			podName: "sandbox-sandbox-b",
			serviceName: "sandbox-sandbox-b",
			serviceAccountName: "sandbox-sandbox-b",
			pvcName: "sandbox-sandbox-b",
			networkPolicyName: "sandbox-sandbox-b",
			secretName: "sandbox-sandbox-b",
			env: { SESSION_ID: "session-b" },
			runtime: sessionSandboxRuntimeInputFixture({
				agentId: allocation.agentId,
				namespace: allocation.namespace,
				sandboxId: "sandbox-b",
			}),
		};
		const firstResources = sessionSandboxResourcesV1(allocation);
		const secondResources = sessionSandboxResourcesV1(second);
		const firstNames = new Set(
			firstResources.map(
				(resource) => `${resource.kind}/${resource.metadata?.name}`,
			),
		);
		const secondNames = new Set(
			secondResources.map(
				(resource) => `${resource.kind}/${resource.metadata?.name}`,
			),
		);
		expect([...firstNames].filter((name) => secondNames.has(name))).toEqual([]);
		expect(firstResources[1].spec?.volumeMode).toBeUndefined();
		// Each Sandbox gets its own derived token; neither is the deployment token.
		expect(firstResources[4].data?.token).not.toBe(
			secondResources[4].data?.token,
		);
		for (const secret of [firstResources[4], secondResources[4]])
			expect(
				Buffer.from(secret.data?.token ?? "", "base64").toString(),
			).not.toBe(sessionSandboxDeploymentTokenFixture);
		expect(firstResources[5].spec?.containers[0]?.workingDir).toBeUndefined();
		expect(firstResources[2].spec?.podSelector).toEqual({
			matchLabels: firstResources[5].metadata?.labels,
		});
		expect(secondResources[2].spec?.podSelector).toEqual({
			matchLabels: secondResources[5].metadata?.labels,
		});
		expect(firstResources[5].spec?.volumes?.[0]?.persistentVolumeClaim).toEqual(
			{
				claimName: allocation.pvcName,
			},
		);
		expect(
			secondResources[5].spec?.volumes?.[0]?.persistentVolumeClaim,
		).toEqual({
			claimName: second.pvcName,
		});
	});

	it("reconciles an unknown attempt from absence without changing its identity", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const observed = await adapter.observe(allocation);
		const pod = observed.resources.find((resource) => resource.kind === "Pod");
		if (!pod) throw new Error("Missing Pod observation");
		const originalResourceVersion = pod.resourceVersion;
		await client.delete({
			kind: "Pod",
			metadata: { name: allocation.podName },
		});
		const intent: SessionSandboxDeletionProgressV1 = {
			schemaVersion: 1,
			state: "unknown",
			deleteAttemptId: "attempt-lost",
			deleteAttempted: true,
			deleteCallResult: "unknown",
			sourceGeneration: allocation.generation,
			resourceFence: allocation.resourceFence,
			managementFence: 4,
			resource: pod,
			preconditions: { uid: pod.uid, resourceVersion: originalResourceVersion },
		};
		const progress: SessionSandboxDeletionProgressV1[] = [];
		await adapter.cleanup(allocation, observed.resources, {
			managementFence: 4,
			deletionProgress: [intent],
			recordDeletionProgress: async (entry) => {
				progress.push(entry);
				return "committed";
			},
		});
		const recovered = progress.find((entry) => entry.resource.kind === "Pod");
		expect(recovered).toMatchObject({
			state: "absent",
			deleteAttemptId: "attempt-lost",
			deleteCallResult: "unknown",
			preconditions: intent.preconditions,
		});
	});

	it("records an already-absent owned resource without a prior delete attempt", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const observed = await adapter.observe(allocation);
		const pod = observed.resources.find((resource) => resource.kind === "Pod");
		if (!pod) throw new Error("Missing Pod observation");
		await client.delete({
			kind: "Pod",
			metadata: { name: allocation.podName },
		});
		const progress: SessionSandboxDeletionProgressV1[] = [];
		await adapter.cleanup(allocation, observed.resources, {
			managementFence: 4,
			recordDeletionProgress: async (entry) => {
				progress.push(entry);
				return "committed";
			},
		});
		expect(
			progress.filter((entry) => entry.resource.kind === "Pod").at(-1),
		).toMatchObject({
			state: "absent",
			deleteAttempted: true,
			deleteCallResult: "unknown",
		});
	});

	it("fails closed when an existing delete attempt sees resourceVersion drift", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const observed = await adapter.observe(allocation);
		const pod = observed.resources.find((resource) => resource.kind === "Pod");
		if (!pod) throw new Error("Missing Pod observation");
		const current = await client.read("Pod", allocation.podName);
		if (!current?.metadata) throw new Error("Missing Pod resource");
		current.metadata.resourceVersion = "drifted";
		const intent: SessionSandboxDeletionProgressV1 = {
			schemaVersion: 1,
			state: "delete-requested",
			deleteAttemptId: "attempt-drift",
			deleteAttempted: false,
			deleteCallResult: "not-attempted",
			sourceGeneration: allocation.generation,
			resourceFence: allocation.resourceFence,
			managementFence: 4,
			resource: pod,
			preconditions: { uid: pod.uid, resourceVersion: pod.resourceVersion },
		};
		await expect(
			adapter.cleanup(allocation, observed.resources, {
				managementFence: 4,
				deletionProgress: [intent],
				recordDeletionProgress: async () => "committed",
			}),
		).rejects.toMatchObject({ code: "conflict" });
	});

	it("does not downgrade an acknowledged delete after a later call error", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const observed = await adapter.observe(allocation);
		const pod = observed.resources.find((resource) => resource.kind === "Pod");
		if (!pod) throw new Error("Missing Pod observation");
		const acknowledged: SessionSandboxDeletionProgressV1 = {
			schemaVersion: 1,
			state: "delete-requested",
			deleteAttemptId: "attempt-ack",
			deleteAttempted: true,
			deleteCallResult: "acknowledged",
			sourceGeneration: allocation.generation,
			resourceFence: allocation.resourceFence,
			managementFence: 4,
			resource: pod,
			preconditions: { uid: pod.uid, resourceVersion: pod.resourceVersion },
		};
		const originalDeleteResult = client.deleteResult;
		client.deleteResult = async (resource) => {
			if (resource.kind === "Pod") throw new Error("delete transport lost");
			return originalDeleteResult(resource);
		};
		const progress: SessionSandboxDeletionProgressV1[] = [];
		await expect(
			adapter.cleanup(allocation, observed.resources, {
				managementFence: 4,
				deletionProgress: [acknowledged],
				recordDeletionProgress: async (entry) => {
					progress.push(entry);
					return "committed";
				},
			}),
		).rejects.toThrow("delete transport lost");
		expect(
			progress.every((entry) => entry.deleteCallResult === "acknowledged"),
		).toBe(true);
	});

	it("creates idempotently and rejects a stale fence or foreign resource", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		await expect(adapter.apply(allocation)).resolves.toEqual({
			sandboxId: "sandbox-a",
			generation: 3,
			resourceFence: 9,
		});
		await expect(
			adapter.apply({ ...allocation, resourceFence: 8 }),
		).rejects.toMatchObject({ code: "conflict" });
	});

	it("serves the Session Pod over in-cluster HTTP without TLS material (ADR-0020)", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const pod = await client.read<V1Pod>("Pod", allocation.podName);
		const container = pod?.spec?.containers[0];
		expect(container?.readinessProbe?.httpGet?.scheme).toBe("HTTP");
		expect(
			container?.volumeMounts?.map(({ mountPath }) => mountPath),
		).not.toContain("/var/run/agent-infra/runtime-tls");
		expect(pod?.spec?.volumes?.some((volume) => volume.secret)).toBe(false);
		await expect(adapter.observe(allocation)).resolves.not.toMatchObject({
			status: "unknown",
		});
	});

	it("retains a matching allocated Service without replacing it during an unready Pod retry", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const service = await client.read<
			import("@kubernetes/client-node").V1Service
		>("Service", allocation.serviceName);
		if (!service?.spec) throw new Error("Missing fixture Service");
		Object.assign(service.spec, {
			clusterIP: "10.43.0.17",
			clusterIPs: ["10.43.0.17"],
			ipFamilies: ["IPv4"],
			ipFamilyPolicy: "SingleStack",
		});
		const before = structuredClone(service);
		const retry = createSessionSandboxWorkloadAdapterV1({
			client: {
				...client,
				async replace(object) {
					if (object.kind === "Service")
						throw new Error("K3s Service replace 409");
					return client.replace(object);
				},
			},
		});
		await expect(retry.apply(allocation)).resolves.toMatchObject({
			sandboxId: allocation.sandboxId,
		});
		expect(await client.read("Service", allocation.serviceName)).toEqual(
			before,
		);
	});
	it("accepts the previous five-second readiness probe during rollout", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const pod = await client.read<V1Pod>("Pod", allocation.podName);
		if (!pod?.spec?.containers[0]?.readinessProbe)
			throw new Error("Missing Session Pod readiness probe");
		// Existing Pods are allowed to finish under the fenced lifecycle. The
		// compatibility is limited to the exact former period; other probe drift
		// remains unknown/conflict.
		pod.spec.containers[0].readinessProbe.periodSeconds = 5;
		expect((await adapter.observe(allocation)).status).toBe("observed");
		await expect(adapter.apply(allocation)).resolves.toMatchObject({
			sandboxId: allocation.sandboxId,
			generation: allocation.generation,
			resourceFence: allocation.resourceFence,
		});
		pod.spec.containers[0].readinessProbe.timeoutSeconds = 2;
		expect((await adapter.observe(allocation)).status).toBe("unknown");
	});

	it("classifies bounded Pod startup evidence without retaining container messages", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const pod = await client.read<V1Pod>("Pod", allocation.podName);
		if (!pod) throw new Error("Missing Session Pod");
		pod.status = {
			phase: "Pending",
			containerStatuses: [
				{
					name: "agent",
					ready: false,
					restartCount: 0,
					image: allocation.imageDigest,
					imageID: "",
					state: { waiting: { reason: "ImagePullBackOff", message: "secret" } },
				},
			],
		};
		const container = pod.status.containerStatuses?.[0];
		if (!container) throw new Error("Missing Session Pod container status");
		expect(await adapter.observe(allocation)).toMatchObject({
			status: "observed",
			failureCode: "eci.image_pull",
		});
		container.state = {
			waiting: { reason: "CreateContainerConfigError", message: "private" },
		};
		expect(await adapter.observe(allocation)).toMatchObject({
			status: "observed",
			failureCode: "runtime.configuration",
		});
	});

	it("records each resource identity and blocks UID drift before any mutation", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const before = await adapter.observe(allocation);
		expect(before.resources).toHaveLength(6);
		expect(
			new Set(before.resources.map((resource) => resource.kind)).size,
		).toBe(6);
		for (const identity of before.resources) {
			expect(identity).toMatchObject({
				namespace: allocation.namespace,
				name: allocation.resourceName,
			});
			expect(identity.uid).toBeTruthy();
			expect(identity.resourceVersion).toBeTruthy();
		}
		const service = await client.read("Service", allocation.serviceName);
		if (!service?.metadata) throw new Error("Missing fixture service");
		service.metadata.uid = "replacement-service";
		let writes = 0;
		const guarded = createSessionSandboxWorkloadAdapterV1({
			client: {
				...client,
				async replace(object) {
					writes++;
					return client.replace(object);
				},
				async create(object) {
					writes++;
					return client.create(object);
				},
				async delete(object) {
					writes++;
					return client.delete(object);
				},
			},
		});
		await expect(
			guarded.apply(allocation, before.resources),
		).rejects.toMatchObject({ code: "conflict" });
		expect(writes).toBe(0);
		await expect(
			guarded.observe(allocation, before.resources),
		).resolves.toMatchObject({ status: "unknown" });
	});

	it("accepts resourceVersion progress for the same UID and reports the new version", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const before = await adapter.observe(allocation);
		const pod = await client.read<V1Pod>("Pod", allocation.podName);
		if (!pod?.metadata) throw new Error("Missing fixture Pod");
		pod.metadata.resourceVersion = "next-version";
		pod.status = {
			phase: "Running",
			conditions: [{ type: "Ready", status: "True" }],
		};
		const after = await adapter.observe(allocation, before.resources);
		expect(after.status).toBe("ready");
		expect(
			after.resources.find((resource) => resource.kind === "Pod")
				?.resourceVersion,
		).toBe("next-version");
	});

	it("does not recreate a missing previously observed Pod without Store recovery", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const before = await adapter.observe(allocation);
		const pod = await client.read("Pod", allocation.podName);
		if (!pod) throw new Error("Missing fixture Pod");
		await client.delete(pod);
		await expect(
			adapter.apply(allocation, before.resources),
		).rejects.toMatchObject({ code: "conflict" });
		await expect(client.read("Pod", allocation.podName)).resolves.toBeNull();
	});

	it("closes Pod, Service and Secret before stopped state returns", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		await adapter.apply({ ...allocation, desiredState: "stopped" });
		await expect(client.read("Pod", allocation.podName)).resolves.toBeNull();
		await expect(
			client.read("Service", allocation.serviceName),
		).resolves.toBeNull();
		await expect(
			client.read("Secret", allocation.secretName),
		).resolves.toBeNull();
		await expect(
			client.read("PersistentVolumeClaim", allocation.pvcName),
		).resolves.toMatchObject({ metadata: { name: allocation.pvcName } });
	});

	it("reports pending until the owned Pod is ready and rejects foreign ownership", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		await expect(adapter.observe(allocation)).resolves.toMatchObject({
			status: "observed",
		});
		const pod = (await client.read("Pod", allocation.podName)) as V1Pod;
		pod.status = {
			phase: "Running",
			conditions: [{ type: "Ready", status: "True" }],
		};
		await expect(adapter.observe(allocation)).resolves.toMatchObject({
			status: "ready",
		});
		pod.metadata = {
			...pod.metadata,
			annotations: {
				...pod.metadata?.annotations,
				"agent-infra.agora.io/fence": "old",
			},
		};
		await expect(adapter.observe(allocation)).resolves.toMatchObject({
			status: "unknown",
		});
	});

	it("reports unknown when an owned resource is terminating", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const pod = await client.read("Pod", allocation.podName);
		if (!pod?.metadata) throw new Error("Missing Pod");
		pod.metadata.deletionTimestamp = new Date();
		await expect(adapter.observe(allocation)).resolves.toMatchObject({
			status: "unknown",
		});
	});

	it("rejects PVC storage drift", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const pvc = await client.read("PersistentVolumeClaim", allocation.pvcName);
		if (pvc) {
			const pvcValue = pvc as V1PersistentVolumeClaim;
			pvcValue.spec = {
				...pvcValue.spec,
				accessModes: ["ReadWriteMany"],
			};
		}
		await expect(adapter.apply(allocation)).rejects.toMatchObject({
			code: "conflict",
		});
	});

	it("rejects pinned PVC storage class drift", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		const pinned = { ...allocation, storageClassName: "fast" };
		await adapter.apply(pinned);
		const pvc = (await client.read(
			"PersistentVolumeClaim",
			pinned.pvcName,
		)) as V1PersistentVolumeClaim | null;
		if (pvc) {
			pvc.spec = { ...pvc.spec, storageClassName: "slow" };
		}
		await expect(adapter.apply(pinned)).rejects.toMatchObject({
			code: "conflict",
		});
	});

	it("rejects an owned Pod with an extra container", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const pod = (await client.read("Pod", allocation.podName)) as V1Pod | null;
		if (!pod?.spec) throw new Error("missing pod spec");
		pod.spec.containers.push({ name: "unexpected", image: "busybox" });
		await expect(adapter.apply(allocation)).rejects.toMatchObject({
			code: "conflict",
		});
	});

	it("accepts an owned Pod when equivalent fields were reordered", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const pod = (await client.read("Pod", allocation.podName)) as V1Pod | null;
		if (!pod?.spec?.containers[0]) throw new Error("missing runtime container");
		pod.spec.containers[0].securityContext = {
			procMount: "Default",
			seccompProfile: { type: "RuntimeDefault" },
			runAsGroup: 1000,
			runAsUser: 1000,
			runAsNonRoot: true,
			capabilities: { drop: ["ALL"] },
			readOnlyRootFilesystem: true,
			allowPrivilegeEscalation: false,
		};
		await expect(adapter.apply(allocation)).resolves.toMatchObject({
			sandboxId: allocation.sandboxId,
		});
	});

	it.each([
		[
			"image",
			(pod: V1Pod) => {
				const container = pod.spec?.containers[0];
				if (!container) throw new Error("missing runtime container");
				container.image = `registry.example.test/other@sha256:${"b".repeat(64)}`;
			},
		],
		[
			"service account",
			(pod: V1Pod) => {
				if (!pod.spec) throw new Error("missing pod spec");
				pod.spec.serviceAccountName = "foreign-account";
			},
		],
		[
			"workspace mount",
			(pod: V1Pod) => {
				const mount = pod.spec?.containers[0]?.volumeMounts?.[0];
				if (!mount) throw new Error("missing workspace mount");
				mount.mountPath = "/foreign";
			},
		],
		[
			"PVC claim",
			(pod: V1Pod) => {
				const volume = pod.spec?.volumes?.[0];
				if (!volume?.persistentVolumeClaim)
					throw new Error("missing workspace volume");
				volume.persistentVolumeClaim.claimName = "foreign-pvc";
			},
		],
		[
			"container port",
			(pod: V1Pod) => {
				const port = pod.spec?.containers[0]?.ports?.[0];
				if (!port) throw new Error("missing container port");
				port.containerPort = 9090;
			},
		],
		[
			"host port",
			(pod: V1Pod) => {
				const port = pod.spec?.containers[0]?.ports?.[0];
				if (!port) throw new Error("missing container port");
				port.hostPort = 8080;
			},
		],
		[
			"host IP",
			(pod: V1Pod) => {
				const port = pod.spec?.containers[0]?.ports?.[0];
				if (!port) throw new Error("missing container port");
				port.hostIP = "127.0.0.1";
			},
		],
		[
			"readiness probe scheme",
			(pod: V1Pod) => {
				const probe = pod.spec?.containers[0]?.readinessProbe;
				if (!probe?.httpGet) throw new Error("missing readiness probe");
				probe.httpGet.scheme = "HTTPS";
			},
		],
		[
			"readiness probe timeout",
			(pod: V1Pod) => {
				const probe = pod.spec?.containers[0]?.readinessProbe;
				if (!probe) throw new Error("missing readiness probe");
				probe.timeoutSeconds = 2;
			},
		],
	] as const)("rejects owned Pod %s drift", async (_field, mutate) => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const pod = await client.read("Pod", allocation.podName);
		mutate(pod as V1Pod);
		await expect(adapter.apply(allocation)).rejects.toMatchObject({
			code: "conflict",
		});
	});

	it.each([
		"Service",
		"NetworkPolicy",
		"PersistentVolumeClaim",
		"ServiceAccount",
		"Secret",
	] as const)(
		"fails closed on same-UID %s drift during readback",
		async (kind) => {
			const client = api();
			const adapter = createSessionSandboxWorkloadAdapterV1({ client });
			const pinned = { ...allocation, storageClassName: "fast" };
			await adapter.apply(pinned);
			const pod = await client.read<V1Pod>("Pod", pinned.podName);
			if (!pod) throw new Error("Missing Pod");
			pod.status = {
				phase: "Running",
				conditions: [{ type: "Ready", status: "True" }],
			};
			const before = await adapter.observe(pinned);
			expect(before.status).toBe("ready");
			const resource = await client.read(kind, pinned.resourceName);
			if (!resource) throw new Error("Missing resource");
			if (kind === "Service")
				(resource as import("@kubernetes/client-node").V1Service).spec = {
					type: "ClusterIP",
					selector: { foreign: "session" },
				};
			if (kind === "NetworkPolicy")
				(resource as import("@kubernetes/client-node").V1NetworkPolicy).spec = {
					podSelector: {},
					policyTypes: ["Ingress", "Egress"],
					ingress: [{}],
					egress: [{}],
				};
			if (kind === "PersistentVolumeClaim")
				(resource as V1PersistentVolumeClaim).spec = {
					...(resource as V1PersistentVolumeClaim).spec,
					storageClassName: "slow",
				};
			if (kind === "ServiceAccount")
				(
					resource as import("@kubernetes/client-node").V1ServiceAccount
				).automountServiceAccountToken = true;
			if (kind === "Secret")
				(resource as V1Secret).data = {
					...(resource as V1Secret).data,
					token: Buffer.from("foreign-token").toString("base64"),
				};
			expect((await adapter.observe(pinned, before.resources)).status).toBe(
				"unknown",
			);
		},
	);

	it("refuses cleanup after an owned resource is replaced", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const observed = await adapter.observe(allocation);
		const service = await client.read("Service", allocation.serviceName);
		if (!service?.metadata) throw new Error("Missing service");
		service.metadata.uid = "replacement-service";
		await expect(
			adapter.cleanup(allocation, observed.resources, {
				recordDeletionProgress: async () => "committed",
			}),
		).rejects.toMatchObject({ code: "conflict" });
	});

	it("cleans only resources owned by the exact generation and fence", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const observed = await adapter.observe(allocation);
		await expect(
			adapter.cleanup(allocation, observed.resources, {
				recordDeletionProgress: async () => "committed",
			}),
		).resolves.toMatchObject({
			schemaVersion: 1,
			sandboxId: allocation.sandboxId,
			retainedPVC: { kind: "PersistentVolumeClaim" },
		});
		for (const kind of [
			"ServiceAccount",
			"NetworkPolicy",
			"Pod",
			"Service",
			"Secret",
		] as const)
			await expect(
				client.read(
					kind,
					kind === "Pod"
						? allocation.podName
						: kind === "Service"
							? allocation.serviceName
							: kind === "ServiceAccount"
								? allocation.serviceAccountName
								: kind === "Secret"
									? allocation.secretName
									: allocation.networkPolicyName,
				),
			).resolves.toBeNull();
		await expect(
			client.read("PersistentVolumeClaim", allocation.pvcName),
		).resolves.toMatchObject({
			metadata: { name: allocation.pvcName },
		});
	});

	it("records durable delete intent, call result, and absence while retaining the PVC", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const observed = await adapter.observe(allocation);
		const progress: Array<{ kind: string; state: string; result: string }> = [];
		const receipt = await adapter.cleanup(allocation, observed.resources, {
			managementFence: 4,
			recordDeletionProgress: async (entry) => {
				progress.push({
					kind: entry.resource.kind,
					state: entry.state,
					result: entry.deleteCallResult,
				});
				return "committed";
			},
		});
		expect(receipt.retainedPVC?.kind).toBe("PersistentVolumeClaim");
		expect(progress).toHaveLength(15);
		expect(
			progress.filter((entry) => entry.state === "delete-requested"),
		).toHaveLength(10);
		expect(progress.filter((entry) => entry.state === "absent")).toHaveLength(
			5,
		);
		expect(
			progress.filter((entry) => entry.result === "acknowledged"),
		).toHaveLength(10);
		// The Pod goes before the Secret it references.
		expect(
			progress
				.filter((entry) => entry.state === "absent")
				.map((entry) => entry.kind),
		).toEqual(["Pod", "Secret", "Service", "NetworkPolicy", "ServiceAccount"]);
	});

	it("fails closed before DELETE when the durable CAS callback is absent", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const observed = await adapter.observe(allocation);
		let deletes = 0;
		const guarded = createSessionSandboxWorkloadAdapterV1({
			client: {
				...client,
				deleteResult: undefined,
				async delete(object) {
					deletes++;
					return client.delete(object);
				},
			},
		});
		await expect(
			guarded.cleanup(allocation, observed.resources),
		).rejects.toMatchObject({
			code: "unavailable",
		});
		expect(deletes).toBe(0);
	});

	it("fails closed before DELETE when the durable delete result is absent", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const observed = await adapter.observe(allocation);
		let deletes = 0;
		const progress: SessionSandboxDeletionProgressV1[] = [];
		const guarded = createSessionSandboxWorkloadAdapterV1({
			client: {
				...client,
				deleteResult: undefined,
				async delete(object) {
					deletes++;
					return client.delete(object);
				},
			},
		});
		await expect(
			guarded.cleanup(allocation, observed.resources, {
				recordDeletionProgress: async (entry) => {
					progress.push(entry);
					return "committed";
				},
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(deletes).toBe(0);
		expect(progress).toContainEqual(
			expect.objectContaining({
				resource: expect.objectContaining({ kind: "Pod" }),
				state: "unknown",
				deleteCallResult: "unknown",
			}),
		);
	});

	it("does not treat a Kubernetes 404 delete response as acknowledged", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const observed = await adapter.observe(allocation);
		const progress: SessionSandboxDeletionProgressV1[] = [];
		const deleteResult = async () => "absent" as const;
		const clientWith404 = Object.assign({}, client, { deleteResult });
		const guarded = createSessionSandboxWorkloadAdapterV1({
			client: clientWith404,
		});
		await expect(
			guarded.cleanup(allocation, observed.resources, {
				recordDeletionProgress: async (entry) => {
					progress.push(entry);
					return "committed";
				},
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(
			progress.find(
				(entry) =>
					entry.resource.kind === "Pod" && entry.deleteCallResult === "unknown",
			),
		).toMatchObject({
			state: "delete-requested",
			deleteCallResult: "unknown",
		});
	});

	it("retries a terminating resource without issuing a second DELETE", async () => {
		const { resources, ...client } = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const observed = await adapter.observe(allocation);
		const originalDeleteResult = client.deleteResult;
		let deletes = 0;
		client.deleteResult = async (object) => {
			deletes++;
			if (object.kind === "Pod") {
				const pod = resources.get(`Pod/${allocation.podName}`);
				if (!pod?.metadata) throw new Error("Missing Pod");
				pod.metadata.deletionTimestamp = new Date();
				pod.metadata.resourceVersion = "terminating";
				return "acknowledged";
			}
			return originalDeleteResult(object);
		};
		const progress: SessionSandboxDeletionProgressV1[] = [];
		const record = async (entry: SessionSandboxDeletionProgressV1) => {
			progress.push(entry);
			return "committed" as const;
		};
		await expect(
			adapter.cleanup(allocation, observed.resources, {
				deletionProgress: [],
				recordDeletionProgress: record,
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		const saved = progress.filter((entry) => entry.resource.kind === "Pod");
		await expect(
			adapter.cleanup(allocation, observed.resources, {
				deletionProgress: saved,
				recordDeletionProgress: record,
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(deletes).toBe(1);
		resources.delete(`Pod/${allocation.podName}`);
		await adapter.cleanup(allocation, observed.resources, {
			deletionProgress: saved,
			recordDeletionProgress: record,
		});
		expect(
			progress.some(
				(entry) => entry.resource.kind === "Pod" && entry.state === "absent",
			),
		).toBe(true);
	});
});

describe("Session Sandbox Runtime projection (#1466)", () => {
	const ready = async (client: ReturnType<typeof api>) => {
		const pod = await client.read<V1Pod>("Pod", allocation.podName);
		if (!pod) throw new Error("Missing Pod");
		pod.status = {
			phase: "Running",
			conditions: [{ type: "Ready", status: "True" }],
		};
	};

	it("projects Runtime inputs by name and keeps both credentials in this Sandbox's Secret", () => {
		const [, , , , secret, pod] = sessionSandboxResourcesV1(allocation);
		const container = pod.spec?.containers[0];
		expect(pod.spec?.securityContext).toEqual({
			runAsNonRoot: true,
			runAsUser: 1000,
			runAsGroup: 1000,
			fsGroup: 1000,
			seccompProfile: { type: "RuntimeDefault" },
		});
		expect(container?.securityContext).toMatchObject({
			allowPrivilegeEscalation: false,
			readOnlyRootFilesystem: true,
			capabilities: { drop: ["ALL"] },
			runAsUser: 1000,
		});
		expect(pod.spec?.enableServiceLinks).toBe(false);
		expect(container?.workingDir).toBeUndefined();
		expect(container?.volumeMounts).toEqual([
			{ name: "workspace", mountPath: "/workspace" },
			{ name: "runtime-tmp", mountPath: "/tmp" },
		]);
		expect(pod.spec?.volumes?.[1]).toEqual({
			name: "runtime-tmp",
			emptyDir: { medium: "Memory", sizeLimit: "128Mi" },
		});
		const env = new Map(
			(container?.env ?? []).map((entry) => [entry.name, entry]),
		);
		expect([...env.keys()].sort()).toEqual(
			[
				"SESSION_ID",
				"AGENT_INFRA_RUNTIME_MODEL_CONFIG",
				"AGENT_INFRA_RUNTIME_DRIVER",
				"AGENT_INFRA_RUNTIME_ISOLATION_MODE",
				"AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ENABLED",
				"AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_SCOPE",
				"AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ATTESTATION",
				"AGENT_INFRA_RUNTIME_AGENT_ID",
				"AGENT_INFRA_RUNTIME_WORKER_ID",
				"AGENT_INFRA_RUNTIME_DATA_DIR",
				"PORT",
				"AGENT_INFRA_RUNTIME_GRANT_KEY_ID",
				"AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY",
				"AGENT_INFRA_RUNTIME_GRANT_ISSUER",
				"AGENT_INFRA_RUNTIME_SERVICE_TOKEN",
				"AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_ORIGIN",
				"AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_SERVICE_TOKEN",
			].sort(),
		);
		expect(env.get("AGENT_INFRA_RUNTIME_DATA_DIR")?.value).toBe(
			"/workspace/runtime",
		);
		expect(env.get("AGENT_INFRA_RUNTIME_AGENT_ID")?.value).toBe("agent-a");
		expect(env.get("AGENT_INFRA_RUNTIME_ISOLATION_MODE")?.value).toBe(
			"container-boundary",
		);
		expect(
			env.get("AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ENABLED")?.value,
		).toBe("worker-v1");
		expect(env.get("AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_SCOPE")?.value).toBe(
			"agent-a:session-a",
		);
		expect(
			env.get("AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ATTESTATION")?.value,
		).toBeUndefined();
		expect(
			env.get("AGENT_INFRA_RUNTIME_CONTAINER_BOUNDARY_ATTESTATION")?.valueFrom,
		).toEqual({
			secretKeyRef: {
				name: allocation.secretName,
				key: "container-boundary-attestation",
				optional: false,
			},
		});
		expect(env.get("PORT")?.value).toBe("8080");
		for (const [name, key] of [
			["AGENT_INFRA_RUNTIME_MODEL_CONFIG", "model-config"],
			["AGENT_INFRA_RUNTIME_SERVICE_TOKEN", "token"],
			["AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_SERVICE_TOKEN", "token"],
		] as const) {
			expect(env.get(name)?.value).toBeUndefined();
			expect(env.get(name)?.valueFrom).toEqual({
				secretKeyRef: { name: allocation.secretName, key, optional: false },
			});
		}
		expect(
			env.get("AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_ORIGIN")?.value,
		).toBe("http://platform-worker-native-metadata");
		// No static model Key and no deployment-level token anywhere in the Pod.
		const podJson = JSON.stringify(pod);
		expect(podJson).not.toContain("MODEL_CREDENTIAL");
		expect(podJson).not.toContain(sessionSandboxDeploymentTokenFixture);
		expect(podJson).not.toContain(allocation.runtime!.serviceToken);
		expect(container?.envFrom).toBeUndefined();
		expect(secret).toMatchObject({
			kind: "Secret",
			type: "Opaque",
			immutable: true,
			metadata: {
				name: allocation.resourceName,
				labels: sessionSandboxLabelsV1(allocation),
			},
		});
		expect(Object.keys(secret.data ?? {}).sort()).toEqual([
			"container-boundary-attestation",
			"model-config",
			"token",
		]);
		const token = Buffer.from(secret.data?.token ?? "", "base64").toString();
		expect(token).toBe(
			sessionSandboxServiceTokenV1(
				sessionSandboxDeploymentTokenFixture,
				allocation.namespace,
				allocation.sandboxId,
			),
		);
		const modelConfig = JSON.parse(
			Buffer.from(secret.data?.["model-config"] ?? "", "base64").toString(),
		);
		expect(modelConfig.schemaVersion).toBe(4);
		expect(JSON.stringify(modelConfig)).not.toMatch(/credential/i);
	});

	it("derives a distinct token per Sandbox and namespace, never the deployment token", () => {
		const token = (namespace: string, sandboxId: string) =>
			sessionSandboxServiceTokenV1(
				sessionSandboxDeploymentTokenFixture,
				namespace,
				sandboxId,
			);
		const a = token("workload-test", "sandbox-a");
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(a).toBe(token("workload-test", "sandbox-a"));
		expect(new Set([a, token("workload-test", "sandbox-b")]).size).toBe(2);
		expect(new Set([a, token("other-namespace", "sandbox-a")]).size).toBe(2);
		// Separator-bound: concatenation cannot alias another namespace/Sandbox.
		expect(token("workload-tes", "tsandbox-a")).not.toBe(a);
		expect(a).not.toBe(sessionSandboxDeploymentTokenFixture);
		expect(
			sessionSandboxServiceTokenV1(
				"rotated-deployment-proof",
				"workload-test",
				"sandbox-a",
			),
		).not.toBe(a);
	});

	it.each([
		[
			"a deployment-level token",
			{ serviceToken: sessionSandboxDeploymentTokenFixture },
		],
		[
			"a static-key model configuration",
			{
				modelConfiguration: JSON.stringify({
					...JSON.parse(allocation.runtime!.modelConfiguration),
					schemaVersion: 3,
				}),
			},
		],
		["a Driver/protocol mismatch", { driver: "claude" }],
		["an unknown Driver", { driver: "unknown" }],
		[
			"Messages configuration with the Codex Driver",
			{
				modelConfiguration: JSON.stringify({
					...JSON.parse(allocation.runtime!.modelConfiguration),
					modelOptions: JSON.parse(
						allocation.runtime!.modelConfiguration,
					).modelOptions.map((option: object) => ({
						...option,
						protocol: "anthropic-messages-v1",
						authentication: "api-key",
					})),
				}),
			},
		],
		["an extra input", { credential: "synthetic" }],
	])("rejects %s before any resource write", async (_name, override) => {
		const client = api();
		let writes = 0;
		const adapter = createSessionSandboxWorkloadAdapterV1({
			client: {
				...client,
				async create(object) {
					writes++;
					return client.create(object);
				},
			},
		});
		await expect(
			adapter.apply({
				...allocation,
				runtime: { ...allocation.runtime, ...override },
			} as SessionSandboxAllocationV1),
		).rejects.toMatchObject({ code: "policy" });
		expect(writes).toBe(0);
	});

	it("rejects a missing native metadata Worker origin when callback egress is enabled", async () => {
		const client = api();
		let writes = 0;
		const adapter = createSessionSandboxWorkloadAdapterV1({
			client: {
				...client,
				async create(object) {
					writes++;
					return client.create(object);
				},
			},
		});
		await expect(
			adapter.apply({
				...allocation,
				runtime: {
					...allocation.runtime,
					nativeMetadataWorkerOrigin: undefined,
				},
				egress: {
					...allocation.egress,
					nativeMetadataWorkerEgress: [
						{
							destination: {
								namespace: "platform",
								podLabels: { "app.kubernetes.io/component": "platform-worker" },
							},
							port: 3004,
						},
					],
				},
			} as SessionSandboxAllocationV1),
		).rejects.toMatchObject({ code: "policy" });
		expect(writes).toBe(0);
	});

	it("accepts the allocation namespace for native metadata egress", () => {
		expect(() =>
			sessionSandboxResourcesV1({
				...allocation,
				egress: {
					nativeMetadataWorkerEgress: [
						{
							destination: {
								namespace: "workload-test",
								podLabels: {
									"app.kubernetes.io/component": "platform-worker",
								},
							},
							port: 3004,
						},
					],
				},
			} as SessionSandboxAllocationV1),
		).not.toThrow();
	});

	it("accepts the release-scoped Worker selector", () => {
		expect(() =>
			sessionSandboxResourcesV1({
				...allocation,
				egress: {
					nativeMetadataWorkerEgress: [
						{
							destination: {
								namespace: "workload-test",
								podLabels: {
									"app.kubernetes.io/component": "platform-worker",
									"app.kubernetes.io/instance": "agent-infra-e2e",
								},
							},
							port: 3004,
						},
					],
				},
			} as SessionSandboxAllocationV1),
		).not.toThrow();
	});

	it.each([
		{
			destination: { ip: "203.0.113.10" },
			port: 3004,
		},
		{
			destination: { cidr: "8.8.8.0/24" },
			port: 3004,
		},
		{
			destination: {
				namespace: "other",
				podLabels: { "app.kubernetes.io/component": "platform-worker" },
			},
			port: 3004,
		},
		{
			destination: {
				namespace: "platform",
				podLabels: { "app.kubernetes.io/component": "other" },
			},
			port: 3004,
		},
		{
			destination: {
				namespace: "platform",
				podLabels: { "app.kubernetes.io/component": "platform-worker" },
			},
			port: 22,
		},
		{
			destination: {
				namespace: "platform",
				podLabels: {
					"app.kubernetes.io/component": "platform-worker",
					"app.kubernetes.io/instance": "bad instance",
				},
			},
			port: 3004,
		},
		{
			destination: {
				namespace: "platform",
				podLabels: {
					"app.kubernetes.io/component": "platform-worker",
					"app.kubernetes.io/instance": 123,
				} as unknown as Record<string, string>,
			},
			port: 3004,
		},
		{
			destination: {
				namespace: "platform",
				podLabels: {
					"app.kubernetes.io/component": "platform-worker",
					"app.kubernetes.io/instance": "a".repeat(64),
				},
			},
			port: 3004,
		},
		{
			destination: {
				namespace: "platform",
				podLabels: {
					"app.kubernetes.io/component": "platform-worker",
					"app.kubernetes.io/instance": "agent-infra-e2e",
					extra: "selector-widening",
				},
			},
			port: 3004,
		},
	] as Array<{
		destination: WorkloadEgressDestinationV1;
		port: number;
	}>)("rejects non-Worker native metadata egress destinations", (entry) => {
		expect(() =>
			sessionSandboxResourcesV1({
				...allocation,
				egress: { nativeMetadataWorkerEgress: [entry] },
			}),
		).toThrow();
	});

	it.each([
		"AGENT_INFRA_RUNTIME_SERVICE_TOKEN",
		"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_X",
		"PORT",
	])("rejects owner env %s that would shadow Runtime inputs", (name) => {
		expect(() =>
			sessionSandboxResourcesV1({
				...allocation,
				env: { ...allocation.env, [name]: "caller" },
			}),
		).toThrow();
	});

	it.each([
		[
			"a runtime env value",
			(pod: V1Pod) => {
				const entry = pod.spec?.containers[0]?.env?.find(
					(item) => item.name === "AGENT_INFRA_RUNTIME_AGENT_ID",
				);
				if (!entry) throw new Error("missing env");
				entry.value = "agent-b";
			},
		],
		[
			"a credential reference",
			(pod: V1Pod) => {
				const entry = pod.spec?.containers[0]?.env?.find(
					(item) => item.name === "AGENT_INFRA_RUNTIME_SERVICE_TOKEN",
				);
				if (!entry?.valueFrom?.secretKeyRef) throw new Error("missing env");
				entry.valueFrom.secretKeyRef.name = "platform-runtime-transport";
			},
		],
		[
			"an added static model Key",
			(pod: V1Pod) => {
				pod.spec?.containers[0]?.env?.push({
					name: "AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_X",
					value: "synthetic",
				});
			},
		],
		[
			"the Pod security context",
			(pod: V1Pod) => {
				if (!pod.spec) throw new Error("missing spec");
				pod.spec.securityContext = { runAsNonRoot: true };
			},
		],
		[
			"a writable root filesystem",
			(pod: V1Pod) => {
				const context = pod.spec?.containers[0]?.securityContext;
				if (!context) throw new Error("missing security context");
				context.readOnlyRootFilesystem = false;
			},
		],
		[
			"the /tmp volume",
			(pod: V1Pod) => {
				if (!pod.spec) throw new Error("missing spec");
				pod.spec.volumes = pod.spec.volumes?.filter(
					(volume) => volume.name !== "runtime-tmp",
				);
			},
		],
		[
			"service links",
			(pod: V1Pod) => {
				if (!pod.spec) throw new Error("missing spec");
				pod.spec.enableServiceLinks = true;
			},
		],
	] as const)(
		"fails closed on Session Pod drift in %s",
		async (_name, mutate) => {
			const client = api();
			const adapter = createSessionSandboxWorkloadAdapterV1({ client });
			await adapter.apply(allocation);
			await ready(client);
			const before = await adapter.observe(allocation);
			expect(before.status).toBe("ready");
			mutate((await client.read<V1Pod>("Pod", allocation.podName)) as V1Pod);
			expect((await adapter.observe(allocation, before.resources)).status).toBe(
				"unknown",
			);
			await expect(
				adapter.apply(allocation, before.resources),
			).rejects.toMatchObject({ code: "conflict" });
		},
	);

	it("records the Secret UID/resourceVersion in the readiness receipt", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		await ready(client);
		const observed = await adapter.observe(allocation);
		expect(observed.status).toBe("ready");
		const live = await client.read<V1Secret>("Secret", allocation.secretName);
		expect(
			observed.resources.find((resource) => resource.kind === "Secret"),
		).toEqual({
			kind: "Secret",
			namespace: allocation.namespace,
			name: allocation.secretName,
			uid: live?.metadata?.uid,
			resourceVersion: live?.metadata?.resourceVersion,
		});
	});

	it("reports unknown when the Secret is replaced or missing", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		await ready(client);
		const before = await adapter.observe(allocation);
		const live = await client.read<V1Secret>("Secret", allocation.secretName);
		if (!live?.metadata) throw new Error("Missing Secret");
		live.metadata.uid = "replacement-secret";
		expect((await adapter.observe(allocation, before.resources)).status).toBe(
			"unknown",
		);
		await client.delete(live);
		expect((await adapter.observe(allocation, before.resources)).status).toBe(
			"unknown",
		);
		await expect(
			adapter.apply(allocation, before.resources),
		).rejects.toMatchObject({ code: "conflict" });
	});

	it("does not take over a same-name external Secret", async () => {
		const client = api();
		const foreign: V1Secret = {
			apiVersion: "v1",
			kind: "Secret",
			type: "Opaque",
			metadata: {
				namespace: allocation.namespace,
				name: allocation.secretName,
				labels: { ...sessionSandboxLabelsV1(allocation) },
			},
			data: { token: Buffer.from("foreign").toString("base64") },
		};
		await client.create(foreign);
		const before = structuredClone(
			await client.read<V1Secret>("Secret", allocation.secretName),
		);
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await expect(adapter.apply(allocation)).rejects.toMatchObject({
			code: "conflict",
		});
		expect(await client.read("Secret", allocation.secretName)).toEqual(before);
		expect(await client.read("Pod", allocation.podName)).toBeNull();
		await expect(adapter.observe(allocation)).resolves.toMatchObject({
			status: "unknown",
		});
	});
});

// #2885：#1481（按 Sandbox 投影 Runtime 输入）之前准备的来源没有模型投影，排空 allocation 的
// runtime 为 null。那时不创建 Runtime Secret，资源规格也由当时的模板渲染。
describe("drain of a source prepared before per-Sandbox Runtime inputs (#2885)", () => {
	const legacy: SessionSandboxAllocationV1 = { ...allocation, runtime: null };
	const name = allocation.resourceName;
	const kinds = [
		"NetworkPolicy",
		"PersistentVolumeClaim",
		"Pod",
		"Service",
		"ServiceAccount",
	];

	/** 带今天的归属标记，但没有 Secret，Pod 与 NetworkPolicy 的规格是旧模板的。 */
	async function seedLegacySource(
		client: ReturnType<typeof api>,
	): Promise<SessionSandboxResourceIdentityV1[]> {
		for (const resource of sessionSandboxResourcesV1(allocation)) {
			if (resource.kind === "Secret") continue;
			const old = structuredClone(resource);
			if (old.kind === "Pod") {
				const spec = (old as V1Pod).spec;
				const container = spec?.containers[0];
				if (!spec || !container) throw new Error("Missing Pod spec");
				spec.volumes = spec.volumes?.filter(
					(volume) => volume.name === "workspace",
				);
				container.volumeMounts = [
					{ name: "workspace", mountPath: "/workspace" },
				];
				delete container.readinessProbe;
				delete spec.enableServiceLinks;
			}
			if (old.kind === "NetworkPolicy") {
				const spec = (old as V1NetworkPolicy).spec;
				if (!spec) throw new Error("Missing NetworkPolicy spec");
				spec.ingress = [];
			}
			await client.create(old);
		}
		return [...client.resources.values()].map((object) => ({
			kind: object.kind as SessionSandboxResourceIdentityV1["kind"],
			namespace: allocation.namespace,
			name,
			uid: object.metadata?.uid ?? "",
			resourceVersion: object.metadata?.resourceVersion ?? "",
		}));
	}

	it("observes the source by ownership and UID for drain control, not by today's template", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		const previous = await seedLegacySource(client);
		// Pod 状态更新让 resourceVersion 前进，UID 不变。
		const pod = client.resources.get(`Pod/${name}`);
		if (!pod?.metadata) throw new Error("Missing Pod");
		pod.metadata.resourceVersion = "99";

		const observed = await adapter.observe(legacy, previous, "control");
		expect(observed.status).toBe("observed");
		expect(observed.resources.map((resource) => resource.kind).sort()).toEqual(
			kinds,
		);
		expect(
			observed.resources.find((resource) => resource.kind === "Pod"),
		).toMatchObject({ uid: pod.metadata.uid, resourceVersion: "99" });

		// 当前来源（有 runtime）不放宽：缺 Secret、规格漂移仍是 unknown。
		await expect(
			adapter.observe(allocation, previous, "control"),
		).resolves.toMatchObject({ status: "unknown" });
		// 业务观测也不放宽。
		await expect(adapter.observe(legacy, previous)).resolves.toMatchObject({
			status: "unknown",
		});
	});

	it("does not identify a replaced or foreign resource by name", async () => {
		for (const change of ["uid", "fence", "session"] as const) {
			const client = api();
			const adapter = createSessionSandboxWorkloadAdapterV1({ client });
			const previous = await seedLegacySource(client);
			const service = client.resources.get(`Service/${name}`);
			if (!service?.metadata?.annotations) throw new Error("Missing Service");
			if (change === "uid") service.metadata.uid = "replaced-service";
			if (change === "fence")
				service.metadata.annotations["agent-infra.agora.io/fence"] = "1";
			if (change === "session")
				service.metadata.annotations["agent-infra.agora.io/session-id"] =
					"session-other";
			await expect(
				adapter.observe(legacy, previous, "control"),
			).resolves.toMatchObject({ status: "unknown" });
		}
	});

	it("removes the four compute and route resources by UID and keeps the PVC", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		const previous = await seedLegacySource(client);
		const progress: SessionSandboxDeletionProgressV1[] = [];
		const receipt = await adapter.cleanup(
			{ ...legacy, desiredState: "stopped" },
			previous,
			{
				managementFence: 4,
				recordDeletionProgress: async (entry) => {
					progress.push(entry);
					return "committed";
				},
			},
		);
		expect(receipt.removed.map((proof) => proof.resource.kind).sort()).toEqual([
			"NetworkPolicy",
			"Pod",
			"Service",
			"ServiceAccount",
		]);
		expect(receipt.retainedPVC?.uid).toBe(
			previous.find((resource) => resource.kind === "PersistentVolumeClaim")
				?.uid,
		);
		expect([...client.resources.keys()]).toEqual([
			`PersistentVolumeClaim/${name}`,
		]);
		expect(progress.some((entry) => entry.resource.kind === "Secret")).toBe(
			false,
		);
	});

	it("does not ignore an owned Secret left by an interrupted preparation", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		const previous = await seedLegacySource(client);
		const secret = sessionSandboxResourcesV1(allocation).find(
			(resource) => resource.kind === "Secret",
		);
		if (!secret) throw new Error("Missing Secret");
		await client.create(structuredClone(secret));
		const observed = await adapter.observe(legacy, previous, "control");
		expect(observed.resources.map((resource) => resource.kind)).toContain(
			"Secret",
		);
		// 来源没有记录它：不随排空忽略或删除，证据不足时失败关闭。
		await expect(
			adapter.cleanup({ ...legacy, desiredState: "stopped" }, previous, {
				managementFence: 4,
				recordDeletionProgress: async () => "committed",
			}),
		).rejects.toMatchObject({ code: "conflict" });
		expect(await client.read("Secret", name)).not.toBeNull();
	});

	it("still requires the Secret of a source prepared with Runtime inputs", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		const previous = await seedLegacySource(client);
		await expect(
			adapter.cleanup({ ...allocation, desiredState: "stopped" }, previous, {
				managementFence: 4,
				recordDeletionProgress: async () => "committed",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
	});
});

describe("Session Sandbox Runtime file exchange (#3276)", () => {
	const origin = "http://platform-api.agent-infra.svc:3000";
	const derived = sessionSandboxFileExchangeTokenV1(
		sessionSandboxDeploymentTokenFixture,
		{
			namespace: allocation.namespace,
			sandboxId: allocation.sandboxId,
			generation: allocation.generation,
			resourceFence: allocation.resourceFence,
		},
	);
	const runtime = allocation.runtime as SessionSandboxRuntimeInputV1;
	// #3289：文件交换 origin 总是伴随部署声明的唯一 egress，端口等于 origin 端口。
	const fileExchangeEgress = [
		{
			destination: {
				namespace: "agent-infra",
				podLabels: { "app.kubernetes.io/component": "platform-api" },
			},
			port: 3000,
		},
	];
	const enabled: SessionSandboxAllocationV1 = {
		...allocation,
		egress: { ...allocation.egress, fileExchangeEgress },
		runtime: { ...runtime, fileExchange: { origin, serviceToken: derived } },
	};
	const fileExchangeNames = [
		"AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN",
		"AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN",
	];
	const envOf = (pod: V1Pod) =>
		new Map(
			(pod.spec?.containers[0]?.env ?? []).map((entry) => [entry.name, entry]),
		);
	const decodedSecret = (secret: V1Secret) =>
		Object.fromEntries(
			Object.entries(secret.data ?? {}).map(([key, value]) => [
				key,
				Buffer.from(value, "base64").toString(),
			]),
		);

	it("injects the origin literal and a Secret reference to this Sandbox's derived token", () => {
		const [, , , , secret, pod] = sessionSandboxResourcesV1(enabled);
		const env = envOf(pod);
		expect(env.get("AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN")).toEqual({
			name: "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN",
			value: origin,
		});
		expect(env.get("AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN")).toEqual({
			name: "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN",
			valueFrom: {
				secretKeyRef: {
					name: enabled.secretName,
					key: "file-exchange-token",
					optional: false,
				},
			},
		});
		expect(Object.keys(secret.data ?? {}).sort()).toEqual([
			"container-boundary-attestation",
			"file-exchange-token",
			"model-config",
			"token",
		]);
		const values = decodedSecret(secret);
		expect(values["file-exchange-token"]).toBe(derived);
		// 文件交换 token 与传输 token 用途不同，取值也不同。
		expect(values["file-exchange-token"]).not.toBe(values.token);
		// AC-3：Pod env 不含任何 token 字面量，Secret 只含派生值，不含部署 token。
		const podJson = JSON.stringify(pod);
		expect(podJson).not.toContain(sessionSandboxDeploymentTokenFixture);
		expect(podJson).not.toContain(derived);
		expect(JSON.stringify(values)).not.toContain(
			sessionSandboxDeploymentTokenFixture,
		);
	});

	it("injects the same pair into a custom platform-adapter Sandbox", () => {
		const custom: SessionSandboxAllocationV1 = {
			...enabled,
			runtime: {
				...runtime,
				driver: "acp",
				modelConfiguration: "",
				fileExchange: { origin, serviceToken: derived },
				custom: {
					secretRefs: [
						{
							schemaVersion: 1,
							ownerType: "agent-owner",
							ownerId: "actor-a",
							agentId: "agent-a",
							secretId: "owner-secret",
							secretVersion: 1,
							configRevision: 1,
							algorithmVersion: "aes-256-gcm:v1",
							wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
							wrappingKeyVersion: "key-a",
							name: "owner-secret-k8s",
						},
					],
				},
			},
		};
		bindSessionSandboxCustomSecretMaterializationV1(custom, {
			data: { MODEL_API_KEY: "redacted-test-value" },
			environmentNames: ["MODEL_API_KEY"],
		});
		const [, , , , secret, pod] = sessionSandboxResourcesV1(custom);
		const env = envOf(pod);
		expect(env.get("AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN")?.value).toBe(
			origin,
		);
		expect(
			env.get("AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN")?.valueFrom,
		).toEqual({
			secretKeyRef: {
				name: custom.secretName,
				key: "file-exchange-token",
				optional: false,
			},
		});
		expect(decodedSecret(secret)["file-exchange-token"]).toBe(derived);
	});

	it("injects neither variable nor the Secret key without a configured origin", () => {
		const [, , , , secret, pod] = sessionSandboxResourcesV1(allocation);
		const env = envOf(pod);
		for (const name of fileExchangeNames) expect(env.has(name)).toBe(false);
		expect(Object.keys(secret.data ?? {})).not.toContain("file-exchange-token");
	});

	it.each([
		[
			"an origin with a path",
			{ origin: `${origin}/api`, serviceToken: derived },
		],
		[
			"an origin with credentials",
			{
				origin: "https://user:pass@platform-api.example.test",
				serviceToken: derived,
			},
		],
		[
			"a cleartext IP origin",
			{ origin: "http://10.0.0.1:3000", serviceToken: derived },
		],
		[
			"the deployment token instead of a derived value",
			{ origin, serviceToken: sessionSandboxDeploymentTokenFixture },
		],
		[
			"the Sandbox transport token",
			{ origin, serviceToken: runtime.serviceToken },
		],
		["a missing token", { origin }],
		[
			"an extra field",
			{ origin, serviceToken: derived, secretName: "foreign" },
		],
	])("rejects %s before any resource write", async (_name, fileExchange) => {
		const client = api();
		let writes = 0;
		const adapter = createSessionSandboxWorkloadAdapterV1({
			client: {
				...client,
				async create(object) {
					writes++;
					return client.create(object);
				},
			},
		});
		await expect(
			adapter.apply({
				...enabled,
				runtime: { ...runtime, fileExchange },
			} as SessionSandboxAllocationV1),
		).rejects.toMatchObject({ code: "policy" });
		expect(writes).toBe(0);
	});

	it("adds exactly one egress rule to the declared origin port (#3289 AC-1)", () => {
		const [, , disabledPolicy] = sessionSandboxResourcesV1(allocation);
		const [, , enabledPolicy] = sessionSandboxResourcesV1(enabled);
		const before = (disabledPolicy as V1NetworkPolicy).spec?.egress ?? [];
		const after = (enabledPolicy as V1NetworkPolicy).spec?.egress ?? [];
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
		// 未配置文件交换时不生成该规则。
		expect(JSON.stringify(before)).not.toContain("platform-api");
	});

	it.each([
		[
			"egress without a configured origin",
			{ ...allocation, egress: enabled.egress },
		],
		[
			"an origin without the declared egress",
			{ ...enabled, egress: allocation.egress },
		],
		[
			"a Runtime origin on another port",
			{
				...enabled,
				runtime: {
					...runtime,
					fileExchange: {
						origin: "http://platform-api.agent-infra.svc:9000",
						serviceToken: derived,
					},
				},
			},
		],
		[
			"a second file exchange destination",
			{
				...enabled,
				egress: {
					fileExchangeEgress: [
						...fileExchangeEgress,
						{ destination: { ip: "203.0.113.10" }, port: 3000 },
					],
				},
			},
		],
		[
			"a CIDR file exchange destination",
			{
				...enabled,
				egress: {
					fileExchangeEgress: [
						{ destination: { cidr: "203.0.113.0/24" }, port: 3000 },
					],
				},
			},
		],
	])("rejects %s before any resource write (#3289)", async (_name, value) => {
		const client = api();
		let writes = 0;
		const adapter = createSessionSandboxWorkloadAdapterV1({
			client: {
				...client,
				async create(object) {
					writes++;
					return client.create(object);
				},
			},
		});
		await expect(
			adapter.apply(value as SessionSandboxAllocationV1),
		).rejects.toMatchObject({ code: "policy" });
		expect(writes).toBe(0);
	});

	it("rejects an Owner env that shadows a file exchange variable", () => {
		for (const name of fileExchangeNames)
			expect(() =>
				sessionSandboxResourcesV1({
					...enabled,
					env: { [name]: "http://owner.example.test" },
				}),
			).toThrow(expect.objectContaining({ code: "policy" }));
	});

	it.each([
		["enabling", allocation, enabled],
		["disabling", enabled, allocation],
	] as const)(
		"treats %s file exchange as Pod and Secret drift, never an in-place update",
		async (_change, before, after) => {
			const client = api();
			const adapter = createSessionSandboxWorkloadAdapterV1({ client });
			await adapter.apply(before);
			const pod = await client.read<V1Pod>("Pod", before.podName);
			if (!pod) throw new Error("Missing Pod");
			pod.status = {
				phase: "Running",
				conditions: [{ type: "Ready", status: "True" }],
			};
			const observed = await adapter.observe(before);
			expect(observed.status).toBe("ready");
			// 现有 Pod 不会保留旧 env 继续被判为就绪：调谐必须走既有的受控替换。
			expect((await adapter.observe(after, observed.resources)).status).toBe(
				"unknown",
			);
			await expect(
				adapter.apply(after, observed.resources),
			).rejects.toMatchObject({ code: "conflict" });
			const secret = await client.read<V1Secret>("Secret", before.secretName);
			expect(
				Object.keys(secret?.data ?? {}).includes("file-exchange-token"),
			).toBe(before === enabled);
		},
	);
});
