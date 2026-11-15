import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImageRegistryAdapterV1 } from "@agent-infra/image-registry";
import {
	type AgentConfigurationRecordV2,
	createWorkloadReconciliationV1,
	type WorkloadReconciliationInputV1,
	type WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import type { V1StatefulSet } from "@kubernetes/client-node";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	urls: [] as string[],
	observations: [] as unknown[],
	reads: 0,
	closes: 0,
	snapshotRead: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("@agent-infra/platform-store", async (original) => {
	const next = () =>
		structuredClone(
			store.observations[
				Math.min(store.reads++, store.observations.length - 1)
			],
		) as {
			management: unknown;
			configuration: unknown;
			state: unknown;
		};
	let pending: ReturnType<typeof next> | undefined;
	const current = () => {
		pending ??= next();
		return pending;
	};
	return {
		...(await original<typeof import("@agent-infra/platform-store")>()),
		PostgresAgentManagementQueryV1: class {
			constructor(options: { databaseUrl: string }) {
				store.urls.push(options.databaseUrl);
			}
			async getAgent() {
				return { management: current().management };
			}
			async close() {
				store.closes++;
			}
		},
		PostgresAgentConfigurationQueryV1: class {
			constructor(options: { databaseUrl: string }) {
				store.urls.push(options.databaseUrl);
			}
			async read() {
				return { outcome: "found", configuration: current().configuration };
			}
			async close() {
				store.closes++;
			}
		},
		openPostgresWorkloadStateReaderV1: (options: { databaseUrl: string }) => {
			store.urls.push(options.databaseUrl);
			return {
				async readCurrentState() {
					const value = current().state;
					pending = undefined;
					return value;
				},
				async close() {
					store.closes++;
				},
			};
		},
		openPostgresWorkspaceSnapshotMaterializationReaderV1: (url: string) => {
			store.urls.push(url);
			return {
				read: store.snapshotRead,
				async close() {
					store.closes++;
				},
			};
		},
	};
});

import {
	fakeKubernetesApi,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-adapter.js";
import { sessionSandboxRuntimeAuthFixture } from "./test-support/session-sandbox-v4.js";
import {
	type AgentWorkloadImageAuthorityV1,
	agentWorkloadImagePolicyHashV1,
	projectAgentWorkloadUpgradeImagesV1,
	readWorkerAgentWorkloadDemandImagesV1,
	type WorkerAgentWorkloadDemandImageDeploymentV1,
} from "./worker-agent-workload-demand-images.js";
import {
	createWorkloadRuntimeV1,
	type WorkloadRuntimeOptionsV1,
	workloadResourceConfigurationHashV1,
} from "./workload-runtime.js";
import { createWorkspaceSnapshotResolverV1 } from "./workspace-snapshot-resolver.js";

const agentId = "agent-a";
const oldDigest = `sha256:${"7".repeat(64)}`;
const newDigest = `sha256:${"4".repeat(64)}`;
const materializerImage = `registry.example.test/materializer@sha256:${"c".repeat(64)}`;
const policy: WorkloadRuntimeOptionsV1["policy"] = {
	...workloadTestPolicy,
	imagePullSecretName: "ack-ghcr-pull",
	workspaceSnapshotEgress: [
		{
			destination: { namespace: "storage", podLabels: { app: "storage" } },
			port: 9000,
		},
	],
};
const proposal = {
	schemaVersion: 1 as const,
	command: "upgrade_custom_image" as const,
	imageReference: `${policy.imageRepository}@${newDigest}`,
};
const recordA = {
	snapshotId: "snapshot-a",
	name: "repo",
	digest: `sha256:${"a".repeat(64)}`,
	sizeBytes: 10,
	objectRef: "PRIVATE_OBJECT_A",
	objectVersion: "private-version-a",
};
const recordB = {
	snapshotId: "snapshot-b",
	name: "docs",
	digest: `sha256:${"b".repeat(64)}`,
	sizeBytes: 20,
	objectRef: "PRIVATE_OBJECT_B",
	objectVersion: "private-version-b",
};
const records = [recordA, recordB];
const manifest = {
	schemaVersion: 1,
	interactionMode: "self-managed",
	service: { port: 3003 },
	health: { path: "/healthz" },
};

function resolver() {
	return createWorkspaceSnapshotResolverV1({
		read: async () => records,
		createReadUrl: async ({ objectRef }) => ({
			signedUrl: `https://objects.example.test/${objectRef}?signature=PRIVATE_SIGNATURE`,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		}),
		policy: {
			imageDigest: materializerImage,
			allowedOrigins: ["https://objects.example.test"],
			cacheSizeLimit: "2Gi",
			credentialSecretName: "snapshot-credentials",
			resources: {
				requests: { cpu: "100m", memory: "128Mi" },
				limits: { cpu: "1", memory: "512Mi" },
			},
		},
		allowedOrigins: ["https://objects.example.test"],
	});
}

function configurationRecord(
	digest = oldDigest,
	revision = 1,
): AgentConfigurationRecordV2 {
	return {
		schemaVersion: 2,
		channels: [],
		channelRevision: "channels-a",
		agentId,
		revision,
		modelConfiguration: null,
		secrets: [],
		environment: [{ name: "LOG_LEVEL", value: "PRIVATE_ENV_VALUE" }],
		source: {
			kind: "custom",
			imageDigest: digest,
			admissionRevision: `admission-${revision}`,
			interactionMode: "self-managed",
			identityResponsibility: "self-managed",
			connectionEnabled: false,
			workspaceSnapshots: [
				{ snapshotId: "snapshot-a", name: "repo" },
				{ snapshotId: "snapshot-b", name: "docs" },
			],
		},
	};
}

/** The Store's management configuration projection of the same record. */
function storeConfiguration(record: AgentConfigurationRecordV2) {
	if (record.source.kind !== "custom") throw new Error("custom only");
	return {
		agentId,
		revision: record.revision,
		source: {
			kind: "custom",
			interactionMode: record.source.interactionMode,
			identityResponsibility: record.source.identityResponsibility,
			workspaceSnapshots: record.source.workspaceSnapshots,
			connectionEnabled: false,
		},
		ownerIds: ["PRIVATE_OWNER_ID"],
		availability: [],
		modelOptions: [],
		defaultModelOptionId: null,
		defaultReasoningLevel: null,
		environment: record.environment,
		channelKinds: [],
		secrets: [],
	};
}

const management: WorkloadReconciliationInputV1["management"] = {
	schemaVersion: 1,
	agentId,
	applicationId: "application-a",
	applicantId: "PRIVATE_OWNER_ID",
	ownerIds: ["PRIVATE_OWNER_ID"],
	availability: [],
	decisionReason: null,
	revision: 16,
	workloadRevision: 1,
	fence: 1,
	status: "available",
	desiredState: "running",
	serviceAvailability: "ready",
	approvalRevision: 1,
	failureCode: null,
};

/** The normal Workload reconciler, run to completion against a fake cluster. */
async function reconciler(registry: ImageRegistryAdapterV1) {
	const api = fakeKubernetesApi();
	let configuration = configurationRecord();
	let state: WorkloadReconciliationStateV1 | null = null;
	const options: WorkloadRuntimeOptionsV1 = {
		templateModelBindings: [],
		workerId: "worker-a",
		client: api.client,
		policy,
		registry,
		admissionPolicyRef: "policy-a",
		registrySubjectRef: "subject-a",
		decryptor: {
			decrypt: async () => ({
				outcome: "failed",
				code: "SECRET_KEY_UNAVAILABLE",
			}),
		},
		fetch: vi.fn(async () => new Response("ok")),
		probeRuntime: async () => ({ core: "passed", capabilities: {} }),
		workspaceSnapshotResolver: resolver(),
	};
	async function tick(times: number) {
		for (let index = 0; index < times; index++)
			await createWorkloadReconciliationV1({
				runtime: createWorkloadRuntimeV1(options),
				maximumAttempts: 2,
				store: {
					async runNext(_workerId, step) {
						state = await step({
							state,
							configuration,
							management,
							requestId: "request-a",
							traceId: "trace-a",
						});
						return "advanced";
					},
				},
			}).tick("worker-a");
	}
	return {
		...api,
		tick,
		get state() {
			return state;
		},
		setConfiguration(next: AgentConfigurationRecordV2) {
			configuration = next;
		},
		async statefulSet() {
			const value = await api.client.read<V1StatefulSet>(
				"StatefulSet",
				workloadResourceNameV1(agentId),
			);
			const spec = value?.spec?.template.spec;
			if (!spec) throw new Error("missing StatefulSet");
			return spec;
		},
	};
}

function authority(
	snapshotResolver:
		| WorkloadRuntimeOptionsV1["workspaceSnapshotResolver"]
		| null = resolver(),
): AgentWorkloadImageAuthorityV1 {
	return {
		sourceSha: "4".repeat(40),
		configurationHash: "f".repeat(64),
		resourceConfigurationHash: workloadResourceConfigurationHashV1(policy),
		imagePolicyHash: agentWorkloadImagePolicyHashV1({
			policy,
			workspaceSnapshotResolver: snapshotResolver ?? undefined,
			admissionPolicyRef: "policy-a",
			registrySubjectRef: "subject-a",
		}),
		contextHash: "d".repeat(64),
		policy,
		...(snapshotResolver
			? { workspaceSnapshotResolver: snapshotResolver }
			: {}),
		admissionPolicyRef: "policy-a",
		registrySubjectRef: "subject-a",
	};
}

/** Current c549-shaped Store state: reconciled old image with two snapshots. */
async function currentObservation() {
	const runtime = await reconciler(workloadRegistryFixture(manifest));
	await runtime.tick(12);
	expect(runtime.state?.phase).toBe("ready");
	return {
		runtime,
		observed: {
			management: structuredClone(management),
			configuration: storeConfiguration(configurationRecord()),
			state: structuredClone(runtime.state),
		},
	};
}

function snapshotReader() {
	return {
		read: vi.fn(async () => records.map((record) => ({ ...record }))),
	};
}

function images(
	spec: Awaited<
		ReturnType<Awaited<ReturnType<typeof reconciler>>["statefulSet"]>
	>,
) {
	return [...spec.containers, ...(spec.initContainers ?? [])].map(
		(container) => ({
			name: container.name,
			image: container.image,
			imagePullPolicy: container.imagePullPolicy ?? null,
		}),
	);
}

it("predicts exactly the parent images the normal reconciler renders after the Owner upgrade", async () => {
	const { runtime, observed } = await currentObservation();
	const before = await runtime.statefulSet();
	const registry = workloadRegistryFixture(manifest);
	const admit = vi.spyOn(registry, "admit");
	const snapshots = snapshotReader();
	const writes = runtime.writes.length;
	const result = await projectAgentWorkloadUpgradeImagesV1({
		authority: authority(),
		target: { agentId, proposal },
		observed,
		registry: () => registry,
		snapshots,
	});
	expect(result).toMatchObject({
		status: "PROJECTED_IMAGES",
		reason: null,
		resourceKind: "StatefulSet",
		resourceName: workloadResourceNameV1(agentId),
		mainImage: proposal.imageReference,
		currentMainImage: `${policy.imageRepository}@${oldDigest}`,
		auxiliaryImages: [materializerImage],
		podIdentity: {
			namespace: policy.namespace,
			serviceAccountName: workloadResourceNameV1(agentId),
			imagePullSecrets: ["ack-ghcr-pull"],
			nodeSelector: {},
			tolerations: [],
			affinity: null,
			runtimeClassName: null,
		},
		retained: {
			configurationRevisionBasis: 1,
			routeExposure: "self-managed",
			routeExposureUnchanged: true,
			environmentUnchanged: true,
			environmentKeyCount: 1,
			workspaceSnapshotCount: 2,
			workspaceSnapshotsUnchanged: true,
			mainEntrypointSource: "image-default-unverified",
		},
		admission: { immutableDigest: newDigest, servicePort: 3003 },
		snapshotStatus: "BOUND_METADATA_UNSIGNED_PROJECTION",
	});
	expect(admit).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({
			agentId,
			imageReference: proposal.imageReference,
			usage: "custom-agent",
			admissionPolicyRef: "policy-a",
			subjectRef: "subject-a",
		}),
		expect.anything(),
	);
	expect(snapshots.read).toHaveBeenCalledExactlyOnceWith({
		agentId,
		configurationRevision: 1,
		workloadRevision: runtime.state?.revision,
		fence: runtime.state?.fence,
		bindings: [
			{ snapshotId: "snapshot-a", name: "repo" },
			{ snapshotId: "snapshot-b", name: "docs" },
		],
	});
	// The preview neither writes the cluster nor changes the Store state.
	expect(runtime.writes).toHaveLength(writes);
	expect(runtime.state).toEqual(observed.state);

	// Domain's normal Owner upgrade, then the normal reconciler.
	runtime.setConfiguration(configurationRecord(newDigest, 2));
	await runtime.tick(16);
	expect(runtime.state?.phase).toBe("ready");
	const after = await runtime.statefulSet();
	expect(
		result.status === "PROJECTED_IMAGES" &&
			result.images.map(({ name, image, imagePullPolicy }) => ({
				name,
				image,
				imagePullPolicy,
			})),
	).toEqual(images(after));
	expect(images(after).map((value) => value.image)).toEqual([
		proposal.imageReference,
		materializerImage,
	]);
	expect(after.imagePullSecrets).toEqual([{ name: "ack-ghcr-pull" }]);
	for (const field of [
		"nodeSelector",
		"tolerations",
		"affinity",
		"runtimeClassName",
	] as const)
		expect(after[field]).toBeUndefined();
	// Command/args/env of the retained main container are unchanged.
	for (const spec of [before, after]) {
		expect(spec.containers[0]?.command).toBeUndefined();
		expect(spec.containers[0]?.args).toBeUndefined();
	}
	expect(after.containers[0]?.env).toEqual(before.containers[0]?.env);
	expect(after.initContainers?.[0]?.command).toEqual(
		before.initContainers?.[0]?.command,
	);
	expect(JSON.stringify(result)).not.toMatch(
		/PRIVATE_(ENV|OBJECT|OWNER|SIGNATURE)|private-version|snapshot-credentials|"env"|"volumes"/,
	);
});

it("holds the result on Store CAS, owner, configuration and policy drift", async () => {
	const { observed } = await currentObservation();
	const registry = workloadRegistryFixture(manifest);
	const input = {
		authority: authority(),
		target: { agentId, proposal },
		observed,
		registry: () => registry,
		snapshots: snapshotReader(),
	};
	const projected = await projectAgentWorkloadUpgradeImagesV1(input);
	if (projected.status !== "PROJECTED_IMAGES") throw new Error("projected");
	const casHash = projected.cas?.casHash;
	expect(casHash).toMatch(/^[a-f0-9]{64}$/);
	expect(
		await projectAgentWorkloadUpgradeImagesV1({
			...input,
			target: { ...input.target, casHash },
		}),
	).toMatchObject({ status: "PROJECTED_IMAGES" });
	const revisionDrift = {
		...observed,
		configuration: { ...observed.configuration, revision: 2 },
	};
	const drifts = [
		{
			...observed,
			configuration: {
				...observed.configuration,
				ownerIds: ["PRIVATE_OWNER_ID", "other-owner"],
			},
		},
		{ ...observed, management: { ...management, revision: 17 } },
		revisionDrift,
	];
	for (const value of drifts)
		expect(
			await projectAgentWorkloadUpgradeImagesV1({
				...input,
				target: { ...input.target, casHash },
				observed: value,
			}),
		).toMatchObject({ status: "CAS_CHANGED", images: [] });
	// Without a caller CAS the authoritative current data still has to correlate.
	for (const [value, reason] of [
		[revisionDrift, "CURRENT_DESIRED_UNAVAILABLE"],
		[
			{
				...observed,
				configuration: {
					...observed.configuration,
					environment: [{ name: "LOG_LEVEL", value: "changed" }],
				},
			},
			"CURRENT_DESIRED_UNAVAILABLE",
		],
		[{ ...observed, state: null }, "CURRENT_DESIRED_UNAVAILABLE"],
		[
			{ ...observed, management: { ...management, desiredState: "unknown" } },
			"STORE_STATE_INCOMPLETE",
		],
	] as const)
		expect(
			await projectAgentWorkloadUpgradeImagesV1({ ...input, observed: value }),
		).toMatchObject({ status: "UNKNOWN", reason, images: [] });
	const imagePolicyHash = input.authority.imagePolicyHash;
	expect(
		await projectAgentWorkloadUpgradeImagesV1({
			...input,
			target: { ...input.target, imagePolicyHash },
		}),
	).toMatchObject({ status: "PROJECTED_IMAGES" });
	for (const changed of [
		{ ...policy, imagePullSecretName: "other-pull" },
		{ ...policy, skillDeliveryImage: materializerImage },
		{ ...policy, workspaceSnapshotEgress: undefined },
	])
		expect(
			await projectAgentWorkloadUpgradeImagesV1({
				...input,
				authority: {
					...input.authority,
					policy: changed,
					imagePolicyHash: agentWorkloadImagePolicyHashV1({
						policy: changed,
						workspaceSnapshotResolver:
							input.authority.workspaceSnapshotResolver,
						admissionPolicyRef: "policy-a",
						registrySubjectRef: "subject-a",
					}),
				},
				target: { ...input.target, imagePolicyHash },
			}),
		).toMatchObject({
			status: "UNKNOWN",
			reason: "POLICY_CHANGED",
			images: [],
		});
});

it("binds complete platform-auth annotation entries into the image policy hash", async () => {
	const { observed } = await currentObservation();
	const registry = workloadRegistryFixture(manifest);
	const snapshotResolver = resolver();
	const hashFor = (value: typeof policy) =>
		agentWorkloadImagePolicyHashV1({
			policy: value,
			workspaceSnapshotResolver: snapshotResolver,
			admissionPolicyRef: "policy-a",
			registrySubjectRef: "subject-a",
		});
	const authUrl = "nginx.ingress.kubernetes.io/auth-url";
	const signIn = "nginx.ingress.kubernetes.io/auth-signin";
	const bound = {
		...policy,
		platformAuthAnnotations: {
			[authUrl]: "https://auth.example.test/verify",
			[signIn]: "https://auth.example.test/sign-in",
		},
	};
	const imagePolicyHash = hashFor(bound);
	const project = (value: typeof policy) =>
		projectAgentWorkloadUpgradeImagesV1({
			authority: {
				...authority(snapshotResolver),
				policy: value,
				imagePolicyHash: hashFor(value),
			},
			target: { agentId, proposal, imagePolicyHash },
			observed,
			registry: () => registry,
			snapshots: snapshotReader(),
		});
	expect(await project(bound)).toMatchObject({ status: "PROJECTED_IMAGES" });
	// Insertion order alone keeps the bound hash.
	const reordered = {
		...policy,
		platformAuthAnnotations: {
			[signIn]: "https://auth.example.test/sign-in",
			[authUrl]: "https://auth.example.test/verify",
		},
	};
	expect(hashFor(reordered)).toBe(imagePolicyHash);
	expect(await project(reordered)).toMatchObject({
		status: "PROJECTED_IMAGES",
	});
	// The same keys with another value change the platform-auth Ingress.
	const changed = {
		...policy,
		platformAuthAnnotations: {
			[authUrl]: "https://PRIVATE_AUTH.example.test/verify",
			[signIn]: "https://auth.example.test/sign-in",
		},
	};
	expect(Object.keys(changed.platformAuthAnnotations).sort()).toEqual(
		Object.keys(bound.platformAuthAnnotations).sort(),
	);
	expect(hashFor(changed)).not.toBe(imagePolicyHash);
	const result = await project(changed);
	expect(result).toMatchObject({
		status: "UNKNOWN",
		reason: "POLICY_CHANGED",
		images: [],
	});
	expect(JSON.stringify(result)).not.toContain("PRIVATE_AUTH");
});

it("rejects upgrade drift outside normal repository, Registry and policy admission", async () => {
	const { observed } = await currentObservation();
	const base = {
		authority: authority(),
		target: { agentId, proposal },
		observed,
		snapshots: snapshotReader(),
	};
	const rejected: ImageRegistryAdapterV1 = {
		async admit(request) {
			return {
				schemaVersion: 1,
				status: "rejected",
				requestId: request.requestId,
				traceId: request.traceId,
				error: {
					schemaVersion: 1,
					code: "IMAGE_NOT_ADMITTED",
					message: "The image is not admitted by deployment policy",
					retryable: false,
					traceId: request.traceId,
				},
			};
		},
	};
	const unavailable: ImageRegistryAdapterV1 = {
		async admit() {
			throw new Error("PRIVATE_REGISTRY_TOKEN");
		},
	};
	const admitted = workloadRegistryFixture(manifest);
	const admit = vi.spyOn(admitted, "admit");
	const otherRepository = {
		...proposal,
		imageReference: `ghcr.io/agoraio-extensions/agent-infra/other@${newDigest}`,
	};
	for (const [change, reason] of [
		[
			{ target: { agentId, proposal: otherRepository } },
			"PROPOSAL_REPOSITORY_NOT_DEPLOYMENT_REPOSITORY",
		],
		[{ registry: () => rejected }, "REGISTRY_ADMISSION_REJECTED"],
		[{ registry: () => unavailable }, "REGISTRY_ADMISSION_UNAVAILABLE"],
		[
			{
				registry: () =>
					workloadRegistryFixture({
						...manifest,
						interactionMode: "platform-adapter",
						protocol: "acp",
						capabilities: {
							attachments: true,
							modelSelection: true,
							supplementaryInstruction: true,
						},
					}),
			},
			"REGISTRY_ADMISSION_REJECTED",
		],
		[
			{
				authority: {
					...authority(),
					policy: { ...policy, platformAuthAnnotations: {} },
				},
				observed: {
					...observed,
					configuration: {
						...observed.configuration,
						source: {
							...observed.configuration.source,
							identityResponsibility: "platform-managed",
						},
					},
				},
			},
			"CURRENT_DESIRED_UNAVAILABLE",
		],
	] as const) {
		const result = await projectAgentWorkloadUpgradeImagesV1({
			registry: () => admitted,
			...base,
			...change,
		});
		expect(result).toMatchObject({ status: "UNKNOWN", reason, images: [] });
		expect(JSON.stringify(result)).not.toContain("PRIVATE_REGISTRY_TOKEN");
	}
	// The repository check runs before any Registry request.
	expect(admit).not.toHaveBeenCalledWith(
		expect.objectContaining({
			imageReference: otherRepository.imageReference,
		}),
		expect.anything(),
	);
});

it("refuses the wrong resource family before Registry admission", async () => {
	const { observed } = await currentObservation();
	const registry = workloadRegistryFixture(manifest);
	const admit = vi.spyOn(registry, "admit");
	for (const source of [
		{ kind: "standard", templateId: "template-a", connectionEnabled: false },
		{
			...observed.configuration.source,
			manifest: "schemaVersion: 1",
		},
	]) {
		expect(
			await projectAgentWorkloadUpgradeImagesV1({
				authority: authority(),
				target: { agentId, proposal },
				observed: {
					...observed,
					configuration: { ...observed.configuration, source },
				},
				registry: () => registry,
				snapshots: snapshotReader(),
			}),
		).toMatchObject({
			status: "UNKNOWN",
			reason: "WRONG_RESOURCE_FAMILY",
			images: [],
		});
	}
	expect(admit).not.toHaveBeenCalled();
});

it("stays UNKNOWN without trusted materializer metadata or retained bindings", async () => {
	const { observed } = await currentObservation();
	const registry = () => workloadRegistryFixture(manifest);
	const input = {
		authority: authority(),
		target: { agentId, proposal },
		observed,
		registry,
	};
	// A caller-built projector with the normal shape but not the captured policy.
	const normal = resolver();
	const forged = Object.assign(async () => ({ inputs: [] }), {
		project: (...value: Parameters<typeof normal.project>) =>
			normal.project(...value),
	});
	for (const [change, reason] of [
		[{ authority: authority(null) }, "WORKSPACE_SNAPSHOT_METADATA_UNAVAILABLE"],
		[
			{ authority: authority(forged) },
			"WORKSPACE_SNAPSHOT_METADATA_UNAVAILABLE",
		],
		[
			{
				snapshots: {
					read: async () => [
						recordA,
						{ ...recordB, digest: `sha256:${"9".repeat(64)}` },
					],
				},
			},
			"WORKSPACE_SNAPSHOT_METADATA_UNAVAILABLE",
		],
		[
			{ snapshots: { read: async () => [recordA] } },
			"WORKSPACE_SNAPSHOT_METADATA_UNAVAILABLE",
		],
		[
			{
				observed: {
					...observed,
					configuration: {
						...observed.configuration,
						source: {
							...observed.configuration.source,
							workspaceSnapshots: [{ snapshotId: "snapshot-a", name: "repo" }],
						},
					},
				},
			},
			"SNAPSHOT_BINDINGS_NOT_RETAINED",
		],
	] as const) {
		const result = await projectAgentWorkloadUpgradeImagesV1({
			snapshots: snapshotReader(),
			...input,
			...change,
		});
		expect(result).toMatchObject({ status: "UNKNOWN", reason, images: [] });
		expect(JSON.stringify(result)).not.toMatch(
			/PRIVATE_OBJECT|private-version/,
		);
	}
});

let directory: string;
let configurationModule: URL;
const configurationBytes = "export const fixture = 1;\n";
const context = {
	platformSource: "2".repeat(40),
	runtimeAuthority: "4".repeat(40),
	planHash: "a".repeat(64),
	clusterUid: "cluster",
	namespace: policy.namespace,
	namespaceUid: "namespace-uid",
	release: "release",
	helmRevision: 46,
	installationId: "installation",
	directoryBindingHash: "b".repeat(64),
	directorySnapshotHash: "c".repeat(64),
};
const databaseUrl = "postgresql://synthetic:synthetic@localhost/platform";

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "worker-agent-images-"));
	const path = join(directory, "configuration.mjs");
	await writeFile(path, configurationBytes);
	configurationModule = pathToFileURL(path);
});
afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
	store.urls = [];
	store.observations = [];
	store.reads = 0;
	store.closes = 0;
	store.snapshotRead.mockReset();
	store.snapshotRead.mockImplementation(async () =>
		records.map((record) => ({ ...record })),
	);
});

