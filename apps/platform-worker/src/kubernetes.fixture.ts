import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	parseRuntimeManifestLabelV1,
	validateAgentWorkloadDesiredV1,
} from "@agent-infra/contracts/workload";
import type { ImageRegistryAdapterV1 } from "@agent-infra/image-registry";
import type {
	KubernetesObject,
	V1Pod,
	V1Secret,
	V1StatefulSet,
} from "@kubernetes/client-node";
import {
	type WorkerKubernetesClientV1,
	WorkloadKubernetesError,
	type WorkloadResourceKind,
} from "./kubernetes-client.js";
import {
	type KubernetesWorkloadPolicyV1,
	workloadResourceNameV1,
} from "./kubernetes-runtime-adapter.js";

export const workloadTestPolicy: KubernetesWorkloadPolicyV1 = {
	namespace: "workload-test",
	namespaceRef: "pilot",
	resourceProfileRef: "standard",
	storageProfileRef: "persistent",
	networkPolicyRef: "isolated",
	resources: {
		requests: { cpu: "25m", memory: "32Mi" },
		limits: { cpu: "100m", memory: "128Mi" },
	},
	storageSize: "64Mi",
	imageRepository: "registry.example.test/agent",
	workerSelector: { component: "worker" },
	routeNamespace: "routes",
	routeSelector: { component: "gateway" },
	ingressClassName: "test",
	routeHostSuffix: "agent.example.test",
	tlsSecretName: "workload-tls",
	platformAuthAnnotations: {
		"nginx.ingress.kubernetes.io/auth-url": "https://auth.example.test/verify",
	},
};

export function runtimeTlsBindingFixture(agentId: string) {
	const name = workloadResourceNameV1(agentId);
	return {
		agentId,
		namespace: workloadTestPolicy.namespace,
		serviceDnsNames: [
			`${name}.${workloadTestPolicy.namespace}.svc`,
			`${name}-probe.${workloadTestPolicy.namespace}.svc`,
		],
		serverSecretRef: { name: `runtime-tls-${name}` },
	};
}

