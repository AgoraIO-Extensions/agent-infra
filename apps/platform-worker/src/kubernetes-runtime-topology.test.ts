import type { V1Pod, V1StatefulSet } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { fixture } from "./kubernetes-runtime-adapter.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";

describe("deployment-approved live Pod topology labels", () => {
	it.each([
		"approved",
		"default-denied",
		"wrong-zone",
		"foreign-label",
		"wrong-agent",
		"template",
	])("handles %s without weakening workload identity", async (mode) => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = createKubernetesRuntimeAdapterV1({
			client: f.client,
			probe: f.probe,
			policy: {
				...workloadTestPolicy,
				...(mode === "default-denied"
					? {}
					: {
							allowedPodTopologyLabelValues: {
								"topology.kubernetes.io/region": ["cn-hangzhou"],
								"topology.kubernetes.io/zone": [
									"cn-hangzhou-j",
									"cn-hangzhou-h",
								],
							},
						}),
			},
		});
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending")
			throw new Error("missing identity");
		const key = `Pod/${desired.service.name}-0`;
		const pod = structuredClone(f.resources.get(key)) as V1Pod;
		if (!pod.metadata) throw new Error("missing pod");
		const topology = {
			"topology.kubernetes.io/region": "cn-hangzhou",
			"topology.kubernetes.io/zone":
				mode === "wrong-zone" ? "foreign" : "cn-hangzhou-j",
		};
		pod.metadata.labels = {
			...pod.metadata.labels,
			...topology,
			...(mode === "foreign-label" ? { privileged: "yes" } : {}),
			...(mode === "wrong-agent"
				? { "agent-infra.agora.io/agent": "foreign" }
				: {}),
		};
		f.resources.set(key, pod);
		if (mode === "template") {
			const workloadKey = `StatefulSet/${desired.service.name}`;
			const workload = structuredClone(
				f.resources.get(workloadKey),
			) as V1StatefulSet;
			if (!workload.spec?.template.metadata)
				throw new Error("missing template");
			Object.assign(workload.spec.template.metadata.labels ?? {}, topology);
			f.resources.set(workloadKey, workload);
		}
		expect(await adapter.observe(desired, identity)).toBe(
			mode === "approved"
				? "healthy"
				: mode === "wrong-agent"
					? "pending"
					: "drifted",
		);
		if (mode === "approved") {
			await adapter.apply(desired);
			expect((f.resources.get(key) as V1Pod).metadata?.uid).toBe(
				pod.metadata.uid,
			);
		}
	});
	it.each<Record<string, readonly string[]>>([
		{ privileged: ["yes"] },
		{ "topology.kubernetes.io/zone": ["bad/value"] },
		{ "topology.kubernetes.io/region": [] },
	])(
		"rejects invalid deployment label policy %j",
		(allowedPodTopologyLabelValues) => {
			const f = fixture();
			expect(() =>
				createKubernetesRuntimeAdapterV1({
					client: f.client,
					probe: f.probe,
					policy: { ...workloadTestPolicy, allowedPodTopologyLabelValues },
				}),
			).toThrow();
		},
	);
});
