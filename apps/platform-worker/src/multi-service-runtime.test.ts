import { MultiServiceManifestDocumentV1Schema } from "@agent-infra/contracts/pilot";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import type { KubernetesObject } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import type { WorkerKubernetesClientV1 } from "./kubernetes-client.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-comparison.js";
import {
	createMultiServiceRuntimeOperations,
	isMultiService,
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
						containers: [
							{
								name: "web",
								image: `sha256:${"a".repeat(64)}`,
								ports: [{ name: "http", port: 8080, targetPort: 8080 }],
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
				annotations: { "agent-infra.agora.io/entry": "true" },
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
			metadata: { name: "worker" },
			spec: {
				type: "ClusterIP",
				selector: { app: "worker" },
				ports: [{ name: "http", port: 8080, targetPort: 8080 }],
			},
		},
	],
});

const statefulManifest = MultiServiceManifestDocumentV1Schema.parse({
	schemaVersion: 1,
	entryServiceName: "web",
	resources: [
		manifest.resources[0],
		{
			apiVersion: "apps/v1",
			kind: "StatefulSet",
			metadata: { name: "worker" },
			spec: {
				replicas: 1,
				serviceName: "worker",
				selector: { matchLabels: { app: "worker" } },
				template: {
					metadata: { labels: { app: "worker" } },
					spec: {
						containers: [{ name: "worker", image: `sha256:${"b".repeat(64)}` }],
					},
				},
			},
		},
		manifest.resources[2],
		manifest.resources[3],
		{
			apiVersion: "v1",
			kind: "PersistentVolumeClaim",
			metadata: { name: "worker-data" },
			spec: {
				accessModes: ["ReadWriteOnce"],
				resources: { requests: { storage: "100Gi" } },
			},
		},
	],
});

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
		async list() {
			return [];
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

describe("multi-service runtime operations", () => {
	it("injects ownership, service accounts, network isolation and entry route", async () => {
		const fake = fakeClient();
		const operations = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: {
				namespace: "agents",
				imageRepository: "registry.example.test/agents",
				storageSize: "1Gi",
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
		);
		expect(deployment?.metadata?.labels?.["agent-infra.agora.io/agent"]).toBe(
			workloadResourceNameV1("agent-a"),
		);
		expect(
			fake.resources.has(`ServiceAccount/${workloadResourceNameV1("agent-a")}`),
		).toBe(true);
		const network = [...fake.resources.values()].find(
			(resource) => resource.kind === "NetworkPolicy",
		);
		expect(
			network?.metadata?.annotations?.["agent-infra.agora.io/spec-hash"],
		).toBeTypeOf("string");
		await operations.promote(value);
		expect(
			fake.resources.has(`Ingress/${workloadResourceNameV1("agent-a")}`),
		).toBe(true);
	});

	it("reconciles a StatefulSet with a policy-owned PVC and retains it on stop", async () => {
		const fake = fakeClient();
		const operations = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: {
				namespace: "agents",
				imageRepository: "registry.example.test/agents",
				storageSize: "1Gi",
				storageClassName: "platform",
				routeHostSuffix: "example.test",
				ingressClassName: "nginx",
				tlsSecretName: "tls",
				routeSelector: { "app.kubernetes.io/name": "ingress" },
			},
		});
		const value = desired(statefulManifest);
		if (!isMultiService(value))
			throw new Error("multi-service fixture invalid");

		await operations.apply(value);
		const statefulSet = fake.resources.get(
			`StatefulSet/${workloadResourceNameV1("agent-a")}-worker`,
		) as {
			spec?: {
				template?: {
					spec?: {
						containers?: Array<{ image?: string; volumeMounts?: unknown[] }>;
					};
				};
			};
		};
		const pvc = fake.resources.get(
			`PersistentVolumeClaim/${workloadResourceNameV1("agent-a")}-worker-data`,
		) as {
			spec?: {
				resources?: { requests?: { storage?: string } };
				storageClassName?: string;
			};
		};
		expect(pvc.spec?.resources?.requests?.storage).toBe("1Gi");
		expect(pvc.spec?.storageClassName).toBe("platform");
		const pvcUid = (
			fake.resources.get(
				`PersistentVolumeClaim/${workloadResourceNameV1("agent-a")}-worker-data`,
			) as { metadata?: { uid?: string } }
		).metadata?.uid;
		expect(statefulSet.spec?.template?.spec?.containers?.[0]?.image).toBe(
			`registry.example.test/agents@sha256:${"b".repeat(64)}`,
		);
		expect(
			statefulSet.spec?.template?.spec?.containers?.[0]?.volumeMounts,
		).toEqual([{ name: "data", mountPath: "/data" }]);

		expect(await operations.scaleDown(value)).toBe("pending");
		expect(
			(
				fake.resources.get(
					`StatefulSet/${workloadResourceNameV1("agent-a")}-worker`,
				) as { spec?: { replicas?: number } }
			).spec?.replicas,
		).toBe(0);
		expect(await operations.cleanupAgent(value)).toBe(true);
		expect(
			fake.resources.has(
				`PersistentVolumeClaim/${workloadResourceNameV1("agent-a")}-worker-data`,
			),
		).toBe(true);
		await operations.apply(value);
		expect(
			(
				fake.resources.get(
					`PersistentVolumeClaim/${workloadResourceNameV1("agent-a")}-worker-data`,
				) as { metadata?: { uid?: string } }
			).metadata?.uid,
		).toBe(pvcUid);
		expect(await operations.cleanupAgent(value, true)).toBe(true);
		expect(
			fake.resources.has(
				`PersistentVolumeClaim/${workloadResourceNameV1("agent-a")}-worker-data`,
			),
		).toBe(false);
	});

	it("rejects an owned PVC that drifts from the platform storage tier", async () => {
		const fake = fakeClient();
		const operations = createMultiServiceRuntimeOperations({
			client: fake.client,
			policy: {
				namespace: "agents",
				imageRepository: "registry.example.test/agents",
				storageSize: "1Gi",
				storageClassName: "platform",
				routeHostSuffix: "example.test",
				ingressClassName: "nginx",
				tlsSecretName: "tls",
				routeSelector: { "app.kubernetes.io/name": "ingress" },
			},
		});
		const value = desired(statefulManifest);
		if (!isMultiService(value))
			throw new Error("multi-service fixture invalid");
		await operations.apply(value);
		const pvcName = `PersistentVolumeClaim/${workloadResourceNameV1("agent-a")}-worker-data`;
		const pvc = fake.resources.get(pvcName);
		if (!pvc) throw new Error("PVC fixture missing");
		(
			pvc as { spec: { resources: { requests: { storage: string } } } }
		).spec.resources.requests.storage = "100Gi";
		await expect(operations.apply(value)).rejects.toThrow(
			"multi-service PVC drifted",
		);
	});
});
