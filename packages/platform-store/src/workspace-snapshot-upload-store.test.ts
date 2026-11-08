import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
	WorkspaceSnapshotPrincipalV1,
	WorkspaceSnapshotRecordV1,
} from "@agent-infra/platform-core";
import { workspaceSnapshotLimitsV1 } from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { PostgresWorkspaceSnapshotBindingStoreV1 } from "./workspace-snapshot-bindings.js";
import { PostgresWorkspaceSnapshotUploadStoreV1 } from "./workspace-snapshot-upload-store.js";

let database: PostgresTestDatabase;
let db: ReturnType<typeof postgres>;
let store: PostgresWorkspaceSnapshotUploadStoreV1;
let bindingStore: PostgresWorkspaceSnapshotBindingStoreV1;
beforeAll(async () => {
	// An explicitly owned local PG is useful on hosts without a Docker daemon; never use a shared DB.
	const url = process.env.WORKSPACE_SNAPSHOT_TEST_DATABASE_URL;
	if (url) {
		const parsed = new URL(url);
		if (
			parsed.hostname !== "127.0.0.1" ||
			!/^\/snapshot_test_[a-z0-9_]+$/.test(parsed.pathname)
		)
			throw new Error("Expected isolated snapshot test database");
		database = {
			databaseUrl: url,
			containerName: "local-snapshot-test",
			stop: async () => {},
		};
	} else database = await startPostgresTestDatabase("workspace-snapshot-3871");
	await migratePlatformDatabase(database);
	db = postgres(database.databaseUrl, { max: 8 });
	store = new PostgresWorkspaceSnapshotUploadStoreV1(database.databaseUrl);
	bindingStore = new PostgresWorkspaceSnapshotBindingStoreV1(
		database.databaseUrl,
	);
}, 120_000);
afterAll(async () => {
	await store?.close();
	await bindingStore?.close();
	await db?.end();
	await database?.stop();
});
const owner = (
	kind: "user" | "application" = "user",
	id: string = randomUUID(),
): WorkspaceSnapshotPrincipalV1 => ({
	kind,
	id,
	scopes: ["agent:create", "agent:read", "agent:manage"],
});
function input(
	who: WorkspaceSnapshotPrincipalV1,
	sizeBytes = 16,
): WorkspaceSnapshotRecordV1 {
	return {
		snapshotId: randomUUID(),
		ownerType: who.kind,
		ownerId: who.id,
		digest: `sha256:${"a".repeat(64)}`,
		sizeBytes,
		unpackedSizeBytes: sizeBytes,
		fileCount: 1,
		mediaType: "application/x-tar+gzip",
		source: { kind: "direct-upload" },
		objectRef: randomUUID(),
		objectVersion: randomUUID(),
		status: "ready",
		createdAt: new Date().toISOString(),
		bindings: [],
	};
}
const requestDigest = "b".repeat(64);
async function credential(
	who: WorkspaceSnapshotPrincipalV1,
	scopes = [...who.scopes],
) {
	const material = `papi_${randomBytes(32).toString("base64url")}`;
	const id = randomUUID();
	if (who.kind === "application")
		await db`insert into platform.platform_applications (id,name,responsible_user_id,status,authorization_revision) values (${who.id},'Synthetic app','unrelated-person','active','revision-1') on conflict do nothing`;
	await db`insert into platform.platform_api_credentials (id,principal_type,principal_id,credential_hash,scopes) values (${id},${who.kind},${who.id},${createHash("sha256").update(material).digest("hex")},${db.json(scopes)})`;
	return { material, id };
}
const directory = {
	resolveUser: async (id: string) => ({
		schemaVersion: 1,
		userId: id,
		accountStatus: "active",
		organizationIds: [],
		authorizationRevision: "current-1",
	}),
};

