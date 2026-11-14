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
