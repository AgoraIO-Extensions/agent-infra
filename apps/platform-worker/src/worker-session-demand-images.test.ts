import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	options: vi.fn(),
	read: vi.fn(),
	close: vi.fn(async () => undefined),
	snapshotOpen: vi.fn(),
	snapshotRead: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("@agent-infra/platform-store", async (original) => ({
	...(await original<typeof import("@agent-infra/platform-store")>()),
	openPostgresSessionSandboxImageReaderV1: (options: unknown) => {
		store.options(options);
		return { read: store.read, close: store.close };
	},
	openPostgresWorkspaceSnapshotMaterializationReaderV1: (
		databaseUrl: string,
	) => {
		store.snapshotOpen(databaseUrl);
		return { read: store.snapshotRead, close: store.close };
	},
}));

import type { CodexSessionExecutorPolicyV1 } from "./codex-session-executor.js";
import { createSessionSandboxResourceInputResolverV1 } from "./conversation-deployment.js";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import {
	type SessionSandboxOAuthProvisioningV1,
	sessionSandboxResourcesV1,
} from "./session-workload-adapter.js";
import {
	sessionSandboxDeploymentTokenFixture,
	sessionSandboxModelProjectionFixture,
	sessionSandboxRuntimeAuthFixture,
	sessionSandboxTemplateBindingFixture,
} from "./test-support/session-sandbox-v4.js";
import {
	readWorkerSessionDemandImagesV1,
	type WorkerSessionDemandImageDeploymentV1,
} from "./worker-session-demand-images.js";
import { workloadResourceConfigurationHashV1 } from "./workload-runtime.js";
import { createWorkspaceSnapshotResolverV1 } from "./workspace-snapshot-resolver.js";

const namespace = workloadTestPolicy.namespace;
const databaseUrl = "postgresql://synthetic:synthetic@localhost/platform";
const configurationBytes = "export const fixtureConfiguration = 1;\n";
const configurationHash = createHash("sha256")
	.update(configurationBytes)
	.digest("hex");
const context = {
	platformSource: "2".repeat(40),
	runtimeAuthority: "4".repeat(40),
	planHash: "a".repeat(64),
	clusterUid: "cluster",
	namespace,
	namespaceUid: "namespace-uid",
	release: "release",
	helmRevision: 46,
	installationId: "installation",
	directoryBindingHash: "b".repeat(64),
	directorySnapshotHash: "c".repeat(64),
};
const executorPolicy: CodexSessionExecutorPolicyV1 = {
	resources: {
		requests: { cpu: "250m", memory: "256Mi" },
		limits: { cpu: "1", memory: "1Gi" },
	},
	tmpSizeLimit: "256Mi",
	placement: { architecture: "amd64" },
};
let directory: string;
let configurationModule: URL;

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "worker-session-images-"));
	const path = join(directory, "configuration.mjs");
	await writeFile(path, configurationBytes);
	configurationModule = pathToFileURL(path);
});
afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
	vi.clearAllMocks();
	store.snapshotRead.mockResolvedValue([]);
});

type Policy = WorkerSessionDemandImageDeploymentV1["workload"]["policy"];

