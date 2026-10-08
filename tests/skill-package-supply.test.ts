import { execFile as callback } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { startMinioFileFixtureV1 } from "../packages/object-storage/src/minio.test-support.ts";
import {
	packSkillProjectSnapshotV1,
	prepareSkillPackageV1,
} from "../packages/object-storage/src/skill-package-admission.ts";
import { createClamAvSkillPackageScannerV1 } from "../packages/object-storage/src/skill-package-clamav.ts";
import {
	SkillPackageSupplierV1,
	type SkillPackageSupplyInputV1,
} from "../packages/object-storage/src/skill-package-supplier.ts";
import type { ObjectStorageDataV1 } from "../packages/object-storage/src/types.ts";
import { migratePlatformDatabase } from "../packages/platform-store/src/migrate.ts";
import { startPostgresTestDatabase } from "../packages/platform-store/src/postgres-test.ts";
import { PostgresSkillHubLifecycleV1 } from "../packages/platform-store/src/skill-hub.ts";

const requireStore = createRequire(
	new URL("../packages/platform-store/package.json", import.meta.url),
);
const postgres = requireStore(
	"postgres",
) as typeof import("../packages/platform-store/node_modules/postgres").default;
const requireStorage = createRequire(
	new URL("../packages/object-storage/package.json", import.meta.url),
);
const { DeleteObjectCommand, PutObjectCommand } = requireStorage(
	"@aws-sdk/client-s3",
) as typeof import("../packages/object-storage/node_modules/@aws-sdk/client-s3");
const execFile = promisify(callback);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });
const sha = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();
const archive = packSkillProjectSnapshotV1([
	{ path: "SKILL.md", bytes: encoder.encode("# summary\n") },
	{ path: "references/info.txt", bytes: encoder.encode("resource") },
]);
const request = (userId = "owner-a") => ({
	userId,
	requestId: "supply-request",
	traceId: "supply-trace",
});
const identity = (userId: string) => ({
	actor: {
		schemaVersion: 1,
		userId,
		accountStatus: "active",
		organizationIds: ["org"],
		isAdministrator: false,
	},
	authorizationRevision: "auth-1",
});
let database: Awaited<ReturnType<typeof startPostgresTestDatabase>>;
let fixture: Awaited<ReturnType<typeof startMinioFileFixtureV1>>;
let sql: ReturnType<typeof postgres>;
let staging: string;
let scannerContainer: string | undefined;
let scanner: ReturnType<typeof createClamAvSkillPackageScannerV1>;
const stores: PostgresSkillHubLifecycleV1[] = [];
let identities: Map<string, ReturnType<typeof identity>>;
let revokedKey: boolean;
let policyRevision: string;
let sourceApproved: boolean;
let scanCount: number;
const keys = generateKeyPairSync("ed25519");
function input(
	overrides: Partial<SkillPackageSupplyInputV1> = {},
): SkillPackageSupplyInputV1 {
	return {
		name: "summary",
		skillId: "skill-a",
		skillVersionId: "version-a",
		visibility: "PRIVATE",
		provider: "my_library",
		version: "1.0.0",
		sourceVersion: "snapshot-1",
		sourceDigest: sha(archive),
		approvalRef: null,
		trustRevision: "trust-1",
		policyRevision: "policy-1",
		archiveBytes: archive,
		...overrides,
	};
}
function supplier(
	storage: ObjectStorageDataV1 = fixture.storage,
	afterScan?: () => Promise<void>,
	scannerOverride = scanner,
) {
	const lifecycle = new PostgresSkillHubLifecycleV1({
		databaseUrl: database.databaseUrl,
		resolveIdentity: async (userId) => identities.get(userId) ?? null,
	});
	stores.push(lifecycle);
	const value = new SkillPackageSupplierV1({
		storage,
		lifecycle,
		resolveAdmissionPolicy: async () => {
			if (revokedKey) throw new Error("private key revoked diagnostic");
			const actual = await scannerOverride.describe();
			return {
				...actual,
				policyRevision,
				signer: { ...keys, keyId: "key-1", trustRevision: "trust-1" },
			};
		},
		sourceVerifier: {
			verify: async (selected) => {
				if (
					!sourceApproved ||
					!identities.has(selected.ownerId) ||
					(selected.provider === "my_library" &&
						selected.sourceDigest !== selected.archiveDigest)
				)
					throw new Error("private provider diagnostic");
				return {
					schemaVersion: 1,
					provider: selected.provider,
					publisherId: selected.ownerId,
					sourceVersion: selected.sourceVersion,
					sourceDigest: selected.sourceDigest,
					approvalRef: selected.approvalRef,
					trustRevision: selected.trustRevision,
				};
			},
		},
		scanner: {
			scan: async (selected) => {
				scanCount++;
				const receipt = await scannerOverride.scan(selected);
				await afterScan?.();
				return receipt;
			},
		},
	});
	return { value, lifecycle };
}
async function counts() {
	const [row] =
		await sql`select (select count(*)::int from platform.skill_hub_versions) as versions, (select count(*)::int from platform.outbox_items where status = 'succeeded') as completed, (select count(*)::int from platform.idempotency_records where scope_type = 'skill_package' and status = 'completed') as idempotency`;
	return row;
}
beforeAll(async () => {
	await mkdir(resolve(".scratch"), { recursive: true });
	staging = await mkdtemp(resolve(".scratch", "skill-package-1541-"));
	const directory = resolve(staging, "database");
	await mkdir(directory);
	// A real native engine with an isolated deterministic test ruleset; production signatures are a separate deployment gate.
	await writeFile(
		resolve(directory, "test.ndb"),
		`AgentInfraTestEicar:0:*:${Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE").toString("hex")}\n`,
	);
	let executable = "clamscan";
	try {
		if (process.env.CI === "true")
			throw new Error("Use pinned native container in CI");
		await execFile(executable, ["--version"]);
	} catch {
		executable = resolve(staging, "clamscan");
		scannerContainer = `agent-infra-1541-clamav-${randomUUID()}`;
		await execFile("docker", [
			"run",
			"--detach",
			"--rm",
			"--platform",
			"linux/amd64",
			"--name",
			scannerContainer,
			"--network=none",
			"--read-only",
			"--tmpfs",
			"/tmp:rw,size=64m",
			"--volume",
			`${staging}:${staging}:ro`,
			"--entrypoint",
			"sh",
			"clamav/clamav@sha256:7769870154c74ce31b0047dd8771e81f7c4269278bc005782e9e419e4922c73d",
			"-c",
			"exec sleep 3600",
		]);
		await writeFile(
			executable,
			`#!/bin/sh\nexec docker exec '${scannerContainer}' clamscan "$@"\n`,
			{ mode: 0o700 },
		);
	}
	scanner = createClamAvSkillPackageScannerV1({
		executable,
		databaseDirectory: directory,
		stagingRoot: staging,
		scannerId: "native-clamav",
		policyRevision: "policy-1",
		maximumReceiptAgeMs: 300_000,
		timeoutMs: 30_000,
	});
	await scanner.describe();
	database = await startPostgresTestDatabase("1541-publication");
	sql = postgres(database.databaseUrl, { max: 1 });
	await migratePlatformDatabase(database);
	fixture = await startMinioFileFixtureV1("skill-package");
});
beforeEach(async () => {
	await sql`truncate platform.skill_hub_skills, platform.skill_hub_versions, platform.idempotency_records, platform.audit_events, platform.outbox_items, platform.platform_user_disables, platform.persisted_events cascade`;
	identities = new Map([
		["owner-a", identity("owner-a")],
		["owner-b", identity("owner-b")],
	]);
	revokedKey = false;
	policyRevision = "policy-1";
	sourceApproved = true;
	scanCount = 0;
});
afterAll(async () => {
	for (const store of stores) await store.close();
	await sql?.end();
	await fixture?.close();
	await database?.stop();
	if (scannerContainer)
		await execFile("docker", ["rm", "--force", scannerContainer]);
	if (staging) await rm(staging, { recursive: true, force: true });
});

