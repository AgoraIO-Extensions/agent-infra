import type {
	KubernetesObject,
	V1Ingress,
	V1Pod,
	V1Service,
} from "@kubernetes/client-node";
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
});
