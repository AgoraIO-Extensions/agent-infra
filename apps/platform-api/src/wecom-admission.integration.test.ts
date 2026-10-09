import { createHash, generateKeyPairSync } from "node:crypto";
import type {
	CurrentTaskUserV1,
	WecomIdentityPortV1,
} from "@agent-infra/platform-core";
import { migratePlatformDatabase } from "@agent-infra/platform-store";
import type { WecomConfigurationV1 } from "@agent-infra/wecom";
import { wecomCallbackFixtureV1 } from "@agent-infra/wecom/testing";
import { createWecomReplyDecryptorV1 } from "@agent-infra/wecom/worker";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../../packages/platform-core/src/agent-configuration.conformance.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { createPlatformHealthApp } from "./app.js";
import { registerWecomRoutesV1 } from "./http/wecom-routes.js";
import { assembleWecomApiV1 } from "./wecom-assembly.js";

// Signed provider envelopes and directory responses are controlled inputs. Hono,
// API assembly, Core, production migrations/Store and Conversation adapter are real.
let db: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let publicKey: string;
let revealReply: ReturnType<typeof createWecomReplyDecryptorV1>;
let sequence = 0;
const cleanups: (() => Promise<void>)[] = [];
function user(userId: string): CurrentTaskUserV1 {
	return {
		schemaVersion: 1,
		userId,
		accountStatus: "active",
		organizationIds: ["controlled-org"],
		authorizationRevision: "controlled-identity-1",
	};
}
function gate() {
	return Promise.withResolvers<void>();
}
async function waiter(query: () => Promise<readonly unknown[]>) {
	await expect
		.poll(async () => (await query()).length, { timeout: 4_000 })
		.toBeGreaterThan(0);
}
async function fixture(userId = `http-user-${++sequence}`) {
	const suffix = ++sequence;
	const peerId = `http-peer-${suffix}`;
	const config: WecomConfigurationV1 = {
		agentId: `http-agent-${suffix}`,
		bindingReference: `http-binding-${suffix}`,
		kind: "wecom_bot",
		botId: `http-bot-${suffix}`,
		token: "controlled-callback-token",
		encodingAesKey: Buffer.alloc(32, 7).toString("base64").slice(0, 43),
		credentialVersion: "controlled-v1",
	};
	const configuration = {
		schemaVersion: 1,
		agentId: config.agentId,
		revision: 1,
		source: {
			kind: "standard",
			templateId: "codex",
			imageDigest: `sha256:${"a".repeat(64)}`,
			admissionRevision: "controlled",
			allowedEnvironmentKeys: [],
			allowedSecretKeys: [],
			platformManagedKeys: [],
			connectionEnabled: false,
		},
		modelConfiguration: structuredClone(
			agentConfigurationConformanceRecordV1.modelConfiguration,
		),
		actions: [],
		actionSetRevision: "controlled-actions-1",
		environment: [],
		secrets: [],
		channels: [
			{ kind: config.kind, bindingReference: config.bindingReference },
		],
		channelRevision: "controlled-channels-1",
	};
	await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values (${config.agentId},1,'controlled-authorization-1')`;
	await sql`insert into platform.agent_applications (id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values (${`${config.agentId}-application`},${config.agentId},'controlled-owner','Controlled','Controlled','available','controlled-trace','controlled-request',now(),1,1,'ready','running',1,1)`;
	await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) values (${config.agentId},'controlled-owner',now())`;
	await sql`insert into platform.agent_availability (agent_id,target_type,target_id) values (${config.agentId},'organization','controlled-org')`;
	await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,configuration,created_at) values (${config.agentId},1,'controlled',${sql.json(configuration as unknown as postgres.JSONValue)},now())`;
	await sql`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version) values('personal',${userId},1,1) on conflict do nothing`;
	await sql`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext) values('personal',${userId},1,${`controlled-key-${suffix}`},${sql.json({ schemaVersion: 1, purpose: "personal", subjectId: userId, keyId: `controlled-key-${suffix}`, keyVersion: 1 })}) on conflict do nothing`;
	const identity: WecomIdentityPortV1 = {
		resolveSender: async (scope) => user(scope.senderId),
		activeUsers: async (ids) => ids,
	};
	let currentIdentity: WecomIdentityPortV1["resolveSender"] =
		identity.resolveSender;
	identity.resolveSender = (scope) => currentIdentity(scope);
	const outcomes: string[] = [];
	const assembly = assembleWecomApiV1(db.databaseUrl, {
		identity,
		userDirectory: { resolveUser: async (id) => user(id) },
		resolveBinding: async (reference) =>
			reference === config.bindingReference ? config : null,
		replyEncryptionPublicKeyPem: publicKey,
		observe: (outcome) => outcomes.push(outcome),
	});
	cleanups.push(assembly.close);
	const app = createPlatformHealthApp();
	registerWecomRoutesV1(app, assembly.dependencies);
	const eventId = `http-event-${suffix}`;
	function request(signal?: AbortSignal) {
		const signed = wecomCallbackFixtureV1(
			config,
			{
				msgid: eventId,
				aibotid: config.botId,
				chattype: "group",
				chatid: peerId,
				from: { userid: userId },
				msgtype: "text",
				text: { content: "controlled admission input" },
				response_url:
					"https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=controlled",
			},
			new Date(),
		);
		return signal ? new Request(signed, { signal }) : signed;
	}
	return {
		conversationKey: createHash("sha256")
			.update(
				JSON.stringify([
					config.agentId,
					config.kind,
					config.bindingReference,
					"group",
					peerId,
					null,
					userId,
					userId,
				]),
			)
			.digest("hex"),
		config,
		peerId,
		userId,
		eventId,
		outcomes,
		setIdentity: (resolveSender: WecomIdentityPortV1["resolveSender"]) => {
			currentIdentity = resolveSender;
		},
		app,
		request,
		eventKey: createHash("sha256")
			.update(JSON.stringify([config.kind, config.botId, eventId]))
			.digest("hex"),
	};
}
async function facts(agentId: string) {
	return sql.begin("isolation level repeatable read read only", async (tx) => ({
		receipts:
			await tx`select to_jsonb(r)-'reply_handle'-'expires_at'-'updated_at' as fact from platform.wecom_receipts r where r.scope->>'agentId'=${agentId} order by r.id`,
		conversations:
			await tx`select to_jsonb(c) as fact from platform.conversations c where c.agent_id=${agentId} order by c.id`,
		messages:
			await tx`select to_jsonb(m) as fact from platform.conversation_messages m join platform.conversations c on c.id=m.conversation_id where c.agent_id=${agentId} order by m.message_id`,
		executions:
			await tx`select to_jsonb(e) as fact from platform.conversation_executions e where e.agent_id=${agentId} order by e.execution_id`,
		authority:
			await tx`select to_jsonb(a) as fact from platform.task_authorization_records a join platform.conversation_executions e on e.execution_id=a.execution_id where e.agent_id=${agentId} order by a.id`,
		outbox:
			await tx`select to_jsonb(o) as fact from platform.outbox_items o join platform.conversation_executions e on e.execution_id=o.payload->>'executionId' where e.agent_id=${agentId} and o.operation<>'conversation.turn.stop.v1' order by o.id`,
		conversationAudit:
			await tx`select to_jsonb(a) as fact from platform.conversation_audit_events a where a.agent_id=${agentId} order by a.id`,
		idempotency:
			await tx`select to_jsonb(i) as fact from platform.idempotency_records i join platform.conversations c on (i.scope_type='agent' and i.command_type='conversation.create' and c.id=i.result->>'conversationId') or (i.scope_type='conversation' and i.command_type='message' and c.id=i.scope_id) where c.agent_id=${agentId} and i.actor_id=c.actor_id order by i.id`,
		audit:
			await tx`select to_jsonb(a) as fact from platform.audit_events a where a.agent_id=${agentId} and a.action='wecom.accepted' order by a.id`,
	}));
}
async function noFacts(input: {
	config: { agentId: string };
	eventKey: string;
	conversationKey: string;
}) {
	for (const rows of Object.values(await facts(input.config.agentId)))
		expect(rows).toEqual([]);
	// Query intent/idempotency by the original keys as well, so missing parent rows
	// cannot hide a late reservation or orphan outbox write after rollback.
	expect(
		await sql`select id from platform.idempotency_records where idempotency_key in ${sql([input.eventKey, input.conversationKey])}`,
	).toEqual([]);
	expect(
		await sql`select id from platform.outbox_items where operation <> 'conversation.turn.stop.v1' and (trace_id=${input.eventKey} or request_id=${input.eventKey})`,
	).toEqual([]);
}
async function releasedLocks(
	agentId: string,
	eventKey: string,
	blockerId: number,
) {
	await sql.begin(async (tx) => {
		// The independent blocker stays held while the original business locks are free.
		expect(
			await tx`select pg_try_advisory_xact_lock(${blockerId}) as acquired`,
		).toEqual([{ acquired: false }]);
		expect(
			await tx`select pg_try_advisory_xact_lock(hashtextextended(${eventKey},0)) as acquired`,
		).toEqual([{ acquired: true }]);
		expect(
			await tx`select id from platform.agents where id=${agentId} for update nowait`,
		).toHaveLength(1);
		expect(
			await tx`select id from platform.agent_applications where agent_id=${agentId} for update nowait`,
		).toHaveLength(1);
		await tx`lock table platform.conversation_messages in access exclusive mode nowait`;
	});
}
beforeAll(async () => {
	db = await startPostgresTestDatabase("wecom-http-cancellation");
	await migratePlatformDatabase(db);
	sql = postgres(db.databaseUrl, { max: 5 });
	const pair = generateKeyPairSync("rsa", {
		modulusLength: 3072,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	publicKey = pair.publicKey;
	revealReply = createWecomReplyDecryptorV1(pair.privateKey);
}, 120_000);
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
afterAll(async () => {
	await sql?.end();
	await db?.stop();
});

describe("signed Hono callback through the original WeCom acceptance transaction", () => {
	it("rejects a missing personal Key without accepting callback facts", async () => {
		const f = await fixture();
		await sql`update platform.relay_key_subjects set current_version=null where purpose='personal' and subject_id=${f.userId}`;
		expect((await f.app.request(f.request())).status).toBe(503);
		await noFacts(f);
	});
	it("rolls back this admission and commits controls for the original user's prior task when disabled before commit", async () => {
		const prior = await fixture();
		expect((await prior.app.request(prior.request())).status).toBe(200);
		const f = await fixture(prior.userId);
		let calls = 0;
		f.setIdentity(async (scope) => {
			calls += 1;
			return calls <= 2
				? user(scope.senderId)
				: { ...user(scope.senderId), accountStatus: "disabled" };
		});
		expect((await f.app.request(f.request())).status).toBe(200);
		expect(f.outcomes).toEqual(["denied"]);
		await noFacts(f);
		expect(
			await sql`select reason from platform.task_control_records c join platform.conversation_executions e on e.execution_id=c.execution_id where e.actor_id=${f.userId}`,
		).toEqual([{ reason: "authorization_revoked" }]);
		expect(
			await sql`select revoked_at is not null as revoked from platform.task_authorization_records a join platform.conversation_executions e on e.execution_id=a.execution_id where e.actor_id=${f.userId}`,
		).toEqual([{ revoked: true }]);
	});
	it("does not fan out controls when a disabled identity has a changed revision", async () => {
		const prior = await fixture();
		expect((await prior.app.request(prior.request())).status).toBe(200);
		const f = await fixture(prior.userId);
		let calls = 0;
		f.setIdentity(async (scope) =>
			++calls <= 2
				? user(scope.senderId)
				: {
						...user(scope.senderId),
						accountStatus: "disabled",
						authorizationRevision: "changed-identity",
					},
		);
		expect((await f.app.request(f.request())).status).toBe(503);
		await noFacts(f);
		expect(
			await sql`select id from platform.task_control_records c join platform.conversation_executions e on e.execution_id=c.execution_id where e.actor_id=${f.userId}`,
		).toEqual([]);
	});
	it("uses the Platform disable override at admission", async () => {
		const prior = await fixture();
		expect((await prior.app.request(prior.request())).status).toBe(200);
		const f = await fixture(prior.userId);
		await sql`insert into platform.platform_user_disables (user_id) values (${f.userId})`;
		expect((await f.app.request(f.request())).status).toBe(200);
		expect(f.outcomes).toEqual(["denied"]);
		await noFacts(f);
		expect(
			await sql`select reason from platform.task_control_records c join platform.conversation_executions e on e.execution_id=c.execution_id where e.actor_id=${f.userId} and e.principal_type='user'`,
		).toEqual([{ reason: "authorization_revoked" }]);
	});
	it("commits receipt and every acceptance fact in one transaction and replays the immutable acceptance snapshot", async () => {
		const f = await fixture();
		expect((await f.app.request(f.request())).status).toBe(200);
		expect(f.outcomes).toEqual(["accepted"]);
		const [receipt] = await sql<
			{ reply_handle: string }[]
		>`select reply_handle from platform.wecom_receipts where id=${f.eventKey}`;
		if (!receipt) throw new Error("Expected accepted receipt");
		expect(await revealReply(receipt.reply_handle)).toMatchObject({
			bindingReference: f.config.bindingReference,
			credentialVersion: f.config.credentialVersion,
			responseUrl:
				"https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=controlled",
			scope: {
				agentId: f.config.agentId,
				bindingReference: f.config.bindingReference,
				kind: f.config.kind,
				senderId: f.userId,
				peerId: f.peerId,
				conversationType: "group",
				threadId: null,
			},
		});
		const saved = await facts(f.config.agentId);
		for (const [kind, rows] of Object.entries(saved))
			expect(rows).toHaveLength(
				kind === "idempotency" || kind === "conversationAudit" ? 2 : 1,
			);
		expect(
			await sql`select action from platform.conversation_audit_events where agent_id=${f.config.agentId} order by action`,
		).toEqual([
			{ action: "conversation.message.accepted" },
			{ action: "conversation.sandbox.allocated" },
		]);
		const versions = await sql<{ kind: string; transaction: string }[]>`
			select 'receipt' as kind,r.xmin::text as transaction from platform.wecom_receipts r where r.id=${f.eventKey}
			union all select 'conversation',c.xmin::text from platform.conversations c where c.agent_id=${f.config.agentId}
			union all select 'message',m.xmin::text from platform.conversation_messages m join platform.conversations c on c.id=m.conversation_id where c.agent_id=${f.config.agentId}
			union all select 'execution',e.xmin::text from platform.conversation_executions e where e.agent_id=${f.config.agentId}
			union all select 'authority',a.xmin::text from platform.task_authorization_records a join platform.conversation_executions e on e.execution_id=a.execution_id where e.agent_id=${f.config.agentId}
			union all select 'outbox',o.xmin::text from platform.outbox_items o join platform.conversation_executions e on e.execution_id=o.payload->>'executionId' where e.agent_id=${f.config.agentId}
			union all select 'conversation-audit',a.xmin::text from platform.conversation_audit_events a where a.agent_id=${f.config.agentId}
			union all select 'idempotency',i.xmin::text from platform.idempotency_records i join platform.conversations c on (i.scope_type='agent' and i.command_type='conversation.create' and c.id=i.result->>'conversationId') or (i.scope_type='conversation' and i.command_type='message' and c.id=i.scope_id) where c.agent_id=${f.config.agentId} and i.actor_id=c.actor_id
			union all select 'audit',a.xmin::text from platform.audit_events a where a.agent_id=${f.config.agentId} and a.action='wecom.accepted'`;
		expect(versions.map((v) => v.kind).sort()).toEqual([
			"audit",
			"authority",
			"conversation",
			"conversation-audit",
			"conversation-audit",
			"execution",
			"idempotency",
			"idempotency",
			"message",
			"outbox",
			"receipt",
		]);
		expect(new Set(versions.map((v) => v.transaction)).size).toBe(1);
		expect((await f.app.request(f.request())).status).toBe(200);
		expect(f.outcomes).toEqual(["accepted", "replayed"]);
		expect(await facts(f.config.agentId)).toEqual(saved);
	});

	it("cancels the actual Conversation insert PendingQuery, awaits rollback and releases locks while the independent blocker remains", async () => {
		const f = await fixture();
		const entered = gate();
		const held = gate();
		const lockId = 11165041;
		const blocker = sql.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(${lockId})`;
			entered.resolve();
			await held.promise;
		});
		const controller = new AbortController();
		let pending: Promise<Response> | undefined;
		try {
			await entered.promise;
			await sql`create function platform.controlled_http_admission_wait() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(11165041); return new; end $$`;
			await sql`create trigger controlled_http_admission_wait before insert on platform.conversation_messages for each row execute function platform.controlled_http_admission_wait()`;
			const requestStartedAt = Date.now();
			pending = Promise.resolve(f.app.request(f.request(controller.signal)));
			await waiter(
				() =>
					sql`select a.pid from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.query like '%insert into platform.conversation_messages%' and l.locktype='advisory' and not l.granted`,
			);
			controller.abort();
			await pending;
			expect(f.outcomes).toEqual(["unavailable"]);
			expect(Date.now() - requestStartedAt).toBeLessThan(3_000);
			await releasedLocks(f.config.agentId, f.eventKey, lockId);
			await noFacts(f);
			// Rollback is complete before the blocker is released, and no late insert survives.
			held.resolve();
			await blocker;
			await new Promise<void>((resolve) => setImmediate(resolve));
			await noFacts(f);
		} finally {
			controller.abort();
			held.resolve();
			await Promise.allSettled([pending, blocker]);
			await sql`drop trigger if exists controlled_http_admission_wait on platform.conversation_messages`;
			await sql`drop function if exists platform.controlled_http_admission_wait()`;
		}
		expect((await f.app.request(f.request())).status).toBe(200);
		expect(f.outcomes).toEqual(["unavailable", "accepted"]);
	}, 30_000);
});
