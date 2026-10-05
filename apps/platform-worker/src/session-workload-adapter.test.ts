import type { SessionSandboxDeletionProgressV1 } from "@agent-infra/platform-core";
import type {
	KubernetesObject,
	V1PersistentVolumeClaim,
	V1Pod,
} from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import type {
	WorkerKubernetesClientV1,
	WorkloadResourceKind,
} from "./kubernetes-client.js";
import {
	createSessionSandboxWorkloadAdapterV1,
	type SessionSandboxAllocationV1,
	sessionSandboxResourcesV1,
} from "./session-workload-adapter.js";

const api = () => {
	const resources = new Map<string, KubernetesObject>();
	const key = (kind: string, name: string) => `${kind}/${name}`;
	const client: WorkerKubernetesClientV1 = {
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
		const originalDelete = client.delete;
		client.delete = async (resource) => {
			if (resource.kind === "Pod") throw new Error("delete transport lost");
			return originalDelete(resource);
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
		const originalDelete = client.delete;
		let deletes = 0;
		client.delete = async (object) => {
			deletes++;
			if (object.kind === "Pod") {
				const pod = resources.get(`Pod/${allocation.podName}`);
				if (!pod?.metadata) throw new Error("Missing Pod");
				pod.metadata.deletionTimestamp = new Date();
				pod.metadata.resourceVersion = "terminating";
				return;
			}
			return originalDelete(object);
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
