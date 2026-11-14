import { expect, it, vi } from "vitest";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { projectSessionDemandImagesV1 } from "./session-demand-images.js";
import {
	sessionSandboxDeploymentTokenFixture,
	sessionSandboxModelProjectionFixture,
	sessionSandboxRuntimeAuthFixture,
	sessionSandboxTemplateBindingFixture,
} from "./test-support/session-sandbox-v4.js";
import { workloadResourceConfigurationHashV1 } from "./workload-runtime.js";
import { createWorkspaceSnapshotResolverV1 } from "./workspace-snapshot-resolver.js";

type Input = Parameters<typeof projectSessionDemandImagesV1>[0];

function fixture(): Input {
	const desired = workloadDesiredFixture(1, "agent-a", "internal-only");
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
	const policy = {
		...workloadTestPolicy,
		runtimeAuth: sessionSandboxRuntimeAuthFixture,
	};
	const p = {
		namespace: policy.namespace,
		resourceConfigurationHash: workloadResourceConfigurationHashV1(policy),
		configurationRevision: 1,
		workloadRevision: 1,
		managementFence: 1,
		imageDigest: desired.imageDigest,
	};
	const source = {
		source: "allocation" as const,
		binding,
		bindingKey: `session:${binding.sandboxId}`,
		bindingStatus: "VERIFIED_STORE_COMPOSITE",
		resourceFence: 3,
		policy: p,
		deployment: desired,
		modelProjection: sessionSandboxModelProjectionFixture({
			agentId: desired.agentId,
			configurationRevision: 1,
			imageDigest: desired.imageDigest,
		}),
		inputHash: "a".repeat(64),
	};
	return {
		readback: {
			namespace: policy.namespace,
			observedAtDatabase: "2026-11-14T11:00:00Z",
			storeSnapshot: "1:10:",
			pageCount: 1,
			enumerationComplete: true,
			emptyAfterCompleteEnumeration: false,
			scope: "namespace-and-unattributed-allocations",
			items: [
				{
					metadata: {
						binding,
						resourceFence: 3,
						status: "ready",
						desiredState: "running",
						allocationRowVersion: "1",
						namespace: policy.namespace,
						policy: p,
						policyHash: "b".repeat(64),
						observationHash: "c".repeat(64),
						resources: [],
						retained: null,
						identityEvidence: "persisted-store-observation; live-unverified",
						snapshotReadCas: { workloadRevision: 1, fence: 1 },
						managementRevision: 1,
						managementFence: 1,
						configurationRevision: 1,
						ownerIds: ["actor-a"],
						outbox: null,
						inputStatus: "STORED_INPUTS_BOUND",
						missing: [],
						projectionInputs: [
							{
								source: source.source,
								inputHash: source.inputHash,
								generation: binding.generation,
								resourceFence: source.resourceFence,
								policyHash: "b".repeat(64),
							},
						],
						casHash: "b".repeat(64),
					},
					workerProjectionInputs: () => [source],
				},
			],
		},
		contextHash: "d".repeat(64),
		authorities: [
			{
				id: "authority",
				sourceSha: "4".repeat(40),
				configurationHash: "e".repeat(64),
				contextHash: "d".repeat(64),
				workload: {
					policy,
					templateModelBindings: [
						sessionSandboxTemplateBindingFixture(desired.imageDigest),
					],
				},
				serviceToken: sessionSandboxDeploymentTokenFixture,
			},
		],
		bindings: [
			{
				casHash: "b".repeat(64),
				inputHash: source.inputHash,
				authorityId: "authority",
			},
		],
		snapshots: { read: vi.fn(async () => []) },
	};
}

