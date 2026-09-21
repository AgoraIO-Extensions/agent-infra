import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type {
	V1Ingress,
	V1Pod,
	V1Service,
	V1StatefulSet,
} from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { createWorkloadRuntimeV1 } from "./workload-runtime.js";
import {
	configurationFixture,
	fixture,
} from "./workload-runtime-split.fixture.js";

describe("assembled Workload Runtime contracts", () => {
	it.each(["NetworkPolicy", "ServiceAccount", "Service"])(
		"repairs a missing %s after readiness without promoting until the replacement is verified",
		async (kind) => {
			const f = fixture();
			await f.tick(8);
			expect(f.state?.phase).toBe("ready");
			const resource = [...f.resources.entries()].find(
				([_, object]) => object.kind === kind,
			);
			if (!resource) throw new Error();
			const pvc = [...f.resources.values()].find(
				(object) => object.kind === "PersistentVolumeClaim",
			);
			f.resources.delete(resource[0]);
			await f.tick(1);
			expect(f.state).toMatchObject({ phase: "applying", revision: 2 });
			await f.tick(7);
			expect(f.state?.phase).toBe("ready");
			expect(f.resources.has(resource[0])).toBe(true);
			expect(
				[...f.resources.values()].find(
					(object) => object.kind === "PersistentVolumeClaim",
				)?.metadata?.uid,
			).toBe(pvc?.metadata?.uid);
		},
	);

	it.each([
		{
			label: "StatefulSet template image",
			async mutate(
				f: ReturnType<typeof fixture>,
				serviceName: string,
			): Promise<void> {
				const workload = await f.client.read<V1StatefulSet>(
					"StatefulSet",
					serviceName,
				);
				if (!workload) throw new Error();
				f.resources.set(`StatefulSet/${serviceName}`, {
					...workload,
					spec: {
						...workload.spec,
						template: {
							...workload.spec?.template,
							spec: {
								...workload.spec?.template.spec,
								containers: workload.spec?.template.spec?.containers.map(
									(container) =>
										container.name === "agent"
											? {
													...container,
													image: "registry.example.test/untrusted@sha256:bad",
												}
											: container,
								),
							},
						},
					},
				} as V1StatefulSet);
			},
			async assertRepaired(
				f: ReturnType<typeof fixture>,
				serviceName: string,
			): Promise<void> {
				expect(
					(await f.client.read<V1StatefulSet>("StatefulSet", serviceName))?.spec
						?.template.spec?.containers[0]?.image,
				).toBe(
					`${workloadTestPolicy.imageRepository}@sha256:${"a".repeat(64)}`,
				);
			},
		},
		{
			label: "Service external IP",
			async mutate(
				f: ReturnType<typeof fixture>,
				serviceName: string,
			): Promise<void> {
				const service = await f.client.read<V1Service>("Service", serviceName);
				if (!service) throw new Error();
				f.resources.set(`Service/${serviceName}`, {
					...service,
					spec: { ...service.spec, externalIPs: ["203.0.113.10"] },
				} as V1Service);
			},
			async assertRepaired(
				f: ReturnType<typeof fixture>,
				serviceName: string,
			): Promise<void> {
				expect(
					(await f.client.read<V1Service>("Service", serviceName))?.spec
						?.externalIPs,
				).toBeUndefined();
			},
		},
		{
			label: "Ingress controller annotation",
			external: true,
			async mutate(
				f: ReturnType<typeof fixture>,
				serviceName: string,
			): Promise<void> {
				const route = await f.client.read<V1Ingress>("Ingress", serviceName);
				if (!route) throw new Error();
				f.resources.set(`Ingress/${serviceName}`, {
					...route,
					metadata: {
						...route.metadata,
						annotations: {
							...route.metadata?.annotations,
							"nginx.ingress.kubernetes.io/auth-url":
								"https://untrusted.example.test/auth",
						},
					},
				} as V1Ingress);
			},
			async assertRepaired(
				f: ReturnType<typeof fixture>,
				serviceName: string,
			): Promise<void> {
				expect(
					(await f.client.read<V1Ingress>("Ingress", serviceName))?.metadata
						?.annotations?.["nginx.ingress.kubernetes.io/auth-url"],
				).toBeUndefined();
			},
		},
	] as const)(
		"closes a promoted route before replacing $label drift",
		async ({ label, mutate, assertRepaired, external = false }) => {
			let f = fixture();
			if (external) {
				const configuration = configurationFixture();
				if (configuration.source.kind !== "custom") throw new Error();
				f = fixture(
					{ registry: workloadRegistryFixture() },
					{
						configuration: {
							...configuration,
							source: {
								...configuration.source,
								interactionMode: "self-managed",
								identityResponsibility: "self-managed",
							},
						},
					},
				);
			}
			await f.tick(8);
			if (f.state?.phase !== "ready") throw new Error();
			const deployment = validateAgentWorkloadDesiredV1(
				f.state.candidate.deployment,
			);
			const serviceName = deployment.service.name;
			await mutate(f, serviceName);

			await f.tick(1);
			expect(f.state).toMatchObject({ phase: "applying", revision: 2 });
			const closedService = await f.client.read<V1Service>(
				"Service",
				serviceName,
			);
			if (label === "Service external IP") expect(closedService).toBeNull();
			else
				expect(
					closedService?.spec?.selector?.["agent-infra.agora.io/revision"],
				).toBe("closed");

			await f.tick(7);
			expect(f.state?.phase).toBe("ready");
			expect(
				(await f.client.read<V1Service>("Service", serviceName))?.spec
					?.selector?.["agent-infra.agora.io/revision"],
			).toBe("2");
			await assertRepaired(f, serviceName);
			const writes = f.writes.length;
			await f.tick(1);
			expect(f.state?.phase).toBe("ready");
			expect(f.writes).toHaveLength(writes);
		},
	);

	it("closes an opened candidate selector before publishing its promoted route", async () => {
		const f = fixture();
		await f.tick(6);
		const state = f.state;
		if (state?.phase !== "promoting" || !state.identity) throw new Error();
		const deployment = validateAgentWorkloadDesiredV1(
			state.candidate.deployment,
		);
		const service = await f.client.read<V1Service>(
			"Service",
			deployment.service.name,
		);
		if (!service?.metadata?.name) throw new Error();
		f.resources.set(`Service/${service.metadata.name}`, {
			...service,
			spec: {
				...service.spec,
				selector: {
					"agent-infra.agora.io/agent": service.metadata.name,
					"agent-infra.agora.io/revision": String(state.revision),
				},
			},
		} as V1Service);
		const before = f.writes.length;

		await createWorkloadRuntimeV1(f.options).promote(state);

		const writes = f.writes.slice(before);
		const closed = writes.findIndex(
			(resource) =>
				resource.kind === "Service" &&
				(resource as V1Service).spec?.selector?.[
					"agent-infra.agora.io/revision"
				] === "closed",
		);
		const opened = writes.findIndex(
			(resource) =>
				resource.kind === "Service" &&
				(resource as V1Service).spec?.selector?.[
					"agent-infra.agora.io/revision"
				] === String(state.revision),
		);
		expect(closed).toBeGreaterThanOrEqual(0);
		expect(opened).toBeGreaterThan(closed);
		expect(
			(await f.client.read<V1Service>("Service", service.metadata.name))?.spec
				?.selector?.["agent-infra.agora.io/revision"],
		).toBe(String(state.revision));
	});

	it("recovers a partially published candidate route before durable promotion", async () => {
		const f = fixture(
			{
				registry: workloadRegistryFixture({
					schemaVersion: 1,
					interactionMode: "self-managed",
					service: { port: 8080 },
					health: { path: "/healthz" },
				}),
			},
			{
				configuration: configurationFixture({
					source: {
						kind: "custom",
						imageDigest: `sha256:${"a".repeat(64)}`,
						admissionRevision: "admission-a",
						interactionMode: "self-managed",
						identityResponsibility: "self-managed",
						connectionEnabled: false,
					},
				}),
			},
		);
		await f.tick(6);
		const state = f.state;
		if (state?.phase !== "promoting" || !state.identity) throw new Error();
		const deployment = validateAgentWorkloadDesiredV1(
			state.candidate.deployment,
		);
		const service = await f.client.read<V1Service>(
			"Service",
			deployment.service.name,
		);
		if (!service?.metadata?.name) throw new Error();
		await createWorkloadRuntimeV1(f.options).promote(state);
		expect(
			(await f.client.read<V1Service>("Service", service.metadata.name))?.spec
				?.selector?.["agent-infra.agora.io/revision"],
		).toBe(String(state.revision));
		expect(
			[...f.resources.values()].some(
				(resource) =>
					resource.kind === "Ingress" &&
					resource.metadata?.name === service.metadata?.name,
			),
		).toBe(true);
		const before = f.writes.length;
		await f.tick(1);
		expect(f.state).toMatchObject({ phase: "ready" });
		const writes = f.writes.slice(before);
		const closed = writes.findIndex(
			(resource) =>
				resource.kind === "Service" &&
				(resource as V1Service).spec?.selector?.[
					"agent-infra.agora.io/revision"
				] === "closed",
		);
		const opened = writes.findIndex(
			(resource) =>
				resource.kind === "Service" &&
				(resource as V1Service).spec?.selector?.[
					"agent-infra.agora.io/revision"
				] === String(state.revision),
		);
		expect(closed).toBeGreaterThanOrEqual(0);
		expect(opened).toBeGreaterThan(closed);
		expect(
			writes.some(
				(resource) =>
					resource.kind === "Ingress" &&
					resource.metadata?.name === service.metadata?.name,
			),
		).toBe(true);
		expect(
			(await f.client.read<V1Service>("Service", service.metadata.name))?.spec
				?.selector?.["agent-infra.agora.io/revision"],
		).toBe(String(state.revision));
	});

	it.each([
		{
			label: "fsGroup",
			mutate: (pod: V1Pod): V1Pod => {
				if (!pod.spec) throw new Error();
				return {
					...pod,
					spec: {
						...pod.spec,
						securityContext: { ...pod.spec.securityContext, fsGroup: 2000 },
					},
				};
			},
			assertSafe: (pod: V1Pod) =>
				expect(pod.spec?.securityContext?.fsGroup).toBe(1000),
		},
		{
			label: "command",
			mutate: (pod: V1Pod): V1Pod => {
				if (!pod.spec) throw new Error();
				return {
					...pod,
					spec: {
						...pod.spec,
						containers: pod.spec.containers.map((container) =>
							container.name === "agent"
								? { ...container, command: ["/unexpected"] }
								: container,
						),
					},
				};
			},
			assertSafe: (pod: V1Pod) =>
				expect(pod.spec?.containers[0]?.command).toBeUndefined(),
		},
		{
			label: "args",
			mutate: (pod: V1Pod): V1Pod => {
				if (!pod.spec) throw new Error();
				return {
					...pod,
					spec: {
						...pod.spec,
						containers: pod.spec.containers.map((container) =>
							container.name === "agent"
								? { ...container, args: ["--unexpected"] }
								: container,
						),
					},
				};
			},
			assertSafe: (pod: V1Pod) =>
				expect(pod.spec?.containers[0]?.args).toBeUndefined(),
		},
		{
			label: "lifecycle",
			mutate: (pod: V1Pod): V1Pod => {
				if (!pod.spec) throw new Error();
				return {
					...pod,
					spec: {
						...pod.spec,
						containers: pod.spec.containers.map((container) =>
							container.name === "agent"
								? {
										...container,
										lifecycle: {
											postStart: { exec: { command: ["/unexpected"] } },
										},
									}
								: container,
						),
					},
				};
			},
			assertSafe: (pod: V1Pod) =>
				expect(pod.spec?.containers[0]?.lifecycle).toBeUndefined(),
		},
	] as const)(
		"closes a promoted route before replacing a drifted owned Pod: $label",
		async ({ mutate, assertSafe }) => {
			const f = fixture();
			await f.tick(8);
			expect(f.state?.phase).toBe("ready");
			const service = [...f.resources.values()].find(
				(resource) =>
					resource.kind === "Service" &&
					!resource.metadata?.name?.endsWith("-probe"),
			) as V1Service | undefined;
			const serviceName = service?.metadata?.name;
			if (!service || !serviceName) throw new Error();
			const pod = await f.client.read<V1Pod>("Pod", `${serviceName}-0`);
			if (!pod) throw new Error();
			expect(service.spec?.selector?.["agent-infra.agora.io/revision"]).toBe(
				"1",
			);
			f.resources.set(`Pod/${serviceName}-0`, mutate(pod));

			await f.tick(1);
			expect(f.state).toMatchObject({ phase: "applying", revision: 2 });
			expect(
				(await f.client.read<V1Service>("Service", serviceName))?.spec
					?.selector?.["agent-infra.agora.io/revision"],
			).toBe("closed");

			await f.tick(1);
			expect(
				(await f.client.read<V1StatefulSet>("StatefulSet", serviceName))?.spec
					?.replicas,
			).toBe(0);
			await f.tick(5);
			expect(f.state?.phase).toBe("ready");
			expect(
				(await f.client.read<V1Service>("Service", serviceName))?.spec
					?.selector?.["agent-infra.agora.io/revision"],
			).toBe("2");
			const replacement = await f.client.read<V1Pod>("Pod", `${serviceName}-0`);
			if (!replacement) throw new Error();
			assertSafe(replacement);
		},
	);

	it("closes the retained verified revision after rejecting a newer revision", async () => {
		const f = fixture();
		await f.tick(8);
		const ready = f.state;
		if (ready?.phase !== "ready") throw new Error();
		const name = validateAgentWorkloadDesiredV1(ready.candidate.deployment)
			.service.name;
		const rejected = {
			...ready,
			phase: "rejected" as const,
			revision: ready.revision + 1,
			verifiedRevision: ready.revision,
		};
		await createWorkloadRuntimeV1(f.options).closeRoute(rejected);
		const service = await f.client.read<V1Service>("Service", name);
		expect(service?.metadata?.labels?.["agent-infra.agora.io/revision"]).toBe(
			String(ready.revision),
		);
		expect(service?.spec?.selector?.["agent-infra.agora.io/revision"]).toBe(
			"closed",
		);
	});
});
