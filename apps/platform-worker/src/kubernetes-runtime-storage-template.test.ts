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
});
