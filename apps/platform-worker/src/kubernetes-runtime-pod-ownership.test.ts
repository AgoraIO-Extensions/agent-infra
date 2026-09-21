import type {
	V1Pod,
	V1SecurityContext,
	V1Service,
	V1StatefulSet,
} from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { workloadDesiredFixture } from "./kubernetes.fixture.js";
import {
	fixture,
	type SecurityContextMutation,
} from "./kubernetes-runtime-adapter.fixture.js";

describe("GA Kubernetes Workload adapter", () => {
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
	it("fails closed while a foreign Pod collides with the closed Service selector", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		const adapter = f.adapter();
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const owned = await f.client.read<V1Pod>(
			"Pod",
			`${desired.service.name}-0`,
		);
		if (!owned) throw new Error();
		const foreign: V1Pod = {
			...owned,
			metadata: {
				...owned.metadata,
				name: `${desired.service.name}-foreign-closed`,
				uid: "foreign-closed-pod",
				labels: {
					...owned.metadata?.labels,
					"agent-infra.agora.io/revision": "closed",
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
		const foreignKey = `Pod/${foreign.metadata?.name}`;
		expect(await f.client.read("Service", desired.service.name)).not.toBeNull();
		f.resources.set(foreignKey, foreign);
		expect(await adapter.observe(desired, identity, "closed")).toBe("drifted");
		expect(await adapter.apply(desired)).toBe("pending");
		expect(await f.client.read("Service", desired.service.name)).toBeNull();
		expect(await f.client.read("Pod", foreign.metadata?.name ?? "")).toEqual(
			foreign,
		);

		f.resources.delete(foreignKey);
		expect(await adapter.reconcile(desired)).toMatchObject({
			status: "applied",
		});
		expect(await f.client.read("Service", desired.service.name)).not.toBeNull();
		await adapter.promote(desired, identity);
		f.resources.set(foreignKey, foreign);
		expect(
			await adapter.closeAgent(
				desired.agentId,
				desired.workloadRevision,
				desired.fence,
			),
		).toBe(true);
		expect(await f.client.read("Service", desired.service.name)).toBeNull();
		expect(
			await f.client.read("Service", `${desired.service.name}-probe`),
		).not.toBeNull();
		expect(await f.client.read("Ingress", desired.route.name)).toBeNull();
		expect(await f.client.read("Pod", foreign.metadata?.name ?? "")).toEqual(
			foreign,
		);

		expect(await adapter.apply(desired)).toBe("pending");
		expect(await f.client.read("Service", desired.service.name)).toBeNull();
		expect(await f.client.read("Pod", foreign.metadata?.name ?? "")).toEqual(
			foreign,
		);

		f.resources.delete(foreignKey);
		expect(await adapter.reconcile(desired)).toMatchObject({
			status: "applied",
		});
		expect(
			(await f.client.read<V1Service>("Service", desired.service.name))?.spec
				?.selector,
		).toEqual({
			"agent-infra.agora.io/agent": desired.service.name,
			"agent-infra.agora.io/revision": "closed",
		});
		expect(await adapter.observe(desired, identity, "closed")).toBe("healthy");
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
});
