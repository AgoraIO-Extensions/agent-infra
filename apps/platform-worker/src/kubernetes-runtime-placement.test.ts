import type { V1Pod, V1PodSpec, V1StatefulSet } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { fixture } from "./kubernetes-runtime-adapter.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";
import {
	sessionSandboxModelProjectionFixture,
	sessionSandboxRuntimeAuthFixture,
} from "./test-support/session-sandbox-v4.js";

// #4351: Agent-level Pods run only where NetworkPolicy is enforced (Spec §10.1).
const eciSelector = { type: "virtual-kubelet", "kubernetes.io/arch": "amd64" };
const providerToleration = {
	key: "virtual-kubelet.io/provider",
	operator: "Equal",
	value: "alibabacloud",
	effect: "NoSchedule",
};
const eciAnnotations = {
	"k8s.aliyun.com/eci-instance-id": "eci-bp1example0001",
	"k8s.aliyun.com/eci-request-id": "45942504-4688-51BA-BBAB-4B692C4F39C0",
	"k8s.aliyun.com/eci-instance-spec": "1.0-2.0Gi",
	"k8s.aliyun.com/eci-instance-cpu": "1.0",
	"k8s.aliyun.com/eci-instance-mem": "2.0",
	"k8s.aliyun.com/eci-platform-version": "1.1.0",
	"k8s.aliyun.com/eci-schedule-result": "finished",
};

function placed(legacyUnplaced: "retain-until-lifecycle" | "reject") {
	return {
		...workloadTestPolicy,
		allowedPodTopologyLabelValues: {
			"topology.kubernetes.io/zone": ["cn-hangzhou-i"],
		},
		agentWorkloadPlacement: { architecture: "amd64", legacyUnplaced },
	} as typeof workloadTestPolicy;
}

function adapterFor(
	f: ReturnType<typeof fixture>,
	policy: typeof workloadTestPolicy,
) {
	return createKubernetesRuntimeAdapterV1({
		client: f.client,
		probe: f.probe,
		policy,
	});
}

/** What ACK writes on a live ECI Pod created from the injected template. */
function scheduleOnEci(f: ReturnType<typeof fixture>, name: string) {
	const key = `Pod/${name}-0`;
	const pod = structuredClone(f.resources.get(key)) as V1Pod;
	if (!pod.metadata || !pod.spec) throw new Error("missing pod");
	pod.metadata.labels = {
		...pod.metadata.labels,
		"topology.kubernetes.io/zone": "cn-hangzhou-i",
	};
	pod.metadata.annotations = { ...pod.metadata.annotations, ...eciAnnotations };
	pod.spec.nodeName = "virtual-kubelet-cn-hangzhou-i";
	pod.spec.tolerations = [
		...(pod.spec.tolerations ?? []),
		{
			key: "node.kubernetes.io/not-ready",
			operator: "Exists",
			effect: "NoExecute",
		},
		{
			key: "node.kubernetes.io/unreachable",
			operator: "Exists",
			effect: "NoExecute",
		},
	];
	f.resources.set(key, pod);
	return { key, pod };
}

async function applyWorkload(
	adapter: ReturnType<typeof createKubernetesRuntimeAdapterV1>,
	desired: ReturnType<typeof workloadDesiredFixture>,
) {
	const identity = await adapter.apply(desired);
	if (!identity || identity === "pending") throw new Error("missing identity");
	return identity;
}

