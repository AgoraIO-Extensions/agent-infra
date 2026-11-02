import { createHash, randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { WorkspaceSnapshotMetadataV1Schema } from "@agent-infra/contracts/pilot";
import { FakeObjectStorageV1 } from "@agent-infra/object-storage";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import { registerWorkspaceSnapshotRoutesV1 } from "./http/workspace-snapshot-routes.js";

let database: PostgresTestDatabase;
let db: ReturnType<typeof postgres>;
let assembly: PlatformApiAssembly;
const storage = new FakeObjectStorageV1();
const app = new Hono();
function bundle(text: string) {
	function header(name: string, size: number, type: string) {
		const bytes = Buffer.alloc(512);
		bytes.write(name);
		bytes.write(size.toString(8).padStart(11, "0"), 124);
		bytes[156] = type.charCodeAt(0);
		bytes.write("ustar\0", 257);
		bytes.write("00", 263);
		bytes.fill(32, 148, 156);
		const checksum = bytes.reduce((sum, n) => sum + n, 0);
		bytes.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
		return bytes;
	}
	const bytes = Buffer.from(text);
	return gzipSync(
		Buffer.concat([
			header("root/", 0, "5"),
			header("root/file.txt", bytes.length, "0"),
			bytes,
			Buffer.alloc((512 - (bytes.length % 512)) % 512),
			Buffer.alloc(1024),
		]),
	);
}
const bytes = bundle("synthetic-repository-v1");
const sha = (value: Uint8Array) =>
	createHash("sha256").update(value).digest("hex");
async function token(
	kind: "user" | "application",
	id: string,
	scopes = ["agent:create", "agent:read", "agent:manage"],
) {
	const material = `papi_${randomBytes(32).toString("base64url")}`;
	if (kind === "application")
		await db`insert into platform.platform_applications (id,name,responsible_user_id,status,authorization_revision) values (${id},'Test application','unrelated','active','v1')`;
	await db`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values (${randomUUID()},${kind},${id},${sha(Buffer.from(material))},${db.json(scopes)})`;
	return material;
}
function upload(
	material: string,
	key: string,
	content = bytes,
	declared = sha(content),
) {
	return app.request("/api/v2/workspace-snapshots", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${material}`,
			"Idempotency-Key": key,
			"Content-Type": "application/x-tar+gzip",
			"X-Content-SHA256": declared,
		},
		body: new Uint8Array(content),
	});
}
beforeAll(async () => {
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
	} else
		database = await startPostgresTestDatabase("workspace-upload-api-3871");
	await migratePlatformDatabase(database);
	db = postgres(database.databaseUrl, { max: 4 });
	const unused = async () => {
		throw new Error("Unrelated adapter unexpectedly called");
	};
	assembly = assemblePlatformApi({
		databaseUrl: database.databaseUrl,
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 2,
			waitingTimeoutMs: 60_000,
		},
		identity: {
			resolve: async () => null,
			hydrateUsers: async () => [],
			resolveUser: async (userId) => ({
				schemaVersion: 1,
				userId,
				accountStatus: "active",
				organizationIds: [],
				authorizationRevision: "v1",
			}),
		},
		admissions: {
			authorizationAdmission: { authorize: unused },
			imageAdmission: { admitImage: unused },
			modelAdmission: { admitModels: unused },
			secretAdmission: { admitSecrets: unused },
			channelAdmission: { admitChannels: unused },
		},
		allocateApplicationIds: unused,
		prepareApplicationSecrets: unused,
		prepareConfigurationSecrets: unused,
		presentAgent: unused,
		workspaceSnapshotDeployment: { storage },
	});
	if (!assembly.dependencies.workspaceSnapshots)
		throw new Error("Snapshot assembly missing");
	registerWorkspaceSnapshotRoutesV1(
		app,
		assembly.dependencies.workspaceSnapshots,
	);
}, 120000);
afterAll(async () => {
	await assembly?.close();
	await db?.end();
	await database?.stop();
});

describe("snapshot HTTP -> disk spool -> archive -> object bytes -> PostgreSQL", () => {
	it("publishes and replays user/application uploads without cross-kind or raw-content exposure", async () => {
		const id = randomUUID();
		const user = await token("user", id);
		const application = await token("application", id);
		const first = await upload(user, "one");
		expect(first.status).toBe(201);
		expect(first.headers.get("Cache-Control")).toContain("no-store");
		const value = WorkspaceSnapshotMetadataV1Schema.parse(await first.json());
		expect(value.digest).toBe(`sha256:${sha(bytes)}`);
		expect(JSON.stringify(value)).not.toContain("synthetic-repository-v1");
		expect(JSON.stringify(value)).not.toContain("objectRef");
		const replay = await upload(user, "one");
		expect(replay.status).toBe(200);
		expect(
			WorkspaceSnapshotMetadataV1Schema.parse(await replay.json()).snapshotId,
		).toBe(value.snapshotId);
		const other = await upload(application, "one");
		expect(other.status).toBe(201);
		expect(
			WorkspaceSnapshotMetadataV1Schema.parse(await other.json()).snapshotId,
		).not.toBe(value.snapshotId);
		const denied = await app.request(
			`/api/v2/workspace-snapshots/${value.snapshotId}`,
			{ headers: { Authorization: `Bearer ${application}` } },
		);
		expect(denied.status).toBe(404);
		const readOnly = await token("user", id, ["agent:read"]);
		const list = await app.request("/api/v2/workspace-snapshots", {
			headers: { Authorization: `Bearer ${readOnly}` },
		});
		expect(list.status).toBe(200);
		expect(await list.json()).toHaveLength(1);
		expect((await upload(readOnly, "cannot-write")).status).toBe(404);
	});
	it("rejects changed replay bytes and conflicting content before metadata publication", async () => {
		const user = await token("user", randomUUID());
		expect((await upload(user, "same")).status).toBe(201);
		expect(
			(await upload(user, "same", bundle("changed"), sha(bytes))).status,
		).toBe(422);
		expect((await upload(user, "same", bundle("changed"))).status).toBe(409);
		const list = await app.request("/api/v2/workspace-snapshots", {
			headers: { Authorization: `Bearer ${user}` },
		});
		expect(await list.json()).toHaveLength(1);
	});
	it("deletes the exact object before releasing stored quota and retains deletion audit", async () => {
		const id = randomUUID();
		const user = await token("user", id);
		const published = await upload(user, "remove");
		expect(published.status).toBe(201);
		const value = WorkspaceSnapshotMetadataV1Schema.parse(
			await published.json(),
		);
		const [stored] =
			await db`select object_ref,object_version,size_bytes from platform.workspace_snapshots where id=${value.snapshotId}`;
		if (!stored) throw new Error("Missing stored object reference");
		expect(
			await storage.inspect(stored.object_ref, stored.object_version),
		).not.toBeNull();
		const deleted = await app.request(
			`/api/v2/workspace-snapshots/${value.snapshotId}`,
			{
				method: "DELETE",
				headers: {
					Authorization: `Bearer ${user}`,
					"Idempotency-Key": "delete-one",
				},
			},
		);
		expect(deleted.status).toBe(200);
		expect(
			WorkspaceSnapshotMetadataV1Schema.parse(await deleted.json()).status,
		).toBe("deleted");
		expect(
			await storage.inspect(stored.object_ref, stored.object_version),
		).toBeNull();
		const audits =
			await db`select action,details from platform.audit_events where target_id=${value.snapshotId}`;
		expect(audits.map((v) => v.action)).toContain("workspace.snapshot.deleted");
		expect(JSON.stringify(audits)).not.toContain("synthetic-repository-v1");
	});
});
