import {
	type AgentWorkloadDesiredV1,
	validateAgentWorkloadDesiredV1,
} from "@agent-infra/contracts/workload";
import type {
	KubernetesObject,
	V1Ingress,
	V1StatefulSet,
} from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { fixture } from "./kubernetes-runtime-adapter.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";
import {
	assertWorkloadPublicRouteV1,
	publicBasePathEnvironmentV1,
	workloadInteractionRouteV1,
	workloadPublicRouteV1,
} from "./workload-public-route.js";

const source = workloadDesiredFixture();
const policy = {
	...workloadTestPolicy,
	pathRoutes: {
		origin: "https://apps.example.test",
		platformOrigin: "https://platform.example.test",
		tlsSecretName: "apps-tls",
		agentIds: [source.agentId],
	},
};
const desired = validateAgentWorkloadDesiredV1({
	...source,
	route: {
		...source.route,
		...workloadInteractionRouteV1(policy, source.agentId),
	},
}) as Extract<AgentWorkloadDesiredV1, { route: { exposure: "self-managed" } }>;

describe("selected public path routes", () => {
	it("promotes one TLS path and injects its prefix while preserving internal health", async () => {
		const f = fixture();
		const adapter = createKubernetesRuntimeAdapterV1({
			client: f.client,
			policy,
			probe: f.probe,
		});
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending")
			throw new Error("Expected workload");
		expect(await f.client.read("Ingress", desired.route.name)).toBeNull();
		await adapter.promote(desired, identity);
		const ingress = await f.client.read<V1Ingress>(
			"Ingress",
			desired.route.name,
		);
		expect(ingress?.spec?.rules).toEqual([
			{
				host: "apps.example.test",
				http: {
					paths: [
						{
							path: desired.route.interactionPath,
							pathType: "Prefix",
							backend: {
								service: { name: desired.service.name, port: { number: 8080 } },
							},
						},
					],
				},
			},
		]);
		expect(ingress?.spec?.tls).toEqual([
			{ hosts: ["apps.example.test"], secretName: "apps-tls" },
		]);
		const workload = await f.client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		expect(workload?.spec?.template.spec?.containers[0]?.env).toContainEqual({
			name: publicBasePathEnvironmentV1,
			value: desired.route.interactionPath,
		});
		expect(
			workload?.spec?.template.spec?.containers[0]?.readinessProbe?.httpGet
				?.path,
		).toBe("/healthz");
		await adapter.cleanupAgent(
			desired.agentId,
			desired.workloadRevision,
			desired.fence,
			false,
		);
		expect(await f.client.read("Ingress", desired.route.name)).toBeNull();
	});
	it("keeps unselected Agents on their existing host", () => {
		const other = workloadDesiredFixture(1, "agent-b");
		const location = workloadPublicRouteV1(policy, other.agentId);
		expect(location.path).toBe("/");
		expect(location.host).toBe(
			`${other.service.name}.${policy.routeHostSuffix}`,
		);
		expect(location.interactionPath).toBeUndefined();
	});
	it.each([
		{ origin: "https://platform.example.test" },
		{ origin: "http://apps.example.test" },
		{ origin: "https://apps.example.test/a/" },
		{ origin: "https://127.0.0.1" },
		{ agentIds: ["unselected"] },
	])(
		"rejects invalid or unapproved deployment choices before writes: %o",
		async (change) => {
			const f = fixture();
			const adapter = createKubernetesRuntimeAdapterV1({
				client: f.client,
				policy: { ...policy, pathRoutes: { ...policy.pathRoutes, ...change } },
				probe: f.probe,
			});
			await expect(adapter.apply(desired)).rejects.toThrow();
			expect(
				await f.client.read("StatefulSet", desired.service.name),
			).toBeNull();
		},
	);
	it("rejects forged paths, origins and Owner prefix overrides", () => {
		for (const interactionPath of [
			"/a/other/",
			"/",
			"/a/../",
			`/a/agent-${"b".repeat(32)}/`,
		]) {
			expect(() =>
				assertWorkloadPublicRouteV1(policy, {
					...desired,
					route: { ...desired.route, interactionPath },
				}),
			).toThrow();
		}
		expect(() =>
			assertWorkloadPublicRouteV1(policy, {
				...desired,
				env: { [publicBasePathEnvironmentV1]: "/" },
			}),
		).toThrow();
		expect(() =>
			assertWorkloadPublicRouteV1(
				policy,
				workloadDesiredFixture(1, source.agentId, "platform-auth"),
			),
		).toThrow();
		expect(() =>
			assertWorkloadPublicRouteV1(workloadTestPolicy, desired),
		).toThrow();
	});
});

