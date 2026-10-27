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
	admissionSignatureBytesV1,
	canonicalSkillPackageScanReceiptV1,
	canonicalSkillPackageSourceProofV1,
	packSkillProjectSnapshotV1,
	prepareSkillPackageV1,
	verifyAdmissionSignatureV1,
	verifySkillPackageScanReceiptV1,
} from "../packages/object-storage/src/skill-package-admission.ts";
import { createClamAvSkillPackageScannerV1 } from "../packages/object-storage/src/skill-package-clamav.ts";
import {
	SkillPackageSupplierV1,
	type SkillPackageSupplyInputV1,
} from "../packages/object-storage/src/skill-package-supplier.ts";
import { createSkillProjectSourceVerifierV1 } from "../packages/object-storage/src/skill-project-source.ts";
import type { ObjectStorageDataV1 } from "../packages/object-storage/src/types.ts";
import { createSkillHubProjectPublicationV1 } from "../packages/platform-core/src/skill-hub-project-content.ts";
import {
	parseSkillPackagePublicationStateV1,
	skillPackagePublicationStagesV1,
} from "../packages/platform-core/src/skill-package-publication.ts";
import { skillPackageObjectRefV1 } from "../packages/platform-core/src/skill-package-ref.ts";
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
	await sql`truncate platform.skill_hub_project_contents, platform.skill_hub_skills, platform.skill_hub_versions, platform.idempotency_records, platform.audit_events, platform.outbox_items, platform.platform_user_disables, platform.persisted_events cascade`;
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
		const [failed] =
			await sql`select status from platform.outbox_items where scope_type = 'skill_package'`;
		expect(failed?.status).toBe("failed");
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

