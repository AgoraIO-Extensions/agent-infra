import {
	defaultMultiServiceResourceProfileV1,
	MultiServiceManifestDocumentV1Schema,
	MultiServiceResourceProfileAnnotationV1,
} from "@agent-infra/contracts/pilot";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type {
	KubernetesObject,
	V1ConfigMap,
	V1Deployment,
	V1Endpoints,
	V1Job,
	V1NetworkPolicy,
	V1PersistentVolumeClaim,
	V1StatefulSet,
} from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import type { WorkerKubernetesClientV1 } from "./kubernetes-client.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-comparison.js";
import {
	createMultiServiceRuntimeOperations,
	isMultiService,
	type MultiServiceRuntimePolicyV1,
	resolveMultiServiceResourceConfigurationV1,
} from "./multi-service-runtime.js";

const manifest = MultiServiceManifestDocumentV1Schema.parse({
	schemaVersion: 1,
	entryServiceName: "web",
	resources: [
		{
			apiVersion: "apps/v1",
			kind: "Deployment",
			metadata: { name: "web" },
			spec: {
				replicas: 1,
				selector: { matchLabels: { app: "web" } },
				template: {
					metadata: { labels: { app: "web" } },
					spec: {
						volumes: [{ name: "config", configMap: { name: "web-config" } }],
						containers: [
							{
								name: "web",
								image: `sha256:${"a".repeat(64)}`,
								ports: [{ name: "http", port: 8080, targetPort: 8080 }],
								volumeMounts: [
									{ name: "config", mountPath: "/etc/web", readOnly: true },
								],
							},
						],
					},
				},
			},
		},
		{
			apiVersion: "apps/v1",
			kind: "Deployment",
			metadata: { name: "worker" },
			spec: {
				replicas: 1,
				selector: { matchLabels: { app: "worker" } },
				template: {
					metadata: { labels: { app: "worker" } },
					spec: {
						containers: [{ name: "worker", image: `sha256:${"b".repeat(64)}` }],
					},
				},
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: {
				name: "web",
				annotations: {
					"agent-infra.agora.io/entry": "true",
					[MultiServiceResourceProfileAnnotationV1]: "small",
				},
			},
			spec: {
				type: "ClusterIP",
				selector: { app: "web" },
				ports: [{ name: "http", port: 8080, targetPort: 8080 }],
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: {
				name: "worker",
				annotations: { [MultiServiceResourceProfileAnnotationV1]: "small" },
			},
			spec: {
				type: "ClusterIP",
				selector: { app: "worker" },
				ports: [{ name: "http", port: 8080, targetPort: 8080 }],
			},
		},
		{
			apiVersion: "v1",
			kind: "ConfigMap",
			metadata: { name: "web-config" },
			spec: { data: { "app.conf": "hello=world\n" } },
		},
	],
});

const smallProfile = {
	profileId: "small",
	displayName: "Small",
	estimatedResources: { cpuMillicores: 100, memoryMiB: 128, storageGiB: 1 },
	resources: {
		requests: { cpu: "25m", memory: "32Mi" },
		limits: { cpu: "100m", memory: "128Mi" },
	},
} as const;

const migrationManifest = MultiServiceManifestDocumentV1Schema.parse({
	...manifest,
	resources: [
		...manifest.resources,
		{
			apiVersion: "batch/v1",
			kind: "Job",
			metadata: { name: "migrate" },
			spec: {
				backoffLimit: 1,
				activeDeadlineSeconds: 300,
				template: {
					metadata: { labels: { app: "migration" } },
					spec: {
						restartPolicy: "Never",
						containers: [
							{ name: "migrate", image: `sha256:${"d".repeat(64)}` },
						],
					},
				},
			},
		},
	],
});

const upgradedManifest = MultiServiceManifestDocumentV1Schema.parse({
	...manifest,
	resources: manifest.resources.map((resource) => {
		if (resource.kind === "ConfigMap")
			return {
				...resource,
				spec: { data: { "app.conf": "hello=upgraded\n" } },
			};
		if (resource.kind !== "Deployment" || resource.metadata.name !== "web")
			return resource;
		return {
			...resource,
			spec: {
				...resource.spec,
				template: {
					...resource.spec.template,
					spec: {
						...resource.spec.template.spec,
						containers: resource.spec.template.spec.containers.map(
							(container) => ({
								...container,
								image: `sha256:${"e".repeat(64)}`,
							}),
						),
					},
				},
			},
		};
	}),
});

const statefulManifest = (() => {
	const web = manifest.resources.find(
		(resource) =>
			resource.kind === "Deployment" && resource.metadata.name === "web",
	);
	if (web?.kind !== "Deployment") throw new Error("stateful fixture missing");
	return MultiServiceManifestDocumentV1Schema.parse({
		...manifest,
		resources: [
			{
				...web,
				kind: "StatefulSet",
				spec: { ...web.spec, serviceName: "web" },
			},
			...manifest.resources.filter((resource) => resource !== web),
			{
				apiVersion: "v1",
				kind: "PersistentVolumeClaim",
				metadata: { name: "web-data" },
				spec: {
					accessModes: ["ReadWriteOnce"],
					resources: { requests: { storage: "1Gi" } },
				},
			},
		],
	});
})();

function desired(multiService = manifest) {
	return validateAgentWorkloadDesiredV1({
		schemaVersion: 1,
		requestId: "request-a",
		traceId: "trace-a",
		agentId: "agent-a",
		configRevision: 1,
		workloadRevision: 1,
		fence: 1,
		expectedWorkload: { state: "absent" },
		namespaceRef: "agents",
		imageDigest: `sha256:${"c".repeat(64)}`,
		registryAdmission: {
			schemaVersion: 1,
			immutableDigest: `sha256:${"c".repeat(64)}`,
			runtimeManifest: {
				schemaVersion: 1,
				interactionMode: "self-managed",
				service: { port: 8080 },
				health: { path: "/" },
			},
			policyEvidence: {
				schemaVersion: 1,
				policyRef: "policy",
				decisionRef: "decision",
				subjectRef: "subject",
				agentId: "agent-a",
				imageDigest: `sha256:${"c".repeat(64)}`,
				evaluatedAt: "2026-01-01T00:00:00.000Z",
			},
			runtimeManifestParsingEvidence: {
				schemaVersion: 1,
				labelName: "io.agora.agent.runtime.manifest",
				utf8ByteLength: 1,
				maxDepth: 1,
				duplicateKeysDetected: false,
				unknownFieldsDetected: false,
			},
		},
		runtimeManifest: {
			schemaVersion: 1,
			interactionMode: "self-managed",
			service: { port: 8080 },
			health: { path: "/" },
		},
		resourceProfileRef: "profile",
		env: {},
		service: { name: "agent-a", port: 8080 },
		health: { path: "/", timeoutSeconds: 5, failureThreshold: 3 },
		persistentVolume: {
			name: "agent-a-data",
			mountPath: "/workspace",
			storageProfileRef: "storage",
			accessMode: "ReadWriteOnce",
			retention: "retain",
		},
		serviceAccount: { name: "agent-a", kubernetesApiAccess: false },
		networkPolicy: {
			deploymentPolicyRef: "network",
			ingressMode: "self-managed-route",
			kubernetesApiAccess: false,
			platformDatabaseAccess: false,
			connectionDatabaseAccess: false,
			decryptionKeyringAccess: false,
		},
		route: {
			name: "agent-a",
			exposure: "self-managed",
			tlsRequired: true,
			interactionOrigin: {
				schemaVersion: 1,
				origin: "https://agent-a.example.test",
			},
		},
		secretRefs: [],
		desiredState: "running",
		replicas: 1,
		multiService,
	});
}

function fakeClient() {
	const resources = new Map<string, KubernetesObject>();
	const client: WorkerKubernetesClientV1 = {
		namespace: "agents",
		async read(kind, name) {
			return (resources.get(`${kind}/${name}`) ?? null) as never;
		},
		async list(kind, selector) {
			const [key, expected] = selector.split("=", 2);
			return [...resources.values()].filter(
				(resource) =>
					resource.kind === kind &&
					(key === undefined || resource.metadata?.labels?.[key] === expected),
			) as never;
		},
		async create(object) {
			const stored = {
				...object,
				metadata: {
					...object.metadata,
					uid: `${object.kind}-${object.metadata?.name}`,
					resourceVersion: "1",
				},
			};
			resources.set(`${object.kind}/${object.metadata?.name}`, stored);
			return stored;
		},
		async replace(object) {
			resources.set(`${object.kind}/${object.metadata?.name}`, object);
			return object;
		},
		async delete(object) {
			resources.delete(`${object.kind}/${object.metadata?.name}`);
		},
	};
	return { client, resources };
}

const basePolicy = {
	namespace: "agents",
	multiServiceResourceProfiles: [smallProfile],
	routeHostSuffix: "example.test",
	ingressClassName: "nginx",
	tlsSecretName: "tls",
	routeSelector: { "app.kubernetes.io/name": "ingress" },
} satisfies MultiServiceRuntimePolicyV1;

/** 记录每一次 Kubernetes 调用（含读取与列举），用于证明拒绝发生在任何调用之前。 */
function recordingClient(client: WorkerKubernetesClientV1) {
	const calls: string[] = [];
	const recorded: WorkerKubernetesClientV1 = {
		namespace: client.namespace,
		read(kind, name) {
			calls.push(`read ${kind}/${name}`);
			return client.read(kind, name);
		},
		list(kind, selector) {
			calls.push(`list ${kind}`);
			return client.list(kind, selector);
		},
		create(object) {
			calls.push(`create ${object.kind}/${object.metadata?.name}`);
			return client.create(object);
		},
		replace(object) {
			calls.push(`replace ${object.kind}/${object.metadata?.name}`);
			return client.replace(object);
		},
		delete(object) {
			calls.push(`delete ${object.kind}/${object.metadata?.name}`);
			return client.delete(object);
		},
	};
	return { client: recorded, calls };
}

/** 带存储档位的 StatefulSet 档位；资源量与 small 不同，便于断言注入来源。 */
const databaseProfile = {
	profileId: "database",
	displayName: "Database",
	estimatedResources: { cpuMillicores: 200, memoryMiB: 256, storageGiB: 5 },
	resources: {
		requests: { cpu: "50m", memory: "64Mi" },
		limits: { cpu: "200m", memory: "256Mi" },
	},
	storageSize: "5Gi",
} as const;

/** StatefulSet 自身声明 database 档位，覆盖其 Service 上的 small。 */
const databaseManifest = MultiServiceManifestDocumentV1Schema.parse({
	...statefulManifest,
	resources: statefulManifest.resources.map((resource) =>
		resource.kind === "StatefulSet"
			? {
					...resource,
					metadata: {
						...resource.metadata,
						annotations: {
							[MultiServiceResourceProfileAnnotationV1]: "database",
						},
					},
				}
			: resource,
	),
});

const pvcKey = `PersistentVolumeClaim/${workloadResourceNameV1("agent-a")}-web-data`;

function storedPvc(fake: ReturnType<typeof fakeClient>) {
	return fake.resources.get(pvcKey) as V1PersistentVolumeClaim | undefined;
}

/** 把已创建的 Deployment/StatefulSet 标记为就绪，使 observe 继续检查 PVC。 */
function markWorkloadsReady(fake: ReturnType<typeof fakeClient>) {
	for (const resource of fake.resources.values())
		if (resource.kind === "Deployment" || resource.kind === "StatefulSet")
			(resource as V1Deployment | V1StatefulSet).status = {
				availableReplicas: 1,
				readyReplicas: 1,
				replicas: 1,
			};
}

describe("multi-service resource policy", () => {
	it("resolves the deployment profiles behind the contract default", () => {
		expect(
			resolveMultiServiceResourceConfigurationV1(basePolicy),
		).toMatchObject({
			profiles: [defaultMultiServiceResourceProfileV1, smallProfile],
			source: "deployment",
		});
	});

	it.each([
		[
			"duplicate profile IDs",
			{ multiServiceResourceProfiles: [smallProfile, smallProfile] },
		],
		[
			"the reserved default profile ID",
			{
				multiServiceResourceProfiles: [
					{ ...smallProfile, profileId: "default" },
				],
			},
		],
		[
			"a schema-invalid profile",
			{
				multiServiceResourceProfiles: [
					{
						...smallProfile,
						resources: {
							requests: { cpu: "1Gi", memory: "1m" },
							limits: { cpu: "1Gi", memory: "1m" },
						},
					},
				],
			},
		],
		[
			"a schema-invalid cap",
			{
				multiServiceResourceCap: {
					cpuMillicores: 0,
					memoryMiB: 1,
					storageGiB: 1,
				},
			},
		],
	])("fails Worker assembly on %s", (_label, overrides) => {
		const fake = recordingClient(fakeClient().client);
		expect(() =>
			createMultiServiceRuntimeOperations({
				client: fake.client,
				policy: {
					...basePolicy,
					...overrides,
				} as unknown as MultiServiceRuntimePolicyV1,
			}),
		).toThrow("multi-service resource policy invalid");
		expect(fake.calls).toEqual([]);
	});

	it("rejects an over-cap Agent before any Kubernetes call, including stale-resource pruning", async () => {
		const fake = fakeClient();
		// small 档位每个工作负载 100m：两个服务 200m 在上限内，加迁移 Job 共 300m 超限。
		const cap = { cpuMillicores: 250, memoryMiB: 4_096, storageGiB: 20 };
		const recorded = recordingClient(fake.client);
		const operations = createMultiServiceRuntimeOperations({
			client: recorded.client,
			policy: { ...basePolicy, multiServiceResourceCap: cap },
		});
		const twoServices = desired();
		const withMigration = desired(migrationManifest);
		if (!isMultiService(twoServices) || !isMultiService(withMigration))
			throw new Error("multi-service fixture invalid");
		await operations.apply(twoServices);
		// 注入一个属于该 Agent、但不在期望清单中的旧 Deployment，作为 prune 的目标。
		const web = [...fake.resources.values()].find(
			(resource) =>
				resource.kind === "Deployment" &&
				resource.metadata?.name?.endsWith("-web"),
		);
		if (!web) throw new Error("Deployment fixture missing");
		const staleName = `${workloadResourceNameV1("agent-a")}-legacy`;
		fake.resources.set(`Deployment/${staleName}`, {
			...web,
			metadata: { ...web.metadata, name: staleName },
		});
		const before = structuredClone([...fake.resources.entries()]);
		recorded.calls.length = 0;

		await expect(
			operations.apply(withMigration, { allowOwnershipTransition: true }),
		).rejects.toThrow("MULTI_SERVICE_RESOURCE_CAP_EXCEEDED");
		expect(recorded.calls).toEqual([]);
		expect([...fake.resources.entries()]).toEqual(before);

		// 对照：未超限时同一所有权交接会清理旧资源，证明上面的 prune 是被上限拦下的。
		await operations.apply(twoServices, { allowOwnershipTransition: true });
		expect(recorded.calls).toContain(`delete Deployment/${staleName}`);
		expect(fake.resources.has(`Deployment/${staleName}`)).toBe(false);
	});

	it("sizes the PVC from the StatefulSet profile and injects that profile", async () => {
		const fake = fakeClient();
		const operations = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: {
				...basePolicy,
				multiServiceResourceProfiles: [smallProfile, databaseProfile],
				storageSize: "1Gi",
			},
		});
		const value = desired(databaseManifest);
		if (!isMultiService(value))
			throw new Error("multi-service fixture invalid");
		await operations.apply(value);
		expect(storedPvc(fake)?.spec?.resources?.requests?.storage).toBe("5Gi");
		const statefulSet = fake.resources.get(
			`StatefulSet/${workloadResourceNameV1("agent-a")}-web`,
		) as V1StatefulSet | undefined;
		expect(statefulSet?.spec?.template.spec?.containers[0]?.resources).toEqual(
			databaseProfile.resources,
		);
		markWorkloadsReady(fake);
		expect(await operations.observe(value, { uid: "u", generation: 1 })).toBe(
			"healthy",
		);
	});

	it("sizes each PVC from the profile of the StatefulSet that owns it (#2523)", async () => {
		// web 使用 database 档位（5Gi），worker 改为第二个 StatefulSet 且档位无 storageSize。
		const worker = databaseManifest.resources.find(
			(resource) =>
				resource.kind === "Deployment" && resource.metadata.name === "worker",
		);
		if (worker?.kind !== "Deployment")
			throw new Error("worker fixture missing");
		const twoStateful = MultiServiceManifestDocumentV1Schema.parse({
			...databaseManifest,
			resources: [
				...databaseManifest.resources.filter((resource) => resource !== worker),
				{
					...worker,
					kind: "StatefulSet",
					spec: { ...worker.spec, serviceName: "worker" },
				},
				{
					apiVersion: "v1",
					kind: "PersistentVolumeClaim",
					metadata: { name: "worker-data" },
					spec: {
						accessModes: ["ReadWriteOnce"],
						resources: { requests: { storage: "9Gi" } },
					},
				},
			],
		});
		const fake = fakeClient();
		const operations = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: {
				...basePolicy,
				multiServiceResourceProfiles: [smallProfile, databaseProfile],
				storageSize: "2Gi",
			},
		});
		const value = desired(twoStateful);
		if (!isMultiService(value))
			throw new Error("multi-service fixture invalid");
		await operations.apply(value);
		const prefix = workloadResourceNameV1("agent-a");
		const storage = (name: string) =>
			(
				fake.resources.get(`PersistentVolumeClaim/${prefix}-${name}`) as
					| V1PersistentVolumeClaim
					| undefined
			)?.spec?.resources?.requests?.storage;
		expect(storage("web-data")).toBe("5Gi");
		expect(storage("worker-data")).toBe("2Gi");
		markWorkloadsReady(fake);
		expect(await operations.observe(value, { uid: "u", generation: 1 })).toBe(
			"healthy",
		);
	});

	it("falls back to the deployment storage size when the StatefulSet profile has none", async () => {
		const fake = fakeClient();
		const operations = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: { ...basePolicy, storageSize: "2Gi" },
		});
		const value = desired(statefulManifest);
		if (!isMultiService(value))
			throw new Error("multi-service fixture invalid");
		await operations.apply(value);
		// 用户清单中的 PVC 请求 1Gi，平台以部署策略为准。
		expect(storedPvc(fake)?.spec?.resources?.requests?.storage).toBe("2Gi");
	});

	it("fails closed when neither the profile nor the deployment sets a storage size", async () => {
		const fake = fakeClient();
		const operations = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: basePolicy,
		});
		const value = desired(statefulManifest);
		if (!isMultiService(value))
			throw new Error("multi-service fixture invalid");
		await expect(operations.apply(value)).rejects.toThrow(
			"multi-service storage policy missing",
		);
		expect(storedPvc(fake)).toBeUndefined();
	});

	it("treats an existing PVC whose size differs from the expected size as drift", async () => {
		const fake = fakeClient();
		const fallback = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: { ...basePolicy, storageSize: "1Gi" },
		});
		const value = desired(statefulManifest);
		if (!isMultiService(value))
			throw new Error("multi-service fixture invalid");
		await fallback.apply(value);
		markWorkloadsReady(fake);
		expect(await fallback.observe(value, { uid: "u", generation: 1 })).toBe(
			"healthy",
		);

		// 集群中的 PVC 被改成与策略不同的大小。
		const pvc = storedPvc(fake);
		if (!pvc?.spec?.resources) throw new Error("PVC fixture missing");
		fake.resources.set(pvcKey, {
			...pvc,
			spec: {
				...pvc.spec,
				resources: { requests: { storage: "3Gi" } },
			},
		} as V1PersistentVolumeClaim);
		await expect(fallback.apply(value)).rejects.toThrow(
			"multi-service PVC drifted",
		);
		expect(await fallback.observe(value, { uid: "u", generation: 1 })).toBe(
			"unhealthy",
		);

		// 部署改为由 StatefulSet 档位声明 5Gi 后，按旧策略创建的 1Gi PVC 同样视为漂移。
		const profiledFake = fakeClient();
		const { storageSize: _storageSize, ...databaseWithoutStorage } =
			databaseProfile;
		const before = createMultiServiceRuntimeOperations({
			client: profiledFake.client,
			policy: {
				...basePolicy,
				multiServiceResourceProfiles: [smallProfile, databaseWithoutStorage],
				storageSize: "1Gi",
			},
		});
		const databaseValue = desired(databaseManifest);
		if (!isMultiService(databaseValue))
			throw new Error("multi-service fixture invalid");
		await before.apply(databaseValue);
		markWorkloadsReady(profiledFake);
		expect(storedPvc(profiledFake)?.spec?.resources?.requests?.storage).toBe(
			"1Gi",
		);
		const after = createMultiServiceRuntimeOperations({
			client: profiledFake.client,
			policy: {
				...basePolicy,
				multiServiceResourceProfiles: [smallProfile, databaseProfile],
				storageSize: "1Gi",
			},
		});
		expect(
			await after.observe(databaseValue, { uid: "u", generation: 1 }),
		).toBe("unhealthy");
		await expect(after.apply(databaseValue)).rejects.toThrow(
			"multi-service PVC drifted",
		);
		expect(storedPvc(profiledFake)?.spec?.resources?.requests?.storage).toBe(
			"1Gi",
		);
	});
});

