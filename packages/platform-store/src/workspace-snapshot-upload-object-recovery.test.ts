import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	type WorkspaceSnapshotPrincipalV1,
	type WorkspaceSnapshotRecordV1,
	workspaceSnapshotLimitsV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { PostgresWorkspaceSnapshotUploadStoreV1 } from "./workspace-snapshot-upload-store.js";
import { PostgresWorkspaceSnapshotStoreV1 } from "./workspace-snapshots.js";

let database: PostgresTestDatabase;
let db: ReturnType<typeof postgres>;
let store: PostgresWorkspaceSnapshotUploadStoreV1;
let metadata: PostgresWorkspaceSnapshotStoreV1;
beforeAll(async () => {
	database = await startPostgresTestDatabase("snapshot-object-recovery-4065");
	await migratePlatformDatabase(database);
	db = postgres(database.databaseUrl, { max: 8 });
	store = new PostgresWorkspaceSnapshotUploadStoreV1(database.databaseUrl);
	metadata = new PostgresWorkspaceSnapshotStoreV1(database.databaseUrl);
}, 120_000);
beforeEach(async () => {
	// This file owns the entire freshly provisioned test DB, never a deployment database.
	await db`truncate platform.workspace_snapshot_upload_objects,
		platform.workspace_snapshot_upload_reservations, platform.workspace_snapshot_bindings,
		platform.workspace_snapshots, platform.idempotency_records, platform.audit_events,
		platform.platform_api_credentials cascade`;
});
afterAll(async () => {
	await store?.close();
	await metadata?.close();
	await db?.end();
	await database?.stop();
});

const requestDigest = "b".repeat(64);
const maxArchive = workspaceSnapshotLimitsV1.maxArchiveBytes;
const owner = (): WorkspaceSnapshotPrincipalV1 => ({
	kind: "user",
	id: randomUUID(),
	scopes: ["agent:create", "agent:read", "agent:manage"],
});
async function reserve(who = owner(), key = randomUUID(), bytes = maxArchive) {
	const result = await store.reserveUpload(
		who,
		key,
		requestDigest,
		bytes,
		new Date(Date.now() + 600_000).toISOString(),
	);
	if (result.state !== "reserved") throw new Error("Expected test reservation");
	return { who, key, id: result.reservationId, ref: randomUUID() };
}
type Lease = Awaited<ReturnType<typeof reserve>>;
async function declared(who = owner(), key = randomUUID()) {
	const lease = await reserve(who, key);
	await store.beginUploadObject(lease.who, lease.id, lease.ref);
	return lease;
}
async function expire(lease: Lease) {
	await db`update platform.workspace_snapshot_upload_reservations set expires_at=clock_timestamp()-interval '1 second' where id=${lease.id}`;
	await db`update platform.workspace_snapshot_upload_objects set expires_at=clock_timestamp()-interval '1 second' where object_ref=${lease.ref}`;
}
async function reservation(lease: Lease) {
	const [row] =
		await db`select id,status,object_ref,object_version,released_at from platform.workspace_snapshot_upload_reservations where id=${lease.id}`;
	return row;
}
async function intent(lease: Lease) {
	const [row] =
		await db`select object_ref,reservation_id,owner_type,owner_id,idempotency_key,request_digest,state,object_version,fence_version,scan_cursor from platform.workspace_snapshot_upload_objects where object_ref=${lease.ref}`;
	return row;
}
function snapshot(
	who: WorkspaceSnapshotPrincipalV1,
	ref: string,
	version: string,
): WorkspaceSnapshotRecordV1 {
	return {
		snapshotId: randomUUID(),
		ownerType: who.kind,
		ownerId: who.id,
		digest: `sha256:${"a".repeat(64)}`,
		sizeBytes: 16,
		unpackedSizeBytes: 16,
		fileCount: 1,
		mediaType: "application/x-tar+gzip",
		source: { kind: "direct-upload" },
		objectRef: ref,
		objectVersion: version,
		status: "ready",
		createdAt: new Date().toISOString(),
		bindings: [],
	};
}