it("uses the real resource-input resolver and image-only renderer for an existing bound Session", async () => {
	const input = fixture();
	const receipt = await projectSessionDemandImagesV1(input);
	expect(receipt.rows[0]?.groups[0]).toMatchObject({
		status: "PROJECTED_IMAGES",
		snapshotStatus: "NOT_APPLICABLE_EMPTY_BINDINGS",
		images: [
			{
				kind: "main",
				image: `registry.example.test/agent@sha256:${"1".repeat(64)}`,
			},
		],
	});
	expect(input.snapshots.read).not.toHaveBeenCalled();
	expect(JSON.stringify(receipt)).not.toContain(
		sessionSandboxDeploymentTokenFixture,
	);
	expect(JSON.stringify(receipt)).not.toMatch(
		/"env"|"deployment"|"modelProjection"|"serviceToken"/,
	);
	expect(receipt.sideEffects).toMatchObject({
		claims: 0,
		applies: 0,
		signedUrls: 0,
		secretMaterializations: 0,
		modelCalls: 0,
	});
});

it("keeps an exact authority/CAS or policy mismatch local to the affected Session", async () => {
	for (const change of ["binding", "policy"] as const) {
		let input = fixture();
		if (change === "binding") input = { ...input, bindings: [] };
		else
			input = {
				...input,
				authorities: input.authorities.map((a) => ({
					...a,
					workload: {
						...a.workload,
						policy: { ...a.workload.policy, resourceProfileRef: "different" },
					},
				})),
			};
		const receipt = await projectSessionDemandImagesV1(input);
		expect(receipt.enumerationComplete).toBe(true);
		expect(receipt.rows[0]?.groups[0]?.status).toBe(
			"UNKNOWN_MISSING_TRUSTED_FIELD",
		);
		expect(receipt.rows[0]?.groups[0]?.missing).toHaveLength(1);
	}
});

it("reads real nonempty snapshot metadata then calls only the unsigned normal project method", async () => {
	const input = fixture();
	const source = input.readback.items[0]?.workerProjectionInputs()[0];
	const authority = input.authorities[0];
	if (!source || !authority) throw new Error("missing fixture");
	const desired = source.deployment as ReturnType<
		typeof workloadDesiredFixture
	>;
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
	const policy = {
		...authority.workload.policy,
		workspaceSnapshotEgress: [
			{
				destination: { namespace: "storage", podLabels: { app: "storage" } },
				port: 9000,
			},
		],
	};
	const prepared = {
		...source,
		policy: {
			...source.policy,
			resourceConfigurationHash: workloadResourceConfigurationHashV1(policy),
		},
		deployment: {
			...desired,
			workspaceSnapshots: [
				{
					snapshotId: record.snapshotId,
					name: record.name,
					digest: record.digest,
					sizeBytes: record.sizeBytes,
					objectRef: record.objectRef,
					mountPath: "/opt/agent/workspaces/repo",
				},
			],
		},
	};
	const projectedInput: Input = {
		...input,
		readback: {
			...input.readback,
			items: input.readback.items.map((item) => ({
				...item,
				workerProjectionInputs: () => [prepared],
			})),
		},
		authorities: [
			{
				...authority,
				workload: {
					...authority.workload,
					policy,
					workspaceSnapshotResolver: resolver,
				},
			},
		],
		snapshots: { read: vi.fn(async () => [record]) },
	};
	const receipt = await projectSessionDemandImagesV1(projectedInput);
	expect(receipt.rows[0]?.groups[0]).toMatchObject({
		status: "PROJECTED_IMAGES",
		snapshotStatus: "BOUND_METADATA_UNSIGNED_PROJECTION",
	});
	expect(
		receipt.rows[0]?.groups[0]?.images.map((value) => value.image),
	).toContain(materializer);
	expect(forbiddenRead).not.toHaveBeenCalled();
	expect(forbiddenUrl).not.toHaveBeenCalled();
	expect(projectedInput.snapshots.read).toHaveBeenCalledWith(
		expect.objectContaining({
			workloadRevision: 1,
			fence: 1,
			bindings: [{ snapshotId: record.snapshotId, name: record.name }],
		}),
	);
	expect(JSON.stringify(receipt)).not.toContain(record.objectRef);
});
