import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	createConversationExecutionUseCaseV1,
	createSessionWorkspaceReclamationV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { PostgresSessionWorkspaceReclamationStoreV1 } from "./session-workspace-reclamation.js";

let db: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresSessionWorkspaceReclamationStoreV1;
const sandboxId = "12345678-1234-1234-1234-123456789abc";
const target = {
	sessionGeneration: 1,
	resourceFence: 2,
	agentId: "agent",
	sessionId: "session",
	sandboxId,
	namespace: "retention-test",
	name: `sandbox-${sandboxId}`,
	uid: "original",
	resourceVersion: "2",
};
const policy = {
	namespace: target.namespace,
	minimumStoppedMs: 60000,
	retainedAgentIds: [],
	retainedSessionIds: [],
	retainedSandboxIds: [],
};
const pvcIdentity = {
	kind: "PersistentVolumeClaim",
	namespace: target.namespace,
	name: target.name,
	uid: "original",
	resourceVersion: "1",
};
const stopReceipt = {
	schemaVersion: 1,
	sandboxId,
	sessionId: "session",
	sourceGeneration: 1,
	sourceResourceFence: 1,
	targetGeneration: 1,
	targetResourceFence: 2,
	removed: [],
	retainedPVC: pvcIdentity,
};
const observation = {
	status: "stopped",
	resources: [pvcIdentity],
	sourceStop: stopReceipt,
};
const lifecycle = {
	schemaVersion: 1,
	authority: {
		kind: "management",
		applicationId: "application",
		managementRevision: 1,
		managementFence: 1,
		workloadRevision: 1,
		targetDesiredState: "stopped",
	},
	source: {
		sandbox: {
			schemaVersion: 1,
			sandboxId,
			sessionId: "session",
			agentId: "agent",
			principal: { kind: "user", id: "user" },
			channelId: "web",
			generation: 1,
			resourceName: target.name,
			workspaceScope: sandboxId,
		},
		resourceFence: 1,
		policy: {
			namespace: target.namespace,
			resourceConfigurationHash: "policy",
			configurationRevision: 1,
			workloadRevision: 1,
			managementFence: 1,
			imageDigest: "sha256:source",
		},
		observation: { status: "stopped", resources: [pvcIdentity] },
	},
	stopReceipt,
};
beforeAll(async () => {
	db = await startPostgresTestDatabase("workspace-4173", {
		logicalReplication: true,
	});
	await migratePlatformDatabase({ databaseUrl: db.databaseUrl });
	sql = postgres(db.databaseUrl, { max: 1 });
	store = new PostgresSessionWorkspaceReclamationStoreV1(
		db.databaseUrl,
		policy,
		"deployment-owner",
	);
}, 120000);
afterAll(async () => {
	await store?.close();
	await sql?.end();
	await db?.stop();
});
beforeEach(async () => {
	await sql`truncate platform.agents,platform.conversations cascade`;
	await sql`truncate platform.outbox_items,platform.audit_events,platform.session_sandbox_resource_charges`;
	await sql`insert into platform.agents(id,current_configuration_revision,authorization_revision) values('agent',1,'auth')`;
	await seedStoppedSandbox(target);
});

