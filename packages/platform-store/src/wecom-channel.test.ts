import {
	createWecomChannelV1,
	type WecomMessageV1,
	wecomChannelIdV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PostgresPlatformAuditQueryV1 } from "./audit.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import { PostgresWecomChannelV1 } from "./wecom-channel.ts";

let db: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresWecomChannelV1;
const message: WecomMessageV1 = {
	providerId: "provider-1",
	agentId: "wecom_agent",
	bindingReference: "wecom_binding",
	kind: "wecom_bot",
	senderId: "sender_a",
	peerId: "group_a",
	conversationType: "group",
	threadId: null,
	eventId: "event_a",
	text: "fixture text",
	replyHandle: "protected_fixture",
	replyExpiresAt: "2099-01-01T00:00:00Z",
};
const configuration = {
	schemaVersion: 1,
	agentId: message.agentId,
	revision: 1,
	source: {
		kind: "standard",
		templateId: "codex",
		imageDigest: `sha256:${"a".repeat(64)}`,
		admissionRevision: "admitted",
		allowedEnvironmentKeys: [],
		allowedSecretKeys: [],
		platformManagedKeys: [],
		connectionEnabled: false,
	},
	modelConfiguration: {
		catalogRevision: "catalog_1",
		options: [
			{
				optionId: "model_1",
				endpointId: "endpoint_1",
				modelId: "model_1",
				reasoningLevels: ["low"],
				credential: { secretId: "fixture_secret", version: 1, isSet: true },
			},
		],
		defaultOptionId: "model_1",
		defaultReasoningLevel: "low",
	},
	actions: [],
	actionSetRevision: "actions_1",
	environment: [],
	secrets: [],
	channels: [
		{ kind: message.kind, bindingReference: message.bindingReference },
	],
	channelRevision: "channels_1",
};
function channel(target = store) {
	return createWecomChannelV1({
		store: target,
		authorization: {
			async authorize(scope) {
				return {
					outcome: "allowed",
					authority: {
						managementRevision: 1,
						channelRevision: "channels_1",
						actor: {
							schemaVersion: 1,
							actorId: scope.senderId,
							agentId: scope.agentId,
							channelId: wecomChannelIdV1(scope),
							authorizationRevision: "authorization_1",
							supportsSupplementaryInstruction: false,
							taskBoundary: {
								schemaVersion: 1,
								principal: { kind: "user", id: scope.senderId },
								agentId: scope.agentId,
								channelId: wecomChannelIdV1(scope),
								identityRevision: "identity-1",
								agentAuthorizationRevision: "authorization_1",
								accessSources: [{ kind: "user", userId: scope.senderId }],
							},
						},
					},
				};
			},
		},
	});
}
beforeAll(async () => {
	db = await startPostgresTestDatabase("wecom-channel");
	await migratePlatformDatabase(db);
	sql = postgres(db.databaseUrl);
	store = new PostgresWecomChannelV1(db);
	await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values (${message.agentId},1,'authorization_1')`;
	await sql`insert into platform.agent_applications (id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values ('app_1',${message.agentId},'owner_1','Fixture','Fixture','available','trace_1','request_1',now(),1,1,'ready','running',1,1)`;
	await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,configuration,created_at) values (${message.agentId},1,'fixture',${sql.json(configuration)},now())`;
}, 120_000);
afterAll(async () => {
	await store?.close();
	await sql?.end();
	await db?.stop();
});
it("commits one receipt with one execution under concurrent callbacks and replays after restart", async () => {
	const first = await Promise.all([
		channel().receive(message),
		channel().receive(message),
	]);
	expect(first.map((r) => r.outcome).sort()).toEqual(["accepted", "replayed"]);
	const accepted = first[0];
	if (
		!accepted ||
		(accepted.outcome !== "accepted" && accepted.outcome !== "replayed")
	)
		throw new Error("Expected receipt");
	const restarted = new PostgresWecomChannelV1(db);
	try {
		expect(await channel(restarted).receive(message)).toEqual({
			...accepted,
			outcome: "replayed",
		});
	} finally {
		await restarted.close();
	}
	expect(await channel().receive({ ...message, text: "changed" })).toEqual({
		outcome: "conflict",
	});
	const rows =
		await sql`select * from platform.conversation_executions where conversation_id=${accepted.receipt.conversationId}`;
	expect(rows).toHaveLength(1);
	expect(rows[0]?.model_option_id).toBe("model_1");
	const records =
		await sql`select boundary from platform.task_authorization_records where execution_id=${accepted.receipt.executionId}`;
	expect(records).toHaveLength(1);
	expect(records[0]?.boundary).toMatchObject({
		principal: { kind: "user", id: message.senderId },
		channelId: wecomChannelIdV1(message),
	});
});
it("rolls back conversation, execution and Runtime outbox when receipt insertion fails", async () => {
	await sql`create function platform.reject_wecom_receipt() returns trigger language plpgsql as $$begin raise exception 'Injected receipt failure';end$$`;
	await sql`create trigger reject_wecom_receipt before insert on platform.wecom_receipts for each row execute function platform.reject_wecom_receipt()`;
	try {
		await expect(
			channel().receive({
				...message,
				senderId: "rollback_sender",
				eventId: "rollback_event",
			}),
		).rejects.toThrow();
	} finally {
		await sql`drop trigger reject_wecom_receipt on platform.wecom_receipts`;
		await sql`drop function platform.reject_wecom_receipt()`;
	}
	const rows =
		await sql`select id from platform.conversations where actor_id='rollback_sender'`;
	expect(rows).toHaveLength(0);
	const executions =
		await sql`select execution_id from platform.conversation_executions where actor_id='rollback_sender'`;
	expect(executions).toHaveLength(0);
});
it("does not resend a reply after a worker crashes in the external send window", async () => {
	const accepted = await channel().receive({
		...message,
		senderId: "sender_crash",
		eventId: "event_crash",
	});
	if (accepted.outcome !== "accepted") throw new Error("Expected receipt");
	await sql`update platform.conversation_executions set status='completed' where execution_id=${accepted.receipt.executionId}`;
	const claim = await store.claim();
	expect(claim?.receiptId).toBe(accepted.receipt.receiptId);
	if (!claim) throw new Error("Expected claim");
	expect(
		await store.prepare(claim, {
			managementRevision: 1,
			channelRevision: "channels_1",
			actor: {
				schemaVersion: 1,
				agentId: message.agentId,
				actorId: "sender_crash",
				taskBoundary: claim.taskBoundary,
				channelId: wecomChannelIdV1(message),
				authorizationRevision: "authorization_1",
				supportsSupplementaryInstruction: false,
			},
		}),
	).toBe(true);
	await sql`update platform.wecom_receipts set lease_until=now()-interval '1 second' where id=${claim.receiptId}`;
	const restarted = new PostgresWecomChannelV1(db);
	try {
		expect(await restarted.claim()).toBeNull();
		expect(await restarted.read(claim.receiptId, "sender_crash")).toMatchObject(
			{ deliveryStatus: "unknown" },
		);
		expect(await restarted.read(claim.receiptId, "sender_other")).toBeNull();
		expect(await restarted.abandon(claim.receiptId, "sender_other")).toBe(
			false,
		);
		expect(await restarted.abandon(claim.receiptId, "sender_crash")).toBe(true);
	} finally {
		await restarted.close();
	}
});
it("rejects a stale binding or management snapshot before creating a new sender conversation", async () => {
	await sql`update platform.agent_applications set management_revision=2 where agent_id=${message.agentId}`;
	try {
		expect(
			await channel().receive({
				...message,
				senderId: "stale_sender",
				eventId: "stale_event",
			}),
		).toEqual({ outcome: "denied" });
		expect(
			await sql`select id from platform.conversations where actor_id='stale_sender'`,
		).toHaveLength(0);
	} finally {
		await sql`update platform.agent_applications set management_revision=1 where agent_id=${message.agentId}`;
	}
});

it("uses current Owner defaults for the next WeCom Turn even while the previous option remains allowed", async () => {
	const first = await channel().receive({
		...message,
		senderId: "default_sender",
		eventId: "default_first",
	});
	if (first.outcome !== "accepted") throw new Error("Expected receipt");
	await sql`update platform.conversation_executions set status='completed' where execution_id=${first.receipt.executionId}`;
	const next = {
		...configuration,
		revision: 2,
		modelConfiguration: {
			...configuration.modelConfiguration,
			options: [
				...configuration.modelConfiguration.options,
				{
					...configuration.modelConfiguration.options[0],
					optionId: "model_2",
					reasoningLevels: ["high"],
				},
			],
			defaultOptionId: "model_2",
			defaultReasoningLevel: "high",
		},
	};
	await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,configuration,created_at) values (${message.agentId},2,'fixture',${sql.json(next)},now())`;
	await sql`update platform.agents set current_configuration_revision=2 where id=${message.agentId}`;
	try {
		const second = await channel().receive({
			...message,
			senderId: "default_sender",
			eventId: "default_second",
		});
		if (second.outcome !== "accepted")
			throw new Error("Expected second receipt");
		expect(second.receipt.conversationId).toBe(first.receipt.conversationId);
		const [execution] =
			await sql`select model_option_id,reasoning_level from platform.conversation_executions where execution_id=${second.receipt.executionId}`;
		expect(execution).toMatchObject({
			model_option_id: "model_2",
			reasoning_level: "high",
		});
	} finally {
		await sql`update platform.agents set current_configuration_revision=1 where id=${message.agentId}`;
	}
});

it("retains trusted rejection audit metadata without a business receipt or message", async () => {
	await store.reject("audit-rejected", "denied", {
		agentId: message.agentId,
		actorId: "known-user",
	});
	const [record] =
		await sql`select actor_type,actor_id,agent_id,request_id,details from platform.audit_events where action='wecom.denied' and request_id='audit-rejected'`;
	expect(record).toMatchObject({
		actor_type: "system",
		actor_id: "platform-api",
		agent_id: message.agentId,
		request_id: "audit-rejected",
		details: {
			component: "platform-api",
			originalPrincipal: { kind: "user", id: "known-user" },
		},
	});
	expect(
		await sql`select id from platform.wecom_receipts where id='audit-rejected'`,
	).toHaveLength(0);
	expect(JSON.stringify(record)).not.toContain(message.text);
	await store.reject("audit-unknown", "denied", { agentId: message.agentId });
	const query = new PostgresPlatformAuditQueryV1(db);
	try {
		const page = await query.listAudit(
			{ schemaVersion: 1, kind: "administrator", administratorId: "admin" },
			{ schemaVersion: 1, limit: 2 },
		);
		expect(page.items).toHaveLength(2);
		expect(page.items.every((i) => i.action === "wecom.denied")).toBe(true);
	} finally {
		await query.close();
	}
	expect(
		await sql`select actor_type,actor_id from platform.audit_events where request_id='audit-unknown'`,
	).toEqual([{ actor_type: "system", actor_id: "platform-api" }]);
});

it("fences WebSocket ingress inside the transaction and reserves replies for the connection owner", async () => {
	await sql`update platform.wecom_receipts set delivery_status='abandoned'`;
	await sql`insert into platform.wecom_connections (bot_id,agent_id,binding_reference,holder_id,fence,lease_until,status) values (${message.providerId},${message.agentId},${message.bindingReference},'worker-one',1,now()+interval '30 seconds','connected')`;
	const owner = new PostgresWecomChannelV1({
		...db,
		connectionHolderId: "worker-one",
	});
	const other = new PostgresWecomChannelV1({
		...db,
		connectionHolderId: "worker-two",
	});
	try {
		const fence = {
			botId: message.providerId,
			holderId: "worker-one",
			fence: 1,
		};
		const event = {
			...message,
			eventId: "websocket-event",
			senderId: "websocket-sender",
		};
		expect(await channel(owner).receive(event, { ...fence, fence: 2 })).toEqual(
			{ outcome: "unavailable" },
		);
		const accepted = await channel(owner).receive(event, fence);
		if (accepted.outcome !== "accepted")
			throw new Error("Expected WebSocket acceptance");
		await sql`update platform.conversation_executions set status='completed' where execution_id=${accepted.receipt.executionId}`;
		expect(await other.claim()).toBeNull();
		await sql`update platform.wecom_connections set fence=2,holder_id='worker-two' where bot_id=${message.providerId}`;
		const freshFence = { ...fence, holderId: "worker-two", fence: 2 };
		expect(
			await channel(other).receive(
				{ ...event, replyHandle: "fresh-route" },
				freshFence,
			),
		).toMatchObject({ outcome: "replayed", receipt: accepted.receipt });
		expect(await owner.claim()).toBeNull();
		const claim = await other.claim();
		expect(claim?.receiptId).toBe(accepted.receipt.receiptId);
		expect(claim?.replyHandle).toBe("fresh-route");
		for (const status of ["claimed", "sending", "unknown", "sent"]) {
			await sql`update platform.wecom_receipts set delivery_status=${status} where id=${accepted.receipt.receiptId}`;
			expect(
				await channel(other).receive(
					{ ...event, replyHandle: "must-not-replace" },
					freshFence,
				),
			).toMatchObject({ outcome: "replayed" });
			const [row] =
				await sql`select reply_handle,delivery_status from platform.wecom_receipts where id=${accepted.receipt.receiptId}`;
			expect(row).toMatchObject({
				reply_handle: "fresh-route",
				delivery_status: status,
			});
		}
		expect(
			await channel(owner).receive(
				{ ...event, eventId: "old-owner-event" },
				fence,
			),
		).toEqual({ outcome: "unavailable" });
		expect(
			await sql`select id from platform.wecom_receipts where connection_bot_id=${message.providerId}`,
		).toHaveLength(1);
	} finally {
		await owner.close();
		await other.close();
	}
});

it("seals a pending connection receipt as unknown after its connection lease expires", async () => {
	await sql`update platform.wecom_receipts set delivery_status='abandoned'`;
	await sql`insert into platform.wecom_connections (bot_id,agent_id,binding_reference,holder_id,fence,lease_until,status)
    values (${message.providerId},${message.agentId},${message.bindingReference},'worker-stale',10,now()+interval '30 seconds','connected')
    on conflict (bot_id) do update set agent_id=excluded.agent_id,binding_reference=excluded.binding_reference,holder_id=excluded.holder_id,fence=excluded.fence,lease_until=excluded.lease_until,status=excluded.status`;
	const owner = new PostgresWecomChannelV1({
		...db,
		connectionHolderId: "worker-stale",
	});
	try {
		const accepted = await channel(owner).receive(
			{
				...message,
				eventId: "stale-connection-event",
				senderId: "stale-connection-sender",
			},
			{ botId: message.providerId, holderId: "worker-stale", fence: 10 },
		);
		if (accepted.outcome !== "accepted")
			throw new Error("Expected WebSocket acceptance");
		await sql`update platform.conversation_executions set status='completed' where execution_id=${accepted.receipt.executionId}`;
		await sql`update platform.wecom_connections set lease_until=now()-interval '1 second' where bot_id=${message.providerId}`;
		expect(await owner.claim()).toBeNull();
		expect(
			await owner.read(accepted.receipt.receiptId, "stale-connection-sender"),
		).toMatchObject({ deliveryStatus: "unknown" });
	} finally {
		await owner.close();
	}
});
