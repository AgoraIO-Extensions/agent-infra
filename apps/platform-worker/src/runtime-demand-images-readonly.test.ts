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
	sessionRead: vi.fn(
		async (
			namespace: string,
		): Promise<{
			namespace: string;
			observedAtDatabase: string;
			storeSnapshot: string;
			pageCount: number;
			enumerationComplete: boolean;
			emptyAfterCompleteEnumeration: boolean;
			scope: string;
			items: unknown[];
		}> => ({
			namespace,
			observedAtDatabase: "2026-11-14T12:00:00Z",
			storeSnapshot: "1:10:",
			pageCount: 1,
			enumerationComplete: true,
			emptyAfterCompleteEnumeration: true,
			scope: "namespace-and-unattributed-allocations",
			items: [],
		}),
	),
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
	openPostgresSessionSandboxImageReaderV1: (options: unknown) => {
		store.options(options);
		return { read: store.sessionRead, close: store.close };
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

it("binds an existing direct Session using its real Store row CAS, not its parent CAS", async () => {
	const directory = await mkdtemp(join(tmpdir(), "declared-session-"));
	const sandboxId = "00000000-0000-4000-8000-000000000001";
	const key = `session:${sandboxId}`;
	const casHash = "6".repeat(64);
	const metadata = {
		binding: { sandboxId },
		bindingKey: key,
		bindingStatus: "VERIFIED_STORE_COMPOSITE",
		namespace: "runtime",
		casHash,
		retained: null,
		missing: [],
	};
	try {
		const image = `ghcr.io/example/codex@sha256:${"1".repeat(64)}`;
		const path = join(directory, "session.json");
		const bytes = Buffer.from(
			JSON.stringify({
				schemaVersion: 1,
				context: input.context,
				producerSourceSha: "e".repeat(40),
				producerInputHash: "e".repeat(64),
				publications: [
					{
						image,
						role: "codex",
						sourceSha: "4".repeat(40),
						manifestHash: "4".repeat(64),
					},
				],
				groups: [
					{
						role: "session/existing",
						kind: "session",
						sourceKind: "standard",
						state: "current",
						namespace: "runtime",
						identityScope: "consumer",
						replicas: 1,
						images: [image],
						spec: {
							containers: [
								{
									name: "runtime",
									image,
									entrypointShapeHash: "a".repeat(64),
									entrypointSource: "image-default-unverified",
								},
							],
							initContainers: [],
						},
						binding: { key, hash: casHash },
						reference: {
							kind: "Pod",
							name: "existing",
							namespace: "runtime",
							uid: "pod-uid",
							resourceVersion: "9",
						},
					},
				],
			}),
		);
		await writeFile(path, bytes, { mode: 0o600 });
		const fileInput = {
			...input,
			declared: {
				path,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				producerSourceSha: "e".repeat(40),
			},
		};
		const snapshot = {
			namespace: "runtime",
			observedAtDatabase: "2026-11-14T12:00:00Z",
			storeSnapshot: "1:10:",
			pageCount: 1,
			enumerationComplete: true,
			emptyAfterCompleteEnumeration: false,
			scope: "namespace-and-unattributed-allocations",
			items: [{ metadata, workerProjectionInputs: () => [] }],
		};
		store.sessionRead.mockResolvedValueOnce(snapshot);
		const receipt = await readRuntimeDemandImages(
			fileInput,
			"postgresql://localhost/platform",
		);
		expect(receipt.bindingKeys).toContain(key);
		expect(receipt.sessionInventory.rows).toHaveLength(1);
		expect(receipt.coverage.session).toBe(
			"STORE_METADATA_ENUMERATED_IMAGE_GROUPS_PARTIAL",
		);
		expect(receipt.declared.groups[0]).toMatchObject({
			status: "BOUND_APPROVED_IMAGE_GROUP",
			binding: { key, hash: casHash },
		});
		expect(store.sessionRead).toHaveBeenCalledWith("runtime");
		for (const changed of [
			{ ...metadata, casHash: "7".repeat(64) },
			{ ...metadata, bindingStatus: "UNKNOWN_COMPOSITE_MISMATCH" },
			{ ...metadata, namespace: "foreign" },
			{ ...metadata, bindingKey: "parent-workload:custom" },
		]) {
			store.sessionRead.mockResolvedValueOnce({
				...snapshot,
				items: [{ metadata: changed, workerProjectionInputs: () => [] }],
			});
			const rejected = await readRuntimeDemandImages(
				fileInput,
				"postgresql://localhost/platform",
			);
			expect(rejected.declared.groups[0]?.status).toBe(
				"UNKNOWN_MISSING_TRUSTED_FIELD",
			);
			expect(rejected.declared.groups[0]?.images).toHaveLength(1);
		}
		const empty = await readRuntimeDemandImages(
			fileInput,
			"postgresql://localhost/platform",
		);
		expect(empty.sessionInventory.emptyAfterCompleteEnumeration).toBe(true);
		expect(empty.bindingKeys).not.toContain(key);
		expect(empty.declared.groups[0]?.status).toBe(
			"UNKNOWN_MISSING_TRUSTED_FIELD",
		);
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
	expect(store.options).toHaveBeenCalledTimes(4);
	for (const [options] of store.options.mock.calls) {
		const url = new URL(options.databaseUrl);
		expect(url.searchParams.get("options")).toContain(
			"default_transaction_read_only=on",
		);
		expect(url.searchParams.get("options")).toContain("statement_timeout=5000");
	}
	expect(store.close).toHaveBeenCalledTimes(4);
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
	expect(store.close).toHaveBeenCalledTimes(4);
});
