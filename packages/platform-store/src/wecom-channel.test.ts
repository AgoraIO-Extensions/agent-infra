import { createHash } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import {
	createWecomAuthorizationV1,
	createWecomChannelV1,
	createWecomDeliveryV1,
	type WecomAuthorizationPortV1,
	type WecomChannelStorePortV1,
	type WecomConnectionFenceV1,
	type WecomDeliveryClaimV1,
	type WecomIdentityPortV1,
	type WecomMessageV1,
	type WecomSendPortV1,
	wecomChannelIdV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.ts";
import { PostgresPlatformAuditQueryV1 } from "./audit.ts";
import { PostgresConversationDispatchStoreV1 } from "./conversation-dispatch.ts";
import { PostgresConversationQueryV1 } from "./conversation-query.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import { PostgresScopedPlatformAuditQueryV1 } from "./scoped-audit-query.ts";
import { markSessionSandboxReadyFixture } from "./session-sandbox.fixture.ts";
import { PostgresWecomChannelV1 } from "./wecom-channel.ts";
import { completeWecomExecutionFixture } from "./wecom-receipt.fixture.ts";

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
const fixtureIdentity: WecomIdentityPortV1 = {
	resolveSender: async (scope) =>
		fixtureUserDirectory.resolveUser(scope.senderId),
	activeUsers: async (ids) => ids,
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
/** 带 Agent 默认 Relay Key 的标准 Agent 持久化为 V3：模型选项不含任何凭证（#2422）。 */
const keylessAgentId = "wecom_agent_keyless";
const keylessConfiguration = (() => {
	const model = agentConfigurationConformanceRecordV1.modelConfiguration;
	if (!model) throw new Error("fixture model missing");
	return {
		...agentConfigurationConformanceRecordV1,
		schemaVersion: 3,
		agentId: keylessAgentId,
		revision: 1,
		source: configuration.source,
		environment: [],
		secrets: [],
		modelConfiguration: {
			...model,
			options: model.options.map(
				({ credential: _credential, ...option }) => option,
			),
		},
		channels: [
			{ kind: message.kind, bindingReference: message.bindingReference },
		],
	};
})();
/** 测试用的放行授权：主体即企微发送者，修订与 fixture Agent 一致。 */
const allowedAuthorization: WecomAuthorizationPortV1 = {
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
						accessSources: [
							{ kind: "organization", organizationId: "controlled-org" },
						],
					},
				},
			},
		};
	},
};
function channel(target = store) {
	const base = createWecomChannelV1({
		store: target,
		authorization: allowedAuthorization,
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
				on conflict do nothing`;
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
		identity: fixtureIdentity,
	});
	await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values (${message.agentId},1,'authorization_1')`;
	await sql`insert into platform.agent_applications (id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values ('app_1',${message.agentId},'owner_1','Fixture','Fixture','available','trace_1','request_1',now(),1,1,'ready','running',1,1)`;
	await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) values (${message.agentId},'owner_1',now())`;
	await sql`insert into platform.agent_availability (agent_id,target_type,target_id) values (${message.agentId},'organization','controlled-org')`;
	await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,configuration,created_at) values (${message.agentId},1,'fixture',${sql.json(configuration)},now())`;
	await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values (${keylessAgentId},1,'authorization_1')`;
	await sql`insert into platform.agent_applications (id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values ('app_keyless',${keylessAgentId},'owner_1','Keyless','Keyless','available','trace_k','request_k',now(),1,1,'ready','running',1,1)`;
	await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) values (${keylessAgentId},'owner_1',now())`;
	await sql`insert into platform.agent_availability (agent_id,target_type,target_id) values (${keylessAgentId},'organization','controlled-org')`;
	await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,configuration,created_at) values (${keylessAgentId},1,'fixture',${sql.json(keylessConfiguration)},now())`;
}, 120_000);
afterAll(async () => {
	await store?.close();
	await sql?.end();
	await db?.stop();
});

it("requires a trusted identity provider before opening the WeCom Store", () => {
	expect(
		() =>
			new PostgresWecomChannelV1({
				...db,
				userDirectory: fixtureUserDirectory,
			} as never),
	).toThrow("WeCom identity is required");
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
		identity: fixtureIdentity,
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
it("accepts a WeCom message for a keyless (V3) Agent with the same single receipt and execution", async () => {
	const keyless = {
		...message,
		agentId: keylessAgentId,
		eventId: "event_keyless",
	};
	const accepted = await channel().receive(keyless);
	if (accepted.outcome !== "accepted") throw new Error("Expected accepted");
	expect(await channel().receive(keyless)).toEqual({
		...accepted,
		outcome: "replayed",
	});
	const rows =
		await sql`select * from platform.conversation_executions where conversation_id=${accepted.receipt.conversationId}`;
	expect(rows).toHaveLength(1);
	expect(rows[0]?.agent_id).toBe(keylessAgentId);
	expect(rows[0]?.model_option_id).toBe("model_primary");
	// 配置仍是 V3 且没有凭证：接收消息不会改写 Agent 配置。
	const [stored] =
		await sql`select configuration from platform.agent_configuration_revisions where agent_id=${keylessAgentId}`;
	expect(stored?.configuration.schemaVersion).toBe(3);
	expect(JSON.stringify(stored?.configuration)).not.toContain("credential");
	// 绑定过期或通道修订不一致时，V3 同样拒绝而不是抛出解码错误。
	expect(
		await channel().receive({
			...keyless,
			eventId: "event_keyless_stale",
			bindingReference: "other_binding",
		}),
	).toMatchObject({ outcome: expect.stringMatching(/denied|unavailable/) });
});
it("rolls back replay metadata and commits controls when identity is disabled at the final check", async () => {
	const event = {
		...message,
		eventId: "replay-disabled-event",
		senderId: "replay-disabled-sender",
	};
	const accepted = await channel().receive(event);
	if (accepted.outcome !== "accepted")
		throw new Error("Expected accepted receipt");
	await sql`update platform.conversation_executions set status='processing' where execution_id=${accepted.receipt.executionId}`;
	let calls = 0;
	const replayStore = new PostgresWecomChannelV1({
		...db,
		userDirectory: fixtureUserDirectory,
		identity: {
			resolveSender: async (scope) =>
				++calls === 1
					? fixtureUserDirectory.resolveUser(scope.senderId)
					: {
							...(await fixtureUserDirectory.resolveUser(scope.senderId)),
							accountStatus: "disabled",
							authorizationRevision: "changed-identity",
						},
			activeUsers: async (ids) => ids,
		},
	});
	try {
		expect(await channel(replayStore).receive(event)).toEqual({
			outcome: "denied",
		});
	} finally {
		await replayStore.close();
	}
	expect(
		await sql`select count(*)::int as count from platform.wecom_receipts where id=${accepted.receipt.receiptId}`,
	).toEqual([{ count: 1 }]);
	expect(
		await sql`select reason from platform.task_control_records c join platform.conversation_executions e on e.execution_id=c.execution_id where e.execution_id=${accepted.receipt.executionId}`,
	).toEqual([{ reason: "authorization_revoked" }]);
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
	await completeWecomExecutionFixture(sql, accepted.receipt.executionId);
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
		identity: fixtureIdentity,
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
it("claims confirmed result files once per file and preserves event order", async () => {
	await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
	const accepted = await channel().receive({
		...message,
		senderId: "result_media_sender",
		eventId: "result_media_event",
	});
	if (accepted.outcome !== "accepted") throw new Error("Expected receipt");
	const executionId = accepted.receipt.executionId;
	const conversationId = accepted.receipt.conversationId;
	if (!executionId || !conversationId) throw new Error("Expected execution");
	await sql`update platform.conversation_executions
		set status='completed',last_event_sequence=2,last_runtime_cursor='runtime-result-2'
		where execution_id=${executionId}`;
	await sql`update platform.conversations
		set last_conversation_cursor=2 where id=${conversationId}`;
	const file = {
		fileId: "result-media-file",
		objectRef: "result-media-object",
		kind: "result" as const,
		idempotencyKey: "result-media-idempotency",
		actorId: "result_media_sender",
		agentId: message.agentId,
		channelId: wecomChannelIdV1({
			kind: message.kind,
			bindingReference: message.bindingReference,
		}),
		conversationId,
		executionId,
		messageId: null,
		sessionGeneration: 1,
		status: "available" as const,
		descriptor: {
			name: "report.pdf",
			mediaType: "application/pdf",
			sizeBytes: 42,
			sha256: "f".repeat(64),
		},
		objectVersion: "result-media-version",
		etag: "result-media-etag",
		createdAt: "2026-10-10T00:00:00.000Z",
		updatedAt: "2026-10-10T00:00:00.000Z",
		expiresAt: "2099-01-01T00:00:00.000Z",
		revision: 1,
	};
	await sql`insert into platform.files
		(file_id,actor_id,conversation_id,idempotency_key,record,updated_at)
		values (${file.fileId},${file.actorId},${conversationId},${file.idempotencyKey},${sql.json(file)},now())`;
	for (const [sequence, adapterEventKey] of [
		[1, "result-media-1"],
		[2, "result-media-2"],
	] as const) {
		await sql`insert into platform.conversation_events
			(event_id,conversation_id,execution_id,adapter_event_key,sequence,
			 conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,
			 occurred_at,source)
			values (${`result-media-event-${sequence}`},${conversationId},${executionId},
			 ${adapterEventKey},${sequence},${sequence},'result.file',
			 ${sql.json({
					type: "result.file",
					fileId: file.fileId,
					name: file.descriptor.name,
					mediaType: file.descriptor.mediaType,
					sizeBytes: file.descriptor.sizeBytes,
				})},${String(sequence).repeat(64)},${`runtime-result-${sequence}`},now(),'runtime')`;
	}
	await completeWecomExecutionFixture(sql, executionId);
	const claim = await store.claim();
	expect(claim?.receiptId).toBe(accepted.receipt.receiptId);
	expect(claim?.textDeltas).toEqual([]);
	expect(claim?.media).toEqual([
		{
			fileId: file.fileId,
			name: file.descriptor.name,
			mediaType: file.descriptor.mediaType,
			sizeBytes: file.descriptor.sizeBytes,
			workspaceReference: null,
		},
	]);
	expect(claim).toMatchObject({ conversationId, executionId });
});

/** #3229：一条已完成的企微执行，带按给定顺序发布的结果文件（V2 事件带工作区引用）。 */
async function completedWithResults(
	senderId: string,
	files: readonly {
		readonly fileId: string;
		readonly name: string;
		readonly recordReference: string | null;
		readonly eventReference: string | null;
	}[],
) {
	await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
	const accepted = await channel().receive({
		...message,
		senderId,
		eventId: `${senderId}_event`,
	});
	if (accepted.outcome !== "accepted") throw new Error("Expected receipt");
	const { executionId, conversationId } = accepted.receipt;
	if (!executionId || !conversationId) throw new Error("Expected execution");
	await sql`update platform.conversation_executions
		set status='completed',last_event_sequence=${files.length},last_runtime_cursor=${`runtime-${senderId}-${files.length}`}
		where execution_id=${executionId}`;
	await sql`update platform.conversations
		set last_conversation_cursor=${files.length} where id=${conversationId}`;
	for (const [index, entry] of files.entries()) {
		const sequence = index + 1;
		const record = {
			fileId: entry.fileId,
			objectRef: `${entry.fileId}-object`,
			kind: "result" as const,
			idempotencyKey: `${entry.fileId}-idempotency`,
			actorId: senderId,
			agentId: message.agentId,
			channelId: wecomChannelIdV1(message),
			conversationId,
			executionId,
			messageId: null,
			sessionGeneration: 1,
			status: "available" as const,
			descriptor: {
				name: entry.name,
				mediaType: "application/pdf",
				sizeBytes: 64,
				sha256: "e".repeat(64),
			},
			objectVersion: `${entry.fileId}-version`,
			etag: `${entry.fileId}-etag`,
			createdAt: "2026-10-10T00:00:00.000Z",
			updatedAt: "2026-10-10T00:00:00.000Z",
			expiresAt: "2099-01-01T00:00:00.000Z",
			revision: 1,
			workspaceReference: entry.recordReference,
		};
		await sql`insert into platform.files
			(file_id,actor_id,conversation_id,idempotency_key,record,updated_at)
			values (${record.fileId},${senderId},${conversationId},${record.idempotencyKey},${sql.json(record)},now())`;
		await sql`insert into platform.conversation_events
			(event_id,conversation_id,execution_id,adapter_event_key,sequence,
			 conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,
			 occurred_at,source)
			values (${`${entry.fileId}-event`},${conversationId},${executionId},
			 ${`${entry.fileId}-adapter`},${sequence},${sequence},'result.file',
			 ${sql.json({
					type: "result.file",
					fileId: record.fileId,
					name: entry.name,
					mediaType: "application/pdf",
					sizeBytes: 64,
					workspaceReference: entry.eventReference,
				})},${`${sequence}`.padStart(64, "f")},${`runtime-${senderId}-${sequence}`},now(),'runtime')`;
	}
	await completeWecomExecutionFixture(sql, executionId);
	const claim = await store.claim();
	if (claim?.receiptId !== accepted.receipt.receiptId)
		throw new Error("Expected claim");
	return { claim, conversationId, executionId };
}
const outboundAuthority = (actorId: string, claim: WecomDeliveryClaimV1) => ({
	managementRevision: 1,
	channelRevision: "channels_1",
	actor: {
		schemaVersion: 1 as const,
		agentId: message.agentId,
		actorId,
		taskBoundary: claim.taskBoundary,
		channelId: wecomChannelIdV1(message),
		authorizationRevision: "authorization_1",
		supportsSupplementaryInstruction: false,
	},
});
const mediaRows = (receiptId: string) =>
	sql<
		{ ordinal: number; file_id: string; kind: string; status: string }[]
	>`select ordinal,file_id,kind,status from platform.wecom_receipt_media where receipt_id=${receiptId} order by ordinal`;

describe("WeCom outbound media progress (#3229)", () => {
	it("claims workspace references and records media progress per file without restarting it", async () => {
		const { claim, conversationId, executionId } = await completedWithResults(
			"outbound_sender",
			[
				{
					fileId: "outbound-a",
					name: "a.pdf",
					recordReference: "out/a.pdf",
					eventReference: "out/a.pdf",
				},
				{
					fileId: "outbound-b",
					name: "b.pdf",
					recordReference: null,
					eventReference: null,
				},
				// 事件与文件记录的工作区引用不一致：不是已确认的结果文件。
				{
					fileId: "outbound-mismatch",
					name: "c.pdf",
					recordReference: "out/c.pdf",
					eventReference: "out/other.pdf",
				},
			],
		);
		expect(claim).toMatchObject({ conversationId, executionId });
		expect(claim.media).toEqual([
			{
				fileId: "outbound-a",
				name: "a.pdf",
				mediaType: "application/pdf",
				sizeBytes: 64,
				workspaceReference: "out/a.pdf",
			},
			{
				fileId: "outbound-b",
				name: "b.pdf",
				mediaType: "application/pdf",
				sizeBytes: 64,
				workspaceReference: null,
			},
		]);
		const media = (claim.media ?? []).map((file) => ({
			...file,
			kind: "file" as const,
		}));
		// 只能记录本次领取给出的结果文件。
		await expect(
			store.prepare(claim, outboundAuthority("outbound_sender", claim), [
				{ ...media[0], fileId: "outbound-mismatch" } as never,
			]),
		).rejects.toThrow();
		expect(
			await store.prepare(
				claim,
				outboundAuthority("outbound_sender", claim),
				media,
			),
		).toBe(true);
		expect(await mediaRows(claim.receiptId)).toEqual([
			{ ordinal: 0, file_id: "outbound-a", kind: "file", status: "pending" },
			{ ordinal: 1, file_id: "outbound-b", kind: "file", status: "pending" },
		]);
		// 结果只能跟在发送意图之后；旧 fence 不能推进进度。
		expect(await store.progressMedia(claim, 0, "sent")).toBe(false);
		expect(
			await store.progressMedia(
				{ ...claim, fence: claim.fence - 1 },
				0,
				"sending",
			),
		).toBe(false);
		expect(await store.progressMedia(claim, 0, "sending")).toBe(true);
		const [lease] = await sql<
			{ seconds: string }[]
		>`select extract(epoch from lease_until - clock_timestamp()) as seconds from platform.wecom_receipts where id=${claim.receiptId}`;
		expect(Number(lease?.seconds)).toBeGreaterThan(120);
		// 已开始的媒体不会再次开始。
		expect(await store.progressMedia(claim, 0, "sending")).toBe(false);
		expect(await store.progressMedia(claim, 0, "sent")).toBe(true);
		expect(await store.progressMedia(claim, 0, "unknown")).toBe(false);
		expect(await store.progressMedia(claim, 1, "sending")).toBe(true);
		await store.finish(claim, "unknown");
		expect((await mediaRows(claim.receiptId)).map((row) => row.status)).toEqual(
			["sent", "unknown"],
		);
		expect(await store.progressMedia(claim, 1, "sent")).toBe(false);
		expect(await store.read(claim.receiptId, "outbound_sender")).toMatchObject({
			deliveryStatus: "unknown",
		});
		await expect(store.progressMedia(claim, 10, "sending")).rejects.toThrow();
	});

	it("keeps started media unconfirmed and never sends the rest after a crash (#3229 AC-3)", async () => {
		const { claim } = await completedWithResults("outbound_crash", [
			{
				fileId: "crash-a",
				name: "a.pdf",
				recordReference: "out/a.pdf",
				eventReference: "out/a.pdf",
			},
			{
				fileId: "crash-b",
				name: "b.pdf",
				recordReference: "out/b.pdf",
				eventReference: "out/b.pdf",
			},
		]);
		const media = (claim.media ?? []).map((file) => ({
			...file,
			kind: "file" as const,
		}));
		expect(
			await store.prepare(
				claim,
				outboundAuthority("outbound_crash", claim),
				media,
			),
		).toBe(true);
		expect(await store.progressMedia(claim, 0, "sending")).toBe(true);
		await sql`update platform.wecom_receipts set lease_until=now()-interval '1 second' where id=${claim.receiptId}`;
		// 租约到期后不再开始新的媒体。
		expect(await store.progressMedia(claim, 1, "sending")).toBe(false);
		const restarted = new PostgresWecomChannelV1({
			...db,
			userDirectory: fixtureUserDirectory,
			identity: fixtureIdentity,
		});
		try {
			expect(await restarted.claim()).toBeNull();
			expect(
				await restarted.read(claim.receiptId, "outbound_crash"),
			).toMatchObject({ deliveryStatus: "unknown" });
			expect(
				(await mediaRows(claim.receiptId)).map((row) => row.status),
			).toEqual(["unknown", "failed"]);
			// 恢复时不重发：原领取与新的持有者都不能再开始这些媒体。
			expect(await store.progressMedia(claim, 0, "sending")).toBe(false);
			expect(await restarted.progressMedia(claim, 1, "sending")).toBe(false);
		} finally {
			await restarted.close();
		}
		// 回执与进度只有文件引用、类型和状态，没有 media_id、File Grant 或文件内容。
		const [columns] = await sql<
			{ names: string[] }[]
		>`select array_agg(column_name::text order by column_name) as names from information_schema.columns where table_schema='platform' and table_name='wecom_receipt_media'`;
		expect(columns?.names).toEqual([
			"created_at",
			"file_id",
			"kind",
			"ordinal",
			"receipt_id",
			"status",
			"updated_at",
		]);
	});
});
type ExecutionEventRow =
	| { readonly type: "text.delta"; readonly text: string }
	| {
			readonly type: "reasoning.delta";
			readonly kind: "raw" | "summary";
			readonly text: string;
	  };
/** 一条企微消息对应的 Execution 写入给定事件并进入终态，供 claim 读取。 */
async function executionWithEvents(
	senderId: string,
	rows: readonly ExecutionEventRow[],
	status: "completed" | "failed" | "cancelled" = "completed",
) {
	await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
	const accepted = await channel().receive({
		...message,
		senderId,
		eventId: `${senderId}_event`,
	});
	if (accepted.outcome !== "accepted") throw new Error("Expected receipt");
	const executionId = accepted.receipt.executionId;
	const conversationId = accepted.receipt.conversationId;
	if (!executionId || !conversationId) throw new Error("Expected execution");
	await sql`update platform.conversation_executions
		set status=${status},last_event_sequence=${rows.length},
			last_runtime_cursor=${`runtime-${senderId}-${rows.length}`}
		where execution_id=${executionId}`;
	await sql`update platform.conversations
		set last_conversation_cursor=${rows.length} where id=${conversationId}`;
	for (const [index, payload] of rows.entries()) {
		const sequence = index + 1;
		await sql`insert into platform.conversation_events
			(event_id,conversation_id,execution_id,adapter_event_key,sequence,
			 conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,
			 occurred_at,source)
			values (${`${senderId}-event-${sequence}`},${conversationId},${executionId},
			 ${`${senderId}-${sequence}`},${sequence},${sequence},${payload.type},
			 ${sql.json(payload)},${sequence.toString(16).padStart(64, "0")},
			 ${`runtime-${senderId}-${sequence}`},now(),'runtime')`;
	}
	if (status === "completed")
		await completeWecomExecutionFixture(sql, executionId);
	return accepted.receipt;
}
it("claims the answer text and the thinking separately (#2979, #2982)", async () => {
	const receipt = await executionWithEvents("reasoning_sender", [
		{ type: "reasoning.delta", kind: "raw", text: "private thought " },
		{ type: "text.delta", text: "答案" },
		{ type: "reasoning.delta", kind: "summary", text: "private summary" },
		{ type: "text.delta", text: "完整" },
	]);
	const claim = await store.claim();
	expect(claim?.receiptId).toBe(receipt.receiptId);
	// 企微答案只拼接正文增量；思考过程单独带出，由 Core 按回复方式组合。
	expect(claim?.textDeltas).toEqual(["答案", "完整"]);
	expect(claim?.thinking).toEqual({
		parts: [
			{ kind: "raw", text: "private thought " },
			{ kind: "summary", text: "private summary" },
		],
		complete: true,
	});
});
it("waits for the persisted terminal event before claiming a completed answer (#3076)", async () => {
	await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
	const accepted = await channel().receive({
		...message,
		senderId: "drain_lag_sender",
		eventId: "drain_lag_event",
	});
	if (accepted.outcome !== "accepted") throw new Error("Expected receipt");
	const { executionId, conversationId } = accepted.receipt;
	// 状态响应或恢复路径先把执行记为 completed，Runtime 事件还没有排空入库。
	await sql`update platform.conversation_executions set status='completed' where execution_id=${executionId}`;
	expect(await store.claim()).toBeNull();
	for (const [index, text] of ["答案", "完整"].entries()) {
		const sequence = index + 1;
		await sql`insert into platform.conversation_events
			(event_id,conversation_id,execution_id,adapter_event_key,sequence,
			 conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,
			 occurred_at,source)
			values (${`drain-lag-${sequence}`},${conversationId},${executionId},
			 ${`drain-lag-${sequence}`},${sequence},${sequence},'text.delta',
			 ${sql.json({ type: "text.delta", text })},${sequence.toString(16).padStart(64, "0")},
			 ${`runtime-drain-lag-${sequence}`},now(),'runtime')`;
	}
	// 部分正文已落库，但终态事件还没有：仍不能认领，否则会发出截断的答案。
	expect(await store.claim()).toBeNull();
	expect(
		(
			await sql<{ delivery_status: string }[]>`
				select delivery_status from platform.wecom_receipts where id=${accepted.receipt.receiptId}`
		)[0]?.delivery_status,
	).toBe("pending");
	await completeWecomExecutionFixture(sql, executionId);
	const claim = await store.claim();
	expect(claim?.receiptId).toBe(accepted.receipt.receiptId);
	expect(claim?.executionStatus).toBe("completed");
	expect(claim?.textDeltas).toEqual(["答案", "完整"]);
});
it("still claims expired and failed receipts without a terminal event (#3076)", async () => {
	await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
	const expired = await channel().receive({
		...message,
		senderId: "drain_expired_sender",
		eventId: "drain_expired_event",
	});
	if (expired.outcome !== "accepted") throw new Error("Expected receipt");
	await sql`update platform.conversation_executions set status='completed' where execution_id=${expired.receipt.executionId}`;
	expect(await store.claim()).toBeNull();
	// 到期的回执照旧认领，由 Core 记为 expired。
	await sql`update platform.wecom_receipts set expires_at=now()-interval '1 second' where id=${expired.receipt.receiptId}`;
	expect((await store.claim())?.receiptId).toBe(expired.receipt.receiptId);
	await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
	const failed = await channel().receive({
		...message,
		senderId: "drain_failed_sender",
		eventId: "drain_failed_event",
	});
	if (failed.outcome !== "accepted") throw new Error("Expected receipt");
	// failed 只发固定文案，不等待 Runtime 终态事件。
	await sql`update platform.conversation_executions set status='failed' where execution_id=${failed.receipt.executionId}`;
	const claim = await store.claim();
	expect(claim?.receiptId).toBe(failed.receipt.receiptId);
	expect(claim?.executionStatus).toBe("failed");
});
it("claims an unready receipt only in the last 30 seconds for the timeout notice (#3077)", async () => {
	await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
	const accepted = await channel().receive({
		...message,
		senderId: "timeout_notice_sender",
		eventId: "timeout_notice_event",
	});
	if (accepted.outcome !== "accepted") throw new Error("Expected receipt");
	// 执行仍在进行：有效期还剩 31 秒时不领取。
	await sql`update platform.wecom_receipts set expires_at=now()+interval '31 seconds' where id=${accepted.receipt.receiptId}`;
	expect(await store.claim()).toBeNull();
	// 只剩 29 秒：领取，并标明回答未就绪，由 Core 发超时提示。
	await sql`update platform.wecom_receipts set expires_at=now()+interval '29 seconds' where id=${accepted.receipt.receiptId}`;
	const claim = await store.claim();
	expect(claim?.receiptId).toBe(accepted.receipt.receiptId);
	expect(claim?.answerReady).toBe(false);
	// 回答已就绪的回执照常领取并标明就绪。
	const ready = await executionWithEvents("timeout_ready_sender", [
		{ type: "text.delta", text: "答案" },
	]);
	const readyClaim = await store.claim();
	expect(readyClaim?.receiptId).toBe(ready.receiptId);
	expect(readyClaim?.answerReady).toBe(true);
});
it("reads only a bounded thinking prefix and marks it incomplete (#2982)", async () => {
	const receipt = await executionWithEvents("long_reasoning_sender", [
		...Array.from({ length: 4 }, (_, index) => ({
			type: "reasoning.delta" as const,
			kind: "raw" as const,
			text: String(index).repeat(10_000),
		})),
		{ type: "text.delta", text: "答案照常发送" },
	]);
	const claim = await store.claim();
	expect(claim?.receiptId).toBe(receipt.receiptId);
	expect(claim?.textDeltas).toEqual(["答案照常发送"]);
	// 前三条开始于 20480 字节之前，第四条开始于 30000 字节，不再读取。
	expect(claim?.thinking?.parts.map((part) => part.text)).toEqual([
		"0".repeat(10_000),
		"1".repeat(10_000),
		"2".repeat(10_000),
	]);
	expect(claim?.thinking?.complete).toBe(false);
});
it("marks an answer beyond the reply bound instead of returning it empty (#3229)", async () => {
	const receipt = await executionWithEvents("long_answer_sender", [
		{ type: "text.delta", text: "答".repeat(7_000) },
	]);
	const claim = await store.claim();
	expect(claim?.receiptId).toBe(receipt.receiptId);
	expect(claim?.textDeltas).toEqual([]);
	expect(claim?.answerTooLong).toBe(true);
	const short = await executionWithEvents("short_answer_sender", [
		{ type: "text.delta", text: "答案" },
	]);
	const next = await store.claim();
	expect(next?.receiptId).toBe(short.receiptId);
	expect(next).not.toHaveProperty("answerTooLong");
});
it.each(["failed", "cancelled"] as const)(
	"does not read thinking for a %s execution (#2982)",
	async (status) => {
		const receipt = await executionWithEvents(
			`${status}_reasoning_sender`,
			[
				{ type: "reasoning.delta", kind: "raw", text: "private thought" },
				{ type: "text.delta", text: "partial" },
			],
			status,
		);
		const claim = await store.claim();
		expect(claim?.receiptId).toBe(receipt.receiptId);
		expect(claim?.executionStatus).toBe(status);
		expect(claim?.thinking).toBeUndefined();
	},
);
it("sends a long-connection reply whose thinking is cut to the reply bound (#2982)", async () => {
	const receipt = await executionWithEvents("bounded_reply_sender", [
		...Array.from({ length: 3 }, () => ({
			type: "reasoning.delta" as const,
			kind: "raw" as const,
			text: "思".repeat(3_000),
		})),
		{ type: "text.delta", text: "最终答案" },
	]);
	const sent: Parameters<WecomSendPortV1["send"]>[0][] = [];
	const delivery = createWecomDeliveryV1({
		store,
		authorization: allowedAuthorization,
		// 文本回答不含 sandbox: 引用。
		answerReferences: () => [],
		sender: {
			async send(input) {
				sent.push(input);
				return "sent";
			},
		},
	});
	expect(await delivery.dispatch()).toBe(true);
	expect(sent).toHaveLength(1);
	const [reply] = sent;
	expect(reply?.text).toBe("最终答案");
	const withThinking = reply?.textWithThinking ?? "";
	expect(Buffer.byteLength(withThinking)).toBeLessThanOrEqual(20_480);
	expect(withThinking.startsWith("<think>思思")).toBe(true);
	expect(
		withThinking.endsWith("（思考过程较长，已截断）</think>\n\n最终答案"),
	).toBe(true);
	expect(
		await store.read(receipt.receiptId, "bounded_reply_sender"),
	).toMatchObject({ deliveryStatus: "sent" });
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
		await completeWecomExecutionFixture(sql, accepted.receipt.executionId);
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
	await completeWecomExecutionFixture(sql, first.receipt.executionId);
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
		identity: fixtureIdentity,
		connectionHolderId: "worker-one",
	});
	const other = new PostgresWecomChannelV1({
		...db,
		userDirectory: fixtureUserDirectory,
		identity: fixtureIdentity,
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
		await completeWecomExecutionFixture(sql, accepted.receipt.executionId);
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
		identity: fixtureIdentity,
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
		await completeWecomExecutionFixture(sql, accepted.receipt.executionId);
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
		identity: fixtureIdentity,
		connectionHolderId: "worker-stale",
	});
	const replacement = new PostgresWecomChannelV1({
		...db,
		userDirectory: fixtureUserDirectory,
		identity: fixtureIdentity,
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
		await completeWecomExecutionFixture(sql, accepted.receipt.executionId);
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
			on conflict do nothing`;
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
   union all select xmin::text from platform.session_sandbox_allocations where agent_id=${input.agentId}
   union all select xmin::text from platform.conversation_audit_events where agent_id=${input.agentId} and action='conversation.sandbox.allocated'
   union all select xmin::text from platform.audit_events where agent_id=${input.agentId} and action in ('wecom.accepted','task.authorization.accepted')`;
		expect(rows).toHaveLength(11);
		expect(new Set(rows.map((row) => row.transaction_id)).size).toBe(1);
		expect((await channel.receive(input)).outcome).toBe("replayed");
		expect(await facts(input, key)).toEqual({
			receipts: 1,
			conversations: 1,
			executions: 1,
			messages: 1,
			authority: 1,
			outbox: 2,
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
						(conversation, mapping) => {
							supplied = conversation;
							return execute(conversation, mapping);
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
			identity: fixtureIdentity,
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
			identity: fixtureIdentity,
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
			identity: fixtureIdentity,
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
					async (conversation, mapping) => {
						supplied = conversation;
						const result = await execute(conversation, mapping);
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
					identity: fixtureIdentity,
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
						(conversation, mapping) => {
							supplied = conversation;
							return execute(conversation, mapping);
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
						async (conversation, mapping) => {
							const result = await execute(conversation, mapping);
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
			identity: fixtureIdentity,
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
							async (conversation, mapping) => {
								supplied = conversation;
								const result = await execute(conversation, mapping);
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
				outbox: 2,
				accepted_audit: 1,
				authority_audit: 1,
			});
		},
	);
});

it("pins the sender-to-Connection fact in the receipt and delivery claim", async () => {
	const fact = {
		schemaVersion: 1 as const,
		providerId: message.providerId,
		bindingReference: message.bindingReference,
		senderId: message.senderId,
		authorizationReference: "opaque-grant-ref",
		authorizationRevision: "auth-r1",
		grantRevision: "grant-r1",
		revocationRevision: "revoke-r1",
		expiresAt: "2099-01-01T00:00:00.000Z",
	};
	const connectionStore = new PostgresWecomChannelV1({
		...db,
		identity: fixtureIdentity,
		userDirectory: fixtureUserDirectory,
		connectionAuthorization: { resolve: async () => fact },
	});
	const authorization = createWecomAuthorizationV1({
		identity: fixtureIdentity,
		state: connectionStore,
		connectionAuthorization: { resolve: async () => fact },
	});
	const channel = createWecomChannelV1({
		store: connectionStore,
		authorization,
	});
	const event = { ...message, eventId: "connection-fact-event" };
	try {
		await sql`update platform.agent_configuration_revisions
			set configuration=jsonb_set(configuration,'{source,connectionEnabled}','true'::jsonb)
			where agent_id=${message.agentId} and revision=1`;
		await sql`insert into platform.relay_key_subjects
			(purpose, subject_id, last_version, current_version)
			values ('personal', ${event.senderId}, 1, 1)
			on conflict (purpose, subject_id) do nothing`;
		await sql`insert into platform.relay_key_versions
			(purpose, subject_id, key_version, key_id, ciphertext)
			values ('personal', ${event.senderId}, 1, ${`fixture-key:personal:${event.senderId}`},
			${sql.json({ purpose: "personal", subjectId: event.senderId, keyId: `fixture-key:personal:${event.senderId}`, keyVersion: 1 })})
			on conflict do nothing`;
		const accepted = await channel.receive(event);
		expect(accepted.outcome).toBe("accepted");
		if (accepted.outcome !== "accepted")
			throw new Error("Expected accepted receipt");
		const [row] = await sql<{ connection_authorization_fact: unknown }[]>`
			select connection_authorization_fact from platform.wecom_receipts
			where id=${accepted.receipt.receiptId}`;
		expect(row?.connection_authorization_fact).toEqual(fact);
		// 该发送者的会话此前已有回复，本条进入排队；按失败结束即可领取，验证回执携带的事实。
		await sql`update platform.conversation_executions set status='failed'
			where execution_id=${accepted.receipt.executionId}`;
		const claim = await connectionStore.claim();
		expect(claim?.connectionAuthorizationFact).toEqual(fact);
		await sql`update platform.wecom_receipts set delivery_status='pending', lease_until=null
			where id=${accepted.receipt.receiptId}`;
		let revalidated = false;
		const delivery = createWecomDeliveryV1({
			store: connectionStore,
			authorization,
			answerReferences: () => [],
			sender: {
				async send(input) {
					revalidated = (await input.revalidate?.()) === true;
					return "sent";
				},
			},
		});
		expect(await delivery.dispatch()).toBe(true);
		expect(revalidated).toBe(true);
	} finally {
		await sql`update platform.agent_configuration_revisions
			set configuration=jsonb_set(configuration,'{source,connectionEnabled}','false'::jsonb)
			where agent_id=${message.agentId} and revision=1`;
		await connectionStore.close();
	}
});

describe("WeCom /new and unavailable conversations (#3184)", () => {
	const scoped = (sender: string, eventId: string, text = "fixture text") => ({
		...message,
		senderId: sender,
		eventId,
		text,
	});
	const receiptOf = async (input: WecomMessageV1) => {
		const result = await channel().receive(input);
		if (result.outcome !== "accepted" && result.outcome !== "replayed")
			throw new Error("Expected a receipt");
		return result;
	};

	it("rotates the sender mapping once per /new event and keeps replays from rotating again", async () => {
		const sender = "rotation_sender";
		const first = await receiptOf(scoped(sender, "rotation_1"));
		const started = await receiptOf(scoped(sender, "rotation_2", "/new"));
		expect(started).toMatchObject({
			outcome: "accepted",
			receipt: {
				status: "new_conversation",
				conversationId: null,
				executionId: null,
			},
		});
		const next = await receiptOf(scoped(sender, "rotation_3", "next"));
		expect(next.receipt.status).toBe("accepted");
		expect(next.receipt.conversationId).not.toBe(first.receipt.conversationId);
		// 重放同一个 /new 事件不再轮换：下一条仍进入同一个新会话（处理中，所以进入排队）。
		expect(await receiptOf(scoped(sender, "rotation_2", "/new"))).toEqual({
			...started,
			outcome: "replayed",
		});
		const again = await receiptOf(scoped(sender, "rotation_4", "again"));
		expect(again.receipt).toMatchObject({
			status: "accepted",
			conversationId: next.receipt.conversationId,
			queuePosition: 1,
		});
		expect(
			await sql`select action, outcome from platform.audit_events where request_id=${started.receipt.receiptId}`,
		).toEqual([{ action: "wecom.conversation_started", outcome: "succeeded" }]);
		// 另一位发送者在同一群里的映射不受影响。
		const other = await receiptOf(scoped("rotation_other", "rotation_other_1"));
		expect(other.receipt.conversationId).not.toBe(next.receipt.conversationId);
	});

	it("serializes concurrent /new events for one mapping into distinct rotations", async () => {
		const sender = "rotation_concurrent";
		await Promise.all([
			receiptOf(scoped(sender, "concurrent_new_1", "/new")),
			receiptOf(scoped(sender, "concurrent_new_2", "/new")),
		]);
		// 两次 /new 在映射锁下依次生效，轮次是 2，不会因竞争只记 1。
		expect(
			await sql`select rotation from platform.wecom_conversation_rotations
				where agent_id=${message.agentId} and rotation >= 2`,
		).toEqual([{ rotation: 2 }]);
	});

	it("treats a generation-isolated conversation as unavailable in the failed reply", async () => {
		await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
		const sender = "isolation_sender";
		const first = await receiptOf(scoped(sender, "isolation_1"));
		await sql`update platform.conversation_executions set status='failed' where execution_id=${first.receipt.executionId}`;
		const conversations =
			await sql`select status, session_generation from platform.conversations where id=${first.receipt.conversationId}`;
		const conversation = conversations[0];
		if (!conversation) throw new Error("Expected mapped conversation");
		// 会话仍是 ready，只有待确认的代次隔离墓碑：提交判据同样拒绝后续消息。
		const authorizations =
			await sql`select id from platform.task_authorization_records where execution_id=${first.receipt.executionId}`;
		const authorization = authorizations[0];
		if (!authorization) throw new Error("Expected accepted authority");
		await sql`insert into platform.task_control_records (id, execution_id, authorization_record_id, reason)
			values ('isolation-control', ${first.receipt.executionId}, ${authorization.id}, 'generation_isolation')`;
		await sql`insert into platform.conversation_generation_tombstones
			(operation_id, conversation_id, session_generation, execution_id, item_id,
			 control_record_id, control_source_id, original_principal, host_session_ref, failure_code)
			values ('isolation-operation', ${first.receipt.conversationId}, ${conversation.session_generation},
				${first.receipt.executionId}, 'isolation-item', 'isolation-control', 'isolation-source',
				${sql.json({ kind: "user", id: "isolation-user" })}, 'isolation-host-session',
				'RUNTIME_SESSION_RECOVERY_FAILED')`;
		expect(conversation.status).not.toBe("unavailable");
		expect(await store.claim()).toMatchObject({
			receiptId: first.receipt.receiptId,
			executionStatus: "failed",
			conversationUnavailable: true,
		});
	});

	it("records an unavailable conversation as a rejected receipt and guides recovery with /new", async () => {
		await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
		const sender = "unavailable_sender";
		const first = await receiptOf(scoped(sender, "unavailable_1"));
		await sql`update platform.conversation_executions set status='failed' where execution_id=${first.receipt.executionId}`;
		await sql`update platform.conversations set status='unavailable' where id=${first.receipt.conversationId}`;
		const failedClaim = await store.claim();
		expect(failedClaim).toMatchObject({
			receiptId: first.receipt.receiptId,
			executionStatus: "failed",
			conversationUnavailable: true,
		});
		await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
		const rejected = await receiptOf(scoped(sender, "unavailable_2", "again"));
		expect(rejected).toMatchObject({
			outcome: "accepted",
			receipt: {
				status: "unavailable",
				conversationId: first.receipt.conversationId,
				executionId: null,
			},
		});
		expect(
			await sql`select count(*)::int as count from platform.conversation_executions where conversation_id=${first.receipt.conversationId}`,
		).toEqual([{ count: 1 }]);
		expect(
			await sql`select action, outcome from platform.audit_events where request_id=${rejected.receipt.receiptId}`,
		).toEqual([
			{ action: "wecom.conversation_unavailable", outcome: "rejected" },
		]);
		expect(await store.claim()).toMatchObject({
			receiptId: rejected.receipt.receiptId,
			acceptanceStatus: "unavailable",
		});
		await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
		await receiptOf(scoped(sender, "unavailable_3", "/new"));
		const recovered = await receiptOf(scoped(sender, "unavailable_4", "again"));
		expect(recovered.receipt.status).toBe("accepted");
		expect(recovered.receipt.conversationId).not.toBe(
			first.receipt.conversationId,
		);
	});
});

describe("WeCom inbound media receipts (#3227)", () => {
	const media = [
		{
			kind: "image" as const,
			name: null,
			download: {
				url: "https://download.example.test/SENTINEL-URL-3227",
				aesKey: "SENTINEL-AESKEY-3227",
				expiresAt: "2099-01-01T00:00:00Z",
			},
		},
	];

	it("prepares the mapped conversation outside admission and persists a rejection receipt", async () => {
		const sender = "media_sender_a";
		const conversations: string[] = [];
		const event = {
			...message,
			senderId: sender,
			peerId: "media_group",
			eventId: "media_rejected_1",
			text: "",
			media,
		};
		const resolve = async (input: { conversationId: string }) => {
			conversations.push(input.conversationId);
			return {
				outcome: "rejected" as const,
				reason: "too_large" as const,
				maxBytes: 20_971_520,
			};
		};
		const { media: _media, ...text } = event;
		const seeded = await channel().receive({
			...text,
			eventId: "media_seed",
			text: "seed",
		});
		if (seeded.outcome !== "accepted") throw new Error("Expected seed");
		await completeWecomExecutionFixture(sql, seeded.receipt.executionId);
		await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
		const rejected = await createWecomChannelV1({
			store,
			authorization: allowedAuthorization,
			media: { resolve },
		}).receive(event);
		expect(rejected).toEqual({
			outcome: "accepted",
			receipt: {
				receiptId: expect.any(String),
				status: "media_rejected",
				conversationId: null,
				executionId: null,
			},
		});
		if (rejected.outcome !== "accepted") throw new Error("Expected receipt");
		// 附件写入前确定的就是这个发送者当前映射的会话，受理事务里不再创建另一条。
		expect(conversations).toEqual([seeded.receipt.conversationId]);
		expect(
			await sql`select action, outcome from platform.audit_events where request_id=${rejected.receipt.receiptId}`,
		).toEqual([{ action: "wecom.media_rejected", outcome: "rejected" }]);
		expect(await store.claim()).toMatchObject({
			receiptId: rejected.receipt.receiptId,
			acceptanceStatus: "media_rejected",
			mediaRejection: { reason: "too_large", maxBytes: 20_971_520 },
			textDeltas: [],
		});
		// 同一事件重投直接走受理重放，不再确定会话或下载。
		expect(
			await createWecomChannelV1({
				store,
				authorization: allowedAuthorization,
				media: { resolve },
			}).receive(event),
		).toEqual({ ...rejected, outcome: "replayed" });
		expect(conversations).toHaveLength(1);
		const [row] =
			await sql`select row_to_json(r)::text as row from platform.wecom_receipts r where id=${rejected.receipt.receiptId}`;
		expect(row?.row).not.toContain("SENTINEL");
	});

	it.each([
		["a media_rejected receipt without a reason", "media_rejected", null, null],
		["a reason on an accepted receipt", "accepted", "failed", null],
		["too_large without its limit", "media_rejected", "too_large", null],
		["a limit on another reason", "media_rejected", "expired", 1024],
		["an unknown reason", "media_rejected", "virus", null],
	] as const)(
		"rejects %s at the database",
		async (_name, status, reason, maxBytes) => {
			await expect(
				sql`insert into platform.wecom_receipts (id,request_digest,scope,actor_id,task_boundary,channel_revision,authorization_revision,acceptance_status,conversation_id,execution_id,reply_handle,expires_at,created_at,updated_at,media_rejection_reason,media_rejection_max_bytes)
				values (${`constraint_${status}_${reason}_${maxBytes}`},'digest',${sql.json({})},'actor',${sql.json({})},'c','a',${status},${status === "accepted" ? "conversation" : null},null,'handle',now(),now(),now(),${reason},${maxBytes})`,
			).rejects.toMatchObject({ constraint_name: "wecom_media_rejection" });
		},
	);
});

// #3258：#3184 与 #3241 新增的企微回执动作由真实写入方产生后，管理员审计能按动作筛到；
// 普通用户仍看不到这些没有执行绑定的企微记录。
describe("WeCom receipt actions in the administrator audit query (#3258)", () => {
	const scoped = (sender: string, eventId: string, text = "fixture text") => ({
		...message,
		senderId: sender,
		eventId,
		text,
	});
	const receiptOf = async (input: WecomMessageV1) => {
		const result = await channel().receive(input);
		if (result.outcome !== "accepted" && result.outcome !== "replayed")
			throw new Error("Expected a receipt");
		return result;
	};
	const abandon = () =>
		sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
	const request = () => ({
		requestId: `audit-3258-${crypto.randomUUID()}`,
		traceId: `audit-3258-${crypto.randomUUID()}`,
	});

	it("lists /new, unavailable conversation and rejected media by action for administrators only", async () => {
		await abandon();
		const started = await receiptOf(
			scoped("audit3258_new", "audit3258_new_1", "/new"),
		);
		await abandon();
		const first = await receiptOf(scoped("audit3258_gone", "audit3258_gone_1"));
		await sql`update platform.conversation_executions set status='failed' where execution_id=${first.receipt.executionId}`;
		await sql`update platform.conversations set status='unavailable' where id=${first.receipt.conversationId}`;
		await abandon();
		const unavailable = await receiptOf(
			scoped("audit3258_gone", "audit3258_gone_2", "again"),
		);
		expect(unavailable.receipt.status).toBe("unavailable");
		await abandon();
		const media = await createWecomChannelV1({
			store,
			authorization: allowedAuthorization,
			media: {
				resolve: async () => ({
					outcome: "rejected" as const,
					reason: "unsupported_channel" as const,
					maxBytes: null,
				}),
			},
		}).receive({
			...scoped("audit3258_media", "audit3258_media_1", ""),
			media: [
				{
					kind: "image" as const,
					name: null,
					download: {
						url: "https://download.example.test/SENTINEL-URL-3258",
						aesKey: "SENTINEL-AESKEY-3258",
						expiresAt: "2099-01-01T00:00:00Z",
					},
				},
			],
		});
		if (media.outcome !== "accepted") throw new Error("Expected receipt");
		expect(media.receipt.status).toBe("media_rejected");
		await abandon();

		const expected = [
			["wecom.conversation_started", started.receipt.receiptId, "succeeded"],
			[
				"wecom.conversation_unavailable",
				unavailable.receipt.receiptId,
				"rejected",
			],
			["wecom.media_rejected", media.receipt.receiptId, "rejected"],
		] as const;
		const administrator = {
			kind: "administrator" as const,
			administratorId: "platform-admin",
		};
		const scopedQuery = new PostgresScopedPlatformAuditQueryV1(db);
		const legacyQuery = new PostgresPlatformAuditQueryV1(db);
		try {
			for (const [action, receiptId, result] of expected) {
				const [row] =
					await sql`select id, details->'originalPrincipal'->>'id' as actor from platform.audit_events where request_id=${receiptId} and action=${action}`;
				if (!row) throw new Error(`Missing ${action} audit`);
				// V1 与 V2 管理员入口共用的受控查询：按动作筛选能查到，且不带出 details。
				const page = await scopedQuery.listAudit(
					administrator,
					{ limit: 100, filters: { action } },
					request(),
				);
				expect(page.items.map((item) => item.action)).toEqual(
					page.items.map(() => action),
				);
				const item = page.items.find((entry) => entry.auditId === row.id);
				expect(item).toMatchObject({
					action,
					result,
					actor: { kind: "system", actorId: "platform-api" },
					subject: { kind: "agent", subjectId: message.agentId },
					summary: action,
					requestId: receiptId,
					agentId: message.agentId,
				});
				expect(JSON.stringify(item)).not.toMatch(/SENTINEL|receiptId/);
				const named = await scopedQuery.listAuditWithDisplayNames(
					administrator,
					{ limit: 100, filters: { action } },
					request(),
				);
				expect(named.items.some((entry) => entry.auditId === row.id)).toBe(
					true,
				);
				expect(
					await scopedQuery.getAudit(
						administrator,
						row.id,
						{ limit: 1, filters: {} },
						request(),
					),
				).toMatchObject({ auditId: row.id, action });
				// 发送者本人不是管理员：列表筛不到，按 ID 读取同样拒绝。
				const actorScope = {
					kind: "execution" as const,
					principal: { kind: "user" as const, id: row.actor as string },
					user: {
						schemaVersion: 1 as const,
						userId: row.actor as string,
						accountStatus: "active" as const,
						organizationIds: ["controlled-org"],
						authorizationRevision: "directory-current",
					},
				};
				expect(
					(
						await scopedQuery.listAudit(
							actorScope,
							{ limit: 100, filters: { action } },
							request(),
						)
					).items,
				).toEqual([]);
				await expect(
					scopedQuery.getAudit(
						actorScope,
						row.id,
						{ limit: 1, filters: {} },
						request(),
					),
				).rejects.toMatchObject({ code: "access_denied" });
			}
			// 旧版管理员审计列表同样不再跳过这三个动作。
			const legacy = await legacyQuery.listAudit(
				{ schemaVersion: 1, kind: "administrator", administratorId: "admin" },
				{ schemaVersion: 1, limit: 100 },
			);
			for (const [action, receiptId] of expected) {
				const [row] =
					await sql`select id from platform.audit_events where request_id=${receiptId} and action=${action}`;
				expect(legacy.items).toContainEqual(
					expect.objectContaining({ auditId: row?.id, action }),
				);
			}
		} finally {
			await scopedQuery.close();
			await legacyQuery.close();
		}
	}, 60_000);
});

// #3377：失败提示的分类事实、复核退避与兜底说明，以及长连接流式进度。
describe("WeCom failure delivery and streaming progress (#3377)", () => {
	type StoredEvent = { readonly type: string } & Record<string, unknown>;
	async function append(
		executionId: string,
		conversationId: string,
		rows: readonly StoredEvent[],
		source: "runtime" | "platform" = "runtime",
	) {
		for (const payload of rows) {
			const key = `${executionId}-${payload.type}-${Math.random()}`;
			await sql`insert into platform.conversation_events
				(event_id,conversation_id,execution_id,adapter_event_key,sequence,
				 conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,
				 occurred_at,source)
				select ${key},${conversationId},${executionId},${key},
					coalesce((select max(sequence) from platform.conversation_events where execution_id=${executionId}),0)+1,
					coalesce((select max(conversation_cursor) from platform.conversation_events where conversation_id=${conversationId}),0)+1,
					${payload.type},${sql.json(payload as never)},${createHash("sha256").update(key).digest("hex")},
					${source === "runtime" ? `runtime-${key}` : null},now(),${source}`;
		}
	}
	const operation = (fact: Record<string, unknown>) => ({
		schemaVersion: 2,
		type: "execution.operation",
		fact: {
			operationRef: "op-1",
			attemptRef: "attempt-1",
			...fact,
		},
	});
	async function accepted(
		senderId: string,
		target = store,
		fence?: WecomConnectionFenceV1,
	) {
		const result = await channel(target).receive(
			{ ...message, senderId, eventId: `${senderId}_event` },
			fence,
		);
		if (result.outcome !== "accepted") throw new Error("Expected receipt");
		const { executionId, conversationId } = result.receipt;
		if (!executionId || !conversationId) throw new Error("Expected execution");
		return { ...result.receipt, executionId, conversationId };
	}

	it("claims a failure with its persisted codes and trace, and Web reads the same facts", async () => {
		await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
		const receipt = await accepted("failure_facts_sender");
		await append(receipt.executionId, receipt.conversationId, [
			operation({
				kind: "model",
				phase: "started",
				model: {
					configVersion: "c",
					modelOptionId: "model_1",
					modelId: "model_1",
				},
			}),
			operation({
				kind: "model",
				phase: "failed",
				failureCode: "dependency_unavailable",
				model: {
					configVersion: "c",
					modelOptionId: "model_1",
					modelId: "model_1",
				},
			}),
			{
				type: "conversation.error",
				code: "RUNTIME_FILE_INPUT_UNAVAILABLE",
				message: "not exposed",
				retryable: false,
			},
		]);
		const [outbox] = await sql<
			{ id: string; trace_id: string }[]
		>`select id,trace_id from platform.outbox_items where scope_type='conversation' and scope_id=${receipt.conversationId} and payload->>'executionId'=${receipt.executionId}`;
		if (!outbox) throw new Error("Expected Turn outbox");
		await sql`insert into platform.persisted_events (event_id,stream_id,sequence,stream_cursor,event_type,payload,trace_id,occurred_at)
			values (${`outbox:${outbox.id}:99`},${`outbox:${outbox.id}`},99,99,'outbox.failed',${sql.json({ attemptCount: 1, deliveryFence: "99", errorCode: "RUNTIME_SESSION_PREPARATION_FAILED" })},${outbox.trace_id},now())`;
		await sql`update platform.conversation_executions set status='failed' where execution_id=${receipt.executionId}`;
		const claim = await store.claim();
		expect(claim?.receiptId).toBe(receipt.receiptId);
		expect(claim?.failure).toEqual({
			taskReason: null,
			dispatchCode: "RUNTIME_SESSION_PREPARATION_FAILED",
			runtimeCode: "RUNTIME_FILE_INPUT_UNAVAILABLE",
			modelFailureCode: "dependency_unavailable",
		});
		expect(claim?.traceId).toEqual(expect.any(String));
		expect(JSON.stringify(claim)).not.toContain("not exposed");
		const query = new PostgresConversationQueryV1({
			databaseUrl: db.databaseUrl,
		});
		try {
			const detail = await query.get(
				{
					principal: { kind: "user", id: "failure_facts_sender" },
					actorId: "failure_facts_sender",
					channelId: wecomChannelIdV1(message),
				},
				receipt.conversationId,
			);
			expect(
				detail?.executions.find(
					(item) => item.executionId === receipt.executionId,
				),
			).toMatchObject({ failure: claim?.failure, traceId: claim?.traceId });
		} finally {
			await query.close();
		}
		// 其他状态的执行不读取失败原因。
		await sql`update platform.conversation_executions set status='cancelled' where execution_id=${receipt.executionId}`;
		await sql`update platform.wecom_receipts set delivery_status='pending',lease_until=null where id=${receipt.receiptId}`;
		expect((await store.claim())?.failure).toBeUndefined();
	});

	it("finalizes an unready reply with a bounded answer prefix", async () => {
		await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
		const receipt = await accepted("timeout_prefix_sender");
		await append(receipt.executionId, receipt.conversationId, [
			{ type: "text.delta", text: "答".repeat(5_000) },
			{ type: "text.delta", text: "案".repeat(5_000) },
		]);
		await sql`update platform.conversation_executions set status='processing' where execution_id=${receipt.executionId}`;
		await sql`update platform.wecom_receipts set expires_at=now()+interval '29 seconds' where id=${receipt.receiptId}`;
		const claim = await store.claim();
		expect(claim?.receiptId).toBe(receipt.receiptId);
		expect(claim?.answerReady).toBe(false);
		expect(claim?.answerTooLong).toBe(true);
		// 第二条开始于 15000 字节之前，照常读取；Core 截短到单条回复上限。
		expect(claim?.textDeltas).toEqual(["答".repeat(5_000), "案".repeat(5_000)]);
	});

	it("defers a claim during temporary unavailability and prepares a fixed notice without a ready Agent", async () => {
		await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
		const receipt = await accepted("revalidation_notice_sender");
		await sql`update platform.conversation_executions set status='failed' where execution_id=${receipt.executionId}`;
		const first = await store.claim();
		if (!first) throw new Error("Expected claim");
		await expect(store.defer(first, 60_001)).rejects.toThrow();
		await store.defer(first, 60_000);
		expect(await store.claim()).toBeNull();
		// 退避到期后重新领取，fence 推进；旧领取不能再推进状态。
		await sql`update platform.wecom_receipts set lease_until=now()-interval '1 second' where id=${receipt.receiptId}`;
		const second = await store.claim();
		expect(second?.fence).toBe(first.fence + 1);
		if (!second) throw new Error("Expected claim");
		await store.defer(first, 0);
		expect(await store.claim()).toBeNull();
		expect(await store.prepareNotice(first)).toBe("stale");
		// Agent 正在更新：固定说明不要求服务就绪。
		await sql`update platform.agent_applications set service_availability='updating' where agent_id=${message.agentId}`;
		try {
			expect(await store.prepareNotice(second)).toBe("prepared");
		} finally {
			await sql`update platform.agent_applications set service_availability='ready' where agent_id=${message.agentId}`;
		}
		expect(
			await store.read(receipt.receiptId, "revalidation_notice_sender"),
		).toMatchObject({
			deliveryStatus: "sending",
		});
		await store.finish(second, "sent");
		expect(
			await store.read(receipt.receiptId, "revalidation_notice_sender"),
		).toMatchObject({
			deliveryStatus: "sent",
		});
		// Agent 授权修订已变化：复核确认不一致，调用方取消。
		const changed = await accepted("revalidation_changed_sender");
		await sql`update platform.conversation_executions set status='failed' where execution_id=${changed.executionId}`;
		const claim = await store.claim();
		if (!claim) throw new Error("Expected claim");
		await sql`update platform.agents set authorization_revision='authorization_changed' where id=${message.agentId}`;
		try {
			expect(await store.prepareNotice(claim)).toBe("changed");
		} finally {
			await sql`update platform.agents set authorization_revision='authorization_1' where id=${message.agentId}`;
		}
		expect(
			await store.read(changed.receiptId, "revalidation_changed_sender"),
		).toMatchObject({
			deliveryStatus: "claimed",
		});
	});

	it("lists progress only for the connection holder and persists the frame sequence under its fence (ADR-0033 decision 6)", async () => {
		await sql`update platform.wecom_receipts set delivery_status='abandoned'`;
		await sql`insert into platform.wecom_connections (bot_id,agent_id,binding_reference,holder_id,fence,lease_until,status)
    values (${message.providerId},${message.agentId},${message.bindingReference},'progress-worker',30,now()+interval '30 seconds','connected')
    on conflict (bot_id) do update set agent_id=excluded.agent_id,binding_reference=excluded.binding_reference,holder_id=excluded.holder_id,fence=excluded.fence,lease_until=excluded.lease_until,status=excluded.status`;
		const open = (holder: string) =>
			new PostgresWecomChannelV1({
				...db,
				userDirectory: fixtureUserDirectory,
				identity: fixtureIdentity,
				connectionHolderId: holder,
			});
		const owner = open("progress-worker");
		const other = open("progress-other");
		try {
			const fence = {
				botId: message.providerId,
				holderId: "progress-worker",
				fence: 30,
			};
			const receipt = await accepted("progress_sender", owner, fence);
			expect(await other.progressCandidates()).toEqual([]);
			expect(await store.progressCandidates()).toEqual([]);
			const [candidate] = await owner.progressCandidates();
			if (!candidate) throw new Error("Expected progress candidate");
			expect(candidate).toMatchObject({
				receiptId: receipt.receiptId,
				executionId: receipt.executionId,
				actorId: "progress_sender",
				channelRevision: "channels_1",
				replyHandle: message.replyHandle,
			});
			// 还没有任何 Runtime 事件：已受理的执行在准备会话。
			expect(await owner.progressSnapshot(candidate)).toEqual({
				phase: { kind: "preparing" },
				textDeltas: [],
				answerComplete: true,
			});
			await append(receipt.executionId, receipt.conversationId, [
				{ type: "execution.status", status: "processing" },
				operation({
					kind: "tool",
					phase: "started",
					toolId: "browser_navigate",
				}),
				{ type: "reasoning.delta", kind: "summary", text: "先打开页面" },
				{ type: "text.delta", text: "正在查" },
			]);
			const [changed] = await owner.progressCandidates();
			expect(changed?.revision).not.toBe(candidate.revision);
			if (!changed) throw new Error("Expected progress candidate");
			expect(await owner.progressSnapshot(changed)).toEqual({
				phase: { kind: "tool", toolName: "打开页面" },
				textDeltas: ["正在查"],
				answerComplete: true,
				thinking: {
					parts: [{ kind: "summary", text: "先打开页面" }],
					complete: true,
				},
			});
			expect(await owner.reserveStreamFrame(changed)).toBe(1);
			expect(await owner.reserveStreamFrame(changed)).toBe(2);
			// 其他 Worker、改绑前的回复路由都不能占用帧序号。
			expect(await other.reserveStreamFrame(changed)).toBeNull();
			expect(
				await owner.reserveStreamFrame({
					...changed,
					replyHandle: "stale-route",
				}),
			).toBeNull();
			// 有效期只剩最后 30 秒：交给终态回复定稿，不再列出。
			await sql`update platform.wecom_receipts set expires_at=now()+interval '29 seconds' where id=${receipt.receiptId}`;
			expect(await owner.progressCandidates()).toEqual([]);
			await sql`update platform.wecom_receipts set expires_at=now()+interval '5 minutes' where id=${receipt.receiptId}`;
			// 持有者切换：旧持有者的迟到帧不被采用，新持有者重投改绑后从已持久的序号之后继续。
			await sql`update platform.wecom_connections set holder_id='progress-other',fence=31 where bot_id=${message.providerId}`;
			expect(await owner.reserveStreamFrame(changed)).toBeNull();
			expect(await owner.progressCandidates()).toEqual([]);
			expect(
				await channel(other).receive(
					{
						...message,
						senderId: "progress_sender",
						eventId: "progress_sender_event",
						replyHandle: "rebound-route",
					},
					{ ...fence, holderId: "progress-other", fence: 31 },
				),
			).toMatchObject({ outcome: "replayed" });
			const [rebound] = await other.progressCandidates();
			expect(rebound?.replyHandle).toBe("rebound-route");
			if (!rebound) throw new Error("Expected rebound candidate");
			expect(await other.reserveStreamFrame(rebound)).toBe(3);
			// 进入终态回复后不再发进度帧。
			await completeWecomExecutionFixture(sql, receipt.executionId);
			expect(await other.progressCandidates()).toEqual([]);
			const terminal = await other.claim();
			expect(terminal?.receiptId).toBe(receipt.receiptId);
			expect(await other.reserveStreamFrame(rebound)).toBeNull();
			const [persisted] =
				await sql`select stream_frame_seq from platform.wecom_receipts where id=${receipt.receiptId}`;
			expect(persisted?.stream_frame_seq).toBe(3);
		} finally {
			await owner.close();
			await other.close();
		}
	});
});

// #3374：只含附件的企微消息打开 3 秒合并窗口，窗口内同一发送者的消息并入同一个初始 Turn
// （工程 Spec §14.2.4）。窗口状态只在 Platform DB 中：Turn outbox 的可认领时间与绑定的消息。
// 每个用例经过多次真实受理事务；CI 负载下放宽默认 5 秒的超时（同 #3227 的媒体集成测试）。
const mergeTimeout = { timeout: 60_000 };
describe("WeCom attachment merge window (#3374)", () => {
	const mergeAuthorization: WecomAuthorizationPortV1 = {
		async authorize(scope, ...rest) {
			const allowed = await allowedAuthorization.authorize(scope, ...rest);
			if (allowed.outcome !== "allowed") return allowed;
			return {
				...allowed,
				authority: {
					...allowed.authority,
					actor: { ...allowed.authority.actor, attachmentMergeWindow: true },
				},
			};
		},
	};
	const image = {
		kind: "image" as const,
		name: null,
		download: {
			url: "https://download.example.test/merge",
			aesKey: "merge-aeskey",
			expiresAt: "2099-01-01T00:00:00Z",
		},
	};
	let fileSequence = 0;
	/** 替身 resolver：按 File Authority 的结果写入当前会话中可用、未绑定的附件记录。 */
	const media = {
		async resolve(input: { message: WecomMessageV1; conversationId: string }) {
			const attachments: string[] = [];
			for (const _entry of input.message.media ?? []) {
				const fileId = `merge_file_${++fileSequence}`;
				const record = {
					actorId: input.message.senderId,
					agentId: input.message.agentId,
					channelId: wecomChannelIdV1(input.message),
					conversationId: input.conversationId,
					fileId,
					objectRef: `object-${fileId}`,
					kind: "attachment",
					idempotencyKey: `intent-${fileId}`,
					descriptor: {
						name: `${fileId}.png`,
						mediaType: "image/png",
						sizeBytes: 5,
						sha256: "e".repeat(64),
					},
					status: "available",
					executionId: null,
					messageId: null,
					sessionGeneration: null,
					objectVersion: "version-1",
					etag: "etag-1",
					createdAt: "2026-10-24T00:00:00.000Z",
					expiresAt: "2099-01-01T00:00:00Z",
					updatedAt: "2026-10-24T00:00:00.000Z",
					revision: 1,
				};
				await sql`insert into platform.files (file_id, actor_id, conversation_id, idempotency_key, record, updated_at)
					values (${fileId}, ${record.actorId}, ${input.conversationId}, ${record.idempotencyKey}, ${sql.json(record)}, now())`;
				attachments.push(fileId);
			}
			return { outcome: "resolved" as const, attachments };
		},
	};
	function mergeChannel(authorization = mergeAuthorization) {
		const base = createWecomChannelV1({
			store,
			authorization,
			media,
		});
		return {
			async receive(input: WecomMessageV1) {
				const keyId = `fixture-key:personal:${input.senderId}`;
				await sql`insert into platform.relay_key_subjects
					(purpose, subject_id, last_version, current_version)
					values ('personal', ${input.senderId}, 1, 1)
					on conflict (purpose, subject_id) do nothing`;
				await sql`insert into platform.relay_key_versions
					(purpose, subject_id, key_version, key_id, ciphertext)
					values ('personal', ${input.senderId}, 1, ${keyId},
						${sql.json({ purpose: "personal", subjectId: input.senderId, keyId, keyVersion: 1 })})
					on conflict do nothing`;
				const result = await base.receive(input);
				if (result.outcome !== "accepted" && result.outcome !== "replayed")
					throw new Error(`Expected a receipt, got ${result.outcome}`);
				return result.receipt;
			},
		};
	}
	const event = (
		senderId: string,
		eventId: string,
		input: { text?: string; images?: number; busy?: true } = {},
	): WecomMessageV1 => ({
		...message,
		senderId,
		peerId: "merge_group",
		eventId,
		text: input.text ?? "",
		// #3376：回复有效期不足以排队（排队期限不晚于有效期前 30 秒），不能并入时按繁忙处理。
		...(input.busy
			? { replyExpiresAt: new Date(Date.now() + 20_000).toISOString() }
			: {}),
		...(input.images === 0
			? {}
			: { media: Array.from({ length: input.images ?? 1 }, () => image) }),
	});
	const windowOf = async (executionId: string | null) => {
		const [row] = await sql<{ open: boolean }[]>`
			select available_at > clock_timestamp() as open from platform.outbox_items
			where id = ${`conversation:turn:${executionId}`}`;
		return row?.open;
	};
	const messagesOf = (executionId: string | null) =>
		sql<{ message_id: string; text: string }[]>`
			select message_id, text from platform.conversation_messages
			where execution_id = ${executionId} order by created_at, message_id`;
	const turnInput = async (
		conversationId: string | null,
		executionId: string | null,
	) => {
		const { readInitialTurnInput, readMessage } = await import(
			"./conversation-dispatch-sql.ts"
		);
		const [outbox] = await sql<{ payload: { messageId: string } }[]>`
			select payload from platform.outbox_items where id = ${`conversation:turn:${executionId}`}`;
		return sql.begin(async (transaction) => {
			const source = await readMessage(
				transaction,
				conversationId ?? "",
				outbox?.payload.messageId ?? "",
			);
			if (!source) throw new Error("Expected the source message");
			return readInitialTurnInput(
				transaction,
				conversationId ?? "",
				executionId ?? "",
				source,
			);
		});
	};
	const settleReceipts = () =>
		sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
	/** Worker 认领该 Execution 的初始 Turn，并读取首次投递前的原始操作绑定。 */
	const claimTurn = async (
		conversationId: string | null,
		executionId: string | null,
	) => {
		await markSessionSandboxReadyFixture(sql, conversationId ?? "");
		const dispatch = new PostgresConversationDispatchStoreV1({
			databaseUrl: db.databaseUrl,
		});
		try {
			const claimed = await dispatch.claim({
				schemaVersion: 1,
				itemId: `conversation:turn:${executionId}`,
				workerId: "merge-worker",
				leaseDurationMs: 30_000,
			});
			if (claimed.outcome !== "claimed") return { outcome: claimed.outcome };
			const runtime = await dispatch.readRuntimeState({
				claim: claimed.claim,
			});
			return {
				outcome: claimed.outcome,
				input: claimed.claim.input,
				originalOperationDigest: runtime?.originalOperationDigest,
			};
		} finally {
			await dispatch.close();
		}
	};

	it(
		"claims only after the window, with the text first and every merged attachment",
		mergeTimeout,
		async () => {
			await settleReceipts();
			const sender = "merge_sender_claim";
			const first = await mergeChannel().receive(
				event(sender, "merge_claim_image_1"),
			);
			// 窗口内 Worker 认领不到这个 Turn，输入因此能在首次投递前定稿。
			expect(await claimTurn(first.conversationId, first.executionId)).toEqual({
				outcome: "busy",
			});
			const second = await mergeChannel().receive(
				event(sender, "merge_claim_image_2", { images: 2 }),
			);
			const text = await mergeChannel().receive(
				event(sender, "merge_claim_text", {
					text: "这三张图哪张最清楚？",
					images: 0,
				}),
			);
			expect([second.executionId, text.executionId]).toEqual([
				first.executionId,
				first.executionId,
			]);
			const files = await sql<{ file_id: string; message_id: string }[]>`
				select f.file_id, f.record->>'messageId' as message_id
				from platform.files f
				join platform.conversation_messages m on m.message_id = f.record->>'messageId'
				where f.record->>'executionId'=${first.executionId}
				order by m.created_at, m.message_id, f.file_id`;
			const claimed = await claimTurn(first.conversationId, first.executionId);
			expect(claimed).toEqual({
				outcome: "claimed",
				input: {
					text: "这三张图哪张最清楚？",
					attachments: files.map((file) => file.file_id),
				},
				originalOperationDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			});
			expect(files).toHaveLength(3);
			// 已认领的 Turn 不再接收并入：之后的消息按原有规则繁忙，输入不变。
			const late = await mergeChannel().receive(
				event(sender, "merge_claim_late", {
					text: "补一句",
					images: 0,
					busy: true,
				}),
			);
			expect(late).toMatchObject({ status: "busy", executionId: null });
			await completeWecomExecutionFixture(sql, first.executionId);
		},
	);

	it(
		"runs an attachment-only Turn on its own once the window expires without text",
		mergeTimeout,
		async () => {
			await settleReceipts();
			// 没有合并能力的授权立即可认领；有合并能力时窗口到期后才可认领。两者的原始操作摘要
			// 都按实际发送的 Runtime 输入（不带空正文）计算。
			for (const [sender, receiver] of [
				["merge_sender_plain_alone", mergeChannel(allowedAuthorization)],
				["merge_sender_alone", mergeChannel()],
			] as const) {
				const image = await receiver.receive(event(sender, `${sender}_image`));
				await sql`update platform.outbox_items set available_at = clock_timestamp() - interval '1 millisecond'
					where id = ${`conversation:turn:${image.executionId}`}`;
				const [file] = await sql<{ file_id: string }[]>`
					select file_id from platform.files where record->>'executionId'=${image.executionId}`;
				expect(
					await claimTurn(image.conversationId, image.executionId),
				).toEqual({
					outcome: "claimed",
					input: { text: "", attachments: [file?.file_id] },
					originalOperationDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
				});
				await completeWecomExecutionFixture(sql, image.executionId);
			}
		},
	);

	it(
		"merges an image and the following text into one Turn and ends the image stream as merged",
		mergeTimeout,
		async () => {
			await settleReceipts();
			const sender = "merge_sender_text";
			const image = await mergeChannel().receive(
				event(sender, "merge_image_1"),
			);
			expect(image.status).toBe("accepted");
			// 只含附件的消息新建的 Turn 在窗口内不可认领。
			expect(await windowOf(image.executionId)).toBe(true);
			const text = await mergeChannel().receive(
				event(sender, "merge_text_1", { text: "图里写了什么？", images: 0 }),
			);
			expect(text).toMatchObject({
				status: "accepted",
				conversationId: image.conversationId,
				executionId: image.executionId,
			});
			// 文字消息结束窗口；两条消息都绑定到同一个 Execution，没有第二个 Turn。
			expect(await windowOf(image.executionId)).toBe(false);
			const messages = await messagesOf(image.executionId);
			expect(messages.map((row) => row.text)).toEqual(["", "图里写了什么？"]);
			expect(
				await sql`select count(*)::int as count from platform.conversation_executions where conversation_id=${image.conversationId}`,
			).toEqual([{ count: 1 }]);
			expect(
				await sql`select count(*)::int as count from platform.outbox_items where scope_id=${image.conversationId} and operation like 'conversation.turn.%'`,
			).toEqual([{ count: 1 }]);
			// 初始 Turn 输入：文字在前，附件来自附件消息；附件绑定到它所属的 Message。
			const input = await turnInput(image.conversationId, image.executionId);
			const [file] = await sql<
				{ file_id: string; message_id: string }[]
			>`select file_id, record->>'messageId' as message_id from platform.files where record->>'executionId'=${image.executionId}`;
			expect(input).toEqual({
				text: "图里写了什么？",
				attachments: [file?.file_id],
			});
			expect(file?.message_id).toBe(messages[0]?.message_id);
			// 重投文字消息只重放回执，不会再次绑定或改变窗口。
			expect(
				await mergeChannel().receive(
					event(sender, "merge_text_1", { text: "图里写了什么？", images: 0 }),
				),
			).toEqual(text);
			expect(await messagesOf(image.executionId)).toHaveLength(2);
			// 附件消息的回执立即领取并以“已合并”结束；文字消息的回执等待答案。
			const claimed = await store.claim();
			expect(claimed).toMatchObject({
				receiptId: image.receiptId,
				acceptanceStatus: "accepted",
				merged: true,
				textDeltas: [],
			});
			if (!claimed) throw new Error("Expected the merged receipt");
			await store.finish(claimed, "sent");
			expect(await store.claim()).toBeNull();
			await completeWecomExecutionFixture(sql, image.executionId);
			const answer = await store.claim();
			expect(answer).toMatchObject({ receiptId: text.receiptId });
			expect(answer).not.toHaveProperty("merged");
			if (answer) await store.finish(answer, "sent");
		},
	);

	it(
		"merges several images within the limit, re-timing the window until the text",
		mergeTimeout,
		async () => {
			await settleReceipts();
			const sender = "merge_sender_images";
			const first = await mergeChannel().receive(
				event(sender, "merge_images_1"),
			);
			const second = await mergeChannel().receive(
				event(sender, "merge_images_2", { images: 2 }),
			);
			expect(second.executionId).toBe(first.executionId);
			expect(await windowOf(first.executionId)).toBe(true);
			// 再并入 8 张会超过 10 个附件：不再并入，按繁忙处理（排队由 #3376 负责）。
			const over = await mergeChannel().receive(
				event(sender, "merge_images_3", { images: 8, busy: true }),
			);
			expect(over).toMatchObject({ status: "busy", executionId: null });
			expect(await windowOf(first.executionId)).toBe(true);
			const text = await mergeChannel().receive(
				event(sender, "merge_images_text", { text: "比较这三张图", images: 0 }),
			);
			expect(text.executionId).toBe(first.executionId);
			expect(await windowOf(first.executionId)).toBe(false);
			const input = await turnInput(first.conversationId, first.executionId);
			expect(input.text).toBe("比较这三张图");
			expect(input.attachments).toHaveLength(3);
			await completeWecomExecutionFixture(sql, first.executionId);
		},
	);

	it(
		"stops merging once the window has expired or the Turn was claimed",
		mergeTimeout,
		async () => {
			await settleReceipts();
			const sender = "merge_sender_expired";
			const image = await mergeChannel().receive(
				event(sender, "merge_expired_1"),
			);
			// 窗口到期（不依赖进程内存，只看 Platform DB 的可认领时间）。
			await sql`update platform.outbox_items set available_at = clock_timestamp() - interval '1 second'
			where id = ${`conversation:turn:${image.executionId}`}`;
			const late = await mergeChannel().receive(
				event(sender, "merge_expired_text", {
					text: "晚到的文字",
					images: 0,
					busy: true,
				}),
			);
			expect(late).toMatchObject({ status: "busy", executionId: null });
			expect(await messagesOf(image.executionId)).toHaveLength(1);
			await completeWecomExecutionFixture(sql, image.executionId);
			// 已被 Worker 认领过的 Turn 即使窗口未到期也不再并入。
			const claimed = await mergeChannel().receive(
				event(sender, "merge_claimed_1"),
			);
			await sql`update platform.outbox_items set attempt_count = 1
			where id = ${`conversation:turn:${claimed.executionId}`}`;
			const afterClaim = await mergeChannel().receive(
				event(sender, "merge_claimed_text", {
					text: "认领后的文字",
					images: 0,
					busy: true,
				}),
			);
			expect(afterClaim).toMatchObject({ status: "busy", executionId: null });
			await completeWecomExecutionFixture(sql, claimed.executionId);
		},
	);

	it(
		"never merges a text-first Turn, a Web-style authority or another sender's message",
		mergeTimeout,
		async () => {
			await settleReceipts();
			const sender = "merge_sender_text_first";
			const textFirst = await mergeChannel().receive(
				event(sender, "merge_text_first", { text: "先发文字", images: 0 }),
			);
			expect(await windowOf(textFirst.executionId)).toBe(false);
			const followUp = await mergeChannel().receive(
				event(sender, "merge_text_first_image", { busy: true }),
			);
			expect(followUp).toMatchObject({ status: "busy", executionId: null });
			await completeWecomExecutionFixture(sql, textFirst.executionId);
			// 群里另一位发送者的文字进入自己的会话，不会并入前一位发送者的附件任务。
			const alice = await mergeChannel().receive(
				event("merge_alice", "merge_alice_image"),
			);
			const bob = await mergeChannel().receive(
				event("merge_bob", "merge_bob_text", { text: "我的问题", images: 0 }),
			);
			expect(bob.conversationId).not.toBe(alice.conversationId);
			expect(bob.executionId).not.toBe(alice.executionId);
			expect(await messagesOf(alice.executionId)).toHaveLength(1);
			expect(await windowOf(alice.executionId)).toBe(true);
			await completeWecomExecutionFixture(sql, alice.executionId);
			await completeWecomExecutionFixture(sql, bob.executionId);
			// 没有合并能力的授权（自建应用、Web 等）不开窗：只含附件的消息立即可认领。
			const plain = await mergeChannel(allowedAuthorization).receive(
				event("merge_plain", "merge_plain_image"),
			);
			expect(await windowOf(plain.executionId)).toBe(false);
			await completeWecomExecutionFixture(sql, plain.executionId);
		},
	);

	describe("supplementary instructions (#3437)", () => {
		/** 当前 Runtime 支持补充指令的企微会话。 */
		function supplementChannel() {
			const base = createWecomChannelV1({
				store,
				authorization: allowedAuthorization,
				supplementaryInstruction: async () => true,
			});
			return {
				async receive(input: WecomMessageV1) {
					const keyId = `fixture-key:personal:${input.senderId}`;
					await sql`insert into platform.relay_key_subjects
						(purpose, subject_id, last_version, current_version)
						values ('personal', ${input.senderId}, 1, 1)
						on conflict (purpose, subject_id) do nothing`;
					await sql`insert into platform.relay_key_versions
						(purpose, subject_id, key_version, key_id, ciphertext)
						values ('personal', ${input.senderId}, 1, ${keyId},
							${sql.json({ purpose: "personal", subjectId: input.senderId, keyId, keyVersion: 1 })})
						on conflict do nothing`;
					const result = await base.receive(input);
					if (result.outcome !== "accepted" && result.outcome !== "replayed")
						throw new Error(`Expected a receipt, got ${result.outcome}`);
					return result.receipt;
				},
			};
		}
		/** 原消息正在执行时再发一条文字消息，作为补充指令绑定原 Execution。 */
		async function supplementFixture(sender: string) {
			const original = await supplementChannel().receive(
				event(sender, `${sender}_original`, { text: "原问题", images: 0 }),
			);
			await sql`update platform.conversation_executions set status='processing'
				where execution_id=${original.executionId}`;
			const supplement = await supplementChannel().receive(
				event(sender, `${sender}_supplement`, { text: "补充一句", images: 0 }),
			);
			const [message] = await sql<{ message_id: string }[]>`
				select payload->>'messageId' as message_id from platform.outbox_items
				where request_id=${supplement.receiptId} and operation='conversation.turn.supplement.v1'`;
			if (!message) throw new Error("Expected the supplement outbox");
			return { original, supplement, messageId: message.message_id };
		}

		it(
			"keeps the original reply and ends the supplement once the Runtime accepts it",
			mergeTimeout,
			async () => {
				await settleReceipts();
				const { original, supplement, messageId } = await supplementFixture(
					"supplement_accepted",
				);
				expect(supplement).toMatchObject({
					status: "accepted",
					executionId: original.executionId,
					supplement: true,
				});
				expect(original).not.toHaveProperty("supplement");
				// 投递前两条回执都不领取：原消息不算已合并，补充指令等待 Runtime 的结果。
				expect(await store.claim()).toBeNull();
				await sql`update platform.outbox_items set status='succeeded'
					where id=${`conversation:supplement:${messageId}`}`;
				const claimed = await store.claim();
				expect(claimed).toMatchObject({
					receiptId: supplement.receiptId,
					supplement: { status: "accepted", failureCode: null },
					textDeltas: [],
				});
				expect(claimed).not.toHaveProperty("merged");
				if (!claimed) throw new Error("Expected the supplement receipt");
				await store.finish(claimed, "sent");
				expect(await store.claim()).toBeNull();
				// 原消息的回执照常等待并承担答案。
				await completeWecomExecutionFixture(sql, original.executionId);
				const answer = await store.claim();
				expect(answer).toMatchObject({ receiptId: original.receiptId });
				expect(answer).not.toHaveProperty("merged");
				expect(answer).not.toHaveProperty("supplement");
				if (answer) await store.finish(answer, "sent");
			},
		);

		it(
			"ends a failed supplement with its failure code",
			mergeTimeout,
			async () => {
				await settleReceipts();
				const { original, supplement, messageId } =
					await supplementFixture("supplement_failed");
				await sql`update platform.outbox_items set status='failed'
					where id=${`conversation:supplement:${messageId}`}`;
				await sql`update platform.conversation_messages set status='failed', failure_code='QUEUE_FULL'
					where message_id=${messageId}`;
				const claimed = await store.claim();
				expect(claimed).toMatchObject({
					receiptId: supplement.receiptId,
					supplement: { status: "failed", failureCode: "QUEUE_FULL" },
				});
				if (claimed) await store.finish(claimed, "sent");
				await completeWecomExecutionFixture(sql, original.executionId);
				const answer = await store.claim();
				expect(answer).toMatchObject({ receiptId: original.receiptId });
				if (answer) await store.finish(answer, "sent");
			},
		);
	});
});

describe("WeCom bounded queue receipts (#3376)", () => {
	it("queues in-flight messages within the reply window and exposes queue facts only to the connection holder", async () => {
		await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
		const botId = "queue-provider";
		await sql`insert into platform.wecom_connections (bot_id,agent_id,binding_reference,holder_id,fence,lease_until,status) values (${botId},${message.agentId},${message.bindingReference},'queue-worker',1,now()+interval '60 seconds','connected')`;
		const owner = new PostgresWecomChannelV1({
			...db,
			userDirectory: fixtureUserDirectory,
			identity: fixtureIdentity,
			connectionHolderId: "queue-worker",
		});
		const other = new PostgresWecomChannelV1({
			...db,
			userDirectory: fixtureUserDirectory,
			identity: fixtureIdentity,
			connectionHolderId: "queue-other-worker",
		});
		const fence = { botId, holderId: "queue-worker", fence: 1 };
		// 回复有效期短于 10 分钟：排队期限取有效期结束前 30 秒（§14.2.4）。
		const replyExpiresAt = new Date(Date.now() + 300_000).toISOString();
		const event = (eventId: string) => ({
			...message,
			providerId: botId,
			senderId: "queue_sender",
			eventId,
			replyHandle: `handle-${eventId}`,
			replyExpiresAt,
		});
		const receive = async (eventId: string) => {
			const result = await channel(owner).receive(event(eventId), fence);
			if (result.outcome !== "accepted") throw new Error("Expected receipt");
			return result.receipt;
		};
		try {
			const active = await receive("queue_active");
			expect(active.queuePosition).toBeUndefined();
			const queued = [
				await receive("queue_1"),
				await receive("queue_2"),
				await receive("queue_3"),
			];
			expect(
				queued.map(({ status, queuePosition }) => [status, queuePosition]),
			).toEqual([
				["accepted", 1],
				["accepted", 2],
				["accepted", 3],
			]);
			const busy = await receive("queue_4");
			expect(busy).toMatchObject({
				status: "busy",
				conversationId: active.conversationId,
				executionId: null,
			});
			const deadlines = await sql<{ matches: boolean }[]>`
				select e.task_wait_deadline = r.expires_at - interval '30 seconds' as matches
				from platform.wecom_receipts r
				join platform.conversation_executions e on e.execution_id = r.execution_id
				where r.id in ${sql(queued.map(({ receiptId }) => receiptId))}
			`;
			expect(deadlines).toEqual([
				{ matches: true },
				{ matches: true },
				{ matches: true },
			]);
			// 位次从持久等待顺序派生，只给持有该连接的 Worker。
			expect(await owner.listQueueNotices()).toEqual(
				queued.map((receipt, index) => ({
					receiptId: receipt.receiptId,
					scope: expect.objectContaining({ senderId: "queue_sender" }),
					replyHandle: `handle-queue_${index + 1}`,
					position: index + 1,
				})),
			);
			expect(await other.listQueueNotices()).toEqual([]);

			// 繁忙回执带当前排队条数，用于“排队已满”提示。
			const busyClaim = await owner.claim();
			expect(busyClaim).toMatchObject({
				receiptId: busy.receiptId,
				acceptanceStatus: "busy",
				queuedCount: 3,
			});
			if (busyClaim) await owner.finish(busyClaim, "sent");

			// 第一条开始处理（认领准入写 task.status: unknown），第二条排队超时。
			const [first, second, third] = queued;
			if (!first || !second || !third) throw new Error("Missing fixture");
			await sql`update platform.conversation_executions set status='completed' where execution_id=${active.executionId}`;
			await sql`update platform.conversation_executions set status='unknown' where execution_id=${first.executionId}`;
			await sql`insert into platform.conversation_events
				(event_id, conversation_id, execution_id, adapter_event_key, sequence, conversation_cursor,
				 event_type, event_payload, event_digest, source, runtime_cursor, occurred_at)
				select 'queue-started-event', e.conversation_id, e.execution_id, 'platform:queue-started-event',
					e.last_event_sequence + 1, c.last_conversation_cursor + 1, 'task.status',
					${sql.json({ type: "task.status", status: "unknown" })}, ${"a".repeat(64)}, 'platform', null, now()
				from platform.conversation_executions e join platform.conversations c on c.id = e.conversation_id
				where e.execution_id = ${first.executionId}`;
			await sql`update platform.conversation_executions set status='failed' where execution_id=${second.executionId}`;
			await sql`update platform.conversation_messages set status='failed', failure_code='TASK_WAIT_TIMEOUT' where execution_id=${second.executionId}`;
			expect(
				(await owner.listQueueNotices()).map(({ receiptId, position }) => [
					receiptId,
					position,
				]),
			).toEqual([
				[first.receiptId, null],
				[third.receiptId, 1],
			]);
			// 排队超时的回执立即可领取，并带上未开始即结束的原因。
			const timedOut = await owner.claim();
			expect(timedOut).toMatchObject({
				receiptId: second.receiptId,
				executionStatus: "failed",
				queue: { failureCode: "TASK_WAIT_TIMEOUT" },
			});
		} finally {
			await Promise.all([owner.close(), other.close()]);
		}
	});
});
