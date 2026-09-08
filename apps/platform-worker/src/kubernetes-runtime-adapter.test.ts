import type {
	KubernetesObject,
	V1Ingress,
	V1NetworkPolicy,
	V1PersistentVolumeClaim,
	V1Pod,
	V1Secret,
	V1SecurityContext,
	V1Service,
	V1StatefulSet,
} from "@kubernetes/client-node";
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
	it("repairs widened NetworkPolicy ports before a candidate can route", async () => {
		for (const direction of ["ingress", "egress"] as const) {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = createKubernetesRuntimeAdapterV1({
				client: f.client,
				policy:
					direction === "egress"
						? {
								...workloadTestPolicy,
								egressProxy: {
									namespace: "egress-proxy",
									selector: { component: "proxy" },
									port: 8443,
								},
							}
						: workloadTestPolicy,
				probe: f.probe,
			});
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const network = await f.client.read<V1NetworkPolicy>(
				"NetworkPolicy",
				desired.service.name,
			);
			const ports = network?.spec?.[direction]?.[0]?.ports;
			if (!network || !ports?.[0]) throw new Error();
			f.resources.set(`NetworkPolicy/${desired.service.name}`, {
				...network,
				spec: {
					...network.spec,
					[direction]: network.spec?.[direction]?.map((rule, index) =>
						index === 0
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

			expect(await adapter.observe(desired, identity), direction).toBe(
				"drifted",
			);
			const result = await adapter.switchRoute({
				schemaVersion: 1,
				requestId: `${desired.requestId}-${direction}-route`,
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
			expect(result, direction).toMatchObject({
				status: "failed",
				routedWorkloads: [],
			});
			expect(
				(await f.client.read<V1Service>("Service", desired.service.name))?.spec
					?.selector?.["agent-infra.agora.io/revision"],
				direction,
			).toBe("closed");
			expect(
				await f.client.read("Ingress", desired.route.name),
				direction,
			).toBeNull();

			await adapter.apply(desired);
			const repaired = await f.client.read<V1NetworkPolicy>(
				"NetworkPolicy",
				desired.service.name,
			);
			expect(
				repaired?.spec?.[direction]?.[0]?.ports?.[0]?.endPort,
				direction,
			).toBeUndefined();
			expect(await adapter.observe(desired, identity), direction).toBe(
				"healthy",
			);
			const port = repaired?.spec?.[direction]?.[0]?.ports?.[0]?.port;
			if (!repaired || typeof port !== "number") throw new Error();
			f.resources.set(`NetworkPolicy/${desired.service.name}`, {
				...repaired,
				spec: {
					...repaired.spec,
					[direction]: repaired.spec?.[direction]?.map((rule, index) =>
						index === 0
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
			expect(await adapter.observe(desired, identity), direction).toBe(
				"healthy",
			);
			await adapter.apply(desired);
			expect(
				(
					await f.client.read<V1NetworkPolicy>(
						"NetworkPolicy",
						desired.service.name,
					)
				)?.spec?.[direction]?.[0]?.ports?.[0]?.endPort,
				direction,
			).toBe(port);
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
		if (!pvc) throw new Error();
		await adapter.closeAgent(a.agentId, 2);
		expect(await adapter.scaleDownAgent(a.agentId, 2)).toBe("pending");
		expect(await adapter.scaleDownAgent(a.agentId, 2)).toMatchObject({
			uid: identityA.uid,
		});
		const b = workloadDesiredFixture(3);
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
		).toBe("3");
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
		).toBe(pvc.metadata?.uid);
		expect(
			(await f.client.read<V1StatefulSet>("StatefulSet", a.service.name))?.spec
				?.template.spec?.containers[0]?.image,
		).toContain(a.imageDigest);
	});
	it("fences a lost PVC cleanup delete after a later revision reuses it", async () => {
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

		f.loseNextDelete("PersistentVolumeClaim", a.persistentVolume.name);
		await expect(
			adapter.cleanupAgent(a.agentId, a.workloadRevision, true),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(f.deferredDelete()).toMatchObject({
			kind: "PersistentVolumeClaim",
			metadata: {
				uid: pvc.metadata?.uid,
				resourceVersion: pvc.metadata?.resourceVersion,
			},
		});
		expect(await f.client.read("StatefulSet", a.service.name)).toBeNull();

		const b = workloadDesiredFixture(3);
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
						initContainers: [
							{ name: "injected-init", image: "registry.example.test/init" },
						],
					},
				},
			},
		} as V1StatefulSet);
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
		const pod = await f.client.read<V1Pod>("Pod", `${desired.service.name}-0`);
		if (!pod) throw new Error();
		for (const unsafeSpec of [
			{ hostIPC: true },
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
		]) {
			f.resources.set(`Pod/${desired.service.name}-0`, {
				...pod,
				spec: { ...pod.spec, ...unsafeSpec },
			} as V1Pod);
			expect(await adapter.observe(desired, repaired)).toBe("drifted");
		}
	});
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
			expect(recreated?.spec, label).toStrictEqual(
				workload?.spec?.template.spec,
			);
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
		const writes = f.writes.length;

		expect(await adapter.apply(desired)).toMatchObject({ uid: identity.uid });
		expect(
			(await f.client.read<V1StatefulSet>("StatefulSet", desired.service.name))
				?.spec?.replicas,
		).toBe(1);
		expect(f.writes).toHaveLength(writes);
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
		await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			new Uint8Array([1, 2, 3]),
		);
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		await adapter.bindSecretFence(desired, identity, ref.name, 7);
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
		expect(
			await adapter.removeImmutableSecret(desired, ref, activationFence),
		).toBe(true);
		expect(await f.client.read<V1Secret>("Secret", ref.name)).toBeNull();
	});
	it("detects missing, foreign, or mutable Secret references before reporting healthy", async () => {
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
