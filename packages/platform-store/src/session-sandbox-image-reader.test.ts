import { beforeEach, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
	query: vi.fn(),
	begin: vi.fn(),
	end: vi.fn(),
}));
vi.mock("./observed-postgres.js", () => ({
	default: () => ({ begin: database.begin, end: database.end }),
}));

import { openPostgresSessionSandboxImageReaderV1 } from "./session-sandbox-image-reader.js";

const privateValue = "PRIVATE_ENV_BODY_NOT_FOR_RECEIPT";
const p = {
	namespace: "runtime",
	resourceConfigurationHash: "a".repeat(64),
	imageDigest: `sha256:${"b".repeat(64)}`,
	configurationRevision: 1,
	workloadRevision: 2,
	managementFence: 3,
};
const sandboxId = (index = 1) =>
	`00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
function row(index = 1) {
	const id = sandboxId(index);
	return {
		sandbox_id: id,
		conversation_id: `conversation-${index}`,
		agent_id: "agent",
		actor_id: "owner",
		principal_type: "user",
		channel_id: "web",
		session_generation: 2,
		resource_name: `sandbox-${id}`,
		workspace_scope: id,
		status: "stopped",
		desired_state: "stopped",
		resource_fence: 4,
		resource_policy: p,
		allocation_version: "123",
		conversation_matches: true,
		resource_observation: {
			status: "stopped",
			resources: [
				{
					kind: "PersistentVolumeClaim",
					namespace: "runtime",
					name: `sandbox-${id}`,
					uid: "pvc-uid",
					resourceVersion: "9",
				},
			],
			ignored: privateValue,
		},
		management_revision: "7",
		management_fence: "3",
		configuration_revision: "1",
		workload_store_revision: "3",
		workload_store_fence: "3",
		owner_ids: ["owner"],
		outbox_id: "outbox",
		outbox_version: "456",
		outbox_status: "succeeded",
		outbox_count: 1,
		attempt_count: 1,
		delivery_fence: "1",
		lease_present: false,
		payload_schema: 1,
		payload_conversation: `conversation-${index}`,
		payload_generation: 2,
		deployment: {
			agentId: "agent",
			configRevision: 1,
			workloadRevision: 2,
			imageDigest: p.imageDigest,
			env: { PRIVATE: privateValue },
		},
		model_projection: { private: privateValue },
		lifecycle_source: null as unknown,
	};
}

function pages(...values: unknown[][]) {
	let page = 0;
	database.query.mockImplementation(async (parts: TemplateStringsArray) => {
		const sql = parts.join("?");
		if (sql.startsWith("set local")) return [];
		if (sql.includes("pg_current_snapshot()"))
			return [{ observed_at: "2026-11-14 11:12:00+00", snapshot: "1:10:" }];
		if (sql.includes("from platform.session_sandbox_allocations"))
			return values[page++] ?? [];
		throw new Error("Unexpected query");
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	database.begin.mockImplementation(async (_mode, read) =>
		read(database.query),
	);
	pages([]);
});

it("reads stored current inputs and UID/RV metadata in an enforced read-only snapshot", async () => {
	pages([row()]);
	const reader = openPostgresSessionSandboxImageReaderV1({
		databaseUrl: "postgresql://synthetic",
	});
	const result = await reader.read("runtime");
	expect(database.begin.mock.calls[0]?.[0]).toBe(
		"isolation level repeatable read read only",
	);
	expect(result.enumerationComplete).toBe(true);
	expect(result.emptyAfterCompleteEnumeration).toBe(false);
	expect(result.items[0]?.metadata).toMatchObject({
		allocationRowVersion: "123",
		bindingKey: `session:${sandboxId()}`,
		bindingStatus: "VERIFIED_STORE_COMPOSITE",
		configurationRevision: 1,
		managementRevision: 7,
		policy: p,
		resources: [{ uid: "pvc-uid", resourceVersion: "9" }],
	});
	expect(result.items[0]?.workerProjectionInputs()[0]?.source).toBe(
		"allocation",
	);
	expect(JSON.stringify(result)).not.toContain(privateValue);
	for (const [parts] of database.query.mock.calls) {
		const sql = parts.join(" ");
		expect(sql).not.toMatch(
			/\b(insert|update|delete|for share|for update|conversation_messages)\b/i,
		);
	}
	await reader.close();
	expect(database.end).toHaveBeenCalledOnce();
});

it("enumerates all pages across principals and channels without manufacturing future Sessions", async () => {
	const rows = Array.from({ length: 100 }, (_, index) => row(index + 1));
	const second = {
		...row(101),
		actor_id: "application",
		principal_type: "application",
		channel_id: "api",
	};
	pages(rows, [second]);
	const result = await openPostgresSessionSandboxImageReaderV1({
		databaseUrl: "postgresql://synthetic",
	}).read("runtime");
	expect(result.pageCount).toBe(2);
	expect(result.items).toHaveLength(101);
	expect(result.items.at(-1)?.metadata.binding.principal.kind).toBe(
		"application",
	);
	pages([]);
	const empty = await openPostgresSessionSandboxImageReaderV1({
		databaseUrl: "postgresql://synthetic",
	}).read("runtime");
	expect(empty.emptyAfterCompleteEnumeration).toBe(true);
	expect(empty.items).toEqual([]);
	expect(empty.scope).toContain("no reserves or future sessions");
});

it("keeps the exact retained lifecycle source instead of replacing it with the new allocation generation", async () => {
	const current = row();
	current.lifecycle_source = {
		sandbox: {
			schemaVersion: 1,
			sandboxId: current.sandbox_id,
			sessionId: current.conversation_id,
			agentId: "agent",
			principal: { kind: "user", id: "owner" },
			channelId: "web",
			generation: 1,
			resourceName: current.resource_name,
			workspaceScope: current.workspace_scope,
		},
		resourceFence: 2,
		policy: p,
		deployment: current.deployment,
		modelProjection: current.model_projection,
	};
	pages([current]);
	const result = await openPostgresSessionSandboxImageReaderV1({
		databaseUrl: "postgresql://synthetic",
	}).read("runtime");
	expect(
		result.items[0]
			?.workerProjectionInputs()
			.map((input) => [
				input.source,
				input.binding.generation,
				input.resourceFence,
			]),
	).toEqual([
		["allocation", 2, 4],
		["retained-lifecycle", 1, 2],
	]);
	const forged = structuredClone(current);
	(
		forged.lifecycle_source as { sandbox: { principal: { id: string } } }
	).sandbox.principal.id = "other-owner";
	pages([forged]);
	const negative = await openPostgresSessionSandboxImageReaderV1({
		databaseUrl: "postgresql://synthetic",
	}).read("runtime");
	expect(negative.items[0]?.workerProjectionInputs()).toHaveLength(1);
	expect(negative.items[0]?.metadata.missing).toContain(
		"sandbox-outbox.lifecycle.source binding/policy/deployment",
	);
});

it.each([
	{ conversation_matches: false },
	{ outbox_count: 2 },
	{ payload_generation: 1 },
	{ payload_conversation: "other" },
	{ deployment: { ...row().deployment, configRevision: 2 } },
	{ deployment: { ...row().deployment, workloadRevision: 3 } },
	{
		deployment: {
			...row().deployment,
			imageDigest: `sha256:${"c".repeat(64)}`,
		},
	},
	{ resource_policy: null },
])(
	"preserves unknown rows and rejects mismatched input authority (%j)",
	async (change) => {
		pages([{ ...row(), ...change }]);
		const result = await openPostgresSessionSandboxImageReaderV1({
			databaseUrl: "postgresql://synthetic",
		}).read("runtime");
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.metadata.inputStatus).toBe(
			"UNKNOWN_MISSING_TRUSTED_FIELD",
		);
		expect(result.items[0]?.workerProjectionInputs()).toHaveLength(0);
		expect(result.emptyAfterCompleteEnumeration).toBe(false);
	},
);

it("fails closed on duplicate joins rather than treating an ambiguous outbox as complete", async () => {
	pages([row(), row()]);
	await expect(
		openPostgresSessionSandboxImageReaderV1({
			databaseUrl: "postgresql://synthetic",
		}).read("runtime"),
	).rejects.toThrow("SESSION_IMAGE_READ_FAILED");
});

it("returns only a safe error when Store or namespace input fails", async () => {
	database.begin.mockRejectedValueOnce(new Error(privateValue));
	await expect(
		openPostgresSessionSandboxImageReaderV1({
			databaseUrl: "postgresql://synthetic",
		}).read("runtime"),
	).rejects.toThrow("SESSION_IMAGE_READ_FAILED");
	await expect(
		openPostgresSessionSandboxImageReaderV1({
			databaseUrl: "postgresql://synthetic",
		}).read("wrong/namespace"),
	).rejects.toThrow("SESSION_IMAGE_READ_FAILED");
});