function scenario(
	options: {
		readonly workerPolicy?: Partial<Policy>;
		readonly storePolicy?: Partial<Policy>;
		readonly desired?: Record<string, unknown>;
	} = {},
) {
	const desired = {
		...workloadDesiredFixture(1, "agent-a", "internal-only"),
		...options.desired,
	};
	const binding = {
		schemaVersion: 1 as const,
		sandboxId: "00000000-0000-4000-8000-000000000001",
		sessionId: "conversation-a",
		agentId: "agent-a",
		principal: { kind: "user" as const, id: "actor-a" },
		channelId: "web",
		generation: 1,
		resourceName: "sandbox-00000000-0000-4000-8000-000000000001",
		workspaceScope: "00000000-0000-4000-8000-000000000001",
	};
	const base = {
		...workloadTestPolicy,
		runtimeAuth: sessionSandboxRuntimeAuthFixture,
	};
	const policy: Policy = { ...base, ...options.workerPolicy };
	const stored = { ...base, ...(options.storePolicy ?? options.workerPolicy) };
	const storePolicy = {
		namespace,
		resourceConfigurationHash: workloadResourceConfigurationHashV1(stored),
		configurationRevision: 1,
		workloadRevision: 1,
		managementFence: 1,
		imageDigest: desired.imageDigest,
	};
	const input = {
		source: "allocation" as const,
		binding,
		resourceFence: 3,
		policy: storePolicy,
		deployment: desired,
		modelProjection: sessionSandboxModelProjectionFixture({
			agentId: desired.agentId,
			configurationRevision: 1,
			imageDigest: desired.imageDigest,
		}),
		inputHash: "a".repeat(64),
	};
	const metadata = (sandboxId: string, casHash: string) => ({
		binding: { ...binding, sandboxId },
		bindingKey: `session:${sandboxId}`,
		bindingStatus: "VERIFIED_STORE_COMPOSITE",
		resourceFence: 3,
		status: "unknown",
		desiredState: "running",
		allocationRowVersion: "41",
		namespace,
		policy: storePolicy,
		policyHash: "d".repeat(64),
		observationHash: "e".repeat(64),
		resources: [],
		retained: null,
		identityEvidence: "persisted-store-observation; live-unverified",
		snapshotReadCas: { workloadRevision: 1, fence: 1 },
		managementRevision: 1,
		managementFence: 1,
		configurationRevision: 1,
		ownerIds: ["private-owner-id"],
		outbox: null,
		inputStatus: "STORED_INPUTS_BOUND",
		missing: [],
		projectionInputs: [
			{
				source: "allocation",
				inputHash: input.inputHash,
				generation: 1,
				resourceFence: 3,
				policyHash: "d".repeat(64),
			},
		],
		casHash,
	});
	const readback = {
		namespace,
		observedAtDatabase: "2026-11-16T00:00:00.000Z",
		storeSnapshot: "10:10:",
		pageCount: 1,
		enumerationComplete: true,
		emptyAfterCompleteEnumeration: false,
		scope: "namespace-and-unattributed-allocations",
		items: [
			{
				metadata: metadata(binding.sandboxId, "b".repeat(64)),
				workerProjectionInputs: () => [input],
			},
			{
				metadata: metadata(
					"00000000-0000-4000-8000-000000000002",
					"c".repeat(64),
				),
				workerProjectionInputs: () => [],
			},
		],
	};
	const deployment: WorkerSessionDemandImageDeploymentV1 = {
		namespace,
		workerId: sessionSandboxRuntimeAuthFixture.workerId,
		workload: {
			policy,
			templateModelBindings: [
				sessionSandboxTemplateBindingFixture(desired.imageDigest),
			],
		},
		serviceToken: sessionSandboxDeploymentTokenFixture,
		configurationModule,
	};
	const request = {
		schemaVersion: 1,
		context,
		targets: [{ sandboxId: binding.sandboxId, inputHash: input.inputHash }],
	};
	return {
		binding,
		desired,
		policy,
		storePolicy,
		input,
		readback,
		deployment,
		request,
	};
}

function oauthBundle(
	value: Pick<
		ReturnType<typeof scenario>["binding"],
		"agentId" | "sessionId" | "sandboxId" | "generation" | "resourceName"
	>,
) {
	return {
		schemaVersion: 1,
		agentId: value.agentId,
		sessionId: value.sessionId,
		sandboxId: value.sandboxId,
		sessionGeneration: value.generation,
		principal: { kind: "user", id: "actor-a" },
		configuration: {
			runtimeOrigin: `https://${value.resourceName}.${namespace}.svc:3443/`,
		},
		tlsSecretRef: { name: "tls", certKey: "tls.crt", keyKey: "tls.key" },
		callbackAuthSecretRef: { name: "callback", key: "callback.auth" },
		apiSelector: { component: "platform-api" },
	} as unknown as SessionSandboxOAuthProvisioningV1;
}

