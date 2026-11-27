import { randomUUID } from "node:crypto";
import type { KubernetesObject, V1Job, V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import type { WorkerKubernetesClientV1 } from "./kubernetes-client.js";
import { createSessionMaintenanceViews } from "./maintenance-session-view.js";
import { maintenanceWorkload } from "./maintenance-terminal-workload.js";

describe("creator maintenance without a Conversation", () => {
	it("mounts only the Agent directory and temporary storage in a credential-free Pod", () => {
		const workload = maintenanceWorkload({
			directoryId: "ccff9c1e-b70e-4a8d-8d3b-99cfd28a7422",
			namespace: "agents",
			image: `registry.example.test/maintenance@sha256:${"a".repeat(64)}`,
			storageClass: "agent-nas",
		});
		expect(workload.pod.spec?.automountServiceAccountToken).toBe(false);
		expect(workload.pod.spec?.containers).toHaveLength(1);
		expect(workload.pod.spec?.containers[0]?.workingDir).toBe("/deployment");
		expect(workload.pod.spec?.volumes).toEqual([
			{
				name: "deployment",
				persistentVolumeClaim: { claimName: workload.claim.metadata?.name },
			},
			{ name: "tmp", emptyDir: {} },
		]);
		expect(workload.claim.spec?.accessModes).toEqual(["ReadWriteMany"]);
		expect(workload.policy.spec?.egress).toEqual([]);
		expect(workload.policy.spec?.ingress).toEqual([]);
	});
});

it("binds a published view to the original volume and checks the actual Job Pod on recovery", async () => {
	const namespace = "agents";
	const root = randomUUID();
	const sandboxId = randomUUID();
	const digest = "c".repeat(64);
	const scope = {
		agentId: "first-agent",
		sessionId: "first-session",
		sandboxId,
	};
	const objects = new Map<string, KubernetesObject>();
	const pods: V1Pod[] = [];
	let receipt: { claimUid: string; digest: string } | null = null;
	let changedPod = false;
	let issued = 0;
	const client: WorkerKubernetesClientV1 = {
		namespace,
		async read<T extends KubernetesObject>(kind: string, name: string) {
			return (objects.get(`${kind}/${name}`) as T) ?? null;
		},
		async list<T extends KubernetesObject>(_kind: string, selector: string) {
			return pods.filter((p) =>
				selector.endsWith(p.metadata?.ownerReferences?.[0]?.uid ?? "invalid"),
			) as T[];
		},
		async create<T extends KubernetesObject>(obj: T) {
			const current = structuredClone(obj);
			const uid = randomUUID();
			current.metadata = { ...current.metadata, uid, resourceVersion: "1" };
			objects.set(`${current.kind}/${current.metadata.name}`, current);
			if (current.kind === "Job") {
				++issued;
				const job = current as V1Job;
				job.status = { conditions: [{ type: "Complete", status: "True" }] };
				const spec = structuredClone(job.spec?.template.spec);
				if (!spec?.containers[0]?.volumeMounts?.[0])
					throw new Error("Missing snapshot mounts");
				if (changedPod)
					spec.containers[0].volumeMounts[0].mountPath = "/unexpected";
				pods.push({
					metadata: {
						namespace,
						ownerReferences: [
							{
								apiVersion: "batch/v1",
								kind: "Job",
								name: current.metadata.name ?? "",
								uid,
								controller: true,
							},
						],
					},
					spec,
					status: {
						containerStatuses: [
							{
								name: "snapshot",
								image: "fixture",
								imageID: "fixture",
								ready: false,
								restartCount: 0,
								state: { terminated: { exitCode: 0, message: digest } },
							},
						],
					},
				});
			}
			return current;
		},
		async replace<T extends KubernetesObject>(_o: T): Promise<T> {
			throw new Error("unexpected replace");
		},
		async delete(obj) {
			objects.delete(`${obj.kind}/${obj.metadata?.name}`);
		},
	};
	const views = createSessionMaintenanceViews(
		client,
		{
			namespace,
			storageClass: "agent-nas",
			image: `registry.test/runtime@sha256:${"b".repeat(64)}`,
		},
		`sha256:${"a".repeat(64)}`,
		{
			async readSessionMaintenanceBinding() {
				return { directoryId: root, boundAt: 123, receipt };
			},
			async recordMaintenanceView(_scope, _dir, binding) {
				receipt = binding;
			},
		},
	);
	expect(await views.bind(scope, 1)).toBe(true);
	expect(receipt).toMatchObject({ digest });
	expect(issued).toBe(1);
	expect(await views.bind(scope, 2)).toBe(true);
	expect(issued).toBe(2);
	changedPod = true;
	await expect(views.bind(scope, 3)).rejects.toThrow(
		"Invalid maintenance snapshot Pod",
	);
});