// 网页编辑项目的发布（#2906）沿同一 Supplier：真实 PG、版本化 MinIO、原生 ClamAV 与 Ed25519。
describe("web-edited Skill project publication with real PG, versioned S3 and native ClamAV", () => {
	function projectPublication(lifecycle: PostgresSkillHubLifecycleV1) {
		const projectSupplier = new SkillPackageSupplierV1({
			storage: fixture.storage,
			lifecycle,
			resolveAdmissionPolicy: async () => ({
				...(await scanner.describe()),
				policyRevision,
				signer: { ...keys, keyId: "key-1", trustRevision: "trust-1" },
			}),
			sourceVerifier: createSkillProjectSourceVerifierV1(),
			scanner: {
				scan: async (selected) => {
					scanCount++;
					return scanner.scan(selected);
				},
			},
		});
		return createSkillHubProjectPublicationV1({
			readSource: (context, projectId, check) =>
				lifecycle.readProjectPublicationSource(context, projectId, check),
			pack: packSkillProjectSnapshotV1,
			admit: ({ context, key, selection, source, archiveBytes }) =>
				projectSupplier.admitVersion(
					context,
					{
						...selection,
						...source,
						trustRevision: "trust-1",
						policyRevision,
						archiveBytes,
					},
					key,
				),
		});
	}
	async function project(
		lifecycle: PostgresSkillHubLifecycleV1,
		body: string,
		organizationId?: string,
	) {
		const { project: created } = await lifecycle.createProject(
			request(),
			`create-${randomUUID()}`,
			{
				schemaVersion: 1,
				name: `notes-${randomUUID().slice(0, 8)}`,
				...(organizationId ? { organizationId } : {}),
			},
		);
		await lifecycle.saveProjectContent(request(), created.projectId, "save-1", {
			schemaVersion: 1,
			baseRevision: 0,
			files: [
				{ path: "SKILL.md", encoding: "utf8", content: body },
				{ path: "scripts/run.sh", encoding: "utf8", content: "echo run\n" },
				{ path: "references/info.txt", encoding: "utf8", content: "resource" },
			],
		});
		return created.projectId;
	}

	it("publishes the stored snapshot as a my_library version whose fixed objects verify", async () => {
		const lifecycle = supplier().lifecycle;
		const projectId = await project(lifecycle, "# notes\n", "org");
		const result = await projectPublication(lifecycle).publish(
			request(),
			projectId,
			"publish-1",
			{
				schemaVersion: 1,
				contentRevision: 1,
				version: "1.0.0",
				visibility: "ORGANIZATION",
			},
		);
		expect(result.version).toMatchObject({
			skillId: projectId,
			provider: "my_library",
			visibility: "ORGANIZATION",
			state: "pending_review",
		});
		expect(Object.keys(result.artifacts).toSorted()).toEqual(
			[
				"bundle",
				"manifest",
				"scan",
				"signature",
				"signature-record",
				"source-proof",
				"zip",
			].toSorted(),
		);
		// 固定 ZIP 字节即服务端从已保存内容打出的包；来源证明固定项目修订且没有审批引用。
		const source = await lifecycle.readProjectPublicationSource(
			request(),
			projectId,
		);
		const zip = result.artifacts.zip;
		if (!zip || !source.content) throw new Error("zip missing");
		expect(zip.sha256).toBe(
			sha(packSkillProjectSnapshotV1(source.content.files)),
		);
		const [operation] =
			await sql`select payload from platform.outbox_items where scope_type = 'skill_package' and scope_id = ${result.version.skillVersionId}`;
		expect(operation?.payload.intents["source-proof"].evidence).toEqual({
			schemaVersion: 1,
			provider: "my_library",
			publisherId: "owner-a",
			sourceVersion: `project:${projectId}:r1`,
			sourceDigest: zip.sha256,
			approvalRef: null,
			trustRevision: "trust-1",
		});
		expect(operation?.payload.selection.organizationId).toBe("org");
		expect(scanCount).toBe(1);
		// 同一版本号的新内容不能再进入供应。
		await lifecycle.saveProjectContent(request(), projectId, "save-2", {
			schemaVersion: 1,
			baseRevision: 1,
			files: [{ path: "SKILL.md", encoding: "utf8", content: "# changed\n" }],
		});
		await expect(
			projectPublication(lifecycle).publish(request(), projectId, "publish-2", {
				schemaVersion: 1,
				contentRevision: 2,
				version: "1.0.0",
				visibility: "PRIVATE",
			}),
		).rejects.toMatchObject({ code: "version_conflict" });
		expect(scanCount).toBe(1);
	});

	// #2949 的 consumer 只认同一原发布操作及其七阶段固定证据；网页发布必须留下同样完整、可逐项核对的事实。
	it("leaves the unique original operation and every fixed evidence object verifiable after restart", async () => {
		const command = {
			schemaVersion: 1,
			contentRevision: 1,
			version: "1.0.0",
			visibility: "PRIVATE",
		};
		const projectId = await project(supplier().lifecycle, "# evidence\n");
		const result = await projectPublication(supplier().lifecycle).publish(
			request(),
			projectId,
			"publish-evidence",
			command,
		);
		const versionId = result.version.skillVersionId;
		// 唯一原操作：同一 Skill Version 只有一条已成功的 skill.package.publish.v1 outbox 与一条已完成的幂等记录。
		const operations =
			await sql`select id, operation, status, payload from platform.outbox_items where scope_type = 'skill_package' and scope_id = ${versionId}`;
		expect(operations).toHaveLength(1);
		const operation = operations[0];
		if (!operation) throw new Error("operation missing");
		expect(operation).toMatchObject({
			operation: "skill.package.publish.v1",
			status: "succeeded",
		});
		const records =
			await sql`select id, actor_id, command_type, status, result from platform.idempotency_records where scope_type = 'skill_package' and scope_id = ${versionId}`;
		expect(records).toEqual([
			{
				id: operation.id,
				actor_id: "owner-a",
				command_type: "skill.package.publish.v1",
				status: "completed",
				result: { operationId: operation.id, skillVersionId: versionId },
			},
		]);
		const state = parseSkillPackagePublicationStateV1(operation.payload);
		expect(state).toMatchObject({
			operationId: operation.id,
			ownerId: "owner-a",
			selection: {
				skillId: projectId,
				skillVersionId: versionId,
				provider: "my_library",
				version: "1.0.0",
				sourceVersion: `project:${projectId}:r1`,
				sourceDigest: result.version.packageDigest,
				archiveDigest: result.version.packageDigest,
				approvalRef: null,
			},
		});
		expect(state.objects).toEqual(result.artifacts);
		const [registered] =
			await sql`select package_object_version, package_digest, manifest_digest, signature_digest from platform.skill_hub_versions where id = ${versionId}`;
		expect(registered).toEqual({
			package_object_version: state.objects.zip?.version,
			package_digest: state.objects.zip?.sha256,
			manifest_digest: state.objects.manifest?.sha256,
			signature_digest: state.objects.signature?.sha256,
		});

		// 七阶段固定对象逐项按对象版本与 ETag 从版本化 MinIO 回读，长度、摘要与 mediaType 一致。
		const bytes = new Map<string, Buffer>();
		for (const stage of skillPackagePublicationStagesV1) {
			const object = state.objects[stage];
			if (!object) throw new Error(`${stage} missing`);
			expect(object.objectRef).toBe(
				skillPackageObjectRefV1(state.operationId, stage),
			);
			expect(object.version).not.toBe("null");
			expect(object.mediaType).toBe(
				stage === "zip"
					? "application/zip"
					: stage === "signature"
						? "application/octet-stream"
						: "application/json",
			);
			const body = Buffer.from(
				await new Response(
					await fixture.storage.download({
						objectRef: object.objectRef,
						version: object.version,
						etag: object.etag,
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
					}),
				).arrayBuffer(),
			);
			expect(body.byteLength).toBe(object.sizeBytes);
			expect(sha(body)).toBe(object.sha256);
			bytes.set(stage, body);
		}
		const stored = (stage: string) => bytes.get(stage) ?? Buffer.alloc(0);
		// manifest 由实际 ZIP 重建；来源证明与扫描回执按规范编码保存，扫描来自原生 ClamAV 且覆盖实际包。
		const prepared = prepareSkillPackageV1({
			archiveBytes: stored("zip"),
			name: state.selection.name,
			version: "1.0.0",
		});
		expect(prepared.packageDigest).toBe(result.version.packageDigest);
		expect(Buffer.from(prepared.manifestBytes).equals(stored("manifest"))).toBe(
			true,
		);
		const proof = JSON.parse(stored("source-proof").toString("utf8"));
		expect(proof).toEqual(state.intents["source-proof"]?.evidence);
		expect(
			Buffer.from(canonicalSkillPackageSourceProofV1(proof)).equals(
				stored("source-proof"),
			),
		).toBe(true);
		const receipt = JSON.parse(stored("scan").toString("utf8"));
		expect(receipt).toEqual(state.intents.scan?.evidence);
		expect(
			Buffer.from(canonicalSkillPackageScanReceiptV1(receipt)).equals(
				stored("scan"),
			),
		).toBe(true);
		expect(receipt).toMatchObject({
			scannerId: "native-clamav",
			verdict: "clean",
			admissionDecision: "pending_review",
		});
		verifySkillPackageScanReceiptV1(
			receipt,
			prepared,
			sha(stored("source-proof")),
			policyRevision,
			300_000,
		);
		// 签名记录关联同一固定 ZIP 版本、来源证明与扫描回执，Ed25519 签名可用受信公钥核对。
		const record = JSON.parse(stored("signature-record").toString("utf8"));
		expect(record).toEqual({
			schemaVersion: 1,
			skillId: projectId,
			skillVersionId: versionId,
			ownerId: "owner-a",
			provider: "my_library",
			version: "1.0.0",
			packageObjectVersion: state.objects.zip?.version,
			packageDigest: result.version.packageDigest,
			manifestDigest: result.version.manifestDigest,
			sourceProofDigest: sha(stored("source-proof")),
			scanReceiptDigest: sha(stored("scan")),
			trustRevision: "trust-1",
			policyRevision,
			signingKeyId: "key-1",
		});
		const { schemaVersion: _schemaVersion, ...signed } = record;
		expect(() =>
			verifyAdmissionSignatureV1(
				admissionSignatureBytesV1(signed),
				stored("signature"),
				keys.publicKey,
			),
		).not.toThrow();
		// bundle 绑定原操作、Owner、selection 与其余六个阶段的固定对象。
		expect(JSON.parse(stored("bundle").toString("utf8"))).toEqual({
			schemaVersion: 1,
			operationId: state.operationId,
			ownerId: "owner-a",
			selection: { ...state.selection },
			objects: Object.fromEntries(
				skillPackagePublicationStagesV1
					.filter((stage) => stage !== "bundle")
					.map((stage) => [stage, state.objects[stage]]),
			),
		});
		// 原操作与证据只含摘要和固定引用，不含项目正文。
		expect(JSON.stringify(operation.payload)).not.toContain("# evidence");

		// 重启后同一键重试只消费原结果：不重新扫描、不更换对象或签名，也不产生第二个发布操作。
		const replay = await projectPublication(supplier().lifecycle).publish(
			request(),
			projectId,
			"publish-evidence",
			command,
		);
		expect(replay.replayed).toBe(true);
		expect(replay.version).toEqual(result.version);
		expect(replay.artifacts).toEqual(result.artifacts);
		expect(scanCount).toBe(1);
		const [after] =
			await sql`select count(*)::int as count from platform.outbox_items where scope_type = 'skill_package'`;
		expect(after?.count).toBe(1);
	});

	it("rejects an infected project snapshot without registering a version", async () => {
		const lifecycle = supplier().lifecycle;
		const projectId = await project(
			lifecycle,
			"EICAR-STANDARD-ANTIVIRUS-TEST-FILE",
		);
		await expect(
			projectPublication(lifecycle).publish(request(), projectId, "publish-1", {
				schemaVersion: 1,
				contentRevision: 1,
				version: "1.0.0",
				visibility: "PRIVATE",
			}),
		).rejects.toThrow(/rejected/);
		expect(await counts()).toEqual({
			versions: 0,
			completed: 0,
			idempotency: 0,
		});
	});
});