it("projects only the requested Session with this Worker's own authority and a same-snapshot CAS", async () => {
	const s = scenario();
	store.read.mockResolvedValueOnce(s.readback);
	const receipt = await readWorkerSessionDemandImagesV1(
		s.deployment,
		s.request,
		databaseUrl,
	);
	expect(receipt.targets).toEqual([
		{
			sandboxId: s.binding.sandboxId,
			inputHash: s.input.inputHash,
			observedCasHash: "b".repeat(64),
			status: "BOUND",
		},
	]);
	expect(receipt.targetScopeStatus).toBe("ALL_TARGETS_PROJECTED");
	expect(receipt.rows).toHaveLength(1);
	expect(receipt.rows[0]).toMatchObject({
		binding: { sandboxId: s.binding.sandboxId },
		casHash: "b".repeat(64),
		ownerCount: 1,
	});
	expect(receipt.rows[0]).not.toHaveProperty("ownerIds");
	expect(receipt.rows[0]?.groups[0]).toMatchObject({
		status: "PROJECTED_IMAGES",
		workerConfigurationAuthority: {
			sourceSha: context.platformSource,
			configurationHash,
		},
		images: [
			{
				kind: "main",
				name: "runtime",
				image: `registry.example.test/agent@sha256:${"1".repeat(64)}`,
			},
		],
		podIdentity: {
			namespace,
			serviceAccountName: s.binding.resourceName,
			imagePullSecrets: [],
			nodeSelector: {},
			tolerations: [],
			runtimeClassName: null,
		},
	});
	expect(receipt.authority).toMatchObject({
		sourceSha: context.platformSource,
		sourceShaBinding: "context.platformSource",
		configurationHash,
		namespace,
		resourceConfigurationHash: workloadResourceConfigurationHashV1(s.policy),
		templateBindingCount: 1,
		workspaceSnapshotResolver: false,
		oauthProvisioningConfigured: false,
	});
	expect(receipt.store).toMatchObject({
		rowCount: 2,
		enumerationComplete: true,
	});
	expect(store.options).toHaveBeenCalledOnce();
	const url = new URL(store.options.mock.calls[0]?.[0].databaseUrl);
	expect(url.searchParams.get("options")).toContain(
		"default_transaction_read_only=on",
	);
	expect(url.searchParams.get("options")).toContain("statement_timeout=5000");
	expect(store.read).toHaveBeenCalledExactlyOnceWith(namespace);
	expect(store.snapshotOpen).not.toHaveBeenCalled();
	expect(store.close).toHaveBeenCalledOnce();
	const text = JSON.stringify(receipt);
	expect(text).not.toContain(sessionSandboxDeploymentTokenFixture);
	expect(text).not.toContain("private-owner-id");
	expect(text).not.toMatch(
		/"env"|"deployment"|"modelProjection"|"serviceToken"/,
	);
});

it("renders the Codex executor init and sidecar with the deployment pull identity and placement of the adapter's Pod", async () => {
	const s = scenario({
		workerPolicy: {
			codexSessionExecutor: executorPolicy,
			imagePullSecretName: "registry-pull",
		},
	});
	store.read.mockResolvedValueOnce(s.readback);
	const receipt = await readWorkerSessionDemandImagesV1(
		s.deployment,
		s.request,
		databaseUrl,
	);
	const group = receipt.rows[0]?.groups[0];
	if (group?.status !== "PROJECTED_IMAGES") throw new Error("not projected");
	const image = `registry.example.test/agent@sha256:${"1".repeat(64)}`;
	expect(group.images.map((row) => [row.kind, row.name, row.image])).toEqual([
		["main", "runtime", image],
		["init", "codex-session-workspace-init", image],
		["sidecar", "codex-session-executor", image],
	]);
	expect(group.podIdentity).toEqual({
		namespace,
		serviceAccountName: s.binding.resourceName,
		imagePullSecrets: ["registry-pull"],
		nodeSelector: { type: "virtual-kubelet", "kubernetes.io/arch": "amd64" },
		tolerations: [
			{
				key: "virtual-kubelet.io/provider",
				operator: "Equal",
				value: "alibabacloud",
				effect: "NoSchedule",
			},
		],
		runtimeClassName: null,
	});
	// The same normal resolver input rendered by the Session adapter.
	const allocation = {
		...createSessionSandboxResourceInputResolverV1(
			s.deployment.workload as never,
			{
				serviceToken: sessionSandboxDeploymentTokenFixture,
			},
		)(
			s.binding,
			s.storePolicy,
			s.desired as never,
			s.input.modelProjection,
			"running",
			1,
			3,
			true,
		),
		principal: s.binding.principal,
		channelId: s.binding.channelId,
	};
	const pod = sessionSandboxResourcesV1(allocation).find(
		(resource) => resource.kind === "Pod",
	) as import("@kubernetes/client-node").V1Pod;
	expect(group.podIdentity).toEqual({
		namespace: pod.metadata?.namespace,
		serviceAccountName: pod.spec?.serviceAccountName,
		imagePullSecrets: pod.spec?.imagePullSecrets?.map((secret) => secret.name),
		nodeSelector: pod.spec?.nodeSelector,
		tolerations: pod.spec?.tolerations,
		runtimeClassName: pod.spec?.runtimeClassName ?? null,
	});
	expect(
		[...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])]
			.map((container) => `${container.name}=${container.image}`)
			.sort(),
	).toEqual(group.images.map((row) => `${row.name}=${row.image}`).sort());
	expect(receipt.authority.resourceConfigurationHash).toBe(
		s.storePolicy.resourceConfigurationHash,
	);
});

