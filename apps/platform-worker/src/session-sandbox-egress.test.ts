import type { V1NetworkPolicy } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { fakeKubernetesApi } from "./kubernetes.fixture.js";
import {
	createSessionSandboxEgressV1,
	type SessionSandboxEgressBindingV1,
} from "./session-sandbox-egress.js";

const binding: SessionSandboxEgressBindingV1 = {
	schemaVersion: 1,
	agentId: "agent-a",
	sessionId: "session-a",
	sandboxId: "sandbox-a",
	principalId: "user-a",
	generation: 1,
	fence: 4,
	configRevision: 2,
	workloadRevision: 3,
	namespace: "workload-test",
	leaseId: "lease-a",
	leaseExpiresAt: Date.now() + 60_000,
};
const profile = {
	ref: "runtime-egress",
	revision: "v1",
	modelEgress: [{ destination: { ip: "203.0.113.8" }, port: 443 }],
	connectionEgress: [{ destination: { ip: "203.0.113.9" }, port: 443 }],
	dnsEgress: [
		{ namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
	],
};
function setup() {
	const api = fakeKubernetesApi();
	// A real Kubernetes empty selector lists the entire namespace.
	api.client.list = async (kind, selector) =>
		structuredClone(
			[...api.resources.values()].filter(
				(value) =>
					value.kind === kind &&
					(!selector ||
						selector.split(",").every((pair) => {
							const [key, expected] = pair.split("=");
							return (
								key !== undefined && value.metadata?.labels?.[key] === expected
							);
						})),
			),
		) as never;
	const adapter = createSessionSandboxEgressV1({
		client: api.client,
		profile,
		withCurrentAllocation: async (_value, _operation, action) => action(),
	});
	return { api, adapter };
}
describe("Session Sandbox egress enforcement (Kubernetes fixture, not CNI evidence)", () => {
	it("writes distinct policies for same-Agent Sessions and reads back exact bounded rules", async () => {
		const { api, adapter } = setup();
		const a = await adapter.apply(binding);
		const b = await adapter.apply({
			...binding,
			sessionId: "session-b",
			sandboxId: "sandbox-b",
		});
		expect(a.name).not.toBe(b.name);
		const policy = await api.client.read<V1NetworkPolicy>(
			"NetworkPolicy",
			a.name,
		);
		expect(policy?.spec?.podSelector?.matchLabels).toEqual({
			"agent-infra.agora.io/agent-id": "agent-a",
			"agent-infra.agora.io/session-id": "session-a",
			"agent-infra.agora.io/sandbox-id": "sandbox-a",
			"agent-infra.agora.io/generation": "1",
		});
		expect(policy?.spec?.policyTypes).toEqual(["Egress"]);
		expect(policy?.spec?.egress).toHaveLength(3);
		expect(policy?.spec?.egress?.[1]).toEqual({
			to: [{ ipBlock: { cidr: "203.0.113.9/32" } }],
			ports: [{ protocol: "TCP", port: 443 }],
		});
		expect(await adapter.observe(binding, a)).toBe(true);
		expect(await adapter.apply(binding, a)).toEqual(a);
	});
	it.each([
		{ principalId: "user-b" },
		{ agentId: "agent-b" },
		{ sessionId: "session-b" },
		{ generation: 2 },
		{ fence: 3 },
		{ configRevision: 1 },
		{ workloadRevision: 2 },
		{ namespace: "foreign" },
		{ leaseExpiresAt: 0 },
		{ sandboxId: "invalid/label" },
	])(
		"rejects mismatched or expired binding %j without mutation",
		async (change) => {
			const { api, adapter } = setup();
			const known = await adapter.apply(binding);
			const writes = api.writes.length;
			await expect(
				adapter.apply({ ...binding, ...change }, known),
			).rejects.toThrow();
			expect(api.writes).toHaveLength(writes);
		},
	);
	it("requires the original allocation authority for every operation", async () => {
		const { api, adapter } = setup();
		const known = await adapter.apply(binding);
		const guarded = createSessionSandboxEgressV1({
			client: api.client,
			profile,
			withCurrentAllocation: async () => {
				throw new Error("stale allocation");
			},
		});
		const writes = api.writes.length;
		await expect(guarded.apply(binding, known)).rejects.toThrow(
			"stale allocation",
		);
		await expect(guarded.observe(binding, known)).rejects.toThrow(
			"stale allocation",
		);
		await expect(guarded.revoke(binding, known)).rejects.toThrow(
			"stale allocation",
		);
		await expect(guarded.remove(binding, known)).rejects.toThrow(
			"stale allocation",
		);
		expect(api.writes).toHaveLength(writes);
	});
	it("does not adopt same-name resources or recreate a lost recorded UID", async () => {
		const { api, adapter } = setup();
		const known = await adapter.apply(binding);
		await expect(adapter.apply(binding)).rejects.toThrow();
		const policy = api.resources.get(`NetworkPolicy/${known.name}`);
		if (!policy?.metadata) throw new Error();
		policy.metadata.uid = "external-uid";
		await expect(adapter.apply(binding, known)).rejects.toThrow();
		await expect(adapter.remove(binding, known)).rejects.toThrow();
		api.resources.delete(`NetworkPolicy/${known.name}`);
		await expect(adapter.apply(binding, known)).rejects.toThrow();
	});
	it("detects and repairs widened rules without changing the sibling Session", async () => {
		const { api, adapter } = setup();
		const known = await adapter.apply(binding);
		const other = await adapter.apply({
			...binding,
			sessionId: "session-b",
			sandboxId: "sandbox-b",
		});
		const sibling = await api.client.read("NetworkPolicy", other.name);
		const policy = api.resources.get(
			`NetworkPolicy/${known.name}`,
		) as V1NetworkPolicy;
		if (!policy.spec) throw new Error();
		policy.spec.egress = [{}];
		expect(await adapter.observe(binding, known)).toBe(false);
		const repaired = await adapter.apply(binding, known);
		expect(await adapter.observe(binding, repaired)).toBe(true);
		expect(await api.client.read("NetworkPolicy", other.name)).toEqual(sibling);
	});
	it("rejects additive overlapping allow policies while accepting empty default-deny policies", async () => {
		const { api, adapter } = setup();
		api.resources.set("NetworkPolicy/default", {
			apiVersion: "networking.k8s.io/v1",
			kind: "NetworkPolicy",
			metadata: { name: "default" },
			spec: { podSelector: {}, policyTypes: ["Egress"], egress: [] },
		} as V1NetworkPolicy);
		const known = await adapter.apply(binding);
		const extra = api.resources.get("NetworkPolicy/default") as V1NetworkPolicy;
		if (!extra.spec) throw new Error();
		extra.spec.egress = [{}];
		await expect(adapter.observe(binding, known)).rejects.toThrow();
		await expect(adapter.apply(binding, known)).rejects.toThrow();
	});
	it("revokes to empty egress and retains the deny until all Sandbox Pods are gone", async () => {
		const { api, adapter } = setup();
		const known = await adapter.apply(binding);
		await expect(adapter.remove(binding, known)).rejects.toThrow();
		const denied = await adapter.revoke(binding, known);
		expect(
			(await api.client.read<V1NetworkPolicy>("NetworkPolicy", denied.name))
				?.spec?.egress,
		).toEqual([]);
		api.resources.set("Pod/old-generation", {
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				name: "old-generation",
				labels: {
					"agent-infra.agora.io/sandbox-id": binding.sandboxId,
					"agent-infra.agora.io/generation": "0",
				},
			},
		});
		await expect(adapter.remove(binding, denied)).rejects.toThrow();
		api.resources.delete("Pod/old-generation");
		await adapter.remove(binding, denied);
		expect(await api.client.read("NetworkPolicy", denied.name)).toBeNull();
	});

	it("advances the same Sandbox under the current fence and rejects a stale writer afterwards", async () => {
		const { api, adapter } = setup();
		const known = await adapter.apply(binding);
		const next = {
			...binding,
			fence: 5,
			configRevision: 3,
			workloadRevision: 4,
		};
		const updated = await adapter.apply(next, known);
		expect(
			(await api.client.read<V1NetworkPolicy>("NetworkPolicy", known.name))
				?.metadata?.annotations?.["agent-infra.agora.io/fence"],
		).toBe("5");
		expect(await adapter.observe(next, updated)).toBe(true);
		await expect(adapter.apply(binding, known)).rejects.toThrow();
	});
	it("rejects a resourceVersion race without overwriting the concurrent policy", async () => {
		const { api, adapter } = setup();
		const known = await adapter.apply(binding);
		const original = api.client.replace;
		api.client.replace = async (object) => {
			const live = api.resources.get(`NetworkPolicy/${known.name}`);
			if (!live?.metadata) throw new Error();
			live.metadata.resourceVersion = "concurrent-write";
			return original(object);
		};
		await expect(adapter.revoke(binding, known)).rejects.toThrow();
		expect(
			(await api.client.read<V1NetworkPolicy>("NetworkPolicy", known.name))
				?.spec?.egress,
		).toHaveLength(3);
	});
	it("rechecks lease expiry after API reads and makes no mutation", async () => {
		const { api, adapter } = setup();
		const known = await adapter.apply(binding);
		const now = vi
			.spyOn(Date, "now")
			.mockReturnValue(binding.leaseExpiresAt - 1);
		const read = api.client.read;
		api.client.read = async (...args) => {
			const result = await read(...args);
			now.mockReturnValue(binding.leaseExpiresAt);
			return result as never;
		};
		const writes = api.writes.length;
		try {
			await expect(adapter.revoke(binding, known)).rejects.toThrow();
		} finally {
			now.mockRestore();
		}
		expect(api.writes).toHaveLength(writes);
	});
	it("snapshots deployment rules and ignores Runtime/request destinations", async () => {
		const { api } = setup();
		const deployment = structuredClone(profile);
		const adapter = createSessionSandboxEgressV1({
			client: api.client,
			profile: deployment,
			withCurrentAllocation: async (_value, _operation, action) => action(),
		});
		if (!deployment.modelEgress[0]) throw new Error();
		deployment.modelEgress[0].destination.ip = "203.0.113.99";
		const supplied = {
			...binding,
			modelEgress: [{ destination: { ip: "203.0.113.100" }, port: 8080 }],
		};
		const known = await adapter.apply(supplied);
		expect(
			(await api.client.read<V1NetworkPolicy>("NetworkPolicy", known.name))
				?.spec?.egress?.[0],
		).toEqual({
			to: [{ ipBlock: { cidr: "203.0.113.8/32" } }],
			ports: [{ protocol: "TCP", port: 443 }],
		});
	});
});