/** Controlled storage callbacks test the real PG state machine; native S3 semantics have separate conformance. */
function versions(ref: string, initial = ["data-v1"]) {
	const state = {
		versions: [...initial],
		fence: `fence-${randomUUID()}`,
		failFence: false,
		failDelete: null as string | null,
	};
	const scope = (actual: string) => {
		if (actual !== ref) throw new Error("Unexpected storage target");
	};
	const storage = {
		fenceUpload: vi.fn(async (actual: string) => {
			scope(actual);
			if (state.failFence) throw new Error("Synthetic fence unavailable");
			if (!state.versions.includes(state.fence))
				state.versions.unshift(state.fence);
			return { version: state.fence };
		}),
		scan: vi.fn(
			async (cursor: string | null, limit: number, actual?: string) => {
				if (actual === undefined) throw new Error("Unscoped scan refused");
				scope(actual);
				if (limit !== 100) throw new Error("Unbounded recovery page");
				// A deleted VersionIdMarker is deliberately invalid: recovery must rescan from the retained fence.
				const position =
					cursor === null ? 0 : state.versions.indexOf(cursor) + 1;
				if (cursor !== null && position === 0)
					throw new Error("Deleted cursor version");
				const page = state.versions.slice(position, position + limit);
				return {
					objects: page.map((version) => ({
						objectRef: ref,
						version,
						createdAt: "2026-01-01T00:00:00Z",
					})),
					cursor:
						position + page.length < state.versions.length
							? (page.at(-1) ?? null)
							: null,
				};
			},
		),
		remove: vi.fn(async (actual: string, version: string) => {
			scope(actual);
			if (version === state.fence) throw new Error("Current fence must remain");
			if (version === state.failDelete)
				throw new Error("Synthetic deletion unavailable");
			const index = state.versions.indexOf(version);
			if (index >= 0) state.versions.splice(index, 1);
		}),
	};
	return { state, storage };
}
const collect = (
	storage: Parameters<
		PostgresWorkspaceSnapshotUploadStoreV1["collectUploadObjects"]
	>[0]["storage"],
	limit = 100,
) => store.collectUploadObjects({ now: new Date(), limit, storage });
async function fillRemainingQuota(who: WorkspaceSnapshotPrincipalV1) {
	for (let index = 0; index < 4; index++) await reserve(who);
}

it("persists one immutable pre-write intent and permits only the same returned version", async () => {
	const lease = await declared();
	expect(await reservation(lease)).toMatchObject({
		status: "reserved",
		object_ref: lease.ref,
		object_version: null,
		released_at: null,
	});
	expect(await intent(lease)).toMatchObject({
		object_ref: lease.ref,
		reservation_id: lease.id,
		owner_type: lease.who.kind,
		owner_id: lease.who.id,
		idempotency_key: lease.key,
		request_digest: requestDigest,
		state: "pending",
		object_version: null,
	});
	await store.beginUploadObject(lease.who, lease.id, lease.ref);
	await expect(
		store.beginUploadObject(lease.who, lease.id, randomUUID()),
	).rejects.toMatchObject({ code: "unavailable" });
	await expect(
		store.attachUploadObject(lease.who, lease.id, randomUUID(), "data-v1"),
	).rejects.toMatchObject({ code: "unavailable" });
	await store.attachUploadObject(lease.who, lease.id, lease.ref, "data-v1");
	await store.attachUploadObject(lease.who, lease.id, lease.ref, "data-v1");
	await expect(
		store.attachUploadObject(lease.who, lease.id, lease.ref, "data-v2"),
	).rejects.toMatchObject({ code: "unavailable" });
	expect(await intent(lease)).toMatchObject({ object_version: "data-v1" });
	expect(
		(
			await db`select count(*)::int as count from platform.workspace_snapshot_upload_objects`
		)[0]?.count,
	).toBe(1);
});