describe("deployment-authoritative Agent workload placement", () => {
	it("validates ACS startup policy before a template is selected", async () => {
		const f = fixture();
		let adapter:
			| ReturnType<typeof createKubernetesRuntimeAdapterV1>
			| undefined;
		expect(() => {
			adapter = adapterFor(f, {
				...placed("reject"),
				agentWorkloadPlacement: {
					architecture: "amd64",
					compute: "acs",
					legacyUnplaced: "reject",
				},
			});
		}).not.toThrow();
		await expect(
			adapter!.apply(workloadDesiredFixture()),
		).rejects.toMatchObject({ code: "policy" });
		expect(f.resources.size).toBe(0);
	});

	it("creates the SDK Codex validation Host on ACS without Native isolation inputs", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture(1, "agent-a", "internal-only");
		const adapter = createKubernetesRuntimeAdapterV1({
			client: f.client,
			probe: f.probe,
			modelProjection: sessionSandboxModelProjectionFixture({
				agentId: desired.agentId,
				configurationRevision: desired.configRevision,
				imageDigest: desired.imageDigest,
				transport: "paseo-sdk-pod",
			}),
			policy: {
				...placed("reject"),
				codexContainerBoundaryEnabled: true,
				runtimeAuth: sessionSandboxRuntimeAuthFixture,
				agentWorkloadPlacement: {
					architecture: "amd64",
					legacyUnplaced: "reject",
					compute: "acs",
				},
			},
		});
		const identity = await applyWorkload(adapter, desired);
		const workload = f.resources.get(
			`StatefulSet/${desired.service.name}`,
		) as V1StatefulSet;
		expect(workload.spec?.template.spec?.containers).toHaveLength(1);
		const environment = workload.spec?.template.spec?.containers[0]?.env;
		expect(environment).toContainEqual({
			name: "AGENT_INFRA_RUNTIME_TRANSPORT",
			value: "paseo-sdk-pod",
		});
		expect(
			environment?.some(
				(entry) => entry.name === "AGENT_INFRA_RUNTIME_ISOLATION_MODE",
			),
		).toBe(false);
		expect(workload.spec?.template.metadata?.labels).toMatchObject({
			"alibabacloud.com/acs": "true",
			"alibabacloud.com/compute-class": "general-purpose",
			"alibabacloud.com/compute-qos": "default",
		});
		expect(workload.spec?.template.metadata?.annotations).toMatchObject({
			"network.alibabacloud.com/enable-network-policy-agent": "true",
		});
		const pendingPod = f.resources.get(
			`Pod/${desired.service.name}-0`,
		) as V1Pod;
		const readyStatus = structuredClone(pendingPod.status);
		pendingPod.status = { phase: "Pending" };
		expect(await adapter.observe(desired, identity)).toBe("pending");
		await adapter.apply(desired);
		expect(
			(f.resources.get(`StatefulSet/${desired.service.name}`) as V1StatefulSet)
				.spec?.replicas,
		).toBe(1);
		const { key, pod } = scheduleOnEci(f, desired.service.name);
		pod.status = readyStatus;
		pod.metadata!.annotations = {
			...workload.spec?.template.metadata?.annotations,
			"alibabacloud.com/instance-id": "acs-synthetic0001",
		};
		const requests = pod.spec?.containers[0]?.resources?.requests;
		if (!requests) throw new Error("missing requests");
		requests["ephemeral-storage"] = "30Gi";
		f.resources.set(key, pod);
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		const current = f.resources.get(
			`StatefulSet/${desired.service.name}`,
		) as V1StatefulSet;
		const authored =
			current.spec?.template.spec?.containers[0]?.resources?.requests;
		if (!authored) throw new Error("missing template requests");
		authored["ephemeral-storage"] = "30Gi";
		expect(await adapter.observe(desired, identity)).toBe("drifted");
		delete authored["ephemeral-storage"];
		requests["ephemeral-storage"] = "90Gi";
		expect(await adapter.observe(desired, identity)).toBe("drifted");
	});

	it("injects the exact ECI placement and accepts the live ECI Pod it produces", async () => {
		const f = fixture();
		const adapter = adapterFor(f, placed("reject"));
		const desired = workloadDesiredFixture();
		const identity = await applyWorkload(adapter, desired);
		const workload = f.resources.get(
			`StatefulSet/${desired.service.name}`,
		) as V1StatefulSet;
		const template = workload.spec?.template.spec;
		expect(template?.nodeSelector).toEqual(eciSelector);
		expect(template?.tolerations).toEqual([providerToleration]);
		expect(template?.affinity).toBeUndefined();
		expect(template?.runtimeClassName).toBeUndefined();
		scheduleOnEci(f, desired.service.name);
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		const writes = f.writes.length;
		await adapter.apply(desired);
		expect(f.writes).toHaveLength(writes);
	});

	it("keeps the same Pod after ECI adds its bound live metadata", async () => {
		const f = fixture();
		const policy = {
			...placed("reject"),
			allowedPodTopologyLabelValues: {
				"topology.kubernetes.io/region": ["cn-hangzhou"],
				"topology.kubernetes.io/zone": ["cn-hangzhou-i"],
			},
		};
		const adapter = adapterFor(f, policy);
		const desired = workloadDesiredFixture();
		const identity = await applyWorkload(adapter, desired);
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		const { key, pod } = scheduleOnEci(f, desired.service.name);
		if (!pod.metadata?.uid || !pod.metadata.namespace)
			throw new Error("missing Pod identity");
		pod.metadata.labels = {
			...pod.metadata.labels,
			"topology.kubernetes.io/region": "cn-hangzhou",
		};
		pod.metadata.annotations = {
			...pod.metadata.annotations,
			ProviderCreate: "done",
			"alibabacloud.com/cluster-id": `c${"1".repeat(32)}`,
			"alibabacloud.com/user-resource-name": pod.metadata.name ?? "",
			"alibabacloud.com/user-resource-namespace": pod.metadata.namespace,
			"alibabacloud.com/user-resource-uid": pod.metadata.uid,
			"k8s.aliyun.com/cluster-dns": "10.96.0.10",
			"k8s.aliyun.com/cluster-domain": "cluster.local",
			"k8s.aliyun.com/dns-cache-enable": "false",
			"k8s.aliyun.com/eci-client-token": "11111111-2222-4333-8444-555555555555",
			"k8s.aliyun.com/eci-container-exit-priority": "{}",
			"k8s.aliyun.com/eci-created-by-template": "true",
			"k8s.aliyun.com/eci-drop-apiserver-interactive-caps": "",
			"k8s.aliyun.com/eci-instance-zone": "cn-hangzhou-i",
			"k8s.aliyun.com/eci-kube-proxy-enabled": "true",
			"k8s.aliyun.com/eci-matched-image-cache": "imc-fixture1",
			"k8s.aliyun.com/eci-schedule-strategy": "VSwitchRandom",
			"k8s.aliyun.com/eci-security-group": "sg-fixture1",
			"k8s.aliyun.com/eci-vpc": "vpc-fixture1",
			"k8s.aliyun.com/eci-vswitch": "vsw-fixture1",
			"k8s.aliyun.com/eni-instance-id": "eni-fixture1",
			"k8s.aliyun.com/k8s-version": "v1.30.7-aliyun.1",
			"k8s.aliyun.com/product-on-eci-mode": "NA",
			"k8s.aliyun.com/vk-version": "v1.2.3-20261125",
			"kubernetes.io/pod-stream-port": "10250",
			"kubernetes.io/preferred-scheduling-node": `${pod.spec?.nodeName}/1`,
			"kubernetes.io/resource-type": "eci",
		};
		f.resources.set(key, pod);
		const writes = f.writes.length;
		for (let iteration = 0; iteration < 3; iteration++) {
			expect(await adapter.observe(desired, identity)).toBe("healthy");
			expect(await adapter.apply(desired)).toEqual(identity);
			expect(f.resources.get(key)?.metadata?.uid).toBe(pod.metadata.uid);
			expect(f.writes).toHaveLength(writes);
		}
	});

	it("keeps an owned Pending Pod when the ECI scheduling hint precedes node binding", async () => {
		const f = fixture();
		const adapter = adapterFor(f, placed("reject"));
		const desired = workloadDesiredFixture();
		const identity = await applyWorkload(adapter, desired);
		const key = `Pod/${desired.service.name}-0`;
		const pod = structuredClone(f.resources.get(key)) as V1Pod;
		if (!pod.metadata || !pod.spec) throw new Error("missing Pod");
		const readyStatus = pod.status;
		delete pod.spec.nodeName;
		pod.metadata.annotations = {
			...pod.metadata.annotations,
			"kubernetes.io/preferred-scheduling-node":
				"virtual-kubelet-cn-hangzhou-i/1",
		};
		pod.status = { phase: "Pending", containerStatuses: [] };
		f.resources.set(key, pod);
		const writes = f.writes.length;
		for (let iteration = 0; iteration < 3; iteration++) {
			expect(await adapter.observe(desired, identity)).toBe("pending");
			expect(await adapter.apply(desired)).toEqual(identity);
			expect(f.resources.get(key)?.metadata?.uid).toBe(pod.metadata.uid);
			expect(f.writes).toHaveLength(writes);
		}
		pod.spec.nodeName = "virtual-kubelet-cn-hangzhou-i";
		pod.status = readyStatus;
		f.resources.set(key, pod);
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		expect(await adapter.apply(desired)).toEqual(identity);
		expect(f.writes).toHaveLength(writes);
		pod.spec.nodeName = "virtual-kubelet-cn-hangzhou-other";
		expect(await adapter.observe(desired, identity)).toBe("drifted");
	});

	it.each([
		"ecs-cn-hangzhou-i/1",
		"virtual-kubelet-/1",
		"virtual-kubelet-CN-hangzhou-i/1",
		"virtual-kubelet-cn-hangzhou-i/2",
		"virtual-kubelet-cn-hangzhou-i//1",
		"virtual-kubelet-cn-hangzhou-i/1\n",
		`virtual-kubelet-${"a".repeat(48)}/1`,
		`virtual-kubelet-a.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(45)}/1`,
	])(
		"rejects an unbound ECI scheduling hint with an invalid node or encoding: %s",
		async (hint) => {
			const f = fixture();
			const adapter = adapterFor(f, placed("reject"));
			const desired = workloadDesiredFixture();
			const identity = await applyWorkload(adapter, desired);
			const key = `Pod/${desired.service.name}-0`;
			const pod = structuredClone(f.resources.get(key)) as V1Pod;
			if (!pod.metadata || !pod.spec) throw new Error("missing Pod");
			delete pod.spec.nodeName;
			pod.metadata.annotations = {
				...pod.metadata.annotations,
				"kubernetes.io/preferred-scheduling-node": hint,
			};
			f.resources.set(key, pod);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
		},
	);

	it("rejects an ECI scheduling hint on an unplaced live Pod", async () => {
		const f = fixture();
		const adapter = adapterFor(f, workloadTestPolicy);
		const desired = workloadDesiredFixture();
		const identity = await applyWorkload(adapter, desired);
		const key = `Pod/${desired.service.name}-0`;
		const pod = structuredClone(f.resources.get(key)) as V1Pod;
		if (!pod.metadata) throw new Error("missing Pod metadata");
		pod.metadata.annotations = {
			...pod.metadata.annotations,
			"kubernetes.io/preferred-scheduling-node":
				"virtual-kubelet-cn-hangzhou-i/1",
		};
		f.resources.set(key, pod);
		expect(await adapter.observe(desired, identity)).toBe("drifted");
	});

	it.each([
		["ProviderCreate", "done\n"],
		["alibabacloud.com/user-resource-name", "another-agent-0"],
		["alibabacloud.com/user-resource-namespace", "another-namespace"],
		["alibabacloud.com/user-resource-uid", "another-pod-uid"],
		["k8s.aliyun.com/eci-instance-zone", "cn-hangzhou-other"],
		[
			"kubernetes.io/preferred-scheduling-node",
			"virtual-kubelet-cn-hangzhou-other/1",
		],
		[
			"kubernetes.io/preferred-scheduling-node",
			"virtual-kubelet-cn-hangzhou-i/2",
		],
		["k8s.aliyun.com/product-on-eci-mode", "unreviewed"],
		["k8s.aliyun.com/eci-container-exit-priority", '{"agent":0}'],
		["k8s.aliyun.com/eci-drop-apiserver-interactive-caps", "exec"],
		["k8s.aliyun.com/cluster-dns", "https://10.96.0.10"],
		["k8s.aliyun.com/eci-client-token", "not-a-uuid"],
	])("rejects a live %s value %s", async (key, invalid) => {
		const f = fixture();
		const adapter = adapterFor(f, placed("reject"));
		const desired = workloadDesiredFixture();
		const identity = await applyWorkload(adapter, desired);
		const { key: podKey, pod } = scheduleOnEci(f, desired.service.name);
		if (!pod.metadata?.annotations) throw new Error("missing Pod metadata");
		const valid: Record<string, string> = {
			ProviderCreate: "done",
			"alibabacloud.com/user-resource-name": pod.metadata.name ?? "",
			"alibabacloud.com/user-resource-namespace": pod.metadata.namespace ?? "",
			"alibabacloud.com/user-resource-uid": pod.metadata.uid ?? "",
			"k8s.aliyun.com/eci-instance-zone": "cn-hangzhou-i",
			"kubernetes.io/preferred-scheduling-node": `${pod.spec?.nodeName}/1`,
			"k8s.aliyun.com/product-on-eci-mode": "NA",
			"k8s.aliyun.com/eci-container-exit-priority": "{}",
			"k8s.aliyun.com/eci-drop-apiserver-interactive-caps": "",
			"k8s.aliyun.com/cluster-dns": "10.96.0.10",
			"k8s.aliyun.com/eci-client-token": "11111111-2222-4333-8444-555555555555",
		};
		pod.metadata.annotations[key] = valid[key] ?? "";
		f.resources.set(podKey, pod);
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		pod.metadata.annotations[key] = invalid;
		f.resources.set(podKey, pod);
		expect(await adapter.observe(desired, identity)).toBe("drifted");
	});

	it.each([
		["ProviderCreate", "done"],
		[
			"kubernetes.io/preferred-scheduling-node",
			"virtual-kubelet-cn-hangzhou-i/1",
		],
	])(
		"rejects live-only ECI metadata copied into the controller template: %s",
		async (annotation, value) => {
			const f = fixture();
			const adapter = adapterFor(f, placed("reject"));
			const desired = workloadDesiredFixture();
			const identity = await applyWorkload(adapter, desired);
			const key = `StatefulSet/${desired.service.name}`;
			const workload = structuredClone(f.resources.get(key)) as V1StatefulSet;
			if (!workload.spec) throw new Error("missing template");
			workload.spec.template.metadata = {
				...workload.spec.template.metadata,
				annotations: { [annotation]: value },
			};
			f.resources.set(key, workload);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
		},
	);

	it("rejects a provider topology value not approved by deployment", async () => {
		const f = fixture();
		const adapter = adapterFor(f, placed("reject"));
		const desired = workloadDesiredFixture();
		const identity = await applyWorkload(adapter, desired);
		const { key, pod } = scheduleOnEci(f, desired.service.name);
		if (!pod.metadata) throw new Error("missing Pod metadata");
		pod.metadata.labels = {
			...pod.metadata.labels,
			"topology.kubernetes.io/zone": "cn-hangzhou-other",
		};
		f.resources.set(key, pod);
		expect(await adapter.observe(desired, identity)).toBe("drifted");
	});

	it.each([
		[
			"extra selector",
			(pod: V1Pod) => {
				Object.assign(pod.spec?.nodeSelector ?? {}, { pool: "owner" });
			},
		],
		[
			"ECS selector",
			(pod: V1Pod) => {
				if (pod.spec) pod.spec.nodeSelector = { "kubernetes.io/arch": "amd64" };
			},
		],
		[
			"affinity",
			(pod: V1Pod) => {
				if (pod.spec) pod.spec.affinity = { nodeAffinity: {} };
			},
		],
		[
			"runtimeClass",
			(pod: V1Pod) => {
				if (pod.spec) pod.spec.runtimeClassName = "runc";
			},
		],
		[
			"foreign toleration",
			(pod: V1Pod) => {
				pod.spec?.tolerations?.push({ operator: "Exists" });
			},
		],
		[
			"missing provider toleration",
			(pod: V1Pod) => {
				if (pod.spec)
					pod.spec.tolerations = pod.spec.tolerations?.filter(
						(entry) => entry.key !== "virtual-kubelet.io/provider",
					);
			},
		],
		[
			"duplicate provider toleration",
			(pod: V1Pod) => {
				pod.spec?.tolerations?.push({ ...providerToleration });
			},
		],
		[
			"ECS node",
			(pod: V1Pod) => {
				if (pod.spec) pod.spec.nodeName = "cn-hangzhou.10.0.0.12";
			},
		],
		[
			"EIP allocation",
			(pod: V1Pod) => {
				Object.assign(pod.metadata?.annotations ?? {}, {
					"k8s.aliyun.com/allocated-eipAddress": "47.99.0.1",
				});
			},
		],
		[
			"unknown provider annotation",
			(pod: V1Pod) => {
				Object.assign(pod.metadata?.annotations ?? {}, {
					"k8s.aliyun.com/eci-with-eip": "true",
				});
			},
		],
		[
			"malformed provider annotation",
			(pod: V1Pod) => {
				Object.assign(pod.metadata?.annotations ?? {}, {
					"k8s.aliyun.com/eci-instance-id": "i-foreign",
				});
			},
		],
	])("treats a live Pod with %s as drift", async (_name, mutate) => {
		const f = fixture();
		const adapter = adapterFor(f, placed("retain-until-lifecycle"));
		const desired = workloadDesiredFixture();
		const identity = await applyWorkload(adapter, desired);
		const { key, pod } = scheduleOnEci(f, desired.service.name);
		mutate(pod);
		f.resources.set(key, pod);
		expect(await adapter.observe(desired, identity)).toBe("drifted");
	});

	it.each([
		["nodeSelector", { nodeSelector: { ...eciSelector, pool: "owner" } }],
		[
			"tolerations",
			{ tolerations: [providerToleration, { operator: "Exists" }] },
		],
		["no placement", { nodeSelector: undefined, tolerations: undefined }],
		["affinity", { affinity: { nodeAffinity: {} } }],
		["runtimeClassName", { runtimeClassName: "runc" }],
		["nodeName", { nodeName: "virtual-kubelet-cn-hangzhou-i" }],
	])(
		"treats a StatefulSet template with altered %s as drift",
		async (_name, patch) => {
			const f = fixture();
			const adapter = adapterFor(f, placed("reject"));
			const desired = workloadDesiredFixture();
			const identity = await applyWorkload(adapter, desired);
			const key = `StatefulSet/${desired.service.name}`;
			const workload = structuredClone(f.resources.get(key)) as V1StatefulSet;
			if (!workload.spec?.template.spec) throw new Error("missing template");
			Object.assign(workload.spec.template.spec, patch);
			f.resources.set(key, workload);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
		},
	);

	it("keeps an unplaced Pod free of ECI provider annotations", async () => {
		const f = fixture();
		const adapter = adapterFor(f, placed("retain-until-lifecycle"));
		const legacy = adapterFor(f, workloadTestPolicy);
		const desired = workloadDesiredFixture();
		const identity = await applyWorkload(legacy, desired);
		const key = `Pod/${desired.service.name}-0`;
		const pod = structuredClone(f.resources.get(key)) as V1Pod;
		if (!pod.metadata) throw new Error("missing pod");
		pod.metadata.annotations = { ...eciAnnotations };
		f.resources.set(key, pod);
		expect(await adapter.observe(desired, identity)).toBe("drifted");
		expect(await legacy.observe(desired, identity)).toBe("drifted");
	});

	it.each(["restart", "stop/start"] as const)(
		"retains a pre-placement Host without rebuild until one %s lifecycle moves it",
		async (lifecycle) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const identity = await applyWorkload(
				adapterFor(f, workloadTestPolicy),
				desired,
			);
			const name = desired.service.name;
			const legacyPod = (f.resources.get(`Pod/${name}-0`) as V1Pod).metadata
				?.uid;
			const retained = adapterFor(f, placed("retain-until-lifecycle"));
			const writes = f.writes.length;
			expect(await retained.observe(desired, identity)).toBe("healthy");
			expect(f.writes).toHaveLength(writes);
			expect((f.resources.get(`Pod/${name}-0`) as V1Pod).metadata?.uid).toBe(
				legacyPod,
			);
			// The same exact legacy object is drift once the transition ends.
			expect(
				await adapterFor(f, placed("reject")).observe(desired, identity),
			).toBe("drifted");
			expect(f.writes).toHaveLength(writes);

			if (lifecycle === "stop/start") {
				const stopped = { ...desired, desiredState: "stopped", replicas: 0 };
				expect(await retained.apply(stopped)).toBe("pending");
				await retained.apply(stopped);
				expect(f.resources.get(`Pod/${name}-0`)).toBeUndefined();
			}
			// One formal lifecycle (next revision and fence) writes the placement.
			const restarted = {
				...desired,
				workloadRevision: 2,
				fence: 2,
				requestId: "restart-1",
			};
			let next = await retained.apply(restarted);
			if (next === "pending") next = await retained.apply(restarted);
			if (!next || next === "pending") throw new Error("missing identity");
			const podTemplates = f.writes
				.slice(writes)
				.filter(
					(write) =>
						write.kind === "StatefulSet" &&
						((write as V1StatefulSet).spec?.replicas ?? 0) > 0,
				)
				.map((write) =>
					JSON.stringify((write as V1StatefulSet).spec?.template.spec),
				);
			expect(new Set(podTemplates).size).toBe(1);
			const template = (f.resources.get(`StatefulSet/${name}`) as V1StatefulSet)
				.spec?.template.spec;
			expect(template?.nodeSelector).toEqual(eciSelector);
			expect(template?.tolerations).toEqual([providerToleration]);
			expect(
				(f.resources.get(`Pod/${name}-0`) as V1Pod).metadata?.uid,
			).not.toBe(legacyPod);
			scheduleOnEci(f, name);
			expect(await retained.observe(restarted, next)).toBe("healthy");
			const after = f.writes.length;
			await retained.apply(restarted);
			expect(f.writes).toHaveLength(after);
		},
	);

	it.each([
		{ architecture: "amd64" },
		{ architecture: "s390x", legacyUnplaced: "reject" },
		{ architecture: "amd64", legacyUnplaced: "ignore" },
		{
			architecture: "amd64",
			legacyUnplaced: "reject",
			runtimeClassName: "runv",
		},
		{ architecture: "amd64", legacyUnplaced: "reject", nodeSelector: {} },
		"amd64",
		null,
	])(
		"rejects invalid deployment placement %j at construction",
		(agentWorkloadPlacement) => {
			const f = fixture();
			expect(() =>
				adapterFor(f, {
					...workloadTestPolicy,
					agentWorkloadPlacement,
				} as unknown as typeof workloadTestPolicy),
			).toThrow();
		},
	);
});

