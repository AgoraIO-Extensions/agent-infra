import {
	type AgentWorkloadDesiredV1,
	validateAgentWorkloadDesiredV1,
} from "@agent-infra/contracts/workload";
import type { V1Ingress, V1StatefulSet } from "@kubernetes/client-node";
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
