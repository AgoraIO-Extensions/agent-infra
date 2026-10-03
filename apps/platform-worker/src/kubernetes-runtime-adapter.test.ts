import type {
	V1Ingress,
	V1PersistentVolumeClaim,
	V1Pod,
	V1Secret,
	V1Service,
	V1StatefulSet,
} from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { fixture } from "./kubernetes-runtime-adapter.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";

describe("GA Kubernetes Workload adapter", () => {
	it("starts other route closures while a Service operation is pending and waits for its outcome", async () => {
		const f = fixture();
		const adapter = f.adapter();
		const desired = workloadDesiredFixture();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		await adapter.promote(desired, identity);
		const probeName = `${desired.service.name}-probe`;
		const probe = await f.client.read<V1Service>("Service", probeName);
		if (!probe?.metadata) throw new Error();
		probe.metadata.annotations = {
			...probe.metadata.annotations,
			"external.example.test/route": "injected",
		};
		f.resources.set(`Service/${probeName}`, probe);
		const gate = Promise.withResolvers<void>();
		const failure = new Error("synthetic delayed deletion failure");
		const remove = f.client.delete.bind(f.client);
		vi.spyOn(f.client, "delete").mockImplementation(async (resource) => {
			if (resource.kind === "Service" && resource.metadata?.name === probeName)
				await gate.promise;
			await remove(resource);
		});
		let settled = false;
		const closing = adapter.closeRoute(desired);
		void closing.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		const rejected = expect(closing).rejects.toBe(failure);
		try {
			await vi.waitFor(() => {
				expect(f.resources.has(`Ingress/${desired.route.name}`)).toBe(false);
				expect(
					(f.resources.get(`Service/${desired.service.name}`) as V1Service).spec
						?.selector?.["agent-infra.agora.io/revision"],
				).toBe("closed");
			});
			expect(settled).toBe(false);
		} finally {
			gate.reject(failure);
		}
		await rejected;
	});
	it.each([
		"probe-delete",
		"main-delete",
		"main-replace",
		"main-readback",
		"main-list",
		"ingress-delete",
	] as const)(
		"attempts every route closure and preserves a failure in %s",
		async (failurePoint) => {
			const f = fixture();
			const adapter = f.adapter();
			const desired = workloadDesiredFixture();
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			await adapter.promote(desired, identity);
			const probeName = `${desired.service.name}-probe`;
			for (const name of [
				probeName,
				...(failurePoint === "main-delete" ? [desired.service.name] : []),
			]) {
				const service = await f.client.read<V1Service>("Service", name);
				if (!service?.metadata) throw new Error();
				service.metadata.annotations = {
					...service.metadata.annotations,
					"external.example.test/route": "injected",
				};
				f.resources.set(`Service/${name}`, service);
			}
			const failure = new Error("synthetic Kubernetes failure");
			const remove = f.client.delete.bind(f.client);
			vi.spyOn(f.client, "delete").mockImplementation(async (resource) => {
				if (
					(failurePoint === "probe-delete" &&
						resource.metadata?.name === probeName) ||
					(failurePoint === "main-delete" &&
						resource.kind === "Service" &&
						resource.metadata?.name === desired.service.name) ||
					(failurePoint === "ingress-delete" && resource.kind === "Ingress")
				)
					throw failure;
				await remove(resource);
			});
			const replace = f.client.replace.bind(f.client);
			vi.spyOn(f.client, "replace").mockImplementation(async (resource) => {
				if (
					failurePoint === "main-replace" &&
					resource.kind === "Service" &&
					resource.metadata?.name === desired.service.name
				)
					throw failure;
				return replace(resource);
			});
			const read = f.client.read.bind(f.client);
			let mainReads = 0;
			vi.spyOn(f.client, "read").mockImplementation(async (kind, name) => {
				if (
					failurePoint === "main-readback" &&
					kind === "Service" &&
					name === desired.service.name &&
					++mainReads === 2
				)
					throw failure;
				return read(kind, name);
			});
			const list = f.client.list.bind(f.client);
			vi.spyOn(f.client, "list").mockImplementation(async (kind, selector) => {
				if (failurePoint === "main-list" && kind === "Pod") throw failure;
				return list(kind, selector);
			});
			await expect(adapter.closeRoute(desired)).rejects.toBe(failure);
			expect(f.resources.has(`Ingress/${desired.route.name}`)).toBe(
				failurePoint === "ingress-delete",
			);
			expect(f.resources.has(`Service/${probeName}`)).toBe(
				failurePoint === "probe-delete",
			);
			if (!["main-delete", "main-replace", "main-list"].includes(failurePoint))
				expect(
					(f.resources.get(`Service/${desired.service.name}`) as V1Service).spec
						?.selector?.["agent-infra.agora.io/revision"],
				).toBe("closed");
		},
	);
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
	it("accepts an additional non-controller owner alongside the exact StatefulSet controller", async () => {
		const f = fixture();
		const adapter = f.adapter();
		const desired = workloadDesiredFixture();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const key = `Pod/${desired.service.name}-0`;
		const pod = structuredClone(f.resources.get(key)) as V1Pod;
		pod.metadata?.ownerReferences?.push({
			apiVersion: "v1",
			kind: "ConfigMap",
			name: "additional-owner",
			uid: "additional-owner",
			controller: false,
		});
		f.resources.set(key, pod);
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		await adapter.promote(desired, identity);
		expect(
			(await f.client.read<V1Service>("Service", desired.service.name))?.spec
				?.selector?.["agent-infra.agora.io/revision"],
		).toBe(String(desired.workloadRevision));
	});
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
	it.each([
		new Error("network unavailable"),
		new DOMException("probe timed out", "TimeoutError"),
	])("reports a probe failure as unhealthy: %s", async (error) => {
		const f = fixture();
		const adapter = f.adapter();
		const desired = workloadDesiredFixture();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		f.probe.mockRejectedValue(error);
		expect(await adapter.observe(desired, identity)).toBe("unhealthy");
		await expect(adapter.promote(desired, identity)).rejects.toMatchObject({
			code: "conflict",
		});
		expect(
			(await f.client.read<V1Service>("Service", desired.service.name))?.spec
				?.selector?.["agent-infra.agora.io/revision"],
		).toBe("closed");
	});
	it.each(["revision", "fence"])(
		"rejects a referenced Secret advanced to a newer %s",
		async (field) => {
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
			const uid = await adapter.applyImmutableSecret(
				desired,
				ref.name,
				"API_KEY",
				new Uint8Array([1]),
			);
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			await adapter.bindSecretFence(desired, identity, ref.name, 7, uid);
			expect(await adapter.observe(desired, identity)).toBe("healthy");
			const secret = await f.client.read<V1Secret>("Secret", ref.name);
			if (!secret?.metadata?.labels || !secret.metadata.annotations)
				throw new Error();
			if (field === "revision")
				secret.metadata.labels["agent-infra.agora.io/revision"] = String(
					desired.workloadRevision + 1,
				);
			else
				secret.metadata.annotations["agent-infra.agora.io/fence"] = String(
					desired.fence + 1,
				);
			f.resources.set(`Secret/${ref.name}`, secret);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			await expect(adapter.promote(desired, identity)).rejects.toThrow();
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
});