function deployment(
	overrides: Partial<WorkerAgentWorkloadDemandImageDeploymentV1> = {},
	registry: ImageRegistryAdapterV1 = workloadRegistryFixture(manifest),
): WorkerAgentWorkloadDemandImageDeploymentV1 {
	return {
		namespace: policy.namespace,
		workerId: sessionSandboxRuntimeAuthFixture.workerId,
		workload: {
			policy: { ...policy, runtimeAuth: sessionSandboxRuntimeAuthFixture },
			workspaceSnapshotResolver: resolver(),
			admissionPolicyRef: "policy-a",
			registrySubjectRef: "subject-a",
		},
		registry: () => registry,
		configurationModule,
		configurationSourceSha: context.runtimeAuthority,
		...overrides,
	};
}

const request = {
	schemaVersion: 1,
	context,
	target: {
		agentId,
		proposal,
		declaredImageSource: {
			sourceSha: "4a3c2840e0d918dfc6fef77ce1cb1b7fffc46c60",
			workflowSourceSha: "334a244152ddef9baba24bcd7eb4fbfc7735317b",
			runId: "43741080676",
		},
	},
};

it("reads the Store twice in read-only sessions and keeps the three source roles distinct", async () => {
	const { observed } = await currentObservation();
	store.observations = [observed, observed];
	const receipt = await readWorkerAgentWorkloadDemandImagesV1(
		deployment(),
		request,
		databaseUrl,
	);
	expect(receipt).toMatchObject({
		kind: "worker-agent-workload-demand-images",
		authority: {
			sourceSha: context.runtimeAuthority,
			configurationHash: createHash("sha256")
				.update(configurationBytes)
				.digest("hex"),
			namespace: policy.namespace,
			imageRepository: policy.imageRepository,
		},
		sourceRoles: {
			platformCode: {
				sourceSha: context.platformSource,
				trust: "CALLER_PLAN_CONTEXT",
			},
			runtimeConfiguration: {
				sourceSha: context.runtimeAuthority,
				trust: "MOUNTED_DEPLOYMENT_CONFIGURATION",
			},
			customImage: {
				...request.target.declaredImageSource,
				trust: "CALLER_DECLARED_NOT_VERIFIED",
			},
		},
		target: { status: "PROJECTED_IMAGES", mainImage: proposal.imageReference },
		storeReads: { contextStable: true, readCount: 2 },
		livePodImagesVerified: false,
		fieldAcceptance: false,
		sideEffects: { databaseWrites: 0, fieldWrites: 0, signedUrls: 0 },
	});
	expect(store.reads).toBe(2);
	expect(store.urls.length).toBeGreaterThanOrEqual(3);
	for (const url of store.urls)
		expect(new URL(url).searchParams.get("options")).toContain(
			"default_transaction_read_only=on -c statement_timeout=5000",
		);
	expect(store.closes).toBe(store.urls.length);
	// Includes the platform-auth annotation value that the policy hash binds.
	expect(JSON.stringify(receipt)).not.toMatch(
		/PRIVATE_|private-version|synthetic:synthetic|grant-key|BEGIN PUBLIC|auth\.example\.test/,
	);
});