describe("multi-service runtime operations", () => {
	it.each([
		["Deployment", manifest],
		["StatefulSet", statefulManifest],
		["Job", migrationManifest],
	] as const)(
		"applies the restricted Pod security baseline to every %s container",
		async (kind, source) => {
			const fake = fakeClient();
			const operations = createMultiServiceRuntimeOperations({
				client: fake.client,
				policy: { ...basePolicy, storageSize: "1Gi" },
			});
			const value = desired(source);
			if (!isMultiService(value))
				throw new Error("multi-service fixture invalid");
			await operations.apply(value);
			const workloads = [...fake.resources.values()].filter(
				(resource) => resource.kind === kind,
			) as (V1Deployment | V1StatefulSet | V1Job)[];
			expect(workloads.length).toBeGreaterThan(0);
			for (const workload of workloads) {
				const pod = workload.spec?.template.spec;
				expect(pod?.automountServiceAccountToken).toBe(false);
				expect(pod?.securityContext).toMatchObject({
					runAsNonRoot: true,
					runAsUser: 1000,
					runAsGroup: 1000,
					fsGroup: 1000,
					seccompProfile: { type: "RuntimeDefault" },
				});
				for (const container of pod?.containers ?? []) {
					expect(container.securityContext).toMatchObject({
						runAsNonRoot: true,
						runAsUser: 1000,
						runAsGroup: 1000,
						allowPrivilegeEscalation: false,
						readOnlyRootFilesystem: true,
						capabilities: { drop: ["ALL"] },
						seccompProfile: { type: "RuntimeDefault" },
					});
				}
			}
		},
	);
	it("injects ownership, service accounts, network isolation and entry route", async () => {
		const fake = fakeClient();
		const operations = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: {
				namespace: "agents",
				multiServiceResourceProfiles: [smallProfile],
				routeHostSuffix: "example.test",
				ingressClassName: "nginx",
				tlsSecretName: "tls",
				routeSelector: { "app.kubernetes.io/name": "ingress" },
			},
		});
		const value = desired();
		if (!isMultiService(value))
			throw new Error("multi-service fixture invalid");
		await operations.apply(value);
		const deployment = [...fake.resources.values()].find(
			(resource) => resource.kind === "Deployment",
		) as V1Deployment | undefined;
		expect(deployment?.metadata?.labels?.["agent-infra.agora.io/agent"]).toBe(
			workloadResourceNameV1("agent-a"),
		);
		expect(
			(
				deployment as {
					spec?: {
						template?: { spec?: { containers?: [{ resources?: unknown }] } };
					};
				}
			).spec?.template?.spec?.containers?.[0]?.resources,
		).toEqual({
			requests: { cpu: "25m", memory: "32Mi" },
			limits: { cpu: "100m", memory: "128Mi" },
		});
		const configMap = [...fake.resources.values()].find(
			(resource) => resource.kind === "ConfigMap",
		) as V1ConfigMap | undefined;
		expect(configMap?.immutable).toBe(true);
		expect(configMap?.data).toEqual({ "app.conf": "hello=world\n" });
		expect(deployment?.spec?.template.spec?.volumes).toEqual([
			{
				name: "config",
				configMap: {
					name: `${workloadResourceNameV1("agent-a")}-web-config`,
					optional: false,
				},
			},
		]);
		expect(
			deployment?.spec?.template.spec?.containers[0]?.volumeMounts,
		).toEqual([{ name: "config", mountPath: "/etc/web", readOnly: true }]);
		expect(
			fake.resources.has(`ServiceAccount/${workloadResourceNameV1("agent-a")}`),
		).toBe(true);
		const network = [...fake.resources.values()].find(
			(resource) => resource.kind === "NetworkPolicy",
		);
		expect(
			network?.metadata?.annotations?.["agent-infra.agora.io/spec-hash"],
		).toBeTypeOf("string");
		expect(
			(network as V1NetworkPolicy | undefined)?.spec?.ingress?.[0]?._from,
		).toContainEqual({
			podSelector: {
				matchLabels: { "app.kubernetes.io/name": "ingress" },
			},
		});
		await operations.promote(value);
		expect(
			fake.resources.has(`Ingress/${workloadResourceNameV1("agent-a")}`),
		).toBe(true);
	});

	it("scopes the entry NetworkPolicy to a cross-namespace route controller", async () => {
		const fake = fakeClient();
		const operations = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: { ...basePolicy, routeNamespace: "new-magic-infra" },
		});
		const value = desired();
		if (!isMultiService(value))
			throw new Error("multi-service fixture invalid");
		await operations.apply(value);
		const network = [...fake.resources.values()].find(
			(resource) =>
				resource.kind === "NetworkPolicy" &&
				resource.metadata?.name?.endsWith("-web-network"),
		) as V1NetworkPolicy | undefined;
		const routePeer = network?.spec?.ingress?.[0]?._from?.find(
			(peer) => peer.namespaceSelector !== undefined,
		);
		expect(routePeer).toEqual({
			namespaceSelector: {
				matchLabels: { "kubernetes.io/metadata.name": "new-magic-infra" },
			},
			podSelector: {
				matchLabels: { "app.kubernetes.io/name": "ingress" },
			},
		});
	});

	it("fails closed when an immutable ConfigMap is changed in place", async () => {
		const fake = fakeClient();
		const operations = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: {
				namespace: "agents",
				multiServiceResourceProfiles: [smallProfile],
				routeHostSuffix: "example.test",
				ingressClassName: "nginx",
				tlsSecretName: "tls",
				routeSelector: { "app.kubernetes.io/name": "ingress" },
			},
		});
		const value = desired();
		if (!isMultiService(value))
			throw new Error("multi-service fixture invalid");
		await operations.apply(value);
		const configMap = fake.resources.get(
			`ConfigMap/${workloadResourceNameV1("agent-a")}-web-config`,
		) as V1ConfigMap | undefined;
		if (!configMap) throw new Error("ConfigMap fixture missing");
		fake.resources.set(
			`ConfigMap/${workloadResourceNameV1("agent-a")}-web-config`,
			{
				...configMap,
				data: { "app.conf": "tampered=true\n" },
			} as V1ConfigMap,
		);
		await expect(operations.apply(value)).rejects.toThrow(
			"ConfigMap is immutable and drifted",
		);
	});

	it("hands resources across manifest revisions and rolls back without losing state", async () => {
		const fake = fakeClient();
		const operations = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: {
				namespace: "agents",
				multiServiceResourceProfiles: [smallProfile],
				routeHostSuffix: "example.test",
				ingressClassName: "nginx",
				tlsSecretName: "tls",
				routeSelector: { "app.kubernetes.io/name": "ingress" },
			},
		});
		const original = desired();
		const upgraded = desired(upgradedManifest);
		if (!isMultiService(original) || !isMultiService(upgraded))
			throw new Error("multi-service fixture invalid");
		await operations.apply(original);
		await operations.apply(upgraded, { allowOwnershipTransition: true });
		const upgradedDeployment = [...fake.resources.values()].find(
			(resource) =>
				resource.kind === "Deployment" &&
				resource.metadata?.name?.endsWith("-web"),
		) as V1Deployment | undefined;
		expect(upgradedDeployment?.spec?.template.spec?.containers[0]?.image).toBe(
			`sha256:${"e".repeat(64)}`,
		);
		expect(
			(
				fake.resources.get(
					`ConfigMap/${workloadResourceNameV1("agent-a")}-web-config`,
				) as V1ConfigMap
			)?.data,
		).toEqual({ "app.conf": "hello=upgraded\n" });
		await operations.apply(original, { allowOwnershipTransition: true });
		const rolledBackDeployment = [...fake.resources.values()].find(
			(resource) =>
				resource.kind === "Deployment" &&
				resource.metadata?.name?.endsWith("-web"),
		) as V1Deployment | undefined;
		expect(
			rolledBackDeployment?.spec?.template.spec?.containers[0]?.image,
		).toBe(`sha256:${"a".repeat(64)}`);
		expect(
			(
				fake.resources.get(
					`ConfigMap/${workloadResourceNameV1("agent-a")}-web-config`,
				) as V1ConfigMap
			)?.data,
		).toEqual({ "app.conf": "hello=world\n" });
	});

	it("keeps a StatefulSet PVC bound across an upgrade and rollback", async () => {
		const fake = fakeClient();
		const operations = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: {
				namespace: "agents",
				multiServiceResourceProfiles: [smallProfile],
				storageSize: "1Gi",
				routeHostSuffix: "example.test",
				ingressClassName: "nginx",
				tlsSecretName: "tls",
				routeSelector: { "app.kubernetes.io/name": "ingress" },
			},
		});
		const original = desired(statefulManifest);
		const upgradedStatefulManifest = MultiServiceManifestDocumentV1Schema.parse(
			{
				...statefulManifest,
				resources: statefulManifest.resources.map((resource) =>
					resource.kind === "StatefulSet"
						? {
								...resource,
								spec: {
									...resource.spec,
									template: {
										...resource.spec.template,
										spec: {
											...resource.spec.template.spec,
											containers: resource.spec.template.spec.containers.map(
												(container) => ({
													...container,
													image: `sha256:${"e".repeat(64)}`,
												}),
											),
										},
									},
								},
							}
						: resource,
				),
			},
		);
		const upgraded = desired(upgradedStatefulManifest);
		if (!isMultiService(original) || !isMultiService(upgraded))
			throw new Error("multi-service fixture invalid");
		await operations.apply(original);
		const pvcName = `${workloadResourceNameV1("agent-a")}-web-data`;
		const before = fake.resources.get(`PersistentVolumeClaim/${pvcName}`) as
			| V1PersistentVolumeClaim
			| undefined;
		if (!before) throw new Error("PVC fixture missing");
		await operations.apply(upgraded, { allowOwnershipTransition: true });
		const afterUpgrade = fake.resources.get(
			`PersistentVolumeClaim/${pvcName}`,
		) as V1PersistentVolumeClaim | undefined;
		expect(afterUpgrade?.metadata?.uid).toBe(before.metadata?.uid);
		await operations.apply(original, { allowOwnershipTransition: true });
		const afterRollback = fake.resources.get(
			`PersistentVolumeClaim/${pvcName}`,
		) as V1PersistentVolumeClaim | undefined;
		expect(afterRollback?.metadata?.uid).toBe(before.metadata?.uid);
	});

	it("mounts every StatefulSet on the PVC that apply created for it", async () => {
		const web = manifest.resources.find(
			(resource) =>
				resource.kind === "Deployment" && resource.metadata.name === "web",
		);
		const worker = manifest.resources.find(
			(resource) =>
				resource.kind === "Deployment" && resource.metadata.name === "worker",
		);
		if (web?.kind !== "Deployment" || worker?.kind !== "Deployment")
			throw new Error("stateful fixture missing");
		const pvc = (name: string) => ({
			apiVersion: "v1",
			kind: "PersistentVolumeClaim",
			metadata: { name: `${name}-data` },
			spec: {
				accessModes: ["ReadWriteOnce"],
				resources: { requests: { storage: "1Gi" } },
			},
		});
		const longName = "inventory-database-primary";
		const twoStateful = MultiServiceManifestDocumentV1Schema.parse({
			...manifest,
			resources: [
				{
					...web,
					kind: "StatefulSet",
					spec: { ...web.spec, serviceName: "web" },
				},
				{
					...worker,
					kind: "StatefulSet",
					metadata: { ...worker.metadata, name: longName },
					spec: { ...worker.spec, serviceName: "worker" },
				},
				...manifest.resources.filter(
					(resource) => resource !== web && resource !== worker,
				),
				pvc("web"),
				pvc(longName),
			],
		});
		for (const [source, count] of [
			[statefulManifest, 1],
			[twoStateful, 2],
		] as const) {
			const fake = fakeClient();
			const operations = createMultiServiceRuntimeOperations({
				client: fake.client,
				policy: { ...basePolicy, storageSize: "1Gi" },
			});
			const value = desired(source);
			if (!isMultiService(value))
				throw new Error("multi-service fixture invalid");
			await operations.apply(value);
			const statefulSets = [...fake.resources.values()].filter(
				(resource) => resource.kind === "StatefulSet",
			) as V1StatefulSet[];
			expect(statefulSets).toHaveLength(count);
			for (const set of statefulSets) {
				const claims = (set.spec?.template.spec?.volumes ?? []).flatMap(
					(volume) =>
						volume.persistentVolumeClaim
							? [volume.persistentVolumeClaim.claimName]
							: [],
				);
				expect(claims).toHaveLength(1);
				expect(fake.resources.has(`PersistentVolumeClaim/${claims[0]}`)).toBe(
					true,
				);
				expect(claims[0]?.length).toBeLessThanOrEqual(63);
			}
		}
	});

	it("reports pending while a workload has no available replica", async () => {
		const policy = {
			namespace: "agents",
			multiServiceResourceProfiles: [smallProfile],
			routeHostSuffix: "example.test",
			ingressClassName: "nginx",
			tlsSecretName: "tls",
			routeSelector: { "app.kubernetes.io/name": "ingress" },
		};
		for (const source of [manifest, statefulManifest]) {
			const fake = fakeClient();
			const operations = createMultiServiceRuntimeOperations({
				client: fake.client,
				policy: { ...policy, storageSize: "1Gi" },
			});
			const value = desired(source);
			if (!isMultiService(value))
				throw new Error("multi-service fixture invalid");
			const identity = await operations.apply(value);
			expect(await operations.observe(value, identity)).toBe("pending");
			markWorkloadsReady(fake);
			expect(await operations.observe(value, identity)).toBe("healthy");
			const workload = [...fake.resources.values()].find(
				(resource) =>
					resource.kind === "Deployment" || resource.kind === "StatefulSet",
			) as V1Deployment | V1StatefulSet | undefined;
			if (!workload) throw new Error("workload fixture missing");
			workload.status = { availableReplicas: 0, readyReplicas: 0, replicas: 1 };
			expect(await operations.observe(value, identity)).toBe("pending");
		}
	});

	it("emits bounded diagnostics for readiness and endpoint failures", async () => {
		const fake = fakeClient();
		const diagnostics: unknown[] = [];
		const operations = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: { ...basePolicy, storageSize: "1Gi" },
			onHealthDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		});
		const value = desired();
		if (!isMultiService(value)) throw new Error("multi-service fixture invalid");
		const identity = await operations.apply(value);
		await operations.observe(value, identity);
		expect(diagnostics[0]).toMatchObject({
			schemaVersion: 1,
			agentId: "agent-a",
			stage: "workload_not_ready",
		});
		expect(
			(diagnostics[0] as { workloads: { kind: string; name: string }[] }).workloads.some(
				(entry) => entry.kind === "Deployment" && entry.name.endsWith("-web"),
			),
		).toBe(true);
		markWorkloadsReady(fake);
		fake.resources.set(
			`Endpoints/${workloadResourceNameV1("agent-a")}-web`,
			{
				apiVersion: "v1",
				kind: "Endpoints",
				metadata: { name: `${workloadResourceNameV1("agent-a")}-web` },
				subsets: [{ addresses: [] }],
			} as V1Endpoints,
		);
		diagnostics.length = 0;
		expect(await operations.observe(value, identity)).toBe("pending");
		expect(diagnostics[0]).toMatchObject({ stage: "service_no_endpoints" });
		expect(
			(diagnostics[0] as { services: { name: string; endpointAddresses: number }[] }).services.some(
				(entry) => entry.name.endsWith("-web") && entry.endpointAddresses === 0,
			),
		).toBe(true);
	});

	it("runs a migration Job before services and reuses its completed result", async () => {
		const fake = fakeClient();
		const operations = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: {
				namespace: "agents",
				multiServiceResourceProfiles: [smallProfile],
				routeHostSuffix: "example.test",
				ingressClassName: "nginx",
				tlsSecretName: "tls",
				routeSelector: { "app.kubernetes.io/name": "ingress" },
			},
		});
		const value = desired(migrationManifest);
		if (!isMultiService(value))
			throw new Error("multi-service fixture invalid");
		const identity = await operations.apply(value);
		const job = [...fake.resources.values()].find(
			(resource) => resource.kind === "Job",
		) as V1Job | undefined;
		expect(job?.spec?.activeDeadlineSeconds).toBe(300);
		expect(job?.spec?.template?.spec?.restartPolicy).toBe("Never");
		expect(
			[...fake.resources.values()].some(
				(resource) => resource.kind === "Deployment",
			),
		).toBe(false);
		expect(await operations.observe(value, identity)).toBe("unreachable");
		if (!job) throw new Error("migration Job fixture missing");
		job.status = { succeeded: 1 };
		expect(await operations.observe(value, identity)).toBe("drifted");
		await operations.apply(value);
		expect(
			[...fake.resources.values()].some(
				(resource) => resource.kind === "Deployment",
			),
		).toBe(true);
		const completedJob = fake.resources.get(`Job/${job.metadata?.name}`);
		await operations.apply(value);
		expect(fake.resources.get(`Job/${job.metadata?.name}`)).toBe(completedJob);
	});

	it("fails closed when the migration Job reports failure", async () => {
		const fake = fakeClient();
		const operations = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: {
				namespace: "agents",
				multiServiceResourceProfiles: [smallProfile],
				routeHostSuffix: "example.test",
				ingressClassName: "nginx",
				tlsSecretName: "tls",
				routeSelector: { "app.kubernetes.io/name": "ingress" },
			},
		});
		const value = desired(migrationManifest);
		if (!isMultiService(value))
			throw new Error("multi-service fixture invalid");
		await operations.apply(value);
		const job = [...fake.resources.values()].find(
			(resource) => resource.kind === "Job",
		) as V1Job | undefined;
		if (!job) throw new Error("migration Job fixture missing");
		job.status = {
			failed: 1,
			conditions: [{ type: "Failed", status: "True" }],
		};
		expect(await operations.observe(value, { uid: "u", generation: 1 })).toBe(
			"unhealthy",
		);
		expect(
			[...fake.resources.values()].some(
				(resource) => resource.kind === "Deployment",
			),
		).toBe(false);
	});
});
