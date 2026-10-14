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

function desired() {
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
		multiService: manifest,
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
});
