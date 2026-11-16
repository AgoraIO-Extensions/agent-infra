import { createHash } from "node:crypto";
import {
	createSkillHubProjectPublicationV1,
	normalizeSkillHubProjectFilesV1,
	platformIdempotencyV1,
	skillPackageObjectRefV1,
} from "@agent-infra/platform-core";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
	rows: [] as unknown[][],
	clauses: [] as unknown[],
	claim: vi.fn(),
	renew: vi.fn(),
	scheduleRetry: vi.fn(),
	markFailed: vi.fn(),
	audit: vi.fn(),
	end: vi.fn(),
}));
vi.mock("./observed-postgres.js", () => ({
	default: () => ({ end: transport.end }),
}));
vi.mock("./outbox.js", () => ({
	createPostgresOutboxStore: () => ({
		close: transport.end,
		claim: transport.claim,
		renew: transport.renew,
		scheduleRetry: transport.scheduleRetry,
		markFailed: transport.markFailed,
	}),
}));
vi.mock("drizzle-orm/postgres-js", () => ({
	drizzle: () => {
		const tx = {
			execute: async () => {},
			select: () => {
				const q = {
					from: () => q,
					where: (clause: unknown) => {
						transport.clauses.push(clause);
						return q;
					},
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
		parent: {
			id: "project-a",
			name: "review",
			ownerId: "owner-a",
			status: "active",
		},
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
	transport.clauses = [];
	transport.claim.mockReset().mockResolvedValue(null);
	transport.renew.mockReset().mockResolvedValue({});
	transport.scheduleRetry.mockReset().mockResolvedValue(null);
	transport.markFailed.mockReset().mockResolvedValue(null);
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

describe("recovery-only reservation and fresh fence", () => {
	it("filters active processing leases by database time before returning recovery inputs", async () => {
		const { store, x } = setup();
		transport.rows = [[], [x.parent], [x.original], []];
		await expect(
			store.readProjectPublicationRecovery(request, "project-a", op),
		).rejects.toMatchObject({ code: "unavailable" });
		const clause = transport.clauses.at(-1) as SQL;
		const query = new PgDialect().sqlToQuery(clause).sql;
		expect(query).toContain('"lease_expires_at" <= clock_timestamp()');
		expect(query).toContain('"lease_expires_at" is not null');
	});
	it.each(["missing", "replaced"])(
		"never creates a new operation when original reservation is %s",
		async (mode) => {
			const { store, x } = setup();
			transport.rows = [
				[],
				mode === "missing"
					? []
					: [{ ...x.original, id: "22222222-2222-4222-8222-222222222222" }],
			];
			const work = vi.fn();
			await expect(
				store.resumePackage(
					request,
					op,
					"original-key",
					selection,
					work,
					async () => {},
				),
			).rejects.toMatchObject({ code: "unavailable" });
			expect(work).not.toHaveBeenCalled();
			expect(transport.claim).not.toHaveBeenCalled();
			expect(
				transport.audit.mock.calls.every(
					([value]) => value.scopeType !== "skill_package",
				),
			).toBe(true);
		},
	);
	it("rechecks the atomic claim after input read and does no package work when lease is active", async () => {
		const { store, x } = setup();
		transport.rows = [
			[],
			[x.original],
			[{ id: op, status: "processing" }],
			[x.parent],
			[x.item],
		];
		const work = vi.fn();
		await expect(
			store.resumePackage(
				request,
				op,
				"original-key",
				selection,
				work,
				async () => {},
			),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(transport.claim).toHaveBeenCalledOnce();
		expect(work).not.toHaveBeenCalled();
	});
	it("uses the newly claimed fence for guarded work and unknown failure, never a new operation", async () => {
		const { store, x } = setup();
		transport.rows = [
			[],
			[x.original],
			[{ id: op, status: "processing" }],
			[x.parent],
			[x.item],
		];
		transport.claim.mockResolvedValue({
			payload: x.item.payload,
			deliveryFence: 2n,
		});
		const work = vi.fn(
			async (publication: {
				state: { operationId: string };
				guard: () => Promise<void>;
			}) => {
				expect(publication.state.operationId).toBe(op);
				await publication.guard();
				throw Object.assign(new Error("synthetic unknown work result"), {
					code: "unavailable",
				});
			},
		);
		await expect(
			store.resumePackage(
				request,
				op,
				"original-key",
				selection,
				work,
				async () => {},
			),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(work).toHaveBeenCalledOnce();
		expect(
			transport.renew.mock.calls.every(
				([lease]) => lease.itemId === op && lease.deliveryFence === 2n,
			),
		).toBe(true);
		expect(transport.scheduleRetry).toHaveBeenCalledWith(
			expect.objectContaining({ itemId: op, deliveryFence: 2n }),
		);
		expect(
			transport.audit.mock.calls.every(
				([value]) => value.scopeType !== "skill_package",
			),
		).toBe(true);
	});
});

it("normal domain recovery cannot recreate an operation removed after its authorized read", async () => {
	const { store, x } = setup();
	const archive = new TextEncoder().encode("synthetic archive");
	const digest = createHash("sha256").update(archive).digest("hex");
	const versionId = `skill-version-${createHash("sha256").update("project:project-a:owner-a:original-key").digest("hex").slice(0, 48)}`;
	const selected = {
		...selection,
		skillVersionId: versionId,
		sourceDigest: digest,
		archiveDigest: digest,
	};
	x.original.scopeId = versionId;
	x.original.requestDigest =
		platformIdempotencyV1.canonicalRequestDigest(selected);
	x.item.scopeId = versionId;
	x.item.payload.selection = selected;
	x.item.payload.intents.zip.sha256 = digest;
	x.item.payload.intents.zip.sizeBytes = archive.byteLength;
	x.item.payload.objects.zip.sha256 = digest;
	x.item.payload.objects.zip.sizeBytes = archive.byteLength;
	// Original read succeeds; the following reservation lookup observes the record removed.
	// Extra rows let the old ordinary-publish fallback actually reserve a new operation in the stub transport.
	transport.rows = [
		[],
		[x.parent],
		[x.original],
		[x.item],
		[],
		[],
		[],
		[x.parent],
		[],
		[],
	];
	let enteredAdmit = 0;
	const work = vi.fn();
	const publication = createSkillHubProjectPublicationV1({
		readRecovery: (context, projectId, operationId) =>
			store.readProjectPublicationRecovery(context, projectId, operationId),
		readSource: async (_context, _project, check) => {
			const source = {
				project: {
					schemaVersion: 1 as const,
					projectId: "project-a",
					name: "review",
					ownerId: "owner-a",
					organizationId: null,
					status: "active" as const,
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
				},
				revision: 2,
				organizationMember: false,
				content: normalizeSkillHubProjectFilesV1([
					{ path: "SKILL.md", bytes: new TextEncoder().encode("# review") },
				]),
			};
			check(source);
			return source;
		},
		pack: () => archive,
		admit: async (candidate) => {
			enteredAdmit++;
			const input = {
				schemaVersion: 1,
				...candidate.selection,
				...candidate.source,
				trustRevision: "trust",
				policyRevision: "policy",
				archiveDigest: digest,
			};
			return candidate.operationId === undefined
				? store.publishPackage(
						candidate.context,
						candidate.key,
						input,
						work,
						async () => {},
					)
				: store.resumePackage(
						candidate.context,
						candidate.operationId,
						candidate.key,
						input,
						work,
						async () => {},
					);
		},
	});
	await expect(
		publication.recover(request, "project-a", op),
	).rejects.toMatchObject({ code: "unavailable" });
	expect(enteredAdmit).toBe(1);
	expect(work).not.toHaveBeenCalled();
	expect(transport.claim).not.toHaveBeenCalled();
	expect(
		transport.audit.mock.calls.filter(
			([value]) => value.scopeType === "skill_package",
		),
	).toEqual([]);
});
