import { connectionConsumerProfileFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import { createConnectionInstallationAuthorizationV1 } from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { decodePlatformAuditRowV1 } from "./audit.js";
import { PostgresConnectionInstallationAuthorizationTransactionV1 } from "./connection-installation.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { seedSessionSandboxFixture } from "./session-sandbox.fixture.js";

let database: PostgresTestDatabase;
let client: ReturnType<typeof postgres>;
let store: PostgresConnectionInstallationAuthorizationTransactionV1;
let userActive = true;
const profile = {
	schemaVersion: 1 as const,
	publicOrigin: "https://connection.test",
	mcpPath: "/mcp",
	consumerId: "platform",
	audience: "mcp",
	egressProfile: { ref: "egress", revision: "r1" },
};
const approval = {
	schemaVersion: 1 as const,
	configFingerprint: connectionConsumerProfileFingerprintV1(profile),
	source: { ref: "profile", revision: "r1" },
	egressEnforced: true as const,
};
const configuration = {
	schemaVersion: 1 as const,
	ref: "oauth",
	revision: "r1",
	clientId: "platform-client",
	issuer: "https://connection.test/",
	authorizationEndpoint: "https://connection.test/oauth/authorize",
	tokenEndpoint: "https://connection.test/oauth/token",
	revocationEndpoint: "https://connection.test/oauth/revoke",
	callbackUrl: "https://platform.test/connection/callback",
	runtimeOrigin: "https://runtime.test:3443/",
	resource: "https://connection.test/mcp",
	scope: "mcp" as const,
	configFingerprint: approval.configFingerprint,
	source: approval.source,
};
const request = {
	userId: "alice",
	identityRevision: "identity-r1",
	requestId: "request-a",
	traceId: "trace-a",
	idempotencyKey: "key-a",
};
beforeAll(async () => {
	database = await startPostgresTestDatabase("1608-installation");
	client = postgres(database.databaseUrl);
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	store = new PostgresConnectionInstallationAuthorizationTransactionV1({
		databaseUrl: database.databaseUrl,
		profile,
		approval,
		configuration,
		directory: {
			resolveUser: async (userId) => ({
				schemaVersion: 1,
				userId,
				accountStatus: userActive ? "active" : "disabled",
				organizationIds: ["eng"],
				authorizationRevision: "identity-r1",
			}),
		},
	});
	await client`insert into platform.agents(id,authorization_revision) values ('agent-a','agent-r1')`;
	await client`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values ('application-a','agent-a','owner','Agent','test','available','trace','request',now(),1,1,'ready','running',1,1)`;
	await client`insert into platform.agent_availability(agent_id,target_type,target_id) values ('agent-a','user','alice')`;
	await client`insert into platform.agent_owners(agent_id,owner_id,created_at) values ('agent-a','owner',now())`;
	await client`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version) values ('personal','alice',1,1)`;
	await client`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext) values ('personal','alice',1,'fixture-key',${client.json({ purpose: "personal", subjectId: "alice", keyId: "fixture-key", keyVersion: 1 })})`;
	await client`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,host_session_ref) values ('conversation-a','agent-a','alice','web','active',1,'agent-r1','host-a')`;
	await client`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at,runtime_submit_protocol,original_operation_digest,original_submit_host_session_ref,execution_source,relay_key_purpose,relay_key_subject_id,relay_key_id,relay_key_version) values ('execution-a','conversation-a','agent-a','alice','web','turn-a','processing',1,'agent-r1',now(),'v4',${"a".repeat(43)},'host-a','web','personal','alice','fixture-key',1)`;
	await client`insert into platform.task_authorization_records(id,execution_id,boundary) values ('task-a','execution-a',${client.json({ schemaVersion: 1, principal: { kind: "user", id: "alice" }, agentId: "agent-a", channelId: "web", identityRevision: "identity-r1", agentAuthorizationRevision: "agent-r1", accessSources: [{ kind: "user", userId: "alice" }] })})`;
	await seedSessionSandboxFixture(client, "conversation-a");
	await client`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,status,lease_owner,lease_expires_at,trace_id) values ('item-a','conversation','conversation-a','conversation.turn.submit.v1',${client.json({ executionId: "execution-a" })},'processing','worker-a',now()+interval '1 hour','trace-a')`;
}, 30000);
beforeEach(async () => {
	userActive = true;
	await client`delete from platform.connection_installation_commands`;
	await client`delete from platform.connection_installation_authorizations`;
	await client`delete from platform.idempotency_records where scope_type='connection_installation'`;
	await client`update platform.conversation_executions set status='processing' where execution_id='execution-a'`;
	await client`update platform.task_authorization_records set revoked_at=null where id='task-a'`;
	await client`update platform.outbox_items set lease_expires_at=now()+interval '1 hour' where id='item-a'`;
});
afterAll(async () => {
	await store?.close();
	await client?.end();
	await database?.stop();
});
it("serializes concurrent begin and confirms the same persisted revision", async () => {
	const producer = createConnectionInstallationAuthorizationV1({ store });
	const [a, b] = await Promise.all([
		producer.execute({
			...request,
			command: "begin",
			executionId: "execution-a",
		}),
		producer.execute({
			...request,
			command: "begin",
			executionId: "execution-a",
		}),
	]);
	expect(a.authorizationId).toBe(b.authorizationId);
	const confirmed = await producer.execute({
		...request,
		command: "confirm",
		authorizationId: a.authorizationId,
	});
	expect(confirmed.confirmationRevision).toBe(a.confirmationRevision);
	expect(
		await producer.execute({
			...request,
			command: "status",
			authorizationId: a.authorizationId,
		}),
	).toMatchObject({ status: "confirmed" });
	expect(
		await producer.authorize(
			{
				principal: a.principal,
				scope: a.scope,
				reference: a.reference,
				authorizationId: a.authorizationId,
				command: "confirm",
			},
			new AbortController().signal,
			async () => {},
		),
	).toMatchObject({ revision: a.confirmationRevision });
	const [audit] =
		await client`select id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome,occurred_at,details from platform.audit_events where action='connection.installation.confirm' order by occurred_at desc limit 1`;
	if (!audit) throw Error("Missing installation audit");
	expect(
		decodePlatformAuditRowV1({
			auditId: audit.id,
			traceId: audit.trace_id,
			actorType: audit.actor_type,
			actorId: audit.actor_id,
			action: audit.action,
			targetType: audit.target_type,
			targetId: audit.target_id,
			outcome: audit.outcome,
			occurredAt: audit.occurred_at,
			details: audit.details,
		}),
	).toMatchObject({
		action: "connection.installation.confirm",
		subject: { kind: "agent", subjectId: "agent-a" },
	});
});
it("rejects cross-user reads, stopped execution, and current identity revocation", async () => {
	const producer = createConnectionInstallationAuthorizationV1({ store });
	const a = await producer.execute({
		...request,
		command: "begin",
		executionId: "execution-a",
	});
	await expect(
		producer.execute({
			...request,
			userId: "bob",
			command: "status",
			authorizationId: a.authorizationId,
		}),
	).rejects.toMatchObject({ code: "denied" });
	await client`update platform.conversation_executions set status='completed' where execution_id='execution-a'`;
	await expect(
		producer.execute({
			...request,
			command: "confirm",
			authorizationId: a.authorizationId,
		}),
	).rejects.toMatchObject({ code: "denied" });
	await client`update platform.conversation_executions set status='processing' where execution_id='execution-a'`;
	userActive = false;
	await expect(
		producer.execute({
			...request,
			command: "confirm",
			authorizationId: a.authorizationId,
		}),
	).rejects.toMatchObject({ code: "denied" });
});
it("rechecks after finalCheck without sending under a revoked task boundary", async () => {
	const producer = createConnectionInstallationAuthorizationV1({ store });
	const a = await producer.execute({
		...request,
		command: "begin",
		executionId: "execution-a",
	});
	expect(
		await producer.authorize(
			{
				principal: a.principal,
				scope: a.scope,
				reference: a.reference,
				authorizationId: a.authorizationId,
				command: "begin",
			},
			new AbortController().signal,
			async () => {
				await client`update platform.task_authorization_records set revoked_at=now() where id='task-a'`;
			},
		),
	).toBeNull();
});

it("does not authorize sending, unknown or completed commands for replay", async () => {
	const producer = createConnectionInstallationAuthorizationV1({ store });
	const a = await producer.execute({
		...request,
		command: "begin",
		executionId: "execution-a",
	});
	const input = {
		principal: a.principal,
		reference: a.reference,
		scope: a.scope,
		authorizationId: a.authorizationId,
		command: "begin" as const,
	};
	for (const status of ["sending", "unknown", "completed"]) {
		await client`update platform.connection_installation_commands set status=${status} where authorization_id=${a.authorizationId}`;
		expect(
			await producer.authorize(
				input,
				new AbortController().signal,
				async () => {},
			),
		).toBeNull();
	}
});

it.each(["sending", "unknown", "completed"])(
	"does not bypass an earlier %s confirm with another key",
	async (status) => {
		const producer = createConnectionInstallationAuthorizationV1({ store });
		const a = await producer.execute({
			...request,
			command: "begin",
			executionId: "execution-a",
		});
		const confirm = {
			...request,
			command: "confirm" as const,
			authorizationId: a.authorizationId,
		};
		await producer.execute(confirm);
		await client`update platform.connection_installation_commands set status=${status} where authorization_id=${a.authorizationId} and command='confirm'`;
		const retry = producer.execute({ ...confirm, idempotencyKey: "fresh-key" });
		if (status === "completed")
			await expect(retry).resolves.toMatchObject({ status: "confirmed" });
		else await expect(retry).rejects.toMatchObject({ code: "conflict" });
		const [count] =
			await client`select count(*)::int as count from platform.connection_installation_commands where authorization_id=${a.authorizationId} and command='confirm'`;
		expect(count?.count).toBe(1);
		expect(
			await producer.authorize(
				{
					principal: a.principal,
					reference: a.reference,
					scope: a.scope,
					authorizationId: a.authorizationId,
					command: "confirm",
				},
				new AbortController().signal,
				async () => {},
			),
		).toBeNull();
	},
);

it("rejects a lost claim and an idempotency key with different installation intent", async () => {
	const producer = createConnectionInstallationAuthorizationV1({ store });
	const a = await producer.execute({
		...request,
		command: "begin",
		executionId: "execution-a",
	});
	const b = await producer.execute({
		...request,
		idempotencyKey: "key-b",
		command: "begin",
		executionId: "execution-a",
	});
	await producer.execute({
		...request,
		idempotencyKey: "confirm-key",
		command: "confirm",
		authorizationId: a.authorizationId,
	});
	await expect(
		producer.execute({
			...request,
			idempotencyKey: "confirm-key",
			command: "confirm",
			authorizationId: b.authorizationId,
		}),
	).rejects.toMatchObject({ code: "conflict" });
	await client`update platform.outbox_items set lease_expires_at=now()-interval '1 second' where id='item-a'`;
	await expect(
		producer.execute({
			...request,
			command: "confirm",
			authorizationId: a.authorizationId,
		}),
	).rejects.toMatchObject({ code: "denied" });
});

it("claims one pending command with an owned attempt and permanently fences unknown", async () => {
	const producer = createConnectionInstallationAuthorizationV1({ store });
	const authorization = await producer.execute({
		...request,
		command: "begin",
		executionId: "execution-a",
	});
	await producer.execute({
		...request,
		command: "confirm",
		authorizationId: authorization.authorizationId,
	});
	const pending = await store.listPending(10, ["execution-a"]);
	const begin = pending.find((item) => item.command.command === "begin");
	if (!begin) throw new Error("missing begin command");
	const beginClaim = await store.claimPending({
		commandId: begin.command.commandId,
		attemptId: "begin-attempt",
		attemptOwner: "worker-a",
	});
	expect(beginClaim).toBeDefined();
	expect(
		await store.settle({
			commandId: begin.command.commandId,
			attemptId: "begin-attempt",
			attemptOwner: "worker-a",
			status: "completed",
		}),
	).toBe(true);
	const pendingAfterBegin = await store.listPending(10, ["execution-a"]);
	const confirm = pendingAfterBegin.find(
		(item) => item.command.command === "confirm",
	);
	expect(confirm).toBeDefined();
	const commandId = confirm?.command.commandId;
	if (!commandId) throw new Error("missing pending command");
	const claimed = await store.claimPending({
		commandId,
		attemptId: "attempt-a",
		attemptOwner: "worker-a",
	});
	expect(claimed?.command).toMatchObject({
		commandId,
		status: "sending",
		attemptId: "attempt-a",
		attemptOwner: "worker-a",
	});
	expect(
		await store.claimPending({
			commandId,
			attemptId: "attempt-b",
			attemptOwner: "worker-b",
		}),
	).toBeNull();
	expect(
		await store.settle({
			commandId,
			attemptId: "attempt-a",
			attemptOwner: "worker-a",
			status: "unknown",
		}),
	).toBe(true);
	expect(
		await store.settle({
			commandId,
			attemptId: "attempt-b",
			attemptOwner: "worker-b",
			status: "completed",
		}),
	).toBe(false);
	expect(await store.listPending(10, ["execution-a"])).toHaveLength(0);
});
it("rolls back every fact when audit persistence fails", async () => {
	await client.unsafe(
		"create function platform.fail_installation_audit() returns trigger as $$ begin if NEW.action like 'connection.installation.%' then raise exception 'private-sentinel'; end if; return NEW; end; $$ language plpgsql",
	);
	await client.unsafe(
		"create trigger fail_installation_audit before insert on platform.audit_events for each row execute function platform.fail_installation_audit()",
	);
	try {
		await expect(
			createConnectionInstallationAuthorizationV1({ store }).execute({
				...request,
				command: "begin",
				executionId: "execution-a",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		const rows =
			await client`select count(*)::int as count from platform.connection_installation_authorizations`;
		expect(rows[0]?.count).toBe(0);
	} finally {
		await client.unsafe(
			"drop trigger fail_installation_audit on platform.audit_events",
		);
		await client.unsafe("drop function platform.fail_installation_audit()");
	}
});