it("keeps missing, stale, drifted or untrusted targets unknown without borrowing authority", async () => {
	const absent = scenario();
	store.read.mockResolvedValueOnce(absent.readback);
	const missing = await readWorkerSessionDemandImagesV1(
		absent.deployment,
		{
			...absent.request,
			targets: [
				{
					sandboxId: "00000000-0000-4000-8000-000000000009",
					inputHash: "a".repeat(64),
				},
			],
		},
		databaseUrl,
	);
	expect(missing.targets[0]?.status).toBe("NOT_FOUND");
	expect(missing.rows).toEqual([]);
	expect(missing.targetScopeStatus).toBe("TARGETS_WITH_UNKNOWN");

	for (const [target, status] of [
		[{ inputHash: "f".repeat(64) }, "INPUT_CHANGED"],
		[{ casHash: "9".repeat(64) }, "CAS_CHANGED"],
	] as const) {
		const s = scenario();
		store.read.mockResolvedValueOnce(s.readback);
		const receipt = await readWorkerSessionDemandImagesV1(
			s.deployment,
			{ ...s.request, targets: [{ ...s.request.targets[0], ...target }] },
			databaseUrl,
		);
		expect(receipt.targets[0]?.status).toBe(status);
		expect(receipt.rows[0]?.groups[0]).toMatchObject({
			status: "UNKNOWN_MISSING_TRUSTED_FIELD",
			images: [],
			missing: ["authority binding for exact allocation CAS/inputHash"],
		});
		expect(receipt.targetScopeStatus).toBe("TARGETS_WITH_UNKNOWN");
	}

	const drifted = scenario({
		storePolicy: { resourceProfileRef: "approved-other-profile" },
	});
	store.read.mockResolvedValueOnce(drifted.readback);
	const policy = await readWorkerSessionDemandImagesV1(
		drifted.deployment,
		drifted.request,
		databaseUrl,
	);
	expect(policy.targets[0]?.status).toBe("BOUND");
	expect(policy.rows[0]?.groups[0]).toMatchObject({
		status: "UNKNOWN_MISSING_TRUSTED_FIELD",
		missing: ["approved Worker policy matching resourceConfigurationHash"],
	});

	const untrusted = scenario();
	store.read.mockResolvedValueOnce(untrusted.readback);
	const template = await readWorkerSessionDemandImagesV1(
		{
			...untrusted.deployment,
			workload: {
				...untrusted.deployment.workload,
				templateModelBindings: [
					sessionSandboxTemplateBindingFixture(`sha256:${"7".repeat(64)}`),
				],
			},
		},
		untrusted.request,
		databaseUrl,
	);
	expect(template.rows[0]?.groups[0]).toMatchObject({
		status: "UNKNOWN_MISSING_TRUSTED_FIELD",
		missing: [
			"Store-captured Desired/modelProjection accepted by normal resource-input resolver",
		],
	});
	expect(template.targetScopeStatus).toBe("TARGETS_WITH_UNKNOWN");
});