it("rejects foreign owners, owner-kind collisions and expired declarations without moving the intent", async () => {
	const lease = await declared();
	for (const other of [
		owner(),
		{ ...lease.who, kind: "application" as const },
	]) {
		await expect(
			store.beginUploadObject(other, lease.id, lease.ref),
		).rejects.toMatchObject({ code: "conflict" });
		await expect(
			store.attachUploadObject(other, lease.id, lease.ref, "data-v1"),
		).rejects.toMatchObject({ code: "unavailable" });
		await expect(
			store.retireUploadObject(other, lease.id, lease.ref),
		).rejects.toMatchObject({ code: "not_found" });
	}
	await expire(lease);
	await expect(
		store.beginUploadObject(lease.who, lease.id, lease.ref),
	).rejects.toMatchObject({ code: "unavailable" });
	expect(await intent(lease)).toMatchObject({
		owner_type: "user",
		owner_id: lease.who.id,
		state: "pending",
		object_version: null,
	});
});

it("retains unknown PUT charge through legacy recovery, fence failure and deletion failure", async () => {
	const lease = await declared();
	await fillRemainingQuota(lease.who);
	await expire(lease);
	await store.releaseUploadReservation(lease.who, lease.id);
	const legacyDelete = vi.fn(async () => undefined);
	expect(
		await store.collectExpiredUploadReservations({
			now: new Date(),
			deleter: { deleteObjectVersion: legacyDelete },
		}),
	).toMatchObject({ released: 0, failed: 0 });
	expect(legacyDelete).not.toHaveBeenCalled();
	const f = versions(lease.ref);
	f.state.failFence = true;
	expect(await collect(f.storage)).toMatchObject({ failed: 1, released: 0 });
	expect(await intent(lease)).toMatchObject({
		state: "retired",
		scan_cursor: null,
	});
	await expect(reserve(lease.who)).rejects.toMatchObject({
		code: "quota_exceeded",
	});
	f.state.failFence = false;
	f.state.failDelete = "data-v1";
	expect(await collect(f.storage)).toMatchObject({ failed: 1, released: 0 });
	expect(await reservation(lease)).toMatchObject({
		object_ref: lease.ref,
		object_version: null,
		released_at: null,
	});
	await expect(reserve(lease.who)).rejects.toMatchObject({
		code: "quota_exceeded",
	});
	f.state.failDelete = null;
	expect(await collect(f.storage)).toMatchObject({
		failed: 0,
		released: 1,
		deletedVersions: 1,
	});
	expect(await reservation(lease)).toMatchObject({
		status: "released",
		object_ref: null,
		released_at: expect.any(Date),
	});
	expect(f.state.versions).toEqual([f.state.fence]);
	await expect(reserve(lease.who)).resolves.toHaveProperty("id");
});

it("requires a confirmed fence even when the unknown upload has no visible object", async () => {
	const lease = await declared();
	await store.retireUploadObject(lease.who, lease.id, lease.ref);
	await expect(
		store.releaseUploadReservation(lease.who, lease.id, {
			objectRef: randomUUID(),
			version: "fence",
		}),
	).rejects.toMatchObject({ code: "conflict" });
	const f = versions(lease.ref, []);
	f.state.failFence = true;
	expect(await collect(f.storage)).toMatchObject({ failed: 1, released: 0 });
	expect(f.storage.scan).not.toHaveBeenCalled();
	expect(await reservation(lease)).toMatchObject({ released_at: null });
	f.state.failFence = false;
	expect(await collect(f.storage)).toMatchObject({
		released: 1,
		failed: 0,
		deletedVersions: 0,
	});
	expect(f.state.versions).toEqual([f.state.fence]);
	expect(f.storage.scan).toHaveBeenCalledWith(null, 100, lease.ref);
	expect(await intent(lease)).toMatchObject({
		state: "retired",
		fence_version: f.state.fence,
		scan_cursor: null,
	});
});

