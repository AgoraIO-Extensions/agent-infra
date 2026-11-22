import { describe, expect, it } from "vitest";
import {
	agentNetworkPolicyOwnerLabelV1,
	networkPolicySpecSha256V1,
	networkPolicySpecV1,
	networkPolicyTemplateDigestsV1,
	networkPolicyVariantsV1,
	parseNetworkPolicyDeploymentConfigV1,
} from "./workload-network-policy.js";

const owner = agentNetworkPolicyOwnerLabelV1;
const config = () => ({
	workerSelector: { "app.kubernetes.io/component": "platform-worker" },
	routeNamespace: "ingress-nginx",
	routeSelector: { "app.kubernetes.io/name": "ingress-nginx" },
	platformApiSelector: { "app.kubernetes.io/component": "platform-api" },
	workspaceSnapshotProjection: false,
	egress: {
		modelEgress: [{ destination: { ip: "198.51.100.10" }, port: 443 }],
		dnsEgress: [
			{ namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
		],
	},
});
const withSnapshot = () => ({
	...config(),
	workspaceSnapshotProjection: true,
	egress: {
		...config().egress,
		workspaceSnapshotEgress: [
			{ destination: { ip: "198.51.100.20" }, port: 9000 },
		],
	},
});

describe("Agent NetworkPolicy template (#4351)", () => {
	it("lists the single-service and multi-service forms, with snapshot forms only when deployed", () => {
		expect(networkPolicyVariantsV1(config())).toEqual([
			"internal-only",
			"self-managed",
			"platform-auth",
			"multi-service-entry",
			"multi-service-service",
			"multi-service-migration",
		]);
		expect(networkPolicyVariantsV1(withSnapshot())).toHaveLength(12);
		// Snapshot egress without the projection is not a snapshot form.
		expect(
			networkPolicyVariantsV1({
				...withSnapshot(),
				workspaceSnapshotProjection: false,
			}),
		).toHaveLength(6);
	});

	it("normalizes only the Agent value, port and service", () => {
		const spec = networkPolicySpecV1({
			variant: "platform-auth",
			config: config(),
		});
		expect(spec.podSelector.matchLabels).toEqual({ [owner]: "<agent>" });
		expect(spec.policyTypes).toEqual(["Ingress", "Egress"]);
		expect(spec.ingress).toEqual([
			{
				from: [{ podSelector: { matchLabels: config().workerSelector } }],
				ports: [{ protocol: "TCP", port: "<port>" }],
			},
			{
				from: [
					{
						namespaceSelector: {
							matchLabels: { "kubernetes.io/metadata.name": "ingress-nginx" },
						},
						podSelector: { matchLabels: config().routeSelector },
					},
					{ podSelector: { matchLabels: config().platformApiSelector } },
				],
				ports: [{ protocol: "TCP", port: "<port>" }],
			},
		]);
		// Egress is carried verbatim from the deployment configuration.
		expect(spec.egress).toHaveLength(2);
		expect(JSON.stringify(spec.egress)).toContain("198.51.100.10");
	});

	it("keeps the Platform API source only for platform-auth and drops the route for internal-only", () => {
		const internal = networkPolicySpecV1({
			variant: "internal-only",
			config: config(),
		});
		expect(internal.ingress).toHaveLength(1);
		const selfManaged = networkPolicySpecV1({
			variant: "self-managed",
			config: config(),
		});
		expect(JSON.stringify(selfManaged.ingress)).not.toContain("platform-api");
		const noApi = { ...config(), platformApiSelector: undefined };
		expect(
			networkPolicySpecV1({ variant: "platform-auth", config: noApi })
				.ingress[1]?.from,
		).toHaveLength(1);
	});

	it("multi-service variants replace the Agent value in the Pod selector and in every ingress peer", () => {
		const substitutions = {
			agentSelector: { key: "np-probe/agent", value: "probe-a" },
			service: "probe-svc",
		};
		const entry = networkPolicySpecV1({
			variant: "multi-service-entry",
			config: config(),
			substitutions,
		});
		expect(entry.podSelector.matchLabels).toEqual({
			"np-probe/agent": "probe-a",
			"agent-infra.agora.io/service": "probe-svc",
		});
		expect(entry.policyTypes).toEqual(["Ingress"]);
		expect(entry.egress).toBeUndefined();
		expect(entry.ingress[0]?.from).toHaveLength(2);
		expect(JSON.stringify(entry)).not.toContain(owner);
		const service = networkPolicySpecV1({
			variant: "multi-service-service",
			config: config(),
			substitutions,
		});
		expect(service.ingress[0]?.from).toEqual([
			{ podSelector: { matchLabels: { "np-probe/agent": "probe-a" } } },
		]);
		const migration = networkPolicySpecV1({
			variant: "multi-service-migration",
			config: config(),
		});
		expect(migration.ingress).toEqual([]);
		expect(migration.podSelector.matchLabels).toEqual({
			[owner]: "<agent>",
			"agent-infra.agora.io/service": "migration",
		});
	});

	it("multi-service snapshot forms add Egress with the deployment destinations and same-Agent peers", () => {
		const spec = networkPolicySpecV1({
			variant: "multi-service-entry+snapshot",
			config: withSnapshot(),
		});
		expect(spec.policyTypes).toEqual(["Ingress", "Egress"]);
		expect(JSON.stringify(spec.egress)).toContain("198.51.100.20");
		expect(spec.egress?.at(-1)).toEqual({
			to: [{ podSelector: { matchLabels: { [owner]: "<agent>" } } }],
		});
		expect(() =>
			networkPolicySpecV1({
				variant: "multi-service-entry+snapshot",
				config: config(),
			}),
		).toThrow();
	});

	it("the probe table swaps the Agent selector and Worker source and leaves the rest verbatim", () => {
		const template = networkPolicySpecV1({
			variant: "self-managed",
			config: config(),
		});
		const probe = networkPolicySpecV1({
			variant: "self-managed",
			config: config(),
			substitutions: {
				agentSelector: { key: "np-probe/agent", value: "probe-a" },
				workerSource: { "np-probe/source": "worker" },
				port: 3003,
			},
		});
		expect(probe.podSelector.matchLabels).toEqual({
			"np-probe/agent": "probe-a",
		});
		expect(probe.ingress[0]?.from).toEqual([
			{ podSelector: { matchLabels: { "np-probe/source": "worker" } } },
		]);
		expect(probe.ingress[0]?.ports).toEqual([{ protocol: "TCP", port: 3003 }]);
		expect(probe.ingress[1]?.from).toEqual(template.ingress[1]?.from);
		expect(probe.egress).toEqual(template.egress);
	});

	it("digests change with every deployment-owned field and never with probe values", () => {
		const base = networkPolicyTemplateDigestsV1(config());
		const widened = networkPolicyTemplateDigestsV1({
			...config(),
			egress: {
				...config().egress,
				modelEgress: [{ destination: { cidr: "8.8.0.0/16" }, port: 443 }],
			},
		});
		const reroute = networkPolicyTemplateDigestsV1({
			...config(),
			routeSelector: { "app.kubernetes.io/name": "other" },
		});
		for (const variant of ["internal-only", "self-managed", "platform-auth"])
			expect(widened[variant]).not.toBe(base[variant]);
		// Multi-service forms without snapshots carry no egress, so a model CIDR does not change them.
		expect(widened["multi-service-entry"]).toBe(base["multi-service-entry"]);
		expect(reroute["multi-service-entry"]).not.toBe(
			base["multi-service-entry"],
		);
		expect(reroute["self-managed"]).not.toBe(base["self-managed"]);
		expect(reroute["internal-only"]).toBe(base["internal-only"]);
		expect(networkPolicySpecSha256V1({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(
			networkPolicySpecSha256V1({ a: [{ c: 2, d: 1 }], b: 1 }),
		);
	});

	it.each([
		[
			"unknown key",
			(value: Record<string, unknown>) => ({ ...value, extra: 1 }),
		],
		[
			"empty Worker selector",
			(value: Record<string, unknown>) => ({ ...value, workerSelector: {} }),
		],
		[
			"no route namespace",
			(value: Record<string, unknown>) => ({
				...value,
				routeNamespace: undefined,
			}),
		],
		[
			"CIDR overlapping a reserved range",
			(value: Record<string, unknown>) => ({
				...value,
				egress: {
					modelEgress: [{ destination: { cidr: "10.0.0.0/16" }, port: 443 }],
				},
			}),
		],
	])("rejects deployment configuration with %s", (_name, mutate) => {
		expect(() =>
			parseNetworkPolicyDeploymentConfigV1(mutate({ ...config() })),
		).toThrow();
	});
});
