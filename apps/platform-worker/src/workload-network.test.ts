import type { V1NetworkPolicy } from "@kubernetes/client-node";
import { ObjectSerializer } from "@kubernetes/client-node/dist/gen/models/ObjectSerializer.js";
import { describe, expect, it, vi } from "vitest";
import {
	fakeKubernetesApi,
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";
import {
	type WorkloadEgressPolicyV1,
	workloadEgressRulesV1,
} from "./workload-network.js";

const egress: WorkloadEgressPolicyV1 = {
	modelEgress: [
		{
			destination: {
				namespace: "models",
				podLabels: { app: "model-endpoint" },
			},
			port: 8443,
		},
		{ destination: { ip: "203.0.113.8" }, port: 443 },
		{ destination: { ip: "2001:db8::8" }, port: 443 },
	],
	dnsEgress: [
		{ namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
	],
};

function ruleParts(network: V1NetworkPolicy, index = 0) {
	const rules = network.spec?.egress;
	const rule = rules?.[index];
	const peer = rule?.to?.[0];
	const port = rule?.ports?.[0];
	if (!rules || !rule || !peer || !port || !rule.to || !rule.ports)
		throw new Error();
	return { rules, rule, peer, port, destinations: rule.to, ports: rule.ports };
}

describe("deployment-owned Workload egress", () => {
	it("keeps absent profiles closed and limits configured destinations to exact hosts, Pods and ports", async () => {
		expect(workloadEgressRulesV1({})).toEqual([]);
		const api = fakeKubernetesApi();
		const adapter = createKubernetesRuntimeAdapterV1({
			client: api.client,
			policy: { ...workloadTestPolicy, ...egress },
			probe: async () => true,
		});
		const desired = workloadDesiredFixture();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const network = await api.client.read<V1NetworkPolicy>(
			"NetworkPolicy",
			desired.service.name,
		);
		expect(network?.spec?.egress).toEqual([
			{
				to: [
					{
						namespaceSelector: {
							matchLabels: { "kubernetes.io/metadata.name": "models" },
						},
						podSelector: { matchLabels: { app: "model-endpoint" } },
					},
				],
				ports: [{ protocol: "TCP", port: 8443 }],
			},
			{
				to: [{ ipBlock: { cidr: "203.0.113.8/32" } }],
				ports: [{ protocol: "TCP", port: 443 }],
			},
			{
				to: [{ ipBlock: { cidr: "2001:db8::8/128" } }],
				ports: [{ protocol: "TCP", port: 443 }],
			},
			{
				to: [
					{
						namespaceSelector: {
							matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
						},
						podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
					},
				],
				ports: [
					{ protocol: "UDP", port: 53 },
					{ protocol: "TCP", port: 53 },
				],
			},
		]);
		// Match real API serialization and harmless selector/port defaulting.
		const serialized = ObjectSerializer.serialize(
			network,
			"V1NetworkPolicy",
			"",
		);
		const roundtrip = ObjectSerializer.deserialize(
			serialized,
			"V1NetworkPolicy",
			"",
		) as V1NetworkPolicy;
		api.resources.set(`NetworkPolicy/${desired.service.name}`, roundtrip);
		expect(await adapter.observe(desired, identity)).toBe("healthy");
	});
	it.each([
		{ destination: { ip: "0.0.0.0/0" }, port: 443 },
		{ destination: { ip: "model.example.test" }, port: 443 },
		{ destination: { namespace: "models", podLabels: {} }, port: 443 },
		{ destination: { namespace: "*", podLabels: { app: "model" } }, port: 443 },
		{
			destination: {
				namespace: "models",
				podLabels: { app: "model" },
				ip: "203.0.113.8",
			},
			port: 443,
		},
		{ destination: { ip: "203.0.113.8" }, port: 0 },
		{ destination: { ip: "203.0.113.8" }, port: 443, endPort: 65535 },
	])(
		"rejects widened or malformed deployment input before any resource mutation: %j",
		(entry) => {
			const api = fakeKubernetesApi();
			expect(() =>
				createKubernetesRuntimeAdapterV1({
					client: api.client,
					policy: {
						...workloadTestPolicy,
						modelEgress: [entry] as WorkloadEgressPolicyV1["modelEgress"],
					},
					probe: async () => true,
				}),
			).toThrow("Kubernetes Workload operation failed");
			expect(api.writes).toEqual([]);
		},
	);
	it.each([
		[
			"extra peer",
			(network: V1NetworkPolicy) => {
				ruleParts(network).destinations.push({});
			},
		],
		[
			"extra port",
			(network: V1NetworkPolicy) => {
				ruleParts(network).ports.push({ port: 5432, protocol: "TCP" });
			},
		],
		[
			"port range",
			(network: V1NetworkPolicy) => {
				ruleParts(network).port.endPort = 65535;
			},
		],
		[
			"broad namespace",
			(network: V1NetworkPolicy) => {
				ruleParts(network).peer.namespaceSelector = {};
			},
		],
		[
			"extra selector",
			(network: V1NetworkPolicy) => {
				ruleParts(network, 1).peer.namespaceSelector = {};
			},
		],
		[
			"broad CIDR",
			(network: V1NetworkPolicy) => {
				const block = ruleParts(network, 1).peer.ipBlock;
				if (!block) throw new Error();
				block.cidr = "0.0.0.0/0";
			},
		],
		[
			"extra rule",
			(network: V1NetworkPolicy) => {
				ruleParts(network).rules.push({});
			},
		],
		[
			"changed DNS",
			(network: V1NetworkPolicy) => {
				ruleParts(network, 3).peer.podSelector = {};
			},
		],
	] as const)(
		"blocks promotion and repairs %s in the existing policy",
		async (_name, mutate) => {
			const api = fakeKubernetesApi();
			const probe = vi.fn(async () => true);
			const adapter = createKubernetesRuntimeAdapterV1({
				client: api.client,
				policy: { ...workloadTestPolicy, ...egress },
				probe,
			});
			const desired = workloadDesiredFixture();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const network = await api.client.read<V1NetworkPolicy>(
				"NetworkPolicy",
				desired.service.name,
			);
			if (!network) throw new Error();
			const original = structuredClone(network.spec);
			mutate(network);
			api.resources.set(`NetworkPolicy/${desired.service.name}`, network);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			await expect(adapter.promote(desired, identity)).rejects.toThrow();
			expect(probe).not.toHaveBeenCalled();
			await adapter.apply(desired);
			expect(
				(
					await api.client.read<V1NetworkPolicy>(
						"NetworkPolicy",
						desired.service.name,
					)
				)?.spec,
			).toEqual(original);
			expect(await adapter.observe(desired, identity)).toBe("healthy");
			expect(
				[...api.resources.values()].filter(
					(resource) => resource.kind === "NetworkPolicy",
				),
			).toHaveLength(1);
		},
	);
});