it.each([
	"foreign-ref",
	"invalid-version",
	"invalid-date",
	"missing-fence",
] as const)(
	"retains charge and refuses deletion from a malformed recovery page: %s",
	async (failure) => {
		const lease = await declared();
		await expire(lease);
		const f = versions(lease.ref);
		const object = {
			objectRef: lease.ref,
			version: "data-v1",
			createdAt: "2026-01-01T00:00:00Z",
		};
		if (failure === "foreign-ref") object.objectRef = randomUUID();
		if (failure === "invalid-version") object.version = "null";
		if (failure === "invalid-date") object.createdAt = "invalid";
		f.storage.scan.mockImplementationOnce(async () => ({
			objects: failure === "missing-fence" ? [] : [object],
			cursor: null,
		}));
		expect(await collect(f.storage)).toMatchObject({ failed: 1, released: 0 });
		expect(f.storage.remove).not.toHaveBeenCalled();
		expect(await reservation(lease)).toMatchObject({
			object_ref: lease.ref,
			released_at: null,
		});
		expect(await intent(lease)).toMatchObject({
			state: "retired",
			scan_cursor: null,
		});
	},
);

it("does not let an application clock claim an unexpired writer or fence published history", async () => {
	const lease = await declared();
	const f = versions(lease.ref);
	expect(
		await store.collectUploadObjects({
			now: new Date(Date.now() + 3_600_000),
			storage: f.storage,
		}),
	).toMatchObject({ released: 0, failed: 0 });
	expect(f.storage.fenceUpload).not.toHaveBeenCalled();
	await store.attachUploadObject(lease.who, lease.id, lease.ref, "data-v1");
	const original = snapshot(lease.who, lease.ref, "data-v1");
	await store.create(original, lease.who, lease.key, requestDigest, lease.id);
	const other = owner();
	await metadata.create({
		...snapshot(other, lease.ref, "data-v1"),
		createdAt: "2000-01-01T00:00:00Z",
	});
	await db`update platform.workspace_snapshots set status='deleted',deleted_at=clock_timestamp() where id=${original.snapshotId}`;
	await expire(lease);
	expect(await collect(f.storage)).toMatchObject({
		scanned: 0,
		released: 0,
		failed: 0,
	});
	await expect(
		store.retireUploadObject(lease.who, lease.id, lease.ref),
	).rejects.toMatchObject({ code: "conflict" });
	expect(f.storage.fenceUpload).not.toHaveBeenCalled();
	expect(await intent(lease)).toMatchObject({ state: "published" });
});

it("retired refs cannot be republished through either creator, even with a new version or owner", async () => {
	const lease = await declared();
	await store.attachUploadObject(lease.who, lease.id, lease.ref, "data-v1");
	await store.retireUploadObject(lease.who, lease.id, lease.ref);
	for (const who of [lease.who, owner()])
		for (const version of ["data-v1", "data-v2"]) {
			const record = snapshot(who, lease.ref, version);
			await expect(
				store.create(record, who, randomUUID(), requestDigest),
			).rejects.toMatchObject({ code: "conflict" });
			await expect(metadata.create(record)).rejects.toMatchObject({
				code: "conflict",
			});
		}
	await expect(
		store.attachUploadObject(lease.who, lease.id, lease.ref, "data-v1"),
	).rejects.toMatchObject({ code: "unavailable" });
	expect(
		(
			await db`select count(*)::int as count from platform.workspace_snapshots`
		)[0]?.count,
	).toBe(0);
});

it("commits retirement before I/O and does not reopen publication when that I/O rolls back", async () => {
	const lease = await declared();
	await expire(lease);
	const f = versions(lease.ref);
	let publisher: Promise<unknown> | undefined;
	f.storage.fenceUpload.mockImplementationOnce(async () => {
		expect(await intent(lease)).toMatchObject({ state: "retired" });
		publisher = metadata.create(snapshot(owner(), lease.ref, "data-v2")).then(
			() => "unexpected publish",
			(error: unknown) => error,
		);
		throw new Error("Synthetic unknown fence response");
	});
	expect(await collect(f.storage)).toMatchObject({ failed: 1, released: 0 });
	expect(await publisher).toMatchObject({ code: "conflict" });
	expect(await intent(lease)).toMatchObject({
		state: "retired",
		fence_version: null,
		scan_cursor: null,
	});
	expect(await reservation(lease)).toMatchObject({
		object_ref: lease.ref,
		released_at: null,
	});
});

