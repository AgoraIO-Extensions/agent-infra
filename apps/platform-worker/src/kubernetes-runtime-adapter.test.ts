import type {
	KubernetesObject,
	V1Ingress,
	V1NetworkPolicy,
	V1PersistentVolumeClaim,
	V1Pod,
	V1PodSpec,
	V1Secret,
	V1SecurityContext,
	V1Service,
	V1StatefulSet,
} from "@kubernetes/client-node";
import { ObjectSerializer } from "@kubernetes/client-node/dist/gen/models/ObjectSerializer.js";
import { describe, expect, it, vi } from "vitest";
import {
	fakeKubernetesApi,
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import type {
	WorkerKubernetesClientV1,
	WorkloadResourceKind,
} from "./kubernetes-client.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";

type SecurityContextMutation = (
	securityContext: V1SecurityContext | undefined,
) => V1SecurityContext;

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
	it("rejects deployment annotations in the controller-owned namespace", () => {
		const f = fixture();
		expect(() =>
			createKubernetesRuntimeAdapterV1({
				client: f.client,
				policy: {
					...workloadTestPolicy,
					platformAuthAnnotations: {
						"agent-infra.agora.io/agent-id": "overridden",
					},
				},
				probe: f.probe,
			}),
		).toThrow();
	});
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
	it("closes an opened candidate selector but keeps the verified route stable", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const service = await f.client.read<V1Service>(
			"Service",
			desired.service.name,
		);
		if (!service) throw new Error();
		f.resources.set(`Service/${desired.service.name}`, {
			...service,
			spec: {
				...service.spec,
				selector: {
					"agent-infra.agora.io/agent": desired.service.name,
					"agent-infra.agora.io/revision": String(desired.workloadRevision),
				},
			},
		} as V1Service);
		expect(await adapter.observe(desired, identity)).toBe("drifted");

		const request = {
			schemaVersion: 1 as const,
			requestId: `${desired.requestId}-route`,
			traceId: desired.traceId,
			agentId: desired.agentId,
			fence: desired.fence,
			action: "promote" as const,
			candidateValidated: true,
			candidateRoute: {
				routeRef: desired.route.name,
				workloadUid: identity.uid,
				workloadGeneration: identity.generation,
				workloadRevision: desired.workloadRevision,
			},
		};
		expect(await adapter.switchRoute(request)).toMatchObject({
			status: "failed",
			routedWorkloads: [],
		});
		expect(
			(await f.client.read<V1Service>("Service", desired.service.name))?.spec
				?.selector,
		).toEqual({
			"agent-infra.agora.io/agent": desired.service.name,
			"agent-infra.agora.io/revision": "closed",
		});
		expect(await f.client.read("Ingress", desired.route.name)).toBeNull();

		await adapter.promote(desired, identity);
		expect(await adapter.observe(desired, identity, "open")).toBe("healthy");
		expect(await adapter.switchRoute(request, "open")).toMatchObject({
			status: "completed",
			routedWorkloads: [request.candidateRoute],
		});
		const verified = await f.client.read<V1Service>(
			"Service",
			desired.service.name,
		);
		if (!verified) throw new Error();
		f.resources.set(`Service/${desired.service.name}`, {
			...verified,
			spec: {
				...verified.spec,
				selector: { "agent-infra.agora.io/revision": "foreign" },
			},
		} as V1Service);
		expect(await adapter.observe(desired, identity, "open")).toBe("drifted");
	});
	it("requires exact controller metadata on every observed resource", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture(2);
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		await adapter.promote(desired, identity);
		expect(await adapter.observe(desired, identity, "open")).toBe("healthy");
		const resources = [
			{ kind: "ServiceAccount", name: desired.serviceAccount.name },
			{ kind: "NetworkPolicy", name: desired.service.name },
			{ kind: "Service", name: `${desired.service.name}-probe` },
			{ kind: "Service", name: desired.service.name },
			{ kind: "Ingress", name: desired.route.name },
		] as const;
		const mutations = [
			{
				label: "revision",
				mutate(resource: KubernetesObject) {
					if (!resource.metadata?.labels) throw new Error();
					resource.metadata.labels["agent-infra.agora.io/revision"] = "1";
				},
			},
			{
				label: "configuration revision",
				mutate(resource: KubernetesObject) {
					if (!resource.metadata?.annotations) throw new Error();
					resource.metadata.annotations[
						"agent-infra.agora.io/config-revision"
					] = "1";
				},
			},
			{
				label: "fence",
				mutate(resource: KubernetesObject) {
					if (!resource.metadata?.annotations) throw new Error();
					resource.metadata.annotations["agent-infra.agora.io/fence"] = "1";
				},
			},
		] as const;
		for (const { kind, name } of resources) {
			const current = await f.client.read<KubernetesObject>(kind, name);
			if (!current) throw new Error();
			for (const { label, mutate } of mutations) {
				const stale = structuredClone(current);
				mutate(stale);
				f.resources.set(`${kind}/${name}`, stale);
				expect(
					await adapter.observe(desired, identity, "open"),
					`${kind} ${label}`,
				).toBe("drifted");
				f.resources.set(`${kind}/${name}`, current);
			}
		}
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
	it("repairs widened NetworkPolicy ingress ports before a candidate can route", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = createKubernetesRuntimeAdapterV1({
			client: f.client,
			policy: workloadTestPolicy,
			probe: f.probe,
		});
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const network = await f.client.read<V1NetworkPolicy>(
			"NetworkPolicy",
			desired.service.name,
		);
		expect(network?.spec?.egress, "DNS and other egress remain denied").toEqual(
			[],
		);
		const ruleIndex = 0;
		const ports = network?.spec?.ingress?.[ruleIndex]?.ports;
		if (!network || !ports?.[0]) throw new Error();
		f.resources.set(`NetworkPolicy/${desired.service.name}`, {
			...network,
			spec: {
				...network.spec,
				ingress: network.spec?.ingress?.map((rule, index) =>
					index === ruleIndex
						? {
								...rule,
								ports: rule.ports?.map((port, portIndex) =>
									portIndex === 0 ? { ...port, endPort: 65_535 } : port,
								),
							}
						: rule,
				),
			},
		} as V1NetworkPolicy);

		expect(await adapter.observe(desired, identity)).toBe("drifted");
		const result = await adapter.switchRoute({
			schemaVersion: 1,
			requestId: `${desired.requestId}-ingress-route`,
			traceId: desired.traceId,
			agentId: desired.agentId,
			fence: desired.fence,
			action: "promote",
			candidateValidated: true,
			candidateRoute: {
				routeRef: desired.route.name,
				workloadUid: identity.uid,
				workloadGeneration: identity.generation,
				workloadRevision: desired.workloadRevision,
			},
		});
		expect(result).toMatchObject({
			status: "failed",
			routedWorkloads: [],
		});
		expect(
			(await f.client.read<V1Service>("Service", desired.service.name))?.spec
				?.selector?.["agent-infra.agora.io/revision"],
		).toBe("closed");
		expect(await f.client.read("Ingress", desired.route.name)).toBeNull();

		await adapter.apply(desired);
		const repaired = await f.client.read<V1NetworkPolicy>(
			"NetworkPolicy",
			desired.service.name,
		);
		expect(
			repaired?.spec?.ingress?.[ruleIndex]?.ports?.[0]?.endPort,
		).toBeUndefined();
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		const port = repaired?.spec?.ingress?.[ruleIndex]?.ports?.[0]?.port;
		if (!repaired || typeof port !== "number") throw new Error();
		f.resources.set(`NetworkPolicy/${desired.service.name}`, {
			...repaired,
			spec: {
				...repaired.spec,
				ingress: repaired.spec?.ingress?.map((rule, index) =>
					index === ruleIndex
						? {
								...rule,
								ports: rule.ports?.map((entry, portIndex) =>
									portIndex === 0 ? { ...entry, endPort: port } : entry,
								),
							}
						: rule,
				),
			},
		} as V1NetworkPolicy);
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		await adapter.apply(desired);
		expect(
			(
				await f.client.read<V1NetworkPolicy>(
					"NetworkPolicy",
					desired.service.name,
				)
			)?.spec?.ingress?.[ruleIndex]?.ports?.[0]?.endPort,
		).toBe(port);
	});
	it("repairs a NetworkPolicy selector that no longer covers the workload", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const network = await f.client.read<V1NetworkPolicy>(
			"NetworkPolicy",
			desired.service.name,
		);
		if (!network) throw new Error();
		f.resources.set(`NetworkPolicy/${desired.service.name}`, {
			...network,
			spec: {
				...network.spec,
				podSelector: {
					...network.spec?.podSelector,
					matchExpressions: [{ key: "isolation-disabled", operator: "Exists" }],
				},
			},
		} as V1NetworkPolicy);

		expect(await adapter.observe(desired, identity)).toBe("drifted");
		await adapter.apply(desired);
		expect(
			(
				await f.client.read<V1NetworkPolicy>(
					"NetworkPolicy",
					desired.service.name,
				)
			)?.spec?.podSelector?.matchExpressions,
		).toBeUndefined();
		expect(await adapter.observe(desired, identity)).toBe("healthy");
	});
	it("accepts exact workload resources deserialized by the Kubernetes client", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const deserialize = <T extends KubernetesObject>(resource: T): T => {
			const type = `V1${resource.kind}`;
			const apiDocument = ObjectSerializer.serialize(resource, type, "");
			const value = ObjectSerializer.deserialize(apiDocument, type, "") as T;
			if (value.kind === "NetworkPolicy") {
				const network = value as V1NetworkPolicy;
				if (!network.spec?.podSelector) throw new Error();
				network.spec.podSelector.matchExpressions = [];
			}
			return value;
		};
		const client: WorkerKubernetesClientV1 = {
			...f.client,
			async read<T extends KubernetesObject>(
				kind: WorkloadResourceKind,
				name: string,
			) {
				const resource = await f.client.read<T>(kind, name);
				return resource ? deserialize(resource) : null;
			},
			async list<T extends KubernetesObject>(
				kind: WorkloadResourceKind,
				selector: string,
			) {
				return (await f.client.list<T>(kind, selector)).map(deserialize);
			},
		};
		const adapter = createKubernetesRuntimeAdapterV1({
			client,
			policy: workloadTestPolicy,
			probe: f.probe,
		});
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const network = await client.read<V1NetworkPolicy>(
			"NetworkPolicy",
			desired.service.name,
		);
		const workload = await client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		if (!network?.spec?.podSelector || !workload?.spec) throw new Error();
		expect(Object.getPrototypeOf(network.spec.podSelector)).not.toBe(
			Object.prototype,
		);
		expect(
			Object.getPrototypeOf(workload.spec.template.spec?.securityContext),
		).not.toBe(Object.prototype);

		expect(await adapter.observe(desired, identity)).toBe("healthy");
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
		if (!pvc) throw new Error();
		await adapter.closeAgent(a.agentId, 2, 9);
		expect(await adapter.scaleDownAgent(a.agentId, 2, 9)).toBe("pending");
		expect(await adapter.scaleDownAgent(a.agentId, 2, 9)).toMatchObject({
			uid: identityA.uid,
		});
		const b = { ...workloadDesiredFixture(3), fence: 10 };
		const identityB = await adapter.apply(b);
		if (!identityB || identityB === "pending") throw new Error();
		expect(identityB.uid).toBe(identityA.uid);
		const reusedPvc = await f.client.read(
			"PersistentVolumeClaim",
			a.persistentVolume.name,
		);
		expect(reusedPvc?.metadata?.uid).toBe(pvc.metadata?.uid);
		expect(reusedPvc?.metadata?.labels?.["agent-infra.agora.io/revision"]).toBe(
			"3",
		);
		expect(
			reusedPvc?.metadata?.annotations?.["agent-infra.agora.io/fence"],
		).toBe("10");
		await adapter.promote(b, identityB);
		await expect(adapter.apply(a)).rejects.toThrow();
		await expect(adapter.closeAgent(a.agentId, 1, 1)).rejects.toThrow();
		await adapter.closeAgent(a.agentId, 4, 11);
		const rollback = { ...a, workloadRevision: 4, fence: 12 };
		expect(await adapter.apply(rollback)).toBe("pending");
		const restored = await adapter.apply(rollback);
		if (!restored || restored === "pending") throw new Error();
		await adapter.promote(rollback, restored);
		expect(
			(await f.client.read("PersistentVolumeClaim", a.persistentVolume.name))
				?.metadata?.uid,
		).toBe(pvc.metadata?.uid);
		expect(
			(await f.client.read<V1StatefulSet>("StatefulSet", a.service.name))?.spec
				?.template.spec?.containers[0]?.image,
		).toContain(a.imageDigest);
	});
	it("does not overwrite resources from a newer fence at the same revision", async () => {
		const f = fixture();
		const adapter = f.adapter();
		const current = { ...workloadDesiredFixture(), fence: 11 };
		const stale = { ...current, requestId: "request-stale", fence: 9 };
		const identity = await adapter.apply(current);
		if (!identity || identity === "pending") throw new Error();
		const writes = f.writes.length;

		await expect(adapter.apply(stale)).rejects.toMatchObject({
			code: "conflict",
		});
		expect(f.writes).toHaveLength(writes);
		expect(
			(await f.client.read<V1StatefulSet>("StatefulSet", current.service.name))
				?.metadata?.annotations?.["agent-infra.agora.io/fence"],
		).toBe("11");
	});
	it("fences an already-stopped workload before reporting newer convergence", async () => {
		const f = fixture();
		const adapter = f.adapter();
		const running = { ...workloadDesiredFixture(), fence: 9 };
		const identity = await adapter.apply(running);
		if (!identity || identity === "pending") throw new Error();
		const stopped = {
			...running,
			requestId: "request-stop",
			desiredState: "stopped" as const,
			replicas: 0 as const,
		};
		expect(await adapter.reconcile(stopped)).toMatchObject({
			status: "failed",
		});
		expect(
			await adapter.reconcile({ ...stopped, requestId: "request-stop-retry" }),
		).toMatchObject({ status: "applied" });

		const current = {
			...stopped,
			requestId: "request-current-stop",
			fence: 11,
		};
		expect(await adapter.reconcile(current)).toMatchObject({
			status: "applied",
		});
		for (const kind of ["Service", "StatefulSet"] as const)
			expect(
				(await f.client.read(kind, running.service.name))?.metadata
					?.annotations?.["agent-infra.agora.io/fence"],
			).toBe("11");

		const writes = f.writes.length;
		await expect(
			adapter.apply({ ...running, requestId: "request-stale-restart" }),
		).rejects.toMatchObject({ code: "conflict" });
		expect(f.writes).toHaveLength(writes);
		expect(
			(await f.client.read<V1StatefulSet>("StatefulSet", running.service.name))
				?.spec?.replicas,
		).toBe(0);
	});
	it("fences a scaled-down StatefulSet while its Pod is terminating", async () => {
		const f = fixture();
		const adapter = f.adapter();
		const running = { ...workloadDesiredFixture(), fence: 9 };
		const identity = await adapter.apply(running);
		if (!identity || identity === "pending") throw new Error();
		const pod = await f.client.read<V1Pod>("Pod", `${running.service.name}-0`);
		if (!pod) throw new Error();
		const stopped = {
			...running,
			requestId: "request-stop",
			desiredState: "stopped" as const,
			replicas: 0 as const,
		};
		expect(await adapter.apply(stopped)).toBe("pending");
		f.resources.set(`Pod/${running.service.name}-0`, {
			...pod,
			metadata: {
				...pod.metadata,
				deletionTimestamp: new Date("2026-09-09T00:00:00Z"),
			},
		} as V1Pod);

		expect(
			await adapter.apply({
				...stopped,
				requestId: "request-current-stop",
				fence: 11,
			}),
		).toBe("pending");
		expect(
			(await f.client.read<V1StatefulSet>("StatefulSet", running.service.name))
				?.metadata?.annotations?.["agent-infra.agora.io/fence"],
		).toBe("11");

		const writes = f.writes.length;
		await expect(
			adapter.apply({ ...running, requestId: "request-stale-restart" }),
		).rejects.toMatchObject({ code: "conflict" });
		expect(f.writes).toHaveLength(writes);
	});
	it("fences a closed Service across partial cleanup before deleting a PVC", async () => {
		const f = fixture();
		const adapter = f.adapter();
		const desired = { ...workloadDesiredFixture(), fence: 9 };
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		f.resources.delete(`StatefulSet/${desired.service.name}`);
		const request = {
			schemaVersion: 1,
			requestId: "request-current-cleanup",
			traceId: desired.traceId,
			agentId: desired.agentId,
			configRevision: desired.configRevision,
			workloadRevision: desired.workloadRevision,
			workloadUid: identity.uid,
			workloadGeneration: identity.generation,
			fence: 11,
			persistentVolumeIntent: "retain-existing" as const,
		};
		expect(await adapter.cleanup(request)).toMatchObject({
			status: "in-progress",
			phase: "removing-resources",
			routeClosed: true,
		});
		expect(
			(await f.client.read<V1Service>("Service", desired.service.name))
				?.metadata?.annotations?.["agent-infra.agora.io/fence"],
		).toBe("11");

		f.resources.delete(`Pod/${desired.service.name}-0`);
		const stale = await adapter.cleanup({
			...request,
			requestId: "request-stale-cleanup",
			fence: 9,
			persistentVolumeIntent: "delete-new" as const,
		});
		expect(stale).toMatchObject({
			status: "failed",
			phase: "closing-route",
			routeClosed: false,
		});
		expect(
			await f.client.read(
				"PersistentVolumeClaim",
				desired.persistentVolume.name,
			),
		).not.toBeNull();
	});
	it("fences a retained PVC after cleanup removes the other resources", async () => {
		const f = fixture();
		const adapter = f.adapter();
		const desired = { ...workloadDesiredFixture(), fence: 9 };
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const request = {
			schemaVersion: 1,
			requestId: "request-current-cleanup",
			traceId: desired.traceId,
			agentId: desired.agentId,
			configRevision: desired.configRevision,
			workloadRevision: desired.workloadRevision,
			workloadUid: identity.uid,
			workloadGeneration: identity.generation,
			fence: 11,
			persistentVolumeIntent: "retain-existing" as const,
		};
		expect(await adapter.cleanup(request)).toMatchObject({
			status: "completed",
			removed: { persistentVolume: false },
		});
		expect(
			(
				await f.client.read<V1PersistentVolumeClaim>(
					"PersistentVolumeClaim",
					desired.persistentVolume.name,
				)
			)?.metadata?.annotations?.["agent-infra.agora.io/fence"],
		).toBe("11");

		const stale = await adapter.cleanup({
			...request,
			requestId: "request-stale-cleanup",
			fence: 9,
			persistentVolumeIntent: "delete-new" as const,
		});
		expect(stale).toMatchObject({ status: "failed" });
		expect(
			await f.client.read(
				"PersistentVolumeClaim",
				desired.persistentVolume.name,
			),
		).not.toBeNull();
	});
	it("fences a retained PVC when an absent workload remains stopped", async () => {
		const f = fixture();
		const adapter = f.adapter();
		const desired = { ...workloadDesiredFixture(), fence: 9 };
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		expect(
			await adapter.cleanup({
				schemaVersion: 1,
				requestId: "request-cleanup",
				traceId: desired.traceId,
				agentId: desired.agentId,
				configRevision: desired.configRevision,
				workloadRevision: desired.workloadRevision,
				workloadUid: identity.uid,
				workloadGeneration: identity.generation,
				fence: desired.fence,
				persistentVolumeIntent: "retain-existing" as const,
			}),
		).toMatchObject({ status: "completed" });
		const retained = await f.client.read<V1PersistentVolumeClaim>(
			"PersistentVolumeClaim",
			desired.persistentVolume.name,
		);
		if (!retained) throw new Error();

		const stopped = {
			...desired,
			requestId: "request-current-stop",
			fence: 11,
			desiredState: "stopped" as const,
			replicas: 0 as const,
		};
		expect(await adapter.apply(stopped)).toBeNull();
		const fenced = await f.client.read<V1PersistentVolumeClaim>(
			"PersistentVolumeClaim",
			desired.persistentVolume.name,
		);
		expect(fenced?.metadata?.uid).toBe(retained.metadata?.uid);
		expect(fenced?.metadata?.resourceVersion).not.toBe(
			retained.metadata?.resourceVersion,
		);
		expect(fenced?.metadata?.annotations?.["agent-infra.agora.io/fence"]).toBe(
			"11",
		);
		expect(fenced?.spec).toStrictEqual(retained.spec);

		await expect(
			adapter.apply({ ...desired, requestId: "request-stale-restart" }),
		).rejects.toMatchObject({ code: "conflict" });
		expect(await f.client.read("StatefulSet", desired.service.name)).toBeNull();
	});
	it("fences a retained PVC when scale-down finds no StatefulSet", async () => {
		const f = fixture();
		const adapter = f.adapter();
		const desired = { ...workloadDesiredFixture(), fence: 9 };
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const retained = await f.client.read<V1PersistentVolumeClaim>(
			"PersistentVolumeClaim",
			desired.persistentVolume.name,
		);
		if (!retained) throw new Error();
		f.resources.delete(`StatefulSet/${desired.service.name}`);

		expect(
			await adapter.scaleDownAgent(
				desired.agentId,
				desired.workloadRevision,
				11,
			),
		).toBe("pending");
		const fenced = await f.client.read<V1PersistentVolumeClaim>(
			"PersistentVolumeClaim",
			desired.persistentVolume.name,
		);
		expect(fenced?.metadata?.uid).toBe(retained.metadata?.uid);
		expect(fenced?.metadata?.resourceVersion).not.toBe(
			retained.metadata?.resourceVersion,
		);
		expect(fenced?.metadata?.annotations?.["agent-infra.agora.io/fence"]).toBe(
			"11",
		);
		expect(fenced?.spec).toStrictEqual(retained.spec);
		f.resources.delete(`Pod/${desired.service.name}-0`);
		expect(
			await adapter.scaleDownAgent(
				desired.agentId,
				desired.workloadRevision,
				11,
			),
		).toBeNull();

		await expect(
			adapter.apply({ ...desired, requestId: "request-stale-restart" }),
		).rejects.toMatchObject({ code: "conflict" });
		expect(await f.client.read("StatefulSet", desired.service.name)).toBeNull();
	});
	it("does not close or remove resources from a newer fence at the same revision", async () => {
		const f = fixture();
		const adapter = f.adapter();
		const desired = { ...workloadDesiredFixture(), fence: 11 };
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		await adapter.promote(desired, identity);
		const writes = f.writes.length;

		const staleRequest = {
			schemaVersion: 1,
			requestId: "request-stale-cleanup",
			traceId: desired.traceId,
			agentId: desired.agentId,
			configRevision: desired.configRevision,
			workloadRevision: desired.workloadRevision,
			workloadUid: identity.uid,
			workloadGeneration: identity.generation,
			fence: 9,
			persistentVolumeIntent: "retain-existing" as const,
		};
		const result = await adapter.cleanup(staleRequest);

		expect(result).toMatchObject({
			status: "failed",
			phase: "closing-route",
			routeClosed: false,
		});
		expect(f.writes).toHaveLength(writes);
		expect(
			(await f.client.read<V1Service>("Service", desired.service.name))?.spec
				?.selector?.["agent-infra.agora.io/revision"],
		).toBe(String(desired.workloadRevision));
		expect(await f.client.read("Ingress", desired.route.name)).not.toBeNull();
		expect(
			await f.client.read("StatefulSet", desired.service.name),
		).not.toBeNull();

		const authorized = await adapter.cleanup({
			...staleRequest,
			requestId: "request-current-cleanup",
			fence: desired.fence,
		});
		expect(authorized).toMatchObject({
			status: "completed",
			routeClosed: true,
		});
	});
	it("fences a lost PVC cleanup delete after a later revision reuses it", async () => {
		const f = fixture();
		const a = { ...workloadDesiredFixture(), fence: 9 };
		const adapter = f.adapter();
		const identityA = await adapter.apply(a);
		if (!identityA || identityA === "pending") throw new Error();
		const pvc = await f.client.read<V1PersistentVolumeClaim>(
			"PersistentVolumeClaim",
			a.persistentVolume.name,
		);
		if (!pvc) throw new Error();

		f.loseNextDelete("PersistentVolumeClaim", a.persistentVolume.name);
		await expect(
			adapter.cleanupAgent(a.agentId, a.workloadRevision, a.fence, true),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(f.deferredDelete()).toMatchObject({
			kind: "PersistentVolumeClaim",
			metadata: {
				uid: pvc.metadata?.uid,
				resourceVersion: pvc.metadata?.resourceVersion,
			},
		});
		expect(await f.client.read("StatefulSet", a.service.name)).toBeNull();

		const b = { ...workloadDesiredFixture(3), fence: 10 };
		const identityB = await adapter.apply(b);
		if (!identityB || identityB === "pending") throw new Error();
		const reusedPvc = await f.client.read<V1PersistentVolumeClaim>(
			"PersistentVolumeClaim",
			a.persistentVolume.name,
		);
		if (!reusedPvc) throw new Error();
		expect(reusedPvc.metadata?.uid).toBe(pvc.metadata?.uid);
		expect(reusedPvc.metadata?.resourceVersion).not.toBe(
			pvc.metadata?.resourceVersion,
		);
		expect(reusedPvc.spec).toStrictEqual(pvc.spec);

		await expect(f.completeDeferredDelete()).rejects.toMatchObject({
			code: "conflict",
		});
		const afterDeferredDelete = await f.client.read<V1PersistentVolumeClaim>(
			"PersistentVolumeClaim",
			a.persistentVolume.name,
		);
		expect(afterDeferredDelete?.metadata?.uid).toBe(pvc.metadata?.uid);
		expect(afterDeferredDelete?.spec).toStrictEqual(pvc.spec);
	});
	it.each([
		["access mode", undefined, { accessModes: ["ReadWriteMany"] }],
		["block volume mode", undefined, { volumeMode: "Block" }],
		[
			"volume selector",
			undefined,
			{ selector: { matchLabels: { storagePool: "external" } } },
		],
		[
			"data source",
			undefined,
			{
				dataSource: {
					apiGroup: "snapshot.storage.k8s.io",
					kind: "VolumeSnapshot",
					name: "snapshot-a",
				},
			},
		],
		[
			"data source reference",
			undefined,
			{
				dataSourceRef: {
					apiGroup: "snapshot.storage.k8s.io",
					kind: "VolumeSnapshot",
					name: "snapshot-a",
				},
			},
		],
		[
			"storage class",
			"approved-storage",
			{ storageClassName: "untrusted-storage" },
		],
		[
			"requested capacity",
			undefined,
			{ resources: { requests: { storage: "1Ti" } } },
		],
	] as const)(
		"rejects reused PVC %s drift",
		async (_label, storageClassName, drift) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = createKubernetesRuntimeAdapterV1({
				client: f.client,
				policy: { ...workloadTestPolicy, storageClassName },
				probe: f.probe,
			});
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const pvc = await f.client.read<V1PersistentVolumeClaim>(
				"PersistentVolumeClaim",
				desired.persistentVolume.name,
			);
			if (!pvc) throw new Error();
			f.resources.set(
				`PersistentVolumeClaim/${desired.persistentVolume.name}`,
				{
					...pvc,
					spec: { ...pvc.spec, ...drift },
				} as V1PersistentVolumeClaim,
			);

			await expect(adapter.apply(desired)).rejects.toMatchObject({
				code: "conflict",
			});
			expect(
				(
					await f.client.read<V1PersistentVolumeClaim>(
						"PersistentVolumeClaim",
						desired.persistentVolume.name,
					)
				)?.spec,
			).toMatchObject(drift);
		},
	);
	it("reuses a filesystem PVC with a Kubernetes binding", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const pvc = await f.client.read<V1PersistentVolumeClaim>(
			"PersistentVolumeClaim",
			desired.persistentVolume.name,
		);
		if (!pvc) throw new Error();
		f.resources.set(`PersistentVolumeClaim/${desired.persistentVolume.name}`, {
			...pvc,
			spec: {
				...pvc.spec,
				volumeMode: "Filesystem",
				volumeName: "bound-volume-a",
			},
		} as V1PersistentVolumeClaim);

		await expect(adapter.apply(desired)).resolves.toMatchObject({
			uid: identity.uid,
		});
		expect(
			(
				await f.client.read<V1PersistentVolumeClaim>(
					"PersistentVolumeClaim",
					desired.persistentVolume.name,
				)
			)?.spec,
		).toMatchObject({
			volumeMode: "Filesystem",
			volumeName: "bound-volume-a",
		});
	});
	it("does not attach a reused PVC while its previous delete is still in progress", async () => {
		const f = fixture();
		const a = workloadDesiredFixture();
		const adapter = f.adapter();
		const identityA = await adapter.apply(a);
		if (!identityA || identityA === "pending") throw new Error();
		const pvc = await f.client.read<V1PersistentVolumeClaim>(
			"PersistentVolumeClaim",
			a.persistentVolume.name,
		);
		if (!pvc) throw new Error();
		const b = workloadDesiredFixture(3);
		expect(await adapter.apply(b)).toBe("pending");
		f.resources.set(`PersistentVolumeClaim/${a.persistentVolume.name}`, {
			...pvc,
			metadata: {
				...pvc.metadata,
				deletionTimestamp: new Date("2026-09-08T00:00:00Z"),
			},
		});
		await expect(adapter.apply(b)).rejects.toMatchObject({ code: "conflict" });
		expect(
			(
				await f.client.read<V1PersistentVolumeClaim>(
					"PersistentVolumeClaim",
					a.persistentVolume.name,
				)
			)?.metadata?.deletionTimestamp,
		).toEqual(new Date("2026-09-08T00:00:00Z"));
		expect(await f.client.read("Pod", `${a.service.name}-0`)).toBeNull();

		// Kubernetes completed the old deletion. A retry starts a new claim instead
		// of attaching the current Workload to the terminating PVC.
		f.resources.delete(`PersistentVolumeClaim/${a.persistentVolume.name}`);
		await adapter.apply(b);
		const identityB = await adapter.apply(b);
		if (!identityB || identityB === "pending") throw new Error();
		expect(
			(
				await f.client.read<V1PersistentVolumeClaim>(
					"PersistentVolumeClaim",
					a.persistentVolume.name,
				)
			)?.metadata?.uid,
		).not.toBe(pvc.metadata?.uid);
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
			f.adapter().cleanupAgent(desired.agentId, 1, 1, true),
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
		expect(await adapter.cleanupAgent(desired.agentId, 1, 1, true)).toBe(true);
		expect(f.resources.size).toBe(0);
	});
	it("removes a stale Ingress before opening an internal-only Service", async () => {
		const f = fixture();
		const external = workloadDesiredFixture();
		const adapter = f.adapter();
		const externalIdentity = await adapter.apply(external);
		if (!externalIdentity || externalIdentity === "pending") throw new Error();
		await adapter.promote(external, externalIdentity);
		expect(await f.client.read("Ingress", external.route.name)).not.toBeNull();

		const internal = workloadDesiredFixture(1, "agent-a", "internal-only");
		const internalIdentity = await adapter.apply(internal);
		if (!internalIdentity || internalIdentity === "pending") throw new Error();
		await adapter.promote(internal, internalIdentity);
		expect(await f.client.read("Ingress", internal.route.name)).toBeNull();
	});
	it("repairs externally routable Service fields before considering a workload healthy", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const service = await f.client.read<V1Service>(
			"Service",
			desired.service.name,
		);
		if (!service) throw new Error();
		f.resources.set(`Service/${desired.service.name}`, {
			...service,
			spec: { ...service.spec, externalIPs: ["203.0.113.10"] },
		} as V1Service);

		expect(await adapter.observe(desired, identity)).toBe("drifted");
		const repaired = await adapter.apply(desired);
		if (!repaired || repaired === "pending") throw new Error();
		expect(
			(await f.client.read<V1Service>("Service", desired.service.name))?.spec
				?.externalIPs,
		).toBeUndefined();
		expect(await adapter.observe(desired, repaired)).toBe("healthy");
	});
	it("repairs a Service that publishes unready endpoints", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const service = await f.client.read<V1Service>(
			"Service",
			desired.service.name,
		);
		if (!service) throw new Error();
		f.resources.set(`Service/${desired.service.name}`, {
			...service,
			spec: { ...service.spec, publishNotReadyAddresses: true },
		} as V1Service);

		expect(await adapter.observe(desired, identity)).toBe("drifted");
		const repaired = await adapter.apply(desired);
		if (!repaired || repaired === "pending") throw new Error();
		expect(
			(await f.client.read<V1Service>("Service", desired.service.name))?.spec
				?.publishNotReadyAddresses,
		).toBeUndefined();
		expect(await adapter.observe(desired, repaired)).toBe("healthy");
	});
	it.each([
		{
			livenessProbe: { exec: { command: ["sh", "-c", "touch /tmp/injected"] } },
		},
		{
			startupProbe: { exec: { command: ["sh", "-c", "touch /tmp/injected"] } },
		},
		{ restartPolicy: "Always" },
		{ terminationMessagePath: "/data/private" },
		{ imagePullPolicy: "Never" },
	])(
		"rejects unmanaged container overrides %j in templates and live Pods",
		async (override) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = f.adapter();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const workload = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				desired.service.name,
			);
			const templateSpec = workload?.spec?.template.spec;
			const pod = await f.client.read<V1Pod>(
				"Pod",
				`${desired.service.name}-0`,
			);
			if (!workload?.spec || !templateSpec || !pod?.spec) throw new Error();
			f.resources.set(`StatefulSet/${desired.service.name}`, {
				...workload,
				spec: {
					...workload.spec,
					template: {
						...workload.spec.template,
						spec: {
							...templateSpec,
							containers: templateSpec.containers.map((container) => ({
								...container,
								...override,
							})),
						},
					},
				},
			} as V1StatefulSet);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			f.resources.set(`StatefulSet/${desired.service.name}`, workload);
			f.resources.set(`Pod/${desired.service.name}-0`, {
				...pod,
				spec: {
					...pod.spec,
					containers: pod.spec.containers.map((container) => ({
						...container,
						...override,
					})),
				},
			} as V1Pod);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
		},
	);
	it("accepts defaulted container probes and rejects readiness handler overrides", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const pod = await f.client.read<V1Pod>("Pod", `${desired.service.name}-0`);
		if (!pod?.spec) throw new Error();
		const container = pod.spec.containers[0];
		if (!container) throw new Error();
		const defaulted = {
			...container,
			imagePullPolicy: "IfNotPresent",
			terminationMessagePath: "/dev/termination-log",
			terminationMessagePolicy: "File",
			readinessProbe: {
				...container.readinessProbe,
				initialDelaySeconds: 0,
				periodSeconds: 10,
				successThreshold: 1,
				httpGet: {
					...container.readinessProbe?.httpGet,
					path: desired.health.path,
					port: desired.service.port,
					scheme: "HTTP",
				},
			},
		};
		f.resources.set(`Pod/${desired.service.name}-0`, {
			...pod,
			spec: { ...pod.spec, containers: [defaulted] },
		} as V1Pod);
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		for (const override of [
			{ exec: { command: ["sh", "-c", "touch /tmp/injected"] } },
			{
				httpGet: { ...defaulted.readinessProbe.httpGet, host: "foreign.test" },
			},
			{ periodSeconds: 1 },
		]) {
			f.resources.set(`Pod/${desired.service.name}-0`, {
				...pod,
				spec: {
					...pod.spec,
					containers: [
						{
							...defaulted,
							readinessProbe: { ...defaulted.readinessProbe, ...override },
						},
					],
				},
			} as V1Pod);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
		}
	});
	it("repairs unsafe StatefulSet drift and rejects unsafe observed Pods", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const workload = await f.client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		if (!workload) throw new Error();
		f.resources.set(`StatefulSet/${desired.service.name}`, {
			...workload,
			spec: {
				...workload.spec,
				template: {
					...workload.spec?.template,
					spec: {
						...workload.spec?.template.spec,
						hostPID: true,
						securityContext: {
							...workload.spec?.template.spec?.securityContext,
							supplementalGroups: [0],
						},
						initContainers: [
							{ name: "injected-init", image: "registry.example.test/init" },
						],
					},
				},
			},
		} as V1StatefulSet);
		expect(await adapter.observe(desired, identity)).toBe("drifted");
		const repaired = await adapter.apply(desired);
		if (!repaired || repaired === "pending") throw new Error();
		expect(
			(await f.client.read<V1StatefulSet>("StatefulSet", desired.service.name))
				?.spec?.template.spec?.hostPID,
		).not.toBe(true);
		expect(
			(await f.client.read<V1StatefulSet>("StatefulSet", desired.service.name))
				?.spec?.template.spec?.initContainers,
		).toBeUndefined();
		expect(
			(await f.client.read<V1StatefulSet>("StatefulSet", desired.service.name))
				?.spec?.template.spec?.securityContext?.supplementalGroups,
		).toBeUndefined();
		const pod = await f.client.read<V1Pod>("Pod", `${desired.service.name}-0`);
		if (!pod) throw new Error();
		for (const unsafeSpec of [
			{ hostIPC: true },
			{ shareProcessNamespace: true },
			{ hostAliases: [{ ip: "203.0.113.10", hostnames: ["provider.test"] }] },
			{ dnsConfig: { nameservers: ["203.0.113.53"] } },
			{ dnsPolicy: "Default" as const },
			{ hostname: undefined },
			{ subdomain: undefined },
			{ hostname: "foreign-hostname" },
			{ subdomain: "foreign-subdomain" },
			{
				securityContext: {
					...pod.spec?.securityContext,
					supplementalGroups: [0],
				},
			},
			{
				initContainers: [
					{ name: "injected-init", image: "registry.example.test/init" },
				],
			},
			{
				ephemeralContainers: [
					{
						name: "injected-debug",
						image: "registry.example.test/debug",
					},
				],
			},
			{
				containers: pod.spec?.containers.map((container) => ({
					...container,
					...(container.name === "agent" ? { workingDir: "/tmp" } : {}),
				})),
			},
		]) {
			f.resources.set(`Pod/${desired.service.name}-0`, {
				...pod,
				spec: { ...pod.spec, ...unsafeSpec },
			} as V1Pod);
			expect(await adapter.observe(desired, repaired)).toBe("drifted");
		}
		f.resources.set(`Pod/${desired.service.name}-0`, {
			...pod,
			spec: {
				...pod.spec,
				dnsPolicy: "ClusterFirst",
				hostname: `${desired.service.name}-0`,
				subdomain: desired.service.name,
			},
		} as V1Pod);
		expect(await adapter.observe(desired, repaired)).toBe("healthy");
	});
	it.each([
		["imagePullSecrets", { imagePullSecrets: [{ name: "foreign" }] }],
		["nodeSelector", { nodeSelector: { "node.example.test/pool": "foreign" } }],
		["tolerations", { tolerations: [{ key: "foreign", operator: "Exists" }] }],
		["affinity", { affinity: { nodeAffinity: {} } }],
		["runtimeClassName", { runtimeClassName: "foreign" }],
		["nodeName", { nodeName: "foreign" }],
		["hostname", { hostname: "foreign-hostname" }],
		["subdomain", { subdomain: "foreign-subdomain" }],
	] as const)(
		"repairs unmanaged StatefulSet scheduling field %s",
		async (field, mutation) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = f.adapter();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const workload = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				desired.service.name,
			);
			if (!workload) throw new Error();
			f.resources.set(`StatefulSet/${desired.service.name}`, {
				...workload,
				spec: {
					...workload.spec,
					template: {
						...workload.spec?.template,
						spec: {
							...workload.spec?.template.spec,
							...mutation,
						} as V1PodSpec,
					},
				},
			} as V1StatefulSet);

			expect(await adapter.observe(desired, identity)).toBe("drifted");
			const repaired = await adapter.apply(desired);
			if (!repaired || repaired === "pending") throw new Error();
			const repairedSpec = (
				await f.client.read<V1StatefulSet>("StatefulSet", desired.service.name)
			)?.spec?.template.spec;
			expect(repairedSpec?.[field]).toBeUndefined();
			expect(await adapter.observe(desired, repaired)).toBe("healthy");
		},
	);
	it.each([
		["command", { command: ["/unexpected"] }],
		["args", { args: ["--unexpected"] }],
		[
			"lifecycle",
			{ lifecycle: { postStart: { exec: { command: ["/unexpected"] } } } },
		],
	] as const)(
		"repairs unexpected agent %s in a StatefulSet template",
		async (_field, mutation) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = f.adapter();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const workload = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				desired.service.name,
			);
			const container = workload?.spec?.template.spec?.containers[0];
			if (!workload || !container) throw new Error();
			f.resources.set(`StatefulSet/${desired.service.name}`, {
				...workload,
				spec: {
					...workload.spec,
					template: {
						...workload.spec?.template,
						spec: {
							...workload.spec?.template.spec,
							containers: [{ ...container, ...mutation }],
						},
					},
				},
			} as unknown as V1StatefulSet);

			expect(await adapter.observe(desired, identity)).toBe("drifted");
			const repaired = await adapter.apply(desired);
			if (!repaired || repaired === "pending") throw new Error();
			expect(
				(
					await f.client.read<V1StatefulSet>(
						"StatefulSet",
						desired.service.name,
					)
				)?.spec?.template.spec?.containers[0],
			).toMatchObject({ name: "agent" });
			expect(
				(
					await f.client.read<V1StatefulSet>(
						"StatefulSet",
						desired.service.name,
					)
				)?.spec?.template.spec?.containers[0],
			).not.toMatchObject(mutation);
			expect(await adapter.observe(desired, repaired)).toBe("healthy");
		},
	);
	it.each([
		{
			label: "image",
			mutate: (workload: V1StatefulSet) => ({
				...workload.spec?.template.spec,
				containers: workload.spec?.template.spec?.containers.map((container) =>
					container.name === "agent"
						? {
								...container,
								image: "registry.example.test/untrusted@sha256:bad",
							}
						: container,
				),
			}),
		},
		{
			label: "sidecar",
			mutate: (workload: V1StatefulSet) => ({
				...workload.spec?.template.spec,
				containers: [
					...(workload.spec?.template.spec?.containers ?? []),
					{ name: "injected", image: "registry.example.test/untrusted" },
				],
			}),
		},
	] as const)(
		"detects and replaces a drifted StatefulSet template: $label",
		async ({ mutate }) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = f.adapter();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const workload = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				desired.service.name,
			);
			const pod = await f.client.read<V1Pod>(
				"Pod",
				`${desired.service.name}-0`,
			);
			if (!workload || !pod) throw new Error();
			f.resources.set(`StatefulSet/${desired.service.name}`, {
				...workload,
				spec: {
					...workload.spec,
					template: {
						...workload.spec?.template,
						spec: mutate(workload),
					},
				},
			} as V1StatefulSet);

			expect(pod.spec?.containers[0]?.image).toBe(
				`${workloadTestPolicy.imageRepository}@${desired.imageDigest}`,
			);
			expect(await adapter.observe(desired, identity)).toBe("drifted");

			const repaired = await adapter.apply(desired);
			if (!repaired || repaired === "pending") throw new Error();
			expect(await adapter.observe(desired, repaired)).toBe("healthy");
		},
	);
	it("repairs and rejects container security-context overrides", async () => {
		const overrides = [
			{ label: "runAsNonRoot", securityContext: { runAsNonRoot: false } },
			{ label: "runAsUser", securityContext: { runAsUser: 0 } },
			{ label: "runAsGroup", securityContext: { runAsGroup: 0 } },
			{
				label: "seccompProfile",
				securityContext: { seccompProfile: { type: "Unconfined" } },
			},
			{ label: "procMount", securityContext: { procMount: "Unmasked" } },
		] as const;
		for (const { label, securityContext } of overrides) {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = f.adapter();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const workload = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				desired.service.name,
			);
			const container = workload?.spec?.template.spec?.containers[0];
			if (!workload || !container) throw new Error();
			f.resources.set(`StatefulSet/${desired.service.name}`, {
				...workload,
				spec: {
					...workload.spec,
					template: {
						...workload.spec?.template,
						spec: {
							...workload.spec?.template.spec,
							containers: [
								{
									...container,
									securityContext: {
										...container.securityContext,
										...securityContext,
									},
								},
							],
						},
					},
				},
			} as V1StatefulSet);
			const repaired = await adapter.apply(desired);
			if (!repaired || repaired === "pending") throw new Error();
			expect(
				(
					await f.client.read<V1StatefulSet>(
						"StatefulSet",
						desired.service.name,
					)
				)?.spec?.template.spec?.containers[0]?.securityContext,
				`repairs ${label}`,
			).toMatchObject({
				allowPrivilegeEscalation: false,
				readOnlyRootFilesystem: true,
				capabilities: { drop: ["ALL"] },
				runAsNonRoot: true,
				runAsUser: 1000,
				runAsGroup: 1000,
				seccompProfile: { type: "RuntimeDefault" },
				procMount: "Default",
			});

			const pod = await f.client.read<V1Pod>(
				"Pod",
				`${desired.service.name}-0`,
			);
			const podContainer = pod?.spec?.containers[0];
			if (!pod || !podContainer) throw new Error();
			f.resources.set(`Pod/${desired.service.name}-0`, {
				...pod,
				spec: {
					...pod.spec,
					containers: [
						{
							...podContainer,
							securityContext: {
								...podContainer.securityContext,
								...securityContext,
							},
						},
					],
				},
			} as V1Pod);
			expect(await adapter.observe(desired, repaired), label).toBe("drifted");
			const result = await adapter.switchRoute({
				schemaVersion: 1,
				requestId: `${desired.requestId}-${label}-route`,
				traceId: desired.traceId,
				agentId: desired.agentId,
				fence: desired.fence,
				action: "promote",
				candidateValidated: true,
				candidateRoute: {
					routeRef: desired.route.name,
					workloadUid: repaired.uid,
					workloadGeneration: repaired.generation,
					workloadRevision: desired.workloadRevision,
				},
			});
			expect(result, label).toMatchObject({
				status: "failed",
				routedWorkloads: [],
			});
			expect(
				(await f.client.read<V1Service>("Service", desired.service.name))?.spec
					?.selector?.["agent-infra.agora.io/revision"],
				label,
			).toBe("closed");
			expect(
				await f.client.read("Ingress", desired.route.name),
				label,
			).toBeNull();
		}
	});
	it("scales down unsafe owned Pods before recreating them from the safe template", async () => {
		const mutations: {
			readonly label: string;
			readonly mutate: SecurityContextMutation;
		}[] = [
			{
				label: "privilege escalation",
				mutate: (securityContext) => ({
					...securityContext,
					allowPrivilegeEscalation: true,
				}),
			},
			{
				label: "writable root filesystem",
				mutate: (securityContext) => ({
					...securityContext,
					readOnlyRootFilesystem: false,
				}),
			},
			{
				label: "dropped capabilities",
				mutate: (securityContext) => ({
					...securityContext,
					capabilities: {},
				}),
			},
			...(
				[
					"runAsNonRoot",
					"runAsUser",
					"runAsGroup",
					"seccompProfile",
					"procMount",
				] as const
			).map((field) => ({
				label: `missing ${field}`,
				mutate: (securityContext: V1SecurityContext | undefined) => ({
					...securityContext,
					[field]: undefined,
				}),
			})),
		];
		for (const { label, mutate } of mutations) {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = f.adapter();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const pod = await f.client.read<V1Pod>(
				"Pod",
				`${desired.service.name}-0`,
			);
			const container = pod?.spec?.containers[0];
			if (!pod || !container) throw new Error();
			f.resources.set(`Pod/${desired.service.name}-0`, {
				...pod,
				spec: {
					...pod.spec,
					containers: [
						{
							...container,
							securityContext: mutate(container.securityContext),
						},
					],
				},
			} as V1Pod);
			expect(await adapter.observe(desired, identity), label).toBe("drifted");

			expect(await adapter.apply(desired), label).toBe("pending");
			expect(
				(
					await f.client.read<V1StatefulSet>(
						"StatefulSet",
						desired.service.name,
					)
				)?.spec?.replicas,
			).toBe(0);
			const repaired = await adapter.apply(desired);
			if (!repaired || repaired === "pending") throw new Error();
			expect(
				(await f.client.read<V1Pod>("Pod", `${desired.service.name}-0`))?.spec
					?.containers[0]?.securityContext,
			).toMatchObject({
				allowPrivilegeEscalation: false,
				readOnlyRootFilesystem: true,
				capabilities: { drop: ["ALL"] },
				runAsNonRoot: true,
				runAsUser: 1000,
				runAsGroup: 1000,
				seccompProfile: { type: "RuntimeDefault" },
				procMount: "Default",
			});
			expect(await adapter.observe(desired, repaired)).toBe("healthy");
		}
	});
	it("recreates current owned Pods that drift from their safe template", async () => {
		const mutatePodSpec = (
			pod: V1Pod,
			mutate: (spec: NonNullable<V1Pod["spec"]>) => NonNullable<V1Pod["spec"]>,
		): V1Pod => {
			if (!pod.spec) throw new Error();
			return { ...pod, spec: mutate(pod.spec) };
		};
		const mutations: {
			readonly label: string;
			readonly mutate: (pod: V1Pod) => V1Pod;
		}[] = [
			{
				label: "pod fsGroup",
				mutate: (pod) =>
					mutatePodSpec(pod, (spec) => ({
						...spec,
						securityContext: {
							...spec.securityContext,
							fsGroup: 2000,
						},
					})),
			},
			{
				label: "service account",
				mutate: (pod) =>
					mutatePodSpec(pod, (spec) => ({
						...spec,
						serviceAccountName: "unexpected",
					})),
			},
			{
				label: "agent environment",
				mutate: (pod) =>
					mutatePodSpec(pod, (spec) => ({
						...spec,
						containers: spec.containers.map((container) =>
							container.name === "agent"
								? {
										...container,
										env: container.env?.map((entry) =>
											entry.name === "LOG_LEVEL"
												? { ...entry, value: "debug" }
												: entry,
										),
									}
								: container,
						),
					})),
			},
			{
				label: "agent command",
				mutate: (pod) =>
					mutatePodSpec(pod, (spec) => ({
						...spec,
						containers: spec.containers.map((container) =>
							container.name === "agent"
								? { ...container, command: ["/unexpected"] }
								: container,
						),
					})),
			},
			{
				label: "agent args",
				mutate: (pod) =>
					mutatePodSpec(pod, (spec) => ({
						...spec,
						containers: spec.containers.map((container) =>
							container.name === "agent"
								? { ...container, args: ["--unexpected"] }
								: container,
						),
					})),
			},
			{
				label: "agent lifecycle",
				mutate: (pod) =>
					mutatePodSpec(pod, (spec) => ({
						...spec,
						containers: spec.containers.map((container) =>
							container.name === "agent"
								? {
										...container,
										lifecycle: {
											postStart: { exec: { command: ["/unexpected"] } },
										},
									}
								: container,
						),
					})),
			},
			{
				label: "agent resources",
				mutate: (pod) =>
					mutatePodSpec(pod, (spec) => ({
						...spec,
						containers: spec.containers.map((container) =>
							container.name === "agent"
								? {
										...container,
										resources: {
											...container.resources,
											requests: {
												...container.resources?.requests,
												cpu: "50m",
											},
										},
									}
								: container,
						),
					})),
			},
			{
				label: "agent readiness probe",
				mutate: (pod) =>
					mutatePodSpec(pod, (spec) => ({
						...spec,
						containers: spec.containers.map((container) =>
							container.name === "agent"
								? {
										...container,
										readinessProbe: {
											...container.readinessProbe,
											timeoutSeconds: 1,
										},
									}
								: container,
						),
					})),
			},
			{
				label: "agent volume mount",
				mutate: (pod) =>
					mutatePodSpec(pod, (spec) => ({
						...spec,
						containers: spec.containers.map((container) =>
							container.name === "agent"
								? {
										...container,
										volumeMounts: container.volumeMounts?.map((mount) =>
											mount.name === "data"
												? { ...mount, mountPath: "/unexpected" }
												: mount,
										),
									}
								: container,
						),
					})),
			},
			{
				label: "pod volume",
				mutate: (pod) =>
					mutatePodSpec(pod, (spec) => ({
						...spec,
						volumes: spec.volumes?.map((volume) =>
							volume.name === "data"
								? {
										...volume,
										persistentVolumeClaim: { claimName: "unexpected-data" },
									}
								: volume,
						),
					})),
			},
			{
				label: "missing hostname",
				mutate: (pod) =>
					mutatePodSpec(pod, (spec) => ({ ...spec, hostname: undefined })),
			},
			{
				label: "missing subdomain",
				mutate: (pod) =>
					mutatePodSpec(pod, (spec) => ({ ...spec, subdomain: undefined })),
			},
			{
				label: "renamed Pod identity",
				mutate: (pod) => {
					const foreignName = `${pod.metadata?.name}-foreign`;
					return {
						...mutatePodSpec(pod, (spec) => ({
							...spec,
							hostname: foreignName,
						})),
						metadata: { ...pod.metadata, name: foreignName },
					};
				},
			},
		];
		for (const { label, mutate } of mutations) {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = f.adapter();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const pod = await f.client.read<V1Pod>(
				"Pod",
				`${desired.service.name}-0`,
			);
			if (!pod) throw new Error();
			f.resources.set(`Pod/${desired.service.name}-0`, mutate(pod));

			expect(await adapter.observe(desired, identity), label).toBe("drifted");
			expect(await adapter.apply(desired), label).toBe("pending");
			expect(
				(
					await f.client.read<V1StatefulSet>(
						"StatefulSet",
						desired.service.name,
					)
				)?.spec?.replicas,
				label,
			).toBe(0);

			const repaired = await adapter.apply(desired);
			if (!repaired || repaired === "pending") throw new Error();
			const recreated = await f.client.read<V1Pod>(
				"Pod",
				`${desired.service.name}-0`,
			);
			const workload = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				desired.service.name,
			);
			expect(recreated?.metadata?.uid, label).not.toBe(pod.metadata?.uid);
			expect(recreated?.spec, label).toStrictEqual({
				...workload?.spec?.template.spec,
				hostname: `${desired.service.name}-0`,
				subdomain: desired.service.name,
			});
			expect(await adapter.observe(desired, repaired), label).toBe("healthy");
		}
	});
	it("does not scale down a drifted Pod owned by another StatefulSet", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const pod = await f.client.read<V1Pod>("Pod", `${desired.service.name}-0`);
		if (!pod) throw new Error();
		f.resources.set(`Pod/${desired.service.name}-foreign`, {
			...pod,
			metadata: {
				...pod.metadata,
				name: `${desired.service.name}-foreign`,
				uid: "foreign-pod",
				ownerReferences: [
					{
						apiVersion: "apps/v1",
						kind: "StatefulSet",
						name: "foreign",
						uid: "foreign-statefulset",
					},
				],
			},
			spec: {
				...pod.spec,
				securityContext: {
					...pod.spec?.securityContext,
					fsGroup: 2000,
				},
			},
		} as V1Pod);

		expect(await adapter.apply(desired)).toMatchObject({ uid: identity.uid });
		expect(
			(await f.client.read<V1StatefulSet>("StatefulSet", desired.service.name))
				?.spec?.replicas,
		).toBe(1);
	});
	it("does not scale down a safe current owned Pod", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const pod = await f.client.read<V1Pod>("Pod", `${desired.service.name}-0`);
		if (!pod) throw new Error();
		f.resources.set(`Pod/${desired.service.name}-0`, {
			...pod,
			spec: {
				...pod.spec,
				dnsPolicy: "ClusterFirst",
				hostname: pod.metadata?.name,
				subdomain: desired.service.name,
			},
		} as V1Pod);
		const writes = f.writes.length;

		expect(await adapter.apply(desired)).toMatchObject({ uid: identity.uid });
		expect(
			(await f.client.read<V1StatefulSet>("StatefulSet", desired.service.name))
				?.spec?.replicas,
		).toBe(1);
		expect(f.writes).toHaveLength(writes);
	});
	it.each([
		{ type: "ExternalName", externalName: "foreign.test" },
		{ externalIPs: ["203.0.113.5"] },
		{ type: "LoadBalancer" },
	])(
		"deletes bypassing Services before reporting route closure %j",
		async (override) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = f.adapter();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			await adapter.promote(desired, identity);
			const service = await f.client.read<V1Service>(
				"Service",
				desired.service.name,
			);
			if (!service) throw new Error();
			f.resources.set(`Service/${desired.service.name}`, {
				...service,
				spec: { ...service.spec, ...override },
			} as V1Service);
			expect(
				await adapter.closeAgent(
					desired.agentId,
					desired.workloadRevision,
					desired.fence,
				),
			).toBe(true);
			expect(await f.client.read("Service", desired.service.name)).toBeNull();
			expect(await f.client.read("Ingress", desired.route.name)).toBeNull();
		},
	);
	it("does not report closure while an unsafe Service deletion remains pending", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = createKubernetesRuntimeAdapterV1({
			client: {
				...f.client,
				async delete(object) {
					if (object.kind !== "Service") await f.client.delete(object);
				},
			},
			policy: workloadTestPolicy,
			probe: f.probe,
		});
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const service = await f.client.read<V1Service>(
			"Service",
			desired.service.name,
		);
		if (!service) throw new Error();
		f.resources.set(`Service/${desired.service.name}`, {
			...service,
			spec: {
				...service.spec,
				type: "ExternalName",
				externalName: "foreign.test",
			},
		} as V1Service);
		expect(
			await adapter.closeAgent(
				desired.agentId,
				desired.workloadRevision,
				desired.fence,
			),
		).toBe(false);
		expect(await f.client.read("Service", desired.service.name)).not.toBeNull();
	});
	it("does not publish a healthy candidate without caller validation", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		await expect(
			adapter.switchRoute({
				schemaVersion: 1,
				requestId: `${desired.requestId}-route`,
				traceId: desired.traceId,
				agentId: desired.agentId,
				fence: desired.fence,
				action: "promote",
				candidateValidated: false,
				candidateRoute: {
					routeRef: desired.route.name,
					workloadUid: identity.uid,
					workloadGeneration: identity.generation,
					workloadRevision: desired.workloadRevision,
				},
			}),
		).rejects.toThrow();
		expect(
			(await f.client.read<V1Service>("Service", desired.service.name))?.spec
				?.selector?.["agent-infra.agora.io/revision"],
		).toBe("closed");
		expect(await f.client.read("Ingress", desired.route.name)).toBeNull();
	});
	it.each(["hostPort", "hostIP", "protocol", "claims", "device", "quantity"])(
		"rejects container port/resource override %s in template and Pod",
		async (mutation) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = f.adapter();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const workload = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				desired.service.name,
			);
			const spec = workload?.spec?.template.spec;
			const pod = await f.client.read<V1Pod>(
				"Pod",
				`${desired.service.name}-0`,
			);
			if (!workload?.spec || !spec || !pod?.spec) throw new Error();
			const mutate = (container: V1PodSpec["containers"][number]) => ({
				...container,
				...(["hostPort", "hostIP", "protocol"].includes(mutation)
					? {
							ports: container.ports?.map((port) => ({
								...port,
								[mutation]:
									mutation === "hostPort"
										? 8080
										: mutation === "hostIP"
											? "0.0.0.0"
											: "UDP",
							})),
						}
					: {
							resources: {
								...container.resources,
								...(mutation === "claims"
									? { claims: [{ name: "foreign-device" }] }
									: {
											limits: {
												...container.resources?.limits,
												...(mutation === "device"
													? { "vendor.test/device": "1" }
													: { memory: "129Mi" }),
											},
										}),
							},
						}),
			});
			f.resources.set(`StatefulSet/${desired.service.name}`, {
				...workload,
				spec: {
					...workload.spec,
					template: {
						...workload.spec.template,
						spec: { ...spec, containers: spec.containers.map(mutate) },
					},
				},
			} as V1StatefulSet);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			f.resources.set(`StatefulSet/${desired.service.name}`, workload);
			f.resources.set(`Pod/${desired.service.name}-0`, {
				...pod,
				spec: { ...pod.spec, containers: pod.spec.containers.map(mutate) },
			} as V1Pod);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
		},
	);
	it("accepts default TCP ports and equivalent canonical resource quantities", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const pod = await f.client.read<V1Pod>("Pod", `${desired.service.name}-0`);
		if (!pod?.spec) throw new Error();
		f.resources.set(`Pod/${desired.service.name}-0`, {
			...pod,
			spec: {
				...pod.spec,
				containers: pod.spec.containers.map((container) => ({
					...container,
					ports: container.ports?.map((port) => ({ ...port, protocol: "TCP" })),
					resources: {
						requests: { cpu: "0.025", memory: "33554432" },
						limits: { cpu: "1e-1", memory: "0.125Gi" },
					},
				})),
			},
		} as V1Pod);
		expect(await adapter.observe(desired, identity)).toBe("healthy");
	});
	it("rejects an ordinary sidecar and keeps its candidate route closed", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const pod = await f.client.read<V1Pod>("Pod", `${desired.service.name}-0`);
		if (!pod) throw new Error();
		f.resources.set(`Pod/${desired.service.name}-0`, {
			...pod,
			spec: {
				...pod.spec,
				containers: [
					...(pod.spec?.containers ?? []),
					{
						name: "injected-sidecar",
						image: "registry.example.test/sidecar",
						securityContext: {
							runAsUser: 0,
							readOnlyRootFilesystem: false,
						},
					},
				],
			},
		} as V1Pod);
		expect(await adapter.observe(desired, identity)).toBe("drifted");

		const result = await adapter.switchRoute({
			schemaVersion: 1,
			requestId: `${desired.requestId}-route`,
			traceId: desired.traceId,
			agentId: desired.agentId,
			fence: desired.fence,
			action: "promote",
			candidateValidated: true,
			candidateRoute: {
				routeRef: desired.route.name,
				workloadUid: identity.uid,
				workloadGeneration: identity.generation,
				workloadRevision: desired.workloadRevision,
			},
		});
		expect(result).toMatchObject({ status: "failed", routedWorkloads: [] });
		expect(
			(await f.client.read<V1Service>("Service", desired.service.name))?.spec
				?.selector?.["agent-infra.agora.io/revision"],
		).toBe("closed");
		expect(await f.client.read("Ingress", desired.route.name)).toBeNull();
	});
	it("closes the exact target route before reporting a post-promotion failure", async () => {
		const f = fixture();
		const desired = { ...workloadDesiredFixture(), fence: 9 };
		let hidePromotedServiceOnce = true;
		const client: WorkerKubernetesClientV1 = {
			...f.client,
			async read<T extends KubernetesObject>(
				kind: WorkloadResourceKind,
				name: string,
			) {
				const current = await f.client.read<T>(kind, name);
				if (
					kind === "Service" &&
					name === desired.service.name &&
					hidePromotedServiceOnce &&
					(current as V1Service | null)?.spec?.selector?.[
						"agent-infra.agora.io/revision"
					] === String(desired.workloadRevision)
				) {
					hidePromotedServiceOnce = false;
					return null;
				}
				return current;
			},
		};
		const adapter = createKubernetesRuntimeAdapterV1({
			client,
			policy: workloadTestPolicy,
			probe: f.probe,
		});
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();

		const result = await adapter.switchRoute({
			schemaVersion: 1,
			requestId: `${desired.requestId}-route`,
			traceId: desired.traceId,
			agentId: desired.agentId,
			fence: desired.fence,
			action: "promote",
			candidateValidated: true,
			candidateRoute: {
				routeRef: desired.route.name,
				workloadUid: identity.uid,
				workloadGeneration: identity.generation,
				workloadRevision: desired.workloadRevision,
			},
		});
		expect(result).toMatchObject({ status: "failed", routedWorkloads: [] });
		const service = await f.client.read<V1Service>(
			"Service",
			desired.service.name,
		);
		expect(service?.spec?.selector?.["agent-infra.agora.io/revision"]).toBe(
			"closed",
		);
		expect(service?.metadata?.labels?.["agent-infra.agora.io/revision"]).toBe(
			String(desired.workloadRevision),
		);
		expect(await f.client.read("Ingress", desired.route.name)).toBeNull();
	});
	it.each([
		"service selector",
		"service fence",
		"ingress",
		"ingress owner",
	] as const)(
		"closes a route when post-promotion %s verification detects drift",
		async (mutation) => {
			const f = fixture();
			const desired = { ...workloadDesiredFixture(), fence: 9 };
			let mutateOnce = true;
			const client: WorkerKubernetesClientV1 = {
				...f.client,
				async read<T extends KubernetesObject>(
					kind: WorkloadResourceKind,
					name: string,
				) {
					const current = await f.client.read<T>(kind, name);
					if (!mutateOnce || !current) return current;
					if (
						(mutation === "service selector" || mutation === "service fence") &&
						kind === "Service" &&
						name === desired.service.name &&
						(current as V1Service).spec?.selector?.[
							"agent-infra.agora.io/revision"
						] === String(desired.workloadRevision)
					) {
						mutateOnce = false;
						const drifted = {
							...(current as V1Service),
							...(mutation === "service selector"
								? {
										spec: {
											...(current as V1Service).spec,
											selector: {
												"agent-infra.agora.io/revision": String(
													desired.workloadRevision,
												),
											},
										},
									}
								: {
										metadata: {
											...(current as V1Service).metadata,
											annotations: {
												...(current as V1Service).metadata?.annotations,
												"agent-infra.agora.io/fence": "10",
											},
										},
									}),
						} as V1Service;
						f.resources.set(`Service/${name}`, drifted);
						return drifted as T;
					}
					if (
						(mutation === "ingress" || mutation === "ingress owner") &&
						kind === "Ingress" &&
						name === desired.route.name
					) {
						mutateOnce = false;
						const drifted = {
							...(current as V1Ingress),
							...(mutation === "ingress"
								? { spec: { ...(current as V1Ingress).spec, rules: [] } }
								: {
										metadata: {
											...(current as V1Ingress).metadata,
											labels: {
												...(current as V1Ingress).metadata?.labels,
												"agent-infra.agora.io/agent": "foreign",
											},
										},
									}),
						} as V1Ingress;
						f.resources.set(`Ingress/${name}`, drifted);
						return drifted as T;
					}
					return current;
				},
			};
			const adapter = createKubernetesRuntimeAdapterV1({
				client,
				policy: workloadTestPolicy,
				probe: f.probe,
			});
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const request = {
				schemaVersion: 1,
				requestId: `${desired.requestId}-route`,
				traceId: desired.traceId,
				agentId: desired.agentId,
				fence: desired.fence,
				action: "promote" as const,
				candidateValidated: true,
				candidateRoute: {
					routeRef: desired.route.name,
					workloadUid: identity.uid,
					workloadGeneration: identity.generation,
					workloadRevision: desired.workloadRevision,
				},
			};
			if (mutation === "service fence" || mutation === "ingress owner") {
				await expect(adapter.switchRoute(request)).rejects.toThrow();
				if (mutation === "service fence")
					expect(
						(await f.client.read<V1Service>("Service", desired.service.name))
							?.metadata?.annotations?.["agent-infra.agora.io/fence"],
					).toBe("10");
				else
					expect(
						(await f.client.read<V1Ingress>("Ingress", desired.route.name))
							?.metadata?.labels?.["agent-infra.agora.io/agent"],
					).toBe("foreign");
				return;
			}

			const result = await adapter.switchRoute(request);
			expect(result).toMatchObject({ status: "failed", routedWorkloads: [] });
			expect(
				(await f.client.read<V1Service>("Service", desired.service.name))?.spec
					?.selector,
			).toEqual({
				"agent-infra.agora.io/agent": desired.service.name,
				"agent-infra.agora.io/revision": "closed",
			});
			expect(await f.client.read("Ingress", desired.route.name)).toBeNull();
		},
	);
	it("does not overwrite a newer route while closing a failed stale target", async () => {
		const f = fixture();
		const desired = { ...workloadDesiredFixture(), fence: 9 };
		let replacePromotedServiceWithNewerRevision = true;
		const client: WorkerKubernetesClientV1 = {
			...f.client,
			async read<T extends KubernetesObject>(
				kind: WorkloadResourceKind,
				name: string,
			) {
				const current = await f.client.read<T>(kind, name);
				if (
					kind === "Service" &&
					name === desired.service.name &&
					replacePromotedServiceWithNewerRevision &&
					(current as V1Service | null)?.spec?.selector?.[
						"agent-infra.agora.io/revision"
					] === String(desired.workloadRevision)
				) {
					replacePromotedServiceWithNewerRevision = false;
					f.resources.set(`Service/${name}`, {
						...(current as V1Service),
						metadata: {
							...(current as V1Service).metadata,
							labels: {
								...(current as V1Service).metadata?.labels,
								"agent-infra.agora.io/revision": "2",
							},
						},
					});
					return null;
				}
				return current;
			},
		};
		const adapter = createKubernetesRuntimeAdapterV1({
			client,
			policy: workloadTestPolicy,
			probe: f.probe,
		});
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();

		await expect(
			adapter.switchRoute({
				schemaVersion: 1,
				requestId: `${desired.requestId}-route`,
				traceId: desired.traceId,
				agentId: desired.agentId,
				fence: desired.fence,
				action: "promote",
				candidateValidated: true,
				candidateRoute: {
					routeRef: desired.route.name,
					workloadUid: identity.uid,
					workloadGeneration: identity.generation,
					workloadRevision: desired.workloadRevision,
				},
			}),
		).rejects.toThrow();
		const service = await f.client.read<V1Service>(
			"Service",
			desired.service.name,
		);
		expect(service?.metadata?.labels?.["agent-infra.agora.io/revision"]).toBe(
			"2",
		);
		expect(service?.spec?.selector?.["agent-infra.agora.io/revision"]).toBe(
			String(desired.workloadRevision),
		);
	});
	it("propagates route-closure failure for retry instead of claiming no exposure", async () => {
		const f = fixture();
		const desired = { ...workloadDesiredFixture(), fence: 9 };
		let hidePromotedServiceOnce = true;
		let failRouteClosure = false;
		const client: WorkerKubernetesClientV1 = {
			...f.client,
			async read<T extends KubernetesObject>(
				kind: WorkloadResourceKind,
				name: string,
			) {
				const current = await f.client.read<T>(kind, name);
				if (
					kind === "Service" &&
					name === desired.service.name &&
					hidePromotedServiceOnce &&
					(current as V1Service | null)?.spec?.selector?.[
						"agent-infra.agora.io/revision"
					] === String(desired.workloadRevision)
				) {
					hidePromotedServiceOnce = false;
					failRouteClosure = true;
					return null;
				}
				return current;
			},
			async delete(object) {
				if (failRouteClosure && object.kind === "Ingress")
					throw new Error("route closure unavailable");
				return f.client.delete(object);
			},
		};
		const adapter = createKubernetesRuntimeAdapterV1({
			client,
			policy: workloadTestPolicy,
			probe: f.probe,
		});
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const request = {
			schemaVersion: 1 as const,
			requestId: `${desired.requestId}-route`,
			traceId: desired.traceId,
			agentId: desired.agentId,
			fence: desired.fence,
			action: "promote" as const,
			candidateValidated: true,
			candidateRoute: {
				routeRef: desired.route.name,
				workloadUid: identity.uid,
				workloadGeneration: identity.generation,
				workloadRevision: desired.workloadRevision,
			},
		};

		await expect(adapter.switchRoute(request)).rejects.toThrow(
			"route closure unavailable",
		);
		expect(
			(await f.client.read<V1Service>("Service", desired.service.name))?.spec
				?.selector?.["agent-infra.agora.io/revision"],
		).toBe("closed");
		expect(await f.client.read("Ingress", desired.route.name)).not.toBeNull();

		const retry = await adapter.switchRoute(request);
		expect(retry).toMatchObject({ status: "completed" });
		expect(
			(await f.client.read<V1Service>("Service", desired.service.name))?.spec
				?.selector?.["agent-infra.agora.io/revision"],
		).toBe(String(desired.workloadRevision));
	});
	it("creates immutable Agent/version Secret refs and refuses terminating or changed Secret reuse", async () => {
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
		const adapter = f.adapter();
		const createdUid = await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			new Uint8Array([1, 2, 3]),
		);
		const existing = await f.client.read<V1Secret>("Secret", ref.name);
		expect(existing?.immutable).toBe(true);
		expect(createdUid).toBe(existing?.metadata?.uid);
		if (!existing) throw new Error();
		f.resources.set(`Secret/${ref.name}`, {
			...existing,
			metadata: {
				...existing.metadata,
				deletionTimestamp: new Date("2026-09-09T00:00:00Z"),
			},
		} as V1Secret);
		await expect(
			adapter.applyImmutableSecret(
				desired,
				ref.name,
				"API_KEY",
				new Uint8Array([1, 2, 3]),
			),
		).rejects.toMatchObject({ code: "conflict" });
		f.resources.set(`Secret/${ref.name}`, existing);
		expect(
			await adapter.applyImmutableSecret(
				desired,
				ref.name,
				"API_KEY",
				new Uint8Array([1, 2, 3]),
			),
		).toBe(createdUid);
		await expect(
			adapter.applyImmutableSecret(
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
	it("removes a materialized Secret only with its current Workload fence", async () => {
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
		const adapter = f.adapter();
		const secretUid = await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			new Uint8Array([1, 2, 3]),
		);
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		await adapter.bindSecretFence(desired, identity, ref.name, 7, secretUid);
		const activationFence = {
			schemaVersion: 1 as const,
			agentId: ref.agentId,
			secretId: ref.secretId,
			secretVersion: ref.secretVersion,
			configRevision: ref.configRevision,
			kubernetesSecretName: ref.name,
			workloadUid: identity.uid,
			workloadGeneration: identity.generation,
			fence: 7,
		};
		expect(
			await adapter.removeImmutableSecret(desired, ref, {
				...activationFence,
				fence: 8,
			}),
		).toBe(false);
		expect(await f.client.read<V1Secret>("Secret", ref.name)).not.toBeNull();
		const workload = await f.client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		if (!workload) throw new Error();
		f.resources.delete(`StatefulSet/${desired.service.name}`);
		expect(
			await adapter.removeImmutableSecret(desired, ref, activationFence),
		).toBe(false);
		expect(await f.client.read<V1Secret>("Secret", ref.name)).not.toBeNull();
		f.resources.set(`StatefulSet/${desired.service.name}`, {
			...workload,
			metadata: {
				...workload.metadata,
				generation: identity.generation + 1,
			},
		} as V1StatefulSet);
		expect(
			await adapter.removeImmutableSecret(desired, ref, activationFence),
		).toBe(true);
		expect(await f.client.read<V1Secret>("Secret", ref.name)).toBeNull();
	});
	it("fences identical immutable Secret reuse without changing its body", async () => {
		const f = fixture();
		const desired = { ...workloadDesiredFixture(), fence: 9 };
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
		const adapter = f.adapter();
		const plaintext = new Uint8Array([1, 2, 3]);
		await adapter.applyImmutableSecret(desired, ref.name, "API_KEY", plaintext);
		const existing = await f.client.read<V1Secret>("Secret", ref.name);
		if (!existing) throw new Error();

		const current = { ...desired, requestId: "request-current", fence: 11 };
		await adapter.applyImmutableSecret(current, ref.name, "API_KEY", plaintext);
		const reused = await f.client.read<V1Secret>("Secret", ref.name);
		expect(reused?.metadata?.annotations?.["agent-infra.agora.io/fence"]).toBe(
			"11",
		);
		expect(reused?.metadata?.uid).toBe(existing.metadata?.uid);
		expect(reused?.metadata?.resourceVersion).not.toBe(
			existing.metadata?.resourceVersion,
		);
		expect(reused?.immutable).toBe(existing.immutable);
		expect(reused?.type).toBe(existing.type);
		expect(reused?.data).toStrictEqual(existing.data);

		await expect(
			adapter.removeImmutableSecret(desired, ref),
		).rejects.toMatchObject({
			code: "conflict",
		});
		expect(await f.client.read<V1Secret>("Secret", ref.name)).not.toBeNull();
	});
	it("advances the Workload fence when the bound Secret fence is unchanged", async () => {
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
		const adapter = f.adapter();
		const secretUid = await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			new Uint8Array([1, 2, 3]),
		);
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		await adapter.bindSecretFence(desired, identity, ref.name, 7, secretUid);

		const current = { ...desired, requestId: "request-current", fence: 11 };
		await adapter.bindSecretFence(current, identity, ref.name, 7, secretUid);
		const bound = await f.client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		const uidKey = Object.keys(bound?.metadata?.annotations ?? {}).find((key) =>
			key.startsWith("agent-infra.agora.io/secret-uid-"),
		);
		if (!bound || !uidKey) throw new Error();
		const legacyAnnotations = { ...bound.metadata?.annotations };
		delete legacyAnnotations[uidKey];
		f.resources.set(`StatefulSet/${desired.service.name}`, {
			...bound,
			metadata: { ...bound.metadata, annotations: legacyAnnotations },
		} as V1StatefulSet);
		await adapter.bindSecretFence(current, identity, ref.name, 7, secretUid);
		const repaired = await f.client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		expect(repaired?.metadata?.annotations?.[uidKey]).toBe(secretUid);
		if (!repaired) throw new Error();
		f.resources.set(`StatefulSet/${desired.service.name}`, {
			...repaired,
			metadata: {
				...repaired.metadata,
				annotations: {
					...repaired.metadata?.annotations,
					[uidKey]: "foreign-secret-uid",
				},
			},
		} as V1StatefulSet);
		await expect(
			adapter.bindSecretFence(current, identity, ref.name, 7, secretUid),
		).rejects.toMatchObject({ code: "conflict" });
		f.resources.set(`StatefulSet/${desired.service.name}`, repaired);
		expect(
			(await f.client.read<V1StatefulSet>("StatefulSet", desired.service.name))
				?.metadata?.annotations?.["agent-infra.agora.io/fence"],
		).toBe("11");
		await expect(
			adapter.apply({ ...desired, requestId: "request-stale", fence: 9 }),
		).rejects.toMatchObject({ code: "conflict" });
		await adapter.bindSecretFence(current, identity, ref.name, 8, secretUid);
		await expect(
			adapter.bindSecretFence(current, identity, ref.name, 7, secretUid),
		).rejects.toMatchObject({ code: "conflict" });
		expect(
			Object.values(
				(
					await f.client.read<V1StatefulSet>(
						"StatefulSet",
						desired.service.name,
					)
				)?.metadata?.annotations ?? {},
			),
		).toContain("8");
	});
	it("rejects a Secret replacement that races the StatefulSet UID binding", async () => {
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
		let swapBeforeStatefulSetReplace = false;
		const client: WorkerKubernetesClientV1 = {
			...f.client,
			async replace<T extends KubernetesObject>(object: T): Promise<T> {
				if (swapBeforeStatefulSetReplace && object.kind === "StatefulSet") {
					swapBeforeStatefulSetReplace = false;
					const secret = await f.client.read<V1Secret>("Secret", ref.name);
					if (!secret) throw new Error();
					f.resources.set(`Secret/${ref.name}`, {
						...secret,
						metadata: { ...secret.metadata, uid: "replacement-secret-uid" },
						data: { API_KEY: Buffer.from([9]).toString("base64") },
					} as V1Secret);
				}
				return f.client.replace(object);
			},
		};
		const adapter = createKubernetesRuntimeAdapterV1({
			client,
			policy: workloadTestPolicy,
			probe: async () => true,
		});
		const secretUid = await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			new Uint8Array([1, 2, 3]),
		);
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		swapBeforeStatefulSetReplace = true;
		await adapter.bindSecretFence(desired, identity, ref.name, 7, secretUid);
		expect(
			await adapter.observeSecretFence(desired, identity, ref.name, 7),
		).toBe(false);
		expect(await adapter.observe(desired, identity)).toBe("drifted");
	});
	it("preserves an active Secret fence across rollout but rejects a terminating Secret", async () => {
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
		const adapter = f.adapter();
		const secretUid = await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			new Uint8Array([1, 2, 3]),
		);
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		await adapter.bindSecretFence(desired, identity, ref.name, 7, secretUid);
		const activationFence = {
			schemaVersion: 1 as const,
			agentId: ref.agentId,
			secretId: ref.secretId,
			secretVersion: ref.secretVersion,
			configRevision: ref.configRevision,
			kubernetesSecretName: ref.name,
			workloadUid: identity.uid,
			workloadGeneration: identity.generation,
			fence: 7,
		};
		const upgraded = workloadDesiredFixture(2);
		upgraded.secretRefs = [ref];
		upgraded.expectedWorkload = {
			state: "present",
			workloadUid: identity.uid,
			workloadGeneration: identity.generation,
		};
		let upgradedIdentity = await adapter.apply(upgraded);
		for (
			let attempt = 0;
			upgradedIdentity === "pending" && attempt < 3;
			attempt++
		)
			upgradedIdentity = await adapter.apply(upgraded);
		expect(upgradedIdentity).toMatchObject({
			uid: identity.uid,
			generation: expect.any(Number),
		});
		if (!upgradedIdentity || upgradedIdentity === "pending") throw new Error();
		const boundWorkload = await f.client.read<V1StatefulSet>(
			"StatefulSet",
			upgraded.service.name,
		);
		if (!boundWorkload) throw new Error();
		const uidKey = Object.keys(boundWorkload.metadata?.annotations ?? {}).find(
			(key) => key.startsWith("agent-infra.agora.io/secret-uid-"),
		);
		expect(uidKey).toBeDefined();
		if (!uidKey) throw new Error();
		expect(boundWorkload.metadata?.annotations?.[uidKey]).toBe(secretUid);
		expect(await adapter.observe(upgraded, upgradedIdentity)).toBe("healthy");
		const annotationsWithoutUid = {
			...boundWorkload.metadata?.annotations,
		};
		delete annotationsWithoutUid[uidKey];
		f.resources.set(`StatefulSet/${upgraded.service.name}`, {
			...boundWorkload,
			metadata: {
				...boundWorkload.metadata,
				annotations: annotationsWithoutUid,
			},
		} as V1StatefulSet);
		expect(await adapter.observe(upgraded, upgradedIdentity)).toBe("drifted");
		expect(
			await adapter.observeActiveImmutableSecret(
				upgraded,
				ref,
				activationFence,
			),
		).toBe(false);
		f.resources.set(`StatefulSet/${upgraded.service.name}`, boundWorkload);
		expect(
			await adapter.observeActiveImmutableSecret(
				upgraded,
				ref,
				activationFence,
			),
		).toBe(true);
		const secret = await f.client.read<V1Secret>("Secret", ref.name);
		if (!secret) throw new Error();
		f.resources.set(`Secret/${ref.name}`, {
			...secret,
			metadata: { ...secret.metadata, uid: "replacement-secret-uid" },
			data: { API_KEY: Buffer.from([9]).toString("base64") },
		} as V1Secret);
		expect(await adapter.observe(upgraded, upgradedIdentity)).toBe("drifted");
		expect(
			await adapter.observeActiveImmutableSecret(
				upgraded,
				ref,
				activationFence,
			),
		).toBe(false);
		expect(
			await adapter.removeImmutableSecret(upgraded, ref, activationFence),
		).toBe(false);
		f.resources.set(`Secret/${ref.name}`, secret);
		f.resources.set(`Secret/${ref.name}`, {
			...secret,
			metadata: {
				...secret.metadata,
				deletionTimestamp: new Date("2026-09-09T00:00:00Z"),
			},
		} as V1Secret);
		expect(
			await adapter.observeActiveImmutableSecret(
				upgraded,
				ref,
				activationFence,
			),
		).toBe(false);
	});
	it("detects missing, terminating, foreign, or mutable Secret refs before reporting healthy", async () => {
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
		const adapter = f.adapter();
		await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			new Uint8Array([1, 2, 3]),
		);
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		const liveSecret = await f.client.read<V1Secret>("Secret", ref.name);
		if (!liveSecret) throw new Error();
		f.resources.set(`Secret/${ref.name}`, {
			...liveSecret,
			metadata: {
				...liveSecret.metadata,
				deletionTimestamp: new Date("2026-09-09T00:00:00Z"),
			},
		} as V1Secret);
		expect(await adapter.observe(desired, identity)).toBe("drifted");
		f.resources.set(`Secret/${ref.name}`, liveSecret);

		f.resources.delete(`Secret/${ref.name}`);
		expect(await adapter.observe(desired, identity)).toBe("drifted");
		await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			new Uint8Array([1, 2, 3]),
		);
		expect(await adapter.observe(desired, identity)).toBe("healthy");

		const secret = await f.client.read<V1Secret>("Secret", ref.name);
		if (!secret) throw new Error();
		f.resources.set(`Secret/${ref.name}`, {
			...secret,
			immutable: false,
		} as V1Secret);
		expect(await adapter.observe(desired, identity)).toBe("drifted");
		f.resources.set(`Secret/${ref.name}`, {
			...secret,
			metadata: {
				...secret.metadata,
				annotations: {
					...secret.metadata?.annotations,
					"agent-infra.agora.io/agent-id": "agent-b",
				},
			},
		} as V1Secret);
		expect(await adapter.observe(desired, identity)).toBe("drifted");
	});
});
