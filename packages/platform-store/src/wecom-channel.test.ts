import { createConnection, createServer, type Socket } from "node:net";
import {
	createWecomAuthorizationV1,
	createWecomChannelV1,
	type WecomChannelStorePortV1,
	type WecomConnectionFenceV1,
	type WecomIdentityPortV1,
	type WecomMessageV1,
	wecomChannelIdV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const fixtureUserDirectory = {
	resolveUser: async (userId: string) => ({
		schemaVersion: 1 as const,
		userId,
		accountStatus: "active" as const,
		organizationIds: ["controlled-org"],
		authorizationRevision: "identity-1",
	}),
};

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
	const base = createWecomChannelV1({
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
	return {
		...base,
		async receive(
			input: WecomMessageV1,
			connectionFence?: WecomConnectionFenceV1,
			signal?: AbortSignal,
		) {
			const keyId = `fixture-key:personal:${input.senderId}`;
			await sql`insert into platform.relay_key_subjects
				(purpose, subject_id, last_version, current_version)
				values ('personal', ${input.senderId}, 1, 1)
				on conflict (purpose, subject_id) do nothing`;
			await sql`insert into platform.relay_key_versions
				(purpose, subject_id, key_version, key_id, ciphertext)
				values ('personal', ${input.senderId}, 1, ${keyId},
					${sql.json({ purpose: "personal", subjectId: input.senderId, keyId, keyVersion: 1 })})
				on conflict (purpose, subject_id, key_version) do nothing`;
			return base.receive(input, connectionFence, signal);
		},
	};
}
beforeAll(async () => {
	db = await startPostgresTestDatabase("wecom-channel");
	await migratePlatformDatabase(db);
	sql = postgres(db.databaseUrl);
	store = new PostgresWecomChannelV1({
		...db,
		userDirectory: fixtureUserDirectory,
	});
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
	const restarted = new PostgresWecomChannelV1({
		...db,
		userDirectory: fixtureUserDirectory,
	});
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
it("rejects an explicitly disabled binding before creating an execution", async () => {
	const disabled = {
		...configuration,
		channels: [
			{
				kind: message.kind,
				bindingReference: message.bindingReference,
				enabled: false,
			},
		],
	};
	await sql`update platform.agent_configuration_revisions set configuration=${sql.json(disabled)} where agent_id=${message.agentId} and revision=1`;
	try {
		const attempted = {
			...message,
			senderId: "disabled_sender",
			eventId: "disabled_event",
		};
		expect(await channel().receive(attempted)).toEqual({ outcome: "denied" });
		expect(
			await sql`select 1 from platform.wecom_receipts where scope->>'senderId'='disabled_sender'`,
		).toHaveLength(0);
	} finally {
		await sql`update platform.agent_configuration_revisions set configuration=${sql.json(configuration)} where agent_id=${message.agentId} and revision=1`;
	}
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
	const [botLease] = await sql<
		{ seconds: string }[]
	>`select extract(epoch from lease_until - clock_timestamp()) as seconds from platform.wecom_receipts where id=${claim.receiptId}`;
	expect(Number(botLease?.seconds)).toBeGreaterThan(0);
	expect(Number(botLease?.seconds)).toBeLessThan(30);
	await sql`update platform.wecom_receipts set lease_until=now()-interval '1 second' where id=${claim.receiptId}`;
	const restarted = new PostgresWecomChannelV1({
		...db,
		userDirectory: fixtureUserDirectory,
	});
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
it("keeps an application reply sending through the bounded multipart window", async () => {
	await sql`update platform.agent_configuration_revisions set configuration=${sql.json(
		{
			...configuration,
			channels: [
				...configuration.channels,
				{ kind: "wecom_app", bindingReference: message.bindingReference },
			],
		},
	)} where agent_id=${message.agentId} and revision=1`;
	try {
		const appMessage: WecomMessageV1 = {
			...message,
			kind: "wecom_app",
			providerId: '["corp-1","42"]',
			senderId: "slow_app_sender",
			peerId: "slow_app_sender",
			conversationType: "single",
			eventId: "slow_app_event",
		};
		const accepted = await channel().receive(appMessage);
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
					agentId: appMessage.agentId,
					actorId: appMessage.senderId,
					taskBoundary: claim.taskBoundary,
					channelId: wecomChannelIdV1(appMessage),
					authorizationRevision: "authorization_1",
					supportsSupplementaryInstruction: false,
				},
			}),
		).toBe(true);
		const [appLease] = await sql<
			{ seconds: string; delivery_status: string }[]
		>`select extract(epoch from lease_until - clock_timestamp()) as seconds,delivery_status from platform.wecom_receipts where id=${claim.receiptId}`;
		expect(appLease?.delivery_status).toBe("sending");
		expect(Number(appLease?.seconds)).toBeGreaterThan(150);
		expect(Number(appLease?.seconds)).toBeLessThan(180);
		await store.finish(claim, "sent");
		expect(
			await store.read(claim.receiptId, appMessage.senderId),
		).toMatchObject({ deliveryStatus: "sent" });
	} finally {
		await sql`update platform.agent_configuration_revisions set configuration=${sql.json(configuration)} where agent_id=${message.agentId} and revision=1`;
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
		userDirectory: fixtureUserDirectory,
		connectionHolderId: "worker-one",
	});
	const other = new PostgresWecomChannelV1({
		...db,
		userDirectory: fixtureUserDirectory,
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
		expect(
			await channel().receive({ ...event, replyHandle: "callback-route" }),
		).toEqual({ outcome: "conflict" });
		const [fenced] = await sql<
			{
				reply_handle: string;
				connection_bot_id: string | null;
				connection_fence: string | null;
			}[]
		>`select reply_handle,connection_bot_id,connection_fence from platform.wecom_receipts where id=${accepted.receipt.receiptId}`;
		expect(fenced).toEqual({
			reply_handle: event.replyHandle,
			connection_bot_id: message.providerId,
			connection_fence: "1",
		});
		const callbackEvent = {
			...event,
			eventId: "callback-event",
			replyHandle: "original-callback-route",
		};
		const callback = await channel().receive(callbackEvent);
		if (callback.outcome !== "accepted")
			throw new Error("Expected callback acceptance");
		expect(
			await channel(owner).receive(
				{ ...callbackEvent, replyHandle: "websocket-route" },
				fence,
			),
		).toEqual({ outcome: "conflict" });
		const [unfenced] = await sql<
			{
				reply_handle: string;
				connection_bot_id: string | null;
				connection_fence: string | null;
			}[]
		>`select reply_handle,connection_bot_id,connection_fence from platform.wecom_receipts where id=${callback.receipt.receiptId}`;
		expect(unfenced).toEqual({
			reply_handle: callbackEvent.replyHandle,
			connection_bot_id: null,
			connection_fence: null,
		});
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

it("keeps an unclaimed connection receipt pending after its connection lease expires", async () => {
	await sql`update platform.wecom_receipts set delivery_status='abandoned'`;
	await sql`insert into platform.wecom_connections (bot_id,agent_id,binding_reference,holder_id,fence,lease_until,status)
    values (${message.providerId},${message.agentId},${message.bindingReference},'worker-stale',10,now()+interval '30 seconds','connected')
    on conflict (bot_id) do update set agent_id=excluded.agent_id,binding_reference=excluded.binding_reference,holder_id=excluded.holder_id,fence=excluded.fence,lease_until=excluded.lease_until,status=excluded.status`;
	const owner = new PostgresWecomChannelV1({
		...db,
		userDirectory: fixtureUserDirectory,
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
		).toMatchObject({ deliveryStatus: "pending" });
	} finally {
		await owner.close();
	}
});

it("replays a claimed receipt after its connection lease expires before prepare", async () => {
	await sql`update platform.wecom_receipts set delivery_status='abandoned'`;
	await sql`insert into platform.wecom_connections (bot_id,agent_id,binding_reference,holder_id,fence,lease_until,status)
    values (${message.providerId},${message.agentId},${message.bindingReference},'worker-stale',20,now()+interval '30 seconds','connected')
    on conflict (bot_id) do update set agent_id=excluded.agent_id,binding_reference=excluded.binding_reference,holder_id=excluded.holder_id,fence=excluded.fence,lease_until=excluded.lease_until,status=excluded.status`;
	const owner = new PostgresWecomChannelV1({
		...db,
		userDirectory: fixtureUserDirectory,
		connectionHolderId: "worker-stale",
	});
	const replacement = new PostgresWecomChannelV1({
		...db,
		userDirectory: fixtureUserDirectory,
		connectionHolderId: "worker-fresh",
	});
	try {
		const event = {
			...message,
			eventId: "claimed-replay-event",
			senderId: "claimed-replay-sender",
		};
		const accepted = await channel(owner).receive(event, {
			botId: message.providerId,
			holderId: "worker-stale",
			fence: 20,
		});
		if (accepted.outcome !== "accepted")
			throw new Error("Expected WebSocket acceptance");
		await sql`update platform.conversation_executions set status='completed' where execution_id=${accepted.receipt.executionId}`;
		const stale = await owner.claim();
		expect(stale?.receiptId).toBe(accepted.receipt.receiptId);
		await sql`update platform.wecom_connections set lease_until=now()-interval '1 second' where bot_id=${message.providerId}`;
		expect(await owner.claim()).toBeNull();
		expect(
			await owner.read(accepted.receipt.receiptId, event.senderId),
		).toMatchObject({ deliveryStatus: "pending" });
		await sql`update platform.wecom_connections set holder_id='worker-fresh',fence=21,lease_until=now()+interval '30 seconds' where bot_id=${message.providerId}`;
		expect(await replacement.claim()).toBeNull();
		expect(
			await channel(replacement).receive(
				{ ...event, replyHandle: "fresh-reply" },
				{
					botId: message.providerId,
					holderId: "worker-fresh",
					fence: 21,
				},
			),
		).toMatchObject({ outcome: "replayed", receipt: accepted.receipt });
		const fresh = await replacement.claim();
		expect(fresh?.receiptId).toBe(accepted.receipt.receiptId);
		expect(fresh?.replyHandle).toBe("fresh-reply");
		expect(fresh?.fence).not.toBe(stale?.fence);
	} finally {
		await owner.close();
		await replacement.close();
	}
});

function cancellationGate() {
	let open = () => {};
	const waiting = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { waiting, open };
}
async function waitForCancellation(
	query: () => Promise<readonly unknown[]>,
	timeoutMs = 4_000,
) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if ((await query()).length) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Expected original PostgreSQL transaction waiter");
}

// A transparent real PostgreSQL transport gate: hold the driver's COMMIT frame,
// not a query result or clock, so cancellation first sees the original idle Tx.
async function pendingCommitTransport(
	databaseUrl: string,
	holdCancelReply = false,
) {
	const target = new URL(databaseUrl);
	const sockets = new Set<Socket>();
	const reached = cancellationGate();
	let cancelDispatched = false;
	const cancelReleases = new Set<() => void>();
	const cancelClients = new Map<Socket, Socket>();
	let armed = false;
	let release = () => {};
	const server = createServer((client) => {
		const upstream = createConnection({
			host: target.hostname.replace(/^\[|\]$/g, ""),
			port: Number(target.port || 5432),
		});
		for (const socket of [client, upstream]) {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		}
		client.on("error", () => upstream.destroy());
		upstream.on("error", () => client.destroy());
		client.on("end", () => upstream.end());
		upstream.on("end", () => client.end());
		let cancelConnection = false;
		let cancelParsed = false;
		let cancelSent = false;
		let cancelHeld: Buffer[] = [];
		const releaseCancelReply = () => {
			cancelSent = false;
			if (cancelHeld.length) client.write(Buffer.concat(cancelHeld));
			cancelHeld = [];
		};
		cancelReleases.add(releaseCancelReply);
		client.on("close", () => {
			cancelClients.delete(client);
			cancelReleases.delete(releaseCancelReply);
		});
		upstream.on("data", (chunk) => {
			if (cancelSent) cancelHeld.push(chunk);
			else client.write(chunk);
		});
		let startup = true;
		let buffer: Buffer = Buffer.alloc(0);
		let held: Buffer[] | undefined;
		client.on("data", (chunk) => {
			if (held) {
				held.push(chunk);
				return;
			}
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= (startup ? 4 : 5)) {
				const size = startup
					? buffer.readUInt32BE(0)
					: 1 + buffer.readUInt32BE(1);
				if (buffer.length < size) return;
				const frame = buffer.subarray(0, size);
				buffer = buffer.subarray(size);
				if (startup) {
					// Pass SSL negotiation too; this controlled PG uses its original plaintext startup.
					if (frame.readUInt32BE(4) === 196608) {
						startup = false;
						const fields = frame.subarray(8).toString().split("\0");
						for (let i = 0; i + 1 < fields.length; i += 2)
							if (fields[i] === "statement_timeout" && fields[i + 1] === "1000")
								cancelConnection = true;
					}
				} else {
					const payload = frame.subarray(5);
					const statement =
						frame[0] === 80 // Parse: statement-name then SQL, both NUL terminated.
							? payload.subarray(payload.indexOf(0) + 1)
							: frame[0] === 81
								? payload
								: undefined; // Simple Query.
					if (holdCancelReply && cancelConnection) {
						if (
							statement
								?.subarray(0, statement.indexOf(0))
								.toString()
								.startsWith("select pg_cancel_backend(pid)")
						)
							cancelParsed = true;
						if (cancelParsed && (frame[0] === 69 || frame[0] === 81)) {
							// Forward the actual Execute/Query; hold only its replies.
							cancelSent = true;
							cancelClients.set(client, upstream);
							cancelDispatched = true;
						}
					}
					if (
						armed &&
						statement
							?.subarray(0, statement.indexOf(0))
							.toString()
							.trim()
							.toLowerCase() === "commit"
					) {
						armed = false;
						held = [frame, buffer];
						buffer = Buffer.alloc(0);
						release = () => {
							if (!held) return;
							upstream.write(Buffer.concat(held));
							held = undefined;
						};
						reached.open();
						return;
					}
				}
				upstream.write(frame);
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing controlled transport address");
	const forwarded = new URL(databaseUrl);
	forwarded.hostname = "127.0.0.1";
	forwarded.port = String(address.port);
	return {
		databaseUrl: forwarded.toString(),
		arm: () => {
			armed = true;
		},
		pending: reached.waiting,
		cancelDispatched: () => cancelDispatched,
		releaseCancelReply: () => {
			for (const unblock of cancelReleases) unblock();
		},
		disconnectCancel: () => {
			for (const [client, upstream] of cancelClients) {
				client.destroy();
				upstream.destroy();
			}
		},
		release: () => release(),
		close: async () => {
			release();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

async function cancellationReturn(pending: Promise<unknown>) {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			pending,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() =>
						reject(
							new Error("Producer did not settle after observed cancellation"),
						),
					2_000,
				);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

describe("existing WeCom transaction cancellation", () => {
	let sequence = 0;
	const identity: WecomIdentityPortV1 = {
		resolveSender: async (scope) => ({
			schemaVersion: 1 as const,
			userId: scope.senderId,
			accountStatus: "active" as const,
			organizationIds: ["controlled-org"],
			authorizationRevision: "identity-1",
		}),
		activeUsers: async (ids: readonly string[]) => ids,
	};
	async function scope(userId: string) {
		const keyId = `fixture-key:personal:${userId}`;
		await sql`insert into platform.relay_key_subjects
			(purpose, subject_id, last_version, current_version)
			values ('personal', ${userId}, 1, 1)
			on conflict (purpose, subject_id) do nothing`;
		await sql`insert into platform.relay_key_versions
			(purpose, subject_id, key_version, key_id, ciphertext)
			values ('personal', ${userId}, 1, ${keyId},
				${sql.json({ purpose: "personal", subjectId: userId, keyId, keyVersion: 1 })})
			on conflict (purpose, subject_id, key_version) do nothing`;
		const suffix = ++sequence;
		const input = {
			...message,
			agentId: `actual-agent-${suffix}`,
			senderId: userId,
			eventId: `actual-event-${suffix}`,
			peerId: `actual-peer-${suffix}`,
		};
		await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values (${input.agentId},1,'authorization_1')`;
		await sql`insert into platform.agent_applications (id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values (${`${input.agentId}-application`},${input.agentId},'owner_1','Controlled','Controlled','available','trace','request',now(),1,1,'ready','running',1,1)`;
		await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,configuration,created_at) values (${input.agentId},1,'controlled',${sql.json({ ...configuration, agentId: input.agentId })},now())`;
		await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) values (${input.agentId},'owner_1',now())`;
		await sql`insert into platform.agent_availability (agent_id,target_type,target_id) values (${input.agentId},'organization','controlled-org')`;
		return input;
	}

	function producer(accept?: WecomChannelStorePortV1["accept"]) {
		return createWecomChannelV1({
			authorization: createWecomAuthorizationV1({ identity, state: store }),
			store: {
				reject: (...args) => store.reject(...args),
				accept: accept ?? ((...args) => store.accept(...args)),
			},
		});
	}
	type Supplied = Parameters<
		Parameters<WecomChannelStorePortV1["accept"]>[1]
	>[0];
	type Backend = {
		pid: number;
		started_at: string;
		query_started_at: string;
		query_delay_ms: number;
	};
	async function originalBackend(query: string, wait: string, observer = sql) {
		let backend: Backend | undefined;
		await waitForCancellation(async () => {
			const rows = await observer<Backend[]>`
    select pid,xact_start::text as started_at,query_start::text as query_started_at,
     extract(epoch from (query_start-xact_start))*1000 as query_delay_ms
    from pg_stat_activity where datname=current_database() and state='active'
     and query like ${query} and wait_event=${wait}`;
			expect(rows.length).toBeLessThanOrEqual(1);
			backend = rows[0];
			return rows;
		});
		if (!backend) throw new Error("Missing exact original transaction");
		return backend;
	}
	async function released(
		input: WecomMessageV1,
		key: string,
		advisory = true,
		observer = sql,
	) {
		await observer.begin(async (transaction) => {
			const [lock] = await transaction<
				{ acquired: boolean }[]
			>`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as acquired`;
			expect(lock?.acquired).toBe(advisory);
			await transaction`select id from platform.agents where id=${input.agentId} for update nowait`;
			await transaction`select id from platform.agent_applications where agent_id=${input.agentId} for update nowait`;
			// Includes locks on rolled-back invisible create/message/authority/receipt rows.
			await transaction`lock table platform.conversations,platform.conversation_messages,platform.conversation_executions,platform.task_authorization_records,platform.wecom_receipts in access exclusive mode nowait`;
		});
	}
	async function gone(backend: Backend, observer = sql) {
		expect(
			await observer`select pid from pg_stat_activity where pid=${backend.pid} and xact_start::text=${backend.started_at}`,
		).toHaveLength(0);
	}
	async function facts(input: WecomMessageV1, key: string) {
		const [row] = await sql`
   select (select count(*)::int from platform.wecom_receipts where id=${key} or scope->>'agentId'=${input.agentId}) as receipts,
    (select count(*)::int from platform.conversations where agent_id=${input.agentId}) as conversations,
    (select count(*)::int from platform.conversation_executions where agent_id=${input.agentId}) as executions,
    (select count(*)::int from platform.conversation_messages where conversation_id in (select id from platform.conversations where agent_id=${input.agentId})) as messages,
    (select count(*)::int from platform.task_authorization_records where boundary->>'agentId'=${input.agentId}) as authority,
    (select count(*)::int from platform.outbox_items where trace_id=${key} or request_id=${key}) as outbox,
    (select count(*)::int from platform.audit_events where agent_id=${input.agentId} and action='wecom.accepted') as accepted_audit,
    (select count(*)::int from platform.audit_events where agent_id=${input.agentId} and action='task.authorization.accepted') as authority_audit`;
		return row;
	}
	async function zero(input: WecomMessageV1, key: string) {
		expect(await facts(input, key)).toEqual({
			receipts: 0,
			conversations: 0,
			executions: 0,
			messages: 0,
			authority: 0,
			outbox: 0,
			accepted_audit: 0,
			authority_audit: 0,
		});
		expect(
			await sql`select id from platform.conversation_audit_events where agent_id=${input.agentId}`,
		).toHaveLength(0);
	}
	async function late(supplied: Supplied, input: WecomMessageV1, key: string) {
		await expect(
			supplied.createConversation({
				schemaVersion: 1,
				agentId: input.agentId,
				idempotencyKey: `${key}-late-create`,
				traceId: key,
				requestId: key,
			}),
		).rejects.toBeDefined();
		await expect(
			supplied.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: `${key}-rolled-back`,
				text: "controlled late input",
				idempotencyKey: `${key}-late-message`,
				traceId: key,
				requestId: key,
			}),
		).rejects.toBeDefined();
	}
	const argument = (agentId: string) =>
		sql.unsafe(`'${agentId.replaceAll("'", "''")}'`);

	it("retains actual authorization and one transaction for normal receipt/message/authority/audit and replay", async () => {
		const input = await scope("normal-cancel-scope");
		let key = "";
		const channel = producer((plan, execute, signal) => {
			key = plan.eventKey;
			return store.accept(plan, execute, signal);
		});
		expect((await channel.receive(input)).outcome).toBe("accepted");
		const rows = await sql<{ transaction_id: string }[]>`
   select xmin::text as transaction_id from platform.wecom_receipts where id=${key}
   union all select xmin::text from platform.conversations where agent_id=${input.agentId}
   union all select xmin::text from platform.conversation_messages where conversation_id in (select id from platform.conversations where agent_id=${input.agentId})
   union all select xmin::text from platform.conversation_executions where agent_id=${input.agentId}
   union all select xmin::text from platform.task_authorization_records where boundary->>'agentId'=${input.agentId}
   union all select xmin::text from platform.outbox_items where trace_id=${key}
   union all select xmin::text from platform.audit_events where agent_id=${input.agentId} and action in ('wecom.accepted','task.authorization.accepted')`;
		expect(rows).toHaveLength(8);
		expect(new Set(rows.map((row) => row.transaction_id)).size).toBe(1);
		expect((await channel.receive(input)).outcome).toBe("replayed");
		expect(await facts(input, key)).toEqual({
			receipts: 1,
			conversations: 1,
			executions: 1,
			messages: 1,
			authority: 1,
			outbox: 1,
			accepted_audit: 1,
			authority_audit: 1,
		});
	});

	it.each(["event", "conversation"] as const)(
		"caller abort cancels the real %s query before releasing its independent blocker",
		async (kind) => {
			const input = await scope(`caller-${kind}`);
			const controller = new AbortController();
			const held = cancellationGate();
			const reached = cancellationGate();
			let blocker: Promise<unknown> | undefined;
			let pending:
				| ReturnType<ReturnType<typeof producer>["receive"]>
				| undefined;
			let failed: Promise<void> | undefined;
			let supplied: Supplied | undefined;
			let key = "";
			let blockerReleased = false;
			try {
				if (kind === "conversation") {
					await sql`create function platform.block_cancel_conversation() returns trigger language plpgsql as $$ begin if new.agent_id=TG_ARGV[0] then perform pg_advisory_xact_lock(11380001); end if; return new; end $$`;
					await sql`create trigger block_cancel_conversation before insert on platform.conversations for each row execute function platform.block_cancel_conversation(${argument(input.agentId)})`;
				}
				const channel = producer(async (plan, execute, signal) => {
					key = plan.eventKey;
					blocker = sql.begin(async (transaction) => {
						if (kind === "event")
							await transaction`select pg_advisory_xact_lock(hashtextextended(${key},0))`;
						else await transaction`select pg_advisory_xact_lock(11380001)`;
						reached.open();
						await held.waiting;
						blockerReleased = true;
					});
					await reached.waiting;
					return store.accept(
						plan,
						(conversation) => {
							supplied = conversation;
							return execute(conversation);
						},
						signal,
					);
				});
				pending = channel.receive(input, undefined, controller.signal);
				failed = expect(pending).rejects.toThrow();
				const backend = await originalBackend(
					kind === "event"
						? "select pg_advisory_xact_lock(hashtextextended(%"
						: "%insert into platform.conversations%",
					"advisory",
				);
				controller.abort();
				await cancellationReturn(failed);
				expect(blockerReleased).toBe(false);
				await gone(backend);
				await released(input, key, kind !== "event");
				await zero(input, key);
				if (supplied) await late(supplied, input, key);
			} finally {
				held.open();
				await Promise.allSettled([pending, failed, blocker]);
				await sql`drop trigger if exists block_cancel_conversation on platform.conversations`;
				await sql`drop function if exists platform.block_cancel_conversation()`;
			}
			await released(input, key);
			await zero(input, key);
		},
		15_000,
	);

	it("caller abort settles while the admission backend is still connecting", async () => {
		const input = await scope("cancel-connect");
		const connected = cancellationGate();
		const sockets = new Set<Socket>();
		// Accept the real TCP connection but withhold PostgreSQL startup replies.
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.on("error", () => {});
			socket.on("close", () => sockets.delete(socket));
			connected.open();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing TCP fixture address");
		const url = new URL(db.databaseUrl);
		url.port = String(address.port);
		const target = new PostgresWecomChannelV1({
			databaseUrl: url.toString(),
			userDirectory: fixtureUserDirectory,
		});
		const controller = new AbortController();
		let pending: Promise<unknown> | undefined;
		let failed: Promise<unknown> | undefined;
		let key = "";
		try {
			pending = producer((plan, execute, signal) => {
				key = plan.eventKey;
				return target.accept(plan, execute, signal);
			}).receive(input, undefined, controller.signal);
			failed = expect(pending).rejects.toThrow();
			await connected.waiting;
			controller.abort();
			await cancellationReturn(failed);
			await zero(input, key);
		} finally {
			for (const socket of sockets) socket.destroy();
			await Promise.allSettled([pending, failed]);
			await target.close();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	}, 10_000);

	it("close rejects further admission without opening a new transaction", async () => {
		const input = await scope("closed-admission");
		const target = new PostgresWecomChannelV1({
			databaseUrl: db.databaseUrl,
			userDirectory: fixtureUserDirectory,
		});
		await target.close();
		let key = "";
		await expect(
			producer((plan, execute, signal) => {
				key = plan.eventKey;
				return target.accept(plan, execute, signal);
			}).receive(input),
		).rejects.toThrow();
		await zero(input, key);
	});

	it("an in-flight cancellation cannot cancel the next admission after the original rollback", async () => {
		const first = await scope("cancel-reuse-first");
		const next = await scope("cancel-reuse-next");
		const url = new URL(db.databaseUrl);
		url.searchParams.set("search_path", "platform,pg_catalog");
		const target = new PostgresWecomChannelV1({
			databaseUrl: url.toString(),
			userDirectory: fixtureUserDirectory,
		});
		const controller = new AbortController();
		const releaseSignal = cancellationGate();
		const releaseBusiness = cancellationGate();
		const locked = cancellationGate();
		let locks: Promise<unknown> | undefined;
		let pending: Promise<unknown> | undefined;
		let failed: Promise<unknown> | undefined;
		let following:
			| ReturnType<ReturnType<typeof producer>["receive"]>
			| undefined;
		let firstKey = "";
		try {
			// Delay the signal *after* the production PID/xact predicate matched.
			// The function delegates to the real PostgreSQL cancellation primitive.
			await sql`create table platform.cancel_reuse_calls (pid integer, signalled boolean)`;
			await sql`create function platform.pg_cancel_backend(target integer) returns boolean language plpgsql as $$ declare sent boolean; begin perform pg_advisory_xact_lock(11380003); sent := pg_catalog.pg_cancel_backend(target); insert into platform.cancel_reuse_calls values (target,sent); return sent; end $$`;
			await sql`create function platform.block_cancel_reuse() returns trigger language plpgsql as $$ begin if new.agent_id in (TG_ARGV[0],TG_ARGV[1]) then perform pg_advisory_xact_lock(11380004); end if; return new; end $$`;
			await sql`create trigger block_cancel_reuse before insert on platform.conversations for each row execute function platform.block_cancel_reuse(${argument(first.agentId)},${argument(next.agentId)})`;
			locks = sql.begin(async (transaction) => {
				await transaction`select pg_advisory_lock(11380003)`;
				let signalLocked = true;
				try {
					await transaction`select pg_advisory_xact_lock(11380004)`;
					locked.open();
					await releaseSignal.waiting;
					await transaction`select pg_advisory_unlock(11380003)`;
					signalLocked = false;
					await releaseBusiness.waiting;
				} finally {
					if (signalLocked)
						await transaction`select pg_advisory_unlock(11380003)`;
				}
			});
			await locked.waiting;
			pending = producer((plan, execute, signal) => {
				firstKey = plan.eventKey;
				return target.accept(plan, execute, signal);
			}).receive(first, undefined, controller.signal);
			failed = expect(pending).rejects.toThrow();
			const original = await originalBackend(
				"%insert into platform.conversations%",
				"advisory",
			);
			controller.abort();
			await originalBackend("select pg_cancel_backend(pid)%", "advisory");
			await sql`select pg_catalog.pg_cancel_backend(${original.pid})`;
			await waitForCancellation(async () =>
				(
					await sql`select pid from pg_stat_activity where pid=${original.pid} and xact_start::text=${original.started_at}`
				).length === 0
					? [true]
					: [],
			);
			following = producer((...args) => target.accept(...args)).receive(next);
			// Attach a rejection handler before deliberately delivering the old signal.
			const result = following.then(
				(value) => ({ value }),
				(error) => ({ error }),
			);
			await originalBackend("%insert into platform.conversations%", "advisory");
			releaseSignal.open();
			await waitForCancellation(
				() =>
					sql`select 1 from platform.cancel_reuse_calls where pid=${original.pid} and signalled`,
			);
			releaseBusiness.open();
			await cancellationReturn(failed);
			expect(await result).toMatchObject({ value: { outcome: "accepted" } });
			await zero(first, firstKey);
		} finally {
			releaseSignal.open();
			releaseBusiness.open();
			await Promise.allSettled([pending, failed, following, locks]);
			await target.close();
			await sql`drop trigger if exists block_cancel_reuse on platform.conversations`;
			await sql`drop function if exists platform.block_cancel_reuse()`;
			await sql`drop function if exists platform.pg_cancel_backend(integer)`;
			await sql`drop table if exists platform.cancel_reuse_calls`;
		}
	}, 15_000);

	it("receipt SQL ends at the runner deadline before its unchanged statement timeout", async () => {
		const input = await scope("receipt-deadline");
		const observer = postgres(db.databaseUrl, { max: 1 });
		let pending: ReturnType<ReturnType<typeof producer>["receive"]> | undefined;
		let failed: Promise<void> | undefined;
		let supplied: Supplied | undefined;
		let key = "";
		try {
			await sql`create function platform.block_cancel_receipt() returns trigger language plpgsql as $$ begin if new.scope->>'agentId'=TG_ARGV[0] then perform pg_sleep(30); end if; return new; end $$`;
			await sql`create trigger block_cancel_receipt before insert on platform.wecom_receipts for each row execute function platform.block_cancel_receipt(${argument(input.agentId)})`;
			const startedAt = Date.now();
			// No caller signal. A real delay before receipt SQL separates its statement timeout from the runner deadline.
			pending = producer((plan, execute, signal) => {
				key = plan.eventKey;
				return store.accept(
					plan,
					async (conversation) => {
						supplied = conversation;
						const result = await execute(conversation);
						await observer`select pg_sleep(2)`;
						return result;
					},
					signal,
				);
			}).receive(input);
			failed = expect(pending).rejects.toThrow();
			const backend = await originalBackend(
				"insert into platform.wecom_receipts %",
				"PgSleep",
				observer,
			);
			expect(Number(backend.query_delay_ms)).toBeGreaterThanOrEqual(1_900);
			// Observe the exact receipt SQL exiting at the real runner deadline.
			// Only then start the independent 2s producer convergence assertion.
			await waitForCancellation(
				() =>
					observer`select 1 where not exists (select 1 from pg_stat_activity where pid=${backend.pid} and xact_start::text=${backend.started_at} and query_start::text=${backend.query_started_at} and state='active')`,
				12_000,
			);
			await cancellationReturn(failed);
			const [ended] = await observer<
				{ elapsed_ms: number }[]
			>`select extract(epoch from(clock_timestamp()-${backend.query_started_at}::timestamptz))*1000 as elapsed_ms`;
			expect(Number(ended?.elapsed_ms)).toBeLessThan(9_500);
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9_000);
			expect(Date.now() - startedAt).toBeLessThan(15_000);
			await gone(backend, observer);
			await released(input, key, true, observer);
			await zero(input, key);
			if (!supplied) throw new Error("Missing original supplied producer");
			await late(supplied, input, key);
			await sql`drop trigger block_cancel_receipt on platform.wecom_receipts`;
			await sql`drop function platform.block_cancel_receipt()`;
			await zero(input, key);
		} finally {
			await Promise.allSettled([pending, failed]);
			await sql`drop trigger if exists block_cancel_receipt on platform.wecom_receipts`;
			await sql`drop function if exists platform.block_cancel_receipt()`;
			await observer.end();
		}
	}, 20_000);

	it.each(["hold-reply", "reset-after-rollback"] as const)(
		"cancel transport reply %s preserves original rollback and the independent 2s producer bound",
		async (kind) => {
			const input = await scope(`cancel-reply-${kind}`);
			const role = `controlled_cancel_${sequence}`;
			const url = new URL(db.databaseUrl);
			url.username = role;
			url.password = "controlled_test_only";
			const held = cancellationGate();
			const reached = cancellationGate();
			const controller = new AbortController();
			let controlled: ReturnType<typeof postgres> | undefined;
			let transport:
				| Awaited<ReturnType<typeof pendingCommitTransport>>
				| undefined;
			let target: PostgresWecomChannelV1 | undefined;
			let blocker: Promise<unknown> | undefined;
			let observed: Promise<void> | undefined;
			let pending:
				| ReturnType<ReturnType<typeof producer>["receive"]>
				| undefined;
			let failed: Promise<void> | undefined;
			let settled: Promise<void> | undefined;
			let supplied: Supplied | undefined;
			let key = "";
			let roleCreated = false;
			let blockerReleased = false;
			try {
				await sql`create role ${sql(role)} login nosuperuser noinherit nocreatedb nocreaterole noreplication password 'controlled_test_only'`;
				roleCreated = true;
				await sql`grant usage on schema platform to ${sql(role)}`;
				await sql`grant select,insert,update,delete on all tables in schema platform to ${sql(role)}`;
				await sql`grant usage,select on all sequences in schema platform to ${sql(role)}`;
				controlled = postgres(url.toString(), { max: 1, connect_timeout: 1 });
				const [permission] = await controlled<
					{
						username: string;
						superuser: boolean;
						may_cancel: boolean;
						signal_all: boolean;
						read_all: boolean;
						server_version: string;
					}[]
				>`
 select current_user as username,r.rolsuper as superuser,
 has_function_privilege(current_user,'pg_catalog.pg_cancel_backend(integer)','execute') as may_cancel,
 pg_has_role(current_user,'pg_signal_backend','member') as signal_all,
 pg_has_role(current_user,'pg_read_all_stats','member') as read_all,
 current_setting('server_version') as server_version from pg_roles r where r.rolname=current_user`;
				expect(permission).toMatchObject({
					username: role,
					superuser: false,
					may_cancel: true,
					signal_all: false,
					read_all: false,
				});
				console.info("controlled-cancel-role", { kind, ...permission });
				const [observer] = await sql<
					{ pid: number }[]
				>`select pg_backend_pid() as pid`;
				if (!observer)
					throw new Error("Missing controlled independent observer");
				await expect(
					controlled`select pg_cancel_backend(${observer.pid})`,
				).rejects.toMatchObject({ code: "42501" });
				await sql`select 1`;
				transport = await pendingCommitTransport(url.toString(), true);
				target = new PostgresWecomChannelV1({
					databaseUrl: transport.databaseUrl,
					userDirectory: fixtureUserDirectory,
				});
				await sql`create function platform.block_cancel_reply() returns trigger language plpgsql as $$ begin if new.agent_id=TG_ARGV[0] then perform pg_advisory_xact_lock(11380002); end if; return new; end $$`;
				await sql`create trigger block_cancel_reply before insert on platform.conversations for each row execute function platform.block_cancel_reply(${argument(input.agentId)})`;
				blocker = sql.begin(async (transaction) => {
					await transaction`select pg_advisory_xact_lock(11380002)`;
					reached.open();
					await held.waiting;
					blockerReleased = true;
				});
				await reached.waiting;
				const activeTarget = target;
				pending = producer((plan, execute, signal) => {
					key = plan.eventKey;
					return activeTarget.accept(
						plan,
						(conversation) => {
							supplied = conversation;
							return execute(conversation);
						},
						signal,
					);
				}).receive(input, undefined, controller.signal);
				failed = expect(pending).rejects.toThrow();
				const backend = await originalBackend(
					"%insert into platform.conversations%",
					"advisory",
				);
				expect(Date.now() - Date.parse(backend.query_started_at)).toBeLessThan(
					2_500,
				);
				const activeTransport = transport;
				const abortedAt = Date.now();
				settled = failed.then(async () => {
					// Verify at producer settlement without polling for a later rollback.
					expect(Date.now() - abortedAt).toBeLessThan(2_000);
					await gone(backend);
					expect(blockerReleased).toBe(false);
					await released(input, key);
					await zero(input, key);
				});
				controller.abort();
				observed = (async () => {
					await waitForCancellation(
						async () => (activeTransport.cancelDispatched() ? [true] : []),
						2_000,
					);
					await waitForCancellation(async () =>
						(
							await sql`select pid from pg_stat_activity where pid=${backend.pid} and xact_start::text=${backend.started_at}`
						).length === 0
							? [true]
							: [],
					);
					await gone(backend);
					expect(blockerReleased).toBe(false);
					if (kind === "reset-after-rollback")
						activeTransport.disconnectCancel();
					// Only the settlement callback probes NOWAIT locks; observers must not compete.
					await settled;
					if (!supplied)
						throw new Error(
							"Missing original supplied Conversation transaction",
						);
					await late(supplied, input, key);
					console.info("controlled-cancel-rollback", {
						kind,
						pid: backend.pid,
						startedAt: backend.started_at,
						afterAbortMs: Date.now() - abortedAt,
						blockerReleased,
						locksReleased: true,
						factsZero: true,
						lateRejected: true,
					});
				})();
				await Promise.all([cancellationReturn(settled), observed]);
			} finally {
				transport?.releaseCancelReply();
				held.open();
				await Promise.allSettled([pending, failed, settled, blocker, observed]);
				await target?.close();
				await transport?.close();
				await controlled?.end();
				await sql`drop trigger if exists block_cancel_reply on platform.conversations`;
				await sql`drop function if exists platform.block_cancel_reply()`;
				if (roleCreated) {
					await sql`revoke all privileges on all tables in schema platform from ${sql(role)}`;
					await sql`revoke all privileges on all sequences in schema platform from ${sql(role)}`;
					await sql`revoke usage on schema platform from ${sql(role)}`;
					await sql`drop role ${sql(role)}`;
				}
			}
			await released(input, key);
			await zero(input, key);
		},
		20_000,
	);

	it.each(["caller-abort", "runner-deadline"] as const)(
		"awaits original rollback and rejects late execute SQL after %s",
		async (kind) => {
			const input = await scope(`late-execute-${kind}`);
			const reached = cancellationGate();
			const resume = cancellationGate();
			const finished = cancellationGate();
			const controller = new AbortController();
			let key = "";
			let lateFinished = false;
			let executeReached = false;
			let lateChecks: Promise<void> | undefined;
			let failed: Promise<void> | undefined;
			let pending:
				| ReturnType<ReturnType<typeof producer>["receive"]>
				| undefined;
			try {
				const startedAt = Date.now();
				pending = producer((plan, execute, signal) => {
					key = plan.eventKey;
					return store.accept(
						plan,
						async (conversation) => {
							const result = await execute(conversation);
							executeReached = true;
							reached.open();
							await resume.waiting;
							try {
								lateChecks = late(conversation, input, key);
								await lateChecks;
							} finally {
								lateFinished = true;
								finished.open();
							}
							return result;
						},
						signal,
					);
				}).receive(
					input,
					undefined,
					kind === "caller-abort" ? controller.signal : undefined,
				);
				failed = expect(pending).rejects.toThrow();
				await reached.waiting;
				if (kind === "caller-abort") controller.abort();
				await failed;
				expect(lateFinished).toBe(false);
				if (kind === "runner-deadline")
					expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9_000);
				expect(Date.now() - startedAt).toBeLessThan(15_000);
				await released(input, key);
				await zero(input, key);
				resume.open();
				await finished.waiting;
				await lateChecks;
				await zero(input, key);
			} finally {
				resume.open();
				await Promise.allSettled([pending, failed]);
				if (executeReached) await finished.waiting;
			}
		},
		20_000,
	);

	it.each(["caller-abort", "runner-deadline"] as const)(
		"cancels original active driver COMMIT after %s and awaits its lock release",
		async (kind) => {
			const input = await scope(`commit-${kind}`);
			const controller = new AbortController();
			let key = "";
			let failed: Promise<void> | undefined;
			let pending:
				| ReturnType<ReturnType<typeof producer>["receive"]>
				| undefined;
			try {
				await sql`create function platform.block_cancel_commit() returns trigger language plpgsql as $$ begin if new.action='wecom.accepted' and new.agent_id=TG_ARGV[0] then perform pg_sleep(30); end if; return new; end $$`;
				await sql`create constraint trigger block_cancel_commit after insert on platform.audit_events deferrable initially deferred for each row execute function platform.block_cancel_commit(${argument(input.agentId)})`;
				const startedAt = Date.now();
				pending = producer((plan, execute, signal) => {
					key = plan.eventKey;
					return store.accept(plan, execute, signal);
				}).receive(
					input,
					undefined,
					kind === "caller-abort" ? controller.signal : undefined,
				);
				failed = expect(pending).rejects.toThrow();
				const backend = await originalBackend("commit", "PgSleep");
				if (kind === "caller-abort") controller.abort();
				await failed;
				if (kind === "runner-deadline")
					expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9_000);
				expect(Date.now() - startedAt).toBeLessThan(15_000);
				await gone(backend);
				await released(input, key);
				await zero(input, key);
			} finally {
				await Promise.allSettled([pending, failed]);
				await sql`drop trigger if exists block_cancel_commit on platform.audit_events`;
				await sql`drop function if exists platform.block_cancel_commit()`;
			}
		},
		20_000,
	);

	it("follows a real queued driver COMMIT from an idle transaction through active cancellation", async () => {
		const input = await scope("pending-commit-caller");
		const transport = await pendingCommitTransport(db.databaseUrl);
		const applicationName = `pending-commit-${input.agentId}`;
		const databaseUrl = new URL(transport.databaseUrl);
		databaseUrl.searchParams.set("application_name", applicationName);
		const target = new PostgresWecomChannelV1({
			databaseUrl: databaseUrl.toString(),
			userDirectory: fixtureUserDirectory,
		});
		const controller = new AbortController();
		let key = "";
		let supplied: Supplied | undefined;
		let pending: ReturnType<ReturnType<typeof producer>["receive"]> | undefined;
		let failed: Promise<void> | undefined;
		let settled = false;
		try {
			await sql`create function platform.block_pending_cancel_commit() returns trigger language plpgsql as $$ begin if new.action='wecom.accepted' and new.agent_id=TG_ARGV[0] then perform pg_sleep(30); end if; return new; end $$`;
			await sql`create constraint trigger block_pending_cancel_commit after insert on platform.audit_events deferrable initially deferred for each row execute function platform.block_pending_cancel_commit(${argument(input.agentId)})`;
			const channel = createWecomChannelV1({
				authorization: createWecomAuthorizationV1({ identity, state: target }),
				store: {
					reject: (...args) => target.reject(...args),
					accept: (plan, execute, signal) => {
						key = plan.eventKey;
						return target.accept(
							plan,
							async (conversation) => {
								supplied = conversation;
								const result = await execute(conversation);
								transport.arm();
								return result;
							},
							signal,
						);
					},
				},
			});
			pending = channel.receive(input, undefined, controller.signal);
			failed = expect(pending).rejects.toThrow();
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			await Promise.race([
				transport.pending,
				pending.then(
					() => {
						throw new Error("Producer committed before the COMMIT gate");
					},
					() => {
						throw new Error("Producer failed before the COMMIT gate");
					},
				),
			]);
			const [backend] = await sql<
				Backend[]
			>`select pid,xact_start::text as started_at,query_start::text as query_started_at,0 as query_delay_ms from pg_stat_activity where application_name=${applicationName} and state='idle in transaction' and query like 'select set_config(''statement_timeout'',%'`;
			if (!backend)
				throw new Error("Missing original queued COMMIT transaction");
			controller.abort();
			// First native cancel probe has actually finished while COMMIT is still unsent.
			// Its original transaction is idle, so the active-COMMIT predicate matched zero.
			await waitForCancellation(
				() =>
					sql`select pid from pg_stat_activity where application_name=${applicationName} and state='idle' and query like 'select pg_cancel_backend(pid) from pg_stat_activity%'`,
			);
			expect(
				await sql`select pid from pg_stat_activity where pid=${backend.pid} and xact_start::text=${backend.started_at} and state='idle in transaction'`,
			).toHaveLength(1);
			expect(settled).toBe(false);
			transport.release();
			await cancellationReturn(failed);
			await gone(backend);
			await released(input, key);
			await zero(input, key);
			if (!supplied) throw new Error("Missing original supplied transaction");
			await late(supplied, input, key);
			await zero(input, key);
		} finally {
			transport.release();
			await Promise.allSettled([pending, failed]);
			await target.close();
			await transport.close();
			await waitForCancellation(
				() =>
					sql`select 1 where not exists(select 1 from pg_stat_activity where application_name=${applicationName})`,
			);
			await sql`drop trigger if exists block_pending_cancel_commit on platform.audit_events`;
			await sql`drop function if exists platform.block_pending_cancel_commit()`;
		}
	}, 20_000);

	it.each([false, true])(
		"rolls back %s deferred acceptance audit fault and retries one actual receipt",
		async (deferred) => {
			const input = await scope(`audit-${deferred}`);
			let key = "";
			const channel = producer((plan, execute, signal) => {
				key = plan.eventKey;
				return store.accept(plan, execute, signal);
			});
			try {
				await sql`create function platform.fail_cancel_audit() returns trigger language plpgsql as $$ begin if new.action='wecom.accepted' and new.agent_id=TG_ARGV[0] then raise exception 'Controlled acceptance audit failure'; end if; return new; end $$`;
				if (deferred)
					await sql`create constraint trigger fail_cancel_audit after insert on platform.audit_events deferrable initially deferred for each row execute function platform.fail_cancel_audit(${argument(input.agentId)})`;
				else
					await sql`create trigger fail_cancel_audit before insert on platform.audit_events for each row execute function platform.fail_cancel_audit(${argument(input.agentId)})`;
				await expect(channel.receive(input)).rejects.toThrow();
				await released(input, key);
				await zero(input, key);
			} finally {
				await sql`drop trigger if exists fail_cancel_audit on platform.audit_events`;
				await sql`drop function if exists platform.fail_cancel_audit()`;
			}
			expect((await channel.receive(input)).outcome).toBe("accepted");
			expect((await channel.receive(input)).outcome).toBe("replayed");
			expect(await facts(input, key)).toEqual({
				receipts: 1,
				conversations: 1,
				executions: 1,
				messages: 1,
				authority: 1,
				outbox: 1,
				accepted_audit: 1,
				authority_audit: 1,
			});
		},
	);
});
