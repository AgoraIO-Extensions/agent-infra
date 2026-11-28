import { randomUUID } from "node:crypto";
import type { KubernetesObject, V1Job, V1Pod } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { fakeKubernetesApi } from "./kubernetes.fixture.js";
import type { WorkerKubernetesClientV1 } from "./kubernetes-client.js";
import { createSessionMaintenanceViews } from "./maintenance-session-view.js";
import {
	maintenanceWorkload,
	prepareMaintenancePod,
} from "./maintenance-terminal-workload.js";

async function readyMaintenanceFixture(eci?: string, provider?: string) {
	const { client, resources } = fakeKubernetesApi();
	const options = {
		directoryId: randomUUID(),
		namespace: client.namespace,
		image: `registry.example.test/maintenance@sha256:${"a".repeat(64)}`,
		storageClass: "agent-nas",
		placement: { architecture: "amd64", legacyUnplaced: "reject" } as const,
	};
	const { pod, policy } = maintenanceWorkload(options);
	if (!pod.metadata || !pod.spec) throw new Error("Missing maintenance Pod");
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
	return { client, resources, options, live, policy };
}

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
			const { client, options, live } = await readyMaintenanceFixture(
				eci,
				provider,
			);
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

	it.each(["absent", "different", "additional"] as const)(
		"matches the ready Pod to every policy selector label (%s)",
		async (change) => {
			const { client, options, live } =
				await readyMaintenanceFixture("eci-test123");
			const labels = live.metadata?.labels;
			if (!labels) throw new Error("Missing maintenance labels");
			const agent = "agent-infra.agora.io/agent";
			if (change === "absent") delete labels[agent];
			if (change === "different") labels[agent] = "other-agent";
			if (change === "additional")
				labels["provider.example.test/zone"] = "zone-a";
			await client.replace(live);
			const ready = prepareMaintenancePod(
				client,
				options,
				AbortSignal.timeout(2000),
			);
			if (change === "additional")
				await expect(ready).resolves.toMatchObject({
					metadata: { uid: live.metadata?.uid },
				});
			else
				await expect(ready).rejects.toThrow(
					"Maintenance network policy mismatch",
				);
		},
	);

	it.each(["removed", "replaced", "terminating", "selector changed"] as const)(
		"requires the original maintenance policy when the Pod becomes ready (%s)",
		async (change) => {
			const { client, resources, options, policy } =
				await readyMaintenanceFixture("eci-test123");
			const original = await client.create(policy);
			const read = client.read.bind(client);
			client.read = async (kind, name) => {
				if (kind === "Pod") {
					const key = `NetworkPolicy/${name}`;
					if (change === "removed") resources.delete(key);
					else {
						const changed = structuredClone(original);
						if (!changed.metadata || !changed.spec)
							throw new Error("Missing test policy");
						if (change === "replaced") changed.metadata.uid = "another-uid";
						if (change === "terminating")
							changed.metadata.deletionTimestamp = new Date();
						if (change === "selector changed") changed.spec.podSelector = {};
						resources.set(key, changed);
					}
				}
				return read(kind, name);
			};
			await expect(
				prepareMaintenancePod(client, options, AbortSignal.timeout(2000)),
			).rejects.toThrow("Maintenance network policy mismatch");
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

it.each([
	["ACS", { "alibabacloud.com/instance-id": "acs-test123" }],
	["missing instance", {}],
	["invalid ECI instance", { "k8s.aliyun.com/eci-instance-id": "invalid" }],
	[
		"conflicting instances",
		{
			"k8s.aliyun.com/eci-instance-id": "eci-test123",
			"alibabacloud.com/instance-id": "acs-test123",
		},
	],
] as const)(
	"requires the configured compute on the Job Pod publishing a maintenance view (%s)",
	async (_case, annotations) => {
		const { client, seed } = fakeKubernetesApi();
		const scope = {
			agentId: "first-agent",
			sessionId: "session",
			sandboxId: randomUUID(),
		};
		const directoryId = randomUUID();
		const digest = "c".repeat(64);
		const recordMaintenanceView = vi.fn(async () => {});
		const views = createSessionMaintenanceViews(
			client,
			{
				namespace: client.namespace,
				image: `registry.test/runtime@sha256:${"b".repeat(64)}`,
				storageClass: "agent-nas",
				placement: { architecture: "amd64", legacyUnplaced: "reject" },
			},
			`sha256:${"a".repeat(64)}`,
			{
				readSessionMaintenanceBinding: async () => ({
					directoryId,
					receipt: null,
				}),
				recordMaintenanceView,
			},
		);
		const bind = () => views.bind(scope, 1);
		await expect(bind()).resolves.toBe(false);
		const name = `maint-view-${scope.sandboxId}`;
		const job = await client.read<V1Job>("Job", name);
		const uid = job?.metadata?.uid;
		const spec = job?.spec?.template.spec;
		if (!uid || !spec) throw new Error("Missing snapshot Job");
		await client.replace({
			...job,
			status: { conditions: [{ type: "Complete", status: "True" }] },
		});
		const pod: V1Pod = {
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				namespace: client.namespace,
				name: "snapshot",
				labels: { "batch.kubernetes.io/controller-uid": uid },
				ownerReferences: [
					{ apiVersion: "batch/v1", kind: "Job", name, uid, controller: true },
				],
				annotations: { ...annotations },
			},
			spec: { ...spec, nodeName: "virtual-kubelet-zone" },
			status: {
				phase: "Succeeded",
				containerStatuses: [
					{
						name: "snapshot",
						ready: false,
						image: "fixture",
						imageID: "fixture",
						restartCount: 0,
						state: { terminated: { exitCode: 0, message: digest } },
					},
				],
			},
		};
		seed(pod);
		await expect(bind()).rejects.toThrow(
			"Maintenance Pod compute does not match admitted ECI placement",
		);
		expect(recordMaintenanceView).not.toHaveBeenCalled();

		const eci = { "k8s.aliyun.com/eci-instance-id": "eci-test123" };
		// A failed earlier attempt and a different Job's success cannot supply the receipt.
		const failedAttempt: V1Pod = {
			...pod,
			status: {
				phase: "Failed",
				containerStatuses: pod.status?.containerStatuses?.map((status) => ({
					...status,
					state: { terminated: { exitCode: 1, message: "failed attempt" } },
				})),
			},
		};
		seed(failedAttempt);
		seed({
			...pod,
			metadata: {
				...pod.metadata,
				name: "foreign-snapshot",
				annotations: eci,
				ownerReferences: [
					{
						apiVersion: "batch/v1",
						kind: "Job",
						name,
						uid: "another-job",
						controller: true,
					},
				],
			},
		});
		await expect(bind()).rejects.toThrow("Missing maintenance view digest");
		expect(recordMaintenanceView).not.toHaveBeenCalled();
		seed({
			...pod,
			metadata: { ...pod.metadata, name: "snapshot-retry", annotations: eci },
		});
		await expect(bind()).resolves.toBe(true);
		expect(recordMaintenanceView).toHaveBeenCalledExactlyOnceWith(
			scope,
			directoryId,
			{ claimUid: expect.any(String), digest },
		);
	},
);

it.each([undefined, "claude", "opencode"] as const)(
	"checks the published view Job and its Pod on recovery (Native project %s)",
	checkPublishedView,
);

async function checkPublishedView(
	nativeProject: "claude" | "opencode" | undefined,
) {
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
					...(nativeProject ? [`--${nativeProject}-native`] : []),
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
	expect(await views.bind(scope, 1, nativeProject)).toBe(true);
	expect(receipt).toMatchObject({ digest });
	expect(issued).toBe(1);
	expect(await views.bind(scope, 2, nativeProject)).toBe(true);
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
	await expect(views.bind(scope, 3, nativeProject)).rejects.toThrow(
		"Invalid maintenance snapshot Pod",
	);
}