it("does not complete an OAuth-selected Session whose Connection publication this reader does not derive", async () => {
	const selected = scenario();
	store.read.mockResolvedValueOnce(selected.readback);
	const receipt = await readWorkerSessionDemandImagesV1(
		{
			...selected.deployment,
			oauthProvisioning: oauthBundle(selected.binding),
		},
		selected.request,
		databaseUrl,
	);
	expect(receipt.targets[0]?.status).toBe("OAUTH_PUBLICATION_UNEVALUATED");
	expect(receipt.rows[0]?.groups[0]?.status).toBe(
		"UNKNOWN_MISSING_TRUSTED_FIELD",
	);
	expect(receipt.authority.oauthProvisioningConfigured).toBe(true);
	expect(receipt.targetScopeStatus).toBe("TARGETS_WITH_UNKNOWN");

	const other = scenario();
	store.read.mockResolvedValueOnce(other.readback);
	const unrelated = await readWorkerSessionDemandImagesV1(
		{
			...other.deployment,
			oauthProvisioning: oauthBundle({
				...other.binding,
				sandboxId: "00000000-0000-4000-8000-000000000002",
				resourceName: "sandbox-00000000-0000-4000-8000-000000000002",
			}),
		},
		other.request,
		databaseUrl,
	);
	expect(unrelated.targets[0]?.status).toBe("BOUND");
	const group = unrelated.rows[0]?.groups[0];
	if (group?.status !== "PROJECTED_IMAGES") throw new Error("not projected");
	expect(group.images.map((row) => row.name)).toEqual(["runtime"]);
});

it("uses only Store snapshot metadata and the unsigned normal projection for a snapshot init", async () => {
	const record = {
		snapshotId: "snapshot-a",
		name: "repo",
		digest: `sha256:${"9".repeat(64)}`,
		sizeBytes: 32,
		objectRef: "private-object-reference",
		objectVersion: "version-a",
	};
	const materializer = `registry.example.test/materializer@sha256:${"8".repeat(64)}`;
	const forbiddenRead = vi.fn(async () => {
		throw new Error("async resolver must not run");
	});
	const forbiddenUrl = vi.fn(async () => {
		throw new Error("signer must not run");
	});
	const resolver = createWorkspaceSnapshotResolverV1({
		read: forbiddenRead,
		createReadUrl: forbiddenUrl,
		allowedOrigins: [],
		policy: {
			imageDigest: materializer,
			allowedOrigins: [],
			credentialSecretName: "reference",
			cacheSizeLimit: "1Gi",
			resources: {
				requests: { cpu: "100m", memory: "128Mi" },
				limits: { cpu: "1", memory: "256Mi" },
			},
		},
	});
	const snapshots = [
		{
			snapshotId: record.snapshotId,
			name: record.name,
			digest: record.digest,
			sizeBytes: record.sizeBytes,
			objectRef: record.objectRef,
			mountPath: "/opt/agent/workspaces/repo",
		},
	];
	const workerPolicy = {
		workspaceSnapshotEgress: [
			{
				destination: { namespace: "storage", podLabels: { app: "storage" } },
				port: 9000,
			},
		],
	};
	for (const metadata of [[record], []]) {
		const s = scenario({
			workerPolicy,
			desired: { workspaceSnapshots: snapshots },
		});
		store.read.mockResolvedValueOnce(s.readback);
		store.snapshotRead.mockResolvedValueOnce(metadata);
		const receipt = await readWorkerSessionDemandImagesV1(
			{
				...s.deployment,
				workload: {
					...s.deployment.workload,
					workspaceSnapshotResolver: resolver,
				},
			},
			s.request,
			databaseUrl,
		);
		const group = receipt.rows[0]?.groups[0];
		if (metadata.length) {
			if (group?.status !== "PROJECTED_IMAGES")
				throw new Error("not projected");
			expect(group.snapshotStatus).toBe("BOUND_METADATA_UNSIGNED_PROJECTION");
			expect(group.images.map((row) => row.image)).toContain(materializer);
		} else {
			// Declared snapshots without exact Store metadata never project a partial set.
			expect(group).toMatchObject({
				status: "UNKNOWN_MISSING_TRUSTED_FIELD",
				images: [],
			});
		}
		const url = new URL(store.snapshotOpen.mock.calls.at(-1)?.[0]);
		expect(url.searchParams.get("options")).toContain(
			"default_transaction_read_only=on",
		);
		expect(JSON.stringify(receipt)).not.toContain(record.objectRef);
	}
	expect(forbiddenRead).not.toHaveBeenCalled();
	expect(forbiddenUrl).not.toHaveBeenCalled();
});

