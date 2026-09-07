import type {
	V1Ingress,
	V1Secret,
	V1Service,
	V1StatefulSet,
} from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import {
	fakeKubernetesApi,
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";

function fixture() {
	const api = fakeKubernetesApi();
	const probe = vi.fn(async () => true);
	const adapter = () =>
		createKubernetesRuntimeAdapterV1({
			client: api.client,
			policy: workloadTestPolicy,
			probe,
		});
	return { ...api, probe, adapter };
}

describe("GA Kubernetes Workload adapter", () => {
	it("creates isolated resources, keeps candidates unrouted, and exposes exactly one verified target", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		expect(identity).toMatchObject({ uid: expect.any(String), generation: 1 });
		if (!identity || identity === "pending") throw new Error();
		const service = () =>
			f.client.read<V1Service>("Service", desired.service.name);
		expect(
			(await service())?.spec?.selector?.["agent-infra.agora.io/revision"],
		).toBe("closed");
		expect(await f.client.read("Ingress", desired.route.name)).toBeNull();
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		await adapter.promote(desired, identity);
		expect(
			(await service())?.spec?.selector?.["agent-infra.agora.io/revision"],
		).toBe("1");
		const ingress = await f.client.read<V1Ingress>(
			"Ingress",
			desired.route.name,
		);
		expect(ingress?.spec?.rules).toHaveLength(1);
		expect(ingress?.spec?.tls?.[0]?.secretName).toBe(
			workloadTestPolicy.tlsSecretName,
		);
		const pod = (
			await f.client.list<V1StatefulSet>(
				"StatefulSet",
				`agent-infra.agora.io/agent=${desired.service.name}`,
			)
		)[0]?.spec?.template.spec;
		expect(pod?.automountServiceAccountToken).toBe(false);
		expect(pod?.containers[0]?.securityContext?.capabilities?.drop).toEqual([
			"ALL",
		]);
		expect(f.probe).toHaveBeenCalledWith(
			expect.objectContaining({
				serviceOrigin: `http://${desired.service.name}-probe.workload-test.svc:8080`,
			}),
		);
	});
	it("replays creation after every partial apply without duplicating resources", async () => {
		for (let stage = 1; stage <= 6; stage++) {
			const f = fixture();
			const desired = workloadDesiredFixture();
			f.failAfter(stage);
			await expect(f.adapter().apply(desired)).rejects.toThrow();
			const identity = await f.adapter().apply(desired);
			expect(identity).toMatchObject({ uid: expect.any(String) });
			expect(
				[...f.resources.values()].filter(
					(object) => object.kind === "StatefulSet",
				),
			).toHaveLength(1);
			expect(
				[...f.resources.values()].filter(
					(object) => object.kind === "PersistentVolumeClaim",
				),
			).toHaveLength(1);
		}
	});
	it("reuses StatefulSet and PVC across stop, restart, upgrade and rollback; refuses stale work", async () => {
		const f = fixture();
		const a = workloadDesiredFixture();
		const adapter = f.adapter();
		const identityA = await adapter.apply(a);
		if (!identityA || identityA === "pending") throw new Error();
		await adapter.promote(a, identityA);
		const pvc = await f.client.read(
			"PersistentVolumeClaim",
			a.persistentVolume.name,
		);
		await adapter.closeAgent(a.agentId, 2);
		expect(await adapter.scaleDownAgent(a.agentId, 2)).toBe("pending");
		expect(await adapter.scaleDownAgent(a.agentId, 2)).toMatchObject({
			uid: identityA.uid,
		});
		const b = workloadDesiredFixture(3);
		const identityB = await adapter.apply(b);
		if (!identityB || identityB === "pending") throw new Error();
		expect(identityB.uid).toBe(identityA.uid);
		await adapter.promote(b, identityB);
		await expect(adapter.apply(a)).rejects.toThrow();
		await expect(adapter.closeAgent(a.agentId, 1)).rejects.toThrow();
		await adapter.closeAgent(a.agentId, 4);
		const rollback = { ...a, workloadRevision: 4, fence: 4 };
		expect(await adapter.apply(rollback)).toBe("pending");
		const restored = await adapter.apply(rollback);
		if (!restored || restored === "pending") throw new Error();
		await adapter.promote(rollback, restored);
		expect(
			(await f.client.read("PersistentVolumeClaim", a.persistentVolume.name))
				?.metadata?.uid,
		).toBe(pvc?.metadata?.uid);
		expect(
			(await f.client.read<V1StatefulSet>("StatefulSet", a.service.name))?.spec
				?.template.spec?.containers[0]?.image,
		).toContain(a.imageDigest);
	});
	it("rejects cross-Agent names and preserves foreign resources during cleanup", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		await f.adapter().apply(desired);
		await expect(
			f.adapter().apply({
				...desired,
				serviceAccount: { ...desired.serviceAccount, name: "another-agent" },
			}),
		).rejects.toThrow();
		const service = await f.client.read<V1Service>(
			"Service",
			desired.service.name,
		);
		if (!service) throw new Error();
		f.resources.set(`Service/${desired.service.name}`, {
			...service,
			metadata: {
				...service.metadata,
				annotations: { "agent-infra.agora.io/agent-id": "agent-b" },
			},
		});
		await expect(
			f.adapter().cleanupAgent(desired.agentId, 1, true),
		).rejects.toThrow();
		expect(
			await f.client.read("StatefulSet", desired.service.name),
		).not.toBeNull();
	});
	it("never promotes an unhealthy or replaced candidate and deletes new PVC only after route closure", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		f.probe.mockResolvedValue(false);
		await expect(adapter.promote(desired, identity)).rejects.toThrow();
		expect(await f.client.read("Ingress", desired.route.name)).toBeNull();
		expect(await adapter.cleanupAgent(desired.agentId, 1, true)).toBe(true);
		expect(f.resources.size).toBe(0);
	});
	it("creates immutable Agent/version Secret refs and refuses to mutate their value", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const ref = {
			schemaVersion: 1 as const,
			agentId: desired.agentId,
			ownerType: "agent-owner" as const,
			ownerId: "owner-a",
			secretId: "secret-a",
			secretVersion: 1,
			configRevision: 1,
			algorithmVersion: "aes-256-gcm:v1" as const,
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
			wrappingKeyVersion: "key-a",
			name: `${desired.service.name}-secret-1`,
		};
		desired.secretRefs = [ref];
		await f
			.adapter()
			.applyImmutableSecret(
				desired,
				ref.name,
				"API_KEY",
				new Uint8Array([1, 2, 3]),
			);
		const existing = await f.client.read<V1Secret>("Secret", ref.name);
		expect(existing?.immutable).toBe(true);
		await expect(
			f
				.adapter()
				.applyImmutableSecret(
					desired,
					ref.name,
					"API_KEY",
					new Uint8Array([4]),
				),
		).rejects.toThrow();
		expect((await f.client.read<V1Secret>("Secret", ref.name))?.data).toEqual(
			existing?.data,
		);
	});
});
