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
	V1ServiceAccount,
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
	it.each(["Service", "ProbeService"] as const)(
		"removes %s with unmanaged routing metadata before reporting closure",
		async (resourceKind) => {
			for (const field of ["labels", "annotations"] as const) {
				const f = fixture();
				const adapter = f.adapter();
				const desired = workloadDesiredFixture();
				const identity = await adapter.apply(desired);
				if (!identity || identity === "pending") throw new Error();
				await adapter.promote(desired, identity);
				const name =
					resourceKind === "Service"
						? desired.service.name
						: `${desired.service.name}-probe`;
				const service = await f.client.read<V1Service>("Service", name);
				if (!service?.metadata) throw new Error();
				service.metadata[field] = {
					...service.metadata[field],
					"external.example.test/route": "injected",
				};
				f.resources.set(`Service/${name}`, service);
				expect(
					await adapter.closeAgent(
						desired.agentId,
						desired.workloadRevision,
						desired.fence,
					),
				).toBe(true);
				expect(await f.client.read("Service", name)).toBeNull();
				expect(await f.client.read("Ingress", desired.route.name)).toBeNull();
			}
		},
	);
	it.each(["probe", "main"])(
		"continues closing routes while unsafe %s Service deletion is pending",
		async (target) => {
			const f = fixture();
			const adapter = f.adapter();
			const desired = workloadDesiredFixture();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			await adapter.promote(desired, identity);
			const name =
				target === "probe"
					? `${desired.service.name}-probe`
					: desired.service.name;
			const service = await f.client.read<V1Service>("Service", name);
			if (!service?.metadata?.annotations) throw new Error();
			service.metadata.annotations["external.example.test/route"] = "injected";
			service.metadata.finalizers = ["external.example.test/retained"];
			f.resources.set(`Service/${name}`, service);
			const remove = f.client.delete.bind(f.client);
			vi.spyOn(f.client, "delete").mockImplementation(async (resource) => {
				if (resource.kind === "Service" && resource.metadata?.name === name) {
					f.resources.set(`Service/${name}`, {
						...resource,
						metadata: { ...resource.metadata, deletionTimestamp: new Date() },
					});
					return;
				}
				await remove(resource);
			});
			expect(await adapter.closeRoute(desired)).toBe(false);
			expect(await f.client.read("Service", name)).not.toBeNull();
			expect(await f.client.read("Ingress", desired.route.name)).toBeNull();
			if (target === "probe")
				expect(
					(await f.client.read<V1Service>("Service", desired.service.name))
						?.spec?.selector?.["agent-infra.agora.io/revision"],
				).toBe("closed");
			f.resources.delete(`Service/${name}`);
			expect(await adapter.closeRoute(desired)).toBe(true);
		},
	);
	it.each([
		"apiVersion",
		"kind",
		"name",
		"uid",
		"controller",
		"extra-reference",
	])(
		"rejects a Pod without the exact controlling StatefulSet reference: %s",
		async (field) => {
			const f = fixture();
			const adapter = f.adapter();
			const desired = workloadDesiredFixture();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const key = `Pod/${desired.service.name}-0`;
			const pod = structuredClone(f.resources.get(key)) as V1Pod;
			const owner = pod.metadata?.ownerReferences?.[0];
			if (!owner) throw new Error();
			if (field === "extra-reference") {
				owner.uid = "foreign-owner";
				pod.metadata?.ownerReferences?.push({
					...owner,
					uid: identity.uid,
					controller: false,
				});
			} else
				Object.assign(owner, {
					[field]: field === "controller" ? false : "foreign",
				});
			f.resources.set(key, pod);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			await expect(adapter.promote(desired, identity)).rejects.toThrow();
			expect(f.resources.get(key)).toEqual(pod);
			expect(
				(await f.client.read<V1Service>("Service", desired.service.name))?.spec
					?.selector?.["agent-infra.agora.io/revision"],
			).toBe("closed");
		},
	);
	it.each(["labels", "annotations", "revision", "fence"])(
		"rechecks route closure metadata after a concurrent %s change",
		async (field) => {
			const f = fixture();
			const adapter = f.adapter();
			const desired = {
				...workloadDesiredFixture(),
				workloadRevision: 2,
				fence: 2,
			};
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			await adapter.promote(desired, identity);
			const replace = f.client.replace.bind(f.client);
			vi.spyOn(f.client, "replace").mockImplementation(async (resource) => {
				const updated = await replace(resource);
				if (
					resource.kind === "Service" &&
					resource.metadata?.name === desired.service.name
				) {
					const raced = structuredClone(updated);
					if (!raced.metadata?.labels || !raced.metadata.annotations)
						throw new Error();
					if (field === "labels" || field === "annotations")
						(field === "labels"
							? raced.metadata.labels
							: raced.metadata.annotations)["external.example.test/route"] =
							"injected";
					if (field === "revision")
						raced.metadata.labels["agent-infra.agora.io/revision"] = "1";
					if (field === "fence")
						raced.metadata.annotations["agent-infra.agora.io/fence"] = "1";
					f.resources.set(`Service/${desired.service.name}`, raced);
				}
				return updated;
			});
			expect(await adapter.closeRoute(desired)).toBe(false);
			expect(await f.client.read("Ingress", desired.route.name)).toBeNull();
		},
	);
	it.each([
		"PersistentVolumeClaim",
		"Service",
		"ProbeService",
		"ServiceAccount",
		"NetworkPolicy",
		"Ingress",
	] as const)(
		"preflights sibling %s before scale-down or absent-PVC fencing",
		async (kind) => {
			for (const absent of [false, true]) {
				for (const mismatch of ["fence", "revision", "owner"]) {
					const f = fixture();
					const adapter = f.adapter();
					const desired = workloadDesiredFixture();
					const identity = await adapter.apply(desired);
					if (!identity || identity === "pending") throw new Error();
					await adapter.promote(desired, identity);
					const resourceKind = kind === "ProbeService" ? "Service" : kind;
					const name =
						kind === "PersistentVolumeClaim"
							? desired.persistentVolume.name
							: kind === "ProbeService"
								? `${desired.service.name}-probe`
								: desired.service.name;
					const resource = await f.client.read(resourceKind, name);
					if (!resource?.metadata?.annotations || !resource.metadata.labels)
						throw new Error();
					if (mismatch === "fence")
						resource.metadata.annotations["agent-infra.agora.io/fence"] =
							String(desired.fence + 2);
					if (mismatch === "revision")
						resource.metadata.labels["agent-infra.agora.io/revision"] = String(
							desired.workloadRevision + 2,
						);
					if (mismatch === "owner")
						resource.metadata.annotations["agent-infra.agora.io/agent-id"] =
							"foreign";
					f.resources.set(`${resourceKind}/${name}`, resource);
					if (absent) {
						f.resources.delete(`StatefulSet/${desired.service.name}`);
						f.resources.delete(`Pod/${desired.service.name}-0`);
					}
					const before = structuredClone([...f.resources]);
					const writes = f.writes.length;
					await expect(
						adapter.scaleDownAgent(
							desired.agentId,
							desired.workloadRevision + 1,
							desired.fence + 1,
						),
					).rejects.toMatchObject({
						code: mismatch === "owner" ? "policy" : "conflict",
					});
					expect(f.writes).toHaveLength(writes);
					expect([...f.resources]).toEqual(before);
				}
			}
		},
	);
	it("reuses canonical equivalent PVC storage quantities without writes", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = createKubernetesRuntimeAdapterV1({
			client: f.client,
			policy: { ...workloadTestPolicy, storageSize: "0.125Gi" },
			probe: f.probe,
		});
		const identity = await adapter.apply(desired);
		const pvc = await f.client.read<V1PersistentVolumeClaim>(
			"PersistentVolumeClaim",
			desired.persistentVolume.name,
		);
		if (!pvc?.spec?.resources?.requests) throw new Error();
		pvc.spec.resources.requests.storage = "128Mi";
		f.resources.set(
			`PersistentVolumeClaim/${desired.persistentVolume.name}`,
			pvc,
		);
		const writes = f.writes.length;
		expect(await adapter.apply(desired)).toEqual(identity);
		expect(f.writes).toHaveLength(writes);
		pvc.spec.resources.requests.storage = "129Mi";
		f.resources.set(
			`PersistentVolumeClaim/${desired.persistentVolume.name}`,
			pvc,
		);
		await expect(adapter.apply(desired)).rejects.toMatchObject({
			code: "conflict",
		});
		expect(f.writes).toHaveLength(writes);
	});
	it("rejects and repairs injected Ingress labels on an open route", async () => {
		const f = fixture();
		const adapter = f.adapter();
		const desired = workloadDesiredFixture();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		await adapter.promote(desired, identity);
		const route = await f.client.read<V1Ingress>("Ingress", desired.route.name);
		if (!route?.metadata?.labels) throw new Error();
		route.metadata.labels["external.example.test/route"] = "injected";
		f.resources.set(`Ingress/${desired.route.name}`, route);
		expect(await adapter.observe(desired, identity, "open")).toBe("drifted");
		await adapter.closeAgent(
			desired.agentId,
			desired.workloadRevision,
			desired.fence,
		);
		await adapter.promote(desired, identity);
		expect(await adapter.observe(desired, identity, "open")).toBe("healthy");
	});
	it.each([
		{ activeDeadlineSeconds: 30 },
		{ restartPolicy: "Never" },
		{ terminationGracePeriodSeconds: 0 },
		{ enableServiceLinks: false },
		{ readinessGates: [{ conditionType: "external.example.test/ready" }] },
		{ hostUsers: false },
		{ serviceAccount: "foreign-account" },
	])(
		"rejects unmanaged Pod profile %j in template and live Pod",
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
			workload.spec.template.spec = {
				...workload.spec.template.spec,
				...mutation,
			};
			f.resources.set(`StatefulSet/${desired.service.name}`, workload);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			await expect(adapter.promote(desired, identity)).rejects.toMatchObject({
				code: "conflict",
			});
			const repaired = await adapter.apply(desired);
			if (!repaired || repaired === "pending") throw new Error();
			expect(await adapter.observe(desired, repaired)).toBe("healthy");
			const pod = await f.client.read<V1Pod>(
				"Pod",
				`${desired.service.name}-0`,
			);
			if (!pod?.spec) throw new Error();
			pod.spec = { ...pod.spec, ...mutation };
			f.resources.set(`Pod/${desired.service.name}-0`, pod);
			expect(await adapter.observe(desired, repaired)).toBe("drifted");
			await expect(adapter.promote(desired, repaired)).rejects.toMatchObject({
				code: "conflict",
			});
			expect(await adapter.apply(desired)).toBe("pending");
		},
	);
	it.each([
		[
			"volume claim templates",
			{
				volumeClaimTemplates: [
					{
						metadata: { name: "injected" },
						spec: {
							accessModes: ["ReadWriteOnce"],
							resources: { requests: { storage: "1Gi" } },
						},
					},
				],
			},
		],
		[
			"PVC deletion policy",
			{
				persistentVolumeClaimRetentionPolicy: {
					whenDeleted: "Delete",
					whenScaled: "Delete",
				},
			},
		],
		[
			"selector expressions",
			{
				selector: {
					matchExpressions: [{ key: "unmanaged", operator: "Exists" }],
				},
			},
		],
		["parallel management", { podManagementPolicy: "Parallel" }],
		["service name", { serviceName: "foreign-service" }],
		["nonzero ordinal", { ordinals: { start: 1 } }],
		[
			"partitioned rollout",
			{
				updateStrategy: {
					type: "RollingUpdate",
					rollingUpdate: { partition: 1 },
				},
			},
		],
	] as const)(
		"rejects or repairs StatefulSet %s despite an unchanged fingerprint",
		async (_label, mutation) => {
			const f = fixture();
			const adapter = f.adapter();
			const desired = workloadDesiredFixture();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const current = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				desired.service.name,
			);
			if (!current?.spec) throw new Error();
			current.spec = {
				...current.spec,
				...structuredClone(mutation),
				selector: {
					...current.spec.selector,
					...("selector" in mutation ? mutation.selector : {}),
				},
			} as V1StatefulSet["spec"];
			f.resources.set(`StatefulSet/${desired.service.name}`, current);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			await expect(adapter.promote(desired, identity)).rejects.toMatchObject({
				code: "conflict",
			});
			if (
				[
					"volume claim templates",
					"selector expressions",
					"parallel management",
					"service name",
				].includes(_label)
			) {
				const before = structuredClone(f.resources);
				const writes = f.writes.length;
				await expect(adapter.apply(desired)).rejects.toMatchObject({
					code: "conflict",
				});
				expect(f.writes).toHaveLength(writes);
				expect(f.resources).toEqual(before);
				return;
			}
			const repaired = await adapter.apply(desired);
			if (!repaired || repaired === "pending") throw new Error();
			expect(await adapter.observe(desired, repaired)).toBe("healthy");
			const writes = f.writes.length;
			await adapter.apply(desired);
			expect(f.writes).toHaveLength(writes);
		},
	);
	it("accepts defaulted StatefulSet spec without reconciliation writes", async () => {
		const f = fixture();
		const adapter = f.adapter();
		const desired = workloadDesiredFixture();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const current = await f.client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		if (!current?.spec) throw new Error();
		current.spec = {
			...current.spec,
			podManagementPolicy: "OrderedReady",
			revisionHistoryLimit: 10,
			minReadySeconds: 0,
			ordinals: { start: 0 },
			volumeClaimTemplates: [],
			persistentVolumeClaimRetentionPolicy: {
				whenDeleted: "Retain",
				whenScaled: "Retain",
			},
			updateStrategy: {
				type: "RollingUpdate",
				rollingUpdate: { partition: 0, maxUnavailable: 1 },
			},
		};
		f.resources.set(`StatefulSet/${desired.service.name}`, current);
		const writes = f.writes.length;
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		await adapter.apply(desired);
		expect(f.writes).toHaveLength(writes);
	});
	it("rejects a terminating StatefulSet before observation and promotion", async () => {
		const f = fixture();
		const adapter = f.adapter();
		const desired = workloadDesiredFixture();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		const current = await f.client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		if (!current?.metadata) throw new Error();
		current.metadata.deletionTimestamp = new Date("2026-09-10T00:00:00Z");
		f.resources.set(`StatefulSet/${desired.service.name}`, current);
		const writes = f.writes.length;
		expect(await adapter.observe(desired, identity)).toBe("drifted");
		await expect(adapter.promote(desired, identity)).rejects.toMatchObject({
			code: "conflict",
		});
		expect(f.writes).toHaveLength(writes);
		expect(await f.client.read("Ingress", desired.route.name)).toBeNull();
	});
	it.each(["route", "probe"] as const)(
		"rejects a recreated Ingress targeting the %s Service while closed",
		async (target) => {
			const f = fixture();
			const adapter = f.adapter();
			const desired = workloadDesiredFixture();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			await adapter.promote(desired, identity);
			const ingress = await f.client.read<V1Ingress>(
				"Ingress",
				desired.route.name,
			);
			if (!ingress?.spec) throw new Error();
			await adapter.closeAgent(
				desired.agentId,
				desired.workloadRevision,
				desired.fence,
			);
			if (target === "probe") {
				for (const rule of ingress.spec.rules ?? []) {
					for (const path of rule.http?.paths ?? []) {
						if (path.backend.service)
							path.backend.service.name = `${desired.service.name}-probe`;
					}
				}
			}
			f.resources.set(`Ingress/${desired.route.name}`, ingress);
			expect(await adapter.observe(desired, identity, "closed")).toBe(
				"drifted",
			);
			await expect(adapter.promote(desired, identity)).rejects.toMatchObject({
				code: "conflict",
			});
			await adapter.closeAgent(
				desired.agentId,
				desired.workloadRevision,
				desired.fence,
			);
			expect(await adapter.observe(desired, identity, "closed")).toBe(
				"healthy",
			);
		},
	);
	it.each(["Service", "ProbeService", "NetworkPolicy"] as const)(
		"rejects and repairs unmanaged %s labels and annotations",
		async (resourceKind) => {
			for (const field of ["labels", "annotations"] as const) {
				const f = fixture();
				const adapter = f.adapter();
				const desired = workloadDesiredFixture();
				const identity = await adapter.apply(desired);
				if (!identity || identity === "pending") throw new Error();
				const kind = resourceKind === "ProbeService" ? "Service" : resourceKind;
				const name =
					resourceKind === "ProbeService"
						? `${desired.service.name}-probe`
						: desired.service.name;
				const resource = await f.client.read(kind, name);
				if (!resource?.metadata) throw new Error();
				resource.metadata[field] = {
					...resource.metadata[field],
					"external.example.test/routing": "unexpected",
				};
				f.resources.set(`${kind}/${name}`, resource);
				expect(await adapter.observe(desired, identity)).toBe("drifted");
				const repaired = await adapter.apply(desired);
				if (!repaired || repaired === "pending") throw new Error();
				expect(
					(await f.client.read(kind, name))?.metadata?.[field],
				).not.toHaveProperty("external.example.test/routing");
				expect(await adapter.observe(desired, repaired)).toBe("healthy");
				const writes = f.writes.length;
				await adapter.apply(desired);
				expect(f.writes).toHaveLength(writes);
			}
		},
	);
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
	it.each([
		"PersistentVolumeClaim",
		"Service",
		"ProbeService",
		"ServiceAccount",
		"NetworkPolicy",
		"StatefulSet",
	] as const)(
		"preflights an isolated existing %s before any apply writes",
		async (resourceKind) => {
			for (const blocker of [
				"fence",
				"revision",
				"terminating",
				"foreign",
			] as const) {
				const f = fixture();
				const desired = workloadDesiredFixture();
				const adapter = f.adapter();
				await adapter.apply(desired);
				const kind = resourceKind === "ProbeService" ? "Service" : resourceKind;
				const name =
					resourceKind === "PersistentVolumeClaim"
						? desired.persistentVolume.name
						: resourceKind === "ProbeService"
							? `${desired.service.name}-probe`
							: desired.service.name;
				const resource = await f.client.read(kind, name);
				if (!resource?.metadata?.annotations || !resource.metadata.labels)
					throw new Error();
				if (blocker === "fence")
					resource.metadata.annotations["agent-infra.agora.io/fence"] = String(
						desired.fence + 1,
					);
				if (blocker === "revision")
					resource.metadata.labels["agent-infra.agora.io/revision"] = String(
						desired.workloadRevision + 1,
					);
				if (blocker === "terminating")
					resource.metadata.deletionTimestamp = new Date();
				if (blocker === "foreign")
					resource.metadata.annotations["agent-infra.agora.io/agent-id"] =
						"other-agent";
				f.resources.clear();
				f.resources.set(`${kind}/${name}`, resource);
				const writes = f.writes.length;
				await expect(adapter.apply(desired)).rejects.toMatchObject({
					code: blocker === "foreign" ? "policy" : "conflict",
				});
				expect(f.writes).toHaveLength(writes);
			}
		},
	);
	it.each(["never-created", "after-cleanup"])(
		"reports public stopped absence: %s",
		async (scenario) => {
			const f = fixture();
			const adapter = f.adapter();
			const desired = workloadDesiredFixture();
			if (scenario === "after-cleanup") {
				await adapter.apply(desired);
				for (let attempt = 0; attempt < 3; attempt++) {
					if (
						await adapter.cleanupAgent(
							desired.agentId,
							desired.workloadRevision,
							desired.fence,
							false,
						)
					)
						break;
				}
				expect(
					await f.client.read("StatefulSet", desired.service.name),
				).toBeNull();
			}
			const stopped = {
				...desired,
				desiredState: "stopped" as const,
				replicas: 0 as const,
			};
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await adapter.reconcile(stopped);
				expect(result).toMatchObject({
					status: "absent",
					replicas: 0,
					routeClosed: true,
					requestId: desired.requestId,
					fence: desired.fence,
				});
				expect(result).not.toHaveProperty("workloadUid");
				expect(result).not.toHaveProperty("workloadGeneration");
			}
		},
	);
	it.each(["pod", "foreign", "new-fence", "route-delete", "identity"])(
		"does not report absent with a blocker: %s",
		async (blocker) => {
			const f = fixture();
			const adapter = f.adapter();
			const desired = workloadDesiredFixture();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			if (blocker !== "identity")
				f.resources.delete(`StatefulSet/${desired.service.name}`);
			if (blocker !== "pod")
				f.resources.delete(`Pod/${desired.service.name}-0`);
			const service = f.resources.get(`Service/${desired.service.name}`);
			if (!service?.metadata?.annotations) throw new Error();
			if (blocker === "foreign")
				service.metadata.annotations["agent-infra.agora.io/agent-id"] =
					"foreign";
			if (blocker === "new-fence")
				service.metadata.annotations["agent-infra.agora.io/fence"] = String(
					desired.fence + 1,
				);
			if (blocker === "route-delete") {
				service.metadata.annotations["external-controller"] = "route";
				vi.spyOn(f.client, "delete").mockResolvedValue(undefined);
			}
			const result = await adapter.reconcile({
				...desired,
				desiredState: "stopped",
				replicas: 0,
				...(blocker === "identity"
					? {
							expectedWorkload: {
								state: "present",
								workloadUid: "different-uid",
								workloadGeneration: identity.generation,
							},
						}
					: {}),
			});
			expect(result).toMatchObject({ status: "failed" });
		},
	);
	it("does not report running absence when the workload disappears during apply", async () => {
		const f = fixture();
		const original = f.client.create.bind(f.client);
		vi.spyOn(f.client, "create").mockImplementation(async (object) => {
			const result = await original(object);
			if (object.kind === "StatefulSet" && result.metadata)
				delete result.metadata.uid;
			return result;
		});
		expect(await f.adapter().reconcile(workloadDesiredFixture())).toMatchObject(
			{ status: "failed" },
		);
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
	it.each(["imagePullSecrets", "secrets", "annotations"] as const)(
		"repairs undeclared ServiceAccount %s and rejects inherited Pod credentials",
		async (field) => {
			const f = fixture();
			const adapter = f.adapter();
			const desired = workloadDesiredFixture();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const account = await f.client.read<V1ServiceAccount>(
				"ServiceAccount",
				desired.serviceAccount.name,
			);
			if (!account) throw new Error();
			f.resources.set(
				`ServiceAccount/${desired.serviceAccount.name}`,
				field === "annotations"
					? {
							...account,
							metadata: {
								...account.metadata,
								annotations: {
									...account.metadata?.annotations,
									"eks.amazonaws.com/role-arn": "foreign-role",
								},
							},
						}
					: { ...account, [field]: [{ name: "foreign-secret" }] },
			);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			await adapter.apply(desired);
			expect(await adapter.observe(desired, identity)).toBe("healthy");
			const repaired = await f.client.read<V1ServiceAccount>(
				"ServiceAccount",
				desired.serviceAccount.name,
			);
			expect(repaired?.imagePullSecrets).toBeUndefined();
			expect(repaired?.secrets).toBeUndefined();
			expect(
				repaired?.metadata?.annotations?.["eks.amazonaws.com/role-arn"],
			).toBeUndefined();
			const podName = `${desired.service.name}-0`;
			const pod = await f.client.read<V1Pod>("Pod", podName);
			if (!pod?.spec) throw new Error();
			f.resources.set(`Pod/${podName}`, {
				...pod,
				spec: { ...pod.spec, imagePullSecrets: [{ name: "foreign-secret" }] },
			} as V1Pod);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			expect(await adapter.apply(desired)).toBe("pending");
			const replacement = await adapter.apply(desired);
			if (!replacement || replacement === "pending") throw new Error();
			expect(await adapter.observe(desired, replacement)).toBe("healthy");
		},
	);

	it.each([true, false])(
		"fences an already-zero StatefulSet before waiting for Pods: %s",
		async (hasPod) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = createKubernetesRuntimeAdapterV1({
				client: {
					...f.client,
					async replace(object) {
						const podKey = `Pod/${desired.service.name}-0`;
						const pod = f.resources.get(podKey);
						const result = await f.client.replace(object);
						if (hasPod && pod && object.kind === "StatefulSet")
							f.resources.set(podKey, pod);
						return result;
					},
				},
				policy: workloadTestPolicy,
				probe: f.probe,
			});
			await adapter.apply(desired);
			const current = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				desired.service.name,
			);
			if (!current?.spec) throw new Error();
			const stopped: V1StatefulSet = {
				...current,
				spec: { ...current.spec, replicas: 0 },
			};
			f.resources.set(`StatefulSet/${desired.service.name}`, stopped);
			if (!hasPod) f.resources.delete(`Pod/${desired.service.name}-0`);
			const result = await adapter.scaleDownAgent(
				desired.agentId,
				desired.workloadRevision + 1,
				desired.fence + 1,
			);
			const fenced = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				desired.service.name,
			);
			expect(
				fenced?.metadata?.annotations?.["agent-infra.agora.io/fence"],
			).toBe(String(desired.fence + 1));
			expect(fenced?.metadata?.labels?.["agent-infra.agora.io/revision"]).toBe(
				String(desired.workloadRevision + 1),
			);
			if (hasPod) expect(result).toBe("pending");
			else expect(result).toMatchObject({ uid: current.metadata?.uid });
			const writes = f.writes.length;
			await expect(adapter.apply(desired)).rejects.toMatchObject({
				code: "conflict",
			});
			expect(f.writes).toHaveLength(writes);
		},
	);

	it.each([true, false])(
		"fences the PVC before pending cleanup for deletion intent %s",
		async (deleteNewVolume) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			await f.adapter().apply(desired);
			// Preserve an orphan Pod while all other objects disappear, leaving only
			// the PVC as the durable barrier against an old apply.
			for (const key of [...f.resources.keys()]) {
				if (
					!key.startsWith("PersistentVolumeClaim/") &&
					!key.startsWith("Pod/")
				)
					f.resources.delete(key);
			}
			const adapter = f.adapter();
			expect(
				await adapter.cleanupAgent(
					desired.agentId,
					desired.workloadRevision + 1,
					desired.fence + 1,
					deleteNewVolume,
				),
			).toBe(false);
			const pvc = await f.client.read<V1PersistentVolumeClaim>(
				"PersistentVolumeClaim",
				desired.persistentVolume.name,
			);
			expect(pvc?.metadata?.annotations?.["agent-infra.agora.io/fence"]).toBe(
				String(desired.fence + 1),
			);
			const writes = f.writes.length;
			await expect(adapter.apply(desired)).rejects.toMatchObject({
				code: "conflict",
			});
			expect(f.writes).toHaveLength(writes);
		},
	);

	it.each([
		"PersistentVolumeClaim",
		"Service",
		"ProbeService",
		"ServiceAccount",
		"NetworkPolicy",
		"StatefulSet",
		"Ingress",
	] as const)(
		"preflights every existing %s before cleanup mutations",
		async (resourceKind) => {
			for (const blocker of ["fence", "revision", "foreign"] as const) {
				const f = fixture();
				const desired = workloadDesiredFixture();
				const adapter = f.adapter();
				const identity = await adapter.apply(desired);
				if (!identity || identity === "pending") throw new Error();
				await adapter.promote(desired, identity);
				const kind = resourceKind === "ProbeService" ? "Service" : resourceKind;
				const name =
					resourceKind === "PersistentVolumeClaim"
						? desired.persistentVolume.name
						: resourceKind === "ProbeService"
							? `${desired.service.name}-probe`
							: desired.service.name;
				const resource = await f.client.read(kind, name);
				if (!resource?.metadata?.annotations || !resource.metadata.labels)
					throw new Error();
				if (blocker === "fence")
					resource.metadata.annotations["agent-infra.agora.io/fence"] = "3";
				if (blocker === "revision")
					resource.metadata.labels["agent-infra.agora.io/revision"] = "3";
				if (blocker === "foreign")
					resource.metadata.annotations["agent-infra.agora.io/agent-id"] =
						"other-agent";
				f.resources.set(`${kind}/${name}`, resource);
				const before = structuredClone(f.resources);
				const writes = f.writes.length;
				await expect(
					adapter.cleanupAgent(desired.agentId, 2, 2, false),
				).rejects.toMatchObject({
					code: blocker === "foreign" ? "policy" : "conflict",
				});
				expect(f.writes).toHaveLength(writes);
				expect(f.resources).toEqual(before);
				expect(
					await adapter.cleanup({
						schemaVersion: 1,
						requestId: "stale-cleanup",
						traceId: desired.traceId,
						agentId: desired.agentId,
						configRevision: desired.configRevision,
						workloadRevision: 2,
						workloadUid: identity.uid,
						workloadGeneration: identity.generation,
						fence: 2,
						persistentVolumeIntent: "retain-existing",
					}),
				).toMatchObject({ status: "failed", routeClosed: false });
				expect(f.writes).toHaveLength(writes);
				expect(f.resources).toEqual(before);
			}
		},
	);
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
	it.each(["ProbeService", "Service", "Ingress"] as const)(
		"preflights %s before any route closure mutation",
		async (resourceKind) => {
			for (const blocker of ["fence", "revision", "foreign"] as const) {
				const f = fixture();
				const desired = workloadDesiredFixture();
				const adapter = f.adapter();
				const identity = await adapter.apply(desired);
				if (!identity || identity === "pending") throw new Error();
				await adapter.promote(desired, identity);
				const probeName = `${desired.service.name}-probe`;
				const probe = await f.client.read<V1Service>("Service", probeName);
				if (!probe?.spec) throw new Error();
				f.resources.set(`Service/${probeName}`, {
					...probe,
					spec: { ...probe.spec, type: "LoadBalancer" },
				} as V1Service);
				const kind = resourceKind === "ProbeService" ? "Service" : resourceKind;
				const name =
					resourceKind === "ProbeService" ? probeName : desired.service.name;
				const resource = await f.client.read(kind, name);
				if (!resource?.metadata?.annotations || !resource.metadata.labels)
					throw new Error();
				if (blocker === "fence")
					resource.metadata.annotations["agent-infra.agora.io/fence"] = "3";
				if (blocker === "revision")
					resource.metadata.labels["agent-infra.agora.io/revision"] = "3";
				if (blocker === "foreign")
					resource.metadata.annotations["agent-infra.agora.io/agent-id"] =
						"other-agent";
				f.resources.set(`${kind}/${name}`, resource);
				const before = structuredClone(f.resources);
				const writes = f.writes.length;
				await expect(
					adapter.closeAgent(desired.agentId, 2, 2),
				).rejects.toMatchObject({
					code: blocker === "foreign" ? "policy" : "conflict",
				});
				expect(f.writes).toHaveLength(writes);
				expect(f.resources).toEqual(before);
			}
		},
	);
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
		await adapter.closeAgent(
			internal.agentId,
			internal.workloadRevision,
			internal.fence,
		);
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
	it.each(["old", "current"] as const)(
		"preserves foreign Pods during upgrade and rejects current selector collisions: %s",
		async (revision) => {
			const f = fixture();
			const adapter = f.adapter();
			const previous = workloadDesiredFixture();
			const initial = await adapter.apply(previous);
			if (!initial || initial === "pending") throw new Error();
			const original = await f.client.read<V1Pod>(
				"Pod",
				`${previous.service.name}-0`,
			);
			if (!original) throw new Error();
			const foreign: V1Pod = {
				...original,
				metadata: {
					...original.metadata,
					name: `${previous.service.name}-foreign`,
					uid: "foreign-pod",
					labels: {
						...original.metadata?.labels,
						"agent-infra.agora.io/revision": revision === "old" ? "1" : "2",
					},
					ownerReferences: [
						{
							apiVersion: "apps/v1",
							kind: "StatefulSet",
							name: "foreign",
							uid: "foreign-statefulset",
						},
					],
				},
			};
			f.resources.set(`Pod/${foreign.metadata?.name}`, foreign);
			const desired = workloadDesiredFixture(2);
			expect(await adapter.apply(desired)).toBe("pending");
			const identity = await adapter.apply(desired);
			expect(identity).toMatchObject({ uid: initial.uid });
			if (!identity || identity === "pending") throw new Error();
			expect(await f.client.read("Pod", foreign.metadata?.name ?? "")).toEqual(
				foreign,
			);
			if (revision === "old") {
				expect(await adapter.observe(desired, identity)).toBe("healthy");
				await adapter.promote(desired, identity);
				for (const name of [
					desired.service.name,
					`${desired.service.name}-probe`,
				]) {
					const service = await f.client.read<V1Service>("Service", name);
					expect(
						service?.spec?.selector?.["agent-infra.agora.io/revision"],
					).toBe("2");
				}
			} else {
				expect(await adapter.observe(desired, identity)).toBe("drifted");
				await expect(adapter.promote(desired, identity)).rejects.toMatchObject({
					code: "conflict",
				});
				expect(
					await adapter.switchRoute({
						schemaVersion: 1,
						requestId: desired.requestId,
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
				).toMatchObject({ status: "failed" });
				expect(
					(await f.client.read<V1Service>("Service", desired.service.name))
						?.spec?.selector?.["agent-infra.agora.io/revision"],
				).toBe("closed");
			}
			f.resources.delete(`Pod/${previous.service.name}-0`);
			expect(await adapter.observe(desired, identity)).not.toBe("healthy");
		},
	);
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
	it.each(["volumeAttributesClassName", "unsupportedFutureField"])(
		"rejects unsupported PVC spec field %s",
		async (field) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = f.adapter();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const key = `PersistentVolumeClaim/${desired.persistentVolume.name}`;
			const pvc = structuredClone(
				f.resources.get(key),
			) as V1PersistentVolumeClaim;
			if (!pvc.spec) throw new Error();
			Object.assign(pvc.spec, { [field]: "unapproved" });
			f.resources.set(key, pvc);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			await expect(adapter.promote(desired, identity)).rejects.toThrow();
			const writes = f.writes.length;
			await expect(adapter.apply(desired)).rejects.toMatchObject({
				code: "conflict",
			});
			expect(f.writes).toHaveLength(writes);
		},
	);
	it.each(["missing", "terminating", "foreign", "stale", "spec"])(
		"rejects promotion with an invalid PVC: %s",
		async (mutation) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = f.adapter();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const key = `PersistentVolumeClaim/${desired.persistentVolume.name}`;
			const pvc = structuredClone(
				f.resources.get(key),
			) as V1PersistentVolumeClaim;
			if (
				!pvc?.metadata ||
				!pvc.metadata.labels ||
				!pvc.metadata.annotations ||
				!pvc.spec
			)
				throw new Error();
			if (mutation === "missing") f.resources.delete(key);
			else {
				if (mutation === "terminating")
					pvc.metadata.deletionTimestamp = new Date();
				if (mutation === "foreign")
					pvc.metadata.annotations["agent-infra.agora.io/agent-id"] = "foreign";
				if (mutation === "stale")
					pvc.metadata.annotations["agent-infra.agora.io/config-revision"] =
						"0";
				if (mutation === "spec") pvc.spec.accessModes = ["ReadWriteMany"];
				f.resources.set(key, pvc);
			}
			await expect(adapter.promote(desired, identity)).rejects.toThrow();
			expect(
				(await f.client.read<V1Service>("Service", desired.service.name))?.spec
					?.selector?.["agent-infra.agora.io/revision"],
			).toBe("closed");
		},
	);
	it.each(["1e0", "01", " 1", "1.0"])(
		"rejects noncanonical ownership metadata before route mutation: %s",
		async (encoded) => {
			for (const field of ["revision", "fence"]) {
				const f = fixture();
				const desired = workloadDesiredFixture();
				const adapter = f.adapter();
				await adapter.apply(desired);
				const key = `Service/${desired.service.name}`;
				const service = structuredClone(f.resources.get(key)) as V1Service;
				if (!service.metadata?.labels || !service.metadata.annotations)
					throw new Error();
				if (field === "revision")
					service.metadata.labels["agent-infra.agora.io/revision"] = encoded;
				else
					service.metadata.annotations["agent-infra.agora.io/fence"] = encoded;
				f.resources.set(key, service);
				await expect(adapter.closeRoute(desired)).rejects.toMatchObject({
					code: "conflict",
				});
				expect(f.resources.get(key)).toEqual(service);
			}
		},
	);
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
	it.each([
		{ labels: { "platform-worker": "true" } },
		{ labels: { "istio-injection": "enabled" } },
		{ annotations: { "k8s.v1.cni.cncf.io/networks": "foreign" } },
		{ annotations: { "cni.projectcalico.org/ipAddrs": '["203.0.113.5"]' } },
	])(
		"rejects unmanaged Pod metadata %j in template and live Pod",
		async (extra) => {
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
			if (!workload?.spec || !pod?.spec) throw new Error();
			f.resources.set(`StatefulSet/${desired.service.name}`, {
				...workload,
				spec: {
					...workload.spec,
					template: {
						...workload.spec.template,
						metadata: {
							...workload.spec.template.metadata,
							labels: {
								...workload.spec.template.metadata?.labels,
								...extra.labels,
							},
							annotations: extra.annotations,
						},
					},
				},
			} as V1StatefulSet);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			f.resources.set(`StatefulSet/${desired.service.name}`, workload);
			f.resources.set(`Pod/${desired.service.name}-0`, {
				...pod,
				metadata: {
					...pod.metadata,
					labels: { ...pod.metadata?.labels, ...extra.labels },
					annotations: extra.annotations,
				},
			} as V1Pod);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			expect(await adapter.apply(desired)).toBe("pending");
		},
	);
	it.each([
		{ schedulerName: "foreign-scheduler" },
		{ priorityClassName: "system-node-critical" },
		{ priority: 100 },
		{ preemptionPolicy: "Never" },
		{ nodeSelector: { pool: "privileged" } },
		{ affinity: { nodeAffinity: {} } },
		{ tolerations: [{ operator: "Exists" }] },
		{ schedulingGates: [{ name: "foreign" }] },
		{
			topologySpreadConstraints: [
				{
					maxSkew: 1,
					topologyKey: "foreign",
					whenUnsatisfiable: "ScheduleAnyway",
				},
			],
		},
		{ resourceClaims: [{ name: "foreign", resourceClaimName: "foreign" }] },
	])(
		"rejects unmanaged scheduling %j in template and Pod",
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
			const spec = workload?.spec?.template.spec;
			const pod = await f.client.read<V1Pod>(
				"Pod",
				`${desired.service.name}-0`,
			);
			if (!workload?.spec || !spec || !pod?.spec) throw new Error();
			f.resources.set(`StatefulSet/${desired.service.name}`, {
				...workload,
				spec: {
					...workload.spec,
					template: {
						...workload.spec.template,
						spec: { ...spec, ...override },
					},
				},
			} as V1StatefulSet);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			f.resources.set(`StatefulSet/${desired.service.name}`, workload);
			f.resources.set(`Pod/${desired.service.name}-0`, {
				...pod,
				spec: { ...pod.spec, ...override },
			} as V1Pod);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
		},
	);
	it("accepts controller labels, Calico output annotations and real scheduler defaults", async () => {
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
		const pod = await f.client.read<V1Pod>("Pod", `${desired.service.name}-0`);
		if (!workload?.spec || !spec || !pod?.spec) throw new Error();
		const defaults = {
			restartPolicy: "Always",
			terminationGracePeriodSeconds: 30,
			enableServiceLinks: true,
			dnsPolicy: "ClusterFirst",
			serviceAccount: desired.serviceAccount.name,
			schedulerName: "default-scheduler",
			priority: 0,
			preemptionPolicy: "PreemptLowerPriority",
		};
		const revision = `${desired.service.name}-abc123`;
		f.resources.set(`StatefulSet/${desired.service.name}`, {
			...workload,
			status: { ...workload.status, updateRevision: revision },
			spec: {
				...workload.spec,
				template: { ...workload.spec.template, spec: { ...spec, ...defaults } },
			},
		} as V1StatefulSet);
		const observedPod: V1Pod = {
			...pod,
			metadata: {
				...pod.metadata,
				labels: {
					...pod.metadata?.labels,
					"statefulset.kubernetes.io/pod-name": `${desired.service.name}-0`,
					"apps.kubernetes.io/pod-index": "0",
					"controller-revision-hash": revision,
				},
				annotations: {
					"cni.projectcalico.org/containerID": "a".repeat(64),
					"cni.projectcalico.org/podIP": "10.244.0.10/32",
					"cni.projectcalico.org/podIPs": "10.244.0.10/32",
				},
			},
			spec: {
				...pod.spec,
				...defaults,
				nodeName: "kind-worker",
				tolerations: [
					"node.kubernetes.io/not-ready",
					"node.kubernetes.io/unreachable",
				].map((key) => ({
					key,
					operator: "Exists",
					effect: "NoExecute",
					tolerationSeconds: 300,
				})),
			},
		};
		observedPod.spec?.tolerations?.push({
			key: "node.kubernetes.io/memory-pressure",
			operator: "Exists",
			effect: "NoSchedule",
		});
		f.resources.set(`Pod/${desired.service.name}-0`, observedPod);
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		const writesBefore = f.writes.length;
		expect(await adapter.apply(desired)).toEqual(identity);
		expect(f.writes).toHaveLength(writesBefore);
		const invalidLabels: Record<string, string>[] = [
			{ "controller-revision-hash": "foreign" },
			{ "statefulset.kubernetes.io/pod-name": "foreign" },
			{ "apps.kubernetes.io/pod-index": "1" },
		];
		for (const labels of invalidLabels) {
			f.resources.set(`Pod/${desired.service.name}-0`, {
				...observedPod,
				metadata: {
					...observedPod.metadata,
					labels: { ...observedPod.metadata?.labels, ...labels },
				},
			});
			expect(await adapter.observe(desired, identity)).toBe("drifted");
		}
		f.resources.set(`Pod/${desired.service.name}-0`, {
			...observedPod,
			metadata: {
				...observedPod.metadata,
				annotations: { "cni.projectcalico.org/podIP": "203.0.113.5/32" },
			},
		});
		expect(await adapter.observe(desired, identity)).toBe("drifted");
	});
	it.each([
		{ type: "LoadBalancer" },
		{ type: "NodePort" },
		{ externalIPs: ["203.0.113.5"] },
		{ selector: { foreign: "true" } },
	])(
		"deletes unsafe probe exposure %j before closing routes",
		async (override) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = f.adapter();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			const probeName = `${desired.service.name}-probe`;
			const probe = await f.client.read<V1Service>("Service", probeName);
			if (!probe) throw new Error();
			f.resources.set(`Service/${probeName}`, {
				...probe,
				spec: { ...probe.spec, ...override },
			} as V1Service);
			expect(
				await adapter.closeAgent(
					desired.agentId,
					desired.workloadRevision,
					desired.fence,
				),
			).toBe(true);
			expect(await f.client.read("Service", probeName)).toBeNull();
		},
	);
	it.each([
		"prefix",
		"optional",
		"configMap",
		"valueFrom",
		"subPath",
		"readOnly",
		"propagation",
		"claimReadOnly",
		"hostPath",
		"defaults",
	])(
		"validates exact nested environment and volume structure %s",
		async (mutation) => {
			const f = fixture();
			const desired = workloadDesiredFixture();
			const adapter = f.adapter();
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
			const secretUid = await adapter.applyImmutableSecret(
				desired,
				ref.name,
				"API_KEY",
				new Uint8Array([1, 2, 3]),
			);
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			await adapter.bindSecretFence(desired, identity, ref.name, 7, secretUid);
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
			const change = (source: V1PodSpec): V1PodSpec => ({
				...source,
				containers: source.containers.map((container) => ({
					...container,
					env: container.env?.map((entry) => ({
						...entry,
						...(mutation === "valueFrom"
							? { valueFrom: { fieldRef: { fieldPath: "metadata.name" } } }
							: {}),
					})),
					envFrom: container.envFrom?.map((entry) => ({
						...entry,
						prefix: mutation === "prefix" ? "FOREIGN_" : "",
						secretRef: {
							...entry.secretRef,
							name: ref.name,
							optional: mutation === "optional",
						},
						...(mutation === "configMap"
							? { configMapRef: { name: "foreign" } }
							: {}),
					})),
					volumeMounts: container.volumeMounts?.map((mount) => ({
						...mount,
						subPath: mutation === "subPath" ? "foreign" : "",
						subPathExpr: "",
						readOnly: mutation === "readOnly",
						mountPropagation:
							mutation === "propagation" ? "HostToContainer" : "None",
					})),
				})),
				volumes: source.volumes?.map((volume) => ({
					...volume,
					persistentVolumeClaim: {
						...volume.persistentVolumeClaim,
						claimName: desired.persistentVolume.name,
						readOnly: mutation === "claimReadOnly",
					},
					...(mutation === "hostPath" ? { hostPath: { path: "/host" } } : {}),
				})),
			});
			const changedWorkload: V1StatefulSet = {
				...workload,
				spec: {
					...workload.spec,
					template: { ...workload.spec.template, spec: change(spec) },
				},
			};
			f.resources.set(`StatefulSet/${desired.service.name}`, changedWorkload);
			expect(await adapter.observe(desired, identity)).toBe(
				mutation === "defaults" ? "healthy" : "drifted",
			);
			f.resources.set(`StatefulSet/${desired.service.name}`, workload);
			const changedPod: V1Pod = { ...pod, spec: change(pod.spec) };
			f.resources.set(`Pod/${desired.service.name}-0`, changedPod);
			expect(await adapter.observe(desired, identity)).toBe(
				mutation === "defaults" ? "healthy" : "drifted",
			);
		},
	);
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
		"service annotations",
		"service labels",
		"ingress",
		"ingress owner",
		"ingress labels",
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
						mutation.startsWith("service") &&
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
											labels: {
												...(current as V1Service).metadata?.labels,
												...(mutation === "service labels"
													? { "external.example.test/route": "injected" }
													: {}),
											},
											annotations: {
												...(current as V1Service).metadata?.annotations,
												...(mutation === "service annotations"
													? { "external.example.test/route": "injected" }
													: mutation === "service fence"
														? { "agent-infra.agora.io/fence": "10" }
														: {}),
											},
										},
									}),
						} as V1Service;
						f.resources.set(`Service/${name}`, drifted);
						return drifted as T;
					}
					if (
						mutation.startsWith("ingress") &&
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
												...(mutation === "ingress labels"
													? { "external.example.test/route": "injected" }
													: { "agent-infra.agora.io/agent": "foreign" }),
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
			const closedService = await f.client.read<V1Service>(
				"Service",
				desired.service.name,
			);
			if (mutation === "service labels" || mutation === "service annotations")
				expect(closedService).toBeNull();
			else
				expect(closedService?.spec?.selector).toEqual({
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

		await expect(adapter.switchRoute(request)).rejects.toThrow(
			"route closure unavailable",
		);
		failRouteClosure = false;
		await adapter.closeAgent(
			desired.agentId,
			desired.workloadRevision,
			desired.fence,
		);
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
	it.each([
		"kubernetes.io/service-account-token",
		"kubernetes.io/tls",
		undefined,
	])("rejects non-Opaque Secret reuse and activation: %s", async (type) => {
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
		const plaintext = new Uint8Array([1]);
		const uid = await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			plaintext,
		);
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const secret = await f.client.read<V1Secret>("Secret", ref.name);
		if (!secret) throw new Error();
		f.resources.set(`Secret/${ref.name}`, { ...secret, type } as V1Secret);
		await expect(
			adapter.applyImmutableSecret(desired, ref.name, "API_KEY", plaintext),
		).rejects.toThrow();
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("drifted");
		await expect(
			adapter.bindSecretFence(desired, identity, ref.name, 7, uid),
		).rejects.toThrow();
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
	it.each([
		"missing-both",
		"empty-uid",
		"zero",
		"noncanonical",
		"unsafe-integer",
		"wrong-uid",
	] as const)(
		"requires every Secret binding before readiness or promotion: %s",
		async (mutation) => {
			const f = fixture();
			const adapter = f.adapter();
			const desired = workloadDesiredFixture();
			desired.secretRefs = [1, 2].map((index) => ({
				schemaVersion: 1,
				agentId: desired.agentId,
				ownerType: "agent-owner",
				ownerId: "owner-a",
				secretId: `secret-${index}`,
				secretVersion: 1,
				configRevision: 1,
				algorithmVersion: "aes-256-gcm:v1",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				wrappingKeyVersion: "key-a",
				name: `${desired.service.name}-secret-${index}`,
			}));
			const uids = await Promise.all(
				desired.secretRefs.map((ref) =>
					adapter.applyImmutableSecret(
						desired,
						ref.name,
						ref.secretId.replace("-", "_"),
						new Uint8Array([1]),
					),
				),
			);
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			expect(
				await adapter.observe(desired, identity, "closed", "activation"),
			).toBe("healthy");
			for (const [index, ref] of desired.secretRefs.entries()) {
				const uid = uids[index];
				if (!uid) throw new Error();
				await adapter.bindSecretFence(desired, identity, ref.name, 7, uid);
				// Initial activation observes one bound Secret while others remain unbound.
				expect(
					await adapter.observeSecretFence(desired, identity, ref.name, 7),
				).toBe(true);
			}
			expect(await adapter.observe(desired, identity)).toBe("healthy");
			const workload = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				desired.service.name,
			);
			const ref = desired.secretRefs[1];
			if (!workload?.metadata?.annotations || !ref) throw new Error();
			const annotations = { ...workload.metadata.annotations };
			const uidKey = Object.keys(annotations).find(
				(key) =>
					key.startsWith("agent-infra.agora.io/secret-uid-") &&
					annotations[key] === uids[1],
			);
			if (!uidKey) throw new Error();
			const fenceKey = uidKey.replace("/secret-uid-", "/secret-");
			if (mutation === "missing-both") {
				delete annotations[uidKey];
				delete annotations[fenceKey];
				const secret = await f.client.read<V1Secret>("Secret", ref.name);
				if (!secret) throw new Error();
				f.resources.set(`Secret/${ref.name}`, {
					...secret,
					metadata: { ...secret.metadata, uid: "unverified-replacement" },
					data: { secret_2: "Ag==" },
				} as V1Secret);
			} else if (mutation === "empty-uid") annotations[uidKey] = "";
			else if (mutation === "wrong-uid") annotations[uidKey] = "foreign-uid";
			else
				annotations[fenceKey] =
					mutation === "zero"
						? "0"
						: mutation === "noncanonical"
							? "07"
							: "9007199254740992";
			f.resources.set(`StatefulSet/${desired.service.name}`, {
				...workload,
				metadata: { ...workload.metadata, annotations },
			});
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			await expect(adapter.promote(desired, identity)).rejects.toMatchObject({
				code: "conflict",
			});
			expect(
				await adapter.switchRoute({
					schemaVersion: 1,
					requestId: desired.requestId,
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
			).toMatchObject({ status: "failed" });
			expect(
				(await f.client.read<V1Service>("Service", desired.service.name))?.spec
					?.selector?.["agent-infra.agora.io/revision"],
			).toBe("closed");
		},
	);
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
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("healthy");
		const liveSecret = await f.client.read<V1Secret>("Secret", ref.name);
		if (!liveSecret) throw new Error();
		f.resources.set(`Secret/${ref.name}`, {
			...liveSecret,
			metadata: {
				...liveSecret.metadata,
				deletionTimestamp: new Date("2026-09-09T00:00:00Z"),
			},
		} as V1Secret);
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("drifted");
		f.resources.set(`Secret/${ref.name}`, liveSecret);

		f.resources.delete(`Secret/${ref.name}`);
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("drifted");
		await adapter.applyImmutableSecret(
			desired,
			ref.name,
			"API_KEY",
			new Uint8Array([1, 2, 3]),
		);
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("healthy");

		const secret = await f.client.read<V1Secret>("Secret", ref.name);
		if (!secret) throw new Error();
		f.resources.set(`Secret/${ref.name}`, {
			...secret,
			immutable: false,
		} as V1Secret);
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("drifted");
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
		expect(
			await adapter.observe(desired, identity, "closed", "activation"),
		).toBe("drifted");
	});
});
