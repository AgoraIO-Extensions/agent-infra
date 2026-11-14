import { describe, expect, it, vi } from "vitest";
import {
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { fixture } from "./kubernetes-runtime-adapter.fixture.js";
import { parentWorkloadImageProjectionV1 } from "./parent-workload-image-projection.js";
import {
	sessionSandboxModelProjectionFixture,
	sessionSandboxTemplateBindingFixture,
} from "./test-support/session-sandbox-v4.js";
import { workloadPodImagesV1 } from "./workload-image-projection.js";
import { projectWorkspaceSnapshotPodShapeV1 } from "./workspace-snapshot-materializer.js";

describe("trusted parent image-only projection", () => {
	it("keeps every main/init/sidecar role without returning command or environment values", () => {
		const image = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;
		const result = workloadPodImagesV1({
			containers: [
				{ name: "main", image, env: [{ name: "PRIVATE", value: "HIDDEN" }] },
				{ name: "sidecar", image, command: ["HIDDEN_COMMAND"] },
			],
			initContainers: [{ name: "init", image, args: ["HIDDEN_ARGUMENT"] }],
		});
		expect(result.map((value) => value.kind)).toEqual([
			"main",
			"sidecar",
			"init",
		]);
		expect(result.map((value) => value.entrypointSource)).toEqual([
			"image-default-unverified",
			"pod-override",
			"pod-override",
		]);
		expect(JSON.stringify(result)).not.toMatch(/HIDDEN|PRIVATE/);
	});

	it("rejects mutable images and ambiguous container identities", () => {
		const image = `registry.example.test/runtime@sha256:${"a".repeat(64)}`;
		expect(() =>
			workloadPodImagesV1({
				containers: [{ name: "main", image: "runtime:latest" }],
			}),
		).toThrow("WORKLOAD_IMAGE_PROJECTION_INVALID");
		expect(() =>
			workloadPodImagesV1({
				containers: [{ name: "same", image }],
				initContainers: [{ name: "same", image }],
			}),
		).toThrow("WORKLOAD_IMAGE_PROJECTION_INVALID");
	});

	it("accepts real Store Desired without Kube spec and uses the trusted standard repository", () => {
		const desired = workloadDesiredFixture(1, "agent-a", "internal-only");
		expect("spec" in desired).toBe(false);
		const binding = {
			...sessionSandboxTemplateBindingFixture(desired.imageDigest),
			imageRepository: "registry.example.test/codex",
		};
		const result = parentWorkloadImageProjectionV1({
			desired,
			sourceKind: "standard",
			standardTemplateBinding: binding,
		});
		expect(result[0]?.images.map((value) => [value.kind, value.image])).toEqual(
			[["main", `registry.example.test/codex@${desired.imageDigest}`]],
		);
		expect(result[0]?.images[0]?.entrypointSource).toBe(
			"image-default-unverified",
		);
	});

	it("matches the normal custom parent renderer and performs no client calls", async () => {
		const f = fixture();
		const desired = workloadDesiredFixture();
		await f.adapter().apply(desired);
		const actual = [...f.resources.values()].find(
			(value) => value.kind === "StatefulSet",
		);
		const spec = (
			actual as {
				spec?: {
					template?: { spec?: Parameters<typeof workloadPodImagesV1>[0] };
				};
			}
		)?.spec?.template?.spec;
		if (!spec) throw new Error("missing rendered parent");
		const read = vi.spyOn(f.client, "read");
		const create = vi.spyOn(f.client, "create");
		const result = parentWorkloadImageProjectionV1({
			desired,
			sourceKind: "custom",
			policy: workloadTestPolicy,
		});
		expect(result[0]?.images).toEqual(workloadPodImagesV1(spec));
		expect(read).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});

	it("keeps custom images on the approved policy repository despite a matching standard binding", () => {
		const desired = workloadDesiredFixture();
		const binding = {
			...sessionSandboxTemplateBindingFixture(desired.imageDigest),
			imageRepository: "registry.example.test/other-standard",
		};
		const result = parentWorkloadImageProjectionV1({
			desired,
			sourceKind: "custom",
			policy: workloadTestPolicy,
			standardTemplateBinding: binding,
		});
		expect(result[0]?.images[0]?.image).toBe(
			`${workloadTestPolicy.imageRepository}@${desired.imageDigest}`,
		);
		expect(() =>
			parentWorkloadImageProjectionV1({
				desired,
				sourceKind: "custom",
				standardTemplateBinding: binding,
			}),
		).toThrow("WORKLOAD_IMAGE_REPOSITORY_REQUIRED");
	});

	it("fails closed on missing standard trust and mismatched digest/Agent/configuration", () => {
		const desired = workloadDesiredFixture(1, "agent-a", "internal-only");
		expect(() =>
			parentWorkloadImageProjectionV1({
				desired,
				sourceKind: "standard",
				policy: workloadTestPolicy,
			}),
		).toThrow("WORKLOAD_IMAGE_BINDING_MISMATCH");
		const binding = sessionSandboxTemplateBindingFixture(
			`sha256:${"2".repeat(64)}`,
		);
		expect(() =>
			parentWorkloadImageProjectionV1({
				desired,
				sourceKind: "standard",
				policy: workloadTestPolicy,
				standardTemplateBinding: binding,
			}),
		).toThrow();
		for (const change of [
			{ agentId: "foreign" },
			{ configurationRevision: 2 },
		]) {
			const projection = {
				...sessionSandboxModelProjectionFixture({
					agentId: "agent-a",
					configurationRevision: 1,
					imageDigest: desired.imageDigest,
				}),
				...change,
			};
			expect(() =>
				parentWorkloadImageProjectionV1({
					desired,
					sourceKind: "standard",
					policy: workloadTestPolicy,
					modelProjection: projection,
				}),
			).toThrow();
		}
	});

	it("requires a real nonempty snapshot shape and uses its independent immutable init image", () => {
		const base = workloadDesiredFixture();
		const record = {
			snapshotId: "snapshot-a",
			name: "repo",
			digest: `sha256:${"a".repeat(64)}`,
			sizeBytes: 32,
			objectRef: "PRIVATE_OBJECT_REF",
		};
		const desired = {
			...base,
			workspaceSnapshots: [
				{ ...record, mountPath: "/opt/agent/workspaces/repo" },
			],
		};
		expect(() =>
			parentWorkloadImageProjectionV1({
				desired,
				sourceKind: "custom",
				policy: workloadTestPolicy,
			}),
		).toThrow("WORKLOAD_SNAPSHOT_PROJECTION_REQUIRED");
		const image = `registry.example.test/materializer@sha256:${"8".repeat(64)}`;
		const shape = {
			...projectWorkspaceSnapshotPodShapeV1([record], {
				imageDigest: image,
				allowedOrigins: [],
				credentialSecretName: "reference",
				cacheSizeLimit: "1Gi",
				resources: workloadTestPolicy.resources,
			}),
			manifest: "",
		};
		const policy = {
			...workloadTestPolicy,
			workspaceSnapshotEgress: [
				{
					destination: { namespace: "storage", podLabels: { app: "storage" } },
					port: 9000,
				},
			],
		};
		const result = parentWorkloadImageProjectionV1({
			desired,
			sourceKind: "custom",
			policy,
			workspaceSnapshotProjection: shape,
		});
		expect(() =>
			parentWorkloadImageProjectionV1({
				desired,
				sourceKind: "custom",
				policy,
				workspaceSnapshotProjection: { ...shape, containerMounts: new Map() },
			}),
		).toThrow("WORKLOAD_SNAPSHOT_PROJECTION_REQUIRED");
		expect(() =>
			parentWorkloadImageProjectionV1({
				desired: base,
				sourceKind: "custom",
				policy,
				workspaceSnapshotProjection: shape,
			}),
		).toThrow("WORKLOAD_SNAPSHOT_PROJECTION_REQUIRED");
		expect(result[0]?.images.map((value) => [value.kind, value.image])).toEqual(
			[
				["main", `${policy.imageRepository}@${desired.imageDigest}`],
				["init", image],
			],
		);
		expect(JSON.stringify(result)).not.toContain(record.objectRef);
		expect(JSON.stringify(result)).not.toMatch(
			/"env"|"volumes"|"Secret"|"manifest"/,
		);
	});
});
