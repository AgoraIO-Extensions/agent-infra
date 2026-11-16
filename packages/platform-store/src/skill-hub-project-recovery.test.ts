import {
	platformIdempotencyV1,
	skillPackageObjectRefV1,
} from "@agent-infra/platform-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
	rows: [] as unknown[][],
	audit: vi.fn(),
	end: vi.fn(),
}));
vi.mock("./observed-postgres.js", () => ({
	default: () => ({ end: transport.end }),
}));
vi.mock("./outbox.js", () => ({
	createPostgresOutboxStore: () => ({ close: transport.end }),
}));
vi.mock("drizzle-orm/postgres-js", () => ({
	drizzle: () => {
		const tx = {
			execute: async () => {},
			select: () => {
				const q = {
					from: () => q,
					where: () => q,
					for: () => q,
					// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are deliberately thenable; this is the stub transport.
					then: (resolve: (rows: unknown[]) => unknown) =>
						Promise.resolve(transport.rows.shift() ?? []).then(resolve),
				};
				return q;
			},
			insert: () => ({ values: transport.audit }),
		};
		return {
			...tx,
			transaction: async (work: (transaction: typeof tx) => Promise<unknown>) =>
				work(tx),
		};
	},
}));

import { PostgresSkillHubLifecycleV1 } from "./skill-hub.js";

const op = "11111111-1111-4111-8111-111111111111";
const selection = {
	schemaVersion: 1,
	name: "review",
	skillId: "project-a",
	skillVersionId: "version-a",
	provider: "my_library",
	visibility: "PRIVATE",
	version: "1.0.0",
	sourceVersion: "project:project-a:r2",
	sourceDigest: "a".repeat(64),
	approvalRef: null,
	archiveDigest: "a".repeat(64),
	trustRevision: "trust",
	policyRevision: "policy",
};
function fixture() {
	const intent = {
		objectRef: skillPackageObjectRefV1(op, "zip"),
		sizeBytes: 10,
		mediaType: "application/zip",
		sha256: "a".repeat(64),
		evidence: null,
	};
	return {
		parent: { id: "project-a", ownerId: "owner-a", status: "active" },
		original: {
			id: op,
			actorId: "owner-a",
			scopeType: "skill_package",
			scopeId: "version-a",
			commandType: "skill.package.publish.v1",
			idempotencyKey: "original-key",
			requestDigest: platformIdempotencyV1.canonicalRequestDigest(selection),
			status: "reserved",
		},
		item: {
			id: op,
			scopeType: "skill_package",
			scopeId: "version-a",
			operation: "skill.package.publish.v1",
			status: "processing",
			payload: {
				schemaVersion: 1,
				operationId: op,
				ownerId: "owner-a",
				selection,
				intents: { zip: intent },
				objects: {
					zip: {
						...intent,
						evidence: undefined,
						version: "object-version",
						etag: "etag",
					},
				},
			},
		},
	};
}
function setup(change: (x: ReturnType<typeof fixture>) => void = () => {}) {
	const x = fixture();
	delete x.item.payload.objects.zip.evidence;
	change(x);
	transport.rows = [[], [x.parent], [x.original], [x.item]];
	const identity = {
		actor: {
			schemaVersion: 1,
			userId: "owner-a",
			accountStatus: "active",
			organizationIds: [],
			isAdministrator: false,
		},
		authorizationRevision: "auth",
	};
	const store = new PostgresSkillHubLifecycleV1({
		databaseUrl: "postgres://synthetic.invalid/no-network",
		resolveIdentity: async () => identity,
	});
	return { store, x };
}
const request = { userId: "owner-a", requestId: "request", traceId: "trace" };
beforeEach(() => {
	transport.rows = [];
	transport.audit.mockReset();
});
describe("normal owned publication recovery store read with stubbed transport", () => {
	it("returns the original private key/selection and keeps partial checkpoints without mutation", async () => {
		const { store } = setup();
		const value = await store.readProjectPublicationRecovery(
			request,
			"project-a",
			op,
		);
		expect(value).toMatchObject({
			key: "original-key",
			selection,
			completed: null,
		});
		expect(transport.audit).not.toHaveBeenCalled();
		expect(transport.rows).toHaveLength(0);
	});
	it.each([
		"owner",
		"actor",
		"scope",
		"digest",
		"operation",
		"status",
		"object",
	])("rejects foreign or corrupt %s", async (field) => {
		const { store } = setup((x) => {
			if (field === "owner") x.parent.ownerId = "owner-b";
			if (field === "actor") x.original.actorId = "owner-b";
			if (field === "scope") x.original.scopeId = "foreign";
			if (field === "digest") x.original.requestDigest = "b".repeat(64);
			if (field === "operation") x.item.operation = "foreign";
			if (field === "status") x.item.status = "succeeded";
			if (field === "object")
				x.item.payload.objects.zip.sha256 = "b".repeat(64);
		});
		await expect(
			store.readProjectPublicationRecovery(request, "project-a", op),
		).rejects.toBeDefined();
	});
	it("rejects missing original proof", async () => {
		const { store } = setup();
		transport.rows = [
			[],
			[{ id: "project-a", ownerId: "owner-a", status: "active" }],
			[],
			[],
		];
		await expect(
			store.readProjectPublicationRecovery(request, "project-a", op),
		).rejects.toMatchObject({ code: "unavailable" });
	});
});