it("reports drift between the two Store reads as UNKNOWN", async () => {
	const { observed } = await currentObservation();
	store.observations = [
		observed,
		{ ...observed, management: { ...management, revision: 17 } },
	];
	const receipt = await readWorkerAgentWorkloadDemandImagesV1(
		deployment(),
		request,
		databaseUrl,
	);
	expect(receipt.target).toMatchObject({
		status: "UNKNOWN",
		reason: "STORE_CONTEXT_DRIFT",
		images: [],
	});
	expect(receipt.storeReads.contextStable).toBe(false);
});

it("fails closed before opening the Store on invalid requests or another authority", async () => {
	for (const value of [
		{ ...request, target: { ...request.target, actorId: "caller" } },
		{
			...request,
			target: {
				...request.target,
				proposal: {
					...proposal,
					imageReference: `${policy.imageRepository}:latest`,
				},
			},
		},
		{
			...request,
			target: {
				...request.target,
				proposal: { ...proposal, command: "upgrade_custom_manifest" },
			},
		},
		{ ...request, target: { ...request.target, containers: [] } },
		{ ...request, targets: [request.target] },
	])
		await expect(
			readWorkerAgentWorkloadDemandImagesV1(deployment(), value, databaseUrl),
		).rejects.toThrow("WORKER_AGENT_WORKLOAD_IMAGE_REQUEST_INVALID");
	for (const change of [
		{ namespace: "other" },
		{ workerId: "other-worker" },
		{ configurationSourceSha: "5".repeat(40) },
		{ configurationSourceSha: undefined },
	])
		await expect(
			readWorkerAgentWorkloadDemandImagesV1(
				deployment(change),
				request,
				databaseUrl,
			),
		).rejects.toThrow("WORKER_AGENT_WORKLOAD_IMAGE_AUTHORITY_UNAVAILABLE");
	await expect(
		readWorkerAgentWorkloadDemandImagesV1(deployment(), request, undefined),
	).rejects.toThrow("WORKER_AGENT_WORKLOAD_IMAGE_READ_FAILED");
	expect(store.urls).toEqual([]);
});