describe("Skill supplier with real PG, versioned S3 and native ClamAV", () => {
	it("publishes actual snapshot bytes, saves every fixed descriptor and replays without scanning after restart", async () => {
		const first = await supplier().value.admitVersion(request(), input());
		expect(first.version.state).toBe("published");
		expect(Object.keys(first.artifacts)).toHaveLength(7);
		for (const object of Object.values(first.artifacts)) {
			const body = new Uint8Array(
				await new Response(
					await fixture.storage.download({
						objectRef: object.objectRef,
						version: object.version,
						etag: object.etag,
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
					}),
				).arrayBuffer(),
			);
			expect(sha(body)).toBe(object.sha256);
			expect(body.byteLength).toBe(object.sizeBytes);
			expect(object.version).not.toBe("null");
		}
		const [operation] =
			await sql`select payload from platform.outbox_items where status = 'succeeded'`;
		expect(operation?.payload.objects).toEqual(first.artifacts);
		expect(JSON.stringify(operation)).not.toContain("# summary");
		const second = await supplier().value.admitVersion(request(), input());
		expect(second.artifacts).toEqual(first.artifacts);
		expect(second.replayed).toBe(true);
		expect(scanCount).toBe(1);
		expect(await counts()).toEqual({
			versions: 1,
			completed: 1,
			idempotency: 1,
		});
		expect(
			prepareSkillPackageV1({
				archiveBytes: archive,
				name: "summary",
				version: "1.0.0",
			}).manifest.files,
		).toHaveLength(2);
	});
	it("resumes a lost upload response using the original scan timestamp, signature and object refs", async () => {
		let lost = false;
		const storage = {
			upload: async (command: Parameters<ObjectStorageDataV1["upload"]>[0]) => {
				const result = await fixture.storage.upload(command);
				if (!lost && command.descriptor.name === "scan.json") {
					lost = true;
					throw new Error("private storage response lost");
				}
				return result;
			},
			download: fixture.storage.download,
			inspect: fixture.storage.inspect,
			scan: fixture.storage.scan,
			remove: fixture.storage.remove,
		};
		await expect(
			supplier(storage).value.admitVersion(request(), input()),
		).rejects.toThrow(/rejected/);
		expect(await counts()).toEqual({
			versions: 0,
			completed: 0,
			idempotency: 0,
		});
		const [before] = await sql`select id,payload from platform.outbox_items`;
		const result = await supplier().value.admitVersion(request(), input());
		const [after] = await sql`select id,payload from platform.outbox_items`;
		expect(after?.id).toBe(before?.id);
		expect(after?.payload.intents.scan).toEqual(before?.payload.intents.scan);
		expect(scanCount).toBe(1);
		expect(result.artifacts.scan?.sha256).toBe(
			before?.payload.intents.scan.sha256,
		);
	});
	it("rolls back metadata and success results on audit failure, then recovers the original bundle", async () => {
		await sql`create function platform.skill_supply_fail_audit() returns trigger language plpgsql as $$ begin if new.outcome = 'succeeded' then raise exception 'private audit diagnostic'; end if; return new; end $$`;
		await sql`create trigger skill_supply_fail_audit before insert on platform.audit_events for each row execute function platform.skill_supply_fail_audit()`;
		try {
			await expect(
				supplier().value.admitVersion(request(), input()),
			).rejects.toThrow(/rejected/);
			expect(await counts()).toEqual({
				versions: 0,
				completed: 0,
				idempotency: 0,
			});
		} finally {
			await sql`drop trigger skill_supply_fail_audit on platform.audit_events`;
			await sql`drop function platform.skill_supply_fail_audit()`;
		}
		const [saved] = await sql`select payload from platform.outbox_items`;
		const result = await supplier().value.admitVersion(request(), input());
		expect(result.artifacts).toEqual(saved?.payload.objects);
		expect(scanCount).toBe(1);
	});
	it("serializes competing attempts and rejects changed input without replacing original artifacts", async () => {
		const values = await Promise.allSettled([
			supplier().value.admitVersion(request(), input()),
			supplier().value.admitVersion(request(), input()),
		]);
		expect(values.filter((value) => value.status === "fulfilled")).toHaveLength(
			1,
		);
		expect(await counts()).toEqual({
			versions: 1,
			completed: 1,
			idempotency: 1,
		});
		const [before] = await sql`select payload from platform.outbox_items`;
		await expect(
			supplier().value.admitVersion(request(), input({ version: "2.0.0" })),
		).rejects.toThrow(/rejected/);
		const [after] = await sql`select payload from platform.outbox_items`;
		expect(after?.payload).toEqual(before?.payload);
	});
	it("isolates equal ZIPs across owners and logical versions", async () => {
		const first = await supplier().value.admitVersion(request(), input());
		const other = await supplier().value.admitVersion(
			request("owner-b"),
			input({ skillId: "skill-b", skillVersionId: "version-b" }),
		);
		expect(other.artifacts.zip?.sha256).toBe(first.artifacts.zip?.sha256);
		expect(other.artifacts.zip?.objectRef).not.toBe(
			first.artifacts.zip?.objectRef,
		);
		expect(other.artifacts.signature?.sha256).not.toBe(
			first.artifacts.signature?.sha256,
		);
	});
	it.each(["identity", "platform-disable", "policy", "key", "source"])(
		"rejects %s changes during real scanning",
		async (change) => {
			const value = supplier(fixture.storage, async () => {
				if (change === "identity")
					identities.set("owner-a", {
						...identity("owner-a"),
						authorizationRevision: "auth-2",
					});
				if (change === "platform-disable")
					await sql`insert into platform.platform_user_disables(user_id) values ('owner-a')`;
				if (change === "policy") policyRevision = "policy-2";
				if (change === "key") revokedKey = true;
				if (change === "source") sourceApproved = false;
			}).value;
			await expect(value.admitVersion(request(), input())).rejects.toThrow(
				/rejected/,
			);
			expect(await counts()).toEqual({
				versions: 0,
				completed: 0,
				idempotency: 0,
			});
		},
	);
	it("rejects infected real payload without registration", async () => {
		const infected = packSkillProjectSnapshotV1([
			{
				path: "SKILL.md",
				bytes: encoder.encode("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"),
			},
		]);
		await expect(
			supplier().value.admitVersion(
				request(),
				input({ archiveBytes: infected, sourceDigest: sha(infected) }),
			),
		).rejects.toThrow(/rejected/);
		expect(await counts()).toEqual({
			versions: 0,
			completed: 0,
			idempotency: 0,
		});
	});
	it("ignores a changed latest object and rejects corrupted fixed signature bytes", async () => {
		const first = await supplier().value.admitVersion(request(), input());
		const manifest = first.artifacts.manifest;
		if (!manifest) throw new Error("manifest missing");
		await fixture.client.send(
			new PutObjectCommand({
				Bucket: fixture.bucket,
				Key: `${fixture.prefix}${manifest.objectRef}`,
				Body: "changed latest manifest",
				ContentType: "text/plain",
			}),
		);
		expect(
			(await supplier().value.admitVersion(request(), input())).artifacts,
		).toEqual(first.artifacts);
		const signature = first.artifacts.signature;
		const corrupted: ObjectStorageDataV1 = {
			upload: fixture.storage.upload,
			inspect: fixture.storage.inspect,
			scan: fixture.storage.scan,
			remove: fixture.storage.remove,
			download: async (command) =>
				command.objectRef === signature?.objectRef
					? new ReadableStream({
							start(controller) {
								controller.enqueue(new Uint8Array(64));
								controller.close();
							},
						})
					: fixture.storage.download(command),
		};
		await expect(
			supplier(corrupted).value.admitVersion(request(), input()),
		).rejects.toThrow(/rejected/);
		expect(scanCount).toBe(1);
	});
	it("refuses a real unavailable scanner dependency", async () => {
		const unavailable = createClamAvSkillPackageScannerV1({
			executable: resolve(staging, "missing-scanner"),
			databaseDirectory: resolve(staging, "database"),
			stagingRoot: staging,
			scannerId: "native-clamav",
			policyRevision: "policy-1",
			maximumReceiptAgeMs: 300_000,
			timeoutMs: 30_000,
		});
		const value = supplier(fixture.storage, undefined, unavailable).value;
		await expect(value.admitVersion(request(), input())).rejects.toThrow(
			/rejected/,
		);
		expect(await counts()).toEqual({
			versions: 0,
			completed: 0,
			idempotency: 0,
		});
	});
	it("refuses missing fixed object versions even when the original bundle exists", async () => {
		const first = await supplier().value.admitVersion(request(), input());
		const object = first.artifacts.manifest;
		if (!object) throw new Error("manifest missing");
		await fixture.client.send(
			new DeleteObjectCommand({
				Bucket: fixture.bucket,
				Key: `${fixture.prefix}${object.objectRef}`,
				VersionId: object.version,
			}),
		);
		await expect(
			supplier().value.admitVersion(request(), input()),
		).rejects.toThrow(/rejected/);
		expect(scanCount).toBe(1);
	});
});