describe("adopted placement is fixed per Agent until its next lifecycle (#4351 MUST-C)", () => {
	const placedAs = (architecture: "amd64" | "arm64") =>
		({
			...placed("reject"),
			agentWorkloadPlacement: { architecture, legacyUnplaced: "reject" },
		}) as typeof workloadTestPolicy;

	it("records the injected placement on the StatefulSet", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		await applyWorkload(adapterFor(f, placedAs("amd64")), desired);
		const workload = f.resources.get(
			`StatefulSet/${desired.service.name}`,
		) as V1StatefulSet;
		expect(
			workload.metadata?.annotations?.[
				"agent-infra.agora.io/agent-workload-placement"
			],
		).toBe("amd64");
	});

	it.each(["arm64 placement", "no placement"] as const)(
		"a configuration change to %s writes nothing until one lifecycle adopts it",
		async (change) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const identity = await applyWorkload(
				adapterFor(f, placedAs("amd64")),
				desired,
			);
			const name = desired.service.name;
			scheduleOnEci(f, name);
			const pod = (f.resources.get(`Pod/${name}-0`) as V1Pod).metadata?.uid;
			const changed = adapterFor(
				f,
				change === "arm64 placement"
					? placedAs("arm64")
					: ({
							...placed("reject"),
							agentWorkloadPlacement: undefined,
						} as typeof workloadTestPolicy),
			);
			const writes = f.writes.length;
			expect(await changed.observe(desired, identity)).toBe("healthy");
			// The original intent (same revision and fence) is also not a rebuild.
			await changed.apply(desired);
			expect(f.writes).toHaveLength(writes);
			expect((f.resources.get(`Pod/${name}-0`) as V1Pod).metadata?.uid).toBe(
				pod,
			);
			if (change === "no placement") return;
			const restarted = {
				...desired,
				workloadRevision: 2,
				fence: 2,
				requestId: "restart-arm64",
			};
			let next = await changed.apply(restarted);
			if (next === "pending") next = await changed.apply(restarted);
			if (!next || next === "pending") throw new Error("missing identity");
			const templates = f.writes
				.slice(writes)
				.filter(
					(write) =>
						write.kind === "StatefulSet" &&
						((write as V1StatefulSet).spec?.replicas ?? 0) > 0,
				)
				.map((write) =>
					JSON.stringify((write as V1StatefulSet).spec?.template.spec),
				);
			expect(new Set(templates).size).toBe(1);
			const workload = f.resources.get(`StatefulSet/${name}`) as V1StatefulSet;
			expect(workload.spec?.template.spec?.nodeSelector).toEqual({
				type: "virtual-kubelet",
				"kubernetes.io/arch": "arm64",
			});
			expect(
				workload.metadata?.annotations?.[
					"agent-infra.agora.io/agent-workload-placement"
				],
			).toBe("arm64");
		},
	);

	it.each([
		"missing record",
		"record for another architecture",
		"invalid record",
	] as const)(
		"treats ECI fields with a %s as drift (no kubectl patch adoption)",
		async (mode) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const identity = await applyWorkload(
				adapterFor(f, placedAs("amd64")),
				desired,
			);
			const key = `StatefulSet/${desired.service.name}`;
			const workload = structuredClone(f.resources.get(key)) as V1StatefulSet;
			const annotations = workload.metadata?.annotations ?? {};
			if (mode === "missing record")
				delete annotations["agent-infra.agora.io/agent-workload-placement"];
			else
				annotations["agent-infra.agora.io/agent-workload-placement"] =
					mode === "invalid record" ? "s390x" : "arm64";
			f.resources.set(key, workload);
			expect(
				await adapterFor(f, placedAs("amd64")).observe(desired, identity),
			).toBe("drifted");
		},
	);
});

