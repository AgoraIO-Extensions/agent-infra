import { expect, it, vi } from "vitest";
import { createWorkspaceSnapshotResolverV1 } from "./workspace-snapshot-resolver.js";

const expiresAt = new Date(Date.now() + 60_000).toISOString();
const digest = `sha256:${"a".repeat(64)}`;
const policy = {
	imageDigest: `registry.example.test/platform-worker@${digest}`,
	allowedOrigins: ["https://objects.example.test"],
	cacheSizeLimit: "2Gi",
	resources: {
		requests: { cpu: "100m", memory: "128Mi" },
		limits: { cpu: "1", memory: "512Mi" },
	},
	credentialSecretName: "workspace-snapshot-credentials",
};
const record = {
	snapshotId: "snapshot-00000000-0000-4000-8000-000000000001",
	name: "repo",
	digest,
	sizeBytes: 10,
	objectRef: "00000000-0000-4000-8000-000000000001",
	objectVersion: "version-1",
};

it("binds only the persisted name and exact object version", async () => {
	const createReadUrl = vi.fn(
		async ({ objectVersion }: { objectVersion: string }) => ({
			signedUrl: `https://objects.example.test/${objectVersion}`,
			expiresAt,
		}),
	);
	const resolver = createWorkspaceSnapshotResolverV1({
		read: async () => [record],
		createReadUrl,
		policy,
		allowedOrigins: ["https://objects.example.test"],
	});
	const result = await resolver({
		agentId: "agent-a",
		configurationRevision: 2,
		workloadRevision: 3,
		fence: 4,
		bindings: [{ snapshotId: record.snapshotId, name: "repo" }],
	});
	expect(result.inputs[0]).toMatchObject({
		objectRef: record.objectRef,
		expiresAt,
		signedUrl: expect.stringContaining("version-1"),
	});
	expect(result.projection).toBeDefined();
	expect(createReadUrl).toHaveBeenCalledWith({
		objectRef: record.objectRef,
		objectVersion: "version-1",
		expiresInSeconds: 300,
	});
});

it("rejects an object URL outside the deployment allowlist", async () => {
	const resolver = createWorkspaceSnapshotResolverV1({
		read: async () => [record],
		createReadUrl: async () => ({
			signedUrl: "https://other.example.test/object",
			expiresAt,
		}),
		policy,
		allowedOrigins: ["https://objects.example.test"],
	});
	await expect(
		resolver({
			agentId: "agent-a",
			configurationRevision: 1,
			workloadRevision: 1,
			fence: 1,
			bindings: [{ snapshotId: record.snapshotId, name: "repo" }],
		}),
	).rejects.toThrow();
});

it("rejects a returned record whose persisted binding name differs", async () => {
	const resolver = createWorkspaceSnapshotResolverV1({
		read: async () => [{ ...record, name: "other" }],
		createReadUrl: async () => ({
			signedUrl: "https://objects.example.test/object",
			expiresAt,
		}),
		policy,
		allowedOrigins: ["https://objects.example.test"],
	});
	await expect(
		resolver({
			agentId: "agent-a",
			configurationRevision: 1,
			workloadRevision: 1,
			fence: 1,
			bindings: [{ snapshotId: record.snapshotId, name: "repo" }],
		}),
	).rejects.toThrow();
});

it("does not extend authorization that expires while signing", async () => {
	const resolver = createWorkspaceSnapshotResolverV1({
		read: async () => [record],
		createReadUrl: async () => ({
			signedUrl: "https://objects.example.test/object",
			expiresAt: new Date(Date.now() - 1).toISOString(),
		}),
		policy,
		allowedOrigins: ["https://objects.example.test"],
	});
	await expect(
		resolver({
			agentId: "agent-a",
			configurationRevision: 1,
			workloadRevision: 1,
			fence: 1,
			bindings: [{ snapshotId: record.snapshotId, name: "repo" }],
		}),
	).rejects.toThrow("expiry");
});

it("isolates manifest Secrets by Agent/configuration and projects drain shape without signing", async () => {
	const sign = vi.fn(async () => ({
		signedUrl: "https://objects.example.test/archive",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	}));
	const resolver = createWorkspaceSnapshotResolverV1({
		read: async () => [record],
		createReadUrl: sign,
		policy,
		allowedOrigins: policy.allowedOrigins,
	});
	const input = {
		agentId: "agent-a",
		configurationRevision: 1,
		workloadRevision: 1,
		fence: 1,
		bindings: [{ snapshotId: record.snapshotId, name: record.name }],
	};
	const a = await resolver(input);
	const b = await resolver({ ...input, agentId: "agent-b" });
	const next = await resolver({ ...input, configurationRevision: 2 });
	const secret = (p: typeof a.projection) =>
		p.volumes.find((v) => v.name === "workspace-snapshot-credentials")?.secret
			?.secretName;
	expect(
		new Set([
			secret(a.projection),
			secret(b.projection),
			secret(next.projection),
		]).size,
	).toBe(3);
	sign.mockClear();
	const shape = resolver.project([record], input);
	expect(shape.initContainers).toEqual(a.projection.initContainers);
	expect(secret(shape)).toBe(secret(a.projection));
	expect(shape.manifest).toBe("");
	expect(sign).not.toHaveBeenCalled();
});