async function seedStoppedSandbox(candidate: typeof target) {
	const { sandboxId, sessionId, name, uid } = candidate;
	const pvc = { ...pvcIdentity, name, uid };
	const receipt = { ...stopReceipt, sandboxId, sessionId, retainedPVC: pvc };
	const source = lifecycle.source;
	const savedLifecycle = {
		...lifecycle,
		source: {
			...source,
			sandbox: { ...source.sandbox, sandboxId, sessionId, resourceName: name },
			observation: { ...source.observation, resources: [pvc] },
		},
		stopReceipt: receipt,
	};
	await sql`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision) values(${sessionId},'agent','user','web','ready',1,'auth')`;
	await sql`insert into platform.session_sandbox_allocations(sandbox_id,conversation_id,agent_id,actor_id,principal_type,channel_id,session_generation,resource_name,workspace_scope,status,created_at,updated_at,resource_fence,desired_state,resource_observation)
 values(${sandboxId},${sessionId},'agent','user','user','web',1,${name},${sandboxId},'stopped',now(),now(),2,'stopped',${sql.json({ ...observation, resources: [pvc], sourceStop: receipt })})`;
	await sql`insert into platform.session_sandbox_resource_charges(sandbox_id,namespace,resources,compute_released) values(${sandboxId},${target.namespace},'{}',true)`;
	await sql`insert into platform.outbox_items(id,trace_id,request_id,scope_type,scope_id,operation,payload,status,available_at,created_at,updated_at)
 values(${sessionId === target.sessionId ? "reconcile" : `reconcile-${sessionId}`},'trace','request','conversation',${sessionId},'conversation.sandbox.reconcile.v1',${sql.json({ lifecycle: savedLifecycle })},'succeeded',now(),now()-interval '2 minutes',now()-interval '2 minutes')`;
	await sql`insert into platform.conversation_audit_events
		(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at, details)
		values(${sessionId === target.sessionId ? "stopped-observed" : `stopped-observed-${sessionId}`},${sessionId},null,'agent','user','conversation.sandbox.observed','trace-stop','request-stop',now()-interval '2 minutes',
			${sql.json({ sandboxId, sessionGeneration: 1, resourceFence: 2, status: "stopped" })})`;
}

const roleSql = readFile(
	new URL(
		"../../../deploy/ack/operator/session-workspace-reclamation-db-ro.sql",
		import.meta.url,
	),
	"utf8",
);

const dropRoleSql = readFile(
	new URL(
		"../../../deploy/ack/operator/session-workspace-reclamation-db-ro-drop.sql",
		import.meta.url,
	),
	"utf8",
);

async function prepareReaderTestDatabase() {
	// Match ACK database bootstrap while keeping default PUBLIC function grants.
	await sql`revoke all on database platform_test from public`;
}

async function loginTestReader() {
	await sql.unsafe(await roleSql);
	await sql`alter role agent_infra_reclamation_ro login password 'reclamation-fixture'`;
	const url = new URL(db.databaseUrl);
	url.username = "agent_infra_reclamation_ro";
	url.password = "reclamation-fixture";
	return url.toString();
}