it("revocation prevents new writes while held-lease retirement and cleanup remain authorized", async () => {
	const who = owner();
	const material = `papi_${randomBytes(32).toString("base64url")}`;
	const credentialId = randomUUID();
	await db`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values (${credentialId},'user',${who.id},${createHash("sha256").update(material).digest("hex")},${db.json([...who.scopes])})`;
	const directory = {
		resolveUser: async (id: string) => ({
			schemaVersion: 1,
			userId: id,
			accountStatus: "active",
			organizationIds: [],
			authorizationRevision: "test-1",
		}),
	};
	const bound = store.forCredential(material, directory).store;
	const lease = await reserve(who);
	await bound.beginUploadObject(who, lease.id, lease.ref);
	await db`update platform.platform_api_credentials set revoked_at=clock_timestamp() where id=${credentialId}`;
	await expect(
		bound.beginUploadObject(who, lease.id, lease.ref),
	).rejects.toMatchObject({ code: "authentication_required" });
	await expect(
		bound.attachUploadObject(who, lease.id, lease.ref, "data-v1"),
	).rejects.toMatchObject({ code: "authentication_required" });
	await expect(
		bound.create(
			snapshot(who, lease.ref, "data-v1"),
			who,
			lease.key,
			requestDigest,
			lease.id,
		),
	).rejects.toMatchObject({ code: "authentication_required" });
	await bound.retireUploadObject(who, lease.id, lease.ref);
	await bound.releaseUploadReservation(who, lease.id);
	expect(await reservation(lease)).toMatchObject({ released_at: null });
	const f = versions(lease.ref);
	expect(await collect(f.storage)).toMatchObject({ released: 1, failed: 0 });
	expect(await store.findIdempotency(who, lease.key)).toBeNull();
	expect(
		(
			await db`select revoked_at is not null as revoked from platform.platform_api_credentials where id=${credentialId}`
		)[0]?.revoked,
	).toBe(true);
});

it("keeps the old ledger after same-key reuse and old cleanup cannot release the new lease", async () => {
	const lease = await declared();
	await expire(lease);
	const f = versions(lease.ref);
	expect(await collect(f.storage)).toMatchObject({ released: 1, failed: 0 });
	const newer = await reserve(lease.who, lease.key);
	expect(newer.id).not.toBe(lease.id);
	await store.beginUploadObject(newer.who, newer.id, newer.ref);
	await store.releaseUploadReservation(lease.who, lease.id, {
		objectRef: lease.ref,
		version: f.state.fence,
	});
	expect(await collect(f.storage)).toMatchObject({ released: 0, failed: 0 });
	expect(await reservation(newer)).toMatchObject({
		status: "reserved",
		object_ref: newer.ref,
		released_at: null,
	});
	expect(await intent(lease)).toMatchObject({
		reservation_id: lease.id,
		object_ref: lease.ref,
		state: "retired",
	});
	expect(await intent(newer)).toMatchObject({
		reservation_id: newer.id,
		object_ref: newer.ref,
		state: "pending",
	});
	expect(
		(
			await db`select count(*)::int as count from platform.workspace_snapshot_upload_objects`
		)[0]?.count,
	).toBe(2);
});

it("resets successful deletion pages instead of using a deleted VersionIdMarker", async () => {
	const lease = await declared();
	await expire(lease);
	const f = versions(
		lease.ref,
		Array.from({ length: 105 }, (_, index) => `data-${index}`),
	);
	expect(await collect(f.storage)).toMatchObject({
		continued: 1,
		released: 0,
		deletedVersions: 99,
		failed: 0,
	});
	expect(await intent(lease)).toMatchObject({ scan_cursor: null });
	expect(await reservation(lease)).toMatchObject({ released_at: null });
	expect(await collect(f.storage)).toMatchObject({
		released: 1,
		deletedVersions: 6,
		failed: 0,
	});
	expect(f.storage.scan.mock.calls.map(([cursor]) => cursor)).toEqual([
		null,
		null,
	]);
	expect(f.state.versions).toEqual([f.state.fence]);
}, 20_000);