it("rejects request and authority defects before opening any Store reader", async () => {
	const s = scenario();
	const target = s.request.targets[0];
	for (const request of [
		null,
		[],
		{ ...s.request, extra: true },
		{ ...s.request, schemaVersion: 2 },
		{ ...s.request, targets: [] },
		{ ...s.request, targets: Array.from({ length: 17 }, () => target) },
		{ ...s.request, targets: [target, target] },
		{ ...s.request, targets: [{ ...target, inputHash: "A".repeat(64) }] },
		{ ...s.request, targets: [{ ...target, pod: "caller-built" }] },
		{ ...s.request, context: { ...context, extra: "unbound" } },
		{ ...s.request, context: { ...context, platformSource: "main" } },
	]) {
		await expect(
			readWorkerSessionDemandImagesV1(s.deployment, request, databaseUrl),
		).rejects.toThrow("WORKER_SESSION_IMAGE_REQUEST_INVALID");
	}
	for (const deployment of [
		{ ...s.deployment, namespace: undefined },
		{ ...s.deployment, namespace: "other-namespace" },
		{
			...s.deployment,
			workload: {
				...s.deployment.workload,
				policy: { ...s.policy, namespace: "other-namespace" },
			},
		},
		{ ...s.deployment, serviceToken: "" },
		{ ...s.deployment, serviceToken: undefined },
		{ ...s.deployment, workerId: "another-worker" },
		{
			...s.deployment,
			workload: { ...s.deployment.workload, templateModelBindings: [{}] },
		},
		{
			...s.deployment,
			workload: {
				...s.deployment.workload,
				policy: {
					...s.policy,
					codexSessionExecutor: {
						...executorPolicy,
						tmpSizeLimit: "unbounded",
					},
				},
			},
		},
		{
			...s.deployment,
			configurationModule: pathToFileURL(join(directory, "missing.mjs")),
		},
	] as WorkerSessionDemandImageDeploymentV1[]) {
		await expect(
			readWorkerSessionDemandImagesV1(deployment, s.request, databaseUrl),
		).rejects.toThrow("WORKER_SESSION_IMAGE_AUTHORITY_UNAVAILABLE");
	}
	await expect(
		readWorkerSessionDemandImagesV1(
			s.deployment,
			{ ...s.request, context: { ...context, namespace: "other-namespace" } },
			databaseUrl,
		),
	).rejects.toThrow("WORKER_SESSION_IMAGE_AUTHORITY_UNAVAILABLE");
	expect(store.options).not.toHaveBeenCalled();
	expect(store.snapshotOpen).not.toHaveBeenCalled();
});

it("fails closed with one stable code and closes readers on database or Store defects", async () => {
	const s = scenario();
	for (const url of [undefined, "", "https://localhost/platform"]) {
		await expect(
			readWorkerSessionDemandImagesV1(s.deployment, s.request, url),
		).rejects.toThrow("WORKER_SESSION_IMAGE_READ_FAILED");
	}
	expect(store.options).not.toHaveBeenCalled();
	store.read.mockRejectedValueOnce(
		new Error(sessionSandboxDeploymentTokenFixture),
	);
	await expect(
		readWorkerSessionDemandImagesV1(s.deployment, s.request, databaseUrl),
	).rejects.toThrow(/^WORKER_SESSION_IMAGE_READ_FAILED$/);
	for (const readback of [
		{ ...s.readback, namespace: "other-namespace" },
		{ ...s.readback, enumerationComplete: false },
	]) {
		store.read.mockResolvedValueOnce(readback);
		await expect(
			readWorkerSessionDemandImagesV1(s.deployment, s.request, databaseUrl),
		).rejects.toThrow("WORKER_SESSION_IMAGE_READ_FAILED");
	}
	expect(store.close).toHaveBeenCalledTimes(3);
});