import { createSkillPackageConsumerV1 } from "../packages/object-storage/src/skill-package-consumer.ts";
// #2949: production reader consumes the Supplier's actual durable operation; no success rows are fabricated.
import { PostgresSkillHubAgentBindingAdmissionV1 } from "../packages/platform-store/src/skill-hub-agent-binding.ts";

it("reads and verifies the original published package with current public-key trust after reopening the reader", async () => {
	const publication = await supplier().value.admitVersion(request(), input());
	const query = {
		skillVersionId: publication.version.skillVersionId,
		packageObjectVersion: publication.version.packageObjectVersion,
	};
	const reader = new PostgresSkillHubAgentBindingAdmissionV1({
		databaseUrl: database.databaseUrl,
	});
	const options = {
		storage: fixture.storage,
		readPublication: reader.readPublication.bind(reader),
		resolveAdmissionPolicy: async () => ({
			...(await scanner.describe()),
			policyRevision,
			trustRevision: "trust-1",
			keyId: "key-1",
			keyState: revokedKey ? ("revoked" as const) : ("active" as const),
			publicKey: keys.publicKey,
			allowInternalWithoutApproval: true,
		}),
		sourceVerifier: {
			verify: async (
				i: Parameters<
					import("../packages/object-storage/src/skill-package-admission.ts").SkillPackageSourceVerifierV1["verify"]
				>[0],
			) => {
				if (!sourceApproved) throw new Error("source unavailable");
				return {
					schemaVersion: 1 as const,
					provider: i.provider,
					publisherId: i.ownerId,
					sourceVersion: i.sourceVersion,
					sourceDigest: i.sourceDigest,
					approvalRef: i.approvalRef,
					trustRevision: i.trustRevision,
				};
			},
		},
	};
	try {
		const facts = await reader.readPublication(query);
		expect(facts?.state.objects).toEqual(publication.artifacts);
		expect(
			(await createSkillPackageConsumerV1(options).verify(query)).packageObject,
		).toEqual(publication.artifacts.zip);
		revokedKey = true;
		await expect(
			createSkillPackageConsumerV1(options).verify(query),
		).rejects.toThrow();
		revokedKey = false;
		sourceApproved = false;
		await expect(
			createSkillPackageConsumerV1(options).verify(query),
		).rejects.toThrow();
		sourceApproved = true;
	} finally {
		await reader.close();
	}
	const restarted = new PostgresSkillHubAgentBindingAdmissionV1({
		databaseUrl: database.databaseUrl,
	});
	try {
		const result = await createSkillPackageConsumerV1({
			...options,
			readPublication: restarted.readPublication.bind(restarted),
		}).verify(query);
		expect(result.state.objects).toEqual(publication.artifacts);
		expect(scanCount).toBe(1);
		expect(await counts()).toEqual({
			versions: 1,
			completed: 1,
			idempotency: 1,
		});
	} finally {
		await restarted.close();
	}
});