describe("real PostgreSQL storage reclamation and Kubernetes fake", () => {
	it("allows the exact PUBLIC logical message signatures without logical slots", async () => {
		await prepareReaderTestDatabase();
		// Exercise one explicit ACL and one built-in default ACL.
		await sql`grant execute on function pg_catalog.pg_logical_emit_message(boolean,text,text) to public`;
		await sql.unsafe(await roleSql);
		try {
			const [grants] = await sql`select
				has_function_privilege('agent_infra_reclamation_ro',
					'pg_catalog.pg_logical_emit_message(boolean,text,text)', 'EXECUTE') as text_allowed,
				has_function_privilege('agent_infra_reclamation_ro',
					'pg_catalog.pg_logical_emit_message(boolean,text,bytea)', 'EXECUTE') as bytea_allowed,
				rolcanlogin from pg_roles where rolname='agent_infra_reclamation_ro'`;
			expect(grants).toEqual({
				text_allowed: true,
				bytea_allowed: true,
				rolcanlogin: false,
			});
		} finally {
			await sql.unsafe(await dropRoleSql);
		}
	});

	it("rejects an unapproved overload even when its name matches a PUBLIC exception", async () => {
		await prepareReaderTestDatabase();
		await sql`create function pg_catalog.pg_logical_emit_message(integer)
			returns integer language sql as 'select 1'`;
		try {
			await expect(sql.unsafe(await roleSql)).rejects.toThrow(
				"reclamation reader has unexpected effective privileges",
			);
		} finally {
			await sql`rollback`;
			await sql`drop function pg_catalog.pg_logical_emit_message(integer)`;
		}
		expect(
			await sql`select oid from pg_roles where rolname = 'agent_infra_reclamation_ro'`,
		).toEqual([]);
	});

	it("reports an inactive logical slot and exits before creating the role", async () => {
		await prepareReaderTestDatabase();
		await sql`select pg_create_logical_replication_slot('reclamation_fixture', 'pgoutput')`;
		try {
			await expect(sql.unsafe(await roleSql)).rejects.toMatchObject({
				message: "WORKSPACE_READER_LOGICAL_SLOTS_PRESENT",
				detail: "logical_slot_count=1",
			});
		} finally {
			await sql`rollback`;
			await sql`select pg_drop_replication_slot('reclamation_fixture')`;
		}
		expect(
			await sql`select oid from pg_roles where rolname = 'agent_infra_reclamation_ro'`,
		).toEqual([]);
	});

	it.each(["SELECT", "SELECT (value)"])(
		"rejects extra %s in the projection schema",
		async (privilege) => {
			await prepareReaderTestDatabase();
			await sql`create view platform_reclamation_read.extra as select 1 as value`;
			try {
				await sql.unsafe(
					`grant ${privilege} on platform_reclamation_read.extra to public`,
				);
				await expect(sql.unsafe(await roleSql)).rejects.toThrow(
					"reclamation reader has unexpected effective privileges",
				);
				await sql`rollback`;
				expect(
					await sql`select oid from pg_roles where rolname = 'agent_infra_reclamation_ro'`,
				).toEqual([]);
			} finally {
				await sql`rollback`;
				await sql`drop view platform_reclamation_read.extra`;
			}
		},
	);

	it("runs dry-run under the operator role without access to raw payloads or business writes", async () => {
		await prepareReaderTestDatabase();
		const databaseUrl = await loginTestReader();
		const reader = postgres(databaseUrl);
		const scopedStore = new PostgresSessionWorkspaceReclamationStoreV1(
			databaseUrl,
			policy,
			"deployment-owner",
		);
		try {
			await sql`update platform.outbox_items set payload = ${sql.json({
				body: "synthetic outbox body",
				lifecycle: {
					...lifecycle,
					source: {
						...lifecycle.source,
						modelProjection: { privateValue: "synthetic credential material" },
					},
				},
			})}`;
			const api = createSessionWorkspaceReclamationV1(scopedStore, {
				async read() {
					return { uid: target.uid, resourceVersion: target.resourceVersion };
				},
				async delete() {
					throw new Error("dry-run attempted deletion");
				},
			});
			expect(await api.dryRun([target.name])).toEqual([target]);
			const [row] =
				await reader`select payload from platform_reclamation_read.outbox_items`;
			expect(row?.payload.lifecycle.source.modelProjection).toBe(true);
			expect(JSON.stringify(row)).not.toContain("synthetic");
			for (const query of [
				"select payload from platform.outbox_items",
				"select resource_observation from platform.session_sandbox_allocations",
				"select details from platform.conversation_audit_events",
				"select * from platform.conversation_messages",
				"select * from platform.platform_api_credentials",
				"update platform.conversations set status = 'unavailable'",
				"create table public.reclamation_probe (id integer)",
				"select pg_catalog.lo_export(0, '/unreachable')",
			]) {
				await expect(
					reader.begin("read write", (tx) => tx.unsafe(query)),
				).rejects.toMatchObject({ code: "42501" });
			}
			await sql`update platform.outbox_items set payload = jsonb_set(
				payload, '{lifecycle,stopReceipt,unexpected}', 'true'::jsonb
			)`;
			expect(await api.dryRun([target.name])).toEqual([]);
		} finally {
			await scopedStore.close();
			await reader.end();
			await sql`alter role agent_infra_reclamation_ro nologin`;
			const receipts = await sql.unsafe(await dropRoleSql);
			expect(receipts.at(-1)).toEqual([{ role_removed: true }]);
		}
	});
	it("preserves a large object and its role when the ownership guard blocks cleanup", async () => {
		await prepareReaderTestDatabase();
		const reader = postgres(await loginTestReader(), { max: 1 });
		let oid: number | undefined;
		try {
			const [object] = await reader.begin(
				"read write",
				(tx) => tx<{ oid: number }[]>`select pg_catalog.lo_create(0) as oid`,
			);
			oid = object?.oid;
			expect(oid).toBeDefined();
		} finally {
			await reader.end();
			await sql`alter role agent_infra_reclamation_ro nologin`;
		}
		try {
			await expect(sql.unsafe(await dropRoleSql)).rejects.toMatchObject({
				message: "WORKSPACE_READER_CLEANUP_OWNERSHIP_PRESENT",
				detail: expect.stringContaining('"large_objects":1'),
			});
		} finally {
			await sql`rollback`;
		}
		expect(
			await sql`select lomowner::regrole::text as owner from pg_largeobject_metadata where oid = ${oid ?? 0}`,
		).toEqual([{ owner: "agent_infra_reclamation_ro" }]);
		expect(
			await sql`select rolcanlogin from pg_roles where rolname = 'agent_infra_reclamation_ro'`,
		).toEqual([{ rolcanlogin: false }]);
		// Remove only the isolated test object, then verify the normal cleanup path.
		await sql`select pg_catalog.lo_unlink(${oid ?? 0})`;
		const receipts = await sql.unsafe(await dropRoleSql);
		expect(receipts.at(-1)).toEqual([{ role_removed: true }]);
	});

	it.each(["owner", "ACL"] as const)(
		"preserves the role and template1 object when a cross-database %s dependency remains",
		async (dependency) => {
			await prepareReaderTestDatabase();
			await sql.unsafe(await roleSql);
			const url = new URL(db.databaseUrl);
			const template = postgres(new URL("/template1", url).toString(), {
				max: 1,
			});
			try {
				await template`create table public.reclamation_dependency_fixture (id integer)`;
				if (dependency === "owner") {
					await template`alter table public.reclamation_dependency_fixture owner to agent_infra_reclamation_ro`;
				} else {
					await template`grant select on public.reclamation_dependency_fixture to agent_infra_reclamation_ro`;
				}
				try {
					await expect(sql.unsafe(await dropRoleSql)).rejects.toMatchObject({
						message:
							dependency === "owner"
								? "WORKSPACE_READER_CLEANUP_OWNERSHIP_PRESENT"
								: "WORKSPACE_READER_CLEANUP_UNEXPECTED_DEPENDENCIES",
						detail: expect.stringContaining(
							dependency === "owner"
								? '"template1_ownership_entries":1'
								: '"template1_acl_entries":1',
						),
					});
				} finally {
					await sql`rollback`;
				}
				expect(
					await template`select has_table_privilege('agent_infra_reclamation_ro',
						'public.reclamation_dependency_fixture', 'SELECT') as still_granted`,
				).toEqual([{ still_granted: true }]);
				expect(
					await sql`select rolcanlogin from pg_roles where rolname = 'agent_infra_reclamation_ro'`,
				).toEqual([{ rolcanlogin: false }]);
			} finally {
				await template`drop table if exists public.reclamation_dependency_fixture`;
				await template.end();
			}
			const receipts = await sql.unsafe(await dropRoleSql);
			expect(receipts.at(-1)).toEqual([{ role_removed: true }]);
		},
	);

	it("stops when a separate grantor adds the same column privilege", async () => {
		await prepareReaderTestDatabase();
		await sql.unsafe(await roleSql);
		await sql`create role reclamation_second_grantor nologin`;
		await sql`grant usage on schema platform to reclamation_second_grantor`;
		try {
			await sql.begin(async (tx) => {
				await tx`grant select (id) on platform.conversations
					to reclamation_second_grantor with grant option`;
				await tx`set local role reclamation_second_grantor`;
				await tx`grant select (id) on platform.conversations to agent_infra_reclamation_ro`;
			});
			try {
				await expect(sql.unsafe(await dropRoleSql)).rejects.toMatchObject({
					message: "WORKSPACE_READER_CLEANUP_UNEXPECTED_DEPENDENCIES",
					detail: expect.stringContaining('"unexpected_acl_rows":1'),
				});
			} finally {
				await sql`rollback`;
			}
			expect(
				await sql`select grantor::regrole::text as grantor
					from platform_reclamation_read.reader_grant_catalog
					where objid='platform.conversations'::regclass and objsubid=(
						select attnum from pg_attribute where attrelid='platform.conversations'::regclass and attname='id'
					) order by 1`,
			).toEqual([
				{ grantor: "platform_test" },
				{ grantor: "reclamation_second_grantor" },
			]);
		} finally {
			await sql.begin(async (tx) => {
				await tx`set local role reclamation_second_grantor`;
				await tx`revoke select (id) on platform.conversations from agent_infra_reclamation_ro`;
			});
			await sql`revoke select (id) on platform.conversations from reclamation_second_grantor`;
			await sql`revoke usage on schema platform from reclamation_second_grantor`;
			await sql`drop role reclamation_second_grantor`;
		}
		const receipts = await sql.unsafe(await dropRoleSql);
		expect(receipts.at(-1)).toEqual([{ role_removed: true }]);
	});

	it("rolls back the recorded revokes when another connection adds an ACL after the precheck", async () => {
		await prepareReaderTestDatabase();
		await sql.unsafe(await roleSql);
		const script = await dropRoleSql;
		const boundary = script.indexOf("-- Revoke only the recorded privilege");
		expect(boundary).toBeGreaterThan(0);
		const concurrent = postgres(db.databaseUrl, { max: 1 });
		try {
			await sql.unsafe(script.slice(0, boundary));
			await concurrent`create table platform.late_reclamation_grant (id integer)`;
			await concurrent`grant select on platform.late_reclamation_grant to agent_infra_reclamation_ro`;
			try {
				await expect(sql.unsafe(script.slice(boundary))).rejects.toMatchObject({
					message: "WORKSPACE_READER_CLEANUP_DEPENDENCIES_REMAIN",
					detail: expect.stringContaining('"cluster_acl_entries":1'),
				});
			} finally {
				await sql`rollback`;
			}
			expect(
				await sql`select
					has_table_privilege('agent_infra_reclamation_ro', 'platform.late_reclamation_grant', 'SELECT') as late_grant,
					has_column_privilege('agent_infra_reclamation_ro', 'platform.conversations', 'id', 'SELECT') as setup_grant,
					rolcanlogin from pg_roles where rolname='agent_infra_reclamation_ro'`,
			).toEqual([{ late_grant: true, setup_grant: true, rolcanlogin: false }]);
		} finally {
			await sql`rollback`;
			await concurrent`drop table if exists platform.late_reclamation_grant`;
			await concurrent.end();
		}
		const receipts = await sql.unsafe(await dropRoleSql);
		expect(receipts.at(-1)).toEqual([{ role_removed: true }]);
	});

	it("preserves the receipt and all grants when a receipt ACL appears after the final dependency check", async () => {
		await prepareReaderTestDatabase();
		await sql.unsafe(await roleSql);
		const script = await dropRoleSql;
		const finalCheck = script.indexOf(
			"WORKSPACE_READER_CLEANUP_DEPENDENCIES_CLEAR",
		);
		const boundary = script.indexOf("$$;", finalCheck) + "$$;".length;
		expect(finalCheck).toBeGreaterThan(0);
		expect(boundary).toBeGreaterThan(finalCheck);
		const concurrent = postgres(db.databaseUrl, { max: 1 });
		try {
			await sql.unsafe(script.slice(0, boundary));
			await concurrent`grant select on platform_reclamation_read.reader_grant_receipt
				to agent_infra_reclamation_ro`;
			try {
				await expect(sql.unsafe(script.slice(boundary))).rejects.toMatchObject({
					code: "2BP01",
				});
			} finally {
				await sql`rollback`;
			}
			expect(
				await concurrent`select
					has_table_privilege('agent_infra_reclamation_ro',
						'platform_reclamation_read.reader_grant_receipt', 'SELECT') as receipt_grant,
					has_column_privilege('agent_infra_reclamation_ro',
						'platform.conversations', 'id', 'SELECT') as setup_grant,
					rolcanlogin from pg_roles where rolname = 'agent_infra_reclamation_ro'`,
			).toEqual([
				{ receipt_grant: true, setup_grant: true, rolcanlogin: false },
			]);
			expect(
				await concurrent`select 1 from platform_reclamation_read.reader_grant_catalog limit 1`,
			).toHaveLength(1);
			await concurrent`revoke select on platform_reclamation_read.reader_grant_receipt
				from agent_infra_reclamation_ro`;
		} finally {
			await sql`rollback`;
			await concurrent.end();
		}
		const receipts = await sql.unsafe(await dropRoleSql);
		expect(receipts.at(-1)).toEqual([{ role_removed: true }]);
	});
	it("uses the durable stopped observation clock and de-duplicates succeeded reconciliation rows", async () => {
		await sql`insert into platform.outbox_items(id,trace_id,request_id,scope_type,scope_id,operation,payload,status,available_at,created_at,updated_at)
			values('reconcile-duplicate','trace-2','request-2','conversation','session','conversation.sandbox.reconcile.v1',${sql.json({ lifecycle })},'succeeded',now(),now()-interval '2 minutes',clock_timestamp())`;
		const candidates = await store.candidates([target.name]);
		const { resourceVersion: _resourceVersion, ...candidate } = target;
		expect(candidates).toEqual([candidate]);
		await sql`update platform.outbox_items set updated_at=clock_timestamp() where id='reconcile'`;
		expect(await store.candidates([target.name])).toEqual([candidate]);
	});
	it("runs the operator CLI against two eligible candidates with PVC get permission for only one", async () => {
		const unapprovedSandbox = "22345678-1234-1234-1234-123456789abc";
		const unapprovedPvcName = `sandbox-${unapprovedSandbox}`;
		await seedStoppedSandbox({
			...target,
			sandboxId: unapprovedSandbox,
			sessionId: "unapproved",
			name: unapprovedPvcName,
			uid: "different",
		});
		expect(
			(await store.candidates([target.name, unapprovedPvcName])).map(
				(row) => row.name,
			),
		).toEqual([target.name, unapprovedPvcName]);
		const base = `/api/v1/namespaces/${target.namespace}/persistentvolumeclaims`;
		const requests: string[] = [];
		const server = createServer((request, response) => {
			response.setHeader("content-type", "application/json");
			if (request.method === "GET" && request.url === "/api/v1") {
				response.end(
					JSON.stringify({
						kind: "APIResourceList",
						apiVersion: "v1",
						groupVersion: "v1",
						resources: [
							{
								name: "persistentvolumeclaims",
								kind: "PersistentVolumeClaim",
								namespaced: true,
								verbs: ["get"],
							},
						],
					}),
				);
				return;
			}
			requests.push(`${request.method} ${request.url}`);
			if (
				request.method === "GET" &&
				request.url === `${base}/${target.name}`
			) {
				response.end(
					JSON.stringify({
						apiVersion: "v1",
						kind: "PersistentVolumeClaim",
						metadata: {
							namespace: target.namespace,
							name: target.name,
							uid: target.uid,
							resourceVersion: target.resourceVersion,
						},
					}),
				);
				return;
			}
			response.statusCode = 403;
			response.end(
				JSON.stringify({
					apiVersion: "v1",
					kind: "Status",
					status: "Failure",
					code: 403,
				}),
			);
		});
		const folder = await mkdtemp(join(tmpdir(), "reclamation-cli-"));
		try {
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("local fake failed to bind");
			const policyFile = join(folder, "policy.json");
			const namesFile = join(folder, "approved.json");
			const kubeconfig = join(folder, "kubeconfig.json");
			await writeFile(policyFile, JSON.stringify(policy));
			await writeFile(namesFile, JSON.stringify([target.name]));
			await writeFile(
				kubeconfig,
				JSON.stringify({
					apiVersion: "v1",
					kind: "Config",
					clusters: [
						{
							name: "fixture",
							cluster: {
								server: `http://127.0.0.1:${address.port}`,
								"insecure-skip-tls-verify": true,
							},
						},
					],
					contexts: [
						{
							name: "fixture",
							context: { cluster: "fixture", user: "fixture" },
						},
					],
					users: [{ name: "fixture", user: {} }],
					"current-context": "fixture",
				}),
			);
			const worker = fileURLToPath(
				new URL("../../../apps/platform-worker/", import.meta.url),
			);
			const run = (...args: string[]) =>
				promisify(execFile)(
					process.execPath,
					[
						"--import",
						"tsx",
						"src/session-workspace-reclamation-cli.ts",
						"dry-run",
						policyFile,
						...args,
					],
					{
						cwd: worker,
						env: {
							...process.env,
							PLATFORM_DATABASE_URL: db.databaseUrl,
							DEPLOYMENT_OWNER: "fixture",
							KUBECONFIG: kubeconfig,
						},
					},
				);
			await expect(run()).rejects.toMatchObject({ code: 1 });
			expect(requests).toEqual([]);
			const { stdout } = await run(namesFile);
			expect(JSON.parse(stdout)).toEqual({
				schemaVersion: 1,
				mode: "dry-run",
				result: [target],
			});
			expect(requests).toEqual([`GET ${base}/${target.name}`]);
		} finally {
			server.close();
			await rm(folder, { recursive: true, force: true });
		}
	}, 30000);

	it("excludes a same-name PVC with a replacement UID", async () => {
		const api = createSessionWorkspaceReclamationV1(store, {
			async read(name) {
				expect(name).toBe(target.name);
				return { uid: "replacement", resourceVersion: "3" };
			},
			async delete() {
				throw new Error("dry-run attempted deletion");
			},
		});
		expect(await api.dryRun([target.name])).toEqual([]);
	});

	it.each([
		{ failureCode: { privateValue: "synthetic" } },
		{
			workspaceSnapshot: {
				podUid: "source-pod",
				imageDigest: `sha256:${"0".repeat(64)}`,
				outcome: "completed",
				attempt: 1,
				extra: "synthetic",
			},
		},
	])(
		"rejects malformed source evidence on both projection and original-table paths",
		async (invalid) => {
			const pod = { ...pvcIdentity, kind: "Pod", uid: "source-pod" };
			const receipt = {
				...stopReceipt,
				removed: [
					{
						resource: pod,
						preconditions: {
							uid: pod.uid,
							resourceVersion: pod.resourceVersion,
						},
						absence: {
							kind: pod.kind,
							namespace: pod.namespace,
							name: pod.name,
						},
					},
				],
			};
			const source = {
				...lifecycle.source,
				observation: { status: "observed", resources: [pod, pvcIdentity] },
			};
			const intent = {
				...lifecycle,
				source,
				stopReceipt: receipt,
				deletionProgress: [
					{
						...receipt.removed[0],
						schemaVersion: 1,
						state: "absent",
						deleteAttemptId: "fixture",
						deleteAttempted: true,
						deleteCallResult: "acknowledged",
						sourceGeneration: 1,
						resourceFence: 1,
						managementFence: 1,
					},
				],
			};
			await sql`update platform.session_sandbox_allocations set resource_observation = ${sql.json(
				{
					...observation,
					sourceStop: receipt,
				},
			)}`;
			await sql`update platform.outbox_items set payload = ${sql.json({ lifecycle: intent })}`;
			expect(await store.candidates([target.name])).toHaveLength(1);
			await sql`update platform.outbox_items set payload = ${sql.json({
				lifecycle: {
					...intent,
					source: {
						...source,
						observation: { ...source.observation, ...invalid },
					},
				},
			})}`;
			expect(await store.candidates([target.name])).toEqual([]);
			await expect(store.prepare(target)).rejects.toThrow(
				"WORKSPACE_NOT_ELIGIBLE",
			);
		},
	);

	it("dry-run is read-only; deletes original conditional identity then releases/audits once, history unavailable", async () => {
		let exists = true;
		const deletions: unknown[] = [];
		const api = createSessionWorkspaceReclamationV1(store, {
			async read() {
				return exists ? { uid: "original", resourceVersion: "2" } : null;
			},
			async delete(t) {
				deletions.push(t);
				exists = false;
			},
		});
		expect(await api.dryRun([target.name])).toEqual([target]);
		expect(await sql`select * from platform.audit_events`).toHaveLength(0);
		await api.execute(target);
		await api.execute(target);
		expect(deletions).toEqual([target]);
		expect(
			(
				await sql`select released from platform.session_sandbox_resource_charges`
			)[0]?.released,
		).toBe(true);
		expect(
			(await sql`select status from platform.conversations`)[0]?.status,
		).toBe("unavailable");
		expect(await sql`select * from platform.audit_events`).toHaveLength(2);
		const transaction = new PostgresConversationExecutionTransactionV1({
			databaseUrl: db.databaseUrl,
		});
		try {
			const usecase = createConversationExecutionUseCaseV1({
				transaction,
				authorization: {
					async authorize() {
						return {
							outcome: "allowed",
							authority: {
								schemaVersion: 1,
								actorId: "user",
								agentId: "agent",
								channelId: "web",
								authorizationRevision: "auth",
								supportsSupplementaryInstruction: false,
							},
						};
					},
				},
			});
			expect(
				await usecase.accept({
					schemaVersion: 1,
					command: "message",
					conversationId: "session",
					text: "after reclamation",
					idempotencyKey: "after-reclaim",
					traceId: "trace",
					requestId: "request",
				}),
			).toEqual({ outcome: "denied" });
			expect(
				await sql`select * from platform.session_sandbox_allocations`,
			).toHaveLength(1);
			expect(
				await sql`select * from platform.conversation_messages`,
			).toHaveLength(0);
			expect(deletions).toHaveLength(1);
		} finally {
			await transaction.close();
		}
		expect(await store.inspect(target)).toMatchObject({
			state: { released: true, conversation_status: "unavailable" },
			journal: [
				{ action: "conversation.workspace.reclamation.started" },
				{ action: "conversation.workspace.reclamation.completed" },
			],
		});
	});
	it("rejects malformed stop proof and changed generation/fence on recovery", async () => {
		await sql`update platform.outbox_items set payload='{"lifecycle":{"stopReceipt":{}}}'`;
		expect(await store.candidates([target.name])).toEqual([]);
		await expect(store.prepare(target)).rejects.toThrow("ELIGIBLE");
	});
	it("does not delete after a journaled target generation changes", async () => {
		await store.prepare(target);
		await sql`update platform.session_sandbox_allocations set resource_fence=3`;
		const deletions: unknown[] = [];
		await expect(
			createSessionWorkspaceReclamationV1(store, {
				async read() {
					return { uid: "original", resourceVersion: "2" };
				},
				async delete(t) {
					deletions.push(t);
				},
			}).execute(target),
		).rejects.toThrow("TOMBSTONE");
		expect(deletions).toEqual([]);
		expect(
			(
				await sql`select released from platform.session_sandbox_resource_charges`
			)[0]?.released,
		).toBe(false);
	});
	it.each(["running", "unknown"])("refuses allocation %s", async (status) => {
		await sql`update platform.session_sandbox_allocations set status=${status === "running" ? "ready" : "unknown"}`;
		expect(await store.candidates([target.name])).toEqual([]);
		await expect(store.prepare(target)).rejects.toThrow("ELIGIBLE");
	});
	it("rejects unknown executions and unfinished reconciliation before any tombstone", async () => {
		await sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at) values('execution','session','agent','user','web','turn','unknown',1,'auth',now())`;
		expect(await store.candidates([target.name])).toEqual([]);
		await expect(store.prepare(target)).rejects.toThrow("ELIGIBLE");
		expect(
			(await sql`select status from platform.conversations`)[0]?.status,
		).toBe("ready");
		await sql`delete from platform.conversation_executions`;
		await sql`update platform.outbox_items set status='processing',lease_owner='worker',lease_expires_at=now()+interval '1 minute'`;
		expect(await store.candidates([target.name])).toEqual([]);
	});
	it("protects deployment retention, stopped threshold and original PVC UID", async () => {
		const retained = new PostgresSessionWorkspaceReclamationStoreV1(
			db.databaseUrl,
			{ ...policy, retainedSessionIds: ["session"] },
			"owner",
		);
		try {
			expect(await retained.candidates([target.name])).toEqual([]);
			await expect(retained.prepare(target)).rejects.toThrow("DENIED");
		} finally {
			await retained.close();
		}
		await expect(store.prepare({ ...target, uid: "new-uid" })).rejects.toThrow(
			"OWNERSHIP",
		);
		await sql`update platform.outbox_items set updated_at=now()`;
		await sql`update platform.conversation_audit_events set occurred_at=clock_timestamp() where id='stopped-observed'`;
		expect(await store.candidates([target.name])).toEqual([]);
	});
	it("retains charge after unconfirmed delete and resumes original journal after process failure", async () => {
		await store.prepare(target);
		expect(
			(
				await sql`select released from platform.session_sandbox_resource_charges`
			)[0]?.released,
		).toBe(false);
		await expect(
			store.prepare({ ...target, resourceVersion: "changed" }),
		).rejects.toThrow("CONFLICT");
		await createSessionWorkspaceReclamationV1(store, {
			async read() {
				return null;
			},
			async delete() {
				throw new Error("must not delete");
			},
		}).execute(target);
		expect(
			(
				await sql`select released from platform.session_sandbox_resource_charges`
			)[0]?.released,
		).toBe(true);
	});
});