describe("deployment placement source (#4351 MUST-A)", () => {
	it("reads only the chart-rendered env and rejects a module-supplied value", async () => {
		const { agentWorkloadPlacementFromEnvironmentV1 } = await import(
			"./agent-workload-placement.js"
		);
		expect(agentWorkloadPlacementFromEnvironmentV1(undefined, false)).toBe(
			undefined,
		);
		expect(
			agentWorkloadPlacementFromEnvironmentV1(
				'{"architecture":"amd64","legacyUnplaced":"retain-until-lifecycle"}',
				false,
			),
		).toEqual({
			architecture: "amd64",
			legacyUnplaced: "retain-until-lifecycle",
		});
		for (const [value, configuredInModule] of [
			[undefined, true],
			['{"architecture":"amd64","legacyUnplaced":"reject"}', true],
			["{", false],
			["null", false],
			['{"architecture":"amd64"}', false],
			[
				'{"architecture":"amd64","legacyUnplaced":"reject","runtimeClassName":"runv"}',
				false,
			],
		] as const)
			expect(() =>
				agentWorkloadPlacementFromEnvironmentV1(value, configuredInModule),
			).toThrow("AGENT_WORKLOAD_PLACEMENT_INVALID");
	});
});

describe("drift repair is not a lifecycle adoption (#4351 round 2 MUST-3)", () => {
	const placedAs = (architecture: "amd64" | "arm64") =>
		({
			...placed("reject"),
			agentWorkloadPlacement: { architecture, legacyUnplaced: "reject" },
		}) as typeof workloadTestPolicy;
	const arch = (f: ReturnType<typeof fixture>, name: string) => {
		const workload = f.resources.get(`StatefulSet/${name}`) as V1StatefulSet;
		return [
			workload.spec?.template.spec?.nodeSelector?.["kubernetes.io/arch"],
			workload.metadata?.annotations?.[
				"agent-infra.agora.io/agent-workload-placement"
			],
		];
	};

	it("repairs an unrelated drift under the original fence without adopting a changed placement", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const identity = await applyWorkload(
			adapterFor(f, placedAs("amd64")),
			desired,
		);
		const name = desired.service.name;
		const changed = adapterFor(f, placedAs("arm64"));
		expect(await changed.observe(desired, identity)).toBe("healthy");
		// An unrelated env drift on the live controller (Core then repairs it).
		const key = `StatefulSet/${name}`;
		const workload = structuredClone(f.resources.get(key)) as V1StatefulSet;
		workload.spec?.template.spec?.containers[0]?.env?.push({
			name: "INJECTED",
			value: "1",
		});
		f.resources.set(key, workload);
		expect(await changed.observe(desired, identity)).toBe("drifted");
		// Core's ordinary repair: next reconciliation revision, same fence and request.
		const repair = { ...desired, workloadRevision: 2 };
		let repaired = await changed.apply(repair);
		if (repaired === "pending") repaired = await changed.apply(repair);
		if (!repaired || repaired === "pending")
			throw new Error("missing identity");
		expect(arch(f, name)).toEqual(["amd64", "amd64"]);
		scheduleOnEci(f, name);
		expect(await changed.observe(repair, repaired)).toBe("healthy");
		// Only a formal command (new fence) adopts arm64.
		const restarted = { ...repair, workloadRevision: 3, fence: 2 };
		let next = await changed.apply(restarted);
		if (next === "pending") next = await changed.apply(restarted);
		if (!next || next === "pending") throw new Error("missing identity");
		expect(arch(f, name)).toEqual(["arm64", "arm64"]);
	});

	it.each([
		[
			"an extra nodeSelector",
			(spec: V1PodSpec) => {
				spec.nodeSelector = { ...spec.nodeSelector, pool: "owner" };
			},
		],
		[
			"a missing provider toleration",
			(spec: V1PodSpec) => {
				spec.tolerations = spec.tolerations?.filter(
					(entry) => entry.key !== providerToleration.key,
				);
			},
		],
	])(
		"repairs %s under the original fence by restoring the recorded architecture (round 3)",
		async (_name, mutate) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const identity = await applyWorkload(
				adapterFor(f, placedAs("amd64")),
				desired,
			);
			const name = desired.service.name;
			const changed = adapterFor(f, placedAs("arm64"));
			const key = `StatefulSet/${name}`;
			const workload = structuredClone(f.resources.get(key)) as V1StatefulSet;
			if (!workload.spec?.template.spec) throw new Error("missing template");
			mutate(workload.spec.template.spec);
			f.resources.set(key, workload);
			expect(await changed.observe(desired, identity)).toBe("drifted");
			const repair = { ...desired, workloadRevision: 2 };
			let repaired = await changed.apply(repair);
			if (repaired === "pending") repaired = await changed.apply(repair);
			if (!repaired || repaired === "pending")
				throw new Error("missing identity");
			const template = (f.resources.get(key) as V1StatefulSet).spec?.template
				.spec;
			expect(template?.nodeSelector).toEqual(eciSelector);
			expect(template?.tolerations).toEqual([providerToleration]);
			expect(arch(f, name)).toEqual(["amd64", "amd64"]);
			scheduleOnEci(f, name);
			expect(await changed.observe(repair, repaired)).toBe("healthy");
			const restarted = { ...repair, workloadRevision: 3, fence: 2 };
			let next = await changed.apply(restarted);
			if (next === "pending") next = await changed.apply(restarted);
			if (!next || next === "pending") throw new Error("missing identity");
			expect(arch(f, name)).toEqual(["arm64", "arm64"]);
		},
	);

	it.each(["missing", "invalid"] as const)(
		"fails closed under the original fence when the adoption record is %s",
		async (mode) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			await applyWorkload(adapterFor(f, placedAs("amd64")), desired);
			const name = desired.service.name;
			const key = `StatefulSet/${name}`;
			const workload = structuredClone(f.resources.get(key)) as V1StatefulSet;
			const annotations = workload.metadata?.annotations ?? {};
			if (mode === "missing")
				delete annotations["agent-infra.agora.io/agent-workload-placement"];
			else
				annotations["agent-infra.agora.io/agent-workload-placement"] = "s390x";
			workload.spec?.template.spec?.tolerations?.splice(0);
			f.resources.set(key, workload);
			const writes = f.writes.length;
			const repair = { ...desired, workloadRevision: 2 };
			const changed = adapterFor(f, placedAs("arm64"));
			const outcome = async () => {
				for (let attempt = 0; attempt < 3; attempt++)
					if ((await changed.apply(repair)) !== "pending") return;
			};
			await expect(outcome()).rejects.toMatchObject({ code: "policy" });
			expect(
				f.writes
					.slice(writes)
					.filter(
						(write) =>
							write.kind === "StatefulSet" &&
							((write as V1StatefulSet).spec?.replicas ?? 0) > 0,
					),
			).toEqual([]);
			expect(
				(f.resources.get(key) as V1StatefulSet).spec?.template.spec
					?.nodeSelector,
			).toEqual(eciSelector);
		},
	);
});