it("keeps failed-page charge/checkpoint while retrying already-deleted exact versions safely", async () => {
	const lease = await declared();
	await expire(lease);
	const f = versions(
		lease.ref,
		Array.from({ length: 105 }, (_, index) => `data-${index}`),
	);
	f.state.failDelete = "data-49";
	expect(await collect(f.storage)).toMatchObject({ failed: 1, released: 0 });
	expect(await intent(lease)).toMatchObject({
		state: "retired",
		scan_cursor: null,
	});
	expect(await reservation(lease)).toMatchObject({
		object_ref: lease.ref,
		released_at: null,
	});
	expect(f.state.versions).not.toContain("data-0");
	f.state.failDelete = null;
	expect(await collect(f.storage)).toMatchObject({ released: 1, failed: 0 });
	expect(f.storage.scan.mock.calls.map(([cursor]) => cursor)).toEqual([
		null,
		null,
	]);
	expect(f.state.versions).toEqual([f.state.fence]);
}, 20_000);

it("advances an undeleted fence-only page and restarts when its fence version changes", async () => {
	const lease = await declared();
	await expire(lease);
	const f = versions(lease.ref);
	f.storage.scan.mockImplementationOnce(async () => ({
		objects: [
			{
				objectRef: lease.ref,
				version: f.state.fence,
				createdAt: "2026-01-01T00:00:00Z",
			},
		],
		cursor: f.state.fence,
	}));
	expect(await collect(f.storage)).toMatchObject({
		continued: 1,
		released: 0,
		deletedVersions: 0,
		failed: 0,
	});
	const oldFence = f.state.fence;
	expect(await intent(lease)).toMatchObject({
		fence_version: oldFence,
		scan_cursor: oldFence,
	});
	f.state.fence = `fence-${randomUUID()}`;
	expect(await collect(f.storage)).toMatchObject({
		released: 1,
		failed: 0,
		deletedVersions: 2,
	});
	expect(f.storage.scan.mock.calls[1]?.[0]).toBeNull();
	expect(await intent(lease)).toMatchObject({
		fence_version: f.state.fence,
		scan_cursor: null,
	});
	expect(f.state.versions).toEqual([f.state.fence]);
});

it("does not release after a fence changes during page I/O", async () => {
	const lease = await declared();
	await expire(lease);
	const f = versions(lease.ref);
	const fence = f.storage.fenceUpload.getMockImplementation();
	if (!fence) throw new Error("Missing storage callback");
	let calls = 0;
	f.storage.fenceUpload.mockImplementation(async (ref) => {
		calls++;
		if (calls === 2) f.state.fence = `fence-${randomUUID()}`;
		return fence(ref);
	});
	expect(await collect(f.storage)).toMatchObject({ failed: 1, released: 0 });
	expect(await intent(lease)).toMatchObject({
		state: "retired",
		scan_cursor: null,
	});
	expect(await reservation(lease)).toMatchObject({ released_at: null });
	expect(await collect(f.storage)).toMatchObject({ failed: 0, released: 1 });
	expect(f.state.versions).toEqual([f.state.fence]);
});

it("rotates a failed oldest intent so another owner can progress in a bounded batch", async () => {
	const a = await declared();
	const b = await declared();
	await expire(a);
	await expire(b);
	await db`update platform.workspace_snapshot_upload_objects set updated_at='2000-01-01' where object_ref=${a.ref}`;
	await db`update platform.workspace_snapshot_upload_objects set updated_at='2001-01-01' where object_ref=${b.ref}`;
	const bad = versions(a.ref);
	bad.state.failFence = true;
	const good = versions(b.ref);
	const target = (ref: string) => {
		if (ref === a.ref) return bad.storage;
		if (ref === b.ref) return good.storage;
		throw new Error("Unexpected intent");
	};
	const storage = {
		fenceUpload: (ref: string) => target(ref).fenceUpload(ref),
		scan: (cursor: string | null, limit: number, ref?: string) => {
			if (!ref) throw new Error("Missing exact scope");
			return target(ref).scan(cursor, limit, ref);
		},
		remove: (ref: string, version: string) => target(ref).remove(ref, version),
	};
	expect(await collect(storage, 1)).toMatchObject({
		scanned: 1,
		failed: 1,
		released: 0,
	});
	expect(await collect(storage, 1)).toMatchObject({
		scanned: 1,
		failed: 0,
		released: 1,
	});
	expect(await reservation(a)).toMatchObject({
		object_ref: a.ref,
		released_at: null,
	});
	expect(await reservation(b)).toMatchObject({
		status: "released",
		released_at: expect.any(Date),
	});
	await expect(collect(storage, 101)).rejects.toMatchObject({
		code: "invalid_input",
	});
});

