import { expect, it, vi } from "vitest";
import { workloadDesiredFixture } from "./kubernetes.fixture.js";
import { projectWorkspaceSnapshotDemandImagesV1 } from "./workspace-snapshot-demand-images.js";
import {
	createWorkspaceSnapshotResolverV1,
	workspaceSnapshotResolverImagePolicyV1,
} from "./workspace-snapshot-resolver.js";

function fixture() {
	const record = {
		snapshotId: "snapshot-a",
		name: "repo",
		digest: `sha256:${"a".repeat(64)}`,
		sizeBytes: 10,
		objectRef: "PRIVATE_OBJECT_REFERENCE",
		objectVersion: "private-version",
	};
	const policy = {
		imageDigest: `registry.example.test/materializer@sha256:${"c".repeat(64)}`,
		allowedOrigins: ["https://private-storage.example.test"],
		cacheSizeLimit: "2Gi",
		credentialSecretName: "private-credential-reference",
		resources: {
			requests: { cpu: "100m", memory: "128Mi" },
			limits: { cpu: "1", memory: "512Mi" },
		},
	};
	const resolverRead = vi.fn(async () => [record]);
	const sign = vi.fn(async () => {
		throw new Error("signing forbidden in image-only projection");
	});
	const resolver = createWorkspaceSnapshotResolverV1({
		read: resolverRead,
		createReadUrl: sign,
		policy,
		allowedOrigins: policy.allowedOrigins,
	});
	const { objectVersion: _, ...binding } = record;
	const input = {
		desired: {
			...workloadDesiredFixture(),
			workspaceSnapshots: [
				{ ...binding, mountPath: "/opt/agent/workspaces/repo" },
			],
		},
		contextHash: "d".repeat(64),
		casHash: "e".repeat(64),
		workloadRevision: 12,
		fence: 6,
		authority: {
			sourceSha: "4".repeat(40),
			configurationHash: "f".repeat(64),
			contextHash: "d".repeat(64),
			resolver,
		},
		snapshots: { read: vi.fn(async () => [record]) },
	};
	return { input, record, policy, resolver, resolverRead, sign };
}

it("binds the actual normal materializer policy image to Store CAS without signing or serializing private shape", async () => {
	const f = fixture();
	const result = await projectWorkspaceSnapshotDemandImagesV1(f.input);
	expect(result.status).toBe("PROJECTED_IMAGES");
	expect(result.images).toEqual([
		{
			name: "workspace-snapshot-materializer",
			kind: "init",
			image: f.policy.imageDigest,
			digest: `sha256:${"c".repeat(64)}`,
			entrypointSource: "pod-override",
			entrypointShapeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		},
	]);
	expect(result.provenance).toMatchObject({
		configurationSourceSha: f.input.authority.sourceSha,
		configurationHash: f.input.authority.configurationHash,
		casHash: f.input.casHash,
		policyHash: workspaceSnapshotResolverImagePolicyV1(f.resolver)?.policyHash,
		producerModule: "apps/platform-worker/src/workspace-snapshot-resolver.ts",
		policyField: "policy.imageDigest",
	});
	expect(f.input.snapshots.read).toHaveBeenCalledWith({
		agentId: f.input.desired.agentId,
		configurationRevision: f.input.desired.configRevision,
		workloadRevision: 12,
		fence: 6,
		bindings: [{ snapshotId: f.record.snapshotId, name: f.record.name }],
	});
	expect(result.projection?.().initContainers[0]?.image).toBe(
		f.policy.imageDigest,
	);
	expect(f.resolverRead).not.toHaveBeenCalled();
	expect(f.sign).not.toHaveBeenCalled();
	expect(JSON.stringify(result)).not.toMatch(
		/PRIVATE_OBJECT|private-version|private-credential|private-storage|"volumes"|"manifest"|"command"|"args"/,
	);
});

it("treats genuinely empty bindings as not applicable without demanding policy or inventing an init", async () => {
	const f = fixture();
	const result = await projectWorkspaceSnapshotDemandImagesV1({
		...f.input,
		desired: workloadDesiredFixture(),
		authority: undefined,
	});
	expect(result).toMatchObject({
		status: "NOT_APPLICABLE_EMPTY_BINDINGS",
		images: [],
		missing: [],
	});
	expect(f.input.snapshots.read).not.toHaveBeenCalled();
});

it("holds nonempty bindings with missing policy or a caller-written projection despite a matching image", async () => {
	const f = fixture();
	const fabricated = Object.assign(async () => ({ inputs: [] }), {
		project: () =>
			f.resolver.project([f.record], {
				agentId: f.input.desired.agentId,
				configurationRevision: f.input.desired.configRevision,
			}),
	});
	for (const resolver of [undefined, fabricated]) {
		const result = await projectWorkspaceSnapshotDemandImagesV1({
			...f.input,
			authority: { ...f.input.authority, resolver },
		});
		expect(result).toMatchObject({ status: "UNKNOWN", images: [] });
		expect(result.missing[0]).toContain("captured policy.imageDigest");
	}
	expect(f.input.snapshots.read).not.toHaveBeenCalled();
});

it("rejects source/context/CAS or metadata drift within only this snapshot group", async () => {
	const f = fixture();
	for (const change of [
		{ casHash: "bad" },
		{ fence: 0 },
		{ contextHash: "0".repeat(64) },
		{ authority: { ...f.input.authority, sourceSha: "bad" } },
	]) {
		const result = await projectWorkspaceSnapshotDemandImagesV1({
			...f.input,
			...change,
		});
		expect(result).toMatchObject({ status: "UNKNOWN", images: [] });
	}
	expect(f.input.snapshots.read).not.toHaveBeenCalled();
	f.input.snapshots.read.mockResolvedValue([
		{ ...f.record, digest: `sha256:${"b".repeat(64)}` },
	]);
	const result = await projectWorkspaceSnapshotDemandImagesV1(f.input);
	expect(result).toMatchObject({ status: "UNKNOWN", images: [] });
	expect(result.missing[0]).toContain("exact Desired bindings/revision/fence");
	expect(f.sign).not.toHaveBeenCalled();
});

it("captures normal policy immutably and refuses a replaced projector", async () => {
	const f = fixture();
	const before = workspaceSnapshotResolverImagePolicyV1(f.resolver);
	f.policy.imageDigest = `registry.example.test/changed@sha256:${"b".repeat(64)}`;
	const result = await projectWorkspaceSnapshotDemandImagesV1(f.input);
	expect(result.images[0]?.image).toBe(before?.image);
	f.resolver.project = () => {
		throw new Error("replacement must not run");
	};
	expect(workspaceSnapshotResolverImagePolicyV1(f.resolver)).toBeUndefined();
	expect(await projectWorkspaceSnapshotDemandImagesV1(f.input)).toMatchObject({
		status: "UNKNOWN",
		images: [],
	});
});
