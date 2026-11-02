import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
	WorkspaceSnapshotPrincipalV1,
	WorkspaceSnapshotRecordV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
		await db`insert into platform.agent_owners (agent_id,owner_id,created_at) values (${agent},${who.id},now())`;
		await db`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,created_at,runtime_revision) values (${agent},1,'synthetic',now(),1)`;
		await expect(
			bindingStore.bind({
				ownerType: other.kind,
				ownerId: other.id,
				snapshotId: value.snapshotId,
				agentId: agent,
				configurationRevision: 1,
				name: "repo",
			}),
		).rejects.toMatchObject({ code: "forbidden" });
		await expect(
			bindingStore.bind({
				ownerType: who.kind,
				ownerId: who.id,
				snapshotId: value.snapshotId,
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
