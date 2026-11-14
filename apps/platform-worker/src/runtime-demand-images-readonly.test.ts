import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	options: vi.fn(),
	close: vi.fn(async () => undefined),
	listAgents: vi.fn(async () => ({
		items: [{ agentId: "custom" }],
		nextAfterId: null,
	})),
	getAgent: vi.fn(async () => ({
		management: { revision: 1, workloadRevision: 1, desiredState: "running" },
	})),
	read: vi.fn(async () => ({
		outcome: "found",
		configuration: {
			agentId: "custom",
			revision: 1,
			source: { kind: "custom", interactionMode: "platform-adapter" },
			ownerIds: ["owner"],
			environment: [{ name: "PRIVATE", value: "PRIVATE_VALUE" }],
		},
	})),
	readCurrentState: vi.fn(async () => null),
}));

vi.mock("@agent-infra/platform-store", () => ({
	PostgresAgentManagementQueryV1: class {
		constructor(options: unknown) {
			store.options(options);
		}
		listAgents = store.listAgents;
		getAgent = store.getAgent;
		close = store.close;
	},
	PostgresAgentConfigurationQueryV1: class {
		constructor(options: unknown) {
			store.options(options);
		}
		read = store.read;
		close = store.close;
	},
	openPostgresWorkloadStateReaderV1: (options: unknown) => {
		store.options(options);
		return { readCurrentState: store.readCurrentState, close: store.close };
	},
}));

import { readRuntimeDemandImages } from "./runtime-demand-images-readonly.js";

const input = {
	actorId: "owner",
	context: {
		platformSource: "2".repeat(40),
		runtimeAuthority: "4".repeat(40),
		planHash: "a".repeat(64),
		clusterUid: "cluster",
		namespace: "runtime",
		namespaceUid: "namespace",
		release: "release",
		helmRevision: 36,
		installationId: "installation",
		directoryBindingHash: "b".repeat(64),
		directorySnapshotHash: "c".repeat(64),
	},
	projections: [],
};

beforeEach(() => vi.clearAllMocks());

it("aggregates an approved declared group against the fresh normal Store CAS", async () => {
	const before = await readRuntimeDemandImages(
		input,
		"postgresql://localhost/platform",
	);
	const cas = before.rows[0]?.casHash;
	if (!cas) throw new Error("missing fixture CAS");
	const directory = await mkdtemp(join(tmpdir(), "declared-images-"));
	try {
		const image = `ghcr.io/example/custom@sha256:${"1".repeat(64)}`;
		const path = join(directory, "approved.json");
		const bytes = Buffer.from(
			JSON.stringify({
				schemaVersion: 1,
				context: input.context,
				producerSourceSha: "e".repeat(40),
				producerInputHash: "e".repeat(64),
				publications: [
					{
						image,
						role: "custom",
						sourceSha: "4".repeat(40),
						manifestHash: "4".repeat(64),
					},
				],
				groups: [
					{
						role: "custom/actual",
						kind: "parent-workload",
						sourceKind: "custom",
						state: "current",
						namespace: "runtime",
						identityScope: "consumer",
						replicas: 1,
						images: [image],
						spec: {
							containers: [
								{
									name: "main",
									image,
									entrypointShapeHash: "a".repeat(64),
									entrypointSource: "image-default-unverified",
								},
							],
							initContainers: [],
						},
						binding: { key: "parent-workload:custom", hash: cas },
						reference: null,
					},
				],
			}),
		);
		await writeFile(path, bytes, { mode: 0o600 });
		const receipt = await readRuntimeDemandImages(
			{
				...input,
				declared: {
					path,
					sha256: createHash("sha256").update(bytes).digest("hex"),
					producerSourceSha: "e".repeat(40),
				},
			},
			"postgresql://localhost/platform",
		);
		expect(receipt.declared.groups[0]).toMatchObject({
			status: "BOUND_APPROVED_IMAGE_GROUP",
			images: [{ image }],
			identityEvidence: "NO_ACTUAL_RESOURCE_PROOF",
		});
		expect(JSON.stringify(receipt)).not.toContain("PRIVATE_VALUE");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("rejects an approved-file schema/raw-field defect before constructing any Store reader", async () => {
	const directory = await mkdtemp(join(tmpdir(), "declared-images-"));
	try {
		const path = join(directory, "image-only.json");
		const bytes = Buffer.from(
			JSON.stringify({ env: { PRIVATE: "NEVER_IN_ERROR" } }),
		);
		await writeFile(path, bytes, { mode: 0o600 });
		await expect(
			readRuntimeDemandImages(
				{
					...input,
					declared: {
						path,
						sha256: createHash("sha256").update(bytes).digest("hex"),
						producerSourceSha: "e".repeat(40),
					},
				},
				"postgresql://localhost/platform",
			),
		).rejects.toThrow("RUNTIME_DEMAND_IMAGE_READ_FAILED");
		expect(store.options).not.toHaveBeenCalled();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("uses only normal Store reads with database-enforced read-only options and releases all clients", async () => {
	const receipt = await readRuntimeDemandImages(
		input,
		"postgresql://synthetic:synthetic@localhost/platform",
	);
	expect(store.options).toHaveBeenCalledTimes(3);
	for (const [options] of store.options.mock.calls) {
		const url = new URL(options.databaseUrl);
		expect(url.searchParams.get("options")).toContain(
			"default_transaction_read_only=on",
		);
		expect(url.searchParams.get("options")).toContain("statement_timeout=5000");
	}
	expect(store.close).toHaveBeenCalledTimes(3);
	expect(JSON.stringify(receipt)).not.toContain("PRIVATE_VALUE");
	expect(receipt.rows).toHaveLength(1);
	expect(receipt.globalAbsenceProven).toBe(false);
});

it("rejects missing or non-database input before constructing any Store client", async () => {
	for (const url of [undefined, "", "not-a-url", "https://localhost/private"]) {
		await expect(readRuntimeDemandImages(input, url)).rejects.toThrow();
	}
	expect(store.options).not.toHaveBeenCalled();
});

it("closes every reader when a normal Store read fails", async () => {
	store.listAgents.mockRejectedValueOnce(new Error("PRIVATE_VALUE"));
	await expect(
		readRuntimeDemandImages(input, "postgresql://localhost/platform"),
	).rejects.toThrow("RUNTIME_DEMAND_IMAGE_READ_FAILED");
	expect(store.close).toHaveBeenCalledTimes(3);
});
