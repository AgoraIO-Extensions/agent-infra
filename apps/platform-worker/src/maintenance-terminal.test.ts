import { randomUUID } from "node:crypto";
import type { KubernetesObject, V1Job, V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { fakeKubernetesApi } from "./kubernetes.fixture.js";
import type { WorkerKubernetesClientV1 } from "./kubernetes-client.js";
import { createSessionMaintenanceViews } from "./maintenance-session-view.js";
import {
	maintenanceWorkload,
	prepareMaintenancePod,
} from "./maintenance-terminal-workload.js";

describe("creator maintenance without a Conversation", () => {
	it.each([
		["ECI", "eci-test123", undefined, true],
		["ACS", undefined, "acs-test123", false],
		["unidentified", undefined, undefined, false],
		["invalid ECI identity", "invalid", undefined, false],
		["conflicting providers", "eci-test123", "acs-test123", false],
	] as const)(
		"checks a ready %s Pod against its admitted ECI placement",
		async (_name, eci, provider, admitted) => {
			const { client } = fakeKubernetesApi();
			const options = {
				directoryId: randomUUID(),
				namespace: client.namespace,
				image: `registry.example.test/maintenance@sha256:${"a".repeat(64)}`,
				storageClass: "agent-nas",
				placement: { architecture: "amd64", legacyUnplaced: "reject" } as const,
			};
			const { pod } = maintenanceWorkload(options);
			if (!pod.metadata || !pod.spec)
				throw new Error("Missing maintenance Pod");
			pod.spec.nodeName = "virtual-kubelet-zone";
			pod.metadata.annotations = {
				...(eci ? { "k8s.aliyun.com/eci-instance-id": eci } : {}),
				...(provider ? { "alibabacloud.com/instance-id": provider } : {}),
			};
			pod.status = {
				phase: "Running",
				containerStatuses: [
					{
						name: "maintenance",
						ready: true,
						image: options.image,
						imageID: options.image,
						restartCount: 0,
					},
				],
			};
			const live = await client.create(pod);
			const prepared = prepareMaintenancePod(
				client,
				options,
				AbortSignal.timeout(2000),
			);
			if (admitted)
				await expect(prepared).resolves.toMatchObject({
					metadata: { uid: live.metadata?.uid },
				});
			else
				await expect(prepared).rejects.toThrow(
					"Maintenance Pod compute does not match admitted ECI placement",
				);
		},
	);

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

it.each([false, true])(
	"checks the published view Job and its Pod on recovery (Native Claude %s)",
	checkPublishedView,
);

async function checkPublishedView(claudeNative: boolean) {
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
				expect(job.spec?.template.spec?.containers[0]?.command).toEqual([
					"node",
					"/app/dist/maintenance-view.mjs",
					...(claudeNative ? ["--claude-native"] : []),
					sandboxId,
					...(receipt ? [digest] : []),
				]);
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
				return { directoryId: root, receipt };
			},
			async recordMaintenanceView(_scope, _dir, binding) {
				receipt = binding;
			},
		},
	);
	expect(await views.bind(scope, 1, claudeNative)).toBe(true);
	expect(receipt).toMatchObject({ digest });
	expect(issued).toBe(1);
	expect(await views.bind(scope, 2, claudeNative)).toBe(true);
	expect(issued).toBe(2);
	for (const key of objects.keys())
		if (key.startsWith("Job/")) objects.delete(key);
	expect(
		await views.isPublished(scope.agentId, { directoryId: root, receipt }),
	).toBe(true);
	expect(
		await views.isPublished(scope.agentId, {
			directoryId: root,
			receipt: null,
		}),
	).toBe(false);
	expect(issued).toBe(2);
	changedPod = true;
	await expect(views.bind(scope, 3, claudeNative)).rejects.toThrow(
		"Invalid maintenance snapshot Pod",
	);
}
