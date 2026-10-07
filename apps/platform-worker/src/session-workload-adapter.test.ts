import { connectionConsumerProfileFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import type { SessionSandboxDeletionProgressV1 } from "@agent-infra/platform-core";
import type {
	KubernetesObject,
	V1NetworkPolicy,
	V1PersistentVolumeClaim,
	V1Pod,
} from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
	createRuntimeConnectionConsumerSnapshotV1,
	runtimeConnectionConsumerAnnotation,
	runtimeConnectionConsumerFileEnvironment,
} from "./connection-consumer-projection.js";
import { runtimeTlsSecretFixture } from "./kubernetes.fixture.js";
import type {
	WorkerKubernetesClientV1,
	WorkloadResourceKind,
} from "./kubernetes-client.js";
import {
	createSessionSandboxWorkloadAdapterV1,
	type SessionSandboxAllocationV1,
	sessionSandboxResourcesV1,
} from "./session-workload-adapter.js";
import { workloadEgressRulesV1 } from "./workload-network.js";

const api = () => {
	const resources = new Map<string, KubernetesObject>();
	const key = (kind: string, name: string) => `${kind}/${name}`;
	resources.set(
		"Secret/sandbox-sandbox-a-tls",
		runtimeTlsSecretFixture("sandbox-sandbox-a-tls", "session-a", [
			"sandbox-sandbox-a.workload-test.svc",
		]),
	);
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
	runtimeTlsSecretName: "sandbox-sandbox-a-tls",
	serviceAccountName: "sandbox-sandbox-a",
	pvcName: "sandbox-sandbox-a",
	networkPolicyName: "sandbox-sandbox-a",
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
	desiredState: "running",
};

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
		const selected = { ...allocation, connectionConsumerSnapshot: snapshot };
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
			env: {
				...selected.env,
				[runtimeConnectionConsumerFileEnvironment]: "/invalid-current-config",
			},
		};
		const controlObservation = await adapter.observe(
			unavailable,
			previous,
			"control",
		);
		expect(controlObservation.status).toBe("observed");
		expect(controlObservation.resources).toHaveLength(5);
		await adapter.cleanup(unavailable, previous, {
			recordDeletionProgress: async () => "committed",
		});
		expect(await client.read("Pod", selected.podName)).toBeNull();
	});
	it("rejects a Session env file override before Pod creation", () => {
		expect(() =>
			sessionSandboxResourcesV1({
				...allocation,
				env: { [runtimeConnectionConsumerFileEnvironment]: "/caller" },
			}),
		).toThrow();
	});
	it("renders one Pod, Service, SA, retained PVC and isolated NetworkPolicy with allocation fence", () => {
		const resources = sessionSandboxResourcesV1(allocation);
		expect(resources.map((resource) => resource.kind)).toEqual([
			"ServiceAccount",
			"PersistentVolumeClaim",
			"NetworkPolicy",
			"Service",
			"Pod",
		]);
		for (const resource of resources) {
			expect(resource.metadata?.labels).toMatchObject({
				"agent-infra.agora.io/agent-id": "agent-a",
				"agent-infra.agora.io/session-id": "session-a",
				"agent-infra.agora.io/sandbox-id": "sandbox-a",
				"agent-infra.agora.io/generation": "3",
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

	it("applies the same deployment-approved egress as the Agent Workload (#1445)", async () => {
		const egress = {
			dnsEgress: [
				{ namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
			],
			modelEgress: [{ destination: { ip: "203.0.113.10" }, port: 443 }],
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
			env: { SESSION_ID: "session-b" },
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
		expect(firstResources[4].spec?.containers[0]?.workingDir).toBe(
			"/workspace",
		);
		expect(secondResources[4].spec?.containers[0]?.workingDir).toBe(
			"/workspace",
		);
		expect(firstResources[2].spec?.podSelector).toEqual({
			matchLabels: firstResources[4].metadata?.labels,
		});
		expect(secondResources[2].spec?.podSelector).toEqual({
			matchLabels: secondResources[4].metadata?.labels,
		});
		expect(firstResources[4].spec?.volumes?.[0]?.persistentVolumeClaim).toEqual(
			{
				claimName: allocation.pvcName,
			},
		);
		expect(
			secondResources[4].spec?.volumes?.[0]?.persistentVolumeClaim,
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

	it("fails closed when the Session leaf SAN is for another Service", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		(
			client as typeof client & { resources: Map<string, KubernetesObject> }
		).resources.set(
			"Secret/sandbox-sandbox-a-tls",
			runtimeTlsSecretFixture("sandbox-sandbox-a-tls", "session-a", [
				"other-sandbox.workload-test.svc",
			]),
		);
		await expect(adapter.observe(allocation)).resolves.toMatchObject({
			status: "unknown",
		});
	});

	it("fails closed when the Session leaf Secret is absent", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		(
			client as typeof client & { resources: Map<string, KubernetesObject> }
		).resources.delete("Secret/sandbox-sandbox-a-tls");
		await expect(adapter.observe(allocation)).resolves.toMatchObject({
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

	it("records each resource identity and blocks UID drift before any mutation", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		const before = await adapter.observe(allocation);
		expect(before.resources).toHaveLength(5);
		expect(
			new Set(before.resources.map((resource) => resource.kind)).size,
		).toBe(5);
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

	it("closes Pod and Service before stopped state returns", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		await adapter.apply({ ...allocation, desiredState: "stopped" });
		await expect(client.read("Pod", allocation.podName)).resolves.toBeNull();
		await expect(
			client.read("Service", allocation.serviceName),
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
			runAsNonRoot: true,
			readOnlyRootFilesystem: false,
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
				probe.httpGet.scheme = "HTTP";
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
		expect(receipt.retainedPVC.kind).toBe("PersistentVolumeClaim");
		expect(progress).toHaveLength(12);
		expect(
			progress.filter((entry) => entry.state === "delete-requested"),
		).toHaveLength(8);
		expect(progress.filter((entry) => entry.state === "absent")).toHaveLength(
			4,
		);
		expect(
			progress.filter((entry) => entry.result === "acknowledged"),
		).toHaveLength(8);
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
