import type { V1NetworkPolicy } from "@kubernetes/client-node";
import { ObjectSerializer } from "@kubernetes/client-node/dist/gen/models/ObjectSerializer.js";
import { describe, expect, it, vi } from "vitest";
import {
	fakeKubernetesApi,
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";
import { nativeEgressFixture } from "./test-support/native-egress.js";
import { sessionSandboxModelProjectionFixture } from "./test-support/session-sandbox-v4.js";
import {
	hasAdditionalEgressPolicyV1,
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
	it("compiles the declared file exchange destination as one exact TCP rule (#3289)", () => {
		const fileExchangeEgress = [
			{ destination: { ip: "172.18.0.44" }, port: 3000 },
		] as const;
		const base = workloadEgressRulesV1(egress);
		const withFileExchange = workloadEgressRulesV1({
			...egress,
			fileExchangeEgress,
		});
		expect(withFileExchange).toHaveLength(base.length + 1);
		// 模型规则在前、DNS 在后，文件交换规则插在两者之间，其他规则不变。
		expect(withFileExchange.slice(0, egress.modelEgress?.length)).toEqual(
			base.slice(0, egress.modelEgress?.length),
		);
		expect(withFileExchange.at(-1)).toEqual(base.at(-1));
		expect(withFileExchange[egress.modelEgress?.length ?? 0]).toEqual({
			to: [{ ipBlock: { cidr: "172.18.0.44/32" } }],
			ports: [{ protocol: "TCP", port: 3000 }],
		});
	});
	it.each([
		[
			"two destinations",
			[
				{ destination: { ip: "172.18.0.44" }, port: 3000 },
				{ destination: { ip: "172.18.0.45" }, port: 3000 },
			],
		],
		[
			"a CIDR destination",
			[{ destination: { cidr: "203.0.113.0/24" }, port: 3000 }],
		],
		["a missing port", [{ destination: { ip: "172.18.0.44" } }]],
		["a non-array declaration", { destination: { ip: "172.18.0.44" } }],
	])("rejects a file exchange egress with %s (#3289)", (_name, value) => {
		expect(() =>
			workloadEgressRulesV1({
				fileExchangeEgress:
					value as unknown as WorkloadEgressPolicyV1["fileExchangeEgress"],
			}),
		).toThrow(expect.objectContaining({ code: "policy" }));
	});
	it("compiles an approved Connection destination with an exact TCP port", () => {
		expect(
			workloadEgressRulesV1({
				connectionEgress: [{ destination: { ip: "203.0.113.9" }, port: 443 }],
			}),
		).toEqual([
			{
				to: [{ ipBlock: { cidr: "203.0.113.9/32" } }],
				ports: [{ protocol: "TCP", port: 443 }],
			},
		]);
	});
	it("compiles the fixed native metadata Worker destination", () => {
		expect(
			workloadEgressRulesV1({
				nativeMetadataWorkerEgress: [
					{
						destination: {
							namespace: "platform",
							podLabels: { "app.kubernetes.io/component": "platform-worker" },
						},
						port: 3004,
					},
				],
			}),
		).toEqual([
			{
				to: [
					{
						namespaceSelector: {
							matchLabels: { "kubernetes.io/metadata.name": "platform" },
						},
						podSelector: {
							matchLabels: {
								"app.kubernetes.io/component": "platform-worker",
							},
						},
					},
				],
				ports: [{ protocol: "TCP", port: 3004 }],
			},
		]);
	});
	it("compiles bounded public CIDRs for model and Connection egress", () => {
		expect(
			workloadEgressRulesV1({
				modelEgress: [{ destination: { cidr: "8.8.8.0/24" }, port: 443 }],
				connectionEgress: [
					{ destination: { cidr: "2001:4860:4860::/48" }, port: 443 },
				],
			}),
		).toEqual([
			{
				to: [{ ipBlock: { cidr: "8.8.8.0/24" } }],
				ports: [{ protocol: "TCP", port: 443 }],
			},
			{
				to: [{ ipBlock: { cidr: "2001:4860:4860::/48" } }],
				ports: [{ protocol: "TCP", port: 443 }],
			},
		]);
	});
	it.each([
		{ destination: { ip: "0.0.0.0/0" }, port: 443 },
		{ destination: { namespace: "connection", podLabels: {} }, port: 443 },
		{ destination: { ip: "203.0.113.9" }, port: 0 },
		{ destination: { ip: "203.0.113.9" }, port: 443, endPort: 65535 },
	])("rejects widened Connection profiles: %j", (entry) => {
		expect(() =>
			workloadEgressRulesV1({
				connectionEgress: [entry] as WorkloadEgressPolicyV1["connectionEgress"],
			}),
		).toThrow();
	});
	it.each([
		"0.0.0.0/0",
		"::/0",
		"10.0.0.0/8",
		"fc00::/7",
		"127.0.0.0/8",
		"::1/128",
		"169.254.0.0/16",
		"fe80::/10",
		"224.0.0.0/4",
		"ff00::/8",
		"64:ff9b::/96",
		"64:ff9b::a9fe:a9fe/128",
		"64:ff9b:1::/48",
		"100:0:0:1::/64",
		"2001:1::1/128",
		"2001:20::/48",
		"2002::/48",
		"2620:4f:8000::/48",
		"3fff::/48",
		"4000::/48",
		"5f00::/48",
		"192.0.2.0/24",
		"192.88.99.0/24",
		"2001:db8::/32",
		"8.8.0.0/15",
		"2001:4860::/47",
		"8.8.8.1/24",
		"2001:4860:4860::1/48",
	])("rejects unsafe or non-canonical CIDR destinations: %s", (cidr) => {
		expect(() =>
			workloadEgressRulesV1({
				modelEgress: [{ destination: { cidr }, port: 443 }],
			}),
		).toThrow();
	});
	it("rejects a CIDR without a port", () => {
		expect(() =>
			workloadEgressRulesV1({
				modelEgress: [{ destination: { cidr: "8.8.8.0/24" } } as never],
			}),
		).toThrow();
	});
	it("keeps CIDR destinations out of DNS egress", () => {
		expect(() =>
			workloadEgressRulesV1({
				dnsEgress: [{ cidr: "8.8.8.0/24" }],
			}),
		).toThrow();
	});

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
		{ destination: { cidr: "8.8.8.0/24" } },
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

describe("standard native egress", () => {
	it("compiles explicitly approved public targets", () => {
		const policy = { nativeEgress: nativeEgressFixture() };
		expect(workloadEgressRulesV1(policy)).toEqual([
			{
				to: [{ ipBlock: { cidr: "8.8.8.8/32" } }],
				ports: [{ protocol: "TCP", port: 443 }],
			},
		]);
	});
});

it.each([
	"10.0.0.1",
	"169.254.169.254",
	"100.100.100.200",
	"127.0.0.1",
	"0.0.0.0",
	"192.168.1.1",
	"224.0.0.1",
	"::1",
	"fd00::1",
	"fe80::1",
	"::ffff:8.8.8.8",
	"::ffff:808:808",
	"64:ff9b::808:808",
	"2001:db8::1",
])("refuses native exact-IP reserved/metadata target %s", (ip) => {
	const nativeEgress = nativeEgressFixture();
	nativeEgress.destinations[0].destination.ip = ip;
	expect(() => workloadEgressRulesV1({ nativeEgress })).toThrow();
});
it.each([
	"8.0.0.0/8",
	"8.8.8.1/24",
	"0.0.0.0/0",
	"10.0.0.0/16",
	"::/0",
	"2606:4700::/32",
])("refuses native unsafe CIDR %s", (cidr) => {
	const nativeEgress = {
		...nativeEgressFixture(),
		destinations: [{ destination: { cidr }, port: 443 }],
	};
	expect(() => workloadEgressRulesV1({ nativeEgress })).toThrow();
});
it("accepts bounded IPv4/IPv6 public CIDRs", () => {
	const nativeEgress = {
		...nativeEgressFixture(),
		destinations: [
			{ destination: { cidr: "8.8.8.0/24" }, port: 443 },
			{ destination: { cidr: "2606:4700:4700::/48" }, port: 8443 },
		],
	};
	expect(
		workloadEgressRulesV1({ nativeEgress }).map(
			(r) => r.to?.[0]?.ipBlock?.cidr,
		),
	).toEqual(["8.8.8.0/24", "2606:4700:4700::/48"]);
});
for (const category of [
	"platformDatabase",
	"connectionDatabase",
	"kubernetesApi",
	"sandboxPodNetworks",
] as const) {
	it.each([
		"missing",
		"empty",
		"public host",
		"overlapping CIDR",
		"IPv6 overlap",
	])(`rejects native ${category} %s`, (scenario) => {
		const nativeEgress = nativeEgressFixture();
		if (scenario === "missing")
			Reflect.deleteProperty(nativeEgress.protectedNetworks, category);
		else if (scenario === "empty")
			nativeEgress.protectedNetworks[category] = [];
		else if (scenario === "public host")
			nativeEgress.protectedNetworks[category] = ["8.8.8.8"];
		else if (scenario === "IPv6 overlap") {
			nativeEgress.destinations[0].destination.ip = "2606:4700:4700::1111";
			nativeEgress.protectedNetworks[category] = ["2606:4700:4700::/48"];
		} else {
			Object.assign(nativeEgress, {
				destinations: [{ destination: { cidr: "8.8.8.0/24" }, port: 443 }],
			});
			nativeEgress.protectedNetworks[category] = ["8.8.8.128/25"];
		}
		expect(() => workloadEgressRulesV1({ nativeEgress })).toThrow();
	});
}
it.each([0, 65536, 1.5])("rejects native invalid port %s", (port) => {
	const nativeEgress = nativeEgressFixture();
	nativeEgress.destinations[0].port = port;
	expect(() => workloadEgressRulesV1({ nativeEgress })).toThrow();
});
it("rejects undeclared native policy and destination keys", () => {
	for (const mutate of [
		(p: ReturnType<typeof nativeEgressFixture>) =>
			Object.assign(p, { caller: true }),
		(p: ReturnType<typeof nativeEgressFixture>) =>
			Object.assign(p.protectedNetworks, { extra: [] }),
		(p: ReturnType<typeof nativeEgressFixture>) =>
			Object.assign(p.destinations[0].destination, { cidr: "8.8.8.0/24" }),
		(p: ReturnType<typeof nativeEgressFixture>) =>
			Object.assign(p, {
				destinations: [
					{
						destination: { namespace: "db", podLabels: { app: "db" } },
						port: 443,
					},
				],
			}),
	]) {
		const nativeEgress = nativeEgressFixture();
		mutate(nativeEgress);
		expect(() => workloadEgressRulesV1({ nativeEgress })).toThrow();
	}
});

it.each([false, true])(
	"native egress is granted only to a verified standard Agent (standard=%s)",
	async (standard) => {
		const api = fakeKubernetesApi();
		const desired = workloadDesiredFixture(1, "agent-a", "internal-only");
		const projection = standard
			? sessionSandboxModelProjectionFixture({
					agentId: desired.agentId,
					configurationRevision: desired.configRevision,
					imageDigest: desired.imageDigest,
				})
			: undefined;
		const nativeEgress = nativeEgressFixture();
		const adapter = createKubernetesRuntimeAdapterV1({
			client: api.client,
			policy: { ...workloadTestPolicy, nativeEgress },
			modelProjection: projection,
			probe: async () => true,
		});
		const identity = await adapter.apply(desired);
		const network = await api.client.read<V1NetworkPolicy>(
			"NetworkPolicy",
			desired.service.name,
		);
		expect(JSON.stringify(network?.spec?.egress).includes("8.8.8.8/32")).toBe(
			standard,
		);
		if (standard) {
			if (!identity || identity === "pending")
				throw new Error("Missing identity");
			const removed = createKubernetesRuntimeAdapterV1({
				client: api.client,
				policy: workloadTestPolicy,
				modelProjection: projection,
				probe: async () => true,
			});
			await expect(removed.apply(desired)).rejects.toThrow();
			expect(await removed.observe(desired, identity)).toBe("drifted");
			api.resources.set("NetworkPolicy/other", {
				kind: "NetworkPolicy",
				metadata: { name: "other" },
				spec: { podSelector: {}, egress: [{}] },
			} as V1NetworkPolicy);
			api.client.list = async (kind) =>
				structuredClone(
					[...api.resources.values()].filter((r) => r.kind === kind),
				) as never;
			const writes = api.writes.length;
			await expect(adapter.apply(desired)).rejects.toThrow();
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			expect(api.writes.length).toBe(writes);
		}
	},
);

it.each([
	null,
	[],
	"native",
	{ destinations: [], protectedNetworks: [] },
	{ ...nativeEgressFixture(), destinations: {} },
	{ ...nativeEgressFixture(), protectedNetworks: [] },
	{
		...nativeEgressFixture(),
		protectedNetworks: {
			...nativeEgressFixture().protectedNetworks,
			kubernetesApi: "9.9.9.9",
		},
	},
])("rejects malformed native policy %#", (value) => {
	expect(() =>
		workloadEgressRulesV1({
			nativeEgress: value,
		} as unknown as WorkloadEgressPolicyV1),
	).toThrow();
});
it.each([undefined, ["Egress"], ["Ingress"]])(
	"handles additive/default policyTypes %j conservatively",
	(policyTypes) => {
		const expected: V1NetworkPolicy = {
			metadata: { name: "native" },
			spec: {
				podSelector: { matchLabels: { session: "a" } },
				policyTypes: ["Egress"],
				egress: [],
			},
		};
		const extra: V1NetworkPolicy = {
			metadata: { name: "other" },
			spec: {
				podSelector: {},
				...(policyTypes ? { policyTypes } : {}),
				egress: [{}],
			},
		};
		expect(hasAdditionalEgressPolicyV1([extra], expected)).toBe(
			policyTypes?.[0] !== "Ingress",
		);
		expect(
			hasAdditionalEgressPolicyV1(
				[
					{
						...extra,
						spec: {
							...extra.spec,
							podSelector: { matchLabels: { session: "b" } },
						},
					},
				],
				expected,
			),
		).toBe(false);
		expect(
			hasAdditionalEgressPolicyV1(
				[{ ...extra, spec: { ...extra.spec, podSelector: {}, egress: [] } }],
				expected,
			),
		).toBe(false);
	},
);

it("rejects arrays masquerading as native policy objects", () => {
	const p = nativeEgressFixture();
	for (const nativeEgress of [
		Object.assign([], p),
		{ ...p, protectedNetworks: Object.assign([], p.protectedNetworks) },
		{ ...p, destinations: [Object.assign([], p.destinations[0])] },
		{
			...p,
			destinations: [
				{ destination: Object.assign([], { ip: "8.8.8.8" }), port: 443 },
			],
		},
	])
		expect(() =>
			workloadEgressRulesV1({
				nativeEgress,
			} as unknown as WorkloadEgressPolicyV1),
		).toThrow();
});

it("rejects sparse native destinations and protected inventory", () => {
	const nativeEgress = nativeEgressFixture();
	nativeEgress.protectedNetworks.platformDatabase = new Array(1);
	expect(() => workloadEgressRulesV1({ nativeEgress })).toThrow();
	expect(() =>
		workloadEgressRulesV1({
			nativeEgress: { ...nativeEgressFixture(), destinations: new Array(1) },
		}),
	).toThrow();
});
