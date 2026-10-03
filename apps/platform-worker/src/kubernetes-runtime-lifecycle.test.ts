import type {
	V1PersistentVolumeClaim,
	V1Pod,
	V1Service,
	V1ServiceAccount,
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
});
