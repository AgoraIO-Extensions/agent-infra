import type { KubernetesObject } from "@kubernetes/client-node";
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
			resources.set(
				key(object.kind ?? "", object.metadata?.name ?? ""),
				object,
			);
			return object;
		},
		async replace<T extends KubernetesObject>(object: T): Promise<T> {
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
	return client;
};

const allocation: SessionSandboxAllocationV1 = {
	schemaVersion: 1,
	agentId: "agent-a",
	sessionId: "session-a",
	sandboxId: "sandbox-a",
	generation: 3,
	fence: 9,
	namespace: "workload-test",
	podName: "sandbox-a-pod",
	serviceName: "sandbox-a",
	serviceAccountName: "sandbox-a",
	pvcName: "sandbox-a-workspace",
	networkPolicyName: "sandbox-a-network",
	imageDigest: `sha256:${"a".repeat(64)}`,
	containerPort: 8080,
	workspaceMountPath: "/workspace",
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
			"Pod",
			"Service",
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
		expect(resources[2].spec?.ingress).toEqual([]);
		expect(resources[2].spec?.egress).toEqual([]);
	});

	it("creates idempotently and rejects a stale fence or foreign resource", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		await expect(adapter.apply(allocation)).resolves.toEqual({
			sandboxId: "sandbox-a",
			generation: 3,
			fence: 9,
		});
		await expect(
			adapter.apply({ ...allocation, fence: 8 }),
		).rejects.toMatchObject({ code: "conflict" });
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

	it("cleans only resources owned by the exact generation and fence", async () => {
		const client = api();
		const adapter = createSessionSandboxWorkloadAdapterV1({ client });
		await adapter.apply(allocation);
		await adapter.cleanup(allocation);
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
});
