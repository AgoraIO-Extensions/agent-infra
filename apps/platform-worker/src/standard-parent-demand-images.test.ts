import { expect, it, vi } from "vitest";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { projectStandardParentDemandImagesV1 } from "./standard-parent-demand-images.js";
import { sessionSandboxTemplateBindingFixture } from "./test-support/session-sandbox-v4.js";
import { projectWorkspaceSnapshotDemandImagesV1 } from "./workspace-snapshot-demand-images.js";
import { createWorkspaceSnapshotResolverV1 } from "./workspace-snapshot-resolver.js";

function fixture() {
	const desired = workloadDesiredFixture(1, "agent-a", "internal-only");
	const binding = {
		...sessionSandboxTemplateBindingFixture(desired.imageDigest),
		imageRepository: "registry.example.test/codex",
	};
	return { desired, binding };
}

it("recomputes complete standard-parent images from validated Desired without a Pod or private policy", () => {
	const { desired, binding } = fixture();
	expect("spec" in desired).toBe(false);
	expect(projectStandardParentDemandImagesV1(desired, binding)).toEqual({
		source: "AgentWorkloadDesiredV1",
		completeness: "COMPLETE",
		images: [`${binding.imageRepository}@${desired.imageDigest}`],
		mainImage: `${binding.imageRepository}@${desired.imageDigest}`,
		auxiliaryImages: [],
		containers: [
			expect.objectContaining({
				kind: "main",
				image: `${binding.imageRepository}@${desired.imageDigest}`,
			}),
		],
	});
});

it("preserves MAIN_ONLY for a real nonempty snapshot declaration without normal materializer inputs", () => {
	const { desired, binding } = fixture();
	const snapshot = {
		snapshotId: "snapshot-a",
		name: "repo",
		digest: `sha256:${"a".repeat(64)}`,
		sizeBytes: 10,
		objectRef: "private-object",
		mountPath: "/opt/agent/workspaces/repo",
	};
	const result = projectStandardParentDemandImagesV1(
		{ ...desired, workspaceSnapshots: [snapshot] },
		binding,
	);
	expect(result).toMatchObject({
		completeness: "MAIN_ONLY",
		auxiliaryImages: [],
	});
	expect(result.images).toEqual([
		`${binding.imageRepository}@${desired.imageDigest}`,
	]);
	expect(result.images).not.toContain(snapshot.digest);
});

it("uses the same normal Store-CAS/materializer projection for independent snapshot init metadata", async () => {
	const { desired, binding } = fixture();
	const record = {
		snapshotId: "snapshot-a",
		name: "repo",
		digest: `sha256:${"a".repeat(64)}`,
		sizeBytes: 10,
		objectRef: "private-object",
		objectVersion: "version-a",
	};
	const materializer = `registry.example.test/materializer@sha256:${"c".repeat(64)}`;
	const forbidden = vi.fn(async () => {
		throw new Error("side effect forbidden");
	});
	const resolver = createWorkspaceSnapshotResolverV1({
		read: forbidden,
		createReadUrl: forbidden,
		allowedOrigins: [],
		policy: {
			imageDigest: materializer,
			credentialSecretName: "reference",
			allowedOrigins: [],
			cacheSizeLimit: "1Gi",
			resources: workloadTestPolicy.resources,
		},
	});
	const { objectVersion: _, ...snapshot } = record;
	const value = {
		...desired,
		workspaceSnapshots: [
			{ ...snapshot, mountPath: "/opt/agent/workspaces/repo" },
		],
	};
	const projection = await projectWorkspaceSnapshotDemandImagesV1({
		desired: value,
		contextHash: "d".repeat(64),
		casHash: "e".repeat(64),
		workloadRevision: 1,
		fence: 1,
		authority: {
			sourceSha: "4".repeat(40),
			configurationHash: "f".repeat(64),
			contextHash: "d".repeat(64),
			resolver,
		},
		snapshots: { read: async () => [record] },
	});
	if (!projection.projection) throw new Error("missing normal projection");
	const result = projectStandardParentDemandImagesV1(value, binding, {
		policy: {
			...workloadTestPolicy,
			workspaceSnapshotEgress: [
				{
					destination: { namespace: "storage", podLabels: { app: "storage" } },
					port: 9000,
				},
			],
		},
		workspaceSnapshotProjection: projection.projection(),
	});
	expect(result).toMatchObject({
		completeness: "COMPLETE",
		auxiliaryImages: [materializer],
	});
	expect(result.images).toEqual([
		`${binding.imageRepository}@${desired.imageDigest}`,
		materializer,
	]);
	expect(forbidden).not.toHaveBeenCalled();
	expect(JSON.stringify(result)).not.toContain(record.objectRef);
});

it("rejects registry/Agent/binding drift rather than accepting a claimed complete image list", () => {
	const { desired, binding } = fixture();
	for (const value of [
		{ ...desired, registryAdmission: undefined },
		{ ...desired, agentId: "foreign-agent" },
		{ ...desired, imageDigest: `sha256:${"9".repeat(64)}` },
	])
		expect(() => projectStandardParentDemandImagesV1(value, binding)).toThrow();
	expect(() =>
		projectStandardParentDemandImagesV1(desired, {
			...binding,
			imageDigest: `sha256:${"8".repeat(64)}`,
		}),
	).toThrow();
});
