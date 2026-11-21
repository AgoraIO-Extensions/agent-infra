import type { V1Pod, V1StatefulSet } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { fixture } from "./kubernetes-runtime-adapter.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";

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
});