describe("workspace snapshot publication on PostgreSQL", () => {
	it("reserves owner quota before object publication and converges idempotency", async () => {
		const who = owner();
		const digest = "b".repeat(64);
		const expiresAt = new Date(Date.now() + 60_000).toISOString();
		const reservations = await Promise.all(
			Array.from({ length: 5 }, (_, index) =>
				store.reserveUpload(
					who,
					`reservation-${index}`,
					digest,
					workspaceSnapshotLimitsV1.maxArchiveBytes,
					expiresAt,
				),
			),
		);
		expect(reservations.every((value) => value.state === "reserved")).toBe(
			true,
		);
		await expect(
			store.reserveUpload(
				who,
				"reservation-over-limit",
				digest,
				workspaceSnapshotLimitsV1.maxArchiveBytes,
				expiresAt,
			),
		).rejects.toMatchObject({ code: "quota_exceeded" });
		const first = reservations[0];
		if (first?.state !== "reserved") throw new Error("reservation missing");
		await expect(
			store.reserveUpload(who, "reservation-0", digest, 1, expiresAt),
		).resolves.toEqual({ state: "in_progress" });
		await expect(
			store.reserveUpload(who, "reservation-0", "c".repeat(64), 1, expiresAt),
		).resolves.toEqual({ state: "conflict" });
		await store.releaseUploadReservation(who, first.reservationId);
		await expect(
			store.reserveUpload(
				who,
				"reservation-over-limit",
				digest,
				workspaceSnapshotLimitsV1.maxArchiveBytes,
				expiresAt,
			),
		).resolves.toMatchObject({ state: "reserved" });
	});
	it("reclaims an expired reservation before accepting the next upload", async () => {
		const who = owner();
		const digest = "d".repeat(64);
		const expired = await store.reserveUpload(
			who,
			"expired-reservation",
			digest,
			workspaceSnapshotLimitsV1.maxArchiveBytes,
			new Date(Date.now() + 60_000).toISOString(),
		);
		expect(expired.state).toBe("reserved");
		if (expired.state !== "reserved") throw new Error("reservation missing");
		await db`update platform.workspace_snapshot_upload_reservations set expires_at=now()-interval '1 second' where id=${expired.reservationId}`;
		const next = await store.reserveUpload(
			who,
			"next-reservation",
			digest,
			workspaceSnapshotLimitsV1.maxArchiveBytes,
			new Date(Date.now() + 60_000).toISOString(),
		);
		expect(next.state).toBe("reserved");
		const rows =
			await db`select status from platform.workspace_snapshot_upload_reservations where owner_id=${who.id} and idempotency_key='expired-reservation'`;
		expect(rows).toEqual([{ status: "expired" }]);
	});
	it("replays a completed legacy idempotency record before reserving new quota", async () => {
		const who = owner();
		const digest = "e".repeat(64);
		await store.create(
			input(who, workspaceSnapshotLimitsV1.maxArchiveBytes),
			who,
			"legacy-replay",
			digest,
		);
		for (let index = 0; index < 4; index++)
			await store.create(
				input(who, workspaceSnapshotLimitsV1.maxArchiveBytes),
				who,
				`full-quota-${index}`,
				digest,
			);
		expect(
			await store.reserveUpload(
				who,
				"legacy-replay",
				digest,
				workspaceSnapshotLimitsV1.maxArchiveBytes,
				new Date(Date.now() + 60_000).toISOString(),
			),
		).toEqual({ state: "completed" });
		await expect(
			store.reserveUpload(
				who,
				"legacy-replay",
				"f".repeat(64),
				workspaceSnapshotLimitsV1.maxArchiveBytes,
				new Date(Date.now() + 60_000).toISOString(),
			),
		).resolves.toEqual({ state: "conflict" });
	});
	it("fences late release and attachment after an expired lease is renewed", async () => {
		const who = owner();
		const digest = "f".repeat(64);
		const reserve = () =>
			store.reserveUpload(
				who,
				"fenced-renewal",
				digest,
				workspaceSnapshotLimitsV1.maxArchiveBytes,
				new Date(Date.now() + 60_000).toISOString(),
			);
		const first = await reserve();
		if (first.state !== "reserved") throw new Error("reservation missing");
		await db`update platform.workspace_snapshot_upload_reservations set expires_at=now()-interval '1 second' where id=${first.reservationId}`;
		const second = await reserve();
		if (second.state !== "reserved") throw new Error("renewal missing");
		expect(second.reservationId).not.toBe(first.reservationId);
		await store.releaseUploadReservation(who, first.reservationId);
		await expect(
			store.attachUploadObject(
				who,
				first.reservationId,
				randomUUID(),
				randomUUID(),
			),
		).rejects.toMatchObject({ code: "unavailable" });
		await expect(reserve()).resolves.toEqual({ state: "in_progress" });
		await expect(
			store.create(
				input(who),
				who,
				"fenced-renewal",
				digest,
				first.reservationId,
			),
		).rejects.toMatchObject({ code: "conflict" });
		const rows =
			await db`select id,status from platform.workspace_snapshot_upload_reservations where owner_id=${who.id}`;
		expect(rows).toEqual([{ id: second.reservationId, status: "reserved" }]);
	});
	it("legacy publication cannot consume quota already reserved by another upload", async () => {
		const who = owner();
		for (let index = 0; index < 4; index++)
			await store.create(
				input(who, workspaceSnapshotLimitsV1.maxArchiveBytes),
				who,
				`quota-seed-${index}`,
				requestDigest,
			);
		const reservation = await store.reserveUpload(
			who,
			"reserved-upload",
			requestDigest,
			workspaceSnapshotLimitsV1.maxArchiveBytes,
			new Date(Date.now() + 60_000).toISOString(),
		);
		if (reservation.state !== "reserved")
			throw new Error("reservation missing");
		await expect(
			store.create(
				input(who, workspaceSnapshotLimitsV1.maxArchiveBytes),
				who,
				"legacy-overcommit",
				requestDigest,
			),
		).rejects.toMatchObject({ code: "quota_exceeded" });
		const record = input(who, workspaceSnapshotLimitsV1.maxArchiveBytes);
		await store.attachUploadObject(
			who,
			reservation.reservationId,
			record.objectRef,
			record.objectVersion,
		);
		await expect(
			store.create(
				record,
				who,
				"reserved-upload",
				requestDigest,
				reservation.reservationId,
			),
		).resolves.toMatchObject({ snapshotId: record.snapshotId });
	});
	it("retains expired object quota until exact-version cleanup succeeds", async () => {
		const who = owner();
		for (let index = 0; index < 4; index++)
			await store.create(
				input(who, workspaceSnapshotLimitsV1.maxArchiveBytes),
				who,
				`orphan-seed-${index}`,
				requestDigest,
			);
		const reservation = await store.reserveUpload(
			who,
			"expired-object",
			requestDigest,
			workspaceSnapshotLimitsV1.maxArchiveBytes,
			new Date(Date.now() + 60_000).toISOString(),
		);
		if (reservation.state !== "reserved")
			throw new Error("reservation missing");
		const object = input(who);
		await store.attachUploadObject(
			who,
			reservation.reservationId,
			object.objectRef,
			object.objectVersion,
		);
		await db`update platform.workspace_snapshot_upload_reservations set expires_at=now()-interval '1 second' where id=${reservation.reservationId}`;
		const nextUpload = () =>
			store.reserveUpload(
				who,
				"after-expired-object",
				requestDigest,
				workspaceSnapshotLimitsV1.maxArchiveBytes,
				new Date(Date.now() + 60_000).toISOString(),
			);
		await expect(nextUpload()).rejects.toMatchObject({
			code: "quota_exceeded",
		});
		const deleteObjectVersion = vi
			.fn()
			.mockRejectedValueOnce(new Error("private-storage-detail"));
		const failed = await store.collectExpiredUploadReservations({
			now: new Date(),
			deleter: { deleteObjectVersion },
		});
		expect(failed.failed).toBeGreaterThanOrEqual(1);
		await expect(nextUpload()).rejects.toMatchObject({
			code: "quota_exceeded",
		});
		deleteObjectVersion.mockResolvedValue(undefined);
		const recovered = await store.collectExpiredUploadReservations({
			now: new Date(),
			deleter: { deleteObjectVersion },
		});
		expect(recovered.released).toBeGreaterThanOrEqual(1);
		expect(deleteObjectVersion).toHaveBeenCalledWith({
			objectRef: object.objectRef,
			objectVersion: object.objectVersion,
		});
		await expect(nextUpload()).resolves.toMatchObject({ state: "reserved" });
		const rows =
			await db`select status,object_ref,object_version from platform.workspace_snapshot_upload_reservations where id=${reservation.reservationId}`;
		expect(rows).toEqual([
			{ status: "expired", object_ref: null, object_version: null },
		]);
	});
	it("recovery preserves a published version and reconciles its durable receipt", async () => {
		const who = owner();
		const reservation = await store.reserveUpload(
			who,
			"published-reservation",
			requestDigest,
			workspaceSnapshotLimitsV1.maxArchiveBytes,
			new Date(Date.now() + 60_000).toISOString(),
		);
		if (reservation.state !== "reserved")
			throw new Error("reservation missing");
		const object = input(who);
		await store.attachUploadObject(
			who,
			reservation.reservationId,
			object.objectRef,
			object.objectVersion,
		);
		await store.create(object, who, "published-reservation", requestDigest);
		await db`update platform.workspace_snapshot_upload_reservations set expires_at=now()-interval '1 second' where id=${reservation.reservationId}`;
		const deleteObjectVersion = vi.fn(async () => {});
		const result = await store.collectExpiredUploadReservations({
			now: new Date(),
			deleter: { deleteObjectVersion },
		});
		expect(result.reconciled).toBeGreaterThanOrEqual(1);
		expect(deleteObjectVersion).not.toHaveBeenCalledWith({
			objectRef: object.objectRef,
			objectVersion: object.objectVersion,
		});
		const rows =
			await db`select status,snapshot_id from platform.workspace_snapshot_upload_reservations where id=${reservation.reservationId}`;
		expect(rows).toEqual([
			{ status: "completed", snapshot_id: object.snapshotId },
		]);
	});
	it("permits cleanup with the held lease after revocation without permitting publication", async () => {
		const who = owner();
		const token = await credential(who);
		const bound = store.forCredential(token.material, directory);
		const reservation = await bound.store.reserveUpload(
			who,
			"revoked-reservation",
			requestDigest,
			workspaceSnapshotLimitsV1.maxArchiveBytes,
			new Date(Date.now() + 60_000).toISOString(),
		);
		if (reservation.state !== "reserved")
			throw new Error("reservation missing");
		const object = input(who);
		await bound.store.attachUploadObject(
			who,
			reservation.reservationId,
			object.objectRef,
			object.objectVersion,
		);
		await db`update platform.platform_api_credentials set revoked_at=now() where id=${token.id}`;
		await expect(
			bound.store.create(
				object,
				who,
				"revoked-reservation",
				requestDigest,
				reservation.reservationId,
			),
		).rejects.toMatchObject({ code: "authentication_required" });
		await store.releaseUploadReservation(owner(), reservation.reservationId);
		const [beforeCleanup] =
			await db`select status from platform.workspace_snapshot_upload_reservations where id=${reservation.reservationId}`;
		expect(beforeCleanup?.status).toBe("reserved");
		await bound.store.releaseUploadReservation(who, reservation.reservationId);
		const [afterCleanup] =
			await db`select status,object_ref,object_version from platform.workspace_snapshot_upload_reservations where id=${reservation.reservationId}`;
		expect(afterCleanup).toEqual({
			status: "released",
			object_ref: null,
			object_version: null,
		});
		expect(await store.findIdempotency(who, "revoked-reservation")).toBeNull();
	});

	it("separates a user and application with the same ID and idempotency key", async () => {
		const person = owner();
		const application = owner("application", person.id);
		const a = await store.create(
			input(person),
			person,
			"same-key",
			requestDigest,
		);
		expect(await store.findIdempotency(application, "same-key")).toBeNull();
		const b = await store.create(
			input(application),
			application,
			"same-key",
			requestDigest,
		);
		expect(a.snapshotId).not.toBe(b.snapshotId);
		expect(
			(await store.findIdempotency(application, "same-key"))?.record.ownerType,
		).toBe("application");
		expect(await store.get(application, a.snapshotId)).toBeNull();
		expect(await store.list(application)).toHaveLength(1);
	});
	it("concurrent retries publish one immutable record and preserve conflicting requests", async () => {
		const who = owner();
		const result = await Promise.all(
			Array.from({ length: 6 }, () =>
				store.create(input(who), who, "concurrent", requestDigest),
			),
		);
		expect(new Set(result.map((v) => v.snapshotId)).size).toBe(1);
		expect(await store.list(who)).toHaveLength(1);
		await expect(
			store.create(input(who), who, "concurrent", "c".repeat(64)),
		).rejects.toMatchObject({ code: "conflict" });
		const canonical = result[0];
		if (!canonical) throw new Error("Expected canonical record");
		const audit =
			await db`select * from platform.audit_events where target_id=${canonical.snapshotId} and action='workspace.snapshot.uploaded'`;
		expect(audit).toHaveLength(1);
		expect(JSON.stringify(audit)).not.toContain("objectVersion");
	});
	it("serializes owner quota across concurrent different uploads", async () => {
		const who = owner();
		const twoGiB = 2 * 1024 ** 3;
		for (let i = 0; i < 4; i++)
			await store.create(input(who, twoGiB), who, `seed-${i}`, requestDigest);
		const result = await Promise.allSettled([
			store.create(input(who, twoGiB), who, "race-1", requestDigest),
			store.create(input(who, twoGiB), who, "race-2", requestDigest),
		]);
		expect(result.filter((v) => v.status === "fulfilled")).toHaveLength(1);
		expect(result.find((v) => v.status === "rejected")).toMatchObject({
			reason: { code: "quota_exceeded" },
		});
		expect((await store.read(who)).ownerStoredBytes).toBe(10 * 1024 ** 3);
	});
	it("rolls back metadata and replay receipt when mandatory audit fails", async () => {
		const who = owner();
		const value = input(who);
		await db.unsafe(
			"create function platform.reject_snapshot_audit() returns trigger language plpgsql as $$ begin if NEW.action = 'workspace.snapshot.uploaded' then raise exception 'synthetic audit failure'; end if; return NEW; end $$",
		);
		await db.unsafe(
			"create trigger reject_snapshot_audit before insert on platform.audit_events for each row execute function platform.reject_snapshot_audit()",
		);
		try {
			await expect(
				store.create(value, who, "audit-failed", requestDigest),
			).rejects.toMatchObject({ code: "unavailable" });
		} finally {
			await db.unsafe(
				"drop trigger reject_snapshot_audit on platform.audit_events",
			);
			await db.unsafe("drop function platform.reject_snapshot_audit()");
		}
		expect(await store.get(who, value.snapshotId)).toBeNull();
		expect(await store.findIdempotency(who, "audit-failed")).toBeNull();
		expect((await store.read(who)).ownerStoredBytes).toBe(0);
	});
	it("checks owner before references and retains bytes until physical deletion", async () => {
		const who = owner();
		const other = owner();
		const value = await store.create(input(who), who, "bound", requestDigest);
		const agent = randomUUID();
		await db`insert into platform.agents (id) values (${agent})`;
		await db`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,created_at,runtime_revision) values (${agent},1,'synthetic',now(),1)`;
		await db`insert into platform.workspace_snapshot_bindings (snapshot_id,agent_id,configuration_revision,name,digest,size_bytes) values (${value.snapshotId},${agent},1,'repo',${value.digest},${value.sizeBytes})`;
		await expect(store.remove(other, value.snapshotId)).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(store.remove(other, "unknown")).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(store.remove(who, value.snapshotId)).rejects.toMatchObject({
			code: "bound",
		});
		expect((await store.get(who, value.snapshotId))?.bindings).toHaveLength(1);
		const unbound = await store.create(
			input(who),
			who,
			"unbound",
			requestDigest,
		);
		expect((await store.remove(who, unbound.snapshotId)).status).toBe(
			"deleting",
		);
		expect((await store.remove(who, unbound.snapshotId)).status).toBe(
			"deleting",
		);
		expect((await store.read(who)).ownerStoredBytes).toBe(32);
	});
	it("rejects binding a snapshot to an agent owned by another subject", async () => {
		const who = owner();
		const other = owner();
		const value = await store.create(
			input(who),
			who,
			"binding-owner",
			requestDigest,
		);
		const agent = randomUUID();
		await db`insert into platform.agents (id) values (${agent})`;
		await db`insert into platform.agent_owners (agent_id,owner_id,created_at) values (${agent},${other.id},now())`;
		await db`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,created_at,runtime_revision) values (${agent},1,'synthetic',now(),1)`;
		await expect(
			bindingStore.bind({
				ownerType: who.kind,
				ownerId: who.id,
				snapshotId: value.snapshotId,
				agentId: agent,
				configurationRevision: 1,
				name: "repo",
			}),
		).rejects.toMatchObject({ code: "forbidden" });
		const otherValue = await store.create(
			input(other),
			other,
			"binding-owner-other",
			requestDigest,
		);
		await expect(
			bindingStore.bind({
				ownerType: other.kind,
				ownerId: other.id,
				snapshotId: otherValue.snapshotId,
				agentId: agent,
				configurationRevision: 1,
				name: "repo",
			}),
		).resolves.toMatchObject({ agentId: agent, name: "repo" });
	});
	it("authenticates user/application scopes and rejects revoked or misattributed writes in the commit transaction", async () => {
		const person = owner();
		const app = owner("application", person.id);
		for (const who of [person, app]) {
			const token = await credential(who);
			const bound = store.forCredential(token.material, directory);
			expect(await bound.credentials.resolve(token.material)).toMatchObject({
				kind: who.kind,
				id: who.id,
			});
			const value = await bound.store.create(
				input(who),
				who,
				"publish",
				requestDigest,
			);
			expect(value.ownerType).toBe(who.kind);
			const other = owner();
			await expect(
				bound.store.create(input(other), other, "wrong-owner", requestDigest),
			).rejects.toMatchObject({ code: "not_found" });
			await db`update platform.platform_api_credentials set revoked_at=now() where id=${token.id}`;
			await expect(
				bound.store.create(input(who), who, "after-revoke", requestDigest),
			).rejects.toMatchObject({ code: "authentication_required" });
		}
		const readOnly = await credential(person, ["agent:read"]);
		const bound = store.forCredential(readOnly.material, directory);
		expect(
			(await bound.credentials.resolve(readOnly.material, "agent:read")).id,
		).toBe(person.id);
		expect(await bound.store.list(person)).toHaveLength(1);
		await expect(
			bound.store.create(input(person), person, "not-allowed", requestDigest),
		).rejects.toMatchObject({ code: "forbidden" });
	});
	it("revalidates current subject after audit and rolls back a revoked identity", async () => {
		const who = owner();
		const token = await credential(who);
		let calls = 0;
		const current = {
			resolveUser: async (id: string) => ({
				...(await directory.resolveUser(id)),
				authorizationRevision: ++calls === 1 ? "first" : "changed",
			}),
		};
		const bound = store.forCredential(token.material, current);
		await expect(
			bound.store.create(input(who), who, "identity-race", requestDigest),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(await store.findIdempotency(who, "identity-race")).toBeNull();
		expect(await store.list(who)).toHaveLength(0);
	});
});