describe("selected public hostname routes", () => {
	it.each([
		{ clusterIssuerName: "" },
		{ hostSuffix: "192.0.2.1" },
		{ agentIds: ["agent-a", "agent-a"] },
		{ agentIds: [] },
		{ accountSecretName: "caller-account" },
	])("rejects invalid deployment certificate policy: %o", (change) => {
		expect(() =>
			workloadPublicRouteV1(
				{
					...workloadTestPolicy,
					hostnameRoutes: {
						hostSuffix: "apps.example.test",
						platformOrigin: "https://platform.example.test",
						clusterIssuerName: "letsencrypt-http01-staging",
						agentIds: ["agent-a"],
						...change,
					},
				},
				"agent-a",
			),
		).toThrow();
	});
	it("rejects selecting a platform-auth Agent before any writes", async () => {
		const f = fixture();
		const selectedPolicy = {
			...workloadTestPolicy,
			hostnameRoutes: {
				hostSuffix: "apps.example.test",
				platformOrigin: "https://platform.example.test",
				clusterIssuerName: "letsencrypt-http01-staging",
				agentIds: ["agent-a"],
			},
		};
		const adapter = createKubernetesRuntimeAdapterV1({
			client: f.client,
			policy: selectedPolicy,
			probe: f.probe,
		});
		await expect(
			adapter.apply(workloadDesiredFixture(1, "agent-a", "platform-auth")),
		).rejects.toThrow();
		expect(await f.client.read("StatefulSet", source.service.name)).toBeNull();
	});
	it("rejects the platform origin and conflicting path selection before resource writes", async () => {
		const selectedPolicy = {
			...workloadTestPolicy,
			hostnameRoutes: {
				hostSuffix: "apps.example.test",
				platformOrigin:
					"https://agent-a51d7389ba2cb760d233154216317fce.apps.example.test",
				clusterIssuerName: "letsencrypt-http01-staging",
				agentIds: ["agent-a"],
			},
		};
		const f = fixture();
		const adapter = createKubernetesRuntimeAdapterV1({
			client: f.client,
			policy: selectedPolicy,
			probe: f.probe,
		});
		const input = validateAgentWorkloadDesiredV1({
			...source,
			route: {
				...source.route,
				interactionOrigin: {
					schemaVersion: 1,
					origin: selectedPolicy.hostnameRoutes.platformOrigin,
				},
			},
		});
		await expect(adapter.apply(input)).rejects.toThrow();
		expect(await f.client.read("StatefulSet", source.service.name)).toBeNull();
		expect(() =>
			workloadPublicRouteV1(
				{
					...policy,
					hostnameRoutes: {
						...selectedPolicy.hostnameRoutes,
						platformOrigin: "https://platform.example.test",
					},
				},
				"agent-a",
			),
		).toThrow();
	});
	it("rejects Agent A borrowing selected Agent B's valid hostname before any writes", async () => {
		const f = fixture();
		const selectedPolicy = {
			...workloadTestPolicy,
			hostnameRoutes: {
				hostSuffix: "apps.example.test",
				platformOrigin: "https://platform.example.test",
				clusterIssuerName: "letsencrypt-http01-staging",
				agentIds: ["agent-a", "agent-b"],
			},
		};
		const b = workloadDesiredFixture(1, "agent-b", "self-managed");
		const bPublicRoute = workloadPublicRouteV1(selectedPolicy, b.agentId);
		const bRoute = workloadInteractionRouteV1(selectedPolicy, b.agentId);
		const legitimateB = validateAgentWorkloadDesiredV1({
			...b,
			route: { ...b.route, ...bRoute },
		});
		expect(() =>
			assertWorkloadPublicRouteV1(selectedPolicy, legitimateB),
		).not.toThrow();
		const a = workloadDesiredFixture(1, "agent-a", "self-managed");
		const forgedA = validateAgentWorkloadDesiredV1({
			...a,
			route: { ...a.route, ...bRoute },
		});
		expect(bRoute.interactionOrigin?.origin).not.toBe(
			workloadInteractionRouteV1(selectedPolicy, a.agentId).interactionOrigin
				?.origin,
		);
		const certificateB = {
			apiVersion: "cert-manager.io/v1",
			kind: "Certificate",
			metadata: {
				namespace: "workload-test",
				name: bPublicRoute.tlsSecretName,
				uid: "certificate-b",
				resourceVersion: "7",
			},
			spec: {
				dnsNames: [bPublicRoute.host],
				secretName: bPublicRoute.tlsSecretName,
				issuerRef: {
					kind: "ClusterIssuer",
					name: selectedPolicy.hostnameRoutes.clusterIssuerName,
				},
			},
		} as KubernetesObject;
		const ingressB: V1Ingress = {
			apiVersion: "networking.k8s.io/v1",
			kind: "Ingress",
			metadata: {
				namespace: "workload-test",
				name: b.service.name,
				uid: "ingress-b",
				resourceVersion: "8",
			},
			spec: {
				tls: [
					{
						hosts: [bPublicRoute.host],
						secretName: bPublicRoute.tlsSecretName,
					},
				],
				rules: [
					{
						host: bPublicRoute.host,
						http: {
							paths: [
								{
									path: "/",
									pathType: "Prefix",
									backend: {
										service: {
											name: b.service.name,
											port: { number: b.service.port },
										},
									},
								},
							],
						},
					},
				],
			},
		};
		f.seed(certificateB);
		f.seed(ingressB);
		const before = structuredClone([...f.resources.entries()]);
		const adapter = createKubernetesRuntimeAdapterV1({
			client: f.client,
			policy: selectedPolicy,
			probe: f.probe,
		});
		await expect(adapter.apply(forgedA)).rejects.toThrow();
		expect(f.writes).toHaveLength(0);
		expect(
			await f.client.read("Certificate", bPublicRoute.tlsSecretName),
		).toEqual(certificateB);
		expect(await f.client.read("Ingress", b.service.name)).toEqual(ingressB);
		expect([...f.resources.entries()]).toEqual(before);
	});
	it("uses the deployment suffix, root path and a stable per-Agent TLS Secret", () => {
		const selectedPolicy = {
			...workloadTestPolicy,
			hostnameRoutes: {
				hostSuffix: "apps.example.test",
				platformOrigin: "https://platform.example.test",
				clusterIssuerName: "letsencrypt-http01-staging",
				agentIds: ["agent-a"],
			},
		};
		const route = workloadPublicRouteV1(selectedPolicy, "agent-a");
		expect(route.interactionOrigin.origin).toBe(
			"https://agent-a51d7389ba2cb760d233154216317fce.apps.example.test",
		);
		expect(route.path).toBe("/");
		expect(route.interactionPath).toBeUndefined();
		expect(route.tlsSecretName).toBe(
			"agent-a51d7389ba2cb760d233154216317fce-tls",
		);
	});
});