// This models imported/pending accounting plus an authoritative completed receipt;
// a new upload commits ready/receipt/ledger together and cannot split these states.
it("repairs only an exact committed tuple before any storage fence", async () => {
	const lease = await declared();
	await store.attachUploadObject(lease.who, lease.id, lease.ref, "data-v1");
	const saved = await store.create(
		snapshot(lease.who, lease.ref, "data-v1"),
		lease.who,
		lease.key,
		requestDigest,
		lease.id,
	);
	await db`update platform.workspace_snapshot_upload_objects set state='pending' where object_ref=${lease.ref}`;
	await db`update platform.workspace_snapshot_upload_reservations set status='reserved',snapshot_id=null where id=${lease.id}`;
	await expire(lease);
	const f = versions(lease.ref);
	expect(await collect(f.storage)).toMatchObject({
		reconciled: 1,
		released: 0,
		failed: 0,
	});
	expect(f.storage.fenceUpload).not.toHaveBeenCalled();
	expect(f.storage.remove).not.toHaveBeenCalled();
	expect(await intent(lease)).toMatchObject({
		state: "published",
		object_version: "data-v1",
	});
	expect(
		(
			await db`select status,snapshot_id from platform.workspace_snapshot_upload_reservations where id=${lease.id}`
		)[0],
	).toMatchObject({ status: "completed", snapshot_id: saved.snapshotId });
});
it.each(["digest", "version", "missing-record"] as const)(
	"does not fence a pending committed tuple whose %s cannot be reconciled",
	async (failure) => {
		const lease = await declared();
		await store.attachUploadObject(lease.who, lease.id, lease.ref, "data-v1");
		const saved = await store.create(
			snapshot(lease.who, lease.ref, "data-v1"),
			lease.who,
			lease.key,
			requestDigest,
			lease.id,
		);
		await db`update platform.workspace_snapshot_upload_objects set state='pending' where object_ref=${lease.ref}`;
		await db`update platform.workspace_snapshot_upload_reservations set status='reserved',snapshot_id=null where id=${lease.id}`;
		if (failure === "digest")
			await db`update platform.idempotency_records set request_digest=${"c".repeat(64)} where result->>'snapshotId'=${saved.snapshotId}`;
		if (failure === "version")
			await db`update platform.workspace_snapshot_upload_objects set object_version='different-version' where object_ref=${lease.ref}`;
		if (failure === "missing-record")
			await db`update platform.idempotency_records set result=${db.json({ snapshotId: randomUUID() })} where result->>'snapshotId'=${saved.snapshotId}`;
		await expire(lease);
		const f = versions(lease.ref);
		expect(await collect(f.storage)).toMatchObject({
			failed: 1,
			released: 0,
			reconciled: 0,
		});
		const deleteObjectVersion = vi.fn(async () => {});
		expect(
			await store.collectExpiredUploadReservations({
				now: new Date(),
				deleter: { deleteObjectVersion },
			}),
		).toMatchObject({ reconciled: 0, released: 0 });
		expect(deleteObjectVersion).not.toHaveBeenCalled();
		expect(f.storage.fenceUpload).not.toHaveBeenCalled();
		expect(f.storage.remove).not.toHaveBeenCalled();
		expect(await intent(lease)).toMatchObject({ state: "pending" });
		expect(await reservation(lease)).toMatchObject({
			object_ref: lease.ref,
			released_at: null,
		});
		expect((await store.get(lease.who, saved.snapshotId))?.status).toBe(
			"ready",
		);
	},
);
