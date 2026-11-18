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
	db = await startPostgresTestDatabase("workspace-4173");
	await migratePlatformDatabase({ databaseUrl: db.databaseUrl });
	sql = postgres(db.databaseUrl);
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
	await sql`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision) values('session','agent','user','web','ready',1,'auth')`;
	await sql`insert into platform.session_sandbox_allocations(sandbox_id,conversation_id,agent_id,actor_id,principal_type,channel_id,session_generation,resource_name,workspace_scope,status,created_at,updated_at,resource_fence,desired_state,resource_observation)
 values(${sandboxId},'session','agent','user','user','web',1,${target.name},${sandboxId},'stopped',now(),now(),2,'stopped',${sql.json(observation)})`;
	await sql`insert into platform.session_sandbox_resource_charges(sandbox_id,namespace,resources,compute_released) values(${sandboxId},${target.namespace},'{}',true)`;
	await sql`insert into platform.outbox_items(id,trace_id,request_id,scope_type,scope_id,operation,payload,status,available_at,created_at,updated_at)
 values('reconcile','trace','request','conversation','session','conversation.sandbox.reconcile.v1',${sql.json({ lifecycle })},'succeeded',now(),now()-interval '2 minutes',now()-interval '2 minutes')`;
	await sql`insert into platform.conversation_audit_events
		(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at, details)
		values('stopped-observed','session',null,'agent','user','conversation.sandbox.observed','trace-stop','request-stop',now()-interval '2 minutes',
			${sql.json({ sandboxId, sessionGeneration: 1, resourceFence: 2, status: "stopped" })})`;
});
describe("real PostgreSQL storage reclamation and Kubernetes fake", () => {
	it("uses the durable stopped observation clock and de-duplicates succeeded reconciliation rows", async () => {
		await sql`insert into platform.outbox_items(id,trace_id,request_id,scope_type,scope_id,operation,payload,status,available_at,created_at,updated_at)
			values('reconcile-duplicate','trace-2','request-2','conversation','session','conversation.sandbox.reconcile.v1',${sql.json({ lifecycle })},'succeeded',now(),now()-interval '2 minutes',clock_timestamp())`;
		const candidates = await store.candidates();
		const { uid: _uid, resourceVersion: _resourceVersion, ...candidate } = target;
		expect(candidates).toEqual([candidate]);
		await sql`update platform.outbox_items set updated_at=clock_timestamp() where id='reconcile'`;
		expect(await store.candidates()).toEqual([candidate]);
	});
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
		expect(await api.dryRun()).toEqual([target]);
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
		expect(await store.candidates()).toEqual([]);
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
		expect(await store.candidates()).toEqual([]);
		await expect(store.prepare(target)).rejects.toThrow("ELIGIBLE");
	});
	it("rejects unknown executions and unfinished reconciliation before any tombstone", async () => {
		await sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at) values('execution','session','agent','user','web','turn','unknown',1,'auth',now())`;
		expect(await store.candidates()).toEqual([]);
		await expect(store.prepare(target)).rejects.toThrow("ELIGIBLE");
		expect(
			(await sql`select status from platform.conversations`)[0]?.status,
		).toBe("ready");
		await sql`delete from platform.conversation_executions`;
		await sql`update platform.outbox_items set status='processing',lease_owner='worker',lease_expires_at=now()+interval '1 minute'`;
		expect(await store.candidates()).toEqual([]);
	});
	it("protects deployment retention, stopped threshold and original PVC UID", async () => {
		const retained = new PostgresSessionWorkspaceReclamationStoreV1(
			db.databaseUrl,
			{ ...policy, retainedSessionIds: ["session"] },
			"owner",
		);
		try {
			expect(await retained.candidates()).toEqual([]);
			await expect(retained.prepare(target)).rejects.toThrow("DENIED");
		} finally {
			await retained.close();
		}
		await expect(store.prepare({ ...target, uid: "new-uid" })).rejects.toThrow(
			"OWNERSHIP",
		);
		await sql`update platform.outbox_items set updated_at=now()`;
		await sql`update platform.conversation_audit_events set occurred_at=clock_timestamp() where id='stopped-observed'`;
		expect(await store.candidates()).toEqual([]);
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
