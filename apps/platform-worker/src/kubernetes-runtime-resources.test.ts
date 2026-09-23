import type {
	KubernetesObject,
	V1Ingress,
	V1NetworkPolicy,
	V1Pod,
	V1PodSpec,
	V1Service,
	V1StatefulSet,
} from "@kubernetes/client-node";
import { ObjectSerializer } from "@kubernetes/client-node/dist/gen/models/ObjectSerializer.js";
import { describe, expect, it } from "vitest";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import type {
	WorkerKubernetesClientV1,
	WorkloadResourceKind,
} from "./kubernetes-client.js";
import { fixture } from "./kubernetes-runtime-adapter.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";

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
	it("provides bounded writable runtime scratch while keeping the root filesystem read-only", async () => {
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
		expect(spec?.volumes).toEqual([
			{
				name: "data",
				persistentVolumeClaim: { claimName: desired.persistentVolume.name },
			},
			{
				name: "runtime-tmp",
				emptyDir: { medium: "Memory", sizeLimit: "128Mi" },
			},
		]);
		expect(spec?.containers[0]?.volumeMounts).toEqual([
			{ name: "data", mountPath: desired.persistentVolume.mountPath },
			{ name: "runtime-tmp", mountPath: "/tmp" },
		]);
		expect(spec?.containers[0]?.securityContext).toMatchObject({
			readOnlyRootFilesystem: true,
			allowPrivilegeEscalation: false,
			capabilities: { drop: ["ALL"] },
			runAsUser: 1000,
		});
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		await adapter.promote(desired, identity);
		expect(
			(await f.client.read<V1Service>("Service", desired.service.name))?.spec
				?.selector?.["agent-infra.agora.io/revision"],
		).toBe("1");
	});
	it.each(["128Mi", "134217728", "131072Ki", "0.125Gi"])(
		"accepts runtime scratch defaults and the equivalent capacity %s without adding a PVC source",
		async (sizeLimit) => {
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
			if (!workload?.spec?.template.spec || !pod?.spec) throw new Error();
			for (const spec of [workload.spec.template.spec, pod.spec]) {
				for (const container of spec.containers)
					container.volumeMounts = container.volumeMounts?.map((mount) => ({
						...mount,
						readOnly: false,
						subPath: "",
						subPathExpr: "",
						mountPropagation: "None",
					}));
				spec.volumes = spec.volumes?.map((volume) =>
					volume.name === "runtime-tmp"
						? { ...volume, emptyDir: { medium: "Memory", sizeLimit } }
						: {
								...volume,
								persistentVolumeClaim: {
									...volume.persistentVolumeClaim,
									claimName: desired.persistentVolume.name,
									readOnly: false,
								},
							},
				);
			}
			f.resources.set(`StatefulSet/${desired.service.name}`, workload);
			f.resources.set(`Pod/${desired.service.name}-0`, pod);
			expect(await adapter.observe(desired, identity)).toBe("healthy");
			await adapter.promote(desired, identity);
			expect(
				(
					await f.client.read<V1Pod>("Pod", `${desired.service.name}-0`)
				)?.spec?.volumes?.find((volume) => volume.name === "runtime-tmp"),
			).toEqual({
				name: "runtime-tmp",
				emptyDir: { medium: "Memory", sizeLimit },
			});
		},
	);
	it.each([
		"missing volume",
		"renamed volume",
		"missing mount",
		"wrong mount path",
		"read-only mount",
		"subPath",
		"subPathExpr",
		"mount propagation",
		"extra mount",
		"unknown mount field",
		"hostPath source",
		"additional PVC source",
		"extra volume",
		"unknown volume field",
		"missing emptyDir",
		"wrong medium",
		"missing limit",
		"larger limit",
		"smaller limit",
		"fractional excess",
		"invalid limit",
		"unknown emptyDir field",
	])(
		"repairs controller runtime scratch drift and refuses live Pod routing for %s",
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
			if (!workload?.spec?.template.spec) throw new Error();
			const change = (source: V1PodSpec): V1PodSpec => {
				const spec = structuredClone(source);
				const volume = spec.volumes?.find(
					(item) => item.name === "runtime-tmp",
				);
				const container = spec.containers.find((item) => item.name === "agent");
				const mount = container?.volumeMounts?.find(
					(item) => item.name === "runtime-tmp",
				);
				if (!volume?.emptyDir || !container || !mount) throw new Error();
				switch (mutation) {
					case "missing volume":
						spec.volumes = spec.volumes?.filter((item) => item !== volume);
						break;
					case "renamed volume":
						volume.name = "foreign";
						break;
					case "missing mount":
						container.volumeMounts = container.volumeMounts?.filter(
							(item) => item !== mount,
						);
						break;
					case "wrong mount path":
						mount.mountPath = "/workspace";
						break;
					case "read-only mount":
						mount.readOnly = true;
						break;
					case "subPath":
						mount.subPath = "foreign";
						break;
					case "subPathExpr":
						mount.subPathExpr = "$(FOREIGN)";
						break;
					case "mount propagation":
						mount.mountPropagation = "Bidirectional";
						break;
					case "extra mount":
						container.volumeMounts?.push({ ...mount, mountPath: "/extra" });
						break;
					case "unknown mount field":
						Object.assign(mount, { unexpected: true });
						break;
					case "hostPath source":
						delete volume.emptyDir;
						volume.hostPath = { path: "/host" };
						break;
					case "additional PVC source":
						volume.persistentVolumeClaim = {
							claimName: desired.persistentVolume.name,
						};
						break;
					case "extra volume":
						spec.volumes?.push({ name: "extra", emptyDir: {} });
						break;
					case "unknown volume field":
						Object.assign(volume, { unexpected: true });
						break;
					case "missing emptyDir":
						delete volume.emptyDir;
						break;
					case "wrong medium":
						volume.emptyDir.medium = "";
						break;
					case "missing limit":
						delete volume.emptyDir.sizeLimit;
						break;
					case "larger limit":
						volume.emptyDir.sizeLimit = "256Mi";
						break;
					case "smaller limit":
						volume.emptyDir.sizeLimit = "64Mi";
						break;
					case "fractional excess":
						volume.emptyDir.sizeLimit = "134217728.000000001";
						break;
					case "invalid limit":
						volume.emptyDir.sizeLimit = "128MiB";
						break;
					case "unknown emptyDir field":
						Object.assign(volume.emptyDir, { unexpected: true });
						break;
				}
				return spec;
			};
			const changedWorkload: V1StatefulSet = {
				...workload,
				spec: {
					...workload.spec,
					template: {
						...workload.spec.template,
						spec: change(workload.spec.template.spec),
					},
				},
			};
			f.resources.set(`StatefulSet/${desired.service.name}`, changedWorkload);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			const repaired = await adapter.apply(desired);
			if (!repaired || repaired === "pending") throw new Error();
			expect(await adapter.observe(desired, repaired)).toBe("healthy");
			const pod = await f.client.read<V1Pod>(
				"Pod",
				`${desired.service.name}-0`,
			);
			if (!pod?.spec) throw new Error();
			const changedPod: V1Pod = { ...pod, spec: change(pod.spec) };
			f.resources.set(`Pod/${desired.service.name}-0`, changedPod);
			expect(await adapter.observe(desired, repaired)).toBe("drifted");
			const result = await adapter.switchRoute({
				schemaVersion: 1,
				requestId: `${desired.requestId}-scratch-route`,
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
			expect(result).toMatchObject({ status: "failed", routedWorkloads: [] });
			expect(
				(await f.client.read<V1Service>("Service", desired.service.name))?.spec
					?.selector?.["agent-infra.agora.io/revision"],
			).toBe("closed");
			expect(await f.client.read("Ingress", desired.route.name)).toBeNull();
		},
	);
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
	it("accepts omitted empty NetworkPolicy egress without accepting widened access", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const network = await f.client.read<V1NetworkPolicy>(
			"NetworkPolicy",
			desired.service.name,
		);
		if (!network?.spec) throw new Error();
		expect(network.spec.egress).toEqual([]);
		// The API server omits an empty egress slice when encoding the policy.
		delete network.spec.egress;
		f.resources.set(`NetworkPolicy/${desired.service.name}`, network);
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("healthy");
		expect(f.probe).toHaveBeenCalledTimes(1);

		network.spec.egress = [{}];
		f.resources.set(`NetworkPolicy/${desired.service.name}`, network);
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("drifted");
		delete network.spec.egress;
		network.spec.policyTypes = ["Ingress"];
		f.resources.set(`NetworkPolicy/${desired.service.name}`, network);
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("drifted");
		expect(f.probe).toHaveBeenCalledTimes(1);
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
});
