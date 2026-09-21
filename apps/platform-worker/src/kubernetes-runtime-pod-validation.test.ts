import type {
	V1PersistentVolumeClaim,
	V1Pod,
	V1PodSpec,
	V1Service,
	V1StatefulSet,
} from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { fixture } from "./kubernetes-runtime-adapter.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";

describe("GA Kubernetes Workload adapter", () => {
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
			if (!pvc?.metadata?.labels || !pvc.metadata?.annotations || !pvc.spec)
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
					...(volume.name === "data"
						? {
								persistentVolumeClaim: {
									...volume.persistentVolumeClaim,
									claimName: desired.persistentVolume.name,
									readOnly: mutation === "claimReadOnly",
								},
							}
						: {}),
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
});