// Real ephemeral serving material for adapter tests; fake probes do not prove CA trust.
const tlsMaterials = new Map<string, { cert: string; key: string }>();
export function runtimeTlsSecretFixture(
	name: string,
	agentId = "agent-a",
): V1Secret {
	let material = tlsMaterials.get(agentId);
	if (!material) {
		const directory = mkdtempSync(join(tmpdir(), "runtime-tls-fixture-"));
		try {
			const dnsNames = runtimeTlsBindingFixture(agentId).serviceDnsNames;
			writeFileSync(
				join(directory, "ext.cnf"),
				`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${dnsNames.map((dns) => `DNS:${dns}`).join(",")}\n`,
			);
			execFileSync(
				"openssl",
				[
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-nodes",
					"-days",
					"2",
					"-subj",
					"/CN=fixture-ca",
					"-keyout",
					"ca.key",
					"-out",
					"ca.crt",
				],
				{ cwd: directory, stdio: "ignore" },
			);
			execFileSync(
				"openssl",
				[
					"req",
					"-newkey",
					"rsa:2048",
					"-nodes",
					"-subj",
					"/CN=fixture-leaf",
					"-keyout",
					"tls.key",
					"-out",
					"tls.csr",
				],
				{ cwd: directory, stdio: "ignore" },
			);
			execFileSync(
				"openssl",
				[
					"x509",
					"-req",
					"-in",
					"tls.csr",
					"-CA",
					"ca.crt",
					"-CAkey",
					"ca.key",
					"-CAcreateserial",
					"-days",
					"2",
					"-extfile",
					"ext.cnf",
					"-out",
					"tls.crt",
				],
				{ cwd: directory, stdio: "ignore" },
			);
			material = {
				cert:
					readFileSync(join(directory, "tls.crt"), "utf8") +
					readFileSync(join(directory, "ca.crt"), "utf8"),
				key: readFileSync(join(directory, "tls.key"), "utf8"),
			};
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
		tlsMaterials.set(agentId, material);
	}
	return {
		apiVersion: "v1",
		kind: "Secret",
		metadata: { name, namespace: workloadTestPolicy.namespace },
		type: "kubernetes.io/tls",
		data: {
			"tls.crt": Buffer.from(material.cert).toString("base64"),
			"tls.key": Buffer.from(material.key).toString("base64"),
		},
	};
}

export function workloadRegistryFixture(
	manifest: unknown = {
		schemaVersion: 1,
		interactionMode: "self-managed",
		service: { port: 8080 },
		health: { path: "/healthz" },
	},
): ImageRegistryAdapterV1 {
	return {
		async admit(request) {
			const immutableDigest = request.imageReference.split("@")[1] ?? "";
			const runtimeManifestLabel = JSON.stringify(manifest);
			return {
				schemaVersion: 1,
				status: "admitted",
				requestId: request.requestId,
				traceId: request.traceId,
				immutableDigest,
				ociConfig: {
					schemaVersion: 1,
					configDigest: immutableDigest,
					operatingSystem: "linux",
					architecture: "amd64",
				},
				runtimeManifestLabel,
				...parseRuntimeManifestLabelV1(runtimeManifestLabel),
				policyEvidence: {
					schemaVersion: 1,
					policyRef: request.admissionPolicyRef,
					decisionRef: "fixture",
					subjectRef: request.subjectRef,
					agentId: request.agentId,
					imageDigest: immutableDigest,
					evaluatedAt: "2026-09-07T00:00:00Z",
				},
			};
		},
	};
}

export function workloadDesiredFixture(
	revision = 1,
	agentId = "agent-a",
	exposure: "self-managed" | "platform-auth" | "internal-only" = "self-managed",
) {
	const name = workloadResourceNameV1(agentId);
	const imageDigest = `sha256:${String(revision).repeat(64).slice(0, 64)}`;
	const runtimeManifest = {
		schemaVersion: 1,
		interactionMode:
			exposure === "internal-only" ? "platform-adapter" : "self-managed",
		...(exposure === "internal-only" ? { protocol: "acp" } : {}),
		service: { port: 8080 },
		health: { path: "/healthz" },
	};
	return validateAgentWorkloadDesiredV1({
		schemaVersion: 1,
		requestId: `request-${revision}`,
		traceId: "trace-a",
		agentId,
		configRevision: revision,
		workloadRevision: revision,
		fence: revision,
		expectedWorkload: { state: "absent" },
		namespaceRef: workloadTestPolicy.namespaceRef,
		desiredState: "running",
		replicas: 1,
		imageDigest,
		registryAdmission: {
			schemaVersion: 1,
			immutableDigest: imageDigest,
			runtimeManifest,
			policyEvidence: {
				schemaVersion: 1,
				policyRef: "policy-a",
				decisionRef: "decision-a",
				subjectRef: "subject-a",
				agentId,
				imageDigest,
				evaluatedAt: "2026-09-07T00:00:00Z",
			},
			runtimeManifestParsingEvidence: {
				schemaVersion: 1,
				labelName: "io.agora.agent.runtime.manifest",
				utf8ByteLength: 128,
				maxDepth: 3,
				duplicateKeysDetected: false,
				unknownFieldsDetected: false,
			},
		},
		runtimeManifest,
		resourceProfileRef: workloadTestPolicy.resourceProfileRef,
		env: { LOG_LEVEL: "info" },
		service: { name, port: 8080 },
		health: { path: "/healthz", timeoutSeconds: 5, failureThreshold: 3 },
		persistentVolume: {
			name: `${name}-data`,
			mountPath: "/workspace",
			storageProfileRef: workloadTestPolicy.storageProfileRef,
			accessMode: "ReadWriteOnce",
			retention: "retain",
		},
		serviceAccount: { name, kubernetesApiAccess: false },
		networkPolicy: {
			deploymentPolicyRef: workloadTestPolicy.networkPolicyRef,
			ingressMode:
				exposure === "internal-only"
					? "runtime-host-client-only"
					: exposure === "platform-auth"
						? "platform-auth-route"
						: "self-managed-route",
			kubernetesApiAccess: false,
			platformDatabaseAccess: false,
			connectionDatabaseAccess: false,
			decryptionKeyringAccess: false,
		},
		route: { name, exposure, tlsRequired: true },
		secretRefs: [],
	});
}

export function fakeKubernetesApi() {
	const resources = new Map<string, KubernetesObject>();
	const writes: KubernetesObject[] = [];
	let version = 0;
	let failAt = -1;
	let writeCount = 0;
	let lostDeleteTarget: string | undefined;
	let lostDelete: KubernetesObject | undefined;
	function resourceKey(object: KubernetesObject) {
		return `${object.kind}/${object.metadata?.name}`;
	}
	function checkDelete(object: KubernetesObject) {
		const current = resources.get(resourceKey(object));
		if (
			!current ||
			object.metadata?.resourceVersion !== current.metadata?.resourceVersion ||
			object.metadata?.uid !== current.metadata?.uid
		)
			throw new WorkloadKubernetesError("conflict");
	}
	function deleteResource(object: KubernetesObject) {
		checkDelete(object);
		resources.delete(resourceKey(object));
		if (object.kind === "StatefulSet")
			resources.delete(`Pod/${object.metadata?.name}-0`);
	}
	function save<T extends KubernetesObject>(object: T, existing?: T): T {
		if (++writeCount === failAt)
			throw new WorkloadKubernetesError("unavailable");
		const updated = structuredClone(object);
		updated.metadata = {
			...updated.metadata,
			uid: existing?.metadata?.uid ?? `uid-${++version}`,
			resourceVersion: String(++version),
			generation: existing?.metadata?.generation ?? 1,
		};
		if (
			existing &&
			!isDeepStrictEqual(
				(existing as V1StatefulSet).spec,
				(updated as V1StatefulSet).spec,
			)
		)
			updated.metadata.generation = (existing.metadata?.generation ?? 1) + 1;
		if (updated.kind === "StatefulSet") {
			const workload = updated as V1StatefulSet;
			const templateSpec = workload.spec?.template.spec;
			if (!templateSpec) throw new WorkloadKubernetesError("policy");
			workload.status = {
				observedGeneration: updated.metadata.generation,
				readyReplicas: workload.spec?.replicas ?? 0,
				replicas: workload.spec?.replicas ?? 0,
			};
			const podName = `${object.metadata?.name}-0`;
			if (workload.spec?.replicas) {
				const pod: V1Pod = {
					apiVersion: "v1",
					kind: "Pod",
					metadata: {
						...workload.spec.template.metadata,
						namespace: updated.metadata.namespace,
						name: podName,
						uid: `pod-${version}`,
						ownerReferences: [
							{
								apiVersion: "apps/v1",
								kind: "StatefulSet",
								name: workload.metadata?.name ?? "",
								uid: updated.metadata.uid ?? "",
								controller: true,
								blockOwnerDeletion: true,
							},
						],
					},
					spec: {
						...templateSpec,
						hostname: podName,
						subdomain: workload.spec.serviceName,
					},
					status: {
						podIP: "10.244.0.10",
						conditions: [{ type: "Ready", status: "True" }],
					},
				};
				resources.set(`Pod/${podName}`, pod);
			} else resources.delete(`Pod/${podName}`);
		}
		resources.set(`${updated.kind}/${updated.metadata.name}`, updated);
		writes.push(structuredClone(updated));
		return structuredClone(updated);
	}
	const client: WorkerKubernetesClientV1 = {
		namespace: workloadTestPolicy.namespace,
		async read<T extends KubernetesObject>(
			kind: WorkloadResourceKind,
			name: string,
		) {
			return structuredClone(
				resources.get(`${kind}/${name}`) ?? null,
			) as T | null;
		},
		async list<T extends KubernetesObject>(
			kind: WorkloadResourceKind,
			selector: string,
		) {
			const [key, value] = selector.split("=");
			return structuredClone(
				[...resources.values()].filter(
					(object) =>
						object.kind === kind &&
						key &&
						object.metadata?.labels?.[key] === value,
				),
			) as T[];
		},
		async create<T extends KubernetesObject>(object: T) {
			if (resources.has(`${object.kind}/${object.metadata?.name}`))
				throw new WorkloadKubernetesError("conflict");
			return save(object);
		},
		async replace<T extends KubernetesObject>(object: T) {
			const old = resources.get(`${object.kind}/${object.metadata?.name}`) as
				| T
				| undefined;
			if (
				!old ||
				old.metadata?.resourceVersion !== object.metadata?.resourceVersion ||
				old.metadata?.uid !== object.metadata?.uid
			)
				throw new WorkloadKubernetesError("conflict");
			return save(object, old);
		},
		async delete(object) {
			const key = resourceKey(object);
			if (lostDeleteTarget === key) {
				// The client loses the response after submitting this legal delete.
				// Its UID/resourceVersion preconditions are evaluated only when the
				// simulated API server later completes the captured request.
				checkDelete(object);
				lostDelete = structuredClone(object);
				lostDeleteTarget = undefined;
				throw new WorkloadKubernetesError("unavailable");
			}
			if (++writeCount === failAt)
				throw new WorkloadKubernetesError("unavailable");
			deleteResource(object);
		},
	};
	return {
		client,
		resources,
		writes,
		seed(object: KubernetesObject) {
			resources.set(resourceKey(object), structuredClone(object));
		},
		failAfter(writes: number) {
			failAt = writeCount + writes;
		},
		loseNextDelete(kind: WorkloadResourceKind, name: string) {
			lostDeleteTarget = `${kind}/${name}`;
		},
		deferredDelete() {
			return structuredClone(lostDelete);
		},
		async completeDeferredDelete() {
			if (!lostDelete) throw new Error("no deferred delete");
			const request = lostDelete;
			lostDelete = undefined;
			deleteResource(request);
		},
	};
}