it("rejects inconsistent original Store facts without repairing publication", async () => {
	const publication = await supplier().value.admitVersion(request(), input());
	const query = {
		skillVersionId: publication.version.skillVersionId,
		packageObjectVersion: publication.version.packageObjectVersion,
	};
	const reader = new PostgresSkillHubAgentBindingAdmissionV1({
		databaseUrl: database.databaseUrl,
	});
	const [original] =
		await sql`select * from platform.idempotency_records where scope_type='skill_package'`;
	const [outbox] =
		await sql`select * from platform.outbox_items where scope_type='skill_package'`;
	if (!original || !outbox) throw new Error("publication fixture unavailable");
	try {
		expect(await reader.readPublication(query)).not.toBeNull();
		for (const mutation of [
			{ command_type: "wrong.operation" },
			{ actor_id: "owner-b" },
			{ scope_type: "wrong_scope" },
			{ request_digest: "f".repeat(64) },
			{
				result: { operationId: "wrong", skillVersionId: query.skillVersionId },
			},
		]) {
			await sql`update platform.idempotency_records set ${sql({ ...mutation, ...("result" in mutation ? { result: sql.json(mutation.result) } : {}) })} where id=${original.id}`;
			expect(await reader.readPublication(query)).toBeNull();
			await sql`update platform.idempotency_records set command_type=${original.command_type},actor_id=${original.actor_id},scope_type=${original.scope_type},request_digest=${original.request_digest},result=${sql.json(original.result)} where id=${original.id}`;
		}
		for (const mutate of [
			(p: Record<string, unknown>) => {
				p.ownerId = "owner-b";
			},
			(p: Record<string, unknown>) => {
				p.selection = {
					...(p.selection as Record<string, unknown>),
					skillId: "different-skill",
				};
			},
			(p: Record<string, unknown>) => {
				const { bundle: _bundle, ...remaining } = p.objects as Record<
					string,
					unknown
				>;
				p.objects = remaining;
			},
			(p: Record<string, unknown>) => {
				p.operationId = randomUUID();
			},
		]) {
			const payload = structuredClone(outbox.payload);
			mutate(payload);
			await sql`update platform.outbox_items set payload=${sql.json(payload)} where id=${outbox.id}`;
			expect(await reader.readPublication(query)).toBeNull();
			await sql`update platform.outbox_items set payload=${sql.json(outbox.payload)} where id=${outbox.id}`;
		}
		await sql`update platform.outbox_items set operation='wrong.operation' where id=${outbox.id}`;
		expect(await reader.readPublication(query)).toBeNull();
		await sql`update platform.outbox_items set operation='skill.package.publish.v1' where id=${outbox.id}`;
		expect(
			await reader.readPublication({
				...query,
				packageObjectVersion: "wrong-version",
			}),
		).toBeNull();
		expect(await reader.readPublication(query)).not.toBeNull();
		await sql`update platform.outbox_items set status='failed' where id=${outbox.id}`;
		expect(await reader.readPublication(query)).toBeNull();
		await sql`update platform.outbox_items set status='succeeded' where id=${outbox.id}`;
		const conflictingId = randomUUID();
		await sql`insert into platform.idempotency_records (id,scope_type,scope_id,actor_id,command_type,idempotency_key,request_digest,status,result)
        select ${conflictingId},scope_type,scope_id,actor_id,command_type,${conflictingId},request_digest,status,result from platform.idempotency_records where id=${original.id}`;
		expect(await reader.readPublication(query)).toBeNull();
		await sql`delete from platform.idempotency_records where id=${conflictingId}`;
		expect(await reader.readPublication(query)).not.toBeNull();
		await sql`delete from platform.outbox_items where id=${outbox.id}`;
		expect(await reader.readPublication(query)).toBeNull();
	} finally {
		await reader.close();
	}
});
