import { createHash, randomUUID } from "node:crypto";
import { FakeObjectStorageV1 } from "@agent-infra/object-storage";
import {
	createWecomChannelV1,
	createWecomDeliveryV1,
	type WecomAuthorizationPortV1,
	type WecomIdentityPortV1,
	type WecomMessageV1,
	type WecomSendPortV1,
	wecomChannelIdV1,
} from "@agent-infra/platform-core";
import { PostgresWecomChannelV1 } from "@agent-infra/platform-store";
import { parseWecomAnswerReferencesV1 } from "@agent-infra/wecom/worker";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { completeWecomExecutionFixture } from "../../../packages/platform-store/src/wecom-receipt.fixture.js";
import { createWecomMediaV1 } from "./wecom-media.js";

// #3229：真实 PostgreSQL、受理与投递事务、File Authority 与回答引用解析；企微传输由替身承担
// （SDK 帧由 packages/wecom 的长连接测试覆盖）。这不是固定环境的真实企微收发验收，那由 #3230 负责。
const SENTINEL_CONTENT = "SENTINEL-FILE-CONTENT-3229";
const userDirectory = {
	resolveUser: async (userId: string) => ({
		schemaVersion: 1 as const,
		userId,
		accountStatus: "active" as const,
		organizationIds: ["controlled-org"],
		authorizationRevision: "identity-1",
	}),
};
const identity: WecomIdentityPortV1 = {
	resolveSender: async (scope) => userDirectory.resolveUser(scope.senderId),
	activeUsers: async (ids) => ids,
};
const base: WecomMessageV1 = {
	providerId: "provider-1",
	agentId: "wecom_outbound_agent",
	bindingReference: "wecom_outbound_binding",
	kind: "wecom_bot",
	senderId: "sender_a",
	peerId: "sender_a",
	conversationType: "single",
	threadId: null,
	eventId: "event",
	text: "生成报告",
	replyHandle: "protected_fixture",
	replyExpiresAt: "2099-01-01T00:00:00Z",
};
const channelId = wecomChannelIdV1(base);
let revoked = false;
const authorization: WecomAuthorizationPortV1 = {
	async authorize(scope) {
		if (revoked) return { outcome: "denied", actorId: scope.senderId };
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
const configuration = {
	schemaVersion: 1,
	agentId: base.agentId,
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
	channels: [{ kind: base.kind, bindingReference: base.bindingReference }],
	channelRevision: "channels_1",
};

// 字节按真实格式构造，类型由内容识别。
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);
const pdf = Buffer.from(
	`%PDF-1.4\n1 0 obj\n<< /Title (${SENTINEL_CONTENT}) >>\nendobj\ntrailer\n<<>>\n%%EOF\n`,
);
const mp4 = Buffer.concat([
	Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"),
	Buffer.from("0000000866726565", "hex"),
]);
const zip = Buffer.concat([
	Buffer.from("504b0304140000000000", "hex"),
	Buffer.alloc(40, 0),
]);

let db: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresWecomChannelV1;
let media: ReturnType<typeof createWecomMediaV1>;
let channel: ReturnType<typeof createWecomChannelV1>;
const storage = new FakeObjectStorageV1();

beforeAll(async () => {
	db = await startPostgresTestDatabase("wecom-outbound-media");
	await migratePlatformDatabase(db);
	sql = postgres(db.databaseUrl, { max: 2 });
	store = new PostgresWecomChannelV1({ ...db, userDirectory, identity });
	media = createWecomMediaV1({
		databaseUrl: db.databaseUrl,
		storage,
		authorization,
	});
	channel = createWecomChannelV1({ authorization, store });
	await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision) values (${base.agentId},1,'authorization_1')`;
	await sql`insert into platform.agent_applications (id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values ('app_outbound',${base.agentId},'owner_1','Fixture','Fixture','available','trace_1','request_1',now(),1,1,'ready','running',1,1)`;
	await sql`insert into platform.agent_owners (agent_id,owner_id,created_at) values (${base.agentId},'owner_1',now())`;
	await sql`insert into platform.agent_availability (agent_id,target_type,target_id) values (${base.agentId},'organization','controlled-org')`;
	await sql`insert into platform.agent_configuration_revisions (agent_id,revision,source_reference,configuration,created_at) values (${base.agentId},1,'fixture',${sql.json(configuration)},now())`;
	// 三方 FileLimits：企微 Channel 声明不含 zip。
	const expiresAt = new Date(Date.now() + 86_400_000);
	const types = ["application/pdf", "image/png", "video/mp4"];
	for (const [scope, agentId, channel, mediaTypes] of [
		["deployment", "", "", [...types, "application/zip"]],
		["agent", base.agentId, "", [...types, "application/zip"]],
		["channel", base.agentId, channelId, types],
	] as const)
		await sql`insert into platform.file_limit_declarations (scope,agent_id,channel_id,revision,expires_at,max_bytes,media_types,idempotency_key,request_digest,updated_at,updated_by) values (${scope},${agentId},${channel},1,${expiresAt},${1024 * 1024},${sql.json([...mediaTypes])},${`fixture-${scope}`},${"0".repeat(64)},now(),'system_admin')`;
}, 120_000);
afterAll(async () => {
	await media?.close();
	await store?.close();
	await sql?.end();
	await db?.stop();
});

/** 完成的执行：回答正文与按顺序发布的结果文件（对象写入 Fake 存储，记录与 V2 事件一致）。 */
async function completed(
	senderId: string,
	answer: string,
	files: readonly {
		readonly name: string;
		readonly mediaType: string;
		readonly bytes: Buffer;
		readonly workspaceReference: string | null;
	}[],
) {
	await sql`update platform.wecom_receipts set delivery_status='abandoned' where delivery_status in ('pending','claimed','sending')`;
	const keyId = `fixture-key:personal:${senderId}`;
	await sql`insert into platform.relay_key_subjects (purpose, subject_id, last_version, current_version)
		values ('personal', ${senderId}, 1, 1) on conflict (purpose, subject_id) do nothing`;
	await sql`insert into platform.relay_key_versions (purpose, subject_id, key_version, key_id, ciphertext)
		values ('personal', ${senderId}, 1, ${keyId}, ${sql.json({ purpose: "personal", subjectId: senderId, keyId, keyVersion: 1 })})
		on conflict do nothing`;
	const accepted = await channel.receive({
		...base,
		senderId,
		peerId: senderId,
		eventId: `${senderId}-event`,
	});
	if (accepted.outcome !== "accepted") throw new Error("Expected receipt");
	const { executionId, conversationId } = accepted.receipt;
	if (!executionId || !conversationId) throw new Error("Expected execution");
	const events = files.length + 1;
	await sql`update platform.conversation_executions
		set status='completed',last_event_sequence=${events},last_runtime_cursor=${`runtime-${senderId}-${events}`}
		where execution_id=${executionId}`;
	await sql`update platform.conversations set last_conversation_cursor=${events} where id=${conversationId}`;
	const event = async (sequence: number, payload: Record<string, unknown>) =>
		sql`insert into platform.conversation_events
			(event_id,conversation_id,execution_id,adapter_event_key,sequence,
			 conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source)
			values (${`${senderId}-event-${sequence}`},${conversationId},${executionId},
			 ${`${senderId}-${sequence}`},${sequence},${sequence},${payload.type as string},
			 ${sql.json(payload as postgres.JSONValue)},${createHash("sha256").update(`${senderId}-${sequence}`).digest("hex")},
			 ${`runtime-${senderId}-${sequence}`},now(),'runtime')`;
	await event(1, { type: "text.delta", text: answer });
	const fileIds: string[] = [];
	for (const [index, file] of files.entries()) {
		const objectRef = randomUUID();
		const descriptor = {
			name: file.name,
			mediaType: file.mediaType,
			sizeBytes: file.bytes.byteLength,
			sha256: createHash("sha256").update(file.bytes).digest("hex"),
		};
		const stored = await storage.upload({
			objectRef,
			descriptor,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			body: new Blob([file.bytes]).stream(),
		});
		const fileId = `${senderId}-file-${index}`;
		fileIds.push(fileId);
		const record = {
			fileId,
			objectRef,
			kind: "result" as const,
			idempotencyKey: `${fileId}-key`,
			actorId: senderId,
			agentId: base.agentId,
			channelId,
			conversationId,
			executionId,
			messageId: null,
			sessionGeneration: 1,
			status: "available" as const,
			descriptor,
			objectVersion: stored.version,
			etag: stored.etag,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			expiresAt: "2099-01-01T00:00:00.000Z",
			revision: 2,
			workspaceReference: file.workspaceReference,
		};
		await sql`insert into platform.files (file_id,actor_id,conversation_id,idempotency_key,record,updated_at)
			values (${fileId},${senderId},${conversationId},${record.idempotencyKey},${sql.json(record)},now())`;
		await event(index + 2, {
			type: "result.file",
			fileId,
			name: descriptor.name,
			mediaType: descriptor.mediaType,
			sizeBytes: descriptor.sizeBytes,
			workspaceReference: file.workspaceReference,
		});
	}
	await completeWecomExecutionFixture(sql, executionId);
	return { receiptId: accepted.receipt.receiptId, fileIds };
}

/** 长连接传输替身：按 Worker 装配的方式核对 FileLimits，经出站文件客户端读取字节。 */
function transport(
	outcome: (index: number) => "sent" | "failed" | "unknown" = () => "sent",
) {
	const texts: string[] = [];
	const delivered: { kind: string; name: string; bytes: Buffer }[] = [];
	const outbound = media.outbound;
	if (!outbound) throw new Error("Expected outbound media");
	let calls = 0;
	const sender: WecomSendPortV1 = {
		async send(input) {
			texts.push(input.textWithThinking ?? input.text);
			return "sent";
		},
		async planMedia(input) {
			const limits = await outbound.limits(input.scope);
			if (!limits) return null;
			return input.files.map((file) =>
				limits.mediaTypes.includes(file.mediaType)
					? "send"
					: "unsupported_type",
			);
		},
		async sendMedia(input) {
			const index = calls++;
			const bytes = await outbound.withSlot(() =>
				outbound.read({ ...input, signal: AbortSignal.timeout(5_000) }),
			);
			delivered.push({
				kind: input.file.kind,
				name: input.file.name,
				bytes: Buffer.from(bytes),
			});
			return outcome(index);
		},
	};
	return {
		texts,
		delivered,
		delivery: createWecomDeliveryV1({
			store,
			authorization,
			sender,
			answerReferences: parseWecomAnswerReferencesV1,
		}),
	};
}
const receiptMedia = (receiptId: string) =>
	sql<
		{ file_id: string; kind: string; status: string }[]
	>`select file_id,kind,status from platform.wecom_receipt_media where receipt_id=${receiptId} order by ordinal`;
const deliveryStatus = async (receiptId: string) =>
	(
		await sql<
			{ delivery_status: string }[]
		>`select delivery_status from platform.wecom_receipts where id=${receiptId}`
	)[0]?.delivery_status;

describe("WeCom long-connection outbound media (#3229)", {
	timeout: 60_000,
}, () => {
	const logged: string[] = [];
	beforeAll(() => {
		for (const method of ["log", "info", "warn", "error", "debug"] as const)
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				logged.push(JSON.stringify(args));
			});
	});

	it("AC-1/AC-2: sends PNG, PDF and MP4 after the rewritten text in reference order", async () => {
		const answer = [
			"视频 [演示](sandbox:out/demo.mp4)，报告 [季度报告](sandbox:out/report.pdf)，",
			"图表 ![趋势](sandbox:out/chart.png)，压缩包 [打包](sandbox:out/all.zip)，",
			"缺失 [草稿](sandbox:out/draft.md)，代码 `sandbox:out/x`。",
		].join("\n");
		const { receiptId, fileIds } = await completed("sender_ac1", answer, [
			{
				name: "chart.png",
				mediaType: "image/png",
				bytes: png,
				workspaceReference: "out/chart.png",
			},
			{
				name: "report.pdf",
				mediaType: "application/pdf",
				bytes: pdf,
				workspaceReference: "out/report.pdf",
			},
			{
				name: "demo.mp4",
				mediaType: "video/mp4",
				bytes: mp4,
				workspaceReference: "out/demo.mp4",
			},
			{
				name: "all.zip",
				mediaType: "application/zip",
				bytes: zip,
				workspaceReference: "out/all.zip",
			},
		]);
		const t = transport();
		expect(await t.delivery.dispatch()).toBe(true);
		expect(t.texts).toEqual([
			[
				"视频 demo.mp4（见下方文件），报告 report.pdf（见下方文件），",
				"图表 chart.png（见下方文件），压缩包 all.zip（类型不支持，未发送），",
				"缺失 draft.md（未发布），代码 `sandbox:out/x`。",
			].join("\n"),
		]);
		expect(t.delivered.map(({ kind, name }) => [kind, name])).toEqual([
			["video", "demo.mp4"],
			["file", "report.pdf"],
			["image", "chart.png"],
		]);
		// 读取的是固定版本的原始字节。
		expect(t.delivered[0]?.bytes.equals(mp4)).toBe(true);
		expect(t.delivered[1]?.bytes.equals(pdf)).toBe(true);
		expect(t.delivered[2]?.bytes.equals(png)).toBe(true);
		expect(await receiptMedia(receiptId)).toEqual([
			{ file_id: fileIds[2], kind: "video", status: "sent" },
			{ file_id: fileIds[1], kind: "file", status: "sent" },
			{ file_id: fileIds[0], kind: "image", status: "sent" },
		]);
		expect(await deliveryStatus(receiptId)).toBe("sent");
	});

	it("AC-3: records unknown for a failed media send and never resends accepted media", async () => {
		const { receiptId } = await completed(
			"sender_ac3",
			"[a](sandbox:out/a.png) [b](sandbox:out/b.pdf)",
			[
				{
					name: "a.png",
					mediaType: "image/png",
					bytes: png,
					workspaceReference: "out/a.png",
				},
				{
					name: "b.pdf",
					mediaType: "application/pdf",
					bytes: pdf,
					workspaceReference: "out/b.pdf",
				},
			],
		);
		const t = transport((index) => (index === 0 ? "sent" : "unknown"));
		expect(await t.delivery.dispatch()).toBe(true);
		expect(await deliveryStatus(receiptId)).toBe("unknown");
		expect((await receiptMedia(receiptId)).map((row) => row.status)).toEqual([
			"sent",
			"unknown",
		]);
		// 恢复与再次投递都不会重新发送已受理或未确认的媒体。
		await sql`update platform.wecom_receipts set lease_until=now()-interval '1 second' where id=${receiptId}`;
		expect(await t.delivery.dispatch()).toBe(false);
		expect(t.delivered).toHaveLength(2);
		expect(t.texts).toHaveLength(1);
	});

	it("AC-5: stops sending media after revocation and keeps file content out of persisted state and logs", async () => {
		const { receiptId } = await completed(
			"sender_ac5",
			"[a](sandbox:out/a.pdf) [b](sandbox:out/b.pdf)",
			[
				{
					name: "a.pdf",
					mediaType: "application/pdf",
					bytes: pdf,
					workspaceReference: "out/a.pdf",
				},
				{
					name: "b.pdf",
					mediaType: "application/pdf",
					bytes: pdf,
					workspaceReference: "out/b.pdf",
				},
			],
		);
		const t = transport((index) => {
			if (index === 0) revoked = true;
			return "sent";
		});
		try {
			expect(await t.delivery.dispatch()).toBe(true);
		} finally {
			revoked = false;
		}
		expect(t.delivered).toHaveLength(1);
		expect(await deliveryStatus(receiptId)).toBe("unknown");
		expect((await receiptMedia(receiptId)).map((row) => row.status)).toEqual([
			"sent",
			"failed",
		]);
		const persisted = JSON.stringify([
			await sql`select * from platform.wecom_receipts`,
			await sql`select * from platform.wecom_receipt_media`,
			await sql`select * from platform.audit_events where action like 'wecom.%'`,
		]);
		expect(persisted).not.toContain(SENTINEL_CONTENT);
		expect(logged.join("\n")).not.toContain(SENTINEL_CONTENT);
	});

	it("AC-5: the outbound file client denies revoked, swapped or replaced result files", async () => {
		const { fileIds } = await completed(
			"sender_reader",
			"[a](sandbox:out/a.pdf)",
			[
				{
					name: "a.pdf",
					mediaType: "application/pdf",
					bytes: pdf,
					workspaceReference: "out/a.pdf",
				},
			],
		);
		const [row] = await sql<
			{ conversation_id: string; record: { executionId: string } }[]
		>`select conversation_id,record from platform.files where file_id=${fileIds[0] ?? ""}`;
		if (!row) throw new Error("Expected file");
		const outbound = media.outbound;
		if (!outbound) throw new Error("Expected outbound media");
		const read = (changes: Record<string, unknown> = {}) =>
			outbound.read({
				scope: { ...base, senderId: "sender_reader", peerId: "sender_reader" },
				source: {
					actorId: "sender_reader",
					conversationId: row.conversation_id,
					executionId: row.record.executionId,
				},
				file: {
					fileId: fileIds[0] ?? "",
					name: "a.pdf",
					mediaType: "application/pdf",
					sizeBytes: pdf.byteLength,
					workspaceReference: "out/a.pdf",
					kind: "file",
				},
				revalidate: async () => true,
				signal: AbortSignal.timeout(5_000),
				...changes,
			});
		expect(Buffer.from(await read()).equals(pdf)).toBe(true);
		await expect(read({ revalidate: async () => false })).rejects.toThrow();
		await expect(
			read({
				source: {
					actorId: "sender_other",
					conversationId: row.conversation_id,
					executionId: row.record.executionId,
				},
			}),
		).rejects.toThrow();
		await expect(
			read({
				source: {
					actorId: "sender_reader",
					conversationId: row.conversation_id,
					executionId: "other-execution",
				},
			}),
		).rejects.toThrow();
		// 只读取记录中固定的对象版本；版本不一致时不回退到最新对象。
		await sql`update platform.files set record=jsonb_set(record,'{objectVersion}','"replaced-version"') where file_id=${fileIds[0] ?? ""}`;
		await expect(read()).rejects.toThrow();
	});
});
